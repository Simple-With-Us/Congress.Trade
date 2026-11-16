-- 0100_peer_import_receipts.sql
-- Inbound cross-app share push receipts (Socratic.Trade -> POST /api/admin/securities/import).
-- Captures accepted/dropped/rejected counts, error summaries, and payload size per request.
-- Pruned by the daily retention sweep (see jobs.ts RETENTION_POLICIES).

CREATE TABLE IF NOT EXISTS peer_import_receipts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id      TEXT NOT NULL,
  received_at     TEXT NOT NULL,
  origin          TEXT,
  kind            TEXT NOT NULL DEFAULT 'share_push',
  payload_bytes   INTEGER NOT NULL DEFAULT 0,
  ok              INTEGER NOT NULL DEFAULT 1,
  accepted_json   TEXT NOT NULL DEFAULT '{}',
  dropped_json    TEXT NOT NULL DEFAULT '{}',
  rejected_json   TEXT NOT NULL DEFAULT '{}',
  errors_json     TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_peer_import_receipts_received_at
  ON peer_import_receipts (received_at);

CREATE INDEX IF NOT EXISTS idx_peer_import_receipts_request_id
  ON peer_import_receipts (request_id);
