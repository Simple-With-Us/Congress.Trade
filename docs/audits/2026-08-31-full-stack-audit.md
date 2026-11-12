# Congress.Trade Full-Stack Audit — 2026-08-31

Read-only team audit of web (phone / tablet / laptop / desktop / ultrawide), iOS, and backend.  Seven specialist agents plus live production probes.  No product-code edits in this lane.

- **Live SHA:** `c2fd4ded` (`https://congress.trade/api/health` at 5:22pm CT)
- **Code base:** `origin/main` worktree `~/apps/congress-grok-build-audit` @ `grok-build/full-stack-audit`
- **Board:** `f74642d0`
- **Prior review this re-checks:** Cursor 2026-08-23 (`#2180`–`#2187`) and Kimi 2026-08-21 P0s
- **Seat:** GROK-BUILD
- **Landed:** 2026-09-05 by CLAUDE, picked up after GROK hit its usage cap with this report staged but never committed.  **Ranked item #1 (`debug-sql`) is already fixed** — PR #2318 gates the route to fail closed in production.  Everything else below is still open as described.

Two spaces between sentences in this file.

## Live snapshot (Mon, Aug 31, 2026 at 5:22 PM CT)

| Probe | Result |
|---|---|
| `GET /api/health` | HTTP 200, `ok/db/schema` true, `status: degraded` |
| Senate relay | Live at `scout.jays.services` |
| Home HTML | 200 in 0.75s, **762 KB** document |
| Polling | House 1m, Senate 5m, Executive 13m — all ok |
| Review queue | 0 unresolved |
| Data freshness | Latest transaction 2h ago |
| Dead letter | **81** ingestion outbox items (`ingestion_dead_letter`) |
| Ticker resolve (90d) | `resolvedTickerPct` **36.9%**; `resolvedEquityTickerPct` **90.7%** |
| Open product PRs | **0** |
| App Store | 1.0.81 previously REJECTED (2.1a/b); 1.0.177 resubmit claimed WAITING_FOR_REVIEW — not re-polled from ASC in this session |

`/api/health` staying HTTP 200 while `pipeline.status === "degraded"` is itself a finding.  Coolify/UptimeRobot-on-status-code will not page the 81 dead letters.

## Executive verdict

The money-path App Store P0s from August 23 are **fixed in code** (Apple webhook mount, REFUND/livemode, delivery secret claim, iOS Filing PDF no longer Stripe-paywalls, account deletion).  The product is **not** in a "everything is on fire" state: polling is live, review queue is empty, schema is applied, Senate relay is up.

What is still wrong is concentrated in five buckets:

1. **Data trust.**  Public "latest" is ingest cursor, not trade date.  Manual review can publish 1 of N rows.  Cross-filer twins still leak.  OGE names still carry row numbers and OCR junk.  Backfills can still fire as "new" webhooks.
2. **Ops blast radius.**  Coolify compose still stop-then-starts the only container.  `POST /api/admin/debug-sql` still runs arbitrary SQL in production behind admin auth.  Litestream can fail open.  KV is unreplicated.  81 DLQ items sit while health is HTTP 200.
3. **Ingest handoff holes.**  Provider-seed upgrades can leave a filing at `new` with no outbox.  Seed rows can block official extract.  Status-then-enqueue races strand docs at `classified`.
4. **Web/iOS product UX.**  Browser Back is broken.  Checkout intent is dropped on Sign In.  Tablet breakpoint split.  PWA chrome is dark.  iOS Universal Links are not in entitlements.  Push is sold as Premium and enforced as sign-in-only.
5. **Copy accuracy.**  Several public strings still say Congress-only while the corpus is House, Senate, **and** Executive (OGE 278-T).

Do not re-open the August 23 money-path P0s as if they were still broken.  They are not.

## Ranked next work (do these, in this order)

| # | Sev | Slice | Why first |
|---|---|---|---|
| 1 | P0 | Remove or hard-gate `POST /api/admin/debug-sql` | Stolen admin session = full SQLite.  New finding. |
| 2 | P0 | Default public feed `order=desc` by trade or discovery date, not `cursor_seq` | `#2180` / `a8ac1f29`.  API/RSS/iOS unwindowed "latest" still lie. |
| 3 | P0 | Finish Coolify zero-downtime (host overlap **installed**, not just coded) | `01e4e870`.  Docs-only merges still 502 the site. |
| 4 | P0 | Manual-confirm under-transcription guard (N-of-M / page-count) | `3a1622e2`.  Kupor Jan 9 still 1 of 3 live. |
| 5 | P1 | Provider-seed upgrade must write ingestion outbox | Official Senate PDF never fetched after FMP seed. |
| 6 | P1 | Drain / classify the 81 dead-letter outbox rows | Health is degraded for a real backlog, not a probe flake. |
| 7 | P1 | Billing routes: `getCurrentUserFromRequest` (Bearer sessions) | Native leftover `/billing/*` can 401 after a paid StoreKit confirm. |
| 8 | P1 | SSE re-check Premium on the 60s loop | Webhooks already stop on lapse; SSE does not. |
| 9 | P1 | Web: persist checkout intent across Sign In; `pushState` for tabs | Highest-intent conversion + Back button. |
| 10 | P1 | iOS Associated Domains + push Premium truth + corpus copy | Universal Links stay in Safari; marketing contradicts gates. |

Owner product (not a defect): Options & Kalshi account separation (`#2248` / `37bdf975`) is a planned feature.  Do not treat it as a bug.

## What August 23 got wrong / is now fixed

Re-verified against current `main` and live SHA `c2fd4ded`.

| Board | Title | Verdict |
|---|---|---|
| `8932ea1f` | Apple REFUND / Sandbox / Stripe livemode | **FIXED** |
| `02c39e28` | Apple webhook only mounted in one runtime | **FIXED** (live POST `/api/webhooks/apple` is 400, not 404) |
| `12962ecb` | One-time delivery secret never shown | **FIXED** |
| `53548457` | iOS Filing PDF → web Stripe | **FIXED** |
| `b0acf6ae` | No account-deletion path | **FIXED** (`POST /auth/account/delete`; this audit's naive `/api/account` 404s are the wrong path) |
| `d2ed52ed` | competitor_backfill fabricated $1,001–$15,000 | **FIXED** on publish path (API ships null bands) |
| `a8360038` | Trades `<tr>` re-roled to button | **FIXED** (Directory headers still leftover) |
| `14fbafea` | shared-dep auto-merge `pull_request_target` | **FIXED** |
| `c3fb117a` / `#2181` | Latency probes paging retired Quiver/UW | **MITIGATED** (#2262; FMP live, retired not paged) |
| `77105be4` | Same trade 2–3× | **PARTIAL** (same-filer twins collapse; MANUAL-* phantom filers still leak) |
| `f6ec22d0` | 34 secrets in git history | **PARTIAL** (working tree clean; rotation completeness not proven from repo) |
| `a8ac1f29` | `order=desc` = ingest cursor | **STILL REAL** |
| `3a1622e2` | Manual confirm 1 of 3 | **STILL REAL** (Kupor `E-2026-scott-a-kupor-01-09-2026-278t` still 1 tx) |
| `01e4e870` | Merge = site down | **STILL REAL** (mechanism) |
| `1d412c9b` | ~80 DLQ | **STILL REAL** (live **81**) |
| `b82ef6d1` | `resolvedTickerPct` ~34% | **STILL REAL** (live **36.9%**; equity-only 90.7% is the honest split) |
| `760dd476` | No delivery freshness gate | **STILL REAL** |
| `3d31c7b9` | OGE asset names OCR / row numbers | **STILL REAL** |
| `341d17d2` | iOS search swapped for "Updating…" | **STILL REAL** (intentional 2026-08-14 behavior, still a UX defect) |
| `f02b2f8c` | Cron >45s | **PARTIAL** (code default still 45s; paid profile may override) |

## Web (all sizes)

Primary surface: `app/src/ui/dashboardHtml.ts` (~13k-line inlined app).  Light default boot is correct.  All Assets dropdown is gone.  Latency copy uses earlier/later, not `+/-`.

### Bugs

- **P1** Column sorts for Amount / Type / Politician / Asset only reorder the **current page**.  Headers imply corpus-wide sort (`dashboardHtml.ts` `setSort` vs registry).
- **P1** Every URL update is `history.replaceState`.  No `popstate`.  Browser Back never restores tabs, filters, or drawers.
- **P1** Start Free Trial → Sign In drops checkout intent.  After `login=ok` the dashboard toasts and does not reopen pricing.
- **P1** Delivery copy tells webhook consumers to dedupe on `docId`.  Contract is `X-Subscription-Id` + `X-Tx-Id`.  Multi-trade filings would drop trades 2…N.
- **P1** Pager "Page N of M" uses uncapped corpus page count while Last is capped (freemium).
- **P2** Client re-filters an already server-filtered page (`renderTrades` + `makeTradesFilterMatcher`).  Shown count can disagree with "N matching".
- **P2** `#2187` still live: unauthenticated `GET /api/stream` returns **400**.

### Responsive / layout

- **P1** Dual mobile cuts: **720px vs 768px**.  ~721–768px (and some iPad "desktop site" modes) get a mix of bottom dock, hamburger, and desktop account cluster.
- **P2** Every Trends fold starts `open` on phones.  First visit is a long scroll of every analytics block.
- **P2** Delivery subscriptions table has no card layout; phones horizontal-scroll a 6-column table.
- **P2** `main` max-width 1800px vs Trends 1280px.  Ultrawide chrome is uneven.
- **P2** Mobile `.section { overflow:hidden }` can clip sticky children and escaped filter menus.
- **P3** Home document is **762 KB**.  First paint is the whole dashboard, not a route split.

### A11y / theme / copy

- **P1** PWA manifest `theme_color` / `background_color` is dark `#08111f` (`assets.ts`) while product default is light.
- **P2** CSS `:root` tokens are still the dark palette; light only under `html[data-theme="light"]`.  No-JS / late script FOUC is dark.
- **P2** Directory People headers nest `role="button"` + inner `<button>`; Assets headers are bare `role="button"` `<th>`.  Trades already fixed this.
- **P2** Public copy still Congress-only in pricing ("source PDF files from Congress"), OG default, latency note, chamber tip.
- **P2** `#2185` password field not inside a form; `#2186` duplicate accessible tab names.
- **P2** Sentence gap miss: `2-week free trial. No charge today.`
- **P3** `SAVE ~17%` all-caps; "Note: Users can add…" Title Case in a note.

Verified non-issues: light boot preference, earlier/later latency, All Assets removed, Inter self-hosted, feed rows open trade-first.

## iOS native

`clients/ios/CongressTrade`.  Light default is correct (`@AppStorage` `"light"`).  No All Assets UI.  Filing PDF / CSV use in-app Premium + device entitlement.  No client scraping / admin token.

### Bugs / contract

- **P1** Associated Domains **not** in checked-in entitlements (APNs + Sign in with Apple only).  `AppDeepLink` parses `https://congress.trade/?trade=…` but without `applinks:congress.trade` those links stay in Safari.  Comment admits the Xcode capability still needs a human click.  Do not hand-edit `.entitlements`.
- **P1** Push alerts are sold as Premium (`PremiumSheet`, signed-out copy) and gated as **sign-in-only**.  Backend `register_device` is not Premium-gated; APNs fan-out checks `pushMode`, not entitlement.
- **P2** Politician sheet fetches Trading Summary KPIs and never renders them.  Ticker sheet does.
- **P2** Stores are still `ObservableObject` / `@StateObject` despite project rule `@Observable` (and `CLAUDE.md` claiming the store already is).
- **P2** Nested `NavigationStack` inside Trade / Politician / Ticker sheets.  Back/dismiss is easy to confuse, worse on iPad.
- **P3** Dead `AssetClassFilter` still encodes banned "All Assets" / "Public Equities" labels and is wired to feed/export with no UI.

### Copy / a11y

- **P1** Premium: "filing PDF from Congress".  Footer names STOCK Act only.  Ticker sections: "Congressional Sentiment".  Corpus includes OGE 278-T.
- **P2** No `SENTENCE_GAP` helper.  Multi-sentence strings in Delivery, Feed, Trade detail, Trends still single-space.
- **P2** Hard `UIFont` sizes (9pt, 40pt avatars) ignore Dynamic Type in spots.
- **P3** Export section `"Date range"` should be `"Date Range"`.
- **P1 leftover** Search field is replaced by "Updating results…" and keyboard is dismissed (`341d17d2`).  Still true.

ASC: 2.1(a)/(b) login busy + IAP error copy had a 1.0.177 resubmit.  StoreKit `purchase()` / `AppStore.sync` / finish-order have **no XCTest** (HTTP redeem only).  That remains the App Store regression hole.

## Backend — API, auth, billing

Solid (do not re-fix): admin fail-closed in prod env markers; delivery unique `(subscription_id, tx_id)` + CAS claim; transactions unique `(doc_id, source, row_key)` + `INSERT OR IGNORE`; create-subscription Premium-gated; Stripe/Apple webhook ledgers; Apple revoke tombstones.

### New / still-open

- **P1** `/billing/*` uses cookie-only `getCurrentUser`.  Client API / delivery / PDF use `getCurrentUserFromRequest` (cookie **or** Bearer).  Native leftover confirm / status can look anonymous after a paid purchase.
- **P1** SSE checks Premium once at open, then only `subscriptions.active` for ~25 min.  Webhooks stop on lapse; SSE does not.
- **P2** Client `update_subscription` allows filter/targetUrl patches while lapsed; REST does not.
- **P2** `claimDelivery` treats missing `meta.changes` as `?? 1` (success).  Client reclaim correctly uses `?? 0`.
- **P2** Apple `billing_retry` (DID_FAIL_TO_RENEW without grace) denies access even if `expiresDate` is still in the future.
- **P2** Bootstrap advertises `webhooks: Boolean(user)` with no Premium bit.  Create then 402s.
- **P3** `start_checkout` / `request_export` accepted then always 501.
- **P3** Rate limiter fails open on KV errors, including Premium CSV.
- **P3** `mountApiRouters` swallows constructor throws (`console.warn` only), including billing/webhooks.
- **P3** Public `/api/health/deep` returns provider diagnostics + LLM spend unauthenticated.

Account deletion **does** exist: `auth/deleteAccount.ts`, client `delete_account`, iOS Settings.  Board `b0acf6ae` should move to completed once a human confirms ASC 5.1.1(v) video is attached (effort log says it is).

## Ingestion / extraction / queues

Polling House/Senate/Executive is live.  Review queue 0.  That is not the same as "pipeline is healthy."

- **P1 NEW** FMP `provider_seeded` → `'new'` upgrade does **not** insert `ingestion_outbox`.  `ingestionOutboxInsertForDoc` only selects `ingest_status = 'new'` *before* the upgrade.  Official Senate discovery can sit at `'new'` with no durable `filing.new` until the 10-day stranded sweep errors it.  (`watcher.ts` ~344–467, `outbox.ts` ~36–63)
- **P1 NEW** `docHasExistingTransactions` is `SELECT 1 FROM transactions WHERE doc_id = ?` with no source filter.  FMP seed rows (`source='seed_dataset'`) make the orchestrator treat the doc as already extracted and **ACK without throwing**.  Official parse never runs.
- **P1 NEW** `filing.local_wait_check` flips to `classified` then sends `filing.extracted`.  If send throws, retry no-ops because status is already `classified`.  Same class in `autonomySweeps` (try/catch warn).
- **P1** Orchestrator silently ACKs on per-doc LLM ceiling.  Filing stays `classified` with no terminal error until stranded sweep.
- **P2** House live-search discoveries omit `filed_date` until ZIP heal (72h autonomy).  Same-day STOCK Act lag is wrong for the hottest chamber path.
- **P2** OGE watch is fail-closed unless `OGE_WATCH_ENABLED` is truthy.  Easy to market Executive while discovery is off.
- **P2** Quiet-tick outbox probe stale = 15m; flush reclaim = 2h.  Operators misread "pending work."
- **P2** Senate filer identity skips without `state` → duplicate `senate-*` filers.
- **P1 live** 81 dead-letter outbox items.  Health check is honest; nobody is draining them.
- **P1 still** Delivery flushes every newly inserted tx with no age/freshness gate (`760dd476`).  A 2023 backfill is a "new" webhook.

## Security / reliability / perf / ops

### Security

- **P0 NEW** `POST /api/admin/debug-sql` (`admin/routes.ts` ~9058–9072) comment says "Development ONLY" and has **no prod/env guard**.  `all(c.env.DB, query, params)` runs caller SQL behind full admin.  Combined with `script-src 'unsafe-inline'` and allowlisted-session admin, XSS becomes arbitrary SQL.
- **P1** CSP `'unsafe-inline'` + cookie session = admin.  Fix: nonce CSP; step-up / bearer for mutating admin; delete debug-sql.
- **P2** `INFISICAL_ALLOW_ENV_FALLBACK` defaults on.  Stale Coolify env can shadow a rotated Infisical secret.
- **P2** `app/get_turso.ts` still `console.log`s Infisical `TURSO_*` values if run.  Delete it.
- **P2** Public rate limits fail open; `pub-api` is per-isolate memory only.

### Reliability

- **P0** Compose `container_name` + host port bind → Coolify stop-then-start.  Overlap/hold is documented, **host install still required**.  This is why docs-only merges 502 the site.
- **P1** `/api/health` HTTP 200 when `pipeline.status` is `degraded`/`stalled` as long as readiness (db/schema) is ok.  Coolify healthcheck is HTTP-only.  `/api/health/deep` *does* 503 on stall.
- **P1** Litestream start script warns and continues without replication.  `kv.sqlite` is not in `litestream.yml`.
- **P1** Single ~2GB SQLite shared by app + sqlite-web + drain.  App boot sets `busy_timeout=10000` only; no explicit `journal_mode=WAL` / `foreign_keys=ON` in app code (WAL is Litestream-implied).
- **P2** Cron tick default 45s; comment still says "Oracle container".  Paid drain of 100 msgs needs `CT_TICK_DEADLINE_MS`.  Slow tick sets `tickInFlight` and **skips the next minute**.
- **P2** Schema apply is `ship.sh` after Coolify rebuild.  New code on old schema until someone POSTs migrate.

### Docs drift that can still cause a wrong action

Hot-path AGENTS / README / DEPLOY current-shape paragraphs are correct (Coolify Deno + host SQLite).  Leftovers that still teach the wrong world:

- `app/DEPLOY.md` local migrate via `wrangler d1`
- `app/package.json` `migrate` script → wrangler
- `.github/workflows/deploy-oracle.yml` (name)
- `ios-build.yml` header still says self-hosted Mac (jobs are `macos-latest`)
- `app/src/admin/routes.ts` migrate comment "Worker's D1 binding"
- `app/src/deno/main.ts` "Oracle container"
- `app/get_turso.ts`, `query_turso.ts`
- Historical analysis memos arguing Deno Deploy SSE/Turso as live gaps

## Tests / coverage

Backend ~299 vitest files / ~3.8k tests.  That is strong unit/contract coverage, not E2E.

| Surface | Tested? |
|---|---|
| Stripe + Apple server webhooks | yes |
| iOS StoreKit purchase/restore/finish | **no** |
| Web browser E2E (Playwright) | **no** |
| Client commands | partial |
| `start_checkout` / `request_export` | yes, as 501 |
| Delivery webhook/SSE | yes |
| Public `order=desc` newest-trade | tests **encode** `cursor_seq` (locks the bug) |
| `not_found` DocID resurrection | thin |
| Provider-seed → outbox | **missing** (would have caught P1 #5) |
| Billing Bearer session | **missing** |
| SSE lapse mid-stream | **missing** |
| Vision-worker Python | Mac unittest, not app CI |
| Trends vs politician-drawer estimands | partial (analytics audit still open) |

Stale GitHub issues that should be closed or commented, not re-implemented: `#2027` APNs `filers.id` join (code uses `bioguide_id`); several effort-board "IN PR" rows whose PRs already merged.

## Suggested slice plan (reviewable PRs)

Do not dump this report into one mega-PR.  Chunk:

1. **Kill `debug-sql` in prod** + nonce CSP follow-up.  Tiny, high leverage.
2. **Feed sort contract** — default `order=desc` → `tx_date` or `published` (`first_seen_at`), with a test that a 2024 backfill cannot beat a 2026 primary.  Update iOS/web callers that already send `sort=tx_date`.
3. **Ingest handoff trio** — seed upgrade outbox, `docHasExistingTransactions` ignores `seed_dataset`, status-then-enqueue compensator.
4. **Billing Bearer + SSE entitlement loop + `claimDelivery ?? 0`.**
5. **Manual confirm N-of-M guard** + Kupor Jan 9 operator repair.
6. **Web conversion + history** — checkout intent, `pushState`, webhook dedupe copy, PWA light manifest, unify 768px.
7. **iOS** — Associated Domains (Xcode UI), push copy/gate alignment, politician Trading Summary, sentence-gap sweep.  No `.pbxproj` hand-edit.
8. **Ops** — host-install Coolify overlap; `/api/health` 503 on stall **or** point Coolify/UR at `/health/deep`; Litestream fail-closed in paid; drain 81 DLQ.
9. **Copy** — House / Senate / Executive everywhere public (web pricing, OG, iOS Premium, footer).
10. **Hygiene** — delete `get_turso.ts`; close stale GH issues; delivery freshness gate for backfills.

## Method

Specialist read-only agents (web, iOS, backend API, ingest, security/ops, tests/known-issues, P0 re-verify) plus live curls against `https://congress.trade`.  Findings without file:line or a live probe were dropped.  Prior August 17 audits (`docs/audits/2026-08-17-*.md`) remain useful; this pass says what is still true on `c2fd4ded`.

This lane did not run `npm test` against product changes (none), did not open App Store Connect, did not SSH the box, and did not drain the DLQ.
