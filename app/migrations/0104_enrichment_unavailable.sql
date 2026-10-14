-- 0104_enrichment_unavailable.sql
-- Negative-cache tickers that cannot be enriched (operator or peer-confirmed).

ALTER TABLE securities_ref ADD COLUMN enrichment_unavailable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE securities_ref ADD COLUMN enrichment_unavailable_reason TEXT;
ALTER TABLE securities_ref ADD COLUMN enrichment_checked_at TEXT;
