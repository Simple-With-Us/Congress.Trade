-- 0081_apple_iap.sql
-- Apple In-App Purchase (StoreKit 2) subscription ledger + App Store Server
-- Notifications V2 webhook idempotency ledger.
--
-- apple_subscriptions is the source of truth for Apple-purchased Premium,
-- keyed by Apple's stable `originalTransactionId` (constant across renewals
-- of the same subscription). Entitlement resolution ORs this with the
-- existing Stripe-derived `users` columns (see billing/entitlement.ts
-- resolveEntitlementAsync) — independent of, and not a replacement for, the
-- Stripe-shaped `users` columns the legacy POST /billing/apple/confirm route
-- also writes for backward compatibility with already-shipped iOS builds.
--
-- apple_webhook_events mirrors stripe_webhook_events' claim/release/processed
-- idempotency ledger (migrations 0022 + the claim_token/claim_expires_at
-- columns added alongside STRIPE_EVENT_SCHEMA_STATEMENTS) so App Store Server
-- Notifications get the same at-least-once-delivery-safe handling Stripe's
-- webhook already has.

CREATE TABLE IF NOT EXISTS apple_subscriptions (
  original_transaction_id   TEXT PRIMARY KEY,
  user_id                   TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_apple_subscriptions_user
  ON apple_subscriptions (user_id);

CREATE INDEX IF NOT EXISTS idx_apple_subscriptions_user_active
  ON apple_subscriptions (user_id, status, expires_date);

CREATE TABLE IF NOT EXISTS apple_webhook_events (
  event_id          TEXT PRIMARY KEY,
  event_type        TEXT NOT NULL,
  received_at       TEXT NOT NULL,
  processed_at      TEXT,
  claim_token       TEXT,
  claim_expires_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_apple_webhook_events_received
  ON apple_webhook_events (received_at DESC);

CREATE INDEX IF NOT EXISTS idx_apple_webhook_events_claim_expiry
  ON apple_webhook_events (processed_at, claim_expires_at);
