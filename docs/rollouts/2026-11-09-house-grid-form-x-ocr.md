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

The real Khanna filing `H-2026-9116399` is not in the repository, so this change does not report an accuracy number against that PDF.

## Follow-ups

- Text OCR on the app image is tesseract, which is the CPU backend already installed there.  The worker can keep using its configured OCR backend.  RapidOCR is not added to the image.
- Amount column K is recorded and not mapped onto a STOCK Act bracket.
