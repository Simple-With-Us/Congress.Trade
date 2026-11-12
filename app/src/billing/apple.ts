/**
 * Apple In-App Purchase (StoreKit 2) confirmation helpers.
 *
 * iOS sends the transaction's `jwsRepresentation`. The current grant path
 * is `redeem_apple_purchase` (and the leftover POST /billing/apple/confirm
 * wrapper). Both verify via appleJws.ts (x5c chain to the pinned Apple root)
 * and write `apple_subscriptions`, not the Stripe-shaped users columns.
 */

import type { Env } from '../shared/types.ts';
import { resolveSecret, resolveSecrets } from '../secrets/infisical.ts';

export const APPLE_PRODUCT_MONTHLY = 'trade.congress.premium.monthly';
export const APPLE_PRODUCT_ANNUAL = 'trade.congress.premium.annual';

export type ApplePlan = 'monthly' | 'annual';

export interface AppleTransactionPayload {
  transactionId?: string;
  originalTransactionId?: string;
  productId?: string;
  bundleId?: string;
  type?: string;
  environment?: string;
  expiresDate?: number;
  purchaseDate?: number;
  revocationDate?: number;
  /** 0 = refunded due to app issue, 1 = other reason (e.g. accidental purchase). Apple's JWSTransactionDecodedPayload.revocationReason. */
  revocationReason?: number;
}

function b64urlJson(part: string): unknown {
  const pad = '='.repeat((4 - (part.length % 4)) % 4);
  const b64 = (part + pad).replace(/-/g, '+').replace(/_/g, '/');
  // Avoid Node Buffer so this works under Deno and Workers.
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json) as unknown;
}

/** Decode a compact JWS without verifying the signature (payload inspection). */
export function decodeAppleJwsPayload(jws: string): AppleTransactionPayload {
  const parts = jws.split('.');
  if (parts.length !== 3) throw new Error('invalid Apple JWS');
  const payload = b64urlJson(parts[1]);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('invalid Apple JWS payload');
  }
  return payload as AppleTransactionPayload;
}

export function planFromAppleProductId(productId: string | undefined): ApplePlan | null {
  if (!productId) return null;
  if (productId === APPLE_PRODUCT_MONTHLY || productId.endsWith('.premium.monthly')) return 'monthly';
  if (productId === APPLE_PRODUCT_ANNUAL || productId.endsWith('.premium.annual')) return 'annual';
  return null;
}

export function appleTransactionIsActive(tx: AppleTransactionPayload, nowMs = Date.now()): boolean {
  if (tx.revocationDate) return false;
  if (tx.expiresDate != null && Number(tx.expiresDate) < nowMs) return false;
  return true;
}

/**
 * Minimal signature check: require three-part JWS and a decodable payload.
 * Full chain verification (x5c → Apple Root CA) can be enabled later via
 * APPLE_IAP_REQUIRE_SIGNATURE + cert pinning without changing the iOS client.
 */
export function assertAppleJwsShape(jws: string): AppleTransactionPayload {
  const trimmed = jws.trim();
  if (trimmed.length < 40 || trimmed.length > 200_000) throw new Error('invalid Apple JWS length');
  return decodeAppleJwsPayload(trimmed);
}

/** App Store Connect product ids (APPLE_PRODUCT_MONTHLY/ANNUAL, else the built-in defaults). */
export async function resolveAppleProductIds(env: Env): Promise<{ monthly: string; annual: string }> {
  const configured = await resolveSecrets(env, ['APPLE_PRODUCT_MONTHLY', 'APPLE_PRODUCT_ANNUAL']);
  return {
    monthly: configured.APPLE_PRODUCT_MONTHLY?.trim() || APPLE_PRODUCT_MONTHLY,
    annual: configured.APPLE_PRODUCT_ANNUAL?.trim() || APPLE_PRODUCT_ANNUAL,
  };
}

export function isAppleSandboxEnvironment(value: string | undefined | null): boolean {
  return (value ?? '').trim().toLowerCase() === 'sandbox';
}

/**
 * Apple-signed Sandbox JWS is allowed unless explicitly turned off.
 *
 * TestFlight, App Review, Xcode, and Designed-for-iPad on Mac all send
 * `environment=Sandbox` to production `congress.trade` — the app binary has
 * no staging API. Rejecting those (the #2030 default) leaves Apple having
 * confirmed the purchase and Congress.Trade refusing to unlock Premium.
 *
 * The JWS is still chain-verified against the pinned Apple root. The
 * ledger keeps `environment` so sandbox grants stay distinguishable.
 * Set `APPLE_ALLOW_SANDBOX=false` to restore the kill switch.
 */
export async function appleSandboxPurchasesAllowed(env: Env): Promise<boolean> {
  const raw = (await resolveSecret(env, 'APPLE_ALLOW_SANDBOX')).value?.trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

/** Map a StoreKit product id to a plan using the CONFIGURED product ids (env-overridable), unlike {@link planFromAppleProductId}'s hardcoded suffix match. */
export function planFromConfiguredAppleProductId(
  productId: string | undefined,
  configured: { monthly: string; annual: string },
): ApplePlan | null {
  if (!productId) return null;
  if (productId === configured.monthly) return 'monthly';
  if (productId === configured.annual) return 'annual';
  return null;
}
