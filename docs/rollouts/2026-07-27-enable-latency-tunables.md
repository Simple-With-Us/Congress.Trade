# 2026-07-27 — Enable disclosure-latency tunables (FMP / UW / QQ)

> **Current shape (2026-08):** Turso is retired.  Schema now lives on the
> Coolify SQLite file; tunables still live in Infisical.  The "Infisical +
> Turso" ops section below is the 2026-07 apply-log.

## Summary

Admin config-sources showed latency knobs as `missing` (and the race produced
zero candidates) for three independent reasons:

1. **Infisical gap after wrangler → Deno.** Only
   `DISCLOSURE_LATENCY_WATCH_ENABLED=true` was migrated into Infisical.
   `DISCLOSURE_LATENCY_PROVIDERS`, `DISCLOSURE_LATENCY_WATCH_LIMIT`, legacy
   `FMP_DISCLOSURE_WATCH_*`, and `UW_DEEP_MATCH_DATES_PER_RUN` were never set,
   so the admin Settings table reported `missing` even though code defaults
   existed for some of them.
2. **Trade-hash rewrite schema/write bugs.** Production
   `trade_*` tables were missing `provider_published_at` (and candidates
   missing `source_url`). `recordTradeLatencyCandidates` also hashed
   `Transaction.owner` (self/spouse) instead of the filer name, hardcoded
   chamber to `house`, and did not map CT `P`/`S`/`E` sides — writes failed
   or produced unmatchable hashes, swallowed as "latency tables missing".
3. **FMP account suspended.** Live FMP stable endpoints return
   `Account suspended` (HTTP 403). UW and Quiver keys are healthy.

## Files changed

- `app/src/ingestion/tradeLatency.ts` — fix candidate recording, P/S/E side
  mapping, filer/chamber lookup, backfill helper
- `app/src/admin/routes.ts` — `POST /disclosure-latency/backfill-candidates`
- `app/src/admin/migrations.ts` — idempotent ALTER column fix for trade-latency
- `app/migrations/0059_trade_latency_watch.sql` — include `source_url` on create
- `app/docs/config-registry.md`, `app/.dev.vars.example`
- tests for hash side-mapping + migration parity

## Ops already applied in production (Infisical + Turso)

Infisical (app):

- `DISCLOSURE_LATENCY_WATCH_ENABLED=true`
- `DISCLOSURE_LATENCY_PROVIDERS=fmp,unusual_whales,quiver`
- `DISCLOSURE_LATENCY_WATCH_LIMIT=100`
- `FMP_DISCLOSURE_WATCH_ENABLED=true`
- `FMP_DISCLOSURE_WATCH_LIMIT=100`
- `UW_DEEP_MATCH_DATES_PER_RUN=8`

Turso:

- `ALTER TABLE trade_provider_observations ADD COLUMN provider_published_at`
- `ALTER TABLE trade_latency_candidates ADD COLUMN provider_published_at`
- `ALTER TABLE trade_latency_candidates ADD COLUMN source_url`
- Seeded ~1746 pending candidates/provider from last-30d tickered trades

## Verification

- `GET /api/admin/config-sources` → all six latency knobs `source: infisical`
- `POST /api/admin/disclosure-latency/probe?providers=unusual_whales,quiver`
  → `ok:true`, fetches rows, no schema errors
- FMP probe still `FMP_HTTP_403` until the FMP account is unsuspended
- `cd app && npm run typecheck && npm test` (focused latency/migration suites green)

## Follow-ups

- Unsuspend / replace the FMP API account (owner billing with FMP).
- After this PR deploys, run
  `POST /api/admin/disclosure-latency/backfill-candidates` again if needed,
  then probe all three providers.
- Tune hash matching if UW/QQ overlap stays low (name/date normalization).
