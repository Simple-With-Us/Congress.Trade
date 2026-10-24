# 2026-08-17 — Coolify compose swap still drops every server (#1537) [CURSOR]

## Summary

Every Coolify deploy of `congress-trade` still has a window with **zero
in-project app containers**.  Clients that land in that window see Traefik's
bare `no available server` (HTTP 503) or a 502.  Issue #1537 asked for a
health-gated rolling update or an overlap path.  This change adds the overlap
path.  It does **not** change live Coolify routing from the agent VM, and it
does **not** edit `app/docker-compose.yml` (live `watch_paths` is `app/**` +
`services/**`; a compose comment would 502 the origin on merge).

## Coolify constraint (still true on current v4.x source)

`deploy_docker_compose_buildpack()` builds the new images, then:

```
$this->stop_running_container(force: true);
$this->application_deployment_queue->addLogEntry('Starting new application.');
// docker compose --project-name … up --build -d
```

`force: true` bypasses the `newVersionIsHealthy` gate.  The old containers
are stopped and removed **before the new ones exist**.

`rolling_update()` — start new, `health_check()`, stop old — exists and is
what Dockerfile / Nixpacks / Railpack deploys use.  Compose never calls it.
Coolify's own docs and Discussion #3767 agree: rolling updates are not
supported on Docker Compose deployments.  Turning the application health
check on or off only changes post-deploy *status reporting*.

`congress-trade` is `build_pack: dockercompose`.  `app/docker-compose.yml`
also sets `container_name: congress-app` and `127.0.0.1:5000:5000`.  Those
two settings independently disable `rolling_update()` even on a Dockerfile
application.  Do not remove the loopback bind without moving
`congress-health-recover.sh` off `LOCAL_HEALTH_URL=http://127.0.0.1:5000/api/health`.

The 2026-08-12 note (`docs/rollouts/2026-08-12-deploy-downtime-gap.md`)
diagnosed the same mechanism and landed the atomic reattach + standby
holding page.  Standby converts the error into a 503 HTML page.  It does
not keep an API server.  Host install of standby was still un-run as of
2026-08-12.

## Concrete fix in this change

A host unit clones the live app as `congress-hold` **outside** Coolify
project `<CT_COOLIFY_APP_UUID>`, so `docker compose … up` cannot remove
it.  `ct-reattach-proxy.sh` then writes a Traefik `failover` service:

1. Primary: `http://congress-app:5000` (in-project container)
2. Fallback: `http://congress-hold:5000` (overlap clone)

The failover health check probes `/health` (trivial `{"ok":true}`), not
`/api/health`.  When Coolify deletes the primary, Traefik has a remaining
server.  After the replacement answers `/health`, the unit removes hold
and the route returns to the single-server shape (no health check), so a
later probe flap cannot produce `no available server`.

Hold runs `deno run … src/deno/main.ts` directly.  It does not start
Litestream.  Two writers on the SQLite bind mount for the swap window is
the same risk as a Dockerfile rolling update; WAL serializes it.

Update 2026-10-23 (CT-2442):  the hold env also sets
`CT_DISABLE_STARTUP_SCHEMA_MIGRATE=1`.  main.ts awaits the boot schema
replay before `Deno.serve`, so a hold that replayed it logged "/health not
ready after 45s" on every deploy and was not serving when Coolify stopped
the old app.  `ct-deploy-overlap.sh --render-env` prints the hold env
offline, with every value except the two hold flags redacted.

If hold is not running, standby (if installed) is still the fallback.

## Files changed

| File | Effect |
| --- | --- |
| `scripts/ops/ct-deploy-overlap.sh` | Start/stop `congress-hold`; `--decide` is the offline policy table |
| `scripts/ops/ct-deploy-overlap.service` | Always-on host loop (3s) |
| `scripts/ops/ct-reattach-proxy.sh` | Failover prefers hold, then standby; `--render` for tests |
| `scripts/ops/test-deploy-overlap.sh` | Offline decide + hold env + render pins |
| `docs/rollouts/2026-08-12-deploy-downtime-gap.md` | Pointer + do not re-enable `ct-deploy-guard.timer` |

## Host install (does not take the site down)

Run as root on `coolify` **before** relying on the next merge deploy.
Merging this PR still triggers Coolify's stop-then-start; the overlap unit
is what keeps a server in the LB.

```bash
install -m 0755 scripts/ops/ct-deploy-overlap.sh /usr/local/bin/
install -m 0755 scripts/ops/ct-reattach-proxy.sh /usr/local/bin/
install -m 0644 scripts/ops/ct-deploy-overlap.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ct-deploy-overlap.service
# optional last-resort holding page (503 + Retry-After), already in tree:
# install + enable ct-standby.service (see that unit's header)
/usr/local/bin/ct-reattach-proxy.sh
```

Credentials stay in `/etc/congress-health-recover.env` (`COOLIFY_TOKEN`).
This change does not add secrets.

## Verification

Offline (this PR):

```bash
bash scripts/ops/test-deploy-overlap.sh
```

On the host, after install, on the **next** Coolify deploy of congress-trade:

```bash
# PASS: an interval where congress-hold is Up while congress-app is gone,
# and public /api/health stays 200 (or at worst the standby 503 page —
# never the bare "no available server" body).
ssh coolify 'docker events --filter type=container --format \
  "{{.Time}} {{.Action}} {{index .Actor.Attributes \"name\"}}"' &

UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
while :; do
  printf '%s %s\n' "$(date +%T)" \
    "$(curl -s -o /tmp/ct-body -w '%{http_code}' -A "$UA" https://congress.trade/api/health)"
  sleep 0.2
done | tee /tmp/deploy-probe.log
```

PASS: `grep -c 'no available server' /tmp/ct-body` is 0 across the swap,
and `/data/coolify/proxy/dynamic/congress-trade.yml` shows
`fallback: congress-hold` while hold is up.

Coolify's own log will still say `Removing old containers.` before
`Starting new application.`  That is expected.  The overlap lives
*outside* that job.

## Follow-ups

- Install the unit on `fleet-hetzner-nbg1`.  Repo merge alone does not.
- Native zero-downtime still requires a **Dockerfile** Coolify application
  (not compose), empty port mappings, consistent container name OFF, and
  health check `/api/health`.  That changes live routing.  Do not do it
  from an agent VM.  Steps remain in
  `docs/rollouts/2026-08-12-deploy-downtime-gap.md`.
- Keep `fleet-deploy-guard@congress-trade.timer` enabled.  Do not re-enable
  the superseded `ct-deploy-guard.timer`.
- Docs-only skip (`watch_paths`) is a separate lane (#2033 / PR #2038).
  This PR is the remaining path for **code** merges.
