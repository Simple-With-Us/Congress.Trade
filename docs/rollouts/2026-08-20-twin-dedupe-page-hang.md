# 2026-08-20 — Twin-dedupe still hung the published first page

## Summary

#2066 (`c2b6757e`) took `TWIN_DEDUPE_SQL` off the unbounded COUNT / today-filings companions.  That did not unhang first-page `GET /api/transactions`.  Live on congress.trade after that ship:

- `/api/health` 200 in ~0.3s, `schema: true`, `missing: []`, build SHA `c2b6757e`
- `GET /api/transactions?order=desc&limit=5&offset=0` timed out at 30s with **zero bytes**

Verified, not assumed:

1. The PAGE builder (`buildTransactionsQuery`) still applied the correlated `NOT EXISTS` in the same WHERE as `ORDER BY … LIMIT`.  SQLite can evaluate that subquery against the live corpus before walking the cursor index to LIMIT.  The handler in `app/src/delivery/rest.ts` awaits that page query before `c.json`.
2. `idx_tx_twin_seek` / migration 0088 is only created via `POST /api/admin/migrate` (`POST_0024_SCHEMA_STATEMENTS`).  `runMigrations` in `app/src/admin/migrations.ts` is test-only.  `app/src/deno/main.ts` never applies schema on process start.  Coolify auto-deploy on `main` does not run `bash app/scripts/ship.sh`, so prod never got the index.  Health's readiness checklist does not include `idx_tx_twin_seek` (intentionally — adding it would 503 health in the deploy-before-migrate window).

This change keeps twin-dedupe **semantics** on the published page.  It forces a cheap `WHERE` + `ORDER` + over-fetch `LIMIT` first (no twin), then applies `TWIN_DEDUPE_SQL` to that candidate window against the full `transactions` table (Fleischmann source-precedence stays), then applies the caller `LIMIT`/`OFFSET`.  First page no longer depends on `idx_tx_twin_seek` existing.

Do not `CREATE INDEX` on Coolify boot — building `(filer_id, tx_date)` on a ~1.88GB SQLite file would lock reads and 524 the site.

## Files changed

- `app/src/delivery/rows.ts` — `twinCandidateLimit`; page SQL walks cheap ORDER+LIMIT first
- `app/src/delivery/__tests__/buildTransactionsQuery.test.ts` — SQL-shape pins
- `app/src/delivery/__tests__/twinDedupeScale.test.ts` — 12k rows **without** `idx_tx_twin_seek`
- `app/src/shared/readiness.ts` + test — document that 0088 is not a required probe

## Verification

`cd app && npm run typecheck && npm test`

Scale fixture: 12,000 unique live rows plus a Fleischmann TSCO triple, no `idx_tx_twin_seek`.  Live-shaped `{ order: 'desc', limit: 5, offset: 0 }` + COUNT + today finish well under 2s.  Published TSCO page is still `primary-tsco`.

Live confirmation before this change: health 200 / first page 30s 0 bytes on SHA `c2b6757e`.

## Follow-ups

90d Trends still embeds `TWIN_DEDUPE_SQL` in unbounded aggregates and will stay slow until `idx_tx_twin_seek` exists (`POST /api/admin/migrate` / `bash app/scripts/ship.sh`).  That is not this first-page hang.  Feed `total` remains a live-row count (slightly above published unique trades).
