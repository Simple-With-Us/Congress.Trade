# 2026-08-13 — Filter-bar takeover (web + iOS)

## Summary

Took over leftover filter-bar work from Antigravity / Monet / Claude.  The shared Trades/Trends chips already existed.  What was still wrong:

- Web still had a second **Search** button that opened page-local Min/Max $ filters, after the owner said no $/size dropdown on any platform.
- Chamber chips used two storage keys and only refreshed the tab you clicked, so the other tab’s chips updated but its numbers did not.
- Multi party/type looked multi-select but often never reached the server (web `type=` only when one side; iOS party was client-side only; Trends `party=` was single-valued).
- iOS time range was missing Past Day and Past 5 Years; web was missing All Time; iOS party menu still used animal emojis.

## Files changed

- `app/src/analytics/sql.ts` + `routes.ts` — `asPartyBuckets` / `parties` IN-filter
- `app/src/ui/dashboardHtml.ts` — drop dual Search + page-local $; All Time; shared chamber key; `type=` CSV
- iOS `FeedQuery.party`, `type=`/`party=` CSV, TimeRange 1d + 1825d, party dots
- tests + `app/docs/client-mobile-api.md`

## Verification

- `npm run typecheck`
- focused vitest: dashboardHtml, analytics sql, feedXml if needed
- `xcodebuild` unsigned iOS tests

## Follow-ups

Issue #1429 Min $ dropdown stays cancelled (owner: no $ UI).  Latency / delivery / keyboard items in that issue are not this slice.
