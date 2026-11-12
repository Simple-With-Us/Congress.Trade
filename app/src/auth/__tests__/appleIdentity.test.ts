import { describe, it, expect, beforeEach } from 'vitest';
import {
  verifyAppleIdentityToken,
  appleEmailIsVerified,
  AppleIdentityVerificationError,
  _resetAppleJwksCache,
  APPLE_ID_ISSUER,
} from '../appleIdentity.ts';

const CRYPTO_TEST_TIMEOUT_MS = 15_000;
const JWKS_URL = 'https://appleid.apple.com/auth/keys';

function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function jsonToB64url(obj: unknown): string {
  return bytesToB64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function makeKeypair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
}

async function signIdentityToken(payload: Record<string, unknown>, privateKey: CryptoKey, kid = 'k1', alg = 'RS256') {
  const header = jsonToB64url({ alg, kid, typ: 'JWT' });
  const body = jsonToB64url(payload);
  const signingInput = `${header}.${body}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${bytesToB64url(new Uint8Array(sig))}`;
}

async function jwksFor(publicKey: CryptoKey, kid = 'k1'): Promise<Response> {
  const jwk = (await crypto.subtle.exportKey('jwk', publicKey)) as JsonWebKey;
  return new Response(JSON.stringify({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }), { status: 200 });
}

const BUNDLE = 'trade.congress.ios';

describe('verifyAppleIdentityToken', () => {
  beforeEach(() => _resetAppleJwksCache());

  it('accepts a properly signed, on-issuer, on-audience token', async () => {
    const kp = await makeKeypair();
    const token = await signIdentityToken(
      { iss: APPLE_ID_ISSUER, aud: BUNDLE, exp: 4000, sub: 'apple-sub-1', email: 'a@example.com', email_verified: 'true' },
      kp.privateKey,
    );
    const claims = await verifyAppleIdentityToken(token, {
      bundleId: BUNDLE,
      jwksUrl: JWKS_URL,
      now: 1000,
      fetchImpl: async () => jwksFor(kp.publicKey),
    });
    expect(claims.sub).toBe('apple-sub-1');
    expect(appleEmailIsVerified(claims)).toBe(true);
  }, CRYPTO_TEST_TIMEOUT_MS);

  it('accepts aud as an array containing the bundle id', async () => {
    const kp = await makeKeypair();
    const token = await signIdentityToken(
      { iss: APPLE_ID_ISSUER, aud: [BUNDLE, 'other'], exp: 4000, sub: 's1' },
      kp.privateKey,
    );
    const claims = await verifyAppleIdentityToken(token, {
      bundleId: BUNDLE,
      jwksUrl: JWKS_URL,
      now: 1000,
      fetchImpl: async () => jwksFor(kp.publicKey),
    });
    expect(claims.sub).toBe('s1');
  }, CRYPTO_TEST_TIMEOUT_MS);

  it('rejects a token signed by a key Apple never published (bad signature)', async () => {
    const signer = await makeKeypair();
    const attacker = await makeKeypair();
    const token = await signIdentityToken(
      { iss: APPLE_ID_ISSUER, aud: BUNDLE, exp: 4000, sub: 's1' },
      attacker.privateKey,
    );
    await expect(
      verifyAppleIdentityToken(token, {
        bundleId: BUNDLE,
        jwksUrl: JWKS_URL,
        now: 1000,
        fetchImpl: async () => jwksFor(signer.publicKey),
      }),
    ).rejects.toThrow(AppleIdentityVerificationError);
  }, CRYPTO_TEST_TIMEOUT_MS);

  it('rejects a wrong issuer even with a valid signature', async () => {
    const kp = await makeKeypair();
    const token = await signIdentityToken(
      { iss: 'https://evil.example.com', aud: BUNDLE, exp: 4000, sub: 's1' },
      kp.privateKey,
    );
    await expect(
      verifyAppleIdentityToken(token, {
        bundleId: BUNDLE,
        jwksUrl: JWKS_URL,
        now: 1000,
        fetchImpl: async () => jwksFor(kp.publicKey),
      }),
    ).rejects.toThrow(/issuer/);
  }, CRYPTO_TEST_TIMEOUT_MS);

  it('rejects an audience/bundle id mismatch', async () => {
    const kp = await makeKeypair();
    const token = await signIdentityToken(
      { iss: APPLE_ID_ISSUER, aud: 'com.other.app', exp: 4000, sub: 's1' },
      kp.privateKey,
    );
    await expect(
      verifyAppleIdentityToken(token, {
        bundleId: BUNDLE,
        jwksUrl: JWKS_URL,
        now: 1000,
        fetchImpl: async () => jwksFor(kp.publicKey),
      }),
    ).rejects.toThrow(/audience/);
  }, CRYPTO_TEST_TIMEOUT_MS);

  it('rejects an expired token', async () => {
    const kp = await makeKeypair();
    const token = await signIdentityToken({ iss: APPLE_ID_ISSUER, aud: BUNDLE, exp: 500, sub: 's1' }, kp.privateKey);
    await expect(
      verifyAppleIdentityToken(token, {
        bundleId: BUNDLE,
        jwksUrl: JWKS_URL,
        now: 10_000,
        fetchImpl: async () => jwksFor(kp.publicKey),
      }),
    ).rejects.toThrow(/expired/);
  }, CRYPTO_TEST_TIMEOUT_MS);

  it('enforces a caller-supplied nonce match', async () => {
    const kp = await makeKeypair();
    const token = await signIdentityToken(
      { iss: APPLE_ID_ISSUER, aud: BUNDLE, exp: 4000, sub: 's1', nonce: 'expected-nonce' },
      kp.privateKey,
    );
    await expect(
      verifyAppleIdentityToken(token, {
        bundleId: BUNDLE,
        nonce: 'wrong-nonce',
        jwksUrl: JWKS_URL,
        now: 1000,
        fetchImpl: async () => jwksFor(kp.publicKey),
      }),
    ).rejects.toThrow(/nonce/);

    const claims = await verifyAppleIdentityToken(token, {
      bundleId: BUNDLE,
      nonce: 'expected-nonce',
      jwksUrl: JWKS_URL,
      now: 1000,
      fetchImpl: async () => jwksFor(kp.publicKey),
    });
    expect(claims.sub).toBe('s1');
  }, CRYPTO_TEST_TIMEOUT_MS);

  it('rejects a malformed token without ever fetching the JWKS', async () => {
    let fetched = false;
    await expect(
      verifyAppleIdentityToken('garbage-not-a-jwt', {
        bundleId: BUNDLE,
        jwksUrl: JWKS_URL,
        now: 1000,
        fetchImpl: async () => {
          fetched = true;
          return new Response('{}', { status: 200 });
        },
      }),
    ).rejects.toThrow(AppleIdentityVerificationError);
    expect(fetched).toBe(false);
  });

  it('rejects a token missing the sub claim', async () => {
    const kp = await makeKeypair();
    const token = await signIdentityToken({ iss: APPLE_ID_ISSUER, aud: BUNDLE, exp: 4000 }, kp.privateKey);
    await expect(
      verifyAppleIdentityToken(token, {
        bundleId: BUNDLE,
        jwksUrl: JWKS_URL,
        now: 1000,
        fetchImpl: async () => jwksFor(kp.publicKey),
      }),
    ).rejects.toThrow(/sub/);
  }, CRYPTO_TEST_TIMEOUT_MS);
});

describe('appleEmailIsVerified', () => {
  it('treats boolean true and string "true" as verified', () => {
    expect(appleEmailIsVerified({ email_verified: true })).toBe(true);
    expect(appleEmailIsVerified({ email_verified: 'true' })).toBe(true);
    expect(appleEmailIsVerified({ email_verified: false })).toBe(false);
    expect(appleEmailIsVerified({ email_verified: 'false' })).toBe(false);
    expect(appleEmailIsVerified({})).toBe(false);
  });
});
