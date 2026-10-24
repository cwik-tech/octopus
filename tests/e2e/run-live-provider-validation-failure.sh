#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
source "$SCRIPT_DIR/lib-live.sh"

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-live-provider-validation.XXXXXX")"
OUTPUT_LOG="$RUN_DIR/pi-output.log"
TEST_REPO="$RUN_DIR/repo"

cleanup() {
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT

copy_repo_for_live_test "$TEST_REPO"
perl -0pi -e "s/provider: codex/provider: anthropic/g" "$TEST_REPO/teams/reception-desk/team.yaml"
perl -0pi -e "s/model: gpt-5\\.4-mini/model: claude-haiku-4-5/g" "$TEST_REPO/teams/reception-desk/team.yaml"
perl -0pi -e "s/provider: codex/provider: anthropic/g" "$TEST_REPO/agents/receptionist/receptionist.md"
perl -0pi -e "s/model: gpt-5\\.4-mini/model: claude-haiku-4-5/" "$TEST_REPO/agents/receptionist/receptionist.md"

set +e
run_pi_capture_sync \
  "$TEST_REPO" \
  "$RUN_DIR" \
  "Hello. Please ask what task to route." \
  "$OUTPUT_LOG" \
  180 \
  ANTHROPIC_API_KEY= \
  CLAUDE_API_KEY=
STATUS=$?
set -e

[[ $STATUS -ne 0 ]] || true

grep -q "Team cannot start: agent 'receptionist' cannot use provider 'anthropic': missing ANTHROPIC_API_KEY" "$OUTPUT_LOG" || {
  echo "Live provider validation E2E failed: missing provider-preflight error" >&2
  cat "$OUTPUT_LOG" >&2
  exit 1
}

grep -q 'team.yaml has configuration errors' "$OUTPUT_LOG" || {
  echo "Live provider validation E2E failed: config-error mode did not activate" >&2
  cat "$OUTPUT_LOG" >&2
  exit 1
}

echo "Live provider validation E2E passed."
