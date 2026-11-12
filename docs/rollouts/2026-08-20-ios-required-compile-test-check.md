# 2026-08-20 — iOS compile + XCTest is a failing CI check

## Summary

Monet **IOSENGINEERING-14** (review finding #27): iOS CI was compile-only and
advisory.  `.github/workflows/ios-build.yml` ran `xcodebuild build` on
`generic/platform=iOS` and never ran the 71 `CongressTradeTests` cases.  Branch
protection on `main` required only `typecheck + test` and `gitleaks`, so three
red iOS builds merged on 2026-08-15/16 and `main` stayed uncompilable for about
38 hours.

This change makes job **`xcodebuild (unsigned)` fail** (not `continue-on-error`)
when either the unsigned compile or any XCTest case fails.  It also runs the
tests and refuses a green result that executed fewer than 71 cases.

## Files changed

- `.github/workflows/ios-build.yml` — keep unsigned device compile; call
  `scripts/ios-ci-xctest.sh`; upload `.xcresult`; scope `cancel-in-progress`
  to pull requests only.  `pull_request` has no `paths:` filter.  An ubuntu
  wrapper job named `xcodebuild (unsigned)` always reports, so it can be a
  required check without blocking backend-only PRs.  The Mac job runs only
  when `clients/ios/**`, this workflow, or the XCTest script changed.
- `scripts/ios-ci-xctest.sh` — `xcodebuild test -only-testing:CongressTradeTests`;
  fail if fewer than 71 cases run; skip ghost sims and create a fresh
  iPhone 17 Pro / 16 Pro when needed.
- `scripts/check-actions-runner-policy.mjs` — pin: no `continue-on-error`,
  must run `xcodebuild test` against `CongressTradeTests`, wrapper must
  always report.
- `docs/EFFORT-LOG.md` — claim/closeout for issue #2031.

A shared `.xcscheme` was not added.  The repo hook blocks hand-edits under
`.xcodeproj/`.  CI does not rely on a checked-in scheme: it passes
`-only-testing:CongressTradeTests` and fails closed if fewer than 71 cases
execute.

No app product code, PDF, billing, OGE, extract, or TestFlight ship.

## Verification

```
node scripts/check-actions-runner-policy.mjs
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ios-build.yml'))"
```

Verified on the Mac runner (workflow_dispatch run 32318653886, sha
`fac8f748`): unsigned device compile succeeded; a fresh iPhone 17 Pro
simulator was created after ghost UDID `27C2C925-…` failed boot; **71
XCTest cases ran**; 4 failures made `xcodebuild-mac` and the wrapper
`xcodebuild (unsigned)` red.  That is the success condition.

GROK babysit (2026-08-20, same PR, after rebase onto current main) fixed
the three XCTest failures that painted the unsigned wrapper red, plus the
`testDeleteAccountCommandPayload` body unwrap that would have failed next:

- POST body tests read `Self.requestBody(request)` (httpBody or stream).
- Pager test expects the default 50-row page size (offset `50`, 5 pages
  for 250 rows).
- Device compile and XCTest use `$RUNNER_TEMP/DerivedData-ct-ci` so a
  contended default DerivedData lock cannot sit until the 45-minute
  timeout and cancel the Mac job.

## Required check (ruleset 20961339)

The wrapper job name **`xcodebuild (unsigned)`** is in repository ruleset
`default-main-protection` (id `20961339`) alongside `typecheck + test` and
`gitleaks`.  Require the **job** name, not the workflow name (`iOS build
(Mac runner)`), and not `xcodebuild-mac` or `ios path gate`.

`scripts/check-actions-runner-policy.mjs` fails CI when that ruleset drops
any of the three contexts (uses `GITHUB_TOKEN` + `GITHUB_REPOSITORY` in
Actions).

Confirm live:

```
gh api repos/Simple-With-Us/Congress.Trade/rulesets/20961339 \
  --jq '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context'
```

## Follow-ups

- No TestFlight from this change.
