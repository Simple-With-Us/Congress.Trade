# Mac vision hand-check gate and dual publisher wake

## Summary

Local Mac vision (`local_mac` / `mac_vision` extractors) and unverified vision/OCR on scanned or handwritten PDFs no longer auto-publish, regardless of confidence or model agreement.  Rows stage in `review_queue` with `needs_hand_check:mac_vision` or `needs_hand_check:scanned_vision` until a human/manual confirm publishes.  Printed PTR form example rows (Exempl/Example Mfg Corp variants, 2012/2020 sample dates) drop in all paths via `dropPtrFormSampleParsedRows`.  Review-queue webhooks fan out to BF-Publisher (`REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL`) and GB Publisher (`REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL_GB`) with the same signed payload.

## Files changed

- `app/src/extraction/handCheckPublish.ts` — hand-check gate helpers
- `app/src/extraction/normalizer.ts` — force review + notify on hand-check
- `app/src/extraction/agreement.ts` — skip agreement autopublish on scanned vision
- `app/src/extraction/extractRouting.ts` — broader form-sample detection + shared drop helper
- `app/src/ingestion/reviewQueueNotify.ts` — dual webhook URLs
- `app/src/admin/routes.ts` — mac vision stamp notifies with hand-check reason
- Tests under `app/src/extraction/__tests__/` and `app/src/ingestion/__tests__/`

## Verification

```bash
cd app && npm run typecheck && npm test
```

Prod: set `REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL_GB` in Infisical if GB Publisher is not already listed in the comma-separated primary URL.

## Follow-ups

- Reprocess already auto-published Oct 12 `local_mac` filings (Harshbarger / Wied) after deploy if rows remain live.
