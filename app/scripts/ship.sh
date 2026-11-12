#!/usr/bin/env bash
# ship.sh — wait for Coolify, then migrate Congress.Trade.
#
# Coolify rebuilds the Deno-in-Docker app on push to main.  This script does
# not wrangler-deploy and does not talk to Deno Deploy or Turso.  It waits
# until https://congress.trade/api/health reports the current HEAD SHA, then
# applies schema via POST /api/admin/migrate against the live host SQLite
# file (not D1).
#
#   ADMIN_TOKEN=xxx bash scripts/ship.sh                  # deploy + ensure schema
#   bash scripts/ship.sh --deploy-only                    # deploy + health only
#   ADMIN_TOKEN=xxx bash scripts/ship.sh --enrich         # + repopulate photos
#   ADMIN_TOKEN=xxx bash scripts/ship.sh --backfill       # + reload senate history
#   ADMIN_TOKEN=xxx bash scripts/ship.sh --house          # + crawl recent House PTRs
#     (bounded by default to 2024-2026, maxFilings=500; override with
#      HOUSE_FROM / HOUSE_TO / HOUSE_MAX env vars)
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${BASE:-https://congress.trade}"
ADMIN_BASE="$BASE"
DEPLOY_ONLY=false
ADMIN_STEPS=()

# congress.trade sits behind a Cloudflare managed challenge that 403s requests
# with no browser User-Agent (e.g. a CI runner's or script's bare curl). Send a
# real browser UA on every request to the app — both the health check and the
# admin POST steps below — so a plain `ADMIN_TOKEN=... bash scripts/ship.sh`
# doesn't pass health and then 403 on /api/admin/migrate.
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

usage() {
  cat <<'EOF'
Usage: ADMIN_TOKEN=... bash scripts/ship.sh [--enrich] [--backfill] [--house]
       bash scripts/ship.sh --deploy-only

Default mode deploys, checks /health liveness, migrates, then checks /api/health readiness.
Use --deploy-only only when intentionally skipping admin post-deploy steps.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --deploy-only)
      DEPLOY_ONLY=true
      ;;
    --enrich|--backfill|--house)
      ADMIN_STEPS+=("$arg")
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "$DEPLOY_ONLY" != true ] && [ -z "${ADMIN_TOKEN:-}" ]; then
  echo "!! ADMIN_TOKEN is required for production deploys that run /api/admin/migrate." >&2
  echo "   Set ADMIN_TOKEN=... or pass --deploy-only to explicitly skip admin post-deploy steps." >&2
  exit 1
fi

check_api_health() {
  local health_url="${1:-$BASE/api/health}"
  local label="${2:-$BASE}"
  local attempts delay body_file body code i
  attempts="${DEPLOY_HEALTH_ATTEMPTS:-8}"
  delay="${DEPLOY_HEALTH_DELAY_SECONDS:-10}"
  body_file="$(mktemp)"
  trap 'rm -f "$body_file"' RETURN

  for ((i = 1; i <= attempts; i++)); do
    code="$(curl -sS -A "$UA" -o "$body_file" -w '%{http_code}' "$health_url" || true)"
    body="$(cat "$body_file")"
    if [[ "$code" == 2* && "$body" == *'"ok":true'* && "$body" == *'"db":true'* ]]; then
      echo "$body"
      return 0
    fi

    echo "   /api/health attempt $i/$attempts on $label failed (HTTP ${code:-curl-error})." >&2
    if [ "$i" -lt "$attempts" ]; then
      sleep "$delay"
    fi
  done

  echo "$body" >&2
  echo "!! /api/health on $label did not report ok=true and db=true after $attempts attempt(s)." >&2
  return 1
}

check_liveness() {
  local base="$1"
  curl -fsS -A "$UA" "$base/health" | grep -q '"ok":true'
}

# Assert the LIVE build is the commit we intend to ship.
#
# ship.sh does not deploy — Coolify redeploys on push to main, and that webhook
# has silently not fired before. Without this check the script health-checks
# whichever revision happens to be running, migrates it, prints success, and an
# operator reasonably reports the new code as live. That produced a false
# "deployed" report on 2026-08-01 for six merged security PRs.
#
# Waits for the running build SHA to match, rather than assuming it.
check_live_revision() {
  local base="$1"
  local expected attempts delay body live i
  expected="$(git rev-parse HEAD 2>/dev/null || echo '')"
  if [ -z "$expected" ]; then
    echo "   (not a git checkout — skipping revision assertion)"
    return 0
  fi
  attempts="${DEPLOY_REVISION_ATTEMPTS:-30}"
  # Gentle ramp (CT-2459): poll eagerly at first (Coolify usually lands in
  # well under a minute), then back off to the old fixed 20s cadence.
  # Setting DEPLOY_REVISION_DELAY_SECONDS pins a fixed delay instead.
  delay="${DEPLOY_REVISION_DELAY_SECONDS:-5}"

  for ((i = 1; i <= attempts; i++)); do
    body="$(curl -sS -A "$UA" "$base/api/health" || true)"
    live="$(printf '%s' "$body" | sed -n 's/.*"build":{"sha":"\([^"]*\)".*/\1/p')"

    if [ "$live" = "$expected" ]; then
      echo "   live build ${live:0:12} matches HEAD — deploy confirmed."
      return 0
    fi

    if [ -z "$live" ] || [ "$live" = "unknown" ]; then
      if [ "${ALLOW_UNKNOWN_BUILD_SHA:-0}" = "1" ]; then
        echo "   (ALLOW_UNKNOWN_BUILD_SHA=1 — build sha is unknown; proceeding with migration and health check)"
        return 0
      fi
      # Pre-dates the build-SHA receipt, or SOURCE_COMMIT was not passed to the
      # build. Cannot verify; say so loudly rather than implying success.
      echo "!! /api/health reports no build SHA on $base." >&2
      echo "   The running image predates the build-revision receipt, or Coolify" >&2
      echo "   did not pass SOURCE_COMMIT. Pass ALLOW_UNKNOWN_BUILD_SHA=1 to bypass." >&2
      return 2
    fi

    echo "   waiting for deploy: live ${live:0:12} != HEAD ${expected:0:12} (attempt $i/$attempts)"
    if [ "$i" -lt "$attempts" ]; then
      sleep "$delay"
      if [ -z "${DEPLOY_REVISION_DELAY_SECONDS:-}" ] && [ "$delay" -lt 20 ]; then
        delay=$((delay + 5))
      fi
    fi
  done

  echo "!! Live build is ${live:0:12} but HEAD is ${expected:0:12}." >&2
  echo "   Coolify has not deployed this commit. Do NOT report it as shipped." >&2
  echo "   Trigger it: GET https://host.jays.services/api/v1/deploy?uuid=congress-trade" >&2
  echo "   (Bearer COOLIFY_AGENTS, browser User-Agent — Cloudflare 403s other UAs.)" >&2
  return 1
}

# Post-deploy smoke: fetch the served dashboard HTML (with a browser UA, same
# Cloudflare-challenge reason as above) and run `node --check` on every inline
# <script> block. Guards against shipping a dashboard whose embedded JS fails
# to parse in the browser (2026-07-12 outage: /health was green while the
# served page's inline script was syntactically broken).
check_dashboard_scripts() {
  local page_url="$1"
  local html_file
  html_file="$(mktemp)"
  trap 'rm -f "$html_file"' RETURN
  if ! curl -fsS -A "$UA" "$page_url" -o "$html_file"; then
    echo "!! Failed to fetch dashboard HTML from $page_url." >&2
    return 1
  fi
  node - "$html_file" <<'NODE_SMOKE'
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const html = fs.readFileSync(process.argv[2], 'utf8');
const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let index = 0;
let checked = 0;
let match;
while ((match = scriptRe.exec(html)) !== null) {
  index++;
  const attrs = match[1];
  const body = match[2];
  if (/\bsrc\s*=/i.test(attrs)) continue; // external script — nothing inline to parse
  if (!body.trim()) continue; // empty block
  const tmp = path.join(os.tmpdir(), `ship-inline-script-${process.pid}-${index}.js`);
  fs.writeFileSync(tmp, body);
  const result = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  fs.unlinkSync(tmp);
  if (result.status !== 0) {
    console.error(`!! Inline <script> #${index} in served HTML failed to parse.`);
    console.error('   First lines of the failing block:');
    for (const line of body.split('\n').slice(0, 5)) console.error(`   | ${line}`);
    console.error((result.stderr || result.stdout || '').trim());
    process.exit(1);
  }
  checked++;
}
if (checked === 0) {
  console.error('!! No inline <script> blocks found in served HTML — dashboard markup looks wrong.');
  process.exit(1);
}
console.log(`   OK: ${checked} inline <script> block(s) parsed cleanly.`);
NODE_SMOKE
}

echo "==> Production deployment is managed by Coolify (triggered automatically on push to main)."

echo "==> Live app liveness check"
ADMIN_BASE="$BASE"
if ! check_liveness "$BASE"; then
  echo "!! /health failed on $BASE." >&2
  exit 1
fi
echo

echo "==> Live revision check (is HEAD actually deployed?)"
check_live_revision "$BASE"
revision_status=$?
if [ "$revision_status" -eq 1 ]; then
  # A confirmed mismatch is fatal: migrating and "verifying" a revision we did
  # not ship is exactly how a stale production gets reported as deployed.
  exit 1
fi
if [ "$revision_status" -eq 2 ]; then
  echo "   Continuing WITHOUT revision proof — treat this run as unverified." >&2
fi
echo

post() { # $1 = admin path, $2 = json body (optional)
  echo "==> POST /api/admin/$1"
  local body_file code
  body_file="$(mktemp)"
  # NOT `curl -f`: on a non-2xx, -f discards the body, which for /migrate is
  # the entire diagnostic payload (the failed[] statements and their SQL
  # errors, plus readiness.missing). Capture the body, then decide.
  code="$(curl -sS -A "$UA" -X POST "$ADMIN_BASE/api/admin/$1" \
    -H "authorization: Bearer $ADMIN_TOKEN" \
    -H "content-type: application/json" -d "${2:-{}}" \
    -o "$body_file" -w '%{http_code}')" || true
  if [[ "$code" == 2* ]]; then
    cat "$body_file"; echo
    rm -f "$body_file"
    return 0
  fi
  echo "!! POST /api/admin/$1 returned HTTP ${code:-curl-error}." >&2
  echo "   Response body (this is the diagnostic — read the failed[] array):" >&2
  cat "$body_file" >&2; echo >&2
  rm -f "$body_file"
  return 1
}

if [ "$DEPLOY_ONLY" = true ]; then
  echo "==> Deploy-only mode: skipped /api/admin/migrate; verifying existing schema readiness."
  check_api_health "$ADMIN_BASE/api/health" "$ADMIN_BASE"
  echo "==> Served-HTML inline script parse smoke"
  check_dashboard_scripts "$ADMIN_BASE/"
  echo "==> Done."
  exit 0
fi

# Ensure the schema is current (idempotent). The app already applies the
# same statement list at startup (src/deno/main.ts), and /api/health spreads
# checkReadiness() ({ok, db, schema, missing[]}); when the just-verified
# live build reports schema=true with nothing missing, the extra migrate
# POST is a duplicate replay -- skip it (CT-2459). SHIP_FORCE_MIGRATE=1
# always POSTs; the live-SHA assertion above still runs either way.
health_body="$(curl -sS -A "$UA" "$ADMIN_BASE/api/health" || true)"
if [ "${SHIP_FORCE_MIGRATE:-0}" != "1" ] \
  && [[ "$health_body" == *'"schema":true'* ]] \
  && [[ "$health_body" == *'"missing":[]'* ]]; then
  echo "==> /api/health reports schema current (schema=true, missing=[]) -- skipping duplicate migrate POST."
else
  post migrate
fi

echo "==> Live API readiness check"
check_api_health "$ADMIN_BASE/api/health" "$ADMIN_BASE"

echo "==> Served-HTML inline script parse smoke"
check_dashboard_scripts "$ADMIN_BASE/"

# Under `set -u`, empty arrays can throw "unbound variable" on some bash builds.
if ((${#ADMIN_STEPS[@]} > 0)); then
  for arg in "${ADMIN_STEPS[@]}"; do
    case "$arg" in
      --enrich)   post enrich-photos ;;
      --backfill) post backfill '{"chambers":["senate"],"limit":20000}' ;;
      --house)    post house-backfill '{"fromYear":'"${HOUSE_FROM:-2024}"',"toYear":'"${HOUSE_TO:-2026}"',"maxFilings":'"${HOUSE_MAX:-500}"'}' ;;
    esac
  done
fi

echo "==> Done."
