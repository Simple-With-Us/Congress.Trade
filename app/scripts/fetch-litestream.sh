#!/usr/bin/env bash
# Build-time download of a pinned Litestream release into ./bin/litestream.
# Adapted from Usage-Monitor's scripts/fetch-litestream.sh (same pinned
# version, same checksums — verified against the shared v0.5.13 release).
#
# Litestream (https://litestream.io) continuously replicates the SQLite file
# at /data/congress-trade/db.sqlite to Backblaze B2. This script only fetches
# the binary; whether replication actually runs is controlled entirely by the
# LITESTREAM_S3_* env vars at container start — see
# scripts/start-with-litestream.sh. Safe to run even when replication is
# never enabled; it just leaves an unused binary in ./bin.
#
# Pinned version: v0.5.13. NOT v0.5.14 — Socratic.Trade hit a socket-churn
# regression in 0.5.14 on this same Coolify/Hetzner environment (~20
# sockets/s to the S3-compatible endpoint, thousands of leaked fds, kernel
# tcp_mem exhaustion that wedged unrelated deploys on the box). See
# Socratic.Trade docs/rollouts/2026-07-10-deploy-blocker-tcpmem-litestream.md.
# All 0.5.x releases share the LTX replica format, so staying within 0.5.x is
# replica-compatible.
#
# A download or checksum failure leaves the binary absent and exits 0, so that
# `bash scripts/fetch-litestream.sh` alone never decides deploy policy. The
# Dockerfile is what enforces it: `RUN bash scripts/fetch-litestream.sh &&
# test -x bin/litestream` fails the BUILD when the binary did not install.
# That matters because the startup wrapper treats a missing binary as
# "run the app without replication" — a live site with no backup, announced
# only by one WARNING line. Catching it at build time keeps the previous
# container serving instead.
set -euo pipefail

LITESTREAM_VERSION="0.5.13"
LITESTREAM_OS="linux"
HOST_ARCH="${LITESTREAM_ARCH_OVERRIDE:-$(uname -m)}"
case "${HOST_ARCH}" in
  x86_64|amd64)
    LITESTREAM_ARCH="x86_64"
    LITESTREAM_SHA256="fc3420fea7d2f92d4d604aceeb0d7c63dc2c91f6ee5c1547cc05e25629e70f9f"
    ;;
  aarch64|arm64)
    LITESTREAM_ARCH="arm64"
    LITESTREAM_SHA256="ef47997794ce8dd87a64b44622d556b3a693b135fd72e0cf47cc42ac2e979051"
    ;;
  *)
    echo "[fetch-litestream] WARNING: unsupported Linux architecture: ${HOST_ARCH}" >&2
    echo "[fetch-litestream] Continuing without installing Litestream; configured/required" >&2
    echo "[fetch-litestream] replication will fail closed during startup." >&2
    exit 0
    ;;
esac
LITESTREAM_ASSET="litestream-${LITESTREAM_VERSION}-${LITESTREAM_OS}-${LITESTREAM_ARCH}.tar.gz"
LITESTREAM_URL="https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/${LITESTREAM_ASSET}"
# From that release's checksums.txt (sha256 of the .tar.gz asset itself).
# Re-verify at https://github.com/benbjohnson/litestream/releases/tag/v0.5.13

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BIN_DIR="${REPO_ROOT}/bin"
BIN_PATH="${BIN_DIR}/litestream"

log() {
  echo "[fetch-litestream] $*"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "ERROR: no sha256sum or shasum available to verify the download" >&2
    exit 1
  fi
}

# Idempotent skip: only trust an existing binary if it reports the exact
# version we pin.
if [[ -x "${BIN_PATH}" ]]; then
  EXISTING_VERSION="$("${BIN_PATH}" version 2>&1 || true)"
  if [[ "${EXISTING_VERSION}" == *"${LITESTREAM_VERSION}"* ]]; then
    log "bin/litestream already present at v${LITESTREAM_VERSION} — skipping download."
    exit 0
  fi
  log "bin/litestream present but not v${LITESTREAM_VERSION} (found: ${EXISTING_VERSION}) — re-fetching."
fi

mkdir -p "${BIN_DIR}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

TARBALL="${TMP_DIR}/${LITESTREAM_ASSET}"

log "Downloading ${LITESTREAM_URL}"
if ! curl -fsSL --retry 3 --retry-connrefused -o "${TARBALL}" "${LITESTREAM_URL}"; then
  echo "[fetch-litestream] WARNING: failed to download ${LITESTREAM_URL}" >&2
  echo "[fetch-litestream] Check network access and that v${LITESTREAM_VERSION} still has a" >&2
  echo "[fetch-litestream] ${LITESTREAM_ASSET} asset at https://github.com/benbjohnson/litestream/releases" >&2
  echo "[fetch-litestream] Continuing without installing it. Startup remains available only" >&2
  echo "[fetch-litestream] when replication is unconfigured; configured/required backup fails closed." >&2
  exit 0
fi

ACTUAL_SHA256="$(sha256_of "${TARBALL}")"
if [[ "${ACTUAL_SHA256}" != "${LITESTREAM_SHA256}" ]]; then
  echo "[fetch-litestream] WARNING: sha256 mismatch for ${LITESTREAM_ASSET}" >&2
  echo "[fetch-litestream]   expected: ${LITESTREAM_SHA256}" >&2
  echo "[fetch-litestream]   actual:   ${ACTUAL_SHA256}" >&2
  echo "[fetch-litestream] Refusing to install a binary that doesn't match the pinned checksum." >&2
  echo "[fetch-litestream] Continuing without installing it; configured/required backup will" >&2
  echo "[fetch-litestream] fail closed at startup rather than run without replication." >&2
  exit 0
fi
log "sha256 verified: ${ACTUAL_SHA256}"

tar -xzf "${TARBALL}" -C "${TMP_DIR}" litestream
mv "${TMP_DIR}/litestream" "${BIN_PATH}"
chmod +x "${BIN_PATH}"

log "Installed bin/litestream $("${BIN_PATH}" version 2>&1 || echo "v${LITESTREAM_VERSION}")"
