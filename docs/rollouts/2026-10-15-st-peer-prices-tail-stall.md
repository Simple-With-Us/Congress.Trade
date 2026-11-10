# ST peer prices tail-backlog stall fix (CT-2408)

## Summary

The `st_peer_prices` stall alarm kept firing while `price_freshness` stayed green because
two permanently-unpriceable tail tickers pinned `MAX(price_checked_at)` on the pending set
even though the indexed corpus `latest_price_date` was already current through
`lastTradingDay`.  Pending math now matches `selectTickersNeedingPrices` (stale bar,
unavailable TTL, competitor fixture exclusion), and the detector suppresses stalls when
the corpus is current and at most five tickers remain in the backlog.

## Files changed

- `app/src/prices/peerPricePending.ts` — shared pending SQL + tail-backlog helper
- `app/src/ingestion/pipelineLoudAlerts.ts` — aligned predicate + tail suppression
- Tests under `app/src/ingestion/__tests__/`, `app/src/prices/__tests__/`

## Verification

From `app/`:

- `npm run typecheck`
- `npm test`

## Follow-ups

- None required; operators can still mark junk symbols via
  `POST /api/admin/securities/:ticker/price-unavailable`.
