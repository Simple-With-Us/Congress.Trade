-- 0093_premium_activation_alerts.sql
-- Idempotency ledger for the "someone became Premium" Pushover notification
-- (src/billing/premiumActivationAlert.ts).  Keyed on a stable activation id --
-- the Stripe subscription id (`sub_...`) or `apple:<originalTransactionId>` --
-- so a redelivered webhook, or a trial->paid / renewal update on the SAME
-- subscription, never re-fires the notification: only the first INSERT for a
-- given activation_key wins (INSERT OR IGNORE), and only that caller sends.
--
-- Two indexes on `users`/`apple_subscriptions` back the totals aggregate the
-- notification message reports (total Premium accounts + how many on trial)
-- so that query stays a cheap indexed lookup, not a full table scan, every
-- time a new subscriber fires it.

CREATE TABLE IF NOT EXISTS premium_activation_notices (
  activation_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  notified_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_premium_status
  ON users (subscription_status, plan);

CREATE INDEX IF NOT EXISTS idx_apple_subscriptions_status_expires
  ON apple_subscriptions (status, expires_date);
