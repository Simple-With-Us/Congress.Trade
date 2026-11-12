# 2026-08-17 — Cursor Cloud dev environment (Deno backend)

## Summary

Added a self-contained Cursor Cloud Agent environment for the Congress.Trade
backend. Cloud Agents previously had no committed `.cursor/environment.json`, so
each run started from a bare VM with no Deno toolchain and no reliable way to
boot the app. The runnable backend moved to the **Deno** runtime
(`app/src/deno/main.ts`) while the older docs still described a `wrangler dev`
flow, so a fresh agent could not run or demonstrate the app end to end.

This change makes a fresh Cloud Agent able to install the toolchain, boot the
server against an **isolated local database**, and serve the dashboard with
seeded data — with no production secrets and no risk of touching production.

## What changed

- `.cursor/environment.json` — declares the environment: `install` script, a
  `start` command that runs the dev server on boot, and exposes port `8787`.
- `scripts/cursor-cloud-setup.sh` (install phase) — installs Deno pinned to the
  CI version (`2.9.3`, matching `.github/workflows/ci.yml`), runs
  `npm ci --include=dev` in `app/`, and warms the Deno module cache. Idempotent.
- `scripts/cursor-cloud-serve.sh` (start command) — starts the Deno server
  wired for keyless local dev and self-bootstraps schema + seed on boot.
- `scripts/seed-local-db.ts` — loads `app/scripts/seed-preview-fixtures.sql` via
  the app's own `@libsql/client`; idempotent and refuses any non-`file:` URL.
- `AGENTS.md` — documents the Cursor Cloud environment under the Cursor section.

## Key decisions / gotchas

- **Isolated DB (safety).** The Cloud Agent VM injects a production
  `TURSO_DATABASE_URL` (`libsql://…`) and `TURSO_AUTH_TOKEN` as secrets. The
  serve script **unconditionally** overrides `TURSO_DATABASE_URL` to a local
  `file:` SQLite path (not `:-` defaulted) and the seeder refuses any non-`file:`
  URL, so the dev server can never read from or write to production.
- **Admin open in dev.** `.prod.vars` ships `ADMIN_EMAILS`, which marks the admin
  API as "configured" and disables the `ADMIN_OPEN_IN_DEV` escape hatch. The
  serve script generates a per-boot random `ADMIN_TOKEN` (never committed) and
  uses it as the bearer for the boot-time `POST /api/admin/migrate`.
- **Fresh-DB migrate quirk (pre-existing).** On a pristine DB
  `POST /api/admin/migrate` returns HTTP 500 on one historical data-cleanup
  `UPDATE` that references `filings.filing_status` — a column not created by any
  committed migration or by the migrate route (only `transactions.filing_status`
  exists, via migration `0011`). Every readiness-required table/column is still
  created, so `GET /api/health` reports `schema:true`. Readiness is the source of
  truth; the bootstrap treats that 500 as expected and non-fatal. This is
  latent schema drift in the production migrate list, not introduced here, and
  was left for a separate owner-reviewed schema fix.
- **Readiness cache.** `GET /api/health` caches its readiness verdict for 60s.
  The bootstrap probes the static `/health` liveness route (no DB, uncached) to
  detect the server is up, then hits `/api/health` only after migrate so the
  first readiness verdict is fresh (`schema:true`).

## Verification

On this VM (and confirmed via a fresh build; see PR):

- `cd app && deno check src/deno/main.ts` — clean (Deno 2.9.3).
- `cd app && npm test` — 3076 tests across 251 files pass.
- `bash scripts/cursor-cloud-setup.sh` — completes; idempotent on re-run.
- `bash scripts/cursor-cloud-serve.sh` — boots on `:8787`, applies schema, seeds
  4 preview transactions; `GET /api/health` → `{ok:true, db:true, schema:true}`.
- End to end: `GET /api/transactions`, `/api/analytics/summary`,
  `/api/analytics/ticker-leaderboard`, and the rendered dashboard/Trends UI all
  return the seeded data.
- Restart against an existing DB re-runs cleanly (seed skips: "already has 4
  rows").

## Follow-ups

- Schema drift: add `ALTER TABLE filings ADD COLUMN filing_status TEXT` to
  `app/migrations/` and mirror it in `POST /api/admin/migrate`
  (`app/src/admin/routes.ts`) so a fresh DB migrates without the 500. Deferred
  to a dedicated owner-reviewed schema change per the migration rules.
- The legacy `scripts/cloud-setup.sh` (npm + `wrangler d1` local migrations) is
  still referenced elsewhere; it targets the older wrangler path and does not
  install Deno. `.cursor/environment.json` is now the source of truth for Cursor
  Cloud.
