# 2026-10-26 — Reconcile published filings stuck at ingest_status error (CT-2453)

Seat: BF-PUBLISHER.  Branch `publisher/reconcile-published-errored`.  Linear: CT-2453, which stays open.  This PR does not merge and does not deploy.

## Summary

A filing whose trades are already published can still carry `filings.ingest_status='error'`.  A later fetch-stage failure overwrites the stamp.  Measured on production on 2026-10-26: 40 filings and 3141 live rows.  The hourly desync reconcile could not repair them, because `reviewStatusReconcile.ts` only maps a resolved `review_queue` row, and these filings never had one.

The reconcile now also stamps `persisted` when the filing itself shows the truth: at least one live transaction (`deprecated_at` is null) and a latest `ingestion_decisions` action of `auto_published`, `confirmed`, `manual`, or `agreement_published`.  Filings with no live transactions are not touched.  The sweep is idempotent.  It does not write `transactions` and it does not touch `review_queue`.

A fetch of an already-published filing returns without changing `ingest_status`, without storing a new error, and without enqueueing `filing.fetched`.  If the pre-check misses and the fetch then fails, `markError` still refuses to stamp `error`.  The success update also refuses to walk the row back to `fetched`.

## Files changed

- `app/src/ingestion/reviewStatusReconcile.ts`: published-truth reconcile, shared predicate.
- `app/src/ingestion/fetcher.ts`: leave an already-published filing's `ingest_status` alone.
- `app/src/ingestion/autonomySweeps.ts`: the hourly desync sweep documents the new population.
- `app/src/ingestion/__tests__/reviewStatusReconcile.test.ts`: no-queue publish, negative cases, queue left untouched.
- `app/src/ingestion/__tests__/fetcherRetry.test.ts`: skip re-fetch, and do not stamp `error` on a failed fetch.

## Verification

Stored raw only, via `GET /api/admin/filings/:docId/raw` with a browser User-Agent.  Public `GET /api/filings/:docId` supplied the live row count (`deprecated_at` is null).  No re-extract, no publish, no `transactions` write.

- `S-6bf3b6f7-9e1b-499a-bd5a-990292ce2e72`: 5 HTML transaction rows, 5 published rows, `ingestStatus` error.
- `S-9e2ff733-aeac-4ce8-872c-3d6b7913da88`: 33 HTML transaction rows, 33 published rows, `ingestStatus` error.
- `S-0a93a20c-2a0f-4979-80ca-cc2f61297527`: 1 HTML transaction row, 1 published row, `ingestStatus` error.
- `S-a0431e36-2161-4e97-b99a-74a966d7193a`: 1 HTML transaction row, 1 published row, `ingestStatus` error.

Each stored body was `text/html` and the transaction table header was `# | transaction date | owner | ticker | asset name | asset type | type | amount | comment`.

`cd app && deno check src/deno/main.ts` passed.  Vitest on `reviewStatusReconcile.test.ts`, `fetcherRetry.test.ts`, `resolvedDesyncSweep.test.ts`, and `senateWallGuard.test.ts`: 4 files, 43 tests, all passed.

## Follow-ups

- Deployer owns the merge and `bash app/scripts/ship.sh`.  This seat does not merge and does not deploy.
- CT-2453 stays open until the sweep has run on production and the 40 filings read `persisted`.  Do not call `ingest-retry-errored`.  That would re-drive already-published filings into extraction.
- The other 36 filings are 2024 House scans.  This change does not re-read them.  The same reconcile covers them once it is deployed, because they have live transactions and a publish decision.
