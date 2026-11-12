# Trends side filter actually applies

## Summary

The shared Buys / Sells / Exchange chip lit up on Trends but did not change
Market Snapshot or What Is Being Traded.  Three independent misses:

- `/api/analytics/*` parsed window / chamber / party and ignored `type=`
- iOS `refreshTrends()` never forwarded `selectedTradeTypes`
- web `trParams()` never appended the Trends side chips

Selecting Buys now restricts the analytics corpus the same way the Trades feed
already did.  Sells KPI goes to 0; ticker ranking is buy-only volume/count.

## Files changed

- `app/src/analytics/sql.ts` — `asTxTypes` / `constrainTxTypes`
- `app/src/analytics/routes.ts` — `commonFromQuery` reads `type=`
- `app/src/analytics/builders.ts` — cluster/conviction keep B/S and intersect
- `app/src/ui/dashboardHtml.ts` — `trParams()` sends `type=`
- `clients/ios/CongressTrade/APIClient.swift` + `Store/CongressTradeStore.swift`

## Verification

- `npm run typecheck` clean
- `npm test` 259 files / 3158 tests
- `testSetTradeTypeSelectionSendsTypeToTrendsAnalytics` on iPhone 17 Pro
- After ship: `GET /api/analytics/summary?window=90d&type=B` must echo
  `"type":"B"` and `totalTrades` must equal `buyCount` (not the mixed total)

## Follow-ups

- Installed iOS clients pick this up on the next TestFlight hourly ship.
  Until then the phone still sends unfiltered Trends requests; the live API
  is ready for them.
