#!/bin/bash
# ct-reattach-proxy.sh — keep congress-app reachable from Traefik on the
# `coolify` network under a stable DNS alias, and keep the dynamic route file
# pointed at that alias.
#
# Install (Coolify / Hetzner host):
#   install -m 0755 scripts/ops/ct-reattach-proxy.sh /usr/local/bin/
#   cron: * * * * * root /usr/local/bin/ct-reattach-proxy.sh >/var/log/ct-reattach-proxy.log 2>&1
#
# THIS FILE IS THE ENTIRE PUBLIC ROUTE FOR congress.trade.
#   The app container carries NO traefik.* labels (verified 2026-08-12) and the
#   proxy runs with `--providers.docker.exposedbydefault=false`, so Traefik's
#   Docker provider produces nothing for this app. The only thing that puts
#   congress.trade on the internet is the file this script writes into
#   /data/coolify/proxy/dynamic/, which Traefik watches with
#   `--providers.file.directory=/traefik/dynamic/ --providers.file.watch=true`.
#
# IMPORTANT (2026-08-10): this script used to disconnect and reconnect the
# container from the `coolify` network on EVERY run, including when it was
# already correctly attached. At one run per minute that produced a brief
# unreachable window every 60s — intermittent 502/503 at the edge, and a
# once-a-minute `health FAIL 1/2 -> ok` oscillation in congress-health-recover.
# Those phantom failures also drained the watchdog's hourly restart budget, so
# when the app genuinely died it refused to remediate.
#
# The reconnect is now conditional: it only touches the network when the
# container is missing from `coolify` or is attached WITHOUT the expected
# alias. A correctly-attached container is left alone.
#
# IMPORTANT (2026-08-12): the route file used to be rewritten with
# `cat > "$DYNAMIC_FILE"` on EVERY run. That opens the watched file with
# O_TRUNC, so the file Traefik is watching is momentarily EMPTY. An empty file
# is valid YAML (null), so a reload landing in that window applies a
# configuration with no congress routers at all — and Coolify's own
# `default_redirect_503.yaml` installs a `catchall` router (priority -1000)
# pointing at a service `noop` whose server list is literally `{}`. Traefik's
# load balancer with zero servers answers:
#
#     HTTP 503   no available server
#
# which is exactly the error the owner hit on 2026-08-12. A merely *dead*
# backend does not produce that string — an unresolvable `congress-app` alias
# gives 502 Bad Gateway. "no available server" means the request fell through
# to the catch-all, i.e. our routers were not in the running config.
#
# Two changes remove that window entirely:
#   1. Steady state writes NOTHING. The rendered config is byte-compared with
#      what is already on disk and the file is left untouched when equal, so
#      Traefik sees no inotify event at all (previously: 1440 events/day, each
#      one a chance to catch the file mid-truncate).
#   2. A genuine change is staged in /data/coolify/proxy (mounted into the
#      proxy, but NOT the watched directory) and moved into place with `mv`,
#      which is an atomic rename on the same filesystem. Traefik therefore only
#      ever sees the complete old file or the complete new one.
#      The staging file must NOT live in dynamic/ — Traefik parses every file
#      in that directory, so a temp copy there would briefly duplicate every
#      router name.
#
# The route file is also now written independently of the container: if
# congress-app is missing (mid-deploy, for example) the routers must still
# exist, otherwise the catch-all takes over and turns a 502 into a bare
# "no available server".
#
# IMPORTANT (2026-08-17, #1537): Coolify compose deploys still call
# stop_running_container(force: true) BEFORE compose up, so there is no
# in-project overlap.  ct-deploy-overlap.sh starts `congress-hold` OUTSIDE
# the Coolify project from the live image.  When that container is running
# this script prefers it as the Traefik failover (real app, not the holding
# page).  Standby remains the last-resort fallback when hold is absent.
#
# IMPORTANT (2026-11-09, CONGRESS-TRADE-25): the alias attach below runs
# BEFORE the route-file swap.  At the end of a deploy the replacement
# container exists but does not carry the alias yet, so a route flipped to
# the single-server shape first points at a name that does not resolve —
# a brief 502 on every deploy even when the overlap hold covered the swap
# itself.  Attaching first means the primary health check is already
# passing against the new container while the failover shape is still up.
# If the attach fails, a plain route (no health check, no failover) is left
# untouched so a working hold route is not replaced by an unresolvable name.

set -euo pipefail

NETWORK="${NETWORK:-coolify}"
ALIAS="${ALIAS:-congress-app}"
DYNAMIC_FILE="${DYNAMIC_FILE:-/data/coolify/proxy/dynamic/congress-trade.yml}"
# Same filesystem as DYNAMIC_FILE, outside the directory Traefik watches.
STAGE_DIR="${STAGE_DIR:-/data/coolify/proxy}"
STANDBY_NAME="${STANDBY_NAME:-congress-standby}"
STANDBY_PORT="${STANDBY_PORT:-8080}"
HOLD_NAME="${HOLD_NAME:-congress-hold}"

# --- render the desired route file ----------------------------------------
#
# Three shapes:
#   * plain      — one server, no Traefik health check. A health check here
#                  would be actively harmful: if it ever failed, congress-svc
#                  would have zero healthy servers and Traefik would answer
#                  "no available server" for every request. Without one,
#                  Traefik just proxies and a dead backend gives 502.
#   * failover   — used when a fallback container is actually running
#                  (hold = live app clone from ct-deploy-overlap.sh; standby
#                  = holding page from ct-standby.service).  Both sit
#                  OUTSIDE the Coolify project so `docker compose ... up`
#                  cannot remove them.  Traefik's `failover` service
#                  requires a health check on the primary; that check is
#                  what flips traffic during the deploy window and back
#                  afterwards.  It probes `/health` — the trivial
#                  `{"ok":true}` liveness route — NOT `/api/health`, which
#                  returns 503 on database or schema trouble and would
#                  divert live traffic while the app was still serving.
#   Hold wins over standby when both are up: clients keep getting the real
#   app instead of a 503 holding page.
render_config() {
  local fallback="${1:-}"
  local svc="congress-svc"
  [[ -n "$fallback" ]] && svc="congress-front"

  cat <<EOF
# Generated by ct-reattach-proxy.sh — do not edit by hand.
http:
  middlewares:
    congress-gzip:
      compress: true
  routers:
    congress-http:
      rule: "Host(\`congress.trade\`) || Host(\`www.congress.trade\`) || Host(\`admin.congress.trade\`)"
      entryPoints: [http]
      service: ${svc}
    congress-https:
      rule: "Host(\`congress.trade\`) || Host(\`www.congress.trade\`) || Host(\`admin.congress.trade\`)"
      entryPoints: [https]
      middlewares: [congress-gzip]
      service: ${svc}
      tls: {}
  services:
EOF

  if [[ "$fallback" == "hold" ]]; then
    cat <<EOF
    congress-front:
      failover:
        service: congress-svc
        fallback: congress-hold
    congress-svc:
      loadBalancer:
        servers:
          - url: "http://${ALIAS}:5000"
        healthCheck:
          path: /health
          interval: 2s
          timeout: 1s
    congress-hold:
      loadBalancer:
        servers:
          - url: "http://${HOLD_NAME}:5000"
EOF
  elif [[ "$fallback" == "standby" ]]; then
    cat <<EOF
    congress-front:
      failover:
        service: congress-svc
        fallback: congress-standby
    congress-svc:
      loadBalancer:
        servers:
          - url: "http://${ALIAS}:5000"
        healthCheck:
          path: /health
          interval: 3s
          timeout: 2s
    congress-standby:
      loadBalancer:
        servers:
          - url: "http://${STANDBY_NAME}:${STANDBY_PORT}"
EOF
  else
    cat <<EOF
    congress-svc:
      loadBalancer:
        servers:
          - url: "http://${ALIAS}:5000"
EOF
  fi
}

if [[ "${1:-}" == "--render" ]]; then
  case "${2:-plain}" in
    plain|"") render_config "" ;;
    hold) render_config hold ;;
    standby) render_config standby ;;
    hold+standby|both) render_config hold ;;
    *) echo "usage: $0 --render [plain|hold|standby|both]" >&2; exit 2 ;;
  esac
  exit 0
fi

HOLD_RUNNING=""
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$HOLD_NAME"; then
  HOLD_RUNNING=1
fi
STANDBY_RUNNING=""
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$STANDBY_NAME"; then
  STANDBY_RUNNING=1
fi

FALLBACK=""
if [[ -n "$HOLD_RUNNING" ]]; then
  FALLBACK="hold"
elif [[ -n "$STANDBY_RUNNING" ]]; then
  FALLBACK="standby"
fi

DESIRED=$(render_config "$FALLBACK")

# --- keep the container aliased on the proxy network ----------------------
# BEFORE the route-file swap below (CONGRESS-TRADE-25): flipping to the
# single-server shape first would point at a name the replacement
# container does not carry yet.  When the app is missing entirely the
# route file is still written — otherwise the catch-all takes over.
# Match both Coolify's `congress-app-<hash>` names and a literal
# `container_name: congress-app`.  Never pick the overlap hold.
APP=$(docker ps --format "{{.Names}}" | grep -E '^congress-app(-|$)' | grep -v "^${HOLD_NAME}\$" | head -1 || true)
alias_ready=0
if [[ -z "${APP}" ]]; then
  echo "no congress-app container"
else
  # Aliases the container currently advertises on $NETWORK (empty if not attached).
  # docker inspect prints a newline even when the alias list is empty; treat
  # whitespace-only as "not attached" so we connect instead of disconnecting.
  current_aliases=$(docker inspect "$APP" \
    --format "{{range \$net, \$conf := .NetworkSettings.Networks}}{{if eq \$net \"${NETWORK}\"}}{{range \$conf.Aliases}}{{.}} {{end}}{{end}}{{end}}" \
    2>/dev/null || true)
  current_aliases=${current_aliases//$'\n'/ }
  current_aliases="${current_aliases#"${current_aliases%%[![:space:]]*}"}"
  current_aliases="${current_aliases%"${current_aliases##*[![:space:]]}"}"

  if [[ -z "$current_aliases" ]]; then
    # Not on the network at all — attach.
    if docker network connect --alias "$ALIAS" "$NETWORK" "$APP"; then
      alias_ready=1
      echo "attached $APP to $NETWORK as $ALIAS"
    else
      echo "alias attach failed for $APP on $NETWORK"
    fi
  elif ! printf '%s' "$current_aliases" | tr ' ' '\n' | grep -qx "$ALIAS"; then
    # On the network but missing the alias — this is the only case that needs a
    # disconnect/reconnect, since aliases cannot be added to a live endpoint.
    docker network disconnect "$NETWORK" "$APP" 2>/dev/null || true
    if docker network connect --alias "$ALIAS" "$NETWORK" "$APP"; then
      alias_ready=1
      echo "re-aliased $APP on $NETWORK as $ALIAS (was: $current_aliases)"
    else
      echo "alias attach failed for $APP on $NETWORK"
    fi
  else
    alias_ready=1
    echo "ok: $APP already on $NETWORK as $ALIAS"
  fi
fi

# --- swap the route file --------------------------------------------------
# Plain has no health check. Writing it while the alias is missing turns a
# hold failover into a 502. Keep the file that is already on disk.
if [[ -z "$FALLBACK" && -n "${APP}" && "$alias_ready" -ne 1 ]]; then
  echo "route file unchanged: alias not attached and desired route is plain"
elif [[ -f "$DYNAMIC_FILE" ]] && [[ "$(cat "$DYNAMIC_FILE")" == "$DESIRED" ]]; then
  : # steady state: identical, so do not touch the watched file at all
else
  TMP=$(mktemp "${STAGE_DIR}/.ct-reattach-proxy.XXXXXX")
  printf '%s\n' "$DESIRED" > "$TMP"
  chmod 0644 "$TMP"
  mv -f "$TMP" "$DYNAMIC_FILE"   # atomic rename; Traefik never sees a partial file
  echo "route file updated (fallback=${FALLBACK:-plain} hold=${HOLD_RUNNING:-0} standby=${STANDBY_RUNNING:-0})"
fi
