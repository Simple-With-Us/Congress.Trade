# 2026-08-27 — Datadog APM Fleet Alignment (us5.datadoghq.com)

## Summary

Congress.Trade is now aligned with Socratic.Trade (`ST`) and the rest of the fleet for Datadog APM tracing on `us5.datadoghq.com`.

Prior to this change:
- `DATADOG_API_KEY` was not recognized in secret resolution (only `DD_API_KEY`).
- `DD_SITE` did not default to `us5.datadoghq.com` (disabling Datadog backend telemetry if `DD_SITE` was omitted in Infisical).
- `DD_AGENT_HOST` / `DD_TRACE_AGENT_URL` / `DD_TRACE_AGENT_HOSTNAME` were not extracted.
- Custom JSON traces attempted against `https://trace.agent.${site}/api/v0.2/traces` were not indexed in Datadog APM.

Changes:
1. `src/shared/datadogRuntime.ts`:
   - Defined `DEFAULT_DATADOG_SITE = 'us5.datadoghq.com'`.
   - Added `DATADOG_API_KEY`, `DATADOG_APP_KEY`, `DD_AGENT_HOST`, `DD_TRACE_AGENT_URL`, `DD_TRACE_AGENT_HOSTNAME`, `DD_TRACE_URL`, and `DD_TRACE_SAMPLE_RATE` to `DATADOG_RESOLVE_KEYS`.
   - Updated `resolveDatadogBackend` to enable APM when an API key or agent host is present with default site `us5.datadoghq.com`.
   - Updated `resolveDatadogRum` to default site to `us5.datadoghq.com`.
2. `src/shared/datadog.ts`:
   - Added `tryInitDdTracer` initializing `npm:dd-trace` in Deno when Datadog backend is enabled.
   - Added `startDatadogSpan` and `traceDatadogOperation` helpers.
   - Updated `datadogRequestMiddleware()` to create HTTP request spans (`web.request`) on the active tracer.
3. `src/shared/thirdPartyTelemetry.ts`:
   - Wrapped outbound calls in `trackedFetch` with APM spans (`http.client.request`) so external calls appear in APM flame graphs.
4. `src/shared/datadogTransport.ts`:
   - Guarded `DD-API-KEY` header in HTTP post to support both agent and agentless modes.
5. `src/shared/types.ts`:
   - Updated `Env` interface with Datadog aliases and agent host fields.

## Verification

- `npm run typecheck` passed (clean `deno check src/deno/main.ts`).
- `npx vitest run src/shared/__tests__/datadogRuntime.test.ts` passed (20/20 tests).
- Full test suite `npm test` passed (3,774 tests across 297 test files).
