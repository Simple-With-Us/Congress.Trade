# ST peer prices stall detector fix

## Summary

The `st_peer_prices` pipeline stall alert fired on every quiet stretch while a
tiny set of never-priced tickers remained in the backlog.  Progress was measured
with `MAX(price_checked_at)` across all Socratic-sourced securities, so daily
EOD cadence tripped the 6h default even when the pending set was unchanged.
This change measures progress only on pending tickers, raises the code default
window to 30h (still overridable via `CT_PIPELINE_STALL_HOURS_ST_PEER_PRICES`),
includes up to ten pending ticker symbols in alert detail, and negative-caches
tickers when Socratic.Trade confirms there is no price (price refresh, import,
or `POST /api/admin/securities/:ticker/price-unavailable`).

## Files changed

- `app/src/ingestion/pipelineLoudAlerts.ts` — pending-scoped progress + sample tickers + 30h default
- `app/src/prices/service.ts` — `markTickerPriceUnavailable`, reason on empty fetch
- `app/src/admin/routes.ts` — import empty-price handling + admin mark endpoint
- `app/migrations/0103_price_unavailable_reason.sql` + `app/src/admin/migrations.ts` mirror
- Tests under `app/src/ingestion/__tests__/`, `app/src/admin/__tests__/`

## Verification

From `app/` (Cursor Cloud, 2026-10-13):

- `npm run typecheck` → pass
- `npm test` → pass (4429 tests)
- `npm run lint` → not run (repo-wide deno lint baseline unrelated to this slice)
- `npm run build` → N/A (Coolify Deno app; no `build` script in `app/package.json`)

Manual (prod, after deploy + migrate):

- Confirm `st_peer_prices` stall detail lists pending ticker samples when it fires.
- `POST /api/admin/securities/JUNK/price-unavailable` with `{ "reason": "…" }` sets `price_unavailable` and drops the ticker from pending counts.

## Follow-ups

- None required; operators can clear a mistaken mark by importing fresh closes or pricing via the daily refresh.
