# 2026-10-16 — House Live-Search Overlay Throttling & Timeout/Pagination Fix

## Summary

The House live-search endpoint is an intraday overlay on the daily bulk XML index. It stays enabled by default because filings can arrive outside the morning bulk window.

1. **Do not infer a shared publication schedule from a matching snapshot:**
   - A live/bulk comparison returning the same DocIDs at one moment does not establish that both sources always publish together. PDF Last-Modified timestamps also do not prove when the live search first exposed a filing.
   - `app/docs/probe-schedule.md` records 7 of 32 House arrival events after its 08:55-09:40 ET peak window (about 22%). This supports continued intraday polling; it does not prove that both sources publish together. Keep the two paths complementary rather than disabling the overlay based on a daily-batch assumption.

2. **Client & timeout defects fixed in `pollHouseLiveSearch()` and `pollHouse()`:**
   - **Keep `HOUSE_LIVE_SEARCH_ENABLED` on by default, throttled to once per 30 minutes (`house_live_search:last_fetch_at`):** Instead of running `pollHouseLiveSearch()` on every 1-minute peak / 4-minute morning poll (153 times/day), it now runs at most once every 30 minutes (~48 times/day) so it stays active intraday without competing with the 1-minute 8:00 AM bulk-ZIP sprint.
   - **Remove fake DataTables pagination loop:** `ViewMemberSearchResult` is a server-rendered Razor HTML view (`<table class="library-table table" role="grid" data-paging="true">`) where client-side DataTables (`main.min.js`) paginates the rendered DOM in the browser.  The server ignores `FilingType=P`, `draw=1`, `start`, and `length`, returning all 436 rows (`207,505` bytes, 427 PTRs) in one response.  Because `427 >= limit (100)`, `pollHouseLiveSearch()` previously slept 500ms and issued a second identical 207 KB POST (`offset=100`) on every poll.
   - **Prevent per-source 7s timeout in `pollHouseLiveSearch()` from discarding already-fetched bulk XML filings:** `pollHouse()` shares a single 7-second `WATCHER_SOURCE_IO_BUDGET_MS` across `fetchHouseIndex()` and `pollHouseLiveSearch()`.  When `fetchHouseIndex()` succeeded and the subsequent `pollHouseLiveSearch()` timed out, `if (signal?.aborted) throw err;` rethrew the per-source `TimeoutError`, discarding the already-fetched bulk XML rows and triggering a 10-minute `lastAttemptFailed` backoff (delaying the Oct 15 8:00:04 AM batch discovery from 8:01 AM to 8:12 AM).
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

- Keep `HOUSE_LIVE_SEARCH_ENABLED` enabled by default (`!== 'false'`) and throttle successful `pollHouseLiveSearch()` runs to once per 30 minutes via `house_live_search:last_fetch_at` in `CONFIG_KV`.  Failed runs intentionally do not set `house_live_search:last_fetch_at` so they can retry on the next tick and advance the 3-strike `house_live_search:consecutive_fails` alert.
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
