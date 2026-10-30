#!/usr/bin/env bash
# public-liveness-watch.sh -- external watchdog for socratictrade.com.
#
# Why this exists (2026-09-30): the Sep-30 10:33 incident was an 11-minute
# public 503 ("no available server") while the app process was alive, the
# Docker healthcheck was green, and Coolify reported "running:healthy".
# Analysis pointed at Traefik<->container backend detachment -- a class of
# failure NOTHING inside the container can observe (loopback probes succeed).
# The in-repo liveness watchdog (scripts/coolify-prod-start.sh) covers the
# wedged-server class; THIS script covers the detached-backend class from
# the outside.
# How it probes (2026-09-30, owner-directed): Cloudflare 403s every request
# from this VM's default egress IP, so the public URL is unusable through the
# normal proxy.  Instead we go through the tailnet-capable egress proxy (port
# 3130 on the same egress host -- the same proxy mac-ssh and the Coolify API
# tooling use): its egress IP is NOT Cloudflare-blocked, so
# https://socratictrade.com/api/live returns a genuine 200 through the full
# public path (Cloudflare -> Traefik -> container).  A 503 here is what users
# would see -- precisely the incident class we are watching for.
# (A direct Traefik-over-tailnet probe was attempted: Traefik answers on the
# tailnet, but its 443 drops connections whose SNI doesn't match a router and
# its port 80 has no router for the app host, so the public-path probe via
# the 3130 proxy is the working approach.)
#
# Failure classification (2026-10-04): a failed target probe is NOT automatically
# a site failure.  The Oct-02 14:31-14:35 CDT event was the 3130 proxy itself
# timing out while the site returned 200; the Oct-01 08:39-08:43 CDT event was
# the same proxy returning 407.  On every target-probe failure this script now:
#   1. records the HTTP status code and a body snippet (a 503 from Traefik's
#      "no available server" page, the app's own {"ok":false} JSON, and a
#      Cloudflare error page are three different bodies -- the code alone
#      could not tell them apart, which is why Oct-02 needed manual probing
#      to classify), and
#   2. independently checks the 3130 proxy path (example.com through it).
# If the proxy path is down, the failure is logged as a PROXY-PATH failure:
# the site's status is unknown, the site-failure counter is reset (it would
# be dishonest to keep accusing the site), and no restart is attempted --
# the restart itself needs the same proxy to reach the Coolify API, so it
# could not succeed anyway.  Proxy-path failures have their own counter and
# are a distinct alert condition ("tailnet proxy path itself failed").
# Only genuine site failures (proxy healthy, target non-200) count toward
# the restart threshold.
#
# Destination-transport classification (2026-10-13, owner-directed): the
# 21:07-21:13 CDT incident returned HTTP 000 (no HTTP response at all) on
# five consecutive target probes WHILE the proxy path was verified healthy
# (example.com 200 through the same proxy).  The script counted those as
# site failures and restarted a healthy app -- wrong on two counts: (a) a
# 000 with a healthy proxy is a VM->proxy->destination transport problem,
# not a site problem, and (b) a container restart cannot fix a path the
# probe cannot reach.  Target 000s with a healthy proxy are now tracked as
# DEST-TRANSPORT failures: separate counter, logged distinctly, alerted at
# threshold, but NEVER restart-triggering.  Only failures that return an
# actual HTTP status from the target (the detached-backend 503 class this
# watchdog exists for) count toward the restart threshold.
#
# Behavior:
#   - Probes https://socratictrade.com/api/live (lightweight, 200 when up).
#   - After PUBLIC_FAIL_THRESHOLD (default 5) consecutive SITE failures
#     (target returned an actual non-200 HTTP status), restarts the Coolify
#     application via the Coolify API (also over Tailscale).
#   - Target HTTP 000 with a healthy proxy path = DEST-TRANSPORT failure:
#     tracked and alerted separately, never restart-triggering (a restart
#     cannot fix an unreachable path).
#   - Cooldown: at most one restart per RESTART_COOLDOWN_S (default 1800).
#   - Network sanity check: if a control probe (example.com, normal egress)
#     also fails, the outage is on OUR side -- do not restart production.
#   - Kill switch: PUBLIC_LIVENESS_WATCH=0 or a DISABLED file in the
#     watchdog root (the directory above the folder holding this script).
#
# State: <script-dir>/../state/public-liveness.state  (consecutive_failures,
#   consecutive_proxy_failures, last_restart_epoch)
# Logs:  <script-dir>/../logs/public-liveness.log
#
# Intended to run every 2 minutes from cron.  ASCII only (Apple bash 3.2).

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="$ROOT_DIR/state"
LOG_DIR="$ROOT_DIR/logs"
STATE_FILE="$STATE_DIR/public-liveness.state"
LOG_FILE="$LOG_DIR/public-liveness.log"

mkdir -p "$STATE_DIR" "$LOG_DIR"

# Local configuration (host addresses, credential file paths) lives in
# watchdog.env in the watchdog root (the parent directory of the folder
# holding the scripts) -- never committed.  See watchdog.env.example for
# the full list.  Values there win over the
# defaults below because every assignment uses the ${VAR:-default} form.
if [ -f "$ROOT_DIR/watchdog.env" ]; then
  # shellcheck disable=SC1091
  . "$ROOT_DIR/watchdog.env"
fi

PUBLIC_HOST="${PUBLIC_LIVENESS_HOST:-socratictrade.com}"
TARGET_URL="https://${PUBLIC_HOST}/api/live"
FAIL_THRESHOLD="${PUBLIC_FAIL_THRESHOLD:-5}"
PROXY_FAIL_THRESHOLD="${PUBLIC_PROXY_FAIL_THRESHOLD:-3}"
COOLDOWN_S="${RESTART_COOLDOWN_S:-1800}"
CONTROL_URL="https://example.com/"
PROXY_CHECK_URL="https://example.com/"
COOLIFY_API="${COOLIFY_API:-}"
APP_UUID="${COOLIFY_APP_UUID:-}"
TOKEN_FILE="${COOLIFY_TOKEN_FILE:-$HOME/workspace/.secrets/coolify-api-token}"

log() {
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') [public-liveness] $*" >> "$LOG_FILE"
}

if [ "${PUBLIC_LIVENESS_WATCH:-1}" = "0" ] || [ -f "$ROOT_DIR/DISABLED" ]; then
  exit 0
fi

if [ -z "$COOLIFY_API" ] || [ -z "$APP_UUID" ]; then
  log "ERROR: COOLIFY_API and COOLIFY_APP_UUID must be set (see watchdog.env.example); exiting"
  exit 1
fi

tailnet_proxy() {
  # The tailnet-capable egress proxy listens on 3130 on the same egress host
  # as the default proxy.  Plain-http destinations use it directly; TLS goes
  # through it as an HTTP CONNECT tunnel.
  local hp="${HTTPS_PROXY:-${https_proxy:-}}"
  [ -n "$hp" ] || return 1
  hp="${hp#*://}"
  hp="${hp%%/*}"
  case "$hp" in
    *:*)
      hp="${hp%:*}"
      ;;
  esac
  echo "http://${hp}:3130"
}

# --- hop decomposition (2026-10-09) ------------------------------------------
# The proxy-path check is split into two hops so a failure names the faulty
# segment.  The 2026-10-09 Plumber diagnosis found the Mango proxy itself
# healthy and the flaky segment the VM->proxy/Tailscale-tunnel path; a bare
# "proxy path failed" alert could not distinguish the two.
#   hop1: the VM gets an HTTP response from the proxy endpoint at all
#         (DNS, TCP connect, CONNECT handshake to the egress proxy).
#   hop2: the fetch THROUGH the proxy returns 200 (proxy's upstream leg).
# probe_proxy_hops sets HOP_FAILED to "hop1", "hop2", or "" (healthy),
# HOP_WHY to a short detail string, and returns 0 only when both hops pass.
# The failed hop is persisted in the state file (last_proxy_hop) so the
# alert names the faulty segment.  Classification rule: no HTTP response
# from the proxy (code 000) => hop1; proxy answered but non-200 (or a
# transfer error after 200) => hop2.
HOP_FAILED=""
HOP_WHY=""
probe_proxy_hops() {
  local proxy code rc
  HOP_FAILED=""
  HOP_WHY=""
  proxy="$(tailnet_proxy)" || { HOP_FAILED="hop1"; HOP_WHY="no proxy configured"; return 1; }
  code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 6 -m 12 \
    --proxy "$proxy" "$PROXY_CHECK_URL" 2>/dev/null)"
  rc=$?
  [ -n "$code" ] || code="000"
  if [ "$code" = "200" ] && [ "$rc" -eq 0 ]; then
    return 0
  fi
  if [ "$code" = "000" ]; then
    HOP_FAILED="hop1"
    HOP_WHY="no HTTP response from proxy (curl rc=$rc)"
    return 1
  fi
  HOP_FAILED="hop2"
  HOP_WHY="proxy answered HTTP $code (curl rc=$rc)"
  return 1
}

tailscale_note() {
  # Compact VM-side Tailscale diagnostic for proxy-path failure logs: is the
  # Coolify host (jay-server) in this VM's netmap right now?
  local st
  st="$(timeout 15 /opt/hatch/bin/tailscale status 2>/dev/null)"
  if [ -z "$st" ]; then
    echo "tailscale: CLI gave no output"
    return
  fi
  if echo "$st" | grep -q 'jay-server'; then
    echo "tailscale: ok, jay-server peer in netmap"
  else
    echo "tailscale: running but jay-server peer NOT in netmap"
  fi
}

# --- trading proxy path: VM -> Coolify -> Mango (2026-10-13) ------------------
# Socratic.Trade egresses provider traffic through the Mango residential proxy
# (on the WireGuard mesh, reachable only from the Coolify host).  This check verifies the two legs separately, from the vantage
# point that can actually test each one:
#   tpx-leg1: VM -> Coolify host. Tested FROM the VM: the Coolify API answers
#             (any HTTP status) through the 3130 tailnet proxy.
#   tpx-leg2: Coolify -> Mango. Tested FROM the Coolify host via the app's
#             /api/proxy-use endpoint, which runs in the container on the
#             Coolify host and probes the Mango directly.  The VM never assumes
#             it can reach the Mango itself.
# Retry: a leg miss sleeps 10s and retries that leg once.  A miss that clears
# on retry is transient (logged, silent).  A miss that fails twice is a
# confirmed failure: exactly one Zulip alert per incident, naming the hop and
# carrying the latest proxy-use reading.  State: trading_proxy_incident
# ("leg:epoch" while an incident is open), trading_proxy_last_resolve,
# trading_proxy_flaps.  The alert payload is written to
# $TPX_ALERT_FILE for the runner to post via zulip-trading-alert.sh.
TPX_ALERT_FILE="$STATE_DIR/trading-proxy-alert.txt"
TPX_RETRY_SLEEP=10
TPX_FLAP_WINDOW_S=1800

# probe_tpx_leg1: 0 = Coolify API answered (any HTTP status), 1 = unreachable.
probe_tpx_leg1() {
  local proxy code
  proxy="$(tailnet_proxy)" || return 1
  code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 6 -m 12 \
    --proxy "$proxy" "$COOLIFY_API/" 2>/dev/null)"
  [ -n "$code" ] || code="000"
  [ "$code" != "000" ]
}

# probe_tpx_leg2: 0 = Mango reachable from the Coolify host,
#                 1 = Mango NOT reachable (confirmed),
#                 2 = not assessable (endpoint not deployed, transport failure,
#                     or non-200) -- skip, do not alert; other watchers own those.
# Sets TPX_SNAPSHOT (raw JSON) when the endpoint answered 200.
TPX_SNAPSHOT=""
probe_tpx_leg2() {
  local proxy http_code body_file
  TPX_SNAPSHOT=""
  proxy="$(tailnet_proxy)" || return 2
  body_file="/tmp/st-tpx-$$.json"
  http_code="$(curl -s -o "$body_file" -w '%{http_code}' -m 15 \
    --proxy "$proxy" "https://${PUBLIC_HOST}/api/proxy-use" 2>/dev/null)"
  [ -n "$http_code" ] || http_code="000"
  if [ "$http_code" != "200" ]; then
    rm -f "$body_file"
    return 2
  fi
  TPX_SNAPSHOT="$(cat "$body_file" 2>/dev/null)"
  rm -f "$body_file"
  [ -n "$TPX_SNAPSHOT" ] || return 2
  if echo "$TPX_SNAPSHOT" | python3 -c \
    "import json,sys; sys.exit(0 if json.load(sys.stdin).get('mango',{}).get('reachable') else 1)" \
    2>/dev/null; then
    return 0
  fi
  return 1
}

# format_tpx_proxy_use: one-line human summary of the latest proxy-use reading
# from TPX_SNAPSHOT, or a note that no reading was available.
format_tpx_proxy_use() {
  if [ -z "${TPX_SNAPSHOT:-}" ]; then
    echo "unavailable (could not read the app's proxy-use endpoint)"
    return
  fi
  echo "$TPX_SNAPSHOT" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print('unparseable proxy-use response'); sys.exit()
snap = d.get('snapshot', {}) or {}
latest = snap.get('latest') or {}
lh = snap.get('lastHour', {}) or {}
if not latest:
    print('no requests recorded yet')
    sys.exit()
used = latest.get('usedProxy')
src = latest.get('source', '?')
host = latest.get('host') or 'direct'
ts = latest.get('ts', 0)
import time
ago = int(time.time()*1000 - ts)//1000 if ts else -1
ago_s = ('%ds ago' % ago) if ago >= 0 else 'unknown time'
mode = ('proxied via ' + host) if used else 'direct egress'
print('last hour: %d proxied, %d direct, %d fallbacks; latest %s (%s, source=%s) %s' % (
    lh.get('proxied', 0), lh.get('direct', 0), lh.get('fallbacks', 0),
    mode, ago_s, src))
" 2>/dev/null || echo "unavailable (proxy-use parse failed)"
}

# format_tpx_mango: one-line Mango reachability from TPX_SNAPSHOT.
format_tpx_mango() {
  if [ -z "${TPX_SNAPSHOT:-}" ]; then
    echo "unknown (no reading)"
    return
  fi
  echo "$TPX_SNAPSHOT" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print('unknown (unparseable)'); sys.exit()
m = d.get('mango', {}) or {}
r = m.get('reachable')
lat = m.get('latencyMs')
if r is True:
    print('yes (probe %sms)' % (lat if lat is not None else '?'))
elif r is False:
    print('NO (probe failed)')
else:
    print('unknown')
" 2>/dev/null || echo "unknown"
}

# build_tpx_alert hop detail flap_note: write the ready-to-post alert message.
build_tpx_alert() {
  local hop="$1" detail="$2" flap_note="$3" hop_name
  if [ "$hop" = "leg1" ]; then
    hop_name="VM-to-Coolify"
  else
    hop_name="Coolify-to-Mango"
  fi
  {
    echo "Trading proxy path confirmed down: ${hop_name} leg failed (missed twice, ${TPX_RETRY_SLEEP}s apart)${flap_note}."
    echo "Trading traffic may be falling back to direct egress or failing outright."
    echo ""
    echo "Failed hop: ${hop_name} -- ${detail}."
    echo "Proxy use (latest): $(format_tpx_proxy_use)."
    echo "Mango reachable from Coolify host: $(format_tpx_mango)."
  } > "$TPX_ALERT_FILE"
}

# handle_tpx_incident hop detail: once-per-incident alert logic.
handle_tpx_incident() {
  local hop="$1" detail="$2" now incident_hop flap_note=""
  now="$(date +%s)"
  incident_hop="${tpx_incident%%:*}"
  # Same incident still open: stay silent.
  if [ -n "$tpx_incident" ] && [ "$incident_hop" = "$hop" ]; then
    return 0
  fi
  # New incident. Flap check: did the last incident resolve recently?
  if [ "${tpx_last_resolve:-0}" != "0" ] && \
     [ "$((now - tpx_last_resolve))" -lt "$TPX_FLAP_WINDOW_S" ]; then
    tpx_flaps=$((tpx_flaps + 1))
    flap_note=" (flapping: ${tpx_flaps} incidents in 30m)"
  else
    tpx_flaps=0
  fi
  tpx_incident="${hop}:${now}"
  write_state "$consec" "$proxy_consec" "$last_restart" "${hop:-}"
  build_tpx_alert "$hop" "$detail" "$flap_note"
  log "trading-proxy: CONFIRMED failure hop=$hop ($detail); alert payload written"
}

# handle_tpx_recovery: clear the open incident when both legs pass.
handle_tpx_recovery() {
  if [ -n "${tpx_incident:-}" ]; then
    tpx_incident=""
    tpx_last_resolve="$(date +%s)"
    write_state "$consec" "$proxy_consec" "$last_restart" "${hop:-}"
    log "trading-proxy: both legs healthy again; incident cleared"
  fi
}

# check_trading_proxy_path: run both legs with one retry each, then update
# incident state.  Skipped when the 3130 probe proxy itself is down (the
# liveness proxy-path logic already owns that alert; no clean signal here).
check_trading_proxy_path() {
  local failed_hop="" detail="" rc
  if [ "${proxy_consec:-0}" -gt 0 ]; then
    log "trading-proxy: skipped (probe proxy path down; owned by liveness alert)"
    return 0
  fi
  # Leg 1: VM -> Coolify.
  if probe_tpx_leg1; then
    :
  else
    sleep "$TPX_RETRY_SLEEP"
    if probe_tpx_leg1; then
      log "trading-proxy: leg1 (VM->Coolify) miss cleared on retry; transient, silent"
    else
      failed_hop="leg1"
      detail="Coolify API gave no HTTP response via the tailnet proxy"
    fi
  fi
  # Leg 2: Coolify -> Mango (needs the app endpoint; skip if leg1 failed).
  if [ -z "$failed_hop" ]; then
    probe_tpx_leg2
    rc=$?
    if [ "$rc" = "0" ]; then
      :
    elif [ "$rc" = "2" ]; then
      log "trading-proxy: leg2 not assessable (endpoint unavailable); skipping, incident left open"
      return 0
    else
      sleep "$TPX_RETRY_SLEEP"
      probe_tpx_leg2
      rc=$?
      if [ "$rc" = "0" ]; then
        log "trading-proxy: leg2 (Coolify->Mango) miss cleared on retry; transient, silent"
      elif [ "$rc" = "2" ]; then
        log "trading-proxy: leg2 not assessable on retry; skipping, incident left open"
        return 0
      else
        failed_hop="leg2"
        detail="app on Coolify host reports Mango proxy unreachable"
      fi
    fi
  fi
  if [ -n "$failed_hop" ]; then
    handle_tpx_incident "$failed_hop" "$detail"
  else
    handle_tpx_recovery
  fi
}

# --- state helpers -----------------------------------------------------------
read_state() {
  consec=0
  consec_dest=0
  proxy_consec=0
  last_restart=0
  last_hop=""
  tpx_incident=""
  tpx_last_resolve=0
  tpx_flaps=0
  if [ -f "$STATE_FILE" ]; then
    # Parse fixed key=value lines; never source the state file -- a poisoned
    # state file must not become code execution in the watchdog user.
    local key value
    while IFS='=' read -r key value; do
      case "$key" in
        consecutive_failures) consec="$value" ;;
        consecutive_dest_transport_failures) consec_dest="$value" ;;
        consecutive_proxy_failures) proxy_consec="$value" ;;
        last_restart_epoch) last_restart="$value" ;;
        last_proxy_hop) last_hop="$value" ;;
        trading_proxy_incident) tpx_incident="$value" ;;
        trading_proxy_last_resolve) tpx_last_resolve="$value" ;;
        trading_proxy_flaps) tpx_flaps="$value" ;;
      esac
    done < "$STATE_FILE"
    # Sanitize: counters and epochs are numeric; hop and incident are enums.
    case "$consec" in *[!0-9]*|"") consec=0 ;; esac
    case "$consec_dest" in *[!0-9]*|"") consec_dest=0 ;; esac
    case "$proxy_consec" in *[!0-9]*|"") proxy_consec=0 ;; esac
    case "$last_restart" in *[!0-9]*|"") last_restart=0 ;; esac
    case "$tpx_last_resolve" in *[!0-9]*|"") tpx_last_resolve=0 ;; esac
    case "$tpx_flaps" in *[!0-9]*|"") tpx_flaps=0 ;; esac
    case "$last_hop" in hop1|hop2) ;; *) last_hop="" ;; esac
    case "$tpx_incident" in leg1:*|leg2:*) ;; *) tpx_incident="" ;; esac
  fi
}

write_state() {
  # args: consecutive_failures consecutive_proxy_failures last_restart_epoch last_proxy_hop
  # consecutive_dest_transport_failures is taken from the global consec_dest.
  # trading-proxy incident keys are appended when set (write_tpx_state).
  printf 'consecutive_failures=%s\nconsecutive_dest_transport_failures=%s\nconsecutive_proxy_failures=%s\nlast_restart_epoch=%s\nlast_proxy_hop=%s\n' \
    "$1" "${consec_dest:-0}" "$2" "$3" "${4:-}" > "$STATE_FILE.tmp"
  if [ -n "${tpx_incident:-}" ]; then
    printf 'trading_proxy_incident=%s\n' "$tpx_incident" >> "$STATE_FILE.tmp"
  fi
  if [ "${tpx_last_resolve:-0}" != "0" ]; then
    printf 'trading_proxy_last_resolve=%s\n' "$tpx_last_resolve" >> "$STATE_FILE.tmp"
  fi
  if [ "${tpx_flaps:-0}" != "0" ]; then
    printf 'trading_proxy_flaps=%s\n' "$tpx_flaps" >> "$STATE_FILE.tmp"
  fi
  mv "$STATE_FILE.tmp" "$STATE_FILE"
}

# --- probes ------------------------------------------------------------------
# probe_target: probe the app through the full public path, via the
# tailnet-capable egress proxy (whose IP Cloudflare does not block).
# Sets PROBE_CODE (HTTP status, "000" on transport failure) and PROBE_BODY
# (first 160 bytes, single line).  Returns 0 on HTTP 200.
# NOTE: --resolve is intentionally NOT used: curl ignores it for proxied
# CONNECT requests, and the proxy resolves the hostname itself.
PROBE_CODE=""
PROBE_BODY=""
probe_target() {
  local proxy code body_file
  proxy="$(tailnet_proxy)" || { PROBE_CODE="000"; PROBE_BODY="no tailnet proxy available"; return 1; }
  body_file="/tmp/st-probe-$$.body"
  code="$(curl -s -o "$body_file" -w '%{http_code}' -m 20 \
    --proxy "$proxy" \
    "$TARGET_URL" 2>/dev/null)"
  [ -n "$code" ] || code="000"
  PROBE_CODE="$code"
  if [ -f "$body_file" ]; then
    PROBE_BODY="$(tr '\n' ' ' < "$body_file" | head -c 160)"
    rm -f "$body_file"
  else
    PROBE_BODY="(no body)"
  fi
  [ "$code" = "200" ]
}

probe_proxy_path() {
  # Independent check that the 3130 proxy itself works: fetch a known-good
  # URL through it.  Returns 0 on HTTP 200.  Short timeout -- a healthy
  # proxy answers in ~1s (verified 2026-10-04).
  local proxy code
  proxy="$(tailnet_proxy)" || return 1
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
    --proxy "$proxy" \
    "$PROXY_CHECK_URL" 2>/dev/null)"
  [ -n "$code" ] || code="000"
  [ "$code" = "200" ]
}

probe_control() {
  # Control probe over the normal egress path.  Returns 0 on HTTP 200.
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$CONTROL_URL" 2>/dev/null)"
  [ -n "$code" ] || code="000"
  [ "$code" = "200" ]
}

# --- main --------------------------------------------------------------------
read_state
now="$(date +%s)"
hop="$last_hop"

# The trading-proxy (VM->Coolify->Mango) check runs once per invocation, after
# the liveness logic below has written its state.  It is independent of the
# liveness result and owns its own alerting (one Zulip alert per incident).
trap 'check_trading_proxy_path' EXIT

if probe_target; then
  if [ "$consec" -gt 0 ]; then
    log "recovered: $TARGET_URL healthy again after $consec consecutive site failures"
  fi
  if [ "${consec_dest:-0}" -gt 0 ]; then
    log "recovered: $TARGET_URL reachable again after $consec_dest consecutive dest-transport failures"
  fi
  if [ "$proxy_consec" -gt 0 ]; then
    log "recovered: tailnet proxy path healthy again after $proxy_consec consecutive proxy-path failures"
  fi
  consec=0
  consec_dest=0
  proxy_consec=0
  hop=""
  write_state "$consec" "$proxy_consec" "$last_restart" ""
  exit 0
fi

# Target probe failed -- classify: site failure, dest-transport failure,
# or proxy-path failure?
# The proxy-path check is hop-decomposed (see probe_proxy_hops): hop1 =
# VM->proxy endpoint TCP, hop2 = proxy->internet.  The failed hop is logged
# and persisted so the alert names the faulty segment.
if probe_proxy_hops; then
  if [ "$PROBE_CODE" = "000" ]; then
    # Dest-transport failure (2026-10-13): the proxy path is healthy but the
    # target gave NO HTTP response at all.  A container restart cannot fix an
    # unreachable path, so this class never counts toward the restart
    # threshold -- it is tracked and alerted separately.
    consec_dest=$((consec_dest + 1))
    consec=0
    proxy_consec=0
    hop=""
    log "dest-transport failure $consec_dest: $TARGET_URL unreachable (HTTP 000) while proxy path healthy; site status unknown, site-failure counter reset, NO restart will be attempted for transport failures"
  else
    # Proxy is fine, so the non-200 came from the public path (Cloudflare,
    # Traefik, or the app).  The body snippet tells which.
    consec=$((consec + 1))
    consec_dest=0
    proxy_consec=0
    hop=""
    log "failure $consec/$FAIL_THRESHOLD: $TARGET_URL returned HTTP $PROBE_CODE (via tailnet proxy); body: $PROBE_BODY"
  fi
else
  # Proxy path itself is down: site status is unknown.  Reset the site and
  # dest-transport counters rather than accusing the site, and track proxy
  # failures separately.  No restart is attempted on this path -- the restart
  # needs the same proxy to reach the Coolify API.
  proxy_consec=$((proxy_consec + 1))
  consec=0
  consec_dest=0
  hop="$HOP_FAILED"
  log "proxy-path failure $proxy_consec/$PROXY_FAIL_THRESHOLD: FAILED HOP=$hop ($HOP_WHY; target probe HTTP $PROBE_CODE); site status unknown, site-failure counter reset, no restart will be attempted while the proxy is down; $(tailscale_note)"
fi

if [ "$consec" -lt "$FAIL_THRESHOLD" ]; then
  write_state "$consec" "$proxy_consec" "$last_restart" "$hop"
  exit 0
fi

# Threshold reached (site failures only).  Cooldown gate.
since_restart=$((now - last_restart))
if [ "$since_restart" -lt "$COOLDOWN_S" ]; then
  log "threshold reached but cooldown active ($since_restart s < $COOLDOWN_S s); not restarting"
  write_state "$consec" "$proxy_consec" "$last_restart" "$hop"
  exit 0
fi

# Network sanity: if WE cannot reach the outside world, do not restart prod.
if ! probe_control; then
  log "control probe $CONTROL_URL also failed; local network issue, NOT restarting"
  write_state "$consec" "$proxy_consec" "$last_restart" "$hop"
  exit 0
fi

# Restart via Coolify API (over Tailscale too -- the default egress proxy
# refuses tailnet destinations, so pin the tailnet proxy explicitly).
if [ ! -f "$TOKEN_FILE" ]; then
  log "ERROR: Coolify token file missing at $TOKEN_FILE; cannot restart"
  write_state "$consec" "$proxy_consec" "$last_restart" "$hop"
  exit 1
fi
token="$(cat "$TOKEN_FILE")"
if [ -z "$token" ]; then
  log "ERROR: Coolify token file empty; cannot restart"
  write_state "$consec" "$proxy_consec" "$last_restart" "$hop"
  exit 1
fi
proxy="$(tailnet_proxy)" || {
  log "ERROR: no tailnet proxy available; cannot reach Coolify API"
  write_state "$consec" "$proxy_consec" "$last_restart" "$hop"
  exit 1
}

log "RESTARTING Coolify app $APP_UUID after $consec consecutive site failures"
# The bearer token travels in a mode-600 curl config file, never in argv
# (argv is visible to other users on the host in ps).
auth_cfg="$(mktemp)"
chmod 600 "$auth_cfg"
printf 'header = "Authorization: Bearer %s"\n' "$token" > "$auth_cfg"
resp="$(curl -s -m 30 -X POST \
  --proxy "$proxy" \
  -K "$auth_cfg" \
  -H "Accept: application/json" \
  "$COOLIFY_API/applications/$APP_UUID/restart" 2>&1 || echo "CURL_FAILED")"
rm -f "$auth_cfg"
log "restart API response: $(echo "$resp" | head -c 300)"
consec=0
write_state "$consec" "$proxy_consec" "$now" "$hop"
log "restart issued; site-failure counter reset, cooldown until +${COOLDOWN_S}s"
exit 0
