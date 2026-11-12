# 2026-09-09 — FMP probe moves server-side + Mango residential proxy

- Summary: Server is now the sole owner of every FMP / FMP_RAPIDAPI / Unusual Whales / Quiver latency probe.  Residential IP bounce routes through the GL.iNet Mango HTTP CONNECT proxy on the Hetzner `wg-ct` WireGuard mesh, no longer through a Mac scout.  The Senate / House / OGE fetchers stop using the retired Mac scout relay and rely on the same Mango path.
- Why: Owner 2026-09-09: "want the server to handle the FMP probe not Mac and try to find out answers to those questions yourself" + the Mac is retired from the residential proxy role (board `ab688ea5`) and the Senate relay role (board `ba810d46`).
- Files:
  - `app/src/shared/proxyFetch.ts` — exports `DEFAULT_RESIDENTIAL_PROXY_URL = 'http://10.99.0.2:8888'`; `resolveResidentialProxyUrl` falls back to it instead of returning `undefined` (so a missed env var cannot accidentally run probes datacentred).
  - `app/src/shared/__tests__/proxyFetch.test.ts` — assertion updated to expect the Mango default.
  - `app/src/ingestion/scoutHandoff.ts` — `LatencyProbeSource` docstring notes `'scout'` is historical-only; `computeNeedScout` returns `needScout: false` for every path; `planServerLatencyProbe` collapses the `handedOff` branch into a one-release defensive release (server-only lane acquires unconditionally).
  - `app/src/ingestion/detectionRoutes.ts` — `POST /api/scout/latency-payload` now returns `410 Gone` with a deprecation note.
  - `app/src/ingestion/senateSource.ts` — `relayUrl` / `relaySecret` marked `@deprecated`; the relay-fallback block is replaced by a `console.warn` if `SENATE_RELAY_URL` is set.
  - `app/src/ingestion/fetcher.ts` — same warn-and-ignore for the Senate document fetch relay when the Mango residential proxy is not configured.
- Verification: `npm run typecheck` (deno) + `npm test -- --run proxyFetch scoutHandoff senateSource fetcher`.  `xcodebuild (unsigned)` and other CT CI gates run on push.

## How the pieces fit together today

```
   ┌──────────────────────────────────────────────┐
   │             Coolify (Hetzner)                │
   │  100.69.77.26 — server (CT Deno app)         │
   │  100.69.77.26:8022 → 10.99.0.2:22 (Mango SSH)│
   │  100.69.77.26:8380 → 10.99.0.2:80 (Mango UI) │
   │                                              │
   │   CT server uses Deno.createHttpClient({     │
   │     proxy: { url: 'http://10.99.0.2:8888' }  │
   │   }) for every Senate / House / OGE / FMP   │
   │   request.  Mango provides the residential   │
   │   IP bounce via HTTP CONNECT.                │
   └──────────────┬───────────────────────────────┘
                  │ WireGuard (wg-ct, port 51821)
                  ▼
   ┌──────────────────────────────────────────────┐
   │  glinet-mango (10.99.0.2, port 8888 HTTP)    │
   │  Residential egress IP: 99.44.91.248         │
   │  Public endpoint: 99.44.91.248:51666          │
   │  Admin UI on port 80 (GL.iNet stock)         │
   └──────────────────────────────────────────────┘
```

The Mango device is the only residential-IP bounce target in the fleet.  No Mac scout, no Mac relay, no `RESIDENTIAL_PROXY_URL=http://100.113.106.39:3128` (that was the now-retired Tailscale IP of the Mac).

## Why the proxy default matters

`resolveResidentialProxyUrl` used to return `undefined` when no env was set.  With the Mac retired, a missed `RESIDENTIAL_PROXY_URL` env in Coolify would have silently run probes / Senate fetches datacentred — exactly what the upstream anti-bot (Imperva) was blocking in the first place.  The Mango default (`http://10.99.0.2:8888`) is reachable directly via the WireGuard mesh so the server always has a path, and the test now asserts the default.

## Operational notes

- The Mac scout relay at `https://scout.jays.services` is retired (Cloudflare tunnel still exists for any other use).  Any historical `source: 'scout'` KV records are mapped to server-owned on read.
- `requestMacProbeLease` is preserved as dead code for one release so its test (`probeLease.test.ts`) continues to compile + run; next pass will delete it entirely.
- `ingestScoutLatencyPayload` is still imported by `tradeLatency.ts` (it remains the underlying ingest path for any payload the server synthesises itself); only its Mac-only `source: 'scout'` parameter is now dead.
- `LATENCY_SCOUT_CONSECUTIVE_ERRORS = 3` is kept as an observable counter (the dashboard surfaces it) but it never gates handoff — the Mac is not coming back.

## Follow-ups

- Delete `senateRelayHealth.ts`, `requestMacProbeLease`, `MacLeaseResult`, `LATENCY_SCOUT_CONSECUTIVE_ERRORS`, and the `LATENCY_PROBE_HEALTH_KV_KEY` `v2` migration once a release has shipped with no Mac scout callers in the wild.
- Add a Sentry / Sentry Metrics alert for `LatencyProbeSource.lastSource === 'scout'` reads (any nonzero value is a misconfigured install).
- Repoint the GL.iNet Mango admin UI off port 80 if any future Coolify ingress starts using it.
