# 2026-10-16 — Bulk-Window Discovery Alert For House Filings

## Summary

The watcher now records how each House filing was first discovered (`filings.discovered_via` = `live` for the intraday live-search overlay, `bulk` for the daily bulk index) and logs a Sentry-visible `console.error` when a filing is first surfaced by the bulk index although its filed date is more than 4 hours old.  That means live search missed it across a full window of polls (or the Clerk published unusually late).

Attribution rules:

- A filing seen by BOTH the bulk index and live search in the same poll is attributed to `live`.  The bulk record is kept (the live-search HTML carries no `FilingDate`, so replacing it would insert `filed_date` NULL).
- `filed_date` from the House XML is day-granularity (`M/D/YYYY`).  A date-only value counts as filed at the END of that calendar day on the Clerk's ET clock, so a same-day discovery at the ~13:00Z morning refresh is never late, and `hoursLate` is a lower bound measured from the end of the filed day in ET.
- Empty, malformed, or unparseable filed dates and an unparseable discovery time stay silent.

## Files changed

- `app/src/ingestion/watcher.ts` (`discoveredVia`, `findStaleBulkDiscoveries`, `filedInstantUpperBoundMs`, `alertOnStaleBulkDiscoveries`, live-over-bulk attribution in `pollHouse`)
- `app/migrations/0106_filings_discovered_via.sql` (new)
- `app/src/admin/migrations.ts` (`FILINGS_DISCOVERED_VIA_SCHEMA_STATEMENTS`, appended to the post-0024 list)
- `app/src/admin/__tests__/migrations.test.ts`, `app/src/ingestion/__tests__/watcher.test.ts`

## Decisions

- Migration number is `0106`: `0105` is reserved for `0105_filers_bioguide_lower_indexes.sql` (open PR #2775).
- The column has its own migration and statement const; it is not part of the `0096` probe-interval set, whose file never carried it.

## Verification

```bash
cd app
npm run typecheck
npx vitest run src/admin/__tests__/migrations.test.ts src/ingestion/__tests__/watcher.test.ts
```

## Follow-ups

- `insertFilingIfNew` writes `discovered_via` on every `filings` INSERT (House, Senate, OGE).  After Coolify lands this SHA, run `bash app/scripts/ship.sh` so `POST /api/admin/migrate` adds the column; until then filing inserts fail and are retried on the next poll.
- The alert is only meaningful while `HOUSE_LIVE_SEARCH_ENABLED` is on: with live search deliberately off, every aged bulk-only discovery would log it.
