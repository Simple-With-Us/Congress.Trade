/**
 * src/delivery/__tests__/assetsRoute.test.ts
 *
 * GET /assets against a real, fully-migrated in-memory SQLite DB (see
 * prices/__tests__/sqliteD1.ts) — the ticker-side analogue of
 * membersRoute.test.ts. No CONFIG_KV is provided, so `cached()` always falls
 * through to a live recompute (see shared/kvCache.ts — any KV error is
 * swallowed).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedD1, type D1Database, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import { buildRestRouter } from '../rest.ts';
import type { Env } from '../../shared/types.ts';

let db: SqliteDatabase;
let d1: D1Database;
let env: Env;

beforeEach(async () => {
  ({ db, d1 } = await openMigratedD1());
  env = { DB: d1 } as unknown as Env;
});

afterEach(() => {
  db.close();
});

function insertSecurityRef(row: { ticker: string; companyName?: string | null; assetClass?: string | null }) {
  db.prepare(`INSERT INTO securities_ref (ticker, company_name, asset_class) VALUES (?, ?, ?)`).run(
    row.ticker,
    row.companyName ?? null,
    row.assetClass ?? null,
  );
}

let txSeq = 0;
function insertTx(ticker: string, filerId: string, opts: { deprecated?: boolean } = {}) {
  txSeq += 1;
  db.prepare(
    `INSERT INTO transactions (id, doc_id, filer_id, ticker, tx_date, deprecated_at) VALUES (?, ?, ?, ?, '2026-01-01', ?)`,
  ).run(`tx-${txSeq}`, `doc-${txSeq}`, filerId, ticker, opts.deprecated ? '2026-02-01T00:00:00.000Z' : null);
}

async function getAssets() {
  const app = buildRestRouter();
  const res = await app.request('http://localhost/assets', {}, env);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    assets: Array<{ ticker: string; name: string | null; assetClass: string | null; txCount: number; memberCount: number }>;
    count: number;
  };
}

describe('GET /assets', () => {
  it('groups transactions by ticker and joins name / asset class from securities_ref', async () => {
    insertSecurityRef({ ticker: 'NVDA', companyName: 'NVIDIA Corporation', assetClass: 'Common Stock' });
    insertTx('NVDA', 'house-jane-smith');
    insertTx('NVDA', 'house-jane-smith');
    insertTx('NVDA', 'senate-john-doe');

    const body = await getAssets();
    const row = body.assets.find((a) => a.ticker === 'NVDA');
    expect(row).toBeDefined();
    expect(row?.name).toBe('NVIDIA Corporation');
    expect(row?.assetClass).toBe('Common Stock');
    expect(row?.txCount).toBe(3);
    expect(row?.memberCount).toBe(2);
  });

  it('still lists an un-enriched ticker with null name/assetClass rather than dropping it', async () => {
    insertTx('ZZZZ', 'house-jane-smith');

    const body = await getAssets();
    const row = body.assets.find((a) => a.ticker === 'ZZZZ');
    expect(row).toBeDefined();
    expect(row?.name).toBeNull();
    expect(row?.assetClass).toBeNull();
    expect(row?.txCount).toBe(1);
  });

  it('excludes rows with a null or empty ticker', async () => {
    insertTx('', 'house-jane-smith');
    txSeq += 1;
    db.prepare(`INSERT INTO transactions (id, doc_id, filer_id, ticker, tx_date) VALUES (?, ?, ?, NULL, '2026-01-01')`).run(
      `tx-${txSeq}`,
      `doc-${txSeq}`,
      'house-jane-smith',
    );

    const body = await getAssets();
    expect(body.assets.find((a) => !a.ticker)).toBeUndefined();
  });

  it('excludes deprecated (retracted) transactions from tx_count', async () => {
    insertTx('NVDA', 'house-jane-smith');
    insertTx('NVDA', 'house-jane-smith');
    insertTx('NVDA', 'house-jane-smith', { deprecated: true });

    const body = await getAssets();
    const row = body.assets.find((a) => a.ticker === 'NVDA');
    expect(row?.txCount).toBe(2);
  });

  it('does not list a ticker whose only transactions were retracted', async () => {
    insertTx('NVDA', 'house-jane-smith', { deprecated: true });

    const body = await getAssets();
    expect(body.assets.find((a) => a.ticker === 'NVDA')).toBeUndefined();
  });

  it('sorts by txCount desc', async () => {
    insertTx('AAPL', 'house-jane-smith');
    insertTx('NVDA', 'house-jane-smith');
    insertTx('NVDA', 'senate-john-doe');
    insertTx('NVDA', 'senate-jill-roe');

    const body = await getAssets();
    expect(body.assets[0].ticker).toBe('NVDA');
    expect(body.assets[0].txCount).toBe(3);
  });

  it('carries the stable-cache header', async () => {
    const app = buildRestRouter();
    const res = await app.request('http://localhost/assets', {}, env);
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=300');
  });

  it('returns count matching the assets array length', async () => {
    insertTx('AAPL', 'house-jane-smith');
    insertTx('NVDA', 'house-jane-smith');

    const body = await getAssets();
    expect(body.count).toBe(body.assets.length);
    expect(body.count).toBeGreaterThanOrEqual(2);
  });
});
