import { describe, it, expect } from 'vitest';
import {
  mapRecordToTransaction,
  deterministicTxId,
  mapTxType,
  mapOwner,
  mapAmount,
  normalizeDate,
  passesSinceYear,
  seedFilerId,
  runSeedBackfill,
  runSeedBackfillFromEnv,
  type RawWatcherRecord,
} from '../seed.ts';
import type { Env } from '../../shared/types.ts';
import type { TickerResolver } from '../../extraction/normalizer.ts';

// A resolver that treats every supplied ticker as known (resolves to itself),
// simulating a securities_master hit so clean rows aren't ticker-penalized.
const resolveAll: TickerResolver = (t) => (t && t.trim() ? t.trim().toUpperCase() : null);

// Inline fixtures — no network.
const SENATE_REC: RawWatcherRecord = {
  senator: 'Jane A. Smith',
  ticker: 'nvda',
  asset_description: 'NVIDIA Corporation',
  asset_type: 'Stock',
  type: 'Purchase',
  transaction_date: '06/04/2026',
  disclosure_date: '06/19/2026',
  amount: '$250,001 - $500,000',
  owner: 'Spouse',
};

describe('field mappers', () => {
  it('maps transaction type to P/S/E', () => {
    expect(mapTxType('Purchase')).toBe('B');
    expect(mapTxType('Sale (Full)')).toBe('S');
    expect(mapTxType('Sale (Partial)')).toBe('S');
    expect(mapTxType('Exchange')).toBe('E');
    expect(mapTxType(undefined)).toBe('B');
  });

  it('maps owner to the Owner union', () => {
    expect(mapOwner('Spouse')).toBe('spouse');
    expect(mapOwner('Joint')).toBe('joint');
    expect(mapOwner('Dependent Child')).toBe('dependent');
    expect(mapOwner('Self')).toBe('self');
    expect(mapOwner('--')).toBeNull();
    expect(mapOwner(undefined)).toBeNull();
  });

  it('normalizes dates to ISO', () => {
    expect(normalizeDate('06/04/2026')).toBe('2026-06-04');
    expect(normalizeDate('6/4/2026')).toBe('2026-06-04');
    expect(normalizeDate('2026-06-04')).toBe('2026-06-04');
    expect(normalizeDate('garbage')).toBeNull();
    expect(normalizeDate(undefined)).toBeNull();
  });

  it('maps amount ranges onto canonical STOCK Act brackets', () => {
    expect(mapAmount('$1,001 - $15,000')).toEqual({ min: 1001, max: 15000 });
    expect(mapAmount('$250,001 - $500,000')).toEqual({ min: 250001, max: 500000 });
    expect(mapAmount('$50,000,001 +')).toEqual({ min: 50000001, max: null });
    expect(mapAmount('')).toEqual({ min: null, max: null });
  });
});

describe('mapRecordToTransaction', () => {
  it('maps a full senate record to a seed_dataset Transaction', () => {
    const tx = mapRecordToTransaction(SENATE_REC, 'senate', '2026-06-20T00:00:00.000Z', resolveAll);
    expect(tx).not.toBeNull();
    if (!tx) return;
    expect(tx.source).toBe('seed_dataset');
    expect(tx.ticker).toBe('NVDA');
    expect(tx.assetName).toBe('NVIDIA Corporation');
    expect(tx.assetTypeName).toBe('Stock');
    expect(tx.txType).toBe('B');
    expect(tx.owner).toBe('spouse');
    expect(tx.txDate).toBe('2026-06-04');
    expect(tx.amountMin).toBe(250001);
    expect(tx.amountMax).toBe(500000);
    expect(tx.docId).toBe('seed-senate');
    expect(tx.filerId).toBe('seed-senate-jane-a-smith');
    expect(tx.isOption).toBe(false);
    // Same rubric as the live normalizer: clean seed row = SEED_BASE_CONFIDENCE,
    // no penalties (ticker resolves, amount canonical, valid type/date).
    expect(tx.confidence).toBe(0.95);
  });

  it('keeps seed asset details out of the main asset name', () => {
    const tx = mapRecordToTransaction(
      {
        senator: 'Jane A. Smith',
        ticker: 'AIG',
        asset_description:
          'American International Group, Inc. <div class="text-muted">Option Type: Put <br><em>Strike price:</em> $50.00 <br> <em>Expires:</em> 05/15/2020 </div>',
        asset_type: 'Stock Option',
        type: 'Purchase',
        transaction_date: '05/01/2020',
        amount: '$15,001 - $50,000',
      },
      'senate',
      '2026-06-20T00:00:00.000Z',
      resolveAll,
    );
    expect(tx).not.toBeNull();
    expect(tx?.assetName).toBe('American International Group, Inc.');
    expect(tx?.assetTypeName).toBe('Stock Option');
    expect(tx?.isOption).toBe(true);
    expect(tx?.description).toBe('Option Type: Put Strike price: $50.00 Expires: 05/15/2020');
    expect(tx?.supplementalText).toBe('Option Type: Put Strike price: $50.00 Expires: 05/15/2020');
  });

  it('returns null when there is no asset and no ticker', () => {
    const tx = mapRecordToTransaction(
      { senator: 'Nobody', type: 'Purchase' },
      'senate',
      '2026-06-20T00:00:00.000Z',
      resolveAll,
    );
    expect(tx).toBeNull();
  });

  it('rejects unparsed scanned-PDF seed placeholders', () => {
    const tx = mapRecordToTransaction(
      {
        senator: 'Jane A. Smith',
        asset_description: 'This filing was disclosed via scanned PDF. Use link in ptr_link column to view the PDF.',
        asset_type: 'PDF Disclosed Filing',
        type: 'Purchase',
      },
      'senate',
      '2026-06-20T00:00:00.000Z',
      resolveAll,
    );
    expect(tx).toBeNull();
  });

  it('does not turn unknown seed transaction types into purchases', () => {
    const tx = mapRecordToTransaction(
      { senator: 'Jane A. Smith', ticker: 'AAPL', asset_description: 'Apple Inc.', type: 'N/A' },
      'senate',
      '2026-06-20T00:00:00.000Z',
      resolveAll,
    );
    expect(tx).toBeNull();
  });

  it('uses the representative field for House records', () => {
    const tx = mapRecordToTransaction(
      { representative: 'Hon. Pat Q. Example', ticker: 'AAPL', type: 'sale' },
      'house',
      '2026-06-20T00:00:00.000Z',
      resolveAll,
    );
    expect(tx?.filerId).toBe('seed-house-hon-pat-q-example');
    expect(tx?.txType).toBe('S');
  });

  it('applies the same ticker penalty to seed rows when the ticker is unresolved', () => {
    const noResolve: TickerResolver = () => null;
    const tx = mapRecordToTransaction(SENATE_REC, 'senate', '2026-06-20T00:00:00.000Z', noResolve)!;
    // Same rubric: base 0.95 * 0.85 (unresolved_ticker) = 0.8075.
    expect(tx.confidence).toBeCloseTo(0.8075, 4);
    expect(tx.ticker).toBe('NVDA'); // raw ticker retained when unresolved
  });
});

describe('deterministic id', () => {
  it('is stable for identical inputs (idempotent re-runs)', () => {
    const a = mapRecordToTransaction(SENATE_REC, 'senate', '2026-06-20T00:00:00.000Z', resolveAll);
    const b = mapRecordToTransaction(SENATE_REC, 'senate', '2999-01-01T00:00:00.000Z', resolveAll);
    // createdAt differs but id must not — it excludes timestamp.
    expect(a?.id).toBe(b?.id);
    expect(a?.id).toMatch(/^seed_[0-9a-f]{16}$/);
  });

  it('differs when any identity field changes', () => {
    const base = {
      source: 'seed_dataset',
      filerId: 'seed-senate-jane-a-smith',
      txDate: '2026-06-04',
      ticker: 'NVDA',
      amountMin: 250001,
      amountMax: 500000,
    };
    const id0 = deterministicTxId(base);
    expect(deterministicTxId({ ...base, ticker: 'AAPL' })).not.toBe(id0);
    expect(deterministicTxId({ ...base, txDate: '2026-06-05' })).not.toBe(id0);
    expect(deterministicTxId({ ...base, amountMin: 1001 })).not.toBe(id0);
    expect(deterministicTxId({ ...base, filerId: 'seed-senate-other' })).not.toBe(id0);
  });
});

describe('filters & helpers', () => {
  it('seedFilerId slugs names and rejects empties', () => {
    expect(seedFilerId('senate', 'Jane A. Smith')).toBe('seed-senate-jane-a-smith');
    expect(seedFilerId('house', '   ')).toBeNull();
  });

  it('passesSinceYear filters by tx_date year', () => {
    const tx = mapRecordToTransaction(SENATE_REC, 'senate', '2026-06-20T00:00:00.000Z', resolveAll)!;
    expect(passesSinceYear(tx, undefined)).toBe(true);
    expect(passesSinceYear(tx, 2026)).toBe(true);
    expect(passesSinceYear(tx, 2027)).toBe(false);
  });
});

describe('runSeedBackfill source overrides (dryRun)', () => {
  // dryRun never touches the DB, so a bare cast env is sufficient here.
  const env = {} as Env;

  function jsonFetch(rows: unknown[]): { fetchImpl: typeof fetch; urls: string[] } {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, urls };
  }

  it('uses opts.sourceUrls override instead of the hardcoded bucket', async () => {
    const { fetchImpl, urls } = jsonFetch([SENATE_REC]);
    const res = await runSeedBackfill(env, {
      chambers: ['senate'],
      dryRun: true,
      fetchImpl,
      sourceUrls: { senate: 'https://mirror.example/senate.json' },
    });
    expect(urls).toEqual(['https://mirror.example/senate.json']);
    expect(res.inserted).toBe(1);
    expect(res.bySource.senate).toBe(1);
  });

  it('runSeedBackfillFromEnv pulls SEED_SENATE_URL from env', async () => {
    const { fetchImpl, urls } = jsonFetch([SENATE_REC]);
    const envWithUrl = { SEED_SENATE_URL: 'https://env.example/senate.json' } as unknown as Env;
    await runSeedBackfillFromEnv(envWithUrl, { chambers: ['senate'], dryRun: true, fetchImpl });
    expect(urls).toEqual(['https://env.example/senate.json']);
  });
});

describe('runSeedBackfill batched writes (subrequest cap)', () => {
  // Fake D1: prepare().all() feeds an empty securities_master to the resolver;
  // batch() records how many statements landed in each call (= one subrequest).
  function fakeDb() {
    const batchSizes: number[] = [];
    const transactionSql: string[] = [];
    const transactionBinds: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            if (/INSERT INTO transactions/i.test(sql)) {
              transactionSql.push(sql);
              transactionBinds.push(params);
            }
            return this;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            return { meta: { changes: 1 } };
          },
        };
      },
      async batch(stmts: unknown[]) {
        batchSizes.push(stmts.length);
        return stmts.map(() => ({ meta: { changes: 1 } }));
      },
    };
    return { db, batchSizes, transactionSql, transactionBinds };
  }

  it('groups upserts into bounded batches instead of one write per row', async () => {
    const { db, batchSizes, transactionSql, transactionBinds } = fakeDb();
    const env = { DB: db } as unknown as Env;
    // 120 distinct politicians => 120 filer upserts + 120 tx upserts = 240 statements.
    const rows = Array.from({ length: 120 }, (_, i) => ({
      ...SENATE_REC,
      senator: `Politician Number ${i}`,
    }));
    const fetchImpl = (async () =>
      new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const res = await runSeedBackfill(env, { chambers: ['senate'], fetchImpl });

    expect(res.errors).toEqual([]);
    expect(res.inserted).toBe(120); // only tx statements are counted, not filers
    // Batched, not one-subrequest-per-statement: many fewer batches than 240,
    // and no single batch exceeds the cap-friendly chunk size.
    expect(batchSizes.length).toBeGreaterThan(1);
    expect(batchSizes.length).toBeLessThan(20);
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(51);
    expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(240);
    expect(transactionSql).toHaveLength(120);
    expect(transactionSql.every((sql) => /filed_date, est_value/i.test(sql))).toBe(true);
    expect(transactionSql.every((sql) => /est_value = excluded\.est_value/i.test(sql))).toBe(true);
    expect(transactionBinds.every((params) => params.at(-3) === 375000.5)).toBe(true);
  });

  it('materializes est_value on insert and refreshes it during seed reconciliation', async () => {
    const prepared: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        const captured = { sql, params: [] as unknown[] };
        prepared.push(captured);
        return {
          bind(...params: unknown[]) {
            captured.params = params;
            return this;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            return { meta: { changes: 1 } };
          },
        };
      },
      async batch(stmts: unknown[]) {
        return stmts.map(() => ({ meta: { changes: 1 } }));
      },
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify([SENATE_REC]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const res = await runSeedBackfill({ DB: db } as unknown as Env, {
      chambers: ['senate'],
      fetchImpl,
    });

    expect(res.errors).toEqual([]);
    const txUpsert = prepared.find(({ sql }) => sql.includes('INSERT INTO transactions'));
    expect(txUpsert).toBeDefined();
    expect(txUpsert?.sql).toContain('first_seen_at, filed_date, est_value');
    expect(txUpsert?.sql).toContain('est_value = excluded.est_value');
    // est_value is followed by disclosure_lag_days + stock_act_status (0065).
    expect(txUpsert?.params.at(-3)).toBe((250001 + 500000) / 2);
  });

  it('archives the verbatim seed payload to R2 before processing rows', async () => {
    const { db } = fakeDb();
    const puts: Array<{ key: string; body: string }> = [];
    const env = {
      DB: db,
      RAW_FILES: {
        async put(key: string, body: string) {
          puts.push({ key, body });
        },
      },
    } as unknown as Env;
    const payload = JSON.stringify([SENATE_REC]);
    const fetchImpl = (async () =>
      new Response(payload, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const res = await runSeedBackfill(env, { chambers: ['senate'], fetchImpl });

    expect(res.errors).toEqual([]);
    expect(puts).toHaveLength(1);
    expect(puts[0].key).toMatch(/^seed\/senate\/.+\.json$/);
    expect(puts[0].body).toBe(payload); // byte-verbatim archive
    expect(res.artifacts?.senate).toBe(puts[0].key);
  });

  it('skips the artifact archive in dryRun and never lets an R2 failure block the run', async () => {
    const { db } = fakeDb();
    const failingEnv = {
      DB: db,
      RAW_FILES: {
        async put() {
          throw new Error('r2 down');
        },
      },
    } as unknown as Env;
    const fetchImpl = (async () =>
      new Response(JSON.stringify([SENATE_REC]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const dry = await runSeedBackfill(failingEnv, { chambers: ['senate'], fetchImpl, dryRun: true });
    expect(dry.errors).toEqual([]);
    expect(dry.artifacts).toBeUndefined();

    const res = await runSeedBackfill(failingEnv, { chambers: ['senate'], fetchImpl });
    expect(res.inserted).toBe(1);
    expect(res.artifacts).toBeUndefined();
    expect(res.errors).toEqual(['senate artifact persist: r2 down']);
  });
});
