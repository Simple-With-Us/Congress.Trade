# 2026-07-30 — Prod 502 incident: Caddy stable-alias fix (Oracle/Coolify)

## Summary

congress.trade (and host.jays.services) returned 502 (Uptime-Robot incident).
Root cause: the host-local Caddyfile at `/etc/usage-monitor/Caddyfile`
(bind-mounted into the `oracle-caddy-1` container) reverse-proxied
congress.trade to a **per-deploy timestamped container name**
(`congress-app-congress-trade-050455830214:5000`). Every Coolify (re)deploy
mints a new container name, so routing broke on each deploy. Additionally,
`oracle-caddy-1` was not attached to the `congress-trade` Docker network, so no
congress container name could resolve at all.

Fixes applied on the Oracle host (<ORACLE_IP_RETIRED>):

1. Caddyfile congress.trade block now proxies to the Coolify **stable network
   alias** `congress-app:5000` (the alias is constant across redeploys; backup
   at `/etc/usage-monitor/Caddyfile.bak-20260730`).
2. `docker network connect congress-trade oracle-caddy-1`, and made durable in
   `/etc/usage-monitor/compose.yaml`: the `caddy` service is now on external
   networks `coolify` and `congress-trade` (compose config validated; backup at
   `compose.yaml.bak-20260730`). The manual connect persists across restarts;
   the compose edit covers container recreation.
3. host.jays.services (Coolify UI, also 502) pointed at a tailscale IP
   (`<TAILSCALE_IP_RETIRED>:8000`) that is unreachable from inside the container network
   namespace; now `reverse_proxy coolify:8080` over the shared `coolify`
   Docker network.

## Traps worth remembering

- `sed -i` on a single-file bind mount swaps the inode — the container keeps
  serving the OLD file. After editing a bind-mounted config file on the host,
  `docker restart <container>` (or write in place) is required; `caddy reload`
  alone is not enough.
- Coolify container names carry deploy-timestamp suffixes. Never reference
  them in hand-written proxy config; use the stable network alias
  (`congress-app`) or the service name on a shared external network.

## Verification

- `https://congress.trade/` → 200, `https://www.congress.trade/` → 200,
  `/api/health` → `{"ok":true,"db":true,"schema":true}`.
- `https://host.jays.services/` → 302 (Coolify login).
- usage.jays.services and socratictrade.com unaffected (307/redirects as before).
- bioguideId verification (post-incident): manual
  `POST /api/admin/enrich-photos` → 538 filers / 409 matched / 129 unmatched;
  `/api/transactions` now serves `bioguideId` on 99/100 latest rows
  (migrations 0065/0066/0067 + bioguide work fully live).

## Follow-ups

- `api.congress.trade` is served in the Caddyfile but has **no Cloudflare DNS
  record** — either add the CNAME or remove it from the Caddyfile.
- Secret-store drift — **CORRECTED 2026-07-30 (later same day):** the earlier
  claim that "both baked Infisical machine identities are revoked (401 at
  login)" was a diagnostic artifact (shell quoting bug in my test; the owner
  confirmed no identity was revoked). Real root cause: on Coolify,
  `INFISICAL_APP_PROJECT_ID` was never set, so `resolveProjectId()` fell back
  to using the app *client* ID as the *project* ID, the app-source fetch
  silently failed, and every secret (incl. `ADMIN_TOKEN`) fell back to the
  image-baked `.prod.vars` values — which is why the Infisical prod
  `ADMIN_TOKEN` was rejected. **Fixed:** set `INFISICAL_APP_PROJECT_ID` and
  `INFISICAL_SHARED_PROJECT_ID` as Coolify runtime envs and restarted; the
  Infisical prod `ADMIN_TOKEN` now authorizes against the live admin API, and
  Infisical rotations reach prod within the 600s secrets-cache TTL (no
  rebuild/restart needed). `.prod.vars` baked into the image layer still
  carries all live provider secrets; flag for Dockerfile/Coolify build owner.
- Deno cron ticks repeatedly hit the 45s deadline; late tick lanes (photo
  enrichment, ticker backfill, retention) are starved when earlier lanes run
  long. Consider splitting daily lanes onto staggered schedules.
