import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRestRouter } from '../rest.ts';
import { openMigratedD1, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import { evaluateCurrentPriceStaleness } from '../../prices/staleness.ts';
import { MarketPriceSeriesReadSchema } from '../../shared/marketPriceSchemas.ts';

let db: SqliteDatabase;
let d1: D1Database;
let close: () => void;

beforeEach(async () => {
  const opened = await openMigratedD1();
  db = opened.db;
  d1 = opened.d1;
  close = opened.close;
});
afterEach(() => close());

describe('GET /market/prices/:ticker staleness fields', () => {
  it('returns stale=true when current_price_date is behind freshThrough', async () => {
    db.prepare(
      "INSERT INTO securities_ref (ticker, current_price, current_price_date) VALUES ('OLD', 50, '2026-07-01')",
    ).run();
    db.prepare("INSERT INTO price_eod (ticker, date, close) VALUES ('OLD', '2026-07-01', 50)").run();

    const app = buildRestRouter();
    const res = await app.request('/market/prices/OLD', {}, { DB: d1 } as never);
    expect(res.status).toBe(200);
    const body = MarketPriceSeriesReadSchema.parse(await res.json());
    const expected = evaluateCurrentPriceStaleness('2026-07-01');
    expect(body.freshThrough).toBe(expected.freshThrough);
    expect(body.stale).toBe(true);
    expect(body.dataAgeDays).toBeGreaterThan(0);
    expect(body.currentPriceDate).toBe('2026-07-01');
  });
});
