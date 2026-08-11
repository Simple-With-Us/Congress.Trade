# iOS ↔ Web Parity & UX Backlog

Owner punch list captured 2026-08-10 (CLAUDE seat). Wave 1 is in flight on branch
`claude/ios-settings-ux`; everything below Wave 1 is queued and must not be dropped.

Evidence for every "confirmed" claim was gathered from live production API reads and
code inspection, not assumption. File:line references are against `main` at capture time.

---

## Wave 1 — in flight

Settings/sign-in rebuild, header quick menu → large sheet, nav chrome, filter indicator,
trades count, sort/pagination unification, sector taxonomy. See PR body for the full list.

---

## Wave 2 — queued

### A. Misleading or wrong numbers (highest priority — these ship wrong today)

- **A1. Top Performers shows the wrong statistic.** `TrendsView.swift:441` renders
  `avgAnnualizedExcessReturn`; the web (`dashboardHtml.ts:9584`) renders `avgExcessReturn`,
  and the API **sorts by** `avgExcessReturn`. The backend's own comment
  (`analytics/routes.ts:753`) calls the annualized field *"reference/debugging only … NOT
  what the board sorts or displays by."* Live at `window=90d`: honest column tops out at
  **5.7%**, annualized column reads **41.4 / 26.4 / 22.5 / 41.2 / 21.9 / 21.9 / 22.2%**.
  This is why iOS disagreed with the website *and* why the list looked unsorted — the rows
  arrive sorted by one field and are painted with another. `Models.swift:1132` does not
  decode `avgExcessReturn` at all; add it.
- **A2. Same bug, second site.** `PoliticianDetailView.swift:168` also shows the annualized
  field and captions it *"matches Top Performers"* — doubly wrong. Web's equivalent caption
  shows the non-annualized value (`dashboardHtml.ts:10326,10344`).
- **A3. Disclosure Timeliness renders two permanently wrong tiles.** `FilingLagSummary`
  (`Models.swift:1171`) decodes `avgLagDays` / `lateCount` / `maxLagDays` / `totalTrades`,
  none of which the API returns. Verified live — `/api/analytics/filing-lag?window=90d`
  returns exactly `{count, distribution, medianLagDays, overFortyFivePct, p90LagDays}`.
  Every field is Optional so decoding never failed; it silently produced **"Avg Delay:
  0 days"** and **"Late Filings: —"** forever. Replace with the web's set: Median / P90 /
  >45-day %. Note `SlowFilerItem` (`Models.swift:1179`) IS correctly shaped — the bug is
  isolated to the summary struct.
- **A4. Benchmark naming.** Say "vs S&P 500" once in the section description; drop the
  per-row `vs SPX` (`TrendsView.swift:442` is the only literal ticker-abbreviation string
  on either platform). No "SPY" exists anywhere.
- **A5. Top Performers guardrails** (owner: "prone to having wild numbers ... want to be
  sure it isn't misleading"): show the active window and the minimum-buys threshold on the
  card, plus a one-line plain-English methodology note.
- **A6. Net Flow sign.** Prefix positive values with `+` everywhere (Market Snapshot KPI,
  sector rows, market-cap rows) — do not rely on green/red alone. Accessibility as well as
  clarity.
- **A7. Non-tickered trades must not pretend data is pending.** `TradeDetailView.swift:267`
  always renders the "Performance vs S&P 500" section; with no ticker it falls through to
  *"will appear when market data is available for this ticker"* — false, it never will.
  **The website has the identical bug** (`dashboardHtml.ts:9936`, `10434-10472`). Hide the
  card entirely when there is no resolved ticker; use a concise honest phrase instead. The
  options case is already correct on both platforms — keep it. Client predicate must mirror
  `TICKER_RESOLVED_SQL` (`analytics/sql.ts:166`): non-empty AND not in
  `NONE / -- / N/A / NA / NULL / —`, because client rows are a raw passthrough of
  `row.ticker` with no server-side sentinel filtering.

### B. Layout and chrome

- **B1. By Market Cap column spacing** — widen the far-right value column, narrow the
  cap-size name; keep middle and right columns right-aligned.
- **B2. Sticky filter + search bar on Trends** so the timeframe stays visible while
  scrolling. Owner confirmed a single small row. Per-section timeframe labels are **not**
  needed: verified that `refreshTrends()` passes `analyticsWindow` to every analytics call
  (`CongressTradeStore.swift:469-479`), so no section disagrees with the pill.
- **B3. Brand lockup on every tab**, identical size and spacing, nudged ~6pt up (≈2mm at
  460 ppi). Today only Trends and Trades carry `BrandTitle`; Directory / Delivery / Settings
  fall back to a plain text title. No large left-aligned titles anywhere — inline only.

### C. Parity and features

- **C1. Asset Directory.** On web this is a People/Assets segmented toggle inside the one
  Directory tab (`dashboardHtml.ts:2617`, `setDirectoryMode()` at `9082`), not a separate
  tab. Backed by `GET /api/assets` (`delivery/rest.ts:1195`): public, unauthenticated, takes
  **no query params**, returns the entire roster
  `{assets:[{ticker,name,assetClass,txCount,memberCount}],count}`, 30-min KV cache. Search
  and sort are client-side. Needs a new `AssetDirectoryEntry` model — no existing iOS type
  matches that shape.
- **C2. Remove the Settings tab** → `Trends | Trades | Directory | Delivery`, matching the
  website's non-admin nav. **Blocking prerequisite:** these live only in Settings today and
  would become unreachable — Google sign-in, magic-link email, the "session could not be
  verified" recovery retry, the push-notification block, and the legal links. Wave 1 moves
  most into the header menu; verify all five before deleting. Also `Components.swift:637`
  sets `tabRouter.selection = .settings`; it becomes a silent no-op (no crash) and must be
  repointed.
- **C3. District.** Web shows it in three places — directory rows (`:9051`), Most Active
  Politicians (`:9731`), politician header (`:10253`, "17th District"). iOS shows it only in
  directory rows (`PeopleDirectoryView.swift:207`). Add to the Trends leaderboard and the
  politician header. The leaderboard needs a **backend change** — `member-leaderboard` never
  selects `district`, so `MemberLeaderboardItem` cannot decode it. The client API already
  returns it for member detail (`client/utils.ts:325`). iOS already has the ordinal
  formatter (`CompactFormat.districtOrdinal`).
- **C5. Directory needs pages, like the Trades tab** (owner 2026-08-10). Today both platforms load the entire
  roster and render every filtered row at once: iOS `PeopleDirectoryView` renders `filteredMembers` in one
  `LazyVStack` with no pager, and `GET /api/members` / `GET /api/assets` are deliberately full-roster endpoints
  (30-min KV cache, no query params — see C1). So this is a **client-side** pager over an already-loaded array,
  NOT a server round trip — do not add offset params to those endpoints and lose their cacheability.
  Reuse the **same** pagination component Wave 1 is restyling for Trades (`FeedPaginationBar`) rather than
  authoring a third one — the design review's RC6 counts 34 controls collapsing to 10 distinct
  (height|radius) pairs, and a bespoke directory pager would make it 11. Same for the web.
  Applies to People **and** the new Assets mode. On desktop web this also mitigates D55
  ("Assets table: 67% unreachable"), though that has its own container fix.
  Page size should match the Trades set once Wave 2 reconciles it with web's 25/50/100/250.

- **C4. Asset-class filter** — one dropdown, "All" / "Public Equities, Funds, & ETFs".
  Maps to `public_equity` + `fund` in `shared/assetTypes.ts` (`fund` covers ETFs and mutual
  funds). Must be a **server-side feed param**, not client-side: `clientTradeFromRow`
  (`client/utils.ts:228`) currently sends only the raw House code and drops
  `assetTypeCategory`, and a client-only filter would re-break the trade count and
  pagination that Wave 1 just fixed. Expose `assetTypeCategory` on client rows. Add to web
  for parity.

### D. Asset-name data quality

Owner approved: fix the parser for new filings **and** backfill existing rows, with a
**dry-run report for approval before any write**. Rate/maturity goes to Notes text only
(no new columns). Original name preserved in the audit note so the change is reversible.

- **D1. Strip bracketed tokens.** Two distinct kinds found across 4,500 sampled rows —
  real type codes leaking (`… [CS] REDEMPTION`) and **footnote markers** (`[1]`, `[2]`,
  e.g. `Us Treasury Bills Due 04/01/2021 [1][2]`) which carry no information. Stripping only
  known asset-type codes would leave the footnote markers behind.
- **D2. Rate/maturity → Notes.** The Senate eFD emits a rigid machine format that parses
  deterministically: `Owens & Minor Rate/Coupon: 3.875% Matures: 09/15/2021` → name
  `Owens & Minor`, note `3.875% coupon, matures 09/15/2021`. ~8% of recent rows. A second
  rigid pattern is `Due MM/DD/YYYY` + a standalone `5.000%`. Reuse the existing
  `cleaning_note` column and `plainCleaningNote()` (`shared/cleaningNote.ts`), already
  surfaced as the web "Notes" column.
  **Known limit — do not attempt:** `Carroll Cnty Ga SCH Dist Go 5% 04/01/27 Ao (Muni)
  Rate/Coupon: 5.0% Matures: 04/01/2027`. After stripping the rigid suffix the inline
  `5% 04/01/27` remains and is genuinely part of the muni's name. Leave inline forms alone.
- **D3. Exchanges.** The PTR form provides **one asset and one ticker per row** — there is
  no from→to pair in the disclosure, so the second leg cannot be recovered and must not be
  invented. Of 324 exchange rows, some filers cram both legs into the name
  (`Ysleta Texas Independent School District Ref Bond (Exchanged) Ysleta T…`), most give one
  (`Fortive Corporation`). Label plainly; move an explicit `(Exchanged)` marker into Notes.
  **Already correct, do not "fix":** exchanges contribute exactly `0` to net flow —
  `SIGNED_MIDPOINT_SQL` (`analytics/sql.ts:148`) signs only `B`/`P` and `S`.

---

## Wave 3 — parity gaps found by audit, awaiting owner priority

- **Delivery:** iOS cannot set per-subscription Tickers (silently reuses the global
  watchlist — `CongressTradeStore.swift:691`), Sides, or Min Amount. Web supports all three.
- **Trades:** no $ min/max filter; 2 sort keys vs web's 12; page sizes 50/100/200 vs web's
  25/50/100/250; no jump-to-first/last.
- **Trends sections absent on iOS:** Party Split, Sector Breakdown (asset-type based, distinct
  from GICS Net Flow by Sector), Committee Sector Conflicts. KPI tiles lack the Assets count
  and Buy Pressure; web KPI tiles also carry sparklines.
- **Company drawer:** iOS lacks Buy Pressure, the buys/sells time chart, "Performance After
  Buys" backtest, and Top Buyers/Sellers. Root cause: iOS calls
  `/api/client/v1/ticker/:t` (returns only `{ticker,asset,summary,items}`) while web's drawer
  calls `/api/analytics/ticker/:t` plus `/backtest`. Decide whether iOS adopts the analytics
  endpoint or stays intentionally lighter.
- **Dynamic per-person OG cards.** Feasible on Workers via Satori → resvg-wasm, cached at the
  edge (`/og/politician/:id.png`). Costs ~1.5–2 MB wasm in the bundle plus an embedded serif
  font subset. Would let a shared link read "Diana Harshbarger · TN-1 · 47 disclosed trades".
- **Sector taxonomy, remaining half.** Wave 1 canonicalizes the labels. Still open: both
  `sector-flow` and `market-cap-breakdown` gate on `TICKER_RESOLVED_SQL`, so trades with no
  resolved ticker are excluded from **both** charts entirely and are invisible to the user.
  That is a product decision, not a bug — but it is currently undisclosed in the UI.
