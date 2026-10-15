# CT-2408 verification — `st_peer_prices` stall (2 tickers)

## Issue (Linear CT-2408)

Production `pipeline.stalled` on stage `st_peer_prices` reported ~23.6h without
`price_checked_at` progress (6h threshold) with **two tickers** that never
received EOD prices.  Early theories (rotated `APP_B_INGEST_TOKEN`, upstream
Socratic outage) were ruled out by recovery timing and provider health; fleet
recall re-scoped the root cause to **backlog tickers pinning the stall
predicate**, including `COMPETITOR-*` synthetic inject rows that must not drive
the price lane.

## Verdict

**Already fixed on `main` by merged PRs #2724, #2726, and #2738** (tail-backlog
stall suppression + shared `peerPricePending` SQL aligned with the price refresh
selector).  **No further application code is required for CT-2408**; this report
is the documentation closeout only.

## What #2724 fixed (`st_peer_prices`)

- Pending set only: stall progress uses `MAX(price_checked_at)` over tickers
  that still need prices (`latest_price_date` or `price_checked_at` missing),
  not over the whole `securities_ref` table.
- Tickers with `price_unavailable` are excluded from the pending set.
- Never-checked pending tickers do not count as “idle progress” (no false stall
  on brand-new backlog rows).
- Alert detail includes a pending ticker sample (up to 10 symbols).
- `markTickerPriceUnavailable()` negative-caches confirmed unpriceable symbols;
  admin `POST /api/admin/securities/:ticker/price-unavailable` for operators.

Rollout: `docs/rollouts/2026-10-13-st-peer-prices-stall-fix.md`.

## What #2726 added (fixture hygiene + enrichment parity)

- `excludeCompetitorFixtureTransactionSql()` on `st_peer_prices` and price
  selection so `doc_id LIKE 'COMPETITOR-%'` rows do not count as pending.
- `tickerHasNonCompetitorFixtureTrade()` guard on
  `markTickerPriceUnavailable()` so **fixture-only** symbols (e.g. a lone
  `COMPETITOR-*` row) are **not** auto-marked unpriceable unless `force: true`.
  Real symbols such as **BHI** stay priceable when a non-fixture disclosure row
  exists (covered by `competitorFixtures.test.ts`).

## Regression tests (Cursor Cloud, 2026-10-15)

From `app/`:

- `npm test -- src/ingestion/__tests__/stPeerPricesStall.test.ts src/shared/__tests__/competitorFixtures.test.ts` → pass (10 tests).

## What #2738 added (tail backlog, same ticket)

- `app/src/prices/peerPricePending.ts` — shared pending predicate with
  `selectTickersNeedingPrices` / stall detector.
- Suppresses `st_peer_prices` stall when the corpus EOD is current through
  `lastTradingDay` and at most five tail tickers remain (permanent junk / FIFO
  tail without paging the whole fleet).

Rollout: `docs/rollouts/2026-10-15-st-peer-prices-tail-stall.md`.

## Overlap / scope

- Held iOS/pricing PRs **#2614–#2619** were not touched.
- **#2735** (schema startup migrate for `price_unavailable_reason`) is deploy
  hygiene, not stall-logic (merged separately on `main`).

## Post-deploy expectation

After production runs a SHA containing #2724/#2726 (and migrate **0103** applied),
the two fixture-only singletons should **drop out of the pending set**; any
remaining stall should reflect real backlog idle time, not synthetic COMPETITOR
rows or global `MAX(price_checked_at)` skew.

## Optional follow-up (out of scope for this ticket)

Fleet lessons note a **calendar-aware** stall window (daily EOD cadence vs flat 6h)
as a separate improvement; #2726 rollout explicitly kept `st_peer_prices` on the
general **6h** default once fixtures are excluded.  Track separately if paging
noise persists on trading days with an empty pending set.
