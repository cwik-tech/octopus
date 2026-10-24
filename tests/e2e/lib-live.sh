#!/bin/zsh
set -euo pipefail

if [[ -z "${REPO_ROOT:-}" ]]; then
  echo "REPO_ROOT must be set before sourcing tests/e2e/lib-live.sh" >&2
  exit 1
fi

copy_repo_for_live_test() {
  local dest="$1"

  mkdir -p "$dest"
  rsync -a \
    --exclude '.git' \
    --exclude 'workspace' \
    --exclude '.pi-agent' \
    --exclude '.tests-dist' \
    --exclude '.DS_Store' \
    --exclude 'coverage' \
    "$REPO_ROOT"/ "$dest"/

  if [[ -d "$REPO_ROOT/node_modules" ]]; then
    rm -rf "$dest/node_modules"
    ln -s "$REPO_ROOT/node_modules" "$dest/node_modules"
  fi

  mkdir -p "$dest/.pi-agent" "$dest/workspace"
}

run_pi_capture_sync() {
  local repo_dir="$1"
  local run_dir="$2"
  local prompt="$3"
  local output_log="$4"
  local timeout_seconds="${5:-300}"
  shift 5 || true

  (
    cd "$repo_dir"
    env \
      PI_CODING_AGENT_DIR="$run_dir/.pi-agent" \
      TEAM_WORKSPACE_PATH="$run_dir/workspace" \
      "$@" \
      perl -e 'alarm shift; exec @ARGV' "$timeout_seconds" \
      pi -p --no-session -e "$repo_dir/team-runtime/index.ts" \
      "$prompt"
  ) >"$output_log" 2>&1
}

run_pi_in_background() {
  local repo_dir="$1"
  local run_dir="$2"
  local prompt="$3"
  local output_log="$4"
  local timeout_seconds="${5:-300}"
  shift 5 || true

  (
    cd "$repo_dir"
    env \
      PI_CODING_AGENT_DIR="$run_dir/.pi-agent" \
      TEAM_WORKSPACE_PATH="$run_dir/workspace" \
      "$@" \
      perl -e 'alarm shift; exec @ARGV' "$timeout_seconds" \
      pi -p --no-session -e "$repo_dir/team-runtime/index.ts" \
      "$prompt"
  ) >"$output_log" 2>&1 &

  echo $!
}

wait_for_path() {
  local root_dir="$1"
  local path_pattern="$2"
  local timeout_seconds="$3"
  local elapsed=0

  while (( elapsed < timeout_seconds )); do
    local match
    match="$(find "$root_dir" -path "$path_pattern" -print -quit 2>/dev/null || true)"
    if [[ -n "$match" ]]; then
      echo "$match"
      return 0
    fi
    sleep 1
    (( elapsed += 1 ))
  done

  return 1
}

find_assignment_dir() {
  local run_dir="$1"
  local suffix="$2"
  find "$run_dir/workspace/assignments" -maxdepth 1 -type d -name "*$suffix" -print -quit 2>/dev/null || true
}

assert_no_common_runtime_errors() {
  local output_log="$1"
  local label="$2"

  if grep -q 'Connection error' "$output_log"; then
    echo "$label failed: run hit a connection error" >&2
    cat "$output_log" >&2
    exit 1
  fi

  if grep -q '401' "$output_log"; then
    echo "$label failed: run hit an authentication error" >&2
    cat "$output_log" >&2
    exit 1
  fi
}
