# 2026-09-18 — ticker-less trades, OGE row numbers, price freshness (board rows 16b46688, 3d31c7b9, 6c05e09b)

## Summary

Three P1 data-integrity rows in the published disclosure data, fixed at the root cause.

- **16b46688 — 32.6% of trades carry no ticker.**  The extractor is faithful (the House scanned form says "Provide full name, not ticker symbol").  The gap was the name to ticker resolver: it matched through `simplifyCompanyName`, which keeps broker share descriptors and fuses `Corp.CMN` into one token, so `Uber Technologies Inc. CMN` never met `Uber Technologies, Inc.`.  New `enrichment/nameTickerBackfill.ts` normalizes both sides (legal forms, CMN/COM/Common Stock, "the", parentheticals, punctuation splits tokens) and resolves only on a unique match.  It is wired into `buildResolver` for rows with NO ticker, so new filings resolve at extraction time, and the existing `runTickerBackfill` (daily cron + `POST /api/admin/resolve-tickers`) now resolves stored rows.
- **3d31c7b9 — OGE asset names carry the 278-T "#" column.**  Trump's 278-T runs past row 3600, so the index is four digits: the text-layer parser's `\d{1,3}` row anchor could not even match those rows, and the scanned path keeps the index in `assetName`.
- **6c05e09b — excess legs use different as-of dates and the price cache is stale with no as-of shown.**  `spx_now` was one global "latest S&P close" joined to each ticker's own price date.

## Files changed

- `app/src/enrichment/nameTickerBackfill.ts` (new), `app/src/extraction/normalizer.ts` (`buildResolver` takes an issuer index; `recomputeTransactions` strips the executive row index)
- `app/src/extraction/ogeRowIndex.ts` (new), `ogeText.ts` (`\d{1,5}`), `extractRouting.ts` (boilerplate rows)
- `app/src/admin/ogeRowIndexCleanup.ts` (new) and `POST /api/admin/clean-oge-row-numbers`
- `app/src/admin/routes.ts` (`runTickerBackfill` cursor mode, `?after=`), `app/src/jobs.ts` (daily cursor in CONFIG_KV)
- `app/src/analytics/builders.ts`, `compute.ts`, `routes.ts`, `app/src/client/routes.ts` (aligned exit legs, `pricesAsOf`, equity-like coverage)
- `app/src/shared/pipelineHealth.ts` (`price_freshness`), `app/src/ui/dashboardHtml.ts` ("Prices as of")

## How existing published rows are affected

1. **Ticker-less rows (16b46688).**  Nothing changes at deploy.  The daily filer lane now pages `runTickerBackfill` by id (5000 rows/day, cursor in `CONFIG_KV` key `jobs:ticker-backfill:cursor`, wraps at the end); until now it re-read the same lowest 5000 ids forever, and most ticker-less rows (bonds, funds, private assets) never resolve, so the resolvable tail was never reached.  Each resolved row gets `ticker` and a recomputed `row_key`, exactly as the existing job does.  Only rows with NO ticker are touched; a bond, preferred, fund, option or coupon description never resolves; an ambiguous name never resolves; a "Class C" description never inherits the Class A ticker.  To backfill faster: `POST /api/admin/resolve-tickers?after=&limit=5000`, then repeat with `after=<lastId>` from the response.  Expected effect on the live example: Ro Khanna H-2026-9116267 (95 of the first 100 July rows had ticker=null) resolves the large caps (UBER, KO, CMCSA, MSFT, V, TSLA, T, HD, SBUX, CHWY, NVDA, AMZN, META).
2. **OGE rows (3d31c7b9).**  Forward: rows extracted after deploy are clean.  Stored rows: `POST /api/admin/clean-oge-row-numbers` is a **dry run by default** (`?dryRun=0` writes; `?limit=` caps filings per call).  It strips the leading number per filing only when that filing's own rows show the "#" column, re-resolves tickers over the cleaned name, recomputes `row_key`, never touches `raw_text`, and skips (and counts) any row whose cleaned `row_key` would collide.  It is not scheduled: run the dry run, read `sample`, then apply.
3. **Prices (6c05e09b).**  `spx_now` is now the S&P close on or before each ticker's own `current_price_date`, so every "excess vs S&P" figure changes by the S&P move over each ticker's staleness gap (for NVDA priced 2026-07-24 against a 2026-08-03 S&P bar that is +1.25 points of benchmark drift removed).  Cached analytics responses refresh within their TTL (15 min).  No stored rows change.
4. **Coverage metric.**  `/api/analytics/summary` `resolvedEquityTickerPct` now uses an equity-like denominator (`public_equity` plus still-`unknown` types), so the ticker-less rows stay visible; the old public-equity-only figure is kept as `resolvedPublicEquityTickerPct`, and `equityLikeTradeCount` is added.  Nothing in the web or iOS clients read `resolvedEquityTickerPct`.

## Verification

- Local: full `vitest run` 316 files / 4022 tests green; changed files clean under `tsc` (remaining errors are pre-existing ambient-type noise).
- Real names: the Khanna July asset descriptions resolve against a securities_ref-shaped index built from the live `/api/assets` roster (16 of 18 sampled resolve, including Alphabet Class A to GOOGL and Class C to GOOG; the two nulls are intended: GE HealthCare is ambiguous with its when-issued line, and the JPM perpetual is a bond).
- After deploy: `GET /api/health` `pipeline.checks` must list `price_freshness`; expect `degraded` until the price cache is repaired (see below).

## Follow-ups (not fixed here)

- **Why prices froze (needs host and Socratic.Trade access).**  Unverified hypothesis from the code: prices come from the Socratic.Trade peer (`PRICE_PROVIDER=peer`, `prices/service.ts:118-170`), and a peer 401/402/403 is rethrown on purpose without falling back to Massive, so a rotated or invalid `APP_B_INGEST_TOKEN` or a peer outage silently stops ingestion.  Check with `POST /api/admin/refresh-prices?dryRun=1&max=5` and read `errors` and `aborted`.
- `price_freshness` is deliberately NOT in `LIVENESS_ALARM_CHECK_IDS`: paging on deploy for a known-stale cache is noise.  Add it once prices are flowing so the next freeze pages.
- iOS: `pricesAsOf` is on `/api/analytics/member-performance`, `/api/analytics/member/:id/performance`, `/api/analytics/performance/:txId` and the client member `performance` object; the Swift views do not print it yet (needs an xcodebuild and simulator pass).  The ticker sheet still shows a price with no date.
- The OCR damage in OGE names ("Mota Plalfonns", "Tempus Al", cut-off names) is not fixable deterministically; only the row number is handled.
