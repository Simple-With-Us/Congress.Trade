#!/bin/bash
# launchd wrapper - each secret comes from the environment first, then from
# `fleet-secrets get NAME` (Infisical Fleet-OPS).  Never prints them.
set -euo pipefail

FLEET_SECRETS_BIN="${FLEET_SECRETS_BIN:-$HOME/.local/bin/fleet-secrets}"

# load_secret NAME: print the value of NAME from `fleet-secrets get`, or nothing
# when the binary is missing or the key is absent / unreadable.
load_secret() {
  local key="$1"
  if [[ ! -x "$FLEET_SECRETS_BIN" ]]; then
    return 0
  fi
  "$FLEET_SECRETS_BIN" get "$key" 2>/dev/null || true
}

export CONGRESS_TRADE_API_URL="${CONGRESS_TRADE_API_URL:-https://congress.trade}"
export WORKER_ID="${WORKER_ID:-local_mac_1}"
export POLL_INTERVAL_SEC="${POLL_INTERVAL_SEC:-45}"
export HEARTBEAT_INTERVAL_SEC="${HEARTBEAT_INTERVAL_SEC:-60}"
export MAX_DOCS_PER_POLL="${MAX_DOCS_PER_POLL:-2}"
export MAX_ATTEMPTS="${MAX_ATTEMPTS:-3}"
export BACKOFF_BASE_SEC="${BACKOFF_BASE_SEC:-90}"
export EXHAUSTED_ALERT_THRESHOLD="${EXHAUSTED_ALERT_THRESHOLD:-5}"
export STATE_FILE="${STATE_FILE:-$HOME/vision-worker/attempt-state.json}"
# PRIMARY: local Grok CLI on owner xAI subscription. OpenRouter is fallback.
export VISION_ENGINE="${VISION_ENGINE:-auto}"
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
export GROK_BIN="${GROK_BIN:-$HOME/.grok/bin/grok}"
export GROK_CLI_TIMEOUT_SEC="${GROK_CLI_TIMEOUT_SEC:-900}"
export GROK_CLI_MAX_TURNS="${GROK_CLI_MAX_TURNS:-16}"
export GROK_CLI_REASONING_EFFORT="${GROK_CLI_REASONING_EFFORT:-medium}"
export GROK_CWD="${GROK_CWD:-$HERE/grok-cwd}"
export OPENROUTER_MODEL="${OPENROUTER_MODEL:-x-ai/grok-4.6}"
# Cheap VL after a missed Grok CLI solo pass. Qwen gets page images, not PDF.
export OPENROUTER_CASCADE_MODELS="${OPENROUTER_CASCADE_MODELS:-qwen/qwen3-vl-8b-instruct,qwen/qwen3-vl-30b-a3b-instruct,google/gemini-3.8-flash}"
export OPENROUTER_CASCADE_MAX_PAGES="${OPENROUTER_CASCADE_MAX_PAGES:-8}"
export OPENROUTER_TIMEOUT_SEC="${OPENROUTER_TIMEOUT_SEC:-600}"
export PYTHONUNBUFFERED=1

if [[ -z "${ADMIN_TOKEN:-}" ]]; then
  export ADMIN_TOKEN="$(load_secret CT_ADMIN_TOKEN)"
fi
if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  export OPENROUTER_API_KEY="$(load_secret CT_OPENROUTER_API_KEY)"
  if [[ -z "${OPENROUTER_API_KEY}" ]]; then
    export OPENROUTER_API_KEY="$(load_secret OPENROUTER_API_KEY)"
  fi
fi
if [[ -z "${PUSHOVER_APP_TOKEN:-}" ]]; then
  export PUSHOVER_APP_TOKEN="$(load_secret PUSHOVER_APP_TOKEN)"
fi
if [[ -z "${PUSHOVER_USER_KEY:-}" ]]; then
  export PUSHOVER_USER_KEY="$(load_secret PUSHOVER_USER_KEY)"
fi

if [[ -z "${ADMIN_TOKEN}" ]]; then
  echo "vision-worker: ADMIN_TOKEN / CT_ADMIN_TOKEN missing" >&2
  exit 2
fi

# local_cli does not need OpenRouter; openrouter/auto-with-fallback do.
if [[ "${VISION_ENGINE}" == "openrouter" && -z "${OPENROUTER_API_KEY}" ]]; then
  echo "vision-worker: OPENROUTER_API_KEY required for VISION_ENGINE=openrouter" >&2
  exit 2
fi

export PATH="$HOME/.grok/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"
PYTHON_BIN="$(command -v python3 || true)"
if [[ -z "$PYTHON_BIN" ]]; then
  PYTHON_BIN="/usr/bin/python3"
fi
exec "$PYTHON_BIN" "$HERE/worker.py"
