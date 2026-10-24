#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
USER_INPUT_DIR="$REPO_ROOT/input-files"
INPUT_DIR="$USER_INPUT_DIR"
PARSED_DIR="$INPUT_DIR/parsed"
LIVE_STAGE_DIR=""
OUTPUT_DISPLAY_DIR="input-files/parsed"

cleanup_live_stage() {
  if [[ -n "$LIVE_STAGE_DIR" && -d "$LIVE_STAGE_DIR" ]]; then
    rm -rf -- "$LIVE_STAGE_DIR"
  fi
}

trap cleanup_live_stage EXIT

cd "$REPO_ROOT"

if [[ ! -d "$USER_INPUT_DIR" ]]; then
  echo "E2E test failed: input-files directory does not exist" >&2
  exit 1
fi

if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  source "$REPO_ROOT/.env"
  set +a
fi

export FILE_PARSER_LLM_ENABLED="${FILE_PARSER_LLM_ENABLED:-${FILE_PARSER_LM_ENABLED:-1}}"

find_root_source() {
  find "$USER_INPUT_DIR" -maxdepth 1 -type f \
    ! -name '.*' \
    ! -name '*.md' \
    ! -name '*.txt' \
    ! -name '*.json' \
    ! -name '*.csv' \
    ! -name '*.yaml' \
    ! -name '*.yml' \
    ! -name '*.xml' \
    ! -name '*.html' \
    -print | sort | head -n 1
}

SOURCE_FILE="${FILE_PARSER_LIVE_INPUT:-}"
if [[ -n "$SOURCE_FILE" && "$SOURCE_FILE" != /* ]]; then
  SOURCE_FILE="$REPO_ROOT/$SOURCE_FILE"
fi

if [[ -z "$SOURCE_FILE" ]]; then
  SOURCE_FILE="$(find_root_source)"
fi

if [[ -z "$SOURCE_FILE" ]]; then
  SOURCE_FILE="$REPO_ROOT/file-parser/tests/fixtures/visual-deck.pdf"
  echo "No user input found; using tracked fixture: file-parser/tests/fixtures/visual-deck.pdf"
fi

if [[ -z "$SOURCE_FILE" || ! -f "$SOURCE_FILE" ]]; then
  echo "E2E test failed: source input file does not exist: $SOURCE_FILE" >&2
  exit 1
fi

SOURCE_PARENT="$(cd "$(dirname "$SOURCE_FILE")" && pwd -P)"
USER_INPUT_ROOT="$(cd "$USER_INPUT_DIR" && pwd -P)"
if [[ "$SOURCE_PARENT" != "$USER_INPUT_ROOT" ]]; then
  LIVE_TEMP_ROOT="${TMPDIR:-/tmp}"
  LIVE_STAGE_DIR="$(mktemp -d "${LIVE_TEMP_ROOT%/}/pipeline-file-parser-live.XXXXXX")"
  if [[ -z "$LIVE_STAGE_DIR" || ! -d "$LIVE_STAGE_DIR" ]]; then
    echo "E2E test failed: could not create temporary parser workspace" >&2
    exit 1
  fi
  TARGET_SOURCE="$LIVE_STAGE_DIR/$(basename "$SOURCE_FILE")"
  cp "$SOURCE_FILE" "$TARGET_SOURCE"
  SOURCE_FILE="$TARGET_SOURCE"
  INPUT_DIR="$LIVE_STAGE_DIR"
  PARSED_DIR="$INPUT_DIR/parsed"
  OUTPUT_DISPLAY_DIR="temporary-parser-workspace/parsed"
fi

SOURCE_NAME="$(basename "$SOURCE_FILE")"

echo "Running live file-parser E2E on: $SOURCE_NAME"
echo "LLM enabled: $FILE_PARSER_LLM_ENABLED"

perl -e 'alarm shift; exec @ARGV' 600 \
  npx tsx "$REPO_ROOT/file-parser/index.ts" "$INPUT_DIR" --force

RAW_OUTPUT="$PARSED_DIR/$SOURCE_NAME.md"
STRUCTURED_OUTPUT="$PARSED_DIR/$SOURCE_NAME.structure.md"
PARSE_JSON="$PARSED_DIR/$SOURCE_NAME.parse.json"
ENRICHED_OUTPUT="$PARSED_DIR/$SOURCE_NAME.enriched.md"
ENRICHMENT_JSON="$PARSED_DIR/$SOURCE_NAME.enrichment.json"
MANIFEST_PATH="$PARSED_DIR/_manifest.json"

if [[ ! -f "$RAW_OUTPUT" ]]; then
  echo "E2E test failed: missing raw output $RAW_OUTPUT" >&2
  exit 1
fi

if [[ ! -f "$STRUCTURED_OUTPUT" ]]; then
  echo "E2E test failed: missing structured output $STRUCTURED_OUTPUT" >&2
  exit 1
fi

if [[ ! -f "$PARSE_JSON" ]]; then
  echo "E2E test failed: missing parse diagnostics $PARSE_JSON" >&2
  exit 1
fi

if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo "E2E test failed: missing manifest $MANIFEST_PATH" >&2
  exit 1
fi

echo "Live parser E2E passed for: $SOURCE_NAME"
if [[ -n "$LIVE_STAGE_DIR" ]]; then
  echo "Outputs were verified in a temporary parser workspace and will be removed on exit."
fi
echo "Outputs:"
echo "  - $OUTPUT_DISPLAY_DIR/$SOURCE_NAME.md"
echo "  - $OUTPUT_DISPLAY_DIR/$SOURCE_NAME.structure.md"
echo "  - $OUTPUT_DISPLAY_DIR/$SOURCE_NAME.parse.json"

if [[ -f "$ENRICHED_OUTPUT" ]]; then
  echo "  - $OUTPUT_DISPLAY_DIR/$SOURCE_NAME.enriched.md"
fi

if [[ -f "$ENRICHMENT_JSON" ]]; then
  echo "  - $OUTPUT_DISPLAY_DIR/$SOURCE_NAME.enrichment.json"
fi

if [[ -d "$PARSED_DIR/$SOURCE_NAME.pages" ]]; then
  echo "  - $OUTPUT_DISPLAY_DIR/$SOURCE_NAME.pages/"
fi
