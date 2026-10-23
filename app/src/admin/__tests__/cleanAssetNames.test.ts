import { describe, expect, it } from 'vitest';

import { buildAdminRouter } from '../routes.ts';

/**
 * CT-2441: POST /clean-asset-names applies the shared OCR normalizer with a
 * doc filter and a dry run.  Confident fixes write with a cleaning_note audit
 * fragment; held rows are reported and left untouched.
 */

const app = buildAdminRouter();
const AUTH = { Authorization: 'Bearer admin-secret' };

interface TxRow {
  id: string;
  asset_name: string;
  ticker: string | null;
  cleaning_note: string | null;
}

const ROWS: TxRow[] = [
  { id: 'row-uber', asset_name: 'Uber Technolo1des Inc.', ticker: null, cleaning_note: null },
  { id: 'row-legal', asset_name: 'Legal200m Com Inc.', ticker: null, cleaning_note: null },
  { id: 'row-apple', asset_name: 'Apple Inc.', ticker: 'AAPL', cleaning_note: null },
];

function fakeDb(captured: { runs: unknown[][]; selects: string[] }) {
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          if (/^UPDATE transactions/i.test(sql.trim())) captured.runs.push([sql, ...args]);
          return this;
        },
        async all<T>() {
          captured.selects.push(sql);
          if (/FROM transactions/i.test(sql)) return { results: ROWS as T[] };
          return { results: [] as T[] };
        },
        async first<T>() {
          return null as T | null;
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;
  return db;
}

function env(db: D1Database) {
  return { ADMIN_TOKEN: 'admin-secret', DB: db } as never;
}

describe('POST /clean-asset-names — OCR cleanup', () => {
  it('dry run proposes fixes and holds without writing', async () => {
    const captured = { runs: [] as unknown[][], selects: [] as string[] };
    const res = await app.request(
      '/clean-asset-names?docId=E-sep17&dryRun=1',
      { method: 'POST', headers: AUTH },
      env(fakeDb(captured)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, cleaned: 0, held: 1, done: true });
    expect(body.proposedCount).toBe(1);
    const proposed = body.proposed as Array<{ before: string; after: string; note: string | null }>;
    expect(proposed[0].before).toBe('Uber Technolo1des Inc.');
    expect(proposed[0].after).toBe('Uber Technologies Inc.');
    expect(proposed[0].note).toContain('normalized OCR artifacts');
    const heldSample = body.heldSample as Array<{ before: string }>;
    expect(heldSample[0].before).toBe('Legal200m Com Inc.');
    expect(captured.runs).toHaveLength(0);
    expect(captured.selects.some((sql) => /WHERE doc_id = \?/i.test(sql))).toBe(true);
  });

  it('apply writes confident fixes with an audit note', async () => {
    const captured = { runs: [] as unknown[][], selects: [] as string[] };
    const res = await app.request(
      '/clean-asset-names?docId=E-sep17',
      { method: 'POST', headers: AUTH },
      env(fakeDb(captured)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, cleaned: 1, ocrCleaned: 1, held: 1 });
    expect(captured.runs).toHaveLength(1);
    const [sql, name, note, id] = captured.runs[0] as [string, string, string, string];
    expect(sql).toContain('UPDATE transactions SET asset_name = ?, cleaning_note = ?');
    expect(name).toBe('Uber Technologies Inc.');
    expect(note).toContain('normalized OCR artifacts');
    expect(id).toBe('row-uber');
  });

  it('sweeps the full table without a doc filter', async () => {
    const captured = { runs: [] as unknown[][], selects: [] as string[] };
    const res = await app.request(
      '/clean-asset-names?dryRun=1',
      { method: 'POST', headers: AUTH },
      env(fakeDb(captured)),
    );
    expect(res.status).toBe(200);
    expect(captured.selects.some((sql) => /WHERE doc_id/i.test(sql))).toBe(false);
  });
});
