# 2026-08-17 — scanned_pdf vision/OCR path for executive 278-T (#1575)

## Summary

`scanned_pdf` is the filing class that genuinely needs vision/OCR.  House already
tries deterministic `textPdf` first and falls back to the existing OpenRouter
vision chain.  Executive 278-T filings did not: `OgeTextExtractor` only claimed
`text_pdf`, so a scan (or a typed PDF mis-tagged `scanned_pdf`) skipped unpdf
entirely and jumped to paid vision.

This change adds `OgePdfExtractor`, a House-style wrapper:

1. Always run the deterministic unpdf / `parseOgeTransactionRows` path first.
2. If that yields rows, return them.  No paid call.
3. If a typed `text_pdf` yields zero rows, return that empty result.  Do not
   charge vision for empty/termination reports.
4. If a `scanned_pdf` yields zero rows, call the existing OpenRouter vision
   extractor (same `OPENROUTER_API_KEY` / configured-vision chain).
5. Vision failures are fail-soft (missing key, parse/provider 4xx) and keep the
   empty unpdf result.  `IngestRetryError` (budget/rate-limit) still propagates
   so the queue can back off.

Local Mac / server_cpu `extraction_pending_local` coverage is unchanged.  No new
paid providers.

## Files changed

- `app/src/extractors/types.ts` — `OgePdfExtractor` + pipeline wiring
- `app/src/extraction/orchestrator.ts` — do not let a vision ban block the
  unpdf-first OGE wrapper
- `app/src/extraction/ogeText.ts` — comment only (`canHandle` still `text_pdf`)
- `app/src/extractors/__tests__/arbitration.test.ts`
- `app/src/extraction/__tests__/orchestratorCircuitBreaker.test.ts`

## Verification

```bash
cd app
npm run typecheck
npm test
```

Confirm executive `text_pdf` still publishes via `ogeText` with no OpenRouter
call, and a `scanned_pdf` with no text layer reaches the existing vision
extractor only after unpdf returns zero rows.

## Follow-ups

- House scanned PDFs already have text-then-vision; this slice does not change
  that wrapper's throw-on-vision-failure behavior.
- Local-worker exhaustion (`local_vision_exhausted,scanned_pdf_vision_spend`)
  remains the park reason when the Mac/CPU workers give up.  This path is the
  server-side fallback after that wait expires, not a replacement for it.
