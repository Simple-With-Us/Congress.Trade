# Retire Scout Relay & Switch to Residential Proxy

**Date**: 2026-09-02
**Author**: Antigravity (AG)

## Summary
Retired the legacy Mac scout relay (`scout.jays.services`) dependency and switched all Senate eFD and House scraping/media fetching directly to the residential proxy configured in Infisical (`RESIDENTIAL_PROXY_URL` / `RESIDENTIAL_PROXY_HOST:PORT` with credentials).

## Changes
- **`app/src/shared/proxyFetch.ts`**: Added `formatProxyUrl` helper and updated `resolveResidentialProxyUrl` to automatically construct the proxy URL from `RESIDENTIAL_PROXY_HOST`, `RESIDENTIAL_PROXY_PORT`, `RESIDENTIAL_PROXY_USERNAME`, and `RESIDENTIAL_PROXY_PASSWORD`.
- **`app/src/shared/types.ts`**: Added proxy host/port/auth fields to `Env`.
- **`app/src/deno/main.ts`**: Automatically resolves residential proxy secrets from Infisical at boot and populates `cachedEnvValues.RESIDENTIAL_PROXY_URL`.
- **`app/src/shared/pipelineHealth.ts`**: When residential proxy is configured, `senate_relay` health check reports `ok` indicating residential proxy egress is active and scout relay is retired.
- **Unit Tests**: Added test coverage in `proxyFetch.test.ts` and `pipelineHealth.test.ts`.

## Verification
- Unit test suite: 3,828 tests passing.
- Direct connectivity test from Coolify Deno container to `efdsearch.senate.gov` and `efd-media-public.senate.gov` via residential proxy succeeded with HTTP 200.
