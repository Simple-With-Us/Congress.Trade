-- 0092_latency_snapshot_repair.sql
-- Repairs the latency-price-snapshot pipeline (2937/2955 stuck at missed_window,
-- 11 at a paid-quote-provider HTTP 402). No PK change: `event` is free text, so the
-- +15m rung is additive in code only (see LATENCY_PRICE_EVENTS). New columns record
-- HOW a price was answered (capture_mode), how confident we are in due_at
-- (confidence / due_at_uncertainty_sec, derived from the provider_probe_runs
-- bracket added in 0089), and the market session at the requested instant so
-- a print crossing the close is labeled, not silently averaged in.

ALTER TABLE latency_price_snapshots ADD COLUMN capture_mode TEXT;
ALTER TABLE latency_price_snapshots ADD COLUMN confidence TEXT;
ALTER TABLE latency_price_snapshots ADD COLUMN due_at_uncertainty_sec INTEGER;
ALTER TABLE latency_price_snapshots ADD COLUMN market_session TEXT;
ALTER TABLE latency_price_snapshots ADD COLUMN backfill_attempts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_latency_price_backfill_due
  ON latency_price_snapshots (capture_mode, due_at)
  WHERE captured_at IS NULL;

-- One-time repair: every row previously abandoned is reopened. That includes the 11
-- 'fmp_quote_http_402' rows - they carry an error naming a provider that is no longer a
-- data source at all, and they are now perfectly backfillable from intraday bars.
-- Every row previously abandoned with 'missed_window' is
-- reopened for capture through the SAME live/backfill pipeline that answers
-- new rows -- never a synthetic "now" price on a past due_at. Idempotent:
-- after the first replay no row still has this value.
UPDATE latency_price_snapshots
   SET captured_at = NULL, error = NULL
 WHERE error IN ('missed_window', 'fmp_quote_http_402');
