# Turso query efficiency (2026-07-24)

> **Current shape (2026-08):** Turso is retired.  Production reads a local
> SQLite file on Coolify / Hetzner (`file:/data/congress-trade/db.sqlite`).
> The query cuts below still apply; do not open a Turso dashboard.

## Summary

Turso metrics showed a small set of queries dominating rows-read and latency
without helping product throughput. This change cuts those costs while keeping
(and in the feed/SSE path, improving) end-user latency:

1. **`GET /api/admin/data-recovery/status`** no longer `COUNT(*)` /
   `COUNT(DISTINCT)` / `MAX(date)` over `price_eod` (~2.3M rows / ~526ms).
   Tickers + latest date come from indexed `securities_ref.latest_price_date`;
   row count comes from a singleton `price_eod_stats` seeded once by migrate.
2. **Feed + SSE cursor polls** apply `WHERE`/`ORDER BY`/`LIMIT` on
   `transactions` first, then join filers/filings/securities_ref — same
   results, far fewer rows read on the hot unfiltered keyset path.
3. **`securities_master` resolver** is cached in-process for 10 minutes so
   normalize/agreement stops re-reading ~10k rows per call.
4. **Migrate backfills** for `latest_price_date` skip tickers with no
   `price_eod` rows (`EXISTS` guard), and partial indexes make post-seed
   disclosure / price-anchor probes near no-ops.
5. **Deno queue claim** indexes cover `(available_at, id)` / `(lease_until, id)`
   to match `ORDER BY available_at ASC, id ASC`.

## Files changed

- `app/migrations/0043_price_backfill_termination.sql` — EXISTS guard
- `app/migrations/0058_turso_query_efficiency.sql` — new indexes + stats table
- `app/src/admin/migrations.ts` — mirror 0043/0058
- `app/src/admin/routes.ts` — status query rewrite
- `app/src/delivery/rows.ts` — nested keyset feed builder
- `app/src/delivery/sse.ts` — nested keyset drain
- `app/src/extraction/normalizer.ts` — resolver TTL cache
- tests under `app/src/admin/__tests__`, `app/src/delivery/__tests__`

## Verification

```bash
cd app && npm run typecheck && npm test
```

After deploy + `POST /api/admin/migrate`:

- Turso dashboard: `price_eod` full-table COUNT should disappear from top queries
- Feed poll rows-read for `cursor_seq > ? LIMIT 50` should drop toward ~50 + join lookups
- Re-running migrate should no longer rewrite `securities_ref.latest_price_date` for unpriceable tickers

## Follow-ups

- Keep `price_eod_stats.row_count` fresh on price writes (currently one-shot seed;
  tickers/latest_date remain exact via `securities_ref`)
- Consider KV/R2 snapshot for `securities_master` if isolate churn defeats the
  process cache
- `ingestion_outbox` poll (~113ms / 7 rows) is network-bound more than scan-bound;
  leave alone unless Turso region latency changes
