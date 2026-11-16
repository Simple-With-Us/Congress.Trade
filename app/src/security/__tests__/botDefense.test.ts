import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../shared/types.ts';
import {
  blockedUserAgent,
  checkRowBudget,
  spendRowBudget,
  publicApiGuard,
  DAILY_ROW_BUDGET,
  PUBLIC_API_LIMIT,
} from '../botDefense.ts';
import { TCP_PEER_HEADER } from '../originLock.ts';

/** Map-backed KV fake so rate-limit counters actually count. */
function fakeKv() {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

function guardedApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use('/api/*', publicApiGuard);
  app.get('/api/transactions', (c) => c.json({ ok: true }));
  app.get('/api/admin/ping', (c) => c.json({ admin: true }));
  return app;
}

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const IOS_APP_UA = 'CongressTrade/1.0 CFNetwork/1494.0.7 Darwin/23.2.0';

describe('blockedUserAgent', () => {
  it('blocks scraping libraries and AI crawlers', () => {
    expect(blockedUserAgent('python-requests/2.32.0')).toBe('python-http');
    expect(blockedUserAgent('curl/8.6.0')).toBe('curl');
    expect(blockedUserAgent('Scrapy/2.11 (+https://scrapy.org)')).toBe('scrapy');
    expect(blockedUserAgent('Go-http-client/2.0')).toBe('go-http');
    expect(blockedUserAgent('GPTBot/1.0 (+https://openai.com/gptbot)')).toBe('ai-crawler');
    expect(blockedUserAgent('Mozilla/5.0 (compatible; ClaudeBot/1.0)')).toBe('ai-crawler');
    expect(blockedUserAgent('Mozilla/5.0 HeadlessChrome/125.0')).toBe('headless-browser');
  });

  it('blocks a missing/empty user agent', () => {
    expect(blockedUserAgent(null)).toBe('missing-user-agent');
    expect(blockedUserAgent('  ')).toBe('missing-user-agent');
  });

  it('allows real browsers and mobile app networking stacks', () => {
    expect(blockedUserAgent(CHROME_UA)).toBeNull();
    expect(blockedUserAgent(IOS_APP_UA)).toBeNull();
    expect(blockedUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) Safari/604.1')).toBeNull();
  });
});

describe('publicApiGuard', () => {
  it('is inert (except X-Robots-Tag) when SCRAPE_GUARD_ENABLED is unset', async () => {
    const app = guardedApp();
    const res = await app.request('http://localhost/api/transactions', { headers: { 'user-agent': 'curl/8.6.0' } }, {
      CONFIG_KV: fakeKv(),
    } as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('rejects scraper user agents on public data endpoints when enabled', async () => {
    const app = guardedApp();
    const env = { SCRAPE_GUARD_ENABLED: 'true', CONFIG_KV: fakeKv() } as never;
    const res = await app.request('http://localhost/api/transactions', { headers: { 'user-agent': 'python-requests/2.32.0' } }, env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe('python-http');
  });

  it('rejects requests without a user agent when enabled', async () => {
    const app = guardedApp();
    const env = { SCRAPE_GUARD_ENABLED: 'true', CONFIG_KV: fakeKv() } as never;
    const res = await app.request('http://localhost/api/transactions', {}, env);
    expect(res.status).toBe(403);
  });

  it('lets browsers through and stamps X-Robots-Tag', async () => {
    const app = guardedApp();
    const env = { SCRAPE_GUARD_ENABLED: 'true', CONFIG_KV: fakeKv() } as never;
    const res = await app.request('http://localhost/api/transactions', { headers: { 'user-agent': CHROME_UA } }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('exempts token-gated surfaces so ops tooling keeps working', async () => {
    const app = guardedApp();
    const env = { SCRAPE_GUARD_ENABLED: 'true', CONFIG_KV: fakeKv() } as never;
    const res = await app.request('http://localhost/api/admin/ping', { headers: { 'user-agent': 'curl/8.6.0' } }, env);
    expect(res.status).toBe(200);
  });

  it('429s an IP past the request budget with Retry-After', async () => {
    const app = guardedApp();
    const env = { SCRAPE_GUARD_ENABLED: 'true', CONFIG_KV: fakeKv() } as never;
    const headers = { 'user-agent': CHROME_UA, 'cf-connecting-ip': '203.0.113.9', [TCP_PEER_HEADER]: '104.16.1.2' };
    let last: Response | null = null;
    for (let i = 0; i < PUBLIC_API_LIMIT + 1; i++) {
      last = await app.request('http://localhost/api/transactions', { headers }, env);
    }
    expect(last?.status).toBe(429);
    expect(Number(last?.headers.get('Retry-After'))).toBeGreaterThan(0);
  });
});

describe('daily row budget', () => {
  it('exhausts after DAILY_ROW_BUDGET rows and reports a retry window', async () => {
    const env = { SCRAPE_GUARD_ENABLED: 'true', CONFIG_KV: fakeKv() } as unknown as Env;
    expect((await checkRowBudget(env, '198.51.100.7')).ok).toBe(true);
    await spendRowBudget(env, '198.51.100.7', DAILY_ROW_BUDGET);
    const blocked = await checkRowBudget(env, '198.51.100.7');
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    // Another IP is unaffected.
    expect((await checkRowBudget(env, '198.51.100.8')).ok).toBe(true);
  });

  it('skips accounting entirely when the guard is disabled', async () => {
    const env = { CONFIG_KV: fakeKv() } as unknown as Env;
    await spendRowBudget(env, '198.51.100.7', DAILY_ROW_BUDGET * 2);
    expect((await checkRowBudget(env, '198.51.100.7')).ok).toBe(true);
  });

  it('fails open without a KV binding', async () => {
    const env = { SCRAPE_GUARD_ENABLED: 'true' } as unknown as Env;
    expect((await checkRowBudget(env, '198.51.100.7')).ok).toBe(true);
  });
});
