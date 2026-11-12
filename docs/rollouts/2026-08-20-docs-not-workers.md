# 2026-08-20 — Current-shape docs are Coolify, not Workers/D1

## Summary

GitHub onboarding docs still described Congress.Trade as a Cloudflare Workers
/ D1 / `wrangler.toml` product.  Production is the Coolify `congress-app`
Deno process on `fleet-hetzner-nbg1`, host SQLite, R2 for filing PDFs, live
site `https://congress.trade`.  This change rewrites current-shape docs and
the GitHub About/homepage.  No product behavior or extract-cap change.

## Files changed

- `README.md`, `app/README.md`, `app/DEPLOY.md`
- `AGENTS.md`, `CLAUDE.md`, `STATUS.md`, `.cursor/rules/congress-trade.mdc`
- `app/docs/preview-deploy.md`, `config-registry.md`, `wave4-auth-billing.md`,
  `fmp-data-sharing.md`, `client-mobile-api.md`, `third-party-usage-telemetry.md`
- `app/package.json` description, `app/scripts/ship.sh` header comments
- `docs/EFFORT-LOG.md`

Dated July rollouts, reviews, and effort-log rows stay historical.

## Verification

- `README.md` lead no longer says Cloudflare Workers / D1.
- `app/DEPLOY.md` sends operators to Coolify + `ship.sh` migrate, not
  `wrangler deploy`.
- GitHub repo About homepage is `https://congress.trade`.

## Follow-ups

- Draft PR #2040 still rewrites some of the same files for the Deno
  Deploy / Turso retirement slice.  Rebase or integrate after this lands.
- Leftover `app/scripts/deploy-preview.sh` Wrangler preview tooling is
  labeled leftover, not deleted.
