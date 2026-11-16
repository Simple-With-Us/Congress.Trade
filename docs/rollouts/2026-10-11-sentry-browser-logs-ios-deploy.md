# 2026-10-11 — Congress.Trade Sentry: browser release, log flush, iOS DSN, deploy skip

## Summary

Telemetry audit C.12: the CDN browser SDK had no `release`, Sentry Logs were
silent for 7d, iOS had 30 days of silence, and `Sentry Deploy` failed 15 times
(FLEET-INFRA-DR) on CI-only main pushes that Coolify never rebuilds.

- Browser `Sentry.init` now carries the Coolify SHA (`CT_BUILD_SHA` /
  `SOURCE_COMMIT`) and `enableLogs`.  After a verified production deploy,
  `scripts/sentry-upload-browser-sourcemaps.mjs` uploads `dashboardHtml.ts`
  against that SHA.
- Deno Logs were captured (`polling.heartbeat_silent` last arrived 2026-09-22)
  but the SDK only auto-flushes on `beforeExit` / 100-item buffer.  A
  long-lived Coolify process never exits, so sparse `sentryLoggerWarn` lines
  sat in memory.  Init now uses a 1s flush interval, each warn schedules a
  250ms flush, and cron / HTTP boundaries call `flushSentry`.
- TestFlight archives on GitHub Actions refuse to ship when Infisical prod
  `SENTRY_DSN` is missing.  Cocoa still no-ops for local debug builds.
- `sentry-report-deploy.mjs` skips observation when the SHA does not match
  Coolify `watch_paths` (`app/**`, `services/**`).

## Files changed

- `app/src/shared/sentryBrowser.ts` — release + enableLogs on the CDN loader
- `app/src/shared/sentryRuntime.ts` — `_flushInterval`, scheduled + exported flush
- `app/src/deno/main.ts` — flush after cron ticks and HTTP requests
- `scripts/sentry-report-deploy.mjs` — Coolify watch_paths skip
- `scripts/sentry-upload-browser-sourcemaps.mjs` — dashboard source upload
- `.github/workflows/sentry-deploy.yml` — upload after a recorded release
- `.github/workflows/ios-ship.yml` + `scripts/ios-fleet/ship-testflight.sh` —
  fail closed without `SENTRY_DSN`

## Verification

- `cd app && npm run typecheck && npm test`
- `node --test scripts/sentry-report-deploy.node-test.mjs scripts/sentry-upload-browser-sourcemaps.node-test.mjs scripts/ios-ship-workflow.test.mjs`

## Follow-ups

- Jay: confirm Infisical CT prod `SENTRY_DSN` is present (same public DSN the
  web SDK uses).  Repo/Actions `SENTRY_AUTH_TOKEN` needs `project:releases`
  on `congress-trade` for source-map upload and deploy receipts.
- Next TestFlight ship after this lands is what injects the DSN into the
  binary; existing TestFlight builds stay silent until that ship.
