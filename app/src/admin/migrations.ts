import { BENCHMARK_SCHEMA_STATEMENTS } from '../benchmark/schema.ts';

/** Base schema needed before the incremental, idempotent admin migration list. */
export const BASE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS filers (bioguide_id TEXT PRIMARY KEY, chamber TEXT, full_name TEXT, party TEXT, state TEXT, district TEXT, committees TEXT)`,
  `CREATE TABLE IF NOT EXISTS filings (doc_id TEXT PRIMARY KEY, chamber TEXT, filer_id TEXT, filing_type TEXT, filed_date TEXT, source_url TEXT, raw_object_key TEXT, ingest_status TEXT, doc_kind TEXT, extractor TEXT, model_version TEXT, confidence REAL, first_seen_at TEXT, source_updated_at TEXT, error TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_filings_status ON filings (ingest_status)',
  'CREATE INDEX IF NOT EXISTS idx_filings_filer ON filings (filer_id)',
  `CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, doc_id TEXT, filer_id TEXT, tx_date TEXT, owner TEXT, asset_name TEXT, ticker TEXT, asset_type TEXT, tx_type TEXT, amount_min INTEGER, amount_max INTEGER, is_option INTEGER, cap_gains_over_200 INTEGER, raw_text TEXT, confidence REAL, source TEXT NOT NULL DEFAULT 'primary', created_at TEXT, cursor_seq INTEGER)`,
  `CREATE TABLE IF NOT EXISTS tx_cursor_seq (seq INTEGER PRIMARY KEY AUTOINCREMENT, tx_id TEXT NOT NULL)`,
  // `_v2` carries the sequence-authoritative body (no `WHEN NEW.cursor_seq IS
  // NULL` guard). It is created under a NEW NAME, and the v1 trigger is dropped
  // only later in this same list — see CURSOR_SEQ_INTEGRITY_SCHEMA_STATEMENTS.
  // Replacing v1 in place (DROP then CREATE) leaves a window with NO trigger at
  // all, and /migrate executes statements as independent round-trips with no
  // enclosing transaction, so a concurrent INSERT lands with cursor_seq = NULL —
  // invisible to every feed read forever, and unhealable by a repair keyed on
  // `>= 1e12` (NULL >= 1e12 is NULL, never TRUE). Create-then-drop has no such
  // window; both triggers coexisting briefly is harmless (the row simply
  // consumes two sequence values and keeps the larger).
  `CREATE TRIGGER IF NOT EXISTS trg_transactions_cursor_v2 AFTER INSERT ON transactions FOR EACH ROW BEGIN INSERT INTO tx_cursor_seq (tx_id) VALUES (NEW.id); UPDATE transactions SET cursor_seq = (SELECT MAX(seq) FROM tx_cursor_seq WHERE tx_id = NEW.id) WHERE id = NEW.id; END`,
  'CREATE INDEX IF NOT EXISTS idx_tx_cursor ON transactions (cursor_seq)',
  'CREATE INDEX IF NOT EXISTS idx_tx_ticker ON transactions (ticker)',
  'CREATE INDEX IF NOT EXISTS idx_tx_filer ON transactions (filer_id)',
  'CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions (tx_date)',
  'CREATE TABLE IF NOT EXISTS securities_master (ticker TEXT PRIMARY KEY, name TEXT, aliases TEXT)',
  `CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, client_id TEXT, delivery TEXT, target_url TEXT, secret TEXT, filters TEXT, cursor INTEGER, active INTEGER, created_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_subscriptions_active ON subscriptions (active)',
  `CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, subscription_id TEXT, tx_id TEXT, status TEXT, attempts INTEGER, last_error TEXT, updated_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_deliveries_sub ON deliveries (subscription_id)',
  'CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries (status)',
  `CREATE TABLE IF NOT EXISTS poll_config (id INTEGER PRIMARY KEY CHECK (id = 1), schedule TEXT, aggressive_mode INTEGER, updated_at TEXT)`,
  `INSERT OR IGNORE INTO poll_config (id, schedule, aggressive_mode, updated_at) VALUES (1, '[{"daysOfWeek":[1,2,3,4,5],"startHourET":8,"endHourET":19,"intervalSec":300},{"daysOfWeek":[1,2,3,4,5],"startHourET":19,"endHourET":24,"intervalSec":1200},{"daysOfWeek":[1,2,3,4,5],"startHourET":0,"endHourET":8,"intervalSec":1200},{"daysOfWeek":[0,6],"startHourET":0,"endHourET":24,"intervalSec":3600}]', 0, '1970-01-01T00:00:00.000Z')`,
  `CREATE TABLE IF NOT EXISTS review_queue (doc_id TEXT PRIMARY KEY, reason TEXT, payload TEXT, created_at TEXT, resolved INTEGER)`,
  'CREATE INDEX IF NOT EXISTS idx_review_resolved ON review_queue (resolved)',
  `CREATE TABLE IF NOT EXISTS ingest_log (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, polled_at TEXT NOT NULL, new_count INTEGER NOT NULL DEFAULT 0, first_seen_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_ingest_log_source ON ingest_log (source, polled_at)',
  // Feed joins.  CREATE IF NOT EXISTS so sqlite tests that exec only this list
  // can prepare GET /api/transactions.  Production already has both tables, so
  // a repeat create is a no-op.  price_at_filing matches migration 0014.
  `CREATE TABLE IF NOT EXISTS tx_performance (
     tx_id TEXT PRIMARY KEY,
     price_at_trade REAL,
     spx_at_trade REAL,
     price_at_filing REAL,
     spx_at_filing REAL,
     computed_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS trade_latency_candidates (
     trade_hash TEXT NOT NULL,
     doc_id TEXT NOT NULL,
     provider TEXT NOT NULL DEFAULT 'fmp',
     chamber TEXT NOT NULL,
     source_url TEXT,
     filed_date TEXT,
     filer_name TEXT,
     ticker TEXT,
     tx_date TEXT,
     tx_type TEXT,
     congress_first_seen_at TEXT NOT NULL,
     provider_key TEXT,
     provider_first_seen_at TEXT,
     provider_published_at TEXT,
     match_method TEXT,
     status TEXT NOT NULL DEFAULT 'pending',
     attempts INTEGER NOT NULL DEFAULT 0,
     last_checked_at TEXT,
     error TEXT,
     payload TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (trade_hash, provider)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_trade_latency_candidates_doc
     ON trade_latency_candidates (doc_id, ticker, tx_date, tx_type)`,
] as const;

/**
 * 0020_disclosure_available_generated.sql — point-in-time disclosure
 * availability (first_seen_at/filed_date backfill + generated column + index).
 * Mirrors migrations/0020_disclosure_available_generated.sql's schema exactly,
 * but the backfill UPDATE below preserves any value already present on the
 * transaction and only fills missing columns from a matching filing. POST
 * /api/admin/migrate replays this whole statement list on every call; the
 * one-shot file migration does not need the same replay-safe guard.
 */
export const DISCLOSURE_AVAILABLE_SCHEMA_STATEMENTS = [
  'ALTER TABLE transactions ADD COLUMN first_seen_at TEXT',
  'ALTER TABLE transactions ADD COLUMN filed_date TEXT',
  `UPDATE transactions SET
   first_seen_at = COALESCE(first_seen_at, (SELECT first_seen_at FROM filings WHERE filings.doc_id = transactions.doc_id)),
     filed_date = COALESCE(filed_date, (SELECT filed_date FROM filings WHERE filings.doc_id = transactions.doc_id))
   WHERE EXISTS (
     SELECT 1 FROM filings
      WHERE filings.doc_id = transactions.doc_id
        AND ((transactions.first_seen_at IS NULL AND filings.first_seen_at IS NOT NULL)
          OR (transactions.filed_date IS NULL AND filings.filed_date IS NOT NULL))
   )`,
  `ALTER TABLE transactions ADD COLUMN disclosure_available_at TEXT GENERATED ALWAYS AS (
     COALESCE(first_seen_at, CASE WHEN filed_date IS NOT NULL THEN filed_date || 'T00:00:00.000Z' END, created_at)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_tx_disclosure_available_ticker ON transactions (disclosure_available_at, ticker, id)',
] as const;

export const EST_VALUE_SCHEMA_STATEMENTS = [
  'ALTER TABLE transactions ADD COLUMN est_value REAL',
  `UPDATE transactions SET est_value = CASE
     WHEN amount_min IS NULL AND amount_max IS NULL THEN 0
     WHEN amount_min IS NULL THEN amount_max
     WHEN amount_max IS NULL THEN amount_min
     ELSE (amount_min + amount_max) / 2.0
   END WHERE est_value IS NULL`,
] as const;

export const RELIABILITY_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS delivery_outbox (tx_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, dead_letter_cycles INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_delivery_outbox_ready ON delivery_outbox(status, available_at)',
  'ALTER TABLE delivery_outbox ADD COLUMN dead_letter_cycles INTEGER NOT NULL DEFAULT 0',
  `CREATE TABLE IF NOT EXISTS ingestion_outbox (doc_id TEXT PRIMARY KEY, chamber TEXT NOT NULL, source_url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, dead_letter_cycles INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_ingestion_outbox_ready ON ingestion_outbox(status, available_at)',
  'ALTER TABLE ingestion_outbox ADD COLUMN dead_letter_cycles INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE deliveries ADD COLUMN claim_token TEXT',
  'ALTER TABLE deliveries ADD COLUMN lease_until TEXT',
  'CREATE INDEX IF NOT EXISTS idx_deliveries_lease ON deliveries(status, lease_until)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_subscription_tx ON deliveries(subscription_id, tx_id)',
  `CREATE TABLE IF NOT EXISTS sse_leases (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, client_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_sse_leases_expiry ON sse_leases(expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_sse_leases_subscription ON sse_leases(subscription_id, expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_sse_leases_client ON sse_leases(client_id, expires_at)',
  `CREATE TRIGGER IF NOT EXISTS trg_sse_subscription_connection_quota BEFORE INSERT ON sse_leases WHEN (SELECT COUNT(*) FROM sse_leases WHERE subscription_id = NEW.subscription_id AND expires_at > NEW.created_at) >= 2 BEGIN SELECT RAISE(ABORT, 'sse subscription connection quota exceeded'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_sse_client_connection_quota BEFORE INSERT ON sse_leases WHEN (SELECT COUNT(*) FROM sse_leases WHERE client_id = NEW.client_id AND expires_at > NEW.created_at) >= 5 BEGIN SELECT RAISE(ABORT, 'sse client connection quota exceeded'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_subscriptions_total_quota BEFORE INSERT ON subscriptions WHEN (SELECT COUNT(*) FROM subscriptions WHERE client_id = NEW.client_id) >= 20 BEGIN SELECT RAISE(ABORT, 'subscription total quota exceeded'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_subscriptions_active_insert_quota BEFORE INSERT ON subscriptions WHEN NEW.active = 1 AND (SELECT COUNT(*) FROM subscriptions WHERE client_id = NEW.client_id AND active = 1) >= 10 BEGIN SELECT RAISE(ABORT, 'subscription active quota exceeded'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_subscriptions_active_update_quota BEFORE UPDATE OF active, client_id ON subscriptions WHEN NEW.active = 1 AND (OLD.active != 1 OR OLD.client_id != NEW.client_id) AND (SELECT COUNT(*) FROM subscriptions WHERE client_id = NEW.client_id AND active = 1 AND id != OLD.id) >= 10 BEGIN SELECT RAISE(ABORT, 'subscription active quota exceeded'); END`,
  `CREATE TABLE IF NOT EXISTS source_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, attempted_at TEXT NOT NULL, outcome TEXT NOT NULL, new_count INTEGER NOT NULL DEFAULT 0, error TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_source_attempts_source_time ON source_attempts(source, attempted_at DESC)',
] as const;

export const STRIPE_EVENT_SCHEMA_STATEMENTS = [
  'ALTER TABLE stripe_webhook_events ADD COLUMN claim_token TEXT',
  'ALTER TABLE stripe_webhook_events ADD COLUMN claim_expires_at TEXT',
  `CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_claim_expiry
     ON stripe_webhook_events (processed_at, claim_expires_at)`,
  `CREATE TABLE IF NOT EXISTS stripe_subscription_event_state (
     subscription_id TEXT PRIMARY KEY,
     customer_id TEXT NOT NULL,
     last_event_created INTEGER NOT NULL,
     last_event_priority INTEGER NOT NULL,
     last_event_id TEXT NOT NULL,
     last_event_type TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_stripe_subscription_event_customer
     ON stripe_subscription_event_state (customer_id, last_event_created DESC)`,
] as const;

export const REVIEW_COMPLEXITY_SCHEMA_STATEMENTS = [
  'ALTER TABLE filings ADD COLUMN page_count INTEGER',
  'ALTER TABLE filings ADD COLUMN raw_bytes INTEGER',
] as const;

export const REVIEW_AGREEMENT_SCHEMA_STATEMENTS = [
  'ALTER TABLE review_queue ADD COLUMN agreement_attempts INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE review_queue ADD COLUMN agreement_tier INTEGER',
  'ALTER TABLE review_queue ADD COLUMN agreement_next_attempt_at TEXT',
  'ALTER TABLE review_queue ADD COLUMN agreement_claim_token TEXT',
  'ALTER TABLE review_queue ADD COLUMN agreement_claimed_at TEXT',
  'ALTER TABLE review_queue ADD COLUMN agreement_legacy_replay_at TEXT',
  `CREATE INDEX IF NOT EXISTS idx_review_queue_agreement_eligible
     ON review_queue (resolved, agreement_next_attempt_at, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_review_queue_agreement_claim
     ON review_queue (agreement_claim_token, agreement_claimed_at)`,
  `UPDATE review_queue
      SET agreement_attempted_at = NULL,
          agreement_attempts = 0,
          agreement_tier = NULL,
          agreement_next_attempt_at = NULL,
          agreement_claim_token = NULL,
          agreement_claimed_at = NULL
    WHERE resolved = 0
      AND agreement_attempted_at IS NOT NULL
      AND created_at > agreement_attempted_at`,
  `UPDATE review_queue
      SET agreement_attempted_at = NULL,
          agreement_attempts = 0,
          agreement_tier = NULL,
          agreement_next_attempt_at = NULL,
          agreement_claim_token = NULL,
          agreement_claimed_at = NULL,
          agreement_legacy_replay_at = CURRENT_TIMESTAMP
    WHERE resolved = 0
      AND agreement_legacy_replay_at IS NULL
      AND agreement_attempted_at >= '2026-06-26T00:00:00.000Z'
      AND agreement_attempted_at < '2026-07-11T00:00:00.000Z'`,
] as const;

export const REVIEW_BUDGET_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS llm_budget (
     day   TEXT PRIMARY KEY,
     reads INTEGER NOT NULL DEFAULT 0
   )`,
] as const;

export const REVIEW_RESOLUTION_SCHEMA_STATEMENTS = [
  'ALTER TABLE review_queue ADD COLUMN agreement_suppressed_at TEXT',
  'ALTER TABLE review_queue ADD COLUMN agreement_suppression_reason TEXT',
  `UPDATE review_queue
      SET agreement_suppressed_at = COALESCE(agreement_suppressed_at, CURRENT_TIMESTAMP),
          agreement_suppression_reason = COALESCE(agreement_suppression_reason, reason)
    WHERE reason LIKE 'unpublished:%' OR reason LIKE 'rejected:%'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_live_doc_source_rowkey
     ON transactions (doc_id, source, row_key)
     WHERE row_key IS NOT NULL AND deprecated_at IS NULL`,
  'DROP INDEX IF EXISTS idx_transactions_doc_source_rowkey',
  `CREATE INDEX IF NOT EXISTS idx_review_queue_agreement_suppressed
     ON review_queue (resolved, agreement_suppressed_at, created_at)`,
] as const;

export const REVIEW_REVISION_SCHEMA_STATEMENTS = [
  'ALTER TABLE review_queue ADD COLUMN review_revision INTEGER NOT NULL DEFAULT 1',
] as const;

/**
 * 0043_price_backfill_termination.sql — negative-cache un-priceable tickers so
 * the backfill-market loop can reach done:true, and maintain an indexed
 * latest_price_date so price selection + freshness stop full-scanning price_eod.
 * Keep in exact lockstep with migrations/0043_price_backfill_termination.sql.
 */
export const PRICE_BACKFILL_TERMINATION_SCHEMA_STATEMENTS = [
  'ALTER TABLE securities_ref ADD COLUMN price_unavailable INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE securities_ref ADD COLUMN price_checked_at TEXT',
  'ALTER TABLE securities_ref ADD COLUMN latest_price_date TEXT',
  'CREATE INDEX IF NOT EXISTS idx_secref_latest_price_date ON securities_ref (latest_price_date)',
  // EXISTS guard: tickers with no price_eod rows would otherwise re-run a
  // correlated MAX on every /migrate and rewrite NULL→NULL forever (~544
  // un-priceable symbols). Skip them once priced tickers are seeded.
  `UPDATE securities_ref
   SET latest_price_date = (
     SELECT MAX(pe.date) FROM price_eod pe WHERE pe.ticker = securities_ref.ticker
   )
 WHERE latest_price_date IS NULL
   AND EXISTS (SELECT 1 FROM price_eod pe WHERE pe.ticker = securities_ref.ticker)`,
  `UPDATE securities_ref
   SET current_price = (
         SELECT pe.close FROM price_eod pe
          WHERE pe.ticker = securities_ref.ticker
          ORDER BY pe.date DESC LIMIT 1
       ),
       current_price_date = (
         SELECT pe.date FROM price_eod pe
          WHERE pe.ticker = securities_ref.ticker
          ORDER BY pe.date DESC LIMIT 1
       )
 WHERE current_price IS NULL
   AND EXISTS (SELECT 1 FROM price_eod pe WHERE pe.ticker = securities_ref.ticker)`,
] as const;

/**
 * 0047_subscription_quota_active_only.sql — recreate trg_subscriptions_total_quota
 * so the 20-per-client lifetime cap only counts currently-active rows,
 * matching the corrected preflight in assertSubscriptionQuota
 * (src/delivery/subscriptions.ts). Fixes the "lifetime subscription lockout"
 * bug where deactivated rows permanently occupied a creation-quota slot with
 * no delete path to reclaim it. Keep in exact lockstep with
 * migrations/0047_subscription_quota_active_only.sql.
 */
export const SUBSCRIPTION_QUOTA_ACTIVE_ONLY_SCHEMA_STATEMENTS = [
  'DROP TRIGGER IF EXISTS trg_subscriptions_total_quota',
  `CREATE TRIGGER IF NOT EXISTS trg_subscriptions_total_quota
   BEFORE INSERT ON subscriptions
   WHEN (
     SELECT COUNT(*) FROM subscriptions
      WHERE client_id = NEW.client_id AND active = 1
   ) >= 20
   BEGIN
     SELECT RAISE(ABORT, 'subscription total quota exceeded');
   END`,
] as const;

/** Ordered review-queue autonomy schema mirrored by file migrations 0033-0037. */
export const REVIEW_AUTONOMY_SCHEMA_STATEMENTS = [
  ...REVIEW_COMPLEXITY_SCHEMA_STATEMENTS,
  ...REVIEW_AGREEMENT_SCHEMA_STATEMENTS,
  ...REVIEW_BUDGET_SCHEMA_STATEMENTS,
  ...REVIEW_RESOLUTION_SCHEMA_STATEMENTS,
  ...REVIEW_REVISION_SCHEMA_STATEMENTS,
] as const;

/**
 * 0044_tx_doc_index.sql — plain doc_id index on transactions so the correlated
 * `WHERE doc_id = ?` dedupe/selector subqueries (which the partial
 * row_key-gated composites cannot serve) stop full-scanning the table.
 * Keep in exact lockstep with migrations/0044_tx_doc_index.sql.
 */
export const TX_DOC_INDEX_SCHEMA_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_tx_doc ON transactions (doc_id)',
] as const;

/** 0045_d1_budget.sql — atomic daily D1 row counters. */
export const D1_BUDGET_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS d1_budget (
     day          TEXT PRIMARY KEY,
     rows_read    INTEGER NOT NULL DEFAULT 0,
     rows_written INTEGER NOT NULL DEFAULT 0
   )`,
] as const;

/** 0046_usage_telemetry_probe_lease.sql — singleton half-open probe lease. */
export const USAGE_TELEMETRY_PROBE_LEASE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS usage_telemetry_probe_lease (
     id          INTEGER PRIMARY KEY CHECK (id = 1),
     lease_token TEXT NOT NULL,
     expires_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL
   )`,
] as const;

/**
 * 0048_retention_indexes.sql — timestamp-leading indexes so the daily retention
 * sweep's `WHERE <ts> < ?` batch deletes range-scan by age instead of full-
 * scanning. `dead_letter_events` already has `idx_dead_letter_created`;
 * `ingest_log` and `source_attempts` only had `(source, <ts>)` composites whose
 * leading `source` column the age-only predicate cannot use.
 */
export const RETENTION_INDEX_SCHEMA_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_ingest_log_polled_at ON ingest_log (polled_at)',
  'CREATE INDEX IF NOT EXISTS idx_source_attempts_attempted_at ON source_attempts (attempted_at)',
] as const;

/** 0049_autopilot.sql — backlog-autopilot run receipts + daily USD spend meter. */
export const AUTOPILOT_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS autopilot_runs (
     id                  TEXT PRIMARY KEY,
     status              TEXT NOT NULL DEFAULT 'running',
     run_trigger         TEXT NOT NULL,
     revision            INTEGER NOT NULL DEFAULT 1,
     backlog_before      INTEGER,
     docs_attempted      INTEGER NOT NULL DEFAULT 0,
     docs_published      INTEGER NOT NULL DEFAULT 0,
     docs_deferred       INTEGER NOT NULL DEFAULT 0,
     spend_microusd      INTEGER NOT NULL DEFAULT 0,
     budget_microusd     INTEGER NOT NULL DEFAULT 0,
     error_class_counts  TEXT,
     sample_errors       TEXT,
     outcomes            TEXT,
     skip_reasons        TEXT,
     halt_reason         TEXT,
     acknowledged_at     TEXT,
     acknowledged_by     TEXT,
     started_at          TEXT NOT NULL,
     updated_at          TEXT NOT NULL,
     finished_at         TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_autopilot_runs_status
     ON autopilot_runs (status, started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS autopilot_budget (
     day            TEXT PRIMARY KEY,
     spend_microusd INTEGER NOT NULL DEFAULT 0
   )`,
] as const;

/** 0050_doc_class.sql — pre-extraction document classification. */
export const DOC_CLASS_SCHEMA_STATEMENTS = [
  'ALTER TABLE filings ADD COLUMN doc_class TEXT',
] as const;

/**
 * 0051_resource_governors.sql — hard resource governors: daily LLM USD meter,
 * governed-write quarantine markers, per-target outbound circuit state. Keep
 * in exact lockstep with migrations/0051_resource_governors.sql.
 */
export const RESOURCE_GOVERNOR_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS llm_spend (
  day        TEXT NOT NULL,
  provider   TEXT NOT NULL,
  usd        REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, provider)
)`,
  `CREATE TABLE IF NOT EXISTS d1_write_quarantine (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  writer     TEXT NOT NULL,
  day        TEXT NOT NULL,
  dropped    INTEGER NOT NULL,
  reason     TEXT,
  created_at TEXT NOT NULL
)`,
  'CREATE INDEX IF NOT EXISTS idx_d1_write_quarantine_day ON d1_write_quarantine (day, writer)',
  `CREATE TABLE IF NOT EXISTS delivery_target_circuit (
  target_key           TEXT PRIMARY KEY,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  open_until           TEXT,
  failures_day         TEXT,
  failures_today       INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  updated_at           TEXT NOT NULL
)`,
] as const;

/** 0052_deno_runtime_queue.sql — durable queue for Deno KV Connect runtimes. */
export const DENO_RUNTIME_QUEUE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS deno_runtime_queue (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     queue_name TEXT NOT NULL,
     dedupe_key TEXT,
     payload TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     attempts INTEGER NOT NULL DEFAULT 0,
     dead_letter_pending INTEGER NOT NULL DEFAULT 0,
     available_at TEXT NOT NULL,
     lease_until TEXT,
     lease_token TEXT,
     last_error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_deno_runtime_queue_ready
     ON deno_runtime_queue(status, available_at, id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_deno_runtime_queue_active_dedupe
     ON deno_runtime_queue(queue_name, dedupe_key)
     WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'processing')`,
] as const;

/** 0053_spend_settlements.sql — idempotent, lease-independent spend receipts. */
export const SPEND_SETTLEMENT_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS llm_spend_settlements (
     settlement_id        TEXT PRIMARY KEY,
     provider             TEXT NOT NULL,
     provider_response_id TEXT,
     attempt_id           TEXT NOT NULL,
     day                  TEXT NOT NULL,
     occurred_at          TEXT NOT NULL,
     requested_model      TEXT NOT NULL,
     resolved_model       TEXT,
     doc_id                TEXT,
     usd                   REAL NOT NULL CHECK (usd > 0),
     receipt_hash          TEXT NOT NULL,
     created_at            TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_spend_settlements_response
     ON llm_spend_settlements(provider, provider_response_id)
     WHERE provider_response_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_llm_spend_settlements_day_provider
     ON llm_spend_settlements(day, provider)`,
  `CREATE TABLE IF NOT EXISTS autopilot_budget_settlements (
     settlement_id     TEXT PRIMARY KEY,
     day               TEXT NOT NULL,
     reserved_microusd INTEGER NOT NULL CHECK (reserved_microusd >= 0),
     actual_microusd   INTEGER NOT NULL CHECK (actual_microusd >= 0),
     status            TEXT NOT NULL CHECK (status IN ('completed', 'aborted', 'failed')),
     created_at        TEXT NOT NULL
   )`,
  `CREATE TRIGGER IF NOT EXISTS trg_autopilot_budget_settlement
     AFTER INSERT ON autopilot_budget_settlements
     BEGIN
       UPDATE autopilot_budget
          SET spend_microusd = MAX(
            spend_microusd + NEW.actual_microusd - NEW.reserved_microusd,
            0
          )
        WHERE day = NEW.day;
     END`,
] as const;

/** 0054_accounting_projections.sql — bounded spend totals and reservations. */
export const ACCOUNTING_PROJECTION_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS llm_spend_settlement_totals (
     day        TEXT NOT NULL,
     provider   TEXT NOT NULL,
     usd        REAL NOT NULL DEFAULT 0,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (day, provider)
   )`,
  `INSERT INTO llm_spend_settlement_totals (day, provider, usd, updated_at)
   SELECT day, provider, SUM(usd), MAX(created_at)
     FROM llm_spend_settlements
    GROUP BY day, provider
   ON CONFLICT(day, provider) DO UPDATE SET
     usd = excluded.usd,
     updated_at = excluded.updated_at`,
  `CREATE TRIGGER IF NOT EXISTS trg_llm_spend_settlement_projection
   AFTER INSERT ON llm_spend_settlements
   BEGIN
     INSERT INTO llm_spend_settlement_totals (day, provider, usd, updated_at)
     VALUES (NEW.day, NEW.provider, NEW.usd, NEW.created_at)
     ON CONFLICT(day, provider) DO UPDATE SET
       usd = usd + excluded.usd,
       updated_at = excluded.updated_at;
   END`,
  `CREATE TABLE IF NOT EXISTS autopilot_budget_reservations (
     reservation_id    TEXT PRIMARY KEY,
     day               TEXT NOT NULL,
     reserved_microusd INTEGER NOT NULL CHECK (reserved_microusd >= 0),
     actual_microusd   INTEGER CHECK (actual_microusd >= 0),
     cap_microusd      INTEGER NOT NULL CHECK (cap_microusd >= 0),
     status            TEXT NOT NULL DEFAULT 'reserved'
                       CHECK (status IN ('reserved', 'completed', 'aborted', 'failed')),
     created_at        TEXT NOT NULL,
     settled_at        TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_autopilot_budget_reservations_day_status
     ON autopilot_budget_reservations(day, status)`,
  `CREATE TRIGGER IF NOT EXISTS trg_autopilot_budget_reserve
   AFTER INSERT ON autopilot_budget_reservations
   BEGIN
     INSERT OR IGNORE INTO autopilot_budget (day, spend_microusd)
     VALUES (NEW.day, 0);
     UPDATE autopilot_budget
        SET spend_microusd = spend_microusd + NEW.reserved_microusd
      WHERE day = NEW.day
        AND spend_microusd + NEW.reserved_microusd <= NEW.cap_microusd;
     SELECT CASE WHEN changes() = 0
       THEN RAISE(ABORT, 'autopilot budget exhausted') END;
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_autopilot_budget_reservation_settle
   AFTER UPDATE OF actual_microusd, status ON autopilot_budget_reservations
   WHEN OLD.status = 'reserved' AND NEW.status <> 'reserved'
   BEGIN
     UPDATE autopilot_budget
        SET spend_microusd = MAX(
          spend_microusd + NEW.actual_microusd - NEW.reserved_microusd,
          0
        )
      WHERE day = NEW.day;
   END`,
] as const;

/** 0055_accounting_projection_resync.sql — closes backfill/trigger race. */
export const ACCOUNTING_PROJECTION_RESYNC_SCHEMA_STATEMENTS = [
  `INSERT INTO llm_spend_settlement_totals (day, provider, usd, updated_at)
   SELECT day, provider, SUM(usd), MAX(created_at)
     FROM llm_spend_settlements
    GROUP BY day, provider
   ON CONFLICT(day, provider) DO UPDATE SET
     usd = excluded.usd,
     updated_at = excluded.updated_at`,
] as const;

/**
 * tests. Keep this in the same order as file migrations 0029 through 0055.
 */
export const QUERY_OPTIMIZATIONS_SCHEMA_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_deno_runtime_queue_pending ON deno_runtime_queue (queue_name, status, available_at)',
  'CREATE INDEX IF NOT EXISTS idx_deno_runtime_queue_processing ON deno_runtime_queue (queue_name, status, lease_until)',
  'CREATE INDEX IF NOT EXISTS idx_ingestion_outbox_enqueued ON ingestion_outbox (status, updated_at)',
  'CREATE INDEX IF NOT EXISTS idx_delivery_outbox_enqueued ON delivery_outbox (status, updated_at)',
] as const;

export const PERFORMANCE_INDEXES_SCHEMA_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_price_eod_ticker_date_asc ON price_eod (ticker ASC, date ASC)',
  'CREATE INDEX IF NOT EXISTS idx_transactions_date_cursor_desc ON transactions (tx_date DESC, cursor_seq DESC) WHERE deprecated_at IS NULL',
  'CREATE INDEX IF NOT EXISTS idx_transactions_cursor_asc ON transactions (cursor_seq ASC) WHERE deprecated_at IS NULL'
] as const;

/**
 * 0058_turso_query_efficiency.sql — claim-order covering indexes + migrate
 * backfill partial indexes so replayed /migrate UPDATEs stop scanning the
 * full transactions/securities_ref tables after anchors are filled. Also
 * seeds a singleton price_eod_stats row so admin status receipts never
 * COUNT(*) the ~2.3M-row price cache.
 */
export const TURSO_QUERY_EFFICIENCY_SCHEMA_STATEMENTS = [
  // Prefer id-covering claim indexes; drop the narrower 0056 twins once the
  // replacements exist (IF EXISTS keeps replay safe on fresh DBs).
  'CREATE INDEX IF NOT EXISTS idx_deno_runtime_queue_pending_id ON deno_runtime_queue (queue_name, status, available_at, id)',
  'CREATE INDEX IF NOT EXISTS idx_deno_runtime_queue_processing_id ON deno_runtime_queue (queue_name, status, lease_until, id)',
  'DROP INDEX IF EXISTS idx_deno_runtime_queue_pending',
  'DROP INDEX IF EXISTS idx_deno_runtime_queue_processing',
  // Migrate backfill probes (disclosure anchors + latest_price_date seed).
  `CREATE INDEX IF NOT EXISTS idx_tx_missing_disclosure_anchors
     ON transactions (doc_id)
     WHERE first_seen_at IS NULL OR filed_date IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_secref_missing_latest_price_date
     ON securities_ref (ticker)
     WHERE latest_price_date IS NULL`,
  `CREATE TABLE IF NOT EXISTS price_eod_stats (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     row_count INTEGER NOT NULL DEFAULT 0,
     updated_at TEXT NOT NULL
   )`,
  `INSERT OR IGNORE INTO price_eod_stats (id, row_count, updated_at)
     VALUES (1, 0, '1970-01-01T00:00:00.000Z')`,
  // One-shot seed: COUNT(*) only while row_count is still 0. After the first
  // successful seed, WHERE fails and SQLite does not evaluate the subquery.
  `UPDATE price_eod_stats
      SET row_count = (SELECT COUNT(*) FROM price_eod),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = 1 AND row_count = 0`,
] as const;

export const TRADE_LATENCY_WATCH_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS trade_latency_candidates (
     trade_hash TEXT NOT NULL,
     doc_id TEXT NOT NULL,
     provider TEXT NOT NULL DEFAULT 'fmp',
     chamber TEXT NOT NULL,
     source_url TEXT,
     filed_date TEXT,
     filer_name TEXT,
     ticker TEXT,
     tx_date TEXT,
     tx_type TEXT,
     congress_first_seen_at TEXT NOT NULL,
     provider_key TEXT,
     provider_first_seen_at TEXT,
     provider_published_at TEXT,
     match_method TEXT,
     status TEXT NOT NULL DEFAULT 'pending',
     attempts INTEGER NOT NULL DEFAULT 0,
     last_checked_at TEXT,
     error TEXT,
     payload TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (trade_hash, provider)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_trade_latency_candidates_status
     ON trade_latency_candidates (provider, status, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS trade_provider_observations (
     provider TEXT NOT NULL,
     chamber TEXT NOT NULL,
     provider_key TEXT NOT NULL,
     trade_hash TEXT NOT NULL,
     first_observed_at TEXT NOT NULL,
     last_observed_at TEXT NOT NULL,
     provider_published_at TEXT,
     source_url TEXT,
     filed_date TEXT,
     filer_name TEXT,
     payload TEXT,
     PRIMARY KEY (provider, chamber, provider_key, trade_hash)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_trade_provider_seen
     ON trade_provider_observations (provider, chamber, first_observed_at DESC)`,
  `DROP TABLE IF EXISTS disclosure_latency_candidates`,
  `DROP TABLE IF EXISTS disclosure_provider_observations`,
] as const;

/** Idempotent column adds for trade-latency tables created before source_url /
 *  provider_published_at were part of CREATE TABLE (CREATE IF NOT EXISTS does
 *  not alter an existing table). */
export const TRADE_LATENCY_WATCH_COLUMN_FIX_SCHEMA_STATEMENTS = [
  'ALTER TABLE trade_latency_candidates ADD COLUMN source_url TEXT',
  'ALTER TABLE trade_latency_candidates ADD COLUMN provider_published_at TEXT',
  'ALTER TABLE trade_provider_observations ADD COLUMN provider_published_at TEXT',
] as const;

/** Scoreboard + exact-hash match indexes (idempotent CREATE INDEX). */
export const TRADE_LATENCY_SCOREBOARD_INDEX_SCHEMA_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS idx_trade_latency_candidates_seen
     ON trade_latency_candidates (provider, status, congress_first_seen_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_trade_latency_candidates_updated
     ON trade_latency_candidates (updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_trade_provider_hash
     ON trade_provider_observations (provider, trade_hash, chamber)`,
  `CREATE INDEX IF NOT EXISTS idx_trade_provider_last_obs
     ON trade_provider_observations (last_observed_at DESC)`,
] as const;

export const DENO_RUNTIME_KV_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS deno_runtime_kv (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    expires_at INTEGER,
    PRIMARY KEY (namespace, key)
  )`,
] as const;

export const CLEAN_PLACEHOLDER_TICKERS_SCHEMA_STATEMENTS = [
  `UPDATE transactions SET ticker = NULL WHERE ticker IN ('NONE', '--', 'N/A', 'NA', 'NULL', '—')`,
  `UPDATE transactions SET asset_name = '(unknown)' WHERE asset_name IN ('NONE', 'None', 'none', '--', 'N/A', 'NA', 'NULL', '—', '')`,
] as const;

export const FIX_DENO_RUNTIME_QUEUE_INDEX_SCHEMA_STATEMENTS = [
  'DROP INDEX IF EXISTS idx_deno_runtime_queue_ready'
] as const;

export const FILINGS_FILED_DATE_INDEX_SCHEMA_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_filings_filed_date ON filings (filed_date)'
] as const;

// 0065_stock_act_status.sql — stored STOCK Act 45-day disclosure-lag fields.
// Thresholds/truncation mirror app/src/shared/stockAct.ts exactly.
export const STOCK_ACT_STATUS_SCHEMA_STATEMENTS = [
  'ALTER TABLE transactions ADD COLUMN disclosure_lag_days INTEGER',
  'ALTER TABLE transactions ADD COLUMN stock_act_status TEXT',
  `UPDATE transactions
     SET disclosure_lag_days = CAST(julianday(filed_date) - julianday(tx_date) AS INTEGER)
   WHERE disclosure_lag_days IS NULL
     AND filed_date IS NOT NULL
     AND tx_date IS NOT NULL`,
  `UPDATE transactions
     SET stock_act_status = CASE
       WHEN disclosure_lag_days > 120 THEN 'severely_late'
       WHEN disclosure_lag_days > 45 THEN 'late'
       ELSE 'on_time'
     END
   WHERE stock_act_status IS NULL
     AND disclosure_lag_days IS NOT NULL`,
  'CREATE INDEX IF NOT EXISTS idx_tx_stock_act_status ON transactions (stock_act_status)',
] as const;

export const DENO_RUNTIME_QUEUE_DEAD_LETTER_CYCLES_SCHEMA_STATEMENTS = [
  'ALTER TABLE deno_runtime_queue ADD COLUMN dead_letter_cycles INTEGER NOT NULL DEFAULT 0'
] as const;

// 0066_filer_bioguide_resolution.sql — resolved Bioguide identity on filers.
// The filers PK stores source-specific synthetic slugs; resolved_bioguide_id
// holds the official Bioguide ID matched by member enrichment (congress-legislators).
export const FILER_BIOGUIDE_RESOLUTION_SCHEMA_STATEMENTS = [
  'ALTER TABLE filers ADD COLUMN resolved_bioguide_id TEXT',
  'CREATE INDEX IF NOT EXISTS idx_filers_resolved_bioguide ON filers (resolved_bioguide_id)',
] as const;

// 0067_clean_ocr_dot_leader_asset_names.sql — clean OCR dot leaders from asset_name and save audit note.
// Owner 2026-08-09: cleaning_note strings are concise plain-English fragments
// (no title case, no internal table names). New writes + a rewrite pass at the
// end of this list keep API/UI/export consistent without a one-shot only.
export const CLEAN_OCR_DOT_LEADERS_SCHEMA_STATEMENTS = [
  'ALTER TABLE transactions ADD COLUMN cleaning_note TEXT',
  `UPDATE transactions
      SET cleaning_note = 'cleaned OCR noise from asset name',
          asset_name = NULL
    WHERE asset_name IN (
       '..', '...', '....', '.....', '......', '.......', '........', '.........', '..........',
       '...........', '............', '.............', '..............', '...............',
       '................', '.................', '..................', '...................',
       '....................', '.....................', '......................',
       '.......................', '........................', '................ me',
       '..........................', '...........................', '.................',
       '.....]', '......s', '..........A', '..o', '...................0', '...................e', '.............e'
    )`,
  `UPDATE transactions SET cleaning_note = 'removed OCR noise from asset name', asset_name = 'ARCC' WHERE asset_name LIKE 'ARCC .%'`,
  `UPDATE transactions SET cleaning_note = 'removed OCR noise from asset name', asset_name = 'NVDA' WHERE asset_name LIKE 'NVDA .%'`,
  `UPDATE transactions SET cleaning_note = 'removed OCR noise from asset name', asset_name = 'XOM' WHERE asset_name LIKE 'XOM .%'`,
  `UPDATE transactions SET cleaning_note = 'removed OCR noise from asset name', asset_name = 'BAC' WHERE asset_name LIKE 'BAC .%'`,
  `UPDATE transactions SET cleaning_note = 'removed OCR noise from asset name', asset_name = 'FMAO' WHERE asset_name LIKE 'FMAO .%'`,
  `UPDATE transactions SET cleaning_note = 'removed OCR noise from asset name', asset_name = 'HD' WHERE asset_name LIKE 'HD .%'`,
  `UPDATE transactions
      SET cleaning_note = 'removed junk OCR from asset name',
          asset_name = NULL
    WHERE (asset_name LIKE '...%' OR asset_name LIKE '%...' OR asset_name LIKE '%....%')
      AND cleaning_note IS NULL`,
  `UPDATE transactions
      SET deprecated_at = CURRENT_TIMESTAMP,
          deprecated_reason = 'synthetic_provider_missing_placeholder'
    WHERE doc_id LIKE 'provider-missing-%'
      AND deprecated_at IS NULL`,
  // Retroactive sweep (PR #1180), MOVED to REVIEW_QUEUE_RESOLUTION_REASON_
  // SCHEMA_STATEMENTS below (still runs every /migrate, just after the
  // resolution_kind/resolution_reason columns exist and can be set honestly
  // — see that block for why it can't stay here).
  `UPDATE transactions
      SET asset_name = (SELECT sr.company_name FROM securities_ref sr WHERE sr.ticker = transactions.ticker),
          cleaning_note = COALESCE(cleaning_note, 'asset name derived from ticker')
    WHERE ticker IS NOT NULL
      AND ticker != ''
      AND EXISTS (SELECT 1 FROM securities_ref sr WHERE sr.ticker = transactions.ticker AND sr.company_name IS NOT NULL AND sr.company_name != '')
      AND (asset_name IS NULL OR asset_name = '' OR asset_name = '(unknown)' OR asset_name = ticker OR asset_name LIKE '%..%')`,
  // Rewrite legacy technical notes already stored (idempotent).
  `UPDATE transactions SET cleaning_note = 'asset name derived from ticker'
    WHERE cleaning_note = 'Populated official company name from securities_ref'`,
  `UPDATE transactions SET cleaning_note = 'cleaned OCR noise from asset name'
    WHERE cleaning_note LIKE 'Cleaned OCR dot leader noise%'`,
  `UPDATE transactions SET cleaning_note = 'removed OCR noise from asset name'
    WHERE cleaning_note LIKE 'Stripped OCR dot leader suffix%'`,
  `UPDATE transactions SET cleaning_note = 'removed junk OCR from asset name'
    WHERE cleaning_note LIKE 'Cleaned junk OCR text%'`,
] as const;

/**
 * 0068_cursor_seq_integrity.sql — sequence-authoritative cursor trigger +
 * poisoned-cursor repair.
 */
export const CURSOR_SEQ_INTEGRITY_SCHEMA_STATEMENTS = [
  // tx_cursor_seq has only an INTEGER PRIMARY KEY on `seq`; nothing indexes
  // `tx_id`. Every lookup below — and the trigger's own MAX(seq) subquery,
  // which runs on EVERY transaction INSERT — is correlated on tx_id, so
  // without this index each one full-scans a table that already holds one row
  // per transaction ever written (~76k+). The repair is O(poisoned x 76k) and
  // ingestion degrades quadratically as the table grows. Create the index
  // FIRST, before anything that depends on it.
  'CREATE INDEX IF NOT EXISTS idx_tx_cursor_seq_tx_id ON tx_cursor_seq (tx_id)',
  // Belt-and-braces: BASE_SCHEMA_STATEMENTS already created _v2 much earlier in
  // this same run, so this is normally a no-op. Both must exist before the v1
  // drop below — never drop a trigger you have not already replaced.
  `CREATE TRIGGER IF NOT EXISTS trg_transactions_cursor_v2 AFTER INSERT ON transactions FOR EACH ROW BEGIN INSERT INTO tx_cursor_seq (tx_id) VALUES (NEW.id); UPDATE transactions SET cursor_seq = (SELECT MAX(seq) FROM tx_cursor_seq WHERE tx_id = NEW.id) WHERE id = NEW.id; END`,
  // Only now is it safe to retire v1 (which carried the `WHEN NEW.cursor_seq IS
  // NULL` guard that let importers write Date.now() epochs).
  'DROP TRIGGER IF EXISTS trg_transactions_cursor',
  'UPDATE subscriptions SET cursor = COALESCE((SELECT MAX(cursor_seq) FROM transactions WHERE cursor_seq < 1000000000000), 0) WHERE cursor >= 1000000000000',
  `INSERT INTO tx_cursor_seq (tx_id) SELECT id FROM transactions WHERE cursor_seq >= 1000000000000 AND NOT EXISTS (SELECT 1 FROM tx_cursor_seq s WHERE s.tx_id = transactions.id) ORDER BY cursor_seq ASC, created_at ASC, id ASC`,
  `UPDATE transactions SET cursor_seq = (SELECT MAX(s.seq) FROM tx_cursor_seq s WHERE s.tx_id = transactions.id) WHERE cursor_seq >= 1000000000000 AND EXISTS (SELECT 1 FROM tx_cursor_seq s WHERE s.tx_id = transactions.id)`,
  // Heal rows that lost their cursor_seq entirely. A NULL cursor_seq is worse
  // than a poisoned one: `t.cursor_seq > ?` is applied on EVERY /transactions
  // read (since defaults to 0), plus the SSE backlog drain, so the trade is
  // invisible to the whole feed and to every alert — permanently and silently.
  // The `>= 1e12` repair above cannot reach these (NULL >= 1e12 is NULL).
  // Sources: any INSERT during a historical no-trigger window, or any writer
  // that ran while the trigger was absent.
  `INSERT INTO tx_cursor_seq (tx_id) SELECT id FROM transactions WHERE cursor_seq IS NULL AND NOT EXISTS (SELECT 1 FROM tx_cursor_seq s WHERE s.tx_id = transactions.id) ORDER BY created_at ASC, id ASC`,
  `UPDATE transactions SET cursor_seq = (SELECT MAX(s.seq) FROM tx_cursor_seq s WHERE s.tx_id = transactions.id) WHERE cursor_seq IS NULL AND EXISTS (SELECT 1 FROM tx_cursor_seq s WHERE s.tx_id = transactions.id)`,
] as const;

/**
 * 0069_client_command_secret_claim.sql — one-time claim for command-issued
 * credentials. Replayed on every POST /api/admin/migrate: the ALTERs are
 * skipped as "duplicate column" and the backfill's json_extract predicate
 * stops matching once scrubbed.
 */
export const CLIENT_COMMAND_SECRET_CLAIM_SCHEMA_STATEMENTS = [
  'ALTER TABLE client_commands ADD COLUMN result_secret TEXT',
  'ALTER TABLE client_commands ADD COLUMN result_claimed_at TEXT',
  `UPDATE client_commands
      SET result = json_remove(result, '$.subscription.secret', '$.subscription.streamUrl'),
          result_claimed_at = COALESCE(result_claimed_at, updated_at)
    WHERE type = 'create_subscription'
      AND result IS NOT NULL
      AND json_valid(result)
      AND json_extract(result, '$.subscription.secret') IS NOT NULL`,
] as const;

export const PURGE_LEAKED_KV_CREDENTIALS_SCHEMA_STATEMENTS = [
  `DELETE FROM deno_runtime_kv WHERE namespace = 'config' AND (key LIKE 'sess:%' OR key LIKE 'magic:%')`,
] as const;

export const QUEUE_OUTBOX_RETENTION_INDEX_SCHEMA_STATEMENTS = [
  "CREATE INDEX IF NOT EXISTS idx_deno_runtime_queue_completed_updated ON deno_runtime_queue (updated_at) WHERE status = 'completed'",
  "CREATE INDEX IF NOT EXISTS idx_deno_runtime_queue_failed_updated ON deno_runtime_queue (updated_at) WHERE status = 'failed'",

  // Canonical tx_type codes: B=Buy, S=Sell, E=Exchange. Migrate legacy STOCK Act
  // form letter P (Purchase) → B. Idempotent. Future writes already emit B via
  // canonicalizeTxType / normalizers.
  `UPDATE transactions SET tx_type = 'B' WHERE tx_type = 'P'`,
  // Competitor / latency observations that stored side as free text stay as-is;
  // only the transactions table is the product API source of truth for txType.

  // Speeds resolveMemberFilerId (memberName → filer_id) used by the public feed
  // before the indexed transactions.filer_id keyset path.
  'CREATE INDEX IF NOT EXISTS idx_filers_full_name_lower ON filers (LOWER(full_name))',
] as const;

export const LOCAL_VISION_WORKER_SCHEMA_STATEMENTS = [
  'ALTER TABLE filings ADD COLUMN local_wait_expires_at TEXT',
  `CREATE TABLE IF NOT EXISTS local_worker_heartbeat (worker_id TEXT PRIMARY KEY, last_heartbeat_at TEXT NOT NULL, status_json TEXT)`,
] as const;

/** 0076_push_devices.sql — account-owned APNs/webpush device tokens. */
export const PUSH_DEVICES_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS push_devices (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     platform TEXT NOT NULL,
     token TEXT NOT NULL,
     app_bundle TEXT,
     env TEXT,
     active INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_push_devices_user_platform_token ON push_devices (user_id, platform, token)',
  'CREATE INDEX IF NOT EXISTS idx_push_devices_user_active ON push_devices (user_id, active)',
  'CREATE INDEX IF NOT EXISTS idx_push_devices_platform_active ON push_devices (platform, active)',
] as const;

/** 0077_llm_spend_purpose_doc.sql — purpose + doc_id indexes for per-doc caps. */
export const LLM_SPEND_PURPOSE_DOC_SCHEMA_STATEMENTS = [
  'ALTER TABLE llm_spend_settlements ADD COLUMN purpose TEXT',
  `CREATE INDEX IF NOT EXISTS idx_llm_spend_settlements_doc
     ON llm_spend_settlements (doc_id)
     WHERE doc_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_llm_spend_settlements_purpose_day
     ON llm_spend_settlements (purpose, day)
     WHERE purpose IS NOT NULL`,
] as const;

/**
 * 0078_filer_identity_merges.sql — durable, reversible identity-merge support
 * for `filers` rows that forked for the same real member (e.g. "Michael T.
 * McCaul" vs "Michael McCaul" — see shared/filerIdentityMatch.ts). Rows are
 * never deleted: `merged_into` tombstones an alias row (points at the
 * surviving canonical bioguide_id) and filer_identity_merges keeps an
 * auditable alias -> canonical mapping. Populated by
 * admin/filerIdentityDedupe.ts via POST /api/admin/dedupe-filer-identities.
 */
export const FILER_IDENTITY_MERGE_SCHEMA_STATEMENTS = [
  'ALTER TABLE filers ADD COLUMN merged_into TEXT',
  'CREATE INDEX IF NOT EXISTS idx_filers_merged_into ON filers (merged_into)',
  `CREATE TABLE IF NOT EXISTS filer_identity_merges (
     alias_filer_id     TEXT PRIMARY KEY,
     canonical_filer_id TEXT NOT NULL,
     chamber             TEXT,
     state               TEXT,
     reason              TEXT NOT NULL DEFAULT 'name-normalization',
     merged_at           TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_filer_identity_merges_canonical
     ON filer_identity_merges (canonical_filer_id)`,
] as const;

/**
 * 0079_members_directory_perf.sql — issue #1454 (GET /api/members ~6s).
 * Partial covering index matching delivery/rest.ts queryMembersRoster's
 * filter (filer_id IS NOT NULL AND deprecated_at IS NULL) exactly, so the
 * planner (forced via INDEXED BY) gets an index-only scan instead of a
 * per-row table fetch. See migrations/0079_members_directory_perf.sql for
 * the full "why not just add the WHERE clause" writeup.
 */
export const MEMBERS_DIRECTORY_PERF_SCHEMA_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS idx_tx_filer_live
     ON transactions (filer_id)
     WHERE deprecated_at IS NULL`,
] as const;

/**
 * 0080_apple_signin.sql — "Sign in with Apple": link a user to their stable
 * Apple `sub` claim. Nullable + partial-unique so existing Google/magic-link
 * users are unaffected until they link Apple.
 */
export const APPLE_SIGNIN_SCHEMA_STATEMENTS = [
  'ALTER TABLE users ADD COLUMN apple_sub TEXT',
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_sub
     ON users (apple_sub)
     WHERE apple_sub IS NOT NULL`,
] as const;

/**
 * 0094_x_auth.sql — "Sign in with X (Twitter)": link a user to their stable
 * X `sub` claim.
 */
export const X_AUTH_SCHEMA_STATEMENTS = [
  'ALTER TABLE users ADD COLUMN x_sub TEXT',
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_x_sub
     ON users (x_sub)
     WHERE x_sub IS NOT NULL`,
] as const;

/**
 * 0081_apple_iap.sql — Apple In-App Purchase (StoreKit 2) subscription ledger
 * + App Store Server Notifications V2 webhook idempotency ledger. See
 * migrations/0081_apple_iap.sql for the full design note (why this table is
 * independent of, not a replacement for, the Stripe-shaped `users` columns
 * the legacy POST /billing/apple/confirm route also writes).
 */
export const APPLE_IAP_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS apple_subscriptions (
     original_transaction_id   TEXT PRIMARY KEY,
     user_id                   TEXT NOT NULL,
     product_id                TEXT NOT NULL,
     plan                      TEXT NOT NULL CHECK (plan IN ('monthly', 'annual')),
     status                    TEXT NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active', 'expired', 'revoked', 'grace_period', 'billing_retry')),
     environment               TEXT,
     latest_transaction_id     TEXT,
     purchase_date              TEXT,
     expires_date               TEXT,
     auto_renew_status          INTEGER,
     auto_renew_product_id      TEXT,
     revoked_at                 TEXT,
     revocation_reason          INTEGER,
     last_notification_type     TEXT,
     last_notification_subtype  TEXT,
     created_at                 TEXT NOT NULL,
     updated_at                 TEXT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_apple_subscriptions_user ON apple_subscriptions (user_id)',
  `CREATE INDEX IF NOT EXISTS idx_apple_subscriptions_user_active
     ON apple_subscriptions (user_id, status, expires_date)`,
  `CREATE TABLE IF NOT EXISTS apple_webhook_events (
     event_id          TEXT PRIMARY KEY,
     event_type        TEXT NOT NULL,
     received_at       TEXT NOT NULL,
     processed_at      TEXT,
     claim_token       TEXT,
     claim_expires_at  TEXT
   )`,
  'CREATE INDEX IF NOT EXISTS idx_apple_webhook_events_received ON apple_webhook_events (received_at DESC)',
  `CREATE INDEX IF NOT EXISTS idx_apple_webhook_events_claim_expiry
     ON apple_webhook_events (processed_at, claim_expires_at)`,
] as const;

/**
 * 0082_review_queue_resolution_reason.sql — make review_queue.resolved=1 an
 * honest signal. See that file for the full production-bug writeup. Keep in
 * exact lockstep with migrations/0082_review_queue_resolution_reason.sql.
 */
export const REVIEW_QUEUE_RESOLUTION_REASON_SCHEMA_STATEMENTS = [
  'ALTER TABLE review_queue ADD COLUMN resolution_kind TEXT',
  'ALTER TABLE review_queue ADD COLUMN resolution_reason TEXT',
  'ALTER TABLE review_queue ADD COLUMN resolved_at TEXT',
  `UPDATE review_queue
      SET resolution_kind = 'published',
          resolved_at = COALESCE(resolved_at, created_at)
    WHERE resolved = 1
      AND resolution_kind IS NULL
      AND EXISTS (
        SELECT 1 FROM transactions t
         WHERE t.doc_id = review_queue.doc_id AND t.deprecated_at IS NULL
      )`,
  `UPDATE review_queue
      SET resolution_kind = 'rejected',
          resolution_reason = COALESCE(resolution_reason, reason),
          resolved_at = COALESCE(resolved_at, created_at)
    WHERE resolved = 1
      AND resolution_kind IS NULL
      AND (reason LIKE 'rejected:%' OR reason = 'orphan_filing_deleted')`,
  // Remaining legacy rows (the ~950 that predate resolution_kind and match
  // neither rule above): they were resolved with no live transactions and no
  // 'rejected:' marker, i.e. closed as empty without ever recording why. That
  // is a true statement we CAN make honestly — classify them as verified_empty
  // with a reason naming the backfill, so review_resolution_integrity reports
  // the real ongoing state instead of a permanent legacy number nobody can act
  // on. Only ever touches rows still NULL, so it is idempotent.
  `UPDATE review_queue
      SET resolution_kind = 'verified_empty',
          resolution_reason = COALESCE(
            NULLIF(resolution_reason, ''),
            'legacy backfill 2026-08-09: resolved before resolution_kind existed; no live transactions at backfill time'
          ),
          resolved_at = COALESCE(resolved_at, created_at)
    WHERE resolved = 1
      AND resolution_kind IS NULL`,
  // Ongoing sweep (originally PR #1180, previously living unconditionally in
  // CLEAN_OCR_DOT_LEADERS_SCHEMA_STATEMENTS / migration 0067's mirror — moved
  // here, after resolution_kind/resolution_reason exist, because
  // trg_review_queue_honest_resolution below is a durable DB object: once
  // installed by any earlier deploy, it enforces on every future UPDATE that
  // sets resolved=1 regardless of that statement's position in THIS list, so
  // the bare `SET resolved = 1` it used to run would abort on every redeploy
  // for as long as routeProviderOnlyObservationsToReview (tradeLatency.ts)
  // keeps creating new provider-only rows. Provider-only placeholder filings
  // have no raw_object_key — nothing was ever fetched to extract from — so
  // they can never gain a live transaction; 'verified_empty' is honest here.
  `UPDATE review_queue
      SET resolved = 1,
          resolution_kind = 'verified_empty',
          resolution_reason = 'provider_only_lead_cleared',
          resolved_at = CURRENT_TIMESTAMP
    WHERE reason = 'provider_discovered_missing_official'
      AND resolved = 0`,
  `CREATE INDEX IF NOT EXISTS idx_review_queue_resolution_kind
     ON review_queue (resolved, resolution_kind)`,
  'DROP TRIGGER IF EXISTS trg_review_queue_honest_resolution',
  `CREATE TRIGGER IF NOT EXISTS trg_review_queue_honest_resolution
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
  SELECT RAISE(ABORT, 'review_queue.resolved=1 requires an honest resolution_kind: published needs a live transaction, verified_empty/rejected need resolution_reason');
END`,
] as const;

/**
 * 0083_filers_display_name.sql — the member's "campaign sign" preferred
 * public display name, distinct from full_name. See that file and
 * src/enrichment/identitySync.ts for how it is computed and kept in sync.
 * Keep in exact lockstep with migrations/0083_filers_display_name.sql.
 */
export const FILERS_DISPLAY_NAME_SCHEMA_STATEMENTS = [
  'ALTER TABLE filers ADD COLUMN display_name TEXT',
] as const;

/**
 * 0084_latency_probe_leases.sql — mutual exclusion for provider polling, so the
 * Deno server and the Mac scout can never both spend quota on the same source.
 * The PRIMARY KEY on `provider` is what makes the conditional upsert in
 * ingestion/probeLease.ts a contended write with exactly one winner.
 * Keep in exact lockstep with migrations/0084_latency_probe_leases.sql.
 */
export const LATENCY_PROBE_LEASE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS latency_probe_leases (
     provider          TEXT PRIMARY KEY,
     holder            TEXT NOT NULL,
     holder_id         TEXT NOT NULL,
     acquired_at       TEXT NOT NULL,
     expires_at        INTEGER NOT NULL,
     tenure_started_at INTEGER NOT NULL,
     reason            TEXT,
     renewals          INTEGER NOT NULL DEFAULT 0,
     updated_at        TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_latency_probe_leases_expires
     ON latency_probe_leases (expires_at DESC)`,
] as const;

export const LOWER_SUBSCRIPTION_QUOTA_SCHEMA_STATEMENTS = [
  'DROP TRIGGER IF EXISTS trg_subscriptions_total_quota',
  `CREATE TRIGGER IF NOT EXISTS trg_subscriptions_total_quota
BEFORE INSERT ON subscriptions
WHEN (
  SELECT COUNT(*) FROM subscriptions
   WHERE client_id = NEW.client_id AND active = 1
) >= 2
BEGIN
  SELECT RAISE(ABORT, 'subscription total quota exceeded');
END`,
  'DROP TRIGGER IF EXISTS trg_subscriptions_active_insert_quota',
  `CREATE TRIGGER IF NOT EXISTS trg_subscriptions_active_insert_quota
BEFORE INSERT ON subscriptions
WHEN NEW.active = 1 AND (
  SELECT COUNT(*) FROM subscriptions WHERE client_id = NEW.client_id AND active = 1
) >= 2
BEGIN
  SELECT RAISE(ABORT, 'subscription active quota exceeded');
END`,
  'DROP TRIGGER IF EXISTS trg_subscriptions_active_update_quota',
  `CREATE TRIGGER IF NOT EXISTS trg_subscriptions_active_update_quota
BEFORE UPDATE OF active, client_id ON subscriptions
WHEN NEW.active = 1 AND (OLD.active != 1 OR OLD.client_id != NEW.client_id) AND (
  SELECT COUNT(*) FROM subscriptions WHERE client_id = NEW.client_id AND active = 1 AND id != OLD.id
) >= 2
BEGIN
  SELECT RAISE(ABORT, 'subscription active quota exceeded');
END`,
] as const;


export const APNS_FANOUT_STATE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS apns_fanout_state (
     id TEXT PRIMARY KEY,
     last_trade_at TEXT NOT NULL,
     last_review_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `INSERT OR IGNORE INTO apns_fanout_state (id, last_trade_at, last_review_at, updated_at)
     VALUES ('default', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')`,
] as const;

export const LATENCY_PRICE_SNAPSHOT_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS latency_price_snapshots (
     trade_hash TEXT NOT NULL,
     ticker TEXT NOT NULL,
     provider TEXT NOT NULL,
     event TEXT NOT NULL,
     due_at TEXT NOT NULL,
     captured_at TEXT,
     price REAL,
     source TEXT,
     error TEXT,
     created_at TEXT NOT NULL,
     PRIMARY KEY (trade_hash, provider, event)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_latency_price_due
     ON latency_price_snapshots (captured_at, due_at)`,
] as const;

/**
 * 0088_tx_twin_seek_index.sql — issue #2062 (PR 2037 twin-dedupe hang).
 * Partial covering index matching TWIN_DEDUPE_SQL's inner seek
 * (filer_id, tx_date on live rows) so the correlated NOT EXISTS on the
 * page / CSV / analytics path is an index SEARCH, not a per-row corpus scan.
 */
export const TWIN_SEEK_INDEX_SCHEMA_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS idx_tx_twin_seek
     ON transactions (filer_id, tx_date)
     WHERE deprecated_at IS NULL`,
] as const;

export const ASSET_NORMALIZATION_0085_SCHEMA_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_tx_ticker_live ON transactions (ticker) WHERE deprecated_at IS NULL',
  "UPDATE transactions SET ticker = 'ETH' WHERE ticker IN ('ETHUSD', 'ETH-USD', 'ETH/USD', '$ETHUSD', '$ETH')",
  "UPDATE transactions SET ticker = 'BTC' WHERE ticker IN ('BTCUSD', 'BTC-USD', 'BTC/USD', 'XBTUSD', '$BTCUSD', '$BTC')",
  "UPDATE transactions SET ticker = 'SOL' WHERE ticker IN ('SOLUSD', 'SOL-USD', 'SOL/USD', '$SOLUSD', '$SOL')",
  "UPDATE transactions SET ticker = 'DOGE' WHERE ticker IN ('DOGEUSD', 'DOGE-USD', '$DOGEUSD', '$DOGE')",
  "UPDATE transactions SET ticker = 'XRP' WHERE ticker IN ('XRPUSD', 'XRP-USD', '$XRPUSD', '$XRP')",
  "UPDATE transactions SET ticker = 'ADA' WHERE ticker IN ('ADAUSD', 'ADA-USD', '$ADAUSD', '$ADA')",
  "UPDATE transactions SET ticker = 'AVAX' WHERE ticker IN ('AVAXUSD', 'AVAX-USD', '$AVAXUSD', '$AVAX')",
  "UPDATE transactions SET ticker = 'DOT' WHERE ticker IN ('DOTUSD', 'DOT-USD', '$DOTUSD', '$DOT')",
  "UPDATE transactions SET ticker = 'MATIC' WHERE ticker IN ('MATICUSD', 'POLUSD', 'MATIC-USD', '$MATICUSD', '$MATIC')",
  "UPDATE transactions SET ticker = 'LINK' WHERE ticker IN ('LINKUSD', 'LINK-USD', '$LINKUSD', '$LINK')",
  "UPDATE transactions SET ticker = 'LTC' WHERE ticker IN ('LTCUSD', 'LTC-USD', '$LTCUSD', '$LTC')",
  "UPDATE transactions SET asset_name = 'Unspecified Asset', ticker = NULL WHERE asset_name LIKE '$151,000%' OR ticker LIKE '$151,000%'",
  "UPDATE transactions SET asset_name = 'U.S. Treasury Bill', ticker = NULL WHERE ticker LIKE '912796%' OR asset_name LIKE '912796%' OR asset_name LIKE '%13-WEEK, MATURESP%' OR asset_name LIKE '%4-WEEK, MATURESP%' OR asset_name LIKE '%3-MONTH, MATURESP%' OR asset_name LIKE '%6-MONTH, MATURESP%'",
  "UPDATE transactions SET asset_name = 'U.S. Treasury Note', ticker = NULL WHERE ticker LIKE '91282C%' OR asset_name LIKE '91282C%'",
  "UPDATE transactions SET ticker = NULL WHERE ticker IN ('1 1', '2 1', '5 1', '1093', '2020', '9201', '9843', '1QY', '3733Z', '559242Z', '5672A', '600690', '7410Z', '8376923Z', '^MWE', '^RGP', '0QZI.IL', '9201:JP', '559242Z:CN', '1494391D', '20030NCU3', '30303M8N5', '37045XCR5', '37045XDS2', '605699PU5', '64110LAS5', '68389XCD5', '713448FM5', '784532JF1', '92343VEU4')",
  "INSERT OR IGNORE INTO securities_ref (ticker, company_name, asset_class) VALUES ('ETH', 'Ethereum', 'Crypto'), ('BTC', 'Bitcoin', 'Crypto'), ('SOL', 'Solana', 'Crypto'), ('DOGE', 'Dogecoin', 'Crypto'), ('XRP', 'XRP', 'Crypto'), ('ADA', 'Cardano', 'Crypto'), ('AVAX', 'Avalanche', 'Crypto'), ('DOT', 'Polkadot', 'Crypto'), ('MATIC', 'Polygon', 'Crypto'), ('LINK', 'Chainlink', 'Crypto'), ('LTC', 'Litecoin', 'Crypto')",
] as const;

/**
 * 0089_probe_run_brackets.sql
 *
 * Durable record of EVERY competitor probe, including probes that found
 * nothing — those are what establish the lower bound of a publication window.
 * See src/ingestion/probeRunLog.ts for why a point-in-time
 * `first_observed_at` is not a publication timestamp.
 *
 * `prev_probe_at` / `provider_window_*` are added as nullable columns: every
 * pre-existing row keeps a NULL window and is therefore reported as
 * UNBOUNDED confidence rather than being retroactively credited with a
 * precision it never had.
 */
export const PROBE_RUN_BRACKET_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS provider_probe_runs (
     provider TEXT NOT NULL,
     chamber TEXT NOT NULL,
     ran_at TEXT NOT NULL,
     ok INTEGER NOT NULL DEFAULT 0,
     rows_seen INTEGER NOT NULL DEFAULT 0,
     error TEXT,
     PRIMARY KEY (provider, chamber, ran_at)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_provider_probe_runs_lookup
     ON provider_probe_runs (provider, chamber, ok, ran_at DESC)`,
  'ALTER TABLE trade_provider_observations ADD COLUMN prev_probe_at TEXT',
  'ALTER TABLE trade_latency_candidates ADD COLUMN provider_window_start TEXT',
  'ALTER TABLE trade_latency_candidates ADD COLUMN provider_window_end TEXT',
] as const;

/**
 * 0090_admin_allowlist.sql — persisted admin grant/revoke allowlist + audit
 * trail, consulted ADDITIONALLY to the ADMIN_EMAILS environment bootstrap
 * list (see admin/identity.ts's adminRuntimeConfig, admin/adminAccess.ts for
 * the grant/revoke logic).  ADMIN_EMAILS itself is never written to this
 * table — it stays the un-editable root escape hatch.
 */
export const ADMIN_ALLOWLIST_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS admin_allowlist (
     email       TEXT PRIMARY KEY,
     granted_by  TEXT NOT NULL,
     granted_at  TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS admin_access_audit (
     id         TEXT PRIMARY KEY,
     action     TEXT NOT NULL,
     email      TEXT NOT NULL,
     actor      TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_admin_access_audit_created ON admin_access_audit (created_at DESC)',
] as const;

/**
 * 0091_apple_subscriptions_nullable_user.sql — Guideline 5.1.1(v): App Store
 * review rejected submission b61e2a4a for requiring account registration
 * before an In-App Purchase that is not itself account-based. Anonymous
 * device purchases (`POST /api/client/v1/entitlements/apple/redeem`) write a
 * `apple_subscriptions` row with `user_id = NULL`; SQLite cannot ALTER COLUMN
 * to drop a NOT NULL constraint, so this rebuilds the table. Keep in exact
 * lockstep with migrations/0091_apple_subscriptions_nullable_user.sql. Safe
 * to replay: each run copies the CURRENT table (already migrated after the
 * first run) into a fresh shadow, drops, and renames back — a no-op in
 * effect, not just idempotent-without-erroring, at the cost of a full-table
 * copy on every deploy. apple_subscriptions is small (one row per
 * subscriber/device, not per trade), so that cost is accepted rather than
 * building one-shot migration scripting this route doesn't otherwise have —
 * same tradeoff already made for the `deliveries` dedupe statement above
 * (see its comment under 0008_idempotency_keys.sql in routes.ts).
 */
export const APPLE_SUBSCRIPTIONS_NULLABLE_USER_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS apple_subscriptions_new (
     original_transaction_id   TEXT PRIMARY KEY,
     user_id                   TEXT,
     product_id                TEXT NOT NULL,
     plan                      TEXT NOT NULL CHECK (plan IN ('monthly', 'annual')),
     status                    TEXT NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active', 'expired', 'revoked', 'grace_period', 'billing_retry')),
     environment               TEXT,
     latest_transaction_id     TEXT,
     purchase_date              TEXT,
     expires_date               TEXT,
     auto_renew_status          INTEGER,
     auto_renew_product_id      TEXT,
     revoked_at                 TEXT,
     revocation_reason          INTEGER,
     last_notification_type     TEXT,
     last_notification_subtype  TEXT,
     created_at                 TEXT NOT NULL,
     updated_at                 TEXT NOT NULL
   )`,
  'INSERT INTO apple_subscriptions_new SELECT * FROM apple_subscriptions',
  'DROP TABLE apple_subscriptions',
  'ALTER TABLE apple_subscriptions_new RENAME TO apple_subscriptions',
  'CREATE INDEX IF NOT EXISTS idx_apple_subscriptions_user ON apple_subscriptions (user_id)',
  `CREATE INDEX IF NOT EXISTS idx_apple_subscriptions_user_active
     ON apple_subscriptions (user_id, status, expires_date)`,
] as const;

/**
 * 0092_latency_snapshot_repair.sql
 *
 * Repairs the latency-price-snapshot pipeline: 2937/2955 scheduled rows were
 * stuck at `missed_window` because snapshots are scheduled RETROSPECTIVELY
 * from already-matched candidates, so `due_at` for ct_publish/provider_publish
 * is always in the past by the time a row exists — captureDueLatencyPriceSnapshots
 * correctly refused to stamp a live quote onto it. The other 11 failed on a
 * paid quote provider's HTTP 402. Owner ruling: that provider is never a
 * market-data source again.
 *
 * New columns record HOW a price was answered (`capture_mode`: 'live' or
 * 'backfill'), how confident we are in `due_at` itself (`confidence` /
 * `due_at_uncertainty_sec`, derived from the provider_probe_runs bracket added
 * in 0089), the market session at the requested instant (`market_session`, so
 * a print crossing the 16:00 close is labeled rather than silently averaged
 * into a same-session comparison), and how many backfill attempts a row has
 * exhausted (`backfill_attempts`) so a persistently unreachable peer
 * terminates instead of retrying forever.
 *
 * The trailing UPDATE reopens every row previously abandoned with
 * 'missed_window' for capture through the SAME live/backfill pipeline that
 * answers new rows — never a synthetic "now" price on a past due_at.
 * Idempotent: after the first replay no row still has this value, so replaying
 * this statement list on a later deploy is a no-op.
 */
export const LATENCY_PRICE_SNAPSHOT_REPAIR_SCHEMA_STATEMENTS = [
  `ALTER TABLE latency_price_snapshots ADD COLUMN capture_mode TEXT`,
  `ALTER TABLE latency_price_snapshots ADD COLUMN confidence TEXT`,
  `ALTER TABLE latency_price_snapshots ADD COLUMN due_at_uncertainty_sec INTEGER`,
  `ALTER TABLE latency_price_snapshots ADD COLUMN market_session TEXT`,
  `ALTER TABLE latency_price_snapshots ADD COLUMN backfill_attempts INTEGER NOT NULL DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS idx_latency_price_backfill_due
     ON latency_price_snapshots (capture_mode, due_at)
     WHERE captured_at IS NULL`,
  `UPDATE latency_price_snapshots
      SET captured_at = NULL, error = NULL
    WHERE error IN ('missed_window', 'fmp_quote_http_402')`,
] as const;

/**
 * 0093_premium_activation_alerts.sql — idempotency ledger for the "someone
 * became Premium" Pushover notification (billing/premiumActivationAlert.ts),
 * plus supporting indexes so the totals aggregate it sends stays cheap.
 * Renumbered off 0090/0091 after those slots landed on main as
 * admin_allowlist / apple_subscriptions_nullable_user / latency_snapshot_repair.
 */
export const PREMIUM_ACTIVATION_ALERT_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS premium_activation_notices (
     activation_key  TEXT PRIMARY KEY,
     user_id         TEXT NOT NULL,
     notified_at     TEXT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_users_premium_status ON users (subscription_status, plan)',
  `CREATE INDEX IF NOT EXISTS idx_apple_subscriptions_status_expires
     ON apple_subscriptions (status, expires_date)`,
] as const;


/**
 * 0095_latency_snapshot_12h_sweep.sql
 */
export const LATENCY_SNAPSHOT_12H_SWEEP_SCHEMA_STATEMENTS = [
  `ALTER TABLE latency_price_snapshots ADD COLUMN swept_12h INTEGER NOT NULL DEFAULT 0;`
] as const;

/**
 * 0096_gov_probe_intervals_and_24h_snapshots.sql
 */
export const GOV_PROBE_INTERVALS_SCHEMA_STATEMENTS = [
  'ALTER TABLE filings ADD COLUMN prev_probe_at TEXT',
  'ALTER TABLE filings ADD COLUMN probe_interval_sec INTEGER',
  'ALTER TABLE trade_latency_candidates ADD COLUMN congress_window_start TEXT',
] as const;

/**
 * 0097_unblock_not_found_house_phantoms.sql
 */
/**
 * 0098_latency_time_provenance.sql
 * Observed vs claimed timestamp provenance on latency_price_snapshots.
 * Independent of confidence (exact / bracketed / unbounded).
 */
export const LATENCY_TIME_PROVENANCE_SCHEMA_STATEMENTS = [
  'ALTER TABLE latency_price_snapshots ADD COLUMN time_provenance TEXT',
  `UPDATE latency_price_snapshots
      SET time_provenance = 'observed'
    WHERE event = 'ct_publish'
      AND time_provenance IS NULL`,
] as const;

/**
 * 0099_feed_latency_join_index.sql
 * GET /api/transactions looks up one trade_latency_candidates row by doc_id.
 * The file migration creates the index.  POST_0024 must create the same
 * object or the file-vs-admin schema snapshot diverges.
 */
export const FEED_LATENCY_JOIN_INDEX_SCHEMA_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS idx_trade_latency_candidates_doc
     ON trade_latency_candidates (doc_id, ticker, tx_date, tx_type)`,
] as const;

/**
 * 0101_market_import_provenance.sql
 * Provider as-of stays in updated_at. received_at is when the push landed.
 * 0100 is reserved for peer import receipts in #2634. 0102 on main is the
 * freshness-stream indexes from #2635.
 */
export const MARKET_IMPORT_PROVENANCE_SCHEMA_STATEMENTS = [
  'ALTER TABLE fundamentals_eod ADD COLUMN received_at TEXT',
  'ALTER TABLE analyst_consensus ADD COLUMN received_at TEXT',
  // Pre-0101 updated_at was the receive time. Copy it once so freshness does
  // not go dark until the next push. Later imports set received_at themselves.
  'UPDATE fundamentals_eod SET received_at = updated_at WHERE received_at IS NULL',
  'UPDATE analyst_consensus SET received_at = updated_at WHERE received_at IS NULL',
] as const;

/**
 * 0102_freshness_stream_indexes.sql
 * Daily freshness MAX(date) / imported MAX(updated_at) cannot ride
 * PRIMARY KEY (ticker, date).  Same statements as the file migration so the
 * file-vs-admin schema snapshot stays aligned.
 */
export const FRESHNESS_STREAM_INDEX_SCHEMA_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_insider_eod_date ON insider_eod (date)',
  'CREATE INDEX IF NOT EXISTS idx_short_volume_eod_date ON short_volume_eod (date)',
  `CREATE INDEX IF NOT EXISTS idx_analyst_consensus_source_updated
     ON analyst_consensus (source, updated_at)`,
] as const;

export const UNBLOCK_NOT_FOUND_HOUSE_PHANTOMS_STATEMENTS = [
  `DELETE FROM ingestion_outbox
   WHERE doc_id IN (
     SELECT doc_id FROM filings
     WHERE chamber = 'house'
       AND ingest_status = 'not_found'
       AND raw_object_key IS NULL
       AND (error LIKE '%phantom%' OR error LIKE '%scout frontier-probe%')
   )`,
  `DELETE FROM filings
   WHERE chamber = 'house'
     AND ingest_status = 'not_found'
     AND raw_object_key IS NULL
     AND (error LIKE '%phantom%' OR error LIKE '%scout frontier-probe%')`,
] as const;

export const POST_0024_SCHEMA_STATEMENTS = [

  // 0025_extraction_runs_usage.sql
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
  // 0043_price_backfill_termination.sql
  ...PRICE_BACKFILL_TERMINATION_SCHEMA_STATEMENTS,
  // 0044_tx_doc_index.sql
  ...TX_DOC_INDEX_SCHEMA_STATEMENTS,
  // 0045_d1_budget.sql
  ...D1_BUDGET_SCHEMA_STATEMENTS,
  // 0046_usage_telemetry_probe_lease.sql
  ...USAGE_TELEMETRY_PROBE_LEASE_SCHEMA_STATEMENTS,
  // 0047_subscription_quota_active_only.sql
  ...SUBSCRIPTION_QUOTA_ACTIVE_ONLY_SCHEMA_STATEMENTS,
  // 0048_retention_indexes.sql
  ...RETENTION_INDEX_SCHEMA_STATEMENTS,
  // 0049_autopilot.sql
  ...AUTOPILOT_SCHEMA_STATEMENTS,
  // 0050_doc_class.sql
  ...DOC_CLASS_SCHEMA_STATEMENTS,
  // 0051_resource_governors.sql
  ...RESOURCE_GOVERNOR_SCHEMA_STATEMENTS,
  // 0052_deno_runtime_queue.sql
  ...DENO_RUNTIME_QUEUE_SCHEMA_STATEMENTS,
  // 0053_spend_settlements.sql
  ...SPEND_SETTLEMENT_SCHEMA_STATEMENTS,
  // 0054_accounting_projections.sql
  ...ACCOUNTING_PROJECTION_SCHEMA_STATEMENTS,
  // 0055_accounting_projection_resync.sql
  ...ACCOUNTING_PROJECTION_RESYNC_SCHEMA_STATEMENTS,
  // 0056_query_optimizations.sql
  ...QUERY_OPTIMIZATIONS_SCHEMA_STATEMENTS,
  // 0057_performance_indexes.sql
  ...PERFORMANCE_INDEXES_SCHEMA_STATEMENTS,
  // 0058_turso_query_efficiency.sql
  ...TURSO_QUERY_EFFICIENCY_SCHEMA_STATEMENTS,
  // 0059_trade_latency_watch.sql
  ...TRADE_LATENCY_WATCH_SCHEMA_STATEMENTS,
  // Idempotent ALTERs for trade-latency tables created before source_url /
  // provider_published_at were present (CREATE IF NOT EXISTS does not alter).
  ...TRADE_LATENCY_WATCH_COLUMN_FIX_SCHEMA_STATEMENTS,
  // 0073_latency_scoreboard_indexes.sql
  ...TRADE_LATENCY_SCOREBOARD_INDEX_SCHEMA_STATEMENTS,
  // 0060_deno_runtime_kv.sql
  ...DENO_RUNTIME_KV_SCHEMA_STATEMENTS,
  // 0061_clean_placeholder_tickers.sql
  ...CLEAN_PLACEHOLDER_TICKERS_SCHEMA_STATEMENTS,
  // 0062_fix_deno_runtime_queue_index.sql
  ...FIX_DENO_RUNTIME_QUEUE_INDEX_SCHEMA_STATEMENTS,
  // 0063_filings_filed_date_index.sql
  ...FILINGS_FILED_DATE_INDEX_SCHEMA_STATEMENTS,
  // 0064_deno_runtime_queue_dead_letter_cycles.sql
  ...DENO_RUNTIME_QUEUE_DEAD_LETTER_CYCLES_SCHEMA_STATEMENTS,
  // 0065_stock_act_status.sql
  ...STOCK_ACT_STATUS_SCHEMA_STATEMENTS,
  // 0066_filer_bioguide_resolution.sql
  ...FILER_BIOGUIDE_RESOLUTION_SCHEMA_STATEMENTS,
  // 0067_clean_ocr_dot_leader_asset_names.sql
  ...CLEAN_OCR_DOT_LEADERS_SCHEMA_STATEMENTS,
  // 0068_cursor_seq_integrity.sql
  ...CURSOR_SEQ_INTEGRITY_SCHEMA_STATEMENTS,
  // 0069_client_command_secret_claim.sql
  ...CLIENT_COMMAND_SECRET_CLAIM_SCHEMA_STATEMENTS,
  // 0070_purge_leaked_kv_credentials.sql
  ...PURGE_LEAKED_KV_CREDENTIALS_SCHEMA_STATEMENTS,
  // 0071_queue_outbox_retention_indexes.sql
  ...QUEUE_OUTBOX_RETENTION_INDEX_SCHEMA_STATEMENTS,
  // 0072_local_vision_worker.sql
  ...LOCAL_VISION_WORKER_SCHEMA_STATEMENTS,
  // 0074_lower_subscription_quota.sql
  ...LOWER_SUBSCRIPTION_QUOTA_SCHEMA_STATEMENTS,
  // 0076_push_devices.sql
  ...PUSH_DEVICES_SCHEMA_STATEMENTS,
  // 0077_llm_spend_purpose_doc.sql
  ...LLM_SPEND_PURPOSE_DOC_SCHEMA_STATEMENTS,
  // 0078_filer_identity_merges.sql
  ...FILER_IDENTITY_MERGE_SCHEMA_STATEMENTS,
  // 0079_members_directory_perf.sql
  ...MEMBERS_DIRECTORY_PERF_SCHEMA_STATEMENTS,
  // 0080_apple_signin.sql
  ...APPLE_SIGNIN_SCHEMA_STATEMENTS,
  // 0081_apple_iap.sql
  ...APPLE_IAP_SCHEMA_STATEMENTS,
  // 0082_review_queue_resolution_reason.sql
  ...REVIEW_QUEUE_RESOLUTION_REASON_SCHEMA_STATEMENTS,
  // 0083_filers_display_name.sql
  ...FILERS_DISPLAY_NAME_SCHEMA_STATEMENTS,
  // 0084_latency_probe_leases.sql
  ...LATENCY_PROBE_LEASE_SCHEMA_STATEMENTS,
  // 0085_asset_name_ticker_normalization.sql
  ...ASSET_NORMALIZATION_0085_SCHEMA_STATEMENTS,
  // 0086_apns_fanout_state.sql
  ...APNS_FANOUT_STATE_SCHEMA_STATEMENTS,
  // 0087_latency_price_snapshots.sql
  ...LATENCY_PRICE_SNAPSHOT_SCHEMA_STATEMENTS,
  // 0088_tx_twin_seek_index.sql
  ...TWIN_SEEK_INDEX_SCHEMA_STATEMENTS,
  // 0089_probe_run_brackets.sql
  ...PROBE_RUN_BRACKET_SCHEMA_STATEMENTS,
  // 0090_admin_allowlist.sql
  ...ADMIN_ALLOWLIST_SCHEMA_STATEMENTS,
  // 0091_apple_subscriptions_nullable_user.sql — Guideline 5.1.1(v).
  ...APPLE_SUBSCRIPTIONS_NULLABLE_USER_SCHEMA_STATEMENTS,
  // 0092_latency_snapshot_repair.sql
  ...LATENCY_PRICE_SNAPSHOT_REPAIR_SCHEMA_STATEMENTS,
  // 0093_premium_activation_alerts.sql
  ...PREMIUM_ACTIVATION_ALERT_SCHEMA_STATEMENTS,
  // 0094_x_auth.sql
  ...X_AUTH_SCHEMA_STATEMENTS,
  // 0095_latency_snapshot_12h_sweep.sql
  ...LATENCY_SNAPSHOT_12H_SWEEP_SCHEMA_STATEMENTS,
  // 0096_gov_probe_intervals_and_24h_snapshots.sql
  ...GOV_PROBE_INTERVALS_SCHEMA_STATEMENTS,
  // 0097_unblock_not_found_house_phantoms.sql
  ...UNBLOCK_NOT_FOUND_HOUSE_PHANTOMS_STATEMENTS,
  // 0098_latency_time_provenance.sql
  ...LATENCY_TIME_PROVENANCE_SCHEMA_STATEMENTS,
  // 0099_feed_latency_join_index.sql
  ...FEED_LATENCY_JOIN_INDEX_SCHEMA_STATEMENTS,
  // 0101_market_import_provenance.sql (0100 reserved for peer import receipts in #2634)
  ...MARKET_IMPORT_PROVENANCE_SCHEMA_STATEMENTS,
  // 0102_freshness_stream_indexes.sql (#2635)
  ...FRESHNESS_STREAM_INDEX_SCHEMA_STATEMENTS,
] as const;

export const INGESTION_DECISIONS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ingestion_decisions (
     id TEXT PRIMARY KEY,
     doc_id TEXT,
     action TEXT NOT NULL,
     source TEXT NOT NULL,
     actor TEXT,
     reason TEXT,
     payload TEXT,
     transaction_ids TEXT NOT NULL DEFAULT '[]',
     created_at TEXT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_ingestion_decisions_doc ON ingestion_decisions (doc_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_ingestion_decisions_created ON ingestion_decisions (created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_ingestion_decisions_action ON ingestion_decisions (action, created_at DESC)',
] as const;

export const INTERMEDIATE_SCHEMA_STATEMENTS = [
  ...DISCLOSURE_AVAILABLE_SCHEMA_STATEMENTS,
  ...INGESTION_DECISIONS_SCHEMA_STATEMENTS,
  `CREATE TABLE IF NOT EXISTS securities_ref (
     ticker TEXT PRIMARY KEY, company_name TEXT, sector TEXT, industry TEXT,
     asset_class TEXT, is_etf INTEGER NOT NULL DEFAULT 0, is_adr INTEGER NOT NULL DEFAULT 0,
     country TEXT, state_hq TEXT, state_of_incorp TEXT, exchange TEXT,
     exchange_short TEXT, currency TEXT, market_cap INTEGER, market_cap_bucket TEXT,
     ipo_date TEXT, cik TEXT, sic_code TEXT, sic_description TEXT, source TEXT,
     enriched_at TEXT, enrichment_error TEXT, current_price REAL, current_price_date TEXT
   )`,
  'ALTER TABLE transactions ADD COLUMN row_key TEXT',
  'ALTER TABLE transactions ADD COLUMN asset_type_name TEXT',
  'ALTER TABLE transactions ADD COLUMN filing_status TEXT',
  'ALTER TABLE transactions ADD COLUMN subholding TEXT',
  'ALTER TABLE transactions ADD COLUMN location TEXT',
  'ALTER TABLE transactions ADD COLUMN description TEXT',
  'ALTER TABLE transactions ADD COLUMN supplemental_text TEXT',
  'ALTER TABLE transactions ADD COLUMN deprecated_at TEXT',
  'ALTER TABLE transactions ADD COLUMN deprecated_reason TEXT',
] as const;






export async function runMigrations(db: { prepare: (sql: string) => { run: () => Promise<unknown> } }): Promise<void> {
  const statements = [...BASE_SCHEMA_STATEMENTS, ...INTERMEDIATE_SCHEMA_STATEMENTS, ...POST_0024_SCHEMA_STATEMENTS];
  for (const sql of statements) {
    try {
      await db.prepare(sql).run();
    } catch {}
  }
}



