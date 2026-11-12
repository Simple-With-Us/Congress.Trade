-- 0080_apple_signin.sql
-- Sign in with Apple: link a user to their stable Apple `sub` claim.
-- Nullable + partial-unique so existing Google/magic-link users are
-- unaffected until they link Apple; SQLite's partial UNIQUE index allows any
-- number of NULLs while still enforcing uniqueness on the non-NULL values.

ALTER TABLE users ADD COLUMN apple_sub TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_sub
  ON users (apple_sub)
  WHERE apple_sub IS NOT NULL;
