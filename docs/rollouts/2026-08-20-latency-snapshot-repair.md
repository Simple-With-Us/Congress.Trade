# Latency price snapshots: record-then-backfill, FMP removed

## 1. Context & Objective

The pipeline that measures whether a competitor's publication moves a stock recorded
**7 prices out of 2955 scheduled snapshots**.  2937 were `missed_window`; 11 were
`fmp_quote_http_402`.  It has effectively never worked.

## 2. The two root causes

**A. Every row was born stale.**  `scheduleMissingLatencyPriceSnapshots` builds rows
retrospectively from already-matched `trade_latency_candidates`, so `due_at` for
`ct_publish` and `provider_publish` is always in the past.  With `SNAPSHOT_STALE_MS` at
3 minutes the capture loop correctly refused to stamp a live quote and wrote
`missed_window`.  The cron was fine (`CT_COST_PROFILE=paid`, every minute) — the
*scheduling model* was wrong.

**B. The only price source was FMP**, which returned HTTP 402 in production and is now
banned fleet-wide for market data (owner ruling 2026-08-20).  It remains valid solely as
a latency-race competitor being probed — that measures a rival feed, it does not source
market data.

## 3. Changes Made

The fix collapses "schedule" and "capture" into one decision evaluated **per row, per
tick**: if `due_at` is within `SNAPSHOT_STALE_MS` of now, ask Socratic.Trade for a live
quote; otherwise ask for historical intraday bars and take the nearest bar at-or-after
`due_at`.  A row that misses its live window because a tick was delayed simply
reclassifies as backfill next tick, so `missed_window` has no way to recur.

- `app/src/ingestion/latencyPriceSnapshots.ts` — rewritten.  FMP deleted outright.
- `app/src/prices/peerMarketData.ts` (new) — ST peer client for quotes + intraday.
- `app/src/shared/marketSession.ts` (new) — session classification per row.
- `app/migrations/0090_latency_snapshot_repair.sql` + `app/src/admin/migrations.ts` +
  `app/src/admin/__tests__/migrations.test.ts` — the migration triple.
- `app/src/ingestion/tradeLatency.ts` — `ct_publish` scheduled inline at candidate mint,
  the one moment its anchor is genuinely "now".
- `app/src/ui/dashboardHtml.ts` — `+15m` rung label (owner asked for 5/15/60).

## 4. Decisions & Trade-offs

**A single empty response is not proof that nothing traded.**  This is the one that
matters.  Until ST PR #2959 is live, ST collapses *every* intraday failure — missing
credential, timeout, upstream 500 — into `200 {bars: []}`.  Terminating on the first
empty answer would let one ST-side hiccup convert the entire reopened backlog into
"confirmed no trading happened" at `CAPTURE_BATCH` rows/minute, and the due query
(`captured_at IS NULL`) could never re-select them.  That is the silent-blanking bug this
work exists to remove, re-entering through *deploy ordering* rather than through code.

So empty answers must **corroborate**: they increment `backfill_attempts` exactly like a
provider failure, and only become `confirmed_no_bars` after `MAX_BACKFILL_ATTEMPTS`.  A
genuine weekend or halt still terminates — over five ticks instead of one.  This removes
the human dependency on merging #2959 first.

**Bar closes are validated locally.**  ST does guarantee a positive finite close, but this
module declares that invariant and must therefore enforce it.  A null close would reach
`writeCaptured` as `price=null, error=null` — a row marked captured holding neither — and
would count as a success.

**The 11 `fmp_quote_http_402` rows are reopened too**, not just the 2937 `missed_window`
ones.  They carry an error naming a provider that is no longer a data source, and they are
now perfectly backfillable.

**Never a live quote for a past `due_at`.**  Enforced by the branch, not by a comment, and
guarded by a test that fails if a 10-minute-stale row ever triggers a quote fetch.

## 5. Verification State

```
cd app
npm run typecheck   # deno check -- clean, exit 0
npm test            # 273 files / 3414 tests passed
npm run lint        # 403 problems -- identical to baseline, zero added
```

## 6. Next Steps & Blockers

- **Apply the migration after merge.**  CT auto-deploy ships code but never schema;
  production schema comes only from `POST /api/admin/migrate` via `ship.sh`.  A schema PR
  merged normally goes live against the old schema — that caused an incident today.
- ST PR #2959 is still open.  This change no longer *depends* on it thanks to the
  corroboration rule, but its landing makes the empty-vs-failure distinction exact and
  lets `MAX_BACKFILL_ATTEMPTS` be reconsidered.
- `provider_window_start/end` remain unpopulated at match time (PR #2080 added the
  columns).  Populating them would let each snapshot record the probe bracket its
  timestamp came from.

## 7. Zero-Code Findings

Backfilled rows inherit the uncertainty of their source timestamp.  Competitor publication
times are probe-quantised — PR #2080 records the bracket, and until probe cadence tightens
a backfilled price is exact at an *imprecise* instant.  The confidence column records this
rather than letting the precision of a price imply precision of timing.
