-- Account-owned push device tokens (APNs now; web push later).
-- Separate from webhook/SSE subscriptions so device registration does not
-- consume the MAX_SUBSCRIPTIONS_PER_USER delivery quota.
CREATE TABLE IF NOT EXISTS push_devices (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  platform   TEXT NOT NULL,
  token      TEXT NOT NULL,
  app_bundle TEXT,
  env        TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_push_devices_user_platform_token
  ON push_devices (user_id, platform, token);

CREATE INDEX IF NOT EXISTS idx_push_devices_user_active
  ON push_devices (user_id, active);

CREATE INDEX IF NOT EXISTS idx_push_devices_platform_active
  ON push_devices (platform, active);
