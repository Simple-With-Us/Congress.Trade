# Latency Lead / Lag wording + live-race window

## Summary

Filing Latency Comparison was calling FMP and Unusual Whales a preliminary
lead while the average was days later.  The cards now say **Lead** or **Lag**
only when median and average agree, **Mixed** when they split, and paint
earlier green / later red on the median and average lines.

The 12 FMP "losses" were not same-day races.  They were House PTRs filed
2026-07-14–27 and first_seen in one 2026-08-11 22:35Z reimport batch
(15–18 days after filed).  Live-import lag is now 7 days, so that crawl
does not score as us being behind.

## Files changed

- `app/src/ui/dashboardHtml.ts` — Lead/Lag/Mixed badge, colored earlier/later
  in the subtitle, scope N of M from `totals.scopeMatched` or `scope`.
- `app/src/analytics/routes.ts` — publish `totals.scopeMatched` / `scopeTotal`.
- `app/src/ingestion/tradeLatency.ts` — `LATENCY_LIVE_FILING_MAX_LAG_DAYS` 21 → 7.
- iOS `TrendsView.swift` / `Models.swift` — same badge and coloring.

## Verification

- `npm run typecheck` clean.
- `npm test` 3052/3052.
- iOS latency scorecard tests green.

## Follow-ups

- Remaining real lags (Senate Tuberville MCD ~18h, UW Peters ~51h, Fetterman
  ~3h) are live races, not matching bugs.  Match method is almost all
  `trade-hash`.
- Scope still ~33% (172 of 513) because many provider rows have no live CT
  counterpart in the 14-day window.  That is coverage, not a join bug.
