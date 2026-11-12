# House official PTR grid

## Summary

The scanned House PTR reader treated both pages of Fleischmann H-2026-9116403 as covers.  Each page has a header rule and no trust bar, and the attached-schedule column fit still succeeded, so the cover check emitted nothing.  A fit that kept the page used the schedule template, which inserts capital-gains, partial, and bracket K, and the amount x landed in bracket E.

This pass fits the printed PTR's 18 rules before the schedule templates.  Those rules expand onto the 21 schedule slots, and the missing capital-gains, partial, and bracket K columns stay empty.  Row bands come from the amount columns at the data pitch, so the shorter sample row and the filer block stay out of the table.  Header text and the Example Mega Corp sample are dropped even when they are marked.  The cover check still skips a schedule page.

H-2026-9116403 emits the seven hand rows: purchases TLH, XAR, and SPMD, and sales IEUR, SPYG, SPTI, and XLE.  Each is joint, traded 2026-10-22, notified 2026-11-01, and marked $1,001–$15,000.  The header, the sample row, and the three empty rows on page 2 do not emit.  All seven confidences are about 0.79, under the 0.95 publish gate.

Khanna H-2026-9116399 stays on the schedule path.  Page 6 can line up 16 of the printed PTR rules near scale 0.92, so the official fit only accepts scale 0.96 to 1.05.  The cover still emits nothing.  The same order-preserving aligner scores all-five 171/275.  The filing still has 109 rows at or above 0.95 and 182 below, so it stays off the publish path.  `houseGridForm` is not a deterministic extractor, and `CONFIDENCE_THRESHOLD` stays 0.95.

## Files changed

- `app/src/extraction/houseGridForm.ts` — printed PTR column fit, row bands, mark scale, one-space ticker, ampersand
- `app/src/extraction/houseGridFormRuntime.ts` — official-form cell inset past the rule
- `app/src/extraction/__tests__/houseGridForm.test.ts` — header and sample drop, one-space ticker, shrunk-template rejection
- `services/scan-cpu-worker/gridform.py` — the same fit, bands, cover skip, and chrome drop
- `services/scan-cpu-worker/tests/test_gridform.py` — official fit and a scale-0.92 rejection

## What changed

The official template is the 18 vertical rules measured on the Fleischmann scan at 150 DPI.  A hit is a template rule with a detected line within 12px, both outer rules have to hit, and 16 hits are required.  Scale has to sit between 0.96 and 1.05.  Fleischmann matches 18 of 18 at scale 1.0.  The Khanna cover reaches only 14 hits, and Khanna page 6 reaches 16 hits only near scale 0.92, so both stay on the schedule fit and the existing cover check.

The 18 rules expand onto the schedule slots.  Owner, asset, purchase, sale, and exchange keep their columns.  Capital gains and partial share the trade-date boundary, and bracket K shares the last rule.  Cells narrower than 8px score 0, so those phantom columns cannot become marks.  The checkbox template is scored at 1.1 times the fit scale.  At the raw fit scale the XLE sale mark was 0.44, under the 0.45 cutoff, and the larger template clears every real mark while the header words stay under it.

Amount-column rules define the rows.  The pitch is the median gap from 45px to 90px, and a band has to sit between 0.8 and 1.35 of that pitch.  The longest consecutive run is the table.  Page 1 keeps the five data rows and drops the sample gap.  Page 2 keeps the header band, the two trades, three empty rows, and the bottom band.  The footnote table is a shorter run and is excluded.

On an official page, chrome is dropped even when a box is marked.  That covers the instruction line, Example Mega Corp, a sample date, and a see-attachment pointer.  A row still needs a clear type mark and an asset name.  The schedule page keeps the old rule and drops chrome only when there is no mark.

The printed PTR puts one space before the ticker.  The schedule still requires two spaces, so a one-space XLE on a schedule name does not peel.  A standalone ampersand stays in the asset name.  The owner and date crops sit 4px inside the fitted rule.  A 2px inset still included the rule, and Tesseract read JT as ost and 11 as 41.  The schedule crop is unchanged.

The Python worker mirrors the fit, the bands, the cover skip, the chrome drop, the mark scale, and the one-space ticker.  It does not run the 300 DPI cell OCR.

## Verification

`cd app && npm run typecheck` passed.  `cd app && npm test` passed, 5508 tests, including 21 in `houseGridForm.test.ts`.  `services/scan-cpu-worker` pytest passed, 26 tests, including 6 in `test_gridform.py`.

The live Fleischmann scan emits 7 rows and nothing else.  Type, owner, trade date, notification date, ticker, and amount match the hand file on every row.  Asset tokens match as well.  The read capitalizes IShares and Spdr where the hand file uses iShares and SPDR.  Amounts are bracket A ($1,001–$15,000), not bracket E.  Confidences are 0.791 to 0.805.

Khanna was scored again against the 275 names published for that filing.  The PDF stays out of the repo.  Alignment is per page and order-preserving.  A pair is kept when the type agrees, or when the asset and date identify the same row.  All-five recall uses all 275 rows.  A blank owner on both sides counts as an owner hit.

| | 2026-11-12 recall | this pass |
| --- | --- | --- |
| emitted | 291 | 291 |
| aligned | 275 | 273 |
| missed | 0 | 2 |
| extra | 16 | 18 |
| type | 259/275 | 258/273 |
| amount | 255/275 | 245/273 |
| date | 239/275 | 239/273 |
| owner | 255/275 | 253/273 |
| asset at 0.75 | 238/275 | 243/273 |
| all five | 171/275 | 171/275 |
| cover rows | 0 | 0 |
| confidence at least 0.95 | 109 | 109 |
| confidence below 0.95 | 182 | 182 |

Page 1 emits nothing.  Page 6 stays on the schedule template and emits 16 rows.  Page 22 is 13 of 13.  109 rows are at or above 0.95 and 182 are below, so the filing cannot publish.  No migration and no deploy.
## Follow-ups

Two Khanna hand rows still do not align, and 18 extra rows remain.  Do not copy a notification date into a null trade date, do not lower the glyph floor, and do not lower the 0.95 gate to publish either filing.
