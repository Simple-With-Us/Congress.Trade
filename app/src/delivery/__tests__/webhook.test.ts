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
 * A minimal env for dispatchWebhook. The party comes from the chamber lookup,
 * so that is the only query whose answer matters here; the rest exist just to
 * get past the subscription fanout.
 *
 * The party is returned only for the filer the lookup actually keys on. That is
 * what makes the filing-vs-transaction drift detectable: filings.filer_id and
 * transactions.filer_id are written independently and filings.filer_id is
 * nullable, so a lookup keying off the filing resolves NULL while the SSE
 * backlog and HTTP feed — which key off the transaction — return the real party.
 *
 * `hasFiling` mirrors the transaction having no `filings` row at all (the
 * competitor_backfill / seed case): a lookup driven off `filings` returns no
 * row for those, while one driven off `transactions` with a LEFT JOIN resolves
 * the filer exactly like the replay paths do.
 */
function partyEnv(
  filerParty: string | null,
  filingFilerId: string | null = txRow.filer_id,
  hasFiling = true,
) {
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
      if (/AS chamber, fl\.party AS party/i.test(sql)) {
        // Mirror the real join: party is whatever the filers row for the keyed
        // bioguide_id holds, which is NULL when that key matches no filer.
        const keyedFiler = /bioguide_id = f\.filer_id/i.test(sql)
          ? filingFilerId
          : txRow.filer_id;
        // No filings row to join: a filings-driven lookup finds nothing here,
        // a transactions-driven one still resolves the filer.
        if (!hasFiling && !/FROM transactions t/i.test(sql)) return null as T;
        const party = keyedFiler === txRow.filer_id ? filerParty : null;
        return { chamber: 'house', party } as T;
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

/** The broadcast frame dispatchWebhook posts to the live SSE streams. */
type BroadcastFrame = {
  type?: string;
  transaction?: { party?: string | null };
};

/** Capture what dispatchWebhook broadcasts to the live SSE streams. */
function captureBroadcast() {
  const posted: BroadcastFrame[] = [];
  class FakeBroadcastChannel {
    constructor(public name: string) {}
    postMessage(message: BroadcastFrame) { posted.push(message); }
    close() {}
    addEventListener() {}
  }
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  return posted;
}

/** The transaction on the broadcast NEW_TRANSACTION frame, asserted present. */
function broadcastedTransaction(posted: BroadcastFrame[]): { party?: string | null } {
  const frame = posted.find((m) => m?.type === 'NEW_TRANSACTION');
  expect(frame, 'a live frame was broadcast').toBeDefined();
  expect(frame?.transaction, 'the frame carries a transaction').toBeDefined();
  return frame!.transaction!;
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
      const join = sqls.find((s) => /AS chamber, fl\.party AS party/i.test(s));
      expect(join, 'the chamber+party lookup was issued').toBeDefined();
      // Driven off transactions with LEFT JOINs, matching rows.ts TX_FROM_JOINS.
      // A filings-driven base resolves nothing at all for the backfill/seed rows
      // that have no filing, which is the drift this file exists to prevent.
      expect(join).toMatch(/FROM transactions t/i);
      expect(join).toMatch(/LEFT JOIN filings f ON f\.doc_id = t\.doc_id/i);
      // Keyed on the transaction's filer, matching sse.ts and rows.ts. Keying on
      // f.filer_id instead silently resolves NULL for the rows whose filing never
      // got a filer_id, which is the drift this file exists to prevent.
      expect(join).toMatch(/LEFT JOIN filers fl ON fl\.bioguide_id = t\.filer_id/i);
      expect(join).toMatch(/COALESCE\(fl\.chamber, f\.chamber\)/i);
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
      expect(broadcastedTransaction(posted).party).toBe('D');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resolves party from the transaction's filer when the filing has none", async () => {
    // filings.filer_id is nullable and extraction inserts filings with doc_id
    // alone, so a filing-keyed join returns NULL here while the SSE backlog and
    // the HTTP feed — both keyed on t.filer_id — return 'D'. The push path has to
    // agree with them.
    const { env } = partyEnv('D', null);
    const posted = captureBroadcast();
    stubFetch();
    try {
      await dispatchWebhook(env, 'tx_1');
      expect(broadcastedTransaction(posted).party).toBe('D');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resolves the party for a transaction that has no filings row at all', async () => {
    // competitor_backfill / seed rows are written by persistTransactions() with no
    // `filings` row behind them. A filings-driven lookup returns no row, so party
    // and chamber came out NULL and these notifications were dropped by every
    // chamber-filtered subscription — while rows.ts, which LEFT JOINs filings off
    // transactions and COALESCEs the chamber, resolved them.
    const { env } = partyEnv('D', null, false);
    const posted = captureBroadcast();
    stubFetch();
    try {
      await dispatchWebhook(env, 'tx_1');
      expect(broadcastedTransaction(posted).party).toBe('D');
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
      const tx = broadcastedTransaction(posted);
      // Null says "known, and it is genuinely unknown". An empty string or a
      // pre-bucketed 'O' would read as a value the server actually sent.
      expect(tx.party).toBeNull();
      expect(tx.party).not.toBe('');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
