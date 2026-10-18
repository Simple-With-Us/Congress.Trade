# 2026-10-17 — Congress.Trade iOS auto-ship re-enabled

Seat: CLAUDE.  Branch `claude/ios-autoship`.  Linear CT-2419 (Refs).

## 1. Context & Objective

Owner goal (2026-10-17): a merge to `main` that touches the iOS native tree uploads a fresh TestFlight build with no human step.

An audit found that this did not happen.  `iOS TestFlight ship (Mac runner)` (`ios-ship.yml`) had been `disabled_manually` since 2026-09-27 2:36am, first for the twice-hourly spam fix (`docs/rollouts/2026-09-03-ios-ship-schedule-skip.md`, which says "Re-enable after this lands") and then for the ASC signing-loader credential hold (Fleet-OPS #37, OPS-13).  The newest TestFlight build was 1.0.235 (sha `8fe264f9`), shipped by a manual `ios-appstore-gm.yml` dispatch on Oct 10.  Five commits touching `clients/ios/**` have merged since (`fca4ffe8`, `9fff68a3`, `a1061371`, `e2e24185`, `fa262cea`).

## 2. What was already right

`ios-ship.yml` already has every piece of the fleet auto-ship pattern, so its triggers and steps are not changed:

- `push` to `main` with `paths: clients/ios/**` and the workflow file, plus `workflow_dispatch`.
- A scheduled catch-up that is behind `scripts/ios-fleet/scheduled-ship-gate.sh` (path gate).
- `fetch-depth: 0`, a stable-Xcode assertion, `IOS_TF_RELEASE_NOTES: "1"`, and no standing `IOS_TF_MIN_INTERVAL_SEC` or `--force-ship`.
- ASC key and issuer from Fleet Secrets prod `/asc`, certificates from the Congress.Trade Infisical project, then `scripts/ios-ship-testflight.sh` (which runs `ship-testflight.sh` and `ensure-tf-ready`).

The other three audit findings were fixed by #2782 before this change: the standing `IOS_TF_MIN_INTERVAL_SEC: "0"` is gone from `ios-appstore-gm.yml`, it publishes What to Test, and the `Released:` line is `Sat, Oct 10, 2026 at 11:01pm` (owner clock, 12-hour, lower-case am or pm, no timezone abbreviation).

## 3. Why it is safe to re-enable

- The signing path was proven on hosted macOS after the loader repair: GM run 38109906462 (Oct 10) archived, signed through the ASC API key and uploaded 1.0.235 with credentials from Fleet Secrets `/asc`.
- The loader fixes landed (#2582, #2586, #2692, #2703) and Socratic Trade's `ios-ship` has been active since Sep 30.
- Owner ruling 2026-10-17: the `/asc` key is usable by any app, and the owner asked for TestFlight to update automatically.
- Preconditions checked by name and length only: Congress.Trade Infisical prod has `SENTRY_DSN`, `IOS_DIST_P12_BASE64` and `IOS_DIST_P12_PASSWORD`; Fleet Secrets prod `/asc` has `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_KEY_P8`.

## 4. Changes Made

- `.github/workflows/ios-ship.yml`: header comment only.  It said "owned Mac runner" and "mac-runner labels" while the job has run on `macos-latest` since #2198.  It now states the auto-ship contract and why the runner is hosted (the owned Mac is a macOS 27 beta that App Store review rejects as `INVALID_BINARY`).
- `scripts/ios-ship-workflow.test.mjs`: three new checks.  The push trigger covers the native tree and not backend code, dispatch exists, a schedule is allowed only behind the scheduled path gate, `fetch-depth: 0`, notes on, ASC from `/asc`, and neither ship workflow carries a standing gate override or a hard-coded `--force-ship`.
- Repo setting, not code: `gh workflow enable ios-ship.yml`, done after this PR merges so the merge push cannot start a run with older code.

## 5. What is inert on a hosted runner

Hosted runners start with an empty home and this repo forbids `actions/cache` (`check-actions-runner-policy.mjs`), so there is no last-ship state:

- The ship script's rate gate (`DEFAULT_MIN_INTERVAL_SEC=3600`) and same-HEAD skip never fire, so every push that passes `paths:` ships once.
- The `7,37 * * * *` cron skips every tick by design, so it is not a retry path.  A failed ship is retried by a new iOS merge or `gh workflow run ios-ship.yml`.
- The What to Test range is the HEAD subject only, which for a squash merge is the PR title.

`ios-appstore-gm.yml` already seeds this state from its previous successful run (#2782).  Doing the same for `ios-ship.yml` would make the gates and the catch-up live, but a skipped run is also "success", so it needs a durable ship marker (for example a small uploaded artifact).  That is a separate change.

## 6. Verify

```
node --test scripts/ios-ship-workflow.test.mjs
bash scripts/ios-fleet/test-scheduled-ship-gate.sh
node scripts/check-actions-runner-policy.mjs
gh workflow view ios-ship.yml --repo Simple-With-Us/Congress.Trade
git show --name-only fca4ffe8   # four files under clients/ios/** match the push filter
```

## 7. Rollback

`gh workflow disable ios-ship.yml --repo Simple-With-Us/Congress.Trade` stops all automatic ships.  `ios-appstore-gm.yml` stays the manual path.

## 8. Follow-ups (not in this change)

- The `Released: ... PM CT` stamp is still in the runtime `/Users/jay/apps/ios-fleet/asc-api.mjs` and the vendored copies in Socratic-Trade, Usage-Monitor and DealDex.  Port the #2782 fix there.
- `DEFAULT_MIN_INTERVAL_SEC` is 3600 in the script while the fleet note says 2.5 hours.  Changing the standing limit is the owner's call.
- Do not widen `paths:` to ship tooling; a tooling commit changes no app behavior and would only add TestFlight builds.
