/**
 * House PTR parser arbitration. Count is not a vote. The column parser can
 * return more rows than the `[TYPE]`-first tail parser while shifting
 * Subholding Of and the next ticker (Cisneros H-2026-20035788). Agreeing rows
 * merge. A content disagreement is held for review.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  arbitrateHousePtrParsers,
  HOUSE_PTR_PARSER_HOLD_CONFIDENCE,
  scoreHousePtrRow,
} from '../housePtrParserArbitration.ts';
import { housePtrParsersDisagree, parseHousePtrText } from '../textPdf.ts';
import type { ParsedTx } from '../../shared/types.ts';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../__fixtures__');

function row(partial: Partial<ParsedTx> & Pick<ParsedTx, 'assetName'>): ParsedTx {
  return {
    txDate: '2026-10-20',
    owner: 'self',
    ticker: 'AAPL',
    assetType: 'ST',
    assetTypeName: 'Stocks (including ADRs)',
    txType: 'B',
    amountMin: 1001,
    amountMax: 15000,
    isOption: false,
    capGainsOver200: false,
    rawText: partial.assetName,
    filingStatus: 'New',
    subholding: null,
    location: null,
    description: null,
    confidence: 1,
    ...partial,
  };
}

describe('arbitrateHousePtrParsers', () => {
  it('merges rows the parsers agree on and leaves confidence publishable', () => {
    const agreed = [
      row({ assetName: 'Apple Inc.', ticker: 'AAPL' }),
      row({ assetName: 'NVIDIA Corporation - Common Stock', ticker: 'NVDA', txType: 'S', txDate: '2026-10-21' }),
    ];
    const decision = arbitrateHousePtrParsers(agreed, agreed.map((item) => ({ ...item, rawText: 'column' })));
    expect(decision.contested).toBe(false);
    expect(decision.rows).toHaveLength(2);
    expect(decision.rows.every((item) => item.confidence === 1)).toBe(true);
    expect(decision.rows[0].rawText).toBe('Apple Inc.');
  });

  it('returns the only parser that produced rows without a hold', () => {
    const column = [row({ assetName: 'JPMorgan Chase BK N A INSTL CTF', ticker: null, assetType: 'CS' })];
    const decision = arbitrateHousePtrParsers([], column);
    expect(decision.contested).toBe(false);
    expect(decision.rows).toEqual(column);
  });

  it('does not pick the longer parser when its extra rows are shifted', () => {
    const tail = [row({ assetName: 'Apple Inc.', ticker: 'AAPL' })];
    const column = [
      row({
        assetName: '150 Main Street Trust > Bank of America Apple Inc.',
        ticker: 'AAPL',
        subholding: '150 Main Street Trust > Bank of America NVIDIA Corporation (NVDA) [ST]',
      }),
      row({
        assetName: 'New York Liberty Development Corporation Revenue Bonds',
        ticker: 'CF',
        assetType: 'ST',
        txDate: '2026-10-13',
        subholding: '150 Main Street Trust > Bank of America (ON) [ST]',
      }),
    ];
    const decision = arbitrateHousePtrParsers(tail, column);
    expect(decision.contested).toBe(true);
    expect(decision.rows).toHaveLength(1);
    expect(decision.rows[0]).toMatchObject({
      assetName: 'Apple Inc.',
      ticker: 'AAPL',
      confidence: HOUSE_PTR_PARSER_HOLD_CONFIDENCE,
    });
  });

  it('keeps a trustworthy row only one parser saw, and holds the filing', () => {
    const tail = [row({ assetName: 'Apple Inc.', ticker: 'AAPL' })];
    const column = [
      row({ assetName: 'Apple Inc.', ticker: 'AAPL' }),
      row({
        assetName: 'Norwegian Cruise Line Holdings Ltd. Ordinary Shares',
        ticker: 'NCLH',
        txDate: '2026-10-21',
      }),
    ];
    const decision = arbitrateHousePtrParsers(tail, column);
    expect(decision.contested).toBe(true);
    expect(decision.rows.map((item) => item.ticker)).toEqual(['AAPL', 'NCLH']);
    expect(decision.rows.every((item) => item.confidence === HOUSE_PTR_PARSER_HOLD_CONFIDENCE)).toBe(true);
  });

  it('prefers the ticker that matches securities_ref over a shifted symbol', () => {
    const names = new Map<string, string>([
      ['NCLH', 'Norwegian Cruise Line Holdings Ltd.'],
      ['CF', 'CF Industries Holdings, Inc.'],
    ]);
    const tail = [row({
      assetName: 'Norwegian Cruise Line Holdings Ltd. Ordinary Shares',
      ticker: 'NCLH',
    })];
    const column = [row({
      assetName: 'New York Liberty Development Corporation Revenue Bonds',
      ticker: 'CF',
      assetType: 'GS',
    })];
    const decision = arbitrateHousePtrParsers(tail, column, names);
    expect(decision.contested).toBe(true);
    expect(decision.rows[0]).toMatchObject({
      ticker: 'NCLH',
      assetName: 'Norwegian Cruise Line Holdings Ltd. Ordinary Shares',
      confidence: HOUSE_PTR_PARSER_HOLD_CONFIDENCE,
    });
    expect(scoreHousePtrRow(column[0], 0, column, names).tickerConsistency).toBe('mismatch');
    expect(scoreHousePtrRow(tail[0], 0, tail, names).tickerConsistency).toBe('match');
  });

  it('rejects an impossible date, a bad owner, and an unknown asset type', () => {
    const bad = row({
      assetName: 'Apple Inc.',
      txDate: '2026-02-31',
      owner: 'nope' as ParsedTx['owner'],
      assetType: 'ZZ',
    });
    const score = scoreHousePtrRow(bad, 0, [bad]);
    expect(score.validDate).toBe(false);
    expect(score.validOwner).toBe(false);
    expect(score.validAssetType).toBe(false);
    expect(score.score).toBeLessThan(scoreHousePtrRow(row({ assetName: 'Apple Inc.' }), 0, [row({ assetName: 'Apple Inc.' })]).score);
  });
});

describe('Cisneros H-2026-20035788', () => {
  const text = readFileSync(join(FIXTURE_DIR, 'H-2026-20035788-text-layer.txt'), 'utf8');
  const expected = JSON.parse(readFileSync(join(FIXTURE_DIR, 'H-2026-20035788-parsed-rows.json'), 'utf8')) as Array<{
    assetName: string;
    ticker: string | null;
    assetType: string;
    txDate: string;
    txType: string;
    subholding: string | null;
  }>;

  it('keeps the page-split NCLH row and does not publish a shifted column parse', () => {
    const rows = parseHousePtrText(text);
    expect(rows).toHaveLength(expected.length);
    const nclh = rows.find((item) => item.ticker === 'NCLH');
    expect(nclh).toMatchObject({
      assetName: 'Norwegian Cruise Line Holdings Ltd. Ordinary Shares',
      assetType: 'ST',
      txType: 'B',
      txDate: '2026-10-20',
      subholding: '150 Main Street Trust > Bank of America',
    });
    expect(rows.find((item) => item.ticker === 'NVDA')).toMatchObject({ assetType: 'ST' });
    expect(rows.some((item) => item.ticker === 'CF' && /Liberty/i.test(item.assetName))).toBe(false);
    expect(rows.some((item) => (item.subholding ?? '').includes('(NVDA)'))).toBe(false);

    // Hold while the parsers disagree. Once they agree row by row, the same
    // fixture can publish. PR #3069 changes the column parser toward agreement.
    if (housePtrParsersDisagree(text)) {
      expect(rows.every((item) => item.confidence < 0.95)).toBe(true);
    } else {
      expect(rows.every((item) => item.confidence >= 0.95)).toBe(true);
    }
  });
});
