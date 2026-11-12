# 2026-10-15 — Arbitration row key includes owner

## Summary

`arbitrationRowKey` was `ticker|date|type`.  Two real lots of the same symbol on the same day, owned by different people, collapsed into one key.  Tier-3 agreement then rejected the whole filing as `ambiguous_multi_lot` (live case H-2026-9116376, 0 rows published).  Linear: CT-2397.

The stable per-row key now appends `|SELF`, `|SPOUSE`, `|JOINT`, or `|DEPENDENT` when owner normalizes to a known code.  A missing or unrecognized owner keeps the historical 3-part key, byte for byte.

Cross-read alignment (`canonicalArbitrationKeys`) is the back-compat layer:

- A single lot per ticker|date|type still uses the 3-part key, so a stored key matches, and models that disagree about owner (or omit it) still vote that field.
- Two or more lots for that prefix keep the owner segment, so spouse and dependent do not collapse.
- A bare stored key is upgraded to the owner-qualified form only when exactly one owner is known for the prefix.  `migrateArbitrationRowKey` does the same for one stored key.

No database migration.  Persisted transaction `row_key` values are the `v1:` fingerprint, which already includes owner.  Consensus and bake-off keys are derived from stored rows on read.

## Files changed

- `app/src/extractors/types.ts` — key, migration, and merge alignment
- `app/src/extraction/agreement.ts` — tier-3 grouping
- `app/src/extraction/consensus.ts` — review consensus grouping
- `app/src/extraction/bakeoff.ts` — mixed-vintage agreement scoring
- `app/src/ui/dashboardHtml.ts` — queued-row pairing and the benchmark majority preview

## Verification

`cd app && npm run typecheck && npm test`

A filing whose models each read a spouse lot and a dependent lot for the same ticker and date publishes both rows.  Two lots with the same owner still return `ambiguous_multi_lot`.  A single lot whose stored key is `TICKER|DATE|TYPE` still matches a row that now keys as `TICKER|DATE|TYPE|OWNER`.

## Follow-ups

Filings already parked as `ambiguous_multi_lot` because of this collision are not requeued by this change.  Reprocess them only when an operator asks.
