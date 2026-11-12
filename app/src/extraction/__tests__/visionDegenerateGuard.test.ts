/**
 * CT-2509 — vision/OCR degenerate extract guard.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Owner, ParsedTx, TxType } from '../../shared/types.ts';
import {
  assessVisionDegenerate,
  assetNameSuggestsListedSecurity,
  mergeVisionDegenerateReason,
  VISION_DEGENERATE_REASON,
} from '../visionDegenerateGuard.ts';

type HandRow = {
  assetName: string;
  ticker: string | null;
  txType: TxType;
  owner: Owner;
  txDate: string;
  amountMin: number;
  amountMax: number;
};

function handRowsToParsed(rows: HandRow[]): ParsedTx[] {
  return rows.map((row, index) => ({
    txDate: row.txDate,
    owner: row.owner,
    assetName: row.assetName,
    ticker: row.ticker,
    assetType: null,
    txType: row.txType,
    amountMin: row.amountMin,
    amountMax: row.amountMax,
    isOption: false,
    capGainsOver200: false,
    rawText: row.assetName,
    confidence: 0.97,
  }));
}

function loadFixture(name: string): HandRow[] {
  return JSON.parse(
    readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), 'utf8'),
  ) as HandRow[];
}

function tx(over: Partial<ParsedTx> = {}): ParsedTx {
  return {
    txDate: '2026-10-22',
    owner: 'joint',
    assetName: 'Apple Inc.',
    ticker: 'AAPL',
    assetType: null,
    txType: 'B',
    amountMin: 1001,
    amountMax: 15000,
    isOption: false,
    capGainsOver200: false,
    rawText: 'Apple Inc.',
    confidence: 0.97,
    ...over,
  };
}

describe('assessVisionDegenerate', () => {
  it('REGRESSION: Fleischmann degenerate Mac vision rows are flagged', () => {
    const parsed = handRowsToParsed(loadFixture('H-2026-9116403-degenerate-rows.json'));
    const hit = assessVisionDegenerate(parsed);
    expect(hit.degenerate).toBe(true);
    expect(hit.signals.map((s) => s.code)).toEqual([
      'uniform_owner_and_tx_type',
      'all_tickers_null_recognizable_names',
      'constant_date_and_amount',
    ]);
  });

  it('CONTROL: Fleischmann hand-truth rows pass', () => {
    const parsed = handRowsToParsed(loadFixture('H-2026-9116403-hand-rows.json'));
    const hit = assessVisionDegenerate(parsed);
    expect(hit.degenerate).toBe(false);
    expect(hit.signals.some((s) => s.code === 'uniform_owner_and_tx_type')).toBe(false);
    expect(hit.signals.some((s) => s.code === 'all_tickers_null_recognizable_names')).toBe(false);
  });

  it('CONTROL: a single-trade extract is never held for uniformity', () => {
    const hit = assessVisionDegenerate([
      tx({ ticker: null, owner: 'self', txType: 'S' }),
    ]);
    expect(hit.degenerate).toBe(false);
  });

  it('CONTROL: genuinely uniform multi-row filing with tickers still publishes path', () => {
    const rows = ['TLH', 'XAR', 'SPMD'].map((ticker, i) =>
      tx({
        ticker,
        owner: 'joint',
        txType: 'B',
        assetName: `ETF ${i}`,
        txDate: '2026-10-22',
      }),
    );
    const hit = assessVisionDegenerate(rows);
    expect(hit.degenerate).toBe(false);
  });

  it('CONTROL: shared date and amount alone is not degenerate when types and tickers vary', () => {
    const parsed = handRowsToParsed(loadFixture('H-2026-9116403-hand-rows.json'));
    expect(parsed.some((r) => r.txType === 'B')).toBe(true);
    expect(parsed.some((r) => r.txType === 'S')).toBe(true);
    const hit = assessVisionDegenerate(parsed);
    expect(hit.signals.some((s) => s.code === 'constant_date_and_amount')).toBe(true);
    expect(hit.degenerate).toBe(false);
  });
});

describe('assetNameSuggestsListedSecurity', () => {
  it('recognizes ETF-style fund names from the Fleischmann fixture', () => {
    expect(assetNameSuggestsListedSecurity('SPDR Ser Tr S&P 400 Mid Cap ETF')).toBe(true);
    expect(assetNameSuggestsListedSecurity('Obscure Private Holdings LLC Series Q')).toBe(false);
  });
});

describe('mergeVisionDegenerateReason', () => {
  it('prefixes vision_degenerate without duplicating the token', () => {
    expect(mergeVisionDegenerateReason('low_confidence')).toBe(`${VISION_DEGENERATE_REASON},low_confidence`);
    expect(mergeVisionDegenerateReason(VISION_DEGENERATE_REASON)).toBe(VISION_DEGENERATE_REASON);
  });
});
