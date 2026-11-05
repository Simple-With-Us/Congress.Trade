# Peer-price catch-up: decoupled lane + no-engagement accounting (2026-11-04)

## Summary

The Socratic.Trade peer-price backlog (712 tickers) stayed frozen for ~49 hours across the Nov 4 ST outage and did not drain on the first hourly tick after ST recovered (7:42 PM CST; the 8:07 PM tick still showed `lastProgressAt` at Nov 3, 12:59 AM CST and produced no lane completion line).  Two defects in the CT-2445 catch-up design caused the freeze:

- The bounded catch-up (`maybeRunPeerPriceCatchUp`) was reachable only from the market-data lane's stamped fast path.  A full lane that cannot complete inside its deadline never stamps the day, so on any day where the full pass cannot finish, the drain never engages at all.
- The catch-up's session accounting treated an outage as a coverage verdict.  An ST 503 is non-fatal per ticker, so during the outage every catch-up run "completed" having priced zero tickers.  Completed no-progress runs count toward the no-progress park (2 per freshThrough session) and spend the session run budget (8 per session), so by the time ST recovered, the session was parked and budgeted out.  A gated catch-up returns `stamped`, which the cron logger deliberately does not log — matching the observed silent tick.

The fix has two parts.  The catch-up now also runs from its own hourly cron lane (`peer-price-catchup`, :17), with its own DB singleton lock and 10-minute deadline via `runDailyLane`, independent of the market-data lane's stamp; the existing KV gate (55-minute spacing, per-session bounds) makes a not-due tick a cheap no-op.  And a completed run that priced zero tickers while recording provider errors is now classified as a no-engagement run: like an aborted run it does not count toward the park, and it hands its session claim back instead of spending the run budget.  Aborted runs (429, deadline, throw) keep the existing accounting, and engaged runs that merely fail to shrink the pending count still park as before.

## Files changed

- `app/src/deno/cronLanes.ts` — new `peer-price-catchup` daily lane at `17 * * * *` calling `maybeRunPeerPriceCatchUp` with the lane abort signal.
- `app/src/jobs.ts` — `maybeRunPeerPriceCatchUp` captures the refresh result, classifies the no-engagement signature (`tickersPriced === 0`, errors present, not aborted), passes `failed`/`spendRun` into the after-run accounting, and logs `providerNeverEngaged`.
- `app/src/prices/peerPriceCatchUp.ts` — `peerPriceCatchUpAfterRun` accepts `spendRun`; a no-engagement run refunds the claimed run count.  Bounds doc updated.
- Tests: `app/src/deno/__tests__/cronLanes.test.ts` (seven lanes, lane mapping, catch-up lane runs independently, catch-up lane respects the singleton lock), `app/src/__tests__/jobs.test.ts` (503-outage runs neither park nor spend; spacing still applies; recovery slot drains immediately; per-run bound still `max: 301`), `app/src/prices/__tests__/peerPriceCatchUp.test.ts` (claim refund semantics).

## Verification

- Targeted suites: `jobs.test.ts`, `cronLanes.test.ts`, and `peerPriceCatchUp.test.ts` pass (56 tests).
- Full `npm test` and `npm run typecheck` results are recorded in the PR body.
- Production confirmation after deploy: `/api/health` `st_peer_prices` should show `lastProgressAt` advancing and the pending count falling on the next :07/:17 ticks after ST is reachable, without waiting for a freshThrough session roll.

## Follow-ups

- The market-data stamped fast path still calls the catch-up as well.  It is redundant with the dedicated lane but harmless (the KV gate dedupes), and removing it is a separate cleanup.
- No-engagement runs still run the first-claim EOD-to-current-price backfill scan, because the claim presents as run 1 each time until a run engages.  The scan is NULL-only and idempotent; revisit if it shows up in lane timings.
