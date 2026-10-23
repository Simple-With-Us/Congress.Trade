import { describe, it, expect } from 'vitest';
import {
  DELIVERY_FRESH_WINDOW_DAYS,
  deliveryFreshnessAnchorMs,
  deliveryFreshnessJudgedAtMs,
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

  it('treats late-discovered historical filings as backfill even when first-seen is recent', () => {
    const row = tx({
      filedDate: '2023-03-08',
      txDate: '2023-03-08',
      firstSeenAt: recent,
      createdAt: recent,
    });
    expect(isDeliveryBackfill(row, now)).toBe(true);
    expect(stampDeliveryFreshness(row).isBackfill).toBe(true);
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

  describe('trade date vs filed date', () => {
    const day = (msAgo: number) => new Date(now - msAgo).toISOString().slice(0, 10);
    const DAY_MS = 24 * 60 * 60 * 1000;
    const todayIso = new Date(now).toISOString();

    it('keeps a disclosure filed and first seen today fresh though its trade is 52 days old', () => {
      // Disclosures arrive weeks after the trade (median ~52 days); the trade
      // date alone must not class a brand-new filing as backfill.
      const row = tx({ filedDate: day(0), firstSeenAt: todayIso, createdAt: todayIso, txDate: day(52 * DAY_MS) });
      expect(isDeliveryBackfill(row, now)).toBe(false);
      expect(stampDeliveryFreshness(row, now).isBackfill).toBe(false);
    });

    it('falls back to the trade date when there is no filed date and no first-seen stamp', () => {
      const row = tx({ filedDate: null, firstSeenAt: null, createdAt: todayIso, txDate: '2023-01-05' });
      expect(isDeliveryBackfill(row, now)).toBe(true);
    });

    it('falls back to the trade date when there is no filed date, even if first seen today', () => {
      // Manual / local_mac imports of old trades carry no filed date.
      const row = tx({ filedDate: null, firstSeenAt: todayIso, createdAt: todayIso, txDate: '2022-09-29' });
      expect(isDeliveryBackfill(row, now)).toBe(true);
    });

    it('keeps an old filed date backfill even if first seen today', () => {
      const row = tx({ filedDate: '2023-03-08', firstSeenAt: todayIso, createdAt: todayIso, txDate: '2023-02-27' });
      expect(isDeliveryBackfill(row, now)).toBe(true);
    });
  });

  describe('deliveryFreshnessJudgedAtMs (targeted retries)', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const tenDaysAgo = new Date(now - 10 * DAY_MS).toISOString();

    it('judges a parked delivery as of when fan-out first saw it, not as of now', () => {
      // First seen, persisted and filed 10 days ago: backfill as of now, but it
      // was fresh when fan-out matched and parked it.
      const row = tx({
        filedDate: tenDaysAgo.slice(0, 10),
        firstSeenAt: tenDaysAgo,
        createdAt: tenDaysAgo,
        txDate: new Date(now - 60 * DAY_MS).toISOString().slice(0, 10),
      });
      const judgedAt = deliveryFreshnessJudgedAtMs(row);
      expect(judgedAt).toBe(Date.parse(tenDaysAgo));
      expect(isDeliveryBackfill(row, now)).toBe(true);
      expect(isDeliveryBackfill(row, judgedAt!)).toBe(false);
    });

    it('still judges a row that was backfill when first seen as backfill', () => {
      const row = tx({ filedDate: '2023-03-08', firstSeenAt: tenDaysAgo, createdAt: tenDaysAgo, txDate: '2023-03-01' });
      expect(isDeliveryBackfill(row, deliveryFreshnessJudgedAtMs(row)!)).toBe(true);
    });

    it('never judges before the row was persisted (seed rows anchor on an old filed date)', () => {
      // No first-seen stamp: the anchor falls back to the 2023 filed date, but
      // the row was persisted 10 days ago, so that is when fan-out judged it.
      const row = tx({ filedDate: '2023-03-08', firstSeenAt: null, createdAt: tenDaysAgo, txDate: '2023-03-01' });
      expect(deliveryFreshnessJudgedAtMs(row)).toBe(Date.parse(tenDaysAgo));
      expect(isDeliveryBackfill(row, deliveryFreshnessJudgedAtMs(row)!)).toBe(true);
    });

    it('returns null when the row carries no usable stamp', () => {
      expect(deliveryFreshnessJudgedAtMs(tx({ filedDate: null, firstSeenAt: null, createdAt: '' }))).toBeNull();
    });
  });

  it('exports a 7-day default window', () => {
    expect(DELIVERY_FRESH_WINDOW_DAYS).toBe(7);
  });
});
