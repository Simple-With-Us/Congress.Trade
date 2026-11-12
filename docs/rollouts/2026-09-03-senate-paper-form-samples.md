# Senate paper PTR form samples no longer park the review queue

## Summary

BF-Publisher drained four live Senate paper PTRs that sat in human review only because `senatePaperMedia` OCR kept the printed IBM/Microsoft example rows. Those rows use placeholder dates `2/1/1X` and `2/27/1X`. Gemini was reading `1X` as `27`, scoring `future_tx_date` (a hard publish block) on the whole filing.

Live handling (prod, 2026-09-03):

- `S-a3722489-195c-4554-8ad0-d32981aa2f61` Richard Blumenthal, filed 2025-05-28. Confirmed 38 official spouse lots from eFD pages 259-262. Dropped IBM/Microsoft examples.
- `S-16afdd38-c0ec-4e37-bc05-cbd82901b43f` Richard Blumenthal, filed 2025-12-12. Confirmed 21 official spouse lots from eFD pages 525-527.
- `S-7dfcd5fd-ae2e-4a52-8f54-bcfe1c4599ef` John Boozman, filed 2023-03-06. Confirmed 8 official IRA lots from the typed attachment. Dropped the printed examples.
- `S-5d1db106-16dc-4cfa-bbdd-bca6f03dd5bd` John Boozman, filed 2022-10-07. Confirmed 6 official IRA lots from the typed attachment. Queue OCR had only the two printed examples.

Admin `review-queue` unresolved went 4 → 0. `confirm` inserted `source=primary`.

Code: treat the Senate printed IBM/Microsoft wording as form chrome (same path as House Example Mega Corp), skip "See Attachment" pointers, reject `1X` placeholder years, and tell paper OCR to read attachment pages.

## Files changed

- `app/src/extraction/extractRouting.ts` — Senate IBM/Microsoft sample detector + See Attachment pointer.
- `app/src/extraction/senatePaperMedia.ts` — drop those rows in `mapPaperRow`; prompt skip; placeholder-year dates.
- `app/src/extraction/normalizer.ts` — drop See Attachment pointers before scoring.
- tests in `extractRouting.test.ts`, `normalizer.test.ts`, `senatePaperMedia.test.ts`.

## Verification

- Live: `GET /api/admin/review-queue?limit=10` count 0.
- Live: `GET /api/filings/S-a3722489-195c-4554-8ad0-d32981aa2f61` 38 txs; Dec Blumenthal 21; Boozman Mar 8; Boozman Oct 6.
- `cd app && npm run typecheck && npm test` (this PR).

## Follow-ups

- Health `extraction_backlog` still showed 4 until the next `/api/health` tick after the drain. Do not treat that stale snapshot as a remaining queue.
- Publisher webhook env is still unset. Do not invent the URL/key.
