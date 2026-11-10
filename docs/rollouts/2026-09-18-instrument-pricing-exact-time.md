# 2026-09-18 — GROK — Instrument pricing capabilities, observed-vs-claimed provenance, exact-time lookup

## Summary

Congress.Trade leftover from board `37bdf975` / issue #2248 (Options & Kalshi event contract account separation, distinct settings & exact pricing).

Socratic.Trade already shipped first-class Kalshi accounts and capability-gated settings (PR #3122, 2026-08-28). This slice is the CT half:

- Capability boundary for Equities (long), Crypto, Options, and Event Contracts (Kalshi). Minute-level PIT is allowed only for equities and crypto.
- Exact-time (1-minute) price lookup via the Socratic.Trade peer. Options and event contracts are refused instead of substituting an equity print.
- Timestamp provenance on latency snapshots: `observed` (we witnessed it) vs `claimed` (competitor purported time). Precision stays on the existing `confidence` column (`exact` / `bracketed` / `unbounded`).
- Admin Instrument Pricing pane with the capability matrix, committee→industry map version, provenance counts, and an exact-time lookup form.

Committee→GICS mapping was already live (`conflicts.ts`, Trends conflicts, PIT scores). This pane surfaces that version rather than duplicating the map.

## Files changed

- `app/src/prices/instrumentCapabilities.ts` (new)
- `app/src/prices/exactPrice.ts` (new)
- `app/src/admin/instrumentPricing.ts` (new)
- `app/migrations/0098_latency_time_provenance.sql` (new)
- `app/src/ingestion/latencyPriceSnapshots.ts` — skip non-minute instruments; write `time_provenance`
- `app/src/ingestion/tradeLatency.ts` — pass `isOption` / asset type into ct_publish scheduling
- `app/src/admin/migrations.ts` / `routes.ts` / `dashboardHtml.ts`
- Tests for capabilities, exact-price lookup, snapshot planning, admin routes, migrations, dashboard HTML

## Verification

- `cd app && npm run typecheck && npm test`
- Targeted: instrumentCapabilities, exactPrice, latencyPriceSnapshots, instrumentPricing, migrations, dashboardHtml

## Follow-ups (not in this slice)

- ST Kalshi trading UI leftovers (already on ST main; not CT).
- ROIC.ai earnings-transcript status (ST settings; not a CT provider).
- Expose latency candidates on `/api/transactions` for ST ingest (`delivery/rows.ts` JOIN).
- Kalshi probability feed into CT (would be a new peer contract, not equity bars).
- Politician historical-performance columns on the latency analysis dataset.
