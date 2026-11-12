-- 0089_probe_run_brackets.sql
-- Durable record of EVERY competitor probe, including probes that found
-- nothing -- those are what establish the lower bound of a publication window.
--
-- `trade_provider_observations.first_observed_at` is when WE noticed a
-- competitor carrying a filing, not when the competitor published it. Read as a
-- publication time it silently credits us the whole probe interval as lead.
-- With a prior probe recorded, publication is known to fall in
-- (prev_probe_at, first_observed_at] and the lead becomes a bounded range.
--
-- Existing rows keep NULL windows and are therefore reported as UNBOUNDED
-- rather than being retroactively credited with precision they never had.
-- See src/ingestion/probeRunLog.ts.

CREATE TABLE IF NOT EXISTS provider_probe_runs (
  provider TEXT NOT NULL,
  chamber TEXT NOT NULL,
  ran_at TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  rows_seen INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  PRIMARY KEY (provider, chamber, ran_at)
);

CREATE INDEX IF NOT EXISTS idx_provider_probe_runs_lookup
  ON provider_probe_runs (provider, chamber, ok, ran_at DESC);

ALTER TABLE trade_provider_observations ADD COLUMN prev_probe_at TEXT;
ALTER TABLE trade_latency_candidates ADD COLUMN provider_window_start TEXT;
ALTER TABLE trade_latency_candidates ADD COLUMN provider_window_end TEXT;
