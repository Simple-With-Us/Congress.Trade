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
