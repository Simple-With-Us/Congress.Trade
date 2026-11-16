# 2026-10-25 — Empty fetch hand-off (CT-2447)

Seat: GROK.  Branch `grok/empty-fetch-handoff`.  Linear: CT-2447, which stays open.  This PR does not recover or publish the filing.

## Summary

`E-2026-donald-j-trump-08-12-2026-278t` has been inert since 2026-08-22.  Its outbox row is `completed` with no error, and the filing has `ingest_status='pending'` (not a member of `IngestStatus`), an empty `raw_object_key`, no transactions, and no review row.  Nothing in the review queue, the desync reconcile, or the loud-alert status lists could see it.

The autonomy sweep now re-drives that class.  A completed outbox whose filing stored no raw object is put back on `new` with the outbox pending, using the existing dead-letter cycle cap.  At the cap the filing is parked on `review_queue` with reason `empty_fetch_handoff`.  A filing whose status is outside `IngestStatus`, with no raw object and no live transactions, takes the same re-drive once it is older than the fetcher's 7-day not-yet-published window.  `doc_kind` is reset to `unknown` so a stale `text_pdf` label is not trusted.  `classifyFiling` still decides the kind from the fetched bytes.

The same predicate pages as stall condition `empty_fetch_handoff` and is check id `empty_fetch_handoff` on `/api/health` (critical when the count is above zero).  The id is in `HEALTH_STALL_SKIP_IDS`, so the generic health loop does not open a second episode.

Part 7 of this filing is not empty.  The text layer is empty on pages 2-34.  The publisher's rendered-page reading shows real rows.  `verified_empty` is not justified.  Evidence: `docs/evidence/2026-10-25-orphan-278t.json`.

## Files changed

- `app/src/ingestion/emptyFetchHandoff.ts`: the shared predicate and the alert WHERE clause.
- `app/src/ingestion/autonomySweeps.ts`: `sweepCompletedEmptyRawHandoff` and `sweepUngroundedIngestStatus`.
- `app/src/ingestion/outbox.ts`: re-arm and park.
- `app/src/ingestion/pipelineLoudAlerts.ts`: stall condition, skip list.
- `app/src/shared/pipelineHealth.ts`: `/api/health` check.
- `app/src/ingestion/__tests__/emptyFetchHandoff.test.ts`: matrix against the same rule.
- `docs/evidence/2026-10-25-orphan-278t.json`: PDF fetch and text-layer record.

## Verification

- Public PDF fetch on 2026-10-25: HTTP 200, 26880519 bytes, sha256 `dfa4d453c1008370a001043bad41f1149fbe18b0800588157c10c4631e5476c6`, 0 redirects.  pdfinfo: 34 pages, creator RICOH IM C4510. `pdftotext -layout`: 297 bytes, page 1 is a signature stamp (262 non-whitespace characters), pages 2-34 are empty.  No transaction rows in the text layer.
- `cd app && npm run typecheck` passed (`deno check src/deno/main.ts`).
- `cd app && npm test` passed: 374 files, 5038 tests.
- `deno lint` on `app/src/ingestion/emptyFetchHandoff.ts` is clean.  `npm run lint` still fails on pre-existing `dashboard.js` findings (3157 problems).  Those files were not part of this change.
- Mutation: with `isUngroundedIngestStatus` reduced to the old watched set, the matrix test failed on `classified` (`expected true to be false`).  With invalid statuses ignored, it failed on `"pending"` (`expected false to be true`).  The rule was restored before the full suite.

## Follow-ups

- Deployer owns merge and `bash app/scripts/ship.sh`.  This seat does not merge and does not deploy.
- CT-2447 stays open until this filing is recovered and published.  After the sweep re-drives it, BF-PUBLISHER decides it on the review queue.  Do not hand-publish the rows.
- No other filing was touched.  No production write was made from this lane.
