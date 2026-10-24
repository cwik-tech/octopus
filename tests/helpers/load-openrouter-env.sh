#!/bin/zsh

load_openrouter_env() {
  local repo_root="$1"

  if [[ -f "$repo_root/.env" ]]; then
    set -a
    source "$repo_root/.env"
    set +a
  fi
}

require_openrouter_env() {
  if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
    echo "Skipping OpenRouter live test: OPENROUTER_API_KEY is not set." >&2
    return 1
  fi
  return 0
}
