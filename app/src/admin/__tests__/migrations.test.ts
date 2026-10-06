// The Worker intentionally omits Node types, while Vitest runs this migration
// parity check in Node.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { persistTransactions } from '../../extraction/normalizer.ts';
import { checkReadiness } from '../../shared/readiness.ts';
import { buildAdminRouter } from '../routes.ts';
import type { Env, Transaction } from '../../shared/types.ts';
import {
  AUTOPILOT_SCHEMA_STATEMENTS,
  ACCOUNTING_PROJECTION_SCHEMA_STATEMENTS,
  ACCOUNTING_PROJECTION_RESYNC_SCHEMA_STATEMENTS,
  QUERY_OPTIMIZATIONS_SCHEMA_STATEMENTS,
  PERFORMANCE_INDEXES_SCHEMA_STATEMENTS,
  TURSO_QUERY_EFFICIENCY_SCHEMA_STATEMENTS,
  TRADE_LATENCY_WATCH_SCHEMA_STATEMENTS,
  TRADE_LATENCY_WATCH_COLUMN_FIX_SCHEMA_STATEMENTS,
  TRADE_LATENCY_SCOREBOARD_INDEX_SCHEMA_STATEMENTS,
  DENO_RUNTIME_KV_SCHEMA_STATEMENTS,
  CLEAN_PLACEHOLDER_TICKERS_SCHEMA_STATEMENTS,
  FIX_DENO_RUNTIME_QUEUE_INDEX_SCHEMA_STATEMENTS,
  FILINGS_FILED_DATE_INDEX_SCHEMA_STATEMENTS,
  DENO_RUNTIME_QUEUE_DEAD_LETTER_CYCLES_SCHEMA_STATEMENTS,
  STOCK_ACT_STATUS_SCHEMA_STATEMENTS,
  FILER_BIOGUIDE_RESOLUTION_SCHEMA_STATEMENTS,
  CLEAN_OCR_DOT_LEADERS_SCHEMA_STATEMENTS,
  CURSOR_SEQ_INTEGRITY_SCHEMA_STATEMENTS,
  CLIENT_COMMAND_SECRET_CLAIM_SCHEMA_STATEMENTS,
  PURGE_LEAKED_KV_CREDENTIALS_SCHEMA_STATEMENTS,
  QUEUE_OUTBOX_RETENTION_INDEX_SCHEMA_STATEMENTS,
  LOCAL_VISION_WORKER_SCHEMA_STATEMENTS,
  BASE_SCHEMA_STATEMENTS,
  D1_BUDGET_SCHEMA_STATEMENTS,
  DENO_RUNTIME_QUEUE_SCHEMA_STATEMENTS,
  DISCLOSURE_AVAILABLE_SCHEMA_STATEMENTS,
  DOC_CLASS_SCHEMA_STATEMENTS,
  EST_VALUE_SCHEMA_STATEMENTS,
  POST_0024_SCHEMA_STATEMENTS,
  LATENCY_PROBE_LEASE_SCHEMA_STATEMENTS,
  ASSET_NORMALIZATION_0085_SCHEMA_STATEMENTS,
  APNS_FANOUT_STATE_SCHEMA_STATEMENTS,
  LATENCY_PRICE_SNAPSHOT_SCHEMA_STATEMENTS,
  TWIN_SEEK_INDEX_SCHEMA_STATEMENTS,
  PROBE_RUN_BRACKET_SCHEMA_STATEMENTS,
  LATENCY_PRICE_SNAPSHOT_REPAIR_SCHEMA_STATEMENTS,
  LATENCY_SNAPSHOT_12H_SWEEP_SCHEMA_STATEMENTS,
  PREMIUM_ACTIVATION_ALERT_SCHEMA_STATEMENTS,
  PRICE_BACKFILL_TERMINATION_SCHEMA_STATEMENTS,
  RELIABILITY_SCHEMA_STATEMENTS,
  RETENTION_INDEX_SCHEMA_STATEMENTS,
  RESOURCE_GOVERNOR_SCHEMA_STATEMENTS,
  SPEND_SETTLEMENT_SCHEMA_STATEMENTS,
  REVIEW_AUTONOMY_SCHEMA_STATEMENTS,
  STRIPE_EVENT_SCHEMA_STATEMENTS,
  USAGE_TELEMETRY_PROBE_LEASE_SCHEMA_STATEMENTS,
  SUBSCRIPTION_QUOTA_ACTIVE_ONLY_SCHEMA_STATEMENTS,
  LOWER_SUBSCRIPTION_QUOTA_SCHEMA_STATEMENTS,
  PUSH_DEVICES_SCHEMA_STATEMENTS,
  LLM_SPEND_PURPOSE_DOC_SCHEMA_STATEMENTS,
  FILER_IDENTITY_MERGE_SCHEMA_STATEMENTS,
  MEMBERS_DIRECTORY_PERF_SCHEMA_STATEMENTS,
  APPLE_SIGNIN_SCHEMA_STATEMENTS,
  APPLE_IAP_SCHEMA_STATEMENTS,
  REVIEW_QUEUE_RESOLUTION_REASON_SCHEMA_STATEMENTS,
  FILERS_DISPLAY_NAME_SCHEMA_STATEMENTS,
  ADMIN_ALLOWLIST_SCHEMA_STATEMENTS,
  APPLE_SUBSCRIPTIONS_NULLABLE_USER_SCHEMA_STATEMENTS,
  X_AUTH_SCHEMA_STATEMENTS,
  GOV_PROBE_INTERVALS_SCHEMA_STATEMENTS,
  UNBLOCK_NOT_FOUND_HOUSE_PHANTOMS_STATEMENTS,
  LATENCY_TIME_PROVENANCE_SCHEMA_STATEMENTS,
  FEED_LATENCY_JOIN_INDEX_SCHEMA_STATEMENTS,
  PEER_IMPORT_RECEIPT_SCHEMA_STATEMENTS,
} from '../migrations.ts';
import { BENCHMARK_SCHEMA_STATEMENTS } from '../../benchmark/schema.ts';
import {
  beginBenchmarkRun,
  claimBenchmarkMeasurement,
  failBenchmarkRun,
} from '../../benchmark/persistence.ts';

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

const migrationsUrl = new URL(
  '../../../migrations/',
  (import.meta as ImportMeta & { url: string }).url,
);

async function sqliteDatabase(): Promise<SqliteDatabase> {
  // Dynamic module name keeps Worker production types free of Node-only APIs.
  const moduleName = 'node:sqlite';
  const sqlite = await import(moduleName) as SqliteModule;
  return new sqlite.DatabaseSync(':memory:');
}

function migrationFiles(): string[] {
  return readdirSync(migrationsUrl as any).filter((name: string) => name.endsWith('.sql')).sort();
}

function applyMigrationFiles(db: SqliteDatabase, files: string[]): void {
  for (const name of files) {
    db.exec(readFileSync(new URL(name, migrationsUrl) as any, 'utf8'));
  }
}

function applyAdminTail(db: SqliteDatabase): void {
  for (const sql of POST_0024_SCHEMA_STATEMENTS) {
    try {
      db.exec(sql);
    } catch (error) {
      if (!/duplicate column|already exists/i.test((error as Error).message)) throw error;
    }
  }
}

function d1Database(db: SqliteDatabase): D1Database {
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
        return {
          success: true,
          meta: { changes: Number(result.changes) },
        } as unknown as D1Result;
      },
      async all<T>() {
        return { results: db.prepare(sql).all(...params) as T[] };
      },
    };
    return statement;
  };
  return {
    prepare,
    async batch(statements: D1PreparedStatement[]) {
      db.exec('BEGIN');
      try {
        const results: D1Result[] = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

function schemaSnapshot(db: SqliteDatabase): Record<string, unknown> {
  const objects = db.prepare(
    `SELECT type, name, tbl_name
       FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name`,
  ).all();
  const tables = objects
    .filter((row) => row.type === 'table')
    .map((row) => String(row.name));
  const columns = Object.fromEntries(tables.map((table) => [
    table,
    db.prepare(`PRAGMA table_xinfo("${table}")`).all(),
  ]));
  const indexes = Object.fromEntries(tables.map((table) => [
    table,
    db.prepare(`PRAGMA index_list("${table}")`).all(),
  ]));
  return { objects, columns, indexes };
}

describe('admin migration bootstrap', () => {
  it('creates base tables before incremental ALTER statements run', () => {
    expect(BASE_SCHEMA_STATEMENTS[0]).toContain('CREATE TABLE IF NOT EXISTS filers');
    expect(BASE_SCHEMA_STATEMENTS.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS transactions'))).toBe(true);
    expect(BASE_SCHEMA_STATEMENTS.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS review_queue'))).toBe(true);
  });
  it('includes reliability schema mirrored by migrations 0030 and 0031', () => {
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('delivery_outbox');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('ingestion_outbox');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('dead_letter_cycles');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('claim_token');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('lease_until');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('trg_subscriptions_total_quota');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('source_attempts');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('trg_sse_subscription_connection_quota');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('trg_sse_client_connection_quota');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('idx_deliveries_subscription_tx');
  });

  it('mirrors migrations 0029 and 0032 around the reliability sequence', () => {
    expect(EST_VALUE_SCHEMA_STATEMENTS.join('\n')).toContain('est_value');
    expect(EST_VALUE_SCHEMA_STATEMENTS.join('\n')).toContain('amount_min + amount_max');
    expect(STRIPE_EVENT_SCHEMA_STATEMENTS.join('\n')).toContain('claim_token');
    expect(STRIPE_EVENT_SCHEMA_STATEMENTS.join('\n')).toContain('claim_expires_at');
    expect(STRIPE_EVENT_SCHEMA_STATEMENTS.join('\n')).toContain('stripe_subscription_event_state');
    expect(STRIPE_EVENT_SCHEMA_STATEMENTS.join('\n')).toContain('idx_stripe_subscription_event_customer');
    expect(POST_0024_SCHEMA_STATEMENTS).toEqual([
      'ALTER TABLE extraction_runs ADD COLUMN usage_json TEXT',
      ...EST_VALUE_SCHEMA_STATEMENTS,
      ...RELIABILITY_SCHEMA_STATEMENTS,
      ...STRIPE_EVENT_SCHEMA_STATEMENTS,
      ...REVIEW_AUTONOMY_SCHEMA_STATEMENTS,
      ...BENCHMARK_SCHEMA_STATEMENTS,
      `CREATE TABLE IF NOT EXISTS batch_extractions_pending (
     doc_id        TEXT PRIMARY KEY,
     chamber       TEXT NOT NULL,
     enqueued_at   TEXT NOT NULL
   )`,
      `CREATE INDEX IF NOT EXISTS idx_batch_pending_enqueued ON batch_extractions_pending (enqueued_at)`,
      `CREATE TABLE IF NOT EXISTS usage_telemetry_fallback_events (
     idempotency_key TEXT PRIMARY KEY,
     event_json TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
     last_error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
      `CREATE INDEX IF NOT EXISTS idx_usage_telemetry_fallback_events_updated
     ON usage_telemetry_fallback_events (updated_at)`,
      ...PRICE_BACKFILL_TERMINATION_SCHEMA_STATEMENTS,
      'CREATE INDEX IF NOT EXISTS idx_tx_doc ON transactions (doc_id)',
      ...D1_BUDGET_SCHEMA_STATEMENTS,
      ...USAGE_TELEMETRY_PROBE_LEASE_SCHEMA_STATEMENTS,
      ...SUBSCRIPTION_QUOTA_ACTIVE_ONLY_SCHEMA_STATEMENTS,
      ...RETENTION_INDEX_SCHEMA_STATEMENTS,
      ...AUTOPILOT_SCHEMA_STATEMENTS,
      ...DOC_CLASS_SCHEMA_STATEMENTS,
      ...RESOURCE_GOVERNOR_SCHEMA_STATEMENTS,
      ...DENO_RUNTIME_QUEUE_SCHEMA_STATEMENTS,
      ...SPEND_SETTLEMENT_SCHEMA_STATEMENTS,
      ...ACCOUNTING_PROJECTION_SCHEMA_STATEMENTS,
      ...ACCOUNTING_PROJECTION_RESYNC_SCHEMA_STATEMENTS,
      ...QUERY_OPTIMIZATIONS_SCHEMA_STATEMENTS,
      ...PERFORMANCE_INDEXES_SCHEMA_STATEMENTS,
      ...TURSO_QUERY_EFFICIENCY_SCHEMA_STATEMENTS,
      ...TRADE_LATENCY_WATCH_SCHEMA_STATEMENTS,
      ...TRADE_LATENCY_WATCH_COLUMN_FIX_SCHEMA_STATEMENTS,
      ...TRADE_LATENCY_SCOREBOARD_INDEX_SCHEMA_STATEMENTS,
      ...DENO_RUNTIME_KV_SCHEMA_STATEMENTS,
      ...CLEAN_PLACEHOLDER_TICKERS_SCHEMA_STATEMENTS,
      ...FIX_DENO_RUNTIME_QUEUE_INDEX_SCHEMA_STATEMENTS,
      ...FILINGS_FILED_DATE_INDEX_SCHEMA_STATEMENTS,
      ...DENO_RUNTIME_QUEUE_DEAD_LETTER_CYCLES_SCHEMA_STATEMENTS,
      ...STOCK_ACT_STATUS_SCHEMA_STATEMENTS,
      ...FILER_BIOGUIDE_RESOLUTION_SCHEMA_STATEMENTS,
      ...CLEAN_OCR_DOT_LEADERS_SCHEMA_STATEMENTS,
      ...CURSOR_SEQ_INTEGRITY_SCHEMA_STATEMENTS,
      ...CLIENT_COMMAND_SECRET_CLAIM_SCHEMA_STATEMENTS,
      ...PURGE_LEAKED_KV_CREDENTIALS_SCHEMA_STATEMENTS,
      ...QUEUE_OUTBOX_RETENTION_INDEX_SCHEMA_STATEMENTS,
      ...LOCAL_VISION_WORKER_SCHEMA_STATEMENTS,
      ...LOWER_SUBSCRIPTION_QUOTA_SCHEMA_STATEMENTS,
      ...PUSH_DEVICES_SCHEMA_STATEMENTS,
      ...LLM_SPEND_PURPOSE_DOC_SCHEMA_STATEMENTS,
      ...FILER_IDENTITY_MERGE_SCHEMA_STATEMENTS,
      ...MEMBERS_DIRECTORY_PERF_SCHEMA_STATEMENTS,
      ...APPLE_SIGNIN_SCHEMA_STATEMENTS,
      ...APPLE_IAP_SCHEMA_STATEMENTS,
      ...REVIEW_QUEUE_RESOLUTION_REASON_SCHEMA_STATEMENTS,
      ...FILERS_DISPLAY_NAME_SCHEMA_STATEMENTS,
      ...LATENCY_PROBE_LEASE_SCHEMA_STATEMENTS,
      ...ASSET_NORMALIZATION_0085_SCHEMA_STATEMENTS,
      ...APNS_FANOUT_STATE_SCHEMA_STATEMENTS,
      ...LATENCY_PRICE_SNAPSHOT_SCHEMA_STATEMENTS,
      ...TWIN_SEEK_INDEX_SCHEMA_STATEMENTS,
      ...PROBE_RUN_BRACKET_SCHEMA_STATEMENTS,
      ...ADMIN_ALLOWLIST_SCHEMA_STATEMENTS,
      ...APPLE_SUBSCRIPTIONS_NULLABLE_USER_SCHEMA_STATEMENTS,
      ...LATENCY_PRICE_SNAPSHOT_REPAIR_SCHEMA_STATEMENTS,
      ...PREMIUM_ACTIVATION_ALERT_SCHEMA_STATEMENTS,
      ...X_AUTH_SCHEMA_STATEMENTS,
      ...LATENCY_SNAPSHOT_12H_SWEEP_SCHEMA_STATEMENTS,
      ...GOV_PROBE_INTERVALS_SCHEMA_STATEMENTS,
      ...UNBLOCK_NOT_FOUND_HOUSE_PHANTOMS_STATEMENTS,
      ...LATENCY_TIME_PROVENANCE_SCHEMA_STATEMENTS,
      ...FEED_LATENCY_JOIN_INDEX_SCHEMA_STATEMENTS,
      ...PEER_IMPORT_RECEIPT_SCHEMA_STATEMENTS,
    ]);
  });

  it('unblocks House phantom not_found rows (0097)', () => {
    const sql = UNBLOCK_NOT_FOUND_HOUSE_PHANTOMS_STATEMENTS.join('\n');
    expect(sql).toContain("ingest_status = 'not_found'");
    expect(sql).toContain("error LIKE '%phantom%'");
    expect(sql).toContain("DELETE FROM ingestion_outbox");
    expect(sql).toContain("DELETE FROM filings");
  });

  it('indexes trade_latency_candidates by doc_id for the feed join (0099)', () => {
    const sql = FEED_LATENCY_JOIN_INDEX_SCHEMA_STATEMENTS.join('\n');
    expect(sql).toContain('idx_trade_latency_candidates_doc');
    expect(sql).toContain('trade_latency_candidates (doc_id, ticker, tx_date, tx_type)');
  });

  it('adds observed-vs-claimed time provenance on latency snapshots (0098)', () => {
    const sql = LATENCY_TIME_PROVENANCE_SCHEMA_STATEMENTS.join('\n');
    expect(sql).toContain('ADD COLUMN time_provenance TEXT');
    expect(sql).toContain("time_provenance = 'observed'");
    expect(sql).toContain("event = 'ct_publish'");
  });

  it('includes the persisted admin allowlist + audit trail (0090)', () => {
    const sql = ADMIN_ALLOWLIST_SCHEMA_STATEMENTS.join('\n');
    expect(sql).toContain('admin_allowlist');
    expect(sql).toContain('granted_by  TEXT NOT NULL');
    expect(sql).toContain('admin_access_audit');
    expect(sql).toContain('idx_admin_access_audit_created');
  });

  it('reopens missed_window snapshots and adds confidence/session/backfill columns (0092)', () => {
    const sql = LATENCY_PRICE_SNAPSHOT_REPAIR_SCHEMA_STATEMENTS.join('\n');
    expect(sql).toContain('ADD COLUMN capture_mode TEXT');
    expect(sql).toContain('ADD COLUMN confidence TEXT');
    expect(sql).toContain('ADD COLUMN due_at_uncertainty_sec INTEGER');
    expect(sql).toContain('ADD COLUMN market_session TEXT');
    expect(sql).toContain('ADD COLUMN backfill_attempts INTEGER NOT NULL DEFAULT 0');
    expect(sql).toContain('idx_latency_price_backfill_due');
    expect(sql).toContain("WHERE error IN ('missed_window', 'fmp_quote_http_402')");
  });

  it('reopens missed_window rows on real SQLite and stays idempotent on replay (0092)', async () => {
    const db = await sqliteDatabase();
    applyMigrationFiles(db, migrationFiles());

    const insertSnapshot = (event: string, error: string | null, capturedAt: string | null): void => {
      db.prepare(
        `INSERT INTO latency_price_snapshots (trade_hash, ticker, provider, event, due_at, captured_at, price, error, created_at)
         VALUES ('h1', 'AAPL', 'fmp', ?, '2026-08-01T00:00:00Z', ?, NULL, ?, '2026-08-01T00:00:00Z')`,
      ).run(event, capturedAt, error);
    };
    // A row previously abandoned with missed_window ...
    insertSnapshot('ct_publish', 'missed_window', '2026-08-01T00:03:00Z');
    // ... a row already terminal with a real outcome, which must never be
    // reset by any later replay of the reopen UPDATE ...
    insertSnapshot('provider_publish', 'confirmed_no_bars', '2026-08-02T00:00:00Z');
    // ... and a row already successfully captured.
    db.prepare(
      `INSERT INTO latency_price_snapshots (trade_hash, ticker, provider, event, due_at, captured_at, price, error, created_at)
       VALUES ('h1', 'AAPL', 'fmp', 'provider_plus_5m', '2026-08-01T00:05:00Z', '2026-08-01T00:05:30Z', 190.5, NULL, '2026-08-01T00:00:00Z')`,
    ).run();

    // Replayed on every deploy (POST /api/admin/migrate re-runs the full
    // statement list, tolerating "duplicate column"/"already exists" the way
    // the real route does — see applyAdminTail), so applying the tail twice
    // more must change nothing further than the first reopen pass.
    applyAdminTail(db);
    applyAdminTail(db);

    const rows = db
      .prepare('SELECT event, captured_at, error FROM latency_price_snapshots ORDER BY event')
      .all() as Array<{ event: string; captured_at: string | null; error: string | null }>;
    const byEvent = Object.fromEntries(rows.map((r) => [r.event, r]));

    expect(byEvent.ct_publish).toEqual({ event: 'ct_publish', captured_at: null, error: null });
    expect(byEvent.provider_publish).toEqual({
      event: 'provider_publish',
      captured_at: '2026-08-02T00:00:00Z',
      error: 'confirmed_no_bars',
    });
    expect(byEvent.provider_plus_5m).toEqual({
      event: 'provider_plus_5m',
      captured_at: '2026-08-01T00:05:30Z',
      error: null,
    });

    const cols = db
      .prepare("PRAGMA table_info(latency_price_snapshots)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const col of ['capture_mode', 'confidence', 'due_at_uncertainty_sec', 'market_session', 'backfill_attempts']) {
      expect(names).toContain(col);
    }

    db.close();  });

  it('includes the twin-seek covering index (0088 / #2062)', () => {
    const sql = TWIN_SEEK_INDEX_SCHEMA_STATEMENTS.join('\n');
    expect(sql).toContain('idx_tx_twin_seek');
    expect(sql).toContain('(filer_id, tx_date)');
    expect(sql).toContain('deprecated_at IS NULL');
  });

  it('includes immutable LLM and autopilot spend settlements (0053)', () => {
    const sql = SPEND_SETTLEMENT_SCHEMA_STATEMENTS.join('\n');
    expect(sql).toContain('llm_spend_settlements');
    expect(sql).toContain('provider_response_id');
    expect(sql).toContain('autopilot_budget_settlements');
    expect(sql).toContain('trg_autopilot_budget_settlement');
  });

  it('includes bounded accounting projections and durable reservations (0054)', () => {
    const sql = ACCOUNTING_PROJECTION_SCHEMA_STATEMENTS.join('\n');
    expect(sql).toContain('llm_spend_settlement_totals');
    expect(sql).toContain('trg_llm_spend_settlement_projection');
    expect(sql).toContain('autopilot_budget_reservations');
    expect(sql).toContain('trg_autopilot_budget_reserve');
    expect(sql).toContain('trg_autopilot_budget_reservation_settle');
  });

  it('resyncs the projection after trigger installation (0055)', () => {
    const sql = ACCOUNTING_PROJECTION_RESYNC_SCHEMA_STATEMENTS.join('\n');
    expect(sql).toContain('SUM(usd)');
    expect(sql).toContain('usd = excluded.usd');
  });

  it('includes the Turso-backed Deno runtime queue schema (0052)', () => {
    const sql = DENO_RUNTIME_QUEUE_SCHEMA_STATEMENTS.join('\n');
    expect(sql).toContain('deno_runtime_queue');
    expect(sql).toContain('lease_until');
    expect(sql).toContain('lease_until');
    expect(sql).toContain('idx_deno_runtime_queue_active_dedupe');
    expect(sql).toContain("status IN ('pending', 'processing')");
  });

  it('indexes retention-sweep timestamp columns so age-only deletes range-scan (0048)', () => {
    const sql = RETENTION_INDEX_SCHEMA_STATEMENTS.join('\n');
    expect(sql).toContain('idx_ingest_log_polled_at ON ingest_log (polled_at)');
    expect(sql).toContain('idx_source_attempts_attempted_at ON source_attempts (attempted_at)');
  });

  it('includes the autopilot receipts/budget + doc_class schema (0049-0050)', () => {
    const sql = AUTOPILOT_SCHEMA_STATEMENTS.join('\n');
    expect(sql).toContain('autopilot_runs');
    expect(sql).toContain('run_trigger         TEXT NOT NULL');
    expect(sql).toContain('spend_microusd INTEGER NOT NULL DEFAULT 0');
    expect(sql).toContain('idx_autopilot_runs_status');
    expect(sql).toContain('autopilot_budget');
    expect(DOC_CLASS_SCHEMA_STATEMENTS.join('\n'))
      .toContain('ALTER TABLE filings ADD COLUMN doc_class TEXT');
  });

  it('includes the resource governor schema (0051)', () => {
    const sql = RESOURCE_GOVERNOR_SCHEMA_STATEMENTS.join('\n');
    expect(sql).toContain('llm_spend');
    expect(sql).toContain('PRIMARY KEY (day, provider)');
    expect(sql).toContain('d1_write_quarantine');
    expect(sql).toContain('idx_d1_write_quarantine_day');
    expect(sql).toContain('delivery_target_circuit');
    expect(sql).toContain('consecutive_failures');
    expect(sql).toContain('failures_today');
  });

  it('includes the singleton usage telemetry half-open lease schema (0046)', () => {
    const sql = USAGE_TELEMETRY_PROBE_LEASE_SCHEMA_STATEMENTS.join('\n');
    expect(sql).toContain('usage_telemetry_probe_lease');
    expect(sql).toContain('CHECK (id = 1)');
    expect(sql).toContain('lease_token TEXT NOT NULL');
    expect(sql).toContain('expires_at  TEXT NOT NULL');
  });

  it('counts only active rows toward the total subscription quota trigger (0047)', () => {
    const sql = SUBSCRIPTION_QUOTA_ACTIVE_ONLY_SCHEMA_STATEMENTS.join('\n');
    expect(sql).toContain('DROP TRIGGER IF EXISTS trg_subscriptions_total_quota');
    expect(sql).toContain('trg_subscriptions_total_quota');
    expect(sql).toContain('client_id = NEW.client_id AND active = 1');
    expect(sql).toContain('subscription total quota exceeded');
  });

  it('negative-caches un-priceable tickers and indexes latest_price_date (0043)', () => {
    const sql = PRICE_BACKFILL_TERMINATION_SCHEMA_STATEMENTS.join('\n');
    expect(sql).toContain('price_unavailable INTEGER NOT NULL DEFAULT 0');
    expect(sql).toContain('price_checked_at TEXT');
    expect(sql).toContain('latest_price_date TEXT');
    expect(sql).toContain('idx_secref_latest_price_date');
    expect(sql).toContain('SELECT MAX(pe.date) FROM price_eod');
    expect(sql).toContain('AND EXISTS (SELECT 1 FROM price_eod pe WHERE pe.ticker = securities_ref.ticker)');
  });

  it('covers Turso claim ORDER BY and migrate backfill probes (0058)', () => {
    const sql = TURSO_QUERY_EFFICIENCY_SCHEMA_STATEMENTS.join('\n');
    expect(sql).toContain('idx_deno_runtime_queue_pending_id');
    expect(sql).toContain('idx_deno_runtime_queue_processing_id');
    expect(sql).toContain('idx_tx_missing_disclosure_anchors');
    expect(sql).toContain('idx_secref_missing_latest_price_date');
    expect(sql).toContain('price_eod_stats');
    expect(sql).toContain('WHERE id = 1 AND row_count = 0');
  });

  it('includes the review autonomy schema mirrored by migrations 0033-0037', () => {
    const sql = REVIEW_AUTONOMY_SCHEMA_STATEMENTS.join('\n');
    expect(sql).toContain('page_count');
    expect(sql).toContain('agreement_attempts');
    expect(sql).toContain('agreement_legacy_replay_at');
    expect(sql).toContain('llm_budget');
    expect(sql).toContain('agreement_suppressed_at');
    expect(sql).toContain('idx_transactions_live_doc_source_rowkey');
    expect(sql).toContain('review_revision');
    expect(sql).not.toContain('review_delivery_outbox');
  });

  it('matches the real 0029-0041 file schema and passes readiness on SQLite', async () => {
    const files = migrationFiles();
    const priorFiles = files.filter((name) => Number(name.slice(0, 4)) <= 24);
    const fileDb = await sqliteDatabase();
    const adminDb = await sqliteDatabase();
    try {
      applyMigrationFiles(fileDb, files);
      applyMigrationFiles(adminDb, priorFiles);
      applyAdminTail(adminDb);

      expect(schemaSnapshot(adminDb)).toEqual(schemaSnapshot(fileDb));
      expect(await checkReadiness(d1Database(fileDb))).toEqual({
        ok: true,
        db: true,
        schema: true,
        missing: [],
      });
    } finally {
      fileDb.close();
      adminDb.close();
    }
  });

  it('executes the production transaction/outbox write idempotently on migrated SQLite', async () => {
    const db = await sqliteDatabase();
    try {
      applyMigrationFiles(db, migrationFiles());
      const d1 = d1Database(db);
      const env = { DB: d1 } as unknown as Env;
      const transaction: Transaction = {
        id: 'tx-1',
        docId: 'doc-1',
        filerId: null,
        txDate: '2026-07-01',
        owner: 'self',
        assetName: 'Example Corp',
        ticker: 'EXM',
        assetType: 'stock',
        txType: 'B',
        amountMin: 15_001,
        amountMax: 50_000,
        isOption: false,
        capGainsOver200: false,
        rawText: 'Example Corp (EXM)',
        rowKey: 'primary:0:example',
        confidence: 0.99,
        source: 'primary',
        createdAt: '2026-07-11T00:00:00.000Z',
        cursorSeq: 0,
        firstSeenAt: '2026-07-11T00:00:00.000Z',
        filedDate: '2026-07-10',
      };

      expect(await persistTransactions(env, [transaction])).toEqual(['tx-1']);
      expect(await persistTransactions(env, [{ ...transaction, id: 'tx-retry' }])).toEqual([]);

      expect(db.prepare(
        'SELECT id, cursor_seq, est_value FROM transactions WHERE row_key = ?',
      ).get(transaction.rowKey)).toMatchObject({
        id: 'tx-1',
        est_value: 32_500.5,
      });
      expect(Number(db.prepare('SELECT cursor_seq FROM transactions WHERE id = ?').get('tx-1')?.cursor_seq)).toBeGreaterThan(0);
      expect(db.prepare('SELECT COUNT(*) AS count FROM delivery_outbox').get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('prevents a new benchmark cell claim after the run becomes terminal', async () => {
    const db = await sqliteDatabase();
    try {
      applyMigrationFiles(db, migrationFiles());
      const d1 = d1Database(db);
      await beginBenchmarkRun(d1, {
        id: 'run-cancel-race',
        chamber: 'house',
        models: [{ provider: 'openai', model: 'gpt-test' }],
        documents: [
          { docId: 'H-1', resolved: false },
          { docId: 'H-2', resolved: false },
        ],
        startedAt: '2026-07-14T12:00:00.000Z',
      });

      await expect(claimBenchmarkMeasurement(d1, {
        runId: 'run-cancel-race',
        docId: 'H-1',
        provider: 'openai',
        model: 'gpt-test',
        now: '2026-07-14T12:00:01.000Z',
      })).resolves.toMatchObject({ claimed: true, state: 'claimed' });
      await expect(failBenchmarkRun(
        d1,
        'run-cancel-race',
        'Stopped by operator',
        '2026-07-14T12:00:02.000Z',
      )).resolves.toBe(true);
      await expect(claimBenchmarkMeasurement(d1, {
        runId: 'run-cancel-race',
        docId: 'H-2',
        provider: 'openai',
        model: 'gpt-test',
        now: '2026-07-14T12:00:03.000Z',
      })).resolves.toEqual({
        claimed: false,
        claimToken: null,
        leaseUntil: null,
        state: 'inactive',
        reclaimedUnknownOutcome: false,
      });
      expect(db.prepare(
        `SELECT COUNT(*) AS count
           FROM benchmark_model_results
          WHERE run_id = ? AND doc_id = ?`,
      ).get('run-cancel-race', 'H-2')).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('preserves partial disclosure dates on replayed /migrate runs (0020 regression)', async () => {
    const db = await sqliteDatabase();
    try {
      for (const sql of BASE_SCHEMA_STATEMENTS) db.exec(sql);
      db.exec(
        `INSERT INTO filings (doc_id, filed_date, first_seen_at)
           VALUES ('doc-1', '2026-06-01', '2026-06-01T12:00:00.000Z')`,
      );
      db.exec(
        `INSERT INTO transactions (id, doc_id, created_at)
           VALUES ('tx-needs-backfill', 'doc-1', '2026-06-01T12:00:00.000Z')`,
      );

      const runStatements = (): number => {
        let updateChanges = -1;
        for (const sql of DISCLOSURE_AVAILABLE_SCHEMA_STATEMENTS) {
          try {
            const result = db.prepare(sql).run();
            if (/^\s*UPDATE transactions SET/i.test(sql)) updateChanges = Number(result.changes);
          } catch (error) {
            if (!/duplicate column|already exists/i.test((error as Error).message)) throw error;
          }
        }
        return updateChanges;
      };

      expect(runStatements()).toBe(1);
      expect(db.prepare(
        'SELECT first_seen_at, filed_date FROM transactions WHERE id = ?',
      ).get('tx-needs-backfill')).toEqual({
        first_seen_at: '2026-06-01T12:00:00.000Z',
        filed_date: '2026-06-01',
      });

      db.exec(
        `INSERT INTO transactions (id, doc_id, created_at, first_seen_at, filed_date)
           VALUES ('tx-seed', NULL, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '2026-04-30')`,
      );
      db.exec(
        `INSERT INTO transactions (id, doc_id, created_at, first_seen_at, filed_date)
           VALUES ('tx-partial', 'doc-1', '2026-06-02T00:00:00.000Z', '2026-06-02T00:00:00.000Z', NULL)`,
      );
      db.exec(
        `INSERT INTO filings (doc_id, filed_date, first_seen_at)
           VALUES ('doc-2', NULL, '2026-06-03T12:00:00.000Z')`,
      );
      db.exec(
        `INSERT INTO transactions (id, doc_id, created_at, first_seen_at, filed_date)
           VALUES ('tx-unfillable', 'doc-2', '2026-06-03T00:00:00.000Z', '2026-06-03T12:00:00.000Z', NULL)`,
      );

      expect(runStatements()).toBe(1);
      expect(db.prepare(
        'SELECT first_seen_at, filed_date FROM transactions WHERE id = ?',
      ).get('tx-seed')).toEqual({
        first_seen_at: '2026-05-01T00:00:00.000Z',
        filed_date: '2026-04-30',
      });
      expect(db.prepare(
        'SELECT first_seen_at, filed_date FROM transactions WHERE id = ?',
      ).get('tx-partial')).toEqual({
        first_seen_at: '2026-06-02T00:00:00.000Z',
        filed_date: '2026-06-01',
      });
      expect(db.prepare(
        'SELECT first_seen_at, filed_date FROM transactions WHERE id = ?',
      ).get('tx-unfillable')).toEqual({
        first_seen_at: '2026-06-03T12:00:00.000Z',
        filed_date: null,
      });
      const afterPartialBackfill = db.prepare(
        'SELECT id, first_seen_at, filed_date FROM transactions ORDER BY id',
      ).all();
      expect(runStatements()).toBe(0);
      expect(db.prepare(
        'SELECT id, first_seen_at, filed_date FROM transactions ORDER BY id',
      ).all()).toEqual(afterPartialBackfill);
    } finally {
      db.close();
    }
  });

  it('enforces unique migration sequence numbers except for the grandfathered 0041 pair', () => {
    const files = migrationFiles();
    const grandfatheredSequence = 41;
    const grandfatheredPair = [
      '0041_batch_extractions_pending.sql',
      '0041_benchmark_single_running_chamber.sql',
    ].sort();
    const bySequence = new Map<number, string[]>();
    let previousSequence = -1;
    for (const name of files) {
      const match = name.match(/^(\d{4})_/);
      expect(match, `${name} must start with a 4-digit sequence number`).not.toBeNull();
      const sequence = Number(match?.[1]);
      expect(sequence, `${name} moves the migration sequence backwards`).toBeGreaterThanOrEqual(previousSequence);
      previousSequence = sequence;
      bySequence.set(sequence, [...(bySequence.get(sequence) ?? []), name]);
    }
    for (const [sequence, names] of bySequence) {
      if (names.length === 1) continue;
      expect(sequence, `sequence ${sequence} has an ungrandfathered duplicate: ${names.join(', ')}`)
        .toBe(grandfatheredSequence);
      expect(names.slice().sort()).toEqual(grandfatheredPair);
    }
  });
  // ---- cursor_seq trigger swap must never leave a gap ----------------------
  // /migrate executes statements as independent round-trips with no enclosing
  // transaction, so a DROP-then-CREATE on the same trigger name leaves a window
  // in which INSERTs land with cursor_seq = NULL. Such a row is invisible to
  // every feed read (`t.cursor_seq > ?` is applied on EVERY /transactions call
  // because `since` defaults to 0) and cannot be healed by a repair keyed on
  // `>= 1e12`, because `NULL >= 1e12` is NULL, never TRUE.
  it('replaces the cursor trigger without ever leaving the table untriggered, and heals NULL rows', async () => {
    const db = await sqliteDatabase();
    db.exec(`
      CREATE TABLE transactions (id TEXT PRIMARY KEY, created_at TEXT, cursor_seq INTEGER);
      CREATE TABLE tx_cursor_seq (seq INTEGER PRIMARY KEY AUTOINCREMENT, tx_id TEXT NOT NULL);
      CREATE TABLE subscriptions (id TEXT PRIMARY KEY, cursor INTEGER);
    `);
    // The v1 trigger, with the guard that let importers supply their own value.
    db.exec(`
      CREATE TRIGGER trg_transactions_cursor AFTER INSERT ON transactions FOR EACH ROW
      WHEN NEW.cursor_seq IS NULL
      BEGIN
        INSERT INTO tx_cursor_seq (tx_id) VALUES (NEW.id);
        UPDATE transactions SET cursor_seq = (SELECT MAX(seq) FROM tx_cursor_seq WHERE tx_id = NEW.id) WHERE id = NEW.id;
      END;
    `);

    db.exec("INSERT INTO transactions (id, created_at, cursor_seq) VALUES ('normal', '2026-01-01', NULL)");
    // A Date.now() epoch, written while the v1 guard still allowed it.
    db.exec("INSERT INTO transactions (id, created_at, cursor_seq) VALUES ('poisoned', '2026-01-02', 1784939101315)");
    db.exec("INSERT INTO subscriptions (id, cursor) VALUES ('sub-1', 1784939101315)");
    // A row that landed during a no-trigger window: no sequence row, NULL cursor.
    db.exec("INSERT INTO transactions (id, created_at, cursor_seq) VALUES ('orphan', '2026-01-03', 1)");
    db.exec("DELETE FROM tx_cursor_seq WHERE tx_id = 'orphan'");
    db.exec("UPDATE transactions SET cursor_seq = NULL WHERE id = 'orphan'");

    const sql = readFileSync(new URL('0068_cursor_seq_integrity.sql', migrationsUrl) as any, 'utf8') as string;

    // The statement list must never drop v1 before its replacement exists.
    const createV2 = sql.indexOf('CREATE TRIGGER IF NOT EXISTS trg_transactions_cursor_v2');
    const dropV1 = sql.indexOf('DROP TRIGGER IF EXISTS trg_transactions_cursor;');
    expect(createV2).toBeGreaterThan(-1);
    expect(dropV1).toBeGreaterThan(-1);
    expect(createV2).toBeLessThan(dropV1);

    // Replayed on every deploy, so it must be idempotent.
    db.exec(sql);
    db.exec(sql);

    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(triggers.map((t) => t.name)).toEqual(['trg_transactions_cursor_v2']);

    const nulls = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE cursor_seq IS NULL').get() as { n: number };
    expect(nulls.n, 'a NULL cursor_seq is permanently invisible to the feed').toBe(0);

    const poisoned = db
      .prepare('SELECT COUNT(*) AS n FROM transactions WHERE cursor_seq >= 1000000000000')
      .get() as { n: number };
    expect(poisoned.n).toBe(0);

    const sub = db.prepare("SELECT cursor FROM subscriptions WHERE id = 'sub-1'").get() as { cursor: number };
    expect(sub.cursor).toBeLessThan(1000000000000);

    // tx_id lookups are correlated everywhere, including in the trigger itself,
    // which runs on every INSERT — unindexed it full-scans one row per
    // transaction ever written.
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tx_cursor_seq' AND name = 'idx_tx_cursor_seq_tx_id'")
      .all() as Array<{ name: string }>;
    expect(idx).toHaveLength(1);

    // And the new trigger still assigns sequences to fresh inserts.
    db.exec("INSERT INTO transactions (id, created_at, cursor_seq) VALUES ('fresh', '2026-01-04', NULL)");
    const fresh = db.prepare("SELECT cursor_seq FROM transactions WHERE id = 'fresh'").get() as { cursor_seq: number };
    expect(fresh.cursor_seq).toBeGreaterThan(0);
  });
  // ---- prod-mirror parity (CT-AUD-P1-18) ----------------------------------
  // app/migrations/*.sql drives LOCAL dev; the statement list behind
  // POST /api/admin/migrate is the source of truth for PRODUCTION schema. They
  // are maintained by hand in two places, so a migration can silently never
  // reach production — exactly the 0067 drift the audit found.
  //
  // Rather than diffing SQL text (which drifts on formatting alone), this
  // asserts that every schema OBJECT a migration declares — table, index,
  // trigger, added column — also exists in the REAL runtime statement list,
  // collected by driving the actual route. Grepping the source would miss
  // statements contributed by other modules (e.g. src/benchmark/schema.ts).
  it('mirrors every object declared by migrations/*.sql into the production migrate list', async () => {
    const statements: string[] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind() { return this; },
          async run() { statements.push(sql); return { success: true, meta: { changes: 1 } }; },
        };
      },
    } as unknown as D1Database;

    const res = await buildAdminRouter().request(
      '/migrate',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ skipSchemaVerify: true }),
      },
      { ADMIN_TOKEN: 'admin-secret', DB: db } as never,
    );
    expect(res.status).toBe(200);

    const mirror = statements.join('\n').replace(/\s+/g, ' ').toLowerCase();

    const patterns: Array<[RegExp, 'table' | 'index' | 'trigger' | 'column']> = [
      [/create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/gi, 'index'],
      [/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/gi, 'table'],
      [/create\s+trigger\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/gi, 'trigger'],
      [/alter\s+table\s+([a-z0-9_]+)\s+add\s+column\s+([a-z0-9_]+)/gi, 'column'],
    ];

    // Objects a migration creates and then deliberately retires, so the prod
    // mirror correctly never carries them.
    const RETIRED = new Set(['trg_transactions_cursor']);

    const missing: string[] = [];
    for (const name of migrationFiles()) {
      const sql = readFileSync(new URL(name, migrationsUrl) as any, 'utf8') as string;
      for (const [re, kind] of patterns) {
        for (const m of sql.matchAll(re)) {
          const object = kind === 'column' ? `${m[1]}.${m[2]}` : m[1];
          if (RETIRED.has(object.toLowerCase())) continue;
          const needle = kind === 'column'
            ? `alter table ${m[1].toLowerCase()} add column ${m[2].toLowerCase()}`
            : object.toLowerCase();
          if (!mirror.includes(needle)) missing.push(`${name}: ${kind} ${object}`);
        }
      }
    }

    expect(
      missing,
      'These objects exist in app/migrations/*.sql but never reach production, ' +
        'because POST /api/admin/migrate does not create them. Mirror them into ' +
        'the statement list in src/admin/routes.ts (see AGENTS.md "Migrations & deploy").',
    ).toEqual([]);
  });
});
