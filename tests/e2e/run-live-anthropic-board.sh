#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
source "$SCRIPT_DIR/lib-live.sh"

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-live-anthropic-board.XXXXXX")"
OUTPUT_LOG="$RUN_DIR/pi-output.log"
TEST_REPO="$RUN_DIR/repo"
PROMPT="How should a small B2B SaaS company decide whether to move upmarket into enterprise clients over the next 12 months? Think through it from multiple angles and produce a structured decomposition."

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

# Boot directly into the board so this tests live Anthropic execution, not
# receptionist delegation or delegated-autostart behavior.
cat > "$TEST_REPO/start.yaml" <<'EOF'
entry: problem-thinking-board
registry: ./teams.yaml
EOF
python - <<'PY' "$TEST_REPO/teams.yaml"
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text()
pattern = re.compile(
    r"(problem-thinking-board:\n(?:  .*\n)*?  host_model: )gpt-5\.4-mini\n(  host_provider: )openai\n",
    re.MULTILINE,
)
text, count = pattern.subn(r"\1claude-sonnet-4-6\n\2anthropic\n", text, count=1)
if count != 1:
    raise SystemExit("failed to patch problem-thinking-board host config in teams.yaml")
path.write_text(text)
PY

# Keep the board small and fast for provider validation.
python - <<'PY' "$TEST_REPO/teams/problem-thinking-board/team.yaml"
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
text = text.replace("host_provider: openai", "host_provider: anthropic")
text = text.replace("host_model: gpt-5.4-mini", "host_model: claude-sonnet-4-6")
text = text.replace(
"""      participants:
        - contrarian
        - pragmatist
        - domain-researcher
        - client-lens
        - money-maker
        - innovator
        - futurist
        - moonshot
        - crazy-man
        - first-principles-fool
        - pattern-matcher
""",
"""      participants:
        - contrarian
        - pragmatist
""",
)
text = text.replace("        max_rounds: 3", "        max_rounds: 1")
path.write_text(text)
PY

ACTIVE_PI_PID="$(run_pi_in_background "$TEST_REPO" "$RUN_DIR" "$PROMPT" "$OUTPUT_LOG" 420)"
assert_no_common_runtime_errors "$OUTPUT_LOG" "Live Anthropic board E2E"

BOARD_ASSIGNMENT="$(wait_for_path "$RUN_DIR/workspace/assignments" '*problem-thinking-board' 180 || true)"
BOARD_OUTPUT="$(wait_for_path "$RUN_DIR/workspace/assignments" '*problem-thinking-board/output/decomposition-plan.md' 240 || true)"
PROVIDER_LOG="$(wait_for_path "$RUN_DIR/workspace/assignments" '*problem-thinking-board/logs/provider-events.jsonl' 240 || true)"
AGENT_RUN_LOG="$(wait_for_path "$RUN_DIR/workspace/assignments" '*problem-thinking-board/logs/agent-runs.jsonl' 240 || true)"
HOST_LOG="$(wait_for_path "$RUN_DIR/workspace/assignments" '*problem-thinking-board/logs/host-events.jsonl' 240 || true)"

for REQUIRED in \
  "$BOARD_OUTPUT" \
  "$PROVIDER_LOG" \
  "$AGENT_RUN_LOG" \
  "$HOST_LOG"
do
  if [[ -z "$REQUIRED" || ! -f "$REQUIRED" ]]; then
    echo "Live Anthropic board E2E failed: missing expected file $REQUIRED" >&2
    cat "$OUTPUT_LOG" >&2 || true
    exit 1
  fi
done

grep -q '"resolved_host_provider":"anthropic-api"' "$HOST_LOG" || {
  echo "Live Anthropic board E2E failed: board host did not resolve to anthropic-api" >&2
  cat "$HOST_LOG" >&2
  exit 1
}

grep -q '"resolved_host_model":"claude-sonnet-4-6"' "$HOST_LOG" || {
  echo "Live Anthropic board E2E failed: board host did not resolve to claude-sonnet-4-6" >&2
  cat "$HOST_LOG" >&2
  exit 1
}

grep -q '"provider":"anthropic"' "$PROVIDER_LOG" || {
  echo "Live Anthropic board E2E failed: Anthropic provider events were not recorded" >&2
  cat "$PROVIDER_LOG" >&2
  exit 1
}

grep -q '"event":"request.end"' "$PROVIDER_LOG" || {
  echo "Live Anthropic board E2E failed: Anthropic request did not complete successfully" >&2
  cat "$PROVIDER_LOG" >&2
  exit 1
}

grep -q '"agent_name":"contrarian"' "$AGENT_RUN_LOG" || {
  echo "Live Anthropic board E2E failed: contrarian did not run" >&2
  cat "$AGENT_RUN_LOG" >&2
  exit 1
}

grep -q '"agent_name":"pragmatist"' "$AGENT_RUN_LOG" || {
  echo "Live Anthropic board E2E failed: pragmatist did not run" >&2
  cat "$AGENT_RUN_LOG" >&2
  exit 1
}

if grep -q 'authentication error' "$OUTPUT_LOG" || grep -q 'invalid x-api-key' "$OUTPUT_LOG" || grep -q 'ANTHROPIC_API_KEY' "$OUTPUT_LOG"; then
  echo "Live Anthropic board E2E failed: Anthropic auth failed" >&2
  cat "$OUTPUT_LOG" >&2
  exit 1
fi

echo "Live Anthropic board E2E passed: $BOARD_OUTPUT"
