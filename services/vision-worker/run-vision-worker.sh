#!/bin/bash
# Launcher wrapper for com.congress.trade.vision-worker (pm2 / launchd).
# Fetches secrets exclusively from Infisical (prod /) via a scoped service
# token (`vision-worker-ct-ro`), never from ambient env vars or retired
# fleet-secrets.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PYTHON_BIN="${VISION_WORKER_PYTHON:-}"

# Strip ambient secret and Infisical env vars so Infisical stays sole source.
unset ADMIN_TOKEN CT_ADMIN_TOKEN OPENROUTER_API_KEY CT_OPENROUTER_API_KEY \
  PUSHOVER_APP_TOKEN PUSHOVER_USER_KEY \
  INFISICAL_TOKEN INFISICAL_CLIENT_ID INFISICAL_CLIENT_SECRET \
  INFISICAL_UNIVERSAL_AUTH_CLIENT_ID INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET || true

if [[ -z "${PYTHON_BIN}" ]]; then
  if [[ -x "${HOME}/vision-worker-venv/bin/python3" ]]; then
    PYTHON_BIN="${HOME}/vision-worker-venv/bin/python3"
  else
    PYTHON_BIN="$(command -v python3)"
  fi
fi

exec "$PYTHON_BIN" "$HERE/launch_with_infisical.py" "$HERE/worker.py" "$@"
