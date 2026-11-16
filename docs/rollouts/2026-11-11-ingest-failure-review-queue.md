# 2026-11-11 — Ingest failures visible on review_queue (CT-2470)

## Summary

Genuine ingest failures (`ingest_status='error'`, no live transactions, not CT-2453 published-stale) now idempotently open an `ingest_failure:*` row on `review_queue` so Publisher’s manual drain can see them.  Stale rows are deleted when a transient retry moves the filing off `error`.  A bounded hourly sweep plus `POST /api/admin/review-queue/backfill-ingest-failures` backfill historic gaps.

## Files changed

- `app/src/ingestion/ingestFailureReviewQueue.ts` — ensure/clear/backfill/sweep helpers
- `app/src/ingestion/fetcher.ts`, `classifier.ts`, `queueHandlers.ts`, `autonomySweeps.ts`, `app/src/extraction/orchestrator.ts` — wire record/clear
- `app/src/admin/routes.ts` — backfill admin endpoint
- Tests: `ingestFailureReviewQueue.test.ts`, `autonomySweeps.test.ts`

## Verification

```bash
cd app && npm run typecheck
cd app && npm test -- src/ingestion/__tests__/ingestFailureReviewQueue.test.ts
```

Backfill (operator only; default dry-run):

```bash
curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"dryRun":true,"limit":50}' \
  https://congress.trade/api/admin/review-queue/backfill-ingest-failures
# apply when satisfied: {"apply":true,"dryRun":false,"limit":500}
```

## Follow-ups

- Deployer owns merge and ship; do not run apply backfill in prod from agents unless asked.
- CT-2453 reconcile remains separate; published-stale filings are excluded from this queue path.
