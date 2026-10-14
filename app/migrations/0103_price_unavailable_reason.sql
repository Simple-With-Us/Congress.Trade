-- 0103_price_unavailable_reason.sql
-- Human-readable reason when a ticker is negative-cached as unpriceable.

ALTER TABLE securities_ref ADD COLUMN price_unavailable_reason TEXT;
