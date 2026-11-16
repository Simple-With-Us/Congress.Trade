/**
 * src/shared/__tests__/pipelineHealthUnreadableDocs.test.ts
 *
 * Collection-level coverage for the unreadable 278-T doc naming added by the
 * salvage-278t-signal branch and the kody-review fixes on top of it. Runs
 * checkPipelineHealth against a REAL SQLite database migrated with the actual
 * app/migrations/*.sql files (same pattern as
 * src/admin/__tests__/reviewQueueHonestResolution.test.ts), seeded with
 * ingestion_decisions rows, and proves:
 *
 *   1. Named ids are ordered by failure recency (MAX(created_at) per doc,
 *      descending) — not alphabetically by doc_id — so a just-failed filing
 *      is never crowded out by alphabetically early ids, and duplicate
 *      unreadable decisions for one doc collapse to a single entry.
 *   2. signals.unreadableExecutiveDocCount counts DISTINCT unreadable docs,
 *      not decision rows.
 *   3. includeUnreadableDocIds: false (the public /health cache mode)
 *      withholds the raw ids and the "Unreadable docs:" detail naming while
 *      still surfacing the count; the default (operator-private) mode keeps
 *      the names.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkPipelineHealth } from '../pipelineHealth.ts';
import type { Env } from '../types.ts';

interface SqliteRunResult {
  changes: number | bigint;
}
interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
  run(...params: unknown[]): SqliteRunResult;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

const migrationsUrl = new URL('../../../migrations/', (import.meta as ImportMeta & { url: string }).url);

async function freshMigratedDb(): Promise<SqliteDatabase> {
  const moduleName = 'node:sqlite';
  const sqlite = (await import(moduleName)) as SqliteModule;
  const db = new sqlite.DatabaseSync(':memory:');
  const files = readdirSync(migrationsUrl as unknown as string).filter((name) => name.endsWith('.sql')).sort();
  for (const name of files) {
    db.exec(readFileSync(new URL(name, migrationsUrl) as unknown as string, 'utf8'));
  }
  return db;
}

function d1Database(db: SqliteDatabase): Env['DB'] {
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        params = values;
        return statement;
      },
      async first<T>() {
        return (db.prepare(sql).get(...params) ?? null) as T | null;
      },
      async run() {
        const result = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(result.changes) } } as unknown;
      },
      async all<T>() {
        return { results: db.prepare(sql).all(...params) as T[] };
      },
    };
    return statement;
  };
  return { prepare } as unknown as Env['DB'];
}

function hoursAgoIso(hours: number, now: Date): string {
  return new Date(now.getTime() - hours * 3_600_000).toISOString();
}

let seq = 0;
function seedDecision(db: SqliteDatabase, docId: string, action: string, createdAt: string): void {
  seq += 1;
  db.prepare(
    `INSERT INTO ingestion_decisions (id, doc_id, action, source, actor, reason, payload, created_at)
     VALUES (?, ?, ?, 'test', 'test', NULL, '{}', ?)`,
  ).run(`dec-${seq}`, docId, action, createdAt);
}

/** Six distinct unreadable docs, named so alphabetical order disagrees with
 *  recency order, plus a duplicate decision, a stale row, and a different
 *  action. Recency: zzz(1h) > aaa(3h) > mmm(5h) > bbb(7h) > yyy(9h) > ccc(11h). */
function seedUnreadableDocs(db: SqliteDatabase, now: Date): void {
  seedDecision(db, 'E-zzz', 'oge_text_unreadable', hoursAgoIso(1, now));
  seedDecision(db, 'E-aaa', 'oge_text_unreadable', hoursAgoIso(3, now));
  seedDecision(db, 'E-aaa', 'oge_text_unreadable', hoursAgoIso(9, now)); // duplicate decision, same doc
  seedDecision(db, 'E-mmm', 'oge_text_unreadable', hoursAgoIso(5, now));
  seedDecision(db, 'E-bbb', 'oge_text_unreadable', hoursAgoIso(7, now));
  seedDecision(db, 'E-yyy', 'oge_text_unreadable', hoursAgoIso(9, now));
  seedDecision(db, 'E-ccc', 'oge_text_unreadable', hoursAgoIso(11, now));
  seedDecision(db, 'E-stale', 'oge_text_unreadable', hoursAgoIso(30, now)); // outside the 24h window
  seedDecision(db, 'E-other', 'extract_empty_failure', hoursAgoIso(2, now)); // different action
}

describe('checkPipelineHealth unreadable 278-T doc naming (real SQLite)', () => {
  it('orders named ids by failure recency, collapses duplicates, and limits to five', async () => {
    const db = await freshMigratedDb();
    try {
      const now = new Date();
      seedUnreadableDocs(db, now);
      const env = { DB: d1Database(db) } as unknown as Env;
      const health = await checkPipelineHealth(env, now);
      // Recency order, not alphabetical (alphabetical would start E-aaa, E-bbb, E-ccc).
      expect(health.signals?.unreadableExecutiveDocIds).toEqual(['E-zzz', 'E-aaa', 'E-mmm', 'E-bbb', 'E-yyy']);
      // DISTINCT docs (6), not decision rows (7) and not the capped id list (5).
      expect(health.signals?.unreadableExecutiveDocCount).toBe(6);
      const filingSkips = health.checks.find((c) => c.id === 'filing_skips');
      expect(filingSkips?.status).toBe('critical');
      expect(String(filingSkips?.detail)).toContain('Unreadable docs: E-zzz');
    } finally {
      db.close();
    }
  });

  it('withholds raw ids and detail naming when includeUnreadableDocIds is false, but keeps the count', async () => {
    const db = await freshMigratedDb();
    try {
      const now = new Date();
      seedUnreadableDocs(db, now);
      const env = { DB: d1Database(db) } as unknown as Env;
      const health = await checkPipelineHealth(env, now, {}, { includeUnreadableDocIds: false });
      expect(health.signals?.unreadableExecutiveDocIds ?? null).toBeNull();
      expect(health.signals?.unreadableExecutiveDocCount).toBe(6);
      const filingSkips = health.checks.find((c) => c.id === 'filing_skips');
      expect(filingSkips?.status).toBe('critical');
      expect(String(filingSkips?.detail)).not.toContain('Unreadable docs:');
      expect(String(filingSkips?.detail)).not.toContain('E-zzz');
      // The count breakdown by action is not sensitive and stays public.
      expect(String(filingSkips?.detail)).toContain('oge_text_unreadable=7');
    } finally {
      db.close();
    }
  });
});
