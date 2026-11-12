# Review-queue self-close for NTR scans, EO.Pdf columns, and Deleted rows

## Summary

Publisher drained the three live terminal `review_queue` rows by hand, then landed the smallest pipeline change so the next similar filings publish or close themselves.

Live handling (prod, 2026-08-26, SHA `1e408b0f2358` at action time):

- `H-2026-20035235` (Steve Cohen, electronic text PTR): confirmed two official purchases from the Clerk PDF.
- `H-2026-20035196` (Kevin Hern): rejected as a later official amendment/deletion of already-persisted `H-2026-20035134`. Did not re-publish OGN. VSNT on `H-2026-20035134` remains live until this PR is shipped and the later PTR is reprocessed (Deleted row apply).
- `H-2026-9116311` (Hal Rogers scanned PTR): rejected. Handwritten "Nothing to report for July 2026". Haiku had OCR'd the form sample "Example Mega Corp" (2012-08-14) as a fake trade. Luna returned 0 rows.

## Files changed

- `app/src/extraction/ptrTails.ts` — column-order tail `P/S/E date date $amount` when `[ST]` wraps after the amount.
- `app/src/extraction/textPdf.ts` — EO.Pdf letter-spaced labels, wrapped `$100,001 -` / `$250,000`, leading disclosure line ids.
- `app/src/extraction/extractRouting.ts` — Example Mega Corp / nothing-to-report / Deleted status detectors.
- `app/src/extraction/normalizer.ts` — auto `verified_empty` for NTR/sample-only; skip Deleted inserts; deprecate matching live txs; skip Amended rows already live on another official doc. Does not touch `persistNormalizedPublish`.
- `app/src/extraction/deterministicDrain.ts` — skip attempt-capped `agreement_cascade_unresolved` (live churn: Cohen revision 3600+, Hern 2700+).

## Verification

- `cd app && npm run typecheck` (`deno check src/deno/main.ts`) clean.
- `cd app && npm test` — 297 files / 3769 tests.
- Live: `GET /api/admin/review-queue?resolved=0` count 0 after the three decisions. Cohen filing `GET /api/filings/H-2026-20035235` shows both buys.

## Follow-ups

- Deployer owns merge and prod ship. After deploy, reprocess `H-2026-20035196` so the Deleted VSNT row unpublishes the matching live sale on `H-2026-20035134`.
- Publisher webhook (`REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL` / `_SECRET`) is still unset. Do not invent the URL/key.
