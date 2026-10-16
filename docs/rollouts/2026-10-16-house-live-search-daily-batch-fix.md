# 2026-10-16 — House Live-Search Overlay Throttling & Timeout/Pagination Fix

## Summary

Investigation of all 23 House STOCK Act PTR filings ingested between October 2 and October 16, 2026 (plus all 30 House discovery batches in `ingest_log` across 108 days of production history) established why `pollHouseLiveSearch()` (`POST https://disclosures-clerk.house.gov/FinancialDisclosure/ViewMemberSearchResult`) had not discovered filings ahead of the daily bulk XML index (`https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{YEAR}FD.ZIP`):

1. **Upstream Clerk release schedule (shared daily 8:00 AM publication batch):**
   - The House Clerk's interactive member search (`POST /FinancialDisclosure/ViewMemberSearchResult`) and the yearly bulk XML (`{YEAR}FD.ZIP` -> `{YEAR}FD.xml`) refresh on the same once-daily publication cycle at ~8:00 AM on business days.
   - Live comparison on `2026-10-16`: `2026FD.ZIP` (`Last-Modified: Oct 15, 8:00:04 AM`) and `POST /FinancialDisclosure/ViewMemberSearchResult` (`FilingYear=2026`) both return the exact same **427** PTR `DocID`s (`live - bulk = []`, `bulk - live = []`).
   - HTTP `Last-Modified` headers on the 23 October 2026 PTR PDFs (`/public_disc/ptr-pdfs/2026/{docId}.pdf`) show the exact timestamp each PDF was generated/signed:
     - On October 14, 2026, `20035487` (Daniel Meuser) was signed at **7:49:54 AM** (10 minutes before the 8:00 AM daily cut) and published in the October 14 8:00 AM batch (discovered by our watcher at **8:02:00 AM**, 12 minutes after PDF creation).
     - Four other October 14 filings — `20035627` (Suzan K. DelBene, signed **2:36:44 PM**), `20035648` (Richard W. Allen, signed **3:40:53 PM**), `20035651` (Rich McCormick, signed **3:46:54 PM**), and `20035652` (Robin Kelly, signed **4:04:57 PM**) — were signed in the afternoon after the 8:00 AM cut.  Between 2:36 PM on Oct 14 and 8:00 AM on Oct 15, `source_attempts` recorded **45 consecutive successful House polls**; all 45 returned `0` new filings until the Clerk's index refreshed at **8:00:04 AM** on Oct 15.

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
- `docs/rollouts/2026-10-16-house-live-search-daily-batch-fix.md`

## Verification

```bash
cd app
npm run typecheck
npm test
```
