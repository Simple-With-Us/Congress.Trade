# Shared filters on every surface

## Summary

After #1997 the Buys chip reached Trends *cards*.  Ticker and politician
sheets, web drawers, party-split, and the iOS ticker-leaderboard sort key
still ignored some of the shared chips.  Window, chamber, party, and side
now travel with every Trends request, every web drawer, and every iOS
ticker/politician sheet.

## Files changed

- `app/src/client/routes.ts` + `queries.ts` — client ticker/member honor feed filters
- `app/src/ui/dashboardHtml.ts` — drawers use `trParams()`
- iOS `APIClient` / `CongressTradeStore` — `sort=` not `rankBy`; party-split gets `party=`; sheets call `fetchTicker` / `fetchMember`

## Verification

- `npm run typecheck`
- `npm test`
- iOS unit tests for party-split + ticker filter forwarding
- After ship: `GET /api/client/v1/ticker/AAPL?type=B` summary sellCount is 0

## Follow-ups

- Installed iOS still needs the hourly TestFlight ship (or a manual one) to
  send the new query params.
