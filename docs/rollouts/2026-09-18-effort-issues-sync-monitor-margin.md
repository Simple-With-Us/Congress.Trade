# 2026-09-18 - effort-issues-sync-monitor-margin

## Context & Objective

Sentry issue **FLEET-INFRA-23** (`https://jays-services.sentry.io/issues/7599456769/`)
regressed again at 2026-09-18T06:27Z as `Cron failure: ci-congress-trade-effort-issues-sync` /
`A missed check-in was detected`.  The daily effort-board mirror is not the
failure mode.  GitHub's `schedule` trigger for `.github/workflows/effort-issues-sync.yml`
is delivered hours late, so the 15-minute Crons margin is structurally
guaranteed to page every day.  Goal: stop that false page without changing
the sync cron, the sync script, or Coolify.

## Changes Made

Widened the Sentry Crons `checkin_margin` for workflow `Effort Issues Sync`
from 15 minutes to 600 minutes (10h), via a new per-workflow
`CHECKIN_MARGIN_OVERRIDES` map in `scripts/sentry-ci-report.py`.  Every other
monitor keeps the 15-minute default.  The workflow crontab (`12 6 * * *`) and
`scripts/sync-effort-issues.py` are unchanged.

Evidence:

- Monitor `ci-congress-trade-effort-issues-sync` (`c13f6926-890e-4f25-a372-2ecbcb319416`):
  crontab `12 6 * * *`, `checkin_margin` 15, `max_runtime` 60.  36 missed
  events since 2026-07-08.  0 users.  Every day misses at 06:27Z and
  auto-resolves when the late check-in lands (~10:29-13:35Z).
- Scheduled Actions runs (`gh run list --workflow effort-issues-sync.yml`)
  all start late on `ubuntu-latest`: 2026-09-17 11:33Z, 09-16 11:24Z,
  09-15 11:37Z, 09-14 12:36Z, 09-13 11:42Z (typical delay 4.3-6.4h).
  Worst in the retained window: 2026-08-31 13:35Z (~7h 23m after the
  06:12Z slot).  Retained scheduled conclusions are `success` or
  `cancelled` (10-minute job timeout).  No `failure`.
- Reporter already sends `in_progress` on `workflow_run` `requested`.
  `in_progress` cannot cover this: GitHub has not created the run yet at
  06:27Z.  Do not add a second in_progress path from this issue.
- Last OK 2026-09-17T11:33:37Z matches scheduled run `35216310736`.
  No 2026-09-18 schedule run existed at the 06:27Z miss.

Files touched:

- `scripts/sentry-ci-report.py` — `CHECKIN_MARGIN_OVERRIDES["Effort Issues Sync"] = 600`
- `scripts/sentry-ci-report-margins_test.py` — AST parse of the override + cron
- `STATUS.md` — handoff row
- `docs/rollouts/2026-09-18-effort-issues-sync-monitor-margin.md` — this note

Deliberately did not edit `docs/EFFORT-LOG.md`: sync-1 already holds
`effort-log-reconcile` on Congress.Trade.

## Decisions & Trade-offs

600 minutes matches Socratic.Trade #3194 / #3387 / #3389 and Autorotate #219
and sits above the measured 7h 23m worst delay while still paging ~16:12Z
if the daily sync never starts.  Effort-board mirroring is not
RTH-critical; a 4-7h GitHub delay still lands the same day.

Do not copy this onto 30-min macos iOS-ship crons (FLEET-INFRA-CC / DA / CX).
Those drop most ticks; a 100-105 minute margin already failed.

Deliberately NOT `"Fixes FLEET-INFRA-23"`: the live monitor already uses
slug `ci-congress-trade-effort-issues-sync`, but the 600-minute config only
upserts on the next scheduled check-in.  Resolve 23 after that monitor
lands `ok` under the 600-minute config.  Tomorrow 06:27Z will still miss
if this merges today, until ~11:xx upserts the new margin.

Out of scope: changing `effort-issues-sync.yml`, the sync script, raising
the 10-minute job timeout, adding a second `in_progress` path, and
dispatching this workflow.

## Verification State

```
python3 -m py_compile scripts/sentry-ci-report.py   # clean
python3 scripts/sentry-ci-report-margins_test.py
# MARGIN_PARSE_OK {'Effort Issues Sync': 600}
# EFFORT_SYNC_CRON_OK 12 6 * * *
```

Did not run product CI locally on this seat.  Hosted `CI` is the product
gate and is unchanged by a reporter-only edit.  Did not `workflow_dispatch`
`effort-issues-sync.yml`.  Did not PUT the Sentry monitor by hand; the next
scheduled check-in upserts the new margin.

## Next Steps & Blockers

1. Merge this PR.  Do not dispatch the sync to "verify".
2. Wait for the next scheduled run (GitHub typically ~10:29-13:35Z).
   Confirm monitor `ci-congress-trade-effort-issues-sync` upserts
   `checkin_margin: 600` and lands `ok`.
3. Ignore/resolve FLEET-INFRA-23 after that OK.  Do not rematch it with
   a second margin PR.
4. If a 06:12Z slot has no Actions run by ~16:12Z the same day, treat that
   as a real silent sync and page.
5. Follow-up (not this PR): several scheduled runs cancel at the 10-minute
   job timeout.  The reporter maps `cancelled` to check-in `ok`, so those
   days still close the miss.  Board drift on timeout days is a separate
   product question.

Blockers: none.  Reporter-only.  Extra-ship no (`ios-ship.yml` watches
`clients/ios/**` and itself only).  No Coolify.

## Zero-Code Findings

The sync script and board mirror were not the failure mode.  This is
GitHub schedule delivery vs a 15-minute Crons margin, the same class
Socratic.Trade #3194 already fixed for `Deploy freshness`.
