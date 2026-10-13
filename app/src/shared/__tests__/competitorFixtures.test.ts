import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedD1, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import {
  excludeCompetitorFixtureTransactionSql,
  tickerHasNonCompetitorFixtureTrade,
} from '../competitorFixtures.ts';
import { markTickerPriceUnavailable } from '../../prices/service.ts';

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

describe('competitorFixtures', () => {
  it('excludeCompetitorFixtureTransactionSql filters COMPETITOR-* doc ids', () => {
    expect(excludeCompetitorFixtureTransactionSql('t')).toContain("t.doc_id NOT LIKE 'COMPETITOR-%'");
  });

  it('tickerHasNonCompetitorFixtureTrade is false for fixture-only symbols', async () => {
    db.prepare(
      `INSERT INTO transactions (id, doc_id, ticker, tx_date, source, created_at)
       VALUES ('tx-fix', 'COMPETITOR-synthetic', 'GNKOQ', '2026-01-01', 'competitor_backfill', '2026-01-01T00:00:00Z')`,
    ).run();
    expect(await tickerHasNonCompetitorFixtureTrade({ DB: d1 } as never, 'GNKOQ')).toBe(false);
  });

  it('tickerHasNonCompetitorFixtureTrade is true when a real disclosure row exists', async () => {
    db.prepare(
      `INSERT INTO transactions (id, doc_id, ticker, tx_date, source, created_at)
       VALUES ('tx-real', 'H-2026-1', 'BHI', '2026-01-01', 'primary', '2026-01-01T00:00:00Z')`,
    ).run();
    expect(await tickerHasNonCompetitorFixtureTrade({ DB: d1 } as never, 'BHI')).toBe(true);
  });

  it('markTickerPriceUnavailable skips fixture-only tickers unless forced', async () => {
    db.prepare(
      `INSERT INTO transactions (id, doc_id, ticker, tx_date, source, created_at)
       VALUES ('tx-fix', 'COMPETITOR-dot', '.', '2026-01-01', 'competitor_backfill', '2026-01-01T00:00:00Z')`,
    ).run();
    await markTickerPriceUnavailable({ DB: d1 } as never, '.', 'socratic_no_eod_history');
    expect(db.prepare('SELECT ticker FROM securities_ref WHERE ticker = ?').get('.')).toBeUndefined();
    await markTickerPriceUnavailable({ DB: d1 } as never, '.', 'operator', { force: true });
    expect(db.prepare('SELECT price_unavailable FROM securities_ref WHERE ticker = ?').get('.')?.price_unavailable)
      .toBe(1);
  });
});
