# 2026-09-03 — Stop twice-hourly Congress.Trade TestFlight spam

Seat: GROK.  Branch `grok/ios-ship-schedule-gate`.  Worktree `~/apps/congress-grok-ios-ship-gate`.  Board `f9d5c319`.  Issue #2302.

## What happened

Owner was working on BotFleet, not Congress.Trade, and TestFlight kept getting new Congress.Trade iOS versions (latest **1.0.222** from cron at 2026-09-04T00:17Z).  BotFleet's own hourly TestFlight job is failing on missing `APPLE_API_*` secrets, so it never uploaded.

`ios-ship.yml` runs on ephemeral `macos-latest`.  `scheduled-ship-gate.sh` treated a missing `~/.cache/ios-fleet/last-ship-congress.txt` as `should_ship=1`.  Every `:07`/`:37` cron tick looked like a first ship and archived.  Socratic.Trade already restores that directory via `actions/cache`; this repo forbids GitHub Actions cache storage (`check-actions-runner-policy.mjs`).

## Immediate

Workflow `iOS TestFlight ship (Mac runner)` is `disabled_manually` so the next cron cannot upload.  Re-enable after this lands.

## Code

Scheduled ticks with no last-ship file now skip.  A real ship is a `push` that passed `paths:` (`clients/ios/**`) or an explicit `workflow_dispatch`.

## Verify

```
bash scripts/ios-fleet/test-scheduled-ship-gate.sh
node --test scripts/ios-ship-workflow.test.mjs
node scripts/check-actions-runner-policy.mjs
```
