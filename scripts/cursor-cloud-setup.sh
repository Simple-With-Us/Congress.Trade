#!/usr/bin/env bash
# Cursor Cloud install phase for Congress.Trade.
#
# The runnable backend lives in app/ and runs on the *Deno* runtime (not
# wrangler): src/deno/main.ts serves the same Hono app production runs on
# Coolify. This script prepares everything a fresh Cloud Agent VM needs so the
# server can boot and the vitest/typecheck gates can run:
#   1. Deno CLI pinned to the CI version (deno check is the typecheck gate).
#   2. app/ npm dependencies (vitest, eslint, and the npm packages Deno imports).
#   3. A warm Deno module cache for src/deno/main.ts.
#
# It is idempotent and non-interactive: safe to re-run and safe to bake into an
# environment build snapshot. Per-boot runtime state (the local SQLite dev DB)
# is created by scripts/cursor-cloud-serve.sh, not here.
set -euo pipefail

# Keep this in lockstep with .github/workflows/ci.yml ("npm install --global
# deno@<VERSION>"). deno check resolves types differently across releases, so a
# drift here can make local typecheck disagree with CI.
DENO_VERSION="2.9.3"
DENO_DIR="${DENO_INSTALL:-$HOME/.deno}"
export DENO_INSTALL="$DENO_DIR"
export PATH="$DENO_DIR/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../app" && pwd)"

echo "==> Node: $(node --version 2>/dev/null || echo 'not found')  npm: $(npm --version 2>/dev/null || echo 'not found')"

# 1. Deno CLI (pinned). Reinstall only when missing or on the wrong version so
# re-runs are cheap.
current_deno=""
if command -v deno >/dev/null 2>&1; then
  current_deno="$(deno --version 2>/dev/null | head -n1 | awk '{print $2}')"
fi
if [ "$current_deno" != "$DENO_VERSION" ]; then
  echo "==> Installing Deno v$DENO_VERSION (found: ${current_deno:-none})"
  curl -fsSL https://deno.land/install.sh | sh -s "v$DENO_VERSION" >/dev/null
else
  echo "==> Deno v$DENO_VERSION already installed"
fi
deno --version

# 2. app/ npm dependencies. --include=dev forces devDependencies (vitest,
# eslint, typescript) even if the environment sets NODE_ENV=production, and the
# vendored Simple-With-Us/congress-trading-shared (@jaywedgeworth22/congress-trading-shared import map) resolves tokenlessly from
# app/vendor via the deno.json import map.
echo "==> Installing app dependencies (npm ci --include=dev)"
( cd "$APP_DIR" && npm ci --include=dev )

# 3. Warm the Deno module cache so the first server boot / typecheck is fast.
echo "==> Caching Deno modules for src/deno/main.ts"
( cd "$APP_DIR" && deno cache src/deno/main.ts )

echo "==> Setup complete."
echo "    Serve:    bash scripts/cursor-cloud-serve.sh   (Deno server on http://localhost:8787)"
echo "    Verify:   cd app && deno check src/deno/main.ts && npm test"
