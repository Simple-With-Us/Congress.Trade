/**
 * src/billing/appleSubscriptions.ts
 *
 * D1 helpers for the `apple_subscriptions` ledger (migration 0081) — the
 * source of truth for Apple-purchased Premium, independent of the
 * Stripe-shaped `users` columns. Keyed by Apple's `originalTransactionId`,
 * which stays constant across renewals of the same subscription (StoreKit 2
 * `Transaction.originalID`); upserts here are what make both the
 * `redeem_apple_purchase` command and the App Store Server Notifications
 * webhook idempotent on that id.
 *
 * `userId` is nullable (migration 00NN_apple_subscriptions_nullable_user —
 * see that file for why): a purchase made signed OUT (Guideline 5.1.1(v),
 * `POST /api/client/v1/entitlements/apple/redeem`) writes a row with
 * `userId: null`, granting Premium to the DEVICE via a separately-issued
 * entitlement token (`billing/deviceEntitlement.ts`), not to any account. The
 * row is claimable by the first account that later presents the same
 * verified transaction (`link_apple_entitlement`) — see the owner-mismatch
 * guard in `upsertAppleSubscription` below.
 */

import type { ApplePlan } from './apple.ts';
import type { Env } from '../shared/types.ts';
import { get, run } from '../shared/db.ts';

export type AppleSubscriptionStatus = 'active' | 'expired' | 'revoked' | 'grace_period' | 'billing_retry';

export interface AppleSubscriptionRecord {
  originalTransactionId: string;
  /** null = anonymous device purchase, not yet (or never) claimed by an account. */
  userId: string | null;
  productId: string;
  plan: ApplePlan;
  status: AppleSubscriptionStatus;
  environment: string | null;
  latestTransactionId: string | null;
  purchaseDate: string | null;
  expiresDate: string | null;
  autoRenewStatus: boolean | null;
  autoRenewProductId: string | null;
  revokedAt: string | null;
  revocationReason: number | null;
  lastNotificationType: string | null;
  lastNotificationSubtype: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AppleSubscriptionRow {
  original_transaction_id: string;
  user_id: string | null;
  product_id: string;
  plan: string;
  status: string;
  environment: string | null;
  latest_transaction_id: string | null;
  purchase_date: string | null;
  expires_date: string | null;
  auto_renew_status: number | null;
  auto_renew_product_id: string | null;
  revoked_at: string | null;
  revocation_reason: number | null;
  last_notification_type: string | null;
  last_notification_subtype: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(r: AppleSubscriptionRow): AppleSubscriptionRecord {
  return {
    originalTransactionId: r.original_transaction_id,
    userId: r.user_id,
    productId: r.product_id,
    plan: r.plan as ApplePlan,
    status: r.status as AppleSubscriptionStatus,
    environment: r.environment,
    latestTransactionId: r.latest_transaction_id,
    purchaseDate: r.purchase_date,
    expiresDate: r.expires_date,
    autoRenewStatus: r.auto_renew_status == null ? null : r.auto_renew_status === 1,
    autoRenewProductId: r.auto_renew_product_id,
    revokedAt: r.revoked_at,
    revocationReason: r.revocation_reason,
    lastNotificationType: r.last_notification_type,
    lastNotificationSubtype: r.last_notification_subtype,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** True when `status` is a state that currently grants Premium access. */
export function appleStatusGrantsAccess(status: AppleSubscriptionStatus): boolean {
  return status === 'active' || status === 'grace_period';
}

/**
 * Client redeem/restore presents the original StoreKit JWS, which usually
 * has no `revocationDate` even after Apple's REFUND/REVOKE webhook has
 * already marked the ledger revoked. Replaying that JWS must not flip
 * `status` back to `active`. A later purchase on the same
 * `originalTransactionId` (new `transactionId` and `purchaseDate` after
 * `revokedAt`) is allowed so a genuine resubscribe can restore without
 * waiting for DID_RENEW. The same holds for a lapsed ledger row
 * (`expired` / `billing_retry`): replaying the purchase-time JWS must not
 * resurrect a subscription Apple already considers dead — otherwise one
 * stored JWS re-grants Premium forever. A lapse is anchored at the
 * recorded `expiresDate` rather than `revokedAt`. Legacy lapsed rows can
 * lack either date; use their persisted last-observed timestamp in that case.
 * A different transaction id alone is not proof of a new purchase: a historic
 * signed transaction could also differ from the latest ledger id.
 */
const REDEEM_GUARDED_STATUSES: ReadonlySet<AppleSubscriptionRecord['status']> = new Set([
  'revoked',
  'expired',
  'billing_retry',
]);

export function clientRedeemWouldResurrectRevoked(
  existing: AppleSubscriptionRecord | null,
  incoming: { transactionId?: string | null; purchaseDateMs?: number | null },
): boolean {
  if (!existing || !REDEEM_GUARDED_STATUSES.has(existing.status)) return false;
  const incomingTxn = incoming.transactionId ?? '';
  const existingTxn = existing.latestTransactionId ?? '';
  const purchaseMs = incoming.purchaseDateMs ?? Number.NaN;
  const anchorMs = existing.revokedAt
    ? Date.parse(existing.revokedAt)
    : Date.parse(existing.expiresDate ?? (
      existing.status === 'expired' || existing.status === 'billing_retry'
        ? existing.updatedAt
        : ''
    ));
  const isNewerPurchase =
    incomingTxn.length > 0 &&
    incomingTxn !== existingTxn &&
    Number.isFinite(purchaseMs) &&
    Number.isFinite(anchorMs) &&
    purchaseMs > anchorMs;
  return !isNewerPurchase;
}

export async function getAppleSubscription(
  env: Env,
  originalTransactionId: string,
): Promise<AppleSubscriptionRecord | null> {
  const row = await get<AppleSubscriptionRow>(
    env.DB,
    'SELECT * FROM apple_subscriptions WHERE original_transaction_id = ?',
    [originalTransactionId],
  );
  return row ? mapRow(row) : null;
}

/**
 * The subscription (if any) that currently grants this user Premium access:
 * status active/grace_period AND not past its expiry. A user may in theory
 * have redeemed more than one Apple subscription over time (e.g. switched
 * plans by cancelling and resubscribing under a new originalTransactionId);
 * the most recently updated qualifying row wins.
 */
export async function activeAppleSubscriptionForUser(
  env: Env,
  userId: string,
  nowIso: string = new Date().toISOString(),
): Promise<AppleSubscriptionRecord | null> {
  const row = await get<AppleSubscriptionRow>(
    env.DB,
    `SELECT * FROM apple_subscriptions
      WHERE user_id = ?
        AND status IN ('active', 'grace_period')
        AND (expires_date IS NULL OR expires_date > ?)
      ORDER BY updated_at DESC
      LIMIT 1`,
    [userId, nowIso],
  );
  return row ? mapRow(row) : null;
}

export interface UpsertAppleSubscriptionInput {
  originalTransactionId: string;
  /** null = anonymous device purchase (no Congress.Trade account). */
  userId: string | null;
  productId: string;
  plan: ApplePlan;
  status: AppleSubscriptionStatus;
  environment?: string | null;
  latestTransactionId?: string | null;
  purchaseDate?: string | null;
  expiresDate?: string | null;
  autoRenewStatus?: boolean | null;
  autoRenewProductId?: string | null;
  revokedAt?: string | null;
  revocationReason?: number | null;
  /**
   * Client redeem paths only: enforce the resurrect guard inside the
   * UPSERT's own WHERE so a REFUND/REVOKE (or lapse) webhook landing after
   * the caller's read cannot be clobbered by this write. A guarded current
   * row makes the UPDATE no-op and returns
   * `{ ok: false, reason: 'guarded_status' }`. Webhook callers must NOT set
   * this — DID_RENEW legitimately flips a guarded row back to active.
   */
  redeemGuard?: boolean;
  lastNotificationType?: string | null;
  lastNotificationSubtype?: string | null;
}

/**
 * Idempotent upsert keyed on `originalTransactionId`. Reassigning a row
 * already owned by a DIFFERENT (non-null) userId is refused (returns
 * `{ ok: false, reason: 'owner_mismatch' }`) rather than silently reassigning
 * a subscription's Premium grant to a new account — the only legitimate way
 * an OWNED transaction id's owner should ever change is a support-assisted
 * account merge, not an unauthenticated replay.
 *
 * A `null`-owner row (anonymous device purchase — Guideline 5.1.1(v)) is the
 * one case this guard deliberately lets through: it is claimable by the
 * FIRST authenticated account that presents a matching verified JWS
 * (`link_apple_entitlement` / `redeem_apple_purchase`), because nobody has a
 * competing claim on it yet. Once claimed, the row behaves exactly like any
 * other owned row. The SELECT+guard is not a transaction; the UPSERT uses
 * `COALESCE(existing.user_id, excluded.user_id)` so an in-flight anonymous
 * redeem cannot write NULL over a claim that landed after the read, and a
 * non-null owner is never reassigned.
 */
export async function upsertAppleSubscription(
  env: Env,
  input: UpsertAppleSubscriptionInput,
): Promise<
  | { ok: true; record: AppleSubscriptionRecord; isNew: boolean }
  | { ok: false; reason: 'owner_mismatch'; ownerId: string }
  | { ok: false; reason: 'guarded_status' }
> {
  const existing = await getAppleSubscription(env, input.originalTransactionId);
  if (existing && existing.userId != null && existing.userId !== input.userId) {
    return { ok: false, reason: 'owner_mismatch', ownerId: existing.userId };
  }
  // No ledger row existed yet for this originalTransactionId before this
  // call — i.e. this is the first time we've ever seen this Apple
  // subscription, not a renewal/refresh of one we already knew about.
  const isNew = !existing;
  const now = new Date().toISOString();
  // SQL mirror of clientRedeemWouldResurrectRevoked, so the guard and the
  // write are one statement (the SELECT+check above is not atomic with this
  // write — a webhook can land in between). In the upsert grammar
  // `apple_subscriptions.<col>` is the existing row, `excluded.<col>` the
  // incoming one. A guarded row yields zero changed rows below.
  const redeemGuardWhere = input.redeemGuard
    ? `
     WHERE NOT (
       apple_subscriptions.status IN ('revoked', 'expired', 'billing_retry')
       AND (
         excluded.latest_transaction_id IS NULL
         OR excluded.latest_transaction_id = apple_subscriptions.latest_transaction_id
         OR excluded.purchase_date IS NULL
         OR NOT (
           (apple_subscriptions.revoked_at IS NOT NULL AND excluded.purchase_date > apple_subscriptions.revoked_at)
           OR (apple_subscriptions.revoked_at IS NULL AND apple_subscriptions.expires_date IS NOT NULL AND excluded.purchase_date > apple_subscriptions.expires_date)
           OR (apple_subscriptions.revoked_at IS NULL AND apple_subscriptions.expires_date IS NULL
               AND apple_subscriptions.status IN ('expired', 'billing_retry')
               AND excluded.purchase_date > apple_subscriptions.updated_at)
         )
       )
     )`
    : '';
  const writeResult = await run(
    env.DB,
    `INSERT INTO apple_subscriptions (
       original_transaction_id, user_id, product_id, plan, status, environment,
       latest_transaction_id, purchase_date, expires_date, auto_renew_status,
       auto_renew_product_id, revoked_at, revocation_reason,
       last_notification_type, last_notification_subtype, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(original_transaction_id) DO UPDATE SET
       -- The SELECT+guard above is not atomic with this write. iOS leaves a
       -- signed-out purchase UNFINISHED so Transaction.updates redelivers it
       -- after sign-in (AppleIAP.observeAppleTransactions) while
       -- link_apple_entitlement claims the same row. If the in-flight
       -- anonymous redeem still saw user_id NULL, user_id = excluded.user_id
       -- would write NULL over the claim and drop account Premium.
       -- COALESCE keeps any existing owner and only fills a NULL.
       user_id = COALESCE(apple_subscriptions.user_id, excluded.user_id),
       product_id = excluded.product_id,
       plan = excluded.plan,
       status = excluded.status,
       environment = excluded.environment,
       latest_transaction_id = excluded.latest_transaction_id,
       purchase_date = excluded.purchase_date,
       expires_date = excluded.expires_date,
       auto_renew_status = excluded.auto_renew_status,
       auto_renew_product_id = excluded.auto_renew_product_id,
       revoked_at = excluded.revoked_at,
       revocation_reason = excluded.revocation_reason,
       last_notification_type = COALESCE(excluded.last_notification_type, apple_subscriptions.last_notification_type),
       last_notification_subtype = COALESCE(excluded.last_notification_subtype, apple_subscriptions.last_notification_subtype),
       updated_at = excluded.updated_at${redeemGuardWhere}`,
    [
      input.originalTransactionId,
      input.userId,
      input.productId,
      input.plan,
      input.status,
      input.environment ?? null,
      input.latestTransactionId ?? null,
      input.purchaseDate ?? null,
      input.expiresDate ?? null,
      input.autoRenewStatus == null ? null : input.autoRenewStatus ? 1 : 0,
      input.autoRenewProductId ?? null,
      input.revokedAt ?? null,
      input.revocationReason ?? null,
      input.lastNotificationType ?? null,
      input.lastNotificationSubtype ?? null,
      existing ? existing.createdAt : now,
      now,
    ],
  );
  if (input.redeemGuard && (writeResult?.meta?.changes ?? 0) === 0) {
    return { ok: false, reason: 'guarded_status' };
  }
  const record = await getAppleSubscription(env, input.originalTransactionId);
  if (!record) throw new Error('apple subscription upsert failed');
  // Re-check ownership AFTER the write before reporting newness.
  //
  // `isNew` above comes from a pre-read, so two accounts redeeming the same
  // previously-unseen originalTransactionId can both see null and both claim to
  // be new. The INSERT preserves the first writer's user_id, but the LOSER would
  // still report isNew - and whichever request then claims the notification key
  // first sends an alert carrying its own email for the winner's subscription.
  // The row's persisted owner is the only authority on who actually won, so a
  // caller that does not own it is never new.
  const wonTheRow = record.userId == null || record.userId === input.userId;
  return { ok: true, record, isNew: isNew && wonTheRow };
}
