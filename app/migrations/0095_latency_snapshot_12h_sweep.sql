-- 0095_latency_snapshot_12h_sweep.sql
-- Adds a flag to track whether a failed snapshot has received its one-time 12-hour retry sweep.

ALTER TABLE latency_price_snapshots ADD COLUMN swept_12h INTEGER NOT NULL DEFAULT 0;
