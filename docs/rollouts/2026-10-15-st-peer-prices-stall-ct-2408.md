# ST peer prices stall false alarms (CT-2408)

## Summary

`pipeline.stalled` on `st_peer_prices` fired daily while EOD prices were current: a
flat wall-clock threshold on `price_checked_at` treated the quiet hours after the
US close as a stall, and a handful of permanently unpriceable tail tickers kept a
non-empty pending set.  The detector now uses the same pending predicate as
`selectTickersNeedingPrices` (last completed trading session + negative-cache TTL),
raises the code default stall window to 30h, and suppresses the stall when the
S&P and active-ticker price cohort match `price_freshness` ok (within three
trading days).

## Files changed

- `app/src/ingestion/pipelineLoudAlerts.ts`
- `app/src/ingestion/__tests__/stPeerPricesStall.test.ts`

## Verification

From `app/`:

- `npm run typecheck`
- `npm test -- src/ingestion/__tests__/stPeerPricesStall.test.ts`
- `npm test`

## Follow-ups

- Operators can still mark junk tickers via `POST /api/admin/securities/:ticker/price-unavailable` when peer refresh has not yet negative-cached them.
