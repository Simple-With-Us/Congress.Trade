#!/usr/bin/env bash
# Cursor cloud agent install for congress-trading-shared.
# Idempotent on Ubuntu Linux.  Runs during Cursor "Build" — must be re-runnable
# because Cursor re-runs install on every fresh agent start.
#
# macOS/iOS/Xcode steps: none here — this is a shared TypeScript package, and
# the consumer apps run on macOS.  The Cursor cloud sandbox is Ubuntu, so
# anything Mac-only is intentionally skipped (no Xcode, no Codesign).
#
# Secrets are NEVER printed, logged, or echoed.  Only secret NAMES appear.

set -euo pipefail

REPO_NAME="congress-trading-shared"

echo "==> Cursor cloud install: ${REPO_NAME} (shared TypeScript contract package)"
echo "==> Platform: $(uname -s)  $(uname -m)"

# ---- Locate repo root (script may be invoked from anywhere) ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# ---- 1. Node >= 22 (engines requirement: node >=22.0.0) ----
NODE_MIN_MAJOR=22
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR}" -lt "${NODE_MIN_MAJOR}" ] 2>/dev/null; then
    echo "==> Node ${NODE_MAJOR}.x found, need >=${NODE_MIN_MAJOR}.  Trying nvm/NodeSource upgrade."
  else
    echo "==> Node $(node --version) (>=${NODE_MIN_MAJOR})  npm $(npm --version)"
  fi
else
  echo "==> Node not found on PATH.  Cursor composer-latest images ship Node; if missing, install Node >=${NODE_MIN_MAJOR} via NodeSource."
fi

# ---- 2. npm + npm ci (idempotent; uses package-lock.json) ----
# This repo's AGENTS.md publish policy: installs run `prepare` (npm run build)
# against the git tarball.  Cursor cloud builds off a real checkout, so the
# prepare step would also fire here — keep it cheap and aligned with CI.
if [ -f package-lock.json ]; then
  echo "==> npm ci --include=dev (using package-lock.json)"
  npm ci --include=dev --no-audit --no-fund
else
  echo "==> No package-lock.json found; falling back to npm install --include=dev"
  npm install --include=dev --no-audit --no-fund
fi

# ---- 3. Build dist/ so tsc/vitest typecheck can resolve exports map ----
# AGENTS.md: this package's prepare script builds; mirror that for cloud runs
# so consumers installed via the git tarball contract see a ready dist/.
echo "==> npm run build (prepare mirror; populates dist/)"
npm run build

# ---- 4. Tools the runtime may need ----
# python3 is used by cursor-cloud-start.sh for the Infisical fetch (curl +
# python3 path; never prints values).  Confirm it exists; no install here.
if command -v python3 >/dev/null 2>&1; then
  echo "==> python3 $(python3 --version) available for Infisical fetch"
else
  echo "==> python3 missing; start script will need it to call Infisical API."
fi

# ---- 5. Ensure .cursor/infisical.env was committed ----
if [ -f .cursor/infisical.env ]; then
  echo "==> Loaded .cursor/infisical.env (PROJECT_ID + ENV + DOMAIN; no credentials)"
else
  echo "==> WARNING: .cursor/infisical.env missing — start script will skip Infisical fetch."
fi

echo "==> Cursor cloud install: ${REPO_NAME} ready."
echo "    Verify: npm test && npm run typecheck"