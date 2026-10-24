#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
source "$SCRIPT_DIR/lib-live.sh"

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-live-workflow-handoff.XXXXXX")"
OUTPUT_LOG="$RUN_DIR/pi-output.log"
TEST_REPO="$RUN_DIR/repo"
PROMPT="I need you to think through this problem from multiple angles first, then turn the result into a polished written brief. The problem is: how should a small B2B SaaS company decide whether to move upmarket into enterprise clients over the next 12 months?"

cleanup() {
  set +e
  if [[ -n "${ACTIVE_PI_PID:-}" ]]; then
    pkill -P "$ACTIVE_PI_PID" 2>/dev/null || true
    kill "$ACTIVE_PI_PID" 2>/dev/null || true
    wait "$ACTIVE_PI_PID" 2>/dev/null || true
  fi
  sleep 1
  rm -rf "$RUN_DIR" 2>/dev/null || true
}
trap cleanup EXIT

copy_repo_for_live_test "$TEST_REPO"
perl -0pi -e "s/provider: codex/provider: openai/g" "$TEST_REPO/teams/writing-team/team.yaml"
ACTIVE_PI_PID="$(run_pi_in_background "$TEST_REPO" "$RUN_DIR" "$PROMPT" "$OUTPUT_LOG" 600)"
assert_no_common_runtime_errors "$OUTPUT_LOG" "Live workflow handoff E2E"

DISCUSSION_OUTPUT="$(wait_for_path "$RUN_DIR/workspace/assignments" '*problem-thinking-board/output/decomposition-plan.md' 180 || true)"
WRITING_INPUT="$(wait_for_path "$RUN_DIR/workspace/assignments" '*writing-team/incoming-brief.md' 180 || true)"

for REQUIRED in "$DISCUSSION_OUTPUT" "$WRITING_INPUT"; do
  if [[ -z "$REQUIRED" || ! -f "$REQUIRED" ]]; then
    echo "Live workflow handoff E2E failed: missing expected file $REQUIRED" >&2
    cat "$OUTPUT_LOG" >&2 || true
    exit 1
  fi
done

cmp -s "$DISCUSSION_OUTPUT" "$WRITING_INPUT" || {
  DISCUSSION_BODY="$(awk 'BEGIN{body=0} /^---[[:space:]]*$/{if(body==0){body=1; next} else {body=2; next}} body==2{print}' "$DISCUSSION_OUTPUT")"
  WRITING_BODY="$(awk 'BEGIN{body=0} /^---[[:space:]]*$/{if(body==0){body=1; next} else {body=2; next}} body==2{print}' "$WRITING_INPUT")"
  [[ "$WRITING_BODY" == "$DISCUSSION_BODY" ]] || {
    echo "Live workflow handoff E2E failed: writing-team incoming brief body did not preserve the discussion artifact" >&2
    diff -u <(printf '%s\n' "$DISCUSSION_BODY") <(printf '%s\n' "$WRITING_BODY") >&2 || true
    exit 1
  }
}

if find "$TEST_REPO/teams" -path '*/workspace/assignments/*' -print -quit | grep -q .; then
  echo "Live workflow handoff E2E failed: a team-local workspace assignment was created under teams/" >&2
  find "$TEST_REPO/teams" -path '*/workspace/assignments/*' >&2
  exit 1
fi

echo "Live workflow handoff E2E passed: $WRITING_INPUT"
