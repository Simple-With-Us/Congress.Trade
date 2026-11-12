/**
 * src/ui/tickerLogos.ts
 * OWNER: dashboard agent
 *
 * Ticker → company-logo support. A cached server proxy resolves a symbol to a
 * PNG so the browser only ever sees `/api/logos/ticker?symbol=AAPL` (the logo
 * provider's key + allowed-referrer stay server-side, and the edge caches the
 * result). Source order is per ticker and per UI theme (tickerLogoPolicy.ts).
 * Themed local files (`assets/ticker-logos/{light|dark}/SYMBOL.png`) always win
 * when present. Otherwise: logo.dev, the unthemed repo pack, then GitHub —
 * unless a jury row pins GitHub first or drops a source.
 * Key: LOGODEV_PUBLISHABLE_KEY or LOGO_DEV_TOKEN.
 *
 * Empty/non-PNG "success" responses from logo.dev or GitHub are rejected so we
 * fall through instead of caching blank images that never fire img.onerror.
 *
 * The dashboard renders `<img src="/api/logos/ticker?symbol=AAPL">` and toggles
 * only the *framing* client-side (glass "tile" vs bare "transparent" vs "off").
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import { PUBLIC_ASSETS_DIR } from './assets.ts';
import {
  type LogoSource,
  type LogoTheme,
  type TickerLogoPolicyMap,
  sourceOrderFor,
} from './tickerLogoPolicy.ts';

const TICKER_LOGO_BASE_URL =
  'https://raw.githubusercontent.com/davidepalazzo/ticker-logos/main/ticker_icons';
const LOCAL_TICKER_LOGO_DIR = join(PUBLIC_ASSETS_DIR, 'assets/ticker-logos');
const SYMBOL_PATTERN = /^[A-Z0-9._^-]{1,20}$/;
// logo.dev publishable keys are locked to allowed domains; the proxy sends this
// as the Referer so a server-side fetch is accepted (the prod origin is allowed).
const LOGO_REFERER = 'https://congress.trade';

const ONE_DAY_SECONDS = 86_400;
const ONE_WEEK_SECONDS = 604_800;
/** Below this size a "PNG" is almost certainly empty/corrupt (real logos are larger). */
const MIN_PNG_BYTES = 64;

/** Optional alias when disclosure name ≠ public ticker / logo pack filename. */
const LOCAL_SYMBOL_ALIASES: Record<string, string> = {
  HONAV: 'HONAV', // Honeywell Aerospace (owner-supplied pack)
  SPCX: 'SPCX', // SpaceX private mark
  TSCO: 'TSCO',
  'BRK.B': 'BRK.B',
  BRKB: 'BRKB',
  'BRK-B': 'BRK-B',
};

/** Uppercase, strip a leading `$`, and reject anything that isn't a plausible symbol. */
export function normalizeTickerLogoSymbol(value: string | null | undefined): string | null {
  const symbol = value?.trim().replace(/^\$/, '').toUpperCase();
  if (!symbol || !SYMBOL_PATTERN.test(symbol)) return null;
  return symbol;
}

/** Repo filenames aren't always consistent for symbols like BRK.B — try variants. */
export function tickerLogoCandidates(value: string | null | undefined): string[] {
  const symbol = normalizeTickerLogoSymbol(value);
  if (!symbol) return [];
  return Array.from(
    new Set([
      symbol,
      symbol.replace(/\^/g, '-'),
      symbol.replace(/\^/g, '.'),
      symbol.replace(/\./g, '-'),
      symbol.replace(/-/g, '.'),
      symbol.replace(/[.^-]/g, '_'),
    ]),
  );
}

export function tickerLogoRawUrl(symbol: string): string {
  return `${TICKER_LOGO_BASE_URL}/${encodeURIComponent(symbol)}.png`;
}

/**
 * logo.dev ticker endpoint URL (PNG, dark by default, 404 on a true miss).
 *
 * WEBPERF-02: the largest rendered `.tkr-logo` box is 36px (.trades-card),
 * so `size=48&retina=true` (96px delivered) already covers ~2.7x DPI with
 * headroom, versus the previous `size=128` (256px) that was up to ~7x
 * oversized for the 22px table box. Format stays PNG (not webp) because
 * `isValidPngBytes`/`pngResponse` below, the repo pack, and the GitHub
 * fallback all assume PNG bytes and an `image/png` content-type; switching
 * format would need those three call sites (and their tests) reworked
 * together, so it is left as a follow-up rather than folded in here.
 */
export function logoDevUrl(symbol: string, token: string, theme: 'dark' | 'light' = 'dark'): string {
  return (
    `https://img.logo.dev/ticker/${encodeURIComponent(symbol)}` +
    `?token=${encodeURIComponent(token)}&format=png&theme=${theme}&size=48&retina=true&fallback=404`
  );
}

/** True when bytes look like a real PNG (magic + non-trivial size). */
export function isValidPngBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < MIN_PNG_BYTES) return false;
  // \x89PNG\r\n\x1a\n
  return (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function pngResponse(bytes: Uint8Array, source: string): Response {
  // Fresh ArrayBuffer-backed copy so Response accepts it under Deno/Node.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Response(copy, {
    headers: {
      'cache-control': `public, max-age=${ONE_DAY_SECONDS}, stale-while-revalidate=${ONE_WEEK_SECONDS}`,
      'content-type': 'image/png',
      'content-length': String(copy.byteLength),
      'x-logo-source': source,
    },
  });
}

/**
 * Read an upstream image response and keep only non-empty valid PNGs.
 * Rejects empty 200s / HTML error pages that would otherwise blank the UI
 * without firing img.onerror.
 */
export async function readValidPng(res: Response): Promise<Uint8Array | null> {
  if (!res.ok) return null;
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  // Allow missing CT (some CDNs omit it) but reject obvious non-images.
  if (ct && !ct.startsWith('image/') && !ct.includes('octet-stream')) return null;
  let buf: Uint8Array;
  try {
    buf = new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
  return isValidPngBytes(buf) ? buf : null;
}

function localTickerLogoFromDir(dir: string, symbol: string, sourcePrefix: string): Response | null {
  const names = new Set<string>([
    LOCAL_SYMBOL_ALIASES[symbol] ?? symbol,
    ...tickerLogoCandidates(symbol),
  ]);
  for (const name of names) {
    if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) continue;
    const abs = join(dir, `${name}.png`);
    if (!existsSync(abs)) continue;
    try {
      const buf = readFileSync(abs);
      const bytes = new Uint8Array(buf);
      if (!isValidPngBytes(bytes)) continue;
      return pngResponse(bytes, `${sourcePrefix}${name}.png`);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Repo pack. Theme subfolders (`light/`, `dark/`) win for that chrome;
 * unthemed `SYMBOL.png` is the gap-fill.
 */
export function tryLocalTickerLogo(symbol: string, theme?: LogoTheme): Response | null {
  if (theme) {
    const themed = localTickerLogoFromDir(
      join(LOCAL_TICKER_LOGO_DIR, theme),
      symbol,
      `local:ticker-logos/${theme}/`,
    );
    if (themed) return themed;
  }
  return localTickerLogoFromDir(LOCAL_TICKER_LOGO_DIR, symbol, 'local:ticker-logos/');
}

async function fetchLogoDevPng(
  symbol: string,
  token: string,
  theme: LogoTheme,
): Promise<Uint8Array | null> {
  const res = await trackedFetch(logoDevUrl(symbol, token, theme), {
    headers: { referer: LOGO_REFERER, accept: 'image/png,image/*;q=0.8,*/*;q=0.5' },
    cf: { cacheTtl: ONE_WEEK_SECONDS, cacheEverything: true },
  }, { service: 'asset-logo', operation: 'fetch-logo-primary' });
  return readValidPng(res);
}

async function fetchGithubTickerPng(symbol: string): Promise<Uint8Array | null> {
  for (const candidate of tickerLogoCandidates(symbol)) {
    let upstream: Response;
    try {
      upstream = await trackedFetch(tickerLogoRawUrl(candidate), {
        headers: { accept: 'image/png' },
        cf: { cacheTtl: ONE_WEEK_SECONDS, cacheEverything: true },
      }, { service: 'asset-logo', operation: 'fetch-logo-fallback' });
    } catch {
      continue;
    }
    const png = await readValidPng(upstream);
    if (png) return png;
  }
  return null;
}

export function parseForcedLogoSource(raw: string | null): LogoSource | null {
  if (raw === 'local' || raw === 'github' || raw === 'logodev') return raw;
  return null;
}

async function resolveLogoSource(
  source: LogoSource,
  symbol: string,
  theme: LogoTheme,
  logoDevToken: string | undefined,
  localMode: 'themed' | 'unthemed' | 'any',
): Promise<Response | null> {
  if (source === 'local') {
    if (localMode === 'themed') {
      return localTickerLogoFromDir(
        join(LOCAL_TICKER_LOGO_DIR, theme),
        symbol,
        `local:ticker-logos/${theme}/`,
      );
    }
    if (localMode === 'unthemed') {
      return localTickerLogoFromDir(LOCAL_TICKER_LOGO_DIR, symbol, 'local:ticker-logos/');
    }
    return tryLocalTickerLogo(symbol, theme);
  }
  if (source === 'logodev') {
    if (!logoDevToken) return null;
    try {
      const png = await fetchLogoDevPng(symbol, logoDevToken, theme);
      return png ? pngResponse(png, 'logo.dev') : null;
    } catch {
      return null;
    }
  }
  try {
    const png = await fetchGithubTickerPng(symbol);
    return png ? pngResponse(png, 'github:davidepalazzo/ticker-logos') : null;
  } catch {
    return null;
  }
}

/**
 * Cached proxy for a single ticker logo. Default order is logo.dev → local pack
 * → GitHub; jury policy (seed + CONFIG_KV overlay) can pin or drop sources per
 * theme. `?source=github|logodev|local` forces one provider (admin jury plates).
 * Long-lived cache headers only on real PNG successes; a genuine miss returns
 * a short-lived cacheable 204 so it doesn't error in the browser console.
 */
export async function handleTickerLogoRequest(
  url: URL,
  logoDevToken?: string,
  overlay?: TickerLogoPolicyMap,
): Promise<Response> {
  const symbol = normalizeTickerLogoSymbol(url.searchParams.get('symbol'));
  if (!symbol) {
    return new Response(JSON.stringify({ error: 'symbol is required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  const theme = url.searchParams.get('theme') === 'light' ? 'light' : 'dark';
  const forced = parseForcedLogoSource(url.searchParams.get('source'));
  const order = forced ? [forced] : sourceOrderFor(symbol, theme, overlay);

  if (!forced) {
    const themedLocal = await resolveLogoSource('local', symbol, theme, logoDevToken, 'themed');
    if (themedLocal) {
      themedLocal.headers.set('x-logo-policy', order.join(','));
      return themedLocal;
    }
  }

  for (const source of order) {
    const localMode = source === 'local' ? (forced ? 'any' : 'unthemed') : 'any';
    const hit = await resolveLogoSource(source, symbol, theme, logoDevToken, localMode);
    if (hit) {
      hit.headers.set('x-logo-policy', order.join(','));
      return hit;
    }
  }

  // Short cache on miss so a transient provider outage recovers quickly.
  return new Response(null, {
    // 204 (not 404) so a genuine miss doesn't error in the browser console;
    // short TTL so newly added pack/provider logos show up within minutes.
    status: 204,
    headers: { 'cache-control': `public, max-age=300` },
  });
}
