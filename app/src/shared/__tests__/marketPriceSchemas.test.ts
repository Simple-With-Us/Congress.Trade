import { describe, expect, it } from 'vitest';
import { MarketPriceSeriesReadSchema } from '../marketPriceSchemas.ts';

describe('MarketPriceSeriesReadSchema', () => {
  it('accepts staleness fields on top of the shared price series shape', () => {
    const parsed = MarketPriceSeriesReadSchema.parse({
      ticker: 'AAPL',
      closes: [{ date: '2026-07-01', close: 100 }],
      currentPrice: 100,
      currentPriceDate: '2026-07-01',
      stale: true,
      freshThrough: '2026-07-13',
      dataAgeDays: 12,
    });
    expect(parsed.stale).toBe(true);
    expect(parsed.dataAgeDays).toBe(12);
  });
});
