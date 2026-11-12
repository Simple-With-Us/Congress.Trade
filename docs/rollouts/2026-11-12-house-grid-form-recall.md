# House grid-form recall

## Summary

The 2026-11-11 reader aligned 273 of 275 hand rows on H-2026-9116399 and got all five fields right on 144 (recall 0.524).  This pass reads the asset, owner, and date cells from a 300 DPI image and fills the one-row gap a trust bar swallows.  Type and amount stay template-matched x marks on the 150 DPI image.  It still uses local tesseract.  It does not call OpenRouter or any paid vision API.

All-five recall on the 275 published rows is 171/275 (0.622).  The 0.95 per-filing publish gate stays closed.  Unmarked type rows stay at confidence 0.35.  A row with no trade-date word cannot reach 0.97.  182 rows on this filing are still below 0.95, including 30 with no type mark, so the filing stays off the publish path.

## Files changed

- `app/src/extraction/houseGridForm.ts` — one-pitch row fill, owner aliases, October month repair, bare ticker, form-token cleanup
- `app/src/extraction/houseGridFormRuntime.ts` — 300 DPI cell OCR, row-rule inset, rule-bounded asset crop, one OpenMP thread per tesseract
- `app/src/extraction/__tests__/houseGridForm.test.ts` — glued names, bare ticker, empty rows, month 40, Fleischmann hand rows
- `app/src/extraction/__fixtures__/H-2026-9116403-hand-rows.json` — seven Fleischmann hand rows
- `services/scan-cpu-worker/gridform.py` — the same row fill, month repair, owner aliases, and bare ticker

## What changed

A trust bar on page 22 sits on the rules of the two neighboring rows.  When the asset column still has ink, the reader inserts one band a single row-pitch above that bar and one band below it.  Page 22 goes from 11 bands to 13.  No other page on this filing changed its band count.

Text cells are cropped from a second render at 300 DPI and mapped back into the 150 DPI columns.  The date crop is inset past the horizontal rule, which otherwise makes the single-line OCR return empty.  The asset crop starts just after the vertical rule on each side.  Each tesseract process is limited to one OpenMP thread.  Without that limit, eight parallel processes oversubscribe a four-core host and a batch takes tens of seconds.

Owner ink is still matched as a DC, SP, or JT glyph first.  Text is used only when its confidence is at least 0.4.  BC, CC, and HC join the existing dependent aliases.  The glyph floor is unchanged.

Months 30 and 40 join 16, 18, 19, and 20 as October.  A trade year that is exactly one below the notification year snaps forward when the snapped date is not after the notification.  A missing trade-date word stays null.  The notification date is not copied over.

Glued form tokens drop interior junk other than `&`, split on `/`, and peel only a CLASSA or CLASSB suffix.  A digit-heavy token maps O to 0.  HLDG CO, USD0, and ADR join the form map.  Two spaces between the asset name and a final ticker are kept, so a bare ticker with no parentheses splits off.  Company names are not rewritten from a filing-specific list.

The cover check is unchanged: no trust bar, plus a rule in the top of the page, emits nothing.  An on-page column fit for H-2026-9116403 was tried and removed.  It emitted the header and the sample row, put the amount x in bracket E, and still skipped page 2.

The Python worker mirrors the row fill, the month repair, the owner aliases, and the bare ticker.  It does not run the 300 DPI cell OCR or the TypeScript name cleaner.

## Verification

`cd app && npm run typecheck` passed.  `cd app && npm test` passed, 5459 tests, including 19 in `houseGridForm.test.ts`.  `services/scan-cpu-worker` pytest passed, 25 tests, including 5 in `test_gridform.py`.

Scored again on H-2026-9116399.  The PDF stays out of the repo.  The 275 comparison rows are the names published for that filing.  The same aligner scores the 2026-11-11 reader at 143/275 on those names.  The 144/275 in the 2026-11-11 note used the original hand file, which is not in the repo.  Alignment is per page and order-preserving.  A pair is kept when the type agrees, or when the asset and date identify the same row.  Field hits below are on the aligned pairs.  All-five recall uses all 275 rows.  A blank owner on both sides counts as an owner hit.

| | 2026-11-09 | 2026-11-11 | this pass |
| --- | --- | --- | --- |
| emitted | 262 | 289 | 291 |
| aligned | 185 | 273 | 275 |
| missed | 90 | 2 | 0 |
| extra | 77 | 16 | 16 |
| type | 185/185 | 257/273 | 259/275 |
| amount | 184/185 | 253/273 | 255/275 |
| date | 156/185 | 238/273 | 239/275 |
| owner | 112/185 | 235/273 | 255/275 |
| asset at 0.75 | 85/185 | 213/273 | 238/275 |
| all five | 37/275 (0.135) | 144/275 (0.524) | 171/275 (0.622) |
| cover rows | 4 | 0 | 0 |
| confidence at least 0.95 | 135 | 109 | 109 |
| confidence below 0.95 | 127 | 180 | 182 |

Page 22 is 13 of 13.  Owner misses are 12 dependent and 8 spouse cells left blank.  There are no owner swaps.  109 rows are at or above 0.95 and 182 are below, so the filing cannot publish.

H-2026-9116403 is a second hand set, committed as seven rows: purchases TLH, XAR, and SPMD, sales IEUR, SPYG, SPTI, and XLE, all joint, trade date 2026-10-22, notification 2026-11-01, amount $1,001–$15,000.  The synthetic tests lock a bare ticker, a month-40 date, and three empty joint rows that emit nothing.  The live two-page scan emits nothing.  Both pages have a header rule and no trust bar, which is the cover check.  Forcing a column fit onto the page emitted 16 rows, including the header and the sample "Example Mega Corp" row, with the amount x in bracket E, all below 0.95, and still skipped page 2.  That fit is not in this pass.

## Follow-ups

The live Fleischmann scan needs a column template whose amount pitch matches the page.  The geometrically correct scale is about 0.48, below the primary minimum of 0.5, and anchoring the outer rules only reaches 9 to 12 inliers.  Do not drop the cover check to read it.  The Khanna cover still scores false type and amount marks.
Remaining Khanna misses are clipped first letters, a few one-digit dates, and the 20 blank owner cells.  Do not copy a notification date into a null trade date, do not lower the glyph floor, and do not add a company dictionary.
Sixteen extra rows remain, on pages 8, 13, 14, 15, 18, 19, and 20.
