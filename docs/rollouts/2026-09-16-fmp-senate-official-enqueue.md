# 2026-09-16 — Enqueue official Senate PTRs from FMP before review stubs

## Summary

BF-Publisher.  FMP surfaced Angus King PTR `e67c6e56-c81e-4e74-b960-849a460165e2` (spouse EA sale, filed 2026-09-14) as `provider_discovered_missing_official` because Senate polling was stale.  Official ingest later persisted `S-e67c6e56-…` via `senateHtml` (conf 0.97) and #2221 rejected the stub as a duplicate at 2026-09-15T08:03Z.

The next FMP Senate PTR with a view UUID should not wait in human review.  When the provider row already carries the eFD report id, insert `S-{uuid}` and hand it to the ingest outbox instead of opening `provider-missing-fmp-senate-*`.

## Why

July 22 follow-up: "Add provider-specific official-document recovery: for provider rows exposing … Senate PTR view IDs, enqueue the official source URL before falling back to synthetic review rows."  #2221 only auto-closes the stub *after* the official filing is already persisted.

## Files

- `app/src/ingestion/providerMissingStubClose.ts` — `enqueueOfficialSenateFromProviderObservation`
- `app/src/ingestion/tradeLatency.ts` — skip stub when official enqueue succeeds
- `app/src/ingestion/__tests__/providerMissingStubClose.test.ts`

House PDF ids stay on the stub path.  Confirming a `provider-missing-*` row is still forbidden.

## Verification

```bash
cd app && npx vitest run src/ingestion/__tests__/providerMissingStubClose.test.ts
```

Live 2026-09-16: admin review-queue unresolved 0.  Official `S-e67c6e56-c81e-4e74-b960-849a460165e2` ingest_status=persisted, one spouse EA sale 2026-08-05 $15,001–$50,000.

## Follow-ups

- House PTR PDF id enqueue (same July 22 bullet).
- Senate polling liveness (stalled this wake; not this lane).
