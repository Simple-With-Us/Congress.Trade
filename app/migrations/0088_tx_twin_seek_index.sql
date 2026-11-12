-- 0088_tx_twin_seek_index.sql
-- Issue #2062: PR 2037 put a correlated NOT EXISTS twin guard on every
-- live-row query. Without a (filer_id, tx_date) seek, SQLite walked
-- idx_transactions_date_cursor_desc (tx_date=?) per outer row — every
-- trade on that calendar day — and GET /transactions COUNT + Trends
-- 90d aggregates hung 8–25s with zero bytes until c.json.
--
-- This partial index matches TWIN_DEDUPE_SQL's inner predicates
-- (d.filer_id = t.filer_id AND d.tx_date = t.tx_date AND
-- d.deprecated_at IS NULL). Keep in lockstep with
-- TWIN_SEEK_INDEX_SCHEMA_STATEMENTS in src/admin/migrations.ts.
CREATE INDEX IF NOT EXISTS idx_tx_twin_seek
  ON transactions (filer_id, tx_date)
  WHERE deprecated_at IS NULL;
