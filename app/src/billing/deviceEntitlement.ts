/**
 * src/billing/deviceEntitlement.ts
 *
 * Short-lived, HMAC-signed proof that a DEVICE (not a Congress.Trade account)
 * holds a verified Apple subscription — minted by `POST
 * /api/client/v1/entitlements/apple/redeem` once a signed StoreKit
 * transaction has been chain-verified (`billing/appleRedeem.ts`) and recorded
 * in the `apple_subscriptions` ledger with no owning user (Guideline
 * 5.1.1(v)). Re-checked against that ledger on every PDF / CSV export request
 * that has no signed-in session (`delivery/rest.ts`).
 *
 * This token carries no personal information — no email, no user id, just
 * the Apple `originalTransactionId` a verified JWS already proved this
 * device's Apple Account owns, plus an expiry. It authorizes nothing the JWS
 * did not already prove; it only saves the client from re-verifying the full
 * JWS chain on every content request. Same "payload.signature" shape as
 * `delivery/webhook.ts`'s `signWebhookPayloadV1`, minus the timestamp prefix
 * (expiry lives in the payload itself).
 */

import type { Env } from '../shared/types.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { constantTimeEqual } from '../auth/tokens.ts';

export interface DeviceEntitlementClaim {
  originalTransactionId: string;
  /** Unix milliseconds. */
  exp: number;
}

/**
 * Never issue a token that outlives the subscription's own `expiresDate`,
 * and never issue one good for more than 24h regardless — bounds how long a
 * revoked-but-not-yet-webhooked anonymous purchase can keep granting content
 * to at most one day, the same exposure window the account-based path
 * already accepts implicitly via cached session state (see the design note
 * "Refunds and expiry revoking the local entitlement").
 */
export const DEVICE_ENTITLEMENT_MAX_TTL_MS = 24 * 60 * 60 * 1000;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64urlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(input: string): string {
  const pad = '='.repeat((4 - (input.length % 4)) % 4);
  const b64 = (input + pad).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return toHex(new Uint8Array(sig));
}

async function deviceEntitlementSecret(env: Env): Promise<string | null> {
  const value = (await resolveSecret(env, 'APPLE_DEVICE_ENTITLEMENT_SECRET')).value?.trim();
  return value && value.length > 0 ? value : null;
}

/** Mints a token, or `null` if `APPLE_DEVICE_ENTITLEMENT_SECRET` is not configured yet. */
export async function issueDeviceEntitlementToken(
  env: Env,
  originalTransactionId: string,
  expiresDateIso: string | null,
  nowMs: number = Date.now(),
): Promise<string | null> {
  const secret = await deviceEntitlementSecret(env);
  if (!secret) return null;
  const subscriptionExpiryMs = expiresDateIso ? new Date(expiresDateIso).getTime() : Number.NaN;
  const cap = nowMs + DEVICE_ENTITLEMENT_MAX_TTL_MS;
  const exp = Number.isFinite(subscriptionExpiryMs) ? Math.min(subscriptionExpiryMs, cap) : cap;
  const payload = JSON.stringify({ originalTransactionId, exp } satisfies DeviceEntitlementClaim);
  const encoded = b64urlEncode(payload);
  const sig = await hmacHex(secret, encoded);
  return `${encoded}.${sig}`;
}

/** Verifies signature + expiry; returns the claim, or `null` if invalid/expired/unconfigured. */
export async function verifyDeviceEntitlementToken(
  env: Env,
  token: string,
  nowMs: number = Date.now(),
): Promise<DeviceEntitlementClaim | null> {
  const secret = await deviceEntitlementSecret(env);
  if (!secret) return null;
  const trimmed = token.trim();
  const dot = trimmed.lastIndexOf('.');
  if (dot <= 0 || dot === trimmed.length - 1) return null;
  const encoded = trimmed.slice(0, dot);
  const sig = trimmed.slice(dot + 1);

  const expectedSig = await hmacHex(secret, encoded);
  if (!(await constantTimeEqual(expectedSig, sig))) return null;

  let claim: DeviceEntitlementClaim;
  try {
    const parsed = JSON.parse(b64urlDecode(encoded)) as Partial<DeviceEntitlementClaim>;
    if (!parsed || typeof parsed.originalTransactionId !== 'string' || typeof parsed.exp !== 'number') return null;
    claim = { originalTransactionId: parsed.originalTransactionId, exp: parsed.exp };
  } catch {
    return null;
  }
  if (claim.exp < nowMs) return null;
  return claim;
}
