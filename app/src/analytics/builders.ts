/**
 * src/analytics/builders.ts
 * OWNER: analytics
 *
 * Pure SQL builders for the analytics endpoints. Each returns { sql, params }
 * and is unit-tested without a DB (mirrors src/delivery/rows.ts). All dollar
 * metrics use BRACKET_MIDPOINT_SQL and are ESTIMATES; ticker views exclude
 * null/empty tickers; party is bucketed D/R/O.
 *
 * Bind-param ordering rule: SQLite positional `?` bind in order of appearance in
 * the SQL text. Builders that bind a SELECT-side value (a strftime() format)
 * push it FIRST, then the WHERE params from buildCommonFilters. LIMIT / HAVING
 * thresholds are validated integers interpolated as literals (as rows.ts does
 * for LIMIT) to keep param ordering simple.
 */

import type { SqlParam } from '../shared/db.ts';
import { canonicalAssetTypeCategorySql } from '../shared/assetTypes.ts';
import {
  ANALYTICS_FROM_JOINS,
  ANALYTICS_FROM_JOINS_SECURITIES,
  ANALYTICS_FROM_JOINS_REF,
  BRACKET_MIDPOINT_SQL,
  CHAMBER_EXPR,
  PARTY_BUCKET_SQL,
  SIGNED_MIDPOINT_SQL,
  STOCK_MIDPOINT_SQL,
  STOCK_SIGNED_MIDPOINT_SQL,
  TICKER_RESOLVED_SQL,
  buildCommonFilters,
  clampLimit,
  constrainTxTypes,
  granularityFormat,
  whereSql,
  windowDays,
  type CommonFilters,
  type Granularity,
  type Window,
} from './sql.ts';

export interface BuiltQuery {
  sql: string;
  params: SqlParam[];
}

const MID = BRACKET_MIDPOINT_SQL;
const SIGNED = SIGNED_MIDPOINT_SQL;
const STOCK_MID = STOCK_MIDPOINT_SQL;
const STOCK_SIGNED = STOCK_SIGNED_MIDPOINT_SQL;
const BUY = "SUM(CASE WHEN t.tx_type IN ('B', 'P') THEN 1 ELSE 0 END)";
const SELL = "SUM(CASE WHEN t.tx_type = 'S' THEN 1 ELSE 0 END)";
const BUY_VOL = `SUM(CASE WHEN t.tx_type IN ('B', 'P') THEN ${MID} ELSE 0 END)`;
const SELL_VOL = `SUM(CASE WHEN t.tx_type = 'S' THEN ${MID} ELSE 0 END)`;

/**
 * S&P 500 close on or before `dateExpr` (a securities_ref.current_price_date),
 * falling back to the newest close when the date is missing or earlier than the
 * whole series.  Correlated lookups on spx_eod's primary key.
 */
function spxOnOrBeforePriceDateSql(dateExpr: string): string {
  return (
    `COALESCE((SELECT s.close FROM spx_eod s WHERE s.date <= ${dateExpr} ORDER BY s.date DESC LIMIT 1), ` +
    '(SELECT s.close FROM spx_eod s ORDER BY s.date DESC LIMIT 1))'
  );
}

/**
 * One row per priced ticker: its current price, the day that price is from, and
 * the S&P close on that SAME day — the aligned exit legs of every excess-vs-S&P
 * figure.  Materialized once per query (securities_ref is small) instead of a
 * correlated lookup per trade row.
 */
/** Materialized once per query; excludes tickers whose current price is too old for excess-return math. */
export function buildPriceAnchorCteBody(priceFreshThrough: string): string {
  const through = priceFreshThrough.slice(0, 10);
  return (
    'SELECT r.ticker AS ticker, r.current_price AS current_price, r.current_price_date AS price_date, ' +
    `${spxOnOrBeforePriceDateSql('r.current_price_date')} AS spx_now ` +
    'FROM securities_ref r WHERE r.current_price IS NOT NULL AND r.current_price > 0 ' +
    `AND r.current_price_date IS NOT NULL AND r.current_price_date >= '${through}'`
  );
}

// ---------------------------------------------------------------------------
// 1. Summary — KPI strip
// ---------------------------------------------------------------------------

/** Corpus-wide totals for the window: trades, politicians, tickers, est volume,
 *  buy/sell/exchange counts, resolved-ticker count, option count. */
export function buildSummaryQuery(p: CommonFilters): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const equitySql = canonicalAssetTypeCategorySql('t.asset_type', 't.asset_type_name', 't.is_option');
  const sql =
    'SELECT ' +
    'COUNT(*) AS total_trades, ' +
    'COUNT(DISTINCT t.filer_id) AS unique_members, ' +
    `COUNT(DISTINCT CASE WHEN ${TICKER_RESOLVED_SQL} THEN t.ticker END) AS unique_tickers, ` +
    `${BUY} AS buy_count, ` +
    `${SELL} AS sell_count, ` +
    "SUM(CASE WHEN t.tx_type = 'E' THEN 1 ELSE 0 END) AS exchange_count, " +
    `SUM(${STOCK_MID}) AS est_volume, ` +
    `SUM(${STOCK_SIGNED}) AS est_net_flow, ` +
    `SUM(CASE WHEN ${TICKER_RESOLVED_SQL} THEN 1 ELSE 0 END) AS resolved_ticker_count, ` +
    `SUM(CASE WHEN ${equitySql} = 'public_equity' THEN 1 ELSE 0 END) AS equity_trade_count, ` +
    `SUM(CASE WHEN ${equitySql} = 'public_equity' AND ${TICKER_RESOLVED_SQL} THEN 1 ELSE 0 END) AS resolved_equity_ticker_count, ` +
    // Equity-LIKE population: rows typed public_equity PLUS rows whose type is
    // still 'unknown'.  A description with no ticker and no [ST] code (the House
    // scanned form's "Provide full name, not ticker symbol", or an OGE row whose
    // name starts with a row number) is typed unknown, so counting only
    // public_equity in the denominator hid exactly the rows that lacked a ticker
    // (board row 16b46688: 95.6% headline vs 45% of all rows).
    `SUM(CASE WHEN ${equitySql} IN ('public_equity', 'unknown') THEN 1 ELSE 0 END) AS equity_like_trade_count, ` +
    `SUM(CASE WHEN ${equitySql} IN ('public_equity', 'unknown') AND ${TICKER_RESOLVED_SQL} THEN 1 ELSE 0 END) AS resolved_equity_like_ticker_count, ` +
    'SUM(CASE WHEN t.is_option = 1 THEN 1 ELSE 0 END) AS option_count ' +
    ANALYTICS_FROM_JOINS +
    whereSql(where);
  return { sql, params };
}

// ---------------------------------------------------------------------------
// 2. Ticker leaderboard — "what is Congress trading?"
// ---------------------------------------------------------------------------

export type TickerSort = 'trades' | 'volume' | 'members' | 'netflow' | 'buys' | 'sells';
const TICKER_SORT_SQL: Record<TickerSort, string> = {
  trades: 'trade_count',
  volume: 'est_volume',
  members: 'member_count',
  netflow: 'est_net_flow',
  buys: 'buy_count',
  sells: 'sell_count',
};
export function asTickerSort(v: unknown): TickerSort {
  return typeof v === 'string' && v in TICKER_SORT_SQL ? (v as TickerSort) : 'trades';
}

export function buildTickerLeaderboardQuery(
  p: CommonFilters & { sort?: TickerSort; limit?: number },
): BuiltQuery {
  const { where, params } = buildCommonFilters({ ...p, tickerNotNull: true });
  const sort = asTickerSort(p.sort);
  const limit = clampLimit(p.limit, 20, 200);
  const sql =
    'SELECT t.ticker AS ticker, sm.name AS name, ' +
    'COUNT(*) AS trade_count, ' +
    `${BUY} AS buy_count, ${SELL} AS sell_count, ` +
    'COUNT(DISTINCT t.filer_id) AS member_count, ' +
    "COUNT(DISTINCT CASE WHEN t.tx_type IN ('B', 'P', 'S') THEN t.filer_id END) AS directional_member_count, " +
    "COUNT(DISTINCT CASE WHEN t.tx_type IN ('B', 'P') THEN t.filer_id END) AS buy_member_count, " +
    "COUNT(DISTINCT CASE WHEN t.tx_type = 'S' THEN t.filer_id END) AS sell_member_count, " +
    `SUM(${STOCK_MID}) AS est_volume, ` +
    `SUM(${STOCK_SIGNED}) AS est_net_flow ` +
    ANALYTICS_FROM_JOINS_SECURITIES +
    whereSql(where) +
    'GROUP BY t.ticker ' +
    `ORDER BY ${TICKER_SORT_SQL[sort]} DESC, trade_count DESC ` +
    `LIMIT ${limit}`;
  return { sql, params };
}

// ---------------------------------------------------------------------------
// 3. Politician leaderboard — "who trades the most?"
// ---------------------------------------------------------------------------

export type MemberSort = 'trades' | 'volume' | 'tickers';
const MEMBER_SORT_SQL: Record<MemberSort, string> = {
  trades: 'trade_count',
  volume: 'est_volume',
  tickers: 'unique_tickers',
};
export function asMemberSort(v: unknown): MemberSort {
  return typeof v === 'string' && v in MEMBER_SORT_SQL ? (v as MemberSort) : 'trades';
}

export function buildMemberLeaderboardQuery(
  p: CommonFilters & { sort?: MemberSort; limit?: number },
): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const allWhere = ['t.filer_id IS NOT NULL', ...where];
  const sort = asMemberSort(p.sort);
  const limit = clampLimit(p.limit, 20, 200);
  const sql =
    'SELECT t.filer_id AS filer_id, COALESCE(fl.display_name, fl.full_name) AS full_name, fl.party AS party, ' +
    `${CHAMBER_EXPR} AS chamber, fl.state AS state, fl.photo_url AS photo_url, ` +
    'COUNT(*) AS trade_count, ' +
    `${BUY} AS buy_count, ${SELL} AS sell_count, ` +
    `COUNT(DISTINCT CASE WHEN ${TICKER_RESOLVED_SQL} THEN t.ticker END) AS unique_tickers, ` +
    `SUM(${MID}) AS est_volume, ` +
    `SUM(${SIGNED}) AS est_net_flow ` +
    ANALYTICS_FROM_JOINS +
    whereSql(allWhere) +
    'GROUP BY t.filer_id ' +
    `ORDER BY ${MEMBER_SORT_SQL[sort]} DESC, trade_count DESC ` +
    `LIMIT ${limit}`;
  return { sql, params };
}

// ---------------------------------------------------------------------------
// 4. Cluster / consensus buys — the strongest noise filter
// ---------------------------------------------------------------------------

/** Tickers where >= minMembers distinct politicians traded the SAME direction in
 *  the window. The headline "N politicians bought X" signal. */
export function buildClusterBuysQuery(
  p: CommonFilters & { minMembers?: number; limit?: number },
): BuiltQuery {
  const { where, params } = buildCommonFilters({
    ...p,
    tickerNotNull: true,
    txTypes: constrainTxTypes(p.txTypes, ['B', 'S']),
  });
  const minMembers = clampLimit(p.minMembers, 3, 50);
  // Max 200 so a caller restricting to a candidate ticker set can fetch both the
  // buy ('B') and sell ('S') cluster row for up to 100 tickers; public callers
  // pin their own limit (see /cluster-buys).
  const limit = clampLimit(p.limit, 12, 200);
  const sql =
    'SELECT t.ticker AS ticker, t.tx_type AS tx_type, sm.name AS name, ' +
    'COUNT(DISTINCT t.filer_id) AS member_count, ' +
    'COUNT(*) AS trade_count, ' +
    'MIN(t.tx_date) AS first_seen, MAX(t.tx_date) AS last_seen, ' +
    `SUM(${MID}) AS est_volume, ` +
    `COUNT(DISTINCT CASE WHEN ${PARTY_BUCKET_SQL} = 'D' THEN t.filer_id END) AS d_members, ` +
    `COUNT(DISTINCT CASE WHEN ${PARTY_BUCKET_SQL} = 'R' THEN t.filer_id END) AS r_members, ` +
    `COUNT(DISTINCT CASE WHEN ${PARTY_BUCKET_SQL} = 'O' THEN t.filer_id END) AS o_members ` +
    ANALYTICS_FROM_JOINS_SECURITIES +
    whereSql(where) +
    'GROUP BY t.ticker, t.tx_type ' +
    `HAVING COUNT(DISTINCT t.filer_id) >= ${minMembers} ` +
    'ORDER BY member_count DESC, trade_count DESC ' +
    `LIMIT ${limit}`;
  return { sql, params };
}

/** Follow-up: per-politician trade counts for a set of cluster tickers, so the route
 *  can attach a few representative politician faces to each cluster card. */
export function buildClusterMembersQuery(
  tickers: string[],
  p: CommonFilters,
): BuiltQuery {
  const { where, params } = buildCommonFilters({
    ...p,
    txTypes: constrainTxTypes(p.txTypes, ['B', 'S']),
  });
  const placeholders = tickers.map(() => '?').join(', ');
  const allWhere = [`t.ticker IN (${placeholders})`, ...where];
  const allParams: SqlParam[] = [...tickers, ...params];
  const sql =
    'SELECT t.ticker AS ticker, t.tx_type AS tx_type, t.filer_id AS filer_id, ' +
    'COALESCE(fl.display_name, fl.full_name) AS full_name, fl.party AS party, fl.photo_url AS photo_url, ' +
    'COUNT(*) AS trade_count ' +
    ANALYTICS_FROM_JOINS +
    whereSql(allWhere) +
    'GROUP BY t.ticker, t.tx_type, t.filer_id ' +
    'ORDER BY trade_count DESC';
  return { sql, params: allParams };
}

// ---------------------------------------------------------------------------
// 5. Trending / momentum — recent period vs prior equal period
// ---------------------------------------------------------------------------

/** Map a window to (recentOffset, priorStartOffset) day modifiers: the recent
 *  period is the window, the prior period is the equal-length span before it.
 *  'all' has no natural prior period, so it falls back to a 90-day comparison
 *  (30d was too short — on sparse data nearly every ticker showed 0→1). */
export function momentumOffsets(w: Window): { recent: string; priorStart: string } {
  const d = windowDays(w) ?? 90;
  return { recent: `-${d} days`, priorStart: `-${2 * d} days` };
}

/**
 * Tickers heating up: trade count in the recent period vs the prior equal-length
 * period, ranked by the increase. The recent/prior date literals come from the
 * validated window (a closed set), so they are interpolated, not bound — which
 * keeps the many SELECT-side date references from scrambling param order.
 */
export function buildTrendingQuery(
  p: Omit<CommonFilters, 'window'> & { window?: Window; limit?: number; bySide?: boolean },
): BuiltQuery {
  const w = p.window ?? '30d';
  const { recent, priorStart } = momentumOffsets(w);
  const recentLit = `date('now', '${recent}')`;
  const priorLit = `date('now', '${priorStart}')`;
  // Max 200 so a bySide caller restricting to a candidate set can fetch both
  // sides for up to 100 tickers; public callers pin their own limit (see /trending).
  const limit = clampLimit(p.limit, 20, 200);

  // Build filters WITHOUT the window clause (we manage the date range manually).
  const { where, params } = buildCommonFilters({ ...p, window: 'all', tickerNotNull: true });
  const allWhere = [`t.tx_date >= ${priorLit}`, ...where];

  const recentCount = `SUM(CASE WHEN t.tx_date >= ${recentLit} THEN 1 ELSE 0 END)`;
  const priorCount = `SUM(CASE WHEN t.tx_date < ${recentLit} THEN 1 ELSE 0 END)`;
  const recentMembers = `COUNT(DISTINCT CASE WHEN t.tx_date >= ${recentLit} THEN t.filer_id END)`;
  const recentVol = `SUM(CASE WHEN t.tx_date >= ${recentLit} THEN ${MID} ELSE 0 END)`;
  const recentNet = `SUM(CASE WHEN t.tx_date >= ${recentLit} THEN ${SIGNED} ELSE 0 END)`;

  // `bySide` groups by (ticker, tx_type) so a caller can read momentum for ONE
  // direction (purchases vs sales) instead of the combined ticker total — the
  // conviction score needs the rising/falling activity for the side it resolved
  // to, not a mix where rising buys could feed a SELL signal.
  const sideSelect = p.bySide ? 't.tx_type AS tx_type, ' : '';
  const groupBy = p.bySide ? 'GROUP BY t.ticker, t.tx_type ' : 'GROUP BY t.ticker ';

  const sql =
    'SELECT t.ticker AS ticker, sm.name AS name, ' +
    sideSelect +
    `${recentCount} AS recent_count, ` +
    `${priorCount} AS prior_count, ` +
    `${recentMembers} AS recent_members, ` +
    `${recentVol} AS recent_volume, ` +
    `${recentNet} AS recent_net_flow ` +
    ANALYTICS_FROM_JOINS_SECURITIES +
    whereSql(allWhere) +
    groupBy +
    // Require >=2 recent trades so a single new trade doesn't read as "rising".
    'HAVING recent_count >= 2 ' +
    'ORDER BY (recent_count - prior_count) DESC, recent_count DESC ' +
    `LIMIT ${limit}`;
  return { sql, params };
}

// ---------------------------------------------------------------------------
// 6. Volume over time — buys vs sells per period
// ---------------------------------------------------------------------------

export function buildVolumeOverTimeQuery(
  p: CommonFilters & { granularity: Granularity },
): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const allWhere = ['t.tx_date IS NOT NULL', ...where];
  const sql =
    'SELECT strftime(?, t.tx_date) AS period, ' +
    `${BUY} AS buys, ${SELL} AS sells, ` +
    `SUM(CASE WHEN t.tx_type IN ('B', 'P') THEN ${STOCK_MID} ELSE 0 END) AS est_buy_vol, ` +
    `SUM(CASE WHEN t.tx_type = 'S' THEN ${STOCK_MID} ELSE 0 END) AS est_sell_vol ` +
    ANALYTICS_FROM_JOINS +
    whereSql(allWhere) +
    'GROUP BY period ORDER BY period ASC';
  // strftime() format is a SELECT-side bind → must precede the WHERE params.
  return { sql, params: [granularityFormat(p.granularity), ...params] };
}

// ---------------------------------------------------------------------------
// 7. Party split — D vs R vs Other
// ---------------------------------------------------------------------------

/** Overall buys/sells/volume/net per party bucket. */
export function buildPartySplitQuery(p: CommonFilters): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const sql =
    `SELECT ${PARTY_BUCKET_SQL} AS party, ` +
    `${BUY} AS buys, ${SELL} AS sells, ` +
    `SUM(${MID}) AS est_volume, SUM(${SIGNED}) AS est_net_flow, ` +
    'COUNT(DISTINCT t.filer_id) AS members ' +
    ANALYTICS_FROM_JOINS +
    whereSql(where) +
    // Group by the bucket EXPRESSION, not the `party` alias: in SQLite a bare
    // GROUP BY identifier binds to the joined `fl.party` column first, which
    // split every raw spelling ("Democrat"/"Democratic"/"D") into its own row.
    `GROUP BY ${PARTY_BUCKET_SQL}`;
  return { sql, params };
}

/** Party buys/sells per time period (for the stacked time chart). */
export function buildPartySplitOverTimeQuery(
  p: CommonFilters & { granularity: Granularity },
): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const allWhere = ['t.tx_date IS NOT NULL', ...where];
  const sql =
    `SELECT strftime(?, t.tx_date) AS period, ${PARTY_BUCKET_SQL} AS party, ` +
    `${BUY} AS buys, ${SELL} AS sells ` +
    ANALYTICS_FROM_JOINS +
    whereSql(allWhere) +
    // Same alias-vs-column trap as buildPartySplitQuery: group by the bucket.
    `GROUP BY period, ${PARTY_BUCKET_SQL} ORDER BY period ASC`;
  return { sql, params: [granularityFormat(p.granularity), ...params] };
}

// ---------------------------------------------------------------------------
// 8. Instrument-type breakdown - canonicalized across House codes and Senate labels.
// ---------------------------------------------------------------------------

export function buildSectorBreakdownQuery(p: CommonFilters & { limit?: number }): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const limit = clampLimit(p.limit, 20, 100);
  const categorySql = canonicalAssetTypeCategorySql('t.asset_type', 't.asset_type_name', 't.is_option');
  // Same volume/net/breadth shape as market-cap + sector-flow so the Trends
  // "By Asset Type" card can use the shared flowRow layout (label+value /
  // full-width bar / buys-sells-net chip) without a one-off hbar layout.
  const sql =
    `SELECT ${categorySql} AS asset_type_category, ` +
    "GROUP_CONCAT(DISTINCT COALESCE(NULLIF(t.asset_type, ''), 'Unknown')) AS raw_asset_types, " +
    'COUNT(*) AS trade_count, ' +
    `${BUY} AS buy_count, ${SELL} AS sell_count, ` +
    `SUM(${MID}) AS est_volume, ` +
    `SUM(${SIGNED}) AS est_net_flow, ` +
    'COUNT(DISTINCT t.filer_id) AS unique_members, ' +
    `COUNT(DISTINCT CASE WHEN ${TICKER_RESOLVED_SQL} THEN t.ticker END) AS unique_tickers ` +
    ANALYTICS_FROM_JOINS +
    whereSql(where) +
    'GROUP BY asset_type_category ORDER BY trade_count DESC ' +
    `LIMIT ${limit}`;
  return { sql, params };
}

// ---------------------------------------------------------------------------
// 8b. Real GICS sector flow + market-cap tilt (from securities_ref enrichment)
// ---------------------------------------------------------------------------

/**
 * Junk sentinels that providers write into `securities_ref.sector` instead of
 * leaving it NULL. `COALESCE(NULLIF(sector, ''), 'Unknown')` only ever caught
 * the empty string, so a literal 'N/A' shipped as its own sector bucket in the
 * chart. Compared against the lower-cased, trimmed label.
 */
const SECTOR_UNKNOWN_SENTINELS = [
  '',
  '-',
  '--',
  'n/a',
  'n\\a',
  'na',
  'none',
  'null',
  'nil',
  'unknown',
  'not available',
  'not applicable',
];

/**
 * Duplicate spellings and sub-industries that several enrichment providers write
 * into ONE `securities_ref.sector` column, mapped onto the canonical vocabulary
 * already dominant in that column (FMP's eleven: Basic Materials, Communication
 * Services, Consumer Cyclical, Consumer Defensive, Energy, Financial Services,
 * Healthcare, Industrials, Real Estate, Technology, Utilities). Without this the
 * chart paints "Healthcare" and "Health Care" as two sectors, and ranks
 * "Semiconductors" against "Technology" as if they were peers.
 *
 * Keys are lower-cased/space-collapsed, so casing variants fold in for free —
 * the canonical labels are listed as identity entries for exactly that reason.
 *
 * DELIBERATELY NOT MAPPED (verified against the tickers actually carrying each
 * label in production, 2026-08-11 — the obvious mapping is wrong for every one):
 *   - 'Financials'      → a provider catch-all, NOT the finance sector: it holds
 *                         Treasury CUSIPs (91282CGH8), mutual funds (ABYIX,
 *                         TGBAX), an option symbol (SPY160219P00180000), index
 *                         tickers (^MWE) and a literal '--'.
 *   - 'Communications'  → ANET/CSCO/EMKR/HLIT — networking HARDWARE, which the
 *                         canonical vocabulary files under Technology, not
 *                         Communication Services.
 *   - 'Mining'          → CRZO/ESV/NBL/WPX — oil & gas names, i.e. Energy.
 *   - 'Electrical Equipment' → splits APH/GLW/TEL (Technology) against
 *                         ETN/HUBB/ROK/GEV (Industrials).
 *   - 'Packaging'       → GICS says Materials, FMP says Consumer Cyclical; the
 *                         column already speaks FMP, so either choice is a lie.
 *   - 'Retail', 'Retail Trade', 'Wholesale Trade', 'Consumer products',
 *     'Manufacturing', 'Services', 'Construction', 'Building', 'Distributors',
 *     'Transportation & Utilities', 'Finance, Insurance & Real Estate',
 *     'Transportation, Communications, Electric, Gas, And Sanitary Services'
 *                       → SIC-style divisions that genuinely span two or more
 *                         canonical sectors (e.g. 'Retail' carries both WMT/KR
 *                         and AMZN/HD).
 * Those fall through to their ORIGINAL label rather than being folded into a
 * wrong bucket or swallowed into 'Unknown' — nothing disappears silently.
 */
const SECTOR_CANONICAL_ALIASES: Record<string, string> = {
  // Canonical labels, as identity entries (folds in casing/spacing variants).
  'basic materials': 'Basic Materials',
  'communication services': 'Communication Services',
  'consumer cyclical': 'Consumer Cyclical',
  'consumer defensive': 'Consumer Defensive',
  energy: 'Energy',
  'financial services': 'Financial Services',
  healthcare: 'Healthcare',
  industrials: 'Industrials',
  'real estate': 'Real Estate',
  technology: 'Technology',
  utilities: 'Utilities',

  // Spelling variants.
  'health care': 'Healthcare',

  // Sub-industries whose parent sector is unambiguous in BOTH GICS and FMP.
  banking: 'Financial Services',
  insurance: 'Financial Services',

  biotechnology: 'Healthcare',
  'life sciences tools & services': 'Healthcare',
  'life sciences tools and services': 'Healthcare',
  pharmaceuticals: 'Healthcare',

  semiconductors: 'Technology',

  media: 'Communication Services',
  telecommunication: 'Communication Services',
  telecommunications: 'Communication Services',

  'aerospace & defense': 'Industrials',
  'aerospace and defense': 'Industrials',
  airlines: 'Industrials',
  'industrial conglomerates': 'Industrials',
  'logistics & transportation': 'Industrials',
  'logistics and transportation': 'Industrials',
  machinery: 'Industrials',
  marine: 'Industrials',
  'professional services': 'Industrials',
  'road & rail': 'Industrials',
  'road and rail': 'Industrials',
  'trading companies & distributors': 'Industrials',
  'trading companies and distributors': 'Industrials',

  'auto components': 'Consumer Cyclical',
  automobiles: 'Consumer Cyclical',
  'diversified consumer services': 'Consumer Cyclical',
  'hotels, restaurants & leisure': 'Consumer Cyclical',
  'hotels, restaurants and leisure': 'Consumer Cyclical',

  beverages: 'Consumer Defensive',
  'food products': 'Consumer Defensive',
  tobacco: 'Consumer Defensive',

  chemicals: 'Basic Materials',
  'metals & mining': 'Basic Materials',
  'metals and mining': 'Basic Materials',
  'paper & forest': 'Basic Materials',
  'paper and forest': 'Basic Materials',
};

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * SQL CASE that folds the multi-vocabulary `securities_ref.sector` column onto
 * one canonical label. Same shape as `canonicalAssetTypeCategorySql`: normalize
 * once, list the known aliases, fall through to the untouched original so an
 * unrecognised label stays visible instead of vanishing.
 *
 * `sectorExpr` must be a bare column reference — it is inlined several times.
 */
export function canonicalSectorSql(sectorExpr = 'sr.sector'): string {
  // Flatten tabs/newlines, trim, then collapse internal runs so 'Health  Care'
  // and a tab-padded ' Healthcare\t' fold onto the same key. SQLite's trim()
  // only strips spaces, hence the explicit char(9)/char(10) pass first.
  const flat = `replace(replace(coalesce(${sectorExpr}, ''), char(9), ' '), char(10), ' ')`;
  const raw = `trim(${flat})`;
  const norm = `replace(replace(lower(${raw}), '  ', ' '), '  ', ' ')`;
  const unknownWhen = SECTOR_UNKNOWN_SENTINELS.map((s) => sqlStringLiteral(s)).join(', ');
  const aliasWhen = Object.entries(SECTOR_CANONICAL_ALIASES)
    .map(([alias, canonical]) => `WHEN ${norm} = ${sqlStringLiteral(alias)} THEN ${sqlStringLiteral(canonical)}`)
    .join(' ');
  return `(CASE WHEN ${norm} IN (${unknownWhen}) THEN 'Unknown' ${aliasWhen} ELSE ${raw} END)`;
}

/**
 * Net buy/sell flow by REAL sector (securities_ref.sector) — distinct from
 * buildSectorBreakdownQuery, which groups by the free-text `asset_type` (an
 * instrument class, not a sector). Reports signed net flow so a sector's
 * accumulation vs distribution is visible, plus politician/ticker breadth.
 *
 * Sector labels are canonicalized (see `canonicalSectorSql`) so provider
 * vocabularies collapse into one bucket per sector.
 *
 * TICKER GATE (product decision, unchanged): `TICKER_RESOLVED_SQL` restricts
 * this chart to trades whose ticker resolved, so munis, funds and other
 * non-tickered assets are absent from BOTH this and the market-cap chart. The
 * trade counts here therefore do NOT reconcile with the corpus-wide totals.
 */
export function buildSectorFlowQuery(p: CommonFilters & { limit?: number }): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const limit = clampLimit(p.limit, 20, 100);
  const allWhere = [TICKER_RESOLVED_SQL, ...where];
  const sql =
    `SELECT ${canonicalSectorSql()} AS sector, ` +
    'COUNT(*) AS trade_count, ' +
    `${BUY} AS buy_count, ${SELL} AS sell_count, ` +
    `SUM(${MID}) AS est_volume, ` +
    `SUM(${SIGNED}) AS est_net_flow, ` +
    'COUNT(DISTINCT t.filer_id) AS unique_members, ' +
    'COUNT(DISTINCT t.ticker) AS unique_tickers ' +
    ANALYTICS_FROM_JOINS_REF +
    whereSql(allWhere) +
    'GROUP BY sector ORDER BY trade_count DESC ' +
    `LIMIT ${limit}`;
  return { sql, params };
}

/**
 * Net flow + activity by market-cap bucket (securities_ref.market_cap_bucket:
 * mega…nano). Surfaces a size tilt (e.g. concentration in small/micro caps).
 * Un-enriched rows collapse to 'unknown'.
 *
 * Shares the sector chart's TICKER_RESOLVED_SQL gate (product decision, left
 * as-is): a trade without a resolved ticker has no securities_ref row, so it
 * cannot carry a market cap. Both charts therefore describe the tickered subset
 * of the corpus, not the whole of it.
 */
export function buildMarketCapBreakdownQuery(p: CommonFilters): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const allWhere = [TICKER_RESOLVED_SQL, ...where];
  const sql =
    "SELECT COALESCE(NULLIF(sr.market_cap_bucket, ''), 'unknown') AS bucket, " +
    'COUNT(*) AS trade_count, ' +
    `${BUY} AS buy_count, ${SELL} AS sell_count, ` +
    `SUM(${MID}) AS est_volume, ` +
    `SUM(${SIGNED}) AS est_net_flow, ` +
    'COUNT(DISTINCT t.filer_id) AS unique_members, ' +
    'COUNT(DISTINCT t.ticker) AS unique_tickers ' +
    ANALYTICS_FROM_JOINS_REF +
    whereSql(allWhere) +
    'GROUP BY bucket';
  return { sql, params };
}

// ---------------------------------------------------------------------------
// 9. Filing lag — disclosure timeliness
// ---------------------------------------------------------------------------

/** Histogram of (filed_date - tx_date) in whole days. Negatives (filed before
 *  the trade — data noise) are excluded. Summarized in the Worker. */
export function buildFilingLagHistogramQuery(p: CommonFilters): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const allWhere = [
    't.tx_date IS NOT NULL',
    'f.filed_date IS NOT NULL',
    'julianday(f.filed_date) >= julianday(t.tx_date)',
    "NOT (t.source = 'competitor_backfill' AND f.filed_date = t.tx_date)",
    ...where,
  ];
  const sql =
    'SELECT CAST(julianday(f.filed_date) - julianday(t.tx_date) AS INTEGER) AS lag_days, ' +
    'COUNT(*) AS cnt ' +
    ANALYTICS_FROM_JOINS +
    whereSql(allWhere) +
    'GROUP BY lag_days';
  return { sql, params };
}

/** Per-politician average/max/late-count disclosure lag (the "late filers" board). */
export function buildLateFilersQuery(p: CommonFilters & { limit?: number }): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const limit = clampLimit(p.limit, 50, 100);
  const lag = '(julianday(f.filed_date) - julianday(t.tx_date))';
  const allWhere = [
    't.filer_id IS NOT NULL',
    't.tx_date IS NOT NULL',
    'f.filed_date IS NOT NULL',
    `julianday(f.filed_date) >= julianday(t.tx_date)`,
    "NOT (t.source = 'competitor_backfill' AND f.filed_date = t.tx_date)",
    ...where,
  ];
  const sql =
    'SELECT t.filer_id AS filer_id, COALESCE(fl.display_name, fl.full_name) AS full_name, fl.party AS party, fl.state AS state, ' +
    `${CHAMBER_EXPR} AS chamber, fl.photo_url AS photo_url, ` +
    `AVG(${lag}) AS avg_lag_days, MAX(${lag}) AS max_lag_days, ` +
    `SUM(CASE WHEN ${lag} > 45 THEN 1 ELSE 0 END) AS late_count, ` +
    'COUNT(*) AS trade_count ' +
    ANALYTICS_FROM_JOINS +
    whereSql(allWhere) +
    'GROUP BY t.filer_id ' +
    'HAVING trade_count >= 3 ' +
    'ORDER BY avg_lag_days DESC ' +
    `LIMIT ${limit}`;
  return { sql, params };
}

// ---------------------------------------------------------------------------
// 9b. Politician performance leaderboard — excess return vs the S&P 500
// ---------------------------------------------------------------------------

/**
 * Per-politician realized performance of their BUYS, measured as excess return vs
 * the S&P 500, anchored at the FILING (disclosure) date — the only price a
 * follower could actually have transacted at (trade-date anchoring would bake in
 * the move that happened before the trade was public). Each trade's excess is
 *
 *   ((current_price / price_at_filing − 1) − (spx_now / spx_at_filing − 1))
 *   annualized by elapsed days since the public filing anchor.
 *
 * Options are excluded (no EOD-equity anchor); only resolved, non-retracted buys
 * with both a filing anchor and a current price count. Asset-class filtered to
 * public equity only (see `canonicalAssetTypeCategorySql`) — crypto and other
 * misc disclosure rows sometimes carry a ticker string that collides with an
 * unrelated public-equity ticker (e.g. a crypto symbol matching a small-cap
 * stock in `securities_ref`), which would otherwise price the crypto trade off
 * the wrong instrument. `minTrades` (validated int, default 5) is a small-N
 * guard so a 1–2 trade "leader" can't top the board.
 *
 * Each trade's excess is winsorized (flat-capped) to ±200% before aggregating
 * — mirrors the spirit of pitScores' percentile winsorization, but with a flat
 * cap rather than p5/p95: per-member sample sizes here are too small (5+
 * trades) for percentile winsorization to be stable, and a flat cap is cheap
 * to reason about (still leaves room for genuine 2x-vs-SPX outperformance).
 * Without it, a single multi-bagger trade can swing a member's entire average.
 *
 * `avg_excess` (size-weighted, winsorized, NOT annualized) is both what the
 * card displays AND what it sorts by, so the rank always matches the number
 * shown. `avg_annualized_excess` is still reported for reference/debugging,
 * but the annualization multiplier (up to ~12x for a 30-day-old trade) makes
 * it unsuitable as the primary sort — it was the original bug here.
 *
 * medianExcess is intentionally NOT computed in this query: SQLite/D1 has no
 * built-in per-group percentile function, and a correlated subquery per
 * `filer_id` group would add real cost to an endpoint that already 502s under
 * load. The member-drawer endpoint computes median in application code over a
 * single member's rows, which is cheap; doing that for every leaderboard row
 * is not. Skipped per perf constraint, not an oversight.
 */
export function buildMemberPerformanceLeaderboardQuery(
  p: CommonFilters & { limit?: number; minTrades?: number; priceFreshThrough: string },
): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const limit = clampLimit(p.limit, 20, 100);
  const minTrades = clampLimit(p.minTrades, 5, 1000);
  // Excess return of one buy vs SPX.  The entry legs are anchored at the filing
  // date; the EXIT legs are aligned to ONE as-of date per ticker: the asset's
  // current price is the close on securities_ref.current_price_date, so the S&P
  // leg ends on the S&P close on or before that same date (see PRICE_ANCHOR_CTE).
  // Board row 6c05e09b: a single "latest S&P close" joined to every ticker's own
  // price date subtracted up to ten days of market move from stale-priced tickers.
  const EXCESS =
    '((px.current_price / p.price_at_filing) - 1.0) - ((px.spx_now / p.spx_at_filing) - 1.0)';
  // Flat winsorization cap: clip each trade's excess to [-200%, +200%] before
  // it feeds any aggregate. See the doc comment above for why flat vs percentile.
  const WINSOR_EXCESS = `MAX(-2.0, MIN(2.0, (${EXCESS})))`;
  const ANCHOR_DATE = 'COALESCE(f.filed_date, f.first_seen_at, t.tx_date)';
  const ELAPSED_DAYS = `(julianday('now') - julianday(${ANCHOR_DATE}))`;
  const ANNUALIZED_EXCESS = `((${WINSOR_EXCESS}) * (365.25 / MAX(30.0, ${ELAPSED_DAYS})))`;
  // Public-equity rows only — see the doc comment above for why.
  const categorySql = canonicalAssetTypeCategorySql('t.asset_type', 't.asset_type_name', 't.is_option');
  const allWhere = [
    "t.tx_type IN ('B', 'P')",
    't.is_option = 0',
    `${categorySql} = 'public_equity'`,
    'p.price_at_filing IS NOT NULL AND p.price_at_filing > 0',
    'p.spx_at_filing IS NOT NULL AND p.spx_at_filing > 0',
    'px.current_price IS NOT NULL AND px.current_price > 0',
    'px.spx_now IS NOT NULL AND px.spx_now > 0',
    `julianday(${ANCHOR_DATE}) IS NOT NULL`,
    `${ELAPSED_DAYS} > 0`,
    't.filer_id IS NOT NULL',
    ...where,
  ];
  const sql =
    `WITH px AS MATERIALIZED (${buildPriceAnchorCteBody(p.priceFreshThrough)}) ` +
    'SELECT t.filer_id AS filer_id, MAX(COALESCE(fl.display_name, fl.full_name)) AS full_name, MAX(fl.party) AS party, ' +
    'MAX(fl.photo_url) AS photo_url, ' +
    'MAX(px.price_date) AS prices_as_of, ' +
    'COUNT(*) AS trade_count, ' +
    `COALESCE(SUM((${ANNUALIZED_EXCESS}) * ${MID}) / NULLIF(SUM(${MID}), 0), AVG(${ANNUALIZED_EXCESS})) AS avg_annualized_excess, ` +
    `COALESCE(SUM((${WINSOR_EXCESS}) * ${MID}) / NULLIF(SUM(${MID}), 0), AVG(${WINSOR_EXCESS})) AS avg_excess, ` +
    `SUM(CASE WHEN ${ANNUALIZED_EXCESS} > 0 THEN 1 ELSE 0 END) AS wins, ` +
    `SUM(${MID}) AS est_volume ` +
    'FROM transactions t ' +
    'JOIN tx_performance p ON p.tx_id = t.id ' +
    'LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id ' +
    'LEFT JOIN filings f ON f.doc_id = t.doc_id ' +
    'JOIN px ON px.ticker = t.ticker ' +
    whereSql(allWhere) +
    'GROUP BY t.filer_id ' +
    `HAVING trade_count >= ${minTrades} AND avg_excess IS NOT NULL ` +
    'ORDER BY avg_excess DESC ' +
    `LIMIT ${limit}`;
  return { sql, params };
}

// ---------------------------------------------------------------------------
// 9b. Conviction realized-skill inputs
// ---------------------------------------------------------------------------

/**
 * Distinct (ticker, side, politician) rows for the directional trades on a candidate
 * ticker set in the window — i.e. "who traded each candidate, on which side".
 * Keyed by tx_type so the conviction rollup can use ONLY the politicians on the side
 * the signal resolves to. Caller must chunk `tickers` under D1's 100-bind cap.
 */
export function buildConvictionMemberLinksQuery(tickers: string[], p: CommonFilters): BuiltQuery {
  const { where, params } = buildCommonFilters({
    ...p,
    tickers,
    txTypes: constrainTxTypes(p.txTypes, ['B', 'S']),
  });
  const allWhere = ['t.filer_id IS NOT NULL', ...where];
  const sql =
    'SELECT DISTINCT t.ticker AS ticker, t.tx_type AS tx_type, t.filer_id AS filer_id ' +
    ANALYTICS_FROM_JOINS +
    whereSql(allWhere);
  return { sql, params };
}

/**
 * Per-politician realized "skill" over their FULL track record (all-time): scored buy
 * count, wins (filing-anchored excess vs the S&P > 0), and average excess. Same
 * EXCESS basis as the performance leaderboard. The window is intentionally OMITTED
 * (skill is a career track record), but the trade-level source / minConf filters
 * ARE honored so the skill matches the requested analytics slice (e.g.
 * ?source=primary won't let seed-dataset buys leak in). Only politicians with >= 5
 * scored buys are returned. Caller must chunk `filerIds` under D1's 100-bind cap.
 */
export function buildMemberSkillQuery(
  filerIds: string[],
  p: CommonFilters & { priceFreshThrough: string },
): BuiltQuery {
  // Same as-of-aligned exit legs as the performance leaderboard (see PRICE_ANCHOR_CTE_BODY).
  const EXCESS =
    '((px.current_price / p.price_at_filing) - 1.0) - ((px.spx_now / p.spx_at_filing) - 1.0)';
  const where = [
    't.deprecated_at IS NULL',
    "t.tx_type IN ('B', 'P')",
    't.is_option = 0',
    'p.price_at_filing IS NOT NULL AND p.price_at_filing > 0',
    'p.spx_at_filing IS NOT NULL AND p.spx_at_filing > 0',
    'px.current_price IS NOT NULL',
    'px.spx_now IS NOT NULL AND px.spx_now > 0',
  ];
  const params: SqlParam[] = [];
  if (p.source && p.source !== 'all') {
    where.push('t.source = ?');
    params.push(p.source);
  }
  if (typeof p.minConf === 'number' && Number.isFinite(p.minConf)) {
    where.push('t.confidence >= ?');
    params.push(p.minConf);
  }
  where.push(`t.filer_id IN (${filerIds.map(() => '?').join(', ')})`);
  for (const id of filerIds) params.push(id);
  const sql =
    `WITH px AS MATERIALIZED (${buildPriceAnchorCteBody(p.priceFreshThrough)}) ` +
    'SELECT t.filer_id AS filer_id, COUNT(*) AS scored, ' +
    `SUM(CASE WHEN ${EXCESS} > 0 THEN 1 ELSE 0 END) AS wins, ` +
    `AVG(${EXCESS}) AS avg_excess ` +
    'FROM transactions t ' +
    'JOIN tx_performance p ON p.tx_id = t.id ' +
    'JOIN px ON px.ticker = t.ticker ' +
    whereSql(where) +
    'GROUP BY t.filer_id ' +
    'HAVING scored >= 5';
  return { sql, params };
}

// ---------------------------------------------------------------------------
// 10. Single-ticker deep dive
// ---------------------------------------------------------------------------

function tickerFilters(ticker: string, p: CommonFilters): { where: string[]; params: SqlParam[] } {
  const { where, params } = buildCommonFilters(p);
  return { where: ['t.ticker = ?', ...where], params: [ticker.toUpperCase(), ...params] };
}

export function buildTickerSummaryQuery(ticker: string, p: CommonFilters): BuiltQuery {
  const { where, params } = tickerFilters(ticker, p);
  const sql =
    'SELECT COUNT(*) AS total_trades, ' +
    `${BUY} AS buy_count, ${SELL} AS sell_count, ` +
    'COUNT(DISTINCT t.filer_id) AS member_count, ' +
    `SUM(${STOCK_MID}) AS est_volume, SUM(${STOCK_SIGNED}) AS est_net_flow, ` +
    'SUM(CASE WHEN t.is_option = 1 THEN 1 ELSE 0 END) AS option_count, ' +
    'MIN(t.tx_date) AS first_trade, MAX(t.tx_date) AS last_trade ' +
    ANALYTICS_FROM_JOINS +
    whereSql(where);
  return { sql, params };
}

/**
 * Buy-cohort trade dates for a ticker backtest: BUYS only, options and
 * null/empty trade dates excluded, honoring the shared window/chamber/party/
 * source/minConf filters (+ optional single politician). The route computes forward
 * returns in-memory from the price series (see aggregateTickerBacktest), so this
 * only needs the dates.
 */
export function buildTickerBacktestCohortQuery(
  ticker: string,
  p: CommonFilters,
  filerId?: string,
): BuiltQuery {
  const { where, params } = tickerFilters(ticker, { ...p, txTypes: ['B'] });
  const allWhere = [...where, 't.is_option = 0', "t.tx_date IS NOT NULL", "t.tx_date <> ''"];
  if (filerId) {
    allWhere.push('t.filer_id = ?');
    params.push(filerId);
  }
  const sql =
    'SELECT t.tx_date AS tx_date ' + ANALYTICS_FROM_JOINS + whereSql(allWhere) + 'ORDER BY t.tx_date ASC';
  return { sql, params };
}

/**
 * Candidate trades for the committee conflict-of-interest signal: trades by a
 * politician WITH committees, in a resolved sector. The route applies the curated
 * committee→sector map (see committeeConflict) to keep only true conflicts, so
 * this just pre-filters to rows that could possibly conflict.
 */
export function buildConflictCandidatesQuery(p: CommonFilters & { limit?: number }): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const allWhere = [
    ...where,
    't.ticker IS NOT NULL',
    'sr.sector IS NOT NULL',
    'fl.committees IS NOT NULL',
    "fl.committees <> ''",
    "fl.committees <> '[]'",
  ];
  const limit = clampLimit(p.limit, 200, 2000);
  const sql =
    'SELECT t.id AS id, t.ticker AS ticker, t.tx_type AS tx_type, t.tx_date AS tx_date, ' +
    `t.filer_id AS filer_id, COALESCE(fl.display_name, fl.full_name) AS full_name, ${CHAMBER_EXPR} AS chamber, fl.party AS party, ` +
    'fl.committees AS committees, sr.sector AS sector, t.amount_min AS amount_min, t.amount_max AS amount_max ' +
    ANALYTICS_FROM_JOINS +
    'LEFT JOIN securities_ref sr ON sr.ticker = t.ticker ' +
    whereSql(allWhere) +
    `ORDER BY t.tx_date DESC LIMIT ${limit}`;
  return { sql, params };
}

export function buildTickerTimeSeriesQuery(
  ticker: string,
  p: CommonFilters & { granularity: Granularity },
): BuiltQuery {
  const { where, params } = tickerFilters(ticker, p);
  const allWhere = [...where, 't.tx_date IS NOT NULL'];
  const sql =
    'SELECT strftime(?, t.tx_date) AS period, ' +
    `${BUY} AS buys, ${SELL} AS sells, ` +
    `SUM(CASE WHEN t.tx_type IN ('B', 'P') THEN ${STOCK_MID} ELSE 0 END) AS est_buy_vol, ` +
    `SUM(CASE WHEN t.tx_type = 'S' THEN ${STOCK_MID} ELSE 0 END) AS est_sell_vol ` +
    ANALYTICS_FROM_JOINS +
    whereSql(allWhere) +
    ' GROUP BY period ORDER BY period ASC';
  return { sql, params: [granularityFormat(p.granularity), ...params] };
}

/** Top buyers (txType 'B') or sellers ('S') of one ticker. */
export function buildTickerTopTradersQuery(
  ticker: string,
  txType: 'B' | 'S',
  p: CommonFilters & { limit?: number },
): BuiltQuery {
  const { where, params } = tickerFilters(ticker, { ...p, txTypes: [txType] });
  const limit = clampLimit(p.limit, 5, 50);
  const sql =
    'SELECT t.filer_id AS filer_id, COALESCE(fl.display_name, fl.full_name) AS full_name, fl.party AS party, ' +
    'fl.photo_url AS photo_url, COUNT(*) AS trade_count, ' +
    `SUM(${MID}) AS est_volume ` +
    ANALYTICS_FROM_JOINS +
    whereSql(where) +
    'GROUP BY t.filer_id ORDER BY est_volume DESC, trade_count DESC ' +
    `LIMIT ${limit}`;
  return { sql, params };
}

export function buildTickerRecentTradesQuery(
  ticker: string,
  p: CommonFilters & { limit?: number },
): BuiltQuery {
  const { where, params } = tickerFilters(ticker, p);
  const limit = clampLimit(p.limit, 15, 100);
  const sql =
    'SELECT t.id AS id, t.doc_id AS doc_id, t.ticker AS ticker, t.asset_name AS asset_name, ' +
    't.asset_type AS asset_type, t.asset_type_name AS asset_type_name, t.raw_text AS raw_text, ' +
    't.source AS source, t.tx_date AS tx_date, t.tx_type AS tx_type, t.owner AS owner, ' +
    't.amount_min AS amount_min, t.amount_max AS amount_max, t.is_option AS is_option, ' +
    't.created_at AS created_at, t.filer_id AS filer_id, COALESCE(fl.display_name, fl.full_name) AS full_name, ' +
    'fl.party AS party, fl.photo_url AS photo_url, f.filed_date AS filed_date, ' +
    'f.first_seen_at AS first_seen_at, f.source_url AS source_url ' +
    ANALYTICS_FROM_JOINS +
    whereSql(where) +
    'ORDER BY t.tx_date DESC, t.cursor_seq DESC ' +
    `LIMIT ${limit}`;
  return { sql, params };
}

// ---------------------------------------------------------------------------
// 11. Single-politician deep dive
// ---------------------------------------------------------------------------

function memberFilters(filerId: string, p: CommonFilters): { where: string[]; params: SqlParam[] } {
  const { where, params } = buildCommonFilters(p);
  return { where: ['t.filer_id = ?', ...where], params: [filerId, ...params] };
}

/** Aggregate stats for one politician: trade counts, distinct tickers, est volume +
 *  net flow, and average disclosure lag. */
export function buildMemberStatsQuery(filerId: string, p: CommonFilters): BuiltQuery {
  const { where, params } = memberFilters(filerId, p);
  const lag =
    'AVG(CASE WHEN t.tx_date IS NOT NULL AND f.filed_date IS NOT NULL ' +
    'AND julianday(f.filed_date) >= julianday(t.tx_date) ' +
    'THEN julianday(f.filed_date) - julianday(t.tx_date) END)';
  const sql =
    'SELECT COUNT(*) AS total_trades, ' +
    `${BUY} AS buy_count, ${SELL} AS sell_count, ` +
    `COUNT(DISTINCT CASE WHEN ${TICKER_RESOLVED_SQL} THEN t.ticker END) AS unique_tickers, ` +
    // Distinct *assets* counts the resolved ticker, else the reported asset name,
    // so politicians whose holdings are bonds/funds (ticker NULL) don't show 0.
    `COUNT(DISTINCT COALESCE(CASE WHEN ${TICKER_RESOLVED_SQL} THEN t.ticker END, NULLIF(t.asset_name, ''))) AS unique_assets, ` +
    `SUM(${MID}) AS est_volume, SUM(${SIGNED}) AS est_net_flow, ` +
    `${lag} AS avg_lag_days, ` +
    'MIN(t.tx_date) AS first_trade, MAX(t.tx_date) AS last_trade ' +
    ANALYTICS_FROM_JOINS +
    whereSql(where);
  return { sql, params };
}

/**
 * Per-trade performance anchors for one politician's trades, backing the realized
 * dual skill aggregate (see aggregateMemberDualPerformance). Joins cached
 * tx_performance anchors at both trade date and filing date, the security's
 * current price, and elapsed days since the public filing (for annualization
 * matching the Top Performers leaderboard). Returns every windowed trade; the
 * aggregator scores buys only and excludes options/unpriced rows.
 */
export function buildMemberPerformanceQuery(filerId: string, p: CommonFilters): BuiltQuery {
  const { where, params } = memberFilters(filerId, p);
  // Same filing anchor as the member-performance leaderboard.
  const ANCHOR_DATE = 'COALESCE(f.filed_date, f.first_seen_at, t.tx_date)';
  const sql =
    'SELECT t.is_option AS is_option, t.tx_type AS tx_type, ' +
    'txp.price_at_trade AS price_at_trade, txp.spx_at_trade AS spx_at_trade, ' +
    'txp.price_at_filing AS price_at_filing, txp.spx_at_filing AS spx_at_filing, ' +
    'sr.current_price AS current_price, sr.current_price_date AS current_price_date, ' +
    // S&P close on or before the ticker's own current-price date, so both exit
    // legs end on the same as-of date; falls back to the latest close (old behaviour)
    // when the ticker has no price date or predates the S&P series.
    `${spxOnOrBeforePriceDateSql('sr.current_price_date')} AS spx_now, ` +
    `(julianday('now') - julianday(${ANCHOR_DATE})) AS elapsed_days_since_filing, ` +
    `${MID} AS est_volume ` +
    ANALYTICS_FROM_JOINS +
    'LEFT JOIN tx_performance txp ON txp.tx_id = t.id ' +
    'LEFT JOIN securities_ref sr ON sr.ticker = t.ticker ' +
    whereSql(where);
  return { sql, params };
}

/** Most-traded tickers for one politician. */
export function buildMemberTopTickersQuery(
  filerId: string,
  p: CommonFilters & { limit?: number },
): BuiltQuery {
  const { where, params } = memberFilters(filerId, { ...p, tickerNotNull: true });
  const limit = clampLimit(p.limit, 5, 50);
  const sql =
    'SELECT t.ticker AS ticker, sm.name AS name, COUNT(*) AS trade_count, ' +
    `${BUY} AS buy_count, ${SELL} AS sell_count, SUM(${MID}) AS est_volume ` +
    ANALYTICS_FROM_JOINS_SECURITIES +
    whereSql(where) +
    'GROUP BY t.ticker ORDER BY trade_count DESC, est_volume DESC ' +
    `LIMIT ${limit}`;
  return { sql, params };
}

/** Most-recent trades for one politician (for the politician drawer's mini-list). */
export function buildMemberRecentTradesQuery(
  filerId: string,
  p: CommonFilters & { limit?: number },
): BuiltQuery {
  const { where, params } = memberFilters(filerId, p);
  const limit = clampLimit(p.limit, 10, 100);
  const sql =
    'SELECT t.id AS id, t.doc_id AS doc_id, t.ticker AS ticker, t.asset_name AS asset_name, ' +
    't.asset_type AS asset_type, t.asset_type_name AS asset_type_name, t.raw_text AS raw_text, ' +
    't.source AS source, t.tx_type AS tx_type, t.tx_date AS tx_date, t.owner AS owner, t.is_option AS is_option, ' +
    't.amount_min AS amount_min, t.amount_max AS amount_max, t.created_at AS created_at, sm.name AS name, ' +
    'f.filed_date AS filed_date, f.first_seen_at AS first_seen_at, f.source_url AS source_url ' +
    ANALYTICS_FROM_JOINS_SECURITIES +
    whereSql(where) +
    'ORDER BY t.tx_date DESC, t.cursor_seq DESC ' +
    `LIMIT ${limit}`;
  return { sql, params };
}
