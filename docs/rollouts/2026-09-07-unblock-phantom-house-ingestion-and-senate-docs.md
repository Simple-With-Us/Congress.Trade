# Unblock House Ingestion Phantoms, Senate Paper Viewing, and Form Example Rows

## Summary

This rollout permanently resolves three interrelated pipeline ingestion, viewing, and normalization issues:

1. **Missed/Unpublished House Official Filings (Cisneros & Taylor):**
   On 2026-07-30, a sequential frontier probe probed prospective doc IDs `20035076` through `20035975` (876 doc IDs) before they were issued by the Clerk.  All 876 IDs were recorded in `filings` with `ingest_status = 'not_found'` and `ingestion_outbox` completed.  When the Clerk officially issued them in August/September 2026 (including Rep. Gilbert Ray Cisneros, Jr. `H-2026-20035190`, Rep. David Taylor `H-2026-20035146` and `H-2026-20035392`), `insertFilingIfNew` dropped them as duplicates with no upgrade path.
   - Added `not_found` upgrade path in `insertFilingIfNew` (`app/src/ingestion/watcher.ts`) that resets status to `new`, clears error, re-arms `ingestion_outbox` to `pending`, and immediately enqueues the fetch.
   - Updated `runHouseReconciler` (`app/src/ingestion/houseReconciler.ts`) to auto-recover any official bulk filing stuck in `not_found`.
   - Added migration 0097 (`app/migrations/0097_unblock_not_found_house_phantoms.sql` and `app/src/admin/migrations.ts`) to delete the unissued 2026-07-30 phantom rows from `filings` and `ingestion_outbox` so current and future filings in that range ingest cleanly.

2. **Broken Senate Filing Document Links:**
   Senate paper filings (`/search/view/paper/<uuid>/`) store eFD's client-side HTML viewer shell in R2.  When served via `/api/documents/:docId/pdf` or `/api/admin/filings/:docId/raw` under `Content-Security-Policy: sandbox`, scripts and relative static assets are blocked, rendering a broken, empty shell.
   - Added `renderSenatePaperViewer` and `enhanceSenateHtmlDocument` (`app/src/extraction/senatePaperMedia.ts`).
   - For Senate paper filings, transforms the shell into a clean, standalone, scriptless multi-page reader displaying official page scans from `efd-media-public.senate.gov` with responsive styling, page badges, and download links that render properly under CSP sandbox.
   - For electronic Senate HTML tables, injects fallback table CSS so tables render legibly.
   - Wired document serving in `app/src/delivery/rest.ts` and `app/src/admin/routes.ts`.

3. **Blumenthal & Senate False `future_tx_date` Labels:**
   Senate Form 278-T contains printed instruction rows: `IBM Corp. (stock) NYSE 2/1/1X` and `(DC) Microsoft (stock) NASDAQ/OTC 2/27/1X` with amounts spelling `EXAMPLE`.  In Sen. Richard Blumenthal's filing (`S-16afdd38-c0ec-4e37-bc05-cbd82901b43f`), OCR read the template row as Microsoft with date `2027-01-17` (due to `1X` interpreted as 2027).  Because the prior detector only matched exact strings, it slipped past, scored `future_tx_date`, and parked the filing in human review.
   - Expanded `looksLikePtrFormSampleAsset` and added `looksLikePtrFormSampleRow` in `app/src/extraction/extractRouting.ts`.
   - In `senatePaperMedia.ts`, `normalizeTxDate` now caps years at `new Date().getFullYear()`, and `mapPaperRow` rejects rows matching `looksLikePtrFormSampleRow`.
   - In `normalizer.ts`, filtered out sample rows up front before scoring or persistence, preventing false `future_tx_date` review queue traps.

## Files changed

- `app/migrations/0097_unblock_not_found_house_phantoms.sql` — Idempotent migration to remove 2026-07-30 frontier-probe phantoms.
- `app/src/admin/migrations.ts` — Registered `UNBLOCK_NOT_FOUND_HOUSE_PHANTOMS_STATEMENTS` in `POST_0024_SCHEMA_STATEMENTS`.
- `app/src/admin/routes.ts` — Enhanced HTML serving in `/filings/:docId/raw`.
- `app/src/admin/__tests__/migrations.test.ts` — Parity tests for migration 0097.
- `app/src/delivery/rest.ts` — Enhanced HTML serving in `serveDocumentPdf` (`/api/documents/:docId/pdf`).
- `app/src/delivery/__tests__/documentPdf.test.ts` — Tests for Senate HTML serving under CSP sandbox.
- `app/src/extraction/extractRouting.ts` — `looksLikePtrFormSampleRow` and broader sample row detector.
- `app/src/extraction/senatePaperMedia.ts` — `renderSenatePaperViewer`, `enhanceSenateHtmlDocument`, `normalizeTxDate` year guard, and sample row dropping.
- `app/src/extraction/normalizer.ts` — Sample row filtering before normalization.
- `app/src/extraction/__tests__/extractRouting.test.ts` — Tests for sample row detection.
- `app/src/extraction/__tests__/senatePaperMedia.test.ts` — Tests for paper viewer and HTML enhancement.
- `app/src/extraction/__tests__/normalizer.test.ts` — Tests for dropping sample rows without triggering `future_tx_date`.
- `app/src/ingestion/watcher.ts` — `not_found` upgrade path in `insertFilingIfNew`.
- `app/src/ingestion/houseReconciler.ts` — Auto-recovery of `not_found` filings in reconciler.
- `app/src/ingestion/__tests__/providerSeedUpgrade.test.ts` — Tests for `not_found` upgrade path.

## Verification

- `cd app && npm run typecheck`: Passed clean (Deno check `src/deno/main.ts`).
- `cd app && npm test`: All 305 test files, 3,869 tests passed clean.

## Follow-ups

- Deploy to production via `bash app/scripts/ship.sh`.
- Run production migration to execute 0097.
- Trigger House reconciliation or discovery to immediately ingest Cisneros (`H-2026-20035190`) and Taylor (`H-2026-20035392`).
