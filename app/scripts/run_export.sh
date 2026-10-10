#!/bin/bash
set -e
# prod is the only Infisical environment (owner 2026-10-10:  dev and staging are retired).
case "${INFISICAL_ENV:-prod}" in
  prod) ;;
  *) echo "run_export: INFISICAL_ENV must be prod (dev and staging are retired)" >&2; exit 1 ;;
esac
export INFISICAL_TOKEN=$(infisical login --method=universal-auth --client-id="${INFISICAL_APP_CLIENT_ID}" --client-secret="${INFISICAL_APP_CLIENT_SECRET}" --silent --plain)
infisical export --projectId "${INFISICAL_APP_PROJECT_ID}" --env prod --format dotenv-export > .env.prod
source .env.prod
deno run -A scripts/export_trades.ts
