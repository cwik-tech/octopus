#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
source "$SCRIPT_DIR/lib-live.sh"

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-live-retry-guard.XXXXXX")"
OUTPUT_LOG="$RUN_DIR/pi-output.log"
TEST_REPO="$RUN_DIR/repo"

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
python - <<'PY' "$TEST_REPO/agents/receptionist/receptionist.md"
from pathlib import Path
import sys

path = Path(sys.argv[1])
path.write_text(
"""---
name: receptionist
tier: orchestration
provider: openai
model: gpt-5.4-mini
thinking: low
tools: spawn_team, spawn_workflow
---

# Retry Guard Test Agent

For this test run only, do exactly this and nothing else:

1. Call `spawn_team` with invalid arguments using `team_name` instead of `team`.
2. Immediately call `spawn_team` again in the same turn with valid arguments.
3. Do not write any normal user-facing response.

Use this exact brief text for both calls:
`Create a concise one-page report on Microsoft.`

The first call must target `writing-team` with:
```json
{
  "team_name": "writing-team",
  "brief": "Create a concise one-page report on Microsoft."
}
```

The second call must target `writing-team` with:
```json
{
  "team": "writing-team",
  "brief": "Create a concise one-page report on Microsoft."
}
```
"""
)
PY

ACTIVE_PI_PID="$(run_pi_in_background "$TEST_REPO" "$RUN_DIR" "Create a concise one-page report on Microsoft." "$OUTPUT_LOG" 300)"
PARENT_ASSIGNMENT="$(wait_for_path "$RUN_DIR/workspace/assignments" '*reception-desk' 120 || true)"
TOOL_LOG="$(wait_for_path "$RUN_DIR/workspace/assignments" '*reception-desk/logs/tool-use.jsonl' 120 || true)"

if [[ -z "$TOOL_LOG" || ! -f "$TOOL_LOG" ]]; then
  echo "Live retry-guard E2E failed: missing tool-use log" >&2
  cat "$OUTPUT_LOG" >&2 || true
  exit 1
fi

sleep 3

if grep -q '"blocked_duplicate_level_tool":true' "$TOOL_LOG"; then
  echo "Live retry-guard E2E passed: duplicate guard triggered."
  exit 0
fi

CALL_COUNT="$(grep -c '"tool_name":"spawn_team"' "$TOOL_LOG" || true)"
ERROR_COUNT="$(grep -c '"is_error":true' "$TOOL_LOG" || true)"

[[ "$CALL_COUNT" -eq 1 ]] || {
  echo "Live retry-guard E2E failed: expected exactly one routing tool call after the invalid payload" >&2
  cat "$TOOL_LOG" >&2
  exit 1
}

[[ "$ERROR_COUNT" -eq 1 ]] || {
  echo "Live retry-guard E2E failed: expected the invalid routing call to fail exactly once" >&2
  cat "$TOOL_LOG" >&2
  exit 1
}

echo "Live retry-guard E2E passed: host halted after the first invalid routing call, so a same-turn retry never occurred."
