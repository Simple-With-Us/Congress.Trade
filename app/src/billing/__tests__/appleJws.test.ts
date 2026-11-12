import { describe, it, expect } from 'vitest';
import { verifyAppleSignedJws, AppleJwsVerificationError } from '../appleJws.ts';
import { parseCertificate } from '../appleCrypto.ts';
import { APPLE_ROOT_CA_G3_DER_B64 } from '../appleRootCert.ts';
import {
  buildAppleLikeChain,
  buildCert,
  generateEcKeyPair,
  signAppleJws,
  APPLE_INTERMEDIATE_MARKER_OID,
  APPLE_LEAF_MARKER_OID,
  type AppleLikeChain,
  type TestCert,
} from './appleCertFixtures.ts';

const FIXED_NOW = Date.parse('2025-06-01T00:00:00Z');

async function freshChain(): Promise<AppleLikeChain> {
  return buildAppleLikeChain({ notBefore: '2024-01-01T00:00:00Z', notAfter: '2034-01-01T00:00:00Z' });
}

describe('verifyAppleSignedJws', () => {
  it('accepts a well-formed chain anchored to the injected pinned root and returns the payload', async () => {
    const chain = await freshChain();
    const payload = { transactionId: 'tx-1', productId: 'trade.congress.premium.monthly' };
    const jws = await signAppleJws(chain, payload);

    const decoded = await verifyAppleSignedJws(jws, { pinnedRootB64: chain.root.b64, now: FIXED_NOW });
    expect(decoded).toEqual(payload);
  }, 15_000);

  it('accepts a chain that includes the root itself in x5c (self-signature anchor check)', async () => {
    const chain = await freshChain();
    const jws = await signAppleJws(
      chain,
      { hello: 'world' },
      { x5c: [chain.leaf.b64, chain.intermediate.b64, chain.root.b64] },
    );
    const decoded = await verifyAppleSignedJws(jws, { pinnedRootB64: chain.root.b64, now: FIXED_NOW });
    expect(decoded).toEqual({ hello: 'world' });
  }, 15_000);

  it('rejects when the chain does not anchor to the pinned root (wrong pin)', async () => {
    const chain = await freshChain();
    const otherChain = await freshChain(); // different root entirely
    const jws = await signAppleJws(chain, { x: 1 });
    await expect(
      verifyAppleSignedJws(jws, { pinnedRootB64: otherChain.root.b64, now: FIXED_NOW }),
    ).rejects.toThrow(AppleJwsVerificationError);
  }, 20_000);

  it('rejects a tampered payload (signature no longer matches)', async () => {
    const chain = await freshChain();
    const jws = await signAppleJws(chain, { amount: 5 });
    const [h, p, s] = jws.split('.');
    const tamperedPayload = btoa(JSON.stringify({ amount: 999999 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const tampered = `${h}.${tamperedPayload}.${s}`;
    await expect(
      verifyAppleSignedJws(tampered, { pinnedRootB64: chain.root.b64, now: FIXED_NOW }),
    ).rejects.toThrow(AppleJwsVerificationError);
  }, 15_000);

  it('rejects when a certificate in the chain is expired relative to `now`', async () => {
    const chain = await buildAppleLikeChain({ notBefore: '2020-01-01T00:00:00Z', notAfter: '2020-06-01T00:00:00Z' });
    const jws = await signAppleJws(chain, { ok: true });
    const wayLater = Date.parse('2026-01-01T00:00:00Z');
    await expect(
      verifyAppleSignedJws(jws, { pinnedRootB64: chain.root.b64, now: wayLater }),
    ).rejects.toThrow(/expired|not yet valid/);
  }, 15_000);

  it('rejects a non-ES256 alg header', async () => {
    const chain = await freshChain();
    const jws = await signAppleJws(chain, { x: 1 }, { alg: 'HS256' });
    await expect(
      verifyAppleSignedJws(jws, { pinnedRootB64: chain.root.b64, now: FIXED_NOW }),
    ).rejects.toThrow(/alg/);
  }, 15_000);

  it('rejects malformed JWS shapes', async () => {
    await expect(verifyAppleSignedJws('not-a-jws')).rejects.toThrow(AppleJwsVerificationError);
    await expect(verifyAppleSignedJws('a.b')).rejects.toThrow(AppleJwsVerificationError);
    await expect(verifyAppleSignedJws('')).rejects.toThrow(AppleJwsVerificationError);
  });

  it('rejects a chain with a broken link (intermediate not actually signed by root)', async () => {
    const chainA = await freshChain();
    const chainB = await freshChain();
    // Splice chain B's intermediate (a validly-shaped CA carrying the WWDR marker,
    // but signed by chain B's root) into chain A's chain, terminating at chain A's
    // pinned root. The structural policy passes; the intermediate<-root signature
    // link is what must fail.
    const jws = await signAppleJws(chainA, { x: 1 }, { x5c: [chainA.leaf.b64, chainB.intermediate.b64, chainA.root.b64] });
    await expect(
      verifyAppleSignedJws(jws, { pinnedRootB64: chainA.root.b64, now: FIXED_NOW }),
    ).rejects.toThrow(AppleJwsVerificationError);
  }, 20_000);

  it('the embedded production Apple Root CA - G3 constant parses as a valid, currently-in-window EC cert', () => {
    const root = parseCertificate(
      Uint8Array.from(atob(APPLE_ROOT_CA_G3_DER_B64), (c) => c.charCodeAt(0)),
    );
    expect(root.spkiCurve).toBe('P-384');
    expect(root.notBefore.getTime()).toBeLessThan(Date.now());
    expect(root.notAfter.getTime()).toBeGreaterThan(Date.now());
  });
});

/**
 * X.509 path-validation hardening. Before this, x5c verification did
 * signature-only chain linking with no role/usage/marker checks, so anyone
 * holding ANY Apple-issued end-entity certificate (which chains to the same
 * Apple Root CA - G3) could mint a forged leaf, sign an arbitrary
 * transaction/notification payload, and have it accepted — granting free
 * Premium via redeem_apple_purchase and forging EXPIRED/REVOKE webhooks against
 * any customer's originalTransactionId. Each fixture below is a chain the OLD
 * code accepted (all signatures valid) that MUST now be rejected.
 */
describe('verifyAppleSignedJws — X.509 path validation (forged-leaf exploit hardening)', () => {
  it('closes the exploit: a real Apple end-entity cert spliced into the intermediate slot is rejected even though every signature is valid and it chains to the exact pinned root', async () => {
    // Genuine Apple-shaped chain we trust the root of.
    const chain = await freshChain();

    // The attacker's own Apple-issued END-ENTITY certificate (e.g. a $99
    // developer / distribution / Apple Pay merchant cert): a NON-CA leaf that
    // Apple's root legitimately signed. Here it is signed directly by the
    // pinned root so that, absent the CA/keyUsage policy, the chain's signature
    // links would all verify — exposing the hole.
    const attackerKp = await generateEcKeyPair('P-256');
    const attackerEE: TestCert = await buildCert({
      subjectCn: 'Attacker Apple Developer Cert',
      issuerCn: 'Test Apple Root CA - G3',
      subjectKeyPair: attackerKp,
      issuerPrivateKey: chain.root.keyPair.privateKey,
      curve: 'P-256',
      sigHash: 'SHA-384',
      notBefore: '2024-01-01T00:00:00Z',
      notAfter: '2034-01-01T00:00:00Z',
      extensions: { basicConstraints: false }, // NOT a CA — the crux
    });

    // A forged StoreKit leaf the attacker mints, signed by their own EE key,
    // dressed with the App Store leaf marker to look legitimate.
    const forgedKp = await generateEcKeyPair('P-256');
    const forgedLeaf: TestCert = await buildCert({
      subjectCn: 'Forged StoreKit Leaf',
      issuerCn: 'Attacker Apple Developer Cert',
      subjectKeyPair: forgedKp,
      issuerPrivateKey: attackerKp.privateKey,
      curve: 'P-256',
      sigHash: 'SHA-256',
      notBefore: '2024-01-01T00:00:00Z',
      notAfter: '2034-01-01T00:00:00Z',
      extensions: { basicConstraints: false, markerOids: [APPLE_LEAF_MARKER_OID] },
    });

    const forgedChain: AppleLikeChain = { root: chain.root, intermediate: chain.intermediate, leaf: forgedLeaf };
    const jws = await signAppleJws(
      forgedChain,
      { transactionId: 'forged-1', productId: 'trade.congress.premium.monthly' },
      { x5c: [forgedLeaf.b64, attackerEE.b64, chain.root.b64] },
    );

    await expect(
      verifyAppleSignedJws(jws, { pinnedRootB64: chain.root.b64, now: FIXED_NOW }),
    ).rejects.toThrow(/basicConstraints CA:TRUE/);
  }, 25_000);

  it('rejects the literal exploit chain shape [forgedLeaf, attackerAppleCert, realIntermediate] — it never terminates at the pinned root', async () => {
    const chain = await freshChain();
    // Attacker EE signed by the genuine intermediate (as a real dev cert is).
    const attackerKp = await generateEcKeyPair('P-256');
    const attackerEE = await buildCert({
      subjectCn: 'Attacker Apple Developer Cert',
      issuerCn: 'Test Apple WWDR Intermediate',
      subjectKeyPair: attackerKp,
      issuerPrivateKey: chain.intermediate.keyPair.privateKey,
      curve: 'P-256',
      sigHash: 'SHA-384',
      notBefore: '2024-01-01T00:00:00Z',
      notAfter: '2034-01-01T00:00:00Z',
      extensions: { basicConstraints: false, markerOids: [APPLE_LEAF_MARKER_OID] },
    });
    const forgedKp = await generateEcKeyPair('P-256');
    const forgedLeaf = await buildCert({
      subjectCn: 'Forged StoreKit Leaf',
      issuerCn: 'Attacker Apple Developer Cert',
      subjectKeyPair: forgedKp,
      issuerPrivateKey: attackerKp.privateKey,
      curve: 'P-256',
      sigHash: 'SHA-256',
      notBefore: '2024-01-01T00:00:00Z',
      notAfter: '2034-01-01T00:00:00Z',
      extensions: { basicConstraints: false, markerOids: [APPLE_LEAF_MARKER_OID] },
    });
    const forgedChain: AppleLikeChain = { root: chain.root, intermediate: chain.intermediate, leaf: forgedLeaf };
    const jws = await signAppleJws(
      forgedChain,
      { transactionId: 'forged-2' },
      { x5c: [forgedLeaf.b64, attackerEE.b64, chain.intermediate.b64] },
    );
    await expect(
      verifyAppleSignedJws(jws, { pinnedRootB64: chain.root.b64, now: FIXED_NOW }),
    ).rejects.toThrow(/does not terminate at the pinned Apple Root CA - G3/);
  }, 25_000);

  it('rejects a CA:TRUE leaf (a signing leaf must be an end-entity certificate)', async () => {
    const chain = await buildAppleLikeChain({
      leafShape: { basicConstraints: true, keyCertSign: true, markerOids: [APPLE_LEAF_MARKER_OID] },
    });
    const jws = await signAppleJws(chain, { x: 1 });
    await expect(
      verifyAppleSignedJws(jws, { pinnedRootB64: chain.root.b64, now: FIXED_NOW }),
    ).rejects.toThrow(/leaf certificate asserts basicConstraints CA:TRUE/);
  }, 20_000);

  it('rejects a non-CA intermediate even when the marker OID is present', async () => {
    const chain = await buildAppleLikeChain({
      intermediateShape: { basicConstraints: false, keyCertSign: false, markerOids: [APPLE_INTERMEDIATE_MARKER_OID] },
    });
    const jws = await signAppleJws(chain, { x: 1 });
    await expect(
      verifyAppleSignedJws(jws, { pinnedRootB64: chain.root.b64, now: FIXED_NOW }),
    ).rejects.toThrow(/intermediate certificate is missing basicConstraints CA:TRUE/);
  }, 20_000);

  it('rejects an intermediate that is a CA but lacks keyUsage keyCertSign', async () => {
    const chain = await buildAppleLikeChain({
      intermediateShape: { basicConstraints: true, markerOids: [APPLE_INTERMEDIATE_MARKER_OID] }, // keyCertSign omitted
    });
    const jws = await signAppleJws(chain, { x: 1 });
    await expect(
      verifyAppleSignedJws(jws, { pinnedRootB64: chain.root.b64, now: FIXED_NOW }),
    ).rejects.toThrow(/intermediate certificate is missing keyUsage keyCertSign/);
  }, 20_000);

  it('rejects when the intermediate is missing the Apple WWDR marker OID', async () => {
    const chain = await buildAppleLikeChain({
      intermediateShape: { basicConstraints: true, keyCertSign: true }, // no marker
    });
    const jws = await signAppleJws(chain, { x: 1 });
    await expect(
      verifyAppleSignedJws(jws, { pinnedRootB64: chain.root.b64, now: FIXED_NOW }),
    ).rejects.toThrow(/missing the Apple WWDR marker/);
  }, 20_000);

  it('rejects when the leaf is missing the Apple App Store signing marker OID', async () => {
    const chain = await buildAppleLikeChain({
      leafShape: { basicConstraints: false }, // no leaf marker
    });
    const jws = await signAppleJws(chain, { x: 1 });
    await expect(
      verifyAppleSignedJws(jws, { pinnedRootB64: chain.root.b64, now: FIXED_NOW }),
    ).rejects.toThrow(/missing the Apple App Store signing marker/);
  }, 20_000);

  it('rejects an x5c chain of length 2 (missing root)', async () => {
    const chain = await freshChain();
    const jws = await signAppleJws(chain, { x: 1 }, { x5c: [chain.leaf.b64, chain.intermediate.b64] });
    await expect(
      verifyAppleSignedJws(jws, { pinnedRootB64: chain.root.b64, now: FIXED_NOW }),
    ).rejects.toThrow(/exactly 3 certificates/);
  }, 20_000);

  it('rejects an x5c chain of length 4', async () => {
    const chain = await freshChain();
    const jws = await signAppleJws(chain, { x: 1 }, {
      x5c: [chain.leaf.b64, chain.intermediate.b64, chain.root.b64, chain.root.b64],
    });
    await expect(
      verifyAppleSignedJws(jws, { pinnedRootB64: chain.root.b64, now: FIXED_NOW }),
    ).rejects.toThrow(/exactly 3 certificates/);
  }, 20_000);

  it('still accepts a fully valid, Apple-shaped 3-cert chain (positive control)', async () => {
    const chain = await freshChain();
    const payload = { transactionId: 'ok-1', productId: 'trade.congress.premium.yearly' };
    const jws = await signAppleJws(chain, payload);
    const decoded = await verifyAppleSignedJws(jws, { pinnedRootB64: chain.root.b64, now: FIXED_NOW });
    expect(decoded).toEqual(payload);
  }, 20_000);

  it('rejects a synthetic chain against the REAL embedded Apple Root CA - G3 (production default pin)', async () => {
    // No pinnedRootB64 override => the production pin (embedded Apple root) is used.
    // A synthetic root's public key can never equal Apple's, so the pin must reject.
    const chain = await freshChain();
    const jws = await signAppleJws(chain, { transactionId: 'synthetic-1' });
    await expect(verifyAppleSignedJws(jws, { now: FIXED_NOW })).rejects.toThrow(
      /does not terminate at the pinned Apple Root CA - G3/,
    );
  }, 20_000);
});
