/**
 * src/delivery/__tests__/membersRoute.test.ts
 *
 * GET /members against a real, fully-migrated in-memory SQLite DB (see
 * prices/__tests__/sqliteD1.ts) so the INDEXED BY query and the
 * deprecated_at filter are exercised for real, not re-implemented in a
 * mock. No CONFIG_KV is provided, so `cached()` always falls through to a
 * live recompute (see shared/kvCache.ts — any KV error is swallowed).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedD1, type D1Database, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import { buildRestRouter } from '../rest.ts';
import { dedupeSplitFilerIdentities } from '../../admin/filerIdentityDedupe.ts';
import type { Env } from '../../shared/types.ts';

let db: SqliteDatabase;
let d1: D1Database;
let env: Env;

beforeEach(async () => {
  ({ db, d1 } = await openMigratedD1());
  env = { DB: d1 } as unknown as Env;
});

afterEach(() => {
  db.close();
});

function insertFiler(row: {
  id: string;
  fullName: string;
  chamber: string;
  state: string;
  party?: string | null;
  photoUrl?: string | null;
  displayName?: string | null;
}) {
  db.prepare(
    `INSERT INTO filers (bioguide_id, chamber, full_name, party, state, photo_url, display_name) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.chamber,
    row.fullName,
    row.party ?? null,
    row.state,
    row.photoUrl ?? null,
    row.displayName ?? null,
  );
}

let txSeq = 0;
function insertTx(filerId: string, opts: { deprecated?: boolean } = {}) {
  txSeq += 1;
  db.prepare(`INSERT INTO transactions (id, doc_id, filer_id, tx_date, deprecated_at) VALUES (?, ?, ?, '2026-01-01', ?)`).run(
    `tx-${txSeq}`,
    `doc-${txSeq}`,
    filerId,
    opts.deprecated ? '2026-02-01T00:00:00.000Z' : null,
  );
}

async function getMembers() {
  const app = buildRestRouter();
  const res = await app.request('http://localhost/members', {}, env);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    members: Array<{
      filerId: string;
      fullName: string | null;
      party: string | null;
      txCount: number;
      photoUrl: string | null;
      title: string | null;
    }>;
    count: number;
  };
}

describe('GET /members', () => {
  it('formats party as a full word for every branch — House/Senate (spelled) and executive (bare letter) alike', async () => {
    insertFiler({ id: 'house-tx10-jane-smith', fullName: 'Jane Smith', chamber: 'house', state: 'TX', party: 'Republican' });
    insertFiler({ id: 'EXEC-TEST', fullName: 'Test Executive', chamber: 'executive', state: 'DC', party: 'D' });
    insertTx('house-tx10-jane-smith');
    insertTx('EXEC-TEST');

    const body = await getMembers();
    const byId = new Map(body.members.map((m) => [m.filerId, m]));
    expect(byId.get('house-tx10-jane-smith')?.party).toBe('Republican');
    expect(byId.get('EXEC-TEST')?.party).toBe('Democrat');
  });

  it('excludes deprecated (retracted) transactions from tx_count', async () => {
    insertFiler({ id: 'house-tx10-jane-smith', fullName: 'Jane Smith', chamber: 'house', state: 'TX' });
    insertTx('house-tx10-jane-smith');
    insertTx('house-tx10-jane-smith');
    insertTx('house-tx10-jane-smith', { deprecated: true });

    const body = await getMembers();
    const row = body.members.find((m) => m.filerId === 'house-tx10-jane-smith');
    expect(row?.txCount).toBe(2);
  });

  it('does not list a filer whose only transactions were retracted', async () => {
    insertFiler({ id: 'house-tx10-jane-smith', fullName: 'Jane Smith', chamber: 'house', state: 'TX' });
    insertTx('house-tx10-jane-smith', { deprecated: true });

    const body = await getMembers();
    expect(body.members.find((m) => m.filerId === 'house-tx10-jane-smith')).toBeUndefined();
  });

  it('reflects a merged identity as one directory row with combined stats (issue #1452, McCaul pair)', async () => {
    insertFiler({ id: 'house-tx10-michael-t-mccaul', fullName: 'Michael T. McCaul', chamber: 'house', state: 'TX' });
    insertFiler({ id: 'house-tx10-michael-mccaul', fullName: 'Michael McCaul', chamber: 'house', state: 'TX' });
    for (let i = 0; i < 4; i++) insertTx('house-tx10-michael-t-mccaul');
    for (let i = 0; i < 3; i++) insertTx('house-tx10-michael-mccaul');

    // Before the backfill runs: two split rows (the reported bug).
    const before = await getMembers();
    expect(before.members.filter((m) => /mccaul/i.test(m.fullName ?? ''))).toHaveLength(2);

    await dedupeSplitFilerIdentities(env);

    // After: one row, combined count, alias no longer listed.
    const after = await getMembers();
    const mccaulRows = after.members.filter((m) => /mccaul/i.test(m.fullName ?? ''));
    expect(mccaulRows).toHaveLength(1);
    expect(mccaulRows[0].txCount).toBe(7);
    expect(after.members.find((m) => m.filerId === 'house-tx10-michael-mccaul')).toBeUndefined();
  });

  it('carries a photoUrl per row for the iOS People directory avatar (owner punch list #2, item 9)', async () => {
    insertFiler({
      id: 'house-tx10-jane-smith',
      fullName: 'Jane Smith',
      chamber: 'house',
      state: 'TX',
      photoUrl: 'https://example.test/photos/jane-smith.jpg',
    });
    insertFiler({ id: 'house-tx10-no-photo', fullName: 'No Photo', chamber: 'house', state: 'TX' });
    insertTx('house-tx10-jane-smith');
    insertTx('house-tx10-no-photo');

    const body = await getMembers();
    const byId = new Map(body.members.map((m) => [m.filerId, m]));
    expect(byId.get('house-tx10-jane-smith')?.photoUrl).toBe('https://example.test/photos/jane-smith.jpg');
    expect(byId.get('house-tx10-no-photo')?.photoUrl).toBeNull();
  });

  it('carries the stable-cache header', async () => {
    const app = buildRestRouter();
    const res = await app.request('http://localhost/members', {}, env);
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=300');
  });

  it('falls back to the un-hinted query when idx_tx_filer_live does not exist yet (deploy-ordering gap)', async () => {
    insertFiler({ id: 'house-tx10-jane-smith', fullName: 'Jane Smith', chamber: 'house', state: 'TX' });
    insertTx('house-tx10-jane-smith');
    insertTx('house-tx10-jane-smith', { deprecated: true });

    // Simulate migration 0079 not having landed yet: drop the partial index
    // this app's own code deploy could reference before /api/admin/migrate
    // runs (see scripts/ship.sh — migrate runs AFTER deploy is confirmed
    // live). The route must still answer correctly, not 500.
    db.exec('DROP INDEX idx_tx_filer_live');

    const body = await getMembers();
    const row = body.members.find((m) => m.filerId === 'house-tx10-jane-smith');
    expect(row?.txCount).toBe(1); // still excludes the deprecated row
  });

  it('prefers display_name over full_name when both are set (COALESCE switch)', async () => {
    insertFiler({
      id: 'senate-bernie-moreno',
      fullName: 'Bernardo Moreno',
      chamber: 'senate',
      state: 'OH',
      displayName: 'Bernie Moreno',
    });
    insertTx('senate-bernie-moreno');

    const body = await getMembers();
    const row = body.members.find((m) => m.filerId === 'senate-bernie-moreno');
    expect(row?.fullName).toBe('Bernie Moreno');
  });

  it('falls back to full_name when display_name is not set', async () => {
    insertFiler({ id: 'house-tx10-jane-smith', fullName: 'Jane Smith', chamber: 'house', state: 'TX' });
    insertTx('house-tx10-jane-smith');

    const body = await getMembers();
    const row = body.members.find((m) => m.filerId === 'house-tx10-jane-smith');
    expect(row?.fullName).toBe('Jane Smith');
  });

  it('surfaces a curated title for a known executive filer, null for a House/Senate filer', async () => {
    insertFiler({ id: 'EXEC-BESSENT', fullName: 'Scott Bessent', chamber: 'executive', state: 'DC', party: 'R' });
    insertFiler({ id: 'house-tx10-jane-smith', fullName: 'Jane Smith', chamber: 'house', state: 'TX' });
    insertTx('EXEC-BESSENT');
    insertTx('house-tx10-jane-smith');

    const body = await getMembers();
    const byId = new Map(body.members.map((m) => [m.filerId, m]));
    expect(byId.get('EXEC-BESSENT')?.title).toBe('Treasury Secretary');
    expect(byId.get('house-tx10-jane-smith')?.title).toBeNull();
  });

  it('falls back to "Executive Branch" for an EXEC-* filer with no curated title', async () => {
    insertFiler({ id: 'EXEC-UNCURATED-TEST', fullName: 'Some Nominee', chamber: 'executive', state: 'DC' });
    insertTx('EXEC-UNCURATED-TEST');

    const body = await getMembers();
    const row = body.members.find((m) => m.filerId === 'EXEC-UNCURATED-TEST');
    expect(row?.title).toBe('Executive Branch');
  });
});
