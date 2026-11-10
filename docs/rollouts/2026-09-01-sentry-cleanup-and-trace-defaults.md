# 2026-09-01 — Sentry Cleanup & Trace Sampling Defaults (Antigravity, `ag/sentry-cleanup-and-trace-defaults`)

## Context & Objective
Removes legacy Cloudflare Worker Sentry packages from Congress.Trade (now running as Deno-in-Docker on Coolify), updates default distributed tracing sample rate to 0.2 to match fleet standard, and verifies Deno typechecking clean.

## Changes Made
- **Removed Dead Cloudflare Sentry Package**: Dropped `@sentry/cloudflare` from root `package.json` and `deno.json`.
- **Trace Sampling Rate Alignment**: Raised default fallback `tracesSampleRate` in `app/src/shared/sentryRuntime.ts` from 0.1 to 0.2.
- **Fixed PDF Destroy Type Cast**: Fixed `PDFDocumentProxy` cast in `app/src/ingestion/autonomySweeps.ts` to satisfy strict TypeScript checking.

### Touched Files
- `package.json`
- `deno.json`
- `app/src/shared/sentryRuntime.ts`
- `app/src/ingestion/autonomySweeps.ts`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-09-01-sentry-cleanup-and-trace-defaults.md`

## Decisions & Trade-offs
- `@sentry/deno` is the sole authoritative Sentry SDK for Congress.Trade production container.

## Verification State
- `deno check app/src/deno/main.ts` — passed with 0 errors.

## Next Steps & Blockers
- None.
