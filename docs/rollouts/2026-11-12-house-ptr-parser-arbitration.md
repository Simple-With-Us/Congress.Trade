# House PTR parser arbitration by row validation

2026-11-12. Cursor. Linear CT-2508.

## Summary

`parseHousePtrText` used to keep whichever of the `[TYPE]`-first tail parser and the column-order parser returned more complete rows.  On Gilbert Cisneros H-2026-20035788 a page-split Norwegian Cruise Line row let the column parser out-count the tail parser while shifting Subholding Of and the next row's ticker and asset type.  The page-split rejoin from PR #3054 still runs inside the tail parser.  Arbitration no longer uses that count.

The choice lives in `app/src/extraction/housePtrParserArbitration.ts`.  Each row is scored on a real transaction type, a STOCK Act amount, a real calendar date, an owner code, ticker and asset-name consistency against `securities_ref.company_name` when that index is loaded, and cross-row bleed (a detail label, a `[TYPE]` bracket, or the next row's ticker landing in Subholding Of or the asset name).  Rows the two parsers describe the same way are merged.  When they disagree on the trade, the higher-scoring row is what review sees and every row on that filing is capped at 0.94, under the 0.95 publish threshold.  A filing only one parser can read is unchanged.

## Files changed

- `app/src/extraction/housePtrParserArbitration.ts` — scoring, alignment, and the hold
- `app/src/extraction/textPdf.ts` — `parseHousePtrText` calls the arbiter; the text extractor loads `securities_ref` when it has a database
- `app/src/extractors/types.ts` — pass env into `TextPdfExtractor`
- `app/src/extraction/__tests__/housePtrParserArbitration.test.ts` — Cisneros fixture and the count trap
- `app/src/extraction/__tests__/textPdf.test.ts` and `textPdfSubholdingCarryover.test.ts` — confidence follows agreement

`parseTailRecords` and `parseColumnTailRecords` are not rewritten.  PR #3069 can keep changing the column parser.

## Verification

```bash
cd app
npm run typecheck
npm test
```

Cisneros H-2026-20035788 still yields 65 rows, with NCLH rejoined and NVDA typed ST.  While the column parser disagrees, that filing is held.  When the two parsers agree row by row, the same fixture can publish.

## Follow-ups

- No migration and no production deploy in this change.
- After the column parser agrees with the tail parser, held electronic PTRs can publish on the next extract without another arbitration change.
