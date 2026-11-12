# 2026-08-11 — Review autonomy P0 (A1 / A3 / A4)

## Summary

House text PDFs and Senate HTML historically parked in review whenever OpenRouter
agreement was halted, even with clean structured rows (~0.55–0.65 confidence).
False `invalid_amount` flags on freeform PTR lines (dates/CUSIPs) and
`server_cpu_v1` letterhead floods also filled the queue with noise.

## Changes

| ID | Fix |
|----|-----|
| A1 | Deterministic extractors (`textPdf`, `senateHtml`, `ogeText`) publish at `DETERMINISTIC_CONFIDENCE_THRESHOLD=0.55` when hard flags are clean |
| A3 | Canonical structured brackets no longer get `invalid_amount` from freeform rawText unless a *different* exact dollar range is embedded; `parseAmountRange` prefers embedded `$…-$…` tokens |
| A4 | Majority OCR garbage (`isMostlyGarbageOcrExtraction`) parks as `ocr_unusable,extract_empty_failure` with empty payload — not hundreds of fake review rows |

## Files

- `app/src/extraction/normalizer.ts` (+ tests)
- `app/src/extraction/amounts.ts` (+ tests)

## Verification

```bash
cd app && npm run typecheck
npx vitest run src/extraction/__tests__/amounts.test.ts src/extraction/__tests__/normalizer.test.ts
```

## Follow-ups

- A2: split autopilot halt circuits (OR-only vs deterministic)
- A5: local-vision SLA reprocess for rejected scanned PDFs that still have raw
