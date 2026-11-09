#!/usr/bin/env bash
# Canonical setup for a fresh, isolated checkout of Congress.Trade (Claude Code
# cloud/remote sandbox, GitHub Codespaces, devcontainer, or any throwaway clone).
# Idempotent — safe to re-run.
#
# IMPORTANT (Claude Code Cloud): Setup script cwd is the PARENT of the clone
# (`/home/user`), not the repo root. A bare `bash scripts/cloud-setup.sh` fails
# with exit 127. Use the fleet locator from
# ai-fleet-coordinator/docs/CLAUDE-CODE-CLOUD-ENVIRONMENTS.md, or:
#   cd Congress.Trade && bash scripts/cloud-setup.sh
#
# The runnable app lives in app/ (Coolify Deno process), NOT the repo root — so a
# plain `npm ci` from the root fails.  This script cd's into app/ for you.
#
# Local runtime configuration comes from Infisical.  This setup maps the
# app/shared machine-identity bootstrap credentials plus a narrow documented set
# of env-only/local selectors into app/.dev.vars.  Provider and app secrets remain
# in Infisical and are resolved by the app at runtime.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# The buildable app lives in app/, not the repo root.
cd "$SCRIPT_DIR/../app"

echo "==> Node: $(node --version 2>/dev/null || echo 'not found')  npm: $(npm --version 2>/dev/null || echo 'not found')"

# Read the Infisical machine identities from the explicit environment (cloud and
# CI use only this) or, on a Mac with the CLI installed, from `fleet-secrets get`.
# Validate complete identity pairs, map canonical CT names to the runtime names,
# preserve non-empty managed app/.dev.vars values, and retain only the documented
# early-init/local selectors from the explicit environment. This runs before the
# expensive install so malformed bootstrap state fails closed immediately.
unset CT_LOCAL_BOOTSTRAP_TEST_MODE
unset CT_LOCAL_BOOTSTRAP_TEST_APP_DIR
unset CT_LOCAL_BOOTSTRAP_TEST_DEV_VARS_FILE
unset CT_LOCAL_BOOTSTRAP_TEST_FLEET_SECRETS_BIN
# Cloud VMs have no fleet-secrets CLI. Missing identities are
# expected; do not fail the whole session setup for a keyless checkout.
node "$SCRIPT_DIR/merge-local-dev-vars.mjs" || echo "==> Infisical local bootstrap skipped (ok in keyless cloud)"

# @jaywedgeworth22/congress-trading-shared is a public repo consumed as a
# tokenless git dependency. The vendored local copy at app/vendor/ is the
# canonical resolution — no npm registry, no NODE_AUTH_TOKEN, no .npmrc entry.
# Deterministic install from the committed lockfile (app/package-lock.json).
# --include=dev forces devDependencies (typescript, vitest, leftover local
# wrangler helper) even when the cloud env sets NODE_ENV=production — npm would
# otherwise omit them, breaking the typecheck / test commands this bootstrap
# is meant to prepare.
echo "==> Installing dependencies (npm ci --include=dev)"
npm ci --include=dev

# Local leftover helper: npm run migrate still shells wrangler d1 --local.
# That is not production.  Production schema is POST /api/admin/migrate
# against the Coolify host SQLite file.  CI=true keeps wrangler
# non-interactive; a migrate hiccup must not fail the whole setup.
echo "==> Applying local schema helper (npm run migrate; leftover wrangler --local)"
CI=true npm run migrate || echo "==> migrate skipped — run 'cd app && npm run migrate' manually if needed"

echo "==> Setup complete."
echo "    Dev:    cd app && npm run dev        (local Deno on http://localhost:8787)"
echo "    Verify: cd app && npm run typecheck && npm test"
echo "    Prod:   Coolify congress-app at https://congress.trade"
