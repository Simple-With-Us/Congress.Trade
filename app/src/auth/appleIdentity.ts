/**
 * src/auth/appleIdentity.ts
 * "Sign in with Apple" identity token (JWS) verification for the native iOS
 * flow. ASAuthorizationAppleIDProvider hands the client a compact JWS signed
 * by Apple; this module verifies its RS256 signature against Apple's
 * published JWKS (cached in-isolate), then validates the standard claims
 * (iss/aud/exp) plus an optional client-supplied nonce.
 *
 * Deliberately parallels admin/access.ts's hand-rolled JWKS + RS256 verifier
 * (decode -> fetch/cache JWKS -> import RSA key -> crypto.subtle.verify)
 * rather than importing it: that module is Cloudflare-Access-specific
 * (aud/email/allowlist semantics baked into checkAccessClaims) and unrelated
 * to Apple's issuer, so a shared abstraction would blur two independently
 * evolving trust boundaries for a few dozen shared lines.
 */

import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

export const APPLE_ID_ISSUER = 'https://appleid.apple.com';
export const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';

interface AppleJwtHeader {
  alg?: string;
  kid?: string;
}

export interface AppleIdentityClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  is_private_email?: boolean | string;
  nonce?: string;
  nonce_supported?: boolean;
  real_user_status?: number;
}

interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}
interface Jwks {
  keys: Jwk[];
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class AppleIdentityVerificationError extends Error {}

function decodeJwt(token: string): {
  header: AppleJwtHeader;
  payload: AppleIdentityClaims;
  signingInput: string;
  signature: Uint8Array;
} {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AppleIdentityVerificationError('malformed identity token');
  const dec = (p: string) => JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as unknown;
  return {
    header: dec(parts[0]) as AppleJwtHeader,
    payload: dec(parts[1]) as AppleIdentityClaims,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: b64urlToBytes(parts[2]),
  };
}

// --- JWKS cache (module-level; survives across requests in a warm isolate) --
interface CacheEntry {
  fetchedAtMs: number;
  keys: Map<string, CryptoKey>;
}
const jwksCache = new Map<string, CacheEntry>();
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h

/** Test hook: clear the JWKS cache between cases. */
export function _resetAppleJwksCache(): void {
  jwksCache.clear();
}

async function importRsaKey(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

async function getSigningKey(
  jwksUrl: string,
  kid: string | undefined,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<CryptoKey | null> {
  let entry = jwksCache.get(jwksUrl);
  const stale = !entry || nowMs - entry.fetchedAtMs > JWKS_TTL_MS;
  const missingKid = !!entry && kid != null && !entry.keys.has(kid);
  if (stale || missingKid) {
    const res = await trackedFetch(
      jwksUrl,
      undefined,
      { service: 'apple-signin', operation: 'fetch-jwks' },
      fetchImpl,
    );
    if (res.ok) {
      const body = (await res.json()) as Jwks;
      const keys = new Map<string, CryptoKey>();
      for (const jwk of body.keys ?? []) {
        if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) continue;
        try {
          keys.set(jwk.kid ?? '', await importRsaKey(jwk));
        } catch {
          /* skip unusable key */
        }
      }
      entry = { fetchedAtMs: nowMs, keys };
      jwksCache.set(jwksUrl, entry);
    }
  }
  if (!entry) return null;
  if (kid != null && entry.keys.has(kid)) return entry.keys.get(kid) ?? null;
  if (kid == null && entry.keys.size === 1) return [...entry.keys.values()][0];
  return null;
}

export interface VerifyAppleIdentityTokenOptions {
  /** Expected audience — the app's bundle id (or Services ID for the web flow). */
  bundleId: string;
  /** Expected nonce, when the client sent one at sign-in start. */
  nonce?: string;
  jwksUrl?: string;
  now?: number; // epoch seconds (test injection)
  fetchImpl?: typeof fetch;
  leewaySec?: number;
}

/**
 * Verify an Apple "Sign in with Apple" identity token end to end: RS256
 * signature against Apple's JWKS, then iss/aud/exp (+ optional nonce).
 * Throws {@link AppleIdentityVerificationError} on any failure; never
 * returns claims without a verified signature.
 */
export async function verifyAppleIdentityToken(
  token: string,
  opts: VerifyAppleIdentityTokenOptions,
): Promise<AppleIdentityClaims> {
  const trimmed = typeof token === 'string' ? token.trim() : '';
  if (trimmed.length < 40 || trimmed.length > 8_000) {
    throw new AppleIdentityVerificationError('invalid identity token length');
  }
  const decoded = decodeJwt(trimmed);
  if (decoded.header.alg !== 'RS256') {
    throw new AppleIdentityVerificationError(`unexpected alg ${String(decoded.header.alg)}`);
  }

  const jwksUrl = opts.jwksUrl ?? APPLE_JWKS_URL;
  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const leeway = opts.leewaySec ?? 60;

  let key: CryptoKey | null;
  try {
    key = await getSigningKey(jwksUrl, decoded.header.kid, fetchImpl, nowSec * 1000);
  } catch {
    throw new AppleIdentityVerificationError('failed to fetch Apple signing keys');
  }
  if (!key) throw new AppleIdentityVerificationError('no matching Apple signing key');

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    decoded.signature as unknown as ArrayBuffer,
    new TextEncoder().encode(decoded.signingInput) as unknown as ArrayBuffer,
  );
  if (!valid) throw new AppleIdentityVerificationError('invalid identity token signature');

  const { payload } = decoded;
  if (payload.iss !== APPLE_ID_ISSUER) throw new AppleIdentityVerificationError('unexpected issuer');
  const auds = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!auds.includes(opts.bundleId)) throw new AppleIdentityVerificationError('audience mismatch');
  if (typeof payload.exp !== 'number' || nowSec > payload.exp + leeway) {
    throw new AppleIdentityVerificationError('identity token expired');
  }
  if (opts.nonce && payload.nonce !== opts.nonce) {
    throw new AppleIdentityVerificationError('nonce mismatch');
  }
  if (!payload.sub) throw new AppleIdentityVerificationError('identity token missing sub claim');

  return payload;
}

export function appleEmailIsVerified(payload: AppleIdentityClaims): boolean {
  return payload.email_verified === true || payload.email_verified === 'true';
}
