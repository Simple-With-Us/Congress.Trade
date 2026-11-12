/**
 * src/delivery/__tests__/memberNameResolution.test.ts
 *
 * GET /transactions?memberName= must resolve the free-text name to a
 * filers.bioguide_id first (indexed t.filer_id keyset path) instead of forcing
 * the un-indexed LOWER(full_name) LIKE full-corpus scan. Unresolved names keep
 * the legacy LIKE fallback so name-less seed rows stay reachable.
 */
import { describe, it, expect } from 'vitest';
import { buildRestRouter } from '../rest.ts';
import { resolveMemberFilerId } from '../rows.ts';
import type { Env } from '../../shared/types.ts';

interface Captured {
  sql: string[];
  filerLookups: number;
}

function makeEnv(opts: { filerId: string | null }): { env: Env; captured: Captured } {
  const captured: Captured = { sql: [], filerLookups: 0 };
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async first<T>() {
      // Matches both the legacy `SELECT bioguide_id FROM filers` and the
      // ranked COALESCE(merged_into, bioguide_id) form that prefers canonical
      // filers with live transactions (dormant-duplicate fix).
      if (/bioguide_id[\s\S]*FROM filers/i.test(sql)) {
        captured.filerLookups += 1;
        return (opts.filerId ? { bioguide_id: opts.filerId } : null) as T | null;
      }
      if (/COUNT/i.test(sql)) return { total: 0 } as T;
      return null as T | null;
    },
    async all<T>() {
      captured.sql.push(sql);
      return { results: [] as T[] };
    },
    async run() {
      return { success: true, meta: { changes: 0 } };
    },
  });
  return { env: { DB: { prepare } as unknown as D1Database } as unknown as Env, captured };
}

describe('resolveMemberFilerId', () => {
  it('returns the bioguide_id for an exact or substring name match', async () => {
    const { env } = makeEnv({ filerId: 'P000197' });
    expect(await resolveMemberFilerId(env, 'pelosi')).toBe('P000197');
  });

  it('returns null for a blank term without hitting the DB', async () => {
    const { env, captured } = makeEnv({ filerId: 'P000197' });
    expect(await resolveMemberFilerId(env, '   ')).toBeNull();
    expect(captured.filerLookups).toBe(0);
  });
});

describe('GET /transactions memberName handling', () => {
  it('resolves memberName to filer_id and takes the indexed keyset path', async () => {
    const { env, captured } = makeEnv({ filerId: 'P000197' });
    const app = buildRestRouter();
    const res = await app.request('http://localhost/transactions?memberName=Pelosi', {}, env);
    expect(res.status).toBe(200);
    const feedSql = captured.sql.find((s) => /FROM transactions/i.test(s)) ?? '';
    expect(captured.filerLookups).toBe(1);
    // Indexed equality filter, not the full-corpus name LIKE.
    expect(feedSql).toContain('t.filer_id = ?');
    expect(feedSql).not.toContain("LOWER(COALESCE(fl.full_name, t.filer_id, '')) LIKE");
    // Nested keyset+LIMIT before the enrichment joins (the fast path).
    // (May still contain fixed-pattern LIKEs for COMPETITOR/EXEC orphan filtering.)
    expect(feedSql).toMatch(/FROM \(SELECT t\.\* FROM transactions t/);
  });

  it('falls back to the legacy LIKE filter when the name resolves to no filer', async () => {
    const { env, captured } = makeEnv({ filerId: null });
    const app = buildRestRouter();
    const res = await app.request('http://localhost/transactions?memberName=Nobody', {}, env);
    expect(res.status).toBe(200);
    const feedSql = captured.sql.find((s) => /FROM transactions/i.test(s)) ?? '';
    expect(feedSql).toContain("LOWER(COALESCE(fl.full_name, t.filer_id, '')) LIKE ?");
    expect(feedSql).toMatch(/FROM \(SELECT t\.\* FROM \(SELECT t\.\*, \(.+\) AS __sort_key FROM transactions t/);
  });

  it('does not look up a filer when member (filer_id) is already given', async () => {
    const { env, captured } = makeEnv({ filerId: 'P000197' });
    const app = buildRestRouter();
    const res = await app.request(
      'http://localhost/transactions?member=M000001&memberName=Pelosi',
      {},
      env,
    );
    expect(res.status).toBe(200);
    expect(captured.filerLookups).toBe(0);
  });
});
