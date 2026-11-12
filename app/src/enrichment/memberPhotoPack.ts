/**
 * src/enrichment/memberPhotoPack.ts
 * OWNER: enrichment
 *
 * Our own repository of member faces.
 *
 * Before this existed, every member photo was a hotlink to
 * `unitedstates.github.io/images/congress/450x550/{bioguide}.jpg` — which is a
 * fine public-domain source but has three problems:
 *
 *   1. it only covers people with a bioguide, so every executive-branch filer
 *      (cabinet secretaries, agency heads, Senate-confirmed nominees) was a
 *      permanent gap;
 *   2. a handful of bioguides 404 there, and the dashboard's
 *      `onerror="this.remove()"` hid the breakage instead of reporting it; and
 *   3. the framing is a 450x550 head-and-torso portrait, so in a circular row
 *      avatar the face ends up small and off-centre.
 *
 * The pack fixes all three: `scripts/member-photos/build_face_pack.py` crops
 * every source portrait to a square, head-focused 256px WebP and commits it to
 * `app/public/assets/member-photos/` alongside a `manifest.json` recording, per
 * face, the original source URL and its licence — see that script and
 * `sources.json`. The licence is a RECORD, not a gate (owner decision,
 * 2026-08): public domain is preferred but no longer required to ship, so a
 * face's `attribution`/`licence` are not proof it is free to display. Whether
 * the recorded `attributionCaption` is surfaced at all is a single
 * manifest-level flag (`attributionDisplayEnabled`, default OFF) — read it via
 * `attributionDisplayEnabled()` and `visibleAttributionCaption()` below rather
 * than reading `attributionCaption` unconditionally.
 *
 * What the flag actually does today, precisely: with it ON, every pack-served
 * photo carries an `x-photo-attribution` response header with that face's
 * credit line; with it OFF, no header. That is the whole of it. **There is no
 * visible caption anywhere in the web UI or the SwiftUI clients yet** — no
 * template and no client response renders a credit line under an avatar. So
 * the flag is a real, wired lever over what we serve, but it is not by itself
 * a complete "now we display attribution" answer: a UI that wants a visible
 * credit line still has to be built, and when it is, it must call
 * `visibleAttributionCaption()` rather than reading the raw field, so the flag
 * keeps governing every surface at once.
 *
 * Serving mirrors `ui/tickerLogos.ts`: one cached proxy route so the client
 * only ever sees `/api/photos/member?key=…`, the pack answers first, and a
 * bioguide key that is not in the pack falls back to the upstream CDN rather
 * than 404ing. A genuine miss is a short-cached 204, not an error.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

const PACK_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../public/assets/member-photos');
const MANIFEST_PATH = join(PACK_DIR, 'manifest.json');

/** Pack keys are a bioguide id (congress) or a person slug (executive). */
const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/i;
/** Filenames the pack is allowed to read: a bare image name, no path parts. */
const SAFE_PACK_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(webp|png|jpe?g)$/;

const UPSTREAM_CONGRESS = 'https://unitedstates.github.io/images/congress';
export const LEGISLATOR_PHOTO_SIZE = '450x550';

const ONE_DAY_SECONDS = 86_400;
const ONE_WEEK_SECONDS = 604_800;
const ONE_YEAR_SECONDS = 31_536_000;
/** Below this a "WebP"/"JPEG" is almost certainly empty or truncated. */
const MIN_IMAGE_BYTES = 64;

export interface MemberFace {
  key: string;
  name: string;
  branch: 'congress' | 'executive';
  bioguide: string | null;
  filerIds: string[];
  file: string;
  sourceUrl: string;
  sourcePage: string | null;
  licence: string;
  /** 0 (public domain, best) .. 3 (everything else). Ranking only — see facepack.licence_tier. */
  licenceTier: number;
  attribution: string | null;
  /** Ready-to-use "Author — Licence, via Site" credit line. ALWAYS captured, regardless of
   *  licenceTier — never render this directly; go through `visibleAttributionCaption()` so the
   *  display flag is honoured. */
  attributionCaption: string | null;
  cropMode: string;
  bytes: number;
  sha256: string;
}

interface PackIndex {
  byKey: Map<string, MemberFace>;
  byFilerId: Map<string, MemberFace>;
  totalBytes: number;
  /** Whether callers should actually SHOW `attributionCaption` to end users. Default OFF (owner
   *  decision, 2026-08) — flip via `build_face_pack.py --set-attribution-display on`, a
   *  manifest-only patch that needs no rebuild. */
  attributionDisplayEnabled: boolean;
}

let cachedIndex: PackIndex | null = null;

function emptyIndex(): PackIndex {
  return { byKey: new Map(), byFilerId: new Map(), totalBytes: 0, attributionDisplayEnabled: false };
}

/**
 * Read + index the committed manifest once per process.
 *
 * A missing or malformed manifest is not fatal: the pack is an optimisation
 * over the upstream CDN, so an empty index degrades to today's behaviour
 * rather than taking member photos down.
 */
export function memberPhotoPack(): PackIndex {
  if (cachedIndex) return cachedIndex;
  cachedIndex = emptyIndex();
  try {
    if (!existsSync(MANIFEST_PATH)) return cachedIndex;
    const parsed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
      faces?: MemberFace[];
      attributionDisplayEnabled?: boolean;
    };
    cachedIndex.attributionDisplayEnabled = parsed.attributionDisplayEnabled === true;
    for (const face of parsed.faces ?? []) {
      if (!face?.key || !face?.file) continue;
      cachedIndex.byKey.set(face.key, face);
      cachedIndex.totalBytes += Number(face.bytes) || 0;
      for (const filerId of face.filerIds ?? []) {
        if (filerId && !cachedIndex.byFilerId.has(filerId)) cachedIndex.byFilerId.set(filerId, face);
      }
    }
  } catch {
    cachedIndex = emptyIndex();
  }
  return cachedIndex;
}

/** Whether the recorded `attributionCaption` is surfaced at all right now — today that means the
 *  `x-photo-attribution` response header, not a visible caption. Default OFF. */
export function attributionDisplayEnabled(): boolean {
  return memberPhotoPack().attributionDisplayEnabled;
}

/**
 * `face.attributionCaption` gated by the display flag — this is what any
 * surfacing code should call, never `face.attributionCaption` directly, so the
 * flag governs every call site at once instead of needing an audit.
 *
 * Live callers today: `tryLocalMemberPhoto` only, which turns the result into
 * the `x-photo-attribution` response header. Note that pack images are cached
 * for a year, so a flag flip changes what the origin serves immediately but
 * reaches already-cached clients only as their copies expire.
 */
export function visibleAttributionCaption(face: MemberFace | null | undefined): string | null {
  if (!face || !attributionDisplayEnabled()) return null;
  return face.attributionCaption ?? null;
}

export function packFaceForKey(key: string | null | undefined): MemberFace | null {
  const normalized = normalizeMemberPhotoKey(key);
  return normalized ? memberPhotoPack().byKey.get(normalized) ?? null : null;
}

/** Every packed face that names at least one filer id (executive-branch fills). */
export function packFacesWithFilerIds(): MemberFace[] {
  return [...memberPhotoPack().byKey.values()].filter((f) => (f.filerIds ?? []).length > 0);
}

export function packFaceForFilerId(filerId: string | null | undefined): MemberFace | null {
  const id = (filerId ?? '').trim();
  return id ? memberPhotoPack().byFilerId.get(id) ?? null : null;
}

/** Reject anything that is not a plain key — no traversal, no separators. */
export function normalizeMemberPhotoKey(value: string | null | undefined): string | null {
  const key = (value ?? '').trim();
  if (!key || key.includes('..') || key.includes('/') || key.includes('\\')) return null;
  return KEY_PATTERN.test(key) ? key : null;
}

/** Upstream public-domain congressional portrait for a bioguide. */
export function upstreamCongressPhotoUrl(bioguide: string, size = LEGISLATOR_PHOTO_SIZE): string {
  return `${UPSTREAM_CONGRESS}/${size}/${bioguide}.jpg`;
}

/**
 * Absolute URL for a packed face.
 *
 * Absolute, not relative: `photo_url` is handed to the SwiftUI clients as-is,
 * and a path-only value would not resolve there.
 */
export function memberPhotoUrl(key: string, baseUrl: string): string {
  const origin = (baseUrl || 'https://congress.trade').replace(/\/+$/, '');
  return `${origin}/api/photos/member?key=${encodeURIComponent(key)}`;
}

/** True when a stored photo_url already points at this deployment's pack route. */
export function isMemberPhotoPackUrl(value: string | null | undefined): boolean {
  return /\/api\/photos\/member\?key=/.test((value ?? '').trim());
}

/** Pack key encoded in a pack URL, if it is one. */
export function packKeyFromUrl(value: string | null | undefined): string | null {
  const match = /\/api\/photos\/member\?key=([^&\s]+)/.exec((value ?? '').trim());
  if (!match) return null;
  try {
    return normalizeMemberPhotoKey(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

function contentTypeFor(file: string): string {
  if (file.endsWith('.webp')) return 'image/webp';
  if (file.endsWith('.png')) return 'image/png';
  return 'image/jpeg';
}

function imageResponse(
  bytes: Uint8Array,
  contentType: string,
  source: string,
  maxAge: number,
  attribution?: string | null,
): Response {
  // Fresh ArrayBuffer-backed copy so Response accepts it under Deno and Node.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const headers: Record<string, string> = {
    'cache-control': `public, max-age=${maxAge}, stale-while-revalidate=${ONE_WEEK_SECONDS}`,
    'content-type': contentType,
    'content-length': String(copy.byteLength),
    'x-photo-source': source,
  };
  // Header values are latin-1 on the wire; captions carry em dashes and
  // accented author names, so strip anything outside that range rather than
  // letting a non-ASCII credit line throw and take the whole photo down.
  if (attribution) headers['x-photo-attribution'] = toHeaderSafe(attribution);
  return new Response(copy, { headers });
}

/** Collapse a caption to a header-safe single line (printable ASCII, no CR/LF). */
function toHeaderSafe(value: string): string {
  return value
    .replace(/[‐-―]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 512);
}

/** Read the committed file for a pack entry, or null when it is missing/empty. */
export function tryLocalMemberPhoto(key: string): Response | null {
  const face = packFaceForKey(key);
  if (!face) return null;
  // The manifest is committed alongside the images, but it is still data read
  // off disk — never let a filename in it escape the pack directory.
  if (!SAFE_PACK_FILE.test(face.file)) return null;
  const abs = join(PACK_DIR, face.file);
  if (!existsSync(abs)) return null;
  try {
    const bytes = new Uint8Array(readFileSync(abs));
    if (bytes.byteLength < MIN_IMAGE_BYTES) return null;
    // Faces are content-addressed by the manifest and only change when the pack
    // is rebuilt and redeployed, so they can be cached for a year.
    return imageResponse(
      bytes,
      contentTypeFor(face.file),
      `pack:${face.file}`,
      ONE_YEAR_SECONDS,
      visibleAttributionCaption(face),
    );
  } catch {
    return null;
  }
}

/** Bioguide-shaped keys can still be answered by the upstream CDN. */
function bioguideFromKey(key: string): string | null {
  return /^[A-Z]\d{6}$/i.test(key) ? key.toUpperCase() : null;
}

/**
 * `GET /api/photos/member?key=…` — pack first, upstream congressional CDN
 * second, short-cached 204 on a genuine miss.
 */
export async function handleMemberPhotoRequest(url: URL): Promise<Response> {
  const key = normalizeMemberPhotoKey(url.searchParams.get('key'));
  if (!key) {
    return new Response(JSON.stringify({ error: 'key is required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const local = tryLocalMemberPhoto(key);
  if (local) return local;

  const bioguide = bioguideFromKey(key);
  if (bioguide) {
    try {
      const upstream = await trackedFetch(
        upstreamCongressPhotoUrl(bioguide),
        {
          headers: { accept: 'image/jpeg,image/*;q=0.8' },
          cf: { cacheTtl: ONE_WEEK_SECONDS, cacheEverything: true },
        },
        { service: 'asset-photo', operation: 'fetch-member-photo-upstream' },
      );
      if (upstream.ok) {
        const contentType = (upstream.headers.get('content-type') ?? '').toLowerCase();
        if (!contentType || contentType.startsWith('image/')) {
          const bytes = new Uint8Array(await upstream.arrayBuffer());
          if (bytes.byteLength >= MIN_IMAGE_BYTES) {
            return imageResponse(bytes, contentType || 'image/jpeg', 'upstream:unitedstates', ONE_DAY_SECONDS);
          }
        }
      }
    } catch {
      /* fall through to the miss response */
    }
  }

  // 204 (not 404) so a genuine miss does not error in the browser console, and
  // a short TTL so a newly built pack shows up within minutes.
  return new Response(null, { status: 204, headers: { 'cache-control': 'public, max-age=300' } });
}
