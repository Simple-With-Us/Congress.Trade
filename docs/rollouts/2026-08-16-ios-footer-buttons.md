# 2026-08-16 — iOS tab footer: buttons, not Markdown

## Summary

The App Review / TestFlight binary `202608150702` still shows raw
`[Privacy](url)` at the bottom of every tab and mails
`congress.trade@jays.services`.  #1881 fixed that on `main` (AttributedString)
but never shipped.  This change makes the tab footer the same button row the
Account sheet already uses, so a Markdown parse miss cannot print source.

Support is `mailto:support@congress.trade`.

## Files

- `clients/ios/CongressTrade/Views/Feed/FeedDashboardView.swift` — `AppLegalFooter`
- `clients/ios/CongressTradeTests/CongressTradeTests.swift`
- `docs/EFFORT-LOG.md`, `STATUS.md`

## Verification

- `xcodebuild test` on the physical iPhone 16 Pro Max
- Screenshot of Trends / Trades / Directory / Delivery footers
- TestFlight force-ship after merge

## Follow-ups

- Attach the new TestFlight build to App Store 1.0.0 and re-record the
  Guideline 2.1 walkthrough on that build.
