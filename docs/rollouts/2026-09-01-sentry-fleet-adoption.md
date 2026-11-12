# 2026-09-01 — Sentry fleet adoption leftovers (GROK, `grok/sentry-fleet-adoption`)

## Context & Objective

Follow-on to AG PR #2282 (dropped `@sentry/cloudflare`, tracesSampleRate 0.2).  Remaining Congress.Trade work from the 2026-09-01 Sentry fleet adoption report: stop committing a live `SENTRY_DSN`, stop minting CONGRESS-TRADE-1C from expected unpdf XRef noise, ship sparse Sentry Logs from health `console.warn` paths, and document Replay / profiling decisions for this Deno-in-Docker runtime.

## Changes Made

- **DSN out of git.**  `app/.prod.vars` keeps the `SENTRY_DSN` key as an empty placeholder (same shape as the other secrets in that file).  Live value is Infisical (canonical) plus Coolify runtime env.  `.dev.vars.example` and `app/DEPLOY.md` / `app/docs/config-registry.md` say the same.  The DSN value is not in this PR.
- **PDF XRef ignore.**  `buildSentryInitOptions` already dropped CONGRESS-TRADE-1C in `beforeSend`.  This PR also sets `ignoreErrors` (`XRefEntryException` / `Bad (uncompressed) XRef entry`) and routes expected pdf.js unhandledrejection noise to a sparse `pdf.xref_noise` log instead of `console.warn` with the raw exception.
- **Sparse Sentry Logs.**  Health `console.warn` paths now call `sentryLoggerWarn` (SDK `logger.warn` after init, console only before init).  Named events: `ingest.dead_letter`, `webhook-retry`, `ingest.retry`, `pdf.xref_noise`, `cron.tick_overlap`, `d1.budget_soft`, `d1.governor_cap`.  `rag.rejected` does not exist in this repo.  Datadog stays the warehouse; these lines are not dual-shipped through the console hook once Sentry is initialized.
- **index.ts factory** now uses `buildSentryInitOptions` (PDF filter + `ignoreErrors` + `enableLogs`) and the 0.2 traces default via `resolveSentryTracesSampleRate`.
- **Replay.**  No browser `@sentry/*` SDK on the public site.  Not added.  Policy if a browser project is created later: `replaysSessionSampleRate: 0`, 100% on error only.
- **Profiling.**  Skipped.  `@sentry/deno` has no profiling docs or Deno profiler integration (Node continuous profiling is `@sentry/profiling-node`).  Do not fake `profileSessionSampleRate` on this runtime.

### Touched files

- `app/.prod.vars`, `app/.dev.vars.example`
- `app/src/shared/pdfParseErrors.ts`, `app/src/shared/sentryRuntime.ts`
- `app/src/deno/sentry.ts`, `app/src/deno/main.ts`, `app/src/index.ts`
- `app/src/delivery/deadLetter.ts`, `app/src/delivery/webhook.ts`, `app/src/queueHandlers.ts`
- `app/src/shared/d1Budget.ts`
- `app/DEPLOY.md`, `app/docs/config-registry.md`
- tests under `app/src/deno/__tests__/sentryInit.test.ts` and `app/src/shared/__tests__/pdfParseErrors.test.ts`

## Decisions & Trade-offs

- Empty `SENTRY_DSN=` in `.prod.vars` rather than deleting the key, so the file stays consistent with other secret placeholders and `buildEnvironmentValues` still skips empty values.
- `sentryLoggerWarn` is module-level so health call sites do not all import `#sentry` (fewer vitest mock updates).
- Cron pause of `watcher-cron` / `agreement-autopublish-cron` is owned by the parent via Sentry API, not this PR.

## Verification State

- `deno check src/deno/main.ts` (npm run typecheck) — clean.
- Focused Sentry/health tests 57/57.  Full suite re-run on the PR.
- DSN rotation: created Sentry client key `production-2026-09` (len 95).  Infisical CT prod `SENTRY_DSN` written and read back at the same length.  Coolify runtime prod + preview env both match the new key (`is_runtime=true`, `is_buildtime=false`).  Deactivated the previously live `ct-rotated-2026-08-21` key after that confirm.  Git `Default` DSN was already inactive in Sentry.  Values are not in this document.

## Next Steps & Blockers

- After deploy, confirm CONGRESS-TRADE-1C stops minting new events and Sentry Logs show `webhook-retry` / `ingest.dead_letter`.
- Do not add Session Replay to congress.trade public HTML.
