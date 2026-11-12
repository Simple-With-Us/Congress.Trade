# 2026-08-08 — Trades pager + autonomous uptime recovery [GROK]

## Summary

1. **Trades tab pagination** — full first/prev/next/last controls (`<< < > >>`) with range-of-total count (`1–N of total`) and a public-offset cap that still cannot 400 the API.
2. **Mitigate + auto-recover site-down** — root cause of recent `exited:unhealthy` / 502: Coolify health command used `/usr/bin/curl` but `denoland/deno:alpine` only shipped `wget`, so the stack could be marked unhealthy even while Deno was fine. Fixed at image, compose, Coolify config, and host watchdog layers.

## Files changed

| Path | Change |
|------|--------|
| `app/src/ui/dashboardHtml.ts` | `<< < > >>` pager, `firstTradesPage` / `lastTradesPage`, `maxReachableTradesPage` |
| `app/src/ui/__tests__/dashboardHtml.test.ts` | asserts new pager controls |
| `app/Dockerfile` | install `curl`; image `HEALTHCHECK` on `/api/health` |
| `app/docker-compose.yml` | `healthcheck` via `wget` (works before rebuild) |
| `scripts/ops/congress-health-recover.sh` | host loop: health → docker restart + Traefik reattach |
| `scripts/ops/congress-health-recover.service` | systemd unit (enabled on Coolify host) |

## Host ops (applied 2026-08-09)

- Installed `/usr/local/bin/congress-health-recover.sh` + unit on `fleet-hetzner-nbg1` (SSH host `coolify`).
- `systemctl enable --now congress-health-recover` → **active**.
- Live container: `apk add curl` so Coolify cmd healthcheck works until next image rebuild.
- Coolify app `<CT_COOLIFY_APP_UUID>`: health path `/api/health`, port **5000**, interval 30s, start period 120s, retries 5.

Watchdog behavior:

| Setting | Value |
|---------|--------|
| Check | `https://congress.trade/api/health` every 30s |
| Fail threshold | 2 consecutive |
| Action | `docker restart` congress-app + `ct-reattach-proxy.sh` |
| Cooldown | 300s |
| Max restarts / hour | 4 |
| Deploy safety | skips while nixpacks/builder containers running |
| Host reboot | never |

Logs: `journalctl -u congress-health-recover -f`

## Verification

```bash
# UI (after deploy)
# Trades footer: "1-50 of N" + << < Page X of Y > >>

# Health
curl -fsS https://congress.trade/api/health | head -c 200

# Watchdog
ssh coolify 'systemctl is-active congress-health-recover; journalctl -u congress-health-recover -n 20 --no-pager'

# Container has curl + health
ssh coolify 'docker exec $(docker ps -q --filter name=congress-app | head -1) which curl'
```

## Follow-ups

- After this PR deploys, confirm Docker reports `Health=healthy` on congress-app (image HEALTHCHECK + compose healthcheck).
- Optional: Mac LaunchAgent as secondary probe (not required; host unit is the primary always-on path).
- Optional: wire UptimeRobot down webhook to the same script (token-gated); current path is push-free polling.
