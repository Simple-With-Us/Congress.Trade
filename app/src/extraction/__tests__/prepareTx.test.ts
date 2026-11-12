import { describe, it, expect } from 'vitest';
import { prepareExtractedTx } from '../prepareTx.ts';
import type { ParsedTx } from '../../shared/types.ts';

function tx(over: Partial<ParsedTx> = {}): ParsedTx {
  return {
    txDate: '2025-01-27',
    owner: 'self',
    assetName: 'Apple Inc',
    ticker: 'AAPL',
    assetType: 'ST',
    txType: 'B',
    amountMin: 15001,
    amountMax: 50000,
    isOption: false,
    capGainsOver200: false,
    rawText: 'row',
    confidence: 0.6,
    ...over,
  };
}

describe('prepareExtractedTx', () => {
  it('demotes GS ticker on a Treasury bill and keeps the type code', () => {
    const out = prepareExtractedTx(tx({
      ticker: 'GS',
      assetName: 'Treasury Bill (3-Month, Matures 5/1/2025)',
      assetType: 'GS',
    }));
    expect(out.ticker).toBeNull();
    expect(out.assetType).toBe('GS');
  });

  it('does not demote Goldman Sachs stock', () => {
    const out = prepareExtractedTx(tx({
      ticker: 'GS',
      assetName: 'Goldman Sachs Group Inc',
      assetType: 'ST',
    }));
    expect(out.ticker).toBe('GS');
    expect(out.assetType).toBe('ST');
  });

  it('clears a purchase letter leaked into assetType', () => {
    const out = prepareExtractedTx(tx({
      ticker: null,
      assetName: 'AIX Ventures Fund II, LP',
      assetType: 'P',
    }));
    expect(out.assetType).toBeNull();
  });
});
