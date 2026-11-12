-- 0074_lower_subscription_quota.sql
-- Lowers the subscription creation quota from 20 to 2 per user.

DROP TRIGGER IF EXISTS trg_subscriptions_total_quota;

CREATE TRIGGER IF NOT EXISTS trg_subscriptions_total_quota
BEFORE INSERT ON subscriptions
WHEN (
  SELECT COUNT(*) FROM subscriptions
   WHERE client_id = NEW.client_id AND active = 1
) >= 2
BEGIN
  SELECT RAISE(ABORT, 'subscription total quota exceeded');
END;

DROP TRIGGER IF EXISTS trg_subscriptions_active_insert_quota;

CREATE TRIGGER IF NOT EXISTS trg_subscriptions_active_insert_quota
BEFORE INSERT ON subscriptions
WHEN NEW.active = 1 AND (
  SELECT COUNT(*) FROM subscriptions WHERE client_id = NEW.client_id AND active = 1
) >= 2
BEGIN
  SELECT RAISE(ABORT, 'subscription active quota exceeded');
END;

DROP TRIGGER IF EXISTS trg_subscriptions_active_update_quota;

CREATE TRIGGER IF NOT EXISTS trg_subscriptions_active_update_quota
BEFORE UPDATE OF active, client_id ON subscriptions
WHEN NEW.active = 1 AND (OLD.active != 1 OR OLD.client_id != NEW.client_id) AND (
  SELECT COUNT(*) FROM subscriptions WHERE client_id = NEW.client_id AND active = 1 AND id != OLD.id
) >= 2
BEGIN
  SELECT RAISE(ABORT, 'subscription active quota exceeded');
END;
