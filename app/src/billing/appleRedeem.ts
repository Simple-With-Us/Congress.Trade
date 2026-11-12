/**
 * src/billing/appleRedeem.ts
 *
 * Shared "verify one StoreKit 2 transaction" steps behind both ways a
 * transaction can be redeemed:
 *   - the authenticated `redeem_apple_purchase` / `link_apple_entitlement`
 *     client commands (client/commands.ts), and
 *   - the unauthenticated anonymous-device route (client/entitlements.ts,
 *     `POST /api/client/v1/entitlements/apple/redeem` — Guideline 5.1.1(v):
 *     an In-App Purchase that is not itself account-based must not require
 *     registration to buy).
 *
 * Every entitlement decision downstream of this module is derived from a
 * chain-VERIFIED Apple JWS (`verifyAppleSignedJws`) — never from a
 * client-supplied boolean, plan, or product id. This file only decides
 * whether the transaction is real, current, and for this app; it does not
 * touch the `apple_subscriptions` ledger or decide who owns the row — that
 * stays with each caller (signed-in user vs. no owner) so this module cannot
 * accidentally attribute a purchase to an account.
 */

import type { Env } from '../shared/types.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { verifyAppleSignedJws, AppleJwsVerificationError } from './appleJws.ts';
import {
  appleSandboxPurchasesAllowed,
  appleTransactionIsActive,
  isAppleSandboxEnvironment,
  planFromConfiguredAppleProductId,
  resolveAppleProductIds,
  type ApplePlan,
  type AppleTransactionPayload,
} from './apple.ts';

export class AppleRedeemError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
  }
}

export interface VerifiedAppleRedemption {
  transaction: AppleTransactionPayload;
  plan: ApplePlan;
  originalTransactionId: string;
}

/** `APPLE_IAP_ENABLED` gate shared by every Apple redeem/link entrypoint. */
export async function requireAppleIapEnabled(env: Env): Promise<void> {
  const enabled = (await resolveSecret(env, 'APPLE_IAP_ENABLED')).value === 'true';
  if (!enabled) throw new AppleRedeemError('Apple in-app purchases are not enabled yet', 503);
}

/**
 * Chain-verify `jws`, then check bundle id, Sandbox policy, a recognized
 * (configured) product id, and that the transaction is currently active.
 * Throws {@link AppleRedeemError} (message + HTTP-ish status) on any failure
 * — callers map that straight to their own error type (`ClientInputError` for
 * commands, a plain JSON error for the anonymous route).
 */
export async function verifyAppleRedemption(env: Env, jws: string): Promise<VerifiedAppleRedemption> {
  if (!jws) throw new AppleRedeemError('signedTransaction is required');

  let transaction: AppleTransactionPayload;
  try {
    transaction = await verifyAppleSignedJws<AppleTransactionPayload>(jws);
  } catch (err) {
    const message = err instanceof AppleJwsVerificationError ? err.message : 'invalid Apple transaction';
    throw new AppleRedeemError(message);
  }

  const expectedBundle = (await resolveSecret(env, 'APPLE_BUNDLE_ID')).value?.trim() || 'trade.congress.ios';
  if (transaction.bundleId && transaction.bundleId !== expectedBundle) {
    throw new AppleRedeemError('bundleId mismatch');
  }
  // Sandbox is allowed by default (TestFlight / App Review / Mac Designed-for-iPad).
  // Only APPLE_ALLOW_SANDBOX=false refuses. See appleSandboxPurchasesAllowed.
  if (isAppleSandboxEnvironment(transaction.environment) && !(await appleSandboxPurchasesAllowed(env))) {
    throw new AppleRedeemError('Sandbox Apple purchases are not accepted');
  }
  const configuredProducts = await resolveAppleProductIds(env);
  const plan = planFromConfiguredAppleProductId(transaction.productId, configuredProducts);
  if (!plan) throw new AppleRedeemError('unrecognized Apple product id');
  if (!appleTransactionIsActive(transaction)) {
    throw new AppleRedeemError('this Apple transaction is not an active subscription');
  }
  const originalTransactionId = transaction.originalTransactionId || transaction.transactionId;
  if (!originalTransactionId) throw new AppleRedeemError('missing Apple transaction id');

  return { transaction, plan, originalTransactionId };
}

/** Pull `signedTransaction` (or the legacy `jwsRepresentation` alias) out of a command/route payload. */
export function jwsFromInput(input: Record<string, unknown>): string {
  return (
    (typeof input.signedTransaction === 'string' && input.signedTransaction) ||
    (typeof input.jwsRepresentation === 'string' && input.jwsRepresentation) ||
    ''
  );
}
