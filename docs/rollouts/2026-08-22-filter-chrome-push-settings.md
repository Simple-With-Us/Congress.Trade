# Filter chrome grey + filing/watchlist push settings

Sat, Aug 22, 2026

Owner screenshot of the iOS Trades header: filter pills, "3 Months", chevrons,
calendar/chamber/people glyphs, and the exchange arrows were system blue (or
black, for exchange).  The ⓘ and hamburger were already grey.  Same ruling:
one semi-dark grey for that whole family.  Selected marks inside an open
dropdown may stay blue.  Green/red buy/sell arrows stay semantic.

Separately, per-trade APNs was a firehose.  Phone alerts now have three modes:
Off, one digest per new filing, or a ticker watchlist with a STOCK Act
bracket-floor minimum and buys/sells per symbol.

## Files

- `clients/ios/CongressTrade/Views/Feed/FeedDashboardView.swift` — filter
  chrome grey; menu tint grey; toggle/checkmark blue only when chosen
- `clients/ios/CongressTrade/Views/Components/Components.swift` — header
  glyphs share `AppTheme.glyphGrey`; alert type picker + watchlist editor
- `clients/ios/CongressTrade/Views/Delivery/DeliveryView.swift` — same
  alert controls; dropped the duplicate OS-only toggle
- `app/src/shared/pushSettings.ts` — parse, copy, watchlist match
- `app/src/delivery/apnsFanout.ts` — per-user digest; honor
  `notificationSettings`; no review-queue pushes to product devices
- `app/src/client/commands.ts` / `state.ts` — normalize + batch-read prefs
- `app/docs/client-mobile-api.md` — `notificationSettings` contract

## Copy

Filing digest title: `{Name}, {Position}` (e.g. `Senator from California`,
`Representative from California's 17th District`, `President`).

Body: `Filed 4 trades (2 buys, 1 sell, 1 exchange).`

Watchlist uses the same digest on the matching rows only.

## Verification

```bash
cd app && npm run typecheck && npm test
xcodebuild -project clients/ios/CongressTrade.xcodeproj -scheme CongressTrade \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:CongressTradeTests test
```

No schema migration.  Existing `notification_settings` JSON is parsed in
place; missing `pushMode` defaults to `filings` (digest), not a per-trade
blast.

## Follow-ups

- TestFlight hourly ship for the installed app
- Web still points at the iOS app for phone push; webhook/SSE unchanged
