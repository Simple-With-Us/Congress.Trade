-- 0079_members_directory_perf.sql
-- Issue #1454: GET /api/members took ~6s. The query groups+counts every
-- live (non-deprecated) transaction per filer_id — a full-corpus aggregate
-- that needs `deprecated_at IS NULL` for correctness (every other live read
-- already excludes retracted rows; /members didn't, inflating counts and
-- occasionally showing a "phantom" filer whose only rows were later
-- retracted).
--
-- Naively adding that filter to the existing query gives SQLite's planner a
-- second candidate index (idx_tx_deprecated_at, migration 0013) that a
-- stats-less planner prefers over the existing covering idx_tx_filer — and
-- that choice isn't covering (it can't read filer_id off the deprecated_at
-- index), so every live (~95%) row needs an extra table fetch. Measured
-- locally: this made the query ~5x SLOWER than the pre-fix baseline.
--
-- This partial index is a compound covering index that exactly matches
-- delivery/rest.ts GET /members' filter (filer_id IS NOT NULL AND
-- deprecated_at IS NULL) — an index-only scan, the same shape the original
-- (pre-#1454-fix) query got from idx_tx_filer. rest.ts forces the planner
-- onto it via INDEXED BY, with a fallback query for the narrow window
-- between this migration landing and the new code actually shipping (see
-- the comment on queryMembersRoster).

CREATE INDEX IF NOT EXISTS idx_tx_filer_live
  ON transactions (filer_id)
  WHERE deprecated_at IS NULL;
