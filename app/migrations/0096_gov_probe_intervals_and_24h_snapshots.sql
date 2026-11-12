-- 0096_gov_probe_intervals_and_24h_snapshots.sql
-- Durably record the prior check timestamp and cadence interval for government source discoveries,
-- and extend candidate discovery window brackets.

ALTER TABLE filings ADD COLUMN prev_probe_at TEXT;
ALTER TABLE filings ADD COLUMN probe_interval_sec INTEGER;
ALTER TABLE trade_latency_candidates ADD COLUMN congress_window_start TEXT;
