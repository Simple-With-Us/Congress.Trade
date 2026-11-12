/**
 * src/billing/appleWebhook.ts
 * App Store Server Notifications V2 sink (mounted at /api/webhooks/apple).
 *
 *   POST /api/webhooks/apple  -> { receivedAt } : Apple event sink
 *
 * Apple POSTs `{ signedPayload }` — an ES256 x5c JWS decoding to a
 * `ResponseBodyV2DecodedPayload`. That payload's own `data.signedTransactionInfo`
 * (and, for renewal-status events, `data.signedRenewalInfo`) are THEMSELVES
 * independently signed JWS, each with their own x5c chain — every layer is
 * verified against the pinned Apple root before any field is trusted.
 *
 * Handles the minimal notification set: DID_RENEW, EXPIRED,
 * DID_CHANGE_RENEWAL_STATUS, REVOKE, REFUND, DID_FAIL_TO_RENEW, GRACE_PERIOD_EXPIRED.
 * REFUND/REVOKE with no existing ledger row insert a null-owner tombstone so a
 * later client redeem of the original StoreKit JWS cannot mint Premium (#2088
 * only works once a revoked row exists). Other types still ignore unknown ids.
 * A revoked row is not overwritten by a stale pre-refund retry of any other
 * handled type — upsert would otherwise clear revokedAt and, for EXPIRED /
 * billing_retry, drop status off 'revoked' so redeem/confirm would re-grant.
 * DID_CHANGE_RENEWAL_STATUS never advances purchase identity or clears
 * revokedAt: a resubscribe's AUTO_RENEW_ENABLED carries the new
 * transactionId, and writing that id (or nulling revokedAt) makes
 * clientRedeemWouldResurrectRevoked treat the later Restore as a replay.
 * Idempotent on Apple's `notificationUUID`
 * via the same claim/release/processed ledger pattern the Stripe webhook uses
 * (appleWebhookEvents.ts), so an at-least-once redelivery never double-applies
 * a subscription state change.
 */

import { Hono } from 'hono';
import type { Env } from '../shared/types.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { verifyAppleSignedJws, AppleJwsVerificationError } from './appleJws.ts';
import {
  appleSandboxPurchasesAllowed,
  isAppleSandboxEnvironment,
  planFromConfiguredAppleProductId,
  resolveAppleProductIds,
  type AppleTransactionPayload,
} from './apple.ts';
import {
  clientRedeemWouldResurrectRevoked,
  getAppleSubscription,
  upsertAppleSubscription,
} from './appleSubscriptions.ts';
import {
  claimAppleWebhookEvent,
  markAppleWebhookEventProcessed,
  releaseAppleWebhookEvent,
} from './appleWebhookEvents.ts';

interface AppleRenewalInfoPayload {
  originalTransactionId?: string;
  autoRenewProductId?: string;
  autoRenewStatus?: number; // 0 | 1
  expirationIntent?: number;
  /** Milliseconds since epoch.  Present while Apple is in Billing Grace Period. */
  gracePeriodExpiresDate?: number;
  isInBillingRetryPeriod?: boolean;
}

interface AppleNotificationDataPayload {
  bundleId?: string;
  environment?: string;
  signedTransactionInfo?: string;
  signedRenewalInfo?: string;
}

interface AppleServerNotificationV2Payload {
  notificationType?: string;
  subtype?: string;
  notificationUUID?: string;
  data?: AppleNotificationDataPayload;
}

const HANDLED_NOTIFICATION_TYPES = new Set([
  'DID_RENEW',
  'EXPIRED',
  'DID_CHANGE_RENEWAL_STATUS',
  'REVOKE',
  'REFUND',
  'DID_FAIL_TO_RENEW',
  'GRACE_PERIOD_EXPIRED',
]);

const ACCESS_ENDING_NOTIFICATION_TYPES = new Set(['REVOKE', 'REFUND', 'EXPIRED']);

export function buildAppleWebhookRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  r.post('/apple', async (c) => {
    const enabled = (await resolveSecret(c.env, 'APPLE_IAP_ENABLED')).value === 'true';
    if (!enabled) return c.json({ error: 'Apple IAP is not enabled' }, 503);

    let body: { signedPayload?: unknown };
    try {
      body = (await c.req.json()) as { signedPayload?: unknown };
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const signedPayload = typeof body.signedPayload === 'string' ? body.signedPayload : '';
    if (!signedPayload) return c.json({ error: 'signedPayload required' }, 400);

    let notification: AppleServerNotificationV2Payload;
    try {
      notification = await verifyAppleSignedJws<AppleServerNotificationV2Payload>(signedPayload);
    } catch (err) {
      const message = err instanceof AppleJwsVerificationError ? err.message : 'invalid Apple notification';
      console.warn('apple webhook rejected:', message);
      return c.json({ error: message }, 400);
    }

    const notificationUUID = notification.notificationUUID;
    const notificationType = notification.notificationType ?? 'UNKNOWN';
    if (!notificationUUID) return c.json({ error: 'missing notificationUUID' }, 400);

    let claimToken: string | null = null;
    try {
      const claim = await claimAppleWebhookEvent(c.env, notificationUUID, notificationType);
      if (claim.status === 'duplicate') return c.json({ received: true, duplicate: true });
      if (claim.status === 'busy') {
        return c.json({ error: 'notification is already being processed' }, 503, { 'Retry-After': '5' });
      }
      claimToken = claim.claimToken;

      if (HANDLED_NOTIFICATION_TYPES.has(notificationType)) {
        await applyNotification(c.env, notificationType, notification);
      }
      // Unhandled types (SUBSCRIBED, PRICE_INCREASE, ...) are acknowledged
      // but not applied. REFUND is applied like REVOKE. DID_FAIL_TO_RENEW and
      // GRACE_PERIOD_EXPIRED keep Premium live for the configured window.

      if (!(await markAppleWebhookEventProcessed(c.env, notificationUUID, claimToken))) {
        throw new Error('webhook claim was lost before completion');
      }
    } catch (err) {
      if (claimToken) {
        try {
          await releaseAppleWebhookEvent(c.env, notificationUUID, claimToken);
        } catch (releaseErr) {
          console.error('apple webhook idempotency release failed:', (releaseErr as Error).message);
        }
      }
      console.error('apple webhook handling error:', (err as Error).message);
      return c.json({ error: 'webhook handling failed' }, 500);
    }
    return c.json({ received: true });
  });

  return r;
}

async function applyNotification(
  env: Env,
  notificationType: string,
  notification: AppleServerNotificationV2Payload,
): Promise<void> {
  const signedTransactionInfo = notification.data?.signedTransactionInfo;
  if (!signedTransactionInfo) {
    console.warn(`apple webhook ${notificationType}: missing signedTransactionInfo, skipping`);
    return;
  }
  let transaction: AppleTransactionPayload;
  try {
    transaction = await verifyAppleSignedJws<AppleTransactionPayload>(signedTransactionInfo);
  } catch (err) {
    console.warn(`apple webhook ${notificationType}: invalid signedTransactionInfo:`, (err as Error).message);
    return;
  }

  const expectedBundle = (await resolveSecret(env, 'APPLE_BUNDLE_ID')).value?.trim() || 'trade.congress.ios';
  if (transaction.bundleId && transaction.bundleId !== expectedBundle) {
    console.warn(`apple webhook ${notificationType}: bundleId mismatch, ignoring`);
    return;
  }

  const sandbox = isAppleSandboxEnvironment(notification.data?.environment)
    || isAppleSandboxEnvironment(transaction.environment);
  if (sandbox && !ACCESS_ENDING_NOTIFICATION_TYPES.has(notificationType)
    && !(await appleSandboxPurchasesAllowed(env))) {
    console.warn(`apple webhook ${notificationType}: Sandbox environment rejected (APPLE_ALLOW_SANDBOX is false)`);
    return;
  }

  const originalTransactionId = transaction.originalTransactionId || transaction.transactionId;
  if (!originalTransactionId) return;

  // Owner is established by redeem/link, never by the webhook. ACCESS-ENDING
  // notifications are the exception to "ignore if no row": after #2087 a
  // client can redeem later with the original StoreKit JWS (no revocationDate),
  // so a REFUND/REVOKE that arrived first must leave a null-owner tombstone
  // or #2088's replay guard never sees a revoked row.
  const existing = await getAppleSubscription(env, originalTransactionId);
  const writeRefundTombstone = !existing && (notificationType === 'REVOKE' || notificationType === 'REFUND');
  if (!existing && !writeRefundTombstone) {
    console.warn(
      `apple webhook ${notificationType}: no ledger row yet (redeem has not run) — ignoring`,
    );
    return;
  }

  let renewalInfo: AppleRenewalInfoPayload | null = null;
  if (notification.data?.signedRenewalInfo) {
    try {
      renewalInfo = await verifyAppleSignedJws<AppleRenewalInfoPayload>(notification.data.signedRenewalInfo);
    } catch (err) {
      console.warn(`apple webhook ${notificationType}: invalid signedRenewalInfo:`, (err as Error).message);
    }
  }

  const configuredProducts = await resolveAppleProductIds(env);
  const plan = planFromConfiguredAppleProductId(transaction.productId, configuredProducts) ?? existing?.plan;
  if (!plan) {
    console.warn(`apple webhook ${notificationType}: unrecognized product id and no existing plan, skipping`);
    return;
  }
  const expiresDate =
    transaction.expiresDate != null ? new Date(Number(transaction.expiresDate)).toISOString() : existing?.expiresDate ?? null;

  const base = {
    originalTransactionId,
    userId: existing?.userId ?? null,
    productId: transaction.productId ?? existing?.productId ?? '',
    plan,
    environment: transaction.environment ?? existing?.environment ?? null,
    latestTransactionId: transaction.transactionId ?? existing?.latestTransactionId ?? null,
    purchaseDate:
      transaction.purchaseDate != null ? new Date(Number(transaction.purchaseDate)).toISOString() : existing?.purchaseDate ?? null,
    expiresDate,
    autoRenewStatus:
      renewalInfo?.autoRenewStatus != null ? renewalInfo.autoRenewStatus === 1 : existing?.autoRenewStatus ?? null,
    autoRenewProductId: renewalInfo?.autoRenewProductId ?? existing?.autoRenewProductId ?? null,
    lastNotificationType: notificationType,
    lastNotificationSubtype: notification.subtype ?? null,
  };

  // Same newer-purchase rule as redeem/confirm. Apple retries each
  // notificationUUID independently, so EXPIRED / DID_FAIL_TO_RENEW /
  // DID_CHANGE_RENEWAL_STATUS / DID_RENEW that 500'd (or was still in
  // flight) can land AFTER REFUND/REVOKE. upsert writes revokedAt=null
  // unless the caller passes it, and EXPIRED / billing_retry move status
  // off 'revoked' — after which clientRedeemWouldResurrectRevoked no
  // longer fires and a StoreKit restore of the original JWS re-grants
  // Premium. A genuine resubscribe has a new transactionId and a
  // purchaseDate after revokedAt.
  const staleRevokedReplay = clientRedeemWouldResurrectRevoked(existing, {
    transactionId: transaction.transactionId,
    purchaseDateMs: transaction.purchaseDate != null ? Number(transaction.purchaseDate) : null,
  });
  if (staleRevokedReplay && notificationType !== 'REVOKE' && notificationType !== 'REFUND') {
    console.warn(
      `apple webhook ${notificationType}: refusing to overwrite revoked row from a pre-refund retry`,
    );
    return;
  }

  if (notificationType === 'DID_RENEW') {
    await upsertAppleSubscription(env, { ...base, status: 'active', revokedAt: null, revocationReason: null });
    return;
  }
  if (notificationType === 'EXPIRED') {
    await upsertAppleSubscription(env, { ...base, status: 'expired' });
    return;
  }
  if (notificationType === 'REVOKE' || notificationType === 'REFUND') {
    await upsertAppleSubscription(env, {
      ...base,
      status: 'revoked',
      revokedAt: new Date().toISOString(),
      revocationReason: transaction.revocationReason ?? null,
    });
    return;
  }
  if (!existing) return;
  if (notificationType === 'DID_CHANGE_RENEWAL_STATUS') {
    // Entitlement is unaffected by this event alone — only the renewal-info
    // fields change. Keep access status, revokedAt, and the purchase
    // identity as-is. A resubscribe's AUTO_RENEW_ENABLED is a newer
    // transactionId; writing it (or defaulting revokedAt to null) makes
    // clientRedeemWouldResurrectRevoked fail the newer-purchase check
    // (same id, or purchaseDate > NaN) and bricks Restore / DID_RENEW.
    await upsertAppleSubscription(env, {
      ...base,
      status: existing.status,
      latestTransactionId: existing.latestTransactionId,
      purchaseDate: existing.purchaseDate,
      revokedAt: existing.revokedAt,
      revocationReason: existing.revocationReason,
    });
    return;
  }
  if (notificationType === 'DID_FAIL_TO_RENEW') {
    const graceMs = renewalInfo?.gracePeriodExpiresDate != null
      ? Number(renewalInfo.gracePeriodExpiresDate)
      : NaN;
    const graceStillOpen = Number.isFinite(graceMs) && graceMs > Date.now();
    const appleSaysGrace = notification.subtype === 'GRACE_PERIOD' || graceStillOpen;
    if (appleSaysGrace) {
      const graceExpires = graceStillOpen
        ? new Date(graceMs).toISOString()
        : existing.expiresDate;
      await upsertAppleSubscription(env, {
        ...base,
        status: 'grace_period',
        expiresDate: graceExpires ?? base.expiresDate,
      });
      return;
    }
    await upsertAppleSubscription(env, {
      ...base,
      status: renewalInfo?.isInBillingRetryPeriod ? 'billing_retry' : 'expired',
    });
    return;
  }
  if (notificationType === 'GRACE_PERIOD_EXPIRED') {
    await upsertAppleSubscription(env, {
      ...base,
      status: renewalInfo?.isInBillingRetryPeriod ? 'billing_retry' : 'expired',
    });
  }
}
