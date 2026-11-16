# Tick lane timeouts + Infisical cache hygiene

## Summary

Production minute ticks on build `5fa1b9ba` began aborting every cycle (~03:17Z Oct 13) with
`Deno tick aborted before completing all lanes` and `cron_deadline` critical.  The maintenance
pipeline ran a full Infisical refresh on **every** tick (ignoring the 600s in-memory TTL), and
the encrypted secrets blob exceeded Deno KV's 64KiB value limit after recent secret growth
(dual publisher webhooks, GB auth header, etc.).  A single slow lane (typically
`secrets_refresh`) held the tick until the soft abort fired, so no lane completed reliably.

This change TTL-skips `refreshSecrets` on cron ticks, skips oversized KV writes with structured
logging, adds per-lane wall-clock budgets with loud Sentry messages on timeout, and caps
publisher webhook POSTs plus the hourly `checkPipelineHealth` stall sweep.

## Decisions

- **TTL skip `refreshSecrets` on cron ticks** (vs. always fetch) — the resolver already
  documents a 600s in-memory TTL; re-fetching every minute duplicated Infisical load and
  dominated tick latency.  Admin and post-mutation paths still use `{ force: true }`.
- **Skip KV writes when encrypted payload exceeds 64KiB** (vs. shard the cache) — sharding
  adds key-management complexity for a single-process Coolify host where in-memory cache is
  the hot path; skipping KV preserves correctness and stops the prod warning.
- **Per-lane wall-clock budgets with lane-scoped `AbortSignal`** (vs. only raising
  `CT_TICK_DEADLINE_MS`) — a hung lane must not abort the entire pipeline; lane timeouts
  cancel in-flight HTTP (e.g. Infisical) instead of orphaning work until the global soft abort.

## Files changed

- `app/src/secrets/infisical.ts` — TTL skip, signal on fetch, KV size guard
- `app/src/deno/maintenanceLaneTimeout.ts` — shared lane race helper
- `app/src/deno/scheduledTick.ts` — per-lane budgets + alerts
- `app/src/ingestion/reviewQueueNotify.ts` — webhook POST timeout
- `app/src/ingestion/pipelineLoudAlerts.ts` — health stall budget
- `app/src/admin/routes.ts` — force refresh on admin endpoints
- Tests under `app/src/deno/__tests__/` and `app/src/secrets/__tests__/`

## Verification

```bash
cd app && npm run typecheck && npm test
```

After deploy: `/api/health` `cron_deadline` returns to `ok` within a few finished ticks;
Infisical KV warning should stop or show `skipping KV cache write` instead of `Value too large`.

## Follow-ups

- Consider trimming Infisical import surface or splitting KV cache shards if cross-isolate warm
  cache is still needed at current secret cardinality.
