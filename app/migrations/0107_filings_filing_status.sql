-- filings.filing_status: read by the admin manual-review publish
-- (POST /api/admin/review/:docId) and agreement publish since #1098
-- (2026-07-28) but never declared in a numbered migration, so a database
-- built only from migrations/ lacks it.  Idempotent on databases that already
-- have the column (the migrate runner skips "duplicate column name").

ALTER TABLE filings ADD COLUMN filing_status TEXT;
