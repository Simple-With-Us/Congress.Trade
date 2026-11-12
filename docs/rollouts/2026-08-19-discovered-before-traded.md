# Discovered stamp cannot predate the trade

## Summary

Public "Seen" / `firstSeenAt` was `filings.first_seen_at`: the watcher
`INSERT OR IGNORE` time for that DocID.  House live search can list a
DocID before the official FilingDate, and before later trades that land
in the same PDF.  The UI then claimed we discovered a trade before it
happened.

Live proof: Kevin Hern `H-2026-20035134` — first-seen
`2026-07-30T15:32:12.565Z`, traded `2026-08-05`, filed `2026-08-10`,
imported `2026-08-11T13:06:49.836Z`.

Read-path only.  Use filing first-seen when it is on/after the trade
date; otherwise use persist `created_at` when that stamp is on/after the
trade date; otherwise omit.  Stored rows are not rewritten.

## Files changed

- `app/src/delivery/tradeLearnedAt.ts` — clamp helper
- `app/src/delivery/rows.ts` — `mapFeedTransaction`
- `app/src/analytics/routes.ts` — ticker/member recent trades
- `app/src/ui/dashboardHtml.ts` — `seenRaw` skips dates before `txdate`
- `app/src/shared/types.ts` — `firstSeenAt` comment

## Verification

- `cd app && npm run typecheck && npm test`
- Feed row for Hern `H-2026-20035134` / `2026-08-05` must not show
  July 30 as Seen.

## Follow-ups

- Filing-object `firstSeenAt` stays the raw DocID listing time (not a
  per-trade claim).
- No iOS source change / no TestFlight from this seat.  Client API
  `filing.firstSeenAt` follows the feed mapper.
