-- Audit trail for CT_DELIVERY_MODE (subscriber alert pause: deliver | hold |
-- suppress).  One row per change made through PUT /api/admin/settings.
-- The delivery_mode health check reads the latest row to know how long alerts
-- have been off; suppressed delivery_outbox rows carry the audit id in
-- last_error.  Mirrored in src/admin/migrations.ts
-- (DELIVERY_MODE_AUDIT_SCHEMA_STATEMENTS).

CREATE TABLE IF NOT EXISTS delivery_mode_audit (
  id            TEXT PRIMARY KEY,
  mode          TEXT NOT NULL,
  previous_mode TEXT,
  actor         TEXT NOT NULL,
  reason        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_mode_audit_created
  ON delivery_mode_audit (created_at DESC);
