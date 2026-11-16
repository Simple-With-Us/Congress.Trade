# House grid-form accuracy

## Summary

The first grid-form pass on H-2026-9116399 aligned 185 of 275 hand rows and got all five fields right on 37 of them (recall 0.135).  This pass fixes the row geometry, the cover page, the owner cell, and the trade-date column.  It still uses local tesseract and template matching.  It does not call OpenRouter or any paid vision API.

The 0.95 per-filing publish gate stays closed.  Unmarked type rows stay at confidence 0.35.  A row with no trade-date word cannot reach 0.97.

## Files changed

- `app/src/extraction/houseGridForm.ts` — pitch fill for faint rules, cover skip, owner-glyph match, date columns, asset cleanup
- `app/src/extraction/houseGridFormRuntime.ts` — asset and date strips instead of a full-page OCR
- `app/src/extraction/__tests__/houseGridForm.test.ts` — cover, missed trade date, owner glyph, asset cleanup
- `services/scan-cpu-worker/gridform.py` — the same row fill, cover skip, and date columns

## What changed

Row rules are filled from the page's single-row pitch, including gaps of several rows, and a short table above the usual header window is fit from the top of the page.  That recovers the merged rows on pages 6, 12, and 16, the empty page 23, and the single row on page 10.
The cover has a sample grid and no trust bar, plus a rule in the top of the page.  That page now emits nothing.  A data page has a trust bar, so the check does not drop it.  The synthetic fixture has neither, so its rows stay.
Owner codes are matched as DC, SP, or JT glyphs in the owner column.  Blank ink stays null.  A joint match stays on a stricter score than DC or SP.
The trade date is the word in the left date column and the notification date is the word in the right column.  If the trade-date word is missing, the trade date stays null.  The notification date is not copied over.
Asset text is read from the asset column, then form words that tesseract glues together (INC, CMN, LLC, an S&P 500 index) are split.  Company names are not rewritten from a filing-specific list.

## Verification

`cd app && npm run typecheck` passed.  `app` vitest `houseGridForm.test.ts` passed (16 tests), including the synthetic refusal page, a cover that emits nothing, a notification date that is not stored as the trade date, and a stamped DC cell.  `services/scan-cpu-worker` pytest `test_gridform.py` passed (5 tests).  The full `app` vitest run passed, 5421 tests.

Scored again on H-2026-9116399 against the same 275 hand rows.  The PDF and the hand file stay out of the repo.  Alignment is per page and order-preserving.  A pair is kept when the type agrees, or when the asset and date identify the same row.  Field hits below are on the aligned pairs.  All-five recall uses all 275 hand rows.

| | 2026-11-09 | this pass |
| --- | --- | --- |
| emitted | 262 | 289 |
| aligned | 185 | 273 |
| missed | 90 | 2 |
| extra | 77 | 16 |
| type | 185/185 | 257/273 |
| amount | 184/185 | 253/273 |
| date | 156/185 | 238/273 |
| owner | 112/185 | 235/273 |
| asset at 0.75 | 85/185 | 213/273 |
| all five | 37/275 (0.135) | 144/275 (0.524) |
| cover rows | 4 | 0 |
| confidence at least 0.95 | 135 | 109 |
| confidence below 0.95 | 127 | 180 |

All-five recall is 0.524.  The 0.60 target is not met.  Cover rows are zero.  180 rows are still below 0.95, including 30 with no type mark, so the filing stays off the publish path.

## Follow-ups

Page 22 is still short two typed rows, and page 15 has one extra band.  The other extras are the 15 untyped rows left out of the hand set.
Owner misses are unread glyphs, not spouse/dependent swaps.  Trade-date misses are unread or one-digit-off words, not the notification date.  Asset misses are proper-noun character errors at this scan size.
Those three still overlap, which is why all-five recall stays under 0.60.  Closing that gap needs a better read of the 10px glyphs, not a looser publish gate.
The next pass is in `docs/rollouts/2026-11-12-house-grid-form-recall.md`.  It scores 171/275 and page 22 is 13 of 13.  The notes above describe the 2026-11-11 reader.
