import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  describeSubscriptionMembers,
  matchesFilters,
  validateAndResolveSubscriptionFilters,
  validateSubscriptionFilters,
} from '../subscriptions.ts';
import { pickMemberCandidate, type MemberCandidate } from '../rows.ts';
import { openMigratedD1 } from '../../prices/__tests__/sqliteD1.ts';
import type { Env, Subscription, Transaction } from '../../shared/types.ts';

describe('subscription filter validation', () => {
  it('normalizes bounded filters', () => {
    expect(validateSubscriptionFilters({ tickers: ['aapl', 'AAPL'], chambers: ['house'], minAmount: 1000 })).toEqual({
      ok: true, filters: { tickers: ['AAPL'], chambers: ['house'], minAmount: 1000 },
    });
  });
  it('rejects unbounded, invalid, and inverted filters', () => {
    expect(validateSubscriptionFilters({ tickers: Array(51).fill('A') }).ok).toBe(false);
    expect(validateSubscriptionFilters({ sides: ['X'] }).ok).toBe(false);
    expect(validateSubscriptionFilters({ minAmount: 2, maxAmount: 1 }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Board a6058af2: the members filter accepted free-text names on every client
// but matchesFilters compares tx.filerId (a bioguide / filer id), so a
// subscription created with "Nancy Pelosi" could never deliver anything.
// The create/update paths now resolve names to filer ids (or reject them).
// ---------------------------------------------------------------------------

const opened: Array<() => void> = [];
afterEach(() => {
  while (opened.length) opened.pop()!();
});

interface FilerSeed {
  id: string;
  name: string;
  displayName?: string | null;
  mergedInto?: string | null;
  live?: boolean;
}

const FILERS: FilerSeed[] = [
  { id: 'P000197', name: 'Nancy Pelosi', displayName: 'Nancy Pelosi', live: true },
  // Tombstoned alias of the same person (identity dedupe, migration 0078).
  { id: 'house-CA12-nancy-pelosi', name: 'Nancy Pelosi', mergedInto: 'P000197' },
  { id: 'C001047', name: 'Shelley Moore Capito', live: true },
  // Dormant seed duplicate: matches "Capito" too but holds no live trades.
  { id: 'SEED-CAPITO', name: 'Shelley M Capito' },
  { id: 'S000510', name: 'Adam Smith', live: true },
  { id: 'S001195', name: 'Jason Smith', live: true },
  { id: 'EXEC-FRANK-J-BISIGNANO', name: 'Frank J Bisignano', live: true },
];
const TX_ONLY_ID = 'NOFILERROW1';

async function seedEnv(): Promise<Env> {
  const { db, d1, close } = await openMigratedD1();
  opened.push(close);
  const insFiler = db.prepare(
    'INSERT INTO filers (bioguide_id, chamber, full_name, display_name, merged_into) VALUES (?, ?, ?, ?, ?)',
  );
  const insTx = db.prepare(
    `INSERT INTO transactions (
       id, doc_id, filer_id, tx_date, ticker, asset_name, tx_type, source,
       amount_min, amount_max, owner, is_option
     ) VALUES (?, ?, ?, '2026-09-01', 'AAPL', 'Apple', 'B', 'primary', 1001, 15000, 'self', 0)`,
  );
  let n = 0;
  for (const f of FILERS) {
    insFiler.run(f.id, 'house', f.name, f.displayName ?? null, f.mergedInto ?? null);
    if (f.live) {
      n += 1;
      insTx.run(`tx-${n}`, `DOC-${n}`, f.id);
    }
  }
  insTx.run('tx-orphan', 'DOC-ORPHAN', TX_ONLY_ID);
  return { DB: d1 } as unknown as Env;
}

/** An env whose DB throws: proves a code path never touches the database. */
const NO_DB_ENV = {
  DB: {
    prepare() {
      throw new Error('DB must not be queried');
    },
  },
} as unknown as Env;

function membersOf(result: Awaited<ReturnType<typeof validateAndResolveSubscriptionFilters>>): string[] {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.filters.members ?? [];
}

describe('members filter resolves names to filer ids (a6058af2)', () => {
  it('resolves a full name to the filer id that matchesFilters compares against', async () => {
    const env = await seedEnv();
    const result = await validateAndResolveSubscriptionFilters(env, { members: ['Nancy Pelosi'] });
    expect(membersOf(result)).toEqual(['P000197']);
    if (!result.ok) throw new Error('unreachable');
    // The stored filter now matches the trade; the raw name never could.
    // Dates stay relative: the delivery freshness gate treats filings older
    // than DELIVERY_FRESH_WINDOW_DAYS as backfill, so a hardcoded date turns
    // this test stale as the calendar moves.
    const learned = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const tx = {
      filerId: 'P000197',
      txDate: learned.toISOString().slice(0, 10),
      filedDate: learned.toISOString().slice(0, 10),
      firstSeenAt: learned.toISOString(),
      createdAt: learned.toISOString(),
    } as unknown as Transaction;
    expect(matchesFilters(tx, result.filters)).toBe(true);
    expect(matchesFilters(tx, { members: ['Nancy Pelosi'] })).toBe(false);
  });

  it('resolves case-insensitive and unique substring names', async () => {
    const env = await seedEnv();
    expect(membersOf(await validateAndResolveSubscriptionFilters(env, { members: ['pelosi'] }))).toEqual([
      'P000197',
    ]);
    expect(membersOf(await validateAndResolveSubscriptionFilters(env, { members: ['  NANCY PELOSI '] }))).toEqual([
      'P000197',
    ]);
  });

  it('keeps existing filer ids, canonicalizes merged aliases, and accepts tx-only ids', async () => {
    const env = await seedEnv();
    const result = await validateAndResolveSubscriptionFilters(env, {
      members: ['S000510', 'p000197', 'house-CA12-nancy-pelosi', 'EXEC-FRANK-J-BISIGNANO', TX_ONLY_ID],
    });
    expect(membersOf(result)).toEqual([
      'S000510',
      'P000197', // lowercase id, canonical
      // alias id -> canonical, deduped against the entry above
      'EXEC-FRANK-J-BISIGNANO',
      TX_ONLY_ID,
    ]);
  });

  it('dedupes entries that resolve to the same member, mixing names and ids', async () => {
    const env = await seedEnv();
    const result = await validateAndResolveSubscriptionFilters(env, {
      members: ['Nancy Pelosi', 'P000197', 'pelosi'],
    });
    expect(membersOf(result)).toEqual(['P000197']);
  });

  it('prefers the live filer over a dormant duplicate (Capito)', async () => {
    const env = await seedEnv();
    expect(membersOf(await validateAndResolveSubscriptionFilters(env, { members: ['Capito'] }))).toEqual([
      'C001047',
    ]);
  });

  it('rejects unresolvable names with a 400-ready error listing every one', async () => {
    const env = await seedEnv();
    const result = await validateAndResolveSubscriptionFilters(env, {
      members: ['Nancy Pelosii', 'P000197', 'Nobody Here'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('"Nancy Pelosii"');
    expect(result.error).toContain('"Nobody Here"');
    expect(result.error).not.toContain('P000197');
    expect(result.unresolvedMembers).toEqual(['Nancy Pelosii', 'Nobody Here']);
  });

  it('rejects an ambiguous name instead of silently picking one person', async () => {
    const env = await seedEnv();
    const result = await validateAndResolveSubscriptionFilters(env, { members: ['Smith'] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('"Smith" is ambiguous');
    expect(result.error).toContain('Adam Smith (S000510)');
    expect(result.error).toContain('Jason Smith (S001195)');
    expect(result.unresolvedMembers).toEqual(['Smith']);
    // The exact full name is unambiguous.
    expect(membersOf(await validateAndResolveSubscriptionFilters(env, { members: ['Adam Smith'] }))).toEqual([
      'S000510',
    ]);
  });

  it('leaves filters without members untouched and never queries the database', async () => {
    expect(await validateAndResolveSubscriptionFilters(NO_DB_ENV, { tickers: ['aapl'] })).toEqual({
      ok: true,
      filters: { tickers: ['AAPL'] },
    });
    expect(await validateAndResolveSubscriptionFilters(NO_DB_ENV, undefined)).toEqual({ ok: true, filters: {} });
  });

  it('still returns the structural validation errors before touching the database', async () => {
    const result = await validateAndResolveSubscriptionFilters(NO_DB_ENV, {
      members: ['Nancy Pelosi'],
      sides: ['X'],
    });
    expect(result).toEqual({ ok: false, error: 'sides contains an invalid value' });
  });

  it('every non-test caller resolves names: nobody uses the sync validator directly', () => {
    const root = new URL('../../', import.meta.url).pathname;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== '__tests__' && name !== 'node_modules') walk(path);
        } else if (name.endsWith('.ts') && !path.endsWith('delivery/subscriptions.ts')) {
          if (/\bvalidateSubscriptionFilters\s*\(/.test(readFileSync(path, 'utf8'))) offenders.push(path);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe('pickMemberCandidate', () => {
  const c = (filerId: string, over: Partial<MemberCandidate> = {}): MemberCandidate => ({
    filerId,
    name: filerId,
    exact: false,
    live: true,
    ...over,
  });
  it('returns none for no candidates and the sole candidate otherwise', () => {
    expect(pickMemberCandidate([])).toEqual({ kind: 'none' });
    expect(pickMemberCandidate([c('A')])).toEqual({ kind: 'match', filerId: 'A', name: 'A' });
  });
  it('collapses duplicate rows of one canonical filer', () => {
    expect(pickMemberCandidate([c('A', { exact: true }), c('A', { live: false })])).toMatchObject({
      kind: 'match',
      filerId: 'A',
    });
  });
  it('narrows to exact matches, then to live filers, before declaring ambiguity', () => {
    expect(pickMemberCandidate([c('A', { exact: true }), c('B')])).toMatchObject({ kind: 'match', filerId: 'A' });
    expect(pickMemberCandidate([c('A', { live: false }), c('B')])).toMatchObject({ kind: 'match', filerId: 'B' });
    expect(pickMemberCandidate([c('A'), c('B')])).toMatchObject({ kind: 'ambiguous' });
    expect(pickMemberCandidate([c('A', { live: false }), c('B', { live: false })])).toMatchObject({
      kind: 'ambiguous',
    });
  });
});

describe('describeSubscriptionMembers (owner-facing labels + dead legacy entries)', () => {
  const sub = (id: string, members: string[] | undefined): Subscription =>
    ({
      id,
      clientId: 'user:1',
      delivery: 'sse',
      targetUrl: null,
      secret: 'x',
      filters: members ? { members } : {},
      cursor: 0,
      active: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    }) as unknown as Subscription;

  it('labels known ids and flags legacy free-text names that can never match', async () => {
    const env = await seedEnv();
    const info = await describeSubscriptionMembers(env, [
      sub('a', ['P000197', 'Nancy Pelosi', TX_ONLY_ID]),
      sub('b', undefined),
      sub('c', ['house-CA12-nancy-pelosi']),
    ]);
    expect(info.get('a')).toEqual({
      memberLabels: { P000197: 'Nancy Pelosi' },
      unresolvedMembers: ['Nancy Pelosi'],
    });
    expect(info.has('b')).toBe(false);
    // A tombstoned alias id labels through its canonical row.
    expect(info.get('c')).toEqual({
      memberLabels: { 'house-CA12-nancy-pelosi': 'Nancy Pelosi' },
      unresolvedMembers: [],
    });
  });

  it('does not touch the database when no subscription filters by member', async () => {
    const info = await describeSubscriptionMembers(NO_DB_ENV, [sub('a', undefined)]);
    expect(info.size).toBe(0);
  });
});
