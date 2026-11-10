# Terminal peer-price tickers

## Summary

The `st_peer_prices` stall clock is `MAX(price_checked_at)` over tickers that still need an end-of-day price.  CPXWF, SGEN, and SPLK were that whole pending set, so the lane and top-level `/api/health` stayed stalled for about 80 hours.  SGEN and SPLK stopped trading years ago.  A last trade that old is now a terminal row: reason and timestamp stored on `securities_ref`, excluded from pending and from the stall clock, and still counted on the health check.  A ticker that is only a session or two behind stays pending, and a real pending ticker still stalls the lane.

The classifier uses data the app already stores. It does not call a new vendor, and it does not read FMP. `acquired` is a reason the parser accepts. Nothing in this change emits it, because there is no acquisition feed.

## How a ticker becomes terminal

Stage `price_unavailable = 5`. The reason text is `terminal since YYYY-MM-DD: <reason> (last trade YYYY-MM-DD)`.

- `no_longer_trading` when `latest_price_date`, or the newest close Socratic.Trade just returned, is strictly more than 90 days before the last completed session.
- `delisted` when that same age is true and the row is already on the repeat not-found stage (Socratic.Trade returned empty history twice).
- A one-session lag, a 14-to-90-day halt, and a ticker with no last trade stay on the existing pending, stage-3, or not-covered paths.
- The sweep runs only when the EOD corpus itself is current, so an outage that ages every ticker together does not terminalize the universe.
- The daily re-check still retries terminal rows. An empty or stale answer keeps stage 5 and the original since-date. A fresh close clears the stage.

## Files changed

- `app/src/prices/service.ts` — stage 5, the 90-day rule, and the refresh write path
- `app/src/prices/terminalListing.ts` — sweep and the health query
- `app/src/prices/stPeerPricesHealth.ts` — terminal count, sample, and reason on the check
- `app/src/prices/notCovered.ts` — daily re-check includes stage 5 without returning it to pending
- `app/src/jobs.ts` — sweep before the price refresh, and on the catch-up lane even when that lane is parked
- `app/src/ui/client/dashboard.js` — No Longer Trading row
- `clients/ios/CongressTrade/Models.swift` and `SettingsView.swift` — the same count

No schema change. Stage 5 reuses `price_unavailable` and `price_unavailable_reason`. This change does not write production data.

## Verification

From `app/`: `npm run typecheck` and the peer-price tests, including `src/prices/__tests__/terminalListing.test.ts`.

After deploy, `/api/health` `st_peer_prices.value.terminal` counts the rows, `pending` no longer includes them, and a new real gap still reports `stalled`.

## Follow-ups

CT-2429 (30-day re-entry budgeting) is unchanged. CPXWF's last close is 2026-11-05, one session behind `freshThrough` 2026-11-06, so this rule does not mark it terminal.
