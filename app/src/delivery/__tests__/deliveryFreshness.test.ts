import { describe, it, expect } from 'vitest';
import {
  DELIVERY_FRESH_WINDOW_DAYS,
  deliveryFreshnessAnchorMs,
  isDeliveryBackfill,
  stampDeliveryFreshness,
} from '../deliveryFreshness.ts';
import type { Transaction } from '../../shared/types.ts';

function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx_1',
    docId: 'doc_1',
    filerId: 'M1',
    txDate: '2026-06-01',
    owner: 'self',
    assetName: 'ACME',
    ticker: 'ACME',
    assetType: 'stock',
    txType: 'B',
    amountMin: 1000,
    amountMax: 15000,
    isOption: false,
    capGainsOver200: false,
    rawText: '',
    confidence: 1,
    source: 'primary',
    createdAt: '2026-06-02T12:00:00.000Z',
    cursorSeq: 1,
    ...over,
  };
}

describe('deliveryFreshness', () => {
  const now = Date.now();
  const recent = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
  const stale = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const recentDay = recent.slice(0, 10);

  it('treats trades first-seen within the window as fresh', () => {
    const row = tx({ firstSeenAt: recent, txDate: recentDay, createdAt: recent });
    expect(isDeliveryBackfill(row, now)).toBe(false);
    expect(stampDeliveryFreshness(row).isBackfill).toBe(false);
  });

  it('treats trades first-seen before the window as backfill', () => {
    const row = tx({
      firstSeenAt: stale,
      txDate: stale.slice(0, 10),
      createdAt: stale,
    });
    expect(isDeliveryBackfill(row, now)).toBe(true);
  });

  it('uses filed date when first-seen is absent', () => {
    const anchor = deliveryFreshnessAnchorMs(tx({ filedDate: recentDay, firstSeenAt: null, txDate: recentDay }));
    expect(anchor).not.toBeNull();
    expect(isDeliveryBackfill(tx({ filedDate: recentDay, firstSeenAt: null, txDate: recentDay }), now)).toBe(false);
    expect(isDeliveryBackfill(tx({ filedDate: '2020-01-01', firstSeenAt: null, txDate: '2020-01-01' }), now)).toBe(true);
  });

  it('missing anchors count as backfill', () => {
    expect(isDeliveryBackfill(tx({ filedDate: null, firstSeenAt: null, createdAt: '' }), now)).toBe(true);
  });

  it('exports a 7-day default window', () => {
    expect(DELIVERY_FRESH_WINDOW_DAYS).toBe(7);
  });
});
