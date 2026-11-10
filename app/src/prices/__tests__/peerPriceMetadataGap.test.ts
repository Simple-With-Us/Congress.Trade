/**
 * Regression for CT-2408: securities_ref.latest_price_date can look "fresh"
 * while price_eod is empty, so price refresh never runs and the ticker never
 * re-prices across restarts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { selectTickersNeedingPrices, lastTradingDay } from '../service.ts';
import { openMigratedD1, type SqliteDatabase } from './sqliteD1.ts';

let db: SqliteDatabase;
let env: Env;
let close: () => void;

beforeEach(async () => {
  const opened = await openMigratedD1();
  db = opened.db;
  env = { DB: opened.d1 } as unknown as Env;
  close = opened.close;
});
afterEach(() => close());

describe('selectTickersNeedingPrices — metadata without price_eod', () => {
  it('re-selects when latest_price_date is fresh but no price_eod rows exist', async () => {
    const freshThrough = lastTradingDay(new Date('2026-10-12T18:00:00.000Z'));
    db.prepare(
      `INSERT INTO transactions (id, ticker, tx_date, source, created_at)
       VALUES ('tx-gap', 'GAP', '2026-01-05', 'primary', '2026-01-05T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO securities_ref (ticker, latest_price_date, price_checked_at)
       VALUES ('GAP', ?, NULL)`,
    ).run(freshThrough);

    const picked = await selectTickersNeedingPrices(env, 10, { freshThrough });
    expect(picked).toContain('GAP');
  });
});
