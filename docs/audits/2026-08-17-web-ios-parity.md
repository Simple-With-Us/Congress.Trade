# Congress.Trade — Web / iOS Parity Audit

**Date:** 2026-08-17  
**Seat:** CURSOR (read-only)  
**HEAD:** `be53b3e5` (`main` — includes merged #1963 design language and #1970 filter chrome)  
**Surfaces:** desktop web, mobile web, native iOS (`clients/ios`)  
**Scope:** information architecture, design consistency, Review Queue, filters, feeds, directory, charts, deep links, keyboard/touch, accessibility, error states, performance  

This is a report.  It does not change product code.

---

## Verdict

The three surfaces now share one product language: Trends-first tabs, shared Branch / Party / Side / window filters, Chamber · Name · D-ST trade identity, party-ringed photos on **web**, ticker logos, light default, and Title Case chrome.  That is the #1963 / #1970 harvest.  It is not yet parity.

The remaining gaps are not 80 one-off bugs.  They are a smaller set of missing contracts that keep reproducing the same owner complaints:

1. **Share and restore** — web can open `?member=` / `?ticker=` / `?trade=` and keep some filters in the URL.  iOS can only *emit* those URLs.  It cannot open them.  Party is never in the URL on either side.
2. **Card truth** — web mobile cards show owner + relative filed time + party-ringed photo.  iOS cards show trade date only, no owner, no photo.  Open PR #1965 adds owner and committees; it does not add the photo ring or filed-relative time.
3. **Entity drawers** — web company drawer has Buy Pressure, buys/sells chart, and Performance After Buys (`/api/analytics/ticker/:t` + `/backtest`).  iOS ticker sheet is the thinner `/api/client/v1/ticker/:t` envelope.
4. **Failure voice** — Trades retries 5xx.  Trends does not, and the banner is often the raw string `Request failed`.
5. **Admin vs consumer** — Review Queue is a web admin tab.  iOS correctly has none.  The queue itself still has a one-click Reject with no confirm.

Land #1967 and #1965 before starting new visual work.  Then fix inbound deep links, Trends retry copy, and the ticker drawer contract.  Do not reintroduce an All Assets dropdown.  Do not add `$` min/max filters on Trades/Trends (cancelled leftover from #1429).

---

## Method

Read-only against `main` at `be53b3e5`, plus the open design/UX diffs:

| Source | What was read |
|---|---|
| Web SPA | `app/src/ui/dashboardHtml.ts` (~13k-line HTML+CSS+JS), `app/src/ui/routes.ts`, `app/src/ui/ogMeta.ts`, `app/src/ui/__tests__/dashboardHtml.test.ts` |
| iOS | `clients/ios/CongressTrade/**/*.swift` (tabs, store, feed, directory, trends, delivery, detail sheets, `APIClient`, `App.swift`) |
| Prior audit | `docs/ux-findings-2026-08.md` (2026-08-10/11 CLAUDE reconstruction) — used as a delta check, not copied blindly |
| Open UX PRs | #1967 (deep-link aliases + primary-only feed), #1965 (directory leftovers) |
| Merged today | #1963 (iOS language + Capitol Ledger style), #1970 (filter seam / unclipped menus) |
| Owner rules | `docs/FLEET-UI-COPY.md`, `AGENTS.md` (light default, two spaces, no asset-class dropdown, House + Senate + Executive) |
| Coordination | `#ag***-s**c` claims for #1963 / #1965 / #1967 / #1970; keepout on #1959 OCR and the in-flight review-queue *ops* catalog (`cursor/prod-incident-audit-f506`) |

No live browser, no Xcode, no production writes.  Claims below are code-backed.  Where a finding was only measured in the August 11 audit and not re-measured live, the row says so.

Severity:

| Sev | Meaning |
|---|---|
| **P0** | Wrong number, crash, or broken primary path |
| **P1** | Common-path miss, destructive without confirm, share/deep-link miss, misleading empty/error |
| **P2** | Visible inconsistency, a11y gap, missing section, persistence miss |
| **P3** | Polish / upgrade |

Status in the matrix: **Parity** · **Web ahead** · **iOS ahead** · **Both missing** · **In PR** · **Expected split**.

---

## Current design and UX PRs (accounted)

Do not re-do these slices.  The matrix treats them as landed or incoming.

| PR | State | What it changes for this audit |
|---|---|---|
| **#1963** `feat(ui): web adopts iOS language + Capitol Ledger style option` | **Merged** 2026-08-17 | Web trade cards use Chamber · Name · D-ST.  Party-ringed photos.  Icon-only theme.  Filter chevrons.  Owner + relative filed time on mobile cards.  Directory photos.  Largest Buys/Sells.  Style = Standard \| Capitol Ledger. |
| **#1970** `fix(ui): drop header/filter seam and unclip filter menus` | **Merged** 2026-08-17 | Header/filter `--border` hairline gone.  `--ct-main-pad` tracks 22px phone padding.  Sell arrow is `--sell` red.  iOS-filter menus `position:fixed` (no longer clipped by chip `overflow:hidden`).  Selected rows use a check, not blue fill. |
| **#1967** `Fix deep-link aliases, quiet anonymous loads, and primary-only feed` | **Open** | `?view=directory` → `people`.  Aliases case-insensitive.  CSP allows Cloudflare Insights.  Public/client feeds hide `seed_dataset` unless `source=all`.  iOS tests capture feed URLs by path (#1549 race). |
| **#1965** `Directory photos, owner, committees, and horizon labels` | **Open** | People rows use the same avatar helper.  Feed table + mobile cards show owner.  Skill stats label each leg as a **variable hold**.  Committee JSON parse + sibling-bioguide fallback.  Empty copy → "No current assignments on file".  iOS politician sheet gets Committees + horizon copy.  iOS `TradeCard` appends owner.  Web Delivery delete becomes second-click **Confirm?** (4s arm), matching iOS. |
| **#1954** Review Queue model chips | **Merged** | Pending chips show the extraction model id, not `OpenRouter`. |
| **#1951 / #1897 / #1871 / #1863 / #1855** | **Merged earlier** | Sticky full-bleed filters, glass mobile tab bar, Directory People\|Assets, no All Assets dropdown, Filing Latency on Delivery, #/$ on Buys vs Sells. |

Still-open *product* issues this audit maps onto (do not confuse with stale effort-board mirrors):

| Issue | Still true on `main`? |
|---|---|
| **#1458** `?view=` aliases | Partially.  `feed` and `delivery` work.  Visible name `directory` does **not**, until #1967.  Unknown values already fall back to Trends. |
| **#1453** primary+historic duplicates | Client still has a `primaryOnly` hide of `seed_dataset` in the SPA.  Server default stays mixed until #1967 (`source` absent / `primary` hides seed). |
| **#1457** anonymous console noise | Stream 404 / poll-config 401 / logo 404 already gated on main.  CSP Insights is the leftover, in #1967. |
| **#1460** committees / owner / photos / horizon | Web photos + owner on cards are on main (#1963).  Committee fallback + iOS Committees + horizon labels are #1965. |
| **#1429** filter parity leftovers | Shared window/branch/party/side are on main.  `$` min/max on Trades/Trends is **cancelled**.  Dual-axis trade-detail chart is still optional leftover.  Web Delivery delete is still `window.confirm` until #1965. |
| **#1459** Capitol Ledger harvest | Style option + Largest Buys/Sells + photos are on main.  Path routes (`/trades` instead of `?view=`) were explicitly left to another seat and are still query-string. |
| **#1549** iOS feed-filter test race | Fix is in #1967 only. |

Disjoint in-flight work (not this report): #1959 scanned-PDF OCR, #1964 Coolify overlap, #1966 latency corpus, and the ops Review Queue catalog on `cursor/prod-incident-audit-f506` (per-document stranded-filing list, no bulk Confirm/Reject).

---

## Information architecture

### Tabs

| Order | Web `data-view` | Web label | iOS `AppTab` | Notes |
|---|---|---|---|---|
| 1 | `trends` | Trends | Trends | Default on both. |
| 2 | `trades` (alias `feed`) | Trades | Trades | Legacy `feed` id kept forever. |
| 3 | `people` (alias `directory` **in #1967**) | Directory | Directory | Visible name ≠ id until #1967. |
| 4 | `review` | Review Queue | — | Admin-gated web only.  **Expected split.** |
| 5 | `subs` (aliases `delivery`, and in older copy `alerts` / `push`) | Delivery | Delivery | Web also accepts path `/pricing` → `?pricing=1&view=subs`. |
| 6 | `admin` | Admin · Cadence | — | Admin-gated web only.  **Expected split.** |

Web routing is **path + query**, no hash router, no History push for entity drawers.  Tab switches `history.replaceState` with `?view=`.  Last tab is also in `localStorage['ct-active-tab']`.  iOS is a four-tab `TabView` + hamburger Account sheet.  `SettingsView` exists and is not mounted.

### Overlays

| Job | Desktop web | Mobile web | iOS |
|---|---|---|---|
| Trade / politician / asset | `#detailDrawer` | same drawer | `.sheet` medium+large |
| Account / theme / export / Premium | desktop cluster + hamburger | hamburger | `AccountQuickMenu` `.large` |
| Login | `#loginOverlay` | same | in-account Sign In (Apple / Google / magic link) |
| Pricing | `#pricingOverlay` or `/pricing` | same | `PremiumSheet` (StoreKit) |
| CSV | `#exportCsvDialog` | same (Premium) | `ExportCSVSheet` `.medium` |
| Review editor | drawer + inline editor | same | none |

### Deep-link map (normative)

| Intent | Web today | iOS today | After #1967 |
|---|---|---|---|
| Tab | `?view=trends\|trades\|people\|subs\|review\|admin` plus `feed`/`delivery` | none inbound | + `directory` → `people`, case-insensitive |
| Politician | `?member=` opens drawer | ShareLink *writes* the same URL; inbound ignored | unchanged |
| Asset | `?ticker=` | outbound only | unchanged |
| Trade | `?trade=` via `/api/client/v1/trade/:id` | outbound only | unchanged |
| Filters | `fq`, `fty`, `fch`, `fw` (not party) | in-memory only; `ClientPreferences.savedFilters` decoded and never applied | unchanged |
| Auth | `?login=` / `?checkout=` toasts then scrubbed | `congresstrade://auth?token=` only | unchanged |
| Universal Links | n/a | **none** — no `associated-domains` | still none |

iOS `Info.plist` registers scheme `congresstrade`.  `App.swift` `onOpenURL` accepts **only** `congresstrade://auth?token=…`.  Shared `https://congress.trade/?trade=…` links open Safari.

---

## Parity matrix

Legend: **P** parity · **W** web ahead · **I** iOS ahead · **M** both missing · **PR** fixed in an open PR · **X** expected split.

| Area | Desktop web | Mobile web | iOS | Status | Sev | Evidence |
|---|---|---|---|---|---|---|
| Default tab = Trends | yes | yes | yes | **P** | — | `initialView = 'trends'`; `TabRouter.selection = .trends` |
| Light theme default | yes | yes | yes | **P** | — | `ui-theme` / `@AppStorage("app_color_scheme") = "light"` |
| Icon-only Light/Dark/System | yes | hamburger | Account sheet | **P** | — | #1963; `ThemeSegmentControl` |
| Capitol Ledger / Style | Standard \| Ledger | same | **none** | **W** | P3 | `ui-style` / `html[data-style="ledger"]` |
| Brand lockup | header | header | `BrandTitle` principal | **P** | — | #1429 / later chrome PRs |
| Glass / solid tab bar | top tabs | bottom glass | system tab bar | **P** (platform) | — | mobile CSS ~L1851 |
| Shared filters (window, branch, party, side) | yes | yes | yes | **P** | — | `shared-*-v1` / `FeedControlBar` |
| Filter menus unclipped | yes after #1970 | yes after #1970 | native `Menu` | **P** | — | `placeIosFilterPop` + `position:fixed` |
| Party in shareable URL | **no** | **no** | n/a (no URL filters) | **M** | P2 | `syncFilterUrl()` omits party |
| Filter persist across launch | localStorage + partial URL | same | **resets** | **W** | P2 | `savedFilters` unused |
| All Assets dropdown | **gone** | **gone** | **gone** (model leftover) | **P** | — | `selectedAssetClass()` stub; `AssetClassFilter` has no UI |
| `$` min/max on Trades/Trends | **gone** (cancelled) | gone | gone | **P** | — | comment at `dashboardHtml.ts` ~L1602 |
| `$` min on Delivery create | yes | yes | **no** | **W** | P2 | iOS create uses chambers + members + watchlist only |
| Search on Trades | `#qSearch` | same | unified field | **P** | — | |
| Sort keys | many table columns | Date / Amount / Ticker | Date / Amount / Ticker | **W** | P3 | desktop table is the richer surface |
| Page sizes | 25 / 50 / 100 / 250 | same | 50 / 100 / 200 | **W** | P3 | |
| Public offset cap 2000 | toast → Premium CSV | same | same cap | **P** | — | `MAX_PUBLIC_TRADES_OFFSET` |
| Trade card identity line | Chamber · Name · D-ST | same | House · Name · D-CA | **P** | — | web `renderTradesCard`; iOS `politicianLine` (comment still says "Sen. Name") |
| Owner on card | desktop col hidden | **yes** | **no** → **PR #1965** | **PR** | P2 | web `fc-owner`; iOS `TradeCard` has no owner on `main` |
| Relative filed time on card | desktop Official Filed hidden | **yes** | **no** (shows trade date) | **W** | P2 | `relativeTimeText()` vs `transaction.date.shortDate` |
| Party-ringed photo on card | yes | yes | **no photo on card** | **W** | P2 | `memberAvatarHtml` `.party-D\|R\|O`; iOS card is ticker + text |
| Party-ringed photo in Directory | yes | yes | grey ring only | **W** | P3 | `MemberAvatar` stroke `AppTheme.borderColor` |
| iOS relative photo URLs | n/a | n/a | **ignored** | **I gap** | P1 | `MemberPhotoURL.resolve` requires a scheme; `/api/photos/...` dropped |
| Ticker logos | yes, lazy | yes | `AssetMark` + theme | **P** | — | |
| Feed default hides seed copies | client-side hide | same | follows API | **PR #1967** | P1 | server still mixed until #1967 |
| Desktop table vs cards | table | cards only | cards | **P** (platform) | — | `.table-wrap { display:none }` ≤768px |
| Directory People \| Assets | segmented | same | segmented | **P** | — | |
| Directory photos | yes | yes | yes if absolute URL | **W/PR** | P1 | #1965 web helper; iOS scheme filter |
| Directory committees on row | no | no | no | **P** | — | belong on profile |
| Politician Committees section | yes; empty = "Not recorded" | same | **missing** → **PR #1965** | **PR** | P2 | web L11293; iOS sheet has Performance + Recent Trades only |
| Committee sibling-bioguide fallback | **PR #1965** | **PR #1965** | **PR #1965** | **PR** | P2 | `resolveFilerCommittees` |
| Horizon / variable-hold labels | **PR #1965** | **PR #1965** | **PR #1965** | **PR** | P2 | |
| Trends: Market Snapshot | yes | yes | yes | **P** | — | |
| Trends: Largest Buys/Sells | yes (#1963) | yes | **no** | **W** | P2 | `#trLargestBuys` / `#trLargestSells` |
| Trends: What Is Being Traded #/$ | yes | yes | yes | **P** | — | |
| Trends: Buys vs Sells #/$ | yes | yes | yes | **P** | — | |
| Trends: Rising / Consensus / Sector / Cap / Performers / Members / Lag / Conflicts | yes | yes | yes | **P** | — | Conflicts added iOS #1823 era |
| Trends: By Party | yes | yes | **fetched, not shown** | **W** | P2 | `loadTrParties()` vs unused `partySplit` |
| Trends: By Asset Type | yes | yes | **no** | **W** | P3 | distinct from GICS sector flow |
| Trends 5xx retry | per-section "Could not load" | same | **single-shot** | **W** | P1 | `performTrendsRefresh()`; Trades has `fetchPageWithRetry` |
| Trends error copy | "Could not load: …" | same | often **"Request failed"** | **W** | P1 | `APIClient.swift` L724 |
| Company drawer: Buy Pressure + chart + backtest | yes | yes | **no** | **W** | P1 | web `openAsset` + `/backtest`; iOS `TickerDetailView` is client envelope only |
| Politician drawer: all-time stats + most-traded | yes | yes | thinner (perf + recent) | **W** | P2 | |
| Review Queue | admin tab | admin tab | **none** | **X** | — | consumer app |
| Review Reject confirm | **none** (POST immediately) | same | n/a | **W gap** | P1 | `resolveReview()` L6361 |
| Review keyboard (j/k) | **none** | none | n/a | **M** | P3 | |
| Delivery webhook/SSE | full filters | full filters | chambers + members + watchlist | **W** | P2 | iOS cannot set per-sub tickers / sides / min $ |
| Delivery delete | `window.confirm` → **PR #1965 Confirm?** | same | **Confirm?** 4s | **PR / I** | P2 | iOS `SubscriptionRow` L471 |
| Push alerts | copy points at iOS | same | OS permission toggle | **X** | — | |
| Premium / trial copy | $5 / $50 / 2-week | same | same | **P** | — | |
| CSV export | Premium dialog | same | Premium sheet | **P** | — | |
| Inbound Universal Links | n/a | n/a | **missing** | **M** | P1 | no `associated-domains` |
| `?view=directory` | **fails** (Trends) | same | n/a | **PR #1967** | P1 | aliases on main: `feed`, `delivery` only |
| Skip link | **none** | none | n/a | **M** | P2 | grep: no "Skip to" |
| Tablist arrow keys | **none** (Tab only) | same | system | **M** | P3 | `role="tab"` without WAI-ARIA arrows |
| Focus trap on overlays | yes | yes | system sheets | **P** | — | L10834 |
| `prefers-reduced-motion` | yes (shimmer / slide) | yes | splash only, **unmounted** | **W** | P2 | `EagleSplashView` not in `App.swift` |
| Dynamic Type | browser zoom | same | Zilla Slab `relativeTo: .body` + `@ScaledMetric` | **I** | — | |
| Offline trades cache | none | none | SwiftData ~400 rows | **I** | P2 | |
| VoiceOver row labels | mixed | cards have `aria-label` | Trends strong; cards mixed | **I/W** | P2 | |
| Sector taxonomy collision | still possible | same | same | **M** | P2 | Aug 11: Health Care vs Healthcare; not re-measured live |
| Path routes (`/trades`) | still `?view=` | same | n/a | **M** | P3 | #1459 leftover, other seat |

---

## Findings

### P1 — fix next

#### F1. iOS cannot open the links it shares

`APIClient.shareURL` builds `https://congress.trade/?trade=` / `?member=` / `?ticker=`.  `App.swift` `onOpenURL` returns unless the scheme is `congresstrade` **and** the host is `auth`.  There is no `AppRoute`, no Universal Links entitlement, and no cold-start query parser.

**Fix:** add associated domains for `congress.trade` / `www.congress.trade`.  On open, map the same query keys the web already understands.  Switch to the matching tab and present the existing sheet.  Keep `congresstrade://auth` exclusive to session handoff.

**Upgrade:** once inbound works, persist the current filter set into the same `fq/fty/fch/fw` keys so a shared Trades URL restores on both sides (see F8).

#### F2. `?view=directory` still lands on Trends

On `main`, `VIEW_ALIASES = { feed: 'trades', delivery: 'subs' }`.  The visible tab name is Directory.  A guessed or typed `?view=directory` fails the `data-view` lookup and falls back to Trends.  That is the original #1458 report, half-fixed.

**Fix:** merge #1967 (`directory: 'people'`, `resolveViewId` lowercases).  Do not invent `/directory` path routes in the same PR as #1459's other seat.

#### F3. Default feed can still show primary + historic seed twins

#1453 is still a product bug on `main`.  The SPA hides `seed_dataset` client-side when `primaryOnly` is on, but the public/client API still returns those rows unless #1967's `source` default lands.  Shared links and iOS see whatever the API returns.

**Fix:** merge #1967.  Keep `source=all` for admin / explicit CSV.  HONAV stays a real ticker.

#### F4. Trends failure is a dead banner; Trades already retries

`CongressTradeStore.performTrendsRefresh()` is single-shot.  `APIError.server` defaults to `"Request failed"` (`APIClient.swift` L724).  A Coolify swap 502 (already observed 2026-08-14) leaves Trends empty until pull-to-refresh.  Trades uses `fetchPageWithRetry` (3×, 429/5xx/transport).

**Fix:** reuse the Trades retry helper for the Trends fan-out.  Map 502/503 to "The site is updating.  Pull to refresh."  Do not print the transport string.

#### F5. iOS ticker sheet is a different product than the web company drawer

Web `openAsset()` loads analytics KPIs, Buy Pressure, a buys/sells chart, Performance After Buys (`/backtest`), and recent trades.  iOS `TickerDetailView` documents that it is `GET /api/client/v1/ticker/:ticker` — identity, summary, recent items.  The Aug 11 findings already named this.  It is still true.

**Fix:** either (a) expand the client ticker envelope with the analytics fields the drawer already computes, or (b) have iOS call the same public analytics routes the web uses.  Prefer (a) so the client API stays the source of truth (`AGENTS.md`).

#### F6. iOS drops relative member photos

`MemberPhotoURL.resolve` skips any URL without a scheme.  Roster/profile payloads that send `/api/photos/member?key=…` render initials.  Web `<img src>` accepts the relative path.  That is why Directory/sheet faces can look empty on device after a web-looking API.

**Fix:** resolve relative paths against the API origin inside `MemberPhotoURL`.  Keep the "no party mascot" rule.

#### F7. Review Queue Reject has no confirm

`resolveReview(docId, 'confirm')` opens the editor.  `reject` POSTs `/api/admin/review/:docId` immediately and only disables the row buttons.  A mis-tap discards a held filing.

**Fix:** same two-step **Confirm?** pattern iOS Delivery already uses (4s arm), or `window.confirm` as a floor.  Do not add bulk Confirm/Reject — that is the ops-catalog keepout.

---

### P2 — consistency and restore

#### F8. Party (and iOS filters) are not shareable or durable

`syncFilterUrl()` writes `fq`, `fty`, `fch`, `fw`.  Party chips live only in `localStorage['shared-parties-v1']`.  iOS filter state is in-memory; `ClientPreferences.savedFilters` is decoded and never applied.

**Fix:** add `fpa=` (or reuse `party=`) on web.  On iOS, apply `savedFilters` at launch and, after F1, read the same query keys.

#### F9. Trade card truth still differs after #1963

Web mobile card (`renderTradesCard`, L4488–L4517): avatar + Chamber · Name · D-ST + owner pill + relative filed time + late-filing flag.  Desktop table hides Owner and Official Filed by default.  iOS `TradeCard`: ticker, amount, **trade date**, politician line, no owner, no photo.

#1965 adds owner to iOS cards and the web table.  It does not add filed-relative time or the photo ring.

**Fix (after #1965):** show owner + relative filed time on iOS cards.  Optionally show the member avatar with a party ring (web already has the CSS).  On desktop, consider making Owner visible by default now that cards treat it as identity, or accept table-vs-card as a density choice and document it.

#### F10. Committees empty copy and missing iOS section

Web empty state is still **"Not recorded"** (`dashboardHtml.ts` L11296).  #1965 changes that to "No current assignments on file" (executive-specific variant) and adds the iOS section plus sibling-bioguide fallback.  Until that lands, Tuberville-style slug PKs look empty.

**Fix:** merge #1965.  After deploy, spot-check a slug PK once the daily committee sync has run.

#### F11. Delivery create/delete still not the same control

iOS delete is second-click **Confirm?** (4s).  Web is `window.confirm(...)`.  #1965 aligns web to iOS.  iOS create still cannot set per-subscription tickers (reuses watchlist), sides, or min amount — web can.  That leftover is from the Aug 11 backlog and #1039.

**Fix:** merge #1965 for delete.  Then add the three missing create fields on iOS, or drop them from web if the product decision is "watchlist is the ticker filter."

#### F12. Trends sections present on web, omitted or silent on iOS

| Section | Web | iOS |
|---|---|---|
| Largest Buys / Sells | yes (#1963) | missing |
| By Party | `loadTrParties()` | `partySplit` fetched, no UI |
| By Asset Type | yes | missing |
| Empty section | "No … in this window" | section omitted |

**Fix:** show By Party (data is already on device).  Port Largest Buys/Sells from the ticker-leaderboard the web already uses.  Per-section empty copy beats a vanishing layout.

#### F13. Ledger row contract is fixed on iOS sheets; desktop Trends still space-between in places

Aug 11 RC1: iOS `DetailRow` used `Spacer()` (52% gap).  **Fixed** — `LedgerRowLayout` is now the shared primitive (`Components.swift` L433).  Web drawers use `.drawer-kv` 35% / 1fr.  Desktop Trends KPI / comparison rows that still `space-between` were the other half of that complaint.  Re-check live after #1963; any remaining `justify-content: space-between` on heterogeneous label/value rows is a leftover, not a new idea.

#### F14. Accessibility gaps that are still cheap

| Gap | Where | Fix |
|---|---|---|
| No skip link | web | `<a href="#view-trends" class="skip-link">Skip to Content</a>` |
| `#drawerTopbarTitle` is `aria-hidden` | web | expose as the drawer heading |
| Tablist has `role="tab"` but no ArrowLeft/Right | web | either implement the ARIA tab pattern or drop `role="tab"` and treat as a toolbar |
| Fold cues `SHOW ↓` / `HIDE ↑` | web mobile | Title Case; keep `aria-hidden` on the visual cue, name the `<summary>` |
| `EagleSplashView` reduce-motion | iOS | unused; either mount it or delete it.  Guard filter animations with `accessibilityReduceMotion` |
| Header buttons 34pt | iOS | 44pt minimum at default Dynamic Type |
| Review status changes | web | `aria-live` on `#reviewBody` after confirm/reject |

Web already has: tab/tabpanel semantics, `aria-pressed` chips, focus-visible, focus trap, entity `tabindex=0` via MutationObserver, `prefers-reduced-motion` on shimmer/slide, real `alt` on politician photos, decorative ticker `alt=""`.

#### F15. Keyboard / touch leftovers

**Web — good:** Escape closes drawer/login/pricing/panels.  Enter/Space opens `.clickable` entities.  Sort headers are keyboard buttons.  Coarse pointers tap-to-reveal `.info-tip` / `.est-money`.  iOS-filter popovers reposition on scroll/resize.  Search debounce 250ms.

**Web — missing:** no `/` to focus search, no `?` help, no j/k in Review Queue, no Arrow keys on the tablist.  Feed Options `⋯` still uses `.menu-pop` (not `placeIosFilterPop`) and can clip on small screens.

**iOS — good:** interactive keyboard dismiss, Done toolbar, pull-to-refresh on Trades/Trends/Directory, sheet detents, no nested-button trap on `TradeCard` (`RowTapModifier`).

**iOS — missing:** no swipe actions (fine).  Delivery delete is already two-step.  Search slot swaps to Reload on error (good).  Trends has no equivalent Reload control — only the notice + pull.

#### F16. Error / empty / loading (cross-surface)

| Surface | Loading | Empty | Error | Offline |
|---|---|---|---|---|
| Web Trades | "Loading live feed…" / skeletons | "No transactions match these filters." | red banner | none |
| iOS Trades | overlay ProgressView | ContentUnavailable + Retry | search-slot Reload | SwiftData + "You are offline." |
| Web Trends | per-section skeletons | "No … in this window" | "Could not load: …" | none |
| iOS Trends | "Loading trends…" | section dropped | **"Request failed"** | stale data, no banner |
| Web Directory | "Loading directory…" | "No politicians match this filter." | "Could not load directory: …" | none |
| iOS Directory | "Loading Directory…" | ContentUnavailable | freshness + Retry; `isOffline: false` hardcoded | not tracked |
| Web Review | "Loading…" | "Nothing awaiting review — queue is clear." | auth → admin.congress.trade copy | n/a |
| Deep-link miss | drawer loading | "That trade was not found…" | retracted copy | n/a |

**Fix:** give iOS Trends the Trades Reload treatment.  Track Directory offline honestly.  Do not invent a web offline cache unless asked.

---

### P3 — upgrades

#### F17. Capitol Ledger is web-only

`html[data-style="ledger"]` swaps Source Serif 4 + IBM Plex Mono and paper `#f4efe4`.  iOS is Zilla Slab + system materials with no Style control.  That is acceptable if Ledger stays a web editorial option.  If it is a product style, add the same two-value control to `AccountQuickMenu`.

#### F18. Path routes and OG cards

#1459 asked for path routes.  The app is still `/?view=trades`.  OG cards already key off query params (`ogMeta.ts`).  Dynamic per-person OG (Satori) is still backlog from August 11.  Do not block parity work on either.

#### F19. Review Queue operator UX

Present and admin-only (correct).  After #1954, chips name the model.  Remaining upgrades: confirm on Reject (F7), keyboard j/n/r, `aria-live` on row resolution, and a pending count that is a live region.  Do not build a consumer Review tab on iOS.

The in-flight ops catalog (`cursor/prod-incident-audit-f506`) is a **different** surface: stranded-filing list, no bulk actions.  Keep it off the product tab.

#### F20. Performance

| Surface | What is fine | What is not |
|---|---|---|
| Web Trades | server pages 25–250; lazy avatars/logos | sticky header + sticky filters + sticky thead (compositor cost, already mitigated) |
| iOS Trades | `LazyVStack` / `LazyVGrid`; 3× retry; poll 15–300s | `AsyncImage` with no shared cache — logos refetch on scroll |
| Web Directory | full roster in one scroll box; ~379 people | **no virtualization**; Assets ~4k rows in DOM |
| iOS Directory | local pager over full roster; 5 / 30 min TTL | same download; `isOffline` lie; no SwiftData persist (Aug 11) |
| Web Trends | IntersectionObserver defers speed-proof | `loadTrends()` ~12 parallel fetches; desktop forces all `<details>` open; tables unbounded height |
| iOS Trends | custom 12-bar chart (not Swift Charts) | same fan-out; no retry |
| Both Directory APIs | gzip is small (Aug 11: 13.7 KB / 72 KB) | `cache-control` advertised, Cloudflare `DYNAMIC` — Cache Rule still not applied |

**Fix (cheap):** Cache Rule for `GET /api/members` and `GET /api/assets` (owner go-ahead; verify `cf-cache-status: HIT`).  **Fix (iOS):** image cache.  **Do not** add server paging to Directory — it would break instant search for the same bytes (Aug 11 measurement still the right design).

#### F21. Copy nits

| Copy | Surface | Rule |
|---|---|---|
| `SHOW ↓` / `HIDE ↑` | web mobile folds | Title Case |
| `politicianLine` comment "Sen. Name · D-CA" | iOS | comment is stale; runtime is House/Senate/Executive |
| Independent as `I` (iOS) vs `O` (web party bucket) | cards | pick one letter for Other / Independent |
| "Not recorded" | web committees | #1965 |
| "Request failed" | iOS Trends/Delivery | F4 |
| Two spaces | most Premium/disclaimer strings | keep; do not "fix" brand periods |

Asset-class dropdown: **do not put it back.**  `$` min/max on Trades/Trends: **do not put it back.**

---

## Review Queue (product, not ops)

Web `#view-review` is the human workflow for scanned / low-confidence filings.

| Control | Behavior on `main` |
|---|---|
| Pending / Resolved Reviews | `setReviewTab` |
| Review / Confirm | `openQueuedReviewEditor` — edit rows, consensus, bake-off |
| Manual | `source=manual` hand-key |
| Reject | immediate POST (F7) |
| Retry auto | `/retry-auto` |
| Unpublish / Reopen | resolved tab |
| Document open | **stored R2 copy only** (`openStoredFiling`) — never the government URL |
| All Filing Decisions | append-only `ingestion_decisions` including auto-published rows |
| Admin · Cadence → Review Queue Maintenance | `POST /api/admin/reprocess` (batch, not per-doc) |

iOS has no Review Queue.  Keep it that way.

Auth failure copy already points at `admin.congress.trade`.  Stale local `ADMIN_TOKEN` fallthrough to session was #1684.

---

## Recommended sequence

Do these as small PRs.  Do not batch them with extract / halt / billing.

1. **Merge #1967 and #1965** (already up).  Re-audit F2, F3, F9-owner, F10, F11-delete after they land.
2. **P1 iOS inbound links** (F1) + **relative photo URLs** (F6) — one iOS PR.  Needs a Mac/`xcodebuild` seat.
3. **P1 Trends retry + copy** (F4) — iOS store + `APIClient` message map.  Small.
4. **P1 ticker drawer contract** (F5) — client API fields first, then iOS UI.  Socialize if the envelope grows.
5. **P1 Review Reject confirm** (F7) — web-only, admin tab.
6. **P2 filter URL + iOS persist** (F8) — web `fpa`, iOS `savedFilters`.
7. **P2 card filed-relative + optional photo ring** (F9 remainder) after #1965.
8. **P2 Trends By Party + Largest Buys/Sells + empty copy** (F12).
9. **P2 a11y skip-link + drawer title + reduce-motion** (F14).
10. **P3** Ledger on iOS, path routes, OG cards, Review keyboard, Directory Cache Rule.

Stop after step 5 if the goal is "stop shipping the same punch list."  Steps 6–9 are the consistency pass.  Step 10 is upgrade.

---

## What this audit is not

- Not a live WCAG contrast lab.  Party dots and lag red were not measured numerically.
- Not a re-measure of the Aug 11 sector-taxonomy collision or `/api/members` TTFB.  Those findings stay in `docs/ux-findings-2026-08.md` until someone hits the live endpoints again.
- Not the ops Review Queue catalog, OCR path, Coolify overlap, or latency corpus.
- Not a TestFlight visual QA.  iOS claims are source-backed; #1965/#1967 iOS bits will not be on a phone until the next hourly ship after merge.

---

## Files to touch (when someone implements)

| Fix | Likely files |
|---|---|
| F1 inbound links | `clients/ios/CongressTrade/App.swift`, new `AppRoute`, entitlements (human Xcode), `APIClient.shareURL` |
| F2 / F3 | already in #1967 — `dashboardHtml.ts`, `delivery/rest.ts`, `delivery/rows.ts` |
| F4 | `CongressTradeStore.swift`, `APIClient.swift` |
| F5 | `app/src/client/routes.ts`, `TickerDetailView.swift` |
| F6 | `Components.swift` `MemberPhotoURL` |
| F7 | `dashboardHtml.ts` `resolveReview` |
| F8 | `syncFilterUrl` / `restoreFiltersFromUrl`; iOS store launch |
| F9 | `TradeCard` in `FeedDashboardView.swift` |
| F10 / F11 | already in #1965 |
| F12 | `TrendsView.swift` |
| F14 | `dashboardHtml.ts` chrome; iOS `App.swift` / animations |
| F20 Cache Rule | Cloudflare zone config — not app code; owner go-ahead |
