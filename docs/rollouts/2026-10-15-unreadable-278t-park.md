# 2026-10-15 — Unreadable executive 278-T stays in review

## Summary

`oge_text_unreadable` was a terminal rejection.  `closeUnreadableExecutive` opened the review row and resolved it `rejected` in the same tick, actor null, `resolvedBy: executive-disposition`.  No agreement cascade ran, and the filing-skip alarm did not count the `rejected` action.  For this form that reason does not mean Part 7 is empty.  The Sep 8 Trump 278-T carried the same string and later published 1113 rows after a manual read.  The Sep 17 filing (`E-2026-donald-j-trump-09-17-2026-278t`) took the silent path.  CT-2393.

An explicit empty Part 7 still closes `verified_empty`.  A refused or unreadable 278-T now stays unresolved with reason `ocr_unusable,oge_text_unreadable`, `ingest_status = needs_review`, and one `oge_text_unreadable` ingestion decision.  That action is part of `filing_skips`, so the first occurrence is critical.  The `ocr_unusable` token still keeps agreement and the deterministic drain from spending another read.  The review row is what a human acts on.

An hourly sweep reopens rows this path already auto-rejected (pipeline, actor null, `resolvedBy` executive-disposition, no live rows, no human decision).  It is bounded to 25 per pass and idempotent.

## Files changed

- `app/src/extraction/executiveDisposition.ts` — park instead of reject; reopen sweep
- `app/src/extraction/normalizer.ts` — unreadable normalize result stays in review
- `app/src/extraction/agreement.ts` — comments only; settlement kind is unchanged
- `app/src/ingestion/autonomySweeps.ts` — hourly reopen
- `app/src/shared/ingestionDecisions.ts` — `oge_text_unreadable` action
- `app/src/shared/pipelineHealth.ts` — filing-skip count includes that action

## Verification

```
cd app && npx vitest run src/extraction/__tests__/executiveDisposition.test.ts src/extraction/__tests__/normalizer.test.ts src/shared/__tests__/pipelineHealth.test.ts
cd app && npm run typecheck
```

After deploy, a new refused 278-T has `review_queue.resolved = 0`, `resolution_kind` null, and an `oge_text_unreadable` decision.  `filing_skips` goes critical.  The Sep 17 row reopens on the next hourly sweep if it still matches the pipeline auto-reject shape.  Bondi stays `verified_empty`.  A second sweep changes nothing.

## Follow-ups

This does not OCR the Sep 17 PDF and does not authorize a vision model.  A human still has to read the official filing.  Rows a person already rejected stay closed.
