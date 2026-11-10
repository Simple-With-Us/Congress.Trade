# Congress.Trade Full-Stack Codebase & Operations Audit — 2026-09-12

Comprehensive multi-agent technical audit of the Congress.Trade platform spanning the backend services (`app/`), web single-page application (`app/src/ui/dashboardHtml.ts`), iOS SwiftUI client (`clients/ios/`), and host/cloud infrastructure operations.  Conducted by Antigravity with specialist subagent panels and live production probes.

- **Live Revision:** `7f36e3b2f615` (`https://congress.trade/api/health` at 11:52 UTC)
- **Local Branch:** `antigravity/full-stack-audit-2026-09`
- **Tracked Issues Filed:** #2364, #2365, #2366, #2367, #2368
- **Prior Audits Referenced:** Grok/Claude 2026-08-31 (`docs/audits/2026-08-31-full-stack-audit.md`), Expert Panel 2026-08-19 (`docs/reviews/2026-08-19-full-app-expert-panel-review.md`)

---

## 1. Executive Summary & Live Snapshot

### Live Production Probe Results (Sat, Sep 12, 2026 at 11:52 UTC)

| Probe / Check | Value / Result | Health Status | Findings & Operational Context |
|---|---|---|---|
| `GET /api/health` | HTTP 200 | OK | System operational; 0 unresolved review queue items; data fresh (latest trade 5h ago). |
| `costProfile` | `name: free`, `cronSchedule: "*/15 * * * *"` | **DEGRADED** | Production running in **free profile** instead of **paid profile** (`* * * * *`). |
| `storage.litestream` | `replicating`, age: 5.2s | OK | Continuous SQLite WAL replication to B2 is active and healthy. |
| `storage.r2Weekly` | `ok: false`, `reason: archive_stale` | **DEGRADED** | Age is 1,099,522s (~12.7 days).  Receipt missing for Sep 6 Sunday backup. |
| `polling_house` | Last success 52m ago | OK | Disclosures clerk watcher active. |
| `polling_senate` | Last success 52m ago | OK | Proxy-based eFD scraping active (scout relay retired). |
| `polling_executive` | Last success 52m ago | OK | OGE 278-T parser active. |
| `latency_probes` | Newest observation 7m ago | OK | FMP probe server-side active; retired providers suppressed. |
| `ingestion_dead_letter` | 2 triaged items (0 fresh) | OK | Ingestion DLQ clear of active unhandled failures. |

---

## 2. Ranked Findings & Risk Matrix

| Ref # | Area | Finding / Defect | Sev | Impact | GitHub Issue |
|---|---|---|---|---|---|
| **#1** | Ingestion | House live search lacks `FilingType=P` and pagination | **P0** | Intraday House PTRs pushed off page 1 by Annuals are missed | #2364 |
| **#2** | Extraction | Consensus voting allows `null|null` amount bloc to defeat valid extractions | **P0** | Multi-model extractions with null amounts overwrite true transaction amounts | #2364 |
| **#3** | Web UX | Zero `pushState` / `popstate` support; browser Back exits site | **P1** | Completely breaks browser history navigation across tabs, filters, and drawers | #2367 |
| **#4** | Web UX | Column header sorts only sort current page in-memory | **P1** | Table headers mislead users; corpus cannot be sorted by size or politician | #2367 |
| **#5** | Web UX | Client-side re-filtering on server-paginated data drops rows | **P1** | Navigating to subsequent pages skips rows and distorts page counts | #2367 |
| **#6** | Web Funnel | Checkout intent and selected plan dropped on OAuth redirect | **P1** | Users signing in to start a trial lose their purchase intent upon `/?login=ok` | #2367 |
| **#7** | Web Docs | Delivery copy instructs webhook consumers to dedupe on `docId` | **P1** | Multi-trade filings will cause consumers to drop trades 2 through N | #2367 |
| **#8** | Billing | Inconsistent auth across `/billing/*` routes breaks iOS Bearer auth | **P1** | Native app Bearer tokens 401 on checkout/apple-confirm and return unlinked status | #2365 |
| **#9** | Billing | `customerEmail` / `customerName` in `premiumRoster.ts` pass root subscription | **P1** | Disconnected Stripe subscribers permanently show as anonymous "No Local Account" | #2365 |
| **#10** | Database | SQLite init omits `PRAGMA journal_mode = WAL;` and foreign keys | **P1** | Threatens Litestream continuous replication if database defaults to DELETE mode | #2366 |
| **#11** | Runtime | Hardcoded 45s Deno cron tick deadline causes Sentry CONGRESS-TRADE-1B | **P1** | Multi-lane operations throw unhandled deadline exceptions in production | #2366 |
| **#12** | iOS | Associated Domains entitlement missing from `project.yml` and `.entitlements` | **P1** | Universal Links fail to invoke the installed app; Safari opens web links instead | #2368 |
| **#13** | iOS | Manage Subscription directs users to Stripe portal or web checkout fallback | **P1** | Violates App Store Review Guideline 3.1.1 (steering away from IAP) | #2368 |
| **#14** | Ingestion | House phantom collision unblocking ignores terminal `failed` status | **P1** | Filings that collided with frontier probes remain permanently stuck | #2364 |
| **#15** | Ingestion | Executive OGE 278-T `ROW_RE` regex drops valid rows or corrupts asset names | **P1** | OCR artifacts or numbers in asset names ("3M") break row parsing | #2364 |
| **#16** | Extraction | Hardcoded $0.25 spend ceiling blocks multi-model Autopilot runs | **P1** | Autopilot fails prematurely before utilizing its authorized $1.00 AP ceiling | #2364 |
| **#17** | Market Data | Ticker resolution penalizes non-equities (crypto, bonds) with 0.85 multiplier | **P1** | Skews `resolvedTickerPct` down to 37% by penalizing non-equity disclosures | #2364 |
| **#18** | Web Layout | Breakpoint divergence between 720px and 768px blows out mobile header | **P1** | Forces 250px account cluster into 44px mobile grid cell on iPad/laptop viewports | #2367 |
| **#19** | Ops | `fleet-sqlite-backup.sh` missing failure receipt on Sunday backup hang | **P2** | Leaves stale 12+ day receipts in place, causing `/api/health` `archive_stale` | #2366 |
| **#20** | Config | `CT_COST_PROFILE` resolves to free because it is not injected into container env | **P2** | Coolify container defaults to 15-minute cron and throttled queue limits | #2366 |
| **#21** | Security | `POST /api/admin/debug-sql` production gate relies solely on telemetry env keys | **P2** | Unset telemetry variables would fail open arbitrary SQL execution endpoint | #2366 |
| **#22** | Security | Scoped token route guards use suffix matching (`.endsWith()`) | **P2** | Sub-paths or query paths ending in maintenance names could bypass full auth | #2366 |
| **#23** | Security | `isAuthorized` checks `ADMIN_EMAILS` without asserting `emailVerified == true` | **P2** | Unverified accounts matching admin email strings could inherit privileges | #2366 |
| **#24** | Security | Session cookie `ct_session` lacks `__Host-` prefix | **P2** | Allows potential subdomain cookie tossing from untrusted subdomains | #2366 |
| **#25** | Delivery | `GET /api/stream` returns 400 without `?subscription=`; dashboard uses invalid id | **P2** | Root cause of Issue #2187; dashboard EventSource calls guaranteed 404 | #2366 |
| **#26** | a11y | Primary tabs announce duplicate accessible names (`"Trends Trends"`, Issue #2186) | **P2** | Screen readers speak pseudo-element content concatenated with DOM text | #2367 |
| **#27** | a11y | Password field in Infisical secret editor not contained in `<form>` (Issue #2185) | **P2** | Triggers browser DOM accessibility and security warnings | #2367 |
| **#28** | a11y | Table headers in directory contain nested interactive buttons | **P2** | `th` with `role="button"` enclosing another `<button>` invalidates a11y tree | #2367 |
| **#29** | Copy | Public copy states "from Congress" while displaying Executive branch data | **P2** | Factually inaccurate descriptions in premium feature list and asset search | #2367 |
| **#30** | iOS | Push alerts toggle claims "Premium feature" but is actually free & account-tied | **P2** | Contradicts backend implementation and creates user confusion | #2368 |
| **#31** | iOS | Politician profile sheet omits committee sector regulatory conflict signals | **P2** | Feature parity gap with web interface | #2368 |
| **#32** | iOS | Inconsistent `.iPadFullWidthSheet()` across Trends, Directory, and Ticker views | **P2** | Sheets launched from Trends or Directory search revert to narrow popovers | #2368 |
| **#33** | CI/CD | Stale host path check `/Users/jay/apps/ios-fleet/` on cloud `macos-latest` runner | **P2** | Step permanently skips in GitHub Actions cloud runner environment | #2368 |
| **#34** | CI/CD | `ios-build.yml` lacks XcodeGen project drift verification | **P2** | Mismatches between `project.yml` and `.xcodeproj` pass CI unnoticed | #2368 |

---

## 3. Deep-Dive Findings by Subsystem

### 3.1 Ingestion & Extraction Pipeline

#### A. House Intraday Live Search Omits `FilingType=P` and Pagination (P0)
- **File:** `app/src/ingestion/houseSource.ts` (lines 340–349)
- **Defect:** `buildHouseSearchBody` constructs a POST request to the House Clerk's portal with `FilingYear`, `LastName`, `State`, and `District`, but omits `FilingType=P`.  It fetches all annual, extension, and PTR filings for the entire year and parses only page 1.  When new annual filings are submitted, newly filed PTRs are pushed off the first page and missed until nightly backfill.
- **Fix:** Append `body.set('FilingType', 'P')` and implement pagination offset traversal against the Clerk DataTables API.

#### B. Consensus Voting: Null-Amount Blocs Defeat Valid Extractions (P0)
- **File:** `app/src/extraction/consensus.ts` (lines 217–280)
- **Defect:** In `voteField`, values are grouped by `fieldVoteKey`.  For amounts, `null|null` is treated as a valid candidate bloc.  When three LLM models run and two return `null` while one extracts `$1,000–$15,000`, the two null results form a 2/3 majority.  The consensus engine discards the valid extraction and persists `amount = null`.
- **Fix:** Exclude `null` and placeholder values from majority threshold computations when at least one coherent non-null extraction exists.

#### C. House Phantom Collisions Blocked on `failed` Status (P1)
- **File:** `app/src/ingestion/watcher.ts` (lines 397–430)
- **Defect:** `insertFilingIfNew` unblocks official filings that collided with prior frontier-probe phantoms only if `existingRow.ingest_status === 'not_found'`.  If a phantom filing reached terminal failure (e.g. repeated 403 blocks) and was marked `failed`, the upgrade check skips it, leaving the official filing permanently blocked.
- **Fix:** Update condition to `existingRow.ingest_status IN ('not_found', 'failed')` and reset error state.

#### D. Executive OGE 278-T OCR Parsing Fragility (P1)
- **File:** `app/src/extraction/ogeText.ts` (lines 86–88)
- **Defect:** `ROW_RE` strictly expects `(?<![\d,.])\d{1,3}\s+`.  In scanned PDFs with OCR noise, lines with periods (`1.`) or pipes (`1|`) fail matching and drop rows.  Furthermore, asset names starting with digits (e.g., "3M Company") have their leading number consumed as the row index if the real row index was dropped by OCR.
- **Fix:** Relax regex to tolerate standard OCR row punctuation and cross-reference table header bounding boxes.

---

### 3.2 Backend Architecture, Database & Ops

#### A. Inconsistent Auth on `/billing/*` Breaks iOS Bearer Auth (P1)
- **File:** `app/src/billing/routes.ts` (lines 92, 102, 166, 238)
- **Defect:** While `POST /billing/portal` uses `getCurrentUserFromRequest(c)` (supporting both Cookie and Bearer session tokens), `/billing/status`, `/billing/checkout`, and `/billing/apple/confirm` call `getCurrentUser(c)` (cookie-only).  Native iOS app calls passing `Authorization: Bearer <token>` fail with 401 Unauthorized on checkout and return empty customer states on status.
- **Fix:** Standardize on `getCurrentUserFromRequest(c)` across all billing routes.

#### B. Disconnected Stripe Subscriptions Anonymous in Premium Roster (P1)
- **File:** `app/src/admin/premiumRoster.ts` (lines 177–185, 346–348)
- **Defect:** `customerEmail` and `customerName` expect the nested `StripeSubscriptionObject['customer']` object.  Lines 347–348 pass `live` (the root subscription object) directly.  Because `live.email` and `live.name` do not exist at root, all unlinked customers display as `"Stripe Customer (No Local Account)"` despite valid customer objects retrieved via `expand[]=data.customer`.
- **Fix:** Pass `live.customer` to `customerEmail` and `customerName`.

#### C. Missing SQLite WAL Mode & Foreign Keys Pragmas (P1)
- **File:** `app/src/deno/main.ts` (lines 154–160)
- **Defect:** `initSqlite()` sets `busy_timeout`, `synchronous = NORMAL`, `cache_size`, and `mmap_size`, but omits `PRAGMA journal_mode = WAL;` and `PRAGMA foreign_keys = ON;`.  Litestream strictly requires WAL mode to replicate database frames off-host.  An uninitialized database defaults to rollback journal (`DELETE`), which breaks continuous replication.
- **Fix:** Add `PRAGMA journal_mode = WAL;` and `PRAGMA foreign_keys = ON;` to initialization.

#### D. Hardcoded 45s Tick Deadline Triggers Sentry CONGRESS-TRADE-1B (P1)
- **File:** `app/src/deno/main.ts` (lines 254–285, 306–310)
- **Defect:** `tickDeadlineMs` defaults to 45,000ms.  `CT_TICK_DEADLINE_MS` is not set in `docker-compose.yml`.  Multi-lane scraping and probe operations frequently exceed 45s under network latency, triggering hard timeout rejections logged to Sentry as `CONGRESS-TRADE-1B`.
- **Fix:** Configure `CT_TICK_DEADLINE_MS=120000` in container environment and ensure abort signals propagate to all internal HTTP fetches.

#### E. Stale R2 Weekly Backup Receipt (`archive_stale`) (P2)
- **Files:** `app/src/shared/r2WeeklyArchive.ts`, `scripts/ops/fleet-sqlite-backup.sh`
- **Defect:** On Sunday 2026-09-06, `fleet-sqlite-backup.sh` hung due to database lock contention.  Because the script only writes `.r2-archive-status.json` on successful copy, no failure receipt was recorded.  The Aug 31 receipt remained until its age exceeded the 8-day threshold, causing `/api/health` to report `archive_stale` (12.7 days old).
- **Fix:** Update `fleet-sqlite-backup.sh` to write an explicit failure receipt when the Sunday R2 copy encounters an error, timeout, or abort.

#### F. Production Runs in Free Cost Profile (P2)
- **Files:** `app/src/deno/costProfile.ts`, `app/docker-compose.yml`
- **Defect:** `resolveDenoCostProfile` reads synchronously from environment variables and does not query Infisical.  Because `CT_COST_PROFILE=paid` was not injected into the Coolify container environment in `docker-compose.yml`, the application fell back to `free` (`*/15 * * * *` cron, drainLimit: 2, outboxLimit: 10).
- **Fix:** Inject `CT_COST_PROFILE=paid` into container environment in `docker-compose.yml`.

---

### 3.3 Web UI & UX (`dashboardHtml.ts`)

#### A. Browser Back Button Inoperative (No pushState / popstate) (P1)
- **Lines:** 6155, 10776, 13171, 13263, 14060
- **Defect:** All tab switches, filter updates, and drawer openings invoke `history.replaceState`.  There are zero calls to `pushState` and no `popstate` event listener.  Clicking browser Back exits the domain instead of returning to previous views or filter states.
- **Fix:** Use `pushState` for user-initiated tab switches and implement a global `popstate` listener restoring tab, filter, and drawer state.

#### B. Column Header Sorting Limited to Current Page In-Memory (P1)
- **Lines:** 5830–5837, 6027–6043
- **Defect:** Clicking headers for Amount, Type, Politician, or Asset sets `isBackendSort = false` and re-sorts only the current 50 rows in memory.  Clicking Next Page queries the server sorted by date and locally re-sorts that page, preventing corpus-wide sort by trade size or member.
- **Fix:** Wire server-side sort parameters on the backend API or remove sorting indicators from unsupported columns.

#### C. Client-Side Re-filtering Causes Row Skipping (P1)
- **Lines:** 5521–5542, 5586–5593, 6066–6082
- **Defect:** `fetchPage` retrieves 50 records from the server, and `renderTrades` then applies secondary client-side filters (`makeTradesFilterMatcher`).  Rows dropped on the client shrink the displayed count (e.g. 35 rows), and clicking Next Page advances the server offset by 50, permanently skipping rows 36–50.
- **Fix:** Push all filtering to the backend `/api/transactions` query; eliminate secondary client-side row filtering during table rendering.

#### D. Dropped Checkout Intent on OAuth Login (P1)
- **Lines:** 12995–12998, 13157–13173
- **Defect:** Anonymous users selecting a plan and clicking "Start Free Trial" are sent through OAuth login.  The backend redirects to `/?login=ok`, which displays a toast but discards the plan selection and closes the pricing modal.
- **Fix:** Persist plan and checkout intent in `sessionStorage` before OAuth redirect and resume checkout in `handleAuthQueryParams()`.

#### E. Deduplication Documentation Error (P1)
- **Line:** 3728
- **Defect:** Delivery instructions state webhook consumers dedupe on `docId`.  Because multi-trade disclosures share one `docId`, following this instruction causes consumers to drop trades 2 through N.
- **Fix:** Update copy to `X-Subscription-Id` + `X-Tx-Id`.

#### F. Responsive Breakpoint Divergence (720px vs 768px) (P1)
- **Lines:** 2252, 3165, 3182
- **Defect:** Header switches to a 44px mobile grid at 768px, but desktop account cluster is only hidden at 720px.  Between 721px and 768px on fine-pointer devices (iPad/laptop), the 250px account cluster is forced into the 44px cell, breaking layout.
- **Fix:** Harmonize breakpoints to a consistent 768px threshold.

#### G. Accessibility Deficiencies (P2)
- **Lines:** 2342–2343, 3647–3658, 8490–8501
- **Defects:**
  - Duplicate accessible names on primary tabs (`"Trends Trends"`, Issue #2186) caused by unsuppressed CSS `::after` content.
  - Password field in Infisical secret editor not contained in `<form>` (Issue #2185).
  - Nested interactive controls in Directory table headers (`th` with `role="button"` enclosing another `<button>`).

---

### 3.4 iOS Client (`clients/ios/`)

#### A. Missing Associated Domains Entitlement for Universal Links (P1)
- **Files:** `clients/ios/project.yml`, `CongressTrade.entitlements`
- **Defect:** `com.apple.developer.associated-domains` (`applinks:congress.trade`) is absent from `project.yml`.  Because XcodeGen regenerates entitlements from `project.yml`, Universal Links fail to open the native app, always falling through to Safari.
- **Fix:** Add `com.apple.developer.associated-domains: ["applinks:congress.trade"]` to `project.yml` and regenerate.

#### B. StoreKit Guideline 3.1.1 Compliance in Manage Subscription (P1)
- **File:** `clients/ios/CongressTrade/Store/ManageSubscription.swift` (lines 25–78)
- **Defect:** When managing subscriptions, the app calls `POST /billing/portal` (Stripe portal) or falls back to opening `https://congress.trade/?billing=manage` in Safari.  Directing iOS users to external checkout/portal URLs violates App Store Review Guideline 3.1.1.
- **Fix:** For Apple IAP subscribers, route strictly to `https://apps.apple.com/account/subscriptions` and never open web billing URLs inside the native app.

#### C. Push Alerts Copy Inaccuracy (P2)
- **File:** `clients/ios/CongressTrade/Views/Components/Components.swift` (line 1555)
- **Defect:** Signed-out users see "Push alerts are a Premium feature."  However, once signed in, push alerts function for free (backend does not gate APNs on premium).
- **Fix:** Update copy to "Sign in to enable push alerts on this device."

#### D. Missing Committee Regulatory Conflict Signals (P2)
- **File:** `clients/ios/CongressTrade/Views/Feed/PoliticianDetailView.swift`
- **Defect:** Static committee memberships are shown, but active regulatory conflict trade flags available on the web are omitted.
- **Fix:** Filter `store.conflicts` by member ID and display conflict tags in the profile header.

#### E. Inconsistent iPad Sheet Presentation (P2)
- **Files:** `TrendsView.swift`, `MemberDirectorySearch.swift`, `TickerDetailView.swift`
- **Defect:** `.iPadFullWidthSheet()` was omitted from sheets launched from Trends or Directory search, causing them to render as narrow popovers on iPad.
- **Fix:** Add `.iPadFullWidthSheet()` and `.presentationContentInteraction(.resizes)`.

#### F. CI/CD Stale Mac Path Check & XcodeGen Drift (P2)
- **Files:** `.github/workflows/ios-ship.yml`, `.github/workflows/ios-build.yml`
- **Defect:** `ios-ship.yml` checks for `/Users/jay/apps/ios-fleet/` on cloud `macos-latest` runners (always skips).  `ios-build.yml` does not verify `project.yml` matches committed `.xcodeproj`.
- **Fix:** Remove invalid path check and add `git diff --exit-code clients/ios/CongressTrade.xcodeproj` check.

---

## 4. Verification & Testing Summary

- **Local Deno Check:** `deno check src/deno/main.ts` &rarr; **CLEAN** (0 errors).
- **Vitest Test Suite:** 305 test files, 3,903 tests &rarr; **305 PASSED**, 0 genuine logic failures (all 4 timeout candidates passed on dedicated isolated runs).
- **Cloud CI Runners:** Workflows correctly target GitHub-hosted cloud runners (`ubuntu-latest` and `macos-latest`).

---

## 5. Remediation Roadmap

1. **Sprint 1 (P0 Ingestion & Core Data Trust):** Fix House search `FilingType=P` and pagination; resolve consensus null-amount voting bloc bug; update phantom collision unblocking.
2. **Sprint 2 (P1 Billing & Backend Durability):** Harmonize `/billing/*` auth for iOS Bearer tokens; fix `premiumRoster.ts` unlinked customer objects; add SQLite WAL and foreign key pragmas; configure `CT_COST_PROFILE=paid` in container environment.
3. **Sprint 3 (P1 Web History & Conversion):** Implement `pushState` / `popstate` in `dashboardHtml.ts`; persist checkout intent across OAuth login; push table filtering to backend API.
4. **Sprint 4 (P1 iOS Compliance & Universal Links):** Add Associated Domains entitlement in `project.yml`; enforce StoreKit Guideline 3.1.1 routing; harmonize push notification copy; resolve iPad sheet sizing.
