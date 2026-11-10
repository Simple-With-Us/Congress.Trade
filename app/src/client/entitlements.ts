/**
 * src/client/entitlements.ts
 *
 * `POST /api/client/v1/entitlements/apple/redeem` — the anonymous half of
 * Apple In-App Purchase redemption (Guideline 5.1.1(v): an app may not
 * require account registration before letting someone buy an In-App
 * Purchase that is not itself account-based; PDF/CSV access is content, not
 * account-specific functionality).
 *
 * Deliberately OUTSIDE the `requireUser`-gated `POST /commands` pipeline —
 * this route takes no session at all. It reuses the exact same JWS
 * chain-verification, bundle-id check, Sandbox policy, and product mapping as
 * the authenticated `redeem_apple_purchase` command
 * (`billing/appleRedeem.ts`); the only thing that differs is who ends up
 * owning the resulting `apple_subscriptions` ledger row: `null` here, a real
 * `userId` there. A device that redeems here gets a short-lived, HMAC-signed
 * device entitlement token (`billing/deviceEntitlement.ts`) it presents on
 * PDF/CSV requests instead of a session — see `delivery/rest.ts`.
 *
 * This is the money path: every response either comes from a chain-verified
 * Apple transaction or is a refusal. Nothing here trusts a client-supplied
 * boolean, plan, or product id.
 */

import type { Context } from 'hono';
import type { Env } from '../shared/types.ts';
import { AppleRedeemError, jwsFromInput, requireAppleIapEnabled, verifyAppleRedemption } from '../billing/appleRedeem.ts';
import { clientRedeemWouldResurrectRevoked, getAppleSubscription, upsertAppleSubscription } from '../billing/appleSubscriptions.ts';
import { issueDeviceEntitlementToken } from '../billing/deviceEntitlement.ts';
import { rateLimit, clientIp } from '../shared/rateLimit.ts';

/**
 * Per-IP: guards the cost of JWS chain verification against a flood of
 * garbage transactions before we even know if any of them are real.
 * Per-originalTransactionId: guards the ledger/token-issuance path itself
 * once a transaction is known-valid — generous enough for a legitimate
 * restore-purchases sweep across a few devices, tight enough to blunt
 * scripted hammering of one transaction id.
 */
const IP_LIMIT = 20;
const IP_WINDOW_SEC = 300;
const TXN_LIMIT = 20;
const TXN_WINDOW_SEC = 3600;

export async function redeemAppleEntitlementAnonymously(c: Context<{ Bindings: Env }>) {
  try {
    await requireAppleIapEnabled(c.env);
  } catch (err) {
    return errorResponse(c, err);
  }

  const ip = clientIp(c.req.raw);
  const ipLimited = await rateLimit(c.env, 'apple-anon-redeem-ip', ip, IP_LIMIT, IP_WINDOW_SEC);
  if (!ipLimited.ok) {
    return c.json({ error: 'too many redeem attempts' }, 429, { 'Retry-After': String(ipLimited.retryAfterSec) });
  }

  let body: Record<string, unknown>;
  try {
    const raw = await c.req.text();
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  let verified;
  try {
    verified = await verifyAppleRedemption(c.env, jwsFromInput(body));
  } catch (err) {
    return errorResponse(c, err);
  }
  const { transaction, plan, originalTransactionId } = verified;

  // Count every presentation of this JWS BEFORE any early-exit check:
  // replaying a stored JWS after REFUND/REVOKE exits 400 below and would
  // otherwise be free to retry forever, while iOS keeps the transaction
  // unfinished and redelivers it indefinitely.
  const txnLimited = await rateLimit(c.env, 'apple-anon-redeem-txn', originalTransactionId, TXN_LIMIT, TXN_WINDOW_SEC);
  if (!txnLimited.ok) {
    return c.json({ error: 'too many redeem attempts for this transaction' }, 429, {
      'Retry-After': String(txnLimited.retryAfterSec),
    });
  }

  const existing = await getAppleSubscription(c.env, originalTransactionId);
  if (
    clientRedeemWouldResurrectRevoked(existing, {
      transactionId: transaction.transactionId,
      purchaseDateMs: transaction.purchaseDate != null ? Number(transaction.purchaseDate) : null,
    })
  ) {
    return c.json({ error: 'this Apple subscription was refunded or revoked' }, 400);
  }

  // userId: null — the defining move of this route. upsertAppleSubscription's
  // owner-mismatch guard does the rest: a row already owned by a real account
  // refuses (409) rather than silently granting this anonymous caller (or
  // anyone else who replays the same JWS) that account's Premium; an
  // unowned or not-yet-existing row accepts, idempotently.
  const upserted = await upsertAppleSubscription(c.env, {
    originalTransactionId,
    userId: null,
    productId: transaction.productId ?? '',
    plan,
    status: 'active',
    environment: transaction.environment ?? null,
    latestTransactionId: transaction.transactionId ?? null,
    purchaseDate: transaction.purchaseDate != null ? new Date(Number(transaction.purchaseDate)).toISOString() : null,
    expiresDate: transaction.expiresDate != null ? new Date(Number(transaction.expiresDate)).toISOString() : null,
    redeemGuard: true,
  });
  if (!upserted.ok) {
    if (upserted.reason === 'guarded_status') {
      return c.json({ error: 'this Apple subscription was refunded or revoked' }, 400);
    }
    return c.json(
      { error: 'this Apple subscription is already linked to a different account', upgradeRequired: false },
      409,
    );
  }

  const deviceEntitlementToken = await issueDeviceEntitlementToken(
    c.env,
    upserted.record.originalTransactionId,
    upserted.record.expiresDate,
  );

  return c.json({
    entitlement: {
      premium: true,
      status: 'active',
      plan: upserted.record.plan,
      trialing: false,
      trialEnd: null,
      currentPeriodEnd: upserted.record.expiresDate,
      cancelAtPeriodEnd: upserted.record.autoRenewStatus === false,
      source: 'apple_anonymous',
    },
    plan: upserted.record.plan,
    expiresAt: upserted.record.expiresDate,
    originalTransactionId: upserted.record.originalTransactionId,
    deviceEntitlementToken,
  });
}

/** {@link AppleRedeemError} only ever carries 400 (verification/policy failures) or 503 (IAP not enabled yet). */
function appleRedeemStatus(status: number): 400 | 503 {
  return status === 503 ? 503 : 400;
}

function errorResponse(c: Context<{ Bindings: Env }>, err: unknown) {
  if (err instanceof AppleRedeemError) {
    return c.json({ error: err.message }, appleRedeemStatus(err.status));
  }
  console.error('anonymous apple redeem failed:', err instanceof Error ? err.message : String(err));
  return c.json({ error: 'redeem failed' }, 500);
}
