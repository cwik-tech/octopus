#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
source "$SCRIPT_DIR/lib-live.sh"

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-live-host-mismatch.XXXXXX")"
OUTPUT_LOG="$RUN_DIR/pi-output.log"
TEST_REPO="$RUN_DIR/repo"

cleanup() {
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT

copy_repo_for_live_test "$TEST_REPO"
perl -0pi -e "s/host_provider: openai/host_provider: codex/" "$TEST_REPO/teams.yaml"

set +e
run_pi_capture_sync "$TEST_REPO" "$RUN_DIR" "Hello. Please ask what task to route." "$OUTPUT_LOG" 180
STATUS=$?
set -e

[[ $STATUS -ne 0 ]] || true

grep -q "Host provider 'codex' is not supported by the repo-local host bridge" "$OUTPUT_LOG" || {
  echo "Live host mismatch E2E failed: missing explicit host-provider validation error" >&2
  cat "$OUTPUT_LOG" >&2
  exit 1
}

grep -q 'team.yaml has configuration errors' "$OUTPUT_LOG" || {
  echo "Live host mismatch E2E failed: config-error mode did not activate" >&2
  cat "$OUTPUT_LOG" >&2
  exit 1
}

echo "Live host mismatch E2E passed."
