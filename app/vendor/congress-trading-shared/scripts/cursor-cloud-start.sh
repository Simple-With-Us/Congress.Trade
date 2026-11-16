#!/usr/bin/env bash
# Cursor cloud agent start for congress-trading-shared.
# Runs every agent boot (Cursor dashboard "start" hook).  Exports Infisical
# secrets for the prod env into a private env file under
# $HOME/.cursor-cloud-env/<repo>.env (mode 0600) plus a tiny source.sh helper.
#
# Install disk state persists across agent starts, but exported shell vars do
# NOT — so this MUST run on every boot, not just install.  Never print secret
# VALUES; only NAMES.  Missing credentials exit 0 (do not fail the agent).

set -euo pipefail

REPO_NAME="congress-trading-shared"
ENV_DIR="${HOME}/.cursor-cloud-env"
ENV_FILE="${ENV_DIR}/${REPO_NAME}.env"
SOURCE_FILE="${ENV_DIR}/${REPO_NAME}.source.sh"

# ---- Locate repo root and load non-secret coordinates ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

if [ -f .cursor/infisical.env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.cursor/infisical.env; set +a
  echo "==> Loaded .cursor/infisical.env  (PROJECT_ID=${INFISICAL_PROJECT_ID}, ENV=${INFISICAL_ENV}, DOMAIN=${INFISICAL_DOMAIN})"
else
  echo "==> .cursor/infisical.env missing; cannot fetch Infisical secrets."
  echo "    Add INFISICAL_PROJECT_ID + INFISICAL_ENV + INFISICAL_DOMAIN to .cursor/infisical.env and retry."
  exit 0
fi

# ---- Prod-only guard (owner 2026-10-10: dev and staging environments retired) ----
# prod is the only Infisical environment.  Refuse to fetch from any other value
# so a stale .cursor/infisical.env cannot read a retired (or empty) environment.
# Exit 0 like the other short-circuits so the agent still comes up.
if [ "${INFISICAL_ENV:-}" != "prod" ]; then
  echo "==> ERROR: INFISICAL_ENV is '${INFISICAL_ENV:-}', expected 'prod'.  Dev and staging are retired; refusing to fetch Infisical secrets." >&2
  echo "    Set INFISICAL_ENV=prod in .cursor/infisical.env and retry." >&2
  exit 0
fi

# ---- Missing-credentials short-circuit ----
# If the Cursor dashboard has not been wired with the fleet machine identity,
# print the missing secret NAMES and exit 0 so the agent still comes up.
if [ -z "${INFISICAL_CLIENT_ID:-}" ] || [ -z "${INFISICAL_CLIENT_SECRET:-}" ]; then
  echo "==> INFISICAL_CLIENT_ID and/or INFISICAL_CLIENT_SECRET not set in the Cursor dashboard."
  echo "    Add these dashboard secrets to enable Infisical fetch:"
  echo "      - INFISICAL_CLIENT_ID"
  echo "      - INFISICAL_CLIENT_SECRET"
  echo "    (Using the fleet-wide automation machine identity — do NOT mint a new one.)"
  echo "    Continuing without secrets; unit/typecheck will still work, integration tests that need API keys will not."
  exit 0
fi

# ---- Pick a fetch strategy: prefer Infisical CLI, fall back to curl+python3 ----
mkdir -p "${ENV_DIR}"
chmod 0700 "${ENV_DIR}"

USE_CLI=0
if command -v infisical >/dev/null 2>&1; then
  USE_CLI=1
  echo "==> Using Infisical CLI for secret export"
else
  if ! command -v python3 >/dev/null 2>&1; then
    echo "==> python3 missing; cannot fall back from missing Infisical CLI."
    echo "    Install python3 OR install the Infisical CLI: curl -1sLf 'https://dl.cloudsmith.io/public/infisical/infisical-cli/setup.deb.sh' | bash && apt-get install -y infisical"
    exit 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "==> curl missing; cannot fetch Infisical secrets."
    exit 0
  fi
  echo "==> Using curl + python3 fallback (Infisical CLI not installed)"
fi

# ---- Fetch + write env (0600) ----
TMP_ENV="$(mktemp -t cursor-cloud-env.XXXXXX)"
trap 'rm -f "${TMP_ENV}"' EXIT

if [ "${USE_CLI}" -eq 1 ]; then
  # Infisical CLI universal-auth login is interactive by default; in a non-TTY
  # cloud agent it can use --client-id/--client-secret flags.  We pipe through
  # `env -i` to prevent leaking the secret into the parent shell environment.
  if ! env -i PATH="${PATH}" \
      INFISICAL_CLIENT_ID="${INFISICAL_CLIENT_ID}" \
      INFISICAL_CLIENT_SECRET="${INFISICAL_CLIENT_SECRET}" \
      INFISICAL_PROJECT_ID="${INFISICAL_PROJECT_ID}" \
      INFISICAL_ENV="${INFISICAL_ENV}" \
      INFISICAL_DOMAIN="${INFISICAL_DOMAIN}" \
      HOME="${HOME}" \
      infisical export \
        --projectId "${INFISICAL_PROJECT_ID}" \
        --env "${INFISICAL_ENV}" \
        --domain "${INFISICAL_DOMAIN}" \
        --plain > "${TMP_ENV}" 2>/dev/null; then
    echo "==> Infisical CLI export failed; check that INFISICAL_CLIENT_ID/SECRET are valid for project ${INFISICAL_PROJECT_ID}."
    rm -f "${TMP_ENV}"
    exit 0
  fi
else
  # curl + python3 fallback: authenticate via /api/v1/auth/universal-auth, then
  # GET /api/v3/secrets/raw/<PROJECT_ID>?environment=<ENV>.  Secrets are never
  # echoed by either curl (-s) or the python json parser; we only write them to
  # the 0600 env file via shell redirection from python's stdout.
  FETCH_SCRIPT="$(mktemp -t cursor-cloud-fetch.XXXXXX.py)"
  cat > "${FETCH_SCRIPT}" <<'PYEOF'
import json, os, sys, urllib.request, urllib.parse
domain = os.environ["INFISICAL_DOMAIN"].rstrip("/")
project_id = os.environ["INFISICAL_PROJECT_ID"]
env_slug = os.environ["INFISICAL_ENV"]
auth_payload = json.dumps({
    "clientId": os.environ["INFISICAL_CLIENT_ID"],
    "clientSecret": os.environ["INFISICAL_CLIENT_SECRET"],
}).encode("utf-8")
req = urllib.request.Request(
    f"{domain}/api/v1/auth/universal-auth/login",
    data=auth_payload,
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=15) as resp:
    access_token = json.loads(resp.read().decode("utf-8"))["accessToken"]
qs = urllib.parse.urlencode({"environment": env_slug, "workspaceId": project_id})
req = urllib.request.Request(
    f"{domain}/api/v3/secrets/raw/{project_id}?{qs}",
    headers={"Authorization": f"Bearer {access_token}"},
    method="GET",
)
with urllib.request.urlopen(req, timeout=15) as resp:
    body = json.loads(resp.read().decode("utf-8"))
for entry in body.get("secrets", []):
    key = entry.get("secretKey")
    value = entry.get("secretValue", "")
    if not key:
        continue
    # shell-safe write; values containing newlines/quotes are escaped via python.
    escaped = value.replace("\\", "\\\\").replace("'", "'\\''")
    sys.stdout.write(f"{key}='{escaped}'\n")
PYEOF

  if ! env -i PATH="${PATH}" \
      HOME="${HOME}" \
      INFISICAL_CLIENT_ID="${INFISICAL_CLIENT_ID}" \
      INFISICAL_CLIENT_SECRET="${INFISICAL_CLIENT_SECRET}" \
      INFISICAL_PROJECT_ID="${INFISICAL_PROJECT_ID}" \
      INFISICAL_ENV="${INFISICAL_ENV}" \
      INFISICAL_DOMAIN="${INFISICAL_DOMAIN}" \
      python3 "${FETCH_SCRIPT}" > "${TMP_ENV}" 2>/dev/null; then
    echo "==> Infisical fetch (curl+python3) failed; check credentials and project ${INFISICAL_PROJECT_ID} / env ${INFISICAL_ENV}."
    rm -f "${TMP_ENV}" "${FETCH_SCRIPT}"
    exit 0
  fi
  rm -f "${FETCH_SCRIPT}"
fi

# Promote the tmp file to the real env file with mode 0600.
install -m 0600 "${TMP_ENV}" "${ENV_FILE}"
rm -f "${TMP_ENV}"

# ---- Write a tiny source helper (no values) ----
cat > "${SOURCE_FILE}" <<'EOF2'
# Auto-generated by scripts/cursor-cloud-start.sh — sources the env file
# without printing any values.
set -a
# shellcheck disable=SC1090
. "${CURSOR_CLOUD_ENV_FILE:-${HOME}/.cursor-cloud-env/congress-trading-shared.env}"
set +a
EOF2
chmod 0600 "${SOURCE_FILE}"

KEY_COUNT="$(grep -cE '^[A-Z0-9_]+=' "${ENV_FILE}" 2>/dev/null || echo 0)"
echo "==> Wrote ${ENV_FILE} (mode 0600) — ${KEY_COUNT} secret keys (names only, no values shown)"
echo "==> Wrote ${SOURCE_FILE} (mode 0600) — `set -a; source the env file; set +a` helper"
echo "==> Start complete."