-- 0091_apple_subscriptions_nullable_user.sql
-- Guideline 5.1.1(v) fix: Apple rejected submission b61e2a4a because the app
-- required account registration before purchasing an In-App Purchase that is
-- not itself account-based (PDF / CSV export are content, not per-account
-- functionality). The fix lets a device buy Premium anonymously via
-- POST /api/client/v1/entitlements/apple/redeem, which records the purchase
-- in apple_subscriptions with NO owning account — so user_id must accept
-- NULL. SQLite cannot ALTER COLUMN to drop a NOT NULL constraint, so this is
-- a table rebuild: copy → drop → rename, same shape as 0081_apple_iap.sql
-- otherwise, with user_id's NOT NULL dropped.
--
-- A null-owner row is claimable by the first authenticated account that
-- later presents the same verified Apple transaction (`link_apple_entitlement`
-- / `redeem_apple_purchase` — see billing/appleSubscriptions.ts
-- upsertAppleSubscription's owner-mismatch guard); a row already owned by a
-- real account is never reassigned by this migration or by that guard.

CREATE TABLE IF NOT EXISTS apple_subscriptions_new (
  original_transaction_id   TEXT PRIMARY KEY,
  user_id                   TEXT,
  product_id                TEXT NOT NULL,
  plan                      TEXT NOT NULL CHECK (plan IN ('monthly', 'annual')),
  status                    TEXT NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'expired', 'revoked', 'grace_period', 'billing_retry')),
  environment               TEXT,
  latest_transaction_id     TEXT,
  purchase_date              TEXT,
  expires_date               TEXT,
  auto_renew_status          INTEGER,
  auto_renew_product_id      TEXT,
  revoked_at                 TEXT,
  revocation_reason          INTEGER,
  last_notification_type     TEXT,
  last_notification_subtype  TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);

INSERT INTO apple_subscriptions_new SELECT * FROM apple_subscriptions;

DROP TABLE apple_subscriptions;

ALTER TABLE apple_subscriptions_new RENAME TO apple_subscriptions;

CREATE INDEX IF NOT EXISTS idx_apple_subscriptions_user
  ON apple_subscriptions (user_id);

CREATE INDEX IF NOT EXISTS idx_apple_subscriptions_user_active
  ON apple_subscriptions (user_id, status, expires_date);
