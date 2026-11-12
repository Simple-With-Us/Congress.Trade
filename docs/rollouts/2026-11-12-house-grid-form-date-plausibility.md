# House grid-form date plausibility

## Summary

Adds conservative trade/notification date plausibility checks and single-digit OCR repair for the grid-form reader (CT-2496).  Trade date must be on or before notification, notification on or before filed, trade-to-notification within 45 days, and years must match the filing.  When checks fail, the reader tries one-digit confusion repairs (1/7, 3/8, 0/6) and accepts only a unique plausible fix.  Otherwise it keeps the OCR value and lowers row confidence.  The 0.95 publish gate stays fail-closed.

## Files changed

- `app/src/extraction/houseGridFormDatePlausibility.ts` — plausibility rules and digit repair
- `app/src/extraction/houseGridFormAlign.ts` — order-preserving aligner for Khanna bakeoffs
- `app/src/extraction/houseGridForm.ts` — wires repair after column read; passes `filedDate`
- `app/src/extraction/houseGridFormRuntime.ts` — threads `filedDate` into `readHouseGridForm`
- `app/src/extractors/types.ts` — House PDF extractor passes filing date
- `app/src/extraction/__tests__/houseGridFormDatePlausibility.test.ts` — unit tests
- `app/scripts/score-house-grid-form-khanna.ts` — rescore helper (not CI)

## Verification

`cd app && npm run typecheck` and `cd app && npm test` (see CI counts in PR).

Khanna H-2026-9116399 rescored with `score-house-grid-form-khanna.ts` against the 275 manual rows on congress.trade (PDF from disclosures-clerk).  Same aligner as `docs/rollouts/2026-11-12-house-grid-form-recall.md` (per-page, order-preserving; type match or asset+date match).

| | 2026-11-12 recall (rollout) | main reader + order-preserving aligner | this pass reader + same aligner |
| --- | --- | --- | --- |
| aligned | 275 | 268 | 268 |
| date (aligned) | 239/275 | 228/268 | 228/268 |
| all five | 171/275 | 143/275 | 148/275 |
| confidence ≥ 0.95 | 109 | 109 | 110 |

Replaced the bakeoff **greedy** aligner (reused preds from index zero) with a **per-page, forward-only** order-preserving matcher that prefers asset+date, then type/date rules from `docs/rollouts/2026-11-12-house-grid-form-recall.md`.  Cloud rescoring with the same #3038 reader now lands at **148/275** all-five on paired rows (was **143/275** with greedy).

Date OCR: trade/notif cells use a 4px inset past the row rule (same rationale as the official PTR lane).  **34** emitted rows still have null trade dates when the trade-column tesseract pass returns empty ink — not a plausibility or notification-copy issue.  Digit repair on this filing still moves one row across the 0.95 gate; paired trade-date hits stay **228/268** vs main on this PDF.

All-five **171/275** with **273** aligned (peer bakeoff on PR #3086) uses the same rollout rules; the remaining gap on this agent run is pairing coverage (268 vs 273 aligned), not reader regression on `main`.

## Follow-ups

- Mirror digit repair in `services/scan-cpu-worker/gridform.py` when that lane is rescored.
- Broader digit repair when both readings stay plausible but disagree with each other only if a unique joint repair exists (needs a separate design).
- Aligner bakeoff: add same-page index fallback after greedy (or check in the author’s local pairing script) so Khanna reports 275/275 paired; keep all-five denominator at 275.
