# Web UI Expert Review — Congress.Trade Dashboard

**Date:** 2026-08-10  
**Reviewer:** Product UI/UX (read-only code + production sample)  
**Primary surface:** `app/src/ui/dashboardHtml.ts` (~11k+ lines, single HTML+CSS+JS template)  
**Related tests:** `app/src/ui/__tests__/dashboardHtml.test.ts`  
**Fleet copy:** `docs/FLEET-UI-COPY.md`  
**Live spot-check:** `https://congress.trade/` + `GET /api/health` + `GET /api/transactions?limit=3`  
**Prior reviews consulted:** `docs/reviews/2026-08-06-full-product-review.md`, `docs/reviews/2026-07-28-full-app-review.md`

---

## Method

1. Walked header, tablist, each public tab (Trends, Trades, Directory, Delivery), drawers, auth/pricing modals, footer, and mobile breakpoints in `dashboardHtml.ts`.
2. Traced interaction handlers (`handleEntityOpenEvent`, `renderTrades` / `tradesCardHtml`, `setTradesKpis`, pager, `renderAccount`, `openTrade` / `openMember` / `openAsset`, export/gate row).
3. Sampled production HTML shell and public APIs for live state (health stalled; feed total ~85k).
4. Did **not** re-implement product code. Owner-in-flight fixes are called out as **Owner-fix** and assumed landing; residual risk is noted if still broken after they land.

### Owner fixes currently shipping (do not re-do)

| # | Fix | Code state at review time | Residual risk after land |
|---|-----|---------------------------|---------------------------|
| 1 | Export CSV into options/menu (not lone bottom button) | Still `#exportCsvBtn` in `#gateRow` (~2298–2301) + dialog | Low if menu + gate-row cleanup both land |
| 2 | Sign In + Upgrade cohesive control group | Separate ghost/primary buttons in `renderAccount()` (~10373–10375) next to theme seg | Medium — theme may still break visual grouping |
| 3 | Trades upper-right count = filtered match total, not page size | `setTradesKpis()` uses `totalRows` from API; filters go through `tradesFilterParams()` | Verify after land: poll path + page-local filters must not overwrite |
| 4 | Pagination top **and** bottom of trades list | Only one `.pager` block under the table (~2282–2297) | Medium — top clone must share disable/state with bottom |
| 5 | Entire trade row/card opens details; easy politician/company from drawer (no magic nested feed targets) | Feed still has nested `data-member` / `data-asset` on cells (~3658–3694, ~3729–3731); drawer already has clear cards + “View All…” links (~10176–10224) | High if feed nesting remains; drawer paths look solid |

---

## Overall UX grade: **B−**

A mature, data-dense disclosure product with real accessibility bones (tabs, focus traps, reduced motion, entity keyboard reachability) and honest Premium/disclaimer framing. The SPA-in-a-string architecture has accumulated years of owner punch-list polish, but **interaction model on Trades**, **tool density**, and a few **trust/placement** issues keep it from A/B territory for first-time users.

### Three top wins if shipping now

1. **Trends as the free landing surface** — KPI strip, consensus, sector/cap flow, timeliness, and honest latency methodology give a complete “why this product exists” story without sign-in.
2. **Drawer system** — trade → politician/company drill-in, sticky topbar summary, source filing link, performance framing, and shareable deep links (`?trade=` / `?ticker=` / `?member=`) are product-grade.
3. **Delivery education + gated management** — clear webhook vs SSE cards, account gate with trial CTA, secrets-shown-once honesty, and $5/$50 pricing consistency.

---

## What's working well

- **Tab architecture:** `role="tablist"` / `tabpanel` / `aria-selected` / `aria-hidden`; mobile bottom bar with `data-icon` + `data-mobile` labels; admin tabs fail-closed until `/auth/me`.
- **Shared filters (Trades ↔ Trends):** chamber/party/side chips + shared window selects; ⓘ popover teaches pictographs (important because H/S/P is opaque).
- **Trades table engineering:** column registry, chooser + drag reorder, resizable columns with versioned localStorage, page-size persistence, mobile sort control, public offset cap with Premium CSV toast.
- **Loading / empty / error:** skeleton helpers on Trends; calm dashed empty frames; banner for feed load failure; toasts for auth/checkout outcomes.
- **A11y foundation:** focus trap on drawer + login/pricing; Escape closes overlays; `MutationObserver` adds `tabindex`/`role=button` to entity targets; `prefers-reduced-motion` honored.
- **Theme:** Light / Dark / System segmented control (ST parity); mobile hamburger avoids brand collision (#1456).
- **Footer honesty:** STOCK Act educational disclaimer + Privacy / Terms / Pricing / RSS / Support.

---

## Findings by severity

### P0 — Broken / confusing / trust-breaking

#### P0-1 — Nested click targets on Trades feed (politician / asset steal the row)

- **What's wrong:** Clicking a table row is advertised as “Open trade details” (`title` on `<tr class="row clickable" data-txid="…">`), but `handleEntityOpenEvent` prioritizes `data-member` → `data-asset` → `data-txid`. Politician and asset cells are independent targets. Mobile cards similarly nest a tappable member chip. Users learn an unpredictable hit-map (“sometimes politician, sometimes company, sometimes trade”).
- **Where:** `memberCellHtml` / `assetCellHtml` (~3658–3694); `tradesCardHtml` (~3729–3745); `handleEntityOpenEvent` (~11119–11150); row render (~4132–4138).
- **Recommended fix:** Feed rows/cards: **only** `data-txid` (whole surface opens trade). In trade drawer (already good): large politician + company cards + “View All Trades by/of …” links. Optional: long-press or overflow “Open politician / Open company” on desktop only if needed later.
- **Owner-fix:** **Yes — #5.** After land, re-verify mobile cards and keyboard Enter on focused row.

#### P0-2 — Dual “Search” mental model on Trades (server filter vs page-local filter)

- **What's wrong:** Visible `#qSearch` is the real server-side search. Separately, `🔍 Search` (`#searchToggle` → `#searchPanel`) is labeled **“Filter this page”** and only filters already-loaded rows (`qAll`, min/max $). Panel copy still says “Use the Ticker / Politician toolbar fields…” — those dedicated fields are gone (hidden legacy `#qMember` / `#qTicker`). Power users and newcomers both misfire: they think Search re-queries the corpus, then wonder why totals / pager disagree.
- **Where:** toolbar ~2227–2237; panel ~2263–2272; `renderTrades` page filters ~4112–4125; count logic ~4171–4185.
- **Recommended fix:** Rename toggle to **“Page Filters”** or fold amount filters into the options menu; rewrite panel copy to match `#qSearch`; or delete page-local search if usage is near-zero. Never use the word “Search” for both.
- **Owner-fix:** No (orthogonal).

#### P0-3 — Latency scoreboard undercuts Premium on Delivery (placement / trust)

- **What's wrong:** Filing Latency Comparison renders on public surfaces including the Delivery/marketing path. When competitors win most races (known from 2026-08-06 review), the Premium pitch “Get the Filing First” sits next to data that can say the opposite. Methodology is careful and honest — placement is the product bug.
- **Where:** `speedProofSectionHtml` injected on Trends (~2507) and Admin; Delivery also surfaces related speed mini content (`#alertsSpeedMini`); prior issue #1455.
- **Recommended fix:** Keep scoreboard on Trends (and Admin) only; on Delivery use qualitative “we push the instant we ingest” without peer win-rate cards until CT leads, **or** reframe as “transparency ledger” on a dedicated `/latency` route linked from footer.
- **Owner-fix:** No (product decision still open).

#### P0-4 — Data identity / quality still leaks into UI (trust)

- **What's wrong:** Prior defects still shape user trust: duplicate politician identities, seed vs primary duplicates, raw asset names. Default API sample without UI sort returns 2020 seed rows first; UI does request `sort=tx_date&order=desc`, but any regression or “Primary Only” confusion re-surfaces historic noise. Live health at review: `status: stalled`, extraction success ~46%, review backlog 246 — not pure UI, but users feel “stale / messy.”
- **Where:** Primary-only client filter in `renderTrades` (~4112–4116); seed rows in API; health endpoints.
- **Recommended fix:** Prefer server-side primary default for public feed; surface a quiet “Showing primary filings” chip when historic seeds are hidden; keep data-quality work as the real P0 (board #1452/#1453 lineage).
- **Owner-fix:** Partial (dedupe mode already in code; not the five chrome fixes).

---

### P1 — Clear usability pain

#### P1-1 — Export CSV still a bottom orphan (+ Premium pitch bar)

- **What's wrong:** After a long table, users find `#gateRow` with a sales sentence and `⤓ CSV Pro`. Export is a list action, not a conversion footer. Mobile requires scroll past pagination to discover it.
- **Where:** ~2298–2301; `openExportCsvDialog` / `exportCsv` ~10609–10655; tests still lock CSV into gate-row (~2659–2682 in test file).
- **Recommended fix:** Options (⋯) menu next to Columns / page size: Export CSV, Columns, maybe Page Filters. Keep Premium upsell once (Delivery or pricing modal), not as the feed’s structural footer.
- **Owner-fix:** **Yes — #1.** Update tests that assert gate-row placement when landing.

#### P1-2 — Pagination only at bottom

- **What's wrong:** With 50–250 rows, changing page requires scrolling to the footer pager every time. Desktop power use and mobile cards both suffer.
- **Where:** single `.pager` ~2282–2297; `updateTradesCountMsg` only binds one set of button IDs.
- **Recommended fix:** Clone a slim top pager (range + prev/next; optional page size only on bottom). Share state via class-based query or dual IDs updated in one function. Scroll-to-top of `#view-trades` / table on page change.
- **Owner-fix:** **Yes — #4.**

#### P1-3 — Sign In / Upgrade not one control group

- **What's wrong:** Guest desktop chrome is `[Theme seg] [Sign In ghost] [Upgrade solid]` as independent chips. Visually competes with brand + tabs; not a single “account cluster.”
- **Where:** `renderAccount` ~10369–10420; CSS `.acct-desktop` ~996–997.
- **Recommended fix:** Segmented or pill group: Sign In | Upgrade (shared border, one radius), theme as icon-only neighbor (ST pattern). Logged-in: avatar menu absorbs Upgrade when free.
- **Owner-fix:** **Yes — #2.**

#### P1-4 — Upper-right count semantics (verify filtered total)

- **What's wrong:** Owner reports count can read like page size (e.g. “100”) rather than filtered corpus total. Code path: `totalRows` from `/api/transactions` → `kpiTotal` via `setTradesKpis()` (~4638–4640, 4659). Filters are applied in `tradesFilterParams()`. Risk remains if: (a) UI shows page length somewhere unlabeled, (b) page-local filters don’t change the upper total (by design) without explaining that, (c) mobile hides “today” but total still confusing.
- **Where:** `#tradesStats` / `#kpiTotal` ~2235–2236; mobile CSS that drops `.stat-today`.
- **Recommended fix:** Label explicitly: **`12,480 matching`** (or “matches filters”); never bare “total” next to a 50-row table. If page-local filter active, show secondary “N on this page.”
- **Owner-fix:** **Yes — #3** (confirm post-land with filtered chamber + search).

#### P1-5 — Directory load UX

- **What's wrong:** People/Assets show plain “Loading directory…” with no skeleton; historical slowness on `GET /api/members` left the tab feeling broken (prior #1454). Assets mode reuses people search placeholder semantics inconsistently (“name, state, party” while in Assets).
- **Where:** markup ~2510–2547; loaders ~8716+.
- **Recommended fix:** Skeleton rows (reuse `skRows`); progressive first paint; mode-aware placeholder (“Search ticker or company…”); keep chamber filter visible only for People.
- **Owner-fix:** No.

#### P1-6 — Public offset cap vs “Page X of Y”

- **What's wrong:** `lastTradesPage` / max page clamps to `MAX_PUBLIC_TRADES_OFFSET`, but `tradesPageMsg` can still say “Page N of M” where M is full `ceil(total/pageSize)`. User hits “last” and lands short of true last page with a toast about Premium CSV — correct business rule, muddy chrome.
- **Where:** ~4145–4197, ~4787–4814.
- **Recommended fix:** Cap displayed page count to reachable pages; footnote “Browse limited; full history via Export (Premium).”
- **Owner-fix:** No.

#### P1-7 — Trends length + default-all-open on mobile

- **What's wrong:** Landing Trends is a long scroll of many open sections (tickers, rising, consensus, chart, sector, cap, performers, politicians, party, asset type, timeliness, conflicts, latency). Desktop fold cues are intentionally non-collapsing ≥769px; mobile has SHOW/HIDE but everything starts open — first-screen overload.
- **Where:** sections ~2358–2507; fold CSS ~1686–1697.
- **Recommended fix:** Mobile default: open Snapshot + What Congress Is Trading + Consensus; collapse the rest. Keep desktop open if analytics density is intentional.
- **Owner-fix:** No.

#### P1-8 — Filter pictographs still high-learning-cost

- **What's wrong:** H / S / P and party emojis are compact but not self-explanatory without ⓘ. First-time mobile users may never discover the popover.
- **Where:** chip groups ~2191–2222 (and Trends twin).
- **Recommended fix:** First-visit coach mark once; or text labels under icons at tablet widths; keep letter chips for density on phone.
- **Owner-fix:** No.

---

### P2 — Polish / consistency

#### P2-1 — Fleet money casing

- **What's wrong:** `fmtBracketAmount` / `estUsd` use lowercase k/m/b (good); amount **tier** labels use `$1M` (`amountTier` ~3704–3705). Delivery min options use `$1m+` (good). Inconsistent.
- **Fix:** `$250k–$1m`, `Over $1m` everywhere.

#### P2-2 — Copy Title Case / casing drift

- **What's wrong:** Mixed control labels: `Rank By:` (ok Title Case) with select options `Distinct Politicians` / `Est. Volume`; Delivery select `webhook` (lowercase) vs `SSE`; pricing `SAVE ~17%` all-caps shout; Review admin sub copy leaks API paths (`POST /api/admin/...`) into UI for operators (acceptable for Admin, not for public).
- **Fix:** `Webhook` option label; `Save ~17%`; keep API hooks in Admin only.

#### P2-3 — Drawer performance / enrichment empty states

- **What's wrong:** `PERF_GATE` / `PROFILE_GATE` mention “once a market-data API key is configured” — operator language visible to all users when enrichment is missing.
- **Where:** ~9727–9728, trade drawer ~10211–10217.
- **Fix:** User-facing: “Price history isn’t available for this trade yet.” Reserve key language for Admin diagnostics.

#### P2-4 — Login modal a11y completeness

- **What's wrong:** Dialog has `aria-modal` and focus trap (good). Close control is a floated ×; no explicit `aria-labelledby` linking to `h2`. Magic-link path is solid.
- **Fix:** `aria-labelledby` / `aria-describedby` on both modals; initial focus on primary CTA.

#### P2-5 — No skip link / main landmark focus

- **What's wrong:** Keyboard users tab through full header/theme/account before content.
- **Fix:** “Skip to content” → `#view-*` active panel or `main`.

#### P2-6 — Delivery form density

- **What's wrong:** Create form is a long wrap of selects + full-width inputs; works but feels like an admin form on a marketing tab. Empty state for signed-out is clear.
- **Fix:** Progressive disclosure: Channel → Target → “Add filters” expander.

#### P2-7 — `#drawerTopbarTitle` marked `aria-hidden="true"`

- **What's wrong:** Sticky summary is useful for sighted users but hidden from AT even when populated (~2847).
- **Fix:** Remove `aria-hidden` when non-empty, or use `aria-live="polite"` on open.

#### P2-8 — Consensus / Trends click affordances

- **What's wrong:** Clickable rows get good hover rails on Trends (desktop); cluster cards less obviously interactive than table rows.
- **Fix:** Chevron or “View” affordance on cards (mobile especially).

#### P2-9 — Banner always in DOM for all tabs

- **What's wrong:** `#banner` sits above all views; mostly cleared after load, but initial “Connecting to the live feed…” is Trades-centric on a Trends-default app.
- **Fix:** Scope banner to Trades or generic “Loading Congress.Trade…”.

#### P2-10 — Deep-link / view alias residual confusion

- **What's wrong:** Aliases `feed→trades`, `delivery→subs` exist (~11300–11305); good. Unknown views silently fall back. Directory is `people` in URLs — fine if documented.
- **Fix:** Document in footer “Share links” or `/docs`; optional 404 toast for unknown `view`.

---

### P3 — Nice-to-have

| ID | Finding | Note |
|----|---------|------|
| P3-1 | Emoji party animals (donkey/elephant) may fail on some OS fonts | Fall back to D/R text if emoji width is 0 |
| P3-2 | `article.trades-card` chevron is decorative only | Fine; ensure whole card hit area ≥44px height (mostly OK) |
| P3-3 | Toast duration fixed 4.2s | Allow longer for multi-sentence Premium messages |
| P3-4 | Column chooser dialog vs native `dialog` for export | Unify panel primitives |
| P3-5 | RSS in footer is a power feature | Add one-line tooltip “Public trade feed” |
| P3-6 | Admin Review UI is utilitarian | OK for admin; don’t polish at expense of public tabs |
| P3-7 | iOS parity cards (`#1529`) on web | Keep visual language aligned with TestFlight screenshots |

---

## Surface-by-surface notes

### Header

- Brand lockup + tabs + account is the right structure.
- Mobile hamburger (#1456) is the correct fix; disclaimer inside menu is clever but long — keep short line only.
- **After owner #2:** ensure theme icons don’t re-break the new Sign In/Upgrade group width.

### Trends

- Strongest free surface; window labels on every section are excellent for trust.
- “Est. Volume” / midpoints need the existing tips — keep them.
- Latency block: methodology excellence, marketing risk (P0-3).
- Empty/loading: better than Directory.

### Trades

- Heart of the product; densest UX debt (search duality, nested targets, bottom-only pager, CSV orphan).
- Mobile cards are close to iOS parity — good direction once nested member chip is removed (owner #5).
- Columns/page size in pager tools: correct placement.

### Directory (People / Assets)

- Clear mode toggle; sort-by-header works.
- Needs skeletons, mode-specific search, and faster API (backend).
- No pagination for large directories — consider virtualize or “load more” if member list is full Congress + historical.

### Delivery

- Education section is best-in-class copy for a developer-facing Premium feature.
- Gate states (signed out / signed in free / premium) are clear.
- Avoid latency scoreboard collision (P0-3).
- Form labels: Title Case channel names.

### Drawers (trade / politician / company)

- Trade drawer structure (transaction first, identity cards, performance, details, company, links) matches how journalists and traders think.
- Easy paths to politician + company already present in drawer — align feed with that (owner #5).
- Soften enrichment gate copy (P2-3).

### Auth / pricing modals

- Google + magic link is the right pair.
- Pricing features list matches product decisions (delivery + CSV + PDF).
- Trial note clear; avoid “You’re in!” emoji if brand goes more institutional (optional).

### Mobile vs desktop

- Bottom tabs: native-feeling.
- Filter chip 2-line layout carefully engineered — don’t break.
- Landscape phone media queries present — good.
- Safe-area padding on drawer and tabs — good.

### Empty / error / loading

- Trends: strong.
- Trades: text states OK; consider skeleton rows for first fetch.
- Directory: weak (P1-5).
- Network errors: banner + toast — ensure Delivery load errors stay in-table (they do).

### Accessibility

- Above average for a bespoke dashboard.
- Gaps: skip link, topbar `aria-hidden`, nested interactive elements inside row buttons (violates “no interactive in interactive” and confuses SR users) — fixed by owner #5 if nesting removed.
- Sortable `th` with `role=button` is acceptable; ensure `aria-sort` stays synced (it does in code).

---

## Prioritized punch list (max 12) — **after** owner fixes land

1. **Re-verify owner #1–#5 on prod** (desktop + 375px): CSV menu, auth group, filtered total, dual pager, whole-row open + drawer links only.  
2. **Kill dual Search** — rename/remove page-local “Search”; fix stale panel copy (P0-2).  
3. **Latency widget placement decision** — Trends-only or `/latency`; never under Premium hero (P0-3 / #1455).  
4. **Directory skeletons + mode-aware search** (P1-5).  
5. **Pager page-count vs public offset cap** — honest “Page X of Y (browsable)” (P1-6).  
6. **User-facing enrichment empty copy** — drop API-key language (P2-3).  
7. **Fleet money casing** `$1m` in amount tiers (P2-1).  
8. **Mobile Trends default-collapse** secondary sections (P1-7).  
9. **Skip link + modal `aria-labelledby`** (P2-4, P2-5).  
10. **Delivery create form progressive disclosure** (P2-6).  
11. **Filter first-run coach** for H/S/P + party chips (P1-8).  
12. **Data trust follow-through** — primary-default feed, member identity merge (P0-4 / prior #1452–#1453).

---

## Regressions & tests that should exist

| Area | Suggested assertion / test |
|------|----------------------------|
| Owner #1 CSV menu | `#exportCsvBtn` **not** sole child of bottom gate; options control present; `openExportCsvDialog` still Premium/sign-in gated |
| Owner #2 auth group | Guest header contains a single grouped control wrapper (class stable) with Sign In + Upgrade |
| Owner #3 counts | With mocked `/api/transactions` `{ total: 1234, transactions: length 50 }`, `#kpiTotal` shows `1,234` not `50` |
| Owner #4 dual pager | Two `aria-label="Trades pagination"` (or top/bottom labels); `updateTradesCountMsg` disables both next buttons together |
| Owner #5 row open | Feed HTML for a row: **no** `data-member` / `data-asset` inside `[data-txid]`; trade drawer still has both |
| Search copy | `searchPanel` must not mention removed “Ticker / Politician toolbar fields” |
| Pager cap | When `total > MAX_PUBLIC_TRADES_OFFSET`, last page index === `maxReachableTradesPage` and UI page count matches |
| Money casing | No `$1M` / `$3.4B` user-visible strings (fleet) |
| Delivery gate | Signed-out gate includes Sign In; free user sees Start Free Trial; premium hides cue |
| Entity a11y | `.clickable[data-txid]` rows have `tabindex=0` without nested buttons |
| View aliases | `?view=feed` → trades, `?view=delivery` → subs (string + boot path) |

Existing suite is strong on parse safety, Trends wiring, HSP filters, speed-proof honesty, mobile hamburger, and pager IDs — extend rather than replace.

---

## Live production snapshot (review time)

- **Health:** `ok: true` but pipeline `status: "stalled"` (autopilot quota halt; extraction degraded; DLQ 80; review backlog 246; data freshness OK ~7h). UI should not claim “all systems green” if a status chip is ever added.
- **Feed scale:** `total` ≈ 85,807 transactions; `filingsImportedToday` ≈ 336 — upper-right count UX matters at this scale.
- **Default shell:** Trends active; all major sections present; Export still bottom-gated in shipped HTML.

---

## Grade rationale (summary)

| Dimension | Grade | Note |
|-----------|-------|------|
| Visual system / density | B | Coherent tokens; dense but intentional |
| Information architecture | B | Trends-first correct; Delivery clear |
| Interaction design (Trades) | C+ | Nested targets + dual search hurt |
| Trust & data presentation | C+ | Honest disclaimers; latency placement + data dups |
| Mobile | B− | Bottom nav good; Trends length + filter literacy |
| A11y | B | Strong bones; nested interactives + skip link |
| Premium conversion UX | B | Clear pricing; CSV/export placement weak |
| **Overall** | **B−** | Owner #1–#5 should lift Trades toward **B/B+** |

---

## Appendix — key code anchors

| Concern | Approx. location in `app/src/ui/dashboardHtml.ts` |
|---------|-----------------------------------------------------|
| Header / tabs | ~2150–2162 |
| Trades toolbars + stats | ~2168–2237 |
| Export dialog + gate row CSV | ~2240–2301 |
| Bottom pager only | ~2282–2297 |
| Trends sections | ~2306–2507 |
| Directory | ~2510–2548 |
| Delivery | ~2576–2653 |
| Drawer shell | ~2845–2848 |
| Login / pricing | ~2850–2900 |
| `tradesCardHtml` / cells | ~3658–3753 |
| `renderTrades` / pager msg | ~4093–4198 |
| `setTradesKpis` / `fetchPage` | ~4638–4680 |
| Offset cap toasts | ~4787–4814 |
| Delivery gate | ~5904–5944 |
| Drawer open/focus | ~9677–9714 |
| `openTrade` | ~10145–10270 |
| `renderAccount` | ~10369–10420 |
| Export / CSV | ~10609–10655 |
| Entity open priority | ~11113–11167 |
| View aliases | ~11300–11305 |

---

*End of review. No product code was modified in this pass.*
