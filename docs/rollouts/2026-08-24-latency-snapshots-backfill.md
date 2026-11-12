# 2026-08-24 — ANTIGRAVITY — COMPLETED / PR OPEN — Latency Snapshots Pre-Publish and Sweeping Backfill

## Context & Objective
The user requested adding pre-publish historical pricing (`-30m`, `-15m`) and a sweeping backfill (`+12h`) to the competitor latency price snapshots. The user also explicitly directed that the time offset array should be based on `provider_first_seen_at` (the time we observed the competitor's publishing) rather than `provider_published_at` (the time the competitor claimed they published it). 

## Changes Made
- Modified `app/src/ingestion/latencyPriceSnapshots.ts` to include `provider_minus_30m`, `provider_minus_15m`, and `provider_plus_12h` in the `FOLLOW_EVENTS` array.
- Updated the `providerAt` logic in `snapshotPlan` to prioritize `provider_first_seen_at`. `provider_published_at` is now only used as a fallback. 
- Modified the `confidence` generation logic so that it assigns `'bracketed'` confidence based on the observation window (`provider_window_start`/`end`) instead of falling back to `'exact'` when `provider_published_at` is available.
- Updated `summarizeProviderPublishBump` query to group the new `FOLLOW_EVENTS`.
- Updated unit tests in `app/src/ingestion/__tests__/latencyPriceSnapshots.test.ts` to reflect the new expected `FOLLOW_EVENTS` and the shift from exact to bracketed confidence for observation-based offset arrays.

## Decisions & Trade-offs
- Since `provider_first_seen_at` is now the anchor for the price snapshot timeline, the snapshots accurately reflect the reality of when the information was *observable* rather than when the competitor *claimed* it was available.
- The 12-hour sweeping backfill now actually sweeps the latency snapshot tables! Added migration 0095 to track swept rows and `captureDueLatencyPriceSnapshots` resets errors to NULL for any row 12+ hours old.
- The user's request for "1-5 min scraping frequency" is already fulfilled by the existing `Deno.cron` `* * * * *` setup (1 min), so no cron infrastructure was modified.
- Left the missing `LEFT JOIN trade_latency_candidates` in `app/src/delivery/rows.ts` alone, as the user's latest prompt focused strictly on the price snapshots and backfill architecture. If the user wants the data sync, that will be a separate targeted PR.

## Verification State
- `deno check src/deno/main.ts` — passed
- `npm run lint` — existing codebase issues, my changes introduced no new errors.
- `vitest run src/ingestion/__tests__/latencyPriceSnapshots.test.ts` — passed (23/23 tests)

## Next Steps
- Merge this PR.
- Coordinate with the ST codebase to consume the new `-30m`, `-15m`, and `+12h` snapshot keys from the `latency_price_snapshots` table if they need to surface them in their UI or modeling. 
