# 2026-09-23 — Empty 278e vs unreadable 278-T

## Summary

Two executive review rows were parked at `agreement_cascade_unresolved` with zero transactions.  An empty OGE 278e (Pam Bondi termination, Part 7 has no rows) and an unreadable OGE 278-T (Donald J. Trump, garbled text layer, index/coverage gate refuses) were taking the same zero-row path.  Capped-row recovery then rewrote `extract_empty_failure` into `agreement_cascade_unresolved`, which is health-terminal and never closes.

This builds on #2553, which closes a Part 7 body that literally says None.  A 278e with no 278-T table and no other successful read closes the same way when that word is absent.  A refused 278-T does not.

The deterministic parser now reports `empty` and `unreadable` separately.  A 278e with no 278-T table and no other successful read closes as `verified_empty` / `auto_resolved_empty`.  A refused or unreadable 278-T closes as `rejected` / `oge_text_unreadable` (`ocr_unusable`).  Recovery will not relabel either reason.  An hourly sweep closes the two already-parked doc ids.  It is allowlisted and idempotent.

## Files changed

- `app/src/extraction/ogeText.ts` — classify empty vs refused
- `app/src/extraction/executiveDisposition.ts` — close paths and the two-doc sweep
- `app/src/extraction/agreement.ts` — do not rewrite empty/unreadable; settle executive zero-reads
- `app/src/extraction/normalizer.ts`, `orchestrator.ts` — carry the disposition into normalize
- `app/src/ingestion/autonomySweeps.ts` — hourly sweep

## Verification

`cd app && npx vitest run src/extraction/__tests__/ogeText.test.ts src/extraction/__tests__/executiveDisposition.test.ts src/extractors/__tests__/arbitration.test.ts src/extraction/__tests__/agreementCascade.test.ts src/ingestion/__tests__/autonomySweeps.test.ts`

After deploy, the Bondi row is `resolution_kind=verified_empty` and the Trump row is `resolution_kind=rejected` with `resolution_reason=oge_text_unreadable`.  A second sweep run changes nothing.  Neither doc id has live transactions.

## Follow-ups

The sweep allowlist is only those two doc ids.  Other historical `agreement_cascade_unresolved` rows are untouched.
