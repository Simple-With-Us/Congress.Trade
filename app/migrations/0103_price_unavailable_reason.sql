-- 0103_price_unavailable_reason.sql
-- Human-readable reason when a ticker is negative-cached as unpriceable.
-- Production also applies this via PRAGMA table_info guard in
-- applyGuardedSecuritiesRefColumnMigrations (schemaMigrationRunner.ts) on startup
-- and before POST /api/admin/migrate replays the statement list.

ALTER TABLE securities_ref ADD COLUMN price_unavailable_reason TEXT;
