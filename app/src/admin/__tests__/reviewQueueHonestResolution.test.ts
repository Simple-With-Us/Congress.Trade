/**
 * src/admin/__tests__/reviewQueueHonestResolution.test.ts
 *
 * Production incident (2026-08-09): review_queue had 3,497 rows, EVERY ONE
 * resolved=1 (hence the review UI reporting "all done" daily), while 738 of
 * those resolved filings had ZERO live transactions and 180 filings sat at
 * filings.ingest_status='needs_review' despite their queue row claiming
 * resolved. Root cause: autopilot's resolveEmptyDoc() flipped
 * review_queue.resolved=1 for classifier-"empty" docs without ever updating
 * filings.ingest_status and without recording a reason on the row itself.
 *
 * This file exercises the REAL fix end-to-end against a REAL SQLite database
 * migrated with the actual app/migrations/*.sql files (not a hand-rolled
 * regex-sniffing mock) — the same pattern src/admin/__tests__/migrations.test
 * .ts uses. Two things get proven for real, not just asserted in a unit test
 * against a pure function:
 *
 *   1. trg_review_queue_honest_resolution (migration 0082) makes a silent
 *      resolved=1 write structurally impossible — every write path (this
 *      one, and any future one) must record an honest resolution_kind (and a
 *      resolution_reason for verified_empty/rejected) in the SAME statement
 *      that flips resolved=1, or SQLite itself raises ABORT.
 *   2. checkPipelineHealth's review_resolution_integrity check actually
 *      fires against seeded rows shaped exactly like the 738/180 production
 *      rows — not just a hand-fed count into the pure evaluator (see
 *      src/shared/__tests__/pipelineHealth.test.ts for that unit-level
 *      coverage of the evaluator itself).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkPipelineHealth } from '../../shared/pipelineHealth.ts';
import type { Env } from '../../shared/types.ts';

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

async function sqliteDatabase(): Promise<SqliteDatabase> {
  const moduleName = 'node:sqlite';
  const sqlite = (await import(moduleName)) as SqliteModule;
  return new sqlite.DatabaseSync(':memory:');
}

function migrationFiles(): string[] {
  return readdirSync(migrationsUrl as unknown as string).filter((name: string) => name.endsWith('.sql')).sort();
}

function applyMigrationFiles(db: SqliteDatabase, files: string[]): void {
  for (const name of files) {
    db.exec(readFileSync(new URL(name, migrationsUrl) as unknown as string, 'utf8'));
  }
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

async function freshMigratedDb(): Promise<SqliteDatabase> {
  const db = await sqliteDatabase();
  applyMigrationFiles(db, migrationFiles());
  return db;
}

/** Minimal filings + review_queue seed for one doc_id. */
function seedFiling(
  db: SqliteDatabase,
  docId: string,
  opts: { ingestStatus?: string; rawObjectKey?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO filings (doc_id, chamber, filer_id, filing_type, filed_date, source_url, raw_object_key, ingest_status)
     VALUES (?, 'house', NULL, 'P', '2026-08-01', 'https://example.test/' || ?, ?, ?)`,
  ).run(docId, docId, opts.rawObjectKey === undefined ? `raw/${docId}` : opts.rawObjectKey, opts.ingestStatus ?? 'needs_review');
}

function seedUnresolvedReview(db: SqliteDatabase, docId: string): void {
  db.prepare(
    `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved)
     VALUES (?, 'low_confidence', '{}', '2026-08-01T00:00:00.000Z', 0)`,
  ).run(docId);
}

function insertLiveTransaction(db: SqliteDatabase, docId: string, id: string): void {
  db.prepare(
    `INSERT INTO transactions (id, doc_id, source, row_key, tx_date, owner, asset_name, tx_type, created_at)
     VALUES (?, ?, 'primary', ?, '2026-08-01', 'self', 'Example Corp', 'B', '2026-08-01T00:00:00.000Z')`,
  ).run(id, docId, `${id}-rowkey`);
}

describe('trg_review_queue_honest_resolution (migration 0082, real SQLite)', () => {
  it('aborts a bare resolved=1 with no resolution_kind', async () => {
    const db = await freshMigratedDb();
    try {
      seedFiling(db, 'H-bare');
      seedUnresolvedReview(db, 'H-bare');
      expect(() => db.prepare('UPDATE review_queue SET resolved = 1 WHERE doc_id = ?').run('H-bare'))
        .toThrow(/honest resolution_kind/);
    } finally {
      db.close();
    }
  });

  it('aborts an unrecognized resolution_kind', async () => {
    const db = await freshMigratedDb();
    try {
      seedFiling(db, 'H-bogus');
      seedUnresolvedReview(db, 'H-bogus');
      expect(() => db.prepare(
        `UPDATE review_queue SET resolved = 1, resolution_kind = 'made_up' WHERE doc_id = ?`,
      ).run('H-bogus')).toThrow(/honest resolution_kind/);
    } finally {
      db.close();
    }
  });

  it('aborts verified_empty / rejected with a blank resolution_reason', async () => {
    const db = await freshMigratedDb();
    try {
      seedFiling(db, 'H-empty-blank');
      seedUnresolvedReview(db, 'H-empty-blank');
      expect(() => db.prepare(
        `UPDATE review_queue SET resolved = 1, resolution_kind = 'verified_empty' WHERE doc_id = ?`,
      ).run('H-empty-blank')).toThrow(/honest resolution_kind/);
      expect(() => db.prepare(
        `UPDATE review_queue SET resolved = 1, resolution_kind = 'verified_empty', resolution_reason = '   ' WHERE doc_id = ?`,
      ).run('H-empty-blank')).toThrow(/honest resolution_kind/);

      seedFiling(db, 'H-reject-blank');
      seedUnresolvedReview(db, 'H-reject-blank');
      expect(() => db.prepare(
        `UPDATE review_queue SET resolved = 1, resolution_kind = 'rejected' WHERE doc_id = ?`,
      ).run('H-reject-blank')).toThrow(/honest resolution_kind/);
    } finally {
      db.close();
    }
  });

  it('aborts resolution_kind=published with zero live transactions — cannot resolve without transactions or a recorded empty-reason', async () => {
    const db = await freshMigratedDb();
    try {
      seedFiling(db, 'H-published-empty');
      seedUnresolvedReview(db, 'H-published-empty');
      expect(() => db.prepare(
        `UPDATE review_queue SET resolved = 1, resolution_kind = 'published', resolution_reason = 'auto_published' WHERE doc_id = ?`,
      ).run('H-published-empty')).toThrow(/honest resolution_kind/);
    } finally {
      db.close();
    }
  });

  it('allows resolution_kind=published once a live transaction exists', async () => {
    const db = await freshMigratedDb();
    try {
      seedFiling(db, 'H-published-ok');
      seedUnresolvedReview(db, 'H-published-ok');
      insertLiveTransaction(db, 'H-published-ok', 'tx-1');
      expect(() => db.prepare(
        `UPDATE review_queue SET resolved = 1, resolution_kind = 'published', resolution_reason = 'auto_published' WHERE doc_id = ?`,
      ).run('H-published-ok')).not.toThrow();
      const row = db.prepare('SELECT resolved, resolution_kind, resolution_reason FROM review_queue WHERE doc_id = ?').get('H-published-ok');
      expect(row).toMatchObject({ resolved: 1, resolution_kind: 'published', resolution_reason: 'auto_published' });
    } finally {
      db.close();
    }
  });

  it('allows resolution_kind=verified_empty with a non-blank reason — the verified-empty path records its reason', async () => {
    const db = await freshMigratedDb();
    try {
      seedFiling(db, 'H-empty-ok');
      seedUnresolvedReview(db, 'H-empty-ok');
      expect(() => db.prepare(
        `UPDATE review_queue
            SET resolved = 1, resolution_kind = 'verified_empty',
                resolution_reason = 'doc_class_empty_no_transactions', resolved_at = CURRENT_TIMESTAMP
          WHERE doc_id = ?`,
      ).run('H-empty-ok')).not.toThrow();
      const row = db.prepare(
        'SELECT resolved, resolution_kind, resolution_reason, resolved_at FROM review_queue WHERE doc_id = ?',
      ).get('H-empty-ok');
      expect(row?.resolved).toBe(1);
      expect(row?.resolution_kind).toBe('verified_empty');
      expect(row?.resolution_reason).toBe('doc_class_empty_no_transactions');
      expect(row?.resolved_at).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it('allows resolution_kind=rejected with a reason, and orphan_deleted without one', async () => {
    const db = await freshMigratedDb();
    try {
      seedFiling(db, 'H-rejected-ok');
      seedUnresolvedReview(db, 'H-rejected-ok');
      expect(() => db.prepare(
        `UPDATE review_queue SET resolved = 1, resolution_kind = 'rejected', resolution_reason = 'rejected: bad extraction' WHERE doc_id = ?`,
      ).run('H-rejected-ok')).not.toThrow();

      seedUnresolvedReview(db, 'H-orphan-ok');
      expect(() => db.prepare(
        `UPDATE review_queue SET resolved = 1, resolution_kind = 'orphan_deleted' WHERE doc_id = ?`,
      ).run('H-orphan-ok')).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe('resolveEmptyDoc write shape (autopilot.ts) against the real trigger', () => {
  it('the exact statement pair resolveEmptyDoc issues satisfies the trigger and moves filings off needs_review atomically', async () => {
    const db = await freshMigratedDb();
    try {
      seedFiling(db, 'H-autopilot-empty', { ingestStatus: 'needs_review' });
      seedUnresolvedReview(db, 'H-autopilot-empty');

      // Mirrors autopilot.ts resolveEmptyDoc()'s two-statement batch exactly.
      db.exec('BEGIN');
      db.prepare(
        `UPDATE review_queue
            SET resolved = 1, agreement_next_attempt_at = NULL,
                agreement_claim_token = NULL, agreement_claimed_at = NULL,
                resolution_kind = 'verified_empty',
                resolution_reason = 'doc_class_empty_no_transactions',
                resolved_at = CURRENT_TIMESTAMP,
                review_revision = review_revision + 1
          WHERE doc_id = ? AND resolved = 0 AND agreement_suppressed_at IS NULL
            AND (agreement_claim_token IS NULL OR agreement_claimed_at IS NULL OR agreement_claimed_at <= ?)`,
      ).run('H-autopilot-empty', '1970-01-01T00:00:00.000Z');
      db.prepare(
        `UPDATE filings
            SET ingest_status = 'verified_empty', error = NULL
          WHERE doc_id = ?
            AND ingest_status <> 'persisted'
            AND NOT EXISTS (SELECT 1 FROM transactions WHERE doc_id = ? AND deprecated_at IS NULL)
            AND EXISTS (
              SELECT 1 FROM review_queue
               WHERE doc_id = ? AND resolved = 1 AND resolution_kind = 'verified_empty'
            )`,
      ).run('H-autopilot-empty', 'H-autopilot-empty', 'H-autopilot-empty');
      db.exec('COMMIT');

      const review = db.prepare(
        'SELECT resolved, resolution_kind, resolution_reason FROM review_queue WHERE doc_id = ?',
      ).get('H-autopilot-empty');
      expect(review).toMatchObject({
        resolved: 1,
        resolution_kind: 'verified_empty',
        resolution_reason: 'doc_class_empty_no_transactions',
      });
      const filing = db.prepare('SELECT ingest_status FROM filings WHERE doc_id = ?').get('H-autopilot-empty');
      // The production bug: this used to stay 'needs_review' forever.
      expect(filing?.ingest_status).toBe('verified_empty');
    } finally {
      db.close();
    }
  });
});

describe('checkPipelineHealth review_resolution_integrity — fires on seeded 738/180-style rows', () => {
  it('reports ok on a clean, fully-migrated database', async () => {
    const db = await freshMigratedDb();
    try {
      const env = { DB: d1Database(db) } as unknown as Env;
      const health = await checkPipelineHealth(env);
      const check = health.checks.find((c) => c.id === 'review_resolution_integrity');
      expect(check?.status).toBe('ok');
      expect(check?.value).toBe(0);
    } finally {
      db.close();
    }
  });

  it('fires when a legacy row is resolved=1 with no resolution_kind (the 738 case) — seeded directly via INSERT, bypassing the UPDATE trigger, exactly as the pre-migration production rows exist today', async () => {
    const db = await freshMigratedDb();
    try {
      // Direct INSERT with resolved=1 does not touch the `resolved` column via
      // UPDATE, so trg_review_queue_honest_resolution (BEFORE UPDATE OF
      // resolved) never fires — this is deliberate: it reproduces exactly how
      // the real 738 production rows exist post-migration (written before the
      // trigger existed, left resolution_kind NULL by the backfill because
      // neither honest condition holds), not a contrived way to fake the count.
      seedFiling(db, 'H-legacy-bad', { ingestStatus: 'needs_review' });
      db.prepare(
        `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved)
         VALUES ('H-legacy-bad', 'doc_class_empty_no_transactions', '{}', '2026-07-01T00:00:00.000Z', 1)`,
      ).run();

      const env = { DB: d1Database(db) } as unknown as Env;
      const health = await checkPipelineHealth(env);
      const check = health.checks.find((c) => c.id === 'review_resolution_integrity');
      expect(check?.status).toBe('degraded');
      expect(check?.detail).toContain('1 review item(s) resolved with no recorded resolution reason');
      expect(health.status).not.toBe('ok');
    } finally {
      db.close();
    }
  });

  it('fires when a needs_review filing has no open (resolved=0) review-queue row (the 180 case)', async () => {
    const db = await freshMigratedDb();
    try {
      seedFiling(db, 'H-orphan-status', { ingestStatus: 'needs_review' });
      // Its queue row exists but is already resolved — exactly the reported
      // "180 filings sit at needs_review yet 0 of them lack a review_queue
      // row" shape: the row is there, it's just claiming resolved.
      db.prepare(
        `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved, resolution_kind, resolution_reason, resolved_at)
         VALUES ('H-orphan-status', 'low_confidence', '{}', '2026-07-01T00:00:00.000Z', 1, 'rejected', 'rejected: stale', '2026-07-01T00:00:00.000Z')`,
      ).run();

      const env = { DB: d1Database(db) } as unknown as Env;
      const health = await checkPipelineHealth(env);
      const check = health.checks.find((c) => c.id === 'review_resolution_integrity');
      expect(check?.status).toBe('degraded');
      expect(check?.detail).toContain('1 filing(s) marked needs_review with no open review-queue row');
    } finally {
      db.close();
    }
  });

  it('does not flag a filing whose transactions were superseded by a later amendment (resolution_kind=published, zero live tx is expected there)', async () => {
    const db = await freshMigratedDb();
    try {
      // Original filing: published, then all its transactions deprecated
      // because an amendment superseded it — a normal, frequent, correct
      // state, not the bug. It must not show up as dishonest.
      seedFiling(db, 'H-superseded', { ingestStatus: 'persisted' });
      db.prepare(
        `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved, resolution_kind, resolution_reason, resolved_at)
         VALUES ('H-superseded', 'low_confidence', '{}', '2026-07-01T00:00:00.000Z', 1, 'published', 'auto_published', '2026-07-01T00:00:00.000Z')`,
      ).run();
      db.prepare(
        `INSERT INTO transactions (id, doc_id, source, row_key, tx_date, owner, asset_name, tx_type, created_at, deprecated_at, deprecated_reason)
         VALUES ('tx-superseded', 'H-superseded', 'primary', 'tx-superseded-rowkey', '2026-06-01', 'self', 'Example Corp', 'B', '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 'superseded by amendment')`,
      ).run();

      const env = { DB: d1Database(db) } as unknown as Env;
      const health = await checkPipelineHealth(env);
      const check = health.checks.find((c) => c.id === 'review_resolution_integrity');
      expect(check?.status).toBe('ok');
      expect(check?.value).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('checkPipelineHealth filing_skips counts a rejected unreadable 278-T (board 5235c003)', () => {
  function insertDecision(
    db: SqliteDatabase,
    id: string,
    docId: string,
    action: string,
    reason: string,
    createdAt: string,
  ): void {
    db.prepare(
      `INSERT INTO ingestion_decisions (id, doc_id, action, source, reason, created_at)
       VALUES (?, ?, ?, 'pipeline', ?, ?)`,
    ).run(id, docId, action, reason, createdAt);
  }

  it('counts rejected + oge_text_unreadable inside 24h, names the doc once, and leaves an older row out', async () => {
    const db = await freshMigratedDb();
    try {
      const recent = new Date(Date.now() - 60_000).toISOString();
      const older = new Date(Date.now() - 48 * 3600_000).toISOString();
      insertDecision(db, 'd1', 'E-2026-donald-j-trump-09-17-2026-278t', 'oge_text_unreadable', 'oge_text_unreadable', recent);
      insertDecision(db, 'd2', 'E-2026-donald-j-trump-09-17-2026-278t', 'oge_text_unreadable', 'oge_text_unreadable', recent);
      insertDecision(db, 'd3', 'E-undated-pam-bondi-2026-278term', 'auto_resolved_empty', 'oge_part7_explicit_none', recent);
      insertDecision(db, 'd4', 'E-other-reject', 'rejected', 'some_other_reason', recent);
      insertDecision(db, 'd5', 'E-2026-donald-j-trump-09-8-2026-278t', 'oge_text_unreadable', 'oge_text_unreadable', older);

      const env = { DB: d1Database(db) } as unknown as Env;
      const health = await checkPipelineHealth(env);
      const check = health.checks.find((c) => c.id === 'filing_skips');
      expect(check?.status).toBe('critical');
      expect(health.signals?.filingSkips24h).toBe(3);
      expect(health.signals?.filingSkipsByAction24h).toMatchObject({
        extract_empty_failure: 0,
        auto_resolved_empty: 1,
        doc_quarantined: 0,
        oge_text_unreadable: 2,
      });
      expect(health.signals?.unreadableExecutiveDocIds).toEqual(['E-2026-donald-j-trump-09-17-2026-278t']);
      expect(check?.detail).toContain('E-2026-donald-j-trump-09-17-2026-278t');
      expect(check?.detail).not.toContain('E-2026-donald-j-trump-09-8-2026-278t');
      expect(check?.detail).not.toContain('E-other-reject');
          } finally {
      db.close();
    }
  });

  it('does not name a doc or mention reopen when the only skip is explicit-None', async () => {
    const db = await freshMigratedDb();
    try {
      const recent = new Date(Date.now() - 60_000).toISOString();
      insertDecision(db, 'd-empty', 'E-undated-pam-bondi-2026-278term', 'auto_resolved_empty', 'oge_part7_explicit_none', recent);
      const env = { DB: d1Database(db) } as unknown as Env;
      const health = await checkPipelineHealth(env);
      const check = health.checks.find((c) => c.id === 'filing_skips');
      expect(check?.status).toBe('critical');
      expect(health.signals?.filingSkipsByAction24h?.oge_text_unreadable).toBe(0);
      expect(health.signals?.filingSkipsByAction24h?.auto_resolved_empty).toBe(1);
      expect(check?.detail).not.toContain('Unreadable docs');
          } finally {
      db.close();
    }
  });
});
