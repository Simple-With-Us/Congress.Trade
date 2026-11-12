-- 0090_admin_allowlist.sql
-- Persisted admin allowlist (grant/revoke admin access for a user's email)
-- and its audit trail. ADMIN_EMAILS in the environment stays the root
-- bootstrap allowlist and is never written here — isAdminSessionEmail /
-- adminRuntimeConfig (src/admin/identity.ts) consult this table ADDITIONALLY
-- to ADMIN_EMAILS, never in place of it. See src/admin/adminAccess.ts for the
-- grant/revoke logic and POST /api/admin/admins/grant|revoke in
-- src/admin/routes.ts for the routes.

CREATE TABLE IF NOT EXISTS admin_allowlist (
  email       TEXT PRIMARY KEY,
  granted_by  TEXT NOT NULL,
  granted_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_access_audit (
  id         TEXT PRIMARY KEY,
  action     TEXT NOT NULL,
  email      TEXT NOT NULL,
  actor      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_access_audit_created ON admin_access_audit (created_at DESC);
