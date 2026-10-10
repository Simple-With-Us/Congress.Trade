#!/usr/bin/env bash
# Container entrypoint for congress-app (Coolify). Wraps the same `deno run`
# invocation that used to be the Dockerfile's CMD directly, adding continuous
# Litestream replication of /data/congress-trade/db.sqlite to Backblaze B2
# when B2 credentials are available — rebuilt 2026-08-12 after the
# Oracle->Hetzner migration dropped the old host-level systemd unit
# (`litestream-congress`, `/etc/litestream/congress.yml` on the decommissioned
# Oracle box). Pattern matches the sibling apps' in-container Litestream:
# Socratic.Trade scripts/coolify-prod-start.sh, Usage-Monitor
# scripts/start-with-litestream.sh.
#
# Secrets: the 5 LITESTREAM_S3_* values (bucket/endpoint/region/access-key-id/
# secret-access-key) live in the same Infisical project the Deno app already
# reads from in-process (congress-trade prod — see src/secrets/infisical.ts), using
# the SAME bootstrap identity (INFISICAL_APP_CLIENT_ID/SECRET) already present
# as a Coolify env var for this service. Litestream is an external binary, not
# part of the Deno process, so it needs real OS env vars before it starts;
# this script fetches ONLY those 5 keys via the infisical CLI and exports them
# — it does not touch, wrap, or change the app's own in-process secret
# resolution (src/secrets/infisical.ts keeps working exactly as before).
#
# When Infisical bootstrap credentials are absent (local dev, preview
# environments without the bootstrap identity) this falls straight through to
# the unmodified `deno run ...` — zero behavior change for those environments.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LITESTREAM_BIN="${LITESTREAM_BIN_PATH:-${REPO_ROOT}/bin/litestream}"
LITESTREAM_CONFIG="${REPO_ROOT}/litestream.yml"
DB_PATH="/data/congress-trade/db.sqlite"

# Same flags the Dockerfile CMD used to invoke directly.
DENO_CMD='deno run --allow-net --allow-env --allow-read --allow-write --allow-sys --allow-ffi --unstable-kv --unstable-cron src/deno/main.ts'

log() {
  echo "[start-with-litestream] $*"
}

CT_PROJECT_ID="${INFISICAL_APP_PROJECT_ID:-}"
# prod is the only Infisical environment (owner 2026-10-10:  dev and staging are
# retired).  Replication credentials are always read from prod, whatever
# INFISICAL_ENV says;  a stray value is logged loudly (the app itself refuses it).
CT_ENV="prod"
case "${INFISICAL_ENV:-prod}" in
  prod|production) ;;
  *) log "ERROR-LEVEL WARNING: INFISICAL_ENV is not prod (dev and staging are retired);  reading the prod environment for Litestream anyway." ;;
esac

litestream_enabled=false

# Accept the same two spellings of the bootstrap identity that the app itself
# accepts (src/secrets/infisical.ts: `INFISICAL_APP_CLIENT_ID ||
# INFISICAL_CLIENT_ID`). Coolify historically set the un-prefixed pair and
# still has both on this service. If this script recognised only the _APP_
# spelling, dropping those duplicates would leave the app resolving secrets
# perfectly while replication silently switched itself off — nothing would
# look broken until a restore was needed.
BOOTSTRAP_CLIENT_ID="${INFISICAL_APP_CLIENT_ID:-${INFISICAL_CLIENT_ID:-}}"
BOOTSTRAP_CLIENT_SECRET="${INFISICAL_CLIENT_SECRET:-${INFISICAL_APP_CLIENT_SECRET:-}}"

if [[ -z "${BOOTSTRAP_CLIENT_ID}" || -z "${BOOTSTRAP_CLIENT_SECRET}" ]]; then
  log "no Infisical bootstrap identity (INFISICAL_APP_CLIENT_ID/SECRET or INFISICAL_CLIENT_ID/SECRET) — running without Litestream (expected for local/preview)."
elif ! command -v infisical >/dev/null 2>&1; then
  log "ERROR-LEVEL WARNING: infisical CLI missing from the image — THE DATABASE IS NOT BEING BACKED UP. Starting the app anyway (uptime over backup); rebuild the image to restore replication."
elif [[ ! -x "${LITESTREAM_BIN}" ]]; then
  log "ERROR-LEVEL WARNING: litestream binary missing at ${LITESTREAM_BIN} — THE DATABASE IS NOT BEING BACKED UP. Starting the app anyway (uptime over backup); the Dockerfile's 'test -x bin/litestream' should have caught this at build time."
else
  # Mint a short-lived token from the app's existing bootstrap identity. Do
  # not log the token or any secret value at any point below.
  TOKEN="$(
    INFISICAL_UNIVERSAL_AUTH_CLIENT_ID="${BOOTSTRAP_CLIENT_ID}" \
    INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET="${BOOTSTRAP_CLIENT_SECRET}" \
    infisical login --method=universal-auth --silent --plain 2>/dev/null || true
  )"
  if [[ -z "${TOKEN}" ]]; then
    log "WARNING: Infisical universal-auth login failed — running without Litestream."
  else
    # Fetch only the 5 keys Litestream needs. Capturing via command
    # substitution keeps the values out of any log stream; `infisical run`
    # injects the full project secret set into the `sh -c` child's env, but
    # only these 5 named values are ever printed (to this captured variable,
    # never to stdout/stderr of the container).
    # shellcheck disable=SC2016  # single quotes are required: these expand in
    # the `sh -c` child, whose env `infisical run` populates — not here.
    mapfile -t _ls_secrets < <(
      INFISICAL_TOKEN="${TOKEN}" infisical run \
        --env "${CT_ENV}" --path / --projectId "${CT_PROJECT_ID}" --silent -- \
        sh -c 'printf "%s\n" "$LITESTREAM_S3_BUCKET" "$LITESTREAM_S3_ENDPOINT" "$LITESTREAM_S3_REGION" "$LITESTREAM_S3_ACCESS_KEY_ID" "$LITESTREAM_S3_SECRET_ACCESS_KEY"' \
        2>/dev/null || true
    )
    LITESTREAM_S3_BUCKET="${_ls_secrets[0]:-}"
    LITESTREAM_S3_ENDPOINT="${_ls_secrets[1]:-}"
    LITESTREAM_S3_REGION="${_ls_secrets[2]:-}"
    LITESTREAM_S3_ACCESS_KEY_ID="${_ls_secrets[3]:-}"
    LITESTREAM_S3_SECRET_ACCESS_KEY="${_ls_secrets[4]:-}"

    configured_keys=0
    for v in "${LITESTREAM_S3_BUCKET}" "${LITESTREAM_S3_ENDPOINT}" "${LITESTREAM_S3_REGION}" \
             "${LITESTREAM_S3_ACCESS_KEY_ID}" "${LITESTREAM_S3_SECRET_ACCESS_KEY}"; do
      [[ -n "${v}" ]] && configured_keys=$((configured_keys + 1))
    done

    if [[ "${configured_keys}" -eq 5 ]]; then
      export LITESTREAM_S3_BUCKET LITESTREAM_S3_ENDPOINT LITESTREAM_S3_REGION \
        LITESTREAM_S3_ACCESS_KEY_ID LITESTREAM_S3_SECRET_ACCESS_KEY
      litestream_enabled=true
      log "Litestream B2 replica credentials resolved (bucket set, endpoint set, region set) — replication ENABLED."
    elif [[ "${configured_keys}" -eq 0 ]]; then
      log "LITESTREAM_S3_* not present in Infisical (${CT_ENV}) — running without Litestream."
    else
      log "ERROR: Litestream is partially configured (${configured_keys}/5 LITESTREAM_S3_* values resolved)."
      log "Set all 5 (BUCKET/ENDPOINT/REGION/ACCESS_KEY_ID/SECRET_ACCESS_KEY) together in Infisical, or none."
      exit 1
    fi
  fi
fi

if [[ "${litestream_enabled}" == "true" ]]; then
  if [[ ! -f "${DB_PATH}" ]]; then
    log "no local DB at ${DB_PATH} — attempting restore from B2 replica (no-op if none exists yet)."
    "${LITESTREAM_BIN}" restore -config "${LITESTREAM_CONFIG}" -if-db-not-exists -if-replica-exists "${DB_PATH}" || \
      log "WARNING: litestream restore attempt failed; continuing to start the app against the local volume."
  else
    log "local DB already present at ${DB_PATH} — skipping restore."
  fi
  log "starting litestream replicate (B2) as PID 1, wrapping: ${DENO_CMD}"
  exec "${LITESTREAM_BIN}" replicate -config "${LITESTREAM_CONFIG}" -exec "${DENO_CMD}"
fi

log "starting app without Litestream: ${DENO_CMD}"
exec ${DENO_CMD}
