#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
FIXTURE_DIR="$TESTS_DIR/fixtures/openrouter-minimal-smoke"
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-openrouter-smoke.XXXXXX")"

source "$TESTS_DIR/helpers/load-openrouter-env.sh"
load_openrouter_env "$REPO_ROOT"
if ! require_openrouter_env; then
  exit 0
fi

cleanup() {
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT

cp -R "$FIXTURE_DIR"/. "$RUN_DIR"/
mkdir -p "$RUN_DIR/.pi-agent"

(
  cd "$RUN_DIR"
  env \
    PI_CODING_AGENT_DIR="$RUN_DIR/.pi-agent" \
    perl -e 'alarm shift; exec @ARGV' 300 \
    pi --provider openrouter --model openai/gpt-4o-mini \
      -p --no-session -e "$REPO_ROOT/team-runtime/index.ts" \
      "Run the OpenRouter provider contract smoke test."
)

REPORT_PATH="$(find "$RUN_DIR/workspace/assignments" -name openrouter-smoke-report.md -print -quit 2>/dev/null || true)"

if [[ -z "$REPORT_PATH" ]]; then
  echo "OpenRouter smoke test failed: openrouter-smoke-report.md was not created" >&2
  exit 1
fi

grep -q 'OPENROUTER-SMOKE-OK' "$REPORT_PATH" || {
  echo "OpenRouter smoke test failed: missing OPENROUTER-SMOKE-OK marker" >&2
  exit 1
}

echo "OpenRouter smoke test passed: $REPORT_PATH"
