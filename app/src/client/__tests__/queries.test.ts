/**
 * src/client/__tests__/queries.test.ts
 *
 * Query-construction tests for client/queries.ts that don't need the full
 * routes.test.ts DB emulation — records the SQL + bound params passed to
 * D1 rather than emulating query results.
 */
import { describe, expect, it } from 'vitest';
import { resolveMember } from '../queries.ts';
import type { Env } from '../../shared/types.ts';

interface RecordedCall {
  sql: string;
  params: unknown[];
}

/** A DB fake that records every prepared statement's SQL + bound params and
 * always resolves reads to "not found" — enough to exercise resolveMember's
 * query construction without needing to emulate SQLite LIKE semantics. */
function recordingEnv(): { env: Env; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async first<T>() {
      calls.push({ sql, params: this.params });
      return null as T | null;
    },
  });
  const env = { DB: { prepare } as unknown as D1Database } as unknown as Env;
  return { env, calls };
}

describe('resolveMember', () => {
  it('escapes LIKE metacharacters in the fuzzy full-name search so they are treated literally', async () => {
    const { env, calls } = recordingEnv();
    const result = await resolveMember(env, 'A_B%C');
    // '%' disqualifies the raw-bioguide-id fallback too, so an all-null DB
    // correctly reports "not found" rather than fabricating an id.
    expect(result).toBeNull();

    expect(calls.some((c) => /resolved_bioguide_id/i.test(c.sql))).toBe(true);
    const byName = calls.find((c) => /LOWER\(full_name\) LIKE/i.test(c.sql));
    expect(byName).toBeDefined();
    // ESCAPE '\' must be declared in the SQL for the escaped param to work.
    expect(byName!.sql).toContain("ESCAPE '\\'");
    // The literal '_' and '%' in the caller's search term must be
    // backslash-escaped in the bound LIKE param — otherwise '_' matches any
    // single character and '%' matches any run of characters, silently
    // broadening the search far beyond what the caller typed.
    expect(byName!.params[1]).toBe('%a\\_b\\%c%');
  });

  it('leaves an ordinary name search unescaped (no false-positive mangling)', async () => {
    const { env, calls } = recordingEnv();
    await resolveMember(env, 'Pelosi');
    const byName = calls.find((c) => /LOWER\(full_name\) LIKE/i.test(c.sql));
    expect(byName).toBeDefined();
    // Matches both full_name and display_name (the curated "campaign sign"
    // preferred name) so a search by either name resolves the filer — see
    // resolveMember's byName query in client/queries.ts.
    expect(byName!.sql).toContain('LOWER(display_name) LIKE');
    expect(byName!.params).toEqual(['Pelosi', '%pelosi%', 'Pelosi', '%pelosi%', 'Pelosi', 'Pelosi']);
  });

  it('resolves an official bioguide to the canonical filer slug via resolved_bioguide_id', async () => {
    const khanna = {
      bioguide_id: 'house-ca17-ro-khanna',
      chamber: 'house',
      full_name: 'Ro Khanna',
      party: 'Democrat',
      state: 'CA',
      district: '17',
      committees: '[]',
      photo_url: 'https://congress.trade/api/photos/member?key=K000389',
      resolved_bioguide_id: 'K000389',
    };
    const calls: string[] = [];
    const prepare = (sql: string) => ({
      bind() {
        return this;
      },
      async first<T>() {
        calls.push(sql);
        if (/resolved_bioguide_id/i.test(sql) && !/LOWER\(full_name\)/i.test(sql)) {
          return khanna as T;
        }
        return null as T | null;
      },
    });
    const env = { DB: { prepare } as unknown as D1Database } as unknown as Env;
    const result = await resolveMember(env, 'K000389');
    expect(result?.id).toBe('house-ca17-ro-khanna');
    expect(result?.profile?.photo_url).toContain('key=K000389');
    expect(calls.some((sql) => /resolved_bioguide_id/i.test(sql))).toBe(true);
  });
});
