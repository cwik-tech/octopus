#!/bin/zsh
set -euo pipefail

# Delegated-autostart recovery, end to end against a real provider.
#
# A delegated child is told to reply NOOP while runtime autostart owns the
# stage. When autostart declines, that instruction must be lifted and the
# coordinator must drive the stage itself — otherwise the child ends idle with
# no artifact, which is exactly how a stage the runtime never attempted got
# reported as a Codex host-provider failure.
#
# The skip is forced with TEAM_RUNTIME_FAULT_INJECT so the failure is
# deterministic; a deliberately broken team.yaml would test config validation
# instead of recovery. Anthropic is used because the sibling board E2E already
# proves that path, keeping this test independent of the host-provider question
# it exists to rule out.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
source "$SCRIPT_DIR/lib-live.sh"

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-live-autostart-recovery.XXXXXX")"
OUTPUT_LOG="$RUN_DIR/pi-output.log"
TEST_REPO="$RUN_DIR/repo"
# A delegated child is a *managed* run: level tools refuse to register without
# the session/run/assignment scope and the task authority a parent grants
# (`requireTeamRuntimeCapabilityIdentity`). Setting TEAM_SESSION_ID alone
# produces a legacy-layout assignment with no capability identity, and the run
# dies in registerLevelTools before autostart is ever reached.
SESSION_ID="autostart-recovery-e2e"
RUN_ID="run-1"
ASSIGNMENT_ID="assignment-1"
RUN_PATH="$RUN_DIR/workspace/sessions/$SESSION_ID/runs/$RUN_ID"
ASSIGNMENT_DIR="$RUN_PATH/assignments/$ASSIGNMENT_ID"
PROMPT="Decompose this delegated brief."

cleanup() {
  set +e
  if [[ "${PIPELINE_KEEP_LIVE_WORKSPACE:-}" == "1" ]]; then
    echo "workspace retained at $RUN_DIR"
  else
    rm -rf "$RUN_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

copy_repo_for_live_test "$TEST_REPO"

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
    r"(problem-thinking-board:\n(?:  .*\n)*?  host_model: )gpt-5\.4-mini\n(  host_provider: )\w+\n",
    re.MULTILINE,
)
text, count = pattern.subn(r"\1claude-sonnet-4-6\n\2anthropic\n", text, count=1)
if count != 1:
    raise SystemExit("failed to patch problem-thinking-board host config in teams.yaml")
path.write_text(text)
PY

# Two participants and one round: this test is about the recovery path, not
# about board quality, and it spends real provider credit.
python - <<'PY' "$TEST_REPO/teams/problem-thinking-board/team.yaml"
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text()
text = re.sub(r"provider: codex", "provider: anthropic", text)
text = re.sub(r"model: default", "model: claude-haiku-4-5", text)
start = text.index("      participants:\n")
end = text.index("      on_agent_failure:", start)
text = text[:start] + "      participants:\n        - contrarian\n        - pragmatist\n" + text[end:]
text = text.replace("        max_rounds: 3", "        max_rounds: 1")
path.write_text(text)
PY

mkdir -p "$ASSIGNMENT_DIR"
cat > "$ASSIGNMENT_DIR/incoming-brief.md" <<'EOF'
## User Brief

USER: Should a two-person consultancy productise its most repeated engagement
into a fixed-price offering? Pressure-test the decision and produce a structured
decomposition.
EOF

# A delegated child, with its stage autostart forced to decline. The
# TEAM_RUNTIME_* scope and task authority mirror exactly what
# `agent-runner.ts` hands a spawned child.
set +e
run_pi_capture_sync \
  "$TEST_REPO" \
  "$RUN_DIR" \
  "$PROMPT" \
  "$OUTPUT_LOG" \
  420 \
  TEAM_SESSION_ID="$SESSION_ID" \
  TEAM_RUNTIME_SESSION_ID="$SESSION_ID" \
  TEAM_RUNTIME_RUN_ID="$RUN_ID" \
  TEAM_RUNTIME_ASSIGNMENT_ID="$ASSIGNMENT_ID" \
  TEAM_RUNTIME_ASSIGNMENT_PATH="$ASSIGNMENT_DIR" \
  TEAM_RUNTIME_RUN_PATH="$RUN_PATH" \
  TEAM_RUNTIME_TASK_ID="autostart-recovery-task" \
  TEAM_RUNTIME_PROCESS_IDENTITY="autostart-recovery-process" \
  TEAM_DELEGATED_AUTOSTART=1 \
  TEAM_INPUT_ARTIFACT=incoming-brief.md \
  TEAM_OUTPUT_ARTIFACT=output/decomposition-plan.md \
  TEAM_RUNTIME_FAULT_INJECT=skip_stage_autostart
set -e

assert_no_common_runtime_errors "$OUTPUT_LOG" "Live delegated autostart recovery E2E"

RUNTIME_LOG="$ASSIGNMENT_DIR/logs/runtime-events.jsonl"
TOOL_LOG="$ASSIGNMENT_DIR/logs/tool-use.jsonl"
BOARD_OUTPUT="$ASSIGNMENT_DIR/output/decomposition-plan.md"

fail() {
  echo "Live delegated autostart recovery E2E failed: $1" >&2
  [[ -f "$RUNTIME_LOG" ]] && tail -40 "$RUNTIME_LOG" >&2
  [[ -f "$TOOL_LOG" ]] && tail -40 "$TOOL_LOG" >&2
  cat "$OUTPUT_LOG" >&2 || true
  exit 1
}

[[ -f "$RUNTIME_LOG" ]] || fail "no runtime events were written"

# 1. The skip is recorded rather than silent — the defect that made six
#    different causes indistinguishable.
grep -q '"event":"runtime.stage_autostart.skipped"' "$RUNTIME_LOG" \
  || fail "the declined autostart was not recorded"
grep -q '"reason":"fault_injected"' "$RUNTIME_LOG" \
  || fail "the skip did not carry its reason"

# 2. The runtime did not execute the stage.
if grep -q '"event":"runtime.stage_autostart.end"' "$RUNTIME_LOG"; then
  fail "autostart claimed to run despite the injected skip"
fi

# 3. The host was handed the coordinator prompt, not "reply with exactly NOOP".
#    This is the assertion that would have caught the original defect, and it
#    holds without a working provider because the prompt is built before the
#    model is called. The NOOP suffix measures 244 characters against the base
#    prompt; a coordinator prompt runs to tens of thousands.
HOST_LOG="$ASSIGNMENT_DIR/logs/host-events.jsonl"
[[ -f "$HOST_LOG" ]] || fail "no host events were written"
python3 - "$HOST_LOG" <<'PY' || fail "the host was told to stand down for a stage the runtime never started"
import json, sys

starts = [
    json.loads(line)
    for line in open(sys.argv[1], encoding="utf8")
    if line.strip() and json.loads(line).get("event") == "host.before_agent_start"
]
if not starts:
    print("no host.before_agent_start was recorded", file=sys.stderr)
    raise SystemExit(1)

first = starts[0]
if not first.get("delegated_autostart"):
    print("the run was not a delegated child; the test proves nothing", file=sys.stderr)
    raise SystemExit(1)

delta = first["system_prompt_length"] - first["base_system_prompt_length"]
if delta < 2000:
    print(f"host received a {delta}-char suffix: the NOOP prompt, not a coordinator prompt", file=sys.stderr)
    raise SystemExit(1)
print(f"coordinator prompt delivered to a delegated child ({delta} chars)")
PY

# Everything above is provider-independent. Everything below needs the host
# model to actually run, so an unusable provider must be reported as
# inconclusive rather than as a broken recovery path — the entire point of this
# change is that a failure should name its own cause.
if grep -qiE 'credit balance is too low|insufficient_quota|rate_limit_error|invalid x-api-key|authentication_error' "$OUTPUT_LOG"; then
  echo "Live delegated autostart recovery E2E INCONCLUSIVE: the host provider was unusable." >&2
  echo "Verified without the provider: the declined autostart was recorded with its reason," >&2
  echo "the runtime did not execute the stage, and the host received the coordinator prompt" >&2
  echo "rather than the NOOP prompt. Unverified: whether the coordinator then drove" >&2
  echo "set_roster/create_brief/converse and produced the artifact." >&2
  grep -iE 'credit balance is too low|insufficient_quota|rate_limit_error|invalid x-api-key|authentication_error' "$OUTPUT_LOG" | head -3 >&2
  exit 2
fi

# 3. The coordinator drove the stage instead. `runtime_autostart` is absent
#    from these entries precisely because the model, not the runtime, called
#    them.
[[ -f "$TOOL_LOG" ]] || fail "the coordinator called no tools — it was still under the NOOP prompt"
for TOOL in set_roster create_brief converse; do
  grep -q "\"tool_name\":\"$TOOL\"" "$TOOL_LOG" \
    || fail "the coordinator never called $TOOL"
done
if grep -q '"delegated_discussion_autostart":true' "$TOOL_LOG"; then
  fail "the stage tools were driven by autostart, so recovery was not exercised"
fi

# 4. The run still produced its contracted artifact.
[[ -s "$BOARD_OUTPUT" ]] || fail "no decomposition-plan.md was produced"

echo "Live delegated autostart recovery E2E passed: $BOARD_OUTPUT"
