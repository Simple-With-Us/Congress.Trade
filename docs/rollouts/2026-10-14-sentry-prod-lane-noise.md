# Sentry production lane noise + watcher I/O budgets

## Summary

Reduce false-positive Sentry issues from cron lane timeouts, pipeline recovery
messages, and bot JSON-parse noise; cap watcher per-source network I/O so one
slow upstream cannot consume the entire 22s watcher lane (CONGRESS-TRADE-1V).

## Files changed

- `app/src/ingestion/watcherSourceIo.ts` — per-source 7s I/O budget
- `app/src/ingestion/watcher.ts` — thread budget into House/Senate/OGE polls
- `app/src/deno/main.ts` — stop double-reporting hard cron deadline to Sentry
- `app/src/ingestion/pipelineLoudAlerts.ts` — recovery logs only (no Sentry info)
- `app/src/shared/sentryNoise.ts` — shared noise filters
- `app/src/shared/sentryRuntime.ts`, `app/src/shared/sentryBrowser.ts`

## Verification

```bash
cd app && npm run typecheck && npm test
```

## Follow-ups

- CONGRESS-TRADE-1S / 1T: landed separately in PR #2731 (usage telemetry budget +
  durable-queue alert deferral).
- CONGRESS-TRADE-1P / 1R: operational ST peer enrichment/price stalls — monitor
  after lock-contention fixes; may need Socratic.Trade peer push recovery.
