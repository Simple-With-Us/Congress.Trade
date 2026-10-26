-- filings.filing_status: read by the admin manual-review publish
-- (POST /api/admin/review/:docId) and agreement publish since #1098
-- (2026-07-28) but never declared in a numbered migration, so a database
-- built only from migrations/ lacks it.  SQLite has no ADD COLUMN IF NOT
-- EXISTS, so POST /api/admin/migrate first adds the column only when
-- PRAGMA table_info shows it missing (applyGuardedFilingsColumnMigrations);
-- this ALTER then lands on the runner's "duplicate column name" skip.
-- wrangler d1 migrations apply records 0107 in d1_migrations and runs it once.

ALTER TABLE filings ADD COLUMN filing_status TEXT;
