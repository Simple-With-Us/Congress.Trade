# 2026-08-20 — Linux GitHub Actions stay on ubuntu-latest

## Summary

Congress.Trade is public.  Linux jobs already evaluated the
`github.event.repository.private && self-hosted/oracle-ci` expressions to
`ubuntu-latest`.  Those branches are deleted so a later private-repo flip
cannot send Linux CI back to `oracle-ci`.

Owner stop-order: day-to-day iOS compile and TestFlight ship stay on the
owned Mac (`[self-hosted, macOS, ARM64, xcode26]`).  `ios-build.yml` and
`ios-ship.yml` were not moved.  `ios-appstore-gm.yml` stays on hosted
`macos-26` for App Store GM binaries.

## Files changed

- `.github/workflows/admin-maintenance.yml`
- `.github/workflows/auto-update-prs.yml`
- `.github/workflows/ci.yml`
- `.github/workflows/debug.yml`
- `.github/workflows/deploy-oracle.yml`
- `.github/workflows/effort-issues-sync.yml`
- `.github/workflows/runner-workerd-diagnostics.yml`
- `.github/workflows/security.yml`
- `.github/workflows/sentry-ci-report.yml`
- `.github/workflows/shared-package-pin-check.yml`
- `.github/workflows/uptime-monitor.yml`
- `.github/actionlint.yaml`
- `scripts/check-actions-runner-policy.mjs`

Unchanged: `ios-build.yml`, `ios-ship.yml`, `ios-appstore-gm.yml`.

## Verification

```bash
node scripts/check-actions-runner-policy.mjs
rg -n 'runs-on:' .github/workflows/*.yml
```

Linux `runs-on` is `ubuntu-latest`.  iOS compile/ship is the Mac xcode26
label set.  GM ship is `macos-26`.  Policy script rejects `oracle-ci` and
any other self-hosted selector.

## Follow-ups

- `.github/workflows/deploy-oracle.yml.bak` is not a workflow; leftover
  `oracle-ci` text can be deleted later.
- `debug.yml` still runs `docker logs` commands that only exist on the
  Coolify box.  That was already true while the repo was public.
- #2036 still owns the iOS required-check / XCTest slice on `ios-build.yml`.
