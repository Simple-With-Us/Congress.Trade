# 2026-10-15 — Peer price writes survive a missing migrate

Board CT-2409.  Branch `cursor/st-peer-prices-missing-column-5f2c`.

## Summary

The 2026-10-15T08:42Z `pipeline.stalled` alert on `st_peer_prices` was a real write failure, not a false stall and not an Socratic.Trade outage.  #2724 started writing `securities_ref.price_unavailable_reason`.  The ALTER is already in `POST /api/admin/migrate` and in `app/migrations/0103_price_unavailable_reason.sql`, but Coolify rebuilds the container on push to `main` and does not run that route.  The host SQLite file never gained the column.

The daily market-data lane at 00:07Z on 2026-10-14 and 2026-10-15 threw `no such column: price_unavailable_reason` before any ticker `price_checked_at` update, then stamped the UTC day anyway.  The next retry waited until the following midnight.  SPX is written earlier in the same function, so `spx_eod` reached 2026-10-14 while ticker `latest_price_date` stayed 2026-10-13.  About 2084 pending names, including AAPL, A, and AA, are that stale corpus.  The #2738 tail suppressor (at most 5 never-priced tickers) does not cover it.

ST `/api/health` stayed ok.  `dependencies.congress-share` is `{ok:false}` because ST's push into `POST /api/admin/securities/import` is rejected for the same missing column (and, separately, `fundamentals_eod.received_at` from migration 0101).  `APP_B_INGEST_TOKEN` is working: the SPX pull succeeded.  This is not FIFO starvation and not the CT-2408 two-ticker false alarm.

## Files changed

- `app/src/admin/ensurePeerSchema.ts` — idempotent ALTER for the price column, the enrichment negative-cache columns, and `received_at`.  Duplicate-column errors are success.
- `app/src/prices/service.ts` — apply the price column before the ticker INSERT and before a negative-cache write.  An aborted lane signal stops the ticker loop.
- `app/src/admin/routes.ts` — apply the import columns at the start of `POST /securities/import`.
- `app/src/prices/peerPriceCatchUp.ts` and `app/src/jobs.ts` — do not stamp the market-data lane when price refresh throws or aborts.  If the day is already stamped and the corpus is behind `lastTradingDay`, or the pending set is larger than the tail, retry prices only.

No new migration file.  The statements are already in 0101, 0103, 0104, and the admin migrate list.  Open #2735 (startup migrate) is complementary and was not edited.  Open #2748 was not edited.

## Verification

```bash
cd app && npm run typecheck && npm test
```

2026-10-15: `deno check src/deno/main.ts` passed.  `npm test` passed, 349 files, 4502 tests.

Production evidence (Datadog, us5, query `no column named`, 3 days): the price-refresh warning at 2026-10-14T00:07:03Z and 2026-10-15T00:07:02Z, and 1693 congress-share import errors with the same column name.

After this deploys, the next market-data tick (`7 * * * *`) runs the ALTER inside the process and refreshes prices.  `bash app/scripts/ship.sh` is not required for the column to appear.  This change does not call production migrate.

## Follow-ups

- #2735 can still land a startup migrate so other new columns do not depend on a write-path guard.
- Today's lane stamp is already set.  The catch-up path is what unblocks 2026-10-15 without waiting for 2026-10-16T00:07Z.  A finished catch-up stamps its own day key, so a weekday holiday (which `lastTradingDay` does not model) cannot re-walk the universe every hour.  An aborted or thrown catch-up leaves that key unset.  The catch-up also honors the D1 row budget.
- Do not requeue Senate DLQ `50e7996f` or touch quarantined deliveries.
