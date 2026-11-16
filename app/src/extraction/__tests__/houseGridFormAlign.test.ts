import { describe, expect, it } from 'vitest';
import {
  alignGridFormRowsByPage,
  rowMatches,
  type GridAlignRow,
} from '../houseGridFormAlign.ts';

function row(partial: Partial<GridAlignRow> & { assetName: string }): GridAlignRow {
  return {
    page: partial.page ?? 1,
    txType: partial.txType ?? null,
    txDate: partial.txDate ?? null,
    notificationDate: partial.notificationDate ?? null,
    owner: partial.owner ?? null,
    assetName: partial.assetName,
    ticker: partial.ticker ?? null,
    amountMin: partial.amountMin ?? null,
    amountMax: partial.amountMax ?? null,
  };
}

describe('houseGridFormAlign', () => {
  it('rowMatches accepts type or asset+date', () => {
    const hand = row({ txType: 'S', txDate: '2026-10-07', assetName: 'Comcast Corporation CMN' });
    const byType = row({ txType: 'S', txDate: null, assetName: 'Other Inc' });
    const byAsset = row({
      txType: 'B',
      txDate: '2026-10-07',
      assetName: 'Comcast Corporation CMN',
    });
    expect(rowMatches(hand, byType)).toBe(true);
    expect(rowMatches(hand, byAsset)).toBe(true);
    expect(rowMatches(hand, row({ txType: 'B', txDate: '2026-10-07', assetName: 'Uber' }))).toBe(false);
  });

  it('order-preserving align skips phantom preds', () => {
    const hand = [
      row({ page: 8, txType: 'B', txDate: '2026-10-13', assetName: 'Humana Inc CMN' }),
      row({ page: 8, txType: 'S', txDate: '2026-10-13', assetName: 'Oracle Corporation CMN' }),
    ];
    const pred = [
      row({ page: 8, txType: 'B', txDate: '2026-10-13', assetName: 'Humana Inc CMN' }),
      row({ page: 8, txType: null, txDate: null, assetName: 'Pepsico Inc CMN' }),
      row({ page: 8, txType: 'S', txDate: '2026-10-13', assetName: 'Oracle Corporation CMN' }),
    ];
    const pairs = alignGridFormRowsByPage(hand, pred);
    expect(pairs).toHaveLength(2);
    expect(pairs[1]?.pred.assetName).toBe('Oracle Corporation CMN');
  });
});
