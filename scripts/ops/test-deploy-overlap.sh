#!/bin/bash
# Offline tests for #1537 overlap, the hold env, the Traefik render, and
# the reattach alias/route ordering (CONGRESS-TRADE-25).
# No Docker, no Coolify, no network (a stub `docker` stands in below).
#
#   bash scripts/ops/test-deploy-overlap.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REATTACH="${ROOT}/scripts/ops/ct-reattach-proxy.sh"
OVERLAP="${ROOT}/scripts/ops/ct-deploy-overlap.sh"
fail=0

assert_eq() {
  local got="$1" want="$2" name="$3"
  if [[ "$got" != "$want" ]]; then
    echo "FAIL ${name}: got '${got}' want '${want}'"
    fail=1
  else
    echo "ok   ${name}"
  fi
}

assert_contains() {
  local hay="$1" needle="$2" name="$3"
  if ! printf '%s' "$hay" | grep -qF -- "$needle"; then
    echo "FAIL ${name}: missing '${needle}'"
    fail=1
  else
    echo "ok   ${name}"
  fi
}

assert_not_contains() {
  local hay="$1" needle="$2" name="$3"
  if printf '%s' "$hay" | grep -qF -- "$needle"; then
    echo "FAIL ${name}: unexpectedly contains '${needle}'"
    fail=1
  else
    echo "ok   ${name}"
  fi
}

# --- decide table ----------------------------------------------------------
decide() {
  DEPLOY_ACTIVE="$1" BUILDER_ACTIVE="$2" APP_RUNNING="$3" HOLD_RUNNING="$4" \
    APP_HEALTHY="$5" OVERLAP_EARLY="$6" HAVE_IMAGE="$7" \
    bash "$OVERLAP" --decide
}

assert_eq "$(decide 1 1 1 0 1 0 1)" "noop" "late mode waits while builder still running"
assert_eq "$(decide 1 0 1 0 1 0 1)" "start-hold" "start hold after builder exits"
assert_eq "$(decide 1 1 1 0 1 1 1)" "start-hold" "early start during build (default)"
assert_eq "$(DEPLOY_ACTIVE=1 BUILDER_ACTIVE=1 APP_RUNNING=1 HOLD_RUNNING=0 APP_HEALTHY=1 HAVE_IMAGE=1 bash "$OVERLAP" --decide)" "start-hold" "script default OVERLAP_EARLY=1"
assert_eq "$(decide 1 0 0 0 0 0 1)" "start-hold" "late start from remembered image"
assert_eq "$(decide 1 0 0 0 0 0 0)" "noop" "cannot start without image"
assert_eq "$(decide 1 0 1 1 1 0 1)" "keep-hold" "hold already up during deploy"
assert_eq "$(decide 0 0 1 1 1 0 1)" "stop-hold" "drop hold once replacement is healthy"
assert_eq "$(decide 0 0 1 1 0 0 1)" "keep-hold" "keep hold while new app is not healthy"
assert_eq "$(decide 0 0 0 1 0 0 1)" "keep-hold" "keep hold in the zero-container gap"
assert_eq "$(decide 0 0 1 0 1 0 1)" "noop" "steady state"
# app_healthy is ignored when idle, which is why tick() skips the probe then.
assert_eq "$(decide 0 0 1 0 0 0 1)" "noop" "idle result does not depend on app health"

# --- loop cadence ----------------------------------------------------------
assert_eq "$(DEPLOY_ACTIVE=0 HOLD_RUNNING=0 bash "$OVERLAP" --sleep-for)" "5" "idle polls a little slower, never beyond 5s by default"
assert_eq "$(DEPLOY_ACTIVE=1 HOLD_RUNNING=0 bash "$OVERLAP" --sleep-for)" "3" "deploy in flight polls fast"
assert_eq "$(DEPLOY_ACTIVE=0 HOLD_RUNNING=1 bash "$OVERLAP" --sleep-for)" "3" "hold up polls fast"
assert_eq "$(IDLE_SLEEP_SEC=20 LOOP_SLEEP_SEC=2 DEPLOY_ACTIVE=0 HOLD_RUNNING=0 bash "$OVERLAP" --sleep-for)" "20" "idle sleep is overridable"

# --- Coolify deployments parse --------------------------------------------
parse_ok() {
  printf '%s' "$1" | APP_UUID=test-app-uuid bash "$OVERLAP" --parse-active
}

if parse_ok '{"0":{"application_uuid":"test-app-uuid","status":"in_progress"}}'; then
  echo "ok   parse in_progress object"
else
  echo "FAIL parse in_progress object"
  fail=1
fi

if parse_ok '{"data":[{"application_name":"congress-trade","status":"queued"}]}'; then
  echo "FAIL parse queued should not start hold"
  fail=1
else
  echo "ok   parse ignores queued (no hold until in-flight)"
fi

if parse_ok '{"0":{"application_uuid":"other","status":"in_progress"}}'; then
  echo "FAIL parse other app should be inactive"
  fail=1
else
  echo "ok   parse ignores other apps"
fi

# --- hold env --------------------------------------------------------------
env_tmp="$(mktemp -d)"
trap 'rm -rf "$env_tmp"' EXIT

# The full render write_hold_env hands docker, via the private-file mode.
render_env_full() {
  printf '%s' "$1" | bash "$OVERLAP" --render-env-file "$env_tmp/hold.env"
  cat "$env_tmp/hold.env"
}

# The stdout inspection mode, which must never show an app value.
render_env_shown() {
  printf '%s' "$1" | bash "$OVERLAP" --render-env
}

# Lines of $1 that start with $2 (a KEY= prefix).
count_prefix() {
  printf '%s\n' "$1" | grep -c "^$2" || true
}

# PEM_KEY is a multi-line value: docker inspect prints it as several lines,
# and one of them is base64 that looks like KEY=.
app_env=$'PATH=/usr/local/bin:/usr/bin\nCT_SKIP_LITESTREAM=0\nCT_DISABLE_STARTUP_SCHEMA_MIGRATE=0\nTURSO_DATABASE_URL=file:/data/congress-trade/db.sqlite\nCOOLIFY_TOKEN=not-a-real-token\nPEM_KEY=-----BEGIN PRIVATE KEY-----\nAbCdEfGhIjKlMnOp0123=\n-----END PRIVATE KEY-----\nCT_DISABLE_STARTUP_SCHEMA_MIGRATE=false\nCT_SKIP_LITESTREAM_NOTE=keep\n'
hold_env="$(render_env_full "$app_env")"
assert_eq "$(stat -c '%a' "$env_tmp/hold.env")" "600" "render-env-file writes a private file"
assert_eq "$(count_prefix "$hold_env" 'CT_SKIP_LITESTREAM=')" "1" "hold env has CT_SKIP_LITESTREAM once"
assert_eq "$(count_prefix "$hold_env" 'CT_DISABLE_STARTUP_SCHEMA_MIGRATE=')" "1" "hold env has CT_DISABLE_STARTUP_SCHEMA_MIGRATE once"
assert_contains "$hold_env" "CT_SKIP_LITESTREAM=1" "hold env skips Litestream"
assert_contains "$hold_env" "CT_DISABLE_STARTUP_SCHEMA_MIGRATE=1" "hold env skips the boot schema migrate"
assert_not_contains "$hold_env" "CT_SKIP_LITESTREAM=0" "hold env drops the app's Litestream value"
assert_not_contains "$hold_env" "CT_DISABLE_STARTUP_SCHEMA_MIGRATE=0" "hold env drops the app's migrate value"
assert_not_contains "$hold_env" "CT_DISABLE_STARTUP_SCHEMA_MIGRATE=false" "hold env drops the app's later migrate value"
assert_contains "$hold_env" "TURSO_DATABASE_URL=file:/data/congress-trade/db.sqlite" "hold env keeps the app env"
assert_contains "$hold_env" "CT_SKIP_LITESTREAM_NOTE=keep" "hold env keeps keys that only share a prefix"
assert_eq "$hold_env" $'PATH=/usr/local/bin:/usr/bin\nTURSO_DATABASE_URL=file:/data/congress-trade/db.sqlite\nCOOLIFY_TOKEN=not-a-real-token\nPEM_KEY=-----BEGIN PRIVATE KEY-----\nAbCdEfGhIjKlMnOp0123=\n-----END PRIVATE KEY-----\nCT_SKIP_LITESTREAM_NOTE=keep\nCT_SKIP_LITESTREAM=1\nCT_DISABLE_STARTUP_SCHEMA_MIGRATE=1' "hold env keeps every other line in order"

# last-env is a rendered env; rendering it again must not add a second copy.
again_env="$(render_env_full "$hold_env")"
assert_eq "$again_env" "$hold_env" "re-rendering a hold env is a no-op"

# --render-env runs on the live app's env, credentials included: it prints
# the two hold flags and a count, and no part of any other line.
shown_env="$(render_env_shown "$app_env")"
assert_eq "$shown_env" $'CT_SKIP_LITESTREAM=1\nCT_DISABLE_STARTUP_SCHEMA_MIGRATE=1\n# 7 other env line(s) not shown' "render-env shows only the hold flags"
while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  case "$line" in CT_SKIP_LITESTREAM=* | CT_DISABLE_STARTUP_SCHEMA_MIGRATE=*) continue ;; esac
  assert_not_contains "$shown_env" "$line" "render-env hides the line ${line:0:12}..."
done <<< "$app_env"

bare_env="$(render_env_shown '')"
assert_eq "$bare_env" $'CT_SKIP_LITESTREAM=1\nCT_DISABLE_STARTUP_SCHEMA_MIGRATE=1\n# 0 other env line(s) not shown' "empty env still gets both hold flags once"

# --- Traefik render --------------------------------------------------------
plain="$(bash "$REATTACH" --render plain)"
hold="$(bash "$REATTACH" --render hold)"
standby="$(bash "$REATTACH" --render standby)"
both="$(bash "$REATTACH" --render both)"

assert_contains "$plain" 'url: "http://congress-app:5000"' "plain points at congress-app"
assert_not_contains "$plain" "healthCheck:" "plain has no health check"
assert_not_contains "$plain" "failover:" "plain has no failover"
assert_not_contains "$plain" "no available server" "render is not the catch-all"

assert_contains "$hold" "fallback: congress-hold" "hold failover target"
assert_contains "$hold" "url: \"http://congress-hold:5000\"" "hold server url"
assert_contains "$hold" "path: /health" "hold probes /health not /api/health"
assert_not_contains "$hold" "/api/health" "hold must not probe /api/health"
assert_contains "$hold" "service: congress-front" "hold routers use failover service"

assert_contains "$standby" "fallback: congress-standby" "standby failover target"
assert_contains "$standby" "url: \"http://congress-standby:8080\"" "standby server url"

assert_contains "$both" "fallback: congress-hold" "both prefers hold over standby"
assert_not_contains "$both" "fallback: congress-standby" "both does not use standby"

# Catch-all shape that produces the owner-visible error string must never
# be what we write.  Coolify's default_redirect_503.yaml is `servers: { }`.
assert_not_contains "$plain" "servers: { }" "plain is not an empty LB"
assert_not_contains "$hold" "servers: { }" "hold is not an empty LB"
assert_not_contains "$standby" "servers: { }" "standby is not an empty LB"

# --- reattach alias/route ordering (CONGRESS-TRADE-25) ---------------------
# End of a deploy: the replacement is up but unaliased, and the route file
# still holds the stale hold-failover shape. The alias attach must land
# BEFORE the route flips to the single-server shape, or Traefik 502s on an
# unresolvable name. A stub `docker` first on PATH keeps this offline and
# hermetic (a real daemon's containers must not leak in).
stubbin="$env_tmp/stubbin"
mkdir -p "$stubbin"
cat > "$stubbin/docker" <<'STUBEOF'
#!/bin/bash
# STUB_MODE=app-unaliased: replacement up, carries no aliases yet.
# STUB_MODE=empty:         no containers at all (mid-swap gap).
# STUB_MODE=connect-fails: replacement up, but network connect fails.
# STUB_MODE=realias-fails: on the network under another alias; the aliased
#                          reconnect fails and a plain reconnect must follow.
mode="${STUB_MODE:-app-unaliased}"
log_action() {
  [[ -n "${STUB_ACTION_LOG:-}" ]] && printf '%s\n' "$1" >> "$STUB_ACTION_LOG"
}
if [[ "$1" == "ps" ]]; then
  if [[ "$mode" == "app-unaliased" || "$mode" == "connect-fails" || "$mode" == "realias-fails" ]]; then
    printf 'congress-app-abc123\n'
  fi
  exit 0
fi
if [[ "$1" == "inspect" ]]; then
  if [[ "$mode" == "realias-fails" ]]; then
    printf 'other-alias\n'
  else
    printf '\n'
  fi
  exit 0
fi
if [[ "$1" == "network" && "$2" == "disconnect" ]]; then
  log_action disconnect
  exit 0
fi
if [[ "$1" == "network" && "$2" == "connect" ]]; then
  # The stub answers "unaliased" until this runs, so if the route file
  # already flipped to plain, the swap beat the attach.
  if [[ -n "${STUB_ROUTE_FILE:-}" && -n "${STUB_ORDER_LOG:-}" ]]; then
    if grep -q 'fallback:' "${STUB_ROUTE_FILE}" 2>/dev/null; then
      printf 'alias-before-route\n' >> "${STUB_ORDER_LOG}"
    else
      printf 'route-before-alias\n' >> "${STUB_ORDER_LOG}"
    fi
  fi
  if [[ "$mode" == "connect-fails" ]]; then
    exit 1
  fi
  if [[ "$mode" == "realias-fails" ]]; then
    if [[ "$3" == "--alias" ]]; then
      log_action aliased-connect-failed
      exit 1
    fi
    log_action plain-reconnect
    exit 0
  fi
  exit 0
fi
exit 0
STUBEOF
chmod +x "$stubbin/docker"

order_log="$env_tmp/order.log"
route_file="$env_tmp/congress-trade.yml"
bash "$REATTACH" --render hold > "$route_file" # stale deploy-window shape
: > "$order_log"
rc=0
STUB_MODE=app-unaliased STUB_ROUTE_FILE="$route_file" STUB_ORDER_LOG="$order_log" \
  PATH="$stubbin:$PATH" DYNAMIC_FILE="$route_file" STAGE_DIR="$env_tmp" \
  bash "$REATTACH" > "$env_tmp/reattach-out.txt" 2>&1 || rc=$?
assert_eq "$rc" "0" "reattach exits 0 with stub docker"
assert_eq "$(cat "$order_log")" "alias-before-route" "alias attach lands before the route swap"
assert_eq "$(cat "$route_file")" "$(bash "$REATTACH" --render plain)" "stale failover route returns to plain"
assert_contains "$(cat "$env_tmp/reattach-out.txt")" "route file updated" "swap is logged"

# Mid-swap gap: no app container at all. The route file must still be
# written (stale failover -> plain), or the catch-all takes over.
bash "$REATTACH" --render hold > "$route_file" # stale again
rc=0
STUB_MODE=empty \
  PATH="$stubbin:$PATH" DYNAMIC_FILE="$route_file" STAGE_DIR="$env_tmp" \
  bash "$REATTACH" > "$env_tmp/reattach-out2.txt" 2>&1 || rc=$?
assert_eq "$rc" "0" "reattach exits 0 with no app container"
assert_eq "$(cat "$route_file")" "$(bash "$REATTACH" --render plain)" "route file is written even with no app container"
assert_contains "$(cat "$env_tmp/reattach-out2.txt")" "no congress-app container" "missing app is logged"

# Attach failed and the desired route is plain. The stale hold file must
# stay: a plain route has no health check, so an unaliased name 502s.
bash "$REATTACH" --render hold > "$route_file"
rc=0
STUB_MODE=connect-fails \
  PATH="$stubbin:$PATH" DYNAMIC_FILE="$route_file" STAGE_DIR="$env_tmp" \
  bash "$REATTACH" > "$env_tmp/reattach-out3.txt" 2>&1 || rc=$?
assert_eq "$rc" "0" "reattach exits 0 when alias attach fails"
assert_eq "$(cat "$route_file")" "$(bash "$REATTACH" --render hold)" "failed attach does not flip a hold route to plain"
assert_contains "$(cat "$env_tmp/reattach-out3.txt")" "alias attach failed" "failed attach is logged"
assert_not_contains "$(cat "$env_tmp/reattach-out3.txt")" "route file updated" "failed attach does not log a route swap"

# Re-alias disconnects first. If the aliased connect fails, the container
# must be put back on the network without the alias, and the hold route stays.
bash "$REATTACH" --render hold > "$route_file"
action_log="$env_tmp/actions.log"
: > "$action_log"
rc=0
STUB_MODE=realias-fails STUB_ACTION_LOG="$action_log" \
  PATH="$stubbin:$PATH" DYNAMIC_FILE="$route_file" STAGE_DIR="$env_tmp" \
  bash "$REATTACH" > "$env_tmp/reattach-out4.txt" 2>&1 || rc=$?
assert_eq "$rc" "0" "reattach exits 0 when re-alias connect fails"
assert_eq "$(cat "$action_log")" "$(printf '%s\n' disconnect aliased-connect-failed plain-reconnect)" "failed re-alias restores network membership"
assert_eq "$(cat "$route_file")" "$(bash "$REATTACH" --render hold)" "failed re-alias does not flip the hold route"
assert_contains "$(cat "$env_tmp/reattach-out4.txt")" "restored" "restore without alias is logged"

if [[ "$fail" -ne 0 ]]; then
  echo "FAILED"
  exit 1
fi
echo "PASSED"
exit 0
