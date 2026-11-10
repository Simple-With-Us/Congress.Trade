/**
 * src/export/__tests__/snapshot.test.ts
 *
 * Unit tests for the bulk snapshot writer with in-memory D1 + R2 fakes. Assert:
 * five NDJSON objects + a manifest are written, the manifest lands LAST (so a
 * partial run is invisible), row counts + NDJSON line counts match the seed, the
 * paged read walks the table in 10k chunks, files live under a run-scoped prefix,
 * and a multi-part table uploads EQUAL-sized non-final parts (R2's requirement).
 */

import { describe, it, expect } from 'vitest';
import type { Env } from '../../shared/types.ts';
import {
  runBulkSnapshot,
  readManifest,
  manifestObjectKey,
  snapshotObjectKey,
  SNAPSHOT_TABLES,
  SNAPSHOT_SCHEMA,
  selectPruneTargets,
  pruneBulkSnapshots,
  parseRunObjectKey,
  parseBulkObjectDate,
  shiftUtcDate,
} from '../snapshot.ts';

const RUN = 'run-fixed-1';
const NOW = new Date('2026-06-25T04:01:00.000Z');

const decode = (v: unknown): string =>
  typeof v === 'string' ? v : new TextDecoder().decode(v as Uint8Array);
const byteLen = (v: unknown): number =>
  typeof v === 'string' ? new TextEncoder().encode(v).length : (v as ArrayBuffer).byteLength;

/** In-memory D1: pages `SELECT * FROM <table> ... LIMIT n OFFSET m` from seeded arrays. */
function fakeDb(data: Record<string, Array<Record<string, unknown>>>) {
  const pageSql: string[] = [];
  const read = new Map<string, number>();
  function makeStmt(sql: string) {
    const stmt = {
      bind: () => stmt,
      async all<T>() {
        pageSql.push(sql);
        const m = /FROM (\w+)/.exec(sql);
        const lm = /LIMIT (\d+)/.exec(sql);
        if (!m || !lm) return { results: [] as T[] };
        const table = m[1];
        const start = read.get(table) ?? 0;
        const rows = (data[table] ?? []).slice(start, start + Number(lm[1]));
        read.set(table, start + rows.length);
        return { results: rows as unknown as T[] };
      },
    };
    return stmt;
  }
  return { db: { prepare: (sql: string) => makeStmt(sql) }, pageSql };
}

/** In-memory R2: records write order, multipart part sizes, and stored bodies. */
function fakeR2() {
  const store = new Map<string, string>();
  const writeOrder: string[] = [];
  const partSizes = new Map<string, number[]>();
  const r2 = {
    store,
    writeOrder,
    partSizes,
    async put(key: string, value: unknown) {
      store.set(key, decode(value));
      writeOrder.push(key);
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const v = store.get(key) as string;
      return { body: v, async text() { return v; }, async json() { return JSON.parse(v); } };
    },
    async createMultipartUpload(key: string) {
      const chunks: string[] = [];
      const sizes: number[] = [];
      return {
        async uploadPart(partNumber: number, value: unknown) {
          chunks[partNumber - 1] = decode(value);
          sizes[partNumber - 1] = byteLen(value);
          return { partNumber, etag: `etag-${partNumber}` };
        },
        async complete() {
          store.set(key, chunks.join(''));
          writeOrder.push(key);
          partSizes.set(key, sizes);
        },
        async abort() { /* no-op */ },
      };
    },
  };
  return r2;
}

function envWith(db: unknown, r2: unknown): Env {
  return { DB: db, RAW_FILES: r2 } as unknown as Env;
}

describe('runBulkSnapshot', () => {
  it('writes five run-scoped NDJSON tables + a manifest, with the manifest LAST', async () => {
    const { db } = fakeDb({
      price_eod: [
        { ticker: 'AAPL', date: '2026-06-24', close: 200, volume: 1000 },
        { ticker: 'MSFT', date: '2026-06-24', close: 400, volume: 2000 },
      ],
      spx_eod: [{ date: '2026-06-24', close: 5000 }],
      securities_ref: [{ ticker: 'AAPL', company_name: 'Apple', shares_outstanding: 15e9 }],
      fundamentals_eod: [{ ticker: 'AAPL', date: '2026-06-24', pe_ratio: 30 }],
      analyst_consensus: [{ ticker: 'AAPL', date: '2026-06-24', rating: 'Buy' }],
    });
    const r2 = fakeR2();
    const manifest = await runBulkSnapshot(envWith(db, r2), '2026-06-25', NOW, RUN);

    expect(r2.store.size).toBe(SNAPSHOT_TABLES.length + 1);
    for (const t of SNAPSHOT_TABLES) {
      const key = snapshotObjectKey('2026-06-25', RUN, t.name);
      expect(key).toContain(`bulk/2026-06-25/runs/${RUN}/`);
      expect(r2.store.has(key)).toBe(true);
      expect(manifest.tables[t.name].objectKey).toBe(key); // manifest points at this run's files
    }
    // Manifest is the FINAL write so a partial run leaves no manifest.
    expect(r2.writeOrder[r2.writeOrder.length - 1]).toBe(manifestObjectKey('2026-06-25'));
    expect(manifest.runId).toBe(RUN);
    expect(manifest.generatedAt).toBe(NOW.toISOString());
    expect(manifest.tables.price_eod.rowCount).toBe(2);
    // shares_outstanding is now advertised in the securities_ref schema.
    expect(SNAPSHOT_SCHEMA.securities_ref).toContain('shares_outstanding');
    expect(manifest.schema.securities_ref).toContain('shares_outstanding');
  });

  it('emits one JSON object per row (valid NDJSON, line count == rowCount)', async () => {
    const { db } = fakeDb({
      price_eod: [
        { ticker: 'AAPL', date: '2026-06-24', close: 200, volume: null },
        { ticker: 'MSFT', date: '2026-06-24', close: 400, volume: 2000 },
      ],
      spx_eod: [], securities_ref: [], fundamentals_eod: [], analyst_consensus: [],
    });
    const r2 = fakeR2();
    await runBulkSnapshot(envWith(db, r2), '2026-06-25', NOW, RUN);

    const ndjson = r2.store.get(snapshotObjectKey('2026-06-25', RUN, 'price_eod')) as string;
    const lines = ndjson.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ ticker: 'AAPL', date: '2026-06-24', close: 200, volume: null });
    // An empty table is a single empty PUT, not a multipart upload.
    expect(r2.store.get(snapshotObjectKey('2026-06-25', RUN, 'spx_eod'))).toBe('');
  });

  it('pages a multi-page table via KEYSET (no OFFSET; cursor on later pages)', async () => {
    const rows = Array.from({ length: 25_001 }, (_, i) => ({
      ticker: 'T' + String(i).padStart(6, '0'),
      date: '2026-06-24',
      close: i,
      volume: i,
    }));
    const { db, pageSql } = fakeDb({
      price_eod: rows, spx_eod: [], securities_ref: [], fundamentals_eod: [], analyst_consensus: [],
    });
    const r2 = fakeR2();
    const manifest = await runBulkSnapshot(envWith(db, r2), '2026-06-25', NOW, RUN);

    expect(manifest.tables.price_eod.rowCount).toBe(25_001);
    const lines = (r2.store.get(snapshotObjectKey('2026-06-25', RUN, 'price_eod')) as string).split('\n').filter(Boolean);
    expect(lines).toHaveLength(25_001);
    const pricePages = pageSql.filter((s) => s.includes('FROM price_eod'));
    expect(pricePages).toHaveLength(3); // 10k + 10k + 5001
    expect(pricePages.every((s) => !s.includes('OFFSET'))).toBe(true);
    expect(pricePages[0]).toContain('ORDER BY ticker ASC, date ASC');
    expect(pricePages[0]).not.toContain('WHERE'); // first page has no cursor
    // Later pages carry the keyset cursor predicate.
    expect(pricePages[1]).toContain('(ticker, date) > (?, ?)');
  });

  it('uploads EQUAL-sized non-final multipart parts (R2 requirement) for a big table', async () => {
    // ~660 bytes/line * 30k ≈ 19.8 MB → two full 8 MiB parts + a smaller final part.
    const pad = 'x'.repeat(600);
    const rows = Array.from({ length: 30_000 }, () => ({ ticker: 'AAAA', date: '2026-01-01', close: 1, volume: 1, pad }));
    const { db } = fakeDb({
      price_eod: rows, spx_eod: [{ date: '2026-06-24', close: 5000 }], securities_ref: [], fundamentals_eod: [], analyst_consensus: [],
    });
    const r2 = fakeR2();
    const manifest = await runBulkSnapshot(envWith(db, r2), '2026-06-25', NOW, RUN);

    expect(manifest.tables.price_eod.rowCount).toBe(30_000);
    const key = snapshotObjectKey('2026-06-25', RUN, 'price_eod');
    const sizes = r2.partSizes.get(key)!;
    expect(sizes.length).toBeGreaterThanOrEqual(3); // ≥2 full parts + final remainder
    const nonFinal = sizes.slice(0, -1);
    // Every non-final part is the SAME size and >= R2's 5 MiB minimum.
    expect(new Set(nonFinal).size).toBe(1);
    expect(nonFinal[0]).toBeGreaterThanOrEqual(5 * 1024 * 1024);
    expect(sizes[sizes.length - 1]).toBeLessThanOrEqual(nonFinal[0]);
    // Round-trips: line count still equals the row count after reassembly.
    expect((r2.store.get(key) as string).split('\n').filter(Boolean)).toHaveLength(30_000);
    // The small spx table stays a single PUT (no recorded parts).
    expect(r2.partSizes.has(snapshotObjectKey('2026-06-25', RUN, 'spx_eod'))).toBe(false);
  });

  it('aborts the multipart upload (no orphaned parts) when a part fails mid-stream', async () => {
    const pad = 'x'.repeat(600);
    const rows = Array.from({ length: 30_000 }, () => ({ ticker: 'AAAA', date: '2026-01-01', close: 1, volume: 1, pad }));
    const { db } = fakeDb({
      price_eod: rows, spx_eod: [], securities_ref: [], fundamentals_eod: [], analyst_consensus: [],
    });
    let aborted = false;
    const failingR2 = {
      async put() { /* unused for the big table */ },
      async get() { return null; },
      async createMultipartUpload() {
        let calls = 0;
        return {
          async uploadPart() {
            calls += 1;
            if (calls >= 2) throw new Error('R2 uploadPart failed');
            return { partNumber: calls, etag: 'e' };
          },
          async complete() { /* never reached */ },
          async abort() { aborted = true; },
        };
      },
    };
    await expect(runBulkSnapshot(envWith(db, failingR2), '2026-06-25', NOW, RUN)).rejects.toThrow('uploadPart failed');
    expect(aborted).toBe(true);
  });

  it('readManifest round-trips the written manifest', async () => {
    const { db } = fakeDb({ price_eod: [], spx_eod: [], securities_ref: [], fundamentals_eod: [], analyst_consensus: [] });
    const r2 = fakeR2();
    await runBulkSnapshot(envWith(db, r2), '2026-06-25', NOW, RUN);
    const read = await readManifest(envWith(db, r2), '2026-06-25');
    expect(read?.snapshotDate).toBe('2026-06-25');
    expect(read?.runId).toBe(RUN);
    expect(await readManifest(envWith(db, r2), '2099-01-01')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Retention / prune
//
// Regression cover for the growth this module used to call "negligible R2 cost":
// nothing ever deleted a superseded run or an expired date, so `bulk/` became
// the largest prefix in congress-trade-bucket and kept pushing the account at
// R2's 10 GB free tier.
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
/** `nowMs` for the selector tests — every fixture age is relative to this. */
const PRUNE_NOW = Date.parse('2026-06-25T12:00:00.000Z');
const old = (hours: number) => new Date(PRUNE_NOW - hours * HOUR);

function selectorOpts(over: Record<string, unknown> = {}) {
  return {
    today: '2026-06-25',
    keepRunId: RUN,
    keepRunDate: '2026-06-25',
    keepDays: 14,
    graceMinutes: 60,
    nowMs: PRUNE_NOW,
    maxDeletes: 500,
    ...over,
  } as Parameters<typeof selectPruneTargets>[1];
}

describe('selectPruneTargets', () => {
  it('deletes a superseded run on a retained date but never the live run', () => {
    const targets = selectPruneTargets(
      [
        { key: `bulk/2026-06-25/runs/${RUN}/price_eod.ndjson`, uploaded: old(5) },
        { key: 'bulk/2026-06-25/runs/run-stale/price_eod.ndjson', uploaded: old(5) },
        { key: 'bulk/2026-06-25/runs/run-stale/spx_eod.ndjson', uploaded: old(5) },
      ],
      selectorOpts(),
    );
    expect(targets).toEqual([
      'bulk/2026-06-25/runs/run-stale/price_eod.ndjson',
      'bulk/2026-06-25/runs/run-stale/spx_eod.ndjson',
    ]);
  });

  it('leaves a superseded run alone until the grace window elapses', () => {
    const key = 'bulk/2026-06-25/runs/run-stale/price_eod.ndjson';
    expect(selectPruneTargets([{ key, uploaded: old(0.25) }], selectorOpts())).toEqual([]);
    expect(selectPruneTargets([{ key, uploaded: old(2) }], selectorOpts())).toEqual([key]);
  });

  it('refuses to delete an object whose upload time is unknown', () => {
    // Without a timestamp we cannot prove the grace window passed, and the
    // object may belong to a run a consumer is streaming right now.
    for (const uploaded of [undefined, null, 'not-a-date']) {
      expect(
        selectPruneTargets(
          [{ key: 'bulk/2026-06-25/runs/run-stale/price_eod.ndjson', uploaded }],
          selectorOpts(),
        ),
      ).toEqual([]);
    }
  });

  it('deletes an expired date entirely, manifest included, ignoring grace', () => {
    const targets = selectPruneTargets(
      [
        { key: 'bulk/2026-05-01/manifest.json', uploaded: old(0.1) },
        { key: 'bulk/2026-05-01/runs/run-old/price_eod.ndjson', uploaded: old(0.1) },
      ],
      selectorOpts(),
    );
    expect(targets).toEqual([
      'bulk/2026-05-01/manifest.json',
      'bulk/2026-05-01/runs/run-old/price_eod.ndjson',
    ]);
  });

  it('keeps the manifest of every retained date, including the oldest kept day', () => {
    // keepDays 14 counting today ⇒ oldest kept is 2026-06-12.
    const targets = selectPruneTargets(
      [
        { key: 'bulk/2026-06-12/manifest.json', uploaded: old(200) },
        { key: 'bulk/2026-06-12/runs/run-a/price_eod.ndjson', uploaded: old(200) },
        { key: 'bulk/2026-06-11/manifest.json', uploaded: old(224) },
      ],
      selectorOpts(),
    );
    // 06-12 is retained, so its manifest stays; its run carries no live-run id
    // for that date and is past grace. 06-11 has expired outright.
    expect(targets).toEqual([
      'bulk/2026-06-11/manifest.json',
      'bulk/2026-06-12/runs/run-a/price_eod.ndjson',
    ]);
  });

  it('never touches keys this job does not own', () => {
    const foreign = [
      { key: 'raw/1234-abcd', uploaded: old(9000) },
      { key: 'weekly/congress-trade-20260815T211942Z.db', uploaded: old(9000) },
      { key: 'historical-dumps/2024.ndjson', uploaded: old(9000) },
      { key: '_ops/usage-telemetry', uploaded: old(9000) },
      { key: 'bulk/manifest.json', uploaded: old(9000) },
      { key: 'bulk/not-a-date/runs/r/price_eod.ndjson', uploaded: old(9000) },
      { key: 'bulk/2026-05-01/runs/../../raw/escape.ndjson', uploaded: old(9000) },
      { key: 'bulk/2026-05-01/runs/run-old/price_eod.txt', uploaded: old(9000) },
    ];
    expect(selectPruneTargets(foreign, selectorOpts())).toEqual([]);
  });

  it('never touches a future-dated key (clock skew)', () => {
    expect(
      selectPruneTargets(
        [{ key: 'bulk/2027-01-01/runs/run-x/price_eod.ndjson', uploaded: old(9000) }],
        selectorOpts(),
      ),
    ).toEqual([]);
  });

  it('caps deletes and takes the oldest dates first so a backlog drains', () => {
    const fixtures = [
      { key: 'bulk/2026-06-01/manifest.json', uploaded: old(600) },
      { key: 'bulk/2026-05-01/manifest.json', uploaded: old(1300) },
      { key: 'bulk/2026-04-01/manifest.json', uploaded: old(2000) },
    ];
    expect(selectPruneTargets(fixtures, selectorOpts({ maxDeletes: 2 }))).toEqual([
      'bulk/2026-04-01/manifest.json',
      'bulk/2026-05-01/manifest.json',
    ]);
  });

  it('returns nothing for nonsensical retention settings', () => {
    const fixtures = [{ key: 'bulk/2026-05-01/manifest.json', uploaded: old(2000) }];
    expect(selectPruneTargets(fixtures, selectorOpts({ keepDays: 0 }))).toEqual([]);
    expect(selectPruneTargets(fixtures, selectorOpts({ maxDeletes: 0 }))).toEqual([]);
    expect(selectPruneTargets(fixtures, selectorOpts({ today: 'garbage' }))).toEqual([]);
  });

  it('parses and rejects key shapes exactly', () => {
    expect(parseRunObjectKey(`bulk/2026-06-25/runs/${RUN}/price_eod.ndjson`)).toEqual({
      date: '2026-06-25',
      runId: RUN,
    });
    expect(parseRunObjectKey('bulk/2026-06-25/manifest.json')).toBeNull();
    expect(parseBulkObjectDate('bulk/2026-06-25/manifest.json')).toBe('2026-06-25');
    expect(parseBulkObjectDate('raw/anything')).toBeNull();
  });

  it('shifts dates across month and year boundaries', () => {
    expect(shiftUtcDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftUtcDate('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftUtcDate('2024-03-01', -1)).toBe('2024-02-29'); // leap year
  });
});

/** R2 fake that also supports list()/delete(), which the writer fake omits. */
function fakeR2WithList(entries: Array<{ key: string; uploaded: Date }>) {
  const store = new Map(entries.map((e) => [e.key, e.uploaded]));
  const deleted: string[] = [];
  return {
    store,
    deleted,
    async put(key: string) { store.set(key, new Date(PRUNE_NOW)); },
    async get() { return null; },
    async delete(key: string) {
      if (key.includes('undeletable')) throw new Error('AccessDenied');
      deleted.push(key);
      store.delete(key);
    },
    async list({ prefix }: { prefix?: string } = {}) {
      return {
        objects: [...store.entries()]
          .filter(([key]) => !prefix || key.startsWith(prefix))
          .map(([key, uploaded]) => ({ key, size: 1, uploaded })),
        truncated: false,
        delimitedPrefixes: [] as string[],
      };
    },
  };
}

describe('pruneBulkSnapshots', () => {
  const base = { today: '2026-06-25', keepRunId: RUN, keepRunDate: '2026-06-25', now: new Date(PRUNE_NOW) };

  it('deletes expired dates and superseded runs, leaving live and foreign keys', async () => {
    const r2 = fakeR2WithList([
      { key: 'bulk/2026-01-02/manifest.json', uploaded: old(4000) },
      { key: 'bulk/2026-01-02/runs/run-ancient/price_eod.ndjson', uploaded: old(4000) },
      { key: 'bulk/2026-06-25/runs/run-stale/price_eod.ndjson', uploaded: old(6) },
      { key: `bulk/2026-06-25/runs/${RUN}/price_eod.ndjson`, uploaded: old(0.1) },
      { key: 'bulk/2026-06-25/manifest.json', uploaded: old(0.1) },
      { key: 'raw/keep-me', uploaded: old(9999) },
    ]);
    const result = await pruneBulkSnapshots(envWith({}, r2), base);

    expect(result.deleted).toBe(3);
    expect(result.failed).toBe(0);
    expect([...r2.deleted].sort()).toEqual([
      'bulk/2026-01-02/manifest.json',
      'bulk/2026-01-02/runs/run-ancient/price_eod.ndjson',
      'bulk/2026-06-25/runs/run-stale/price_eod.ndjson',
    ]);
    expect(r2.store.has(`bulk/2026-06-25/runs/${RUN}/price_eod.ndjson`)).toBe(true);
    expect(r2.store.has('bulk/2026-06-25/manifest.json')).toBe(true);
    expect(r2.store.has('raw/keep-me')).toBe(true);
  });

  it('honours the kill switch without deleting anything', async () => {
    const r2 = fakeR2WithList([{ key: 'bulk/2026-01-02/manifest.json', uploaded: old(4000) }]);
    const env = { DB: {}, RAW_FILES: r2, BULK_SNAPSHOT_PRUNE_DISABLED: '1' } as unknown as Env;
    const result = await pruneBulkSnapshots(env, base);
    expect(result.skipped).toBe('disabled');
    expect(r2.deleted).toEqual([]);
  });

  it('degrades quietly when the binding has no list()', async () => {
    const result = await pruneBulkSnapshots(envWith({}, fakeR2()), base);
    expect(result.skipped).toBe('unsupported');
    expect(result.deleted).toBe(0);
  });

  it('counts a failed delete without throwing or blocking the rest', async () => {
    const r2 = fakeR2WithList([
      { key: 'bulk/2026-01-02/runs/run-undeletable/price_eod.ndjson', uploaded: old(4000) },
      { key: 'bulk/2026-01-03/manifest.json', uploaded: old(4000) },
    ]);
    const result = await pruneBulkSnapshots(envWith({}, r2), base);
    expect(result.failed).toBe(1);
    expect(result.deleted).toBe(1);
    expect(r2.deleted).toEqual(['bulk/2026-01-03/manifest.json']);
  });

  it('survives a listing failure', async () => {
    const r2 = { ...fakeR2WithList([]), async list() { throw new Error('R2 unavailable'); } };
    await expect(pruneBulkSnapshots(envWith({}, r2), base)).resolves.toMatchObject({ deleted: 0, failed: 0 });
  });

  it('respects a BULK_SNAPSHOT_KEEP_DAYS override', async () => {
    // keepDays 2 ⇒ oldest kept is 06-24, so only 06-20 expires.
    const r2 = fakeR2WithList([
      { key: 'bulk/2026-06-24/manifest.json', uploaded: old(30) },
      { key: 'bulk/2026-06-20/manifest.json', uploaded: old(130) },
    ]);
    const env = { DB: {}, RAW_FILES: r2, BULK_SNAPSHOT_KEEP_DAYS: '2' } as unknown as Env;
    await pruneBulkSnapshots(env, base);
    expect(r2.deleted).toEqual(['bulk/2026-06-20/manifest.json']);
  });
});

describe('runBulkSnapshot prune integration', () => {
  it('prunes a superseded same-day run after publishing the new manifest', async () => {
    const { db } = fakeDb({ price_eod: [], spx_eod: [], securities_ref: [], fundamentals_eod: [], analyst_consensus: [] });
    const r2 = fakeR2WithList([
      { key: 'bulk/2026-06-25/runs/run-previous/price_eod.ndjson', uploaded: old(6) },
    ]);
    await runBulkSnapshot(envWith(db, r2), '2026-06-25', new Date(PRUNE_NOW), RUN);

    expect(r2.deleted).toEqual(['bulk/2026-06-25/runs/run-previous/price_eod.ndjson']);
    // The run just published is intact and still reachable through its manifest.
    expect(r2.store.has(manifestObjectKey('2026-06-25'))).toBe(true);
    expect(r2.store.has(snapshotObjectKey('2026-06-25', RUN, 'price_eod'))).toBe(true);
  });

  it('still returns the manifest when the prune blows up', async () => {
    const { db } = fakeDb({ price_eod: [], spx_eod: [], securities_ref: [], fundamentals_eod: [], analyst_consensus: [] });
    const r2 = { ...fakeR2WithList([]), async list() { throw new Error('boom'); } };
    const manifest = await runBulkSnapshot(envWith(db, r2), '2026-06-25', NOW, RUN);
    expect(manifest.runId).toBe(RUN);
  });
});
