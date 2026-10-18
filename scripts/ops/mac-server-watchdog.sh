#!/usr/bin/env bash
# mac-server-watchdog.sh - Cross-monitoring watchdog between Mac & Coolify Server.
# Periodically pings server health endpoints, sends Mac heartbeat, and auto-heals
# both local Mac daemons and the Coolify application container if degraded.
set -euo pipefail

LOG_FILE="${HOME}/.cache/ct-mac-watchdog.log"
mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG_FILE"
}

# Tokens come from the environment first, then `fleet-secrets get NAME`
# (Infisical Fleet-OPS).  Never printed.
fleet_secret() {
  local name="$1"
  if [[ -n "${!name:-}" ]]; then
    printf '%s' "${!name}"
    return 0
  fi
  if command -v fleet-secrets >/dev/null 2>&1; then
    fleet-secrets get "$name" 2>/dev/null || true
  fi
}

INGEST_TOKEN="$(fleet_secret INGEST_TOKEN)"
COOLIFY_TOKEN="$(fleet_secret COOLIFY_AGENTS)"
if [[ -z "$COOLIFY_TOKEN" ]]; then
  COOLIFY_TOKEN="$(fleet_secret COOLIFY_TOKEN)"
fi

TARGET_URL="${TARGET_URL:-https://congress.trade}"

# 1. Send Mac Heartbeat to Server
if [[ -n "$INGEST_TOKEN" ]]; then
  UPTIME_SEC="$(sysctl -n kern.boottime 2>/dev/null | awk '{print $4}' | tr -d ',' | awk -v now="$(date +%s)" '{print now - $1}' || echo 0)"
  curl -s -X POST "${TARGET_URL}/api/ingest/mac-heartbeat" \
    -H "Authorization: Bearer ${INGEST_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"worker\":\"mac-scout\",\"status\":\"ok\",\"uptimeSeconds\":${UPTIME_SEC}}" >/dev/null 2>&1 || log "Failed to post Mac heartbeat"
fi

# 2. Check Server Health
HTTP_CODE="$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${TARGET_URL}/health" || echo 000)"

if [[ "$HTTP_CODE" != "200" ]]; then
  log "WARNING: Server ${TARGET_URL}/health returned HTTP ${HTTP_CODE}. Attempting automated self-healing restart..."
  
  if [[ -n "$COOLIFY_TOKEN" ]]; then
    RESTART_RESP="$(curl -s -X POST "${COOLIFY_BASE_URL:-https://host.jays.services}/api/v1/applications/congress-trade/restart" \
      -H "Authorization: Bearer ${COOLIFY_TOKEN}" \
      -H "Content-Type: application/json" --insecure || echo '{"error":"request failed"}')"
    log "Coolify API restart triggered: ${RESTART_RESP}"
  else
    log "ERROR: COOLIFY_TOKEN unavailable; cannot trigger Coolify auto-restart."
  fi
else
  log "Server check OK (HTTP 200)."
fi
