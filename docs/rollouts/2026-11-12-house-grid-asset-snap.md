# House grid-form asset snap

## Summary

The grid-form reader on H-2026-9116399 matches 238 of 275 asset names at token overlap 0.75, and 171 of 275 rows on all five fields.  Most of the remaining name errors are misread proper nouns.  This pass adds a post-OCR snap in its own module.  It compares the OCR line with securities_ref company names, securities_master names and aliases, and the curated issuer list.  A clear letter match stays as read.  A unique near miss replaces only the misread token, lowers that row's confidence by 0.03, and fills a missing ticker only on that strong unique match.  Linked notes, hybrids, and option lines do not receive an equity ticker.  The 0.95 publish gate stays fail-closed.

## Files changed

- `app/src/extraction/houseGridAssetSnap.ts` — catalog load, fuzzy snap, and the 0.03 confidence drop
- `app/src/extraction/houseGridFormRuntime.ts` — optional catalog hook after `readHouseGridForm`
- `app/src/extractors/types.ts` — the extractor pipeline passes `loadHouseGridSecurityCatalog`
- `app/src/extraction/__tests__/houseGridAssetSnap.test.ts` — clear reads, one-letter fixes, ticker conflicts, and option lines

## What changed

The matcher builds a key from the company tokens.  Legal forms compare equal without rewriting the OCR word, so INC stays INC and CORPORATION stays CORPORATION.  N.V. stays in the key.  Apostrophes and ampersands split into the same display tokens the aligner uses, so O'Reilly stays O REILLY.

A distance of 0 does not rewrite the string.  It may fill a null ticker when the catalog name has exactly one ticker.  A one-letter edit is accepted when the shorter key is at least 5 characters, the ratio is at least 0.80, and the margin over the next name is at least 0.12, or 0.25 when that key is only 5 characters.  A two-letter edit needs a shorter key of at least 8, a ratio of at least 0.90, and a margin of at least 0.08.  An existing ticker that names a different security blocks the snap.  Option lines that start with CALL/ or PUT/ are left alone.  A name change appends "asset name snapped" to supplementalText and sets confidence to the original minus 0.03, never higher.

The catalog is securities_ref (ticker, company_name), securities_master (ticker, name, aliases), and the curated issuer list.  A missing table is cached as an empty side.  A lock or other query failure is not cached, so the next filing retries it.  Tests that call `readHouseGridForm` directly are unchanged.

## Verification

`cd app && npm run typecheck` passed (`deno check src/deno/main.ts`).  `cd app && npm test` passed, 5517 tests in 399 files, including 11 in `houseGridAssetSnap.test.ts`.

Scored on the same H-2026-9116399 OCR rows as the 2026-11-12 recall note, then snapped with the live public asset roster (4308 names).  The PDF stays out of the repo.  Alignment is the same per-page order-preserving aligner.  Type, amount, date, and owner are unchanged.  All-five still uses all 275 published rows.

| | before | after |
| --- | --- | --- |
| emitted | 291 | 291 |
| aligned | 275 | 275 |
| missed | 0 | 0 |
| extra | 16 | 16 |
| type | 259/275 | 259/275 |
| amount | 255/275 | 255/275 |
| date | 239/275 | 239/275 |
| owner | 255/275 | 255/275 |
| asset at 0.75 | 238/275 | 247/275 |
| all five | 171/275 (0.622) | 178/275 (0.647) |
| confidence at least 0.95 | 109 | 105 |
| confidence below 0.95 | 182 | 186 |

Ten names changed.  Nine of them cross the 0.75 asset line: Zoetis, DoorDash, NXP Semiconductors, Otis Worldwide, Illinois Tool Works, Old Dominion, Kimberly-Clark, O'Reilly, and Capital One.  Bank of America on the hybrid line is corrected and stays without a ticker.  Four of those rows were at 0.97 and are now 0.94, so the filing still cannot publish.

## Follow-ups

NETFUX, learon, loneo, and lnsazon stay uncorrected because the edit is too large or the margin is too small.  KEY CORP, DR HORTON, LAB CORP, and DOMINO S stay as read because the letters already match.  Cover-page detection and date repair are separate changes.  Do not raise a snapped row back over 0.95.
