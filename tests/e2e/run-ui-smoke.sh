#!/bin/zsh
# Run UI Phase 5 smoke test.
#
# Boots the API server with a temp workspace, then exercises the Phase 1-5
# end-to-end contract:
#   1. session create
#   2. file upload + parser (parsed status)
#   3. grounded chat round-trip against a deterministic provider fixture —
#      the Receptionist answer must echo a sentinel that exists only in the
#      uploaded fixture, and the captured provider request must contain it
#   4. workflow listing
#   5. task kickoff (creates task folder + brief)
#
# Does NOT wait for the engine subprocess to finish — the spawned `pi`
# process is detached. We only verify the API record + the cwd folder
# layout that the launcher set up.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
FIXTURE_DIR="$TESTS_DIR/fixtures/run-ui-smoke"
PROVIDER_FIXTURE="$TESTS_DIR/fixtures/providers/openai-tool-loop-server.mjs"

# Unique value that exists only inside sample-brief.txt. The chat journey
# cannot pass on an ungrounded ("please upload the file") response because
# the deterministic provider can only echo this sentinel when the grounded
# file context was part of the request it received.
SENTINEL="SMOKE-VAULT-AZUREFALCON-4738"
SENTINEL_PATTERN='SMOKE-VAULT-[A-Z0-9-]+'
QUESTION="What is the vault code mentioned in the uploaded file?"

if [[ ! -f "$FIXTURE_DIR/sample-brief.txt" ]]; then
  echo "Smoke test failed: fixture sample-brief.txt missing" >&2
  exit 1
fi

if ! grep -qF "$SENTINEL" "$FIXTURE_DIR/sample-brief.txt"; then
  echo "Smoke test failed: fixture sample-brief.txt does not contain the sentinel $SENTINEL" >&2
  exit 1
fi

WORKSPACE="$(mktemp -d "${TMPDIR:-/tmp}/run-ui-smoke.XXXXXX")"
SERVER_LOG="$WORKSPACE/.api-server.log"
PROVIDER_LOG="$WORKSPACE/.provider-fixture.log"
PROVIDER_REQUESTS="$WORKSPACE/provider-requests.jsonl"
SERVER_PID=""
PROVIDER_PID=""

kill_port_listener() {
  local url="$1"
  local port="${url##*:}"
  if [[ -z "$port" || "$port" == "$url" ]]; then
    return 0
  fi
  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi
  local pids
  pids="$(lsof -ti "tcp:$port" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    kill $pids 2>/dev/null || true
  fi
}

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "$PROVIDER_PID" ]] && kill -0 "$PROVIDER_PID" 2>/dev/null; then
    kill "$PROVIDER_PID" 2>/dev/null || true
    wait "$PROVIDER_PID" 2>/dev/null || true
  fi
  # $SERVER_PID is a wrapper subshell; killing it orphans the npx/tsx/node
  # chain below it. Kill the process actually bound to the API port so its
  # parents exit on their own.
  kill_port_listener "${BASE:-}"
  rm -rf "$WORKSPACE"
}
trap cleanup EXIT

# ──────────────────────────────────────────────────────────────────
# 0. Start the deterministic OpenAI-compatible provider fixture
# ──────────────────────────────────────────────────────────────────
PROVIDER_FIXTURE_REQUEST_LOG="$PROVIDER_REQUESTS" \
PROVIDER_FIXTURE_SENTINEL_PATTERN="$SENTINEL_PATTERN" \
node "$PROVIDER_FIXTURE" >"$PROVIDER_LOG" 2>&1 &
PROVIDER_PID=$!

FIXTURE_BASE=""
for i in $(seq 1 20); do
  FIXTURE_BASE="$(sed -n 's/.*"url":"\(http:\/\/[^"]*\)".*/\1/p' "$PROVIDER_LOG" 2>/dev/null | tail -n1)"
  if [[ -n "$FIXTURE_BASE" ]]; then
    break
  fi
  sleep 0.5
done

if [[ -z "$FIXTURE_BASE" ]]; then
  echo "Smoke test failed: provider fixture did not report its URL" >&2
  echo "--- provider fixture log ---" >&2
  cat "$PROVIDER_LOG" >&2 || true
  exit 1
fi
echo "Provider fixture: $FIXTURE_BASE"

PORT="${RUN_UI_SMOKE_PORT:-0}"
HOST="127.0.0.1"
BASE=""

(
  cd "$REPO_ROOT"
  API_HOST="$HOST" \
  API_PORT="$PORT" \
  API_WORKSPACE_PATH="$WORKSPACE" \
  TEAM_RUNTIME_TASK_RUNNER_DRY_RUN=1 \
  OPENAI_API_KEY="run-ui-smoke-key" \
  WORKFLOW_GENERATOR_OPENAI_API_URL="$FIXTURE_BASE/v1/chat/completions" \
  npx tsx server/api-server.ts >"$SERVER_LOG" 2>&1
) &
SERVER_PID=$!

# Wait for the API to print its bound URL, then wait for /health up to 30s.
for i in $(seq 1 60); do
  BASE="$(sed -n 's/.*Team Runtime API listening on \(http:\/\/[^ ]*\).*/\1/p' "$SERVER_LOG" 2>/dev/null | tail -n1)"
  if [[ -z "$BASE" ]]; then
    sleep 0.5
    continue
  fi
  if curl -fsS "$BASE/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if [[ -z "$BASE" ]] || ! curl -fsS "$BASE/health" >/dev/null 2>&1; then
  echo "Smoke test failed: API server did not become healthy" >&2
  echo "--- server log ---" >&2
  cat "$SERVER_LOG" >&2 || true
  exit 1
fi

JSON_HEADER="content-type: application/json"

# ──────────────────────────────────────────────────────────────────
# 1. Create a session
# ──────────────────────────────────────────────────────────────────
SESSION_JSON="$(curl -fsS -X POST -H "$JSON_HEADER" -d '{"title":"Smoke Test Session"}' "$BASE/sessions")"
SESSION_ID="$(printf '%s' "$SESSION_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
if [[ -z "$SESSION_ID" ]]; then
  echo "Smoke test failed: could not extract session id from $SESSION_JSON" >&2
  exit 1
fi
echo "Created session: $SESSION_ID"

if [[ ! -d "$WORKSPACE/sessions/$SESSION_ID" ]]; then
  echo "Smoke test failed: session directory was not created at $WORKSPACE/sessions/$SESSION_ID" >&2
  exit 1
fi

# ──────────────────────────────────────────────────────────────────
# 2. Upload the fixture file
# ──────────────────────────────────────────────────────────────────
curl -fsS -X POST \
  -H "x-filename: sample-brief.txt" \
  -H "content-type: application/octet-stream" \
  --data-binary @"$FIXTURE_DIR/sample-brief.txt" \
  "$BASE/sessions/$SESSION_ID/files" >/dev/null

if [[ ! -f "$WORKSPACE/sessions/$SESSION_ID/inputs/sample-brief.txt" ]]; then
  echo "Smoke test failed: uploaded file did not appear under session inputs/" >&2
  exit 1
fi

if [[ ! -d "$WORKSPACE/sessions/$SESSION_ID/inputs/parsed" ]]; then
  echo "Smoke test failed: parser did not produce a parsed/ directory" >&2
  ls -la "$WORKSPACE/sessions/$SESSION_ID/inputs/" >&2 || true
  exit 1
fi

if [[ ! -f "$WORKSPACE/sessions/$SESSION_ID/inputs/parsed/_manifest.json" ]]; then
  echo "Smoke test failed: parser manifest missing" >&2
  exit 1
fi

FILES_LIST="$(curl -fsS "$BASE/sessions/$SESSION_ID/files")"
if ! printf '%s' "$FILES_LIST" | grep -q '"sample-brief.txt"'; then
  echo "Smoke test failed: GET files did not include sample-brief.txt — got $FILES_LIST" >&2
  exit 1
fi

if ! printf '%s' "$FILES_LIST" | grep -q '"parseStatus":"parsed"'; then
  echo "Smoke test failed: sample-brief.txt is not marked parsed — got $FILES_LIST" >&2
  exit 1
fi
echo "Upload + parse: OK (parseStatus=parsed)"

# ──────────────────────────────────────────────────────────────────
# 3. Post a chat message about the fixture-only sentinel
# ──────────────────────────────────────────────────────────────────
# The per-turn provider/model override routes this turn to the deterministic
# fixture started above; the API server reaches it through
# WORKFLOW_GENERATOR_OPENAI_API_URL. The fixture can only echo the sentinel
# when the grounded file context was part of the provider request.
CHAT_PAYLOAD="$(printf '{"text":"%s","provider":"openai","model":"fixture/echo-sentinel"}' "$QUESTION")"
CHAT_JSON="$(curl -fsS -X POST -H "$JSON_HEADER" \
  -d "$CHAT_PAYLOAD" \
  "$BASE/sessions/$SESSION_ID/messages")"

if ! printf '%s' "$CHAT_JSON" | grep -q '"role":"assistant"'; then
  echo "Smoke test failed: chat endpoint did not return an assistant message — got $CHAT_JSON" >&2
  exit 1
fi

if printf '%s' "$CHAT_JSON" | grep -q '"fallback":true'; then
  echo "Smoke test failed: chat turn used the offline fallback instead of the deterministic provider — got $CHAT_JSON" >&2
  exit 1
fi

# Grounding proof 1: the assistant answer contains the fixture-only sentinel.
if ! printf '%s' "$CHAT_JSON" | grep -qF "$SENTINEL"; then
  echo "Smoke test failed: assistant reply is not grounded in the uploaded file (missing $SENTINEL) — got $CHAT_JSON" >&2
  exit 1
fi

# Grounding proof 2: the exact request the provider received carried the
# sentinel (via the bounded file context in the system prompt).
if [[ ! -f "$PROVIDER_REQUESTS" ]] || ! grep -qF "$SENTINEL" "$PROVIDER_REQUESTS"; then
  echo "Smoke test failed: no provider request contained the sentinel $SENTINEL" >&2
  cat "$PROVIDER_REQUESTS" >&2 2>/dev/null || true
  exit 1
fi

if [[ ! -f "$WORKSPACE/sessions/$SESSION_ID/chat.jsonl" ]]; then
  echo "Smoke test failed: chat.jsonl was not written" >&2
  exit 1
fi

# chat.jsonl must contain only the textual user/assistant turns — exactly
# two lines, user first, no attachment-only message, and no wholesale dump
# of the uploaded file material.
CHAT_LINES="$(wc -l < "$WORKSPACE/sessions/$SESSION_ID/chat.jsonl" | tr -d ' ')"
if [[ "$CHAT_LINES" -ne 2 ]]; then
  echo "Smoke test failed: chat.jsonl should contain exactly 2 lines (user + assistant), got $CHAT_LINES" >&2
  cat "$WORKSPACE/sessions/$SESSION_ID/chat.jsonl" >&2
  exit 1
fi

CHAT_ROLES="$(sed -n 's/.*"role":"\([^"]*\)".*/\1/p' "$WORKSPACE/sessions/$SESSION_ID/chat.jsonl" | tr '\n' ' ')"
if [[ "$CHAT_ROLES" != "user assistant " ]]; then
  echo "Smoke test failed: chat.jsonl roles should be 'user assistant', got '$CHAT_ROLES'" >&2
  cat "$WORKSPACE/sessions/$SESSION_ID/chat.jsonl" >&2
  exit 1
fi

if ! head -n1 "$WORKSPACE/sessions/$SESSION_ID/chat.jsonl" | grep -qF "\"text\":\"$QUESTION\""; then
  echo "Smoke test failed: first chat.jsonl line is not the textual user question" >&2
  cat "$WORKSPACE/sessions/$SESSION_ID/chat.jsonl" >&2
  exit 1
fi

if grep -qF "AcmeWidget v0" "$WORKSPACE/sessions/$SESSION_ID/chat.jsonl"; then
  echo "Smoke test failed: chat.jsonl contains raw uploaded file material (attachment-only or dump message)" >&2
  cat "$WORKSPACE/sessions/$SESSION_ID/chat.jsonl" >&2
  exit 1
fi
echo "Chat round-trip: OK (grounded reply echoes $SENTINEL; chat.jsonl has 2 textual turns)"

# ──────────────────────────────────────────────────────────────────
# 4. List workflows
# ──────────────────────────────────────────────────────────────────
WORKFLOWS_JSON="$(curl -fsS "$BASE/workflows")"
WORKFLOW_ID="$(printf '%s' "$WORKFLOWS_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -n1)"
if [[ -z "$WORKFLOW_ID" ]]; then
  echo "Smoke test failed: could not find any workflow id in $WORKFLOWS_JSON" >&2
  exit 1
fi
echo "Picked workflow: $WORKFLOW_ID"

# ──────────────────────────────────────────────────────────────────
# 5. Start a task (stub kickoff)
# ──────────────────────────────────────────────────────────────────
TASK_PAYLOAD="$(printf '{"workflowId":"%s","brief":"Smoke test task brief."}' "$WORKFLOW_ID")"
TASK_JSON="$(curl -fsS -X POST -H "$JSON_HEADER" -d "$TASK_PAYLOAD" \
  "$BASE/sessions/$SESSION_ID/tasks")"
TASK_ID="$(printf '%s' "$TASK_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -n1)"
if [[ -z "$TASK_ID" ]]; then
  echo "Smoke test failed: could not extract task id from $TASK_JSON" >&2
  exit 1
fi

TASK_DIR="$WORKSPACE/sessions/$SESSION_ID/tasks/$TASK_ID"
if [[ ! -d "$TASK_DIR" ]]; then
  echo "Smoke test failed: task directory was not created at $TASK_DIR" >&2
  exit 1
fi

if [[ ! -f "$TASK_DIR/incoming-brief.md" ]]; then
  echo "Smoke test failed: incoming-brief.md missing in task dir" >&2
  exit 1
fi

if ! grep -q "$WORKFLOW_ID" "$TASK_DIR/incoming-brief.md"; then
  echo "Smoke test failed: workflow id not present in task brief" >&2
  exit 1
fi

if [[ ! -f "$TASK_DIR/task.json" ]]; then
  echo "Smoke test failed: task.json missing" >&2
  exit 1
fi

RUN_ID="$(printf '%s' "$TASK_JSON" | sed -n 's/.*"runId":"\([^"]*\)".*/\1/p' | head -n1)"
if [[ -z "$RUN_ID" ]]; then
  echo "Smoke test failed: task response did not include runId — got $TASK_JSON" >&2
  exit 1
fi

# The task record carries the authoritative assignmentPath once the runner
# starts (sessions/<id>/runs/<runId>/assignments/<runId>). Poll the record
# and fall back to the legacy workspace-level location.
ASSIGNMENT_DIR=""
for i in $(seq 1 60); do
  TASK_RECORD="$(curl -fsS "$BASE/sessions/$SESSION_ID/tasks/$TASK_ID" 2>/dev/null || true)"
  CANDIDATE="$(printf '%s' "$TASK_RECORD" | sed -n 's/.*"assignmentPath":"\([^"]*\)".*/\1/p' | head -n1)"
  if [[ -n "$CANDIDATE" ]] && [[ -f "$CANDIDATE/logs/engine-events.jsonl" ]]; then
    ASSIGNMENT_DIR="$CANDIDATE"
    break
  fi
  if [[ -f "$WORKSPACE/assignments/$RUN_ID/logs/engine-events.jsonl" ]]; then
    ASSIGNMENT_DIR="$WORKSPACE/assignments/$RUN_ID"
    break
  fi
  sleep 0.5
done

if [[ -z "$ASSIGNMENT_DIR" ]]; then
  echo "Smoke test failed: assignment engine events missing for run $RUN_ID" >&2
  find "$WORKSPACE" -maxdepth 6 -type f | sort >&2 || true
  exit 1
fi

if ! grep -q '"run.session_started"' "$ASSIGNMENT_DIR/logs/engine-events.jsonl"; then
  echo "Smoke test failed: assignment did not record run.session_started" >&2
  cat "$ASSIGNMENT_DIR/logs/engine-events.jsonl" >&2 || true
  exit 1
fi
echo "Task kickoff: OK ($TASK_ID)"

# ──────────────────────────────────────────────────────────────────
# 6. Running state: SSE events snapshot endpoint accessible
# ──────────────────────────────────────────────────────────────────
# GET /runs/:runId/events?snapshot=1 returns the event array that
# openRunEventStream (runtime-client.ts) reads to populate the task
# timeline. Verifying this endpoint confirms the data layer that
# drives the running-state task-strip tab + StageTimeline is live.
EVENTS_SNAPSHOT="$(curl -fsS "$BASE/runs/$RUN_ID/events?snapshot=1" 2>/dev/null || true)"
if [[ -z "$EVENTS_SNAPSHOT" ]]; then
  echo "Smoke test failed: GET /runs/$RUN_ID/events?snapshot=1 returned empty body" >&2
  exit 1
fi
if ! printf '%s' "$EVENTS_SNAPSHOT" | grep -q '"events"'; then
  echo "Smoke test failed: /runs/$RUN_ID/events?snapshot=1 did not return events JSON — got $EVENTS_SNAPSHOT" >&2
  exit 1
fi
echo "Running state SSE snapshot: OK"

# ──────────────────────────────────────────────────────────────────
# 7. Task completion: run.completed event in engine log
# ──────────────────────────────────────────────────────────────────
# DRY_RUN tasks complete synchronously but run in a detached subprocess;
# wait up to 30 s for run.completed to appear in the engine events log.
# This event is what transitions TaskRunEntry.mode → 'done' in RunPanel.tsx.
for i in $(seq 1 60); do
  if grep -q '"run.completed"' "$ASSIGNMENT_DIR/logs/engine-events.jsonl" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

if ! grep -q '"run.completed"' "$ASSIGNMENT_DIR/logs/engine-events.jsonl"; then
  echo "Smoke test failed: run.completed event not found in engine events log" >&2
  cat "$ASSIGNMENT_DIR/logs/engine-events.jsonl" >&2 || true
  exit 1
fi
echo "Task completion event: OK"

# ──────────────────────────────────────────────────────────────────
# 8. Done view data: artifact.written event recorded
# ──────────────────────────────────────────────────────────────────
# RunPanel.tsx captures artifact.written events to set
# TaskRunEntry.artifactPath, which DoneView.tsx passes to fetchArtifact().
# Verify at least one artifact.written event exists for this run.
if ! grep -q '"artifact.written"' "$ASSIGNMENT_DIR/logs/engine-events.jsonl"; then
  echo "Smoke test failed: artifact.written event not found — DoneView would have no artifactPath to fetch" >&2
  exit 1
fi
echo "Artifact written event: OK"

# ──────────────────────────────────────────────────────────────────
# 9. Done view artifact container: GET /runs/:runId/assignments/:path
# ──────────────────────────────────────────────────────────────────
# DoneView.tsx calls fetchArtifact(runId, artifactPath) which resolves to
# GET /runs/:runId/assignments/:artifactPath.  Extract the result artifact
# path from the artifact.written events (artifact_type=result) in the log,
# falling back to the dry-run predictable path if sed extraction fails.
ARTIFACT_PATH="$(grep '"artifact.written"' "$ASSIGNMENT_DIR/logs/engine-events.jsonl" | \
  grep '"artifact_type":"result"' | \
  sed -n 's/.*"path":"\([^"]*\)".*/\1/p' | head -n1)"
if [[ -z "$ARTIFACT_PATH" ]]; then
  # Dry-run always writes this predictable path relative to the assignment dir
  ARTIFACT_PATH="workflow-${WORKFLOW_ID}-result.md"
fi

ARTIFACT_HTTP_STATUS="$(curl -fsS -o /dev/null -w "%{http_code}" \
  "$BASE/runs/$RUN_ID/assignments/$ARTIFACT_PATH" 2>/dev/null || echo 000)"
if [[ "$ARTIFACT_HTTP_STATUS" != "200" ]]; then
  echo "Smoke test failed: GET /runs/$RUN_ID/assignments/$ARTIFACT_PATH returned HTTP $ARTIFACT_HTTP_STATUS (expected 200)" >&2
  echo "  Artifact path: $ARTIFACT_PATH" >&2
  exit 1
fi

ARTIFACT_CONTENT="$(curl -fsS "$BASE/runs/$RUN_ID/assignments/$ARTIFACT_PATH" 2>/dev/null || true)"
if [[ -z "$ARTIFACT_CONTENT" ]]; then
  echo "Smoke test failed: artifact content is empty — DoneView MarkdownViewer would render blank" >&2
  exit 1
fi
echo "Done view artifact endpoint: OK (artifact path: $ARTIFACT_PATH, ${#ARTIFACT_CONTENT} bytes)"

# ──────────────────────────────────────────────────────────────────
# 10. Task status: backend marks task as done
# ──────────────────────────────────────────────────────────────────
# GET /sessions/:sessionId/tasks/:taskId returns the persisted task record.
# This is the source of truth that mirrors what TaskRunEntry.mode tracks
# in the UI; confirming status=done validates the full lifecycle.
TASK_STATUS_JSON="$(curl -fsS "$BASE/sessions/$SESSION_ID/tasks/$TASK_ID" 2>/dev/null || true)"
if ! printf '%s' "$TASK_STATUS_JSON" | grep -q '"status":"done"'; then
  echo "Smoke test failed: task status is not 'done' — got $TASK_STATUS_JSON" >&2
  exit 1
fi
echo "Task status done: OK"

echo ""
echo "Run UI smoke test passed."
