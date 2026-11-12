# Probe-run brackets: competitor publish time becomes a bounded interval

## 1. Context & Objective

Socratic.Trade is evaluating an ultra-short-term lane that would buy when CT
publishes a filing and sell into the copycat flow that arrives when a COMPETITOR
feed (fmp / quiver / unusual_whales) publishes the same filing.  That strategy
needs one number CT does not currently have: when the competitor published.

While diagnosing the price-snapshot pipeline it turned out the existing "lead"
figures are an artifact of our own polling, not a measurement of anyone's
publication time.  This change makes the uncertainty explicit instead of hiding
it.

## 2. Changes Made

`trade_provider_observations.first_observed_at` is when WE noticed a competitor
carrying a filing.  Read as a publication time it silently credits us the entire
probe interval as lead.  The honest statement is an interval: if the probe at T
finds a row the probe at T_prev did not, the competitor published in
(T_prev, T].  Getting T_prev requires recording probes that found NOTHING, since
those are exactly the ones that establish the lower bound.

- `app/src/ingestion/probeRunLog.ts` (new) — durable probe-run recording,
  `detectionWindow()` and `boundedLeadSec()` as pure functions.
- `app/src/ingestion/tradeLatency.ts` — records every probe outcome via the
  existing `recordHandoff` seam; stamps `prev_probe_at` on newly inserted
  observations.
- `app/src/admin/migrations.ts` + `app/migrations/0089_probe_run_brackets.sql` —
  `provider_probe_runs` table, `prev_probe_at`, `provider_window_start/end`.
- `app/src/ingestion/__tests__/probeRunLog.test.ts` (new) — 7 tests.
- `app/src/admin/__tests__/migrations.test.ts` — registered the new statements.

## 3. Decisions & Trade-offs

- **Only `kind === 'success'` sets `ok = 1`.**  A skipped, unconfigured or failed
  probe never observed the competitor's state, so it cannot bound anything.
- **Ordering is load-bearing.**  `previousSuccessfulProbeAt` is read BEFORE the
  current run is recorded.  Recording first would make a run its own predecessor
  and collapse every bracket to zero width — a fictional perfect measurement.
  Verified at all three `upsertProviderRows` call sites.
- **Clock skew degrades to unbounded, never to zero.**  The Mac scout and the
  server both write timestamps.  `prev >= end` returns `unbounded` rather than
  clamping, because zero width is the strongest possible claim.
- **Pre-existing rows keep NULL windows** and report as `unbounded` rather than
  being retroactively credited with precision they never had.
- **Chamber sentinel `'*'`.**  A provider probe fetches one "latest" feed
  spanning whatever chambers it carries, so a run is recorded once; the lookup
  matches the specific chamber or the sentinel.

## 4. Verification State

```
cd app
npm run typecheck   # deno check src/deno/main.ts -- clean
npm test            # 270 files / 3346 tests passed
npm run lint        # 403 problems, all pre-existing; probeRunLog.ts lints clean
```

The lint count differs by one from the integration worktree only because that
tree is on `382c65e1` while this branch forks `891bb5a5`; a per-file diff of
lint problems between the two shows no difference.

## 5. Next Steps & Blockers

This records the bracket.  It does not yet CONSUME it:

1. Propagate the window onto `trade_latency_candidates`
   (`provider_window_start/end` are added but not yet populated at match time).
2. Replace the dashboard's point `avgLeadSec` / `medianLeadSec` with the bounded
   range, and exclude `unbounded` rows from any speed claim.
3. Tighten cadence.  The bracket is only as useful as it is narrow; quiver and
   unusual_whales currently sit at `interval=1800s`, `tier=low`, and both lanes
   are leased to `mac-jays.services`, which sleeps.

Blocker for the trading use-case, unchanged by this PR: no competitor exposes
its own publication timestamp.  FMP's `disclosureDate`, Quiver's `Filed` and
UW's `filed_at_date` are all the GOVERNMENT filing date at day resolution.
Polling is the only detection mechanism available.

## 6. Zero-Code Findings

Measured on production (`/data/congress-trade/db.sqlite`, 2026-08-16..19):

- `latency_price_snapshots`: 2955 rows, 7 with a price.  2937 `missed_window`,
  11 `fmp_quote_http_402`.  Snapshots are scheduled retrospectively so `due_at`
  is always in the past and the 3-minute staleness guard correctly refuses.
- `provider_published_at` is NULL for 600/600 matched rows.
- Quiver and unusual_whales both report leads of exactly 68.28h and 147.28h
  across dozens of rows — identical to two decimals across two independent
  vendors, which is our probe schedule showing through.
- Owner ruling 2026-08-20: FMP must never be used for market data.  It remains
  valid as a latency-race competitor being timed.
