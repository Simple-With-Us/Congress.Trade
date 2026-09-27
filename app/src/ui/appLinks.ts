/**
 * src/ui/appLinks.ts
 * OWNER: dashboard agent
 *
 * WEB half of iOS Universal Links.  This file serves the Apple App Site
 * Association (AASA) manifest that lets iOS associate `congress.trade` with
 * the native app (`CC8UTF7ATG.trade.congress.ios`), and — once the app has a
 * public App Store id — injects the Smart App Banner meta tag on the
 * dashboard page.  Neither piece opens the app by itself.  Universal links
 * stay DARK (a congress.trade link keeps opening Safari, not the app) until
 * the iOS half also ships: the `com.apple.developer.associated-domains`
 * entitlement plus an `NSUserActivity` / `onContinueUserActivity` handler in
 * `clients/ios/CongressTrade/App.swift`.  That is a different seat's work —
 * see the handoff note in the PR that introduced this file.
 */

import type { Hono, MiddlewareHandler } from 'hono';
import type { Env } from '../shared/types.ts';

/**
 * `<Team ID>.<Bundle ID>` from the Apple Developer Portal — fixed by
 * `clients/ios/CLAUDE.md` ("Team: CC8UTF7ATG", "Bundle ID: trade.congress.ios"),
 * not a value this file can derive or should ever guess.
 */
const IOS_APP_ID = 'CC8UTF7ATG.trade.congress.ios';

/**
 * Modern `components` format, not the legacy `paths` array: every entity URL
 * on this site is a QUERY STRING on `/` (`?member=`, `?ticker=`, `?trade=`,
 * `?view=`) and `paths` can only match a pathname pattern — it has no way to
 * express a query-string requirement at all, so it silently cannot match any
 * link this site actually generates.
 *
 * `exclude: true` components run first and win outright: `/auth/*` is the
 * `ASWebAuthenticationSession` surface Google/Apple sign-in opens in an
 * ephemeral in-app browser, and `/api/*` is the JSON API. An associated
 * domain that swallowed either would either break sign-in (the OS would try
 * to hand the session-only web view a `congress.trade` URL to the app
 * instead of letting the auth flow complete) or make plain API calls from
 * Safari/curl behave unpredictably. A bare `/` with no matching query is
 * deliberately NOT matched by any component below: home-page links keep
 * opening Safari unless they carry one of the four entity params, so sharing
 * the root URL never yanks a reader into the app.
 */
function buildAasaDocument(): Record<string, unknown> {
  return {
    applinks: {
      details: [
        {
          appIDs: [IOS_APP_ID],
          components: [
            { '/': '/auth/*', exclude: true },
            { '/': '/api/*', exclude: true },
            { '/': '/', '?': { member: '?*' } },
            { '/': '/', '?': { ticker: '?*' } },
            { '/': '/', '?': { trade: '?*' } },
            { '/': '/', '?': { view: '?*' } },
          ],
        },
      ],
    },
  };
}

/** Served body — computed once at module load; the document is static. */
export const AASA_JSON = JSON.stringify(buildAasaDocument());

/**
 * Cache duration for the AASA response. iOS's own fetch/refresh cycle for
 * associated-domains manifests is undocumented and out of our control either
 * way, so this header mainly governs any reverse proxy in front of the
 * origin and direct debugging fetches. The `/assets/*` pattern elsewhere in
 * this router uses a year-long `immutable` cache because those URLs are
 * content-hashed — a stale cache is never wrong because the URL itself would
 * change first. This file has no such hash: a future edit (e.g. adding a new
 * query param to match) would sit behind a year-long cache before any layer
 * that respects the header would pick it up. One hour is long enough that
 * the rarely-hit route doesn't cost much, short enough that a manifest fix
 * reaches production the same day it ships.
 */
const AASA_CACHE_CONTROL = 'public, max-age=3600';

/**
 * Single source of truth for "is there a real App Store id configured".
 * Both the native `apple-itunes-app` meta tag (`appStoreBannerTag`, shipped
 * in PR #2076) and the custom banner below (`appStoreBannerMarkup` /
 * `appStoreBannerHeadExtras`) gate on this ONE switch — there must never be
 * a second env var or a second validity check that could drift from it.
 *
 * Reads `env.IOS_APP_STORE_ID` — a plain optional var, the same
 * absent-by-default shape every other optional integration in
 * `shared/types.ts` already uses (e.g. `LOGODEV_PUBLISHABLE_KEY`). The app
 * record exists (App Store id 6798076688, bundle `trade.congress.ios`) but
 * version 1.0.0 is REJECTED and the app is not downloadable today, so there
 * is no id this function should invent or default to — leaving the var
 * unset is exactly what keeps both banners correctly dark; setting it once
 * a version is Approved lights them both up with no code change.
 */
function validAppStoreId(env: Env): string | null {
  const id = (env.IOS_APP_STORE_ID || '').trim();
  return /^\d+$/.test(id) ? id : null;
}

/**
 * Resolve the public TestFlight or App Store link for the iOS app.
 * Prefers explicit IOS_TESTFLIGHT_URL or IOS_BETA_URL, falls back to
 * the App Store URL when IOS_APP_STORE_ID is set, or the verified app invitation.
 */
export function testFlightUrl(env?: Env): string {
  const custom = (env?.IOS_TESTFLIGHT_URL || env?.IOS_BETA_URL || '').trim();
  if (custom) {
    try {
      const url = new URL(custom);
      const invite = url.hostname === 'testflight.apple.com' && /^\/join\/[A-Za-z0-9]+\/?$/.test(url.pathname);
      const store = url.hostname === 'apps.apple.com' && /^\/(?:[a-z]{2}\/)?app\/(?:[^/]+\/)?id[0-9]+\/?$/.test(url.pathname);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port && (invite || store)) return custom;
    } catch {
      // Invalid configured links fall through to an available app-specific destination.
    }
  }
  const appId = env ? validAppStoreId(env) : null;
  if (appId) return `https://apps.apple.com/app/id${appId}`;
  return 'https://testflight.apple.com/join/VNUEU6Ge';
}

/**
 * Build the native Smart App Banner meta tag, or `null` when no App Store id
 * is configured yet. Honored only by Mobile Safari on iOS/iPadOS.
 */
export function appStoreBannerTag(env: Env): string | null {
  const id = validAppStoreId(env);
  return id ? `<meta name="apple-itunes-app" content="app-id=${id}" />` : null;
}

/**
 * CSS + a before-paint detection script for the CUSTOM banner (below), or
 * `null` when dark. Lives in `<head>` for two reasons:
 *
 * 1. CSS-in-`<head>` means the banner's layout is resolved by the FIRST
 *    layout pass of `<body>` — there is no client-side height change after
 *    paint, so no CLS, matching the "reserve height before paint" bar.
 * 2. The detection script mirrors the existing `ui-theme` pre-paint IIFE a
 *    few lines above this file's other `<head>` injection point (see
 *    `dashboardHtml.ts` around the `data-theme` attribute): it runs
 *    synchronously, before `<body>` is parsed, and stamps two data
 *    attributes on `<html>` that the CSS below reads. By the time the
 *    browser lays out `#app-store-banner`, both attributes already reflect
 *    their final state — nothing toggles visibility after the fact.
 *
 *    - `data-asb-dismissed="1"` — this visitor already closed the banner
 *      (localStorage, versioned key so a future relaunch can re-show it).
 *    - `data-asb-native-context="1"` — Apple's OWN Smart App Banner (driven
 *      by the `apple-itunes-app` meta tag above) can render here, so showing
 *      ours too would stack two banners. That tag is honored ONLY by Mobile
 *      Safari on iOS/iPadOS — not Chrome/Firefox/Edge/etc. on iOS (all of
 *      which are WebKit wrappers that still say "Safari" in their UA string,
 *      so they need to be told apart by their OWN app token, not by
 *      "Safari"'s presence), and not desktop Safari (no touch, so it never
 *      matches `isIOSDevice` below). The check fails safe TOWARD suppressing
 *      the custom banner: any iOS-shaped device (`iPad|iPhone|iPod`, or
 *      iPadOS reporting as `MacIntel` with `maxTouchPoints > 1`) is treated
 *      as native-banner context UNLESS its UA carries a token proving it is
 *      one of the specific browsers known NOT to honor the meta tag; an
 *      unrecognized iOS browser, or any error reading `navigator` at all,
 *      also resolves to "native context" (suppressed), never to "show ours".
 */
export function appStoreBannerHeadExtras(env: Env): string | null {
  if (!validAppStoreId(env)) return null;
  return `<style>
  #app-store-banner {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 14px; background: var(--panel); color: var(--text);
    border-bottom: 1px solid var(--border); position: relative; z-index: 11;
  }
  #app-store-banner .asb-close {
    flex: 0 0 auto; width: 26px; height: 26px; padding: 0;
    display: flex; align-items: center; justify-content: center;
    border: none; border-radius: 6px; background: transparent;
    color: var(--text-dim); font-size: 20px; line-height: 1; cursor: pointer;
  }
  #app-store-banner .asb-close:hover { background: var(--panel-2); color: var(--text); }
  #app-store-banner .asb-close:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  #app-store-banner .asb-icon { flex: 0 0 auto; width: 40px; height: 40px; border-radius: 9px; border: 1px solid var(--border); }
  #app-store-banner .asb-copy { flex: 1 1 auto; min-width: 0; }
  #app-store-banner .asb-name { font-weight: 700; font-size: 13px; color: var(--text); }
  #app-store-banner .asb-sub { font-size: 11px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #app-store-banner .asb-cta {
    flex: 0 0 auto; padding: 7px 16px; border-radius: var(--radius-pill);
    background: var(--accent); color: #fff; font-weight: 600; font-size: 13px; text-decoration: none;
  }
  #app-store-banner .asb-cta:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  /* Custom banner is a mobile affordance (matches the site's own
     max-width:768px mobile breakpoint used for header.top elsewhere) — it
     never renders on desktop widths, where there is no App Store app to
     hand off to anyway. */
  @media (min-width: 769px) { #app-store-banner { display: none; } }
  html[data-asb-dismissed="1"] #app-store-banner,
  html[data-asb-native-context="1"] #app-store-banner { display: none; }
</style>
<script>
  (function () {
    try {
      if (localStorage.getItem('asb-dismissed-v1')) {
        document.documentElement.setAttribute('data-asb-dismissed', '1');
      }
    } catch (e) {}
    try {
      var ua = navigator.userAgent || '';
      var isIOSDevice = /iPad|iPhone|iPod/.test(ua) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (isIOSDevice) {
        var knownNonSafariOnIOS = /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA|Firefox|OPR\\//i.test(ua);
        if (!knownNonSafariOnIOS) {
          document.documentElement.setAttribute('data-asb-native-context', '1');
        }
      }
    } catch (e) {
      // Can't read navigator --- assume native-banner context and stay dark
      // rather than risk stacking a duplicate banner.
      document.documentElement.setAttribute('data-asb-native-context', '1');
    }
  })();
</script>`;
}

/**
 * The custom banner's markup, or `null` when dark. Spliced in as the very
 * first child of `<body>` (see `appStoreBannerMiddleware`) — before
 * `<header class="top">` — so it sits above the site header in normal
 * document flow (not `position:sticky`/`fixed`), matching the familiar iOS
 * Smart App Banner shape: close control, icon, name + one supporting line,
 * CTA on the right. Reuses the already-served `/icon-192.png` (see
 * `assets.ts` / `routes.ts`) rather than inventing new artwork.
 */
export function appStoreBannerMarkup(env: Env): string | null {
  const id = validAppStoreId(env);
  if (!id) return null;
  return `<div id="app-store-banner">
  <button type="button" class="asb-close" aria-label="Dismiss App Store banner" onclick="try{localStorage.setItem('asb-dismissed-v1','1')}catch(e){};document.documentElement.setAttribute('data-asb-dismissed','1')">&times;</button>
  <img class="asb-icon" src="/icon-192.png?v=10" width="40" height="40" alt="" decoding="async" />
  <div class="asb-copy">
    <div class="asb-name">Congress.Trade</div>
    <div class="asb-sub">Live Trades tab, alerts &amp; more.&nbsp; Get it on the App Store.</div>
  </div>
  <a class="asb-cta" href="https://apps.apple.com/app/id${id}" target="_blank" rel="noopener noreferrer">View</a>
</div>`;
}

/**
 * Post-process an already-rendered HTML response to splice in BOTH the
 * native Smart App Banner meta tag (right after `<head>`) and the custom
 * banner's CSS/script (also in `<head>`, immediately after that same meta
 * tag) and markup (as the first child of `<body>`, right after `<body>`).
 * Runs on both `/` and `/admin` (the same `DASHBOARD_HTML` document, per
 * `renderDashboard` in `routes.ts`).
 *
 * MUST be registered with `r.use(...)` BEFORE `routes.ts` registers
 * `r.get('/', …)` / `r.get('/admin', …)` — `mountAppLinks` is called at the
 * very top of `buildUiRouter()` for exactly this reason. Hono composes
 * same-path handlers in registration order, and a route handler that returns
 * without calling `next()` (which `c.html()` / `c.body()` always do) ends the
 * chain there; a `use()` registered AFTER it would simply never run.
 */
const appStoreBannerMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await next();
  const tag = appStoreBannerTag(c.env);
  if (!tag || !c.res) return;
  const contentType = c.res.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return;
  let html = await c.res.text();
  const headExtras = appStoreBannerHeadExtras(c.env) || '';
  html = html.replace('<head>', `<head>\n${tag}\n${headExtras}`);
  const bodyMarkup = appStoreBannerMarkup(c.env);
  if (bodyMarkup) html = html.replace('<body>', `<body>\n${bodyMarkup}`);
  c.res = new Response(html, c.res);
};

/**
 * Mount both pieces onto the dashboard router. Call this ONE line at the top
 * of `buildUiRouter()`, before any other route is registered (see the
 * ordering note on `appStoreBannerMiddleware` above).
 */
export function mountAppLinks(r: Hono<{ Bindings: Env }>): void {
  // `.well-known/apple-app-site-association` is the only path iOS 9+ fetches
  // for Universal Links; this app's deployment target is iOS 17
  // (`clients/ios/CongressTrade.xcodeproj/project.pbxproj`), well past the
  // iOS 8 era when an unprefixed root-level `/apple-app-site-association`
  // fallback mattered. Serving only the canonical `.well-known` path avoids
  // a second copy of this manifest that could ever drift from the first.
  r.get('/.well-known/apple-app-site-association', (c) =>
    c.body(AASA_JSON, 200, {
      'content-type': 'application/json',
      'cache-control': AASA_CACHE_CONTROL,
    }));

  r.use('/', appStoreBannerMiddleware);
  r.use('/admin', appStoreBannerMiddleware);
}
