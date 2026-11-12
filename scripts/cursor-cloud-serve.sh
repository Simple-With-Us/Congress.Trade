#!/usr/bin/env bash
# Cursor Cloud dev server for Congress.Trade (Deno backend, src/deno/main.ts).
#
# Runs the same Hono app production serves, but wired for keyless local dev:
#   * a local SQLite file (libsql `file:` URL) instead of the production DB,
#   * a local Deno KV file,
#   * Infisical disabled -> secrets resolve from process env / .prod.vars,
#   * admin API opened via a per-boot random ADMIN_TOKEN (never committed),
#   * the internal cron disabled (no background polling of live House/Senate/OGE
#     sources) — drive a tick manually with POST /api/admin/runtime-tick,
#   * the public-API scrape guard off so plain curl works against /api/*.
#
# On boot it applies the schema via POST /api/admin/migrate (the same idempotent
# statement list production uses) and loads the committed preview fixtures so the
# dashboard has data out of the box. Both steps are idempotent. This is a
# long-running foreground process — run it as a terminal, not in `install`.
set -euo pipefail

DENO_DIR="${DENO_INSTALL:-$HOME/.deno}"
export PATH="$DENO_DIR/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../app" && pwd)"
cd "$APP_DIR"

# Runtime state lives outside the repo so it is never committed.
DEV_STATE_DIR="${CT_DEV_STATE_DIR:-$HOME/.congress-trade-dev}"
mkdir -p "$DEV_STATE_DIR"

export PORT="${PORT:-8787}"
# Force an isolated local SQLite file. This is deliberately NOT `:-` defaulted:
# the Cloud Agent VM injects a production `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`
# as secrets, and a dev server must never connect to (or seed into) production.
export TURSO_DATABASE_URL="file:$DEV_STATE_DIR/db.sqlite"
export TURSO_AUTH_TOKEN=""
export DENO_KV_PATH="$DEV_STATE_DIR/kv.sqlite"
# Mark this as a non-production run: enables the local admin escape hatch and
# keeps telemetry/observability pointed away from production sinks.
export SENTRY_ENVIRONMENT="development"
export USAGE_MONITOR_ENVIRONMENT="local"
export USAGE_MONITOR_ENABLED="false"
export ADMIN_OPEN_IN_DEV="true"
export DENO_DISABLE_INTERNAL_CRON="true"
export SCRAPE_GUARD_ENABLED="false"
export INFISICAL_ALLOW_ENV_FALLBACK="true"
# .prod.vars ships ADMIN_EMAILS, which marks admin as "configured" and closes the
# ADMIN_OPEN_IN_DEV escape hatch. A per-boot random bearer token re-opens admin
# for local curl without committing any secret.
export ADMIN_TOKEN="${ADMIN_TOKEN:-$(openssl rand -hex 24)}"

# Start the server in the background so its logs stream to this terminal, run
# the schema+seed bootstrap in the foreground (reliable, ordered output), then
# hand the terminal back to the server via `wait`.
echo "[serve] starting Congress.Trade Deno server on http://localhost:$PORT"
deno run \
  --allow-net --allow-env --allow-read --allow-write --allow-sys --allow-ffi \
  --unstable-kv --unstable-cron \
  src/deno/main.ts &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' INT TERM EXIT

bootstrap() {
  set +e
  local base="http://localhost:$PORT"
  local code=""
  # Poll the static /health liveness route (no DB, uncached). Deliberately NOT
  # /api/health: that route caches its readiness verdict for 60s, so probing it
  # before the schema exists would pin a stale schema:false for a minute.
  for _ in $(seq 1 90); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$base/health" 2>/dev/null)"
    if [ -n "$code" ] && [ "$code" != "000" ]; then break; fi
    kill -0 "$SERVER_PID" 2>/dev/null || { echo "[bootstrap] server exited before it was ready"; return; }
    sleep 1
  done

  echo "[bootstrap] server responding (health HTTP ${code:-none}); applying schema"
  # /api/admin/migrate creates the full readiness schema; on a pristine DB one
  # historical data-cleanup UPDATE errors (it references a legacy filings column
  # absent from the committed schema) and the route returns 500, but every
  # required table/column is created. Readiness (GET /api/health -> schema:true)
  # is the source of truth, so this 500 is expected and non-fatal here.
  curl -s -o /dev/null -w '[bootstrap] migrate HTTP %{http_code}\n' \
    -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$base/api/admin/migrate"

  echo "[bootstrap] loading preview fixtures (idempotent)"
  # --allow-sys: the libsql native module probes the platform (process.report)
  # on load, the same reason the server itself runs with --allow-sys.
  deno run --allow-net --allow-env --allow-read --allow-sys --allow-ffi \
    "$SCRIPT_DIR/seed-local-db.ts"

  # First /api/health call after migrate computes a fresh readiness verdict.
  if curl -s "$base/api/health" | grep -q '"schema":true'; then
    echo "[bootstrap] READY — dashboard: $base/   health: $base/api/health"
  else
    echo "[bootstrap] WARNING: schema not reported ready; check server logs above"
  fi
}

bootstrap

# Keep this process (and the terminal) attached to the server.
wait "$SERVER_PID"
