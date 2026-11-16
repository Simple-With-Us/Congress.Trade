# 2026-11-12 — ios-ship seeds last-ship state without actions/cache

Seat: CURSOR.  Branch `gb-compiler/ct-2512-last-ship-seed`.  Linear [CT-2512](https://linear.app/simple-with-us/issue/CT-2512).

## Summary

Hosted macos-latest runners start with an empty `~/.cache/ios-fleet`, and this repo forbids `actions/cache`.  A scheduled ios-ship tick with no last-ship file skips, so the cron that exists to catch bot-merged iOS commits never ships.  Push runs also had no same-HEAD or rate-gate state.

`ios-ship.yml` now writes `last-ship-congress.txt` before the scheduled gate and the ship script, using the previous successful run of ios-ship itself.  The shared helper `scripts/ios-fleet/seed-last-ship.sh` also replaces the inline seed in `ios-appstore-gm.yml`.

A green ios-ship skip is a successful workflow run.  Seeding that run's timestamp would make the 1 hour rate gate block every push.  The ios-ship call passes `--require-upload`: a run counts only when its ship step succeeded and lasted at least 60 seconds, and runs shorter than 180 seconds are not looked up.  The GM workflow still takes the newest success, because a skip fails that job.

No `actions/cache`.  No PATH change.  No ship-flag change.  No `--force-ship`.  This change does not dispatch a ship.

## Files changed

- `.github/workflows/ios-ship.yml` — `actions: read`, and a seed step before the scheduled gate
- `.github/workflows/ios-appstore-gm.yml` — the same helper, newest success only
- `.github/workflows/ci.yml` — the helper's syntax check and tests
- `scripts/ios-fleet/seed-last-ship.sh`
- `scripts/ios-fleet/seed-last-ship.mjs`
- `scripts/ios-fleet/seed-last-ship.test.mjs`
- `scripts/ios-fleet/test-seed-last-ship.sh`
- `scripts/ios-ship-workflow.test.mjs`

## Verification

```
node --test scripts/ios-fleet/seed-last-ship.test.mjs scripts/ios-ship-workflow.test.mjs
bash scripts/ios-fleet/test-seed-last-ship.sh
actionlint .github/workflows/ios-ship.yml .github/workflows/ios-appstore-gm.yml .github/workflows/ci.yml
node scripts/check-actions-runner-policy.mjs
```

## Follow-ups

Merging this workflow file to main starts ios-ship, because `.github/workflows/ios-ship.yml` is on the push path filter.  Do not dispatch that run from the PR.

If the last real upload is older than 50 pages of successful runs, the seed writes nothing and the scheduled tick skips.  That is the safe side.
A failed Actions lookup warns and leaves the file unwritten.  It does not report that there was no previous upload.
