# Pipeline loud alerts (terminal failures + stall detector)

## Summary

Terminal non-retryable ingest/extract failures now wake Publisher/BF-Publisher via the same signed `review_queue` webhook and emit Sentry errors, instead of only appearing on `/api/health`.  An hourly stall detector pages when the OCR/scan-reader has scanned-PDF backlog but no `server_cpu`/`local_mac` submission in N hours (default 6, `CT_PIPELINE_STALL_HOURS`), and when Senate polling has had no successful fetch in the same window.

## Files changed

- `app/src/ingestion/pipelineLoudAlerts.ts` — terminal + stall alerting, KV dedupe
- `app/src/ingestion/outbox.ts` — alert when ingestion outbox dead-letter budget exhausts
- `app/src/deno/durableQueue.ts` — alert when ingest durable rows go `failed`
- `app/src/ingestion/autonomySweeps.ts` — hourly `sweepPipelineStallAlerts`
- `app/src/ingestion/__tests__/pipelineLoudAlerts.test.ts`

## Verification

- `cd app && npm run typecheck && npm test`
- Simulate: terminal outbox failure triggers one webhook + Sentry per `doc_id`; stall sweep dedupes within the stall window

## Follow-ups

- None.  No production migrate or ship in this change.
