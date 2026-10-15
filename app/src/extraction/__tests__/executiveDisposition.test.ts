import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { maybeRunAgreementAutopublish, settledZeroReadResult } from '../agreement.ts';
import {
  BONDI_EMPTY_DOC_ID,
  closeUnreadableExecutive,
  closeVerifiedEmptyExecutive,
  sweepAutoRejectedUnreadable,
  sweepKnownParkedExecutiveTerminals,
  TRUMP_UNREADABLE_DOC_ID,
} from '../executiveDisposition.ts';

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

// Capped-recovery tests drive the executive classifier directly; every other
// test runs the real implementation.
const classifyOverride = vi.hoisted(() => ({
  fn: null as null | ((bytes: ArrayBuffer, docId: string) => Promise<unknown>),
}));
vi.mock('../ogeText.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ogeText.ts')>();
  return {
    ...actual,
    classifyExecutivePdfBytes: (bytes: ArrayBuffer, docId: string) =>
      classifyOverride.fn ? classifyOverride.fn(bytes, docId) : actual.classifyExecutivePdfBytes(bytes, docId),
  };
});

// CAS-loss tests stub normalize()'s result; every other test runs the real
// implementation.
const normalizeOverride = vi.hoisted(() => ({
  fn: null as null | ((...args: unknown[]) => Promise<unknown>),
}));
vi.mock('../normalizer.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../normalizer.ts')>();
  return {
    ...actual,
    normalize: (...args: unknown[]) =>
      normalizeOverride.fn
        ? normalizeOverride.fn(...args)
        : (actual.normalize as (...a: unknown[]) => Promise<unknown>)(...args),
  };
});

let openDatabase: SqliteDatabase | null = null;

async function sqliteDatabase(): Promise<SqliteDatabase> {
  const sqlite = await import('node:sqlite') as SqliteModule;
  const db = new sqlite.DatabaseSync(':memory:');
  openDatabase = db;
  db.exec(`
    CREATE TABLE filings (
      doc_id TEXT PRIMARY KEY,
      chamber TEXT,
      ingest_status TEXT,
      error TEXT,
      doc_kind TEXT,
      raw_object_key TEXT,
      extractor TEXT,
      filer_id TEXT,
      filing_type TEXT,
      filed_date TEXT,
      source_url TEXT,
      model_version TEXT,
      confidence REAL,
      first_seen_at TEXT,
      source_updated_at TEXT
    );
    CREATE TABLE review_queue (
      doc_id TEXT PRIMARY KEY,
      reason TEXT,
      payload TEXT,
      created_at TEXT,
      resolved INTEGER,
      agreement_attempts INTEGER,
      agreement_tier INTEGER,
      agreement_claim_token TEXT,
      agreement_claimed_at TEXT,
      agreement_suppressed_at TEXT,
      agreement_next_attempt_at TEXT,
      review_revision INTEGER NOT NULL DEFAULT 1,
      resolution_kind TEXT,
      resolution_reason TEXT,
      resolved_at TEXT
    );
    CREATE TABLE transactions (
      doc_id TEXT,
      source TEXT,
      deprecated_at TEXT
    );
    CREATE TABLE extraction_runs (
      doc_id TEXT,
      batch_id TEXT,
      provider TEXT,
      model TEXT,
      ok INTEGER,
      row_count INTEGER,
      kind TEXT,
      result_json TEXT
    );
    CREATE TABLE securities_master (
      ticker TEXT,
      name TEXT,
      aliases TEXT
    );
    CREATE TABLE ingestion_decisions (
      id TEXT PRIMARY KEY,
      doc_id TEXT,
      action TEXT,
      source TEXT,
      actor TEXT,
      reason TEXT,
      payload TEXT,
      transaction_ids TEXT,
      created_at TEXT
    );
    CREATE TRIGGER trg_review_queue_honest_resolution
    BEFORE UPDATE OF resolved ON review_queue
    WHEN NEW.resolved = 1 AND (
      NEW.resolution_kind IS NULL
      OR NEW.resolution_kind NOT IN ('published', 'verified_empty', 'rejected', 'orphan_deleted')
      OR (
        NEW.resolution_kind IN ('verified_empty', 'rejected')
        AND (NEW.resolution_reason IS NULL OR TRIM(NEW.resolution_reason) = '')
      )
      OR (
        NEW.resolution_kind = 'published'
        AND NOT EXISTS (
          SELECT 1 FROM transactions WHERE doc_id = NEW.doc_id AND deprecated_at IS NULL
        )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'honest resolution required');
    END;
  `);
  return db;
}

function d1Database(db: SqliteDatabase): D1Database {
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          params = values;
          return this;
        },
        async first<T>() {
          return (db.prepare(sql).get(...params) ?? null) as T | null;
        },
        async run() {
          const result = db.prepare(sql).run(...params);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
        async all<T>() {
          return { results: db.prepare(sql).all(...params) as T[] };
        },
      };
    },
  } as unknown as D1Database;
}

function envFor(db: SqliteDatabase): Env {
  return {
    DB: d1Database(db),
    AGREEMENT_AUTOPUBLISH_ENABLED: 'true',
    AGREEMENT_MAX_ATTEMPTS: '3',
    INGEST_QUEUE: { send: async () => {} },
  } as unknown as Env;
}

function seedReview(
  db: SqliteDatabase,
  docId: string,
  reason: string,
  attempts = 3,
): void {
  db.prepare(
    `INSERT INTO filings (doc_id, chamber, ingest_status, doc_kind, extractor)
     VALUES (?, 'executive', 'needs_review', 'text_pdf', 'ogeText')`,
  ).run(docId);
  db.prepare(
    `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved, agreement_attempts, review_revision)
     VALUES (?, ?, '{}', '2026-09-01T00:00:00.000Z', 0, ?, 1)`,
  ).run(docId, reason, attempts);
}

afterEach(() => {
  classifyOverride.fn = null;
  normalizeOverride.fn = null;
  openDatabase?.close();
  openDatabase = null;
});

describe('sweepKnownParkedExecutiveTerminals', () => {
  it('closes Bondi as verified_empty and parks Trump as unreadable, then no-ops', async () => {
    const db = await sqliteDatabase();
    seedReview(db, BONDI_EMPTY_DOC_ID, 'agreement_cascade_unresolved');
    seedReview(db, TRUMP_UNREADABLE_DOC_ID, 'agreement_cascade_unresolved');
    seedReview(db, 'E-other-still-open', 'agreement_cascade_unresolved');
    const env = envFor(db);

    const first = await sweepKnownParkedExecutiveTerminals(env);
    expect(first).toEqual({ verifiedEmpty: 1, unreadable: 1 });

    const bondi = db.prepare(
      `SELECT rq.resolved, rq.resolution_kind, rq.resolution_reason, f.ingest_status, f.error
         FROM review_queue rq JOIN filings f ON f.doc_id = rq.doc_id
        WHERE rq.doc_id = ?`,
    ).get(BONDI_EMPTY_DOC_ID) as Record<string, unknown>;
    expect(bondi).toMatchObject({
      resolved: 1,
      resolution_kind: 'verified_empty',
      resolution_reason: 'executive_278e_no_transactions',
      ingest_status: 'verified_empty',
      error: null,
    });

    const trump = db.prepare(
      `SELECT rq.resolved, rq.resolution_kind, rq.resolution_reason, rq.reason, f.ingest_status
         FROM review_queue rq JOIN filings f ON f.doc_id = rq.doc_id
        WHERE rq.doc_id = ?`,
    ).get(TRUMP_UNREADABLE_DOC_ID) as Record<string, unknown>;
    expect(trump).toMatchObject({
      resolved: 0,
      resolution_kind: null,
      resolution_reason: null,
      ingest_status: 'needs_review',
    });
    expect(String(trump.reason)).toContain('ocr_unusable');
    expect(String(trump.reason)).toContain('oge_text_unreadable');

    const other = db.prepare(`SELECT resolved, reason FROM review_queue WHERE doc_id = ?`)
      .get('E-other-still-open') as { resolved: number; reason: string };
    expect(other).toMatchObject({ resolved: 0, reason: 'agreement_cascade_unresolved' });

    const decisions = db.prepare(`SELECT doc_id, action, reason FROM ingestion_decisions`)
      .all() as Array<{ doc_id: string; action: string; reason: string }>;
    expect(decisions).toEqual(expect.arrayContaining([
      { doc_id: BONDI_EMPTY_DOC_ID, action: 'auto_resolved_empty', reason: 'executive_278e_no_transactions' },
      { doc_id: TRUMP_UNREADABLE_DOC_ID, action: 'oge_text_unreadable', reason: 'oge_text_unreadable' },
    ]));
    expect(decisions).toHaveLength(2);

    const second = await sweepKnownParkedExecutiveTerminals(env);
    expect(second).toEqual({ verifiedEmpty: 0, unreadable: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ingestion_decisions`).get()).toEqual({ n: 2 });
  });

  it('leaves an operator retry-auto row alone (no re-close without re-reading the PDF)', async () => {
    const db = await sqliteDatabase();
    // retry-auto rewrites the reason and clears suppression; the corrective
    // sweep must only correct rows still carrying the legacy parked reason.
    seedReview(db, BONDI_EMPTY_DOC_ID, 'auto_retry_requested: extract_empty_failure');
    seedReview(db, TRUMP_UNREADABLE_DOC_ID, 'auto_retry_requested: extract_empty_failure');

    const result = await sweepKnownParkedExecutiveTerminals(envFor(db));
    expect(result).toEqual({ verifiedEmpty: 0, unreadable: 0 });
    const rows = db.prepare(`SELECT resolved, reason FROM review_queue ORDER BY doc_id`)
      .all() as Array<{ resolved: number; reason: string }>;
    expect(rows.every((row) => row.resolved === 0)).toBe(true);
    expect(rows.every((row) => row.reason.startsWith('auto_retry_requested'))).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ingestion_decisions`).get()).toEqual({ n: 0 });
  });

  it('does not verified_empty a doc that already has a successful non-empty read or live rows', async () => {
    const db = await sqliteDatabase();
    seedReview(db, BONDI_EMPTY_DOC_ID, 'extract_empty_failure');
    seedReview(db, TRUMP_UNREADABLE_DOC_ID, 'agreement_cascade_unresolved');
    db.prepare(
      `INSERT INTO extraction_runs (doc_id, ok, row_count, result_json) VALUES (?, 1, 472, '[{}]')`,
    ).run(BONDI_EMPTY_DOC_ID);
    db.prepare(
      `INSERT INTO transactions (doc_id, source, deprecated_at) VALUES (?, 'primary', NULL)`,
    ).run(TRUMP_UNREADABLE_DOC_ID);

    const result = await sweepKnownParkedExecutiveTerminals(envFor(db));
    expect(result).toEqual({ verifiedEmpty: 0, unreadable: 0 });
    const bondi = db.prepare(`SELECT resolved, reason FROM review_queue WHERE doc_id = ?`)
      .get(BONDI_EMPTY_DOC_ID) as { resolved: number; reason: string };
    expect(bondi).toEqual({ resolved: 0, reason: 'extract_empty_failure' });
    const trump = db.prepare(`SELECT resolved FROM review_queue WHERE doc_id = ?`)
      .get(TRUMP_UNREADABLE_DOC_ID) as { resolved: number };
    expect(trump.resolved).toBe(0);
  });

  it('parks Trump as unreadable when agreement vision counts disagree (33/66/472)', async () => {
    const db = await sqliteDatabase();
    seedReview(db, TRUMP_UNREADABLE_DOC_ID, 'agreement_cascade_unresolved');
    const insert = db.prepare(
      `INSERT INTO extraction_runs (doc_id, batch_id, provider, model, ok, row_count, kind, result_json)
       VALUES (?, 'batch-1', ?, ?, 1, ?, 'agreement', '[]')`,
    );
    insert.run(TRUMP_UNREADABLE_DOC_ID, 'gemini', 'gemini-a', 33);
    insert.run(TRUMP_UNREADABLE_DOC_ID, 'openai', 'gpt-a', 66);
    insert.run(TRUMP_UNREADABLE_DOC_ID, 'anthropic', 'claude-a', 472);

    const result = await sweepKnownParkedExecutiveTerminals(envFor(db));
    expect(result).toEqual({ verifiedEmpty: 0, unreadable: 1 });
    const trump = db.prepare(
      `SELECT resolved, resolution_kind, resolution_reason, reason FROM review_queue WHERE doc_id = ?`,
    ).get(TRUMP_UNREADABLE_DOC_ID) as Record<string, unknown>;
    expect(trump).toMatchObject({
      resolved: 0,
      resolution_kind: null,
      resolution_reason: null,
    });
    expect(String(trump.reason)).toContain('ocr_unusable');
    expect(String(trump.reason)).toContain('oge_text_unreadable');
  });

  it('does not close Trump when two agreement vision runs agree on row count', async () => {
    const db = await sqliteDatabase();
    seedReview(db, TRUMP_UNREADABLE_DOC_ID, 'agreement_cascade_unresolved');
    const insert = db.prepare(
      `INSERT INTO extraction_runs (doc_id, batch_id, provider, model, ok, row_count, kind, result_json)
       VALUES (?, 'batch-1', ?, ?, 1, ?, 'agreement', '[]')`,
    );
    insert.run(TRUMP_UNREADABLE_DOC_ID, 'gemini', 'gemini-a', 1150);
    insert.run(TRUMP_UNREADABLE_DOC_ID, 'openai', 'gpt-a', 1160);

    const result = await sweepKnownParkedExecutiveTerminals(envFor(db));
    expect(result).toEqual({ verifiedEmpty: 0, unreadable: 0 });
    const trump = db.prepare(`SELECT resolved FROM review_queue WHERE doc_id = ?`)
      .get(TRUMP_UNREADABLE_DOC_ID) as { resolved: number };
    expect(trump.resolved).toBe(0);
  });

  it('does not let an older disputed batch veto a later corroborated batch', async () => {
    const db = await sqliteDatabase();
    seedReview(db, TRUMP_UNREADABLE_DOC_ID, 'agreement_cascade_unresolved');
    const insert = db.prepare(
      `INSERT INTO extraction_runs (doc_id, batch_id, provider, model, ok, row_count, kind, result_json)
       VALUES (?, ?, ?, ?, 1, ?, 'agreement', '[]')`,
    );
    // batch-1: two models disagree (33 vs 472).
    insert.run(TRUMP_UNREADABLE_DOC_ID, 'batch-1', 'gemini', 'gemini-a', 33);
    insert.run(TRUMP_UNREADABLE_DOC_ID, 'batch-1', 'openai', 'gpt-a', 472);
    // batch-2: two models agree (1150 vs 1160) — a real read of the filing.
    insert.run(TRUMP_UNREADABLE_DOC_ID, 'batch-2', 'gemini', 'gemini-a', 1150);
    insert.run(TRUMP_UNREADABLE_DOC_ID, 'batch-2', 'openai', 'gpt-a', 1160);

    const result = await sweepKnownParkedExecutiveTerminals(envFor(db));
    expect(result).toEqual({ verifiedEmpty: 0, unreadable: 0 });
    const trump = db.prepare(`SELECT resolved FROM review_queue WHERE doc_id = ?`)
      .get(TRUMP_UNREADABLE_DOC_ID) as { resolved: number };
    expect(trump.resolved).toBe(0);
  });

  it('does not count same-model retries or cross-batch runs as agreement', async () => {
    const db = await sqliteDatabase();
    seedReview(db, TRUMP_UNREADABLE_DOC_ID, 'agreement_cascade_unresolved');
    const insert = db.prepare(
      `INSERT INTO extraction_runs (doc_id, batch_id, provider, model, ok, row_count, kind, result_json)
       VALUES (?, ?, ?, ?, 1, ?, 'agreement', '[]')`,
    );
    // Two retries of one model in one batch agree on count: not agreement.
    insert.run(TRUMP_UNREADABLE_DOC_ID, 'batch-1', 'gemini', 'gemini-a', 1150);
    insert.run(TRUMP_UNREADABLE_DOC_ID, 'batch-1', 'gemini', 'gemini-a', 1160);
    // A different model agrees, but in another batch: not a pair either.
    insert.run(TRUMP_UNREADABLE_DOC_ID, 'batch-2', 'openai', 'gpt-a', 1155);

    const result = await sweepKnownParkedExecutiveTerminals(envFor(db));
    expect(result).toEqual({ verifiedEmpty: 0, unreadable: 1 });
    const trump = db.prepare(
      `SELECT resolved, resolution_kind, resolution_reason, reason FROM review_queue WHERE doc_id = ?`,
    ).get(TRUMP_UNREADABLE_DOC_ID) as Record<string, unknown>;
    expect(trump).toMatchObject({
      resolved: 0,
      resolution_kind: null,
      resolution_reason: null,
    });
    expect(String(trump.reason)).toContain('oge_text_unreadable');
  });

  it('still verified_empties when the only successful reads are zero-row', async () => {
    const db = await sqliteDatabase();
    seedReview(db, BONDI_EMPTY_DOC_ID, 'extract_empty_failure,no_transactions_extracted');
    db.prepare(
      `INSERT INTO extraction_runs (doc_id, ok, row_count, result_json) VALUES (?, 1, 0, '[]')`,
    ).run(BONDI_EMPTY_DOC_ID);
    const closed = await closeVerifiedEmptyExecutive(envFor(db), BONDI_EMPTY_DOC_ID);
    expect(closed).toBe(true);
  });

  it('does not close a parked row whose revision moved between the sweep SELECT and the close', async () => {
    const db = await sqliteDatabase();
    seedReview(db, BONDI_EMPTY_DOC_ID, 'extract_empty_failure');
    const env = envFor(db);
    // Simulate a concurrent normalize(): it bumps review_revision after the
    // sweep's SELECT but before the close batch runs.
    const realPrepare = env.DB.prepare.bind(env.DB);
    let bumped = false;
    (env.DB as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (!bumped && /UPDATE\s+review_queue/i.test(sql)) {
        bumped = true;
        db.prepare(
          `UPDATE review_queue SET review_revision = review_revision + 1 WHERE doc_id = ?`,
        ).run(BONDI_EMPTY_DOC_ID);
      }
      return realPrepare(sql);
    };

    const result = await sweepKnownParkedExecutiveTerminals(env);
    expect(bumped).toBe(true);
    expect(result).toEqual({ verifiedEmpty: 0, unreadable: 0 });
    const row = db.prepare(
      `SELECT resolved, review_revision FROM review_queue WHERE doc_id = ?`,
    ).get(BONDI_EMPTY_DOC_ID) as { resolved: number; review_revision: number };
    expect(row).toEqual({ resolved: 0, review_revision: 2 });
  });
});

describe('admin reopen and first-pass closes', () => {
  it('leaves an administrator-reopened (suppressed) row open on the sweep', async () => {
    const db = await sqliteDatabase();
    seedReview(db, BONDI_EMPTY_DOC_ID, 'agreement_cascade_unresolved');
    seedReview(db, TRUMP_UNREADABLE_DOC_ID, 'agreement_cascade_unresolved');
    db.prepare(`UPDATE review_queue SET agreement_suppressed_at = '2026-09-23T00:00:00.000Z'`).run();

    const result = await sweepKnownParkedExecutiveTerminals(envFor(db));
    expect(result).toEqual({ verifiedEmpty: 0, unreadable: 0 });
    const rows = db.prepare(`SELECT resolved FROM review_queue ORDER BY doc_id`).all() as Array<{ resolved: number }>;
    expect(rows.every((row) => row.resolved === 0)).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ingestion_decisions`).get()).toEqual({ n: 0 });
  });

  it('inserts an open review row on first pass when no review row exists yet', async () => {
    const db = await sqliteDatabase();
    db.prepare(
      `INSERT INTO filings (doc_id, chamber, ingest_status, doc_kind, extractor)
       VALUES (?, 'executive', 'pending', 'text_pdf', 'ogeText')`,
    ).run(TRUMP_UNREADABLE_DOC_ID);
    const env = envFor(db);

    expect(await closeUnreadableExecutive(env, TRUMP_UNREADABLE_DOC_ID)).toBe(false);
    expect(await closeUnreadableExecutive(env, TRUMP_UNREADABLE_DOC_ID, { insertIfAbsent: true })).toBe(true);
    const row = db.prepare(
      `SELECT rq.resolved, rq.resolution_kind, rq.resolution_reason, f.ingest_status
         FROM review_queue rq JOIN filings f ON f.doc_id = rq.doc_id WHERE rq.doc_id = ?`,
    ).get(TRUMP_UNREADABLE_DOC_ID);
    expect(row).toMatchObject({
      resolved: 0,
      resolution_kind: null,
      resolution_reason: null,
      ingest_status: 'needs_review',
    });
    // Idempotent: a second first-pass park changes nothing.
    expect(await closeUnreadableExecutive(env, TRUMP_UNREADABLE_DOC_ID, { insertIfAbsent: true })).toBe(false);
  });

  it('does not insert a resolved first-pass row when a nonempty run lands between guard and batch', async () => {
    const db = await sqliteDatabase();
    db.prepare(
      `INSERT INTO filings (doc_id, chamber, ingest_status, doc_kind, extractor)
       VALUES (?, 'executive', 'pending', 'text_pdf', 'ogeText')`,
    ).run(BONDI_EMPTY_DOC_ID);
    const env = envFor(db);
    // Same race as the UPDATE close: the outer emptiness guards pass, then a
    // concurrent worker persists a nonempty extraction_run before the
    // first-pass INSERT runs.
    const realPrepare = env.DB.prepare.bind(env.DB);
    let injected = false;
    (env.DB as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (!injected && /INSERT\s+OR\s+IGNORE\s+INTO\s+review_queue/i.test(sql)) {
        injected = true;
        db.prepare(
          `INSERT INTO extraction_runs (doc_id, ok, row_count, result_json) VALUES (?, 1, 4, '[{}]')`,
        ).run(BONDI_EMPTY_DOC_ID);
      }
      return realPrepare(sql);
    };

    const closed = await closeVerifiedEmptyExecutive(env, BONDI_EMPTY_DOC_ID, { insertIfAbsent: true });
    expect(injected).toBe(true);
    expect(closed).toBe(false);
    expect(
      db.prepare(`SELECT count(*) AS n FROM review_queue WHERE doc_id = ?`).get(BONDI_EMPTY_DOC_ID),
    ).toEqual({ n: 0 });
    expect(
      db.prepare(`SELECT ingest_status FROM filings WHERE doc_id = ?`).get(BONDI_EMPTY_DOC_ID),
    ).toEqual({ ingest_status: 'pending' });
  });

  it('does not insert over an existing unresolved row a human suppressed', async () => {
    const db = await sqliteDatabase();
    seedReview(db, BONDI_EMPTY_DOC_ID, 'extract_empty_failure');
    db.prepare(`UPDATE review_queue SET agreement_suppressed_at = '2026-09-23T00:00:00.000Z'`).run();
    const closed = await closeVerifiedEmptyExecutive(envFor(db), BONDI_EMPTY_DOC_ID, {
      respectSuppression: true,
      insertIfAbsent: true,
    });
    expect(closed).toBe(false);
    expect(db.prepare(`SELECT resolved FROM review_queue WHERE doc_id = ?`).get(BONDI_EMPTY_DOC_ID))
      .toEqual({ resolved: 0 });
  });
});

describe('sweepAutoRejectedUnreadable', () => {
  function seedPipelineAutoReject(db: SqliteDatabase, docId: string): void {
    seedReview(db, docId, 'ocr_unusable,oge_text_unreadable');
    db.prepare(
      `UPDATE filings SET ingest_status = 'error', error = 'old reject' WHERE doc_id = ?`,
    ).run(docId);
    db.prepare(
      `UPDATE review_queue
          SET resolved = 1,
              resolution_kind = 'rejected',
              resolution_reason = 'oge_text_unreadable',
              resolved_at = '2026-10-08T09:13:13.402Z'
        WHERE doc_id = ?`,
    ).run(docId);
    db.prepare(
      `INSERT INTO ingestion_decisions
         (id, doc_id, action, source, actor, reason, payload, transaction_ids, created_at)
       VALUES (?, ?, 'rejected', 'pipeline', NULL, 'oge_text_unreadable', ?, '[]', '2026-10-08T09:13:13.461Z')`,
    ).run(
      `rej-${docId}`,
      docId,
      JSON.stringify({ resolvedBy: 'executive-disposition', resolutionKind: 'rejected' }),
    );
  }

  it('reopens a same-tick pipeline auto-reject and then no-ops', async () => {
    const db = await sqliteDatabase();
    const docId = 'E-2026-donald-j-trump-09-17-2026-278t';
    seedPipelineAutoReject(db, docId);

    const first = await sweepAutoRejectedUnreadable(envFor(db));
    expect(first).toEqual({ reopened: 1 });
    const row = db.prepare(
      `SELECT rq.resolved, rq.resolution_kind, rq.resolution_reason, rq.reason, f.ingest_status
         FROM review_queue rq JOIN filings f ON f.doc_id = rq.doc_id
        WHERE rq.doc_id = ?`,
    ).get(docId) as Record<string, unknown>;
    expect(row).toMatchObject({
      resolved: 0,
      resolution_kind: null,
      resolution_reason: null,
      ingest_status: 'needs_review',
    });
    expect(String(row.reason)).toContain('oge_text_unreadable');
    const parked = db.prepare(
      `SELECT action, actor, source FROM ingestion_decisions WHERE doc_id = ? AND action = 'oge_text_unreadable'`,
    ).get(docId) as { action: string; actor: string | null; source: string };
    expect(parked).toEqual({ action: 'oge_text_unreadable', actor: null, source: 'pipeline' });

    const second = await sweepAutoRejectedUnreadable(envFor(db));
    expect(second).toEqual({ reopened: 0 });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM ingestion_decisions WHERE action = 'oge_text_unreadable'`).get(),
    ).toEqual({ n: 1 });
  });

  it('does not reopen a rejection a human already made', async () => {
    const db = await sqliteDatabase();
    const docId = 'E-2026-human-rejected-278t';
    seedPipelineAutoReject(db, docId);
    db.prepare(
      `INSERT INTO ingestion_decisions
         (id, doc_id, action, source, actor, reason, payload, transaction_ids, created_at)
       VALUES ('human-rej', ?, 'rejected', 'admin', 'jay', 'rejected by admin', '{}', '[]', '2026-10-08T10:00:00.000Z')`,
    ).run(docId);

    const result = await sweepAutoRejectedUnreadable(envFor(db));
    expect(result).toEqual({ reopened: 0 });
    const row = db.prepare(`SELECT resolved, resolution_kind FROM review_queue WHERE doc_id = ?`).get(docId) as {
      resolved: number;
      resolution_kind: string;
    };
    expect(row).toEqual({ resolved: 1, resolution_kind: 'rejected' });
  });

  it('does not reopen an auto-reject that already has live transactions', async () => {
    const db = await sqliteDatabase();
    const docId = TRUMP_UNREADABLE_DOC_ID;
    seedPipelineAutoReject(db, docId);
    db.prepare(
      `INSERT INTO transactions (doc_id, source, deprecated_at) VALUES (?, 'primary', NULL)`,
    ).run(docId);

    const result = await sweepAutoRejectedUnreadable(envFor(db));
    expect(result).toEqual({ reopened: 0 });
    const row = db.prepare(`SELECT resolved FROM review_queue WHERE doc_id = ?`).get(docId) as { resolved: number };
    expect(row.resolved).toBe(1);
  });
});

describe('closeUnreadableExecutive guards', () => {
  it('does not reject a filing an earlier successful read found rows for', async () => {
    const db = await sqliteDatabase();
    seedReview(db, TRUMP_UNREADABLE_DOC_ID, 'agreement_cascade_unresolved');
    db.prepare(
      `INSERT INTO extraction_runs (doc_id, ok, row_count, result_json) VALUES (?, 1, 12, '[{}]')`,
    ).run(TRUMP_UNREADABLE_DOC_ID);

    const closed = await closeUnreadableExecutive(envFor(db), TRUMP_UNREADABLE_DOC_ID);
    expect(closed).toBe(false);
    const row = db.prepare(
      `SELECT resolved, reason FROM review_queue WHERE doc_id = ?`,
    ).get(TRUMP_UNREADABLE_DOC_ID) as { resolved: number; reason: string };
    expect(row).toEqual({ resolved: 0, reason: 'agreement_cascade_unresolved' });
  });

  it('does not close over a review row revised after the captured revision', async () => {
    const db = await sqliteDatabase();
    seedReview(db, TRUMP_UNREADABLE_DOC_ID, 'agreement_cascade_unresolved');
    db.prepare(`UPDATE review_queue SET review_revision = 2 WHERE doc_id = ?`).run(TRUMP_UNREADABLE_DOC_ID);

    // The caller parsed against revision 1; the row is now at revision 2.
    const closed = await closeUnreadableExecutive(envFor(db), TRUMP_UNREADABLE_DOC_ID, {
      reviewRevision: 1,
    });
    expect(closed).toBe(false);
    const row = db.prepare(
      `SELECT resolved, review_revision FROM review_queue WHERE doc_id = ?`,
    ).get(TRUMP_UNREADABLE_DOC_ID) as { resolved: number; review_revision: number };
    expect(row).toEqual({ resolved: 0, review_revision: 2 });

    // The matching revision still closes.
    const closedCurrent = await closeUnreadableExecutive(envFor(db), TRUMP_UNREADABLE_DOC_ID, {
      reviewRevision: 2,
    });
    expect(closedCurrent).toBe(true);
  });

  it('does not close on a stale claim token after a concurrent clear of the lease', async () => {
    const db = await sqliteDatabase();
    seedReview(db, TRUMP_UNREADABLE_DOC_ID, 'agreement_cascade_unresolved');
    // The row's token is NULL (a concurrent normalize() cleared the lease),
    // but the worker still presents its stale token. A NULL-permissive
    // predicate would let the stale worker close the newer review.
    const closed = await closeUnreadableExecutive(envFor(db), TRUMP_UNREADABLE_DOC_ID, {
      claimToken: 'stale-token',
    });
    expect(closed).toBe(false);
    const row = db.prepare(
      `SELECT resolved, review_revision FROM review_queue WHERE doc_id = ?`,
    ).get(TRUMP_UNREADABLE_DOC_ID) as { resolved: number; review_revision: number };
    expect(row).toEqual({ resolved: 0, review_revision: 1 });

    // The live token still closes, and the close clears the lease columns.
    db.prepare(
      `UPDATE review_queue SET agreement_claim_token = 'live-token' WHERE doc_id = ?`,
    ).run(TRUMP_UNREADABLE_DOC_ID);
    const closedLive = await closeUnreadableExecutive(envFor(db), TRUMP_UNREADABLE_DOC_ID, {
      claimToken: 'live-token',
    });
    expect(closedLive).toBe(true);
  });

  it('does not let a tokenless close cross a live agreement lease', async () => {
    const db = await sqliteDatabase();
    seedReview(db, BONDI_EMPTY_DOC_ID, 'extract_empty_failure');
    // A worker holds a live lease; acquiring it did not bump review_revision,
    // so only the lease predicate can protect the row.
    db.prepare(
      `UPDATE review_queue SET agreement_claim_token = 'worker-token', agreement_claimed_at = ? WHERE doc_id = ?`,
    ).run(new Date().toISOString(), BONDI_EMPTY_DOC_ID);

    const closed = await closeVerifiedEmptyExecutive(envFor(db), BONDI_EMPTY_DOC_ID);
    expect(closed).toBe(false);
    const held = db.prepare(
      `SELECT resolved, agreement_claim_token FROM review_queue WHERE doc_id = ?`,
    ).get(BONDI_EMPTY_DOC_ID) as { resolved: number; agreement_claim_token: string };
    expect(held).toEqual({ resolved: 0, agreement_claim_token: 'worker-token' });

    // Once the lease has expired, the tokenless close proceeds.
    db.prepare(
      `UPDATE review_queue SET agreement_claimed_at = ? WHERE doc_id = ?`,
    ).run(new Date(Date.now() - 20 * 60 * 1000).toISOString(), BONDI_EMPTY_DOC_ID);
    const closedAfter = await closeVerifiedEmptyExecutive(envFor(db), BONDI_EMPTY_DOC_ID);
    expect(closedAfter).toBe(true);
  });

  it('does not close a review that holds staged candidate transactions only in its payload', async () => {
    const db = await sqliteDatabase();
    seedReview(db, BONDI_EMPTY_DOC_ID, 'extract_empty_failure');
    // routeToReview stages low-confidence candidates only in the payload:
    // no live transaction, no extraction_runs row, so both table guards pass.
    db.prepare(`UPDATE review_queue SET payload = ? WHERE doc_id = ?`).run(
      JSON.stringify({ transactionCount: 2, transactions: [{}, {}] }),
      BONDI_EMPTY_DOC_ID,
    );

    const closed = await closeVerifiedEmptyExecutive(envFor(db), BONDI_EMPTY_DOC_ID);
    expect(closed).toBe(false);
    const row = db.prepare(
      `SELECT resolved, review_revision FROM review_queue WHERE doc_id = ?`,
    ).get(BONDI_EMPTY_DOC_ID) as { resolved: number; review_revision: number };
    expect(row).toEqual({ resolved: 0, review_revision: 1 });

    // A payload with no staged candidates still closes.
    db.prepare(`UPDATE review_queue SET payload = '{}' WHERE doc_id = ?`).run(BONDI_EMPTY_DOC_ID);
    const closedEmpty = await closeVerifiedEmptyExecutive(envFor(db), BONDI_EMPTY_DOC_ID);
    expect(closedEmpty).toBe(true);
  });

  it('does not close when a nonempty extraction_run lands between the guard and the close', async () => {
    const db = await sqliteDatabase();
    seedReview(db, BONDI_EMPTY_DOC_ID, 'extract_empty_failure');
    const env = envFor(db);
    // Simulate the race: the outer emptiness guards pass, then a concurrent
    // worker persists a nonempty extraction_run before the close batch runs.
    const realPrepare = env.DB.prepare.bind(env.DB);
    let injected = false;
    (env.DB as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (!injected && /UPDATE\s+review_queue/i.test(sql)) {
        injected = true;
        db.prepare(
          `INSERT INTO extraction_runs (doc_id, ok, row_count, result_json) VALUES (?, 1, 7, '[{}]')`,
        ).run(BONDI_EMPTY_DOC_ID);
      }
      return realPrepare(sql);
    };

    const closed = await closeVerifiedEmptyExecutive(env, BONDI_EMPTY_DOC_ID);
    expect(injected).toBe(true);
    expect(closed).toBe(false);
    const row = db.prepare(
      `SELECT resolved, review_revision FROM review_queue WHERE doc_id = ?`,
    ).get(BONDI_EMPTY_DOC_ID) as { resolved: number; review_revision: number };
    expect(row).toEqual({ resolved: 0, review_revision: 1 });
  });
});

describe('recoverExpiredCappedReviews', () => {
  it('does not rewrite unreadable rows; labels capped empty failures it cannot settle', async () => {
    const db = await sqliteDatabase();
    seedReview(db, 'E-empty', 'extract_empty_failure');
    seedReview(db, 'E-chrome', 'form_chrome_only,extract_empty_failure,no_transactions_extracted');
    seedReview(db, 'E-unread', 'ocr_unusable,oge_text_unreadable');
    seedReview(db, 'E-capped', 'needs_review');
    seedReview(db, 'E-already', 'agreement_cascade_unresolved');
    // House/Senate empty failures are not health-terminal; they keep the
    // capped-row terminal label instead of stranding as eligible forever.
    seedReview(db, 'H-2026-empty', 'extract_empty_failure');
    seedReview(db, 'S-2026-empty', 'extract_empty_failure,no_transactions_extracted');

    const out = await maybeRunAgreementAutopublish(
      { ...envFor(db), AGREEMENT_AUTOPUBLISH_LIMIT: '10' } as unknown as Env,
    );
    // No bytes are reachable for the executive empty failures (no raw key, no
    // source_url), so they cannot be re-classified and take the capped
    // human-review label instead of stranding. E-chrome carries the terminal
    // form_chrome_only reason, so recovery leaves it untouched.
    expect(out).toMatchObject({ terminalized: 4, attempted: 0 });

    const reason = (docId: string) =>
      (db.prepare(`SELECT reason FROM review_queue WHERE doc_id = ?`).get(docId) as { reason: string }).reason;
    expect(reason('E-empty')).toBe('agreement_cascade_unresolved');
    expect(reason('E-chrome')).toBe('form_chrome_only,extract_empty_failure,no_transactions_extracted');
    expect(reason('E-unread')).toBe('ocr_unusable,oge_text_unreadable');
    expect(reason('E-already')).toBe('agreement_cascade_unresolved');
    expect(reason('E-capped')).toBe('agreement_cascade_unresolved');
    expect(reason('H-2026-empty')).toBe('agreement_cascade_unresolved');
    expect(reason('S-2026-empty')).toBe('agreement_cascade_unresolved');
  });

  it('does not lease a capped row whose review_revision moved after selection', async () => {
    const db = await sqliteDatabase();
    seedReview(db, 'E-2026-racy-278e', 'extract_empty_failure');
    db.prepare(
      `UPDATE filings SET raw_object_key = 'raw/racy.pdf' WHERE doc_id = 'E-2026-racy-278e'`,
    ).run();
    classifyOverride.fn = async () => {
      throw new Error('classifier must not run: the lease CAS must fail on the stale revision');
    };
    const env = withBytes(db, async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }));
    // A concurrent normalize() bumps review_revision after the recovery pass
    // selects the row but before its lease UPDATE executes.
    const realPrepare = env.DB.prepare.bind(env.DB);
    let bumped = false;
    (env.DB as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (!bumped && /UPDATE\s+review_queue\s+SET\s+agreement_claim_token/i.test(sql)) {
        bumped = true;
        db.prepare(
          `UPDATE review_queue SET review_revision = review_revision + 1 WHERE doc_id = 'E-2026-racy-278e'`,
        ).run();
      }
      return realPrepare(sql);
    };

    const out = await maybeRunAgreementAutopublish(env);
    expect(bumped).toBe(true);
    expect(out).toMatchObject({ terminalized: 0 });
    const row = reviewRow(db, 'E-2026-racy-278e');
    // Not leased, not relabeled: the stale pass drops the row for a later one.
    expect(row).toMatchObject({ resolved: 0, reason: 'extract_empty_failure' });
    expect(row.agreement_claim_token).toBeNull();
  });

  it('preserves established terminal reasons instead of relabeling them during capped recovery', async () => {
    const db = await sqliteDatabase();
    seedReview(db, 'E-localvision', 'local_vision_exhausted');
    seedReview(db, 'E-rowlimit', 'extraction_row_limit');
    seedReview(db, 'E-spend', 'scanned_pdf_vision_spend');
    seedReview(db, 'E-chrome2', 'form_chrome_only,extract_empty_failure');
    seedReview(db, 'E-rejected', 'rejected:manual');
    seedReview(db, 'E-plain', 'extract_empty_failure');

    const out = await maybeRunAgreementAutopublish(
      { ...envFor(db), AGREEMENT_AUTOPUBLISH_LIMIT: '10' } as unknown as Env,
    );
    // Only the plain nonterminal empty failure is recovered; the terminal
    // rows keep their reasons (sweepLocalVisionHostedFallback selects on
    // local_vision_exhausted) and are never leased.
    expect(out).toMatchObject({ terminalized: 1 });
    const row = (docId: string) =>
      db.prepare(`SELECT reason, agreement_claim_token FROM review_queue WHERE doc_id = ?`).get(docId) as
        { reason: string; agreement_claim_token: string | null };
    expect(row('E-localvision')).toEqual({ reason: 'local_vision_exhausted', agreement_claim_token: null });
    expect(row('E-rowlimit')).toEqual({ reason: 'extraction_row_limit', agreement_claim_token: null });
    expect(row('E-spend')).toEqual({ reason: 'scanned_pdf_vision_spend', agreement_claim_token: null });
    expect(row('E-chrome2')).toEqual({ reason: 'form_chrome_only,extract_empty_failure', agreement_claim_token: null });
    expect(row('E-rejected')).toEqual({ reason: 'rejected:manual', agreement_claim_token: null });
    expect(row('E-plain').reason).toBe('agreement_cascade_unresolved');
  });

  function withBytes(db: SqliteDatabase, get: (key: string) => Promise<unknown>): Env {
    return { ...envFor(db), RAW_FILES: { get } } as unknown as Env;
  }

  function reviewRow(db: SqliteDatabase, docId: string) {
    return db.prepare(
      `SELECT reason, resolved, resolution_kind, resolution_reason, agreement_claim_token
         FROM review_queue WHERE doc_id = ?`,
    ).get(docId) as Record<string, unknown>;
  }

  it('re-classifies a capped executive empty failure: empty closes, unreadable parks, unconfirmed goes to human review', async () => {
    const db = await sqliteDatabase();
    for (const id of ['E-2026-empty-278e', 'E-2026-refused-278t', 'E-2026-garbled-278e']) {
      seedReview(db, id, 'extract_empty_failure,no_transactions_extracted');
      db.prepare(`UPDATE filings SET raw_object_key = ? WHERE doc_id = ?`).run(`raw/${id}.pdf`, id);
    }
    const seen: string[] = [];
    classifyOverride.fn = async (_bytes, docId) => {
      seen.push(docId);
      if (docId === 'E-2026-empty-278e') return { disposition: 'empty', rows: [] };
      if (docId === 'E-2026-refused-278t') return { disposition: 'unreadable', rows: [], reason: 'unreadable_278t' };
      return { disposition: 'unconfirmed', rows: [] };
    };
    const env = withBytes(db, async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }));

    const out = await maybeRunAgreementAutopublish(env);
    expect(out).toMatchObject({ terminalized: 3, attempted: 0 });
    expect(seen.sort()).toEqual(['E-2026-empty-278e', 'E-2026-garbled-278e', 'E-2026-refused-278t']);

    expect(reviewRow(db, 'E-2026-empty-278e')).toMatchObject({
      resolved: 1, resolution_kind: 'verified_empty', agreement_claim_token: null,
    });
    expect(reviewRow(db, 'E-2026-refused-278t')).toMatchObject({
      resolved: 0, resolution_kind: null, agreement_claim_token: null,
    });
    expect(String(reviewRow(db, 'E-2026-refused-278t').reason)).toContain('oge_text_unreadable');
    // Blank/garbled/header-only 278e: not auto-closed, but no longer stuck
    // eligible at the cap - it gets the terminal human-review label.
    expect(reviewRow(db, 'E-2026-garbled-278e')).toMatchObject({
      resolved: 0, reason: 'agreement_cascade_unresolved', agreement_claim_token: null,
    });

    // Idempotent: a second pass has nothing left to do.
    const again = await maybeRunAgreementAutopublish(env);
    expect(again).toMatchObject({ terminalized: 0 });
  });

  it('terminalizes a recovered-rows settlement that stays in review (no re-normalization every pass)', async () => {
    const db = await sqliteDatabase();
    seedReview(db, 'E-2026-rows-278t', 'extract_empty_failure');
    db.prepare(`UPDATE filings SET raw_object_key = 'raw/rows.pdf' WHERE doc_id = 'E-2026-rows-278t'`).run();
    classifyOverride.fn = async () => ({
      disposition: 'rows',
      rows: [{
        txDate: '2026-06-19', owner: null, assetName: 'Apple Inc.', ticker: 'AAPL',
        assetType: null, assetTypeName: null, txType: 'B', amountMin: 1001, amountMax: 15000,
        isOption: false, capGainsOver200: false,
        rawText: '1 Apple Inc. Purchase 06/19/2026 No $1,001 - $15,000',
        confidence: 0.3,
      }],
    });
    const env = withBytes(db, async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }));

    const out = await maybeRunAgreementAutopublish(env);
    expect(out).toMatchObject({ terminalized: 1 });

    // routeToReview cleared the claim, so a token-CAS finish matches nothing;
    // the recovery must terminalize the settlement's new review_revision
    // instead: terminal label on, staged candidates preserved in the payload.
    const row = db.prepare(
      `SELECT reason, resolved, agreement_claim_token, payload FROM review_queue WHERE doc_id = ?`,
    ).get('E-2026-rows-278t') as {
      reason: string; resolved: number; agreement_claim_token: string | null; payload: string;
    };
    expect(row.resolved).toBe(0);
    expect(row.reason).toBe('agreement_cascade_unresolved');
    expect(row.agreement_claim_token).toBeNull();
    const payload = JSON.parse(row.payload) as { transactionCount?: number; transactions?: unknown[] };
    expect(payload.transactionCount).toBe(1);
    expect(payload.transactions).toHaveLength(1);

    // A second pass leaves the terminalized row alone.
    classifyOverride.fn = async () => {
      throw new Error('must not re-classify a terminalized row');
    };
    const again = await maybeRunAgreementAutopublish(env);
    expect(again).toMatchObject({ terminalized: 0 });
  });

  it('does not count a recovered-rows CAS loss as terminalized (row stays eligible)', async () => {
    const db = await sqliteDatabase();
    seedReview(db, 'E-2026-caslost-278e', 'extract_empty_failure');
    db.prepare(`UPDATE filings SET raw_object_key = 'raw/caslost.pdf' WHERE doc_id = 'E-2026-caslost-278e'`).run();
    classifyOverride.fn = async () => ({
      disposition: 'rows',
      rows: [{
        txDate: '2026-06-19', owner: null, assetName: 'Apple Inc.', ticker: 'AAPL',
        assetType: null, assetTypeName: null, txType: 'B', amountMin: 1001, amountMax: 15000,
        isOption: false, capGainsOver200: false,
        rawText: '1 Apple Inc. Purchase 06/19/2026 No $1,001 - $15,000',
        confidence: 0.9,
      }],
    });
    // normalize() lost the persist/stage CAS: the recovered rows were
    // neither persisted nor staged, so the pass must not finish as a
    // success over nothing.
    normalizeOverride.fn = async () => ({
      transactions: [{}], minConfidence: 0.9, needsReview: false, published: false,
    });
    const env = withBytes(db, async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }));

    const out = await maybeRunAgreementAutopublish(env);
    expect(out).toMatchObject({ terminalized: 0 });
    // Untouched: same non-terminal reason, still unresolved, no re-label.
    const row = reviewRow(db, 'E-2026-caslost-278e');
    expect(row).toMatchObject({ resolved: 0, reason: 'extract_empty_failure' });
  });

  it('maps a recovered-rows CAS loss to skipped/claim-lost, not published', () => {
    // settledZeroReadResult: published:false with needsReview:false means
    // the recovered rows were neither persisted nor staged.
    expect(settledZeroReadResult('E-x', 1, {
      kind: 'rows', needsReview: false, published: false, settled: false, rowCount: 2,
    })).toMatchObject({
      outcome: 'skipped',
      reason: 'review_resolved_or_claim_lost',
      rowCount: 2,
      flags: ['deterministic_rows_recovered'],
    });
    // The real publish and review shapes are unchanged.
    expect(settledZeroReadResult('E-x', 1, {
      kind: 'rows', needsReview: false, published: true, settled: false, rowCount: 2,
    })).toMatchObject({ outcome: 'published', reason: 'deterministic_rows_recovered' });
    expect(settledZeroReadResult('E-x', 1, {
      kind: 'rows', needsReview: true, published: false, settled: false, rowCount: 2,
    })).toMatchObject({ outcome: 'review_flagged', reason: 'deterministic_rows_recovered' });
  });

  it('preserves a successful no-new-row settlement (amendment already persisted)', () => {
    // normalize() resolved the review with nothing new to persist: a
    // terminal no-op success, published with its distinguishing reason -
    // not skipped as a CAS loss.
    expect(settledZeroReadResult('E-x', 1, {
      kind: 'rows', needsReview: false, published: false, settled: true,
      rowCount: 0, reason: 'amendment_already_persisted',
    })).toMatchObject({
      outcome: 'published',
      reason: 'amendment_already_persisted',
      flags: ['deterministic_rows_recovered'],
    });
    expect(settledZeroReadResult('E-x', 1, {
      kind: 'rows', needsReview: false, published: false, settled: true,
      rowCount: 0, reason: 'deleted_rows_applied',
    })).toMatchObject({ outcome: 'published', reason: 'deleted_rows_applied' });
  });

  it('counts a no-new-row settlement as terminalized in the capped sweep', async () => {
    const db = await sqliteDatabase();
    seedReview(db, 'E-2026-nonewrows-278e', 'extract_empty_failure');
    db.prepare(`UPDATE filings SET raw_object_key = 'raw/nonewrows.pdf' WHERE doc_id = 'E-2026-nonewrows-278e'`).run();
    classifyOverride.fn = async () => ({
      disposition: 'rows',
      rows: [{
        txDate: '2026-06-19', owner: null, assetName: 'Apple Inc.', ticker: 'AAPL',
        assetType: null, assetTypeName: null, txType: 'B', amountMin: 1001, amountMax: 15000,
        isOption: false, capGainsOver200: false,
        rawText: '1 Apple Inc. Purchase 06/19/2026 No $1,001 - $15,000',
        confidence: 0.9,
      }],
    });
    // normalize() resolved the review with nothing new to persist
    // (amendment rows already live on a predecessor).
    normalizeOverride.fn = async () => ({
      transactions: [], minConfidence: 0.9, needsReview: false, published: false,
      reviewReason: 'amendment_already_persisted', settled: true,
    });
    const env = withBytes(db, async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }));

    const out = await maybeRunAgreementAutopublish(env);
    expect(out).toMatchObject({ terminalized: 1 });
  });

  it('treats a soft loadDocBytes skip (R2 miss + source timeout) as retryable, keeping lease and reason', async () => {
    const db = await sqliteDatabase();
    seedReview(db, 'E-2026-timeout-278e', 'extract_empty_failure');
    db.prepare(
      `UPDATE filings SET raw_object_key = 'raw/miss.pdf', source_url = 'https://example.test/doc.pdf'
        WHERE doc_id = 'E-2026-timeout-278e'`,
    ).run();
    classifyOverride.fn = async () => {
      throw new Error('classifier must not run without bytes');
    };
    // R2 miss, then the source_url fallback times out: a blip, not a verdict.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('The operation timed out');
    }));
    const env = withBytes(db, async () => null);

    const out = await maybeRunAgreementAutopublish(env);
    expect(out).toMatchObject({ terminalized: 0 });
    const row = reviewRow(db, 'E-2026-timeout-278e');
    // Not relabeled agreement_cascade_unresolved (a label later recovery
    // excludes); the row retries after the 15-minute lease expiry.
    expect(row).toMatchObject({ resolved: 0, reason: 'extract_empty_failure' });
    expect(row.agreement_claim_token).toEqual(expect.any(String));
    vi.unstubAllGlobals();
  });

  it('keeps the lease and the empty-failure reason when storage throws', async () => {
    const db = await sqliteDatabase();
    seedReview(db, 'E-2026-blip-278e', 'extract_empty_failure');
    db.prepare(`UPDATE filings SET raw_object_key = 'raw/blip.pdf' WHERE doc_id = 'E-2026-blip-278e'`).run();
    classifyOverride.fn = async () => {
      throw new Error('classifier must not run without bytes');
    };
    const env = withBytes(db, async () => {
      throw new Error('R2 unavailable');
    });

    const out = await maybeRunAgreementAutopublish(env);
    expect(out).toMatchObject({ terminalized: 0 });
    const row = reviewRow(db, 'E-2026-blip-278e');
    expect(row).toMatchObject({ resolved: 0, reason: 'extract_empty_failure' });
    // Lease retained; the row retries after the 15-minute expiry.
    expect(row.agreement_claim_token).toEqual(expect.any(String));
  });
});
