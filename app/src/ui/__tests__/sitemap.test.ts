/**
 * src/ui/__tests__/sitemap.test.ts
 *
 * SEOSOCIAL-03: GET /sitemap.xml is the only way search engines discover the
 * ?member=/?ticker= entity URLs without walking the whole client-rendered
 * site. Pins the XML shape, the DB-failure fallback (must never 500), the
 * SEOSOCIAL-06-style ticker format filter, and the lastmod source.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import type { Env } from '../../shared/types.ts';
import {
  buildSitemapXml,
  generateSitemapXml,
  getSitemapXml,
  resetSitemapCacheForTests,
  staticSitemapUrls,
} from '../sitemap.ts';

type Row = Record<string, unknown>;

function makeEnv(opts: {
  filerRows?: Row[];
  tickerRows?: Row[];
  throwOnQuery?: boolean;
  noDb?: boolean;
}): Env {
  if (opts.noDb) return {} as Env;
  const prepare = (sql: string) => ({
    bind() {
      return this;
    },
    async all<T>(): Promise<{ results: T[] }> {
      if (opts.throwOnQuery) throw new Error('D1 unavailable');
      if (/GROUP BY f\.bioguide_id/.test(sql)) return { results: (opts.filerRows || []) as T[] };
      if (/GROUP BY t\.ticker/.test(sql)) return { results: (opts.tickerRows || []) as T[] };
      return { results: [] as T[] };
    },
  });
  return { DB: { prepare } as unknown as Env['DB'] } as Env;
}

describe('staticSitemapUrls', () => {
  it('always includes the public views + static pages, even before any DB URLs (CT-2459)', () => {
    const locs = staticSitemapUrls().map((u) => u.loc);
    expect(locs).toEqual([
      'https://congress.trade/',
      'https://congress.trade/?view=trends',
      'https://congress.trade/?view=trades',
      'https://congress.trade/?view=people',
      'https://congress.trade/?view=subs',
      'https://congress.trade/pricing',
      'https://congress.trade/terms-of-service',
      'https://congress.trade/privacy-policy',
    ]);
  });
});

describe('buildSitemapXml', () => {
  it('renders a valid urlset with loc/lastmod/changefreq', () => {
    const xml = buildSitemapXml([
      { loc: 'https://congress.trade/', changefreq: 'hourly' },
      { loc: 'https://congress.trade/?member=P000197', lastmod: '2026-08-01', changefreq: 'weekly' },
    ]);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('<loc>https://congress.trade/</loc>');
    expect(xml).toContain('<loc>https://congress.trade/?member=P000197</loc>');
    expect(xml).toContain('<lastmod>2026-08-01</lastmod>');
    expect(xml).toContain('<changefreq>weekly</changefreq>');
    expect(xml).toMatch(/<\/urlset>\s*$/);
  });

  it('omits <lastmod> when a URL has none rather than emitting an empty tag', () => {
    const xml = buildSitemapXml([{ loc: 'https://congress.trade/' }]);
    expect(xml).not.toContain('<lastmod>');
  });

  it('escapes XML-significant characters in <loc>', () => {
    const xml = buildSitemapXml([{ loc: 'https://congress.trade/?member=a&b' }]);
    expect(xml).toContain('<loc>https://congress.trade/?member=a&amp;b</loc>');
    expect(xml).not.toContain('?member=a&b<');
  });

  it('caps at 50,000 URLs (the sitemap protocol per-file limit)', () => {
    const urls = Array.from({ length: 50_010 }, (_, i) => ({ loc: `https://congress.trade/?ticker=T${i}` }));
    const xml = buildSitemapXml(urls);
    expect((xml.match(/<url>/g) || []).length).toBe(50_000);
  });
});

describe('generateSitemapXml', () => {
  it('includes filers and tickers with their lastmod from the latest trade', async () => {
    const env = makeEnv({
      filerRows: [{ id: 'P000197', lastmod: '2026-08-10' }],
      tickerRows: [{ id: 'NVDA', lastmod: '2026-08-15' }],
    });
    const xml = await generateSitemapXml(env);
    expect(xml).toContain('<loc>https://congress.trade/?member=P000197</loc>');
    expect(xml).toContain('<lastmod>2026-08-10</lastmod>');
    expect(xml).toContain('<loc>https://congress.trade/?ticker=NVDA</loc>');
    expect(xml).toContain('<lastmod>2026-08-15</lastmod>');
  });

  it('skips malformed ticker values instead of emitting a bad URL (mirrors SEOSOCIAL-06)', async () => {
    const env = makeEnv({
      tickerRows: [
        { id: 'NVDA', lastmod: '2026-08-15' },
        { id: 'Some Private Fund LLC', lastmod: '2026-08-01' },
        { id: '--', lastmod: '2026-07-01' },
      ],
    });
    const xml = await generateSitemapXml(env);
    expect(xml).toContain('ticker=NVDA');
    expect(xml).not.toContain('Private+Fund');
    expect(xml).not.toContain('ticker=--');
  });

  it('degrades to the static view URLs (not a 500) when the DB throws', async () => {
    const env = makeEnv({ throwOnQuery: true });
    const xml = await generateSitemapXml(env);
    expect(xml).toContain('<urlset');
    expect(xml).toContain('<loc>https://congress.trade/</loc>');
    expect(xml).not.toContain('?member=');
    expect(xml).not.toContain('?ticker=');
  });

  it('degrades to the static view URLs when no DB binding is present at all', async () => {
    const env = makeEnv({ noDb: true });
    const xml = await generateSitemapXml(env);
    expect(xml).toContain('<urlset');
    expect(xml).toContain('<loc>https://congress.trade/</loc>');
  });
});

describe('getSitemapXml caching', () => {
  beforeEach(() => resetSitemapCacheForTests());

  it('reuses the first render for a later call instead of re-querying', async () => {
    let calls = 0;
    const env = makeEnv({ filerRows: [{ id: 'P000197', lastmod: '2026-08-10' }] });
    const originalPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      calls++;
      return originalPrepare(sql);
    }) as typeof env.DB.prepare;

    const first = await getSitemapXml(env);
    const callsAfterFirst = calls;
    const second = await getSitemapXml(env);

    expect(second).toBe(first);
    expect(calls).toBe(callsAfterFirst); // no additional DB round-trips
  });
});
