# Deno Deploy cost minimization (free-tier survival)

> **Current shape (2026-08):** Deno Deploy is retired.  Production is Coolify
> Deno-in-Docker on Hetzner, SQLite + Litestream, Infisical,
> `CT_COST_PROFILE=paid` (`* * * * *`).  This note is the 2026-07 free-tier
> survival work.  Do not set these knobs on Deploy.

## Summary

Production burned a full Deno Deploy free-tier month of quota in ~4 days after
moving the backend to Deno Deploy. Root cause: `Deno.cron` ran **every minute**
and each tick could claim/process heavy extraction work (PDF fetch + vision LLM
+ normalizer) while also flushing outboxes — even when mostly idle.

This rollout adds a **cost profile** (default **`free`**) that:

- Runs the internal cron every **5 minutes** (`*/5 * * * *`) instead of every minute (~5× fewer ticks).
- Caps durable-queue drain to **3 messages / claim size 1** per tick (serial, tiny).
- **Idle short-circuits** outbox flush + queue drain when a cheap probe finds no pending work (watcher + daily jobs still run).
- Exposes **`POST /api/admin/runtime-tick`** so Coolify/GitHub Actions can own the scheduler while Deno Deploy serves HTTP only (`DENO_DISABLE_INTERNAL_CRON=true`).

## Free-tier reference (Deno Deploy Free, 2026)

| Resource | Free limit | How we burn it |
| --- | --- | --- |
| Requests | 1M / mo | Cron ticks + public API + dashboard polls |
| Egress | 20 GB / mo | Large JSON feeds, HTML dashboard, PDF proxies |
| KV reads / writes | 450k / 300k | Rate limits, session, config (most config now Turso-backed) |
| CPU / memory-time* | 15h / 350 GB-h | Long extraction ticks (*may not apply to Deploy Classic) |

## Operator knobs (Deno Deploy env / Infisical)

| Variable | Purpose | Free default |
| --- | --- | --- |
| `CT_COST_PROFILE` | `free` \| `balanced` \| `paid` | `free` |
| `CT_CRON_SCHEDULE` | Override crontab | `*/5 * * * *` |
| `CT_DRAIN_LIMIT` | Max messages per queue per tick | `3` |
| `CT_DRAIN_CLAIM_SIZE` | Claim batch size | `1` |
| `CT_OUTBOX_LIMIT` | Outbox rows per flush | `20` |
| `CT_DISABLE_INTERNAL_CRON` | Skip `Deno.cron`; use external tick | unset |
| `CT_FORCE_FULL_TICK` | Disable idle short-circuit | unset |

**Naming:** Deno Deploy rejects custom env keys starting with `DENO_`. Use
`CT_*` only. Legacy `DENO_*` aliases still work in local tests.

While still on **Pro this month**, you may set `CT_COST_PROFILE=paid` (or
`balanced`) for lower latency. Free is the code default and should be set live
as `CT_COST_PROFILE=free`.

Verify live: `GET /api/health` includes `costProfile.name` (`"free"`).

### Deploy frequency cap

`.github/workflows/deploy-deno.yml` no longer runs hourly (was 24 deploys/day).
It deploys on main path changes, optional daily safety net, and enforces a
default **8 successful deploys/UTC day** (`vars.DEPLOY_MAX_PER_DAY`). Manual
`workflow_dispatch` with `force=true` bypasses the cap.

### Optional: move background work off Deno entirely

1. Set `CT_DISABLE_INTERNAL_CRON=true` on the Deno app.
2. On Coolify (or Actions), every 5 minutes:

```bash
curl -sS -X POST "https://<host>/api/admin/runtime-tick" \
  -H "Authorization: Bearer $ADMIN_MAINTENANCE_TOKEN" \
  -H "content-type: application/json"
```

Deno then only pays for inbound HTTP.

### Poll cadence (separate from cron)

Watcher still self-gates via `poll_config` (default 5 min business hours, 20 min
evenings, 60 min weekends). For free tier, prefer **not** enabling aggressive
mode, and consider lengthening intervals via admin `PUT /api/admin/poll-config`.

### Other usage reducers (ops, not only code)

- Point the public site at the Coolify PWA; avoid heavy HTML dashboard traffic on Deno.
- Cap client poll intervals (feed `?since=` already zero-delta cheap).
- Do **not** run large admin backfills / reprocess storms on Deno; use Coolify
  `admin-maintenance.yml` in small batches.
- Pause backlog autopilot when not needed (LLM spend + long ticks).

## Files changed

- `app/src/deno/costProfile.ts` — profile resolution
- `app/src/deno/scheduledTick.ts` — shared tick + idle probe
- `app/src/deno/runtimeHandlers.ts` — queue handler wiring without app cycle
- `app/src/deno/main.ts` — profile-aware cron registration
- `app/src/admin/routes.ts` — `POST /runtime-tick` + maintenance allowlist
- tests under `app/src/deno/__tests__/` and maintenance auth test update

## Verification

```bash
cd app
npm run typecheck
npx vitest run src/deno/__tests__/costProfile.test.ts src/deno/__tests__/scheduledTick.test.ts src/admin/__tests__/ingestRetryErrored.test.ts
```

After deploy: Deno logs should show
`Deno cost profile=free cron="*/5 * * * *"` and idle ticks log
`skipped outbox/queue drain`.

## Follow-ups

- Wire a Coolify cron for `/runtime-tick` if further HTTP-only Deploy is needed.
- Consider serving `/` dashboard only from Coolify/CDN long-term.
- Track Deno console usage weekly through July so Aug 1 starts clean.
