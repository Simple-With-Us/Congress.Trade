/**
 * src/export/__tests__/priceNeeds.test.ts
 *
 * buildPriceNeedsExport lists congressional tickers that still lack price/SPX
 * history for performance-vs-S&P, with pagination and unavailable TTL exclusion.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { openMigratedD1 } from '../../prices/__tests__/sqliteD1.ts';
import { buildPriceNeedsExport, parsePriceNeedsQuery } from '../priceNeeds.ts';
import { buildExportRouter } from '../routes.ts';
import { resolveSecrets } from '../../secrets/infisical.ts';

vi.mock('../../secrets/infisical.ts', () => ({
  resolveSecret: vi.fn(async (env: { INGEST_TOKEN?: string }, key: string) => ({
    value: key === 'INGEST_TOKEN' ? env.INGEST_TOKEN ?? null : null,
  })),
  resolveSecrets: vi.fn(async (env: Record<string, string | undefined>, keys: string[]) => {
    const out: Record<string, string> = {};
    for (const k of keys) if (env[k]) out[k] = env[k] as string;
    return out;
  }),
}));

// vitest global — import for typecheck environments that need the symbol
import { vi } from 'vitest';

const NOW = new Date('2026-07-14T16:00:00Z'); // Tue afternoon ET → last trading day Mon 2026-07-13

function seedTrade(
  db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } },
  opts: {
    id: string;
    ticker: string;
    txDate: string;
    deprecated?: boolean;
  },
) {
  db.prepare(
    `INSERT INTO transactions (id, ticker, tx_date, source, created_at, deprecated_at)
     VALUES (?, ?, ?, 'test', '2026-01-01T00:00:00Z', ?)`,
  ).run(opts.id, opts.ticker, opts.txDate, opts.deprecated ? '2026-01-01T00:00:00Z' : null);
}

describe('parsePriceNeedsQuery', () => {
  it('defaults and clamps limit', () => {
    expect(parsePriceNeedsQuery({}).limit).toBe(500);
    expect(parsePriceNeedsQuery({ limit: '10' }).limit).toBe(10);
    expect(parsePriceNeedsQuery({ limit: '99999' }).limit).toBe(2000);
    expect(parsePriceNeedsQuery({ cursor: ' aapl ' }).cursor).toBe('AAPL');
  });
});

describe('buildPriceNeedsExport', () => {
  let close: (() => void) | undefined;

  afterEach(() => {
    close?.();
    close = undefined;
  });

  it('lists tickers missing anchors and deep history, skips healthy + deprecated', async () => {
    const opened = await openMigratedD1();
    close = opened.close;
    const { db, d1 } = opened;

    // NEED: trade with no price_eod / no tx_performance
    seedTrade(db, { id: 't1', ticker: 'NEED', txDate: '2020-01-15' });

    // HEALTHY: full anchors + history covering oldest trade + fresh latest
    seedTrade(db, { id: 't2', ticker: 'OK', txDate: '2024-06-01' });
    db.prepare(
      `INSERT INTO securities_ref (ticker, latest_price_date, current_price) VALUES ('OK', '2026-07-13', 100)`,
    ).run();
    db.prepare(`INSERT INTO price_eod (ticker, date, close) VALUES ('OK', '2024-05-31', 90)`).run();
    db.prepare(`INSERT INTO price_eod (ticker, date, close) VALUES ('OK', '2026-07-13', 100)`).run();
    db.prepare(`INSERT INTO spx_eod (date, close) VALUES ('2024-05-31', 5000)`).run();
    db.prepare(`INSERT INTO spx_eod (date, close) VALUES ('2026-07-13', 5500)`).run();
    db.prepare(
      `INSERT INTO tx_performance (tx_id, price_at_trade, spx_at_trade, price_at_filing, spx_at_filing, computed_at)
       VALUES ('t2', 90, 5000, 90, 5000, '2026-07-13T00:00:00Z')`,
    ).run();

    // DEPRECATED should not appear
    seedTrade(db, { id: 't3', ticker: 'DEADTX', txDate: '2019-01-01', deprecated: true });

    // SHALLOW: has recent prices but not covering oldest trade
    seedTrade(db, { id: 't4', ticker: 'SHALLOW', txDate: '2018-03-01' });
    db.prepare(
      `INSERT INTO securities_ref (ticker, latest_price_date, current_price) VALUES ('SHALLOW', '2026-07-13', 10)`,
    ).run();
    db.prepare(`INSERT INTO price_eod (ticker, date, close) VALUES ('SHALLOW', '2025-01-02', 10)`).run();
    db.prepare(
      `INSERT INTO tx_performance (tx_id, price_at_trade, spx_at_trade, price_at_filing, spx_at_filing, computed_at)
       VALUES ('t4', NULL, 5000, NULL, 5000, '2026-07-13T00:00:00Z')`,
    ).run();

    const env = { DB: d1 } as never;
    const out = await buildPriceNeedsExport(env, { limit: 50, cursor: null }, NOW);

    const tickers = out.tickers.map((t) => t.ticker).sort();
    expect(tickers).toContain('NEED');
    expect(tickers).toContain('SHALLOW');
    expect(tickers).not.toContain('OK');
    expect(tickers).not.toContain('DEADTX');

    const need = out.tickers.find((t) => t.ticker === 'NEED')!;
    expect(need.needsDeepHistory).toBe(true);
    expect(need.missingPriceAnchors).toBe(1);
    expect(need.reasons).toContain('no_price_history');

    const shallow = out.tickers.find((t) => t.ticker === 'SHALLOW')!;
    expect(shallow.needsDeepHistory).toBe(true);
    expect(shallow.reasons).toContain('history_after_oldest_trade');

    expect(out.summary.distinctTickers).toBe(3); // NEED, OK, SHALLOW
    expect(out.summary.tickersNeedingPrices).toBeGreaterThanOrEqual(2);
    expect(out.spx.oldestTradeDate).toBe('2018-03-01');
    expect(out.spx.needsHistoryBefore).toBe('2018-03-01'); // spx only from 2024
  });

  it('paginates by ticker cursor', async () => {
    const opened = await openMigratedD1();
    close = opened.close;
    const { db, d1 } = opened;
    for (const [id, ticker] of [
      ['1', 'AAA'],
      ['2', 'BBB'],
      ['3', 'CCC'],
    ] as const) {
      seedTrade(db, { id, ticker, txDate: '2021-01-01' });
    }
    const env = { DB: d1 } as never;
    const page1 = await buildPriceNeedsExport(env, { limit: 2, cursor: null }, NOW);
    expect(page1.tickers.map((t) => t.ticker)).toEqual(['AAA', 'BBB']);
    expect(page1.pagination.nextCursor).toBe('BBB');
    const page2 = await buildPriceNeedsExport(env, { limit: 2, cursor: 'BBB' }, NOW);
    expect(page2.tickers.map((t) => t.ticker)).toEqual(['CCC']);
    expect(page2.pagination.nextCursor).toBeNull();
  });

  it('excludes tickers in active price_unavailable TTL', async () => {
    const opened = await openMigratedD1();
    close = opened.close;
    const { db, d1 } = opened;
    seedTrade(db, { id: 'u1', ticker: 'UNAVAIL', txDate: '2020-01-01' });
    db.prepare(
      `INSERT INTO securities_ref (ticker, price_unavailable, price_checked_at)
       VALUES ('UNAVAIL', 1, ?)`,
    ).run(NOW.toISOString()); // stage-1, just checked → excluded

    seedTrade(db, { id: 'u2', ticker: 'VISIBLE', txDate: '2020-01-01' });

    const env = { DB: d1 } as never;
    const out = await buildPriceNeedsExport(env, { limit: 50, cursor: null }, NOW);
    expect(out.tickers.map((t) => t.ticker)).toEqual(['VISIBLE']);
  });

  it('ignores pre-1990 dates in the oldest-trade window and the missing-anchor counts', async () => {
    const opened = await openMigratedD1();
    close = opened.close;
    const { db, d1 } = opened;
    seedTrade(db, { id: 'old', ticker: 'GARBAGE', txDate: '1202-07-02' });
    seedTrade(db, { id: 'live', ticker: 'NEED', txDate: '2020-01-15' });
    const out = await buildPriceNeedsExport({ DB: d1 } as never, { limit: 50, cursor: null }, NOW);
    expect(out.tickers.map((t) => t.ticker)).toEqual(['NEED']);
    expect(out.tickers[0].oldestTradeDate).toBe('2020-01-15');
    expect(out.spx.oldestTradeDate).toBe('2020-01-15');
    expect(out.summary.distinctTickers).toBe(1);
    expect(out.summary.tradesMissingPriceAnchor).toBe(1);
    expect(out.summary.tradesMissingSpxAnchor).toBe(1);
  });
});

describe('GET /price-needs route', () => {
  const app = buildExportRouter();
  const TOKEN = 'ingest-secret';

  it('requires INGEST_TOKEN', async () => {
    const opened = await openMigratedD1();
    const env = { DB: opened.d1, INGEST_TOKEN: TOKEN, CONFIG_KV: { get: async () => null, put: async () => {} } };
    const denied = await app.request('/price-needs', { method: 'GET' }, env as never);
    expect(denied.status).toBe(401);
    const ok = await app.request(
      '/price-needs',
      { method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } },
      env as never,
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { tickers: unknown[]; summary: unknown };
    expect(Array.isArray(body.tickers)).toBe(true);
    expect(body.summary).toBeTruthy();
    opened.close();
  });

  it('advertises priceNeeds on capabilities', async () => {
    const env = {
      DB: { prepare: () => ({ bind: () => ({}), first: async () => null, all: async () => ({ results: [] }) }) },
      INGEST_TOKEN: TOKEN,
      CONFIG_KV: { get: async () => null, put: async () => {} },
    };
    const res = await app.request(
      '/capabilities',
      { method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } },
      env as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      endpoints: { exports: { priceNeeds: { path: string } } };
      recommendedSync: { priceNeedsForPerformance: string };
    };
    expect(body.endpoints.exports.priceNeeds.path).toContain('/api/export/price-needs');
    expect(body.recommendedSync.priceNeedsForPerformance).toMatch(/price-needs/);
    expect(resolveSecrets).toHaveBeenCalled();
  });
});
