#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
FIXTURE_DIR="$TESTS_DIR/fixtures/openrouter-reception-to-writing-e2e"
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-openrouter-reception.XXXXXX")"

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
    perl -e 'alarm shift; exec @ARGV' 600 \
    pi --provider openrouter --model openai/gpt-4o-mini \
      -p --no-session -e "$REPO_ROOT/team-runtime/index.ts" \
      "Create a 1 page report on Microsoft."
)

PARENT_ASSIGNMENT="$(find "$RUN_DIR" -type d -path '*/workspace/assignments/*reception-desk' -print -quit 2>/dev/null || true)"
CHILD_ASSIGNMENT="$(find "$RUN_DIR" -type d -path '*/workspace/assignments/*writing-team' -print -quit 2>/dev/null || true)"
FINAL_DRAFT="$(find "$RUN_DIR" -type f -path '*/workspace/assignments/*writing-team/final-draft.md' -print -quit 2>/dev/null || true)"
DRAFT_PACKAGE="$(find "$RUN_DIR" -type f -path '*/workspace/assignments/*writing-team/draft-package.md' -print -quit 2>/dev/null || true)"

if [[ -z "$PARENT_ASSIGNMENT" || -z "$CHILD_ASSIGNMENT" || -z "$FINAL_DRAFT" || -z "$DRAFT_PACKAGE" ]]; then
  echo "OpenRouter reception-to-writing E2E failed: expected assignment artifacts were not created" >&2
  exit 1
fi

grep -q 'status: "completed"' "$PARENT_ASSIGNMENT/delegation-writing-team-result.md" || {
  echo "OpenRouter reception-to-writing E2E failed: delegation did not complete successfully" >&2
  exit 1
}

grep -q '"target_team": "writing-team"' "$PARENT_ASSIGNMENT/job-request.md" || {
  echo "OpenRouter reception-to-writing E2E failed: job-request.md did not record writing-team as the target" >&2
  exit 1
}

grep -q 'Microsoft' "$DRAFT_PACKAGE" || {
  echo "OpenRouter reception-to-writing E2E failed: draft package did not preserve the Microsoft topic" >&2
  exit 1
}

grep -qi '^# Microsoft' "$FINAL_DRAFT" || {
  echo "OpenRouter reception-to-writing E2E failed: final draft missing a Microsoft heading" >&2
  exit 1
}

grep -qi 'Microsoft' "$FINAL_DRAFT" || {
  echo "OpenRouter reception-to-writing E2E failed: final draft missing Microsoft content" >&2
  exit 1
}

grep -q '<review_decision>APPROVE</review_decision>' "$CHILD_ASSIGNMENT/review-feedback-v1.md" || {
  echo "OpenRouter reception-to-writing E2E failed: review-feedback-v1.md missing structured approval tag" >&2
  exit 1
}

echo "OpenRouter reception-to-writing E2E passed: $FINAL_DRAFT"
