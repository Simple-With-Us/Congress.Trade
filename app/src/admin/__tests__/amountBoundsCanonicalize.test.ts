import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedD1, type D1Database, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import { canonicalizePublishedAmountBounds } from '../amountBoundsCanonicalize.ts';
import type { Env } from '../../shared/types.ts';

let db: SqliteDatabase;
let d1: D1Database;
let env: Env;

beforeEach(async () => {
  ({ db, d1 } = await openMigratedD1());
  env = { DB: d1 } as unknown as Env;
});

afterEach(() => db.close());

let seq = 0;
function insertTx(
  docId: string,
  source: string,
  amountMin: number | null,
  amountMax: number | null,
  id?: string,
) {
  seq += 1;
  const txId = id ?? `tx${seq}`;
  db.prepare(
    `INSERT INTO transactions (id, doc_id, filer_id, tx_date, asset_name, ticker, tx_type, source,
      amount_min, amount_max, est_value, row_key, raw_text)
     VALUES (?, ?, 'F1', '2026-01-15', 'Example Corp', 'EXMP', 'P', ?, ?, ?, ?, ?, 'raw')`,
  ).run(
    txId,
    docId,
    source,
    amountMin,
    amountMax,
    amountMin != null && amountMax != null ? (amountMin + amountMax) / 2 : amountMin,
    `v1:${source}:0:rk${seq}`,
  );
  return txId;
}

const amounts = (id: string) =>
  db.prepare('SELECT amount_min, amount_max, est_value FROM transactions WHERE id = ?').get(id) as {
    amount_min: number | null;
    amount_max: number | null;
    est_value: number | null;
  };

describe('canonicalizePublishedAmountBounds', () => {
  it('dry run counts off-by-one rows by bracket and writes nothing', async () => {
    insertTx('H-1', 'primary', 1000, 15000);
    insertTx('H-1', 'primary', 15000, 50000);
    insertTx('H-2', 'local_mac', 1000000, 5000000);

    const result = await canonicalizePublishedAmountBounds(env, { dryRun: true, limit: 500 });

    expect(result.dryRun).toBe(true);
    expect(result.changed).toBe(3);
    expect(result.byBracket).toEqual({
      '1001-15000': 1,
      '15001-50000': 1,
      '1000001-5000000': 1,
    });
    expect(result.sample).toHaveLength(3);
    expect(amounts('tx1')).toEqual({ amount_min: 1000, amount_max: 15000, est_value: 8000 });
  });

  it('applies only off-by-one repairs and leaves exact, $0–$1,000, competitor, and unmappable rows alone', async () => {
    const off = insertTx('H-a', 'primary', 1000, 15000);
    const exact = insertTx('H-a', 'primary', 1001, 15000);
    const subThousand = insertTx('H-a', 'primary', 0, 1000);
    const competitor = insertTx('H-a', 'competitor_backfill', 1000, 15000);
    const off2 = insertTx('H-a', 'server_cpu', 15000, 50000);

    const result = await canonicalizePublishedAmountBounds(env, { dryRun: false });

    expect(result.changed).toBe(2);
    expect(amounts(off)).toEqual({ amount_min: 1001, amount_max: 15000, est_value: 8000.5 });
    expect(amounts(exact)).toEqual({ amount_min: 1001, amount_max: 15000, est_value: 8000.5 });
    expect(amounts(subThousand)).toEqual({ amount_min: 0, amount_max: 1000, est_value: 500 });
    expect(amounts(competitor)).toEqual({ amount_min: 1000, amount_max: 15000, est_value: 8000 });
    expect(amounts(off2)).toEqual({ amount_min: 15001, amount_max: 50000, est_value: 32500.5 });

    const decisions = db.prepare(
      "SELECT action, source, reason, transaction_ids FROM ingestion_decisions WHERE doc_id = 'H-a'",
    ).all() as Array<{ action: string; source: string; reason: string; transaction_ids: string }>;
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ action: 'manual', source: 'admin', reason: 'amount_bounds_canonicalize' });
    expect(JSON.parse(decisions[0].transaction_ids)).toEqual(expect.arrayContaining([off, off2]));
  });

  it('is idempotent on a second apply pass', async () => {
    insertTx('H-b', 'manual', 1000, 15000);
    await canonicalizePublishedAmountBounds(env, { dryRun: false });
    const again = await canonicalizePublishedAmountBounds(env, { dryRun: false });
    expect(again.matched).toBe(0);
    expect(again.changed).toBe(0);
  });
});
