/**
 * src/enrichment/__tests__/memberPhotoPack.test.ts
 *
 * The face pack is data read off disk and served to the public, so the tests
 * that matter are the ones that stop it doing something bad: reading outside
 * the pack directory, shipping an image with no recorded licence, or handing
 * the SwiftUI clients a URL they cannot resolve.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attributionDisplayEnabled,
  handleMemberPhotoRequest,
  isMemberPhotoPackUrl,
  memberPhotoPack,
  memberPhotoUrl,
  normalizeMemberPhotoKey,
  packFaceForFilerId,
  packFaceForKey,
  packFacesWithFilerIds,
  packKeyFromUrl,
  tryLocalMemberPhoto,
  upstreamCongressPhotoUrl,
  visibleAttributionCaption,
} from '../memberPhotoPack.ts';

const PACK_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../public/assets/member-photos',
);

describe('member photo pack key handling', () => {
  it('accepts bioguide ids and person slugs', () => {
    expect(normalizeMemberPhotoKey('B001300')).toBe('B001300');
    expect(normalizeMemberPhotoKey('  scott-bessent ')).toBe('scott-bessent');
  });

  it('rejects path traversal and separators', () => {
    for (const bad of ['../secrets', 'a/b', 'a\\b', '..', '', null, undefined, 'has space']) {
      expect(normalizeMemberPhotoKey(bad)).toBeNull();
    }
  });
});

describe('member photo URLs', () => {
  it('builds an absolute URL — a relative one would not resolve on iOS', () => {
    const url = memberPhotoUrl('B001300', 'https://congress.trade');
    expect(url).toBe('https://congress.trade/api/photos/member?key=B001300');
    expect(url.startsWith('https://')).toBe(true);
  });

  it('tolerates a trailing slash on the base URL', () => {
    expect(memberPhotoUrl('x-y', 'https://example.test/')).toBe(
      'https://example.test/api/photos/member?key=x-y',
    );
  });

  it('round-trips the key and recognises its own URLs', () => {
    const url = memberPhotoUrl('scott-bessent', 'https://congress.trade');
    expect(isMemberPhotoPackUrl(url)).toBe(true);
    expect(packKeyFromUrl(url)).toBe('scott-bessent');
    expect(isMemberPhotoPackUrl(upstreamCongressPhotoUrl('B001300'))).toBe(false);
    expect(packKeyFromUrl(upstreamCongressPhotoUrl('B001300'))).toBeNull();
  });
});

describe('committed pack contents', () => {
  const pack = memberPhotoPack();

  it('has faces indexed by key', () => {
    expect(pack.byKey.size).toBeGreaterThan(100);
  });

  it('records a source URL and a licence for every face — no unattributed images', () => {
    for (const face of pack.byKey.values()) {
      expect(face.sourceUrl, `${face.key} has no source URL`).toMatch(/^https:\/\//);
      expect(face.licence, `${face.key} has no licence`).toBeTruthy();
    }
  });

  it('every manifest entry has its file on disk, and vice versa', () => {
    for (const face of pack.byKey.values()) {
      expect(existsSync(join(PACK_DIR, face.file)), `${face.file} missing`).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(join(PACK_DIR, 'manifest.json'), 'utf8'));
    expect(manifest.faces.length).toBe(pack.byKey.size);
  });

  it('stays small — a repo full of large portraits is its own problem', () => {
    // 256px WebP faces average ~7KB. A regression to full-size portraits would
    // blow straight through this.
    expect(pack.totalBytes / pack.byKey.size).toBeLessThan(30_000);
    expect(pack.totalBytes).toBeLessThan(8_000_000);
  });

  it('captures a licence and an attribution caption for every face, PD or not — capture is unconditional', () => {
    for (const face of pack.byKey.values()) {
      expect(face.attributionCaption, `${face.key} has no attributionCaption`).toBeTruthy();
      expect(typeof face.licenceTier, `${face.key} has no licenceTier`).toBe('number');
    }
  });

  it('indexes executive faces by filer id', () => {
    const withFilers = packFacesWithFilerIds();
    expect(withFilers.length).toBeGreaterThan(0);
    const sample = withFilers.find((f) => f.branch === 'executive');
    expect(sample).toBeTruthy();
    expect(packFaceForFilerId(sample!.filerIds[0])?.key).toBe(sample!.key);
  });

  it('does not resolve an unknown key or filer id', () => {
    expect(packFaceForKey('definitely-not-a-member')).toBeNull();
    expect(packFaceForFilerId('NOT-A-FILER')).toBeNull();
    expect(packFaceForFilerId('')).toBeNull();
  });
});

describe('attribution display flag', () => {
  it('defaults OFF — the committed manifest ships with display disabled', () => {
    expect(attributionDisplayEnabled()).toBe(false);
  });

  it('never surfaces a caption while the flag is off, even for a real face with a caption', () => {
    const withCaption = [...memberPhotoPack().byKey.values()].find((f) => !!f.attributionCaption);
    expect(withCaption).toBeTruthy();
    expect(visibleAttributionCaption(withCaption)).toBeNull();
  });

  it('returns null for a missing face without throwing', () => {
    expect(visibleAttributionCaption(null)).toBeNull();
    expect(visibleAttributionCaption(undefined)).toBeNull();
  });
});

/**
 * The flag is only worth having if flipping it changes what we actually serve.
 * These two assert the wiring end to end — flag OFF, no header; flag ON, the
 * face's real caption on the real response — so the "flip the flag" remedy
 * cannot silently rot back into a no-op.
 */
describe('attribution display flag drives the served response', () => {
  const packedKeyWithCaption = () =>
    [...memberPhotoPack().byKey.values()].find((f) => !!f.attributionCaption)!.key;

  it('omits x-photo-attribution while the flag is off', async () => {
    expect(attributionDisplayEnabled()).toBe(false);
    const res = await handleMemberPhotoRequest(
      new URL(`https://x.test/api/photos/member?key=${packedKeyWithCaption()}`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-photo-attribution')).toBeNull();
  });

  it('emits the face’s caption as x-photo-attribution once the flag is on', async () => {
    const index = memberPhotoPack();
    const key = packedKeyWithCaption();
    const face = index.byKey.get(key)!;
    index.attributionDisplayEnabled = true;
    try {
      const res = await handleMemberPhotoRequest(
        new URL(`https://x.test/api/photos/member?key=${key}`),
      );
      expect(res.status).toBe(200);
      const header = res.headers.get('x-photo-attribution');
      expect(header).toBeTruthy();
      // Header values are latin-1, so an em dash or an accented author name is
      // downgraded rather than allowed to throw — but the substantive words of
      // the credit line must survive, and the result must stay header-legal.
      expect(header).toMatch(/^[\x20-\x7E]*$/);
      expect(header!.length).toBeLessThanOrEqual(512);
      for (const word of face.attributionCaption!.split(/[^A-Za-z0-9.]+/).filter((w) => w.length > 3)) {
        expect(header, `caption word "${word}" missing from header`).toContain(word);
      }
    } finally {
      index.attributionDisplayEnabled = false;
    }
  });
});

describe('handleMemberPhotoRequest', () => {
  it('400s without a key', async () => {
    const res = await handleMemberPhotoRequest(new URL('https://x.test/api/photos/member'));
    expect(res.status).toBe(400);
  });

  it('serves a packed face with an immutable-ish cache and the right content type', async () => {
    const key = [...memberPhotoPack().byKey.keys()][0];
    const res = await handleMemberPhotoRequest(
      new URL(`https://x.test/api/photos/member?key=${key}`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('x-photo-source')).toContain('pack:');
    expect(Number(res.headers.get('content-length'))).toBeGreaterThan(64);
  });

  it('204s (not 404s) on a genuine miss so the browser console stays clean', async () => {
    // Deliberately not bioguide-shaped, so no upstream fetch is attempted.
    const res = await handleMemberPhotoRequest(
      new URL('https://x.test/api/photos/member?key=nobody-by-this-name'),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('cache-control')).toContain('max-age=300');
  });

  it('400s on a traversal attempt rather than reading outside the pack', async () => {
    const res = await handleMemberPhotoRequest(
      new URL('https://x.test/api/photos/member?key=..%2F..%2Fmanifest.json'),
    );
    expect(res.status).toBe(400);
    expect(tryLocalMemberPhoto('../../manifest.json')).toBeNull();
  });
});
