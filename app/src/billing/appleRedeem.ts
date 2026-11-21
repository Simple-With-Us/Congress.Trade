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

function appleEpochMsToIso(value: unknown): string {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return 'none';
  try {
    return new Date(ms).toISOString();
  } catch {
    // Out-of-range epoch: a logger must never crash the rejection path.
    return 'none';
  }
}

/**
 * Collapse log-bound text to one truncated printable line. Rejection reasons
 * can carry attacker-influenced text from an unverified JWS, and signed
 * payload fields are still external input: embedded CR/LF or ANSI escapes
 * must not split or forge extra log lines.
 */
function singleLogLine(value: unknown, max = 120): string {
  const text = String(value ?? 'unknown').replace(/[^\x20-\x7e]+/g, ' ');
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * One payload-free line per refused redemption: which check failed plus the
 * environment / product / expires / revoked fields Apple signed — the minimum
 * needed to tell "Sandbox purchase expired" from "Production purchase
 * revoked" in server logs. The JWS itself, transaction ids and every other
 * transaction field stay out of logs, so a refusal can be diagnosed without
 * ever persisting a customer's signed transaction.
 */
function logAppleRedeemRejection(reason: string, transaction?: AppleTransactionPayload): void {
  if (!transaction) {
    console.warn(`apple redeem rejected: ${singleLogLine(reason)}`);
    return;
  }
  console.warn(
    `apple redeem rejected: ${singleLogLine(reason)};` +
      ` environment=${singleLogLine(transaction.environment)}` +
      ` productId=${singleLogLine(transaction.productId)}` +
      ` expiresAt=${appleEpochMsToIso(transaction.expiresDate)}` +
      ` revokedAt=${appleEpochMsToIso(transaction.revocationDate)}` +
      ` revocationReason=${singleLogLine(transaction.revocationReason ?? 'none')}`,
  );
}

/**
 * Chain-verify `jws`, then check bundle id, Sandbox policy, a recognized
 * (configured) product id, and that the transaction is currently active.
 * Throws {@link AppleRedeemError} (message + HTTP-ish status) on any failure
 * — callers map that straight to their own error type (`ClientInputError` for
 * commands, a plain JSON error for the anonymous route). Every rejection is
 * logged once via {@link logAppleRedeemRejection} before throwing.
 */
export async function verifyAppleRedemption(env: Env, jws: string): Promise<VerifiedAppleRedemption> {
  if (!jws) throw new AppleRedeemError('signedTransaction is required');

  let transaction: AppleTransactionPayload;
  try {
    transaction = await verifyAppleSignedJws<AppleTransactionPayload>(jws);
  } catch (err) {
    const message = err instanceof AppleJwsVerificationError ? err.message : 'invalid Apple transaction';
    logAppleRedeemRejection(message);
    throw new AppleRedeemError(message);
  }

  const expectedBundle = (await resolveSecret(env, 'APPLE_BUNDLE_ID')).value?.trim() || 'trade.congress.ios';
  if (transaction.bundleId && transaction.bundleId !== expectedBundle) {
    logAppleRedeemRejection('bundleId mismatch', transaction);
    throw new AppleRedeemError('bundleId mismatch');
  }
  // Sandbox is allowed by default (TestFlight / App Review / Mac Designed-for-iPad).
  // Only APPLE_ALLOW_SANDBOX=false refuses. See appleSandboxPurchasesAllowed.
  if (isAppleSandboxEnvironment(transaction.environment) && !(await appleSandboxPurchasesAllowed(env))) {
    logAppleRedeemRejection('Sandbox Apple purchases are not accepted', transaction);
    throw new AppleRedeemError('Sandbox Apple purchases are not accepted');
  }
  const configuredProducts = await resolveAppleProductIds(env);
  const plan = planFromConfiguredAppleProductId(transaction.productId, configuredProducts);
  if (!plan) {
    logAppleRedeemRejection('unrecognized Apple product id', transaction);
    throw new AppleRedeemError('unrecognized Apple product id');
  }
  if (!appleTransactionIsActive(transaction)) {
    logAppleRedeemRejection('this Apple transaction is not an active subscription', transaction);
    throw new AppleRedeemError('this Apple transaction is not an active subscription');
  }
  const originalTransactionId = transaction.originalTransactionId || transaction.transactionId;
  if (!originalTransactionId) {
    logAppleRedeemRejection('missing Apple transaction id', transaction);
    throw new AppleRedeemError('missing Apple transaction id');
  }

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
