# 2026-08-15 — Trends layout, Directory pager, Khanna recent dates

## Context & Objective

Owner asked to move Buys vs Sells under Rising Activity, drop rank numbers on
What Is Being Traded and add a # / $ toggle, put Directory pagination on the
far left like Trades, stop sticky pager/sort unless the bottom copies go
away, and fix Ro Khanna's politician sheet showing December 2025 as the
most recent trades.

## Changes Made

- **Trends order (iOS + web):** What Is Being Traded → Rising Activity →
  Buys vs Sells → Consensus Moves.
- **What Is Being Traded:** no leading rank numbers.  `#` / `$` on the
  heading ranks by trade count or estimated volume.
- **Directory People + Assets:** pager / sort / rows-per-page sit in the
  same `PaginationBar` as Trades (pager left).  That chrome scrolls with
  the list (top and bottom), matching Trades.  The People|Assets switch
  stays at the top of the tab.
- **Khanna dates:** `GET /api/client/v1/member/:id` now defaults to
  `sort=tx_date&order=desc`.  Live lastTrade was already 2026-07-01 on
  slug `house-ca17-ro-khanna`; items were cursor-ordered so a reimported
  2025-12-12 filing floated first.  iOS requests that sort explicitly.
  Analytics `/member/:filerId` now runs `resolveMember` so a Trends tap
  on bioguide `K000389` hits the slug's trades instead of an empty
  profile.

Touched:

- `app/src/client/routes.ts`
- `app/src/client/__tests__/routes.test.ts`
- `app/src/analytics/routes.ts`
- `app/src/ui/dashboardHtml.ts`
- `app/src/ui/__tests__/dashboardHtml.test.ts`
- `clients/ios/CongressTrade/APIClient.swift`
- `clients/ios/CongressTrade/Views/TrendsView.swift`
- `clients/ios/CongressTrade/Views/People/PeopleDirectoryView.swift`
- `clients/ios/CongressTrade/MemberDirectorySearch.swift`
- `clients/ios/CongressTradeTests/CongressTradeTests.swift`
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `docs/rollouts/2026-08-15-trends-directory-khanna.md`

## Decisions & Trade-offs

- Did not delete the 22,832 Khanna rows or the many ticker-less assets —
  that is extraction quality, not this layout/sort bug.  lastTrade is
  already 2026-07-01 once items sort by `tx_date`.
- Autopilot is still halted (OpenRouter files prepaid minimum).  Newer
  unpublished filings will not appear until extraction runs again.

## Verification State

- `npm run typecheck` — clean
- Focused + full `npm test` (see commit)
- Local Xcode still has no iOS 26.5 destination; Swift compile is CI

## Next Steps & Blockers

- TestFlight hourly ship for the iOS chrome.
- Coolify auto-deploy for web + member API.
- Extraction halt is a separate lane.
