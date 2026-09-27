/**
 * src/ui/routes.ts
 * OWNER: dashboard agent
 *
 * Hono router that serves the static dashboard document at `/` and `/admin`.
 * Both routes render the same single-page app (DASHBOARD_HTML); the admin
 * panels are reachable via the in-page tabs, so `/admin` is simply a convenient
 * deep-link entry point. The page talks to the JSON API mounted under /api and
 * /api/admin by the delivery + admin agents.
 *
 * Mounted by index.ts at the root, e.g. `root.route('/', buildUiRouter())`.
 */

import { Hono } from 'hono';
import type { Env } from '../shared/types.ts';
import { DASHBOARD_HTML } from './dashboardHtml.ts';
import { TOS_HTML, PRIVACY_HTML } from './legalHtml.ts';
import { getLogoDisplay } from '../shared/settings.ts';
import {
  APPLE_TOUCH_ICON_PNG,
  BRAND_LOGO_DARK_PNG,
  BRAND_LOGO_LIGHT_PNG,
  BRAND_LOGO_PNG,
  EAGLE_SPLASH_PNG,
  FAVICON_PNG,
  ICON_192_PNG,
  ICON_512_PNG,
  INTER_400_WOFF2,
  INTER_500_WOFF2,
  INTER_600_WOFF2,
  INTER_700_WOFF2,
  INTER_800_WOFF2,
  OG_IMAGE_COMPANY_PNG,
  OG_IMAGE_PNG,
  OG_IMAGE_POLITICIAN_PNG,
  OG_IMAGE_TRENDS_PNG,
  SITE_WEBMANIFEST,
  SWU_LOGO_WEBP,
  ZILLA_SLAB_WOFF2,
  type StaticAsset,
} from './assets.ts';
import { applyOgMeta, resolveOgMeta, SITE } from './ogMeta.ts';
import { mountAppLinks, testFlightUrl } from './appLinks.ts';
import { DEFAULT_EXECUTIVE_TITLE, executiveTitleFor } from '../shared/executiveTitles.ts';
import { getSitemapXml } from './sitemap.ts';
import { TICKER_RESOLVED_SQL } from '../analytics/sql.ts';
import { getDatadogInitInput } from '../shared/datadog.ts';
import { resolveDatadogRum } from '../shared/datadogRuntime.ts';
import { renderDatadogRumScript } from '../shared/datadogRum.ts';
import { renderSentryBrowserScript } from '../shared/sentryBrowser.ts';

/**
 * Analytics injection was removed (CT-AUD-P1-15).
 *
 * Every page shipped `<script src="https://www.googletagmanager.com/gtag/js?id=…">`
 * with a HARDCODED default measurement id, while the CSP has long been
 * `script-src 'self' 'unsafe-inline'` with `connect-src 'self'`. The browser
 * blocked both the tag and its collection calls, so it never produced a single
 * data point — it only cost a request attempt and a CSP violation on every page
 * load, for every visitor, including anyone self-hosting this code.
 *
 * Re-enabling it is a deliberate PRIVACY decision, not a config change: it needs
 * an owner-chosen measurement id (never a hardcoded default), explicit CSP
 * entries for googletagmanager.com and google-analytics.com, a consent surface,
 * and a privacy-policy update. Until those exist, shipping nothing is the
 * honest behaviour.
 */
/** What a politician share card needs about a filer: who they are and their seat. */
type MemberShareIdentity = {
  displayName: string | null;
  /** Pre-formatted seat descriptor for `resolveOgMeta`'s `memberDistrict`. */
  district: string | null;
};

/**
 * Format a filer's seat as the compact descriptor politician share cards render
 * in parentheses after the name — `D-CA-17`, `R-AL-Sen`, `D-DE-AL`, `President`.
 *
 * Shape notes, all confirmed against live `filers` rows:
 *   - `party` is a full word ('Democrat' / 'Republican' / 'Independent') or NULL
 *     for ~14% of filers, so the initial is optional rather than assumed.
 *   - `district` is NULL for senators and executive-branch filers, and the
 *     STRING '0' for at-large House seats (AK, DE, VT, WY, …) — '0' must render
 *     'AL', never a literal district zero.
 *   - Executive-branch filers hold a POSITION rather than a district seat
 *     ('President', 'Treasury Secretary', …). That title lives only in the
 *     curated `shared/executiveTitles.ts` map — neither the OGE source nor the
 *     `filers` schema captures it — and is keyed by the `EXEC-*` filer id,
 *     which IS `filers.bioguide_id` for these rows (see the roster join
 *     `f.bioguide_id = t.filer_id` in delivery/rest.ts).
 *   - Executive rows may still carry a `state` (e.g. EXEC-MCCORMICK / PA), so
 *     the chamber must be checked BEFORE the state, or a cabinet official
 *     would render a congressional-looking `R-PA` seat they never held.
 *
 * Exported for unit tests; there is no D1 dependency in here on purpose.
 */
export function formatMemberSeat(
  filerId: string | null | undefined,
  chamber: string | null | undefined,
  party: string | null | undefined,
  state: string | null | undefined,
  district: string | null | undefined,
): string | null {
  const ch = (chamber || '').trim().toLowerCase();
  const st = (state || '').trim().toUpperCase();

  // Executive branch: show the position, never a district and never the word
  // "Executive" (owner 2026-08-10 — "just say their position"). An uncurated
  // EXEC-* filer falls back to a bare name rather than the module's generic
  // 'Executive Branch' default, which would be exactly the label to avoid.
  if (ch === 'executive' || (filerId || '').startsWith('EXEC-')) {
    const title = executiveTitleFor((filerId || '').trim());
    return title && title !== DEFAULT_EXECUTIVE_TITLE ? title : null;
  }

  // Congressional: a seat needs a state to be meaningful.
  if (!st) return null;

  const partyInitial = (party || '').trim().charAt(0).toUpperCase();
  const dist = (district || '').trim();

  let seat = '';
  if (ch === 'senate') {
    seat = 'Sen';
  } else if (dist) {
    // '0' (and '00') are the at-large encodings, not a district numbered zero.
    seat = /^0+$/.test(dist) ? 'AL' : dist.replace(/^0+(?=\d)/, '');
  }

  return [partyInitial, st, seat].filter(Boolean).join('-');
}

/** Best-effort filer identity for politician share cards (never throws). */
async function lookupMemberShareIdentity(env: Env, memberId: string): Promise<MemberShareIdentity> {
  const empty: MemberShareIdentity = { displayName: null, district: null };
  const id = memberId.trim();
  if (!id || !env.DB) return empty;
  try {
    const row = await env.DB
      .prepare(
        'SELECT full_name, chamber, party, state, district FROM filers ' +
          'WHERE LOWER(bioguide_id) = LOWER(?) LIMIT 1',
      )
      .bind(id)
      .first<{
        full_name: string | null;
        chamber: string | null;
        party: string | null;
        state: string | null;
        district: string | null;
      }>();
    if (!row) return empty;
    return {
      displayName: row.full_name?.trim() || null,
      district: formatMemberSeat(id, row.chamber, row.party, row.state, row.district),
    };
  } catch {
    return empty;
  }
}

/** SEOSOCIAL-06: same shape check `sitemap.ts` uses so a malformed ?ticker=
 *  value never even reaches the DB. */
const TICKER_QUERY_FORMAT = /^[A-Z][A-Z0-9.\-]{0,9}$/;

/** Whether ?ticker= names a security that has actually traded (never
 *  throws) — gates the company share card so arbitrary query text can't be
 *  echoed back as branded og:title/og:description (SEOSOCIAL-06). */
async function lookupTickerResolved(env: Env, ticker: string): Promise<boolean> {
  const t = ticker.trim().toUpperCase();
  if (!t || !TICKER_QUERY_FORMAT.test(t) || !env.DB) return false;
  try {
    const row = await env.DB
      .prepare(`SELECT 1 FROM transactions WHERE ${TICKER_RESOLVED_SQL} AND ticker = ? LIMIT 1`)
      .bind(t)
      .first();
    return !!row;
  } catch {
    return false;
  }
}

/** TS port of the client's fmtBracketAmount (dashboardHtml.ts) — kept
 *  side-by-side rather than shared since one is server TS and the other a
 *  string literal inside the browser-JS template; a unit test on each side
 *  pins them to the same output for the STOCK Act bracket range this
 *  actually sees (four figures to eight). */
function formatBracketAmount(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const clean = (v: string) => v.replace(/\.0$/, '');
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}t`;
  if (abs >= 1e9) return `${sign}$${clean((abs / 1e9).toFixed(abs >= 10e9 ? 0 : 1))}b`;
  if (abs >= 1e6) return `${sign}$${clean((abs / 1e6).toFixed(abs >= 10e6 ? 0 : 1))}m`;
  if (abs >= 1e3) return `${sign}$${clean((abs / 1e3).toFixed(abs >= 10e3 ? 0 : 1))}k`;
  return `${sign}$${Math.round(abs)}`;
}

/** "$1k - $15k" / "$1m - $5m" — the STOCK Act disclosure bracket, formatted
 *  the same way the client's amountText() renders it in the trade drawer. */
function formatAmountBracket(min: number | null, max: number | null): string {
  if (min == null && max == null) return 'an undisclosed amount';
  return `${formatBracketAmount(min)} - ${max == null ? '+' : formatBracketAmount(max)}`;
}

/** "Aug 5, 2026" from a 'YYYY-MM-DD' tx_date — UTC so the date never shifts
 *  a day depending on the server's local timezone. */
function formatShareTxDate(txDate: string | null): string {
  const d = txDate ? new Date(`${txDate}T00:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime())) return 'an undisclosed date';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(d);
}

type TradeShareRow = {
  tx_type: string | null;
  ticker: string | null;
  asset_name: string | null;
  amount_min: number | null;
  amount_max: number | null;
  tx_date: string | null;
  filer_id: string | null;
  full_name: string | null;
  chamber: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
};

/** Best-effort trade share summary for the ?trade= permalink card
 *  (SEOSOCIAL-05, never throws) — mirrors the "bought/sold/traded" wording
 *  delivery/rest.ts's RSS feed already uses, and SEOSOCIAL-06's rule that an
 *  unresolved id (bad/deleted trade) gets no card, not an echoed one. */
async function lookupTradeShareSummary(
  env: Env,
  tradeId: string,
): Promise<{
  filerLabel: string | null;
  verb: 'bought' | 'sold' | 'traded';
  assetLabel: string;
  amountBracket: string;
  txDateLabel: string;
} | null> {
  const id = tradeId.trim();
  if (!id || !env.DB) return null;
  try {
    const row = await env.DB
      .prepare(
        'SELECT t.tx_type, t.ticker, t.asset_name, t.amount_min, t.amount_max, t.tx_date, t.filer_id, ' +
          'f.full_name, f.chamber, f.party, f.state, f.district ' +
          'FROM transactions t LEFT JOIN filers f ON f.bioguide_id = t.filer_id ' +
          'WHERE t.id = ? LIMIT 1',
      )
      .bind(id)
      .first<TradeShareRow>();
    if (!row) return null;

    const verb: 'bought' | 'sold' | 'traded' =
      row.tx_type === 'B' || row.tx_type === 'P' ? 'bought' : row.tx_type === 'S' ? 'sold' : 'traded';

    const tickerOk = (row.ticker || '').trim() && TICKER_QUERY_FORMAT.test((row.ticker || '').trim().toUpperCase());
    const assetLabel = tickerOk
      ? (row.ticker as string).trim().toUpperCase()
      : (row.asset_name || '').trim().slice(0, 60) || 'an asset';

    const name = row.full_name?.trim() || null;
    const district = name ? formatMemberSeat(row.filer_id, row.chamber, row.party, row.state, row.district) : null;
    const filerLabel = name ? (district ? `${name} (${district})` : name) : null;

    return {
      filerLabel,
      verb,
      assetLabel,
      amountBracket: formatAmountBracket(row.amount_min, row.amount_max),
      txDateLabel: formatShareTxDate(row.tx_date),
    };
  } catch {
    return null;
  }
}

async function renderDashboard(env: Env, requestUrl: string): Promise<string> {
  const logoDisplay = await getLogoDisplay(env);
  let memberDisplayName: string | null = null;
  let memberDistrict: string | null = null;
  let tickerResolved = false;
  let tradeSummary: Awaited<ReturnType<typeof lookupTradeShareSummary>> = null;
  try {
    const u = new URL(requestUrl);
    const member = (u.searchParams.get('member') || '').trim();
    const ticker = (u.searchParams.get('ticker') || '').trim();
    const trade = (u.searchParams.get('trade') || '').trim();
    if (member) {
      const identity = await lookupMemberShareIdentity(env, member);
      memberDisplayName = identity.displayName;
      memberDistrict = identity.district;
    }
    // resolveOgMeta gives a RESOLVED member priority over ticker, so the
    // ticker lookup is only wasted work when member is both present and
    // resolved — an unresolved (or absent) member still needs it checked.
    if (ticker && !memberDisplayName) {
      tickerResolved = await lookupTickerResolved(env, ticker);
    }
    // Same priority logic one level down: a trade lookup is wasted work only
    // when a higher-priority (member or ticker) card already resolved.
    if (trade && !memberDisplayName && !tickerResolved) {
      tradeSummary = await lookupTradeShareSummary(env, trade);
    }
  } catch {
    /* ignore bad URL */
  }
  const og = resolveOgMeta(requestUrl, 'https://congress.trade', {
    memberDisplayName,
    memberDistrict,
    tickerResolved,
    tradeSummary,
  });
  let html = DASHBOARD_HTML
    .split('%LOGO_DISPLAY%').join(logoDisplay)
    .split('%GA_SCRIPT%').join(telemetryScripts(env));
  html = applyOgMeta(html, og);
  return html;
}

function datadogRumScript(env: Env): string {
  return renderDatadogRumScript(resolveDatadogRum({
    ...(getDatadogInitInput() ?? {}),
    ...env,
  }));
}

function telemetryScripts(env: Env): string {
  return datadogRumScript(env) + renderSentryBrowserScript(env);
}

function renderLegalHtml(html: string, env: Env): string {
  return html.split('%GA_SCRIPT%').join(telemetryScripts(env));
}

export function buildUiRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();
  mountAppLinks(r); // iOS Universal Links (AASA + Smart App Banner) — src/ui/appLinks.ts.

  // Dashboard SPA. Hono's c.html() sets `content-type: text/html; charset=UTF-8`.
  // OG/Twitter meta is filled from the request URL so crawlers unfurl the
  // correct card for ?view=trends / ?ticker= / ?member= deep links.
  r.get('/', async (c) => c.html(await renderDashboard(c.env, c.req.url)));
  r.get('/admin', async (c) => c.html(await renderDashboard(c.env, c.req.url)));

  // Binary assets live under app/public/ (loaded by assets.ts) and are served
  // here with long cache headers. HTML references these URL paths — never
  // inline base64 — so documents stay small and assets are CSP-safe (`'self'`).
  const serveAsset = (a: StaticAsset, cacheControl: string) => (c: any) =>
    c.body(a.bytes, 200, {
      'content-type': a.contentType,
      'cache-control': cacheControl,
    });
  const IMMUTABLE = 'public, max-age=31536000, immutable';
  const LONG = 'public, max-age=86400';
  r.get('/assets/zilla-slab-700.woff2', serveAsset(ZILLA_SLAB_WOFF2, IMMUTABLE));
  r.get('/assets/inter-400.woff2', serveAsset(INTER_400_WOFF2, IMMUTABLE));
  r.get('/assets/inter-500.woff2', serveAsset(INTER_500_WOFF2, IMMUTABLE));
  r.get('/assets/inter-600.woff2', serveAsset(INTER_600_WOFF2, IMMUTABLE));
  r.get('/assets/inter-700.woff2', serveAsset(INTER_700_WOFF2, IMMUTABLE));
  r.get('/assets/inter-800.woff2', serveAsset(INTER_800_WOFF2, IMMUTABLE));
  r.get('/assets/eagle-splash.png', serveAsset(EAGLE_SPLASH_PNG, IMMUTABLE));
  r.get('/assets/brand-logo.png', serveAsset(BRAND_LOGO_PNG, IMMUTABLE));
  r.get('/assets/brand-logo-dark.png', serveAsset(BRAND_LOGO_DARK_PNG, IMMUTABLE));
  r.get('/assets/brand-logo-light.png', serveAsset(BRAND_LOGO_LIGHT_PNG, IMMUTABLE));
  r.get('/swu-logo-wide.webp', serveAsset(SWU_LOGO_WEBP, LONG));
  r.get('/og-image.png', serveAsset(OG_IMAGE_PNG, LONG));
  r.get('/og-image-trends.png', serveAsset(OG_IMAGE_TRENDS_PNG, LONG));
  r.get('/og-image-company.png', serveAsset(OG_IMAGE_COMPANY_PNG, LONG));
  r.get('/og-image-politician.png', serveAsset(OG_IMAGE_POLITICIAN_PNG, LONG));
  r.get('/favicon.ico', serveAsset(FAVICON_PNG, LONG));
  r.get('/icon-192.png', serveAsset(ICON_192_PNG, LONG));
  r.get('/icon-512.png', serveAsset(ICON_512_PNG, LONG));
  r.get('/apple-touch-icon.png', serveAsset(APPLE_TOUCH_ICON_PNG, LONG));
  r.get('/site.webmanifest', (c) =>
    c.body(SITE_WEBMANIFEST, 200, {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': LONG,
    }));

  // Static legal pages (required for Stripe Checkout: ToS + Privacy URLs).
  r.get('/terms-of-service', (c) => c.html(renderLegalHtml(TOS_HTML, c.env)));
  r.get('/privacy-policy', (c) => c.html(renderLegalHtml(PRIVACY_HTML, c.env)));
  // Short aliases users and external listings commonly try first.
  r.get('/privacy', (c) => c.redirect('/privacy-policy', 301));
  r.get('/terms', (c) => c.redirect('/terms-of-service', 301));
  // Shareable pricing entry — dashboard opens the Premium modal via ?pricing=1.
  r.get('/pricing', (c) => c.redirect('/?pricing=1&view=subs', 302));
  // Shareable iOS TestFlight / Beta links
  r.get('/beta', (c) => c.redirect(testFlightUrl(c.env), 302));
  r.get('/testflight', (c) => c.redirect(testFlightUrl(c.env), 302));
  r.get('/ios', (c) => c.redirect(testFlightUrl(c.env), 302));
  r.get('/app', (c) => c.redirect(testFlightUrl(c.env), 302));

  // robots.txt — allow search engines, block AI/LLM crawlers and scrapers.
  // Follows the same policy as capitoltrades.com/robots.txt.
  //
  // SEOSOCIAL-01: the whole page is a shell — every trade, politician, ticker
  // and Trends number is fetched from /api/* client-side after load, so a
  // blanket "Disallow: /api/" makes Googlebot/Bingbot render (and index) an
  // empty page. The explicit Allow lines below re-open exactly the read-only,
  // public GET endpoints the SPA needs to paint real content; everything else
  // under /api/ (admin, billing, delivery writes, export) stays disallowed.
  // This is safe independent of robots.txt: publicApiGuard (security/
  // botDefense.ts) always stamps `X-Robots-Tag: noindex` on every /api/*
  // response, so the raw JSON itself can never appear in search results even
  // though a crawler is now allowed to fetch it for rendering.
  r.get('/robots.txt', (c) => c.text(`User-Agent: *
Allow: /
Allow: /api/analytics/
Allow: /api/transactions
Allow: /api/photos/
Allow: /api/logos/
Allow: /api/feed.xml
Disallow: /api/

User-Agent: GPTBot
User-Agent: ChatGPT-User
User-Agent: OAI-SearchBot
User-Agent: ClaudeBot
User-Agent: anthropic-ai
User-Agent: Claude-Web
User-Agent: CCBot
User-Agent: Google-Extended
User-Agent: Applebot-Extended
User-Agent: PerplexityBot
User-Agent: Perplexity-User
User-Agent: Bytespider
User-Agent: Amazonbot
User-Agent: meta-externalagent
User-Agent: Meta-ExternalAgent
User-Agent: FacebookBot
User-Agent: Diffbot
User-Agent: ImagesiftBot
User-Agent: Omgilibot
User-Agent: Omgili
User-Agent: YouBot
User-Agent: cohere-ai
User-Agent: cohere-training-data-crawler
User-Agent: Timpibot
User-Agent: VelenPublicWebCrawler
User-Agent: Scrapy
Disallow: /

Sitemap: ${SITE}/sitemap.xml
`, 200, { 'content-type': 'text/plain; charset=utf-8' }));

  // SEOSOCIAL-03: the only remaining way to tell search engines the
  // ?member=/?ticker= entity URLs exist, now that SEOSOCIAL-02's crawlable
  // <a href> links still need JS/API round-trips to enumerate. Cached ~1h in
  // isolate memory; falls back to the static view URLs (never a 500) if the
  // DB is unreachable.
  r.get('/sitemap.xml', async (c) => c.body(await getSitemapXml(c.env), 200, {
    'content-type': 'application/xml; charset=utf-8',
    'cache-control': 'public, max-age=3600',
  }));

  return r;
}
