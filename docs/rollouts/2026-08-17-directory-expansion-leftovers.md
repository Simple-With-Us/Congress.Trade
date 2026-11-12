# Directory expansion leftovers (#1460) + Delivery delete confirm (#1429)

## Summary

Product gaps from the 2026-08-06 review that were still open after GROK's filter-bar closeout:

- People directory rows now use the same member avatar helper as the feed.
- Feed table cells and mobile trade cards show the beneficial owner (self / spouse / joint / dependent).
- Politician skill stats label each leg as a variable hold and distinguish avg excess vs S&P from avg asset return.
- Committee lists accept driver-decoded JSON and fall back to a sibling bioguide row when the slug PK is empty.  Empty copy is "No current assignments on file" (or executive-specific), not "Not recorded".
- Web Delivery delete matches iOS: first tap arms **Confirm?** for 4 seconds; second tap deletes.

#1429 items already on `main` and left alone: shared Trades/Trends filters, cancelled `$` min/max, brand lockup assets, FMP family merge, QQ empty-tie fix, keyboard dismiss, cancelled-card filter.

## Files changed

- `app/src/shared/committeeNames.ts` — parse + sibling lookup
- `app/src/analytics/routes.ts` — committee fallback; performance `resolveMember`
- `app/src/client/utils.ts` / `app/src/client/routes.ts` — same committee parse/fallback
- `app/src/ui/dashboardHtml.ts` — directory photos, owner pills, horizon copy, delete confirm
- `clients/ios/CongressTrade/Models.swift` — `Member.committees`
- `clients/ios/CongressTrade/Views/Feed/PoliticianDetailView.swift` — Committees + horizon copy
- `clients/ios/CongressTrade/Views/Feed/FeedDashboardView.swift` — owner on `TradeCard`

## Verification

```bash
cd app && npm run typecheck && npm test
```

iOS source-only in this Linux environment (`xcodebuild` is not installed).

## Follow-ups

- Prod spot-check Tuberville / other slug PKs after the next daily committee sync.
- Dual-axis trade-detail chart remains optional (#1429 comment).
