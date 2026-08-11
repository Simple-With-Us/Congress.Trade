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
  TICKER_RESOLVED_SQL,
  buildCommonFilters,
  clampLimit,
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
const BUY = "SUM(CASE WHEN t.tx_type IN ('B', 'P') THEN 1 ELSE 0 END)";
const SELL = "SUM(CASE WHEN t.tx_type = 'S' THEN 1 ELSE 0 END)";
const BUY_VOL = `SUM(CASE WHEN t.tx_type IN ('B', 'P') THEN ${MID} ELSE 0 END)`;
const SELL_VOL = `SUM(CASE WHEN t.tx_type = 'S' THEN ${MID} ELSE 0 END)`;

// ---------------------------------------------------------------------------
// 1. Summary — KPI strip
// ---------------------------------------------------------------------------

/** Corpus-wide totals for the window: trades, politicians, tickers, est volume,
 *  buy/sell/exchange counts, resolved-ticker count, option count. */
export function buildSummaryQuery(p: CommonFilters): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const sql =
    'SELECT ' +
    'COUNT(*) AS total_trades, ' +
    'COUNT(DISTINCT t.filer_id) AS unique_members, ' +
    `COUNT(DISTINCT CASE WHEN ${TICKER_RESOLVED_SQL} THEN t.ticker END) AS unique_tickers, ` +
    `${BUY} AS buy_count, ` +
    `${SELL} AS sell_count, ` +
    "SUM(CASE WHEN t.tx_type = 'E' THEN 1 ELSE 0 END) AS exchange_count, " +
    `SUM(${MID}) AS est_volume, ` +
    `SUM(${SIGNED}) AS est_net_flow, ` +
    `SUM(CASE WHEN ${TICKER_RESOLVED_SQL} THEN 1 ELSE 0 END) AS resolved_ticker_count, ` +
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
    `SUM(${MID}) AS est_volume, ` +
    `SUM(${SIGNED}) AS est_net_flow ` +
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
  const { where, params } = buildCommonFilters({ ...p, tickerNotNull: true, txTypes: ['B', 'S'] });
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
  const { where, params } = buildCommonFilters({ ...p, txTypes: ['B', 'S'] });
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
    `SUM(CASE WHEN t.tx_type IN ('B', 'P') THEN ${MID} ELSE 0 END) AS est_buy_vol, ` +
    `SUM(CASE WHEN t.tx_type = 'S' THEN ${MID} ELSE 0 END) AS est_sell_vol ` +
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
    'GROUP BY party';
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
    'GROUP BY period, party ORDER BY period ASC';
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
 * securities_ref.sector / .market_cap_bucket are populated by several
 * enrichment providers racing a COALESCE-on-conflict upsert (see
 * enrichment/service.ts insertOrUpdate) — whichever provider's row lands
 * first wins the value, and providers do not share a vocabulary. Some write
 * a literal junk string instead of leaving the column NULL/empty (observed
 * live: a bare "N/A", 2 trades in a 90d window). The old
 * `COALESCE(NULLIF(x, ''), 'Unknown')` fallback only catches the empty
 * string — NULLIF does not know these sentinels are also "no value". This
 * list is intentionally small and conservative (exact, case-insensitive
 * matches only); it must never catch a real short sector/bucket label.
 */
const JUNK_SENTINEL_VALUES = ['', 'n/a', 'na', '-', '--', 'none', 'null', 'unknown'];

/** `WHEN`-worthy boolean SQL: true when `expr` (trimmed, lowercased) is a junk sentinel. */
function junkSentinelSql(expr: string): string {
  const raw = `lower(trim(coalesce(${expr}, '')))`;
  return JUNK_SENTINEL_VALUES.map((v) => `${raw} = ${sectorSqlQuote(v)}`).join(' OR ');
}

function sectorSqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * securities_ref.sector fragments one real sector across several rows because
 * different enrichment providers write different vocabularies into the same
 * column (see the comment on {@link JUNK_SENTINEL_VALUES} above). Observed
 * live in a 90d window: "Health Care" (43 trades) and "Healthcare" (33
 * trades) are the same sector split in two; "Communication Services" /
 * "Communications" / "Telecommunication" fragment one sector into three; and
 * dozens of rows are GICS *sub-industries* masquerading as sectors
 * (Semiconductors, Pharmaceuticals, Banking, Aerospace & Defense, …).
 *
 * This maps the labels we are CONFIDENT about onto the 11-sector
 * Morningstar/GICS-style set already named in this codebase's product copy
 * (Technology, Financial Services, Health Care, Consumer Cyclical, Consumer
 * Defensive, Industrials, Energy, Utilities, Real Estate, Basic Materials,
 * Communication Services). It is deliberately NOT exhaustive: a handful of
 * observed labels are genuinely ambiguous between two canonical sectors
 * under GICS (e.g. "Retail" spans Consumer Discretionary Retail AND Consumer
 * Staples Distribution & Retail; "Construction" spans Construction &
 * Engineering [Industrials] and Home Builders [Consumer Cyclical]; "Finance
 * Insurance & Real Estate" spans two sectors outright; "Consumer products"
 * — lowercase p — gives no signal beyond "consumer") and are intentionally
 * left OUT of this table so they fall through to their own original label
 * in the ELSE branch below, rather than being guessed into the wrong
 * bucket. Anything not recognized here is never swallowed into 'Unknown' —
 * only genuine junk sentinels (see {@link junkSentinelSql}) become 'Unknown'.
 */
const SECTOR_ALIASES: Record<string, string> = {
  // Exact duplicates / cross-taxonomy synonyms for the SAME sector.
  healthcare: 'Health Care',
  'health care': 'Health Care',
  communications: 'Communication Services',
  'communication services': 'Communication Services',
  telecommunication: 'Communication Services',
  telecommunications: 'Communication Services',
  financials: 'Financial Services',
  'financial services': 'Financial Services',
  technology: 'Technology',
  'information technology': 'Technology',
  industrials: 'Industrials',
  energy: 'Energy',
  utilities: 'Utilities',
  'real estate': 'Real Estate',
  materials: 'Basic Materials',
  'basic materials': 'Basic Materials',
  'consumer cyclical': 'Consumer Cyclical',
  'consumer discretionary': 'Consumer Cyclical',
  'consumer defensive': 'Consumer Defensive',
  'consumer staples': 'Consumer Defensive',

  // GICS sub-industries rolled up into their (unambiguous) parent sector.
  semiconductors: 'Technology',
  software: 'Technology',
  'consumer electronics': 'Technology',
  media: 'Communication Services',
  entertainment: 'Communication Services',
  banking: 'Financial Services',
  banks: 'Financial Services',
  insurance: 'Financial Services',
  'asset management': 'Financial Services',
  'capital markets': 'Financial Services',
  pharmaceuticals: 'Health Care',
  biotechnology: 'Health Care',
  'life sciences tools & services': 'Health Care',
  'medical devices': 'Health Care',
  automobiles: 'Consumer Cyclical',
  'hotels/restaurants & leisure': 'Consumer Cyclical',
  'hotels restaurants & leisure': 'Consumer Cyclical',
  beverages: 'Consumer Defensive',
  'food products': 'Consumer Defensive',
  tobacco: 'Consumer Defensive',
  machinery: 'Industrials',
  'electrical equipment': 'Industrials',
  'aerospace & defense': 'Industrials',
  'aerospace and defense': 'Industrials',
  'road & rail': 'Industrials',
  'road and rail': 'Industrials',
  'logistics & transportation': 'Industrials',
  'logistics and transportation': 'Industrials',
  'industrial conglomerates': 'Industrials',
  'metals & mining': 'Basic Materials',
  'metals and mining': 'Basic Materials',
};

/**
 * SQL CASE expression canonicalizing `sectorExpr` (a `securities_ref.sector`
 * reference) — same shape as {@link canonicalAssetTypeCategorySql} in
 * shared/assetTypes.ts: junk sentinels collapse to 'Unknown', recognized
 * aliases collapse onto their canonical label, everything else passes
 * through unchanged (trimmed) so no raw sector value silently disappears.
 */
export function canonicalSectorSql(sectorExpr: string): string {
  const aliasWhen = Object.entries(SECTOR_ALIASES)
    .map(
      ([label, canonical]) =>
        `WHEN lower(trim(coalesce(${sectorExpr}, ''))) = ${sectorSqlQuote(label)} THEN ${sectorSqlQuote(canonical)}`,
    )
    .join(' ');
  return (
    `(CASE WHEN ${junkSentinelSql(sectorExpr)} THEN 'Unknown' ` +
    `${aliasWhen} ELSE trim(${sectorExpr}) END)`
  );
}

/**
 * Net buy/sell flow by REAL GICS sector (securities_ref.sector) — distinct from
 * buildSectorBreakdownQuery, which groups by the free-text `asset_type` (an
 * instrument class, not a sector). Resolved tickers only; un-enriched/junk
 * sectors collapse to 'Unknown'; known duplicate/sub-industry labels collapse
 * onto one canonical sector via {@link canonicalSectorSql} (see that comment
 * for why — multi-provider enrichment writes different vocabularies into one
 * column). Reports signed net flow so a sector's accumulation vs distribution
 * is visible, plus politician/ticker breadth.
 *
 * NOTE — this query (and buildMarketCapBreakdownQuery below) filters on
 * TICKER_RESOLVED_SQL, so trades with no resolved ticker are excluded here
 * entirely (they have no `t.ticker` to join securities_ref on, so they
 * couldn't contribute a sector anyway). That population is invisible in this
 * view and in the market-cap breakdown; buildSummaryQuery already computes
 * `resolved_ticker_count` / `total_trades` (surfaced as `resolvedTickerPct`
 * by GET /api/analytics/summary) for sizing it. Changing that gate is a
 * product decision outside the scope of this fix.
 */
export function buildSectorFlowQuery(p: CommonFilters & { limit?: number }): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const limit = clampLimit(p.limit, 20, 100);
  const allWhere = [TICKER_RESOLVED_SQL, ...where];
  const sql =
    `SELECT ${canonicalSectorSql('sr.sector')} AS sector, ` +
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
 * Resolved tickers only (same TICKER_RESOLVED_SQL gate + exclusion caveat as
 * buildSectorFlowQuery above); un-enriched/junk rows collapse to 'unknown'
 * via the same sentinel list as the sector query (see JUNK_SENTINEL_VALUES).
 */
export function buildMarketCapBreakdownQuery(p: CommonFilters): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const allWhere = [TICKER_RESOLVED_SQL, ...where];
  const sql =
    `SELECT (CASE WHEN ${junkSentinelSql('sr.market_cap_bucket')} THEN 'unknown' ELSE trim(sr.market_cap_bucket) END) AS bucket, ` +
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
  p: CommonFilters & { limit?: number; minTrades?: number },
): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const limit = clampLimit(p.limit, 20, 100);
  const minTrades = clampLimit(p.minTrades, 5, 1000);
  // Excess return of one buy vs SPX, both legs anchored at the filing date.
  const EXCESS =
    '((sr.current_price / p.price_at_filing) - 1.0) - ((sx.spx_now / p.spx_at_filing) - 1.0)';
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
    'sr.current_price IS NOT NULL AND sr.current_price > 0',
    'sx.spx_now IS NOT NULL AND sx.spx_now > 0',
    `julianday(${ANCHOR_DATE}) IS NOT NULL`,
    `${ELAPSED_DAYS} > 0`,
    't.filer_id IS NOT NULL',
    ...where,
  ];
  const sql =
    'WITH sx AS MATERIALIZED (SELECT close AS spx_now FROM spx_eod ORDER BY date DESC LIMIT 1) ' +
    'SELECT t.filer_id AS filer_id, MAX(COALESCE(fl.display_name, fl.full_name)) AS full_name, MAX(fl.party) AS party, ' +
    'MAX(fl.photo_url) AS photo_url, ' +
    'COUNT(*) AS trade_count, ' +
    `SUM((${ANNUALIZED_EXCESS}) * ${MID}) / NULLIF(SUM(${MID}), 0) AS avg_annualized_excess, ` +
    `SUM((${WINSOR_EXCESS}) * ${MID}) / NULLIF(SUM(${MID}), 0) AS avg_excess, ` +
    `SUM(CASE WHEN ${ANNUALIZED_EXCESS} > 0 THEN 1 ELSE 0 END) AS wins, ` +
    `SUM(${MID}) AS est_volume ` +
    'FROM transactions t ' +
    'JOIN tx_performance p ON p.tx_id = t.id ' +
    'LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id ' +
    'LEFT JOIN filings f ON f.doc_id = t.doc_id ' +
    'JOIN securities_ref sr ON sr.ticker = t.ticker ' +
    'CROSS JOIN sx ' +
    whereSql(allWhere) +
    'GROUP BY t.filer_id ' +
    `HAVING trade_count >= ${minTrades} ` +
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
  const { where, params } = buildCommonFilters({ ...p, tickers, txTypes: ['B', 'S'] });
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
export function buildMemberSkillQuery(filerIds: string[], p: CommonFilters): BuiltQuery {
  const EXCESS =
    '((sr.current_price / p.price_at_filing) - 1.0) - ((sx.spx_now / p.spx_at_filing) - 1.0)';
  const where = [
    't.deprecated_at IS NULL',
    "t.tx_type IN ('B', 'P')",
    't.is_option = 0',
    'p.price_at_filing IS NOT NULL AND p.price_at_filing > 0',
    'p.spx_at_filing IS NOT NULL AND p.spx_at_filing > 0',
    'sr.current_price IS NOT NULL',
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
    'WITH sx AS MATERIALIZED (SELECT close AS spx_now FROM spx_eod ORDER BY date DESC LIMIT 1) ' +
    'SELECT t.filer_id AS filer_id, COUNT(*) AS scored, ' +
    `SUM(CASE WHEN ${EXCESS} > 0 THEN 1 ELSE 0 END) AS wins, ` +
    `AVG(${EXCESS}) AS avg_excess ` +
    'FROM transactions t ' +
    'JOIN tx_performance p ON p.tx_id = t.id ' +
    'JOIN securities_ref sr ON sr.ticker = t.ticker ' +
    'CROSS JOIN sx ' +
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
    `SUM(${MID}) AS est_volume, SUM(${SIGNED}) AS est_net_flow, ` +
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
    `${BUY_VOL} AS est_buy_vol, ${SELL_VOL} AS est_sell_vol ` +
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
    'sr.current_price AS current_price, ' +
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
