# 2026-10-16 — House Live-Search Overlay Throttling & Timeout/Pagination Fix

## Summary

The House live-search endpoint is an intraday overlay on the daily bulk XML index. It stays enabled by default because filings can arrive outside the morning bulk window.

1. **Upstream Clerk release schedule & data clarification:**
   - The House Clerk's interactive member search (`POST /FinancialDisclosure/ViewMemberSearchResult`) and the yearly bulk XML (`{YEAR}FD.ZIP` -> `{YEAR}FD.xml`) refresh on a shared morning publication batch at ~8:00 AM Central on business days.
   - Note on `app/docs/probe-schedule.md` ("117 filings in one burst at 11:33 ET on Aug 4"): Database inspection of `/data/congress-trade/db.sqlite` confirmed those 117 rows were synthetic `provider-missing-quiver-house-*` and `provider-missing-unusual_whales-house-*` latency backfill rows, rather than House Clerk filings.  All genuine House filings (`doc_id LIKE 'H-%'`) across production history land during the morning batch.
   - However, live search remains enabled by default and follows the full adaptive probe schedule (`probeSchedule.ts`: 60s in 07:55-08:40 Central burst, 4 min shoulder, ~10 min midday, 30 min overnight) so any genuine intraday Clerk releases are discovered immediately without artificial delays.

2. **Client & timeout defects fixed in `pollHouseLiveSearch()` and `pollHouse()`:**
   - **Keep `HOUSE_LIVE_SEARCH_ENABLED` on by default on the adaptive schedule:** Live search runs on every scheduled House poll alongside the bulk index without an artificial 30-minute KV throttle.
   - **Remove fake DataTables pagination loop:** `ViewMemberSearchResult` is a server-rendered Razor HTML view where DataTables paginates in the browser.  The server returns all 436 rows in one response.  `pollHouseLiveSearch()` now issues a single POST per poll instead of 2 POSTs and a 500ms sleep.
   - **Prevent per-source 7s timeout in `pollHouseLiveSearch()` from discarding already-fetched bulk XML filings:** `pollHouse()` isolates `tickSignal` so a live-search timeout never aborts or discards already-fetched bulk XML rows.
   - **Remove outbound `x-residential-proxy-url` header leak.**

## Files Changed

- `app/src/ingestion/houseSource.ts`
- `app/src/ingestion/watcher.ts`
- `app/src/shared/types.ts`
- `app/src/ingestion/__tests__/houseSource.test.ts`
- `app/src/ingestion/__tests__/watcher.test.ts`
- `app/src/ui/dashboardHtml.ts`
- `app/src/ui/__tests__/dashboardHtml.test.ts`
- `docs/rollouts/2026-10-16-house-live-search-daily-batch-fix.md`

## Decisions

- Keep `HOUSE_LIVE_SEARCH_ENABLED` enabled by default (`!== 'false'`) and execute on every scheduled House poll following the adaptive schedule (`probeSchedule.ts`), with no separate 30-minute KV throttle.  Consecutive failure alerts escalate via `console.error` every 12 failures (`house_live_search:consecutive_failures`).
- Isolate `tickSignal` from the per-source `signal` so a slow `pollHouseLiveSearch()` call never aborts and discards already-fetched `fetchHouseIndex()` bulk rows.
- Include `FinancialModelingPrep.com` (`fmp`) in `publicLatencyProviders()` and run `renderSpeedProof()` on boot and `subs` tab restore so the public website displays live FMP vs. Congress.Trade latency comparisons.

## Verification

```bash
cd app
npm run typecheck
npx vitest run src/ingestion/__tests__/houseSource.test.ts src/ingestion/__tests__/watcher.test.ts src/ui/__tests__/dashboardHtml.test.ts
```

- `npm run typecheck`: passed (`0` errors).
- `vitest`: `441/441` tests passed across `houseSource.test.ts` (`12`), `watcher.test.ts` (`34`), and `dashboardHtml.test.ts` (`395`).

## Next Steps

- Deploy to production via `bash app/scripts/ship.sh` after merge to `main` and verify `/api/health` and the public Filing Latency Comparison scoreboard on `https://congress.trade`.
