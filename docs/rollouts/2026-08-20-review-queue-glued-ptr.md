# Review-queue remaining clusters: glued PTR rows

2026-08-20.  Grok.  Issue #2106.  Board `efdb8a9f`.

## What was wrong

After #2102/#2104, 73 House items remained in review.  The typed leftovers were not low-quality extracts.

- Seven `text_pdf` filings parked on `invalid_amount` + `ticker_asset_mismatch` because `parseHousePtrText` required an SP/DC/JT owner on every row.  Later self-owned rows glued into the first `rawText`.  Live: AMZN on an Allegheny County muni (H-2025-20030212); Accenture+AMD mashed to asset name `ACN`; three Direxion TNA lots as one row.
- `parseDates()[0]` treated `due 1/31/2028` as the trade date (H-2024-20025111), so a T-note parked as `future_tx_date`.
- `ocr_unusable` wiped mixed payloads to `[]`.  The 47 form-chrome items had nothing a human or drain could recover.  Amendment letters with one real Treasury line lost that row too.
- Deterministic drain would have published the glued one-row payload after the #2102 amount-bracket skip, landing 1 of N trades — the same class as truncated McCaul (#2104).

Scanned `form_chrome_only` (47) and Khanna OCR floods still need local vision.  Do not empty-confirm those.

## What changed

- Split House PTR records on every `[TYPE] P/S/E date date $amount` tail, including subsequent rows that omit the owner code.
- Skip due/maturity dates when choosing `txDate`.  Parse `Over $1,000,000`.
- Do not flag `ticker_asset_mismatch` when the asset name is just the ticker symbol.
- Keep dated non-chrome rows when OCR is mostly garbage instead of wiping the payload.
- Treat a stored review payload as incomplete when its `rawText` contains more PTR tails than stored rows.  Drain re-extracts instead of publishing the stump.

## Verify

```bash
cd app
npx vitest run src/extraction/__tests__/textPdf.test.ts \
  src/extraction/__tests__/deterministicDrain.test.ts \
  src/extraction/__tests__/normalizer.test.ts \
  src/extraction/__tests__/extractRouting.test.ts
deno check src/deno/main.ts
```

After deploy: `GET /api/admin/review-queue` typed mismatch cluster should drop as drain re-extracts.  McCaul H-2024-8220320 still waits on #2102/#2104 SHA (live was `6ebb15eb`).
