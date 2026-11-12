# Filings auto-publish: 200-tx cap, plurality, House type-code tickers

2026-08-20.  Grok.  Issue #2101.  Board `22db6199`.

## What was wrong

Held review-queue filings were not auto-publishing even when several models extracted the same trades.

- `MAX_PUBLISH_TRANSACTIONS_PER_FILING = 200` refused real PTRs (published corpus already has 201–658 row filings).  Review payloads were truncated, so a human confirm of McCaul H-2024-8220320 could only ship 200 of 219 munis.
- Vision/OpenRouter confidence is capped at 0.6, below the 0.95 vision bar.  Typed House PTRs at 0.6 sat as `low_confidence` with empty flags.
- Models copy House instrument codes (GS, ST, CS, …) into `ticker`.  The same T-bill becomes `GS|date|B` vs `TREASURY BILL|date|B` (prod H-2025-20026666, four successful reads).
- Tier 3 required strict majority on assetName.  A unique 2-of-5 plurality on the most variable field blocked publish.
- Deterministic drain re-extracted via OpenRouter and was starved by older empty/form-chrome rows.

## What changed

- Publish sanity cap is 2000.  Clean large filings publish.  Uniform **low** OCR (0.189 floods) still held as garbage.
- `prepareExtractedTx` demotes a House type-code ticker when the asset name describes that class.  Goldman Sachs stock keeps ticker GS.
- Unique plurality is enough for assetName/assetType.  Identity fields (date, type, amount, owner, ticker) still need majority.
- Deterministic drain republishes stored payloads first (no LLM).  Newest first.  Skips form_chrome/ocr_unusable.
- `maybePublishFromStoredRuns` votes existing `extraction_runs` (latest per model) and publishes with no new LLM spend.

## Manual drain this session

Confirmed 37 clean held filings (~63 txs) via admin review, including Yakym T-bill and Gill BTC/ETF rows.  Queue 114 → ~77.

Left for later / this deploy:

- 48 scanned `form_chrome_only` (CPU OCR got letterhead; need local vision, not an empty confirm)
- Khanna 0.189 OCR floods above 200 rows
- McCaul 219 (truncated until this lands; stored-run should publish)
- ticker/name mismatches and missing/future dates

## Verify after deploy

- `GET /api/admin/review-queue?limit=1` totals drop as drain + stored-run tick
- McCaul H-2024-8220320 publishes >200 rows
- A T-bill with `[GS]` auto-publishes instead of splitting on ticker GS
