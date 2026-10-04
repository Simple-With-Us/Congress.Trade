/**
 * src/prices/__tests__/backfillTermination.test.ts
 *
 * Behavioral tests (real migrated SQLite) for the fixes that let the
 * /api/admin/backfill-market loop terminate instead of running forever:
 *   - marketPending.prices excludes negative-cached (price_unavailable) tickers
 *     and uses NOT EXISTS, so it can reach 0 → done:true becomes reachable.
 *   - selectTickersNeedingPrices skips fresh tickers (latest_price_date >= last
 *     trading day) and negative-cached ones (within the re-check TTL), while still
 *     retrying ones whose negative-cache has aged past the TTL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// hasConfiguredKeyedEnrichmentProvider (used by marketPending) resolves secrets;
// with none configured it must report "no keyed provider" deterministically.
// Partial mock so every other export the route graph pulls in stays real.
vi.mock('../../secrets/infisical', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../secrets/infisical')>()),
  resolveSecrets: vi.fn(async () => ({})),
}));

import type { Env } from '../../shared/types.ts';
import { marketPending } from '../../admin/routes.ts';
import { PRICE_BACKFILL_TERMINATION_SCHEMA_STATEMENTS } from '../../admin/migrations.ts';
import {
  selectTickersNeedingPrices,
  lastTradingDay,
  priceUnavailableCutoffIso,
  priceUnavailableFirstRecheckCutoffIso,
} from '../service.ts';
import { openMigratedD1, type SqliteDatabase } from './sqliteD1.ts';

let db: SqliteDatabase;
let env: Env;
let close: () => void;

beforeEach(async () => {
  const opened = await openMigratedD1();
  db = opened.db;
  close = opened.close;
  env = { DB: opened.d1 } as unknown as Env;
});
afterEach(() => close());

/** Seed a traded (dated) ticker + its securities_ref row. */
function seedTicker(
  ticker: string,
  sr: {
    enrichedAt?: string | null;
    latestPriceDate?: string | null;
    /** 0=priced, 1=not-found stage 1 (7d recheck), 2=not-found stage 2 (30d
     *  recheck), 3=stalled listing (30d recheck) — see PRICE_UNAVAILABLE_* in
     *  prices/service.ts. */
    priceUnavailable?: 0 | 1 | 2 | 3;
    priceCheckedAt?: string | null;
  } = {},
): void {
  db.prepare(
    `INSERT INTO transactions (id, ticker, tx_date, source, created_at)
     VALUES (?, ?, '2026-01-05', 'primary', '2026-01-05T00:00:00Z')`,
  ).run(`tx-${ticker}`, ticker);
  db.prepare(
    `INSERT INTO securities_ref (ticker, enriched_at, latest_price_date, price_unavailable, price_checked_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    ticker,
    sr.enrichedAt ?? '2026-01-01T00:00:00Z',
    sr.latestPriceDate ?? null,
    sr.priceUnavailable ?? 0,
    sr.priceCheckedAt ?? null,
  );
}

function seedPriceRows(ticker: string, dates: string[]): void {
  for (const d of dates) {
    db.prepare('INSERT INTO price_eod (ticker, date, close) VALUES (?, ?, 100)').run(ticker, d);
  }
}

describe('marketPending — done:true is reachable', () => {
  it('excludes negative-cached tickers so prices reaches 0 when only priced + unavailable remain', async () => {
    // Fully priced + enriched → not pending on either axis.
    seedTicker('AAA', { latestPriceDate: '2026-07-13' });
    seedPriceRows('AAA', ['2026-07-10', '2026-07-13']);
    // Un-priceable: no price_eod row, marked unavailable within the TTL.
    seedTicker('DEAD', {
      priceUnavailable: 1,
      priceCheckedAt: new Date().toISOString(),
    });

    expect(await marketPending(env)).toEqual({ enrich: 0, prices: 0 });
  });

  it('still counts genuinely missing tickers and ones whose negative-cache aged out', async () => {
    seedTicker('MISS'); // no price_eod, not unavailable → pending
    seedTicker('AAA', { latestPriceDate: '2026-07-13' });
    seedPriceRows('AAA', ['2026-07-13']);
    seedTicker('DEAD', { priceUnavailable: 1, priceCheckedAt: new Date().toISOString() }); // excluded
    seedTicker('STALEUNAVAIL', { priceUnavailable: 1, priceCheckedAt: '2000-01-01T00:00:00Z' }); // TTL expired → pending again

    expect((await marketPending(env)).prices).toBe(2); // MISS + STALEUNAVAIL
  });

  it('uses NOT EXISTS so a ticker with many cached rows is never counted as missing', async () => {
    seedTicker('BIG', { latestPriceDate: '2026-07-13' });
    seedPriceRows('BIG', ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10']);
    expect((await marketPending(env)).prices).toBe(0);
    // Guard the query shape itself: the anti-join must be an index-seekable
    // NOT EXISTS, never the row-materializing `LEFT JOIN ... WHERE pe.ticker IS NULL`.
    expect(marketPending.toString()).toContain('NOT EXISTS');
    expect(marketPending.toString()).not.toContain('pe.ticker IS NULL');
  });

  it('excludes stage-2 (escalated) and stalled-listing tickers within their own 30-day TTL, not just stage-1', async () => {
    // Regression: price_unavailable now has THREE non-zero values (1/2/3 — see
    // selectTickersNeedingPrices' two-stage backoff). A query that only excluded
    // `= 1` would over-count these as still "pending", making `done:true`
    // unreachable again for exactly the escalated/stalled set this backoff targets.
    const now = new Date().toISOString();
    seedTicker('STAGE2', { priceUnavailable: 2, priceCheckedAt: now });
    seedTicker('STALLED', { priceUnavailable: 3, priceCheckedAt: now });

    expect((await marketPending(env)).prices).toBe(0);
  });

  it('a stage-2 ticker checked between the 7-day and 30-day cutoffs still counts as pending only once truly expired', async () => {
    // Checked 10 days ago: past the stage-1 (7d) cutoff but still within the
    // stage-2/stalled (30d) one. A query that (incorrectly) applied the 7-day
    // cutoff to a price_unavailable=2 row would call this "pending"; the fix
    // must still exclude it.
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    seedTicker('STAGE2_10D', { priceUnavailable: 2, priceCheckedAt: tenDaysAgo });

    expect((await marketPending(env)).prices).toBe(0);
  });
});

describe('selectTickersNeedingPrices — no perpetual re-selection', () => {
  const NOW = new Date('2026-07-14T12:00:00Z'); // Tuesday
  const FRESH_THROUGH = lastTradingDay(NOW); // Monday 2026-07-13
  const CUTOFF = priceUnavailableCutoffIso(NOW); // escalated (30-day) cutoff, 2026-06-14
  const FIRST_CUTOFF = priceUnavailableFirstRecheckCutoffIso(NOW); // stage-1 (7-day) cutoff, 2026-07-07T12:00Z

  it('drops fresh (latest_price_date == last trading day), keeps stale/never/expired-unavailable', async () => {
    seedTicker('FRESH', { latestPriceDate: FRESH_THROUGH }); // == Monday → not stale
    seedTicker('STALE', { latestPriceDate: '2026-07-01' }); // older → stale
    seedTicker('NEVER', { latestPriceDate: null }); // never priced
    seedTicker('DEADRECENT', {
      latestPriceDate: null,
      priceUnavailable: 1, // stage 1 → 7-day cutoff
      priceCheckedAt: '2026-07-10T00:00:00Z', // within the 7-day TTL → excluded
    });
    seedTicker('DEADOLD', {
      latestPriceDate: null,
      priceUnavailable: 1,
      priceCheckedAt: '2026-05-01T00:00:00Z', // before both cutoffs → retry
    });

    const picked = await selectTickersNeedingPrices(env, 50, {
      freshThrough: FRESH_THROUGH,
      unavailableCutoff: CUTOFF,
      firstUnavailableCutoff: FIRST_CUTOFF,
    });
    expect(new Set(picked)).toEqual(new Set(['STALE', 'NEVER', 'DEADOLD']));
  });

  it('an escalated (stage 2+) ticker uses the slower 30-day cutoff, not the 7-day one', async () => {
    seedTicker('STAGE2_RECENT', {
      latestPriceDate: null,
      priceUnavailable: 2, // stage 2 → 30-day cutoff, NOT the 7-day one
      // Past the 7-day mark but still within the 30-day one: proves stage 2
      // does not fall back to the shorter stage-1 cadence.
      priceCheckedAt: '2026-07-10T00:00:00Z',
    });
    seedTicker('STAGE2_OLD', {
      latestPriceDate: null,
      priceUnavailable: 2,
      priceCheckedAt: '2026-05-01T00:00:00Z', // before the 30-day cutoff → retry
    });
    seedTicker('STALLED_RECENT', {
      latestPriceDate: null,
      priceUnavailable: 3, // stalled listing → same 30-day cadence as stage 2
      priceCheckedAt: '2026-07-10T00:00:00Z',
    });

    const picked = await selectTickersNeedingPrices(env, 50, {
      freshThrough: FRESH_THROUGH,
      unavailableCutoff: CUTOFF,
      firstUnavailableCutoff: FIRST_CUTOFF,
    });
    expect(new Set(picked)).toEqual(new Set(['STAGE2_OLD']));
  });

  it('with the real clock, a ticker carrying the last trading day is not re-selected', async () => {
    seedTicker('CUR', { latestPriceDate: lastTradingDay() });
    expect(await selectTickersNeedingPrices(env, 50)).toEqual([]);
  });

  it('returns eligible tickers OLDEST-traded first (cursor_seq ASC), not newest-first', async () => {
    // cursor_seq is assigned in strict insertion order (see the transactions
    // trigger in 0001_init.sql), so seeding in this order gives FIRST the
    // lowest cursor_seq. Newest-first (the pre-fix order) would return these
    // reversed; oldest-first must return them in insertion order, so a steady
    // inflow of newly-traded tickers can never perpetually crowd out the tail
    // of an unpriced backlog.
    seedTicker('FIRST');
    seedTicker('SECOND');
    seedTicker('THIRD');

    expect(await selectTickersNeedingPrices(env, 50)).toEqual(['FIRST', 'SECOND', 'THIRD']);
  });

  it('does not select or count a ticker whose only trade is before 1990', async () => {
    db.prepare(
      `INSERT INTO transactions (id, ticker, tx_date, source, created_at)
       VALUES ('tx-ancient', 'ANCIENT', '1202-07-02', 'primary', '2026-01-05T00:00:00Z')`,
    ).run();
    expect(await selectTickersNeedingPrices(env, 50)).toEqual([]);
    expect((await marketPending(env)).prices).toBe(0);
  });
});

describe('0043 migration backfill', () => {
  it('seeds latest_price_date AND current_price from cached closes for anchor-less rows', () => {
    // A row that was imported closes-only under the OLD handler: cached closes but
    // null latest_price_date / current_price.
    db.prepare(
      "INSERT INTO price_eod (ticker, date, close) VALUES ('OLDIMP','2026-07-14',10),('OLDIMP','2026-07-15',12)",
    ).run();
    db.prepare("INSERT INTO securities_ref (ticker) VALUES ('OLDIMP')").run();

    // Re-run the migration's idempotent data backfill against the seeded rows (the
    // ALTER/CREATE parts already ran on the empty DB at open).
    for (const sql of PRICE_BACKFILL_TERMINATION_SCHEMA_STATEMENTS) {
      if (sql.trim().startsWith('UPDATE')) db.exec(sql);
    }

    const row = db
      .prepare(
        'SELECT latest_price_date, current_price, current_price_date FROM securities_ref WHERE ticker = ?',
      )
      .get('OLDIMP');
    expect(row?.latest_price_date).toBe('2026-07-15');
    // Without the current_price backfill the now-"fresh" selector would skip this
    // ticker forever, leaving current-return analytics blank.
    expect(row?.current_price).toBe(12);
    expect(row?.current_price_date).toBe('2026-07-15');
  });
});

describe('lastTradingDay — Eastern-time / weekend handling', () => {
  it('never returns a Saturday or Sunday and stays behind the ET "today"', () => {
    // Noon UTC = morning ET, so the ET calendar day matches the UTC date here.
    expect(lastTradingDay(new Date('2026-07-13T12:00:00Z'))).toBe('2026-07-10'); // Mon ET → Fri
    expect(lastTradingDay(new Date('2026-07-12T12:00:00Z'))).toBe('2026-07-10'); // Sun ET → Fri
    expect(lastTradingDay(new Date('2026-07-14T12:00:00Z'))).toBe('2026-07-13'); // Tue ET → Mon
  });

  it('is anchored on Eastern time, not UTC, at the 00:00 UTC cron tick', () => {
    // 2026-07-14T00:00Z is still Monday EVENING in ET (2026-07-13 ~20:00), before
    // Monday's EOD close is published. A UTC-yesterday bar would demand Monday
    // (07-13); the ET bar correctly stays at Friday (07-10) so the newest tickers
    // aren't perpetually re-selected against an unpublished session.
    expect(lastTradingDay(new Date('2026-07-14T00:00:00Z'))).toBe('2026-07-10');
    // Wednesday's 00:00 UTC tick is Tuesday evening ET → last completed session Monday.
    expect(lastTradingDay(new Date('2026-07-15T00:00:00Z'))).toBe('2026-07-13');
  });
});
