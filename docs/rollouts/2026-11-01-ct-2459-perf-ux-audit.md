# CT-2459 — Full-stack performance + UI/UX audit and fix sweep

Date: 2026-11-01
Seat: MC (Muse Code).  Lane: muse-code/perf-ux-audit.

## Summary

Owner asked for a top-to-bottom audit of the web app, the iOS client and the Deno backend, plus fixes for every finding that can be remedied in code.  The fleet workflow fanned out six read-only auditors (web perf, UX/a11y, backend hot paths, DB/queue/jobs, iOS, build/CI/deps), then an adversarial critic re-opened every P1 citation.  27 of 28 P1s survived; one (backtest full-table reads) was downgraded to P3 and still fixed.  Everything below landed with focused tests.  Items needing an owner decision are listed under Follow-ups and were deliberately not coded.

## What shipped (by batch)

1. Build/CI.  Pinned the Deno image, manifest-first Docker layer, explicit COPY allowlist + .dockerignore, CI npm/deno caches, coverage only on main pushes, gitleaks diff-depth fallback, denoland setup action (the raw curl installer wrote outside $HOME on hosted runners), deno.json aligned up to package.json versions, both lockfiles regenerated.  Later in the same lane: deno install --frozen now passes and is enforced in the Dockerfile.
2. Backend shared paths. kvCache gained a per-binding memory tier + singleflight; d1Budget flushes at most every 30s or 10k rows (was a DB write per read request); botDefense caches the guard flag 60s per binding and memoizes IP hashes; /api/* skips RUM/Sentry CSP resolution; session token-to-userId cached 30s with logout invalidation (the User row still loads fresh).
3. Delivery.  One 60s singleflight pipeline-health cache serves all four health endpoints (three were uncached 30+-probe scans).  Premium CSV export pre-counts and streams 1k-row batches instead of materializing ~3 copies; the uncapped full-match-set rule is unchanged.  Count-pairs and the market bundle parallelized.
4. Analytics + client API.  Member performance uses a materialized price CTE and a buys-only SQL filter (output-identical).  Backtest series are bounded to the cohort window; pricedDays keeps full-coverage meaning via COUNT. /performance/:txId cached 600s. /conflicts pages candidates.  Client API sends public Cache-Control (feed 15s, detail 300s; never on account routes) — the server half of the iOS URLCache pair.  Client member performance block cached 600s; resolveMember memoized 5 minutes.
5. Queue.  Aborted drains release claimed-but-unstarted rows immediately (was stranded until lease expiry); exponential retries got full jitter; handler delaySeconds clamped to 3600s; 15-minute priority aging; ingest/delivery drains interleave; lease-guarded binding proxies memoized.
6. Tick/lanes.  Tick singleton TTL follows CT_TICK_DEADLINE_MS + 30s.  Daily write lanes fail closed on lock errors and hold the singleton grace-bounded while a zombie lane settles (counted).  The eligibleReview idle probe caches positives for 5 minutes.  Retention budget check now precedes the day stamp; the 5-year sweep uses two indexed branches and one atomic batch.  Outbox flushes bulk-claim, sendBatch, and bulk-complete.
7. Web.  Served JS minified at build (558 KB/157 KB gz to 379 KB/105 KB gz, identifiers preserved + build-time global assertion); served CSS minified at module load (205 KB to 128 KB); ETag/304 on text and binary assets.  Header logo is 920w lossless WebP (161 KB to 43 KB) with fetchpriority; Inter 400/600 preloaded; 512 icon is manifest-only.  Skip link + per-view visually-hidden h1; roving tabindex + Arrow/Home/End completes the tablist; dark sell lightened to WCAG AA incl. tints with new regression cases; 3:1 control borders; visible focus on tips, chart columns and info buttons; reduced-motion and coarse-pointer rules; micro-type floor.  The feed renders only the visible layout (table XOR cards).  Trends sections load near the viewport.  The drawer keeps its accessible name; menus and popovers manage focus; delivery errors focus the URL field.  OG delivery copy now says webhook + SSE; the sitemap adds trends, pricing and the legal pages.
8/9. iOS.  Trends fan-out publishes through one TrendsSnapshot (was ~13 objectWillChange waves).  The feed @Query is cursor-sorted and the sort+filter is memoized behind a signature task.  A shared downsampling image cache (20 MB NSCache) replaces bare AsyncImage; relative photo URLs resolve against the site origin.  Members loads coalesce.  Cold launch sequences Trends before the feed fetch.  TrendsView is a LazyVStack with redacted skeletons; formatters hoisted; FilterChip hits 44pt; MetricTile stops shrinking at accessibility sizes.  The widget sends the Safari UA pair; Trader.id is a stable FNV hash; requested-image cache policy is fail-closed per endpoint class.  Brand assets right-sized; unused ZillaSlab-Bold dropped.
10. Deps. pdf-lib, @google/genai and unpdf are dynamic-imported at first extraction use.  The Senate scraper moved from cheerio to node-html-parser; cheerio and the unused @sentry/cloudflare are gone.  Dead postdeploy and wrangler migrate scripts removed (production migrate stays POST /api/admin/migrate per AGENTS.md).

## Files changed

Commissioned in 8 commits on the lane; see git log for the per-batch file lists.  Highest-blast-radius files: app/src/ui/client/dashboard.js (+ regenerated dashboardClient.ts), app/src/ui/dashboardHtml.ts, app/src/ui/dashboardStyles.ts, app/src/deno/durableQueue.ts, app/src/delivery/rest.ts, app/src/jobs.ts, clients/ios/CongressTrade/Store/CongressTradeStore.swift.

## Verification

- cd app && DENO_DIR=/tmp/ct-deno-cache npm run typecheck — clean.
- cd app && npm test — 387 files, 5278 tests, all passed.
- npm run check:client — dashboardClient.ts in sync, eslint clean.
- New/updated focused tests: pipelineHealthCache, kvCacheTier, d1Budget throttle, queue abort-release + jitter/clamp, minifyCss + minified-JS parse/globals, semantic dark AA cases, backtest bound via existing ticker fixtures, filingRetention + outbox fakes updated for bulk-claim SQL.
- iOS: xcodebuild build and build-for-testing both SUCCEEDED.  Unit tests could not execute locally (this Mac has no simulator runtime); CI macos-latest is the execution gate.  New Trader/photo tests are compile-verified only.
- One pre-existing failure was re-verified on the untouched base: extraction normalizer timeout reproduces at 5d27aa20 without this lane's changes.  It passed in the final full-suite run.

## Follow-ups (owner-gated, not coded)

- sqlite: second read connection + cache_size/mmap PRAGMAs (P1 ceiling; Litestream/WAL implications).
- Schema: queue priority generated column + partial claim index; migrate version stamp (skip the ~1,817-statement POST /api/admin/migrate replay — needs its own lane).
- Prod data: one-time VACUUM after measuring freelist headroom; new retention policies for webhook_deliveries and metric tables; tick lane reordering (ingest before delivery dispatch).
- Remove .prod.vars from the Docker image; untrack app/vendor node_modules.
- Web residuals: dashboard.js code-splitting (single-file constraint), script defer (needs live click-through verification), eagle-splash.webp removal (verify external references first), lazy export libs inside the client bundle.
