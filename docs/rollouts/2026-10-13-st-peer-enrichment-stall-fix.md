# ST peer enrichment stall detector fix

## Summary

The `st_peer_enrichment` pipeline stall alert measured progress with
`MAX(enriched_at)` over all Socratic-sourced rows and a coarse pending count
(`enriched_at IS NULL`), so a small junk backlog could page while unrelated
symbols kept enriching, or while SEC EDGAR filled profiles without touching the
Socratic timestamp.  The detector also used the 6h default stall window, which is
too tight for daily/hourly enrichment cadence.

This change scopes pending work to the same predicate as the enrichment runner
(minus `enrichment_unavailable` marks), measures progress only on
`enrichment_checked_at` for that pending set, raises the code default to 30h
(overridable via `CT_PIPELINE_STALL_HOURS_ST_PEER_ENRICHMENT`), includes up to
ten pending ticker symbols in alert detail, stamps `enrichment_checked_at` on
every enrichment attempt, and negative-caches confirmed no-profile symbols
(runner tombstone, or `POST /api/admin/securities/:ticker/enrichment-unavailable`).

## Files changed

- `app/src/ingestion/pipelineLoudAlerts.ts` — pending-scoped progress + sample tickers + 30h default
- `app/src/enrichment/service.ts` — `markTickerEnrichmentUnavailable`, `enrichment_checked_at` stamps
- `app/src/admin/routes.ts` — admin mark endpoint + pending counts
- `app/migrations/0104_enrichment_unavailable.sql` + `app/src/admin/migrations.ts` mirror
- Tests under `app/src/ingestion/__tests__/`, `app/src/admin/__tests__/`

## Verification

From `app/`:

- `npm run typecheck`
- `npm test`

Manual (prod, after deploy + migrate):

- Confirm `st_peer_enrichment` stall detail lists pending ticker samples when it fires.
- `POST /api/admin/securities/JUNK/enrichment-unavailable` with `{ "reason": "…" }` sets `enrichment_unavailable` and drops the ticker from pending counts.

## Follow-ups

- Clearing a mistaken `enrichment_unavailable` mark is operator-driven (import a full ref or clear the flag in admin tooling if we add a paired clear endpoint later).
