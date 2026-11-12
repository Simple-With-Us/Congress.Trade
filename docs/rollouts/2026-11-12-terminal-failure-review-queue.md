# 2026-11-12 — Terminal filing failures stay on review_queue (CT-2507)

## Summary

House and Senate filings that die in a terminal failure state now get one unresolved `review_queue` row when they do not already have one.  Download, extract, OCR, normalize, and publish misses use a `pipeline_failure:*` reason.  Outbox dead letters and durable-queue filing failures are included.  A filing that already has a review row, including a human resolution, is left alone.  The enqueue never sets `resolved = 1`.  Autopilot will not auto-close `ingest_failure:*`, `pipeline_failure:*`, extract-empty, OCR-unusable, or empty-fetch rows.  Transient outbox and queue failures still retry with the existing bounded backoff before this sweep runs.  A failed row whose error is still transient and whose dead-letter cycles are under the replay cap stays off review_queue until that budget is spent.

## Files changed

- `app/src/ingestion/terminalFailureReview.ts` — reason codes, idempotent enqueue, sweep
- `app/src/ingestion/autonomySweeps.ts` — hourly sweep after the transient dead-letter replay
- `app/src/extraction/orchestrator.ts` — doc LLM budget halt and an unsettled normalize/publish
- `app/src/queueHandlers.ts` — missing ingestion outbox on a filing dead letter
- `app/src/extraction/reviewQueueHealth.ts` and `app/src/extraction/autopilot.ts` — `ingest_failure:*`, `pipeline_failure:*`, and empty-fetch rows stay in the terminal bucket.  Autopilot does not auto-resolve those, or extract-empty and OCR-unusable rows, as empty filings.  Capped recovery still reclassifies extract-empty rows.
- Tests: `terminalFailureReview.test.ts`, `reviewQueueHealth.test.ts`

## Verification

```bash
cd app && npm run typecheck
cd app && npm test
```

Confirm a terminal failure with no review row:

```sql
SELECT f.doc_id, f.ingest_status, rq.reason, rq.resolved
  FROM filings f
  LEFT JOIN review_queue rq ON rq.doc_id = f.doc_id
 WHERE f.ingest_status = 'error'
   AND rq.doc_id IS NULL;
```

After the hourly autonomy sweep that count should be filings the sweep skipped on purpose (live trades, `persisted`, `verified_empty`, or `provider-missing-*`).  A second sweep changes nothing.

## Follow-ups

- Do not merge or deploy from this change.  The sweep is idempotent and does not need a one-time production backfill command.
- CT-2470 still owns `ingest_status = 'error'` rows that have no review row at all.  This sweep covers the terminal states that stamp never reached.
