/**
 * src/billing/appleJws.ts
 *
 * Verifies Apple-signed JWS payloads: StoreKit 2 `signedTransaction` /
 * `signedRenewalInfo` and App Store Server Notifications V2 `signedPayload`.
 * Both share the same envelope — a compact JWS whose protected header
 * carries `alg: "ES256"` and an `x5c` certificate chain (leaf first,
 * base64-DER per RFC 7515 §4.1.6). Apple does not include the root in `x5c`;
 * the topmost certificate the peer supplies is verified directly against our
 * pinned Apple Root CA - G3 public key (appleRootCert.ts) — no network call,
 * and no trust is placed in anything beyond what chains to that pin.
 */

import { parseCertificate, verifyCertSignedBy, type ParsedCert } from './appleCrypto.ts';
import { APPLE_ROOT_CA_G3_DER_B64 } from './appleRootCert.ts';

/**
 * Apple structures the StoreKit 2 / App Store Server Notifications V2 x5c chain
 * as EXACTLY three certificates — [leaf, WWDR intermediate, Apple Root CA - G3]
 * — the same length Apple's own app-store-server-library enforces
 * (`ChainVerifier`, EXPECTED_CHAIN_LENGTH = 3). Anything else is rejected before
 * any cryptography runs.
 */
const REQUIRED_CHAIN_LENGTH = 3;

/**
 * Apple's custom marker OIDs that bind a certificate to a specific branch of
 * Apple's PKI. The WWDR intermediate that issues App Store signing leaves
 * carries 1.2.840.113635.100.6.2.1; the leaf itself carries
 * 1.2.840.113635.100.6.11.1. Their mere presence is the signal — the same two
 * OIDs app-store-server-library checks. Requiring them stops an attacker from
 * substituting some *other* Apple-issued end-entity cert (e.g. a $99 developer
 * cert) into the intermediate/leaf position.
 */
const APPLE_INTERMEDIATE_MARKER_OID = '1.2.840.113635.100.6.2.1';
const APPLE_LEAF_MARKER_OID = '1.2.840.113635.100.6.11.1';

export class AppleJwsVerificationError extends Error {}

/** Length-safe byte comparison (public trust-anchor material — no secrecy need). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Enforce the X.509 path-validation *policy* Apple's chain uses, beyond the raw
 * signature links: end-entity vs. CA roles (basicConstraints), certificate-
 * signing capability (keyUsage keyCertSign) on every issuer, and the Apple
 * marker OIDs on the leaf and intermediate. This is what distinguishes a
 * genuine Apple signing leaf from a forged leaf chained through an unrelated
 * Apple-issued certificate.
 */
function assertAppleChainConstraints(leaf: ParsedCert, intermediate: ParsedCert, root: ParsedCert): void {
  // The leaf must be an end-entity certificate — never permitted to act as a CA.
  if (leaf.isCa) {
    throw new AppleJwsVerificationError('leaf certificate asserts basicConstraints CA:TRUE (a signing leaf must be an end-entity certificate)');
  }
  // Every issuing (non-leaf) certificate must be a CA that is allowed to sign certificates.
  for (const [label, ca] of [['intermediate', intermediate], ['root', root]] as const) {
    if (!ca.isCa) {
      throw new AppleJwsVerificationError(`${label} certificate is missing basicConstraints CA:TRUE`);
    }
    if (!ca.keyCertSign) {
      throw new AppleJwsVerificationError(`${label} certificate is missing keyUsage keyCertSign`);
    }
  }
  // Apple marker OIDs must be present on the intermediate and the leaf.
  if (!intermediate.extensionOids.includes(APPLE_INTERMEDIATE_MARKER_OID)) {
    throw new AppleJwsVerificationError(`intermediate certificate is missing the Apple WWDR marker extension (${APPLE_INTERMEDIATE_MARKER_OID})`);
  }
  if (!leaf.extensionOids.includes(APPLE_LEAF_MARKER_OID)) {
    throw new AppleJwsVerificationError(`leaf certificate is missing the Apple App Store signing marker extension (${APPLE_LEAF_MARKER_OID})`);
  }
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return b64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

interface JwsHeader {
  alg?: string;
  x5c?: string[];
}

export interface VerifyAppleJwsOptions {
  /** Override the pinned root's DER bytes (base64) — test injection only; production always uses the embedded Apple root. */
  pinnedRootB64?: string;
  /** Epoch ms used for certificate validity-window checks. Defaults to Date.now(). */
  now?: number;
}

function parseChain(x5c: string[]): ParsedCert[] {
  try {
    return x5c.map((certB64) => parseCertificate(b64ToBytes(certB64)));
  } catch (err) {
    throw new AppleJwsVerificationError(`malformed certificate in x5c chain: ${(err as Error).message}`);
  }
}

function assertCertsInWindow(certs: ParsedCert[], nowMs: number): void {
  for (const cert of certs) {
    if (nowMs < cert.notBefore.getTime() || nowMs > cert.notAfter.getTime()) {
      throw new AppleJwsVerificationError('a certificate in the chain is expired or not yet valid');
    }
  }
}

/**
 * Verify an Apple ES256 x5c-chained JWS end to end and return the decoded JSON
 * payload. Performs full X.509 path validation, not merely signature linking:
 *
 *   1. x5c length is EXACTLY 3 (leaf, intermediate, root).
 *   2. Every certificate is within its validity window at `now`.
 *   3. The supplied root (x5c[2]) IS our pinned Apple Root CA - G3 (public-key
 *      match) — the chain must terminate at exactly that trust anchor.
 *   4. Role/usage policy: the leaf is an end-entity cert (not a CA); the
 *      intermediate and root are CAs with keyUsage keyCertSign; the Apple
 *      marker OIDs are present on the leaf and intermediate.
 *   5. Signature links, each verified against a key WE derived: root self-
 *      signed by the pin, intermediate by the root, leaf by the intermediate.
 *   6. The outer JWS ES256 signature verifies under the leaf key.
 *
 * Throws {@link AppleJwsVerificationError} on any failure. Never returns a
 * payload without a fully validated chain. This closes the forged-leaf exploit
 * whereby anyone holding an Apple-issued end-entity certificate (which chains
 * to the same root) could mint a leaf, sign an arbitrary payload, and have it
 * accepted: such a chain fails the role/usage, marker-OID, and exact-pin checks.
 */
export async function verifyAppleSignedJws<T = unknown>(
  jws: string,
  opts: VerifyAppleJwsOptions = {},
): Promise<T> {
  const trimmed = typeof jws === 'string' ? jws.trim() : '';
  if (trimmed.length < 40 || trimmed.length > 200_000) {
    throw new AppleJwsVerificationError('invalid JWS length');
  }
  const parts = trimmed.split('.');
  if (parts.length !== 3) throw new AppleJwsVerificationError('malformed JWS: expected 3 dot-separated parts');
  const [headerB64, payloadB64, sigB64] = parts;

  let header: JwsHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64))) as JwsHeader;
  } catch {
    throw new AppleJwsVerificationError('malformed JWS header');
  }
  if (header.alg !== 'ES256') {
    throw new AppleJwsVerificationError(`unsupported JWS alg ${String(header.alg)}; only ES256 is accepted`);
  }
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length !== REQUIRED_CHAIN_LENGTH) {
    throw new AppleJwsVerificationError(
      `x5c certificate chain must contain exactly ${REQUIRED_CHAIN_LENGTH} certificates (leaf, intermediate, root)`,
    );
  }
  if (!x5c.every((c) => typeof c === 'string' && c.length > 0)) {
    throw new AppleJwsVerificationError('x5c chain entries must be non-empty strings');
  }

  const chain = parseChain(x5c);
  const [leaf, intermediate, suppliedRoot] = chain;
  const nowMs = opts.now ?? Date.now();
  assertCertsInWindow(chain, nowMs);

  let pinnedRoot: ParsedCert;
  try {
    pinnedRoot = parseCertificate(b64ToBytes(opts.pinnedRootB64 ?? APPLE_ROOT_CA_G3_DER_B64));
  } catch (err) {
    throw new AppleJwsVerificationError(`invalid pinned root certificate: ${(err as Error).message}`);
  }
  if (nowMs < pinnedRoot.notBefore.getTime() || nowMs > pinnedRoot.notAfter.getTime()) {
    throw new AppleJwsVerificationError('the pinned root certificate is outside its validity window');
  }

  // Trust-anchor pin: the root the peer supplied at x5c[2] must BE our pinned
  // Apple Root CA - G3, matched by public key (SPKI). This is what stops the
  // forged-leaf exploit at its root — an attacker's chain that terminates at
  // some other Apple-issued cert (even one legitimately signed by the real
  // Apple root) never presents *this exact* root at x5c[2].
  if (!bytesEqual(suppliedRoot.spkiRaw, pinnedRoot.spkiRaw)) {
    throw new AppleJwsVerificationError('certificate chain does not terminate at the pinned Apple Root CA - G3');
  }

  // X.509 role/usage policy (basicConstraints, keyUsage, Apple marker OIDs).
  assertAppleChainConstraints(leaf, intermediate, suppliedRoot);

  // Signature links, verified top-down, each against a key WE derived: the
  // supplied root against the pinned key (a self-signature since they match),
  // the intermediate against the root, and the leaf against the intermediate.
  const rootAnchored = await verifyCertSignedBy(suppliedRoot, pinnedRoot.spkiRaw, pinnedRoot.spkiCurve);
  if (!rootAnchored) {
    throw new AppleJwsVerificationError('supplied root certificate is not signed by the pinned Apple root key');
  }
  const intermediateSigned = await verifyCertSignedBy(intermediate, suppliedRoot.spkiRaw, suppliedRoot.spkiCurve);
  if (!intermediateSigned) {
    throw new AppleJwsVerificationError('intermediate certificate is not signed by the root');
  }
  const leafSigned = await verifyCertSignedBy(leaf, intermediate.spkiRaw, intermediate.spkiCurve);
  if (!leafSigned) {
    throw new AppleJwsVerificationError('leaf certificate is not signed by the intermediate');
  }

  // Outer JWS signature: ES256 = ECDSA P-256 + SHA-256, raw r||s (RFC 7518 §3.4).
  if (leaf.spkiCurve !== 'P-256') {
    throw new AppleJwsVerificationError('leaf certificate is not a P-256 key required for ES256');
  }
  const leafKey = await crypto.subtle.importKey(
    'spki',
    leaf.spkiRaw as unknown as ArrayBuffer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = b64urlToBytes(sigB64);
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    leafKey,
    sig as unknown as ArrayBuffer,
    signingInput as unknown as ArrayBuffer,
  );
  if (!valid) throw new AppleJwsVerificationError('invalid JWS signature');

  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64))) as T;
  } catch {
    throw new AppleJwsVerificationError('malformed JWS payload');
  }
}
