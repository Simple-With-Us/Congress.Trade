# Congress-share import SQLITE_BUSY hardening

## Summary

Socratic.Trade `congress-share` pushes to `POST /api/admin/securities/import` were returning HTTP 500 when the production SQLite file was busy during the Deno minute tick (maintenance lanes `usage_telemetry` and `durable_queue` were also overrunning their budgets — Sentry `CONGRESS-TRADE-1S` / `CONGRESS-TRADE-1T`).  Import batches did not retry `SQLITE_BUSY`, and unhandled lock errors bubbled to a 500.  This change retries lock contention on `run` / `batchPrepared`, returns 503 with a retry hint when locks persist, defers durable-queue terminal alerts off the hot drain path, and caps usage-telemetry R2 drain wall time inside the lane budget.

## Files changed

- `app/src/shared/db.ts` — `run` and `batchPrepared` use `withSqliteLockRetry`
- `app/src/admin/routes.ts` — import handler fail-soft 503 on persistent busy
- `app/src/deno/durableQueue.ts` — async terminal ingest alerts (1T)
- `app/src/shared/thirdPartyTelemetry.ts` — time-budget early exit on R2 drain (1S)
- Tests under `app/src/shared/db.test.ts`, `app/src/admin/__tests__/securitiesImportSqliteBusy.test.ts`

## Verification

```bash
cd app && npm run typecheck && npm test
```

After deploy: Socratic `congress-share` import calls should return 200 (or 413 on oversize), not 500, during cron overlap; Sentry lane-timeout noise for 1S/1T should drop.

## Follow-ups

- If 503s persist at volume, consider lowering per-tick `usageTelemetryLimit` or further shortening `tx_performance` recompute work per import batch.
