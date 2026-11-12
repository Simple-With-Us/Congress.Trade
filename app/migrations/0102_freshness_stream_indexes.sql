-- 0102_freshness_stream_indexes.sql
-- Freshness watchdog MAX() cannot use PRIMARY KEY (ticker, date): ticker leads.
-- 0100 is the peer-import receipt lane and 0101 is the staleness-signal lane.
-- Mirror: FRESHNESS_STREAM_INDEX_SCHEMA_STATEMENTS in app/src/admin/migrations.ts.

CREATE INDEX IF NOT EXISTS idx_insider_eod_date
  ON insider_eod (date);

CREATE INDEX IF NOT EXISTS idx_short_volume_eod_date
  ON short_volume_eod (date);

-- source leads so WHERE source = 'imported' plus MAX(updated_at) is one seek.
CREATE INDEX IF NOT EXISTS idx_analyst_consensus_source_updated
  ON analyst_consensus (source, updated_at);
