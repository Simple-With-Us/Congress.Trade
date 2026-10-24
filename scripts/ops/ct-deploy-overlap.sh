#!/bin/bash
# ct-deploy-overlap.sh — keep a live congress-app clone outside the Coolify
# project so Traefik still has a server while Coolify does stop-then-start.
#
# WHY
#   Coolify 4.x `deploy_docker_compose_buildpack()` still does:
#     stop_running_container(force: true)   # old containers gone
#     docker compose up --build -d          # new ones created after
#   `rolling_update()` (start new → health_check → stop old) is never called
#   for compose.  There is no UI toggle.  See
#   docs/rollouts/2026-08-17-coolify-deploy-overlap.md and GitHub #1537.
#
# WHAT
#   When a congress-trade deploy is in flight and the builder has finished
#   (or OVERLAP_EARLY=1), clone the running app as `congress-hold` on the
#   `coolify` network.  ct-reattach-proxy.sh then emits a Traefik failover
#   so requests keep hitting a real app while Coolify deletes the in-project
#   container.  After the replacement is healthy, this script removes hold
#   and reattaches the route.
#
#   Hold is deliberately NOT in the main Coolify project, so
#   `docker compose ... up` cannot stop it.  It runs the Deno app directly
#   (no Litestream) so a second replicator does not fight the live one, and
#   with the boot schema migrate off (CT_DISABLE_STARTUP_SCHEMA_MIGRATE=1):
#   main.ts awaits that ~400-statement replay before Deno.serve, so a hold
#   that replays it is still not serving /health when Coolify stops the old
#   app.  In the normal path (OVERLAP_EARLY=1) hold clones the old, healthy
#   app, which already migrated this schema; the replacement migrates again
#   when it boots.  If hold is ever started later in a deploy, after the
#   replacement container exists (for example hold died), it clones the
#   replacement's image and serves that code before the replacement's own
#   boot migrate has finished.
#
# INSTALL (root on the Coolify host — does not take the site down):
#   install -m 0755 scripts/ops/ct-deploy-overlap.sh /usr/local/bin/
#   install -m 0644 scripts/ops/ct-deploy-overlap.service /etc/systemd/system/
#   systemctl daemon-reload && systemctl enable --now ct-deploy-overlap.service
#   # also install the current ct-reattach-proxy.sh so failover to hold works
#
# UNINSTALL
#   systemctl disable --now ct-deploy-overlap.service
#   docker rm -f congress-hold
#   /usr/local/bin/ct-reattach-proxy.sh
#
# This script never talks to production from a developer laptop.  It is a
# host unit.  `--decide` / `--parse-active` / `--render-env` are offline and
# used by tests.  `--render-env` prints every value but the hold flags redacted.

set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/congress-health-recover.env}"
# shellcheck disable=SC1090
[[ -r "$ENV_FILE" ]] && { set -a; . "$ENV_FILE"; set +a; }

APP_UUID="${APP_UUID:-${COOLIFY_APP_UUID:-congress-app}}"
export APP_UUID
COOLIFY_BASE_URL="${COOLIFY_BASE_URL:-https://host.jays.services}"
HOLD_NAME="${HOLD_NAME:-congress-hold}"
NETWORK="${NETWORK:-coolify}"
DATA_DIR="${DATA_DIR:-/data/congress-trade}"
STATE_DIR="${STATE_DIR:-/var/lib/ct-deploy-overlap}"
REATTACH="${REATTACH:-/usr/local/bin/ct-reattach-proxy.sh}"
LOG_TAG="${LOG_TAG:-ct-deploy-overlap}"
LOOP_SLEEP_SEC="${LOOP_SLEEP_SEC:-3}"
# Default ON: a 3s poll after the builder exits often misses Coolify's
# immediate stop_running_container.  Start hold when the deploy begins so
# it is already serving before the in-project container is deleted.
# Set OVERLAP_EARLY=0 to wait until builders exit (saves RAM, races the swap).
OVERLAP_EARLY="${OVERLAP_EARLY:-1}"
HOLD_MEMORY="${HOLD_MEMORY:-1g}"
HOLD_CPUS="${HOLD_CPUS:-1.0}"
HEALTH_PATH="${HEALTH_PATH:-/health}"
HOLD_HEALTH_TIMEOUT_SEC="${HOLD_HEALTH_TIMEOUT_SEC:-45}"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
  command -v logger >/dev/null 2>&1 && logger -t "$LOG_TAG" -- "$*" || true
}

# Offline decision table.  Prints one of: start-hold | stop-hold | keep-hold | noop
#
#   deploy   builder  app_running  hold_running  app_healthy  early  have_image
decide_overlap_action() {
  local deploy="${1:-0}" builder="${2:-0}" app_running="${3:-0}"
  local hold_running="${4:-0}" app_healthy="${5:-0}" early="${6:-0}"
  local have_image="${7:-0}"

  if [[ "$deploy" == 1 ]]; then
    if [[ "$hold_running" == 1 ]]; then
      printf '%s\n' keep-hold
      return 0
    fi
    if [[ "$early" == 1 || "$builder" == 0 ]]; then
      if [[ "$app_running" == 1 || "$have_image" == 1 ]]; then
        printf '%s\n' start-hold
        return 0
      fi
    fi
    printf '%s\n' noop
    return 0
  fi

  if [[ "$hold_running" != 1 ]]; then
    printf '%s\n' noop
    return 0
  fi
  if [[ "$app_running" == 1 && "$app_healthy" == 1 ]]; then
    printf '%s\n' stop-hold
    return 0
  fi
  printf '%s\n' keep-hold
}

parse_deploy_active() {
  # stdin: Coolify /api/v1/deployments JSON.  Exit 0 if this app is in flight.
  APP_UUID="$APP_UUID" python3 -c '
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
# Queued is not in-flight.  Starting hold on a queued webhook would pin a
# second SQLite writer for the whole coalesce window.
active = [x for x in rows if mine(x) and x.get("status") in
          ("in_progress", "building", "running")]
raise SystemExit(0 if active else 1)
'
}

# stdin: KEY=VALUE env lines copied from the live app.  stdout: the hold's env,
# with each hold-only key set exactly once (any earlier value is dropped).
#   CT_SKIP_LITESTREAM=1                 never start a second Litestream
#                                        replicator against the live B2 target.
#   CT_DISABLE_STARTUP_SCHEMA_MIGRATE=1  serve /health without replaying the
#                                        boot schema migrate (see WHAT above).
render_hold_env() {
  grep -v -e '^CT_SKIP_LITESTREAM=' -e '^CT_DISABLE_STARTUP_SCHEMA_MIGRATE=' || true
  printf 'CT_SKIP_LITESTREAM=1\n'
  printf 'CT_DISABLE_STARTUP_SCHEMA_MIGRATE=1\n'
}

# stdin: a rendered hold env.  stdout: the two hold flags in full and every
# other line as KEY=<redacted>.  The env is the live app's, credentials
# included, so --render-env never prints a value; write_hold_env does not
# use this and hands docker the full values.
redact_hold_env() {
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      CT_SKIP_LITESTREAM=* | CT_DISABLE_STARTUP_SCHEMA_MIGRATE=* | '') printf '%s\n' "$line" ;;
      *=*) printf '%s=<redacted>\n' "${line%%=*}" ;;
      *) printf '<redacted>\n' ;;
    esac
  done
}

if [[ "${1:-}" == "--decide" ]]; then
  decide_overlap_action \
    "${DEPLOY_ACTIVE:-0}" \
    "${BUILDER_ACTIVE:-0}" \
    "${APP_RUNNING:-0}" \
    "${HOLD_RUNNING:-0}" \
    "${APP_HEALTHY:-0}" \
    "${OVERLAP_EARLY:-1}" \
    "${HAVE_IMAGE:-0}"
  exit 0
fi

if [[ "${1:-}" == "--parse-active" ]]; then
  parse_deploy_active
  exit $?
fi

if [[ "${1:-}" == "--render-env" ]]; then
  render_hold_env | redact_hold_env
  exit 0
fi

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '2,47p' "$0"
  exit 0
fi

container_running() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$1"
}

find_app_container() {
  docker ps --format '{{.Names}}' 2>/dev/null \
    | grep -E '^congress-app(-|$)' \
    | grep -v "^${HOLD_NAME}\$" \
    | head -1 || true
}

builder_active() {
  docker ps --format '{{.Names}}' 2>/dev/null \
    | grep -Eqi 'nixpacks|coolify-builder|buildkit'
}

coolify_deploy_active() {
  [[ -z "${COOLIFY_TOKEN:-}" ]] && return 1
  command -v python3 >/dev/null 2>&1 || return 1
  local json
  json=$(curl -fsS -m 8 \
    -H "Authorization: Bearer ${COOLIFY_TOKEN}" \
    -H "Accept: application/json" \
    "${COOLIFY_BASE_URL%/}/api/v1/deployments" 2>/dev/null) || return 1
  printf '%s' "$json" | parse_deploy_active
}

probe_health() {
  local target="$1"
  docker exec "$target" wget -q -O /dev/null "http://127.0.0.1:5000${HEALTH_PATH}" 2>/dev/null \
    || docker exec "$target" curl -fsS "http://127.0.0.1:5000${HEALTH_PATH}" >/dev/null 2>&1
}

remember_image() {
  local app="$1"
  mkdir -p "$STATE_DIR"
  docker inspect -f '{{.Config.Image}}' "$app" > "$STATE_DIR/last-image" 2>/dev/null || true
}

resolve_image() {
  local app="$1"
  if [[ -n "$app" ]]; then
    docker inspect -f '{{.Config.Image}}' "$app" 2>/dev/null && return 0
  fi
  if [[ -s "$STATE_DIR/last-image" ]]; then
    cat "$STATE_DIR/last-image"
    return 0
  fi
  return 1
}

write_hold_env() {
  local app="$1" dest="$2"
  if [[ -n "$app" ]]; then
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$app" > "$dest"
  elif [[ -s "$STATE_DIR/last-env" ]]; then
    cp "$STATE_DIR/last-env" "$dest"
  else
    return 1
  fi
  render_hold_env < "$dest" > "${dest}.tmp"
  mv "${dest}.tmp" "$dest"
  if [[ -n "$app" ]]; then
    mkdir -p "$STATE_DIR"
    cp "$dest" "$STATE_DIR/last-env"
  fi
}

reattach_now() {
  if [[ -x "$REATTACH" ]]; then
    "$REATTACH" || log "warn: reattach exited $?"
  fi
}

start_hold() {
  local app image envfile
  app="$(find_app_container)"
  image="$(resolve_image "$app")" || { log "cannot start hold: no image"; return 1; }
  if container_running "$HOLD_NAME"; then
    log "hold already running"
    return 0
  fi
  envfile=$(mktemp)
  if ! write_hold_env "$app" "$envfile"; then
    rm -f "$envfile"
    log "cannot start hold: no env"
    return 1
  fi
  docker rm -f "$HOLD_NAME" >/dev/null 2>&1 || true
  # Deno entrypoint only — the image CMD wraps Litestream.  Same bind mount
  # as prod; WAL serializes the short two-writer window (same risk as a
  # Dockerfile rolling update).
  if ! docker run -d --name "$HOLD_NAME" \
    --label 'ct.overlap=1' \
    --label 'coolify.managed=false' \
    --network "$NETWORK" \
    --network-alias "$HOLD_NAME" \
    --restart no \
    --memory "$HOLD_MEMORY" \
    --cpus "$HOLD_CPUS" \
    --pids-limit 256 \
    -v "${DATA_DIR}:${DATA_DIR}" \
    --env-file "$envfile" \
    "$image" \
    deno run --allow-net --allow-env --allow-read --allow-write --allow-sys --allow-ffi --unstable-kv --unstable-cron src/deno/main.ts \
    >/dev/null; then
    rm -f "$envfile"
    log "docker run hold failed"
    return 1
  fi
  rm -f "$envfile"
  local i=0
  while (( i < HOLD_HEALTH_TIMEOUT_SEC )); do
    if probe_health "$HOLD_NAME"; then
      log "hold ready (${i}s) image=${image}"
      reattach_now
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  log "hold started but /health not ready after ${HOLD_HEALTH_TIMEOUT_SEC}s; leaving it up"
  reattach_now
  return 0
}

stop_hold() {
  if ! docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$HOLD_NAME"; then
    return 0
  fi
  docker rm -f "$HOLD_NAME" >/dev/null 2>&1 || true
  log "hold removed"
  reattach_now
}

tick() {
  local app hold_on deploy builder app_on app_ok have_image action
  app="$(find_app_container)"
  [[ -n "$app" ]] && remember_image "$app"
  hold_on=0
  container_running "$HOLD_NAME" && hold_on=1
  deploy=0
  coolify_deploy_active && deploy=1
  builder=0
  builder_active && builder=1
  app_on=0
  [[ -n "$app" ]] && app_on=1
  app_ok=0
  if [[ "$app_on" == 1 ]] && probe_health "$app"; then
    app_ok=1
  fi
  have_image=0
  [[ -s "$STATE_DIR/last-image" || -n "$app" ]] && have_image=1

  action="$(decide_overlap_action "$deploy" "$builder" "$app_on" "$hold_on" "$app_ok" "$OVERLAP_EARLY" "$have_image")"
  case "$action" in
    start-hold)
      log "action=start-hold deploy=${deploy} builder=${builder} app=${app:-none}"
      start_hold || log "start-hold failed"
      ;;
    stop-hold)
      log "action=stop-hold app=${app:-none} healthy"
      stop_hold
      ;;
    keep-hold)
      log "action=keep-hold deploy=${deploy} app=${app:-none} healthy=${app_ok}"
      ;;
    noop)
      ;;
    *)
      log "unknown action ${action}"
      ;;
  esac
}

if [[ "${1:-}" == "--once" || -z "${1:-}" ]]; then
  mkdir -p "$STATE_DIR"
  tick
  exit 0
fi

if [[ "${1:-}" == "--loop" ]]; then
  mkdir -p "$STATE_DIR"
  log "loop start sleep=${LOOP_SLEEP_SEC}s early=${OVERLAP_EARLY}"
  while true; do
    tick || log "tick failed"
    sleep "$LOOP_SLEEP_SEC"
  done
fi

echo "usage: $0 [--once|--loop|--decide|--parse-active|--render-env|--help]" >&2
exit 2
