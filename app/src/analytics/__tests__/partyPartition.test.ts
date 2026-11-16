/**
 * src/analytics/__tests__/partyPartition.test.ts
 *
 * Board efd94c45 / expert-panel review #35: the party filter did not partition
 * the data.  Trades whose filer has no party on file (seed filers with
 * party='', executive-branch and manual filers, or a transaction with no
 * `filers` row at all) bucketed to NULL, so
 *   - any explicit party selection (`party=D`, `party=D,R,O`) dropped them,
 *   - `party=O` ("Other") returned ~nothing,
 *   - All (no filter) never equalled D + R + O, and
 *   - cluster cards printed "0 Democrats, 3 Republicans" for 4 politicians.
 *
 * These tests run the REAL generated SQL against an in-memory SQLite database
 * with every production migration applied (same harness as the migration
 * tests), so they fail on the NULL bucket rather than on a string diff.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { openMigratedD1 } from '../../prices/__tests__/sqliteD1.ts';
import {
  ANALYTICS_FROM_JOINS,
  PARTY_BUCKET_SQL,
  buildCommonFilters,
  whereSql,
  type CommonFilters,
} from '../sql.ts';
import {
  buildClusterBuysQuery,
  buildPartySplitOverTimeQuery,
  buildPartySplitQuery,
} from '../builders.ts';
import { PARTY_BUCKET_SQL_LOCAL, buildTransactionsCountQuery } from '../../delivery/rows.ts';

type Db = Awaited<ReturnType<typeof openMigratedD1>>['db'];

const opened: Array<() => void> = [];
afterEach(() => {
  while (opened.length) opened.pop()!();
});

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

interface FilerSeed {
  id: string;
  party: string | null;
  chamber?: string;
}

/**
 * One filer per real-world party shape seen in production data, plus one
 * transaction per filer.  `ORPHAN` has a transaction but no `filers` row.
 */
const FILERS: FilerSeed[] = [
  { id: 'D000001', party: 'Democrat' },
  { id: 'D000002', party: 'Democratic' },
  { id: 'D000003', party: ' d ' },
  { id: 'R000001', party: 'Republican' },
  { id: 'R000002', party: 'R' },
  { id: 'I000001', party: 'Independent' },
  { id: 'O000001', party: 'Other' },
  { id: 'L000001', party: 'Libertarian' },
  { id: 'SEED0001', party: '' },
  { id: 'SEED0002', party: '   ' },
  { id: 'EXEC-FRANK-J-BISIGNANO', party: null, chamber: 'executive' },
  { id: 'MANUAL-ELVIRA', party: null },
];
const ORPHAN = 'NOFILERROW1';
const EXPECTED_BUCKET: Record<string, 'D' | 'R' | 'O'> = {
  D000001: 'D',
  D000002: 'D',
  D000003: 'D',
  R000001: 'R',
  R000002: 'R',
  I000001: 'O',
  O000001: 'O',
  L000001: 'O',
  SEED0001: 'O',
  SEED0002: 'O',
  'EXEC-FRANK-J-BISIGNANO': 'O',
  'MANUAL-ELVIRA': 'O',
  [ORPHAN]: 'O',
};

async function seedDb(): Promise<Db> {
  const { db, close } = await openMigratedD1();
  opened.push(close);
  const insFiler = db.prepare(
    'INSERT INTO filers (bioguide_id, chamber, full_name, party) VALUES (?, ?, ?, ?)',
  );
  const insTx = db.prepare(
    `INSERT INTO transactions (
       id, doc_id, filer_id, tx_date, ticker, asset_name, tx_type, source,
       amount_min, amount_max, owner, is_option
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'primary', 1001, 15000, 'self', 0)`,
  );
  let n = 0;
  const ids = [...FILERS.map((f) => f.id), ORPHAN];
  for (const f of FILERS) insFiler.run(f.id, f.chamber ?? 'house', `Member ${f.id}`, f.party);
  for (const id of ids) {
    n += 1;
    // Every filer buys the SAME ticker (a 13-member consensus cluster) and
    // sells a private one, so cluster + party-split queries see all buckets.
    insTx.run(`tx-b-${n}`, `DOC-B-${n}`, id, isoDaysAgo(3), 'CLUS', 'Cluster Corp', 'B');
    insTx.run(`tx-s-${n}`, `DOC-S-${n}`, id, isoDaysAgo(4), `T${n}`, `Ticker ${n}`, 'S');
  }
  return db;
}

function countCommon(db: Db, p: CommonFilters): number {
  const { where, params } = buildCommonFilters({ window: 'all', ...p });
  const sql = `SELECT COUNT(*) AS n ${ANALYTICS_FROM_JOINS}${whereSql(where)}`;
  return Number(db.prepare(sql).get(...params)!.n);
}

function countFeed(db: Db, partyBuckets?: Array<'D' | 'R' | 'O'>): number {
  const q = buildTransactionsCountQuery({ partyBuckets });
  return Number(db.prepare(q.sql).get(...q.params)!.total);
}

describe('party filter partitions the data (efd94c45)', () => {
  it('buckets every party shape into exactly D, R or O — never NULL', async () => {
    const db = await seedDb();
    const rows = db
      .prepare(
        `SELECT t.filer_id AS filer_id, ${PARTY_BUCKET_SQL} AS bucket
           ${ANALYTICS_FROM_JOINS}
          WHERE t.tx_type = 'B'`,
      )
      .all() as Array<{ filer_id: string; bucket: string | null }>;
    expect(rows.length).toBe(FILERS.length + 1);
    for (const r of rows) {
      expect(r.bucket, `bucket for ${r.filer_id}`).toBe(EXPECTED_BUCKET[r.filer_id]);
    }
  });

  it('analytics: All equals D + R + O, and party=D,R,O equals All', async () => {
    const db = await seedDb();
    const all = countCommon(db, {});
    const d = countCommon(db, { party: 'D' });
    const r = countCommon(db, { party: 'R' });
    const o = countCommon(db, { party: 'O' });
    expect(all).toBe((FILERS.length + 1) * 2);
    expect(d + r + o).toBe(all);
    expect(d).toBe(3 * 2);
    expect(r).toBe(2 * 2);
    // 'Other' used to be ~empty: now Independents, minor parties and every
    // no-party filer (seed, executive, manual, orphan) land here.
    expect(o).toBe(8 * 2);
    expect(countCommon(db, { parties: ['D', 'R', 'O'] })).toBe(all);
    expect(countCommon(db, { parties: ['D', 'R'] })).toBe(d + r);
  });

  it('Trades feed: party=D,R,O equals no filter and the three buckets sum to All', async () => {
    const db = await seedDb();
    const all = countFeed(db);
    expect(all).toBe((FILERS.length + 1) * 2);
    expect(countFeed(db, ['D']) + countFeed(db, ['R']) + countFeed(db, ['O'])).toBe(all);
    expect(countFeed(db, ['D', 'R', 'O'])).toBe(all);
    expect(countFeed(db, ['O'])).toBe(8 * 2);
  });

  it('party split has no NULL bucket and its buckets sum to the unfiltered total', async () => {
    const db = await seedDb();
    const q = buildPartySplitQuery({ window: 'all' });
    const rows = db.prepare(q.sql).all(...q.params) as Array<{
      party: string | null;
      buys: number;
      sells: number;
      members: number;
    }>;
    expect(rows.map((r) => r.party).sort()).toEqual(['D', 'O', 'R']);
    const trades = rows.reduce((sum, r) => sum + Number(r.buys) + Number(r.sells), 0);
    expect(trades).toBe(countCommon(db, {}));
    const members = rows.reduce((sum, r) => sum + Number(r.members), 0);
    expect(members).toBe(FILERS.length + 1);
  });

  it('party split over time yields at most one row per (period, bucket) and no NULL bucket', async () => {
    const db = await seedDb();
    const q = buildPartySplitOverTimeQuery({ window: 'all', granularity: 'month' });
    const rows = db.prepare(q.sql).all(...q.params) as Array<{
      period: string;
      party: string | null;
      buys: number;
      sells: number;
    }>;
    const keys = rows.map((r) => `${r.period}|${r.party}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(rows.every((r) => r.party === 'D' || r.party === 'R' || r.party === 'O')).toBe(true);
    const trades = rows.reduce((sum, r) => sum + Number(r.buys) + Number(r.sells), 0);
    expect(trades).toBe(countCommon(db, {}));
  });

  it('cluster cards: D + R + O members always equals the cluster member count', async () => {
    const db = await seedDb();
    const q = buildClusterBuysQuery({ window: 'all', minMembers: 2 });
    const rows = db.prepare(q.sql).all(...q.params) as Array<Record<string, number | string>>;
    const clus = rows.find((r) => r.ticker === 'CLUS');
    expect(clus).toBeTruthy();
    expect(Number(clus!.member_count)).toBe(FILERS.length + 1);
    expect(Number(clus!.d_members)).toBe(3);
    expect(Number(clus!.r_members)).toBe(2);
    expect(Number(clus!.o_members)).toBe(8);
    expect(
      Number(clus!.d_members) + Number(clus!.r_members) + Number(clus!.o_members),
    ).toBe(Number(clus!.member_count));
  });

  it('the analytics and Trades-feed bucket expressions are identical (drift guard)', () => {
    expect(PARTY_BUCKET_SQL_LOCAL).toBe(PARTY_BUCKET_SQL);
  });
});
