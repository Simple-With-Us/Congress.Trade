# Congress.Trade — UX findings, defects, and parity backlog

Captured 2026-08-10/11 (CLAUDE seat) from an owner punch list, a three-surface UX audit, live production API
reads, and macOS crash reports.

**This file exists because the original notes were lost.** They lived only in a `/private/tmp` worktree that a
machine crash destroyed, along with a day of unpushed code. Everything below is reconstructed and committed
immediately. Push findings the moment you have them.

Every "confirmed" claim here was measured — live API responses, crash reports, or code read at a cited line.
Nothing is inferred. Where something is uncertain it says so.

---

## 1. Shipping-wrong numbers

These were on screen and wrong. None were reported by the owner; all were found by audit.

### 1.1 Top Performers displayed the wrong statistic — CONFIRMED

`TrendsView.swift:441` rendered `avgAnnualizedExcessReturn`. The website (`dashboardHtml.ts:9584`) renders
`avgExcessReturn`, and **the API sorts by `avgExcessReturn`**. The backend's own comment on the annualized field
(`app/src/analytics/routes.ts` ~753) reads: *"reference/debugging only … NOT what the board sorts or displays by
(a young trade's ~12x annualization multiplier made this misleading as the primary stat)."*

Live at `window=90d`:

| Politician | iOS showed (annualized) | Web shows (`avgExcessReturn`) | buys |
|---|---:|---:|---:|
| Cleo Fields | 41.4% | 5.7% | 10 |
| David J. Taylor | 26.4% | 4.7% | 18 |
| Gilbert Ray Cisneros, Jr | 22.5% | 4.4% | 115 |
| Richard McCormick | 41.2% | 4.4% | 8 |
| Ro Khanna | 21.9% | 4.0% | 56 |

**Two symptoms, one cause.** The inflated numbers, *and* the "odd order" the owner noticed: the API returns rows
already sorted by `avgExcessReturn` (monotonic 5.7 → 4.7 → 4.4 → 4.0 …), so painting a different column made a
correctly-sorted list look shuffled. `Models.swift:1132` did not decode `avgExcessReturn` at all.

Annualization is what inflates it: a trade held 30 days that beat the S&P by 3% extrapolates to ~43%/yr. On a
90-day window most trades are young, so the multiplier is large and noisy — which is how someone with 8 buys
outranks someone with 115.

### 1.2 The same bug, second call site — CONFIRMED

`PoliticianDetailView.swift:168` displayed the annualized field captioned *"matches Top Performers"* — false on
both counts. Web's equivalent caption (`dashboardHtml.ts:10326,10344`) shows the non-annualized value.
`leg.avgExcess` was already decoded on the same struct.

### 1.3 Disclosure Timeliness shipped two permanently-wrong tiles — CONFIRMED

`FilingLagSummary` (`Models.swift:1171`) decoded `avgLagDays`, `maxLagDays`, `lateCount`, `totalTrades`.
**None of them exist in the response.** Verified live — `/api/analytics/filing-lag?window=90d` returns exactly:

```json
{ "count": 1837, "medianLagDays": 22, "p90LagDays": 36, "overFortyFivePct": 0.0022, "distribution": [...] }
```

Every Swift field was Optional, so decoding never failed. It silently produced **"Avg Delay: 0 days"** and
**"Late Filings: —"** for every window, forever. Median Delay was the only correct tile on the card.

Web shows the right set: Median / P90 / >45-day %. `SlowFilerItem` (`Models.swift:1179`) *is* correctly shaped —
the bug is isolated to the summary struct, which looks copy-pasted from the per-filer row shape.

**Lesson worth keeping:** all-Optional decoding turns a schema mismatch into silent wrong output instead of a
loud failure. Any struct mirroring an API response should have its shape asserted against a real response.

---

## 2. The macOS TestFlight crash — CONFIRMED

The app installed fine on an Apple Silicon Mac and then did not work. Four real crash reports
(`~/Library/Logs/DiagnosticReports/Retired/Congress.Trade-2026-08-10-*.ips`), all identical:

```
EXC_BREAKPOINT (SIGTRAP)          macOS 27.0, Congress.Trade 1.0
libswiftCore    _assertionFailure(_:_:file:line:flags:)
SwiftData       ×3
Congress.Trade  ClientTrade.storedAsset.getter
Congress.Trade  ClientTrade.asset.getter
Congress.Trade  closure #1 in TradeCard.body.getter
```

(A fifth report, `…235007`, is a `CongressTradeTests`/`MockURLProtocol` test crash — unrelated.)

**Cause.** `App.swift:37` uses the bare `.modelContainer(for: ClientTrade.self)` — no `VersionedSchema`, no
`MigrationPlan`, no error handling, no recovery. `ClientTrade` is a `@Model` whose stored properties are Codable
**structs** (`Member`/`Asset`/`Transaction`/`Filing`, `Models.swift:44-75`), and those shapes changed across
releases (#1613, #1597, #1596, #1558, #1547 all touched `Models.swift`). A store persisted by an older build
holds blobs the current struct cannot decode, so SwiftData traps the moment `TradeCard` faults a row.

Install succeeds; the **first paint of the Trades list** kills the app. A phone that got a clean install has an
empty store and never reproduces it — the Mac's store persisted, which is why it looked Mac-specific.

**The fix must be structural.** A Swift `do/catch` cannot intercept a SwiftData assertion trap, so guarding the
container open is not sufficient — the trap is on faulting an individual row. The durable answer is a schema
version stamp persisted beside the store, compared at launch, wiping on mismatch.

**Why wiping is correct here:** this store is a *pure cache* of server data. No user-authored state lives in it —
watchlist and account state are server-side. Crashing on a stale cache is never the right behaviour; discard and
refetch is.

Note `antigravity/mac-testflight-and-full-review` (#1711) flips `SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD = YES` and
`TARGETED_DEVICE_FAMILY = "1,2"`, which makes the app *installable* on Mac. It does not touch runtime. Both
changes are needed; neither is redundant.

---

## 3. The root cause behind "many things like this"

The owner's report: *"'First Trade' and 'Last Trade' for Coca Cola having date on far right of screen … while
there is 70+% of the screen width blank between them and its hard to even tell if they are related … this is just
a little example, many things like this."*

An audit across desktop web, mobile web, and iOS reduced **104 raw observations → 81 distinct defects → 9 root
causes**, six of which are a single shared component or helper that does not exist yet. The owner is not seeing
81 mistakes; he is seeing **nine missing decisions, made 81 times**.

### 3.1 The governing fact

**The web already solved this complaint. iOS never got the fix, and the web fix was never applied outside the drawer.**

`app/src/ui/dashboardHtml.ts:943` — `.drawer-kv`:

```css
grid-template-columns: 35% 1fr;   /* label col, value col — value LEFT-aligned in col 2 */
```

with this comment at `:530`:

> label/value on the SAME line (owner: stacked label-above-value "is impossible to look at without getting a headache")

and `:1626` explicitly refusing to collapse it on mobile. Measured live at 375px: label at x=16, value at x=133 on
every row, one shared entry guide, gap = **9%** of the container. That is the reference implementation.

`clients/ios/CongressTrade/Views/Components/Components.swift:256` — `DetailRow`:

```swift
HStack(alignment: .top) {
    Text(label).foregroundStyle(.secondary)
    Spacer(minLength: 18)                      // ← this is the entire bug
    Text(value).multilineTextAlignment(.trailing)
}
```

Measured on the KO ticker sheet: **52%** dead gap. Used by every `DetailRow` call site plus four hand-rolled
copies. The desktop Trends page ships the same failure via `justify-content: space-between` at **82%**, thirty-three
times, on the first screen a new visitor sees.

### 3.2 The nine root causes

| # | Root cause | Distinct defects | Fix shape |
|---|---|---:|---|
| RC1 | **No row primitive** — key/value layout improvised per call site with `Spacer()` (iOS) or `space-between` (web) | 9 | 2 component edits |
| RC2 | **No display-labeler layer** — DB enums reach the screen raw (`equity`, `mega`, chamber codes) | 10 | 1 server field set + 1 client table |
| RC3 | **A data-integrity defect rendered as product truth** — `securities_ref.sector` holds three provider vocabularies; the UI prints the collision | 3 | display rule + upstream fix |
| RC4 | **No formatting contract** — 6 date formats, 5 separators, 3 meanings for `~` | 16 | 4 shared helpers |
| RC5 | **Identity chrome authored per layer** — nav, hero, chips, ledger, footer each restate the entity | 10 | 1 header builder |
| RC6 | **No token scale / control inventory** — 3,644 off-scale spacing values on one page; 34 controls → 10 distinct (height\|radius) pairs | 6 | mechanical migration |
| RC7 | **No container discipline** — a table 4,027px wide inside a 1,320px box | 9 | 1 grid + table policy |
| RC8 | **Touch is second-class** — 1,183 `title` tooltips, 32 hover rules, exactly 1 hover guard | 7 | media-query pass |
| RC9 | **Voice unowned** — operator state shipped as user copy; empty/error states never designed | 6 | copy pass |

### 3.3 Layout contract (normative)

**Decision procedure** — apply in order, first match wins:

| # | Test | Form |
|---|---|---|
| 1 | ≤3 short self-labeling atoms identifying one entity (ticker, exchange, party, state) | Inline run |
| 2 | ≥3 sibling rows, **same measure and unit**, whose job is vertical comparison | Comparison list (justified right column permitted) |
| 3 | A single free-text blob >60 characters | Stacked block |
| 4 | Everything else | **Ledger row — THE DEFAULT** |

The KO Security and Congressional Trading sections fall to rule 4 in every row (a date, a count, a string, a dollar
figure — heterogeneous). They were rendered as if rule 2 applied. That is the error.

**Ledger row geometry:**

| Token | Web | iOS |
|---|---|---|
| Label column | `min(35%, 180px)` | `min(38%, 160pt)` |
| Gutter | `14px` | `14pt` |
| Row rhythm | `8px` (`6px` ≤720px) | `8pt` |
| Ledger max measure | `560px` | n/a |
| Value alignment | `text-align: left` | `.frame(maxWidth:.infinity, alignment:.leading)` |
| Vertical alignment | `align-self: center` | `.firstTextBaseline` |

Label type: `.caption2`/10.5px, weight 600–700, uppercase, 0.4px tracking, secondary.
Value type: `.subheadline`/13px, weight 500–600, primary, **tabular figures**.

**Rejected, with reasons:**
- **Leader dots** — a table-of-contents device for values pinned to a page edge for a structural reason (page
  numbers align to the trim). Nothing here has that constraint; dots add ink whose only job is to repair a gap
  that should not exist.
- **Right-aligning the value** in the default form — ragged-left values ("Mar 13, 2014" vs "Buy") make the eye
  re-find the value's start on every row. Left alignment gives one vertical entry guide.

**Checkable test** (so a screenshot can be graded): let `G` = horizontal gap between the label's right ink edge and
the value's left ink edge, `W` = container content width. **FAIL** if `G > 0.25 × W` or `G > 96` device-independent
units, unless the row qualifies as a comparison list.

---

## 4. Sector taxonomy — the answer to "do we have data for all?"

Owner: *"Net Flow By Sector, do we have data for all regarding sector? Doubt it."*

**Coverage is effectively 100%. The doubt is misplaced; the problem is different and worse.**

`/api/analytics/sector-flow?window=90d` returns **39 buckets over 1,090 trades**. `/market-cap-breakdown` returns
the **same 1,090**, of which `unknown` = 1 (0.1%). So `securities_ref.sector` is essentially never empty.

**The real defect is taxonomy fragmentation** — multiple enrichment providers write different vocabularies into one
column:

- `Health Care` (43) **and** `Healthcare` (33) — one sector, two rows
- `Communication Services` **and** `Communications` **and** `Telecommunication` — three rows
- `Consumer products` (lowercase p) beside `Consumer Defensive` / `Consumer Cyclical`
- Sub-industries posing as sectors: Semiconductors, Media, Retail, Banking, Insurance, Pharmaceuticals,
  Biotechnology, Machinery, Road & Rail, Beverages, Tobacco, Packaging…
- A literal `"N/A"` (2 trades) that `COALESCE(NULLIF(sector,''),'Unknown')` does **not** catch — `NULLIF` only
  nulls the empty string

**And iOS showed only `prefix(8)` = 63.5% of trades**, silently dropping 31 buckets and 398 trades with no "Other"
row. So the flagship ranking also ranks industries against sectors.

**Undisclosed exclusion:** both `buildSectorFlowQuery` and `buildMarketCapBreakdownQuery` gate on
`TICKER_RESOLVED_SQL`, so trades with no resolved ticker are excluded from **both** charts entirely and are
invisible to the user. That is a product decision, not a bug — but it is currently undisclosed in the UI.

---

## 5. Asset-name data quality

Sampled 4,500 rows across 2021–2026.

**Bracket junk, two distinct kinds.** Stripping only known type codes leaves the second kind behind:
- real House asset-type codes: `TOBACCO SETTLEMENT FING CORP VA SER A1 … [CS] REDEMPTION`
- **footnote markers** carrying no information: `Port of Portland Or Arpt Reven Due 07/01/2036 5.000% [1]`,
  `Us Treasury Bills Due 04/01/2021 [1][2]`

**Rate/maturity belongs in Notes, and parses deterministically.** The Senate eFD emits a rigid machine format
(~8% of recent rows):

```
Owens & Minor Rate/Coupon: 3.875% Matures: 09/15/2021
  → name "Owens & Minor",  note "3.875% coupon, matures 09/15/2021"
```

A second rigid pattern is `Due MM/DD/YYYY` plus a standalone rate. The mechanism already exists: the
`transactions.cleaning_note` column and `plainCleaningNote()` (`app/src/shared/cleaningNote.ts`), already surfaced
as the web "Notes" column.

**Known limit — do not attempt.** `Carroll Cnty Ga SCH Dist Go 5% 04/01/27 Ao (Muni) Rate/Coupon: 5.0% Matures:
04/01/2027`. After stripping the rigid suffix, the inline `5% 04/01/27` remains and is genuinely part of the muni's
name. Strip the rigid suffix only.

**Exchanges.** The PTR form provides **one asset and one ticker per row** — there is no from→to pair in the
disclosure, so the second leg cannot be recovered and must not be invented. Of 324 exchange rows some filers cram
both legs into the name (`Ysleta Texas Independent School District Ref Bond (Exchanged) Ysleta T…`), most give one.

**Already correct — do not "fix":** exchanges contribute exactly `0` to net flow. `SIGNED_MIDPOINT_SQL`
(`app/src/analytics/sql.ts:148`) signs only `B`/`P` and `S`.

---

## 6. Non-tickered trades — both platforms

`TradeDetailView.swift:267` and web `openTrade` (`dashboardHtml.ts:10434-10472`) both **always** render a
performance-vs-S&P section. With no ticker they fall through to *"will appear when market data is available"* —
false. For real estate, a private stake or a muni it can never be computed.

The **options** case is already handled correctly and honestly on both platforms; keep it.

**Client predicate must mirror the server's** `TICKER_RESOLVED_SQL` (`app/src/analytics/sql.ts:166`): non-empty
**and** not in `NONE / -- / N/A / NA / NULL / —`. Client rows are a raw passthrough of `row.ticker`
(`app/src/delivery/rows.ts:149`, `app/src/client/utils.ts:227`) with no sentinel filtering, so `!isEmpty` is not
enough.

**Do not gate on asset class.** An ETF or fund with a real ticker *can* compute a vs-S&P comparison; ticker
presence is the correct single gate.

---

## 7. Directory paging — measured, not guessed

Owner asked for pages like the Trades tab, then asked whether the full-roster fetch hurts startup.

**It does not affect app launch.** The fetch fires from `PeopleDirectoryView.task` — when the Directory tab first
appears, not at launch. The app opens on Trends; a user who never taps Directory never downloads it.

| Endpoint | Rows | Raw | Gzipped | TTFB | Total |
|---|---:|---:|---:|---:|---:|
| `/api/members` | 379 | 85 KB | **13.7 KB** | 0.41s | 0.54s |
| `/api/assets` | 4,212 | 424 KB | **72 KB** | 0.20s | 0.46s |

Client memoizes for 5 minutes (`membersCacheTTL`); refetches after that, on pull-to-refresh, and on every cold
launch (in-memory only, not persisted).

**Paging would not reduce the download.** Neither endpoint accepts paging params — they are deliberately
full-roster with a 30-minute server KV cache. A client-side pager downloads all 4,212 assets and shows 50. Same
bytes. Server-side paging would cost instant search/sort (every keystroke → network) and an honest total count.
**So: client-side pager, server untouched.**

**Real latency bug found while measuring:** the response says
`cache-control: public, s-maxage=300, stale-while-revalidate=600` but returns `cf-cache-status: DYNAMIC` —
Cloudflare is **not** caching it. Cloudflare does not cache JSON API responses by default without a Cache Rule, so
that header is currently decorative and every cold Directory open runs a Worker invocation plus a full origin
transfer. Fixing that is worth more than paging, at zero UX cost. **Not yet done — needs a production Cache Rule.**

---

## 8. Open backlog

- Cloudflare Cache Rule for `/api/members` and `/api/assets` so `s-maxage` applies (production config — needs
  owner go-ahead; verify `cf-cache-status` flips to `HIT`, do not assume).
- Persist the members/assets roster (SwiftData) so cold launches stop refetching.
- Asset-name backfill of existing rows — dry-run report first, owner approves before any write.
- District in the Trends "Most Active Politicians" leaderboard — needs `district` added to the member-leaderboard
  query (`app/src/analytics/builders.ts`).
- Dynamic per-person OG cards (Satori → resvg-wasm on Workers, edge-cached). Would let a share link read
  "Diana Harshbarger · TN-1 · 47 disclosed trades". ~1.5–2 MB wasm + an embedded serif subset.
- Delivery parity: iOS cannot set per-subscription Tickers (it silently reuses the global watchlist —
  `CongressTradeStore.swift:691`), Sides, or Min Amount. Web supports all three.
- Trades parity: no $ min/max filter; 2 sort keys vs web's 12; page sizes 50/100/200 vs web's 25/50/100/250;
  no jump-to-first/last.
- Trends sections absent on iOS: Party Split, Sector Breakdown (asset-type based, distinct from GICS Net Flow by
  Sector), Committee Sector Conflicts. KPI tiles lack Assets count and Buy Pressure.
- Company drawer: iOS lacks Buy Pressure, the buys/sells chart, "Performance After Buys" backtest, and Top
  Buyers/Sellers. Root cause: iOS calls `/api/client/v1/ticker/:t` (returns only `{ticker,asset,summary,items}`)
  while web's drawer calls `/api/analytics/ticker/:t` plus `/backtest`.
- `CongressTradeTests` has 4 tests failing on clean `main`, plus 2 flaky. Pre-existing; verified by stashing and
  re-running against untouched `origin/main`.
