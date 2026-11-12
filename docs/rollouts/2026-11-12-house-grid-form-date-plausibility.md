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

| | 2026-11-12 recall (rollout) | main + aligner | this pass + aligner |
| --- | --- | --- | --- |
| date (aligned) | 239/275 | 228/268 | 228/268 |
| all five | 171/275 | 143/275 | 143/275 |
| confidence ≥ 0.95 | 109 | 109 | 108 |

This pass applied one on-filing date digit repair (`date digit repair applied` in row notes).  Most remaining date misses are plausible misreads that do not fail the plausibility gate (per spec: no invented dates).  Cloud aligner pairs 268 of 275 hand rows (page mapping misses seven rows vs the hand count).

## Follow-ups

- Mirror digit repair in `services/scan-cpu-worker/gridform.py` when that lane is rescored.
- Broader digit repair when both readings stay plausible but disagree with each other only if a unique joint repair exists (needs a separate design).
- Close the seven hand rows the cloud aligner still misses (page index drift vs manual supplemental text).
