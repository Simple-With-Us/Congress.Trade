# 2026-07-31 — Cron-lane split: staggered daily lanes (fix 45s deadline starvation)

> **Current shape (2026-08):** Deno Deploy is retired.  Production is Coolify
> paid (`* * * * *`) on Hetzner; the 45s Deploy free-tier deadline is
> historical.  The staggered lanes below are still the live daily split.

## Summary

The once-a-day job chain (FMP enrichment, price refresh, bulk R2 snapshot,
photo enrichment/bioguide, ticker backfill, retention sweeps) used to run
inside the 15-minute scheduled tick under a 45s deadline left over from the
Deno Deploy free tier. Provider-paced network lanes routinely blew that
deadline, and because the whole chain shared one KV date stamp, every lane
after the abort silently never ran that day — visibly: photo enrichment
(bioguideId/photos never filled) and the bulk R2 snapshot.

Each daily lane now has its own hourly cron window, KV date stamp, DB
singleton lock, and 10-minute deadline (`CT_DAILY_LANE_DEADLINE_MS`):

| lane                | window (UTC) | contents |
|---------------------|--------------|----------|
| `daily-market-data` | :07          | FMP/SEC enrichment, price refresh, peer share, telemetry, freshness |
| `daily-snapshot`    | :22          | bulk market-data snapshot to R2 (after market data, so it's fresh) |
| `daily-filer`       | :37          | photo enrichment / resolved_bioguide_id, ticker backfill |
| `daily-retention`   | :53          | retention sweeps + R2 usage summary (Pushover) |

The 15-min tick passes `includeDailyJobs: false`; the legacy combined entry
(`maybeRunDailyJobs`, Workers scheduled path + external runtime-tick) keeps
its original semantics (DAILY_KEY suppressor, budget chain-stop).

## Files changed

- `app/src/jobs.ts` — four lane functions with per-lane KV stamps
  (`jobs:daily:lastdate:<lane>`); `maybeRunDailyJobs` composes them.
- `app/src/deno/cronLanes.ts` — new: lane table, deadline resolution,
  guarded lane runner, cron registration.
- `app/src/deno/scheduledTick.ts` — `includeDailyJobs` pipeline option;
  tick singleton generalized to `acquireDenoCronSingleton`.
- `app/src/deno/main.ts` — registers lane crons when the internal cron is
  enabled; tick skips daily jobs.
- Tests: lane stamp independence, budget stamping, window policy, overlap /
  abort / error guards, includeDailyJobs flag (both ways).

## Verification

- Gates: `npm run typecheck` clean; `npm test` 1978/1978 (181 files).
- Prod: deploy after merge crash-looped on `Invalid cron name` (Deno.cron
  forbids `:` in cron names) — hotfixed in PR #1203 (`daily-lane <name>`).
  Redeployed container logs:
  `Daily lane crons registered: daily-market-data="7 * * * *" daily-snapshot="22 * * * *" daily-filer="37 * * * *" daily-retention="53 * * * *" deadlineMs=600000`
  and the first lane fired on schedule: `daily lane daily-retention ran in 826ms`.
  Health `ok/db/schema` throughout.

## Follow-ups

- Watch the 00:07/00:22 UTC lanes tomorrow for the first full market-data +
  snapshot run on the new windows (snapshot should log `bulk snapshot
  written: <day> N rows` — now with working R2 creds).
- If a lane ever needs a same-day re-run, delete its KV stamp
  (`jobs:daily:lastdate:<lane>` in deno_runtime_kv) and it refires on the
  next hourly window.
