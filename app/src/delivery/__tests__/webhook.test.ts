/**
 * The push path must put the filer party on the streamed transaction.
 *
 * The dashboard's D/R chips call rowPartyBucket(), which reads row.party and
 * falls back to 'O' when the field is absent. The backlog drain selects
 * `fl.party AS filer_party`, but the broadcast path reads
 * `SELECT * FROM transactions`, which has no party column at all — so
 * mapTransaction() could not supply one and every broadcast row reached the
 * client party-less.
 *
 * These tests pin the fix on the push side specifically, so the two delivery
 * paths cannot drift apart on shape again. The backlog side is pinned in
 * sse.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { dispatchWebhook } from '../webhook.ts';

const txRow = {
  id: 'tx_1', doc_id: 'doc_1', filer_id: 'K000388', tx_date: '2026-10-17', owner: 'self',
  asset_name: 'Apple Inc.', ticker: 'AAPL', asset_type: 'stock', tx_type: 'B',
  amount_min: 1001, amount_max: 15000, is_option: 0, cap_gains_over_200: 0,
  raw_text: 'AAPL purchase', confidence: 0.99, source: 'primary',
  filed_date: '2026-10-17',
  first_seen_at: '2026-10-17T15:00:00.000Z',
  created_at: '2026-10-17T15:00:00.000Z', cursor_seq: 42,
};

/**
 * A minimal env for dispatchWebhook. The party comes from the filings+filers
 * join, so that is the only query whose answer matters here; the rest exist
 * just to get past the subscription fanout.
 */
function partyEnv(filerParty: string | null) {
  const sqls: string[] = [];
  const subRow = {
    id: 'sub_1', client_id: 'integration:ops', delivery: 'webhook',
    target_url: 'https://hooks.example.test/trade', secret: 'sub_secret', filters: '{}',
    cursor: 0, active: 1, created_at: '2026-06-20T00:00:00.000Z',
  };
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) { this.params = params; return this; },
    async first<T>() {
      sqls.push(sql);
      if (/FROM transactions WHERE id = \?/i.test(sql)) return txRow as T;
      if (/FROM filings f/i.test(sql)) {
        return { chamber: 'house', party: filerParty } as T;
      }
      if (/FROM users WHERE id/i.test(sql)) return null as T | null;
      if (/FROM securities_ref/i.test(sql)) return { sector: 'Technology', market_cap_bucket: 'mega' } as T;
      if (/FROM subscriptions/i.test(sql)) return subRow as T;
      return null as T | null;
    },
    async all<T>() {
      if (/active = 1 AND delivery = 'webhook'/i.test(sql)) return { results: [subRow] as T[] };
      return { results: [] as T[] };
    },
    async run() {
      return { success: true, meta: { changes: 1 } };
    },
  });
  const env = {
    DB: { prepare } as unknown as D1Database,
    DELIVERY_QUEUE: { send: vi.fn(), sendBatch: vi.fn() },
    CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
  } as unknown as Env;
  return { env, sqls };
}

/** Capture what dispatchWebhook broadcasts to the live SSE streams. */
function captureBroadcast() {
  const posted: Array<Record<string, any>> = [];
  class FakeBroadcastChannel {
    constructor(public name: string) {}
    postMessage(message: Record<string, any>) { posted.push(message); }
    close() {}
    addEventListener() {}
  }
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  return posted;
}

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
      const type = new URL(url).searchParams.get('type');
      return Response.json({ Status: 0, Answer: type === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [] });
    }
    return Response.json(
      { receiptVersion: 1, delivered: true, consumed: true, ok: true, applied: 1 },
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }));
}

describe('dispatchWebhook puts the filer party on the broadcast transaction', () => {
  it('resolves the party through the filers join', async () => {
    const { env, sqls } = partyEnv('D');
    const posted = captureBroadcast();
    stubFetch();
    try {
      await dispatchWebhook(env, 'tx_1');
      // The party has to come from a filers join: the transactions table has no
      // party column, so `SELECT * FROM transactions` can never supply one.
      const join = sqls.find((s) => /FROM filings f/i.test(s));
      expect(join, 'the filing lookup was issued').toBeDefined();
      expect(join).toMatch(/LEFT JOIN filers fl ON fl\.bioguide_id = f\.filer_id/i);
      expect(join).toMatch(/fl\.party AS party/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sets tx.party from fl.party when the transaction carries none', async () => {
    const { env } = partyEnv('D');
    const posted = captureBroadcast();
    stubFetch();
    try {
      await dispatchWebhook(env, 'tx_1');
      const frame = posted.find((m) => m?.type === 'NEW_TRANSACTION');
      expect(frame, 'a live frame was broadcast').toBeDefined();
      expect(frame.transaction.party).toBe('D');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps a filer with no party as null, not empty string and not "O"', async () => {
    const { env } = partyEnv(null);
    const posted = captureBroadcast();
    stubFetch();
    try {
      await dispatchWebhook(env, 'tx_1');
      const frame = posted.find((m) => m?.type === 'NEW_TRANSACTION');
      expect(frame, 'a live frame was broadcast').toBeDefined();
      // Null says "known, and it is genuinely unknown". An empty string or a
      // pre-bucketed 'O' would read as a value the server actually sent.
      expect(frame.transaction.party).toBeNull();
      expect(frame.transaction.party).not.toBe('');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
