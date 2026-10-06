# 2026-10-06 — Residential proxy CONNECT liveness probe

## Summary

The Mango **tinyproxy** on `10.99.0.2:8888` does not expose the retired Mac daemon's `GET /health` JSON.  Watcher was caching `senate_relay` **DOWN** with `value: null` even when the mis-probe was the only failure mode, and operators had no live CONNECT check on `/api/health`.

## Changes

- **`app/src/ingestion/residentialProxyHealth.ts`**: After optional Mac-style `/health`, probe liveness with **HTTP CONNECT egress** (`HEAD` to `https://example.com/` through `createProxiedFetch`).  Persist probe `method` in CONFIG_KV.  Add `probeResidentialProxyLive` for a dedicated route.
- **`app/src/delivery/rest.ts`**: `GET /api/health/residential-proxy` live probe (503 when CONNECT fails).
- **Tests**: `residentialProxyHealth.test.ts`, `healthMonitorEndpoints.test.ts`.

## Verification

```bash
cd app && npm run typecheck && npm test -- --run residentialProxyHealth healthMonitorEndpoints
```

After deploy: `GET https://congress.trade/api/health/residential-proxy` should match real tinyproxy state; `senate_relay` on `/api/health` follows the watcher KV refresh.

## Follow-ups

- If CONNECT is 503 but TCP to `10.99.0.2:8888` is open, restart tinyproxy on the Mango peer (CONNECT child leak) per fleet runbook — app code cannot fix a wedged proxy process.
