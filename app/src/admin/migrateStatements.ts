import {
  BASE_SCHEMA_STATEMENTS,
  DISCLOSURE_AVAILABLE_SCHEMA_STATEMENTS,
  POST_0024_SCHEMA_STATEMENTS,
} from './migrations.ts';

/** Full idempotent statement list for POST /api/admin/migrate and Deno startup schema apply. */
export function buildAdminMigrateStatements(): readonly string[] {
  return [
      ...BASE_SCHEMA_STATEMENTS,
      'ALTER TABLE filers ADD COLUMN photo_url TEXT',
      // 0003_users.sql — end-user accounts (public-site auth). Idempotent.
      `CREATE TABLE IF NOT EXISTS users (
         id             TEXT PRIMARY KEY,
         email          TEXT NOT NULL UNIQUE,
         name           TEXT,
         picture        TEXT,
         google_sub     TEXT UNIQUE,
         email_verified INTEGER NOT NULL DEFAULT 0,
         created_at     TEXT NOT NULL,
         last_login_at  TEXT
       )`,
      'CREATE INDEX IF NOT EXISTS idx_users_email ON users (email)',
      // 0004_billing.sql — Stripe billing columns on users. Idempotent.
      'ALTER TABLE users ADD COLUMN stripe_customer_id TEXT',
      'ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT',
      'ALTER TABLE users ADD COLUMN subscription_status TEXT',
      'ALTER TABLE users ADD COLUMN plan TEXT',
      'ALTER TABLE users ADD COLUMN current_period_end TEXT',
      'ALTER TABLE users ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE users ADD COLUMN trial_end TEXT',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stripe_customer ON users (stripe_customer_id)',
      // 0005_securities_ref.sql — asset reference data (sector, market cap, …).
      `CREATE TABLE IF NOT EXISTS securities_ref (
         ticker            TEXT PRIMARY KEY,
         company_name      TEXT, sector TEXT, industry TEXT, asset_class TEXT,
         is_etf INTEGER NOT NULL DEFAULT 0, is_adr INTEGER NOT NULL DEFAULT 0,
         country TEXT, state_hq TEXT, state_of_incorp TEXT,
         exchange TEXT, exchange_short TEXT, currency TEXT,
         market_cap INTEGER, market_cap_bucket TEXT, ipo_date TEXT,
         cik TEXT, sic_code TEXT, sic_description TEXT,
         source TEXT, enriched_at TEXT, enrichment_error TEXT
       )`,
      'CREATE INDEX IF NOT EXISTS idx_secref_sector ON securities_ref (sector)',
      'CREATE INDEX IF NOT EXISTS idx_secref_bucket ON securities_ref (market_cap_bucket)',
      'CREATE INDEX IF NOT EXISTS idx_secref_enriched ON securities_ref (enriched_at)',
      // 0006_prices.sql — price history + per-trade performance vs S&P 500.
      `CREATE TABLE IF NOT EXISTS price_eod (
         ticker TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL,
         PRIMARY KEY (ticker, date)
       )`,
      'CREATE INDEX IF NOT EXISTS idx_price_eod_ticker_date ON price_eod (ticker, date DESC)',
      'CREATE TABLE IF NOT EXISTS spx_eod (date TEXT PRIMARY KEY, close REAL NOT NULL)',
      `CREATE TABLE IF NOT EXISTS tx_performance (
         tx_id TEXT PRIMARY KEY, price_at_trade REAL, spx_at_trade REAL, computed_at TEXT
       )`,
      'ALTER TABLE securities_ref ADD COLUMN current_price REAL',
      'ALTER TABLE securities_ref ADD COLUMN current_price_date TEXT',
      // 0007_market_extras.sql — daily volume + insider / short-volume datasets.
      'ALTER TABLE price_eod ADD COLUMN volume INTEGER',
      `CREATE TABLE IF NOT EXISTS insider_eod (
         ticker TEXT NOT NULL, date TEXT NOT NULL, sentiment REAL,
         buy_filings INTEGER, sell_filings INTEGER, buy_shares REAL, sell_shares REAL,
         owners TEXT, PRIMARY KEY (ticker, date)
       )`,
      `CREATE TABLE IF NOT EXISTS short_volume_eod (
         ticker TEXT NOT NULL, date TEXT NOT NULL, short_volume_ratio REAL,
         elevated INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ticker, date)
       )`,
      // 0008_idempotency_keys.sql — at-least-once retry guards.
      'ALTER TABLE transactions ADD COLUMN row_key TEXT',
      // NOTE: the strict idx_transactions_doc_source_rowkey that 0008 created
      // is deliberately NOT replayed here. A later statement in this same list
      // (REVIEW_AGREEMENT_SUPPRESSION_SCHEMA_STATEMENTS) supersedes it with
      // idx_transactions_live_doc_source_rowkey — which additionally requires
      // deprecated_at IS NULL — and then DROPs this one. Recreating it on every
      // run was dead work that also throws "UNIQUE constraint failed" whenever a
      // deprecated row shares (doc_id, source, row_key) with a live one, which
      // is precisely why it was superseded. Harmless while /migrate swallowed
      // errors; since that route fails closed it would 500 the whole migration
      // and block the deploy.
      `DELETE FROM deliveries
         WHERE rowid NOT IN (
           SELECT MAX(rowid)
             FROM deliveries
            GROUP BY subscription_id, tx_id
         )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_subscription_tx
         ON deliveries (subscription_id, tx_id)`,
      // 0009_client_api.sql — shared PWA / SwiftUI client state.
      `CREATE TABLE IF NOT EXISTS user_preferences (
         user_id TEXT PRIMARY KEY,
         saved_filters TEXT NOT NULL DEFAULT '{}',
         watchlist TEXT NOT NULL DEFAULT '[]',
         notification_settings TEXT NOT NULL DEFAULT '{}',
         default_window TEXT,
         updated_at TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS client_commands (
         id TEXT PRIMARY KEY,
         user_id TEXT NOT NULL,
         type TEXT NOT NULL,
         status TEXT NOT NULL,
         idempotency_key TEXT,
         payload TEXT NOT NULL DEFAULT '{}',
         result TEXT,
         error TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         started_at TEXT,
         finished_at TEXT
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_client_commands_user_idempotency
         ON client_commands (user_id, idempotency_key)
         WHERE idempotency_key IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_client_commands_user_created
         ON client_commands (user_id, created_at DESC)`,
      'CREATE INDEX IF NOT EXISTS idx_client_commands_status ON client_commands (status)',
      // 0010_fundamentals.sql — sibling-app fundamentals + analyst consensus cache.
      `CREATE TABLE IF NOT EXISTS fundamentals_eod (
         ticker TEXT NOT NULL, date TEXT NOT NULL, pe_ratio REAL, eps REAL, beta REAL,
         dividend_yield REAL, week52_high REAL, week52_low REAL, fcf_yield REAL,
         debt_to_equity REAL, eps_growth REAL, source TEXT, updated_at TEXT NOT NULL,
         PRIMARY KEY (ticker, date)
       )`,
      `CREATE TABLE IF NOT EXISTS analyst_consensus (
         ticker TEXT NOT NULL, date TEXT NOT NULL, rating TEXT, target_mean REAL,
         target_high REAL, target_low REAL, target_median REAL, analyst_count INTEGER,
         strong_buy INTEGER, buy INTEGER, hold INTEGER, sell INTEGER, strong_sell INTEGER,
         source TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (ticker, date)
       )`,
      // 0011_transaction_row_details.sql — row-specific House PTR details.
      'ALTER TABLE transactions ADD COLUMN asset_type_name TEXT',
      'ALTER TABLE transactions ADD COLUMN filing_status TEXT',
      'ALTER TABLE transactions ADD COLUMN subholding TEXT',
      'ALTER TABLE transactions ADD COLUMN location TEXT',
      'ALTER TABLE transactions ADD COLUMN description TEXT',
      'ALTER TABLE transactions ADD COLUMN supplemental_text TEXT',
      'CREATE INDEX IF NOT EXISTS idx_tx_asset_type_name ON transactions (asset_type_name)',
      // 0012_shares_outstanding.sql — keep market cap current off the daily close.
      'ALTER TABLE securities_ref ADD COLUMN shares_outstanding REAL',
      `UPDATE securities_ref SET shares_outstanding = market_cap / current_price
         WHERE shares_outstanding IS NULL AND market_cap IS NOT NULL
           AND current_price IS NOT NULL AND current_price > 0`,
      // 0013_tx_deprecation.sql — soft-delete so admins can un-publish filings.
      'ALTER TABLE transactions ADD COLUMN deprecated_at TEXT',
      'ALTER TABLE transactions ADD COLUMN deprecated_reason TEXT',
      'CREATE INDEX IF NOT EXISTS idx_tx_deprecated_at ON transactions (deprecated_at)',
      // 0014_tx_perf_filing_anchors.sql — disclosure-date performance anchors.
      'ALTER TABLE tx_performance ADD COLUMN price_at_filing REAL',
      'ALTER TABLE tx_performance ADD COLUMN spx_at_filing REAL',
      // 0015_extraction_runs.sql — per-doc per-model extraction results (bake-off + review dashboard).
      `CREATE TABLE IF NOT EXISTS extraction_runs (
         id TEXT PRIMARY KEY, batch_id TEXT, doc_id TEXT NOT NULL,
         provider TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'bakeoff',
         ok INTEGER NOT NULL DEFAULT 0, error TEXT, row_count INTEGER NOT NULL DEFAULT 0,
         latency_ms INTEGER, avg_confidence REAL, result_json TEXT, created_at TEXT NOT NULL)`,
      'CREATE INDEX IF NOT EXISTS idx_extraction_runs_doc ON extraction_runs (doc_id)',
      'CREATE INDEX IF NOT EXISTS idx_extraction_runs_batch ON extraction_runs (batch_id)',
      'CREATE INDEX IF NOT EXISTS idx_extraction_runs_created ON extraction_runs (created_at)',
      // 0016_batch_jobs.sql — async batch reprocessing jobs (cheaper backlog path).
      `CREATE TABLE IF NOT EXISTS batch_jobs (
         id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
         provider_batch_id TEXT, doc_ids TEXT NOT NULL, status TEXT NOT NULL,
         submitted_at TEXT NOT NULL, completed_at TEXT, turnaround_ms INTEGER,
         result_summary TEXT, error TEXT)`,
      'CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON batch_jobs (status)',
      'CREATE INDEX IF NOT EXISTS idx_batch_jobs_submitted ON batch_jobs (submitted_at)',
      // 0017_fb_meta_remap.sql — Facebook's old "FB" ticker was reassigned by the
      // SEC to a ProShares ETF after Meta moved to "META", so congressional FB
      // trades were showing the ProShares name. Remap stored FB rows to META and
      // fix the cached names. Idempotent (UPDATEs).
      "UPDATE transactions SET ticker = 'META' WHERE ticker = 'FB' AND deprecated_at IS NULL",
      "UPDATE securities_ref SET company_name = 'Meta Platforms, Inc.' WHERE ticker = 'META' AND (company_name IS NULL OR company_name = '' OR company_name LIKE '%ProShares%')",
      "UPDATE securities_master SET name = 'Meta Platforms, Inc.' WHERE ticker = 'META'",
      // 0018_agreement_attempted.sql — one autonomous agreement attempt per review doc.
      'ALTER TABLE review_queue ADD COLUMN agreement_attempted_at TEXT',
      'CREATE INDEX IF NOT EXISTS idx_review_queue_agreement ON review_queue (agreement_attempted_at)',
      // 0019_ingestion_decisions.sql — append-only audit trail for publication/review decisions.
      `CREATE TABLE IF NOT EXISTS ingestion_decisions (
         id TEXT PRIMARY KEY,
         doc_id TEXT NOT NULL,
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
      // 0020_disclosure_available_generated.sql — generated column for disclosure availability.
      ...DISCLOSURE_AVAILABLE_SCHEMA_STATEMENTS,
      // 0021_disclosure_latency_watch.sql — congress.trade-vs-FMP disclosure race monitor.
      `CREATE TABLE IF NOT EXISTS disclosure_latency_candidates (
         doc_id TEXT NOT NULL,
         provider TEXT NOT NULL DEFAULT 'fmp',
         chamber TEXT NOT NULL,
         source_url TEXT,
         filed_date TEXT,
         filer_name TEXT,
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
         PRIMARY KEY (doc_id, provider)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_disc_latency_candidates_status
         ON disclosure_latency_candidates (provider, status, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS disclosure_provider_observations (
         provider TEXT NOT NULL,
         chamber TEXT NOT NULL,
         provider_key TEXT NOT NULL,
         first_observed_at TEXT NOT NULL,
         last_observed_at TEXT NOT NULL,
         provider_published_at TEXT,
         source_url TEXT,
         filed_date TEXT,
         filer_name TEXT,
         payload TEXT,
         PRIMARY KEY (provider, chamber, provider_key)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_disc_provider_seen
         ON disclosure_provider_observations (provider, chamber, first_observed_at DESC)`,
      // 0022_stripe_webhook_events.sql — durable Stripe webhook idempotency ledger.
      `CREATE TABLE IF NOT EXISTS stripe_webhook_events (
         event_id TEXT PRIMARY KEY,
         event_type TEXT NOT NULL,
         received_at TEXT NOT NULL,
         processed_at TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_received
         ON stripe_webhook_events (received_at DESC)`,
      // 0023_disclosure_provider_timestamps.sql — provider-side publish/upload timestamp when available.
      'ALTER TABLE disclosure_latency_candidates ADD COLUMN provider_published_at TEXT',
      'ALTER TABLE disclosure_provider_observations ADD COLUMN provider_published_at TEXT',
      // 0024_dead_letter_events.sql — operator log for terminally-failed queue messages.
      `CREATE TABLE IF NOT EXISTS dead_letter_events (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         queue TEXT NOT NULL,
         msg_type TEXT,
         doc_id TEXT,
         tx_id TEXT,
         attempts INTEGER,
         error TEXT,
         created_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_dead_letter_created ON dead_letter_events(created_at)`,
      // 0087_latency_price_snapshots.sql
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
      `CREATE INDEX IF NOT EXISTS idx_latency_price_due ON latency_price_snapshots (captured_at, due_at)`,
      // 0025_amendment_trump_deprecation.sql — soft-deprecate unamended Trump report rows superseded by amendment.
      `UPDATE transactions
          SET deprecated_at = '2026-07-28T17:00:00.000Z',
              deprecated_reason = 'superseded by amendment E-2025-donald-j-trump-08-12-2025-278t-2-amended'
        WHERE doc_id = 'E-2025-donald-j-trump-08-12-2025-278t-3'
          AND deprecated_at IS NULL
          AND EXISTS (
            SELECT 1 FROM transactions WHERE doc_id = 'E-2025-donald-j-trump-08-12-2025-278t-2-amended' AND deprecated_at IS NULL
          )`,
      `CREATE INDEX IF NOT EXISTS idx_filings_filer_amend ON filings(filer_id, ingest_status, filed_date)`,
      // 0026_retroactive_amendment_deprecation_sweep.sql — soft-deprecate all historical predecessor filing transactions superseded by amended filings across all chambers (indexed and bounded to 50 per run for instant response).
      `UPDATE transactions
          SET deprecated_at = '2026-07-28T17:15:00.000Z',
              deprecated_reason = 'retroactive amendment cleanup: superseded by newer amended filing'
        WHERE deprecated_at IS NULL
          AND doc_id IN (
            SELECT f_orig.doc_id
              FROM filings f_amend
              JOIN filings f_orig
                ON f_amend.filer_id = f_orig.filer_id
               AND f_amend.filed_date = f_orig.filed_date
               AND f_amend.doc_id <> f_orig.doc_id
             WHERE f_amend.ingest_status = 'persisted'
               AND f_orig.ingest_status = 'persisted'
               AND (f_amend.filing_status = 'Amended' OR f_amend.doc_id LIKE '%amend%' OR f_amend.source_url LIKE '%amend%')
             LIMIT 50
          )`,
      // 0029-0039 — canonical value, reliability, Stripe, review, and benchmark tail.
      ...POST_0024_SCHEMA_STATEMENTS,
  ];
}
