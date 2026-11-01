import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedD1, type D1Database, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import { benchmarkDocumentIsHumanResolved } from '../routes.ts';
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
    const unmappable = insertTx('H-a', 'primary', 1000, 20000);
    const rowKeyBefore = (db.prepare('SELECT row_key FROM transactions WHERE id = ?').get(off) as { row_key: string }).row_key;

    const result = await canonicalizePublishedAmountBounds(env, { dryRun: false });

    expect(result.changed).toBe(2);
    expect(amounts(off)).toEqual({ amount_min: 1001, amount_max: 15000, est_value: 8000.5 });
    expect(amounts(exact)).toEqual({ amount_min: 1001, amount_max: 15000, est_value: 8000.5 });
    expect(amounts(subThousand)).toEqual({ amount_min: 0, amount_max: 1000, est_value: 500 });
    expect(amounts(competitor)).toEqual({ amount_min: 1000, amount_max: 15000, est_value: 8000 });
    expect(amounts(off2)).toEqual({ amount_min: 15001, amount_max: 50000, est_value: 32500.5 });
    expect(amounts(unmappable)).toEqual({ amount_min: 1000, amount_max: 20000, est_value: 10500 });
    // row_key is the durable identity (outbox, re-ingest dedupe) and must not move.
    expect((db.prepare('SELECT row_key FROM transactions WHERE id = ?').get(off) as { row_key: string }).row_key)
      .toBe(rowKeyBefore);

    const decisions = db.prepare(
      "SELECT action, source, reason, transaction_ids FROM ingestion_decisions WHERE doc_id = 'H-a'",
    ).all() as Array<{ action: string; source: string; reason: string; transaction_ids: string }>;
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      action: 'auto_published',
      source: 'admin',
      reason: 'amount_bounds_canonicalize',
    });
    expect(JSON.parse(decisions[0].transaction_ids)).toEqual(expect.arrayContaining([off, off2]));
  });

  it('does not promote machine-resolved filings to benchmark ground truth', async () => {
    db.prepare(
      `INSERT INTO filings (doc_id, chamber, filer_id, filing_type, filed_date, ingest_status, first_seen_at, raw_object_key)
       VALUES ('H-gt-auto', 'house', 'F1', 'P', '2026-01-10', 'persisted', '2026-01-10T00:00:00.000Z', 'raw/H-gt-auto')`,
    ).run();
    db.prepare(
      `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved)
       VALUES ('H-gt-auto', 'agreement', '{}', '2026-01-10T00:00:00.000Z', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO ingestion_decisions
         (id, doc_id, action, source, actor, reason, payload, transaction_ids, created_at)
       VALUES ('dec-auto', 'H-gt-auto', 'auto_published', 'pipeline', NULL, 'agreement', NULL, '[]', '2026-01-11T00:00:00.000Z')`,
    ).run();
    insertTx('H-gt-auto', 'primary', 1000, 15000);

    await canonicalizePublishedAmountBounds(env, { dryRun: false, actor: 'admin@test' });

    expect(await benchmarkDocumentIsHumanResolved(env, 'H-gt-auto')).toBe(false);
  });

  it('preserves human-confirmed benchmark ground truth after repair audit', async () => {
    db.prepare(
      `INSERT INTO filings (doc_id, chamber, filer_id, filing_type, filed_date, ingest_status, first_seen_at, raw_object_key)
       VALUES ('H-gt-human', 'house', 'F1', 'P', '2026-01-10', 'persisted', '2026-01-10T00:00:00.000Z', 'raw/H-gt-human')`,
    ).run();
    db.prepare(
      `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved)
       VALUES ('H-gt-human', 'low_confidence', '{}', '2026-01-10T00:00:00.000Z', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO ingestion_decisions
         (id, doc_id, action, source, actor, reason, payload, transaction_ids, created_at)
       VALUES ('dec-human', 'H-gt-human', 'confirmed', 'admin', 'reviewer', NULL, NULL, '[]', '2026-01-11T00:00:00.000Z')`,
    ).run();
    insertTx('H-gt-human', 'primary', 1000, 15000);

    await canonicalizePublishedAmountBounds(env, { dryRun: false, actor: 'admin@test' });

    expect(await benchmarkDocumentIsHumanResolved(env, 'H-gt-human')).toBe(true);
  });

  it('is idempotent on a second apply pass', async () => {
    insertTx('H-b', 'manual', 1000, 15000);
    await canonicalizePublishedAmountBounds(env, { dryRun: false });
    const again = await canonicalizePublishedAmountBounds(env, { dryRun: false });
    expect(again.matched).toBe(0);
    expect(again.changed).toBe(0);
    expect(again.totalCandidates).toBe(0);
    expect(again.hasMore).toBe(false);
  });

  it('reports totalCandidates and hasMore when limit is below the backlog', async () => {
    for (let i = 0; i < 5; i += 1) {
      insertTx(`H-page-${i}`, 'primary', 1000, 15000);
    }

    const page = await canonicalizePublishedAmountBounds(env, { dryRun: true, limit: 2 });

    expect(page.matched).toBe(2);
    expect(page.totalCandidates).toBe(5);
    expect(page.hasMore).toBe(true);
    expect(page.changed).toBe(2);
  });

  it('writes ingestion_decisions in the same batch pass as row updates per filing', async () => {
    const offA = insertTx('H-batch-a', 'primary', 1000, 15000);
    const offB = insertTx('H-batch-b', 'primary', 1000, 15000);

    const result = await canonicalizePublishedAmountBounds(env, { dryRun: false, actor: 'admin@test' });

    expect(result.changed).toBe(2);
    expect(amounts(offA).amount_min).toBe(1001);
    expect(amounts(offB).amount_min).toBe(1001);

    const decisions = db.prepare(
      'SELECT doc_id, transaction_ids FROM ingestion_decisions WHERE reason = ?',
    ).all('amount_bounds_canonicalize') as Array<{ doc_id: string; transaction_ids: string }>;
    expect(decisions).toHaveLength(2);
    expect(decisions.map((d) => d.doc_id).sort()).toEqual(['H-batch-a', 'H-batch-b']);
    for (const d of decisions) {
      expect(JSON.parse(d.transaction_ids)).toHaveLength(1);
    }
  });
});
