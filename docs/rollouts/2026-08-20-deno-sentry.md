# Real Sentry for Deno production (ENGINEERINGQUALITY-01)

## Summary

Production Deno had no real Sentry.  `#sentry` resolved to `sentryDummy.ts` (passthrough `withSentry` + `console.error`).  Coolify container logs die on redeploy, so unhandled route / cron / queue failures had no durable signal.

`#sentry` now binds `@sentry/deno` (the Deno *runtime* SDK).  Production is Deno-in-Docker on Coolify (Hetzner fleet), not Deno Deploy — no deployctl, no Deploy integration, no Deploy-only APIs.  `src/deno/main.ts` inits after Infisical refresh from `SENTRY_DSN` (Infisical first, Coolify env fallback).  Missing DSN or `init` throw is fail-soft: the app still boots and captures no-op.  Events reuse `scrubSentryEvent` so credential query params, headers, and URL userinfo are `[Filtered]`.  Release is the Coolify image SHA via `readBuildInfo` (`CT_BUILD_SHA`, then `SOURCE_COMMIT`).  Coolify log retention was not changed.

## Files changed

- `app/src/deno/sentry.ts` — real `#sentry` adapter (`@sentry/deno`)
- `app/src/shared/sentryRuntime.ts` — init / fail-soft / Infisical+env resolve
- `app/src/shared/sentryScrub.ts` — shared secret scrub
- `app/src/deno/main.ts` — boot init + cron `captureException`
- `app/src/deno/cronLanes.ts` — daily-lane `captureException`
- `app/src/index.ts` — shared scrub; DSN from env only (no hardcoded fallback)
- `app/deno.json`, `deno.json`, `app/package.json` — `#sentry` → `sentry.ts`; `@sentry/deno`
- deleted `app/src/deno/sentryDummy.ts`

## Verification

- `cd app && npm run typecheck && npm test`
- New tests: DSN set → `init` called; DSN missing / blank → no-op; init throw → boot continues; beforeSend scrubs secrets; import maps do not mention `sentryDummy`
- After deploy: Coolify env / Infisical `SENTRY_DSN` present; a thrown cron/route error appears as a Sentry issue (not only a dead container log)

## Follow-ups

- Resolve or delete the stale `watcher-cron` monitor (Deno never sent those check-ins)
- Confirm Infisical CT prod `SENTRY_DSN` / `SENTRY_ENVIRONMENT` are the live values Coolify already reports as configured
