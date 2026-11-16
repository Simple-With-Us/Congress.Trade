# 2026-10-26 — Local OCR retry before an unreadable 278-T parks

## Summary

Image-only OGE 278-T scans park as `ocr_unusable,oge_text_unreadable` and wait for a human.  The Aug 12 Trump 278-T (`E-2026-donald-j-trump-08-12-2026-278t`, 34 RICOH-scanned pages) was recovered by hand with free local tesseract, so the pipeline now runs that same pass automatically before parking.  CT-2448.

When the deterministic OGE read refuses an executive 278-T, the extraction pass renders each page's table body with pdftoppm at 400 DPI (crop x380-3060 / y380-2480 in 300-DPI pixels of the post-rotation render, honoring the page `/Rotate`), OCRs it with tesseract psm 4, and parses number, description, type, date, notification flag and amount with the same row pattern the text-layer parser uses.  A second read at 600 DPI confirms; a row survives only when type, date and amount agree across both reads.  The recovered rows go through the normal `normalize()` decision model, publishing only when row numbers run 1..N with no gaps, every amount maps to a canonical STOCK Act bracket, and every type is B/S/E.  Anything else parks exactly as before, with the unreconciled rows listed in the review payload's `localOcr` section.  The agreement lane retries only filings the extraction lane never attempted.

The crop numbers are a starting hint measured on the Trump scan, not gospel: when the cropped read yields no coherent table the pass re-reads the pages uncropped before giving up.  The rect, page budget, time budget and master switch are Infisical-backed knobs (`CT_OGE_LOCAL_OCR`, `CT_OGE_LOCAL_OCR_CROP`, `CT_OGE_LOCAL_OCR_MAX_PAGES`, `CT_OGE_LOCAL_OCR_MAX_SECONDS`).  No vision model, no paid API, no cap raises.

The app image now ships poppler-utils and tesseract-ocr with English traineddata, and Deno runs with `--allow-run=pdftoppm,tesseract`.  When the binaries are missing the pass fails closed: the filing parks as before with reason `oge_local_ocr_unavailable`.

Separately, a review backlog made only of terminal rows (parked unreadable 278-Ts, rejected rows, attempt-capped cascades) no longer marks the `extraction_provider` health check stalled.  Those rows are work no extraction attempt can help; the `extraction_backlog` check still reports the queue.

## Files changed

- `app/src/extraction/ogeLocalOcr.ts` — the pass: settings, row parse, two-read reconcile, publish gate, review payload
- `app/src/extraction/ogeLocalOcrRuntime.ts` — poppler/tesseract shell-out backend (probe plus render and OCR)
- `app/src/extraction/orchestrator.ts` — run the pass before `normalize()` parks; hand it a pre-extractor PDF copy
- `app/src/extraction/agreement.ts` — retry in the zero-read lane unless already attempted
- `app/src/extraction/normalizer.ts` — carry the OCR payload into the park; preserve `localOcr` payloads
- `app/src/extraction/executiveDisposition.ts` — optional park payload (only rewritten when supplied)
- `app/src/extraction/ogeText.ts` — `scanOgeRows()` keeps raw fields for cross-read comparison; notification captured
- `app/src/settings/settingsService.ts` — four Infisical-backed knobs
- `app/src/shared/pipelineHealth.ts` — provider stall counts eligible backlog only
- `app/Dockerfile`, `app/scripts/start-with-litestream.sh` — ship and permit the binaries
- `app/deno.json` — exclude `no-irregular-whitespace` (zero violations on main), which forbids the NBSP sentence style this change uses in comments

## Verification

```
cd app && npx vitest run src/extraction/__tests__/ogeLocalOcr.test.ts src/shared/__tests__/pipelineHealth.test.ts
cd app && npm run typecheck
cd app && deno lint src/extraction/ogeLocalOcr.ts src/extraction/ogeLocalOcrRuntime.ts
```

Matrix: a clean scan publishes, a row-number gap parks, a two-read disagreement parks, a text-layer PDF skips the pass, and a terminal-only backlog leaves `extraction_provider` ok.  CI-facing tests use canned OCR text behind a fake backend; one test uses the real binaries when present and skips otherwise.

Also verified by hand with the installed poppler and tesseract: a synthetic 5-row page OCRs identically at 400 and 600 DPI and passes reconcile plus the gate, an A4 portrait page with `/Rotate 90` renders landscape 3509x2480 at 300 DPI with the default crop inside it, and an oversized crop clamps harmlessly instead of erroring.

## Follow-ups

This does not re-verify the exact crop rect against the real Trump scan (no fixture in the repo).  Watch the first real parks' `localOcr.cropped` flag and tune `CT_OGE_LOCAL_OCR_CROP` without a deploy if the full-page fallback dominates.  Trump-scale filings still take the normalizer's row-limit review path when they exceed it; the OCR gate passing does not bypass that.  Local `deno task start` lacks `--allow-run`, so local dev fails closed with `oge_local_ocr_unavailable`; add the flag locally to exercise the pass outside the image.
