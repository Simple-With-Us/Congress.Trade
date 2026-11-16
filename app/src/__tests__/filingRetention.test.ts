/**
 * src/__tests__/filingRetention.test.ts
 *
 * The 5-year filing retention sweep must (a) also remove the delivery
 * bookkeeping rows (deliveries / delivery_outbox) that reference the batch's
 * transactions so they are not orphaned, and (b) sweep filings whose
 * filed_date is NULL by falling back to the ingestion date instead of never
 * matching the age predicate.
 */
import { describe, it, expect } from 'vitest';
import { runFilingRetentionSweep } from '../jobs.ts';
import type { Env } from '../shared/types.ts';

function makeEnv(
  batchRows: Array<{ doc_id: string; raw_object_key: string | null }>,
  opts: { captureDeletes?: string[] } = {},
) {
  const ranSql: string[] = [];
  const selectSql: string[] = [];
  let selectCalls = 0;
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async first<T>() {
      return null as T | null;
    },
    async all<T>() {
      if (/SELECT doc_id, raw_object_key FROM/i.test(sql)) {
        selectSql.push(sql);
        selectCalls += 1;
        return { results: (selectCalls === 1 ? batchRows : []) as T[], meta: {} };
      }
      // CT-2459: the sweep resolves the batch's tx ids once, then deletes
      // delivery rows by tx_id inside one atomic batch.
      if (/SELECT id FROM transactions WHERE doc_id IN/i.test(sql)) {
        return { results: (selectCalls >= 1 ? [{ id: 'tx-1' }] : []) as T[], meta: {} };
      }
      return { results: [] as T[], meta: {} };
    },
    async run() {
      ranSql.push(sql);
      return { success: true, meta: { changes: 1 } };
    },
  });
  const env = {
    DB: { prepare } as unknown as D1Database,
    RAW_FILES: {
      delete: async (key: string) => {
        opts.captureDeletes?.push(key);
      },
    },
  } as unknown as Env;
  return { env, ranSql, selectSql };
}

describe('runFilingRetentionSweep', () => {
  it('sweeps NULL filed_date rows via the first_seen_at fallback', async () => {
    const { env, selectSql } = makeEnv([{ doc_id: 'H-1', raw_object_key: null }]);
    const deleted = await runFilingRetentionSweep(env, new Date('2026-07-28T00:00:00Z'));
    expect(deleted).toBe(1);
    // CT-2459: two indexed branches replace the COALESCE predicate; the
    // NULL-filed_date branch keeps the first_seen_at fallback.
    expect(selectSql[0]).toContain('filed_date IS NULL AND substr(first_seen_at, 1, 10) < ?');
    expect(selectSql[0]).toContain('filed_date IS NOT NULL AND filed_date < ?');
  });

  it('deletes deliveries and delivery_outbox rows for the batch before the transactions', async () => {
    const { env, ranSql } = makeEnv([{ doc_id: 'H-1', raw_object_key: null }]);
    await runFilingRetentionSweep(env, new Date('2026-07-28T00:00:00Z'));
    const deliveriesIdx = ranSql.findIndex((s) => /DELETE FROM deliveries/i.test(s));
    const outboxIdx = ranSql.findIndex((s) => /DELETE FROM delivery_outbox/i.test(s));
    const txIdx = ranSql.findIndex((s) => /DELETE FROM transactions/i.test(s));
    const filingsIdx = ranSql.findIndex((s) => /DELETE FROM filings/i.test(s));
    expect(deliveriesIdx).toBeGreaterThanOrEqual(0);
    expect(outboxIdx).toBeGreaterThanOrEqual(0);
    expect(txIdx).toBeGreaterThan(deliveriesIdx);
    expect(txIdx).toBeGreaterThan(outboxIdx);
    expect(filingsIdx).toBeGreaterThan(txIdx);
    // CT-2459: delivery deletes key off tx ids resolved once from the
    // batch's doc_ids (same rows, no per-delete subquery re-scan).
    expect(ranSql[deliveriesIdx]).toContain('DELETE FROM deliveries WHERE tx_id IN');
    expect(ranSql[outboxIdx]).toContain('DELETE FROM delivery_outbox WHERE tx_id IN');
  });

  it('is a no-op when nothing is expired', async () => {
    const { env, ranSql } = makeEnv([]);
    const deleted = await runFilingRetentionSweep(env, new Date('2026-07-28T00:00:00Z'));
    expect(deleted).toBe(0);
    expect(ranSql).toHaveLength(0);
  });
});

/**
 * 2026-08-11 — the archived document is the ONLY durable artifact in the
 * system. Extracted text, OCR output, rasterised pages and transaction rows
 * are all recomputed from it, and serving is stored-copy-only (the routes
 * 404 rather than redirecting to the Clerk). Destroying it is therefore
 * unrecoverable — the DB rows can be rebuilt from the document, the document
 * cannot be rebuilt from the rows. It must never be deleted implicitly.
 */
describe('runFilingRetentionSweep — archive safety', () => {
  const FLAG = 'RETENTION_DELETE_RAW_OBJECTS';

  it('does NOT delete the archived object unless the operator opts in', async () => {
    delete process.env[FLAG];
    const deletes: string[] = [];
    const { env } = makeEnv([{ doc_id: 'H-1', raw_object_key: 'raw/H-1' }], {
      captureDeletes: deletes,
    });
    const pruned = await runFilingRetentionSweep(env, new Date('2026-07-28T00:00:00Z'));
    // DB rows are still pruned, so table growth stays bounded...
    expect(pruned).toBe(1);
    // ...but the only durable copy of the document survives.
    expect(deletes).toEqual([]);
  });

  it('deletes the archived object when the operator explicitly opts in', async () => {
    process.env[FLAG] = '1';
    const deletes: string[] = [];
    const { env } = makeEnv([{ doc_id: 'H-1', raw_object_key: 'raw/H-1' }], {
      captureDeletes: deletes,
    });
    await runFilingRetentionSweep(env, new Date('2026-07-28T00:00:00Z'));
    expect(deletes).toEqual(['raw/H-1']);
    delete process.env[FLAG];
  });

  it('never prunes a filing we only just ingested, whatever its filed_date', async () => {
    // The predicate keys on filed_date, so a 2020 PTR discovered by a
    // historical backfill TODAY was immediately eligible: the backfill lanes
    // exist to ingest filings older than the cutoff, so backfill and sweep
    // fought each other — ingest, destroy, repeat.
    const { env, selectSql } = makeEnv([{ doc_id: 'H-1', raw_object_key: null }]);
    await runFilingRetentionSweep(env, new Date('2026-07-28T00:00:00Z'));
    expect(selectSql[0]).toContain('first_seen_at < ?');
  });
});
