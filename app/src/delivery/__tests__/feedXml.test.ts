/**
 * src/delivery/__tests__/feedXml.test.ts
 *
 * GET /feed.xml — RSS 2.0 over the existing transactions query builder.
 * Pins the content type, the newest-first query shape, and XML escaping.
 */
import { describe, it, expect } from 'vitest';
import { buildRestRouter, xmlEscape } from '../rest.ts';
import type { Env } from '../../shared/types.ts';
import type { FeedTransactionRow } from '../rows.ts';

const FRESH_STAMP = new Date().toISOString();
const FRESH_DAY = FRESH_STAMP.slice(0, 10);

function feedRow(over: Partial<FeedTransactionRow> = {}): FeedTransactionRow {
  return {
    id: 'tx_1',
    doc_id: 'H-2026-1',
    filer_id: 'P000197',
    tx_date: FRESH_DAY,
    owner: 'self',
    asset_name: 'Acme & Sons <Corp>',
    ticker: 'ACME',
    asset_type: 'stock',
    tx_type: 'B',
    amount_min: 1001,
    amount_max: 15000,
    is_option: 0,
    cap_gains_over_200: 0,
    raw_text: '',
    confidence: 0.9,
    source: 'primary',
    created_at: FRESH_STAMP,
    cursor_seq: 9,
    est_value: null,
    filer_full_name: 'Nancy Pelosi',
    filer_state: 'CA',
    filer_photo_url: null,
    filing_filed_date: FRESH_DAY,
    filing_first_seen_at: FRESH_STAMP,
    ...over,
  };
}

function makeEnv(rows: FeedTransactionRow[]): { env: Env; sql: () => string } {
  let lastFeedSql = '';
  const prepare = (sql: string) => ({
    bind() {
      return this;
    },
    async first<T>() {
      return null as T | null;
    },
    async all<T>() {
      if (/FROM transactions/i.test(sql)) {
        lastFeedSql = sql;
        return { results: rows as T[], meta: {} };
      }
      return { results: [] as T[], meta: {} };
    },
    async run() {
      return { success: true, meta: { changes: 0 } };
    },
  });
  return {
    env: { DB: { prepare } as unknown as D1Database } as unknown as Env,
    sql: () => lastFeedSql,
  };
}

describe('GET /feed.xml', () => {
  it('serves RSS 2.0 with one item per recent trade, newest first', async () => {
    const { env, sql } = makeEnv([feedRow()]);
    const app = buildRestRouter();
    const res = await app.request('http://localhost/feed.xml', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/rss+xml');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');

    const body = await res.text();
    expect(body).toContain('<rss version="2.0">');
    expect(body).toContain('<title>Congress.Trade — Recent Trades</title>');
    expect(body).toContain('House, Senate, and Executive Branch stock trades');
    expect(body).not.toContain('Recent Congressional Trades');
    expect(body).toContain('<title>Nancy Pelosi bought ACME</title>');
    expect(body).toContain('<guid isPermaLink="false">tx_1</guid>');
    expect(body).toContain('<pubDate>');
    // Asset name carries XML metacharacters — must be escaped (the company-name
    // normalizer also title-cases it to 'ACME ... Corp.' on the way out).
    expect(body).toContain('ACME &amp; Sons &lt;Corp.&gt;');
    expect(body).not.toContain('ACME & Sons <Corp>');
    // Newest-first snapshot over the shared builder.
    expect(sql()).toContain('ORDER BY COALESCE(t.first_seen_at, t.filed_date, t.tx_date, t.cursor_seq) DESC, t.cursor_seq DESC');
  });

  it('omits backfill rows by default but honors includeBackfill=1', async () => {
    const stale = feedRow({
      id: 'tx_old',
      tx_date: '2020-01-01',
      filing_first_seen_at: '2020-01-01T00:00:00.000Z',
      filing_filed_date: '2020-01-01',
      created_at: '2020-01-02T12:00:00Z',
    });
    const freshStamp = new Date().toISOString();
    const fresh = feedRow({
      id: 'tx_new',
      tx_date: freshStamp.slice(0, 10),
      created_at: freshStamp,
      filing_first_seen_at: freshStamp,
      filing_filed_date: freshStamp.slice(0, 10),
    });
    const app = buildRestRouter();
    const resDefault = await app.request('http://localhost/feed.xml', {}, makeEnv([stale, fresh]).env);
    const bodyDefault = await resDefault.text();
    expect(bodyDefault).toContain('tx_new');
    expect(bodyDefault).not.toContain('tx_old');
    const resAll = await app.request('http://localhost/feed.xml?includeBackfill=1', {}, makeEnv([stale, fresh]).env);
    const bodyAll = await resAll.text();
    expect(bodyAll).toContain('tx_new');
    expect(bodyAll).toContain('tx_old');
  });

  it('passes the shared feed filters through to the query builder', async () => {
    const { env, sql } = makeEnv([]);
    const app = buildRestRouter();
    const res = await app.request('http://localhost/feed.xml?ticker=aapl', {}, env);
    expect(res.status).toBe(200);
    expect(sql()).toContain('t.ticker = ?');
    const body = await res.text();
    expect(body).not.toContain('<item>');
  });
});

describe('xmlEscape', () => {
  it('escapes all five XML metacharacters', () => {
    expect(xmlEscape(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
    expect(xmlEscape(null)).toBe('');
  });
});
