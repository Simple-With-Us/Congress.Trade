# 2026-08-13 — Drop inaccurate “Congressional” labels

## Summary

Executive-branch trades are in the default feed, analytics, and subscription corpus.  Product copy that said **Congressional** on those mixed surfaces was wrong.

Owner report: Directory → company drawer said **Congressional Activity**.  That heading is now **Activity**.  The same inaccuracy is gone from the Trends card, iOS company summary, Premium blurb, RSS channel, OG descriptions, and Terms.

## Files changed

- `app/src/ui/dashboardHtml.ts` — company drawer **Activity**; Trends **What Is Being Traded**; Premium “every disclosed trade”
- `clients/ios/CongressTrade/Views/Feed/TickerDetailView.swift` — **Trading Summary**
- `clients/ios/CongressTrade/Views/TrendsView.swift` — **What Is Being Traded**
- `app/src/ui/ogMeta.ts` — company / politician / Trends descriptions
- `app/src/delivery/rest.ts` — RSS channel title + description
- `app/src/ui/legalHtml.ts` — “public financial disclosures”
- `scripts/og-card.html` — default card label
- tests pin the drawer heading and RSS/OG strings

Left alone on purpose: latency-probe copy about providers’ Congressional APIs, and code comments that really mean House + Senate.

## Verification

- `npm run typecheck`
- focused vitest: `dashboardHtml`, `ogMeta`, `legalHtml`, `feedXml` (282 tests)

## Follow-ups

None.  Filter-bar work is not in this slice.  Last owners of requested web-filter changes were Antigravity (#1823 default filter state), Monet (Aug 8 toolbar/filter chrome), and Claude (Aug 9 punchlist).  All three lanes are already completed.
