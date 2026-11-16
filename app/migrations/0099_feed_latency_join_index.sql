-- 0099_feed_latency_join_index.sql
-- GET /api/transactions joins one trade_latency_candidates row by doc_id.
-- Existing indexes lead with provider or updated_at, so the feed full-scans.
-- Deploy applies app/migrations; it does not run POST /api/admin/migrate.

CREATE INDEX IF NOT EXISTS idx_trade_latency_candidates_doc
  ON trade_latency_candidates (doc_id, ticker, tx_date, tx_type);
