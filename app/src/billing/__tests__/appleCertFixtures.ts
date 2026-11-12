/**
 * Test-only DER/X.509 + JWS builder used to synthesize an Apple-shaped
 * certificate chain (root -> intermediate -> leaf) and ES256 x5c JWS
 * envelopes entirely in-process via WebCrypto, so appleCrypto/appleJws tests
 * never depend on an external `openssl` process or committed key material.
 *
 * NOT shipped: lives only under __tests__ and is never imported by app code.
 */

// ---- minimal DER encoder (inverse of appleCrypto's reader, encoder-only) --

function derLength(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concatBytes([new Uint8Array([tag]), derLength(content.length), content]);
}

function seq(...parts: Uint8Array[]): Uint8Array {
  return tlv(0x30, concatBytes(parts));
}

function derInt(unsignedBigEndian: Uint8Array): Uint8Array {
  let b = unsignedBigEndian;
  while (b.length > 1 && b[0] === 0x00) b = b.slice(1);
  const needsPad = b.length === 0 || (b[0] & 0x80) !== 0;
  const content = needsPad ? concatBytes([new Uint8Array([0x00]), b]) : b;
  return tlv(0x02, content);
}

function derOid(dotted: string): Uint8Array {
  const arcs = dotted.split('.').map(Number);
  const first = arcs[0] * 40 + arcs[1];
  const bytes: number[] = [first];
  for (const arc of arcs.slice(2)) {
    if (arc === 0) {
      bytes.push(0);
      continue;
    }
    const chunk: number[] = [];
    let v = arc;
    while (v > 0) {
      chunk.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    }
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, new Uint8Array(bytes));
}

function derBitString(raw: Uint8Array): Uint8Array {
  return tlv(0x03, concatBytes([new Uint8Array([0x00]), raw]));
}

function derBool(v: boolean): Uint8Array {
  return tlv(0x01, new Uint8Array([v ? 0xff : 0x00]));
}

function derOctetString(content: Uint8Array): Uint8Array {
  return tlv(0x04, content);
}

function derNull(): Uint8Array {
  return tlv(0x05, new Uint8Array([]));
}

// ---- X.509 v3 extension builders (encoder side of appleCrypto's parser) -----

/** Apple's custom marker OIDs, mirrored from appleJws for fixture construction. */
export const APPLE_INTERMEDIATE_MARKER_OID = '1.2.840.113635.100.6.2.1';
export const APPLE_LEAF_MARKER_OID = '1.2.840.113635.100.6.11.1';

/** Extension ::= SEQUENCE { extnID OID, critical BOOLEAN DEFAULT FALSE, extnValue OCTET STRING } */
function ext(oid: string, critical: boolean, valueDer: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [derOid(oid)];
  if (critical) parts.push(derBool(true));
  parts.push(derOctetString(valueDer));
  return seq(...parts);
}

/** basicConstraints: CA:TRUE -> SEQUENCE{cA=TRUE}; CA:FALSE -> empty SEQUENCE (cA defaults FALSE). */
function extBasicConstraints(isCa: boolean): Uint8Array {
  return ext('2.5.29.19', true, isCa ? seq(derBool(true)) : seq());
}

/** keyUsage BIT STRING with keyCertSign(bit5)+cRLSign(bit6) set — byte 0x06, 1 unused bit (matches Apple's CAs). */
function extKeyUsageKeyCertSign(): Uint8Array {
  return ext('2.5.29.15', true, tlv(0x03, new Uint8Array([0x01, 0x06])));
}

/** A non-critical marker extension whose extnID *is* the signal (extnValue = DER NULL). */
function extMarker(oid: string): Uint8Array {
  return ext(oid, false, derNull());
}

export interface CertExtensionShape {
  /** basicConstraints: true -> CA:TRUE, false -> CA:FALSE, undefined/'omit' -> extension absent. */
  basicConstraints?: boolean | 'omit';
  /** include a keyUsage extension asserting keyCertSign. */
  keyCertSign?: boolean;
  /** custom marker OID extensions to attach. */
  markerOids?: string[];
}

function buildExtensionsBlock(shape: CertExtensionShape): Uint8Array | null {
  const exts: Uint8Array[] = [];
  if (shape.basicConstraints === true) exts.push(extBasicConstraints(true));
  else if (shape.basicConstraints === false) exts.push(extBasicConstraints(false));
  if (shape.keyCertSign) exts.push(extKeyUsageKeyCertSign());
  for (const oid of shape.markerOids ?? []) exts.push(extMarker(oid));
  if (exts.length === 0) return null;
  // [3] EXPLICIT Extensions ::= SEQUENCE OF Extension
  return tlv(0xa3, seq(...exts));
}

function derGeneralizedTime(iso: string): Uint8Array {
  const d = new Date(iso);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const s =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return tlv(0x18, new TextEncoder().encode(s));
}

function derName(cn: string): Uint8Array {
  // RDNSequence with a single RDN: { commonName (2.5.4.3) = cn }
  const attr = seq(derOid('2.5.4.3'), tlv(0x0c, new TextEncoder().encode(cn))); // UTF8String
  return seq(tlv(0x31, attr)); // SET OF { SEQUENCE }
}

const SIG_ALG_OID: Record<string, string> = {
  'SHA-256': '1.2.840.10045.4.3.2',
  'SHA-384': '1.2.840.10045.4.3.3',
};

function rawEcdsaSigToDer(raw: Uint8Array): Uint8Array {
  const size = raw.length / 2;
  const r = raw.slice(0, size);
  const s = raw.slice(size, size * 2);
  return seq(derInt(r), derInt(s));
}

export interface TestCert {
  keyPair: CryptoKeyPair;
  der: Uint8Array;
  b64: string;
}

async function signTbs(tbs: Uint8Array, issuerPrivateKey: CryptoKey, hash: 'SHA-256' | 'SHA-384'): Promise<Uint8Array> {
  const rawSig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash }, issuerPrivateKey, tbs as unknown as ArrayBuffer),
  );
  return rawEcdsaSigToDer(rawSig);
}

/**
 * Build one EC-keyed, EC-signed X.509 certificate. `issuer` signs `subject`'s
 * key (pass `{ privateKey: subjectKeyPair.privateKey }` for a self-signed
 * cert, i.e. a root).
 */
export async function buildCert(opts: {
  subjectCn: string;
  issuerCn: string;
  subjectKeyPair: CryptoKeyPair;
  issuerPrivateKey: CryptoKey;
  curve: 'P-256' | 'P-384';
  sigHash: 'SHA-256' | 'SHA-384';
  notBefore: string;
  notAfter: string;
  serial?: number;
  /** X.509 v3 extensions to embed (basicConstraints/keyUsage/marker OIDs). */
  extensions?: CertExtensionShape;
}): Promise<TestCert> {
  // exportKey('spki', ...) already returns the COMPLETE, correctly-formed
  // SubjectPublicKeyInfo SEQUENCE (AlgorithmIdentifier + BIT STRING) — use it
  // verbatim as the TBSCertificate's spki field; do not re-wrap it.
  const spkiField = new Uint8Array(await crypto.subtle.exportKey('spki', opts.subjectKeyPair.publicKey));

  const version = tlv(0xa0, derInt(new Uint8Array([0x02]))); // [0] EXPLICIT INTEGER 2 (v3)
  const serial = derInt(new Uint8Array([0x01, opts.serial ?? 1]));
  const sigAlgId = seq(derOid(SIG_ALG_OID[opts.sigHash]));
  const issuer = derName(opts.issuerCn);
  const validity = seq(derGeneralizedTime(opts.notBefore), derGeneralizedTime(opts.notAfter));
  const subject = derName(opts.subjectCn);

  const tbsParts = [version, serial, sigAlgId, issuer, validity, subject, spkiField];
  const extBlock = opts.extensions ? buildExtensionsBlock(opts.extensions) : null;
  if (extBlock) tbsParts.push(extBlock);

  const tbs = seq(...tbsParts);
  const signature = await signTbs(tbs, opts.issuerPrivateKey, opts.sigHash);
  const der = seq(tbs, sigAlgId, derBitString(signature));

  let bin = '';
  for (const b of der) bin += String.fromCharCode(b);
  return { keyPair: opts.subjectKeyPair, der, b64: btoa(bin) };
}

export async function generateEcKeyPair(curve: 'P-256' | 'P-384'): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: curve }, true, ['sign', 'verify'])) as CryptoKeyPair;
}

export interface AppleLikeChain {
  root: TestCert;
  intermediate: TestCert;
  leaf: TestCert;
}

// Default Apple-shaped extension sets. A genuine chain has: a CA root, a CA
// intermediate carrying the WWDR marker OID, and an end-entity (non-CA) leaf
// carrying the App Store leaf marker OID. Negative fixtures override these.
const DEFAULT_ROOT_SHAPE: CertExtensionShape = { basicConstraints: true, keyCertSign: true };
const DEFAULT_INTERMEDIATE_SHAPE: CertExtensionShape = {
  basicConstraints: true,
  keyCertSign: true,
  markerOids: [APPLE_INTERMEDIATE_MARKER_OID],
};
const DEFAULT_LEAF_SHAPE: CertExtensionShape = {
  basicConstraints: false,
  markerOids: [APPLE_LEAF_MARKER_OID],
};

/**
 * Build a root(P-384)->intermediate(P-384)->leaf(P-256) chain mirroring Apple's
 * real shape, including the v3 extensions (basicConstraints, keyUsage, marker
 * OIDs) that path validation now requires. Per-cert `*Shape` overrides let a
 * test synthesize a specific malformed chain (e.g. a CA:TRUE leaf, a missing
 * marker OID, or a non-CA in the intermediate slot).
 */
export async function buildAppleLikeChain(opts: {
  notBefore?: string;
  notAfter?: string;
  rootShape?: CertExtensionShape;
  intermediateShape?: CertExtensionShape;
  leafShape?: CertExtensionShape;
} = {}): Promise<AppleLikeChain> {
  const notBefore = opts.notBefore ?? '2024-01-01T00:00:00Z';
  const notAfter = opts.notAfter ?? '2034-01-01T00:00:00Z';

  const rootKeyPair = await generateEcKeyPair('P-384');
  const root = await buildCert({
    subjectCn: 'Test Apple Root CA - G3',
    issuerCn: 'Test Apple Root CA - G3',
    subjectKeyPair: rootKeyPair,
    issuerPrivateKey: rootKeyPair.privateKey,
    curve: 'P-384',
    sigHash: 'SHA-384',
    notBefore,
    notAfter,
    extensions: opts.rootShape ?? DEFAULT_ROOT_SHAPE,
  });

  const interKeyPair = await generateEcKeyPair('P-384');
  const intermediate = await buildCert({
    subjectCn: 'Test Apple WWDR Intermediate',
    issuerCn: 'Test Apple Root CA - G3',
    subjectKeyPair: interKeyPair,
    issuerPrivateKey: rootKeyPair.privateKey,
    curve: 'P-384',
    sigHash: 'SHA-384',
    notBefore,
    notAfter,
    extensions: opts.intermediateShape ?? DEFAULT_INTERMEDIATE_SHAPE,
  });

  const leafKeyPair = await generateEcKeyPair('P-256');
  const leaf = await buildCert({
    subjectCn: 'Test StoreKit Leaf',
    issuerCn: 'Test Apple WWDR Intermediate',
    subjectKeyPair: leafKeyPair,
    issuerPrivateKey: interKeyPair.privateKey,
    curve: 'P-256',
    sigHash: 'SHA-256',
    notBefore,
    notAfter,
    extensions: opts.leafShape ?? DEFAULT_LEAF_SHAPE,
  });

  return { root, intermediate, leaf };
}

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Sign an ES256 x5c JWS over `payload` using the chain's leaf key. */
export async function signAppleJws(
  chain: AppleLikeChain,
  payload: Record<string, unknown>,
  opts: { x5c?: string[]; alg?: string } = {},
): Promise<string> {
  const header = {
    alg: opts.alg ?? 'ES256',
    // Apple's real x5c is length 3: [leaf, intermediate, root].
    x5c: opts.x5c ?? [chain.leaf.b64, chain.intermediate.b64, chain.root.b64],
  };
  const headerB64 = b64urlFromBytes(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = b64urlFromBytes(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      chain.leaf.keyPair.privateKey,
      signingInput as unknown as ArrayBuffer,
    ),
  );
  return `${headerB64}.${payloadB64}.${b64urlFromBytes(sig)}`;
}
