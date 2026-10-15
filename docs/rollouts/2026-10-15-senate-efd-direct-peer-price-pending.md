# Senate eFD direct egress + peer price pending alignment

## Summary

CT-2361: Senate PTR discovery no longer implicitly routes through the dead GL.iNet Mango default (`10.99.0.2:8888`).  The watcher tries direct datacenter egress with bounded backoff, then only an **explicit** `RESIDENTIAL_PROXY_URL` / `SENATE_PROXY_URL`.  A cached direct `GET /search/` probe (`senate_efd` on `/api/health`) runs each watcher tick.

CT-2408: `selectTickersNeedingPrices` and the `st_peer_prices` stall detector now share `buildPeerPricePendingSql`, and tickers with a fresh-looking `latest_price_date` but **no** `price_eod` rows are re-selected for pricing (regression test added).  #2724/#2726 addressed stall false positives; this closes the metadata-without-EOD gap.

No dead-letter queue requeue was performed.

## Files changed

- `app/src/ingestion/senateSource.ts` — direct-first egress with backoff
- `app/src/ingestion/senateEfdHealth.ts` — probe + KV cache
- `app/src/ingestion/watcher.ts` — refresh probe each tick
- `app/src/shared/pipelineHealth.ts` — `senate_efd` check
- `app/src/deno/main.ts` — do not inject Mango default into runtime env
- `app/src/prices/peerPricePending.ts`, `service.ts`, `pipelineLoudAlerts.ts`
- Tests under `app/src/ingestion/__tests__/`, `app/src/prices/__tests__/`

## Verification

From `app/`:

- `npm run typecheck`
- `npm test`

After deploy: `/api/health` should include `senate_efd` with a recent direct probe; Senate polling should succeed without a live Mango proxy when datacenter egress is accepted.

## Follow-ups

- Enable Agent-Sync Linear tools for the CURSOR seat to claim/post on CT-2361 / CT-2408 from cloud agents.
