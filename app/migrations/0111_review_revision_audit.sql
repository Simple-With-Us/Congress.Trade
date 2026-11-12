-- 0111_review_revision_audit.sql
-- Append-only audit of review_revision changes and identical-publish no-ops (CT-2510).

CREATE TABLE IF NOT EXISTS review_revision_audit (
  id           TEXT PRIMARY KEY,
  doc_id       TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  trigger      TEXT NOT NULL,
  content_hash TEXT,
  detail       TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_revision_audit_doc
  ON review_revision_audit (doc_id, revision DESC, created_at DESC);
