/**
 * Board row 6c05e09b: "Excess vs S&P" subtracted the S&P move up to the LATEST
 * S&P bar (2026-08-03) from an asset whose price was frozen at 2026-07-24, so
 * every stale-priced ticker carried a benchmark-drift error equal to the market
 * move over the gap.  These run the real leaderboard / skill / per-member SQL
 * against a migrated in-memory schema and assert numerically that both legs end
 * on the same date.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedD1, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import {
  buildMemberPerformanceLeaderboardQuery,
  buildMemberPerformanceQuery,
  buildMemberSkillQuery,
  buildPriceAnchorCteBody,
} from '../builders.ts';
import { aggregateMemberDualPerformance } from '../compute.ts';

let db: SqliteDatabase;

beforeEach(async () => {
  ({ db } = await openMigratedD1());
  for (const [date, close] of [['2026-07-20', 5000], ['2026-07-24', 5040], ['2026-08-03', 5100]] as const) {
    db.prepare('INSERT INTO spx_eod (date, close) VALUES (?, ?)').run(date, close);
  }
  // STALE was last priced 2026-07-24; FRESH on 2026-08-03; both moved +10% since the filing.
  db.prepare("INSERT INTO securities_ref (ticker, company_name, current_price, current_price_date) VALUES ('STALE', 'Stale Corp', 110, '2026-07-24')").run();
  db.prepare("INSERT INTO securities_ref (ticker, company_name, current_price, current_price_date) VALUES ('FRESH', 'Fresh Corp', 110, '2026-08-03')").run();
  db.prepare("INSERT INTO securities_ref (ticker, company_name, current_price) VALUES ('NODATE', 'No Date Corp', 110)").run();
  db.prepare("INSERT INTO filers (bioguide_id, chamber, full_name) VALUES ('f-stale', 'house', 'Stale Filer'), ('f-fresh', 'house', 'Fresh Filer'), ('f-nodate', 'house', 'No Date Filer')").run();
  buy('f-stale', 'STALE');
  buy('f-fresh', 'FRESH');
  buy('f-nodate', 'NODATE');
});

afterEach(() => db.close());

function buy(filerId: string, ticker: string) {
  const id = `tx-${ticker}`;
  db.prepare("INSERT INTO filings (doc_id, chamber, filer_id, filing_type, filed_date, ingest_status) VALUES (?, 'house', ?, 'P', '2026-06-01', 'persisted')").run(`doc-${ticker}`, filerId);
  db.prepare(
    `INSERT INTO transactions (id, doc_id, filer_id, tx_date, ticker, asset_type, is_option, tx_type, amount_min, amount_max, source)
     VALUES (?, ?, ?, '2026-05-25', ?, 'ST', 0, 'B', 1001, 15000, 'primary')`,
  ).run(id, `doc-${ticker}`, filerId, ticker);
  db.prepare(
    'INSERT INTO tx_performance (tx_id, price_at_trade, spx_at_trade, price_at_filing, spx_at_filing, computed_at) VALUES (?, 95, 4700, 100, 4800, ?)',
  ).run(id, '2026-08-19T00:00:00.000Z');
}

describe('performance leaderboard excess uses the S&P close on the ticker\'s own price date', () => {
  const freshThrough = '2026-08-03';

  it('excludes stale-priced tickers from excess-return leaderboards', () => {
    const q = buildMemberPerformanceLeaderboardQuery({
      window: 'all',
      minTrades: 1,
      limit: 10,
      priceFreshThrough: freshThrough,
    });
    expect(q.sql).toContain(buildPriceAnchorCteBody(freshThrough));
    const rows = db.prepare(q.sql).all(...q.params) as Array<{ filer_id: string; avg_excess: number; prices_as_of: string }>;
    const by = Object.fromEntries(rows.map((r) => [r.filer_id, r]));
    expect(by['f-stale']).toBeUndefined();
    expect(by['f-fresh'].avg_excess).toBeCloseTo(0.0375, 6);
    expect(by['f-fresh'].prices_as_of).toBe('2026-08-03');
  });

  it('when freshThrough is relaxed, STALE is measured against the 2026-07-24 S&P (aligned legs)', () => {
    const q = buildMemberPerformanceLeaderboardQuery({
      window: 'all',
      minTrades: 1,
      limit: 10,
      priceFreshThrough: '2026-07-20',
    });
    const rows = db.prepare(q.sql).all(...q.params) as Array<{ filer_id: string; avg_excess: number; prices_as_of: string }>;
    const by = Object.fromEntries(rows.map((r) => [r.filer_id, r]));
    expect(by['f-stale'].avg_excess).toBeCloseTo(0.05, 6);
    expect(by['f-stale'].prices_as_of).toBe('2026-07-24');
  });

  it('a ticker with no price date is excluded once freshness is enforced', () => {
    const q = buildMemberPerformanceLeaderboardQuery({
      window: 'all',
      minTrades: 1,
      limit: 10,
      priceFreshThrough: freshThrough,
    });
    const rows = db.prepare(q.sql).all(...q.params) as Array<{ filer_id: string; avg_excess: number }>;
    expect(rows.find((r) => r.filer_id === 'f-nodate')).toBeUndefined();
  });

  it('the skill query and the per-member rows use the same alignment', () => {
    const sq = buildMemberSkillQuery(['f-stale'], { window: 'all', priceFreshThrough: '2026-07-20' });
    // Skill needs >= 5 scored buys; assert the aligned excess through the raw per-trade rows instead.
    expect(sq.sql).toContain('px.spx_now / p.spx_at_filing');
    const pq = buildMemberPerformanceQuery('f-stale', { window: 'all' });
    const rows = db.prepare(pq.sql).all(...pq.params) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].current_price_date).toBe('2026-07-24');
    expect(rows[0].spx_now).toBe(5040);

    const dual = aggregateMemberDualPerformance(
      rows.map((r) => ({
        isOption: false,
        txType: String(r.tx_type),
        priceAtTrade: Number(r.price_at_trade),
        spxAtTrade: Number(r.spx_at_trade),
        priceAtFiling: Number(r.price_at_filing),
        spxAtFiling: Number(r.spx_at_filing),
        currentPrice: Number(r.current_price),
        elapsedDaysSinceFiling: 80,
        currentPriceDate: String(r.current_price_date),
        spxNow: Number(r.spx_now),
      })),
      5100, // the misaligned latest close a caller might still pass
    );
    // Filing-date leg: 0.10 - (5040/4800 - 1) = 0.05, NOT 0.0375.
    expect(dual.filingDate.avgExcess).toBeCloseTo(0.05, 4);
  });
});
