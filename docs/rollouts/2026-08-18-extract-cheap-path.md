# 2026-08-18 — Cheap-first House extract routing

## Summary

OpenRouter Files is a poor default under the existing **$2/day key limit**. Files
attaches a $0.50 prepaid hold to that limit. Typed / electronic House PTRs now
take a local text path first (unpdf + House PTR parser, then optional Flash-Lite
text chat). Files / expensive vision run only for documents classified as real
scans. Letterhead, column-header, row-limit, and missing-date + malformed-amount
reads hard-stop before the agreement trio.

This change does **not** raise the OpenRouter key limit, does **not** bulk
Confirm/Reject review rows, and does **not** mutate filing truth.

## Routing

1. House `20xxxxxx` DocIDs, `text_pdf`, and `doc_class=typed` → electronic.
   No OpenRouter Files.
2. Cheap path: `TextPdfExtractor` (local). If zero structured rows but the
   extracted text looks like a trade table, one `openRouterText` call
   (chat text only — no `type: file`, no file-parser plugin).
3. `822xxxx` / `911xxxx` paper IDs and `clean_scan` / `hard_scan` → Files/vision
   only after the cheap read is empty (not after a letterhead failure).
4. `local_mac_1` stays optional. Hosted cheap path runs when Mac vision is down
   or exhausted.

Estimated typed-PTR envelope: local unpdf = $0; Flash-Lite text typically
well under $0.02 — far below the $0.50 Files hold.

## Files changed

- `app/src/extraction/extractRouting.ts` — DocID routing + quality gates
- `app/src/extraction/openRouterText.ts` — text-only OpenRouter extract
- `app/src/extractors/types.ts` — `HousePdfExtractor` never Files on electronic
- `app/src/extraction/orchestrator.ts` / `agreement.ts` — skip trio on hard-stop
- `app/src/extraction/docClassifier.ts` — font-or-text-show; electronic DocID = typed
- `app/src/extraction/normalizer.ts` — shared letterhead helper; `reviewReason`
- tests for routing, letterhead hard-stop, and no Files on electronic PTRs

## Verification

```bash
cd app && npm run typecheck && npm test
```

## Follow-ups

- Manual review of existing parked House rows (do not bulk resolve here)
- #1959 executive scanned_pdf OCR remains a disjoint slice
