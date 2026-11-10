-- 0098_latency_time_provenance.sql
-- Distinguishes timestamps we witnessed (observed) from timestamps a
-- competitor claimed (claimed). Precision (exact / bracketed / unbounded)
-- stays on the existing confidence column; this is a second axis.

ALTER TABLE latency_price_snapshots ADD COLUMN time_provenance TEXT;

-- Our own publish clock is always observed.
UPDATE latency_price_snapshots
   SET time_provenance = 'observed'
 WHERE event = 'ct_publish'
   AND time_provenance IS NULL;

-- Remaining rows: leave NULL until the next schedule pass writes provenance.
-- Do not guess claimed vs observed for historical provider_publish rows.
