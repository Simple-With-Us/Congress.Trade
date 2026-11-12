/**
 * Durable App Store Server Notifications V2 webhook event ledger. Mirrors
 * billing/webhookEvents.ts's claim/release/processed pattern exactly (same
 * at-least-once-delivery-safe shape as the Stripe webhook), against its own
 * `apple_webhook_events` table (migration 0081) so a duplicate Apple
 * notification redelivery can never double-apply a subscription state
 * change.
 */

import type { Env } from '../shared/types.ts';
import { get, run } from '../shared/db.ts';

const DEFAULT_CLAIM_LEASE_SECONDS = 60;

export type AppleWebhookClaimResult =
  | { status: 'claimed'; claimToken: string }
  | { status: 'duplicate' }
  | { status: 'busy' };

export interface AppleWebhookClaimOptions {
  now?: Date;
  leaseSeconds?: number;
  claimToken?: string;
}

interface AppleWebhookEventRow {
  processed_at: string | null;
}

export async function claimAppleWebhookEvent(
  env: Env,
  eventId: string,
  eventType: string,
  options: AppleWebhookClaimOptions = {},
): Promise<AppleWebhookClaimResult> {
  const now = options.now ?? new Date();
  const leaseSeconds = Math.max(1, Math.floor(options.leaseSeconds ?? DEFAULT_CLAIM_LEASE_SECONDS));
  const claimToken = options.claimToken ?? crypto.randomUUID();
  const receivedAt = now.toISOString();
  const claimExpiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
  const inserted = await run(
    env.DB,
    `INSERT OR IGNORE INTO apple_webhook_events (
       event_id, event_type, received_at, claim_token, claim_expires_at
     ) VALUES (?, ?, ?, ?, ?)`,
    [eventId, eventType, receivedAt, claimToken, claimExpiresAt],
  );
  if ((inserted.meta?.changes ?? 0) > 0) return { status: 'claimed', claimToken };

  const reclaimed = await run(
    env.DB,
    `UPDATE apple_webhook_events
        SET event_type = ?, claim_token = ?, claim_expires_at = ?
      WHERE event_id = ?
        AND processed_at IS NULL
        AND (claim_token IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)`,
    [eventType, claimToken, claimExpiresAt, eventId, receivedAt],
  );
  if ((reclaimed.meta?.changes ?? 0) > 0) return { status: 'claimed', claimToken };

  const existing = await get<AppleWebhookEventRow>(
    env.DB,
    'SELECT processed_at FROM apple_webhook_events WHERE event_id = ?',
    [eventId],
  );
  return existing?.processed_at ? { status: 'duplicate' } : { status: 'busy' };
}

export async function markAppleWebhookEventProcessed(
  env: Env,
  eventId: string,
  claimToken: string,
  processedAt = new Date().toISOString(),
): Promise<boolean> {
  const res = await run(
    env.DB,
    `UPDATE apple_webhook_events
        SET processed_at = ?, claim_token = NULL, claim_expires_at = NULL
      WHERE event_id = ? AND claim_token = ? AND processed_at IS NULL`,
    [processedAt, eventId, claimToken],
  );
  return (res.meta?.changes ?? 0) > 0;
}

export async function releaseAppleWebhookEvent(
  env: Env,
  eventId: string,
  claimToken: string,
): Promise<boolean> {
  const res = await run(
    env.DB,
    `UPDATE apple_webhook_events
        SET claim_token = NULL, claim_expires_at = NULL
      WHERE event_id = ? AND claim_token = ? AND processed_at IS NULL`,
    [eventId, claimToken],
  );
  return (res.meta?.changes ?? 0) > 0;
}
