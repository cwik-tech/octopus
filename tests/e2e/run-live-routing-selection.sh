#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
BASE_RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-live-routing.XXXXXX")"

cleanup() {
  if [[ -n "${ACTIVE_PI_PID:-}" ]]; then
    kill "$ACTIVE_PI_PID" 2>/dev/null || true
    wait "$ACTIVE_PI_PID" 2>/dev/null || true
  fi
  rm -rf "$BASE_RUN_DIR"
}
trap cleanup EXIT

wait_for_path() {
  local path_pattern="$1"
  local timeout_seconds="$2"
  local elapsed=0

  while (( elapsed < timeout_seconds )); do
    local match
    match="$(find "$BASE_RUN_DIR" -path "$path_pattern" -print -quit 2>/dev/null || true)"
    if [[ -n "$match" ]]; then
      echo "$match"
      return 0
    fi
    sleep 1
    (( elapsed += 1 ))
  done

  return 1
}

run_case() {
  local case_name="$1"
  local prompt="$2"
  local expected_child="$3"
  local forbidden_child="$4"

  local case_dir="$BASE_RUN_DIR/$case_name"
  local output_log="$case_dir/pi-output.log"
  mkdir -p "$case_dir/.pi-agent" "$case_dir/workspace"

  (
    cd "$REPO_ROOT"
    env \
      PI_CODING_AGENT_DIR="$case_dir/.pi-agent" \
      TEAM_WORKSPACE_PATH="$case_dir/workspace" \
      pi -p --no-session -e "$REPO_ROOT/team-runtime/index.ts" \
      "$prompt"
  ) >"$output_log" 2>&1 &
  ACTIVE_PI_PID=$!

  local parent_assignment
  parent_assignment="$(wait_for_path "$case_dir/workspace/assignments/*reception-desk" 90 || true)"
  if [[ -z "$parent_assignment" ]]; then
    echo "Live routing E2E failed [$case_name]: receptionist assignment directory was not created" >&2
    cat "$output_log" >&2 || true
    exit 1
  fi

  local job_request
  job_request="$(wait_for_path "$case_dir/workspace/assignments/*reception-desk/job-request.md" 90 || true)"
  if [[ -z "$job_request" ]]; then
    echo "Live routing E2E failed [$case_name]: job-request.md was not created" >&2
    cat "$output_log" >&2 || true
    exit 1
  fi

  grep -q "\"target_team\": \"$expected_child\"" "$job_request" || {
    echo "Live routing E2E failed [$case_name]: job-request.md did not record target team '$expected_child'" >&2
    cat "$job_request" >&2
    exit 1
  }

  local expected_assignment
  expected_assignment="$(wait_for_path "$case_dir/workspace/assignments/*$expected_child" 120 || true)"
  if [[ -z "$expected_assignment" ]]; then
    echo "Live routing E2E failed [$case_name]: expected child team '$expected_child' was not spawned" >&2
    find "$case_dir/workspace/assignments" -maxdepth 2 -type d >&2 || true
    cat "$output_log" >&2 || true
    exit 1
  fi

  local child_brief
  child_brief="$(wait_for_path "$case_dir/workspace/assignments/*$expected_child/incoming-brief.md" 30 || true)"
  if [[ -z "$child_brief" ]]; then
    echo "Live routing E2E failed [$case_name]: child team '$expected_child' did not receive incoming-brief.md" >&2
    find "$expected_assignment" -maxdepth 2 -type f >&2 || true
    exit 1
  fi

  local forbidden_assignment
  forbidden_assignment="$(find "$case_dir/workspace/assignments" -maxdepth 1 -type d -name "*$forbidden_child" -print -quit 2>/dev/null || true)"
  if [[ -n "$forbidden_assignment" ]]; then
    echo "Live routing E2E failed [$case_name]: unexpected child team '$forbidden_child' was spawned" >&2
    find "$case_dir/workspace/assignments" -maxdepth 2 -type d >&2 || true
    exit 1
  fi

  if grep -q 'team.yaml has configuration errors' "$output_log"; then
    echo "Live routing E2E failed [$case_name]: configuration errors were shown during startup" >&2
    cat "$output_log" >&2
    exit 1
  fi

  if grep -q 'Connection error' "$output_log"; then
    echo "Live routing E2E failed [$case_name]: run hit a connection error" >&2
    cat "$output_log" >&2
    exit 1
  fi

  if grep -q '401' "$output_log"; then
    echo "Live routing E2E failed [$case_name]: run hit an authentication error" >&2
    cat "$output_log" >&2
    exit 1
  fi

  kill "$ACTIVE_PI_PID" 2>/dev/null || true
  wait "$ACTIVE_PI_PID" 2>/dev/null || true
  ACTIVE_PI_PID=''

  echo "Live routing E2E passed [$case_name]: $expected_child"
}

ACTIVE_PI_PID=''

run_case \
  "writing" \
  "Create a concise one-page report on Microsoft." \
  "writing-team" \
  "problem-thinking-board"

run_case \
  "problem-thinking" \
  "Use the specialist team named problem-thinking-board for this request. I need structured multi-angle analysis only, not writing: how should a small B2B SaaS company decide whether to move upmarket into enterprise clients over the next 12 months?" \
  "problem-thinking-board" \
  "writing-team"

echo "Live routing selection E2E passed."
