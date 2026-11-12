# iOS disclaimer under the title, cold-start 3s slide

2026-08-22.  Grok.  Board `08b3f53c`.  Branch `grok/ios-disclaimer-header`.

## Summary

The Trades/Trends ⓘ control is always in the navigation bar, but the
disclaimer lived as the first row of the vertical `ScrollView`.  Tapping
it while scrolled inserted height at content offset 0, which looked like
a no-op and glitched the list.  The banner now sits in the sticky header
under the wordmark and above the filter/search strip.  Expanding it
pushes those controls down; collapsing slides them back up under the
title.

On a cold start (process launch after the app was closed, not a return
from background and not a tab switch) the banner shows for 3 seconds
then auto-hides.  Tapping ⓘ during that intro cancels the auto-hide.
The intro is owned by `MainTabView` so Trends' data fetch cannot delay
it.

## Files changed

- `clients/ios/CongressTrade/App.swift`
- `clients/ios/CongressTrade/Views/Feed/FeedDashboardView.swift`
- `clients/ios/CongressTrade/Views/TrendsView.swift`
- `clients/ios/CongressTradeTests/CongressTradeTests.swift`

## Verification

```bash
xcodebuild -project clients/ios/CongressTrade.xcodeproj -scheme CongressTrade \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  test -only-testing:CongressTradeTests/CongressTradeTests/testDisclaimerColdStartPlaysOnceThenHides \
  -only-testing:CongressTradeTests/CongressTradeTests/testDisclaimerColdStartCancelKeepsUserToggle
```

Simulator screenshots (iPhone 17 Pro, light): cold-start expanded under
the wordmark with filters slid down; ~3.5s later filters back under the
title.  Same pair on Trades (`-startOnTrades`) and Trends.

## Follow-ups

Hourly TestFlight ship on `clients/ios/**` merge.  No extra TestFlight
needed unless the owner wants one now.

## Follow-ups

None.  TestFlight is not required for this layout-only change unless
the owner wants a build.
