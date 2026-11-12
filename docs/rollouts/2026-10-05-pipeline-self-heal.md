# Pipeline self-heal and loud fail

## Summary

Transient ingestion failures (SQLITE_BUSY, cron deadline abort, rate limits) now replay themselves on the hourly autonomy sweep, with the same cycle cap the outbox reconnect path already uses.  Parked rows, poison payloads, and rows past that cap stay failed.  Rebased onto #2631: any non-parked failure keeps `ingestion_dead_letter` degraded until it is requeued or explicitly parked, including aged transient rows the sweep has not cleared yet.  Parked-only stays ok.  Poison and cycle-capped rows add the operator replay to that detail, and the existing Pushover liveness sweep pages the degraded check.  A cron tick that misses its deadline, or skips because the singleton lock is SQLITE_BUSY, writes a KV episode that `/api/health` reports as `cron_deadline` until a later tick finishes.  Autopilot does not latch on those infrastructure errors.  File-SQLite concurrency and WAL settings are unchanged.

## Files changed

- `app/src/ingestion/transientDlq.ts` — auto-retry with backoff and cycle cap; hourly sweep
- `app/src/ingestion/autonomySweeps.ts` — runs that sweep before liveness alarms; alarm ids
- `app/src/shared/pipelineHealth.ts` — active vs parked dead letters (#2631) plus `cron_deadline`
- `app/src/shared/cronDeadlineSignal.ts` — KV episode for a tick that did not finish
- `app/src/deno/main.ts` — records and clears that episode
- `app/src/extraction/providerHealth.ts` and `autopilot.ts` — infrastructure errors do not latch

## Verification

- `ingestion_dead_letter` degrades on any non-parked failure, including a saturated retryable DLQ, and stays ok when every remaining row is `parked:`.  Poison and cycle-capped detail names `POST /api/admin/ingest-requeue-failed`.
- `cron_deadline` is ok with no episode, degraded on one recent miss, critical at 3 misses inside 6 hours.  The detail is the real reason.
- `cd app && npm run typecheck && npm test`

## Follow-ups

- The two live triaged rows are classified only after this ships.  Transient ones clear on the next autonomy sweep and stop degrading once they leave `failed`.  Parked ones stay ok.  Capped or poison ones stay on `ingestion_dead_letter` until an operator replays them.
- No production migrate, backfill, or Coolify action in this change.
