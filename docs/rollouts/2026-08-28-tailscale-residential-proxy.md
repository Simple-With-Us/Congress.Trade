# 2026-08-28 — Tailscale residential proxy on Mac & server-directed scraping

## Summary

Previously, scraping gov disclosure sites behind anti-bot layers (such as Senate eFD behind Imperva) relied on a standalone local scout daemon (`scout/congress-scout.mjs`) running on the Mac and posting detections back to the server, and a specialized Senate relay microservice (`scout/senate-relay.ts`) behind a Cloudflare tunnel.

This rollout replaces the standalone local scout client with **server-directed probing and scraping via a lightweight Tailscale residential HTTP/HTTPS CONNECT proxy**:
1. **Mac Residential Proxy Daemon:** A lightweight, zero-dependency Node daemon (`scout/residential-proxy.mjs` / `scout/run-residential-proxy.sh`) runs via pm2 `residential-proxy` on the Mac, listening on the Tailscale private network (`100.113.106.39:3128` / `0.0.0.0:3128`).
2. **Server-Directed Execution:** Congress.Trade directly executes all Senate eFD discovery sessions, Senate/House document fetches, and disclosure latency probes using the residential proxy (`RESIDENTIAL_PROXY_URL=http://100.113.106.39:3128`), bypassing datacenter anti-bot blocks while retaining 100% of pipeline control, database state, queue deduplication, and telemetry on the server.
3. **Fail-Soft Sleep/Offline Fallback:** If the Mac sleeps, powers off, or is disconnected from Tailscale, server calls catch connection errors and fall back gracefully to direct datacenter egress or log soft skips without failing scheduled cron ticks or interrupting other services.
4. **Local Scout Retired:** pm2 `scout` (`congress-scout.mjs`) is retired. `MAC-LOCAL-PROCESSES.md` and the Apple Note `⭐️ Background Jobs Master List` have been updated.

## Files changed

- `scout/residential-proxy.mjs` — Lightweight HTTP forwarding + HTTPS CONNECT tunnel proxy with `/health` liveness probe.
- `scout/run-residential-proxy.sh` — pm2 runner script for the residential proxy.
- `/Users/jay/apps/pm2-ecosystem.config.cjs` — Registered `residential-proxy`, retired `scout`.
- `/Users/jay/apps/MAC-LOCAL-PROCESSES.md` — Updated master process inventory; Apple Note updated.
- `app/src/shared/proxyFetch.ts` — Deno native proxy HTTP client resolver and fetch wrapper.
- `app/src/shared/types.ts` — Added `RESIDENTIAL_PROXY_URL` to `Env`.
- `app/src/ingestion/residentialProxyHealth.ts` — Health probe helper for `RESIDENTIAL_PROXY_URL/health`.
- `app/src/ingestion/senateSource.ts` — Support direct Senate eFD scraping over residential proxy with fail-soft fallback.
- `app/src/ingestion/fetcher.ts` — Support direct document fetching over residential proxy.
- `app/src/ingestion/tradeLatency.ts` — Wrapped disclosure latency competitor probes with residential proxy client.
- `app/src/ingestion/watcher.ts` — Threaded `RESIDENTIAL_PROXY_URL` to Senate polling.
- Tests: `app/src/shared/__tests__/proxyFetch.test.ts`, `app/src/ingestion/__tests__/residentialProxyHealth.test.ts`.

## Verification

```bash
cd app
npm run typecheck
npm test
```

Results: 299 test files passed, 3,783 unit tests passed.

Live verification on Mac:
- Health check: `curl -s http://127.0.0.1:3128/health` → `{"ok":true,"service":"residential-proxy",...}`
- Tailscale IP check: `curl -s http://100.113.106.39:3128/health` → `{"ok":true,"service":"residential-proxy",...}`
- Outbound egress verification: `curl -s --proxy http://100.113.106.39:3128 https://api.ipify.org` → returned residential IP `99.44.91.248`.

## Follow-ups

- In Coolify / Infisical for `congress-app` production container: set `RESIDENTIAL_PROXY_URL=http://100.113.106.39:3128` to direct live server traffic through the residential proxy on the shared Tailnet.
