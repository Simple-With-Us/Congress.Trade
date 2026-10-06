/**
 * src/analytics/__tests__/builders.test.ts
 *
 * Unit tests for the analytics query builders. Pure + deterministic (no DB):
 * assert the generated SQL shape, bound-param order, limit/having clamping, and
 * the bracket-midpoint / ticker / sort conventions.
 */

import { describe, it, expect } from 'vitest';
import {
  asMemberSort,
  asTickerSort,
  buildClusterBuysQuery,
  buildClusterMembersQuery,
  buildConvictionMemberLinksQuery,
  buildMemberSkillQuery,
  buildFilingLagHistogramQuery,
  buildLateFilersQuery,
  buildMemberLeaderboardQuery,
  buildMemberPerformanceQuery,
  buildMemberStatsQuery,
  buildMemberTopTickersQuery,
  buildMemberRecentTradesQuery,
  buildPartySplitQuery,
  buildPartySplitOverTimeQuery,
  buildSectorBreakdownQuery,
  buildSectorFlowQuery,
  buildMarketCapBreakdownQuery,
  canonicalSectorSql,
  buildMemberPerformanceLeaderboardQuery,
  buildSummaryQuery,
  buildTickerLeaderboardQuery,
  buildTickerRecentTradesQuery,
  buildTickerSummaryQuery,
  buildTickerTimeSeriesQuery,
  buildTickerTopTradersQuery,
  buildTrendingQuery,
  buildVolumeOverTimeQuery,
  momentumOffsets,
} from '../builders.ts';
import { PARTY_BUCKET_SQL, STOCK_MIDPOINT_SQL, granularityFormat } from '../sql.ts';

describe('buildSummaryQuery', () => {
  it('aggregates corpus totals and uses the bracket midpoint for $', () => {
    const q = buildSummaryQuery({ window: '30d' });
    expect(q.sql).toContain('COUNT(*) AS total_trades');
    expect(q.sql).toContain('COUNT(DISTINCT t.filer_id) AS unique_members');
    expect(q.sql).toContain(`SUM(${STOCK_MIDPOINT_SQL}) AS est_volume`);
    expect(q.sql).toContain('AS option_count');
    expect(q.params).toEqual(['-30 days']);
  });

  it('counts resolvedEquityTickerPct from canonical public_equity, not House CS bonds', () => {
    const q = buildSummaryQuery({ window: 'all' });
    expect(q.sql).toContain("= 'public_equity' THEN 1 ELSE 0 END) AS equity_trade_count");
    expect(q.sql).toContain("= 'public_equity' AND");
    expect(q.sql).toContain("WHEN upper(trim(coalesce(t.asset_type, ''))) = 'CS' THEN 'fixed_income_corporate'");
    expect(q.sql).not.toMatch(
      /IN \('ST', 'Stock', 'Equity', 'stock', 'equity', 'CS', 'Common Stock'\)/,
    );
  });
});

describe('buildSummaryQuery equity-like coverage (16b46688)', () => {
  it('widens the equity denominator to public_equity + unknown so ticker-less equities stay visible', () => {
    const q = buildSummaryQuery({ window: 'all' });
    expect(q.sql).toContain("IN ('public_equity', 'unknown') THEN 1 ELSE 0 END) AS equity_like_trade_count");
    expect(q.sql).toContain("IN ('public_equity', 'unknown') AND");
    expect(q.sql).toContain('AS resolved_equity_like_ticker_count');
    // The narrow public_equity-only counters remain for the back-compat field.
    expect(q.sql).toContain('AS equity_trade_count');
    expect(q.sql).toContain('AS resolved_equity_ticker_count');
  });
});

describe('buildTickerLeaderboardQuery', () => {
  it('excludes null tickers, groups by ticker, and joins the securities master', () => {
    const q = buildTickerLeaderboardQuery({ window: 'all' });
    expect(q.sql).toContain("(t.ticker IS NOT NULL AND t.ticker <> '' AND t.ticker NOT IN ('NONE', '--', 'N/A', 'NA', 'NULL', '—'))");
    expect(q.sql).toContain('GROUP BY t.ticker');
    expect(q.sql).toContain('LEFT JOIN securities_master sm');
    expect(q.sql).toContain('ORDER BY trade_count DESC');
    expect(q.sql).toContain('LIMIT 20');
  });

  it('whitelists the sort column (invalid → trades) and clamps the limit', () => {
    expect(asTickerSort('volume')).toBe('volume');
    expect(asTickerSort('netflow')).toBe('netflow');
    expect(asTickerSort('DROP TABLE')).toBe('trades');
    const q = buildTickerLeaderboardQuery({ window: 'all', sort: 'volume', limit: 9999 });
    expect(q.sql).toContain('ORDER BY est_volume DESC');
    expect(q.sql).toContain('LIMIT 200');
  });

  it('exposes directional + per-side distinct-politician counts (for conviction breadth)', () => {
    const q = buildTickerLeaderboardQuery({ window: 'all' });
    expect(q.sql).toContain("CASE WHEN t.tx_type IN ('B', 'P', 'S') THEN t.filer_id END) AS directional_member_count");
    expect(q.sql).toContain("CASE WHEN t.tx_type IN ('B', 'P') THEN t.filer_id END) AS buy_member_count");
    expect(q.sql).toContain("CASE WHEN t.tx_type = 'S' THEN t.filer_id END) AS sell_member_count");
  });
});

describe('buildMemberLeaderboardQuery', () => {
  it('requires a filer id, groups by filer, resolves chamber + photo', () => {
    const q = buildMemberLeaderboardQuery({ window: '90d', sort: 'volume' });
    expect(q.sql).toContain('t.filer_id IS NOT NULL');
    expect(q.sql).toContain('GROUP BY t.filer_id');
    expect(q.sql).toContain('COALESCE(fl.chamber, f.chamber) AS chamber');
    expect(q.sql).toContain('ORDER BY est_volume DESC');
    expect(q.params).toEqual(['-90 days']);
    expect(asMemberSort('tickers')).toBe('tickers');
    expect(asMemberSort('nope')).toBe('trades');
  });
});

describe('buildClusterBuysQuery', () => {
  it('filters to B/S (dual-read legacy P), counts distinct politicians + party split, applies HAVING', () => {
    const q = buildClusterBuysQuery({ window: '30d', minMembers: 4, limit: 10 });
    // Buy expands to B+P for dual-read → three binds with S
    expect(q.sql).toContain('t.tx_type IN (?, ?, ?)');
    expect(q.sql).toContain('GROUP BY t.ticker, t.tx_type');
    expect(q.sql).toContain('HAVING COUNT(DISTINCT t.filer_id) >= 4');
    expect(q.sql).toContain('AS d_members');
    expect(q.sql).toContain('AS r_members');
    expect(q.sql).toContain('LIMIT 10');
    // window offset first, then B,P,S (buy dual-read + sell)
    expect(q.params).toEqual(['-30 days', 'B', 'P', 'S']);
  });

  it('defaults minMembers to 3', () => {
    const q = buildClusterBuysQuery({ window: 'all' });
    expect(q.sql).toContain('HAVING COUNT(DISTINCT t.filer_id) >= 3');
  });

  it('narrows the directional cluster to a requested side', () => {
    const q = buildClusterBuysQuery({ window: '30d', txTypes: ['B'], minMembers: 4, limit: 10 });
    expect(q.params).toEqual(['-30 days', 'B', 'P']);
    expect(q.sql).toContain('t.tx_type IN (?, ?)');
  });
});

describe('buildClusterMembersQuery', () => {
  it('binds the ticker IN-list first, then the common filters', () => {
    const q = buildClusterMembersQuery(['AAPL', 'NVDA'], { window: '30d' });
    expect(q.sql).toContain('t.ticker IN (?, ?)');
    expect(q.sql).toContain('GROUP BY t.ticker, t.tx_type, t.filer_id');
    // tickers first, then window offset, then B,P,S (buy dual-read + sell)
    expect(q.params).toEqual(['AAPL', 'NVDA', '-30 days', 'B', 'P', 'S']);
  });
});

describe('buildTrendingQuery', () => {
  it('compares recent vs prior windows via inlined date literals', () => {
    const q = buildTrendingQuery({ window: '30d', limit: 15 });
    expect(q.sql).toContain("date('now', '-30 days')");
    expect(q.sql).toContain("date('now', '-60 days')");
    expect(q.sql).toContain('AS recent_count');
    expect(q.sql).toContain('AS prior_count');
    expect(q.sql).toContain('ORDER BY (recent_count - prior_count) DESC');
    expect(q.sql).toContain('LIMIT 15');
    // date range is inlined (whitelisted), so no window param is bound
    expect(q.params).toEqual([]);
  });

  it('bySide groups momentum by ticker + tx_type for per-direction reads', () => {
    const def = buildTrendingQuery({ window: '30d' });
    expect(def.sql).toContain('GROUP BY t.ticker ');
    expect(def.sql).not.toContain('t.tx_type AS tx_type');
    const sided = buildTrendingQuery({ window: '30d', bySide: true });
    expect(sided.sql).toContain('t.tx_type AS tx_type');
    expect(sided.sql).toContain('GROUP BY t.ticker, t.tx_type');
  });

  it('momentumOffsets returns a prior period of equal length', () => {
    expect(momentumOffsets('7d')).toEqual({ recent: '-7 days', priorStart: '-14 days' });
    expect(momentumOffsets('90d')).toEqual({ recent: '-90 days', priorStart: '-180 days' });
    expect(momentumOffsets('180d')).toEqual({ recent: '-180 days', priorStart: '-360 days' });
    expect(momentumOffsets('45d')).toEqual({ recent: '-45 days', priorStart: '-90 days' });
    expect(momentumOffsets('all')).toEqual({ recent: '-90 days', priorStart: '-180 days' });
  });
});

describe('buildVolumeOverTimeQuery', () => {
  it('binds the strftime format FIRST, then the window offset', () => {
    const q = buildVolumeOverTimeQuery({ window: '90d', granularity: 'week' });
    expect(q.sql).toContain('strftime(?, t.tx_date) AS period');
    expect(q.sql).toContain('GROUP BY period ORDER BY period ASC');
    expect(q.params).toEqual([granularityFormat('week'), '-90 days']);
  });
});

describe('buildPartySplitQuery', () => {
  it('groups by the party bucket', () => {
    const q = buildPartySplitQuery({ window: '365d' });
    expect(q.sql).toContain('AS party');
    // Group by the bucket expression, never the bare `party` identifier (it
    // binds to the joined fl.party column and splits each raw spelling).
    expect(q.sql).toContain(`GROUP BY ${PARTY_BUCKET_SQL}`);
    expect(q.sql).not.toMatch(/GROUP BY party\b/);
    expect(q.params).toEqual(['-365 days']);
  });
  it('over-time variant binds the format first', () => {
    const q = buildPartySplitOverTimeQuery({ window: '365d', granularity: 'month' });
    expect(q.sql).toContain('strftime(?, t.tx_date)');
    expect(q.sql).toContain(`GROUP BY period, ${PARTY_BUCKET_SQL}`);
    expect(q.params).toEqual([granularityFormat('month'), '-365 days']);
  });
});

describe('buildSectorBreakdownQuery', () => {
  it('buckets canonical asset-type categories across raw source labels', () => {
    const q = buildSectorBreakdownQuery({ window: 'all' });
    expect(q.sql).toContain('AS asset_type_category');
    expect(q.sql).toContain("THEN 'public_equity'");
    expect(q.sql).toContain("THEN 'fixed_income_government'");
    expect(q.sql).toContain('GROUP BY asset_type_category');
  });

  it('includes net flow + member breadth for Trends flowRow parity with market cap', () => {
    const q = buildSectorBreakdownQuery({ window: '90d' });
    expect(q.sql).toContain('AS est_net_flow');
    expect(q.sql).toContain('AS unique_members');
    expect(q.sql).toContain('AS unique_tickers');
  });
});

describe('buildSectorFlowQuery (real sector)', () => {
  it('groups by a canonicalized securities_ref.sector with signed net flow, resolved tickers only', () => {
    const q = buildSectorFlowQuery({ window: '90d' });
    expect(q.sql).toContain('AS sector');
    expect(q.sql).toContain('LEFT JOIN securities_ref sr ON sr.ticker = t.ticker');
    expect(q.sql).toContain('AS est_net_flow');
    expect(q.sql).toContain('GROUP BY sector');
    expect(q.sql).toContain("t.ticker IS NOT NULL AND t.ticker <> ''");
    // The old COALESCE(NULLIF(...)) form only nulled the empty string, so a
    // literal 'N/A' shipped as its own sector bucket.
    expect(q.sql).not.toContain("COALESCE(NULLIF(sr.sector, ''), 'Unknown')");
  });
});

/**
 * These run the generated CASE through real SQLite rather than asserting on the
 * SQL text: the point is what the expression RETURNS for the vocabularies
 * actually present in securities_ref, not how it is spelled.
 */
describe('canonicalSectorSql', () => {
  async function classify(labels: (string | null)[]): Promise<Record<string, string>> {
    // Dynamic module name keeps Worker production types free of Node-only APIs
    // (same trick as src/admin/__tests__/migrations.test.ts).
    const moduleName = 'node:sqlite';
    const sqlite = (await import(moduleName)) as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...p: unknown[]): unknown; all(...p: unknown[]): Record<string, unknown>[] };
        close(): void;
      };
    };
    const db = new sqlite.DatabaseSync(':memory:');
    db.exec('CREATE TABLE sr (sector TEXT)');
    const insert = db.prepare('INSERT INTO sr (sector) VALUES (?)');
    for (const label of labels) insert.run(label);
    const rows = db
      .prepare(`SELECT sector AS input, ${canonicalSectorSql('sr.sector')} AS out FROM sr`)
      .all() as { input: string | null; out: string }[];
    db.close();
    const result: Record<string, string> = {};
    for (const row of rows) result[row.input ?? '<null>'] = row.out;
    return result;
  }

  it('folds junk sentinels into Unknown, not their own bucket', async () => {
    const out = await classify([null, '', '   ', 'N/A', 'n/a', 'NA', '-', '--', 'None', 'null', 'Unknown']);
    expect(out['<null>']).toBe('Unknown');
    expect(out['']).toBe('Unknown');
    expect(out['   ']).toBe('Unknown');
    expect(out['N/A']).toBe('Unknown');
    expect(out['n/a']).toBe('Unknown');
    expect(out.NA).toBe('Unknown');
    expect(out['-']).toBe('Unknown');
    expect(out['--']).toBe('Unknown');
    expect(out.None).toBe('Unknown');
    expect(out.null).toBe('Unknown');
    expect(out.Unknown).toBe('Unknown');
  });

  it('collapses duplicate spellings onto one bucket', async () => {
    const out = await classify(['Healthcare', 'Health Care', 'HEALTH CARE', 'Health  Care']);
    expect(new Set(Object.values(out))).toEqual(new Set(['Healthcare']));
  });

  it('rolls sub-industries up to their unambiguous parent sector', async () => {
    const out = await classify([
      'Semiconductors',
      'Pharmaceuticals',
      'Biotechnology',
      'Banking',
      'Insurance',
      'Media',
      'Telecommunication',
      'Machinery',
      'Airlines',
      'Beverages',
      'Tobacco',
      'Automobiles',
      'Chemicals',
    ]);
    expect(out.Semiconductors).toBe('Technology');
    expect(out.Pharmaceuticals).toBe('Healthcare');
    expect(out.Biotechnology).toBe('Healthcare');
    expect(out.Banking).toBe('Financial Services');
    expect(out.Insurance).toBe('Financial Services');
    expect(out.Media).toBe('Communication Services');
    expect(out.Telecommunication).toBe('Communication Services');
    expect(out.Machinery).toBe('Industrials');
    expect(out.Airlines).toBe('Industrials');
    expect(out.Beverages).toBe('Consumer Defensive');
    expect(out.Tobacco).toBe('Consumer Defensive');
    expect(out.Automobiles).toBe('Consumer Cyclical');
    expect(out.Chemicals).toBe('Basic Materials');
  });

  it('passes an unrecognised label through unchanged instead of swallowing it', async () => {
    // Nothing may silently disappear into Unknown: an unmapped provider label
    // still has to show up as its own honest bucket.
    const out = await classify(['Quantum Widgets', 'Retail', 'Manufacturing', 'Services', '  Retail Trade  ']);
    expect(out['Quantum Widgets']).toBe('Quantum Widgets');
    expect(out.Retail).toBe('Retail');
    expect(out.Manufacturing).toBe('Manufacturing');
    expect(out.Services).toBe('Services');
    expect(out['  Retail Trade  ']).toBe('Retail Trade');
  });

  it('leaves the labels whose obvious mapping production data disproves', async () => {
    // 'Financials' is a provider catch-all (Treasury CUSIPs, mutual funds, a
    // '--'), 'Communications' is networking hardware, 'Mining' is oil & gas.
    // Folding any of them would misattribute real trades.
    const out = await classify(['Financials', 'Communications', 'Mining', 'Electrical Equipment', 'Packaging']);
    expect(out.Financials).toBe('Financials');
    expect(out.Communications).toBe('Communications');
    expect(out.Mining).toBe('Mining');
    expect(out['Electrical Equipment']).toBe('Electrical Equipment');
    expect(out.Packaging).toBe('Packaging');
  });
});

describe('buildMarketCapBreakdownQuery', () => {
  it('groups by market_cap_bucket with net flow + breadth', () => {
    const q = buildMarketCapBreakdownQuery({ window: 'all' });
    expect(q.sql).toContain("COALESCE(NULLIF(sr.market_cap_bucket, ''), 'unknown') AS bucket");
    expect(q.sql).toContain('LEFT JOIN securities_ref sr ON sr.ticker = t.ticker');
    expect(q.sql).toContain('AS est_net_flow');
    expect(q.sql).toContain('GROUP BY bucket');
  });
});

describe('conviction realized-skill inputs', () => {
  it('buildConvictionMemberLinksQuery: distinct (ticker, side, politician) for the candidate set', () => {
    const q = buildConvictionMemberLinksQuery(['AAPL', 'MSFT'], { window: '90d' });
    expect(q.sql).toContain('SELECT DISTINCT t.ticker AS ticker, t.tx_type AS tx_type, t.filer_id AS filer_id');
    expect(q.sql).toContain('t.ticker IN (?, ?)');
    expect(q.sql).toContain('t.tx_type IN (?, ?, ?)');
    expect(q.sql).toContain('t.filer_id IS NOT NULL');
    // bind order: window offset, then B/P/S (buy dual-read), then the ticker IN-list.
    expect(q.params).toEqual(['-90 days', 'B', 'P', 'S', 'AAPL', 'MSFT']);
  });

  it('buildMemberSkillQuery: per-politician scored/wins/avg-excess for the given filers (>=5)', () => {
    const q = buildMemberSkillQuery(['A1', 'B2', 'C3'], { window: 'all', priceFreshThrough: '2020-01-01' });
    expect(q.sql).toContain('JOIN tx_performance p ON p.tx_id = t.id');
    expect(q.sql).toContain('COUNT(*) AS scored');
    expect(q.sql).toContain('AS wins');
    expect(q.sql).toContain('AS avg_excess');
    expect(q.sql).toContain("t.tx_type IN ('B', 'P')");
    expect(q.sql).toContain('t.filer_id IN (?, ?, ?)');
    expect(q.sql).toContain('HAVING scored >= 5');
    // window is intentionally omitted (career track record); no date bind.
    expect(q.sql).not.toContain("tx_date >=");
    expect(q.params).toEqual(['A1', 'B2', 'C3']);
  });

  it('buildMemberSkillQuery: honors source + minConf (trade-level), binds before the filer IN-list', () => {
    const q = buildMemberSkillQuery(['A1'], {
      window: 'all',
      source: 'primary',
      minConf: 0.7,
      priceFreshThrough: '2020-01-01',
    });
    expect(q.sql).toContain('t.source = ?');
    expect(q.sql).toContain('t.confidence >= ?');
    expect(q.params).toEqual(['primary', 0.7, 'A1']);
  });
});

describe('buildMemberPerformanceLeaderboardQuery', () => {
  it('anchors excess return at the filing date, buys only, options excluded, small-N guarded', () => {
    const q = buildMemberPerformanceLeaderboardQuery({
      window: 'all',
      minTrades: 5,
      limit: 10,
      priceFreshThrough: '2020-01-01',
    });
    expect(q.sql).toContain('JOIN tx_performance p ON p.tx_id = t.id');
    // Excess uses the FILING anchors, not the trade-date ones.
    expect(q.sql).toContain('p.price_at_filing');
    expect(q.sql).toContain('p.spx_at_filing');
    expect(q.sql).not.toContain('price_at_trade');
    // Exit legs share ONE as-of date per ticker: the S&P close on or before the
    // ticker's own current_price_date (board row 6c05e09b), not a single latest close.
    expect(q.sql).toContain('WITH px AS MATERIALIZED (');
    expect(q.sql).toContain('SELECT s.close FROM spx_eod s WHERE s.date <= r.current_price_date ORDER BY s.date DESC LIMIT 1');
    expect(q.sql).toContain('JOIN px ON px.ticker = t.ticker');
    expect(q.sql).toContain('px.spx_now / p.spx_at_filing');
    expect(q.sql).not.toContain('CROSS JOIN sx');
    expect(q.sql).toContain("t.tx_type IN ('B', 'P')");
    expect(q.sql).toContain('t.is_option = 0');
    expect(q.sql).toContain("julianday('now') - julianday(COALESCE(f.filed_date, f.first_seen_at, t.tx_date))");
    expect(q.sql).toContain('AS avg_annualized_excess');
    expect(q.sql).toContain('AS avg_excess');
    expect(q.sql).toContain('GROUP BY t.filer_id');
    expect(q.sql).toContain('HAVING trade_count >= 5');
  });

  it('sorts by the SAME statistic the card displays (winsorized, size-weighted, non-annualized avg_excess) — not the annualized figure', () => {
    const q = buildMemberPerformanceLeaderboardQuery({
      window: 'all',
      minTrades: 5,
      limit: 10,
      priceFreshThrough: '2020-01-01',
    });
    expect(q.sql).toContain('ORDER BY avg_excess DESC');
    expect(q.sql).not.toContain('ORDER BY avg_annualized_excess');
  });

  it('winsorizes each trade excess to a flat +/-200% cap before it feeds any aggregate', () => {
    const q = buildMemberPerformanceLeaderboardQuery({ window: 'all', priceFreshThrough: '2020-01-01' });
    // Flat MIN/MAX cap, not a percentile — applied once and reused by both
    // avg_excess and avg_annualized_excess (and thus by `wins`, which is
    // derived from the annualized figure's sign).
    expect(q.sql).toContain('MAX(-2.0, MIN(2.0,');
    // Both aggregates route through the capped excess, not the raw one.
    const capIndex = q.sql.indexOf('MAX(-2.0, MIN(2.0,');
    expect(capIndex).toBeGreaterThan(-1);
    expect(q.sql.indexOf('AS avg_annualized_excess')).toBeGreaterThan(capIndex);
    expect(q.sql.indexOf('AS avg_excess')).toBeGreaterThan(capIndex);
  });

  it('restricts to public-equity rows so a crypto/misc ticker collision cannot leak in', () => {
    const q = buildMemberPerformanceLeaderboardQuery({ window: 'all', priceFreshThrough: '2020-01-01' });
    expect(q.sql).toContain("= 'public_equity'");
    // House crypto code still resolves to 'crypto' in the CASE, distinct from 'public_equity'.
    expect(q.sql).toContain("WHEN upper(trim(coalesce(t.asset_type, ''))) = 'CT' THEN 'crypto'");
  });

  it('defaults and clamps the small-N guard + limit', () => {
    const q = buildMemberPerformanceLeaderboardQuery({ window: 'all', priceFreshThrough: '2020-01-01' });
    expect(q.sql).toContain('HAVING trade_count >= 5'); // default minTrades
    expect(q.sql).toContain('LIMIT 20'); // default limit
  });
});

describe('filing-lag builders', () => {
  it('histogram excludes negative lags and groups by whole-day lag', () => {
    const q = buildFilingLagHistogramQuery({ window: '90d' });
    expect(q.sql).toContain('CAST(julianday(f.filed_date) - julianday(t.tx_date) AS INTEGER) AS lag_days');
    expect(q.sql).toContain('julianday(f.filed_date) >= julianday(t.tx_date)');
    expect(q.sql).toContain("t.source = 'competitor_backfill' AND f.filed_date = t.tx_date");
    expect(q.sql).toContain('GROUP BY lag_days');
  });
  it('late filers require >= 3 trades and sort by average lag', () => {
    const q = buildLateFilersQuery({ window: 'all' });
    expect(q.sql).toContain('HAVING trade_count >= 3');
    expect(q.sql).toContain('ORDER BY avg_lag_days DESC');
    expect(q.sql).toContain('AS late_count');
    expect(q.sql).toContain('LIMIT 50');
  });
});

describe('politician deep-dive builders', () => {
  it('stats filter by filer id (bound first) and average disclosure lag', () => {
    const q = buildMemberStatsQuery('P000197', { window: 'all' });
    expect(q.sql).toContain('t.filer_id = ?');
    expect(q.sql).toContain('AS avg_lag_days');
    // Distinct *assets* falls back to the asset name when ticker is unresolved,
    // so politicians holding only bonds/funds (ticker NULL) don't show 0.
    expect(q.sql).toContain('AS unique_assets');
    expect(q.sql).toContain('NULLIF(t.asset_name');
    expect(q.params).toEqual(['P000197']);
  });
  it('performance query joins both anchors + elapsed filing days and filters by filer', () => {
    const q = buildMemberPerformanceQuery('P000197', { window: 'all' });
    expect(q.sql).toContain('LEFT JOIN tx_performance txp ON txp.tx_id = t.id');
    expect(q.sql).toContain('LEFT JOIN securities_ref sr ON sr.ticker = t.ticker');
    expect(q.sql).toContain('txp.price_at_trade AS price_at_trade');
    expect(q.sql).toContain('txp.price_at_filing AS price_at_filing');
    expect(q.sql).toContain('txp.spx_at_filing AS spx_at_filing');
    expect(q.sql).toContain('t.tx_type AS tx_type');
    expect(q.sql).toContain('elapsed_days_since_filing');
    expect(q.sql).toContain('COALESCE(f.filed_date, f.first_seen_at, t.tx_date)');
    expect(q.sql).toContain('sr.current_price AS current_price');
    expect(q.sql).toContain('t.filer_id = ?');
    expect(q.params).toEqual(['P000197']);
  });
  it('top tickers exclude null tickers and group by ticker', () => {
    const q = buildMemberTopTickersQuery('P000197', { window: '365d' });
    expect(q.sql).toContain("(t.ticker IS NOT NULL AND t.ticker <> '' AND t.ticker NOT IN ('NONE', '--', 'N/A', 'NA', 'NULL', '—'))");
    expect(q.sql).toContain('GROUP BY t.ticker');
    expect(q.params).toEqual(['P000197', '-365 days']);
  });
  it('recent trades order by date desc, carry the source link, clamp limit', () => {
    const q = buildMemberRecentTradesQuery('P000197', { window: 'all', limit: 999 });
    expect(q.sql).toContain('f.source_url AS source_url');
    expect(q.sql).toContain('t.asset_type AS asset_type');
    expect(q.sql).toContain('t.asset_type_name AS asset_type_name');
    expect(q.sql).toContain('t.raw_text AS raw_text');
    expect(q.sql).toContain('ORDER BY t.tx_date DESC, t.cursor_seq DESC');
    expect(q.sql).toContain('LIMIT 100');
    expect(q.params).toEqual(['P000197']);
  });
});

describe('ticker deep-dive builders', () => {
  it('summary upper-cases the ticker and binds it first', () => {
    const q = buildTickerSummaryQuery('aapl', { window: '30d' });
    expect(q.sql).toContain('t.ticker = ?');
    expect(q.sql).toContain('AS option_count');
    expect(q.params).toEqual(['AAPL', '-30 days']);
  });
  it('time series binds the format first, then the ticker, then the window', () => {
    const q = buildTickerTimeSeriesQuery('nvda', { window: '90d', granularity: 'week' });
    expect(q.params).toEqual([granularityFormat('week'), 'NVDA', '-90 days']);
  });
  it('top traders filter by tx type and order by est volume', () => {
    const q = buildTickerTopTradersQuery('AAPL', 'B', { window: 'all' });
    // Buy dual-read expands B → B,P
    expect(q.sql).toContain('t.tx_type IN (?, ?)');
    expect(q.sql).toContain('ORDER BY est_volume DESC');
    expect(q.params).toEqual(['AAPL', 'B', 'P']);
  });
  it('recent trades order by date desc and clamp the limit', () => {
    const q = buildTickerRecentTradesQuery('AAPL', { window: 'all', limit: 999 });
    expect(q.sql).toContain('t.id AS id');
    expect(q.sql).toContain('t.doc_id AS doc_id');
    expect(q.sql).toContain('t.asset_name AS asset_name');
    expect(q.sql).toContain('t.asset_type AS asset_type');
    expect(q.sql).toContain('t.asset_type_name AS asset_type_name');
    expect(q.sql).toContain('t.raw_text AS raw_text');
    expect(q.sql).toContain('t.filer_id AS filer_id');
    expect(q.sql).toContain('f.filed_date AS filed_date');
    expect(q.sql).toContain('f.source_url AS source_url');
    expect(q.sql).toContain('ORDER BY t.tx_date DESC, t.cursor_seq DESC');
    expect(q.sql).toContain('LIMIT 100');
  });
});
