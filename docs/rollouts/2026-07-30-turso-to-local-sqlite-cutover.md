# 2026-07-30 — Turso → local SQLite cutover (Oracle/Coolify)

> **Current shape (2026-08):** Turso stays retired.  The SQLite file now lives
> on Hetzner (`/data/congress-trade/db.sqlite`) with Litestream.  Oracle is
> decommissioned.  See `app/DEPLOY.md`.

## Summary

Per owner directive ("we aren't using Turso anymore"), the production database
was cut over from Turso (`libsql://congress-trade-...turso.io`) to a local
SQLite file at `/data/congress-trade/db.sqlite` on the Oracle host block
volume — the target the Coolify compose stack (`sqlite-web` service browses
that file) was already shaped for.

A staged copy (`db.sqlite`, synced from Turso at 05:07Z, ~20h stale / 1,025
transactions behind) already existed on the host. To avoid losing the gap, a
fresh full sync was performed instead of using the stale file.

## Steps performed (host `<ORACLE_IP_RETIRED>`)

1. Stopped the app container (maintenance window ~15 min, single writer).
2. Moved the stale copy aside to `db.sqlite.stale-20260730`.
3. Ran a one-shot Deno sync (schema + all rows, rowid-keyset batched, in a
   throwaway container from the app image): 57 tables, ~2.6M rows
   (`price_eod` 2,272,280; `transactions` 74,575). One table-batch hit a
   spurious duplicate-PK error from `@libsql/client` local `batch()`; a
   count-compare identified the 5 tables processed after the crash
   (`autopilot_budget_reservations`, `price_eod_stats`,
   `trade_latency_candidates`, `trade_provider_observations`,
   `deno_runtime_kv`) and a finish pass copied them plus rebuilt
   `sqlite_sequence`. Final per-table counts verified equal to Turso.
4. Set `TURSO_DATABASE_URL=file:/data/congress-trade/db.sqlite` as a Coolify
   runtime env on application `congress-trade` (runtime env overrides the
   image-baked `.prod.vars` per `buildEnvironmentValues` order in
   `app/src/deno/main.ts`), via the write-capable `COOLIFY_AGENTS` Infisical
   token (the `COOLIFY_API_TOKEN` token is read-only — "Missing required
   permissions: write").
5. Triggered Coolify deploy (`GET /api/v1/deploy?uuid=congress-trade`),
   deployment `fa62yc2lcm2rkivyxsi9ft0p`. New container
   `congress-app-congress-trade-071112480217` booted onto the local file.

## Verification

- `/api/health` → `{"ok":true,"db":true,"schema":true}`.
- `/api/transactions?limit=1` total 73,922 (matches the pre-cutover filtered
  total of 73,927 minus retention sweeps running during the window).
- `bioguideId` served 50/50 on latest rows; `?stockAct=severely_late` total
  1,662 (filter semantics intact).
- `db.sqlite-wal` active (journal_mode=WAL) and advancing — cron ticks, the
  retention sweep, and ingestion now write the local file. Confirmed in
  container logs (`5-year filing retention sweep deleted old filings: 3`).
- sqlite-web continues to browse the same file it was already pointed at.

## Notes and follow-ups

- Turso is now read-only legacy. `db.sqlite.stale-20260730` and the Turso
  database itself remain as rollback archives; Turso plan can be cancelled at
  the owner's convenience.
- **R2 writes are failing (pre-existing, unrelated to the DB cutover):**
  container logs show `bulk snapshot failed: Unauthorized` and
  `Failed to delete raw file raw/H-... from R2 Unauthorized`. Verified with a
  signed S3 call using the exact runtime config: endpoint and bucket
  (`congress-trade-bucket`, which exists on the `admin@congress.trade`
  account, created 2026-07-24) are correct, so the 401 means the R2 API token
  itself was **deleted on that Cloudflare account** (R2 returns 401
  "Unauthorized" for unknown access keys). Remediation (owner, dashboard
  only): R2 → Manage R2 API Tokens → create Account/bucket-scoped token with
  Object Read & Write on `congress-trade-bucket`, then update Infisical
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — the app picks the new values
  up automatically within the 600s secrets-cache TTL now that
  `INFISICAL_APP_PROJECT_ID` is set (see correction in
  `2026-07-30-caddy-stable-alias-prod-502.md`). NOTE: the
  `CLOUDFLARE_CT_API_TOKEN` value stored in Infisical is itself rejected by
  the Cloudflare API (code 1000 "Invalid API Token", and at 53 chars it is
  not shaped like a standard 40-char CF token) — worth re-checking what it
  was meant to be.
- The 45s cron-deadline starvation persists on local SQLite (root cause is
  network lanes: FMP/peer/bulk-snapshot attempts), reinforcing the flagged
  follow-up to split daily lanes onto staggered schedules.
- Post-cutover, `app/scripts/ship.sh` / migrate paths still apply: schema
  changes continue to go through `POST /api/admin/migrate` against the local
  file (admin token = the Infisical prod `ADMIN_TOKEN`, live since the
  `INFISICAL_APP_PROJECT_ID` fix — see correction in
  `2026-07-30-caddy-stable-alias-prod-502.md`).
