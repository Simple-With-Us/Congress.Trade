import { describe, expect, it } from 'vitest';

import { hashPublishMaterialRows, materialRowFingerprint, multisetContentHash } from '../publishContentHash.ts';

describe('publishContentHash', () => {
  it('order does not affect multiset hash', async () => {
    const row = {
      txDate: '2026-01-10',
      owner: 'self' as const,
      assetName: 'Apple Inc.',
      ticker: 'AAPL',
      txType: 'P',
      amountMin: 1001,
      amountMax: 15000,
    };
    const a = await hashPublishMaterialRows([row, { ...row, txDate: '2026-01-11', assetName: 'Microsoft', ticker: 'MSFT', txType: 'S' }]);
    const b = await hashPublishMaterialRows([
      { ...row, txDate: '2026-01-11', assetName: 'Microsoft', ticker: 'MSFT', txType: 'S' },
      row,
    ]);
    expect(a).toBe(b);
  });

  it('ignores cosmetic asset-name casing', () => {
    const upper = materialRowFingerprint({
      txDate: '2026-01-10',
      owner: 'self',
      assetName: 'APPLE INC',
      ticker: 'AAPL',
      txType: 'P',
      amountMin: 1001,
      amountMax: 15000,
    });
    const lower = materialRowFingerprint({
      txDate: '2026-01-10',
      owner: 'self',
      assetName: 'Apple Inc.',
      ticker: 'AAPL',
      txType: 'P',
      amountMin: 1001,
      amountMax: 15000,
    });
    expect(upper).toBe(lower);
  });

  it('changes hash when trade date changes', async () => {
    const base = {
      txDate: '2026-01-10',
      owner: 'self' as const,
      assetName: 'Apple Inc.',
      ticker: 'AAPL',
      txType: 'P',
      amountMin: 1001,
      amountMax: 15000,
    };
    const h1 = await multisetContentHash([materialRowFingerprint(base)]);
    const h2 = await multisetContentHash([materialRowFingerprint({ ...base, txDate: '2026-01-11' })]);
    expect(h1).not.toBe(h2);
  });
});
