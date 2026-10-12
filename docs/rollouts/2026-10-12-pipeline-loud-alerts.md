# Pipeline loud alerts (terminal failures + stall detector)

## Summary

Terminal non-retryable ingest/extract failures wake GB Publisher and BF-Publisher via signed publisher webhook(s) and emit Sentry errors, instead of only appearing on `/api/health`.  An hourly stall detector pages when ingest chambers (House, Senate, Executive/OGE), the OCR/scan-reader, or Socratic.Trade enrichment/price/share paths go stale.  Stall events use `pipeline.stalled` / `pipeline.stall_recovered` with a null `docId` (optional wake `docId` for OCR backlog).  Threshold default is 6h per pipeline (`CT_PIPELINE_STALL_HOURS` and `CT_PIPELINE_STALL_HOURS_<CONDITION>`).  BF receives `REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL`; GB receives optional `REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL_GB` (same HMAC secret).

## Files changed

- `app/src/ingestion/pipelineLoudAlerts.ts` — terminal + stall alerting, KV dedupe + recovery
- `app/src/ingestion/reviewQueueNotify.ts` — dual-target fan-out + pipeline stall events
- `app/src/ingestion/outbox.ts` — alert when ingestion outbox dead-letter budget exhausts
- `app/src/deno/durableQueue.ts` — alert when ingest durable rows go `failed`
- `app/src/ingestion/autonomySweeps.ts` — hourly `sweepPipelineStallAlerts`
- `app/src/ingestion/__tests__/pipelineLoudAlerts.test.ts`
- `app/src/ingestion/__tests__/reviewQueueNotify.test.ts`

## Verification

- `cd app && npm run typecheck` -> ok
- `cd app && npm test` -> ok
- Simulate: terminal outbox failure triggers webhook(s) + Sentry per `doc_id` (7d dedupe); stall sweep dedupes within the stall window and sends `pipeline.stall_recovered` when the condition clears

## Follow-ups

- Ensure Infisical prod sets `REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL_GB` to the GB Publisher automation URL when Jay wants both bots live on every stall (BF URL already points at `agents.jays.services`).
