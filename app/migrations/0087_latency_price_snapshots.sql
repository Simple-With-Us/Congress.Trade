-- 0087_latency_price_snapshots.sql
-- Quote prints at Congress.Trade publish, competitor publish, and 5/30/60
-- minutes after the competitor so we can see whether their print moves price.

CREATE TABLE IF NOT EXISTS latency_price_snapshots (
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
);

CREATE INDEX IF NOT EXISTS idx_latency_price_due
  ON latency_price_snapshots (captured_at, due_at);
