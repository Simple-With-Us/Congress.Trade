# 2026-08-15 — iOS tab footer links + latency lead/lag signs

## Context & Objective

Owner screenshot of the iOS Trends tab: the bottom legal row printed raw
Markdown (`[Privacy](url)`) instead of tappable links, Support mailed
`congress.trade@jays.services`, and Speed vs. Data Providers painted every
time in green as a "Preliminary lead" even when the number was negative.

## Changes Made

- **Footer.** SwiftUI `Text` only parses Markdown for string literals.
  Concatenated `[label](url)` strings were shown as source.  `AppLegal`
  now builds an `AttributedString` (inline-only) so Privacy / Terms /
  Pricing / Support wrap and tap.  Support is `mailto:support@congress.trade`
  on iOS, the web footer, and the Terms/Privacy pages.
- **Latency scorecard.** Live `GET /api/analytics/latency-summary`
  (2026-08-16T00:52Z): FMP median **+13.0h** / avg **−4.6d** (16–12);
  Unusual Whales median **+24m** / avg **−5.7h** (7–2); Quiver median
  **+13m** / avg **+1.9h** (13–0).  All three probes `running`,
  `comparisonStatus=preliminary` because coverage is still building
  (FMP 53% CT coverage, UW 18%, Quiver 16%).  iOS was headlining the
  **mean** and coloring by **win count**, so a slower average sat in
  green under a "lead" badge.  iOS now matches web: headline = median,
  `+`/green when we published first, `−`/red when later, "lead" vs
  "lag" follows the sign.  When mean and median disagree, a caption
  says the average was pulled by outliers.

Touched:

- `clients/ios/CongressTrade/Views/Components/Components.swift`
- `clients/ios/CongressTrade/Views/Feed/FeedDashboardView.swift`
- `clients/ios/CongressTrade/Views/TrendsView.swift`
- `clients/ios/CongressTradeTests/CongressTradeTests.swift`
- `app/src/ui/legalHtml.ts`
- `app/src/ui/dashboardHtml.ts`
- `app/src/ui/__tests__/legalHtml.test.ts`
- `app/src/ui/__tests__/dashboardHtml.test.ts`
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `docs/rollouts/2026-08-15-ios-footer-latency-signs.md`

## Decisions & Trade-offs

- Badge and color follow the **headline sign** (median), not win count.
  Win % stays on the right as a separate fact.  With a median headline
  those two almost always agree; the owner's confusion was the mean.
- Did not change the matcher.  Issue #1523 already covers undercounting.
  The 14-day concurrent window is why a few FMP losses are multi-day
  and flip the mean.  Probes themselves are healthy.
- Local Mac has no CoreSimulator runtime (0 disk images) and Xcode
  reports "iOS 26.5 is not installed" for destinations, so iOS
  compile/tests run in CI on the Mac runner.

## Verification State

- `npm run typecheck` (deno check `src/deno/main.ts`) — clean
- `npm test` — 250 files, 3042 tests passed
- `npx vitest run src/ui/__tests__/legalHtml.test.ts src/ui/__tests__/dashboardHtml.test.ts` — 271 passed
- Live latency-summary fetched; all three providers `running`
- iOS `xcodebuild` locally: no eligible Simulator/device destination

## Next Steps & Blockers

- CI `xcodebuild` on the Mac runner is the first compile of the Swift
  changes.  Watch that job.
- TestFlight hourly ship will pick up the iOS binary after merge.
- `support@congress.trade` must be routed (Cloudflare Email Routing or
  equivalent).  The old inbox was `congress.trade@jays.services`.
