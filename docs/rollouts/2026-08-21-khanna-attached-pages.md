# Khanna attached-schedule PTRs: skip truncated Grok CLI, chunk Gemini PDF

2026-08-21.  Grok.  Board `642b4524`.  Branch `grok/khanna-attached-pages`.

## Summary

Nine Ro Khanna House PTRs sat in the review queue as `form_chrome` / `extraction_row_limit` because page 1 is a cover that only says "Please see the attached" and the trades live on 15–34 landscape schedule pages.  The local Grok CLI is capped at `MAX_PAGES=12`, so it either published a truncated 12-page read or burned 900s and then sent the whole PDF to Gemini in one 32k-token shot (H-2025-8221264: 210 rows, `tokens_out=31993`, `no_amount,missing_tx_date`).

This change:

1. **Skip local Grok CLI** when the PDF has more pages than `MAX_PAGES` (auto engine).  Go straight to PDF-native Gemini/Grok.
2. **Chunk native-PDF calls** at `PDF_NATIVE_CHUNK_PAGES=10` via `pdfseparate`/`pdfunite` so a 34-page packet is not truncated at 32k tokens.
3. **Stop requeueing `local_vision_exhausted`** docs.  `sweepRejectedScannedForLocalVision` had been reopening genuine Rogers NOTHING TO REPORT months after the Mac worker already spent three zero-row tries.

Live `~/vision-worker/worker.py` was copied and pm2-restarted before the PR landed so the remaining Khanna packets drain on the new path.

## Files changed

- `services/vision-worker/worker.py` — skip CLI, PDF chunk split, cap-gains passthrough
- `services/vision-worker/test_worker.py` — skip-CLI unit test
- `services/vision-worker/README.md`
- `app/src/extraction/deterministicDrain.ts` — do not requeue exhausted empties
- `app/src/extraction/__tests__/deterministicDrain.test.ts`

## Verification

```bash
python3 services/vision-worker/test_worker.py
# 18 tests OK, including test_auto_skips_local_cli_when_over_max_pages
```

Live worker log after restart:

```
skipping local CLI: 23 pages exceeds MAX_PAGES=12 — PDF-native cascade
split ... into 3 PDF chunks of <=10 pages
PDF-native chunk model=google/gemini-3.7-flash pages=1-10/23
```

Rogers eight NOTHING TO REPORT months re-rejected 2026-08-21 (they had bounced via `local_vision_requeue_once`).  The exhausted-exclusion closes the loop after this deploy.

## Follow-ups

- Sessions `H-2025-20033330`: form prints tx 2025-10-24, digital signature 2025-10-22.  Confirm API refuses later-than-filed.  Parked; do not invent the date.
- Chunked Gemini still has to auto-publish.  If `no_amount` remains, confirm the complete payload rather than the truncated 210.
- `pdfseparate`/`pdfunite` are poppler tools already on the Mac worker.  If they are missing the worker sends the whole PDF once (previous behavior).
