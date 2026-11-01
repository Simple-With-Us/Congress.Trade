#!/usr/bin/env bash
# congress-health-recover.sh — autonomous recovery for congress.trade
#
# Polls LOCAL /api/health on 127.0.0.1:5000. After consecutive failures:
#   1) restart the Coolify-managed congress-app container (docker)
#   2) re-attach stable Traefik alias via ct-reattach-proxy.sh (if present)
#   3) optionally POST Coolify application restart when COOLIFY_TOKEN is set
#
# Safe defaults:
#   - no host reboot
#   - no docker daemon restart
#   - skip remediation while Coolify is actively building/deploying
#   - cooldown between restarts; max restarts per hour
#
# Install (Coolify / Hetzner host):
#   install -m 0755 scripts/ops/congress-health-recover.sh /usr/local/bin/
#   install -m 0644 scripts/ops/congress-health-recover.service /etc/systemd/system/
#   systemctl daemon-reload && systemctl enable --now congress-health-recover
#
# Env overrides (optional):
#   HEALTH_URL          default https://congress.trade/api/health
#   LOCAL_HEALTH_URL    default http://127.0.0.1:5000/api/health
#                       Watchdog decisions use LOCAL first. Public flaps
#                       (Traefik rewrite, CF challenge, hairpin) must not
#                       restart a healthy container — that is how the hourly
#                       budget gets spent and the "needs a human" alert fires
#                       while the app is still serving on :5000.
#   CHECK_INTERVAL_SEC  default 30
#   FAIL_THRESHOLD      default 2
#   RESTART_COOLDOWN_SEC default 300
#   MAX_RESTARTS_PER_HOUR default 4
#   APP_UUID            default from COOLIFY_APP_UUID or congress-app
#   COOLIFY_BASE_URL    default https://host.jays.services
#   COOLIFY_TOKEN       optional Bearer for Coolify API restart
#   STATE_DIR           default /var/lib/congress-health-recover
#   LOG_TAG             default congress-health-recover

set -euo pipefail

HEALTH_URL="${HEALTH_URL:-https://congress.trade/api/health}"
LOCAL_HEALTH_URL="${LOCAL_HEALTH_URL:-http://127.0.0.1:5000/api/health}"
CHECK_INTERVAL_SEC="${CHECK_INTERVAL_SEC:-30}"
FAIL_THRESHOLD="${FAIL_THRESHOLD:-2}"
RESTART_COOLDOWN_SEC="${RESTART_COOLDOWN_SEC:-300}"
MAX_RESTARTS_PER_HOUR="${MAX_RESTARTS_PER_HOUR:-4}"
APP_UUID="${APP_UUID:-${COOLIFY_APP_UUID:-congress-app}}"
COOLIFY_BASE_URL="${COOLIFY_BASE_URL:-https://host.jays.services}"
STATE_DIR="${STATE_DIR:-/var/lib/congress-health-recover}"
LOG_TAG="${LOG_TAG:-congress-health-recover}"
STARTUP_GRACE_SEC="${STARTUP_GRACE_SEC:-90}"

mkdir -p "$STATE_DIR"
FAILS=0
STARTED_AT=$(date +%s)

log() {
  local msg="$*"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$msg"
  if command -v logger >/dev/null 2>&1; then
    logger -t "$LOG_TAG" -- "$msg" || true
  fi
}

now() { date +%s; }

# Pushover alert for give-up paths. Silence is the failure mode this guards:
# 2026-08-10 the watchdog logged an unrecoverable outage every 5 minutes for
# ~7 hours to a journal nobody reads, and nothing paged.
# Rate-limited so a stuck outage does not spam.
notify() {
  local msg="$1" title="${2:-congress.trade}"
  if [[ -z "${PUSHOVER_APP_TOKEN:-}" || -z "${PUSHOVER_USER_KEY:-}" ]]; then
    return 0
  fi
  local stamp_file="$STATE_DIR/last_notify"
  local last=0
  [[ -f "$stamp_file" ]] && last=$(cat "$stamp_file" 2>/dev/null || echo 0)
  if [[ $(( $(now) - last )) -lt "${NOTIFY_MIN_INTERVAL_SEC:-1800}" ]]; then
    return 0
  fi
  now > "$stamp_file"
  curl -sS -m 15 -o /dev/null \
    -K <(printf 'form-string = "token=%s"\nform-string = "user=%s"\n' "$PUSHOVER_APP_TOKEN" "$PUSHOVER_USER_KEY") \
    --form-string "title=${title}" \
    --form-string "message=${msg}" \
    --form-string "priority=1" \
    https://api.pushover.net/1/messages.json >/dev/null 2>&1 \
    || log "warn: pushover notify failed"
}

# Coolify /api/v1/deployments is the running+queued set (not history).
# Same parse as ct-deploy-guard.sh: object with numeric keys, this app only.
is_coolify_deploy_active() {
  [[ -z "${COOLIFY_TOKEN:-}" ]] && return 1
  command -v python3 >/dev/null 2>&1 || return 1
  local json
  json=$(curl -fsS -m 8 \
    -H @<(printf 'Authorization: Bearer %s\n' "$COOLIFY_TOKEN") \
    -H "Accept: application/json" \
    "${COOLIFY_BASE_URL%/}/api/v1/deployments" 2>/dev/null) || return 1
  printf '%s' "$json" | APP_UUID="$APP_UUID" python3 -c '
import json, os, sys
try:
    d = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
if isinstance(d, list):
    rows = d
elif isinstance(d, dict):
    inner = d.get("data", d.get("deployments"))
    if isinstance(inner, list):
        rows = inner
    elif isinstance(inner, dict):
        rows = list(inner.values())
    elif d and all(str(k).isdigit() for k in d.keys()):
        rows = list(d.values())
    else:
        rows = []
else:
    rows = []
app_uuid = os.environ.get("APP_UUID", "")
def mine(x):
    return (x.get("application_id") == app_uuid
            or x.get("application_uuid") == app_uuid
            or x.get("application_name") == "congress-trade")
active = [x for x in rows if mine(x) and x.get("status") in
          ("in_progress", "building", "running", "queued")]
raise SystemExit(0 if active else 1)
'
}

is_deploy_active() {
  # Coolify builder / nixpacks containers indicate a live deploy.
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -Eqi 'nixpacks|coolify-builder|buildkit'; then
    return 0
  fi
  # Compose replace: old container is gone, new one is Created / starting.
  # A Coolify API restart here stacks a second deploy on the first and
  # burns the hourly budget.
  if docker ps -a --filter 'name=congress-app-' --format '{{.Status}}' 2>/dev/null \
    | grep -Eqi 'Created|Restarting|health: starting'; then
    return 0
  fi
  # Stop-before-start gap: the old container is already removed and the new
  # one is not Created yet.  2026-08-14 02:51Z #1852 hit this — local health
  # failed, find_app_container missed, and we stacked a Coolify restart on
  # the in-flight deploy.  Ask Coolify before treating that as a crash.
  if is_coolify_deploy_active; then
    return 0
  fi
  return 1
}

# Probe one health URL. Alive if HTTP 2xx/3xx and (when JSON) ok+db are not
# explicitly false. Network errors / 5xx / HTML challenge pages are down.
check_one() {
  local url="$1"
  local body code
  body=$(curl -fsS -m 12 -w '\n%{http_code}' "$url" 2>/dev/null) || return 1
  code=$(printf '%s\n' "$body" | tail -n1)
  body=$(printf '%s\n' "$body" | sed '$d')
  case "$code" in
    2??|3??) ;;
    *) return 1 ;;
  esac
  if printf '%s' "$body" | grep -q '"ok"[[:space:]]*:[[:space:]]*false'; then
    return 1
  fi
  if printf '%s' "$body" | grep -q '"db"[[:space:]]*:[[:space:]]*false'; then
    return 1
  fi
  # Prefer structured health; plain non-JSON 200 without ok is treated as down.
  if ! printf '%s' "$body" | grep -q '"ok"'; then
    return 1
  fi
  return 0
}

check_health() {
  # Local published port is the app process. Public congress.trade is Traefik
  # + Cloudflare. A 60s edge blip used to count as an outage, docker-restart
  # the healthy app, and spend the hourly budget. Override LOCAL_HEALTH_URL
  # if the host bind ever moves.
  check_one "$LOCAL_HEALTH_URL"
}

restart_timestamps_file() { printf '%s/restarts.log' "$STATE_DIR"; }
last_restart_file() { printf '%s/last_restart' "$STATE_DIR"; }

restarts_last_hour() {
  local cutoff now_ts
  now_ts=$(now)
  cutoff=$((now_ts - 3600))
  if [[ ! -f "$(restart_timestamps_file)" ]]; then
    echo 0
    return
  fi
  awk -v c="$cutoff" '$1 >= c { n++ } END { print n+0 }' "$(restart_timestamps_file)"
}

cooldown_ok() {
  local last now_ts
  now_ts=$(now)
  if [[ ! -f "$(last_restart_file)" ]]; then
    return 0
  fi
  last=$(cat "$(last_restart_file)" 2>/dev/null || echo 0)
  [[ $((now_ts - last)) -ge $RESTART_COOLDOWN_SEC ]]
}

find_app_container() {
  # Prefer live Coolify-labeled congress-app only.
  # Monet incident 2026-08-10: `docker ps -aq --filter name=congress-app-` matched
  # abandoned manual relics (congress-app-live-*) and `docker start` resurrected a
  # 3-day-old build on a health blip. Never start name-matched stopped containers.
  local id
  id=$(docker ps -q \
    --filter "label=coolify.resourceName=congress-trade" \
    --filter "label=com.docker.compose.service=congress-app" 2>/dev/null | head -1 || true)
  if [[ -n "$id" ]]; then
    printf '%s\n' "$id"
    return 0
  fi
  # Stopped-but-labeled Coolify container: restart is OK (same resource).
  id=$(docker ps -aq \
    --filter "label=coolify.resourceName=congress-trade" \
    --filter "label=com.docker.compose.service=congress-app" \
    --filter "status=exited" 2>/dev/null | head -1 || true)
  if [[ -n "$id" ]]; then
    printf '%s\n' "$id"
    return 0
  fi
  # Name fallback: RUNNING only. Manual/relic stopped containers must not start.
  id=$(docker ps -q --filter "name=congress-app-" 2>/dev/null | head -1 || true)
  if [[ -n "$id" ]]; then
    log "warn: using running name=congress-app- fallback id=${id:0:12} (prefer Coolify labels)"
    printf '%s\n' "$id"
    return 0
  fi
  return 1
}

restart_via_docker() {
  local id name
  id=$(find_app_container) || {
    log "remediate: no congress-app container found"
    return 1
  }
  name=$(docker inspect --format '{{.Name}}' "$id" 2>/dev/null | sed 's#^/##')
  local status
  status=$(docker inspect --format '{{.State.Status}}' "$id" 2>/dev/null || echo unknown)
  log "remediate: docker $status -> restart id=${id:0:12} name=$name"
  if [[ "$status" == "running" ]]; then
    docker restart "$id" >/dev/null
  else
    docker start "$id" >/dev/null || docker restart "$id" >/dev/null
  fi
  if [[ -x /usr/local/bin/ct-reattach-proxy.sh ]]; then
    /usr/local/bin/ct-reattach-proxy.sh || log "warn: ct-reattach-proxy.sh failed"
  fi
  return 0
}

restart_via_coolify_api() {
  if [[ -z "${COOLIFY_TOKEN:-}" ]]; then
    return 1
  fi
  local url="${COOLIFY_BASE_URL%/}/api/v1/applications/${APP_UUID}/restart"
  log "remediate: Coolify API restart $url"
  local code
  code=$(curl -sS -m 30 -o /tmp/ct-coolify-restart.out -w '%{http_code}' \
    -X GET \
    -H @<(printf 'Authorization: Bearer %s\n' "$COOLIFY_TOKEN") \
    -H "Accept: application/json" \
    "$url" 2>/dev/null || echo 000)
  # Some Coolify builds use POST; retry once on 405/404.
  if [[ "$code" == "405" || "$code" == "404" ]]; then
    code=$(curl -sS -m 30 -o /tmp/ct-coolify-restart.out -w '%{http_code}' \
      -X POST \
      -H @<(printf 'Authorization: Bearer %s\n' "$COOLIFY_TOKEN") \
      -H "Accept: application/json" \
      "$url" 2>/dev/null || echo 000)
  fi
  log "remediate: Coolify API HTTP $code"
  [[ "$code" == "2"* ]]
}

remediate() {
  if is_deploy_active; then
    log "remediate: skipped (Coolify build/deploy active)"
    return 0
  fi
  if ! cooldown_ok; then
    log "remediate: skipped (cooldown ${RESTART_COOLDOWN_SEC}s)"
    return 0
  fi
  local n
  n=$(restarts_last_hour)
  if [[ "$n" -ge "$MAX_RESTARTS_PER_HOUR" ]]; then
    log "remediate: skipped (already $n restarts in last hour; max $MAX_RESTARTS_PER_HOUR)"
    notify "Health failing but restart budget is spent ($n/$MAX_RESTARTS_PER_HOUR this hour). Not self-healing — needs a human." "congress.trade DOWN"
    return 0
  fi

  local docker_ok=1 api_ok=1
  restart_via_docker || docker_ok=0
  # Coolify API is the ONLY path that recovers a container that was REMOVED
  # rather than stopped — find_app_container cannot match what does not exist.
  restart_via_coolify_api || api_ok=0

  # Do not spend hourly budget on a remediation that did nothing. Before this,
  # a no-op (no container + no token) still burned a slot, so four no-ops
  # locked out recovery for the rest of the hour.
  if [[ "$docker_ok" -eq 0 && "$api_ok" -eq 0 ]]; then
    log "remediate: FAILED — no container to restart and no Coolify API fallback (COOLIFY_TOKEN set? ${COOLIFY_TOKEN:+yes}${COOLIFY_TOKEN:-no})"
    notify "Cannot self-heal: no congress-app container and Coolify API restart unavailable. Manual redeploy needed." "congress.trade DOWN"
    return 1
  fi

  local ts
  ts=$(now)
  echo "$ts" >> "$(restart_timestamps_file)"
  echo "$ts" > "$(last_restart_file)"
  log "remediate: recorded restart ts=$ts docker_ok=$docker_ok api_ok=$api_ok"

  # Wait for recovery window before counting more failures.
  sleep 45
  if check_health; then
    log "remediate: health restored after restart"
    FAILS=0
  else
    log "remediate: health still down after restart"
    notify "Restarted congress-app but /api/health is still failing." "congress.trade DOWN"
  fi
}

log "start health_url=$LOCAL_HEALTH_URL (public=$HEALTH_URL) interval=${CHECK_INTERVAL_SEC}s fail_threshold=$FAIL_THRESHOLD"

while true; do
  if [[ $(( $(now) - STARTED_AT )) -lt $STARTUP_GRACE_SEC ]]; then
    sleep "$CHECK_INTERVAL_SEC"
    continue
  fi

  if check_health; then
    if [[ "$FAILS" -gt 0 ]]; then
      log "health ok (recovered after $FAILS fail(s))"
    fi
    FAILS=0
  else
    FAILS=$((FAILS + 1))
    log "health FAIL count=$FAILS/$FAIL_THRESHOLD"
    if [[ "$FAILS" -ge "$FAIL_THRESHOLD" ]]; then
      remediate || log "remediate: failed"
    fi
  fi
  sleep "$CHECK_INTERVAL_SEC"
done
