import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { resetD1WriteGovernor } from '../../shared/d1Budget.ts';
import { insertFilingIfNew, type DiscoveredFiling } from '../watcher.ts';

const DISCOVERED: DiscoveredFiling = {
  docId: 'S-abc12345',
  chamber: 'senate',
  sourceUrl: 'https://efdsearch.senate.gov/search/view/ptr/abc12345/',
  filedDate: '07/15/2026',
  filerId: 'senate-jane-smith',
  filerName: 'Jane Smith',
};

function envWithExistingFiling(mode: 'provider_seed' | 'not_found' | 'none') {
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        sql,
        params: [] as unknown[],
        bind(...params: unknown[]) {
          statement.params = params;
          return statement;
        },
        async run() {
          writes.push({ sql, params: statement.params });
          let changes = 1;
          if (/INSERT OR IGNORE INTO filings/i.test(sql)) changes = 0;
          if (/ingest_status = 'provider_seeded'/i.test(sql)) changes = mode === 'provider_seed' ? 1 : 0;
          if (/ingest_status (?:= 'not_found'|IN)/i.test(sql)) changes = (mode === 'not_found' || mode === 'failed') ? 1 : 0;
          return { meta: { changes } } as D1Result;
        },
        async all<T>() {
          if (/FROM filings/i.test(sql)) {
            if (mode === 'provider_seed') {
              return { results: [{ doc_id: DISCOVERED.docId, ingest_status: 'provider_seeded', extractor: 'fmp-senate-latest' }] as T[] };
            }
            if (mode === 'not_found') {
              return { results: [{ doc_id: DISCOVERED.docId, ingest_status: 'not_found', extractor: null }] as T[] };
            }
            if (mode === 'failed') {
              return { results: [{ doc_id: DISCOVERED.docId, ingest_status: 'failed', extractor: null }] as T[] };
            }
          }
          return { results: [] as T[] };
        },
        // resolveIngestFilerId's merge/existing-filer lookups (get() -> .first()).
        // DISCOVERED carries no `state`, so it never reaches the chamber+state
        // scan — these two always miss for this fixture, same as an empty DB.
        async first<T>() {
          return null as T | null;
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
    async batch(statements: Array<{ run(): Promise<D1Result> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  } as unknown as D1Database;
  return { env: { DB: db } as unknown as Env, writes };
}

beforeEach(() => resetD1WriteGovernor());
afterEach(() => resetD1WriteGovernor());

describe('official discovery upgrades FMP provider seeds', () => {
  it('reopens only the narrowly-tagged provider seed for the official pipeline', async () => {
    const { env, writes } = envWithExistingFiling('provider_seed');
    const result = await insertFilingIfNew(env, DISCOVERED, '2026-07-22T00:00:00.000Z');

    expect(result).toBe('inserted');
    const upgrade = writes.find(({ sql }) => /provider_seeded/.test(sql));
    expect(upgrade?.sql).toContain("extractor = 'fmp-senate-latest'");
    expect(upgrade?.sql).toContain("ingest_status = 'new'");
    expect(upgrade?.params).toEqual(expect.arrayContaining(['S-abc12345', 'senate-jane-smith']));
  });

  it('unblocks official filings stuck as not_found phantoms', async () => {
    const { env, writes } = envWithExistingFiling('not_found');
    const result = await insertFilingIfNew(env, DISCOVERED, '2026-07-22T00:00:00.000Z');

    expect(result).toBe('inserted');
    const upgrade = writes.find(({ sql }) => /ingest_status IN \('not_found', 'failed'\)/.test(sql));
    expect(upgrade?.sql).toContain("ingest_status = 'new'");
    expect(upgrade?.sql).toContain("error = NULL");
    expect(upgrade?.params).toEqual(expect.arrayContaining(['S-abc12345']));

    const outboxReArm = writes.find(({ sql }) => /INSERT INTO ingestion_outbox/.test(sql));
    expect(outboxReArm?.sql).toContain("ON CONFLICT(doc_id) DO UPDATE");
  });

  it('unblocks official filings stuck as failed phantoms', async () => {
    const { env, writes } = envWithExistingFiling('failed');
    const result = await insertFilingIfNew(env, DISCOVERED, '2026-07-22T00:00:00.000Z');

    expect(result).toBe('inserted');
    const upgrade = writes.find(({ sql }) => /ingest_status IN \('not_found', 'failed'\)/.test(sql));
    expect(upgrade?.sql).toContain("ingest_status = 'new'");
    expect(upgrade?.sql).toContain("error = NULL");
    expect(upgrade?.params).toEqual(expect.arrayContaining(['S-abc12345']));
  });

  it('leaves an unrelated pre-existing filing classified as a duplicate', async () => {
    const { env } = envWithExistingFiling('none');
    await expect(insertFilingIfNew(env, DISCOVERED, '2026-07-22T00:00:00.000Z')).resolves.toBe('duplicate');
  });
});
