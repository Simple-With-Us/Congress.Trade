/**
 * Stale /performance/:txId must return before the unused S&P lookups.
 */
import { describe, expect, it } from 'vitest';
import { buildAnalyticsRouter } from '../routes.ts';
import { currentPriceFreshThrough } from '../../prices/staleness.ts';

const app = buildAnalyticsRouter();

function tradeRow(currentPriceDate: string | null) {
  return {
    tx_type: 'P',
    is_option: 0,
    ticker: 'AAPL',
    tx_date: '2026-01-02',
    filed_date: '2026-01-20',
    price_at_trade: 100,
    spx_at_trade: 5000,
    current_price: 110,
    current_price_date: currentPriceDate,
  };
}

function fakeDb(currentPriceDate: string | null) {
  const queries: string[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async first() {
          queries.push(sql);
          if (/FROM transactions t/i.test(sql)) return tradeRow(currentPriceDate);
          if (/FROM spx_eod/i.test(sql)) return { close: 5100 };
          if (/FROM price_eod/i.test(sql)) return { close: 105 };
          throw new Error(`unexpected query: ${sql}`);
        },
      };
    },
  };
  return { db, queries };
}

describe('GET /performance/:txId staleness', () => {
  it('returns stale before any S&P lookup when the cached price is old', async () => {
    const { db, queries } = fakeDb('2020-01-02');
    const res = await app.request('/performance/tx1', {}, { DB: db } as never);
    expect(res.status).toBe(200);
    const body = await res.json() as { stale?: boolean; tradeDatePerformance: unknown; freshThrough: string };
    expect(body.stale).toBe(true);
    expect(body.tradeDatePerformance).toBeNull();
    expect(body.freshThrough).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(queries.some((sql) => /spx_eod/i.test(sql))).toBe(false);
  });

  it('returns stale before any S&P lookup when the price date is missing', async () => {
    const { db, queries } = fakeDb(null);
    const res = await app.request('/performance/tx1', {}, { DB: db } as never);
    expect(res.status).toBe(200);
    const body = await res.json() as { stale?: boolean; currentPriceDate: string | null };
    expect(body.stale).toBe(true);
    expect(body.currentPriceDate).toBeNull();
    expect(queries.some((sql) => /spx_eod/i.test(sql))).toBe(false);
  });

  it('still aligns a fresh price to the S&P close on that date', async () => {
    const fresh = currentPriceFreshThrough();
    const { db, queries } = fakeDb(fresh);
    const res = await app.request('/performance/tx1', {}, { DB: db } as never);
    expect(res.status).toBe(200);
    const body = await res.json() as { stale?: boolean; assetReturn: number | null };
    expect(body.stale).toBeUndefined();
    expect(body.assetReturn).toBeCloseTo(0.1, 5);
    expect(queries.some((sql) => /FROM spx_eod WHERE date <= \?/i.test(sql))).toBe(true);
  });
});
