/**
 * Board row 3d31c7b9: one-off cleanup of stored executive rows whose asset name
 * carries the 278-T "#" column.  Real migrated in-memory schema.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedD1, type D1Database, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import { cleanOgeRowIndexes } from '../ogeRowIndexCleanup.ts';
import { clearResolverCache } from '../../extraction/normalizer.ts';
import type { Env } from '../../shared/types.ts';

let db: SqliteDatabase;
let d1: D1Database;
let env: Env;

beforeEach(async () => {
  clearResolverCache();
  ({ db, d1 } = await openMigratedD1());
  env = { DB: d1 } as unknown as Env;
  db.prepare("INSERT INTO securities_ref (ticker, company_name, market_cap) VALUES ('MSFT', 'Microsoft Corporation', 1000000)").run();
  db.prepare("INSERT INTO securities_ref (ticker, company_name, market_cap) VALUES ('NVDA', 'NVIDIA Corporation', 1000000)").run();
});

afterEach(() => db.close());

function filing(docId: string, chamber: string) {
  db.prepare("INSERT INTO filings (doc_id, chamber, filer_id, filing_type, ingest_status) VALUES (?, ?, 'EXEC-DJT', 'P', 'persisted')").run(docId, chamber);
}

let seq = 0;
function tx(docId: string, assetName: string, ticker: string | null = null, rowIndex = seq) {
  seq += 1;
  const id = `t${seq}`;
  db.prepare(
    `INSERT INTO transactions (id, doc_id, filer_id, tx_date, asset_name, ticker, tx_type, source, row_key, raw_text)
     VALUES (?, ?, 'EXEC-DJT', '2026-08-10', ?, ?, 'S', 'primary', ?, ?)`,
  ).run(id, docId, assetName, ticker, `v1:primary:${rowIndex}:old${seq}`, `raw ${assetName}`);
  return id;
}

const row = (id: string) =>
  db.prepare('SELECT asset_name, ticker, row_key, raw_text FROM transactions WHERE id = ?').get(id) as {
    asset_name: string; ticker: string | null; row_key: string; raw_text: string;
  };

describe('cleanOgeRowIndexes', () => {
  function seedTrump() {
    filing('E-2026-trump', 'executive');
    return {
      msft: tx('E-2026-trump', '3641 Microsoft Corp. Com'),
      nvda: tx('E-2026-trump', '3608 Nvidia Corp.'),
      mos: tx('E-2026-trump', '1123 the Mosaic Co.'),
      keep: tx('E-2026-trump', 'Apple Inc.', 'AAPL'),
    };
  }

  it('is a dry run by default and writes nothing', async () => {
    const ids = seedTrump();
    const result = await cleanOgeRowIndexes(env);
    expect(result.dryRun).toBe(true);
    expect(result.docsStripped).toBe(1);
    expect(result.rowsChanged).toBe(3);
    expect(result.tickersResolved).toBe(2);
    expect(result.sample[0]).toMatchObject({ before: '3641 Microsoft Corp. Com', after: 'Microsoft Corp. Com', ticker: 'MSFT' });
    expect(row(ids.msft).asset_name).toBe('3641 Microsoft Corp. Com');
  });

  it('applies: strips the number, resolves the ticker, recomputes row_key, preserves raw_text, leaves other rows alone', async () => {
    const ids = seedTrump();
    const result = await cleanOgeRowIndexes(env, { dryRun: false });

    expect(result.rowsChanged).toBe(3);
    expect(row(ids.msft)).toMatchObject({ asset_name: 'Microsoft Corp. Com', ticker: 'MSFT', raw_text: 'raw 3641 Microsoft Corp. Com' });
    expect(row(ids.nvda)).toMatchObject({ asset_name: 'Nvidia Corp.', ticker: 'NVDA' });
    expect(row(ids.mos)).toMatchObject({ asset_name: 'the Mosaic Co.', ticker: null });
    expect(row(ids.msft).row_key).toMatch(/^v1:primary:\d+:/);
    expect(row(ids.msft).row_key).not.toMatch(/old/);
    expect(row(ids.keep)).toMatchObject({ asset_name: 'Apple Inc.', ticker: 'AAPL' });
  });

  it('is idempotent', async () => {
    seedTrump();
    await cleanOgeRowIndexes(env, { dryRun: false });
    const again = await cleanOgeRowIndexes(env, { dryRun: false });
    expect(again.docsScanned).toBe(0);
    expect(again.rowsChanged).toBe(0);
  });

  it('never touches a house filing or a filing that does not show the "#" column', async () => {
    filing('H-2026-1', 'house');
    const h = tx('H-2026-1', '3641 Microsoft Corp. Com');
    filing('E-2026-few', 'executive');
    const a = tx('E-2026-few', '360 DigiTech Inc.');
    tx('E-2026-few', 'Apple Inc.');
    tx('E-2026-few', 'Nvidia Corp.');

    const result = await cleanOgeRowIndexes(env, { dryRun: false });

    expect(result.rowsChanged).toBe(0);
    expect(row(h).asset_name).toBe('3641 Microsoft Corp. Com');
    expect(row(a).asset_name).toBe('360 DigiTech Inc.');
  });

  it('skips (and counts) a cleaned row whose row_key collides with an existing row instead of failing the run', async () => {
    filing('E-2026-dup', 'executive');
    const a = tx('E-2026-dup', '10 Microsoft Corp. Com', null, 0);
    tx('E-2026-dup', '11 Nvidia Corp.', null, 1);
    tx('E-2026-dup', '12 Apple Inc.', null, 2);
    // A row that already owns the exact key row `a` would get once cleaned (same doc, source, index, fields).
    const { transactionRowKey } = await import('../../extraction/normalizer.ts');
    const target = transactionRowKey('primary', 0, {
      txDate: '2026-08-10', owner: null, assetName: 'Microsoft Corp. Com', ticker: 'MSFT',
      assetType: null, assetTypeName: null, txType: 'S', amountMin: null, amountMax: null,
      isOption: false, capGainsOver200: false, rawText: 'raw 10 Microsoft Corp. Com',
      filingStatus: null, subholding: null, location: null, description: null, supplementalText: null,
    });
    db.prepare(
      `INSERT INTO transactions (id, doc_id, filer_id, tx_date, asset_name, ticker, tx_type, source, row_key, raw_text)
       VALUES ('twin', 'E-2026-dup', 'EXEC-DJT', '2026-08-10', 'Microsoft Corp. Com', 'MSFT', 'S', 'primary', ?, 'raw 10 Microsoft Corp. Com')`,
    ).run(target);

    const applied = await cleanOgeRowIndexes(env, { dryRun: false });

    expect(applied.collisionsSkipped).toBe(1);
    expect(applied.rowsChanged).toBe(2);
    expect(row(a).asset_name).toBe('10 Microsoft Corp. Com');
  });
});
