# 2026-08-08 — sqlite-web crash loop took congress.trade to 502

## Summary
Production Coolify app `congress-trade` repeatedly entered `exited:unhealthy`
(restart_count 26–32, `last_restart_type=crash`). Cloudflare returned **502**.
UptimeRobot opened incidents.

## Root cause
1. Compose service **`sqlite-web`** runs `sqlite_web --password`.
2. With **empty** `SQLITE_WEB_PASSWORD`, sqlite-web falls back to interactive
   `getpass()` → `EOFError` in Docker (no TTY) → exit 1.
3. `restart: unless-stopped` crash-looped that container forever.
4. Coolify treats the multi-service stack as one resource; the restart storm
   flipped the app to **exited:unhealthy** and stopped **congress-app** too.
5. Secondary: Traefik routes to `http://congress-app:5000` on the `coolify`
   network; Coolify’s generated compose only attaches the private app network.
   Host helper `/usr/local/bin/ct-reattach-proxy.sh` (cron every minute) adds
   the `congress-app` alias on `coolify` after deploys.

## Fix
- Set `SQLITE_WEB_PASSWORD` in Coolify (prod) + host `.env` (len 31).
- Stopped crash loop; recreated sqlite-web healthy.
- Dockerfile: fail-fast if password empty (no getpass).
- Compose: `restart: on-failure:3` for non-critical admin UI.
- Proxy reattach cron already present on host.

## Verification
- `GET https://congress.trade/api/health` → 200
- `docker ps`: congress-app Up; sqlite-web Up (not Restarting)
