import { describe, it, expect } from 'vitest';
import { parseCertificate, derEcdsaSignatureToRaw, verifyCertSignedBy, curveByteSize } from '../appleCrypto.ts';
import {
  buildAppleLikeChain,
  APPLE_INTERMEDIATE_MARKER_OID,
  APPLE_LEAF_MARKER_OID,
} from './appleCertFixtures.ts';

describe('parseCertificate', () => {
  it('extracts curve, validity window, and importable SPKI bytes for a P-384 root', async () => {
    const { root } = await buildAppleLikeChain({ notBefore: '2024-01-01T00:00:00Z', notAfter: '2030-01-01T00:00:00Z' });
    const parsed = parseCertificate(root.der);
    expect(parsed.spkiCurve).toBe('P-384');
    expect(parsed.notBefore.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(parsed.notAfter.toISOString()).toBe('2030-01-01T00:00:00.000Z');
    // The SPKI bytes must round-trip through WebCrypto's own importer.
    await expect(
      crypto.subtle.importKey('spki', parsed.spkiRaw as unknown as ArrayBuffer, { name: 'ECDSA', namedCurve: 'P-384' }, false, ['verify']),
    ).resolves.toBeTruthy();
  });

  it('extracts a P-256 leaf correctly', async () => {
    const { leaf } = await buildAppleLikeChain();
    const parsed = parseCertificate(leaf.der);
    expect(parsed.spkiCurve).toBe('P-256');
  });

  it('parses v3 extensions: CA certs expose isCa+keyCertSign, the leaf does not, and marker OIDs are surfaced', async () => {
    const { root, intermediate, leaf } = await buildAppleLikeChain();

    const parsedRoot = parseCertificate(root.der);
    expect(parsedRoot.isCa).toBe(true);
    expect(parsedRoot.keyCertSign).toBe(true);

    const parsedIntermediate = parseCertificate(intermediate.der);
    expect(parsedIntermediate.isCa).toBe(true);
    expect(parsedIntermediate.keyCertSign).toBe(true);
    expect(parsedIntermediate.hasKeyUsage).toBe(true);
    expect(parsedIntermediate.extensionOids).toContain(APPLE_INTERMEDIATE_MARKER_OID);

    const parsedLeaf = parseCertificate(leaf.der);
    expect(parsedLeaf.isCa).toBe(false); // end-entity: basicConstraints CA:FALSE
    expect(parsedLeaf.keyCertSign).toBe(false);
    expect(parsedLeaf.extensionOids).toContain(APPLE_LEAF_MARKER_OID);
    expect(parsedLeaf.extensionOids).not.toContain(APPLE_INTERMEDIATE_MARKER_OID);
  });

  it('treats a CA:TRUE basicConstraints leaf as a CA (so the chain verifier can reject it)', async () => {
    const { leaf } = await buildAppleLikeChain({
      leafShape: { basicConstraints: true, keyCertSign: true, markerOids: [APPLE_LEAF_MARKER_OID] },
    });
    const parsed = parseCertificate(leaf.der);
    expect(parsed.isCa).toBe(true);
    expect(parsed.keyCertSign).toBe(true);
  });

  it('defaults isCa/keyCertSign to false when a cert carries no such extensions', async () => {
    // A leaf built with no extensions at all — parser must not throw and must default safely.
    const { leaf } = await buildAppleLikeChain({ leafShape: {} });
    const parsed = parseCertificate(leaf.der);
    expect(parsed.isCa).toBe(false);
    expect(parsed.keyCertSign).toBe(false);
    expect(parsed.hasKeyUsage).toBe(false);
    expect(parsed.extensionOids).toEqual([]);
  });

  it('throws on truncated/garbage input', () => {
    expect(() => parseCertificate(new Uint8Array([0x30, 0x05, 0x01, 0x02]))).toThrow();
    expect(() => parseCertificate(new Uint8Array([]))).toThrow();
  });
});

describe('verifyCertSignedBy', () => {
  it('confirms a real issuer link and rejects a mismatched issuer key', async () => {
    const chainA = await buildAppleLikeChain();
    const chainB = await buildAppleLikeChain();
    const leaf = parseCertificate(chainA.leaf.der);
    const realIssuer = parseCertificate(chainA.intermediate.der);
    const wrongIssuer = parseCertificate(chainB.intermediate.der);

    await expect(verifyCertSignedBy(leaf, realIssuer.spkiRaw, realIssuer.spkiCurve)).resolves.toBe(true);
    await expect(verifyCertSignedBy(leaf, wrongIssuer.spkiRaw, wrongIssuer.spkiCurve)).resolves.toBe(false);
  }, 20_000);
});

describe('derEcdsaSignatureToRaw', () => {
  it('round-trips a DER SEQUENCE{r,s} into fixed-width raw r||s', () => {
    // r has a leading 0x00 sign-guard byte in DER (high bit of first real byte set);
    // s is a short value that must be left-padded to the curve width.
    const der = new Uint8Array([
      0x30, 0x08, // SEQUENCE, len 8
      0x02, 0x02, 0x00, 0x81, // INTEGER r = 00 81 (sign-guarded)
      0x02, 0x02, 0x00, 0x05, // INTEGER s = 00 05
    ]);
    const raw = derEcdsaSignatureToRaw(der, 4);
    expect(Array.from(raw)).toEqual([0x00, 0x00, 0x00, 0x81, 0x00, 0x00, 0x00, 0x05]);
  });

  it('throws on a non-SEQUENCE input', () => {
    expect(() => derEcdsaSignatureToRaw(new Uint8Array([0x02, 0x01, 0x01]), 32)).toThrow();
  });
});

describe('curveByteSize', () => {
  it('maps curves to their coordinate width', () => {
    expect(curveByteSize('P-256')).toBe(32);
    expect(curveByteSize('P-384')).toBe(48);
    expect(curveByteSize('P-521')).toBe(66);
  });
});
