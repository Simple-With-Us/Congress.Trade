/**
 * src/ui/assets.ts
 * OWNER: dashboard agent
 *
 * Binary brand/icon/font assets live as real files under `app/public/` and are
 * served by ui/routes.ts with long cache headers. This module loads those
 * files once (via node:fs — works under Deno and Vitest) so the TypeScript
 * bundle no longer embeds multi-megabyte base64 strings.
 *
 * Issue #1040: extract base64 from dashboardHtml/assets.ts to static routes.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface StaticAsset {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** Directory containing committed binary assets (relative to this module). */
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../public');

/**
 * CT-2418: content fingerprint for a generated text asset, used as the `?v=`
 * cache-busting query on its URL.
 *
 * The dashboard CSS and JS are served `immutable` for a year, which is the whole
 * point (a repeat visit costs nothing) but means a deploy must change something
 * the client can see. Folding a fingerprint of the bytes into the query string
 * gives a deploy a fresh immutable URL, so it invalidates exactly the files that
 * changed instead of stranding returning visitors on last month's CSS.
 *
 * FNV-1a 32-bit, not a cryptographic hash: this only has to change when the
 * content changes, and it has to be synchronous (module-load time, and the
 * worker has no sync crypto).
 */
export function assetVersion(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    // 16777619 (FNV prime), kept in 32-bit range without BigInt.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function loadAsset(relativePath: string, contentType: string): StaticAsset {
  const abs = join(PUBLIC_DIR, relativePath);
  const buf = readFileSync(abs);
  // Always copy into a standalone Uint8Array (Buffer is a Uint8Array subclass
  // in Node; Deno's node:fs also returns Buffer-compatible bytes).
  return { bytes: new Uint8Array(buf), contentType };
}

// Font + brand images (immutable-cache routes under /assets/*).
export const ZILLA_SLAB_WOFF2 = loadAsset('assets/zilla-slab-700.woff2', 'font/woff2');
// Self-hosted Inter (QABUGHUNT-01 / WEBPERF-01): the body font used to be
// pulled from a Google Fonts <link> whose axis tuple 400s the whole
// stylesheet (see dashboardHtml.ts), so Inter has NEVER actually loaded on
// production — every visitor silently gets the system fallback stack.  These
// five static weights (latin subset only, matching the weights the CSS
// actually uses) are the same gstatic.com woff2 bytes Google Fonts would
// have served, vendored here so the face can never 400 again and so the
// third-party request (and the CSP exceptions it required) goes away.
export const INTER_400_WOFF2 = loadAsset('assets/inter-400.woff2', 'font/woff2');
export const INTER_500_WOFF2 = loadAsset('assets/inter-500.woff2', 'font/woff2');
export const INTER_600_WOFF2 = loadAsset('assets/inter-600.woff2', 'font/woff2');
export const INTER_700_WOFF2 = loadAsset('assets/inter-700.woff2', 'font/woff2');
export const INTER_800_WOFF2 = loadAsset('assets/inter-800.woff2', 'font/woff2');
export const EAGLE_SPLASH_PNG = loadAsset('assets/eagle-splash.png', 'image/png');
export const BRAND_LOGO_PNG = loadAsset('assets/brand-logo.png', 'image/png');
export const BRAND_LOGO_DARK_PNG = loadAsset('assets/brand-logo-dark.png', 'image/png');
export const BRAND_LOGO_LIGHT_PNG = loadAsset('assets/brand-logo-light.png', 'image/png');
export const SWU_LOGO_WEBP = loadAsset('swu-logo-wide.webp', 'image/webp');
export const SIMPLE_WITH_US_WEBP = loadAsset('assets/simple-with-us.webp', 'image/webp');

// Well-known root icons / social cards (long cache, stable paths).
// Context-specific OG cards share the site heading lockup (CONGRESS + eagle + TRADE)
// over a small eyebrow label and a stylised, non-person-specific impression of
// the product (stacked panels of KPI tiles / trade rows / buy-sell columns).
// Regenerate all four with `scripts/render-og-cards.sh` and bump
// OG_IMAGE_VERSION below so crawler caches pick the new art up.
export const OG_IMAGE_PNG = loadAsset('og-image.png', 'image/png');
export const OG_IMAGE_TRENDS_PNG = loadAsset('og-image-trends.png', 'image/png');
export const OG_IMAGE_COMPANY_PNG = loadAsset('og-image-company.png', 'image/png');
export const OG_IMAGE_POLITICIAN_PNG = loadAsset('og-image-politician.png', 'image/png');
export const ICON_192_PNG = loadAsset('icon-192.png', 'image/png');
export const ICON_512_PNG = loadAsset('icon-512.png', 'image/png');
export const APPLE_TOUCH_ICON_PNG = loadAsset('apple-touch-icon.png', 'image/png');
/** Favicon bytes (PNG content; served at /favicon.ico with image/png). */
export const FAVICON_PNG = loadAsset('favicon.png', 'image/png');

/** Cache-bust query for og:image URLs. Bump when regenerating social cards. */
export const OG_IMAGE_VERSION = '24';

/** Absolute path to the public asset root (for tests / tooling). */
export const PUBLIC_ASSETS_DIR = PUBLIC_DIR;

export const SITE_WEBMANIFEST = JSON.stringify({
  name: 'Congress.Trade',
  short_name: 'Congress.Trade',
  description: 'STOCK Act disclosures from the House, Senate, and Executive Branch, plus premium webhooks.',
  start_url: '/',
  display: 'standalone',
  background_color: '#08111f',
  theme_color: '#08111f',
  icons: [
    { src: '/icon-192.png?v=10', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png?v=10', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});
