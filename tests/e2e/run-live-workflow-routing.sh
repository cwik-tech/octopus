#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
source "$SCRIPT_DIR/lib-live.sh"

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-live-workflow-routing.XXXXXX")"
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
ACTIVE_PI_PID="$(run_pi_in_background "$TEST_REPO" "$RUN_DIR" "$PROMPT" "$OUTPUT_LOG" 600 OPENAI_API_KEY=)"
PARENT_ASSIGNMENT="$(wait_for_path "$RUN_DIR/workspace/assignments" '*reception-desk' 120 || true)"
DISCUSSION_ASSIGNMENT="$(wait_for_path "$RUN_DIR/workspace/assignments" '*problem-thinking-board' 180 || true)"
WRITING_ASSIGNMENT="$(wait_for_path "$RUN_DIR/workspace/assignments" '*writing-team' 180 || true)"
FINAL_DRAFT="$(wait_for_path "$RUN_DIR/workspace/assignments" '*writing-team/final-draft.md' 240 || true)"
ROUTING_DECISION="$(wait_for_path "$RUN_DIR/workspace/assignments" '*reception-desk/routing-decision.md' 60 || true)"
WORKFLOW_RESULT="$(wait_for_path "$RUN_DIR/workspace/assignments" '*reception-desk/workflow-discussion-to-writing-result.md' 60 || true)"
assert_no_common_runtime_errors "$OUTPUT_LOG" "Live workflow routing E2E"

for REQUIRED in \
  "$PARENT_ASSIGNMENT/workflow-discussion-to-writing-request.md" \
  "$WORKFLOW_RESULT" \
  "$ROUTING_DECISION" \
  "$DISCUSSION_ASSIGNMENT/output/decomposition-plan.md" \
  "$WRITING_ASSIGNMENT/incoming-brief.md" \
  "$FINAL_DRAFT"
do
  if [[ -z "$REQUIRED" || ! -f "$REQUIRED" ]]; then
    echo "Live workflow routing E2E failed: missing expected file $REQUIRED" >&2
    cat "$OUTPUT_LOG" >&2 || true
    exit 1
  fi
done

grep -q 'Workflow: discussion-to-writing' "$PARENT_ASSIGNMENT/workflow-discussion-to-writing-request.md" || {
  echo "Live workflow routing E2E failed: workflow request did not record discussion-to-writing" >&2
  cat "$PARENT_ASSIGNMENT/workflow-discussion-to-writing-request.md" >&2
  exit 1
}

grep -q 'Workflow status: completed' "$ROUTING_DECISION" || {
  echo "Live workflow routing E2E failed: routing decision did not record workflow completion" >&2
  cat "$ROUTING_DECISION" >&2
  exit 1
}

echo "Live workflow routing E2E passed: $FINAL_DRAFT"
