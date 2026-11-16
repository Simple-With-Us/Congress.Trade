/**
 * src/analytics/__tests__/sql.test.ts
 *
 * Unit tests for the shared analytics SQL fragments + filter builder. Pure +
 * deterministic (no DB): assert generated clauses, bound-param order, and the
 * input validators.
 */

import { describe, it, expect } from 'vitest';
import {
  BRACKET_MIDPOINT_SQL,
  STOCK_MIDPOINT_SQL,
  PARTY_BUCKET_SQL,
  asChamber,
  asPartyBucket,
  asPartyBuckets,
  asSourceFilter,
  asTxType,
  asTxTypes,
  constrainTxTypes,
  asWindow,
  autoGranularity,
  buildCommonFilters,
  clampLimit,
  granularityFormat,
  isWindow,
  whereSql,
  windowToOffset,
  windowDays,
} from '../sql.ts';
import { TWIN_DEDUPE_SQL } from '../../shared/tradeIdentity.ts';

describe('validators', () => {
  it('asWindow accepts preset + custom <N>d windows and falls back otherwise', () => {
    expect(asWindow('7d')).toBe('7d');
    expect(asWindow('all')).toBe('all');
    expect(asWindow('180d')).toBe('180d'); // preset (past 6 months)
    expect(asWindow('1825d')).toBe('1825d'); // preset (past 5 years)
    expect(asWindow('45d')).toBe('45d'); // custom age via API
    expect(asWindow('nonsense')).toBe('90d'); // default fallback (recent, not all-time)
    expect(asWindow('0d')).toBe('90d'); // must be >= 1 day → default fallback
    expect(asWindow('nonsense', '30d')).toBe('30d'); // explicit fallback still honored
    expect(asWindow(undefined, '90d')).toBe('90d');
    expect(isWindow('365d')).toBe(true);
    expect(isWindow('5y')).toBe(false); // only <N>d or 'all'
  });

  it('windowToOffset handles presets and custom ages', () => {
    expect(windowToOffset('1d')).toBe('-1 days');
    expect(windowToOffset('180d')).toBe('-180 days');
    expect(windowToOffset('1825d')).toBe('-1825 days');
    expect(windowToOffset('45d')).toBe('-45 days');
  });

  it('autoGranularity scales the bucket to the window length', () => {
    expect(autoGranularity('1d')).toBe('day');
    expect(autoGranularity('30d')).toBe('day');
    expect(autoGranularity('90d')).toBe('week');
    expect(autoGranularity('180d')).toBe('month');
    expect(autoGranularity('1825d')).toBe('month');
    expect(autoGranularity('all')).toBe('month');
  });

  it('asPartyBucket maps first letter to D/R/O (I→O), else undefined', () => {
    expect(asPartyBucket('Democrat')).toBe('D');
    expect(asPartyBucket('R')).toBe('R');
    expect(asPartyBucket('Independent')).toBe('O');
    expect(asPartyBucket('Other')).toBe('O');
    expect(asPartyBucket('')).toBeUndefined();
    expect(asPartyBucket(undefined)).toBeUndefined();
  });

  it('asPartyBuckets parses CSV and IN-filters multiple buckets', () => {
    expect(asPartyBuckets('D,R')).toEqual(['D', 'R']);
    expect(asPartyBuckets('R, D, R')).toEqual(['D', 'R']);
    expect(asPartyBuckets('')).toBeUndefined();
    const { where, params } = buildCommonFilters({ window: '90d', parties: ['D', 'R'] });
    expect(where.join(' AND ')).toContain('IN (?, ?)');
    expect(params).toEqual(expect.arrayContaining(['D', 'R']));
  });

  it('asChamber / asSourceFilter validate against known sets', () => {
    expect(asChamber('house')).toBe('house');
    expect(asChamber('xyz')).toBeUndefined();
    expect(asSourceFilter('primary')).toBe('primary');
    expect(asSourceFilter('bogus')).toBe('all');
  });

  it('asTxType / asTxTypes parse B/S/E and expand legacy P to Buy', () => {
    expect(asTxType('B')).toBe('B');
    expect(asTxType('P')).toBe('B');
    expect(asTxType('S')).toBe('S');
    expect(asTxType('E')).toBe('E');
    expect(asTxType('X')).toBeUndefined();
    expect(asTxTypes('B,S')).toEqual(['B', 'S']);
    expect(asTxTypes('P,S,B')).toEqual(['B', 'S']);
    expect(asTxTypes('')).toBeUndefined();
    expect(asTxTypes('nope')).toBeUndefined();
  });

  it('constrainTxTypes intersects a request with an endpoint universe', () => {
    expect(constrainTxTypes(undefined, ['B', 'S'])).toEqual(['B', 'S']);
    expect(constrainTxTypes(['B'], ['B', 'S'])).toEqual(['B']);
    expect(constrainTxTypes(['E'], ['B', 'S'])).toEqual(['__none__']);
  });

  it('accepts calendar-year window presets', () => {
    expect(isWindow('this_cy')).toBe(true);
    expect(isWindow('last_cy')).toBe(true);
    expect(asWindow('this_cy')).toBe('this_cy');
    expect(windowToOffset('this_cy')).toBeNull();
    expect(windowToOffset('last_cy')).toBeNull();
    expect(windowDays('this_cy')).toBeGreaterThan(0);
  });

  it('windowToOffset returns null only for "all"', () => {
    expect(windowToOffset('7d')).toBe('-7 days');
    expect(windowToOffset('365d')).toBe('-365 days');
    expect(windowToOffset('all')).toBeNull();
  });

  it('clampLimit clamps to [1,max] with a fallback', () => {
    expect(clampLimit(undefined, 20, 200)).toBe(20);
    expect(clampLimit(0, 20, 200)).toBe(20);
    expect(clampLimit(-5, 20, 200)).toBe(20);
    expect(clampLimit(5000, 20, 200)).toBe(200);
    expect(clampLimit(37.9, 20, 200)).toBe(37);
  });

  it('granularity helpers map windows to strftime formats', () => {
    expect(autoGranularity('7d')).toBe('day');
    expect(autoGranularity('90d')).toBe('week');
    expect(autoGranularity('365d')).toBe('month');
    expect(granularityFormat('day')).toBe('%Y-%m-%d');
    expect(granularityFormat('week')).toBe('%Y-W%W');
    expect(granularityFormat('month')).toBe('%Y-%m');
  });
});

describe('SQL fragments', () => {
  it('bracket midpoint guards the open-ended top tier (amount_max IS NULL)', () => {
    expect(BRACKET_MIDPOINT_SQL).toContain('t.amount_max IS NOT NULL');
    expect(BRACKET_MIDPOINT_SQL).toContain('(t.amount_min + t.amount_max) / 2.0');
    expect(BRACKET_MIDPOINT_SQL).toContain("t.source = 'competitor_backfill'");
    expect(STOCK_MIDPOINT_SQL).toContain('t.is_option = 1');
  });

  it("party bucket classifies D and R and folds everything else (incl. no party) into 'O'", () => {
    expect(PARTY_BUCKET_SQL).toContain("= 'D'");
    expect(PARTY_BUCKET_SQL).toContain("= 'R'");
    // Total, never NULL: All must equal D + R + O (board efd94c45; the real-SQL
    // invariant lives in partyPartition.test.ts).
    expect(PARTY_BUCKET_SQL).toContain("ELSE 'O' END");
    expect(PARTY_BUCKET_SQL).not.toContain('NULL END');
  });
});

describe('buildCommonFilters', () => {
  it('always excludes retracted + non-first-class placeholder rows, then the 30-day window with the offset as the first param', () => {
    const { where, params } = buildCommonFilters({});
    expect(where[0]).toBe('t.deprecated_at IS NULL');
    // Same "real, first-class disclosed trade" guards as the public feed
    // (src/delivery/rows.ts buildTxFilters) — see buildCommonFilters for why:
    // without these, Trends aggregates over-count relative to the Trades tab.
    expect(where[1]).toBe("SUBSTR(t.doc_id, 1, 17) != 'provider-missing-'");
    expect(where[2]).toBe('t.filer_id IS NOT NULL');
    expect(where[3]).toBe(
      "NOT (t.source = 'competitor_backfill' AND t.filer_id LIKE 'EXEC-%' AND t.doc_id LIKE 'COMPETITOR%')",
    );
    expect(where[4]).toBe(TWIN_DEDUPE_SQL);
    expect(where[5]).toBe("t.tx_date >= date('now', ?)");
    expect(params[0]).toBe('-30 days');
  });

  it('window="all" drops the date clause entirely (but keeps the retracted + placeholder guards)', () => {
    const { where, params } = buildCommonFilters({ window: 'all' });
    expect(where.join(' ')).not.toContain('tx_date >=');
    expect(where).toContain('t.deprecated_at IS NULL');
    expect(where).toContain('t.filer_id IS NOT NULL');
    expect(params).toEqual([]);
  });

  it('emits chamber/party/source/minConf clauses in order, after the always-on guards', () => {
    const { where, params } = buildCommonFilters({
      window: '90d',
      chamber: 'senate',
      party: 'D',
      source: 'primary',
      minConf: 0.7,
    });
    expect(where).toEqual([
      't.deprecated_at IS NULL',
      "SUBSTR(t.doc_id, 1, 17) != 'provider-missing-'",
      't.filer_id IS NOT NULL',
      "NOT (t.source = 'competitor_backfill' AND t.filer_id LIKE 'EXEC-%' AND t.doc_id LIKE 'COMPETITOR%')",
      TWIN_DEDUPE_SQL,
      "t.tx_date >= date('now', ?)",
      'COALESCE(fl.chamber, f.chamber) = ?',
      "(CASE WHEN UPPER(SUBSTR(TRIM(COALESCE(fl.party, '')), 1, 1)) = 'D' THEN 'D' WHEN UPPER(SUBSTR(TRIM(COALESCE(fl.party, '')), 1, 1)) = 'R' THEN 'R' ELSE 'O' END) = ?",
      "t.source IN ('primary', 'manual')",
      't.confidence >= ?',
    ]);
    expect(params).toEqual(['-90 days', 'senate', 'D', 0.7]);
  });

  it('source="all" applies no explicit source-filter clause (the always-on competitor_backfill guard still references t.source)', () => {
    const { where } = buildCommonFilters({ source: 'all' });
    expect(where).not.toContain("t.source IN ('primary', 'manual')");
    expect(where).not.toContain('t.source = ?');
  });

  it('tickerNotNull and txTypes expand to the expected clauses + params', () => {
    const { where, params } = buildCommonFilters({
      window: 'all',
      tickerNotNull: true,
      txTypes: ['B', 'S'],
    });
    expect(where).toContain("(t.ticker IS NOT NULL AND t.ticker <> '' AND t.ticker NOT IN ('NONE', '--', 'N/A', 'NA', 'NULL', '—'))");
    // Buy dual-read expands B → B,P so three binds with S
    expect(where.some((w) => w.includes('t.tx_type IN (?, ?, ?)'))).toBe(true);
    expect(params).toEqual(['B', 'P', 'S']);
  });

  it('tickers expands to an IN-list with one bind per ticker', () => {
    const { where, params } = buildCommonFilters({ window: 'all', tickers: ['AAPL', 'MSFT', 'NVDA'] });
    expect(where.some((w) => w === 't.ticker IN (?, ?, ?)')).toBe(true);
    expect(params).toEqual(['AAPL', 'MSFT', 'NVDA']);
  });

  it('always applies the canonical-trade twin guard so one real-world trade counts once', () => {
    const { where } = buildCommonFilters({ window: 'all' });
    expect(where).toContain(TWIN_DEDUPE_SQL);
  });

  it('excludeOptions adds an is_option = 0 clause (no bind), off by default', () => {
    const { where, params } = buildCommonFilters({ window: 'all', excludeOptions: true });
    expect(where).toContain('t.is_option = 0');
    expect(params).toEqual([]);
    expect(buildCommonFilters({ window: 'all' }).where).not.toContain('t.is_option = 0');
  });

  it('whereSql renders a clause with a trailing space, or empty', () => {
    expect(whereSql([])).toBe('');
    expect(whereSql(['a = ?', 'b = ?'])).toBe('WHERE a = ? AND b = ? ');
  });
});
