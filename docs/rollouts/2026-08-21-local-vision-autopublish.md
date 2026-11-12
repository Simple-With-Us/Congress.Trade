# Local vision: stop re-OCR loop, auto-publish clean Grok extracts

2026-08-21.  Grok.  Board `c9d9766b`.  Branch `grok/queue-autopublish`.

## Summary

The Mac vision-worker transcribed the same two House scans all afternoon
(`H-2025-9115689` Hal Rogers 17 rows, `H-2025-8221302` Michael McCaul 93/94
rows) because `GET /scanned-filings/pending?worker=local` reclaimed every
unresolved review item and `ingest-local-vision` returned
`published=false needsReview=true`.  `clear_attempts` then forgot the doc
so the next poll picked it again.

Two mechanical bugs held otherwise-read rows:

1. `parseAmountRange` stripped digits from asset names (`Fund 4 LP`,
   `BDS 2016`) and treated them as exact dollar amounts, so a canonical
   STOCK Act bracket became `invalid_amount` and blocked the whole filing.
2. One PTR row with an unchecked amount box (`no_amount`) dropped
   min-confidence below 0.95 and held every sibling trade.  Rogers page 4
   really has five sales with no amount checkbox; those rows should persist
   with null brackets, not freeze the other twelve.

Adrian Smith's Bitcoin PTR (`H-2025-8221238`, 2025-10-17 purchase, bracket A)
was already published via `local_grok_cli_v1` / `local_mac`.

## What changed

- `parseAmountRange` only parses a single-token amount when the whole string
  looks like money (`$1,000`, `456.00`), not a fund name with a digit.
- Local Grok / `local_mac` extracts: `no_amount` is not a filing-level hard
  stop.  Gate confidence on rows that have amounts; persist omitted-amount
  rows too.
- After a local-mac submit that still needs review, tag
  `local_vision_submitted` and keep that doc off the pending list.
- Vision-worker: remember `review_submitted` instead of clearing attempt
  state; skip those docs on the next poll.
- Admin confirm allows `amountMin: null` so a human can ship the same
  omitted-checkbox rows.

## Manual drain this session

- Confirmed McCaul `H-2025-8221302` 94 rows (false `invalid_amount` on five
  fund names).  Inserted 94.  Delivery claimed 40 on that tick.
- Live worker skip copied to `~/vision-worker/worker.py` and the two looping
  docs marked `review_submitted` so the worker moved on to `H-2025-9115684`.

Left for the deploy: re-ingest Rogers `H-2025-9115689` so the five
unchecked-amount sales publish beside the twelve bracket-A sales.  Do not
invent an A box they did not check.

## Files changed

- `app/src/extraction/amounts.ts`
- `app/src/extraction/normalizer.ts`
- `app/src/admin/routes.ts`
- `services/vision-worker/worker.py`
- tests for amounts, normalizer, pending-list skip

## Verification

```bash
python3 services/vision-worker/test_worker.py
cd app && npx vitest run src/extraction/__tests__/amounts.test.ts \
  src/extraction/__tests__/normalizer.test.ts \
  src/ingestion/__tests__/localVisionWaitState.test.ts
```

Live: `GET /api/admin/review-queue?limit=1` totals drop; vision-worker log
shows `skipped ... review` instead of re-processing 9115689/8221302;
McCaul 94 rows on `/api/transactions?q=McCaul`.

## Follow-ups

- Rotate portrait House PTR pages before the Grok CLI pass (still burns
  turns on sideways grids).
- `H-2025-8220834` server_cpu glue (dates in the asset name, every amount
  box marked) needs a real vision pass, not a confirm of OCR garbage.
