-- 0101_market_import_provenance.sql
-- Preserve provider as-of timestamps on imported fundamentals/analyst rows
-- separately from when this app received the push (received_at).

ALTER TABLE fundamentals_eod ADD COLUMN received_at TEXT;
ALTER TABLE analyst_consensus ADD COLUMN received_at TEXT;
