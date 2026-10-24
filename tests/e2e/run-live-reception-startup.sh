#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-live-reception.XXXXXX")"
OUTPUT_LOG="$RUN_DIR/pi-output.log"

cleanup() {
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT

mkdir -p "$RUN_DIR/.pi-agent" "$RUN_DIR/workspace"

(
  cd "$REPO_ROOT"
  env \
    PI_CODING_AGENT_DIR="$RUN_DIR/.pi-agent" \
    TEAM_WORKSPACE_PATH="$RUN_DIR/workspace" \
    OPENAI_API_KEY= \
    perl -e 'alarm shift; exec @ARGV' 300 \
    pi -p --no-session -e "$REPO_ROOT/team-runtime/index.ts" \
    "Hello. I am running an automated startup check. Please ask me for the task you should route."
) >"$OUTPUT_LOG" 2>&1

ASSIGNMENT_DIR="$(find "$RUN_DIR/workspace/assignments" -maxdepth 1 -type d -name '*reception-desk' -print -quit 2>/dev/null || true)"

if [[ -z "$ASSIGNMENT_DIR" ]]; then
  echo "Live receptionist startup E2E failed: receptionist assignment directory was not created" >&2
  cat "$OUTPUT_LOG" >&2
  exit 1
fi

for REQUIRED in \
  "$ASSIGNMENT_DIR/logs/conversation.jsonl" \
  "$ASSIGNMENT_DIR/logs/host-events.jsonl"
do
  if [[ ! -f "$REQUIRED" ]]; then
    echo "Live receptionist startup E2E failed: missing expected file $REQUIRED" >&2
    cat "$OUTPUT_LOG" >&2
    exit 1
  fi
done

grep -q '"team":"reception-desk"' "$ASSIGNMENT_DIR/logs/conversation.jsonl" || {
  echo "Live receptionist startup E2E failed: conversation log did not initialize for reception-desk" >&2
  cat "$ASSIGNMENT_DIR/logs/conversation.jsonl" >&2
  exit 1
}

grep -q '"event":"host.model_selection.resolved"' "$ASSIGNMENT_DIR/logs/host-events.jsonl" || {
  echo "Live receptionist startup E2E failed: host model was not resolved at startup" >&2
  cat "$ASSIGNMENT_DIR/logs/host-events.jsonl" >&2
  exit 1
}

grep -q '"resolved_host_provider":"openai-codex"' "$ASSIGNMENT_DIR/logs/host-events.jsonl" || {
  echo "Live receptionist startup E2E failed: host did not resolve to the ChatGPT subscription provider" >&2
  cat "$ASSIGNMENT_DIR/logs/host-events.jsonl" >&2
  exit 1
}

if grep -q 'team.yaml has configuration errors' "$OUTPUT_LOG"; then
  echo "Live receptionist startup E2E failed: configuration errors were shown during startup" >&2
  cat "$OUTPUT_LOG" >&2
  exit 1
fi

if grep -q 'Connection error' "$OUTPUT_LOG"; then
  echo "Live receptionist startup E2E failed: startup hit a connection error" >&2
  cat "$OUTPUT_LOG" >&2
  exit 1
fi

if grep -q '401' "$OUTPUT_LOG"; then
  echo "Live receptionist startup E2E failed: startup hit an authentication error" >&2
  cat "$OUTPUT_LOG" >&2
  exit 1
fi

if ! grep -Eqi 'I need to know what request you would like me to route|What task (would you like me to|should I) route|Please provide the details of your task|Please provide the details of your request' "$OUTPUT_LOG"; then
  echo "Live receptionist startup E2E failed: receptionist intake response was not observed" >&2
  cat "$OUTPUT_LOG" >&2
  exit 1
fi

echo "Live receptionist startup E2E passed: $ASSIGNMENT_DIR"
