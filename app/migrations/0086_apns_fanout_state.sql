-- Cursor for APNs product fan-out (official trades + review-needed).
-- CONFIG_KV is preferred at runtime; this table is the durable fallback.
CREATE TABLE IF NOT EXISTS apns_fanout_state (
  id TEXT PRIMARY KEY,
  last_trade_at TEXT NOT NULL,
  last_review_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO apns_fanout_state (id, last_trade_at, last_review_at, updated_at)
VALUES ('default', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z');
