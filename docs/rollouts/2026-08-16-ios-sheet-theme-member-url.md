# iOS Account theme + first-tap member 404

## Summary

The open Account sheet stayed dark after switching to Light/System.  Theme
now paints every window and presented controller, and the sheet forces the
chosen color scheme in the SwiftUI environment.

Tapping a politician showed `member not found` because
`GET /member/:id?sort=tx_date` stuffed the query into the path
(`C001047%3Fsort=tx_date`).  Query items are real query items now.  Ticker
and politician sheets use `sheet(item:)` and retry a cancelled/5xx first
load so a first tap that SwiftUI cancels is not shown as an error.

## Files changed

- `clients/ios/CongressTrade/APIClient.swift`
- `clients/ios/CongressTrade/Views/Components/Components.swift`
- `clients/ios/CongressTrade/Views/Feed/{Politician,Ticker}DetailView.swift`
- Trades / Trends / Directory sheet presenters
- `clients/ios/CongressTradeTests/CongressTradeTests.swift`

## Verification

- Unit test: member URL path has no `?` / `%3F`; `sort` and `order` are query items.
- CI `xcodebuild (unsigned)` + `typecheck + test`.
