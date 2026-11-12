# Peer-price daily drain + stall clock (CT-2469)

## Summary

After the daily EOD rollover, `st_peer_prices` backlog drained from ~1688 toward ~950 and then plateaued for the rest of the session while health reported a ~47h stall.  The stall detector used `MAX(price_checked_at)` over tickers still pending, which tracks the oldest checked row in a large mixed-age backlog — not time since the catch-up lane last made progress.  The hourly catch-up also parked after two runs with a flat pending count even when it priced tickers (negative-cache boundaries), and non-fatal per-ticker fetch errors did not stamp `price_checked_at`, so stuck sweeps never fired during catch-up-only days.

## Files changed

- `app/src/prices/peerPriceDrainProgress.ts` — KV `jobs:market-data:price-drain-last-progress-at`
- `app/src/prices/stPeerPricesHealth.ts` — stall on drain KV; `oldestPendingCheckedAt` informational
- `app/src/prices/peerPriceCatchUp.ts` — priced-ticker progress; scalable run cap
- `app/src/jobs.ts` — record progress; stuck sweep in catch-up; full-lane progress
- `app/src/prices/service.ts` — stamp `price_checked_at` on non-fatal fetch errors
- Tests under `app/src/prices/__tests__`, `app/src/ingestion/__tests__`, `app/src/__tests__/jobs.test.ts`

## Verification

- `npm test` (including new `peerPriceDrainProgress.test.ts` and updated stall suites)
- After deploy: `/api/health` `st_peer_prices.value.lastProgressAt` advances when catch-up runs; `oldestPendingCheckedAt` may stay old without paging

## Follow-ups

- CT-2429 (30-day suppression re-entry) remains GROK's lane — not duplicated here
