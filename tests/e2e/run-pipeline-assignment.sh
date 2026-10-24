#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
FIXTURE_DIR="$TESTS_DIR/fixtures/pipeline-assignment-e2e"
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-e2e.XXXXXX")"

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
    perl -e 'alarm shift; exec @ARGV' 600 \
    pi -p --no-session -e "$REPO_ROOT/team-runtime/index.ts" \
    "Analyze the assignment, produce a recommendation, and finalize the report."
)

PLAN_PATH="$(find "$RUN_DIR/workspace/assignments" -path '*/.runtime/pipeline/assignment-pipeline/plan.md' -print -quit 2>/dev/null || true)"
AGENT_RUN_LOG="$(find "$RUN_DIR/workspace/assignments" -path '*/logs/agent-runs.jsonl' -print -quit 2>/dev/null || true)"

if [[ -z "$PLAN_PATH" || ! -f "$PLAN_PATH" ]]; then
  echo "E2E test failed: run-scoped pipeline plan was not found" >&2
  exit 1
fi

cmp -s "$SOURCE_PLAN_PATH" "$RUN_DIR/source-plan.before.md" || {
  echo "E2E test failed: configured source plan was mutated" >&2
  exit 1
}

grep -q '#### T1:' "$PLAN_PATH" || {
  echo "E2E test failed: T1 is missing from the plan" >&2
  exit 1
}

grep -q '#### T2:' "$PLAN_PATH" || {
  echo "E2E test failed: T2 is missing from the plan" >&2
  exit 1
}

grep -q '#### T3:' "$PLAN_PATH" || {
  echo "E2E test failed: T3 is missing from the plan" >&2
  exit 1
}

COMPLETED_COUNT="$(grep -c '\- \*\*Status:\*\* completed' "$PLAN_PATH" || true)"
if [[ "$COMPLETED_COUNT" -lt 3 ]]; then
  echo "E2E test failed: expected 3 completed tasks, found $COMPLETED_COUNT" >&2
  exit 1
fi

if [[ -z "$AGENT_RUN_LOG" ]]; then
  echo "E2E test failed: agent-runs.jsonl was not created" >&2
  exit 1
fi

grep -q '"agent_name":"analyst"' "$AGENT_RUN_LOG" || {
  echo "E2E test failed: analyst dispatch was not recorded" >&2
  exit 1
}

grep -q '"agent_name":"synthesizer"' "$AGENT_RUN_LOG" || {
  echo "E2E test failed: synthesizer dispatch was not recorded" >&2
  exit 1
}

echo "E2E test passed: $PLAN_PATH"
