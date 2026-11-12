# 2026-08-13 — Watchdog spent its restart budget on Traefik blips

## Summary

Pushover fired **Health failing but restart budget is spent**. The app was
not dead. `/api/health` on the container bind (`127.0.0.1:5000`) was 200 in
~20ms. The watchdog was probing **public** `https://congress.trade/api/health`,
and the host still ran the 2026-08-10 `ct-reattach-proxy.sh` (3115 bytes).
That copy rewrote `/data/coolify/proxy/dynamic/congress-trade.yml` every
minute. Traefik saw a mid-write empty file, served a brief 502/503, the
watchdog counted two 30s failures, docker/Coolify-restarted a healthy app,
and burned `MAX_RESTARTS_PER_HOUR=4`. After that it could not self-heal.

## Files changed

- `scripts/ops/congress-health-recover.sh` — decisions use
  `LOCAL_HEALTH_URL` (`http://127.0.0.1:5000/api/health`). Skip remediates
  while a compose replace is `Created` / `health: starting`.
- Host: installed current `scripts/ops/ct-reattach-proxy.sh` (8231 bytes,
  atomic route write + no-op when unchanged). Already on `main`; the host
  copy had never been updated.

## Verification

- Host reattach second run: `ok: … already on coolify as congress-app`,
  route file mtime unchanged at `2026-08-14 02:41:14Z` across later cron ticks.
- Watchdog start line (02:42:00Z): `health_url=http://127.0.0.1:5000/api/health`.
- Local health 200 in 20ms; public 200 in ~260ms.  `congress-app` healthy on
  `127.0.0.1:5000`.  Journal after the 02:42Z restart has no `health FAIL`.
- Hourly restart count dropped off the 4/4 cap as the false remediates aged out.

## Follow-ups

- **2026-08-14 02:51Z:** merging #1852 auto-deployed the app.  Coolify
  stop-before-start removed `congress-app` before the replacement was
  `Created`.  `is_deploy_active` missed that gap, local health failed, and
  the watchdog stacked a Coolify API restart on the in-flight deploy.
  Host now asks `GET /api/v1/deployments` (same parse as
  `ct-deploy-guard.sh`) and skips remediates while this app is
  `in_progress` / `queued`.
- `status=stalled` on `/api/health` is autopilot quota, not this outage.
