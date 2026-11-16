# 2026-09-18 - ci-backstop-cron-map

## Context & Objective

Sentry **FLEET-INFRA-BJ** (`sentry-ci-report has no CRON_SCHEDULES entry for scheduled workflow
'CI' [congress-trade]`, tag `drift: unmapped-schedule`) fired once per scheduled CI run since
2026-08-13 (about 400 events, level warning) and had been archived forever, which hid a real
configuration gap rather than resolving it.  `.github/workflows/ci.yml` carries an hourly
`23 * * * *` backstop tick, but the reporter's `CRON_SCHEDULES` mapped only Effort Issues Sync,
Security and Shared Package Pin Check, so a silently dead CI backstop would never have raised a
missed-check-in alert.  Goal: map it without creating a monitor that pages on healthy runs.

## Changes Made

- `scripts/sentry-ci-report.py`: `CRON_SCHEDULES["CI"] = "23 * * * *"` and
  `CHECKIN_MARGIN_OVERRIDES["CI"] = 600`.
- `scripts/sentry-ci-report-margins_test.py`: asserts both.
- `.github/workflows/sentry-ci-report.yml`: header comment lists the new mirrored schedule.
- `STATUS.md`: handoff row.

Not touched: `ci.yml` (cron and schedule-gate unchanged), the observed-workflow list (CI was
already observed), Coolify, and Sentry issue state.

## Evidence

`gh run list -R jaywedgeworth22/Congress.Trade --workflow ci.yml --event schedule --limit 60`
(2026-09-08 09:50Z to 2026-09-18 16:33Z): 60 runs, all `success`.  Gap between consecutive
scheduled runs: median about 260 min, p90 about 347 min, worst about 467 min.  GitHub is not
honouring the hourly cadence, so this is dispatch latency on GitHub's side, not a broken job.
Usage-Monitor hit the same platform behaviour (FLEET-INFRA-CA) and uses a 480 min margin; 600
matches Socratic.Trade #3387 / #3389 and covers the worst observed gap with headroom.

## Verification

- `python3 -m py_compile scripts/sentry-ci-report.py`
- `python3 scripts/sentry-ci-report-margins_test.py` prints `MARGIN_PARSE_OK`, `EFFORT_SYNC_CRON_OK`,
  `CI_CRON_OK`
- `find_cron_schedule_drift()` against the real workflow `name:` values returns no stale keys.

## Decisions & Trade-offs

Mapping the schedule creates the Sentry monitor `ci-congress-trade-ci`, upserted on the next
scheduled check-in.  A wide margin is deliberate: with a tight one this would page on nearly
every tick (see FLEET-INFRA-CA).  The trade-off is that a CI backstop that stops firing is only
caught after 10h, which is fine for a defence-in-depth tick that runs alongside real push and
pull request CI.

Deliberately NOT `Fixes FLEET-INFRA-BJ`: the issue is archived forever and the fix only takes
effect on the next scheduled check-in.  Leave the archive in place; once
`ci-congress-trade-ci` lands an `ok` check-in the drift events stop on their own.

## Rollback

Revert this commit.  The drift warning returns; the monitor (if already upserted) can be paused
or deleted in Sentry Crons.
