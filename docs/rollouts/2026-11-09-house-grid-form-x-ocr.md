# House grid-form x-mark OCR

## Summary

Hand-delivered scanned House PTRs mark transaction type and amount with an x in printed columns.  The server CPU ink-ratio reader treated empty checkbox borders as marks and, when no type box was filled, stored a guessed purchase.  A local stage now fits the column rules on each page, template-matches the x, and OCRs only the asset, owner, and date text.  A row with no single type mark is flagged `grid_type_unmarked` and is not given a buy, sale, or exchange.  Low-confidence and unmarked rows stay on the review queue.  The stage does not call OpenRouter.

The in-app extractor is `houseGridForm`, wired in front of paid vision for scanned House PDFs.  The Coolify CPU worker uses the same rules and submits `server_cpu_gridform` when a page matches.  Older ink-ratio reads still require a hand check.

## Files changed

- `app/src/extraction/houseGridForm.ts` — column fit, x-match, row assembly, confidence
- `app/src/extraction/houseGridFormRuntime.ts` — `pdftoppm` grayscale render and tesseract TSV
- `app/src/extractors/types.ts` — House PDF extractor tries the stage before vision
- `app/src/extraction/normalizer.ts` — unmarked type is a hard failure and is omitted from inserts
- `app/src/extraction/handCheckPublish.ts` — grid-form extractor uses the normalizer gates
- `app/src/extraction/extractRouting.ts` — this lane does not enqueue agreement
- `services/scan-cpu-worker/gridform.py` and `pipeline.py` — same stage on the CPU worker

## Verification

`app` vitest covers a synthetic page drawn from the column template at scale 0.72, with empty checkbox borders and stamped x marks.  On that page, 3 of 3 typed rows matched type and amount, and 3 of 3 rows with no single type mark were refused.  That is 6 of 6 rows.  `services/scan-cpu-worker` pytest covers the same fit, the same refusal rules, and a rendered page (1 typed row, 2 refused).

Scored on H-2026-9116399 (Ro Khanna, 23 pages) against the 275 hand-verified typed rows.  The PDF stays out of the repo.  The stage emitted 262 rows and aligned 185 of them to the hand set (90 hand rows unmatched, 77 extra predictions).  On the aligned rows, type was 185/185, amount bucket 184/185, date 156/185, owner 112/185, and asset-name token overlap at 0.75 was 85/185.  Against all 275 hand rows that is type recall 0.673 and precision 0.706, amount recall 0.669 and precision 0.702, date recall 0.567 and precision 0.595, owner recall 0.407 and precision 0.427, asset recall 0.309 and precision 0.324.  Rows with all five fields right: 37 (recall 0.135, precision 0.141).  135 predicted rows scored at or above 0.95 and 127 scored below, so the filing-level gate holds the document.  15 rows were flagged with no type mark.  The hand set left out 15 untyped rows, which are not in the edit file, so those 15 flags were not matched one to one.

## Follow-ups

- Text OCR on the app image is tesseract, which is the CPU backend already installed there.  The worker can keep using its configured OCR backend.  RapidOCR is not added to the image.
- Amount column K is recorded and not mapped onto a STOCK Act bracket.
- The 2026-11-11 accuracy pass fills faint row rules, skips the cover, reads owner ink, and stops copying a notification date into a missed trade date.  See `docs/rollouts/2026-11-11-house-grid-form-accuracy.md`.
