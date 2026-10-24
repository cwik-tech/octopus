#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
source "$SCRIPT_DIR/lib-live.sh"

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-live-child-failure.XXXXXX")"
OUTPUT_LOG="$RUN_DIR/pi-output.log"
TEST_REPO="$RUN_DIR/repo"

cleanup() {
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT

copy_repo_for_live_test "$TEST_REPO"
perl -0pi -e "s/provider: codex/provider: anthropic/g" "$TEST_REPO/teams/writing-team/team.yaml"
perl -0pi -e "s/model: gpt-5\\.4-mini/model: claude-haiku-4-5/g" "$TEST_REPO/teams/writing-team/team.yaml"

set +e
run_pi_capture_sync \
  "$TEST_REPO" \
  "$RUN_DIR" \
  "Create a concise one-page report on Microsoft." \
  "$OUTPUT_LOG" \
  300 \
  ANTHROPIC_API_KEY= \
  CLAUDE_API_KEY=
STATUS=$?
set -e

[[ $STATUS -ne 0 ]] || true

PARENT_ASSIGNMENT="$(find_assignment_dir "$RUN_DIR" 'reception-desk')"
CHILD_ASSIGNMENT="$(find_assignment_dir "$RUN_DIR" 'writing-team')"
RESULT_FILE="$PARENT_ASSIGNMENT/delegation-writing-team-result.md"

for REQUIRED in "$PARENT_ASSIGNMENT" "$CHILD_ASSIGNMENT" "$RESULT_FILE"; do
  if [[ -z "$REQUIRED" || ! -e "$REQUIRED" ]]; then
    echo "Live child-failure E2E failed: missing expected path $REQUIRED" >&2
    cat "$OUTPUT_LOG" >&2 || true
    exit 1
  fi
done

grep -q '"status": "failed"' "$RESULT_FILE" || {
  echo "Live child-failure E2E failed: parent delegation result did not record failure" >&2
  cat "$RESULT_FILE" >&2
  exit 1
}

grep -q 'missing ANTHROPIC_API_KEY' "$RESULT_FILE" || {
  echo "Live child-failure E2E failed: parent delegation result did not surface the child failure reason" >&2
  cat "$RESULT_FILE" >&2
  exit 1
}

if [[ -f "$PARENT_ASSIGNMENT/routing-decision.md" ]]; then
  echo "Live child-failure E2E failed: routing-decision.md should not exist after child delegation failure" >&2
  cat "$PARENT_ASSIGNMENT/routing-decision.md" >&2
  exit 1
fi

if grep -q 'Assignment complete' "$OUTPUT_LOG"; then
  echo "Live child-failure E2E failed: receptionist output still claimed success" >&2
  cat "$OUTPUT_LOG" >&2
  exit 1
fi

echo "Live child-failure E2E passed."
