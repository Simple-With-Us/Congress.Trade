/**
 * src/export/__tests__/pitScores.test.ts
 *
 * Regression tests for the point-in-time score export helpers. The key safety
 * property: politician skill must ignore any outcome whose evaluation horizon had
 * not matured by the observation's asOf date.
 */

import { describe, expect, it } from 'vitest';
import {
  MEMBER_SKILL_HORIZON_DAYS,
  MEMBER_SKILL_HORIZONS,
  buildPitScoreExport,
  computePitMemberSkillFromRows,
  parsePitScoreQuery,
  pitScoreRowsToNdjson,
  type PriceBar,
} from '../pitScores.ts';

const prices = (rows: Array<[string, number]>): PriceBar[] =>
  rows.map(([date, close]) => ({ date, close }));

describe('computePitMemberSkillFromRows', () => {
  it('excludes member outcomes whose horizon had not matured before asOf', () => {
    const px = prices([
      ['2026-01-01', 100],
      ['2026-02-10', 110],
      ['2026-03-06', 120], // 63d after Jan 1 has matured by Mar 10.
    ]);
    const spx = prices([
      ['2026-01-01', 1000],
      ['2026-02-10', 1010],
      ['2026-03-06', 1020],
    ]);
    const skill = computePitMemberSkillFromRows(
      [
        { id: 'old', filerId: 'F1', ticker: 'AAPL', txDate: '2026-01-01', side: 'P', disclosureAvailableAt: '2026-01-01T00:00:00.000Z' },
        { id: 'immature', filerId: 'F1', ticker: 'AAPL', txDate: '2026-02-20', side: 'P', disclosureAvailableAt: '2026-02-20T00:00:00.000Z' },
      ],
      new Map([['AAPL', px]]),
      spx,
      '2026-03-10',
      42,
    );

    expect(MEMBER_SKILL_HORIZON_DAYS).toBe(63);
    expect(MEMBER_SKILL_HORIZONS.map((h) => h.key)).toEqual(['1m', '3m', '6m', '12m']);
    expect(skill.scoredCount).toBe(1);
    expect(skill.sourceRecordIds).toEqual(['old']);
    expect(skill.skillScoredThrough).toBe('2026-03-06');
    expect(skill.filingAlpha).toBeGreaterThan(0);
    expect(skill.tradeAlpha).toBeGreaterThan(0);
    expect(skill.horizons['3m'].filingAlpha as number).toBeGreaterThan(0);
    expect(skill.byDirection.buy.filingAlpha as number).toBeGreaterThan(0);
    expect(skill.fallback).toBeNull();
  });

  it('treats sale skill as positive when the asset underperforms after disclosure', () => {
    const px = prices([
      ['2026-01-01', 100],
      ['2026-01-25', 90],
      ['2026-03-06', 80],
    ]);
    const spx = prices([
      ['2026-01-01', 1000],
      ['2026-01-25', 1000],
      ['2026-03-06', 1000],
    ]);
    const skill = computePitMemberSkillFromRows(
      [{ id: 'sale', filerId: 'F1', ticker: 'AAPL', txDate: '2026-01-01', side: 'S', disclosureAvailableAt: '2026-01-01T00:00:00.000Z' }],
      new Map([['AAPL', px]]),
      spx,
      '2026-03-10',
      42,
    );

    expect(skill.byDirection.sell.filingAlpha as number).toBeGreaterThan(0);
    const oneMonth = skill.horizons['1m'] as { byDirection: { sell: { alpha: number } } };
    expect(oneMonth.byDirection.sell.alpha).toBeGreaterThan(0);
    expect(skill.sourceRecordIds).toEqual(['sale']);
  });

  it('falls back to activity prominence when no matured labels exist', () => {
    const px = prices([
      ['2026-02-10', 110],
      ['2026-03-06', 120],
    ]);
    const spx = prices([
      ['2026-02-10', 1010],
      ['2026-03-06', 1020],
    ]);
    const skill = computePitMemberSkillFromRows(
      [{ id: 'immature', filerId: 'F1', ticker: 'AAPL', txDate: '2026-03-01', side: 'P', disclosureAvailableAt: '2026-03-01T00:00:00.000Z' }],
      new Map([['AAPL', px]]),
      spx,
      '2026-03-10',
      37,
    );

    expect(skill.scoredCount).toBe(0);
    expect(skill.skillScore).toBeNull();
    expect(skill.filingAlpha).toBeNull();
    expect(skill.tradeAlpha).toBeNull();
    expect(skill.fallback).toBe('activity_prominence');
    expect(skill.fallbackScore).toBe(37);
    expect(skill.sourceRecordIds).toEqual([]);
  });
});

describe('parsePitScoreQuery', () => {
  it('validates date ranges and placebos', () => {
    expect(parsePitScoreQuery({ from: '2026-01-02', to: '2026-01-01' })).toMatchObject({ status: 400 });
    expect(parsePitScoreQuery({ placebo: 'bogus' })).toMatchObject({ status: 400 });
    expect(parsePitScoreQuery({ source: 'bogus' })).toMatchObject({ status: 400 });
    expect(parsePitScoreQuery({ minConf: '2' })).toMatchObject({ status: 400 });
    expect(parsePitScoreQuery({ ticker: 'aapl', limit: '999', format: 'ndjson', placebo: 'no_flow' })).toMatchObject({
      ticker: 'AAPL',
      limit: 500,
      format: 'ndjson',
      placebo: 'no_flow',
    });
  });

  it('parses cursors over asOf and ticker', () => {
    expect(parsePitScoreQuery({ cursor: '2026-01-02T00:00:00.000Z~AAPL' })).toMatchObject({
      cursor: { asOf: '2026-01-02T00:00:00.000Z', ticker: 'AAPL' },
    });
    expect(parsePitScoreQuery({ cursor: 'bad' })).toMatchObject({ status: 400 });
  });
});

describe('buildPitScoreExport pagination', () => {
  it('returns a nextCursor and continues after it', async () => {
    const env = {
      DB: fakeDb({
        transactions: [
          tx('tx1', 'AAPL', '2026-01-01T00:00:00.000Z'),
          tx('tx2', 'MSFT', '2026-01-02T00:00:00.000Z'),
        ],
        price_eod: [],
        spx_eod: [],
      }),
    };
    const first = await buildPitScoreExport(env as never, { limit: 1, format: 'json', placebo: 'none', source: 'all' }, new Date('2026-03-01T00:00:00.000Z'));
    expect(first.rows.map((r) => r.ticker)).toEqual(['AAPL']);
    expect(first.pagination.nextCursor).toBe('2026-01-01T00:00:00.000Z~AAPL');
    expect(first.rows[0]).toMatchObject({
      assetTypeCategory: 'public_equity',
      assetTypeCategoryLabel: 'Public Equity',
      assetTypeCategorySource: 'label',
    });
    expect(first.rows[0].includedDisclosures[0]).toMatchObject({
      assetType: 'STOCK',
      assetTypeName: 'Stock',
      assetTypeCategory: 'public_equity',
    });
    expect(first.validationReadiness).toMatchObject({
      historicalValidationReady: false,
      scoreInputsPitSafeRows: 1,
      historicalValidationReadyRows: 0,
      researchOnlyRows: 1,
    });
    expect(first.rows[0].pitValidity).toMatchObject({
      historicalValidationReady: false,
      scoreInputsPitSafe: true,
      metadataPitComplete: false,
      recommendedUse: 'score_input_validation_only_pending_metadata_vintages',
    });
    expect((first.rows[0].pitValidity.reasonCodes as string[])).toContain('missing_no_signal_decision_universe');

    const second = await buildPitScoreExport(env as never, {
      limit: 1,
      format: 'json',
      placebo: 'none',
      source: 'all',
      cursor: { asOf: '2026-01-01T00:00:00.000Z', ticker: 'AAPL' },
    }, new Date('2026-03-01T00:00:00.000Z'));
    expect(second.rows.map((r) => r.ticker)).toEqual(['MSFT']);
    expect(second.pagination.nextCursor).toBeNull();
  });

  it('uses securities_ref asset class when disclosure asset type is missing', async () => {
    const env = {
      DB: fakeDb({
        transactions: [
          tx('tx1', 'AAPL', '2026-01-01T00:00:00.000Z', {
            asset_type: null,
            asset_type_name: null,
            asset_class: 'equity',
          }),
        ],
        price_eod: [],
        spx_eod: [],
      }),
    };
    const result = await buildPitScoreExport(
      env as never,
      { limit: 1, format: 'json', placebo: 'none', source: 'all' },
      new Date('2026-03-01T00:00:00.000Z'),
    );

    expect(result.rows[0]).toMatchObject({
      assetType: 'equity',
      assetTypeCategory: 'public_equity',
      assetTypeCategorySource: 'label',
    });
  });

  it('flags seed/date-only rows as not true historical validation rows', async () => {
    const env = {
      DB: fakeDb({
        transactions: [
          tx('seed1', 'AAPL', null, { source: 'seed_dataset', filed_date: '2020-01-02', created_at: '2026-06-21T00:00:00.000Z' }),
        ],
        price_eod: [],
        spx_eod: [],
      }),
    };

    const out = await buildPitScoreExport(env as never, { limit: 10, format: 'json', placebo: 'none', source: 'all' }, new Date('2026-06-27T00:00:00.000Z'));
    expect(out.validationReadiness).toMatchObject({
      historicalValidationReady: false,
      scoreInputsPitSafeRows: 0,
      historicalValidationReadyRows: 0,
      researchOnlyRows: 1,
    });
    expect(out.rows[0].pitValidity).toMatchObject({
      historicalValidationReady: false,
      scoreInputsPitSafe: false,
      recommendedUse: 'research_contract_or_live_forward_collection_only',
    });
    expect((out.rows[0].pitValidity.reasonCodes as string[])).toContain('missing_true_market_observed_disclosure_timestamp');
    expect((out.rows[0].pitValidity.reasonCodes as string[])).toContain('non_primary_or_historical_seed_source');
  });
});

describe('buildPitScoreExport delisting metadata', () => {
  const asOf = new Date('2026-03-01T00:00:00.000Z');
  const runFor = async (ticker: string) => {
    const env = {
      DB: fakeDb({
        transactions: [tx('t1', ticker, '2026-01-01T00:00:00.000Z')],
        price_eod: [],
        spx_eod: [],
      }),
    };
    const out = await buildPitScoreExport(env as never, { limit: 1, format: 'json', placebo: 'none', source: 'all' }, asOf);
    return out.rows[0].delistingTickerChangeMetadata;
  };

  it('records acquisition delisting metadata for an acquired source ticker (ATVI)', async () => {
    // ATVI is an acquisition source (Microsoft acquired Activision, delisted). It is deliberately
    // NOT folded to MSFT at ingest, so it reaches scoring as ATVI and must be flagged delisted.
    expect(await runFor('ATVI')).toMatchObject({
      aliasClass: 'acquisition',
      delisted: true,
      acquiredBy: 'MSFT',
      mappedToCurrentTicker: null,
      reason: 'curated_alias_map',
    });
  });

  it('leaves a rename-target ticker unflagged and unchanged (META)', async () => {
    // Renames are folded to the current ticker (FB→META) upstream; META must keep its existing
    // prior-ticker metadata and never be marked delisted.
    expect(await runFor('META')).toMatchObject({
      knownPriorTickers: ['FB'],
      mappedToCurrentTicker: null,
      aliasClass: null,
      delisted: false,
      acquiredBy: null,
      reason: 'curated_alias_map',
    });
  });

  it('records no delisting metadata for a plain ticker with no alias relationship (AAPL)', async () => {
    expect(await runFor('AAPL')).toMatchObject({
      knownPriorTickers: [],
      mappedToCurrentTicker: null,
      aliasClass: null,
      delisted: false,
      acquiredBy: null,
      reason: null,
    });
  });
});

describe('pitScoreRowsToNdjson', () => {
  it('emits one JSON line per row and an empty string for no rows', () => {
    expect(pitScoreRowsToNdjson([])).toBe('');
    expect(pitScoreRowsToNdjson([{ a: 1 }, { b: 2 }] as never)).toBe('{"a":1}\n{"b":2}\n');
  });
});

function tx(id: string, ticker: string, firstSeenAt: string | null, overrides: Record<string, unknown> = {}) {
  const fallbackDate = firstSeenAt?.slice(0, 10) ?? '2026-01-01';
  return {
    id,
    doc_id: `doc-${id}`,
    filer_id: `F-${id}`,
    tx_date: fallbackDate,
    owner: 'Self',
    asset_name: ticker,
    ticker,
    asset_type: 'STOCK',
    asset_type_name: 'Stock',
    tx_type: 'B',
    amount_min: 1001,
    amount_max: 15000,
    is_option: 0,
    raw_text: null,
    confidence: 0.9,
    source: 'primary',
    created_at: firstSeenAt,
    filed_date: fallbackDate,
    first_seen_at: firstSeenAt,
    source_url: 'https://example.test/filing',
    filing_chamber: 'house',
    full_name: 'Test Politician',
    filer_chamber: 'house',
    party: 'I',
    state: 'NA',
    committees: '[]',
    company_name: ticker,
    sector: null,
    industry: null,
    asset_class: 'equity',
    cik: null,
    exchange_short: 'NASDAQ',
    ...overrides,
  };
}

function fakeDb(data: Record<string, Array<Record<string, unknown>>>) {
  return {
    prepare(sql: string) {
      const stmt = {
        bind: () => stmt,
        async all<T>() {
          const table = /FROM\s+(\w+)/i.exec(sql)?.[1] ?? '';
          return { results: (data[table] ?? []) as T[] };
        },
      };
      return stmt;
    },
  };
}
