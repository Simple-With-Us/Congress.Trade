#!/bin/bash
# Launcher wrapper for com.congress.trade.vision-worker (pm2 / launchd).
# Fetches secrets exclusively from Infisical (prod /) via a scoped service
# token (`vision-worker-ct-ro`), never from ambient env vars or retired
# fleet-secrets.
set -euo pipefail

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
export OPENROUTER_MODEL="${OPENROUTER_MODEL:-x-ai/grok-4.7}"
# Cheap VL after a missed Grok CLI solo pass. Qwen gets page images, not PDF.
export OPENROUTER_CASCADE_MODELS="${OPENROUTER_CASCADE_MODELS:-qwen/qwen3-vl-8b-instruct,qwen/qwen3-vl-30b-a3b-instruct,google/gemini-4-hydrogen}"
export OPENROUTER_CASCADE_MAX_PAGES="${OPENROUTER_CASCADE_MAX_PAGES:-8}"
export OPENROUTER_TIMEOUT_SEC="${OPENROUTER_TIMEOUT_SEC:-600}"
export PYTHONUNBUFFERED=1
export PATH="$HOME/.grok/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"

# Strip ambient secret and Infisical env vars so Infisical stays sole source.
unset ADMIN_TOKEN CT_ADMIN_TOKEN OPENROUTER_API_KEY CT_OPENROUTER_API_KEY \
  PUSHOVER_APP_TOKEN PUSHOVER_USER_KEY \
  INFISICAL_TOKEN INFISICAL_CLIENT_ID INFISICAL_CLIENT_SECRET \
  INFISICAL_UNIVERSAL_AUTH_CLIENT_ID INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET || true

PYTHON_BIN="${VISION_WORKER_PYTHON:-}"
if [[ -z "${PYTHON_BIN}" ]]; then
  if [[ -x "${HOME}/vision-worker-venv/bin/python3" ]]; then
    PYTHON_BIN="${HOME}/vision-worker-venv/bin/python3"
  else
    PYTHON_BIN="$(command -v python3 || true)"
    if [[ -z "${PYTHON_BIN}" ]]; then
      PYTHON_BIN="/usr/bin/python3"
    fi
  fi
fi

exec "$PYTHON_BIN" "$HERE/launch_with_infisical.py" "$HERE/worker.py" "$@"
