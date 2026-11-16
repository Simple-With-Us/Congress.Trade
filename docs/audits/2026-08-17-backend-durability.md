# 2026-08-17 — Congress.Trade backend durability audit

**Author:** Cursor (Cloud).  Read-only.  No production writes, no host installs, no schema changes.
**Method:** repo evidence on `main` (`be53b3e5`) plus live public health probes at 2026-08-17 23:44 UTC.  Accounts for open Coolify overlap PR [#1964](https://github.com/jaywedgeworth22/Congress.Trade/pull/1964) and merged Senate fallback [#1961](https://github.com/jaywedgeworth22/Congress.Trade/pull/1961).
**Keepout:** did not edit `#1964` compose/overlap scripts, `#1959` OCR, `#1966` latency corpus, or extract/halt/billing code.  Sibling Cursor claim `cursor/prod-incident-audit-f506` owns the leftover OpenRouter files-prepaid halt.

Severity used here:

| Sev | Meaning |
|---|---|
| **S1** | User-visible outage, silent pipeline halt, or single-host blast radius.  Fix first. |
| **S2** | Durability / recovery gap that will hurt the next real incident. |
| **S3** | Observability, capacity, or hygiene.  Cheap and worth doing; not the blast radius. |

HTTP 200 on `/api/health` is **not** an availability SLO.  Live tonight it is 200 while `status` is `stalled`.

---

## 1. Live snapshot (2026-08-17 23:44 UTC)

Probed with a browser User-Agent from this VM.  No admin token.  No secrets printed.

| Probe | HTTP | What it actually said |
|---|---|---|
| `GET /health` | 200 | `{"ok":true}` — process liveness only (`app/src/index.ts`) |
| `GET /api/health` | **200** | `ok:true`, `db:true`, **`status:"stalled"`**, build `be53b3e57109` |
| `GET /api/health/polling` | 200 | House 2–3m, Senate 1–2m, Executive 15–16m |
| `GET /api/health/latency` | **503** | Quiver quiet 137h, Unusual Whales quiet 100h |
| `GET /api/health/senate-relay` | 200 | `scout.jays.services` HTTP 200, mode `relay` |
| `GET /api/health/deep` | **503** | Same pipeline `stalled` as `/api/health` JSON |

`/api/health` storage and cost profile (public fields only):

- **Cost profile `paid`:** cron `* * * * *`, `drainLimit` 100, `drainClaimSize` 25, `outboxLimit` 100.  Code default is `free` (`app/src/deno/costProfile.ts`).  Production overrides are live.
- **Litestream:** `replicating`, age **2.0s**, last LTX `2026-08-17T23:44:31Z`.
- **R2 weekly:** `ok`, key `weekly/congress-trade-20260816T181501Z.db`, age ~29h (Sunday job; expected).
- **Secrets resolver:** shared 65 ok, app 145 ok, cache ready, 0 errors.

Pipeline checks at that instant:

| Check | Status | Detail (truncated) |
|---|---|---|
| `ingestion_backlog` | ok | Outbox backlog clear |
| `ingestion_dead_letter` | degraded | **316** failed outbox items |
| `extraction_provider` | **stalled** | No extraction attempts in 24h; autopilot halted (`error_class:billing`, leftover OpenRouter files prepaid string) |
| `extraction_backlog` | ok | Review backlog 9 |
| `autopilot_halt` | **stalled** | Same leftover billing latch |
| `data_freshness` | degraded | Latest transaction **149h** old (threshold 96h) |
| `polling_house/senate/executive` | ok | All chambers live |
| `latency_probes` | degraded | Quiver 137h, UW 100h (48h silence) |
| `senate_relay` | ok | Probed 35s ago |

Discovery is healthy.  Extraction is not.  The site can serve the last published corpus while new official filings stop becoming trades.  That is the current durability picture, not a deploy failure.

---

## 2. In-flight PRs this audit must not steal

| PR | State | Relevance |
|---|---|---|
| **[#1961](https://github.com/jaywedgeworth22/Congress.Trade/pull/1961)** Senate fallback | **Merged** 2026-08-17 21:16Z | Named tunnel stays `https://scout.jays.services`.  Cloudflare 502/5xx on the Mac origin falls back to box eFD.  `#1610` `/fetch-doc` unchanged when the relay answers.  Live tonight: relay **up**, so fallback is latent. |
| **[#1964](https://github.com/jaywedgeworth22/Congress.Trade/pull/1964)** Coolify overlap | **Open**, not installed | Clones `congress-hold` outside the Coolify project and fails Traefik over to it during compose stop-then-start.  **Merge alone does nothing.**  Host systemd install is the actual fix. |
| #1966 latency corpus | Open | Methodology only.  Does not change probe health. |
| #1959 scanned-pdf OCR | Draft | Extraction path.  Keepout. |
| `cursor/prod-incident-audit-f506` | Claimed in `#ag***-s**c` | Owns review-queue catalog + leftover files-prepaid halt.  Keepout. |

UptimeRobot incidents at **16:18 CDT** and **16:29 CDT** today match the documented Coolify compose gap (seconds-to-minutes with zero in-project app containers).  This audit did not have Traefik access logs to prove those two flaps were deploys.  The mechanism is proven from 2026-08-12 and 2026-08-14 (~90s gap on `#1863`).

---

## 3. Shape (what is actually running)

Production is **not** Cloudflare Workers.  The live path is one Deno process in `congress-app` on Coolify (`fleet-hetzner-nbg1`), SQLite file at `/data/congress-trade/db.sqlite`, Deno KV at `/data/congress-trade/kv.sqlite`, R2 for filing PDFs, Litestream → B2 for the DB.

```
Browser / iOS
    → Cloudflare edge (managed challenge; non-browser UA often 502)
    → Traefik file provider `/data/coolify/proxy/dynamic/congress-trade.yml`
         (rewritten by ct-reattach-proxy.sh; no Docker labels)
    → congress-app:5000  (or 502 if the container is gone)
         Deno.serve → Hono (app/src/index.ts)
         libsql → /data/congress-trade/db.sqlite
         Deno.openKv → kv.sqlite
         deno_runtime_queue (ingest + delivery)
    Litestream replicate (PID 1) → B2, 5m sync, 7d LTX
    sqlite-web + scan-cpu-worker share the Coolify compose project
```

Coolify build pack is **dockercompose**.  `deploy_docker_compose_buildpack()` calls `stop_running_container(force: true)` **before** `compose up`.  Rolling update exists in Coolify for Dockerfile apps and is unreachable here.  Evidence: `docs/rollouts/2026-08-12-deploy-downtime-gap.md` (Coolify 4.1.2 source, lines cited there).

Compose blockers that also disable `rolling_update()` even after a Dockerfile migration:

- `container_name: congress-app` (`app/docker-compose.yml:35`)
- Host bind `127.0.0.1:5000:5000` (`:40-41`) — watchdog and overlap still need this bind until they move

---

## 4. Findings

### 4.1 Framework and API

**What is solid.**  Hono app with defense-in-depth headers (`app/src/security/headers.ts`), public-API bot guard (300 req / 5 min / IP, 3k rows / day), fail-closed admin (`app/src/admin/routes.ts` — no token and no Access ⇒ 401 unless explicit open-admin in non-prod).  Delivery create is signed-in + Premium (401/402).  Feed and analytics stay public by owner decision.  Webhook delivery CAS-claims `(subscription_id, tx_id)` and tells recipients to dedupe `X-Subscription-Id` + `X-Tx-Id`.

**Gaps.**

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| F1 | S3 | No global HTTP timeout or Hono body-limit middleware.  Caps are per-caller (webhook 10s, Senate probe 5s, filing 25 MiB).  A stuck upstream on an unguarded route holds a Deno slot. | `app/src/delivery/webhook.ts:49`, `app/src/ingestion/fetcher.ts:39`, `app/src/ingestion/senateRelayHealth.ts:23` |
| F2 | S3 | Bot defense and rate limits **fail open** on CONFIG_KV errors.  Correct for availability; wrong if KV is the thing under attack. | `app/src/security/botDefense.ts`, `app/src/shared/rateLimit.ts` |
| F3 | S3 | SSE is a 5s poll with a 25-minute reconnect contract, not infinite push.  Clients that ignore `event: reconnect` look "dead." | `app/src/delivery/sse.ts` |
| F4 | S2 | Two cron orchestrations still exist: Deno `runScheduledTick` (DB singleton) vs Workers `scheduled()` in `app/src/index.ts` (no singleton).  Live is Deno-only.  Drift is a footgun if preview/Workers is ever pointed at the same file. | `app/src/deno/scheduledTick.ts`, `app/src/index.ts` |

### 4.2 Persistence

**What is solid.**  Single libsql client, `PRAGMA busy_timeout = 10000`, write batches owned by libsql (no nested `BEGIN` — that broke review confirm).  Live uniqueness is partial unique index `(doc_id, source, row_key) WHERE row_key IS NOT NULL AND deprecated_at IS NULL`.  Persist is `INSERT OR IGNORE` plus delivery-outbox in the same batch.  Readiness probes a large required-schema list.  Prod migrate is the idempotent statement list in `POST /api/admin/migrate`, not `wrangler d1 --remote`.

**WAL.**  The app never sets `PRAGMA journal_mode=WAL`.  Litestream 0.5 requires WAL and is **live replicating** tonight.  The 2026-07-30 cutover already measured `db.sqlite-wal` advancing.  Treat WAL as **Litestream-implied**, not app-guaranteed.  If the entrypoint falls through to Deno-only (`start-with-litestream.sh` warns and continues when Infisical/binary is missing), journal mode is whatever SQLite last used.

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| P1 | S2 | One SQLite file (~1.88 GB) holds corpus, queues, outboxes, CONFIG_KV mirror, cron locks.  HTTP + cron + queue drain + sqlite-web share it.  `busy_timeout` is 10s then fail. | `app/src/deno/main.ts:71-76`, `app/docker-compose.yml:42-43,76-77` |
| P2 | S2 | `/migrate` applies statements as independent round trips.  Documented `cursor_seq` trigger window: DROP-then-CREATE left a gap where concurrent INSERTs landed `cursor_seq = NULL` and vanished from the feed.  Current list creates `_v2` first, then drops v1 — better, still not one transaction. | `app/src/admin/migrations.ts:11-20`, `app/src/admin/routes.ts` migrate loop |
| P3 | S2 | Local `app/migrations/*.sql` vs prod statement list can drift.  Missing a mirror is a silent prod schema gap until readiness fails. | `AGENTS.md`, `app/package.json` `migrate` vs `admin/migrations.ts` |
| P4 | S2 | Deno KV (`kv.sqlite`) is **not** in Litestream.  Fleet 6h snapshot copies it best-effort.  Restore of `db.sqlite` without matching KV is split-brain (relay probe cache, eFD session, alarm dedup, Infisical cache). | `app/litestream.yml:55-56`, `scripts/ops/fleet-sqlite-backup.sh` |
| P5 | S3 | D1 shim meters `rows_read` as result row count.  `get()` / `.first()` is unmetered.  Budget alerts undercount scans. | `app/src/deno/shims.ts`, `app/src/shared/d1Budget.ts` |
| P6 | S3 | `foreign_keys` is never enabled.  Orphans are possible if application deletes are incomplete. | grep across `app/` |

### 4.3 Queues, concurrency, cache

**What is solid.**  Three-layer handoff: discovery → `ingestion_outbox` → `deno_runtime_queue` ingest → transactions + `delivery_outbox` → `deno_runtime_queue` delivery → webhook CAS.  Queue claim is `UPDATE … RETURNING` with 10-minute lease, 8 attempts, exp backoff cap 30 min, lease fencing so a stale worker cannot write after reclaim.  Tick overlap: in-isolate `tickInFlight` plus DB singleton in `deno_runtime_kv`.  Outbox flush is optimistic CAS.  Production drain is **paid / 100**, not the code-default free profile of 2 msgs / 15 min (that free default starved extraction for ~3 days on 2026-08-01; Coolify now sets `CT_DRAIN_LIMIT=100`, `CT_TICK_DEADLINE_MS=240000` per effort log).

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| Q1 | S2 | Default tick deadline in code is still **45s**.  Production depends on a Coolify env override.  If that env is dropped on a rebuild, paid drain of 100 messages will abort every minute. | `app/src/deno/main.ts:166-168`; effort log 2026-08-01 |
| Q2 | S2 | Slow tick **skips** the next cron entirely.  Under SQLITE_BUSY or a fat extract, watcher/outbox pause for a full interval. | `app/src/deno/main.ts:157-159` |
| Q3 | S3 | Daily lane lock **fails open** on KV/SQL error (lane runs unguarded). | `app/src/deno/cronLanes.ts` |
| Q4 | S2 | 316 dead-letter ingestion_outbox rows are `degraded`, not `stalled`.  They do not trip `/api/health/polling` or Coolify.  Historical class: `consumer retry budget exhausted` (`transientDlq.ts:4-6`; was 309 on 2026-08-14, **316** tonight). | Live `/api/health`; `app/src/shared/pipelineHealth.ts` |
| Q5 | S3 | CONFIG_KV has no atomic increment.  Telemetry outbox counts are best-effort and fail closed at cap. | `app/src/shared/thirdPartyTelemetry.ts` |
| Q6 | S3 | Analytics `cached()` is KV read-through, no stampede lock.  Fine at current QPS; thundering herd on KV expiry. | `app/src/shared/kvCache.ts` |

At-least-once is explicit and acceptable: crash between queue `send()` and outbox `enqueued` duplicates a message; dedupe index + delivery CAS absorb it.  Recipients must still dedupe.  Do not "fix" this into exactly-once.

### 4.4 Coolify deployment (today vs #1964)

**Today (main, before #1964 is installed):**

1. Coolify stops and removes in-project containers (`congress-app`, `sqlite-web`, `scan-cpu-worker`).
2. Gap: no in-project app until image start + Deno boot.  Healthcheck `start_period` is 120s.
3. Traefik still has routers (atomic reattach on main).  Backend name `congress-app` does not resolve → **502**.  If routers were ever empty, catch-all is **503 `no available server`**.
4. Optional `congress-standby` (outside the project) can serve a 503 holding page.  Effort log 2026-08-12: host Traefik/standby install was **still un-run**.  This VM cannot confirm current host units.
5. `congress-health-recover.sh` correctly skips remediates while a Coolify deploy is active (`scripts/ops/congress-health-recover.sh:291`).
6. `scan-cpu-worker` `depends_on: congress-app` — worker dies with the app on every swap.

**#1964 (open):** clone live app as `congress-hold` outside the project; Traefik failover prefers hold (real API) over standby.  Hold runs bare `deno run` (no Litestream) against the same `/data/congress-trade` bind.  WAL serializes the short two-writer window.  Offline tests exist.  **Host `ct-deploy-overlap.service` is not installed from the agent VM.**

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| D1 | **S1** | Every compose deploy has a zero in-project-container window.  Users see 502 / `no available server`.  UptimeRobot flaps.  Measured ~90s on 2026-08-14.  Today's 16:18 / 16:29 CDT incidents fit this class. | `docs/rollouts/2026-08-12-deploy-downtime-gap.md`; `#1964` still open |
| D2 | **S1** | `#1964` merge without host install is a false close of #1537.  The next auto-deploy on `main` will still drop the backend. | `#1964` body |
| D3 | S2 | Native Coolify rolling update still blocked (compose pack + `container_name` + host port).  Overlap is a workaround.  Dockerfile-application migration is owner-gated and unverified. | downtime-gap doc § "The real fix" |
| D4 | S2 | Two writers on one SQLite file during hold+new-app overlap — acknowledged, not load-tested on prod. | `#1964` rollout (PR-only file) |
| D5 | S3 | Traefik access logs are off.  Every edge incident is reconstructed from app logs and Coolify timestamps. | downtime-gap doc Finding 3 / structural notes |
| D6 | S3 | `ct-deploy-guard.timer` was manually disabled 2026-08-12.  Fleet guard `@congress-trade` is the replacement.  Burst merges still multiply windows if the fleet timer is off. | downtime-gap doc |

### 4.5 Relay dependencies

**Landed (#1961).**  Relay-first for `/fetch-ptr` and `/fetch-doc`.  Unreachable class is Cloudflare origin-down `{502,503,504,521–524}` or connect error → direct eFD on the box.  Mirrored 404/403/400 stay on the relay path.  `GET /api/health/senate-relay` live-probes in 5s.  `senate_relay` on `/api/health` uses the last KV probe (no extra outbound hop).

**Live tonight:** relay is up.  Fallback is unexercised in production from this vantage.

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| R1 | **S1** | Preferred Senate path is still one residential Mac + named tunnel.  Sleeping Mac → stable 502 at the permanent hostname.  Fallback works only while Imperva allows Hetzner egress.  If the WAF returns, `polling_senate` goes FAILING.  **Do not rotate `SENATE_RELAY_URL`.** | `docs/rollouts/2026-08-17-senate-relay-host-dependency.md`; `AGENTS.md` |
| R2 | S2 | `SENATE_PROXY_URL` is typed and unused.  Paid residential proxy is the documented later option, not wired. | `app/src/shared/types.ts`; host-dependency rollout |
| R3 | S3 | `HOUSE_RELAY_URL` / `OGE_RELAY_URL` / `INGEST_RELAY_URL` are implemented (`houseSource.ts`, `ogeSource.ts`) but not documented as live.  Watcher does not thread them the way it threads `SENATE_RELAY_URL` (process.env fallback only). | `app/src/ingestion/watcher.ts` vs `senateSource.ts:371-378` |
| R4 | S3 | `polling_senate` can stay ok on the fallback while the Mac is dead.  That is intentional.  Paging the laptop requires `/api/health/senate-relay` (or the `senate_relay` pipeline check going stalled).  UptimeRobot free plan was 9/10 as of 2026-08-10 — this URL may not have a slot. | `app/src/delivery/rest.ts:583-591`; live 200 tonight |

### 4.6 Latency and capacity

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| L1 | S2 | Latency monitors are doing their job: `/api/health/latency` is **503** because Quiver (137h) and UW (100h) are quiet.  Owner action is renew/replace those credentials, not a code path. | Live probe; effort log `#1903` |
| L2 | S2 | Latest published transaction is **149h** old.  Chambers are polling.  Extraction is halted.  Freshness is an extraction/halt problem, not a discovery outage. | Live `data_freshness` |
| L3 | **S1** | Single host `fleet-hetzner-nbg1` (8c / 15 GiB / 150 GiB) runs prod app + 1.88 GB SQLite + Litestream + CI runners (`hetzner-ct-ci-1/2`) + sibling Coolify apps.  2026-08-12: CI burst → `/` 20s, `/api/health` 0.23s, load 3.31.  Disk was ~70% then; 2026-08-10 hit 100% and a deploy died mid-pull.  `concurrent_builds=1` is load-bearing. | downtime-gap doc; `docs/rollouts/2026-08-10-box-disk-hygiene.md` |
| L4 | S3 | `congress-app` cap 2 CPU / 3 GiB; `scan-cpu-worker` 2 CPU / 1 GiB.  Ceilings exist because the worker once ran at 283% CPU on discarded OCR.  Fine as runaway bounds; they do not add capacity. | `app/docker-compose.yml:3-17` |
| L5 | S3 | Parser-class latency bugs (observations stored, no filer in trade hash) stay `running` and never match.  Silence monitors will not page until observations stop. | `app/src/ingestion/tradeLatency.ts` (filer-missing warn) |

### 4.7 Retries

| Path | Policy | Notes |
|---|---|---|
| `trackedFetch` | **No retry** | Callers retry. |
| Ingest | 408/425/429/5xx/403/fresh 404 → `IngestRetryError`; exp backoff 5×2^(n-1) cap; queue 8 attempts | `app/src/ingestion/fetcher.ts` |
| Durable queue | lease 10 min, 8 attempts, base 30s, cap 30 min, DLQ recovery cycles 8 | `app/src/deno/durableQueue.ts` |
| Webhook | 5 attempts, 10s POST, jittered backoff cap 900s, **per-target circuit** (5 failures → 1 probe/hour) | `app/src/delivery/webhook.ts`, `targetCircuit.ts` |
| OpenRouter budget | 3 failures → 1h open | `openRouterBudgetCircuit.ts` |
| Price 429 | 3 retries, 5/15/30s + Retry-After cap 60s | `prices/retry429.ts` |
| Usage Monitor budget gate | **Fail open** | Discretionary autopilot only |
| Litestream start | Fail **open** (app starts, logs ERROR-LEVEL WARNING) if binary/CLI missing; fail **closed** if 1–4 of 5 B2 keys present | `app/scripts/start-with-litestream.sh:56-108` |

Retry design is mature.  The live extraction stall is a **stored halt string**, not a retry-budget problem.  Do not widen retries to paper over that latch.

### 4.8 Observability and health semantics

This is the sharpest SLO mismatch in the stack.

| Surface | 503 when | Stays 200 when |
|---|---|---|
| `GET /health` | never | process up |
| `GET /api/health` | readiness fail (DB/schema) | **pipeline `stalled`** (live tonight) |
| `GET /api/health/deep` | `pipeline.status === 'stalled'` | degraded-only |
| `GET /api/health/polling` | any chamber `stalled` | extraction halt, DLQ, latency |
| `GET /api/health/latency` | latency check `stalled` **or** `degraded` | extraction halt |
| `GET /api/health/senate-relay` | live probe fail | polling still ok via fallback |
| Coolify / compose healthcheck | wget `/api/health` non-200 | pipeline stall (intentional — do not bounce the box for a billing latch) |
| GitHub `uptime-monitor.yml` | HTTP ≠ 200 **or** JSON `status === 'stalled'` | — will **fail every 5 min** during the current leftover halt |
| UptimeRobot (HTTP) | non-200 | JSON `stalled` if it only checks status code |

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| H1 | **S1** | No dedicated pager for **extraction / autopilot halt**.  Polling monitors are green.  Main `/api/health` is HTTP 200.  GitHub uptime workflow fails on JSON `stalled` (issue noise) while UptimeRobot on HTTP likely stays green.  Three different contracts, none of which is written down as the SLO. | `app/src/delivery/rest.ts:499-524`; `.github/workflows/uptime-monitor.yml:56-59`; live 200 + stalled |
| H2 | S2 | `/api/health` caches readiness + pipeline **60s**.  Fine for Coolify.  Wrong if someone pages off the cached JSON. | `READINESS_CACHE_TTL_MS` in `rest.ts` |
| H3 | S2 | `ingestion_dead_letter` and `data_freshness` are degraded.  They will not page polling/latency monitors.  316 DLQ + 149h freshness are the actual user-visible corpus stall **symptoms**, with halt as the cause. | Live pipeline |
| H4 | S3 | Sentry traces 0.1 HTTP / 0 queue; `IngestRetryError` / `DeliveryRetryError` suppressed (correct).  No unified JSON log schema.  Traefik access logs off. | `app/src/index.ts`; downtime-gap doc |
| H5 | S3 | Pushover covers OpenRouter budget, liveness sweep (including `senate_relay`), R2 daily.  Generic pipeline stall is not a first-class Pushover. | `autonomySweeps.ts`, `pushover.ts` |

**Do not** make `/api/health` return 503 on pipeline stall.  Coolify and the watchdog would restart a healthy process during a billing latch (already a 2026-08-14 class of false outage).  The fix is a **third contract**: page `GET /api/health/deep` or a new `/api/health/pipeline` and document that `/api/health` is deploy/DB liveness only.

### 4.9 Backup, restore, disaster recovery

Documented layers (`app/src/shared/r2Usage.ts:256-277`, `app/litestream.yml`):

| Layer | Implied RPO | Proven? |
|---|---|---|
| Litestream → B2 (`sync-interval: 5m`, snapshot 24h, retain 168h) | ~5 min | **Live replicating** tonight (age 2s).  B2 restore drill PASS 2026-08-14 (receipt in Usage-Monitor repo, not here). |
| Fleet cron `.backup` → B2 `hetzner/` every 6h | ~6 h | Proven 2026-08-09 (1.69 GB first run). |
| Hetzner volume snapshot | ~24 h | Documented floor; not exercised in this audit. |
| R2 weekly `weekly/*.db` | ~7 d | Live `ok` tonight.  Was 401 for an extended stretch (wrong account token). |
| Deno KV | 6h file copy only | Not continuous. |
| R2 `raw/` PDFs | object store, not DB | Product corpus.  Separate from Litestream. |

`start-with-litestream.sh` will `litestream restore -if-db-not-exists` on an empty volume.  There is **no** in-repo operator runbook for: host loss, paired DB+KV restore, R2 `raw/` rebuild, or "promote weekly file to prod."  The Sun 04:30 integrity drill is named in the 2026-08-09 rollout and **not implemented in this repo**.

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| B1 | **S1** | Host total loss RTO is **unbounded**.  One box, no secondary region, no written restore-to-new-Coolify procedure. | `AGENTS.md` Current Shape; no DR runbook under `docs/` |
| B2 | S2 | KV not in Litestream → restore split-brain. | `app/litestream.yml` |
| B3 | S2 | Weekly restore drill is documentation only. | `docs/rollouts/2026-08-09-offsite-backups-b2-r2.md` |
| B4 | S2 | Litestream can silently be off (missing CLI/binary) while the app stays up.  Health `litestreamStatus` would go `unknown` / age null — only if someone looks. | `start-with-litestream.sh:58-61`; `litestreamAge.ts` |
| B5 | S3 | Infisical down: in-process cache ~600s; **container start** cannot mint Litestream env.  New deploys lose replication until secrets return. | `start-with-litestream.sh`; `AGENTS.md` |

---

## 5. SLO gaps (none are written down)

There is no availability, ingest-freshness, or restore SLO in-repo.  Implied numbers from code and rollouts, versus what is actually enforced:

| Candidate SLO | Implied target | Enforced by | Gap |
|---|---|---|---|
| **Edge availability** | "Always up" | UptimeRobot on HTTP `/api/health` | Every compose deploy violates it.  `#1964` uninstalled.  No error budget. |
| **DB/process liveness** | Container healthy | Coolify wget `/api/health` | Correctly ignores pipeline stall.  Undocumented. |
| **Chamber discovery** | House/Senate ~hours, Executive ~26h | `/api/health/polling` 503 + Pushover liveness sweep | Working tonight. |
| **Latency probes** | No provider silent >48h; system silent >24h | `/api/health/latency` 503 | **In violation** (Quiver/UW).  Credentials, not code. |
| **Senate preferred path** | Mac origin up | `/api/health/senate-relay` | Working tonight.  No UptimeRobot slot confirmed.  Fallback has no SLO for Imperva re-block. |
| **Extraction / publish** | New official filings become trades | None (HTTP).  GitHub uptime fails on JSON `stalled` | **In violation** (halt + 149h freshness + 316 DLQ).  No owner pager contract. |
| **RPO** | 5 min (Litestream) / 6h (snapshot) / 24h (volume) | Health `litestreamAgeSeconds`; UM reads it | Live 2s.  KV RPO is 6h. |
| **RTO** | "minutes" for process restart | `congress-health-recover` | Host-loss RTO unset.  Restore drill not in this repo. |
| **Deploy change-fail** | Invisible deploys | None | Compose stop-then-start.  Standby is 503 by design (still pages).  Hold path (#1964) would serve real API if installed. |

Legal copy already says the service is "AS IS" / "AS AVAILABLE" (`app/src/ui/legalHtml.ts`).  That is not an operational SLO.  Operators are paging off three different health contracts and a leftover halt string.

---

## 6. Prioritized fixes

Owner-gated or already claimed items are marked.  This audit does not implement them.

### P0 — do these before the next merge storm

1. **Install `#1964` on `fleet-hetzner-nbg1`** (`ct-deploy-overlap.service` + current `ct-reattach-proxy.sh`), then watch **one** real deploy: `congress-hold` Up while `congress-app` is gone, public body not `no available server`.  Do not close #1537 on merge alone.
2. **Confirm `fleet-deploy-guard@congress-trade.timer` is enabled.**  If 30-minute coalesce hurts, lower `MIN_DEPLOY_INTERVAL_SEC`.  Do not leave the guard off.
3. **Pick one pipeline-halt pager** (`GET /api/health/deep` or a thin `/api/health/pipeline`) and point a monitor at it.  Leave Coolify on `/api/health`.  Stop treating GitHub `uptime-monitor.yml` JSON-`stalled` as the silent contract — either document it or stop opening issues for a known leftover latch.
4. **Do not rotate `SENATE_RELAY_URL`.**  If Senate discovery fails after an Imperva 403, finish the always-on Mac/Pi origin on the same named tunnel (`docs/rollouts/2026-08-17-senate-relay-host-dependency.md`).

The leftover OpenRouter files-prepaid halt, 316 DLQ, and 149h freshness are **production incidents**, not deploy bugs.  They sit with the claimed `cursor/prod-incident-audit-f506` / owner billing lane.  This audit only records that health semantics hide them from HTTP `/api/health`.

### P1 — durability that will matter on the next real outage

5. Write **`docs/runbooks/restore-congress-trade.md`**: Litestream PITR, 6h B2 `.backup`, weekly R2 file, **paired KV restore**, Infisical bootstrap, Traefik reattach, overlap unit.  Name RTO targets (process restart vs host loss).
6. Implement the Sunday integrity drill that the 2026-08-09 rollout already promised, **in this repo**.
7. Replicate or snapshot `kv.sqlite` on the same cadence as the DB, or accept and document "KV is ephemeral; sessions/alarms reset on restore."
8. Pin `CT_TICK_DEADLINE_MS` / `CT_COST_PROFILE=paid` / drain overrides in a checked-in Coolify env inventory so a rebuild cannot silently revert to 45s / `free`.
9. Enable Traefik access logs (or an equivalent edge log) so the next 502-vs-503 argument is a query, not a source-read.

### P2 — capacity and structural risk

10. Move CI runners off the production box, or keep `concurrent_builds=1` and treat disk/CI cache as a prod dependency (`docs/rollouts/2026-08-10-box-disk-hygiene.md`).
11. Owner-gated: Dockerfile Coolify application, empty port mappings, no `container_name`, health-gated `rolling_update()`.  Verify with the 200ms edge probe in the 2026-08-12 doc.  Overlap is the interim.
12. Set `PRAGMA journal_mode=WAL` and `foreign_keys=ON` at libsql bootstrap so WAL does not depend on Litestream starting.
13. Thread `HOUSE_RELAY_URL` / `OGE_RELAY_URL` from `env` the same way Senate is threaded, or delete the illusion that they are live.
14. Drain/requeue the 316 transient DLQ rows with the existing dry-run admin path after the halt is honestly cleared — not before.

### P3 — hygiene

15. Fail-closed daily-lane lock (skip, don't double-run) on lock-store errors.
16. Fix D1 shim `rows_read` or stop pretending the row budget sees scans.
17. Add `Cache-Control: no-store` on `/api/health` (polling/latency/senate-relay already have it).
18. Optional UptimeRobot slot for `/api/health/senate-relay` when a free-plan slot exists.
19. Retire Oracle-era comments (`CT_TICK_DEADLINE_MS` "Oracle container", `mac-server-watchdog.sh` still naming `<ORACLE_IP_RETIRED>`).

---

## 7. What this audit did not do

- No SSH to `coolify`, no Coolify API, no host unit inventory.  `#1964` install state and `ct-standby` / fleet-guard timers are **unconfirmed** from this VM.
- No production SQL, no migrate, no queue drain, no secret values.
- No load test of two SQLite writers (hold + app).
- No restore actually executed.
- Did not change extract/halt/billing.  Live `error_class:billing` string is recorded as evidence only.

---

## 8. File index (jump list)

| Area | Primary paths |
|---|---|
| Deno entry / cron | `app/src/deno/main.ts`, `scheduledTick.ts`, `costProfile.ts`, `durableQueue.ts` |
| HTTP / health | `app/src/index.ts`, `app/src/delivery/rest.ts`, `app/src/shared/pipelineHealth.ts`, `app/src/shared/readiness.ts` |
| Senate fallback | `app/src/ingestion/senateRelayHealth.ts`, `senateSource.ts`, `fetcher.ts` |
| Persist / migrate | `app/src/deno/shims.ts`, `app/src/admin/routes.ts`, `app/src/admin/migrations.ts` |
| Compose / deploy | `app/docker-compose.yml`, `app/Dockerfile`, `app/scripts/start-with-litestream.sh`, `app/litestream.yml`, `scripts/ops/ct-reattach-proxy.sh`, `scripts/ops/congress-health-recover.sh` |
| Overlap (PR only) | `#1964` `scripts/ops/ct-deploy-overlap.sh`, `docs/rollouts/2026-08-17-coolify-deploy-overlap.md` |
| Prior incidents | `docs/rollouts/2026-08-12-deploy-downtime-gap.md`, `2026-08-17-senate-relay-host-dependency.md`, `2026-08-09-offsite-backups-b2-r2.md`, `2026-08-10-box-disk-hygiene.md` |
