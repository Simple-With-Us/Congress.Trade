-- 0082_review_queue_resolution_reason.sql
-- Make review_queue.resolved=1 an HONEST signal instead of a bare boolean.
--
-- Production audit (2026-08-09) found review_queue with 3,497 rows, every one
-- resolved=1 (hence the review UI reporting "all done" daily), while 738 of
-- those resolved filings have ZERO live transactions and 180 filings sit at
-- filings.ingest_status='needs_review' despite their queue row claiming
-- resolved. Root cause: autopilot's resolveEmptyDoc() (src/extraction/
-- autopilot.ts) flips review_queue.resolved=1 for docs the deterministic
-- classifier calls "empty" without ever updating filings.ingest_status and
-- without recording WHY on the review_queue row itself (only a companion
-- ingestion_decisions audit row, easy to lose track of).
--
-- resolution_kind + resolution_reason give every resolved=1 row an explicit,
-- queryable answer to "why is this resolved": 'published' (>=1 live
-- transaction), 'verified_empty' (a human- or classifier-confirmed filing
-- that legitimately has no reportable transactions — reason required),
-- 'rejected' (admin rejected the extraction — reason required), or
-- 'orphan_deleted' (the filing row itself no longer exists). resolved_at
-- timestamps the transition. trg_review_queue_honest_resolution (below)
-- makes it structurally impossible for any future write path — this one or
-- one not yet written — to set resolved=1 without one of those honest
-- outcomes recorded in the SAME statement.
--
-- The backfill below only classifies EXISTING resolved rows using already-
-- true facts (a live transaction exists / the stored reason already reads
-- "rejected:..."); it does not touch ingest_status, transactions, or
-- fabricate a reason for rows with neither signal. Rows that stay
-- resolution_kind IS NULL after this backfill are exactly the legacy
-- dishonest resolutions the bug produced — left visible (via the pipeline
-- health check and the admin review-queue list) for lane-2 recovery, not
-- mass-mutated here.
--
-- Mirrored idempotently in POST /api/admin/migrate via src/admin/migrations.ts
-- (REVIEW_QUEUE_RESOLUTION_REASON_SCHEMA_STATEMENTS).

ALTER TABLE review_queue ADD COLUMN resolution_kind TEXT;
ALTER TABLE review_queue ADD COLUMN resolution_reason TEXT;
ALTER TABLE review_queue ADD COLUMN resolved_at TEXT;

UPDATE review_queue
   SET resolution_kind = 'published',
       resolved_at = COALESCE(resolved_at, created_at)
 WHERE resolved = 1
   AND resolution_kind IS NULL
   AND EXISTS (
     SELECT 1 FROM transactions t
      WHERE t.doc_id = review_queue.doc_id AND t.deprecated_at IS NULL
   );

UPDATE review_queue
   SET resolution_kind = 'rejected',
       resolution_reason = COALESCE(resolution_reason, reason),
       resolved_at = COALESCE(resolved_at, created_at)
 WHERE resolved = 1
   AND resolution_kind IS NULL
   AND (reason LIKE 'rejected:%' OR reason = 'orphan_filing_deleted');

CREATE INDEX IF NOT EXISTS idx_review_queue_resolution_kind
  ON review_queue (resolved, resolution_kind);

-- Structural guardrail: a future UPDATE that names `resolved` in its SET
-- clause and sets it to 1 must carry an honest resolution_kind in that same
-- statement — published rows must have a live transaction at write time,
-- verified_empty/rejected rows must carry a non-empty resolution_reason.
-- Only fires on UPDATEs that touch `resolved` (matches every current write
-- site); does not fire on this migration's own backfill above, which never
-- names `resolved` in its SET clause, so pre-existing legacy rows are left
-- exactly as they are for lane-2 recovery to find and fix.
DROP TRIGGER IF EXISTS trg_review_queue_honest_resolution;

-- Remaining legacy rows (predate resolution_kind, no live transactions, no
-- 'rejected:' marker): closed as empty without recording why. Classify them
-- honestly so the integrity check reflects ongoing state. Idempotent.
UPDATE review_queue
   SET resolution_kind = 'verified_empty',
       resolution_reason = COALESCE(
         NULLIF(resolution_reason, ''),
         'legacy backfill 2026-08-09: resolved before resolution_kind existed; no live transactions at backfill time'
       ),
       resolved_at = COALESCE(resolved_at, created_at)
 WHERE resolved = 1
   AND resolution_kind IS NULL;

CREATE TRIGGER IF NOT EXISTS trg_review_queue_honest_resolution
BEFORE UPDATE OF resolved ON review_queue
WHEN NEW.resolved = 1 AND (
  NEW.resolution_kind IS NULL
  OR NEW.resolution_kind NOT IN ('published', 'verified_empty', 'rejected', 'orphan_deleted')
  OR (
    NEW.resolution_kind IN ('verified_empty', 'rejected')
    AND (NEW.resolution_reason IS NULL OR TRIM(NEW.resolution_reason) = '')
  )
  OR (
    NEW.resolution_kind = 'published'
    AND NOT EXISTS (
      SELECT 1 FROM transactions WHERE doc_id = NEW.doc_id AND deprecated_at IS NULL
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'review_queue.resolved=1 requires an honest resolution_kind: published needs a live transaction, verified_empty/rejected need resolution_reason');
END;
