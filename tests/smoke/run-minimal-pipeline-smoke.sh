#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
FIXTURE_DIR="$TESTS_DIR/fixtures/minimal-pipeline-smoke"
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-smoke.XXXXXX")"

cleanup() {
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT

cp -R "$FIXTURE_DIR"/. "$RUN_DIR"/
mkdir -p "$RUN_DIR/.pi-agent"
SOURCE_PLAN_PATH="$RUN_DIR/workspace/plan.md"
cp "$SOURCE_PLAN_PATH" "$RUN_DIR/source-plan.before.md"

(
  cd "$RUN_DIR"
  env \
    PI_CODING_AGENT_DIR="$RUN_DIR/.pi-agent" \
    perl -e 'alarm shift; exec @ARGV' 300 \
    pi -p --no-session -e "$REPO_ROOT/team-runtime/index.ts" \
    "Run the minimal smoke test assignment."
)

PLAN_PATH="$(find "$RUN_DIR/workspace/assignments" -path '*/.runtime/pipeline/smoke-pipeline/plan.md' -print -quit 2>/dev/null || true)"
AGENT_RUN_LOG="$(find "$RUN_DIR/workspace/assignments" -path '*/logs/agent-runs.jsonl' -print -quit 2>/dev/null || true)"

if [[ -z "$PLAN_PATH" || ! -f "$PLAN_PATH" ]]; then
  echo "Smoke test failed: run-scoped pipeline plan was not found" >&2
  exit 1
fi

cmp -s "$SOURCE_PLAN_PATH" "$RUN_DIR/source-plan.before.md" || {
  echo "Smoke test failed: configured source plan was mutated" >&2
  exit 1
}

grep -q '\- \*\*Status:\*\* completed' "$PLAN_PATH" || {
  echo "Smoke test failed: the pipeline task did not reach completed state" >&2
  exit 1
}

if [[ -z "$AGENT_RUN_LOG" ]]; then
  echo "Smoke test failed: agent-runs.jsonl was not created" >&2
  exit 1
fi

grep -q '"agent_name":"worker"' "$AGENT_RUN_LOG" || {
  echo "Smoke test failed: worker dispatch was not recorded" >&2
  exit 1
}

echo "Smoke test passed: $PLAN_PATH"
