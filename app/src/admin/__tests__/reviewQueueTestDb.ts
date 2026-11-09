/**
 * src/admin/__tests__/reviewQueueTestDb.ts
 *
 * A real SQLite-backed D1Database stand-in for the review-queue pagination
 * tests. Unlike the hand-rolled "regex-sniff the SQL" fakes used elsewhere in
 * this test suite, pagination/filter/keyset-cursor correctness genuinely
 * depends on WHERE/ORDER BY/LIMIT semantics — re-implementing that logic in
 * JS inside a mock would just test the mock, not the endpoint. Node's builtin
 * `node:sqlite` (stable from Node 22.5+; this repo runs Node 26) gives us a
 * real SQLite engine with zero new npm dependencies, so the review-queue SQL
 * actually executes.
 *
 * D1's bound-parameter limit (~100 per statement) is stricter than SQLite's
 * own default (much higher), and is the exact mechanism behind the
 * silent-data-loss bug this PR fixes (see routes.ts). `bind()` below
 * reproduces that cap explicitly so the chunking fix is tested against the
 * real failure mode, not just plain SQLite's more permissive limit.
 *
 * This repo's tsconfig deliberately scopes global ambient types to
 * @cloudflare/workers-types only (no Node globals leaking into Worker code).
 * `@types/node` is a devDependency purely so this file's explicit
 * `node:sqlite` import resolves — it isn't added to tsconfig `types`, so it
 * doesn't affect any other file.
 */

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { D1Database, D1Result, D1PreparedStatement } from '../../prices/__tests__/sqliteD1.ts';

/** D1 rejects a statement bound with more than this many parameters. */
export const D1_BOUND_PARAM_LIMIT = 100;

const SCHEMA_SQL = `
CREATE TABLE filings (
  doc_id            TEXT PRIMARY KEY,
  chamber           TEXT,
  filer_id          TEXT,
  filing_type       TEXT,
  filed_date        TEXT,
  source_url        TEXT,
  raw_object_key    TEXT,
  ingest_status     TEXT,
  doc_kind          TEXT,
  extractor         TEXT,
  model_version     TEXT,
  confidence        REAL,
  first_seen_at     TEXT,
  source_updated_at TEXT,
  error             TEXT,
  page_count        INTEGER,
  raw_bytes         INTEGER
);

CREATE TABLE review_queue (
  doc_id     TEXT PRIMARY KEY,
  reason     TEXT,
  payload    TEXT,
  created_at TEXT,
  resolved   INTEGER,
  agreement_attempts INTEGER NOT NULL DEFAULT 0,
  agreement_tier INTEGER,
  agreement_next_attempt_at TEXT,
  agreement_claim_token TEXT,
  agreement_claimed_at TEXT,
  agreement_legacy_replay_at TEXT,
  agreement_suppressed_at TEXT,
  agreement_suppression_reason TEXT,
  review_revision INTEGER NOT NULL DEFAULT 1,
  resolution_kind TEXT,
  resolution_reason TEXT,
  resolved_at TEXT
);
CREATE INDEX idx_review_resolved ON review_queue (resolved);

CREATE TABLE transactions (
  id                 TEXT PRIMARY KEY,
  doc_id             TEXT,
  filer_id           TEXT,
  tx_date            TEXT,
  owner              TEXT,
  asset_name         TEXT,
  ticker             TEXT,
  asset_type         TEXT,
  tx_type            TEXT,
  amount_min         INTEGER,
  amount_max         INTEGER,
  is_option          INTEGER,
  cap_gains_over_200 INTEGER,
  raw_text           TEXT,
  confidence         REAL,
  source             TEXT NOT NULL DEFAULT 'primary',
  created_at         TEXT,
  cursor_seq         INTEGER,
  deprecated_at      TEXT,
  deprecated_reason  TEXT
);

CREATE TABLE extraction_runs (
  id             TEXT PRIMARY KEY,
  batch_id       TEXT,
  doc_id         TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'bakeoff',
  ok             INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  row_count      INTEGER NOT NULL DEFAULT 0,
  latency_ms     INTEGER,
  avg_confidence REAL,
  result_json    TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_extraction_runs_doc ON extraction_runs (doc_id);

CREATE TABLE filers (
  bioguide_id TEXT PRIMARY KEY,
  chamber     TEXT,
  full_name   TEXT,
  party       TEXT,
  state       TEXT,
  district    TEXT,
  committees  TEXT
);

CREATE TABLE ingestion_outbox (
  doc_id             TEXT PRIMARY KEY,
  chamber            TEXT NOT NULL,
  source_url         TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  attempts           INTEGER NOT NULL DEFAULT 0,
  dead_letter_cycles INTEGER NOT NULL DEFAULT 0,
  available_at       TEXT NOT NULL,
  last_error         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_ingestion_outbox_ready ON ingestion_outbox (status, available_at);
`;

export interface ReviewQueueFixtureRow {
  docId: string;
  createdAt: string;
  resolved?: 0 | 1;
  reason?: string;
  payload?: string | null;
  chamber?: string | null;
  ingestStatus?: string | null;
  docKind?: string | null;
  sourceUrl?: string | null;
  resolutionKind?: string | null;
  resolutionReason?: string | null;
  /** Skip the review_queue row entirely (the ingest-failure shape). */
  noReview?: boolean;
  filerId?: string | null;
  /** Seeds a filers row with bioguide_id = filerId (or docId) for name lookup. */
  filerName?: string | null;
  filedDate?: string | null;
  filingType?: string | null;
  error?: string | null;
  firstSeenAt?: string | null;
  sourceUpdatedAt?: string | null;
  liveTransactions?: number;
  deprecatedTransactions?: number;
  outboxUpdatedAt?: string | null;
  models?: Array<{
    provider: string;
    model: string;
    ok?: boolean;
    rowCount?: number;
    avgConfidence?: number | null;
    createdAt?: string;
  }>;
}

/** Coerce JS values D1's SqlParam type allows into what node:sqlite accepts
 *  (it rejects JS booleans outright — see reviewQueueTestDb prototyping). */
function coerceParam(value: unknown): SQLInputValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value as SQLInputValue;
}

/** Build a D1Database-shaped object backed by a fresh in-memory SQLite
 *  instance seeded with the given review_queue/filings/extraction_runs rows.
 *  Enforces D1's bound-parameter cap so the chunking fix is exercised for
 *  real (see D1_BOUND_PARAM_LIMIT above). */
export function makeReviewQueueTestDb(rows: ReviewQueueFixtureRow[]): D1Database {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA_SQL);

  const insertFiling = raw.prepare(
    `INSERT INTO filings
       (doc_id, chamber, filer_id, filing_type, filed_date, source_url,
        raw_object_key, doc_kind, ingest_status, first_seen_at,
        source_updated_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertReview = raw.prepare(
    `INSERT INTO review_queue
       (doc_id, reason, payload, created_at, resolved, review_revision,
        resolution_kind, resolution_reason, resolved_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  );
  const insertRun = raw.prepare(
    `INSERT INTO extraction_runs (id, doc_id, provider, model, kind, ok, error, row_count, latency_ms, avg_confidence, created_at)
     VALUES (?, ?, ?, ?, 'bakeoff', ?, NULL, ?, NULL, ?, ?)`,
  );
  const insertFiler = raw.prepare(
    `INSERT OR IGNORE INTO filers (bioguide_id, chamber, full_name) VALUES (?, ?, ?)`,
  );
  const insertTx = raw.prepare(
    `INSERT INTO transactions (id, doc_id, deprecated_at) VALUES (?, ?, ?)`,
  );
  const insertOutbox = raw.prepare(
    `INSERT INTO ingestion_outbox
       (doc_id, chamber, source_url, status, attempts, available_at,
        last_error, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 3, ?, ?, ?, ?)`,
  );

  let runIdSeq = 0;
  let txIdSeq = 0;
  for (const row of rows) {
    insertFiling.run(
      row.docId,
      row.chamber ?? null,
      row.filerId ?? null,
      row.filingType ?? 'P',
      row.filedDate ?? null,
      row.sourceUrl ?? `https://example.test/${row.docId}`,
      `raw/${row.docId}`,
      row.docKind ?? 'text_pdf',
      row.ingestStatus ?? (row.resolved ? 'persisted' : 'needs_review'),
      row.firstSeenAt ?? row.createdAt,
      row.sourceUpdatedAt ?? null,
      row.error ?? null,
    );
    if (row.filerName) {
      insertFiler.run(row.filerId ?? row.docId, row.chamber ?? null, row.filerName);
    }
    if (!row.noReview) {
      insertReview.run(
        row.docId,
        row.reason ?? 'low_confidence',
        row.payload === undefined ? '{"minConfidence":0,"transactions":[]}' : row.payload,
        row.createdAt,
        row.resolved ?? 0,
        row.resolutionKind ?? null,
        row.resolutionReason ?? null,
        row.resolved ? row.createdAt : null,
      );
    }
    for (let i = 0; i < (row.liveTransactions ?? 0); i++) {
      insertTx.run(`tx-${txIdSeq++}`, row.docId, null);
    }
    for (let i = 0; i < (row.deprecatedTransactions ?? 0); i++) {
      insertTx.run(`tx-${txIdSeq++}`, row.docId, row.createdAt);
    }
    if (row.outboxUpdatedAt) {
      insertOutbox.run(
        row.docId,
        row.chamber ?? 'senate',
        row.sourceUrl ?? `https://example.test/${row.docId}`,
        row.outboxUpdatedAt,
        row.error ?? null,
        row.createdAt,
        row.outboxUpdatedAt,
      );
    }
    for (const m of row.models ?? []) {
      insertRun.run(
        `run-${runIdSeq++}`,
        row.docId,
        m.provider,
        m.model,
        m.ok === false ? 0 : 1,
        m.rowCount ?? 1,
        m.avgConfidence ?? 0.9,
        m.createdAt ?? row.createdAt,
      );
    }
  }

  return {
    prepare(sql: string) {
      let boundParams: unknown[] = [];
      const exec = <T>(kind: 'all' | 'get' | 'run') => {
        if (boundParams.length > D1_BOUND_PARAM_LIMIT) {
          // Mirrors the real D1 behavior this PR's fix depends on: binding
          // more than ~100 params throws instead of silently truncating.
          throw new Error(
            `D1_ERROR: too many SQL variables at offset 0: SqliteError: too many SQL variables (bound ${boundParams.length})`,
          );
        }
        const stmt = raw.prepare(sql);
        const coerced: SQLInputValue[] = boundParams.map(coerceParam);
        if (kind === 'all') return { results: stmt.all(...coerced) as unknown as T[] };
        if (kind === 'get') return (stmt.get(...coerced) ?? null) as unknown as T | null;
        const info = stmt.run(...coerced);
        return { success: true, meta: { changes: Number(info.changes) } };
      };
      const api = {
        bind(...params: unknown[]) {
          boundParams = params;
          return api;
        },
        async all<T>() {
          return exec<T>('all');
        },
        async first<T>() {
          return exec<T>('get');
        },
        async run() {
          return exec('run');
        },
      };
      return api;
    },
  } as unknown as D1Database;
}
