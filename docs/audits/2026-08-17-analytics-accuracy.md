# Analytics Accuracy Audit — 2026-08-17

**Seat:** CURSOR (cloud, `bc-92234cd8-3d0b-42fe-9dc8-8bc01b232621`)
**Branch:** `cursor/analytics-accuracy-audit-2621`
**Code under review:** `main` at `be53b3e5` (2026-08-17)
**Live production:** `https://congress.trade` measured 2026-08-17 ~23:44–23:48Z (browser UA)
**Kind:** Read-only methodology review.  No app code, schema, or production data was changed.

This is a political-finance / quantitative-methods audit of Congress.Trade analytics: return math, latency comparisons, cross-source matching, benchmarks, estimated ranges, issuer/ticker maps, committee and member enrichment, backtests, historical completeness, survivorship and look-ahead bias, and user-facing claims.

Related in-flight work that this report does **not** edit: PR [#1966](https://github.com/jaywedgeworth22/Congress.Trade/pull/1966) (latency corpus-hash coverage for #1523), PR [#1965](https://github.com/jaywedgeworth22/Congress.Trade/pull/1965) (directory / committee leftovers).

---

## 1. Verdict

Congress.Trade already has a stronger honesty layer than most congressional-trade products: filing-date Top Performers, dual-anchor member drawers, coverage-adjusted latency gates, median-and-average Lead/Lag agreement, PIT export (`congress-pit-v2`) that refuses to call itself historically validated, and explicit “not a forecast / not impropriety” disclaimers.

The remaining accuracy problem is **not** a missing disclaimer.  It is that **three different performance stories, two different corpora, and two sector vocabularies are presented as one product.**  A reader of Trends, a reader of a politician drawer, and a reader of an asset backtest are not looking at the same estimand.  Live production on 2026-08-17 makes that concrete.

| Surface | What it actually measures | What the copy implies |
|---|---|---|
| Top Performers | Filing-date, public-equity buys, ±200% winsor, size-weighted excess vs `spx_eod` | “Beat the S&P after the trade was disclosed” |
| Politician drawer “If you bought at filing” | Filing-date buys, **no** public-equity filter, **no** winsor | “Matches Top Performers” |
| Asset “Performance After Buys” | **Trade-date** equal-weight forward returns | “After **disclosed** buys” |
| PIT export | Lag-aware, disclosure-available entry, placebos | Correctly marked `historicalValidationReady: false` |

The most important live contradictions measured today:

1. **Cleo Fields, 90d.**  Top Performers: 8 buys, +9.0% excess, 87.5% win rate.  Drawer filing leg: 10 buys, +7.0% excess, 70% win rate.  Same politician, same window, two numbers, copy says they match.
2. **90-day corpus.**  Analytics default (`source=all`): 2,006 trades.  Primary-only: 1,467.  Trades tab is hardcoded primary-only.  Trends is not.
3. **Ticker coverage.**  44.7% of all 90d trades have a resolved ticker; **26.6% of primary** trades do.  Sector/cap/conflict/backtest charts are a minority slice presented without a denominator.
4. **NVDA backtest (`window=all`).**  331 buy events, 252-trading-day average excess **+76.5%**, entry at `tx_date`.  That is a look-ahead number if the UI keeps saying “disclosed.”
5. **Latency.**  No provider is `usable`.  FMP is `preliminary` (53.3% CT coverage).  Unusual Whales and Quiver are `operationalStatus: error` with 14–16% coverage, while the scorecard still publishes Lead seconds.  Scope `providerOnly` is 256 of 527 (48.6%) — the #1523 undercount PR #1966 is still not on `main`.

**Do not treat this audit as a license to invent alpha, reconstruct portfolios, or ship a “who is beating the S&P” fantasy league.**  The 2026-08-06 product review already warned against that framing.  The upgrade path is: one estimand per surface, one corpus note, gold-dataset tests, then copy that names the estimand.

---

## 2. Method and severity

**Method.**  Read-only review of `app/src/analytics/*`, `app/src/ingestion/tradeLatency.ts`, `app/src/prices/*`, `app/src/extraction/tickerNormalize.ts`, `app/src/export/pitScores.ts`, `app/src/enrichment/*`, web Trends copy in `dashboardHtml.ts`, PIT/export docs, prior reviews (`docs/reviews/`, `docs/ux-findings-2026-08.md`), and live `GET /api/analytics/*` on production.

**Severity.**

| Sev | Meaning |
|---|---|
| **P0** | User-facing number or claim is systematically the wrong estimand, or two surfaces that claim to match do not. |
| **P1** | Material bias, filter mismatch, or missing caveat that changes interpretation for a careful reader. |
| **P2** | Known gap, incomplete wiring, or ops/doc drift.  Honesty rails exist but are incomplete. |
| **P3** | Test debt, comment drift, or small hygiene. |

This report does not estimate calendar time.  Difficulty is stated as which subsystem must change and how invasive the edit is.

---

## 3. Live corpus snapshot (2026-08-17)

`GET /api/analytics/summary?window=90d`

| Filter | Trades | Members | Tickers | Est. volume | Resolved ticker % | Buys / sells |
|---|---:|---:|---:|---:|---:|---|
| `source=all` (Trends default) | 2,006 | 79 | 325 | $116.9M | **44.7%** | 1,314 / 679 |
| `source=primary` (Trades tab) | 1,467 | 74 | 195 | $112.1M | **26.6%** | 1,021 / 437 |

`GET /api/analytics/filing-lag?window=90d` summary count = **1,474**.  That is 532 fewer rows than the all-source trade total (26.5% of the window never enters timeliness).

`GET /api/analytics/sector-flow?window=90d` covers **828** trades across 20 buckets / 15 unique labels (duplicate Technology, Healthcare, Industrials, Communication Services).  Unmapped leftovers include Electrical Equipment, Retail, Finance, Consumer Discretionary.

`GET /api/analytics/conflicts?window=90d&limit=200` returns **60** flags: **46 sells / 14 buys**.  Sector mix: Industrials 41, Health Care 12, Real Estate 3, Energy 3, Communication Services 1.  Almost no Financial Services / Technology flags despite those being the two largest sector-flow buckets.

`GET /api/analytics/latency-summary` (7-day score / 14-day scope):

| Provider | Status | Ops | Timed matches | Us first / them | Median lead | Avg lead | CT coverage |
|---|---|---|---:|---|---:|---:|---:|
| FMP | preliminary | running | 17 | 15 / 2 | +13.1 h | +9.3 h | 53.3% |
| Unusual Whales | preliminary | **error** | 8 | 7 / 1 | +24.4 min | **−34 s** | 14.4% |
| Quiver | preliminary | **error** | 13/12 | 12 / 0 | +12.5 min | +12.8 min | 16.3% |

Scope: 527 rows, 158 strong matches (30%), 256 provider-only.  FMP `coverageStrongPairingsOnFile` = 169 while timed `matched` = 17.  No lane meets the `usable` gate (15 matured rows **and** 80% coverage both ways).

---

## 4. Findings

### 4.1 Return calculations and benchmarks

**What the code does.**  Returns are simple arithmetic, not log: `(to − from) / from` in `app/src/prices/compute.ts`.  Excess is asset return minus S&P 500 return from `spx_eod` over the same calendar span.  There is no sector ETF, no beta, no factor residual, no transaction cost, no next-open execution lag.

```25:41:app/src/prices/compute.ts
export function pctChange(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from == null || to == null || !Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return null;
  return (to - from) / from;
}
// ...
  const excessReturn = assetReturn != null && spxReturn != null ? assetReturn - spxReturn : null;
```

Annualization (filing leg / leaderboard reference column only) is `excess * (365.25 / max(30, elapsedDays))`.  A 30-day-old +3% excess prints as ~36.5% annualized.  That is why `docs/ux-findings-2026-08.md` §1 found iOS showing Cleo Fields at 41% while web showed 5.7%.  Web now displays non-annualized `avgExcessReturn`.  The annualized column is still in the API and still ~6× the displayed number (Fields live: 9.0% vs 56.5%).

**P0-A. Ticker backtest is trade-date alpha labeled as disclosure follow-through.**
`aggregateTickerBacktest` enters at the close on/before each buy’s `tx_date` (`app/src/analytics/compute.ts:390–401`).  The route comment says the same (`routes.ts:815–817`).  Web copy says “After disclosed **buys**” (`dashboardHtml.ts:11269`).  STOCK Act filings are typically days to weeks after the trade.  Entering at `tx_date` credits the pre-publication move.  Live NVDA `window=all`: 21d avg excess +4.8%, 63d +12.4%, 126d +28.4%, 252d +76.5% on 331 buys.  Those figures are not copy-tradeable.

**P0-B. “Matches Top Performers” is false for the politician drawer.**
Leaderboard SQL (`builders.ts:671–678`) requires `public_equity`, `price_at_filing > 0`, `spx_at_filing > 0`, live `current_price > 0`, and ±200% winsor.  Drawer `aggregateMemberPerformance` skips asset-class and winsor filters (`compute.ts:274–320`).  Live Fields 90d: leaderboard 8 / +9.01% / 87.5% vs drawer filing 10 / +6.95% / 70%.  The drawer note still says “avgAnnualizedExcess matches Top Performers” (`routes.ts` member-performance note; live payload confirmed).  That sentence is wrong on both the field and the cohort.

**P1-A. Leaderboard win rate uses a different statistic than the displayed excess.**
`avg_excess` is winsorized, non-annualized, size-weighted.  `wins` counts `ANNUALIZED_EXCESS > 0` (`builders.ts:690–692`).  A young trade can “win” on the 30-day floor while the displayed average is pulled the other way.  Drawer win rate uses raw (non-annualized) excess sign (`compute.ts:294–315`).  Three win-rate definitions exist.

**P1-B. `weightedMean(excesses, weights)` length coupling.**
`weights` is pushed for every scored return.  `excesses` is pushed only when SPX excess exists (`compute.ts:280–292`).  `weightedMean` returns null unless the arrays are the same length (`297–298`).  One unpriced SPX anchor nulls **the entire** `avgExcess` / `avgAnnualizedExcess` for that member.  Same bug on the annualized array, which is often shorter.

**P1-C. Benchmark is an index close, not a tradable book.**
`spx_eod` is the right *economic* benchmark for “did this name beat the market.”  It is the wrong *implementation* benchmark for “could a follower have done this”: no SPY tracking error (Massive even proxies SPX with SPY in `massive.ts`), no borrow, no lot size, no bracket uncertainty.  Sector-relative skill is not computed even though sector enrichment exists.

**P2-A. Open-ended mark-to-market.**
Top Performers and the drawer mark to `securities_ref.current_price` / latest SPX.  That is not a realized exit.  Sells are excluded on purpose (“exit timing … needs cost basis we don’t have,” `compute.ts:329–330`) — correct — but the UI still says “beat.”

**P2-B. ±200% winsor is leaderboard-only.**
Documented and justified for the board (`builders.ts:640–646`).  Drawer, conviction skill, and ticker backtest are uncapped.  One multi-bagger can dominate those surfaces.

---

### 4.2 Estimated ranges (STOCK Act brackets)

**Method.**  Arithmetic midpoint.  Closed bracket → `(min + max) / 2`.  Open top tier → **floor** (`amount_min`).  Missing → **0**, and that zero still enters sums.

```157:159:app/src/analytics/sql.ts
export const BRACKET_MIDPOINT_SQL =
  '(CASE WHEN t.amount_max IS NOT NULL THEN (t.amount_min + t.amount_max) / 2.0 ' +
  'WHEN t.amount_min IS NOT NULL THEN t.amount_min ELSE 0 END)';
```

House/Senate PTR tiers are log-ish ($1,001–$15,000, $15,001–$50,000, … $50,000,001+).  An arithmetic midpoint on $1,001–$15,000 is $8,000.50.  A log-uniform mean on the same interval is about $3.9k.  Wide brackets therefore overweight the right tail in every volume, net-flow, and size-weighted excess figure.  The open $50M+ tier is systematically **understated** (floor, not a modeled tail).

Live envelopes correctly set `estimatedAmounts: true`.  They do **not** publish a low/mid/high band.  Net flow and “est. $” read as point estimates.

**P1-D.**  Size-weighted skill inherits bracket error.  A single open-top buy can be either a $50M floor or a nine-figure ticket; the board cannot tell.
**P2-C.**  Missing amounts contribute $0 rather than being dropped, which silently down-weights those rows in volume and (if used as weight) treats them as weight 1 in the TS aggregator.

---

### 4.3 Windows, source filters, and historical completeness

**Window field.**  Almost every aggregate filters `t.tx_date` (`sql.ts:264–277`).  Filing-lag and performance anchors use `filed_date`.  A “90d” Trends view therefore includes trades that *occurred* in-window even if they were disclosed later (or not yet), and excludes older trades disclosed today.  That is a valid trade-activity window.  It is the wrong window for “what became public in the last 90 days.”

**Two corpora.**  Analytics default is `source=all` (`routes.ts:190–191`).  The Trades tab hardcodes `tradesSourceMode() === 'primary'` and drops `seed_dataset` client-side (`dashboardHtml.ts:3531–3537`, `4872–4876`).  Live 90d delta: **+539 trades / +5 members / +130 tickers** on the all-source path.  Seed rows often lack official `filed_date` (banner copy at `dashboardHtml.ts:4522`).

**Feed-quality guards** on analytics (`sql.ts:246–262`) now exclude `provider-missing-*`, null `filer_id`, and competitor executive injects.  That was a real fix (Trends “TRADES” KPI used to run ahead of the feed).  It does **not** align Trends with the primary-only tab.

**Timeliness completeness.**  Lag SQL requires both dates and `filed_date >= tx_date` (`builders.ts:571–575`).  Live: 1,474 / 2,006.  The UI does not show the excluded denominator.  House `filed_date` NULLs for Clerk-absent / Quiver-stub ids are documented as honest (`docs/rollouts/2026-08-17-house-fd-zip-1577.md`); they still shrink the accountability lens.

**P0-C. Trends vs Trades count mismatch is unexplained in the UI.**
**P1-E. Window = trade date, copy often reads as disclosure window.**
**P1-F. Filing-lag KPIs have no “N of M dated filings” footnote.**
**P2-D. `buildMemberSkillQuery` uses `t.source = ?` for primary (no `manual`) and skips the feed-quality guards (`builders.ts:737–751` vs `sql.ts:246–297`).**
**P2-E. Comments still say executive is excluded by default (`sql.ts:100–105`, `routes.ts:165–166`, `app/docs/client-mobile-api.md`) while `buildCommonFilters` includes all chambers (`sql.ts:286–287`).**

---

### 4.4 Issuer / ticker mapping

Pipeline: securities master → preferred-share parse (`T$A` → `T^A`) → rename-only `resolveContinuousTicker` (FB→META, SQ→XYZ, GEHCV→GEHC) → syntactic acceptance of well-formed unknowns (`tickerNormalize.ts:25–32`).  Acquisitions (ATVI, RHT, BRCM, TWX) are **not** folded into acquirer price series.  There is no FIGI/CUSIP issuer graph.  PIT export emits `cusip: null`.  `securities_master.aliases` is documented empty in prod.

**P1-G. Well-formed unknown tickers are accepted.**  Funds, ADRs, typos, and collisions (crypto vs equity, recycled tickers) can price against the wrong series.  Leaderboards restrict `public_equity`; other surfaces do not always.
**P1-H. Today’s map is applied to historical rows.**  FB→META remaps stored history (`0017_fb_meta_remap.sql`).  There is no as-of ticker vintage.  Ticker reuse (the post-META Facebook ticker is a different issuer) is a known look-ahead / identity risk.
**P1-I. Primary resolved-ticker rate is 26.6%.**  Bonds, funds, and unnamed assets are the bulk of the official corpus.  Sector flow, market cap, conviction, conflicts, and backtests are conditioned on `TICKER_RESOLVED_SQL` (`sql.ts:180`) without saying so on the chart.
**P2-F. Name match uses `includes()` in either direction** (`normalizer.ts` name plausibility).  Short issuer strings false-positive.
**P2-G. No acquisition terminal return.**  ATVI holders received cash, not a Microsoft series.  Forward-return samples die at the last quoted bar (survivorship toward still-listed names).

Prices: providers prefer `adjClose` (FMP dividend-adjusted, Tiingo `adjClose`, Massive `adjusted=true`).  The table column is still `close`.  PIT labels `totalReturnBasis: false` and `corporateActionVintage: null`.  Production default is the Socratic.Trade peer (`docs/rollouts/2026-08-11-enrichment-committees-photos-prices.md`).  Delisted / unpriceable names get a 7-then-30-day negative cache — coverage hole, not an imputed terminal return.

---

### 4.5 Committee / member enrichment

**Committees.**  Daily union of `committees-current.json` + House Clerk XML (`enrichment/committeeSync.ts`).  **Current** roster, not membership at `tx_date`.  Former members get `[]`.  Executive filers have no committees by design.

**Conflict rules.**  Free-text substring → curated GICS-like sectors (`conflicts.ts:23–40`).  Candidate SQL passes **raw** `securities_ref.sector` (`builders.ts:839`).  Sector-flow charts canonicalize to FMP labels (`Healthcare`, `Financial Services`, `Technology`, `Consumer Cyclical`, `Basic Materials`) (`builders.ts:414–426`).  Conflict rules still expect GICS (`Health Care`, `Financials`, `Information Technology`, `Consumer Discretionary`, `Materials`).

Live 90d conflicts are almost all Industrials (Armed Services / Intelligence substring hits) plus a few raw `Health Care` rows.  The two largest flow buckets — Technology (202) and Financial Services (172) — barely appear.  That is the vocabulary miss, not an absence of oversight-adjacent trading.

Sells are flagged the same as buys (46 vs 14 live).  A sale in an overseen sector is a different journalistic object than a purchase.

**P0-D. Conflict sector vocabulary does not match canonical enrichment.**  True overlaps on FMP labels will not flag.  Tests pin the old GICS strings (`conflicts.test.ts`).
**P0-E. Current committees on historical trades.**  Assignment changes and lame-duck / former members are wrong both ways.  Copy says “a politician’s committees oversee,” not “current assignments.”
**P1-J. Substring brittleness.**  `help`, `finance`, `natural resources` are short tokens.  Senate Finance is intentionally not “financial,” but “help” is not similarly fenced.
**P1-K. Member identity splits.**  Issue #1452 (McCaul ×2) and `identitySync.ts` (never overwrite `resolved_bioguide_id`) mean unique-politician KPIs and per-member skill can double-count.  Seed vs live name variants remain an open completeness issue (#1453).

---

### 4.6 Latency comparisons and cross-source matching

**Identity.**  `lastName_TICKER_YYYY-MM-DD_side` via `generateTradeHash` (`tradeLatency.ts:1746–1752`).  Strong: exact hash, or same person/ticker/side within ±2 days.  Weak: missing date or missing ticker.  Chamber mismatch is allowed (providers mis-tag).  Last-name match uses `includes()` for names ≥4 characters — “Scott” family risk.

**Clocks.**  CT side is `congress_first_seen_at` (monitor).  Quiver prefers `Quiver_Upload_Time` (provider).  FMP/UW are monitor-only; FMP parser publishes `published_at = null`.  Delta sign: positive = CT earlier.  Timed cohort requires `|Δ| ≤ 336h`.  Coverage uses match-clock (`updated_at` when status → matched), not CT first-seen — that Quiver 0% bug is fixed.

**Live-race exclusion.**  Seed / competitor_backfill never mint candidates.  Primary imports with `first_seen − filed_date > 7d` are excluded.  Scoreboard re-applies `isLiveRaceImport` with **hardcoded** `source: 'primary'`.  Missing filed/first-seen returns `true` (cannot detect a historical crawl).

**Coverage vs timing (the #1523 hole, still on `main`).**  A provider “latest” row for a trade CT already has via seed/backfill has no in-window candidate, so it stays `unmatchedProvider` forever.  Live: 256 provider-only of 527 scope rows; FMP 135 unmatched vs 17 timed matches, with 169 strong pairings on file.  PR #1966 adds `corpus-hash` for **coverage only** (not timing).  Until it lands, `providerOnly` is an upper bound, not a miss count — the code comment already says so (`tradeLatency.ts` ~297–318), but the public scope line still reads as “they have it and we do not.”

**Honesty gates (good).**  `usable` needs ≥15 matured rows and ≥80% coverage both ways.  `preliminary` at ≥2 timed races.  UI Lead/Lag requires median **and** average to agree (`dashboardHtml.ts:10111–10117`).  UW live is the example: median +24 min, average −34 s → **Mixed**.  Weak matches are excluded from headline `matched`.  FMP document-key inflation is de-duplicated by trade hash (one PANW line of five ≠ 100% coverage).

**P0-F. Outage + stale scorecard.**  UW and Quiver are `operationalStatus: error` (token/plan; see #1953 and `docs/rollouts/2026-08-17-latency-probes-silent.md`) and still publish median/average lead.  `/latency-summary` is KV-cached 5 minutes and does not degrade when probes are dead.  Public Delivery placement hides the block unless `isLatencyAhead()` — selection bias toward the marketable side (`dashboardHtml.ts:10450–10455`).
**P1-L. Coverage undercount until #1966.**  Do not market “we have 30% overlap” as a miss rate.
**P1-M. Price snapshots are live quotes near `due_at`, not historical prints** (`latencyPriceSnapshots.ts`, 3-minute stale window).  Edge bps are not PIT.
**P2-H. Speed-boast line uses median only** and does not require average agreement (`dashboardHtml.ts:10158`).
**P2-I. Rollout doc drift.**  `docs/rollouts/2026-07-22-coverage-adjusted-latency.md` still cites 72h / 20-row; code is 336h / 168h / 15-row.
**P3-A. `quality.ts` admin crosscheck** keys on `ticker|date|type` only (no amount/owner).  Untested module.

---

### 4.7 Backtests vs PIT export

Product backtest (`/ticker/:ticker/backtest` and client `tickerAnalytics.ts`): buys only, equal-weight, horizons 21/63/126/252 **trading** days, `BACKTEST_MIN_N = 5`, no costs, no sells/shorts, entry `tx_date`.  Coverage honesty (`tradeCount` vs `n`) is good.  Tradeability is not.

PIT export (`app/src/export/pitScores.ts`, `congress-pit-v2`) is the rigorous surface: scores keyed by `disclosure_available_at`, first close on/after the conservative actionable date (date-only filings +1 calendar day), horizons must mature before `asOf`, sell skill flips sign when the asset underperforms, p5/p95 winsor when n≥20, placebos (permutation, jitter, flip, ablation, leakage detector).  `metadataPitComplete` is hardcoded `false`, so `historicalValidationReady` is never true.  That is the correct product claim for App B / research consumers.

**P0-A (repeated).**  Do not let the drawer backtest outrun the PIT contract.
**P1-N. Survivorship in the scored sample.**  Missing forward bars increment `tradeCount` and drop out of `n`.  Delistings and acquisitions vanish instead of receiving a terminal cash-out return.
**P2-J. Conviction `lateShare` is always `null`** (`routes.ts:439`), so the integrity multiplier is stuck at 0.9 (`compute.ts:565`).  The gate is advertised, not wired.

---

### 4.8 User-facing claims

| Surface | Current claim | Problem | Suggested rewrite |
|---|---|---|---|
| Top Performers sub | “buys beat the S&P 500 after the trade was **disclosed**” | “Beat” + no P&L / bracket / mark-to-market caveat | “Average excess vs the S&P 500 from **public filing date** to the latest close on disclosed **stock buys** (≥5, public equity, ±200% cap).  Not portfolio P&L.  Amounts are bracket estimates.  We do not know sell timing.” |
| Top Performers row | “N buys • X% win” | Win uses annualized sign | Drop “% win,” or compute wins from winsorized non-annualized excess |
| Drawer filing leg | “Matches Top Performers” | Live Fields 8 vs 10, 9.0% vs 7.0% | “Same **anchor** as Top Performers (filing date).  This drawer is not public-equity-only and is not ±200% capped.” |
| Drawer API note | “avgAnnualizedExcess matches Top Performers” | Board ranks/displays non-annualized `avgExcess` | Delete or invert |
| Asset backtest | “After disclosed buys” | Entry is `tx_date` | “Forward returns from each buy’s **transaction date** (not filing date).  Not what a follower could have captured.” |
| Committee conflicts | “committees oversee” | Current roster, GICS/FMP mismatch, sells included | “Uses each filer’s **current** committee assignments (daily sync), not membership at trade date.  Sector labels are provider vocabulary.  Observational — not evidence of impropriety.” |
| Disclosure Timeliness | STOCK Act 45-day lens | Silent drop of undated rows | “Based on trades with both transaction and official filing dates (1,474 of 2,006 in the live 90d all-source window).” |
| Trends KPIs | No source note | Seed included; Trades tab is primary-only | “Counts include historical seed imports.  The Trades tab shows primary disclosures only.” |
| Sector / cap charts | Implied full activity | 828 / 2,006 ticker-resolved | “Excludes trades without a resolved ticker.” |
| Terms / OG / footer | Congress / STOCK Act only | Corpus is House, Senate, **and Executive (OGE 278-T)** | Name all three.  Fleet copy rule. |
| Premium / Delivery | “Get the Filing First”; hide when behind | Selection on `isLatencyAhead()` | Conditional: “When the live matched sample is usable, we typically publish before provider X.” |
| Admin Aggressive Mode | “front-running edge” | Conflicts with educational posture | “Faster business-hours polling to cut ingest delay vs third-party feeds.” |
| Latency scope | “Matched means we and the provider both saw the same disclosure” | Corpus-only CT possession does not count on `main` | After #1966: split “CT missing” vs “CT has trade, excluded from live race.” |

ASC listing copy was corrected 2026-08-14 (House/Senate/Executive, 2-week trial).  In-repo `legalHtml.ts:66`, `ogMeta.ts` `DEFAULT_DESC`, and the dashboard footer still read Congress-only.

---

## 5. Bias inventory

| Bias | Where it hits | Sev | Mitigation today |
|---|---|---|---|
| **Look-ahead (information)** | Ticker backtest; drawer `tradeDate` leg if sold as followable | P0 | PIT export is lag-aware; Top Performers is filing-anchored |
| **Look-ahead (identity)** | Current ticker map / committee roster on historical rows | P1 | Renames-only at ingest; acquisitions kept distinct |
| **Survivorship** | Require live `current_price`; drop names without forward bars | P1 | `tradeCount` vs `n` on backtest; no terminal M&A return |
| **Selection / small-n** | Top Performers min 5; backtest min 5; latency usable 15 + 80% | P2 | Gates exist; annualized win-rate still leaks small-n noise |
| **Coverage / source** | Seed in Trends, not Trades; 27% 90d delta | P0 | Feed-quality guards; no UI source note |
| **Ticker resolution** | 26.6% primary; sector charts on 41% of all-source trades | P1 | `TICKER_RESOLVED_SQL`; no chart denominator |
| **Bracket / size** | Arithmetic mid; open-top floor; missing → 0 | P1 | `estimatedAmounts: true`; no bands |
| **Winsor inconsistency** | Board yes; drawer/backtest no | P1 | Documented for the board only |
| **Weighting inconsistency** | Board size-weighted; backtest equal-weight; medians equal-weight | P2 | Acceptable if labeled |
| **Latency outage** | Error ops + published leads; hide-when-behind | P0 | Median+avg badge; `usable` gate; health 503 |
| **Match fuzz** | Last-name substring; weak missing-date pairs | P1 | Weak excluded from headline |
| **Chamber / executive** | Code includes; docs/copy often omit | P2 | Fleet rule vs leftover Congress-only strings |

---

## 6. Methodological upgrades (recommended, not implemented)

Ordered by how much they change what a user should believe.  Each is a later PR; this audit does not land them.

1. **One estimand per surface, named in the API.**
   Add `anchor: 'filing_date' | 'trade_date' | 'disclosure_available_at'` and `cohort: { assetClass, winsor, weighting, source }` to every performance payload.  UI must print those fields, not a slogan.
2. **Filing-date ticker backtest (or relabel).**
   Duplicate `aggregateTickerBacktest` on `COALESCE(filed_date, first_seen_at, tx_date)` (better: PIT `disclosure_available_at` + next close).  Keep the trade-date series as a clearly marked “hindsight / non-replicable” diagnostic.
3. **Align drawer filing leg with leaderboard SQL.**
   Same public-equity filter, same ±200% winsor, same size weights — or stop saying “matches.”
4. **Win rate on the displayed statistic.**
   `SUM(CASE WHEN WINSOR_EXCESS > 0 THEN 1 ELSE 0 END)`.
5. **Fix `weightedMean` pairing.**
   Push a weight only when the corresponding excess/annualized value is pushed, or use index-aligned tuples.
6. **Canonicalize sectors before `committeeConflict`.**
   Map FMP ↔ GICS once.  Do not leave `Financials` unmapped in flow **and** required in conflicts.  Add PIT committee membership before treating conflicts as historical.
7. **Source and ticker denominators on Trends.**
   KPI footer: all vs primary.  Sector/cap/conflict: “N of M trades with a resolved ticker.”  Timeliness: “N of M with both dates.”
8. **Bracket sensitivity.**
   Publish `estVolumeUsdLow` / `Mid` / `High` (min / midpoint-or-log-uniform / max-or-open-top-model).  Size-weighted skill should be recomputed on the band, not only the mid.
9. **Latency: freeze or downgrade when `operationalStatus === 'error'`.**
   Merge #1966 for coverage honesty.  Do not badge Lead on a dead probe.  Boast line must use the same median+average rule as the card.
10. **Gold-dataset CI (section 8) before any new “skill” surface.**
11. **Optional later (research, not Trends):** log-uniform brackets; sector-ETF residual; next-open + 1-day lag book; acquisition cash-out; FIGI/CUSIP graph; committee membership vintages to unlock PIT `historicalValidationReady`.

---

## 7. Gold datasets

Check these in as frozen fixtures (synthetic or redacted official rows).  Do not scrape production into git.  Each row needs expected outputs, not just inputs.

### G1. Return / anchor pack (`analytics-gold-anchors.json`)

~30 synthetic trades with `tx_date`, `filed_date`, `first_seen_at`, bracket min/max, ticker EOD, SPX EOD.

Assert: midpoint, trade-date excess, filing-date excess, winsorized size-weighted board row, annualized reference column, drawer vs board equality when filters are forced equal.

Include: one >200% winner, one open-top $50M+ buy, one option (must drop), one missing SPX anchor (must not null the whole member after the weight fix), one 25-day-old +3% excess (annualized ≈ 43.8%).

### G2. Official PTR ticker pack (`analytics-gold-ptr-tickers.json`)

20–50 rows from published House/Senate watcher JSON **and** the matching official PDF identifiers (e.g. clerk `20034836.pdf` already in `scripts/seed-preview-fixtures.sql`: Pelosi INTC/UBER options, Perdue AXTA, Scott bond / null ticker).

Assert: normalize → expected ticker or expected null; options stay `is_option=1`; bonds do not resolve to SV equity; preferreds (`JPM^J`, `T^A`) survive.

### G3. Survivorship / acquisition pack

One delisted name (price stalls), one cash acquisition (ATVI-style), one rename (FB→META), one recycled ticker.

Assert: leaderboard drops stale `current_price`; backtest `n` < `tradeCount`; acquisition does **not** silently ride the acquirer series; rename maps only the continuous entity.

### G4. Sector / conflict pack

Rows for `Health Care` vs `Healthcare`, `Financials` vs `Financial Services`, `Information Technology` vs `Technology`, plus Armed Services / HELP / Financial Services committee strings.

Assert: after canonicalization, HELP∩pharma flags; Financial Services committee ∩ bank flags; `help` does not match an unrelated “help” token; current-vs-historical membership fixture fails closed until PIT committees exist.

### G5. Source / completeness pack

Filer with mixed `primary` + `seed_dataset`; known NULL `filed_date` count.

Assert: `summary.totalTrades` all vs primary delta; filing-lag `count` ≤ dated subset; Trends UI note required when delta > 0.

### G6. Latency gold (`analytics-gold-latency.json`)

Reuse and extend the existing FMP McGuire/PANW hash tests:

| ID | Case | Expect |
|---|---|---|
| L1 | Exact FMP house-latest hash | `trade-hash`, timed race |
| L2 | Quiver with `Quiver_Upload_Time` | provider clock |
| L3 | Quiver without upload time | monitor fallback, no fake tie |
| L4 | UW `KHANNA, ROHIT` | Ro Khanna alias |
| L5 | Two members, same ticker/date/side | no match |
| L6 | Seed source | no candidate |
| L7 | filed 2026-07-26, first_seen 2026-08-11 | not live-race |
| L8 | FMP key, 5 lines, 1 paired | `ctCoveragePct = 20%` |
| L9 | Strong pairings, 0 matured matches | `coverageIntegrity: contradiction` |
| L10 | Median lead, average lag | badge Mixed |
| L11 | `#1966` corpus-hash, no live candidate | coverage up, `matched` unchanged |
| L12 | `scott_*` vs `scottish_*` | no fuzzy last-name hit |
| L13 | Probe silent 48h | `operationalStatus: error` **and** comparison not `usable` |

### G7. Identity collision pack

McCaul / Capito / campaign-sign variants from `identitySync.test.ts`.

Assert: analytics `uniqueMembers` vs distinct `resolved_bioguide_id`; committee sync does not attach to the dormant seed row.

---

## 8. Validation tests to add

Priority order.  Pure functions first; one SQLite fixture route test per public performance endpoint.

1. **Win-rate basis.**  Leaderboard `winRate === wins_from_WINSOR_EXCESS / trade_count`.
2. **Drawer ↔ board equality.**  Same filer/window after forcing public-equity + winsor + size weights.  Live Fields 90d is the regression canary (8 vs 10 must become 8 vs 8).
3. **Backtest anchor contract.**  JSON includes `anchor: 'trade_date'`.  UI string test forbids “disclosed” on that payload unless a filing-date series is also present.
4. **Filing-date backtest mirror.**  For a cohort with lag > 0, trade-date avg excess ≥ filing-date avg excess is the usual inequality; assert both series exist.
5. **Weight-array pairing.**  Mixed SPX-missing rows; `avgExcess` uses aligned weights, never nulls the whole group.
6. **Conflict × canonical sector.**  Every `COMMITTEE_SECTOR_RULES` sector hits when `securities_ref.sector` is the FMP form.
7. **Source parity.**  `summary(all).totalTrades − summary(primary).totalTrades` pinned on the gold pack; dashboard contains the source note.
8. **Timeliness denominator.**  `filing-lag.summary.count ≤ dated_trades`; UI shows both.
9. **Bracket band.**  Snapshot min/mid/max net-flow for one ticker window.
10. **Latency gold L1–L13** as an integration from mint → probe obs → `getDisclosureLatencySummary`.
11. **Copy lint.**  No Congress-only lede in `legalHtml.ts` / `ogMeta.ts` / footer; Executive present; no “front-running edge” in user-visible admin copy if that screen can leak.
12. **Chamber default.**  One test that encodes the intended default (all chambers vs H+S).  Fix docs and iOS comments to that test.
13. **`quality.ts`.**  Pinned agree / only-us / only-provider counts on a fixture filing with amount-mismatch and type-alias variants.
14. **Conviction `lateShare`.**  Either wire it or drop the integrity-gate claim.

Existing coverage that should stay: `compute.test.ts` (midpoint, conviction math, backtest min-N), `builders.test.ts` (winsor SQL, sector aliases), `latencySummary.test.ts`, `tradeLatency.test.ts` (coverage clock, FMP key inflation), `pitScores.test.ts` (maturity / sell-sign / leakage).  Gaps: most `routes.ts` handlers have no numeric gold; `quality.ts` has zero tests.

---

## 9. What is already honest (do not regress)

- Top Performers **ranks and displays** non-annualized, winsorized, filing-anchored, public-equity, 5+ buys (`builders.ts:642–646`, `routes.ts:729–737`, `dashboardHtml.ts:3015–3021`).
- Dual-anchor drawer **exists** (trade-date skill vs filing-date copy-trade) even though the “matches” sentence is wrong.
- Latency: matched-overlap-only, weak-match exclusion, 24h grace, contradiction guard, FMP key de-dup, median+average Lead/Lag, “live new imports only” note (`dashboardHtml.ts:80`).
- PIT export refuses `historicalValidationReady` until metadata vintages exist.
- Dollar tooltips already say brackets are estimates (`dashboardHtml.ts:9311–9313`).
- Conflicts already say “Observational — not evidence of impropriety.”
- Analytics stay public/free by owner decision (2026-07-24).  Delivery is the Premium surface.
- LAG_BUCKETS in the current vendor pin day 60 to `60d+` (`46-59d` / `max: 59`).  The old 46–60d / 60d+ overlap is fixed in-tree.

---

## 10. Related work and keepouts

| Item | Status vs this audit |
|---|---|
| #1523 latency undercount | Open.  PR #1966 implements corpus-hash coverage.  This report describes `main` without that patch. |
| #1953 Quiver plan + UW token | Owner ops.  Explains live `operationalStatus: error`. |
| #1452 / #1453 / #1642 identity | Open completeness.  Skill and unique-member KPIs inherit the split. |
| #1460 committees / photos / horizon labels | PR #1965.  Does not add PIT membership. |
| `docs/ux-findings-2026-08.md` §1 | iOS annualized Top Performers — **display field fixed**; win-rate basis and drawer parity remain. |
| `docs/reviews/2026-08-06-full-product-review.md` | Do not import Capitol Ledger “spy_alpha” / reconstructed $1M books. |
| Extract / halt / billing / Senate `/fetch-doc` | Keepout.  Not in scope. |

---

## 11. File index

| Area | Paths |
|---|---|
| Analytics API | `app/src/analytics/routes.ts`, `compute.ts`, `sql.ts`, `builders.ts`, `conflicts.ts`, `quality.ts` |
| Tests | `app/src/analytics/__tests__/*` |
| Prices / excess | `app/src/prices/compute.ts`, `app/src/prices/service.ts` |
| Latency | `app/src/ingestion/tradeLatency.ts`, `latencyPriceSnapshots.ts`, `latencyCallLedger.ts` |
| Tickers | `app/src/extraction/tickerNormalize.ts`, `normalizer.ts`, `app/vendor/congress-trading-shared/src/constants.ts` |
| PIT | `app/src/export/pitScores.ts`, `app/docs/pit-score-export.md` |
| Enrichment | `app/src/enrichment/committeeSync.ts`, `identitySync.ts` |
| Claims | `app/src/ui/dashboardHtml.ts`, `legalHtml.ts`, `ogMeta.ts`, `clients/ios/CongressTrade/Views/TrendsView.swift` |
| Prior reviews | `docs/ux-findings-2026-08.md`, `docs/reviews/2026-08-06-full-product-review.md`, `docs/reviews/2026-07-28-full-app-review.md` |
| Latency rollouts | `docs/rollouts/2026-08-16-latency-lead-lag.md`, `2026-07-22-coverage-adjusted-latency.md`, `2026-08-17-latency-probes-silent.md` |

---

## 12. Closeout

This document is the deliverable.  It is evidence, not a ship of product changes.  The first implementation slice, if a later seat picks this up, should be **P0-A/B/C/D/E/F** (backtest label or re-anchor, drawer↔board parity, Trends source note, conflict vocabulary, current-committee caveat, latency error freeze) plus gold tests G1/G4/G6 — not a new leaderboard.
