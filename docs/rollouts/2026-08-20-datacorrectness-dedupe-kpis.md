# 2026-08-20 — Dedupe trades, stop fabricating competitor brackets, stock-only $ KPIs

## Summary

Monet 2026-08-19 DATACORRECTNESS-01 / 02 / 10 (issue #2032, PR #2037).  The same real-world trade now counts once in analytics and the public feed.  Competitor backfill rows no longer publish a fabricated $1,001–$15,000 bracket or `filed_date = tx_date`.  Headline Net Flow / Approx. Volume / ticker net-flow are stock-only, with an `incl. N option trades` footnote.  Largest Buys / Largest Sells stay gone.

## Files changed

- `app/src/shared/tradeIdentity.ts` — canonical key, source precedence, publish sanitizer
- `app/src/analytics/sql.ts` / `builders.ts` / `routes.ts` — twin guard, stock-only $ KPIs
- `app/src/delivery/rows.ts` — same twin guard + sanitizer on the feed
- `app/src/ui/dashboardHtml.ts` — "bracket unavailable" + option footnote
- `app/scripts/inject_competitor_data.ts` — stop minting default brackets / filed dates
- Tests under `app/src/analytics/__tests__/`, `app/src/shared/__tests__/`, `app/src/delivery/__tests__/`

## Verification

`cd app && npm run typecheck && npm test`

Fixture: Fleischmann TSCO manual + primary + competitor_backfill counts as 1.  Summary net flow without `excludeOptions` matches the stock-only figure.

## Follow-ups

MANUAL-* phantom filers (DATACORRECTNESS-03/04/05) are not merged in this PR.  Existing competitor rows already in production still carry fabricated columns on disk; the publish path nulls them until a later hygiene job rewrites the table.
