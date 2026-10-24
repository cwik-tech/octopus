#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
source "$SCRIPT_DIR/lib-live.sh"

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-live-review-override.XXXXXX")"
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
python - <<'PY' "$TEST_REPO/agents/editor/editor.md"
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
marker = "## Purpose\n"
inject = "## Purpose\n\nFor this test run only, always return `<review_decision>REVISE</review_decision>` with one short revision note. Do not approve.\n"
if marker not in text:
    raise SystemExit("missing editor purpose heading")
path.write_text(text.replace(marker, inject, 1))
PY

ACTIVE_PI_PID="$(run_pi_in_background "$TEST_REPO" "$RUN_DIR" "$PROMPT" "$OUTPUT_LOG" 600)"
assert_no_common_runtime_errors "$OUTPUT_LOG" "Live workflow review-override E2E"

REVIEW_LOG="$(wait_for_path "$RUN_DIR/workspace/assignments" '*writing-team/logs/review-events.jsonl' 240 || true)"
FINAL_DRAFT="$(wait_for_path "$RUN_DIR/workspace/assignments" '*writing-team/final-draft.md' 240 || true)"

for REQUIRED in "$REVIEW_LOG" "$FINAL_DRAFT"; do
  if [[ -z "$REQUIRED" || ! -f "$REQUIRED" ]]; then
    echo "Live workflow review-override E2E failed: missing expected file $REQUIRED" >&2
    cat "$OUTPUT_LOG" >&2 || true
    exit 1
  fi
done

for _ in {1..30}; do
  if grep -q '"step":"loop.max-iterations-reached"' "$REVIEW_LOG"; then
    break
  fi
  sleep 1
done

grep -q '"step":"loop.max-iterations-reached"' "$REVIEW_LOG" || {
  echo "Live workflow review-override E2E failed: review loop did not hit the configured iteration cap" >&2
  cat "$REVIEW_LOG" >&2
  exit 1
}

grep -q '"max_iterations":1' "$REVIEW_LOG" || {
  echo "Live workflow review-override E2E failed: workflow override did not clamp max_iterations to 1" >&2
  cat "$REVIEW_LOG" >&2
  exit 1
}

grep -q 'verdict: "MAX_ITERATIONS_APPROVE_WITH_WARNINGS"' "$FINAL_DRAFT" || {
  echo "Live workflow review-override E2E failed: final draft did not record approve-with-warnings completion" >&2
  cat "$FINAL_DRAFT" >&2
  exit 1
}

echo "Live workflow review-override E2E passed."
