# 2026-08-12 — Coolify deploy downtime: root cause, why no toggle exists, and the fix [CLAUDE]

> **2026-08-17 follow-up (#1537):** compose still cannot roll.  The overlap
> path (live `congress-hold` clone + Traefik failover) is in
> `docs/rollouts/2026-08-17-coolify-deploy-overlap.md`.

## The observed failure

The owner hit **`no available server`** while signing in with Google.  The scan
worker saw the app unreachable at `09:38:47`; the app container started at
`09:38:50` — three seconds later.  Six merges in ~25 minutes meant six such
windows.

Two *separate* defects produce that experience.  Both are proven below; only
one of them is the deploy itself.

---

## Finding 1 — Coolify never health-gates a docker-compose deploy

Coolify 4.1.2 **does** implement exactly the rollout we want.  From the running
instance's own source (`docker exec coolify … app/Jobs/ApplicationDeploymentJob.php`,
`rolling_update()`, line 1904):

```php
$this->start_by_compose_file();   // start the NEW container
$this->health_check();            // wait until it reports healthy
$this->stop_running_container();  // only stops the old one if newVersionIsHealthy
```

Every build pack calls it — `deploy_simple_dockerfile`, `deploy_dockerimage_buildpack`,
`deploy_dockerfile_buildpack`, `deploy_nixpacks_buildpack`, `deploy_railpack_buildpack`,
`deploy_static_buildpack` (lines 571, 591, 919, 952, 983, 1015).

**`deploy_docker_compose_buildpack()` (line 607) does not.**  It does this
instead, at line 782:

```php
$this->stop_running_container(force: true);                 // line 782
$this->application_deployment_queue->addLogEntry('Starting new application.');
…
docker compose --project-name … up --build -d                // line 3918
```

`stop_running_container()` is gated on `if ($this->newVersionIsHealthy || $force)`
— and compose passes **`force: true`**, which bypasses the gate entirely.  The
old containers are `docker stop`ped and `docker rm -f`'d *before the new ones
exist*.  The window is unconditional and is the whole of: stop grace period +
`rm` + network setup + `compose up` + image start + Deno boot to first
successful `/health`.

`congress-trade` is `build_pack: dockercompose`.  This is the mechanism, and it
is the same one that produced the 08-10 outage — an overlapping deploy simply
made the remove-phase permanent.

Coolify's docs agree with its source: *"Rolling updates are not supported on
Docker Compose-based deployments."*  The other documented disqualifiers, read
straight out of `rolling_update()`, are host **port mappings**, **consistent
container name**, **custom internal name**, PR deploys, and `--ip`/`--ip6` in
custom run options.

### Consequences for the requested options

* **(a) Enable a health-gated rollout via a setting — NOT POSSIBLE.**  There is
  no toggle.  Compose deploys never reach `rolling_update()`.  Turning the
  application-level health check on or off changes only post-deploy *status
  reporting*; it is cosmetic with respect to downtime.  (Tell: the API reports
  `custom_healthcheck_found: false` even though `app/Dockerfile` has had a
  `HEALTHCHECK` since before this incident — the health data is simply not in
  the compose deploy path.)
* **(b) Keep Traefik on the old container until the new one is ready — NOT
  POSSIBLE.**  Coolify **deletes** the old container before creating the new
  one.  There is no old container left to route to.  No compose key, Traefik
  label, or container `HEALTHCHECK` can change that; both the Dockerfile and
  `app/docker-compose.yml` already declare healthchecks and it makes no
  difference.
* Therefore: **(c)**, plus the migration in "The real fix" below, which reaches
  (a) properly by leaving the compose build pack.

---

## Finding 2 — the route file flapped once a minute, and *that* is the observed error string

`congress.trade` has **no `traefik.*` labels on its container** (verified with
`docker inspect`; only `coolify.managed` and `coolify.name`), and the proxy runs
with `--providers.docker.exposedbydefault=false`.  Traefik's Docker provider
produces **nothing** for this app.

The entire public route is one file-provider file,
`/data/coolify/proxy/dynamic/congress-trade.yml`, rewritten **every 60 seconds**
by `/etc/cron.d/ct-reattach-proxy` → `ct-reattach-proxy.sh`, and Traefik watches
that directory (`--providers.file.directory=/traefik/dynamic/ --providers.file.watch=true`).

The rewrite was `cat > "$DYNAMIC_FILE"`, which opens the watched file with
`O_TRUNC`.  An empty file is valid YAML, so a reload landing in that window
applies a configuration **with no congress routers at all**.  Coolify's own
`default_redirect_503.yaml` then takes the request:

```yaml
routers:
  catchall:
    service: noop
    rule: PathPrefix(`/`)
    priority: -1000
services:
  noop:
    loadBalancer:
      servers: {  }
```

A Traefik load balancer with zero servers answers exactly:

```
HTTP 503   no available server
```

**This matters because a dead backend does not produce that string.**  When the
app container is gone, `congress-app` stops resolving on the `coolify` network
and Traefik returns **502 Bad Gateway**.  `no available server` means the
request fell through to the catch-all — i.e. our routers were briefly absent
from the running config.  So the owner's error was the deploy window *and* the
once-a-minute rewrite race, not the deploy window alone.

**Fixed in this change** (`scripts/ops/ct-reattach-proxy.sh`):

1. Steady state now writes **nothing** — the rendered config is byte-compared
   with what is on disk and the file is left untouched when equal.  Traefik
   receives no inotify event at all, instead of 1440 per day, each one a chance
   to read the file mid-truncate.
2. A genuine change is staged in `/data/coolify/proxy` — mounted into the proxy
   but **not** the watched directory — and `mv`d into place, an atomic rename on
   the same filesystem.  (The staging file must not live in `dynamic/`: Traefik
   parses every file there, so a temp copy would briefly duplicate every router
   name.)
3. The route file is written **independently of the container**, so a mid-deploy
   gap can no longer leave the routers missing.

---

## Finding 3 — the deploy guard is switched OFF

`ct-deploy-guard.timer` — the thing that collapses N merges into one deploy —
is **stopped and disabled**:

```
Loaded: loaded (/etc/systemd/system/ct-deploy-guard.timer; disabled; preset: enabled)
Active: inactive (dead)
Aug 12 07:14:59 fleet-hetzner-nbg1 systemd[1]: ct-deploy-guard.timer: Deactivated successfully.
Aug 12 07:14:59 fleet-hetzner-nbg1 systemd[1]: Stopped ct-deploy-guard.timer.
```

It was turned off at **07:14:59, about two hours and twenty minutes before the
09:38 incident**.  Nothing in this repo disables it, so this was done by hand.
With it off, every merge webhook becomes its own deploy and its own
zero-container window — which is precisely "six merges in 25 minutes, six
windows".  The guard's own last act before being stopped was
`deploying latest main (force=true): site down — bypassing rate limit`.

The guard itself is correct and was working: the 08-11 live run exercised
self-protection, coalescing and rate-limiting on real traffic.  **It is simply
not running.**

---

## What is landed here (safe, no production config touched)

| File | Effect |
| --- | --- |
| `scripts/ops/ct-reattach-proxy.sh` | Atomic + no-op-in-steady-state route file.  Removes the `no available server` race. |
| `services/standby/nginx.conf`, `services/standby/standby.html` | Holding page served with 503 + `Retry-After`. |
| `scripts/ops/ct-standby.service` | Runs that page as `congress-standby` **outside** the Coolify project, so `docker compose … up` for project `<CT_COOLIFY_APP_UUID>` cannot remove it. |

When `congress-standby` is running, `ct-reattach-proxy.sh` automatically emits a
Traefik **`failover`** service instead of the plain one, so deploy-window
requests get the holding page rather than a raw proxy error.  It reverts by
itself the moment the standby stops — there is no flag to remember.

The failover health check probes **`/health`** (the trivial `{"ok":true}`
liveness route), deliberately **not** `/api/health`, which returns 503 when the
database or schema is unhappy and would divert live traffic to a holding page
while the app was still serving.

This converts a hard error into a graceful, self-refreshing page.  It does not
make the deploy invisible — only the migration below does that.

---

## The real fix — move the web app to its own Dockerfile application

This is the only way to get Coolify's health-gated rollout.  **Do not apply any
of this without the owner's go-ahead; it changes live routing.**

1. Create a **new Coolify application**, source = same repo/branch, **build pack
   `Dockerfile`** (not "Docker Compose"), base directory `/app`, Dockerfile
   `app/Dockerfile`, exposed port `5000`.
2. Settings that must be correct, because `rolling_update()` checks each one:
   * **Ports mappings: EMPTY.**  Not `127.0.0.1:5000:5000`, not anything.  A
     host port mapping disables rolling updates outright and logs
     *"Application has ports mapped to the host system, rolling update is not
     supported."*  Nothing in this repo needs the host bind — `congress-health-recover.sh`
     probes `https://congress.trade/api/health`, and the container healthcheck
     is in-container.
   * **Consistent container name: OFF.**  Logs *"Consistent container name
     feature enabled, rolling update is not supported."*
   * **Custom internal name: empty.**
   * **Health check: enabled**, path `/api/health`, port `5000`, expected 200.
     Keep `start_period` generous (the Dockerfile uses 120s) — this is now on
     the critical path of every deploy, and a too-tight window fails the deploy
     rather than the site.
3. Set the FQDNs (`congress.trade`, `www.congress.trade`, `admin.congress.trade`)
   on the new application and let Coolify generate its own Traefik labels.
4. **Retire the hand-rolled route** once the labels are live: remove
   `/etc/cron.d/ct-reattach-proxy` and `/data/coolify/proxy/dynamic/congress-trade.yml`.
   Leaving both in place would give Traefik two router sets for the same hosts.
5. Keep the existing compose application for `sqlite-web` and `scan-cpu-worker`
   only — delete the `congress-app` service from `app/docker-compose.yml` and
   point `scan-cpu-worker`'s `CONGRESS_TRADE_API_URL` at the new app's network
   alias.  Both are non-user-facing, so their deploy windows do not matter.
6. `/data/congress-trade` must stay a bind mount on the new application.  Note
   the consequence: during a rolling update **two containers hold the same
   SQLite file for a few seconds**.  The old one is idle-but-alive; WAL mode
   tolerates this, but the cutover should still be verified against a real
   deploy (step 3 of the verification below), and Litestream should be checked
   for a double-replicate warning.

### Verification — this is the acceptance test, not "the setting looks right"

A setting that reads correctly proves nothing.  The rollout is verified only by
**observing a deploy in which the old container is still serving while the new
one is coming up**:

```bash
# 1. Watch container lifecycle across the deploy.  The PASS condition is an
#    interval where BOTH containers exist, with the old one removed only after
#    the new one is healthy.
ssh coolify 'docker events --filter type=container --format \
  "{{.Time}} {{.Action}} {{index .Actor.Attributes \"name\"}}"' &

# 2. Continuous edge probe at 200ms.  PASS = zero non-200 responses.
while :; do
  printf '%s %s\n' "$(date +%T)" \
    "$(curl -s -o /dev/null -w '%{http_code}' -A "$UA" https://congress.trade/api/health)"
  sleep 0.2
done | tee /tmp/deploy-probe.log

# 3. Trigger the deploy, then assert:
grep -vc ' 200$' /tmp/deploy-probe.log        # must be 0
```

And in the Coolify deployment log, the PASS marker is literally:

```
Rolling update started.
Waiting for healthcheck to pass on the new container.
…
Removing old containers.
Rolling update completed.
```

If the log instead says `Removing old containers.` *before* `Starting new
application.`, the rollout did **not** happen and one of the four disqualifiers
above is still set.

---

## 2026-08-20 update — docs-only skip is live

`watch_paths` on `<CT_COOLIFY_APP_UUID>` is now `app/**` + `services/**`.
A docs-only merge no longer queues a compose swap.  Code merges still take
the origin down until PR #1964 is installed or this app leaves the compose
build pack.  Receipt: `docs/rollouts/2026-08-20-docs-only-deploy-skip.md`.

## Immediate actions, cheapest first

1. **Keep `fleet-deploy-guard@congress-trade.timer` enabled.**  Do **not**
   re-enable the superseded `ct-deploy-guard.timer` (see
   `docs/rollouts/2026-08-13-deploy-guard-post.md`).  If merge latency is
   painful, lower `MIN_DEPLOY_INTERVAL_SEC` on the fleet unit rather than
   leaving the guard off — an unguarded burst is what the owner just
   experienced.
2. **Install the fixed reattach script** (removes the `no available server`
   race; the script is idempotent and reverts cleanly):
   ```bash
   scp scripts/ops/ct-reattach-proxy.sh coolify:/usr/local/bin/ct-reattach-proxy.sh
   ssh coolify 'chmod 0755 /usr/local/bin/ct-reattach-proxy.sh && /usr/local/bin/ct-reattach-proxy.sh'
   # verify: the file is byte-identical on the next two runs and its mtime stops moving
   ssh coolify 'stat -c %y /data/coolify/proxy/dynamic/congress-trade.yml; sleep 90; \
                stat -c %y /data/coolify/proxy/dynamic/congress-trade.yml'
   ```
3. **Install the standby** (see the install block in `scripts/ops/ct-standby.service`).
   Verify with `curl -H 'Host: congress.trade' http://congress-standby:8080/` from
   inside the `coolify` network, then confirm the route file switched to
   `service: congress-front`.
4. **Batch deploys into the dead window.**  Filing traffic is nil from
   **20:00–08:59 ET** for both chambers, so a deploy there costs almost nothing
   even at today's window length.  This is a scheduling policy for the guard,
   not a code change.
5. **Then** schedule the Dockerfile-application migration above.

---

## Separate structural problem — one host runs everything

Not fixed by zero-downtime deploys, and worth its own lane.

`fleet-hetzner-nbg1` (<PROD_ORIGIN_IP>) carries **all** of: the CI runners
`hetzner-ct-ci-1/2`, the production app, the 1.88 GB SQLite database, and the
sibling apps' Coolify workloads.  A six-PR CI burst measurably degraded
production — `/` took **20 s** while `/api/health` took **0.23 s**, load average
**3.31**.  That shape (edge slow, app fast) is CPU starvation of the render
path, not a database problem.

Two more measurements from this investigation:

* **Disk is at 70 %** — 100 G used of 150 G on `/dev/sda1`, shared by the
  database, Docker images, build caches and CI workspaces.  A build cache blowup
  and a database growth event compete for the same 44 G.
* **Traefik access logs are off** — `docker logs coolify-proxy --since 6h`
  returned **0 lines**.  Every edge-level incident so far has had to be
  reconstructed from application and worker logs.  Enabling access logs would
  have answered "502 or 503?" for the 09:38 event in one query instead of by
  source-reading Traefik's balancer semantics.

The structural fix is to move the CI runners off the production host.  Until
then, `concurrent_builds=1` remains load-bearing and box-wide (it also protects
ST and UM) and must not be raised.
