#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
FIXTURE_DIR="$TESTS_DIR/fixtures/writing-template-validator-e2e"
ROOT_RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-template-validator.XXXXXX")"

cleanup() {
  rm -rf "$ROOT_RUN_DIR"
}
trap cleanup EXIT

run_case() {
  local case_name="$1"
  local prompt="$2"
  local run_dir="$ROOT_RUN_DIR/$case_name"

  mkdir -p "$run_dir"
  cp -R "$FIXTURE_DIR"/. "$run_dir"/
  mkdir -p "$run_dir/.pi-agent"

  (
    cd "$run_dir"
    env \
      PI_CODING_AGENT_DIR="$run_dir/.pi-agent" \
      perl -e 'alarm shift; exec @ARGV' 600 \
      pi -p --no-session -e "$REPO_ROOT/team-runtime/index.ts" \
      "$prompt"
  )
}

run_case bad 'Create a BAD-STRUCTURE executive summary so the writing-team validator path is exercised.'
run_case good 'Create a GOOD-STRUCTURE executive summary so the writing-team validator path is exercised.'

BAD_CHILD="$(find "$ROOT_RUN_DIR/bad/workspace/assignments" -maxdepth 1 -type d -name '*writing-team' -print -quit 2>/dev/null || true)"
GOOD_CHILD="$(find "$ROOT_RUN_DIR/good/workspace/assignments" -maxdepth 1 -type d -name '*writing-team' -print -quit 2>/dev/null || true)"

if [[ -z "$BAD_CHILD" || -z "$GOOD_CHILD" ]]; then
  echo "Template-validator E2E failed: writing-team assignment directory missing for one or both cases" >&2
  exit 1
fi

BAD_FEEDBACK_V1="$BAD_CHILD/review-feedback-v1.md"
BAD_FEEDBACK_V2="$BAD_CHILD/review-feedback-v2.md"
BAD_REVIEW_LOG="$BAD_CHILD/logs/review-events.jsonl"
BAD_FINAL="$BAD_CHILD/final-draft.md"

GOOD_FEEDBACK="$GOOD_CHILD/review-feedback-v1.md"
GOOD_FINAL="$GOOD_CHILD/final-draft.md"

for required in \
  "$BAD_FEEDBACK_V1" \
  "$BAD_FEEDBACK_V2" \
  "$BAD_REVIEW_LOG" \
  "$GOOD_FEEDBACK" \
  "$GOOD_FINAL"
do
  if [[ ! -f "$required" ]]; then
    echo "Template-validator E2E failed: missing expected file $required" >&2
    exit 1
  fi
done

if [[ -f "$BAD_FINAL" ]]; then
  echo "Template-validator E2E failed: bad structure case unexpectedly produced final-draft.md" >&2
  exit 1
fi

grep -q 'Required template heading is missing' "$BAD_FEEDBACK_V1" || {
  echo "Template-validator E2E failed: bad case review feedback did not report missing required headings" >&2
  exit 1
}

grep -q '## Context' "$BAD_FEEDBACK_V1" || {
  echo "Template-validator E2E failed: bad case feedback did not require the Task heading explicitly" >&2
  exit 1
}

grep -q '"step":"validator.template-structure.failed"' "$BAD_REVIEW_LOG" || {
  echo "Template-validator E2E failed: bad case review log did not record validator.template-structure.failed" >&2
  exit 1
}

grep -q '<review_decision>APPROVE</review_decision>' "$GOOD_FEEDBACK" || {
  echo "Template-validator E2E failed: good case review feedback missing approval tag" >&2
  exit 1
}

for heading in \
  '## Context' \
  '## Executive Summary' \
  '## Main Findings' \
  '## Recommended Next Steps' \
  '## Open Questions And Assumptions'
do
  grep -q "$heading" "$GOOD_FINAL" || {
    echo "Template-validator E2E failed: good case final draft missing heading $heading" >&2
    exit 1
  }
done

echo "Template-validator E2E passed: bad case blocked and good case approved"
