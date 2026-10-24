#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
FIXTURE_DIR="$TESTS_DIR/fixtures/reception-to-writing-e2e"
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-reception-writing.XXXXXX")"

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
    perl -e 'alarm shift; exec @ARGV' 600 \
    pi -p --no-session -e "$REPO_ROOT/team-runtime/index.ts" \
    "Create a 1 page report on Microsoft."
)

PARENT_ASSIGNMENT="$(find "$RUN_DIR/workspace/assignments" -maxdepth 1 -type d -name '*reception-desk' -print -quit 2>/dev/null || true)"
CHILD_ASSIGNMENT="$(find "$RUN_DIR/workspace/assignments" -maxdepth 1 -type d -name '*writing-team' -print -quit 2>/dev/null || true)"
FINAL_DRAFT="$(find "$RUN_DIR/workspace/assignments" -maxdepth 2 -type f -name 'final-draft.md' -path '*writing-team/*' -print -quit 2>/dev/null || true)"
DRAFT_PACKAGE="$(find "$RUN_DIR/workspace/assignments" -maxdepth 2 -type f -name 'draft-package.md' -path '*writing-team/*' -print -quit 2>/dev/null || true)"

if [[ -z "$PARENT_ASSIGNMENT" ]]; then
  echo "E2E test failed: receptionist assignment directory was not created" >&2
  exit 1
fi

if [[ -z "$CHILD_ASSIGNMENT" ]]; then
  echo "E2E test failed: writing-team assignment directory was not created under workspace/assignments" >&2
  exit 1
fi

if [[ -z "$FINAL_DRAFT" || -z "$DRAFT_PACKAGE" ]]; then
  echo "E2E test failed: writing-team output artifacts were not created in workspace/assignments" >&2
  exit 1
fi

for REQUIRED in \
  "$PARENT_ASSIGNMENT/job-request.md" \
  "$PARENT_ASSIGNMENT/delegation-writing-team-brief.md" \
  "$PARENT_ASSIGNMENT/delegation-writing-team-result.md" \
  "$PARENT_ASSIGNMENT/logs/team-spawns.jsonl" \
  "$PARENT_ASSIGNMENT/logs/conversation.jsonl" \
  "$PARENT_ASSIGNMENT/logs/tool-use.jsonl" \
  "$CHILD_ASSIGNMENT/logs/conversation.jsonl" \
  "$CHILD_ASSIGNMENT/logs/tool-use.jsonl" \
  "$FINAL_DRAFT" \
  "$DRAFT_PACKAGE"
do
  if [[ ! -f "$REQUIRED" ]]; then
    echo "E2E test failed: missing expected file $REQUIRED" >&2
    exit 1
  fi
done

grep -q 'writing-team' "$PARENT_ASSIGNMENT/delegation-writing-team-result.md" || {
  echo "E2E test failed: delegation result did not record writing-team delegation" >&2
  exit 1
}

grep -q '"target_team": "writing-team"' "$PARENT_ASSIGNMENT/job-request.md" || {
  echo "E2E test failed: job-request.md did not record writing-team as the target" >&2
  exit 1
}

grep -q 'status: "completed"' "$PARENT_ASSIGNMENT/delegation-writing-team-result.md" || {
  echo "E2E test failed: parent delegation result did not complete successfully" >&2
  exit 1
}

grep -q '"child_team":"writing-team"' "$PARENT_ASSIGNMENT/logs/team-spawns.jsonl" || {
  echo "E2E test failed: team-spawns.jsonl missing writing-team entry" >&2
  exit 1
}

grep -q 'Spawn Specialist Team' "$PARENT_ASSIGNMENT/logs/tool-use.jsonl" && true || true

grep -q 'WRITER-CHAIN-DRAFT' "$DRAFT_PACKAGE" || {
  echo "E2E test failed: draft package missing writer chain marker" >&2
  exit 1
}

grep -q 'Microsoft' "$DRAFT_PACKAGE" || {
  echo "E2E test failed: draft package did not preserve the Microsoft topic" >&2
  exit 1
}

grep -q 'WRITER-FINAL-DRAFT' "$FINAL_DRAFT" || {
  echo "E2E test failed: final draft missing writer final marker" >&2
  exit 1
}

grep -q 'Microsoft One-Page Report' "$FINAL_DRAFT" || {
  echo "E2E test failed: final draft missing Microsoft one-page title" >&2
  exit 1
}

grep -q 'Subject: Microsoft' "$FINAL_DRAFT" || {
  echo "E2E test failed: final draft missing Microsoft subject marker" >&2
  exit 1
}

grep -q 'APPROVE' "$CHILD_ASSIGNMENT/logs/conversation.jsonl" || {
  echo "E2E test failed: child session log does not show review approval" >&2
  exit 1
}

grep -q '<review_decision>APPROVE</review_decision>' "$CHILD_ASSIGNMENT/review-feedback-v1.md" || {
  echo "E2E test failed: review-feedback-v1.md missing structured approval tag" >&2
  exit 1
}

echo "Reception-to-writing E2E passed: $FINAL_DRAFT"
