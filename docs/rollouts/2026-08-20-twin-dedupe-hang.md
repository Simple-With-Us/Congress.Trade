# 2026-08-20 — Twin-dedupe hang on feed COUNT and Trends

## Summary

PR 2037 (`90b5f597`, issue #2032) put `TWIN_DEDUPE_SQL` — a correlated `NOT EXISTS` self-join — on every live-row filter, including the unbounded `GET /transactions` COUNT / today-filings companions that first page always waits on before writing JSON.  On production SQLite that was a per-row seek of every trade sharing a `tx_date`, so `/api/transactions?since=0` sat 25s+ with zero bytes and 90d Trends sat on LOADING then 502'd.

This change keeps twin-dedupe on published rows (page, CSV, client ticker/member summaries, every Trends aggregate).  The unbounded COUNT / today path reports the live-row total without the correlated subquery.  A covering `(filer_id, tx_date)` partial index makes the remaining NOT EXISTS an index SEARCH.

## Files changed

- `app/src/shared/tradeIdentity.ts` — index-first twin predicates; `TWIN_SEEK_INDEX`
- `app/src/delivery/rows.ts` — COUNT / today omit `TWIN_DEDUPE_SQL`
- `app/migrations/0088_tx_twin_seek_index.sql` + `TWIN_SEEK_INDEX_SCHEMA_STATEMENTS` in `app/src/admin/migrations.ts`
- Tests: `twinDedupeScale.test.ts`, query-builder pins, Fleischmann page vs COUNT

## Verification

`cd app && npm run typecheck && npm test`

Scale fixture: 12,000 unique live rows plus a Fleischmann TSCO triple.  EXPLAIN QUERY PLAN on COUNT has no correlated subquery.  First-page + COUNT + today + 90d summary/leaderboard finish well under 2s.  Published TSCO page is the primary row; analytics still counts the triple once.

## Follow-ups

`total` on the feed is now a live-row count (slightly above the published unique-trade count when twins exist).  Write-time canonicalization would make COUNT exact without a correlated subquery; not done here.  Production schema lands via `POST /api/admin/migrate` on ship.

**2026-08-20 follow-up:** COUNT-off was not enough.  Live SHA `c2b6757e` still sat 30s with zero bytes on `GET /api/transactions?order=desc&limit=5&offset=0` because the PAGE query kept `TWIN_DEDUPE_SQL` in the driving WHERE.  See `docs/rollouts/2026-08-20-twin-dedupe-page-hang.md`.
