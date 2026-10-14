import { describe, expect, it, vi } from 'vitest';

vi.mock('./d1Budget', () => ({ recordD1Meta: vi.fn() }));

import { batchPrepared, first, run } from './db.ts';
import { recordD1Meta } from './d1Budget.ts';

describe('batchPrepared', () => {
  it('retries when SQLite reports database is locked', async () => {
    const busy = new Error('SQLITE_BUSY: database is locked');
    const db = {
      batch: vi.fn()
        .mockRejectedValueOnce(busy)
        .mockResolvedValueOnce([{ meta: { rows_written: 1 } }]),
    } as unknown as D1Database;

    await expect(batchPrepared(db, [])).resolves.toHaveLength(1);
    expect(db.batch).toHaveBeenCalledTimes(2);
  });

  it('records D1 row metadata for every prepared-statement result', async () => {
    const statements = [{ run: vi.fn() }, { run: vi.fn() }] as unknown as D1PreparedStatement[];
    const db = {
      batch: vi.fn(async () => [
        { meta: { rows_read: 3, rows_written: 2 } },
        { meta: { rows_read: 5, rows_written: 7 } },
      ]),
    } as unknown as D1Database;

    await batchPrepared(db, statements);

    expect(recordD1Meta).toHaveBeenNthCalledWith(1, { rows_read: 3, rows_written: 2 });
    expect(recordD1Meta).toHaveBeenNthCalledWith(2, { rows_read: 5, rows_written: 7 });
  });
});

describe('run', () => {
  it('retries when SQLite reports database is locked', async () => {
    const busy = new Error('SQLITE_BUSY: database is locked');
    const runFn = vi.fn()
      .mockRejectedValueOnce(busy)
      .mockResolvedValueOnce({ meta: { rows_written: 1 } });
    const db = {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run: runFn })) })),
    } as unknown as D1Database;

    await expect(run(db, 'INSERT INTO t VALUES (?)', [1])).resolves.toMatchObject({
      meta: { rows_written: 1 },
    });
    expect(runFn).toHaveBeenCalledTimes(2);
  });
});

describe('first', () => {
  it('returns the first aggregate row and records D1 row metadata', async () => {
    const db = {
      prepare: vi.fn(() => ({
        all: vi.fn(async () => ({
          results: [{ total: 42 }],
          meta: { rows_read: 42, rows_written: 0 },
        })),
      })),
    } as unknown as D1Database;

    await expect(first<{ total: number }>(db, 'SELECT COUNT(*) AS total FROM transactions')).resolves.toEqual({ total: 42 });
    expect(recordD1Meta).toHaveBeenCalledWith({ rows_read: 42, rows_written: 0 });
  });
});
