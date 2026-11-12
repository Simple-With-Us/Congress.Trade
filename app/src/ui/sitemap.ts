/**
 * src/ui/sitemap.ts
 *
 * SEOSOCIAL-03: `GET /sitemap.xml` — the only way search engines can discover
 * the ?member=/?ticker= entity URLs without walking the whole site, now that
 * SEOSOCIAL-02 makes them crawlable `<a href>` links but still buried behind
 * client-side directory fetches. Generated from `filers` + resolved tickers
 * in `transactions`, plus the handful of public ?view= tabs, with `lastmod`
 * taken from each entity's most recent disclosed trade.
 *
 * Contract:
 *   - Never throws, never 500s: a DB error (or empty DB) falls back to the
 *     static view URLs only — a sitemap with 4 URLs beats no sitemap.
 *   - Capped at MAX_URLS (50,000, the sitemap protocol's per-file limit) —
 *     entities are ordered by most-recently-traded first, so a cap only ever
 *     drops the longest-stale tail.
 *   - Cached in isolate memory for SITEMAP_CACHE_TTL_MS so a burst of crawler
 *     hits (or a human refreshing) doesn't re-run the two aggregate queries
 *     on every request; the route also sets `cache-control: max-age=3600` for
 *     any edge/browser cache in front of the Worker.
 */

import { SITE } from './ogMeta.ts';
import { TICKER_RESOLVED_SQL } from '../analytics/sql.ts';
import type { Env } from '../shared/types.ts';

/** Sitemap protocol per-file cap (a sitemap INDEX would be needed past this). */
const MAX_URLS = 50_000;
/** Split the cap between filers and tickers if both are large; each half is
 *  generous for this product's current entity counts (hundreds of filers,
 *  low thousands of tickers) with headroom to grow for years. */
const MAX_FILER_URLS = 25_000;
const MAX_TICKER_URLS = 25_000;

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h, matches the route's cache-control

/** A real, DB-resolved ticker symbol — mirrors the SEOSOCIAL-06 validator so
 *  a corrupt/placeholder `transactions.ticker` value never becomes a URL.
 *  Must start with a letter (every real ticker does) so punctuation-only or
 *  digit-led junk can't slip through even if it isn't one of the SQL-level
 *  sentinel strings TICKER_RESOLVED_SQL already excludes. */
const TICKER_FORMAT = /^[A-Z][A-Z0-9.\-]{0,9}$/;

export type SitemapUrl = {
  loc: string;
  lastmod?: string;
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
};

/** The public ?view= tabs — always present regardless of DB state. */
export function staticSitemapUrls(): SitemapUrl[] {
  return [
    { loc: `${SITE}/`, changefreq: 'hourly' },
    { loc: `${SITE}/?view=trends`, changefreq: 'hourly' },
    { loc: `${SITE}/?view=trades`, changefreq: 'hourly' },
    { loc: `${SITE}/?view=people`, changefreq: 'daily' },
    { loc: `${SITE}/?view=subs`, changefreq: 'weekly' },
    { loc: `${SITE}/pricing`, changefreq: 'weekly' },
    { loc: `${SITE}/terms-of-service`, changefreq: 'monthly' },
    { loc: `${SITE}/privacy-policy`, changefreq: 'monthly' },
  ];
}

/** Escape text for use inside XML element content (URLs go through this too —
 *  `&` is the only sitemap-relevant character a bioguide id/ticker could
 *  never legitimately contain, but this stays correct even if one did). */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function urlEntryXml(u: SitemapUrl): string {
  let entry = '  <url>\n    <loc>' + escapeXml(u.loc) + '</loc>\n';
  if (u.lastmod) entry += '    <lastmod>' + escapeXml(u.lastmod) + '</lastmod>\n';
  if (u.changefreq) entry += '    <changefreq>' + u.changefreq + '</changefreq>\n';
  entry += '  </url>';
  return entry;
}

/** Render a list of URL entries into a complete `<urlset>` document. Pure —
 *  no DB access — so it's directly unit-testable and reusable as the
 *  DB-failure fallback. */
export function buildSitemapXml(urls: SitemapUrl[]): string {
  const capped = urls.slice(0, MAX_URLS);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    capped.map(urlEntryXml).join('\n') +
    '\n</urlset>\n'
  );
}

type FilerRow = { id: string | null; lastmod: string | null };
type TickerRow = { id: string | null; lastmod: string | null };

/** Every filer with at least one disclosed trade, most-recently-traded first. */
async function queryFilerUrls(env: Env): Promise<SitemapUrl[]> {
  const { results } = await env.DB.prepare(
    `SELECT f.bioguide_id AS id, MAX(t.tx_date) AS lastmod
       FROM filers f
       JOIN transactions t ON t.filer_id = f.bioguide_id
      WHERE f.bioguide_id IS NOT NULL AND TRIM(f.bioguide_id) != ''
      GROUP BY f.bioguide_id
      ORDER BY lastmod DESC
      LIMIT ?`,
  )
    .bind(MAX_FILER_URLS)
    .all<FilerRow>();
  const urls: SitemapUrl[] = [];
  for (const row of results) {
    const id = (row.id || '').trim();
    if (!id) continue;
    urls.push({
      loc: `${SITE}/?member=${encodeURIComponent(id)}`,
      lastmod: row.lastmod || undefined,
      changefreq: 'weekly',
    });
  }
  return urls;
}

/** Every distinct, well-formed ticker traded at least once, most-recently-
 *  traded first. Malformed values (sentinels, free-text fund names sitting in
 *  the ticker column) are filtered out — SEOSOCIAL-06's same rule: only a
 *  real, resolvable ticker earns a URL. */
async function queryTickerUrls(env: Env): Promise<SitemapUrl[]> {
  const { results } = await env.DB.prepare(
    `SELECT t.ticker AS id, MAX(t.tx_date) AS lastmod
       FROM transactions t
      WHERE ${TICKER_RESOLVED_SQL}
      GROUP BY t.ticker
      ORDER BY lastmod DESC
      LIMIT ?`,
  )
    .bind(MAX_TICKER_URLS)
    .all<TickerRow>();
  const urls: SitemapUrl[] = [];
  for (const row of results) {
    const ticker = (row.id || '').trim().toUpperCase();
    if (!TICKER_FORMAT.test(ticker)) continue;
    urls.push({
      loc: `${SITE}/?ticker=${encodeURIComponent(ticker)}`,
      lastmod: row.lastmod || undefined,
      changefreq: 'weekly',
    });
  }
  return urls;
}

/** Build the full sitemap from the DB. Never throws — a query failure (or a
 *  missing DB binding, e.g. in a stripped-down test env) degrades to the
 *  static view URLs only, which is still a valid, useful sitemap. */
export async function generateSitemapXml(env: Env): Promise<string> {
  const urls: SitemapUrl[] = [...staticSitemapUrls()];
  if (env.DB) {
    try {
      const [filerUrls, tickerUrls] = await Promise.all([queryFilerUrls(env), queryTickerUrls(env)]);
      urls.push(...filerUrls, ...tickerUrls);
    } catch {
      /* DB error: ship the static URLs rather than a 500. */
    }
  }
  return buildSitemapXml(urls);
}

let cache: { xml: string; expiresAt: number } | null = null;

/** Cached wrapper around {@link generateSitemapXml} — memoized in isolate
 *  memory for `CACHE_TTL_MS` so repeated crawler/browser hits within the
 *  window reuse one render instead of re-running both aggregate queries. */
export async function getSitemapXml(env: Env): Promise<string> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.xml;
  const xml = await generateSitemapXml(env);
  cache = { xml, expiresAt: now + CACHE_TTL_MS };
  return xml;
}

/** Test-only: drop the in-memory cache so a fresh env is actually queried. */
export function resetSitemapCacheForTests(): void {
  cache = null;
}
