# 2026-10-06 — Freshness watchdog for ST import streams

## 1. Context & Objective

Board `71a3e821`.  PR #2635 (`gb-compiler/ct-freshness-streams`) extends the daily freshness watchdog so insider, short-volume, and imported analyst consensus cannot go quiet without an admin email.  The first cut also watched a `securities_ref.price_checked_at` proxy and treated a null latest as stale.  Both of those were wrong: the proxy follows our own price job, and a null latest pages forever because the alert throttle is 12 hours, not a stop.

## 2. Changes Made

- `app/src/share/freshness.ts` watches `insider`, `shortVolume`, and `analyst` (`MAX(updated_at)` where `source = 'imported'`).  Thresholds stay 5 / 5 / 8 days.  Null latest is skipped.  A real timestamp past the threshold still pages.  `refEnrichment` is gone.
- `app/src/share/__tests__/freshness.test.ts` covers the skip, the empty price cohort, the threshold boundaries, and that the SQL does not read `price_checked_at`.
- `app/migrations/0102_freshness_stream_indexes.sql` and `FRESHNESS_STREAM_INDEX_SCHEMA_STATEMENTS` in `app/src/admin/migrations.ts` add `idx_insider_eod_date`, `idx_short_volume_eod_date`, and `idx_analyst_consensus_source_updated`.  `0100` and `0101` are other open lanes.
- `app/src/admin/__tests__/migrations.test.ts` asserts those statements and that `EXPLAIN QUERY PLAN` uses them for the three `MAX()` queries.
- `docs/EFFORT-LOG.md` records the tip.

`npm run build` is not defined.  This is a Coolify Deno app.

## 3. Decisions & Trade-offs

- Did not add `imported_at` on `securities_ref`.  `price_checked_at` is written by `app/src/prices/service.ts` on every priced ticker, and `IMPORT_SECURITY_REF_SQL` sets `source` only on insert.  A real import clock belongs with PR #2638, not this watchdog.
- Did not page on null.  An empty table is a partner that has not sent a row yet.  Paging it emails admins twice a day until something lands.  A push that stops leaves a frozen date, and that date still ages out.
- Analyst index is `(source, updated_at)`, not `updated_at` alone, so the `source = 'imported'` filter and the `MAX` are one seek.
- Did not rewrite the static SQL into Prisma.  This app does not use Prisma.  The fragments are literals.  `'imported'` is a constant.

## 4. Verification State

From `app/` on 2026-10-06, worktree `/workspace/ct-2635-tip`:

```bash
npm run typecheck
# exit 0 (deno check src/deno/main.ts)

npm test
# exit 0 — 327 files / 4315 tests
```

`EXPLAIN QUERY PLAN` on an in-memory SQLite database (migrations test) uses `idx_insider_eod_date`, `idx_short_volume_eod_date`, and `idx_analyst_consensus_source_updated` for the three new aggregates.  No `build` script.

## 5. Next Steps & Blockers

1. Squash-merge #2635 when CI is green.  Coolify applies schema through `POST /api/admin/migrate` (`bash app/scripts/ship.sh`), which includes the same three `CREATE INDEX IF NOT EXISTS` statements.
2. PR #2638 still owns import-received timestamps.  This PR does not.
3. No `#agent-sync` permalink was recorded.  This seat had no Slack token, and the suggested channel id was not `C0BEZDJDNKV`.

## 6. Zero-Code Findings

- `gb-compiler/ct-freshness-streams` was mergeable with `main` and was not rebased.
- The Kody Prisma-SQL note does not match this stack.  Queries go through the D1 helper, and the new SQL does not interpolate input.
- The Kody coordination note asked for a receipt that was not posted.  Inventing one would have been a false log line.
