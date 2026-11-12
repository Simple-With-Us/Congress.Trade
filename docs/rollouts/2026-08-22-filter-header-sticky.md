# iOS filter bar in the opaque light header

Sat, Aug 22, 2026

Owner screenshots: the Trends filter pills (3 Months, branch, party, side)
sat in the cool grey page below the wordmark with a large gap, and the
`ultraThinMaterial` strip over `#eff3f8` read as a blue wash.  On scroll the
page showed through the material so the bar no longer looked pinned.

#2155 already greys the glyphs and "3 Months".  This pass puts the strip
in the same opaque white as the navigation bar, tight under the title,
outside the vertical ScrollView so it stays put.  The disclaimer moves into
the scrolling content so an expanded (i) card cannot shove the pills away
from the wordmark.

## Files

- `clients/ios/CongressTrade/Views/Components/Components.swift` —
  `AppTheme.headerChrome` (opaque card) and `ctSolidFeedHeader()`
- `clients/ios/CongressTrade/Views/Feed/FeedDashboardView.swift` —
  `FeedStickyBar`; Trades filter + search in the light header
- `clients/ios/CongressTrade/Views/TrendsView.swift` — same sticky bar
- `clients/ios/CongressTradeTests/CongressTradeTests.swift` —
  header chrome is opaque, panel is not

## Verification

```bash
cd app && npm run typecheck && npm test
xcodebuild -project clients/ios/CongressTrade.xcodeproj -scheme CongressTrade \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -only-testing:CongressTradeTests/CongressTradeTests/testHeaderChromeIsOpaqueCardNotTranslucentPanel \
  test
xcrun simctl io booted screenshot /tmp/ct-filter-header-top.png
```

No schema migration.  Keepouts: extract/halt, Infisical, #1959.
