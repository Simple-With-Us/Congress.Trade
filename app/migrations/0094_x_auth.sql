-- 0090_x_auth.sql
-- Sign in with X (Twitter): link a user to their stable X `sub` / user ID.

ALTER TABLE users ADD COLUMN x_sub TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_x_sub
  ON users (x_sub)
  WHERE x_sub IS NOT NULL;
