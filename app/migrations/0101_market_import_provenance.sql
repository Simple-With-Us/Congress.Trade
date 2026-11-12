-- 0101_market_import_provenance.sql
-- Preserve provider as-of timestamps on imported fundamentals/analyst rows
-- separately from when this app received the push (received_at).

ALTER TABLE fundamentals_eod ADD COLUMN received_at TEXT;
ALTER TABLE analyst_consensus ADD COLUMN received_at TEXT;

-- Pre-0101 updated_at was the receive time. Copy it once so freshness does
-- not go dark until the next push. Later imports set received_at themselves.
UPDATE fundamentals_eod SET received_at = updated_at WHERE received_at IS NULL;
UPDATE analyst_consensus SET received_at = updated_at WHERE received_at IS NULL;
