/**
 * trade.retract signal (migration 0108, delivery/retractions.ts), on a real
 * migrated SQLite database so the triggers, the outbox key, the webhook
 * claim and the poll feed all run for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { openMigratedD1, type D1Database, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import type { Env } from '../../shared/types.ts';
import { buildRestRouter } from '../rest.ts';
import { dispatchWebhook } from '../webhook.ts';
import { openSseStream } from '../sse.ts';
import { flushParkedDeliveries } from '../targetCircuit.ts';
import { APNS_FANOUT_TRADE_SQL } from '../apnsFanout.ts';
import { listRetractions, parseRetractKey, retractKey } from '../retractions.ts';

let db: SqliteDatabase;
let d1: D1Database;
let env: Env;

beforeEach(async () => {
  ({ db, d1 } = await openMigratedD1());
  env = {
    DB: d1,
    DELIVERY_QUEUE: { send: vi.fn(async () => {}), sendBatch: vi.fn(async () => {}) },
  } as unknown as Env;
});
afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

const CREATED = '2026-10-20T12:00:00.000Z';

function seedTx(id: string, opts: { deliveredOutbox?: boolean } = {}) {
  db.prepare(
    `INSERT OR IGNORE INTO filings (doc_id, chamber, filer_id, filing_type, filed_date, ingest_status, first_seen_at)
     VALUES ('H-2026-1', 'house', 'K000388', 'P', '2026-10-20', 'published', ?)`,
  ).run(CREATED);
  db.prepare(
    `INSERT INTO transactions (id, doc_id, filer_id, tx_date, owner, asset_name, ticker, tx_type,
       amount_min, amount_max, is_option, cap_gains_over_200, raw_text, confidence, source, row_key, created_at)
     VALUES (?, 'H-2026-1', 'K000388', '2026-10-01', NULL, 'Apple Inc.', 'AAPL', 'P',
       1001, 15000, 0, 0, '', 1, 'pdf', ?, ?)`,
  ).run(id, `v1:pdf:${id}`, CREATED);
  if (opts.deliveredOutbox) {
    db.prepare(
      `INSERT INTO delivery_outbox (tx_id, status, attempts, available_at, created_at, updated_at)
       VALUES (?, 'completed', 1, ?, ?, ?)`,
    ).run(id, CREATED, CREATED, CREATED);
  }
}

const deprecate = (id: string, at = '2026-10-25T20:00:00.000Z') =>
  db.prepare("UPDATE transactions SET deprecated_at = ?, deprecated_reason = 'unpublished: test' WHERE id = ?").run(at, id);
const revive = (id: string) =>
  db.prepare('UPDATE transactions SET deprecated_at = NULL, deprecated_reason = NULL WHERE id = ?').run(id);
const cursorOf = (id: string) =>
  (db.prepare('SELECT cursor_seq AS c FROM transactions WHERE id = ?').get(id) as { c: number }).c;

describe('deprecation trigger', () => {
  it('records a retraction and a retract outbox event that does not collide with the original delivery', () => {
    seedTx('tx-a', { deliveredOutbox: true });
    deprecate('tx-a');
    const retractions = db.prepare('SELECT seq, tx_id, doc_id, retracted_at, revived_at FROM tx_retractions').all();
    expect(retractions).toEqual([
      { seq: 1, tx_id: 'tx-a', doc_id: 'H-2026-1', retracted_at: '2026-10-25T20:00:00.000Z', revived_at: null },
    ]);
    const outbox = db.prepare('SELECT tx_id, status, event_kind FROM delivery_outbox ORDER BY tx_id').all();
    expect(outbox).toEqual([
      { tx_id: 'retract:1', status: 'pending', event_kind: 'trade.retract' },
      { tx_id: 'tx-a', status: 'completed', event_kind: 'trade.new' },
    ]);
  });

  it('fires only on the live -> deprecated transition', () => {
    seedTx('tx-a');
    deprecate('tx-a');
    // Re-stamping an already deprecated row is not a second retraction.
    deprecate('tx-a', '2026-10-26T00:00:00.000Z');
    db.prepare("UPDATE transactions SET asset_name = 'APPLE INC' WHERE id = 'tx-a'").run();
    expect((db.prepare('SELECT COUNT(*) AS n FROM tx_retractions').get() as { n: number }).n).toBe(1);
  });

  it('never feeds a retract event to the APNs trade fan-out', () => {
    seedTx('tx-a', { deliveredOutbox: true });
    seedTx('tx-b');
    deprecate('tx-b');
    const rows = db.prepare(APNS_FANOUT_TRADE_SQL).all('2000-01-01T00:00:00.000Z') as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['tx-a']);
  });
});

describe('revive after a retraction', () => {
  it('gives a byte-identical revive a new cursor_seq and closes the retraction', () => {
    seedTx('tx-a');
    const before = cursorOf('tx-a');
    seedTx('tx-other');
    deprecate('tx-a');
    revive('tx-a');
    expect(cursorOf('tx-a')).toBeGreaterThan(cursorOf('tx-other'));
    expect(cursorOf('tx-a')).toBeGreaterThan(before);
    const r = db.prepare('SELECT revived_at FROM tx_retractions WHERE tx_id = ?').get('tx-a') as { revived_at: string | null };
    expect(r.revived_at).not.toBeNull();
  });

  it('keeps the cursor of a row that was never exposed as retracted', () => {
    seedTx('tx-a');
    const before = cursorOf('tx-a');
    deprecate('tx-a');
    // Deprecated before migration 0108: no retraction was ever served.
    db.prepare('DELETE FROM tx_retractions').run();
    revive('tx-a');
    expect(cursorOf('tx-a')).toBe(before);
  });

  it('does not allocate twice when the reviving UPDATE already moved the cursor', () => {
    seedTx('tx-a');
    deprecate('tx-a');
    db.prepare("INSERT INTO tx_cursor_seq (tx_id) VALUES ('tx-a')").run();
    const allocated = (db.prepare("SELECT MAX(seq) AS s FROM tx_cursor_seq WHERE tx_id = 'tx-a'").get() as { s: number }).s;
    db.prepare(
      `UPDATE transactions SET deprecated_at = NULL,
         cursor_seq = (SELECT MAX(seq) FROM tx_cursor_seq WHERE tx_id = 'tx-a') WHERE id = 'tx-a'`,
    ).run();
    expect(cursorOf('tx-a')).toBe(allocated);
  });
});

const PollResponse = z.object({
  retractions: z.array(z.object({ retractSeq: z.number(), txId: z.string(), docId: z.string(), retractedAt: z.string() })),
  cursor: z.number(),
  hasMore: z.boolean(),
});

describe('GET /transactions/retractions', () => {
  async function poll(query: string) {
    const res = await buildRestRouter().request(`http://localhost/transactions/retractions${query}`, {}, env);
    return { status: res.status, body: res.status === 200 ? PollResponse.parse(await res.json()) : null, res };
  }

  it('pages forward by retraction cursor and omits revived rows', async () => {
    for (const id of ['tx-a', 'tx-b', 'tx-c']) seedTx(id);
    deprecate('tx-a');
    deprecate('tx-b');
    deprecate('tx-c');
    revive('tx-b');

    const first = await poll('?since=0&limit=2');
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      retractions: [{ retractSeq: 1, txId: 'tx-a', docId: 'H-2026-1', retractedAt: '2026-10-25T20:00:00.000Z' }],
      cursor: 2,
      hasMore: true,
    });
    const second = await poll('?since=2');
    expect(second.body?.retractions.map((r) => r.txId)).toEqual(['tx-c']);
    expect(second.body?.cursor).toBe(3);
    expect(second.body?.hasMore).toBe(false);
    const empty = await poll('?since=3');
    expect(empty.body).toEqual({ retractions: [], cursor: 3, hasMore: false });
  });

  it('is public and CORS-readable like /transactions', async () => {
    const res = await buildRestRouter().request('http://localhost/transactions/retractions', {
      headers: { Origin: 'https://socratic.example' },
    }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeTruthy();
  });

  it('rejects a negative cursor', async () => {
    expect((await poll('?since=-1')).status).toBe(400);
  });
});

function stubWebhookFetch() {
  const posts: Array<{ url: string; headers: Headers; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
      const type = new URL(url).searchParams.get('type');
      return Response.json({ Status: 0, Answer: type === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [] });
    }
    posts.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return Response.json({ receiptVersion: 1, delivered: true, consumed: true, ok: true, applied: 1 });
  }));
  return posts;
}

function seedWebhookSub() {
  db.prepare(
    `INSERT INTO subscriptions (id, client_id, delivery, target_url, secret, filters, cursor, active, created_at)
     VALUES ('sub_1', 'integration:ops', 'webhook', 'https://hooks.example.test/trade', 'sub_secret',
       '{"tickers":["MSFT"]}', 7, 1, '2026-06-20T00:00:00.000Z')`,
  ).run();
}

describe('webhook trade.retract', () => {
  it('posts a non-trade retract event under its own delivery key, ignoring trade filters', async () => {
    seedTx('tx-a', { deliveredOutbox: true });
    seedWebhookSub();
    deprecate('tx-a');
    const posts = stubWebhookFetch();
    const result = await dispatchWebhook(env, retractKey(1));
    expect(result.outboxComplete).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0].headers.get('X-CT-Event')).toBe('transaction.retracted');
    expect(posts[0].headers.get('X-Tx-Id')).toBe('retract:1');
    expect(posts[0].body).toMatchObject({
      type: 'trade.retract',
      id: 'ct-retract-1',
      event: 'trade.retract',
      retraction: { retractSeq: 1, txId: 'tx-a', docId: 'H-2026-1', retractedAt: '2026-10-25T20:00:00.000Z' },
    });
    expect(posts[0].body).not.toHaveProperty('transaction');
    const delivery = db.prepare('SELECT tx_id, status FROM deliveries').all();
    expect(delivery).toEqual([{ tx_id: 'retract:1', status: 'delivered' }]);
    // The trade cursor is not moved by a retraction.
    expect((db.prepare("SELECT cursor FROM subscriptions WHERE id = 'sub_1'").get() as { cursor: number }).cursor).toBe(7);
  });

  it('drops a retraction whose row was revived before delivery', async () => {
    seedTx('tx-a');
    seedWebhookSub();
    deprecate('tx-a');
    revive('tx-a');
    const posts = stubWebhookFetch();
    expect((await dispatchWebhook(env, retractKey(1))).outboxComplete).toBe(true);
    expect(posts).toHaveLength(0);
  });

  it('re-releases a parked retract delivery instead of terminalizing it as a missing tx', async () => {
    seedTx('tx-a');
    seedWebhookSub();
    deprecate('tx-a');
    db.prepare(
      `INSERT INTO deliveries (id, subscription_id, tx_id, status, attempts, last_error, updated_at)
       VALUES ('dlv_1', 'sub_1', 'retract:1', 'parked', 0, 'circuit open', '2026-10-25T20:00:00.000Z')`,
    ).run();
    const result = await flushParkedDeliveries(env, { now: new Date('2026-10-25T21:00:00.000Z') });
    expect(result.terminalized).toBe(0);
    expect(result.released).toBe(1);
    expect(env.DELIVERY_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'delivery.dispatch', txId: 'retract:1', subscriptionId: 'sub_1' }),
    );
  });
});

describe('SSE trade.retract', () => {
  async function readAll(res: Response): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  }

  it('streams retractions after ?retractSince and hands the cursor back on reconnect', async () => {
    db.prepare(
      `INSERT INTO subscriptions (id, client_id, delivery, target_url, secret, filters, cursor, active, created_at)
       VALUES ('sub_s', 'ops-integration', 'sse', NULL, 'stream-secret', '{}', 0, 1, '2026-01-01T00:00:00.000Z')`,
    ).run();
    seedTx('tx-a');
    seedTx('tx-b');
    deprecate('tx-a');
    deprecate('tx-b');
    const res = await openSseStream(env, 'sub_s', undefined, 'stream-secret', '127.0.0.1', {
      maxStreamMs: 150, pollIntervalMs: 10, backlogDrainIntervalMs: 1000, reconnectGraceMs: 20,
    }, 1);
    expect(res.status).toBe(200);
    const body = await readAll(res);
    expect(body).toContain('event: retract-cursor\ndata: 1\n');
    const frames = body.split('\n\n').filter((f) => f.startsWith('event: trade.retract'));
    expect(frames).toHaveLength(1);
    expect(frames[0]).not.toMatch(/^id:/m);
    expect(JSON.parse(frames[0].split('data: ')[1])).toMatchObject({ type: 'trade.retract', retractSeq: 2, txId: 'tx-b' });
    expect(body).toContain('"retractSince":2');
  });

  it('starts at the retraction high-water mark without ?retractSince', async () => {
    db.prepare(
      `INSERT INTO subscriptions (id, client_id, delivery, target_url, secret, filters, cursor, active, created_at)
       VALUES ('sub_s', 'ops-integration', 'sse', NULL, 'stream-secret', '{}', 0, 1, '2026-01-01T00:00:00.000Z')`,
    ).run();
    seedTx('tx-a');
    deprecate('tx-a');
    const res = await openSseStream(env, 'sub_s', undefined, 'stream-secret', '127.0.0.1', {
      maxStreamMs: 100, pollIntervalMs: 10, backlogDrainIntervalMs: 1000, reconnectGraceMs: 20,
    });
    const body = await readAll(res);
    expect(body).toContain('event: retract-cursor\ndata: 1\n');
    expect(body).not.toContain('event: trade.retract');
  });

  it('replays retractions from 0 when resuming without ?retractSince', async () => {
    db.prepare(
      `INSERT INTO subscriptions (id, client_id, delivery, target_url, secret, filters, cursor, active, created_at)
       VALUES ('sub_s', 'ops-integration', 'sse', NULL, 'stream-secret', '{}', 0, 1, '2026-01-01T00:00:00.000Z')`,
    ).run();
    seedTx('tx-a');
    deprecate('tx-a');
    // since=0 with no retractSince: like a native EventSource auto-reconnect,
    // which replays Last-Event-ID but cannot resend ?retractSince=.
    const res = await openSseStream(env, 'sub_s', 0, 'stream-secret', '127.0.0.1', {
      maxStreamMs: 100, pollIntervalMs: 10, backlogDrainIntervalMs: 1000, reconnectGraceMs: 20,
    });
    const body = await readAll(res);
    expect(body).toContain('event: retract-cursor\ndata: 0\n');
    expect(body).toContain('event: trade.retract');
  });
});

describe('retract keys', () => {
  it('round-trips and rejects anything else', () => {
    expect(parseRetractKey(retractKey(42))).toBe(42);
    expect(parseRetractKey('tx-a')).toBeNull();
    expect(parseRetractKey('retract:0')).toBeNull();
    expect(parseRetractKey('retract:1;DROP')).toBeNull();
  });

  it('listRetractions advances past a revived-only page', async () => {
    seedTx('tx-a');
    deprecate('tx-a');
    revive('tx-a');
    expect(await listRetractions(env, 0)).toEqual({ retractions: [], cursor: 1, hasMore: false });
  });
});
