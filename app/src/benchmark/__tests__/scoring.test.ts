import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_SCORING_PROFILE,
  compareBenchmarkRows,
  scorePersistedBenchmarkResult,
} from '../scoring.ts';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ticker: 'AAPL',
    assetName: 'Apple Inc.',
    txDate: '2026-07-01',
    txType: 'B',
    amountMin: 1_001,
    amountMax: 15_000,
    owner: 'self',
    assetType: 'ST',
    assetTypeName: 'Stocks (including ADRs)',
    isOption: false,
    capGainsOver200: false,
    filingStatus: null,
    subholding: null,
    location: null,
    description: null,
    supplementalText: null,
    ...overrides,
  };
}

describe('compareBenchmarkRows', () => {
  it('pins the persisted scoring semantics to an explicit profile', () => {
    expect(BENCHMARK_SCORING_PROFILE).toBe('ct-benchmark-scoring-v2-row-identity-strict-document');
  });

  it('keeps strict document accuracy separate from row-detection F1 counts', () => {
    const comparison = compareBenchmarkRows(
      [row({ assetTypeName: null, filingStatus: 'New', description: 'Model detail' })],
      [row()],
    );

    expect(comparison).toEqual({
      resolved: true,
      perfectMatch: false,
      tp: 1,
      fp: 0,
      fn: 0,
      gtCount: 1,
      candCount: 1,
    });
  });

  it('compares strict row multisets without depending on source order', () => {
    const apple = row();
    const microsoft = row({ ticker: 'MSFT', assetName: 'Microsoft Corp.', amountMin: 15_001, amountMax: 50_000 });

    expect(compareBenchmarkRows([microsoft, apple], [apple, microsoft])).toMatchObject({
      perfectMatch: true,
      tp: 2,
      fp: 0,
      fn: 0,
    });
  });

  it('retains duplicate multiplicity in strict and row-detection comparisons', () => {
    const disclosure = row();
    expect(compareBenchmarkRows([disclosure], [disclosure, disclosure])).toMatchObject({
      perfectMatch: false,
      tp: 1,
      fp: 0,
      fn: 1,
      gtCount: 2,
      candCount: 1,
    });
  });

  it('accepts persisted snake-case rows and normalizes numeric amount strings', () => {
    const persisted = {
      ticker: 'aapl',
      asset_name: '  Apple   Inc. ',
      tx_date: '2026-07-01',
      tx_type: 'p',
      amount_min: '$1,001',
      amount_max: '15,000',
      owner: 'SELF',
      asset_type: 'st',
      asset_type_name: 'Stocks (including ADRs)',
      is_option: 0,
      cap_gains_over_200: 0,
      filing_status: null,
      subholding: null,
      location: null,
      description: null,
      supplemental_text: null,
    };

    expect(compareBenchmarkRows([row()], [persisted])).toMatchObject({
      perfectMatch: true,
      tp: 1,
      fp: 0,
      fn: 0,
    });
  });

  it('counts a different transaction identity as one false positive and one false negative', () => {
    expect(compareBenchmarkRows(
      [row({ amountMin: 50_001, amountMax: 100_000 })],
      [row()],
    )).toMatchObject({
      perfectMatch: false,
      tp: 0,
      fp: 1,
      fn: 1,
    });
  });
});

describe('scorePersistedBenchmarkResult', () => {
  const document = { docId: 'H-1', resolved: true, groundTruth: [row()] };

  it('re-scores stored rows without any provider dependency', () => {
    expect(scorePersistedBenchmarkResult(document, {
      docId: 'H-1', invoked: true, ok: true, outcome: 'would_publish',
      result: { rows: [row({ filingStatus: 'New' })] },
    })).toMatchObject({ perfectMatch: false, tp: 1, fp: 0, fn: 0 });
  });

  it('leaves an invoked provider failure out of OCR accuracy', () => {
    expect(scorePersistedBenchmarkResult(document, {
      docId: 'H-1', invoked: true, ok: false, outcome: 'skipped', result: { rows: [] },
    })).toBeNull();
  });

  it('leaves running, unavailable, and unresolved cells unscored', () => {
    expect(scorePersistedBenchmarkResult(document, {
      docId: 'H-1', invoked: false, ok: false, outcome: 'skipped', result: null,
    })).toBeNull();
    expect(scorePersistedBenchmarkResult(document, {
      docId: 'H-1', invoked: false, ok: false, outcome: 'running', result: null,
    })).toBeNull();
    expect(scorePersistedBenchmarkResult({ ...document, resolved: false }, {
      docId: 'H-1', invoked: true, ok: true, outcome: 'would_publish', result: { rows: [row()] },
    })).toBeNull();
  });
});
