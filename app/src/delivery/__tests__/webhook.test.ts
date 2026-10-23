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
import { flushParkedDeliveries } from '../targetCircuit.ts';

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

/**
 * Targeted retries (flushParkedDeliveries releasing a parked row as
 * {txId, subscriptionId}) and the freshness rule they judge by.
 *
 * Production wedge (CT-2442): the July retention sweep deleted transactions
 * whose parked rows survived.  dispatchWebhook returned on "transaction not
 * found" without touching the row, so the flush re-released the same 50
 * oldest rows every minute, forever, and every live row behind them starved.
 */
describe('targeted retries of parked deliveries', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

  function tradeRow(over: Record<string, unknown> = {}) {
    const seen = isoAgo(60 * 60 * 1000);
    return {
      id: 'tx_1', doc_id: 'doc_1', filer_id: 'K000388', tx_date: seen.slice(0, 10), owner: 'self',
      asset_name: 'Apple Inc.', ticker: 'AAPL', asset_type: 'stock', tx_type: 'B',
      amount_min: 1001, amount_max: 15000, is_option: 0, cap_gains_over_200: 0,
      raw_text: 'AAPL purchase', confidence: 0.99, source: 'primary',
      filed_date: seen.slice(0, 10), first_seen_at: seen, created_at: seen, cursor_seq: 42,
      deprecated_at: null,
      ...over,
    };
  }

  interface FakeRow {
    id: string;
    subscription_id: string;
    tx_id: string;
    status: string;
    attempts: number;
    last_error: string | null;
    updated_at: string;
    claim_token: string | null;
    lease_until: string | null;
  }

  /**
   * One deliveries row (or none) behind a closed circuit, with enough of the
   * claim/record SQL for a real POST to land.  `transaction` is what the
   * dispatch's lookup returns (null = swept).  The fake's parked scan never
   * classifies the transaction, so a row leaves the parked set here only if
   * the dispatch moves it (the flush-side check is pinned in
   * targetCircuit.test.ts).
   */
  function retryEnv(
    transaction: Record<string, unknown> | null,
    opts: { status?: string | null; targetUrl?: string | null } = {},
  ) {
    const subRow = {
      id: 'sub_1', client_id: 'integration:ops', delivery: 'webhook',
      target_url: opts.targetUrl === undefined ? 'https://hooks.example.test/trade' : opts.targetUrl,
      secret: 'sub_secret', filters: '{}', cursor: 0, active: 1, created_at: '2026-06-20T00:00:00.000Z',
    };
    const status = opts.status === undefined ? 'parked' : opts.status;
    let row: FakeRow | null = status
      ? {
          id: 'dlv_1', subscription_id: 'sub_1', tx_id: 'tx_1', status, attempts: 0,
          last_error: 'target circuit: circuit-open', updated_at: '2026-07-21T00:00:00.000Z',
          claim_token: null, lease_until: null,
        }
      : null;
    const queueSends: unknown[] = [];
    const prepare = (sql: string) => ({
      params: [] as unknown[],
      bind(...params: unknown[]) { this.params = params; return this; },
      async first<T>() {
        if (/FROM transactions WHERE id = \?/i.test(sql)) return transaction as T | null;
        if (/AS chamber, fl\.party AS party/i.test(sql)) return { chamber: 'house', party: 'D' } as T;
        if (/FROM securities_ref/i.test(sql)) return null as T | null;
        if (/FROM deliveries WHERE subscription_id = \? AND tx_id = \?/i.test(sql)) return (row ? { ...row } : null) as T | null;
        if (/FROM subscriptions/i.test(sql)) return subRow as T;
        // delivery_target_circuit and the parked-depth count: no row = closed.
        return null as T | null;
      },
      async all<T>() {
        if (/FROM deliveries d\s+JOIN subscriptions s/i.test(sql)) {
          if (/\(t\.id IS NULL OR t\.deprecated_at IS NOT NULL\)/i.test(sql)) return { results: [] as T[] };
          const want = /d\.status = 'parked'/i.test(sql) ? 'parked' : 'quarantined';
          const results = row && row.status === want
            ? [{ subscription_id: row.subscription_id, tx_id: row.tx_id, target_url: subRow.target_url }]
            : [];
          return { results: results as T[] };
        }
        if (/active = 1 AND delivery = 'webhook'/i.test(sql)) return { results: [subRow] as T[] };
        return { results: [] as T[] };
      },
      async run() {
        const p = this.params;
        const changed = (n: number) => ({ success: true, meta: { changes: n } });
        if (/SET status = 'skipped'/i.test(sql) && /status IN \('parked', 'quarantined'\)/i.test(sql)) {
          if (!row || (row.status !== 'parked' && row.status !== 'quarantined')) return changed(0);
          row.status = 'skipped';
          row.last_error = p[0] as string;
          row.updated_at = p[1] as string;
          return changed(1);
        }
        if (/INSERT INTO deliveries/i.test(sql) && /'sending'/.test(sql)) {
          row = {
            id: p[0] as string, subscription_id: p[1] as string, tx_id: p[2] as string, status: 'sending',
            attempts: 1, last_error: null, updated_at: p[3] as string, claim_token: p[4] as string, lease_until: p[5] as string,
          };
          return changed(1);
        }
        if (/SET status = 'sending', attempts = attempts \+ 1/i.test(sql)) {
          if (!row) return changed(0);
          Object.assign(row, { status: 'sending', attempts: row.attempts + 1, claim_token: p[0], lease_until: p[1], updated_at: p[2] });
          return changed(1);
        }
        if (/UPDATE deliveries\s+SET status = \?, attempts = \?/i.test(sql)) {
          if (!row) return changed(0);
          Object.assign(row, { status: p[0], attempts: p[1], last_error: p[2], updated_at: p[3], claim_token: null, lease_until: null });
          return changed(1);
        }
        return changed(1);
      },
    });
    const env = {
      DB: { prepare } as unknown as D1Database,
      DELIVERY_QUEUE: { send: vi.fn(async (msg: unknown) => void queueSends.push(msg)), sendBatch: vi.fn() },
      CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
    } as unknown as Env;
    return { env, queueSends, row: () => row };
  }

  /** Receipt-acknowledging target; records each POSTed payload. */
  function stubTarget() {
    const posts: Array<{ transaction?: { isBackfill?: boolean } }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
        const type = new URL(url).searchParams.get('type');
        return Response.json({ Status: 0, Answer: type === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [] });
      }
      posts.push(JSON.parse(String(init?.body ?? '{}')));
      return Response.json(
        { receiptVersion: 1, delivered: true, consumed: true, ok: true, applied: 1 },
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }));
    return posts;
  }

  const retry = { type: 'delivery.dispatch' as const, txId: 'tx_1', subscriptionId: 'sub_1' };

  it('skips a parked row whose transaction was swept, and the next flush does not release it again', async () => {
    const { env, queueSends, row } = retryEnv(null);
    const posts = stubTarget();
    try {
      expect(await flushParkedDeliveries(env, { limit: 50 })).toMatchObject({ released: 1 });
      await dispatchWebhook(env, queueSends[0] as typeof retry);
      expect(row()).toMatchObject({ status: 'skipped', last_error: 'transaction no longer exists' });
      // Before the fix the row stayed parked with its July updated_at and came
      // straight back at the head of the next page.
      expect(await flushParkedDeliveries(env, { limit: 50 })).toMatchObject({ scanned: 0, released: 0 });
      expect(queueSends).toHaveLength(1);
      expect(posts).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('skips a parked row whose transaction was retracted', async () => {
    const { env, row } = retryEnv(tradeRow({ deprecated_at: isoAgo(DAY_MS) }));
    const posts = stubTarget();
    try {
      await dispatchWebhook(env, retry);
      expect(row()).toMatchObject({ status: 'skipped', last_error: 'transaction retracted' });
      expect(posts).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('skips a quarantined row the same way', async () => {
    const { env, row } = retryEnv(null, { status: 'quarantined' });
    await dispatchWebhook(env, retry);
    expect(row()).toMatchObject({ status: 'skipped', last_error: 'transaction no longer exists' });
  });

  it('skips a targeted row whose subscription has no webhook target', async () => {
    const { env, row } = retryEnv(tradeRow(), { targetUrl: null });
    await dispatchWebhook(env, retry);
    expect(row()).toMatchObject({ status: 'skipped', last_error: 'subscription has no webhook target' });
  });

  it('leaves deliveries alone when a fan-out dispatch finds no transaction', async () => {
    const { env, row } = retryEnv(null);
    const result = await dispatchWebhook(env, 'tx_1');
    expect(result.outboxComplete).toBe(true);
    expect(row()).toMatchObject({ status: 'parked', last_error: 'target circuit: circuit-open' });
  });

  it('delivers a fresh disclosure with an old trade date under default filters {}', async () => {
    // Filed and first seen today; the trade itself is 52 days old, which is
    // the median disclosure lag.  Since Oct 15 the trade-date rule dropped these.
    const { env, row } = retryEnv(tradeRow({ tx_date: isoAgo(52 * DAY_MS).slice(0, 10) }), { status: null });
    const posts = stubTarget();
    try {
      await dispatchWebhook(env, 'tx_1');
      expect(posts).toHaveLength(1);
      expect(posts[0].transaction?.isBackfill).toBe(false);
      expect(row()).toMatchObject({ status: 'delivered' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('delivers a targeted retry that was fresh when it parked, though fan-out now would class it backfill', async () => {
    // First seen, persisted and filed 10 days ago, then parked behind an open
    // circuit.  Judged as of now it is backfill; judged as of when fan-out
    // matched it, it was fresh.
    const seen = isoAgo(10 * DAY_MS);
    const trade = tradeRow({
      filed_date: seen.slice(0, 10), first_seen_at: seen, created_at: seen,
      tx_date: isoAgo(60 * DAY_MS).slice(0, 10),
    });

    const fanout = retryEnv(trade, { status: null });
    const fanoutPosts = stubTarget();
    try {
      await dispatchWebhook(fanout.env, 'tx_1');
      expect(fanoutPosts).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }

    const { env, row } = retryEnv(trade);
    const posts = stubTarget();
    try {
      await dispatchWebhook(env, retry);
      expect(posts).toHaveLength(1);
      expect(posts[0].transaction?.isBackfill).toBe(false);
      expect(row()).toMatchObject({ status: 'delivered' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still skips a targeted retry that was already backfill when first seen', async () => {
    const seen = isoAgo(10 * DAY_MS);
    const { env, row } = retryEnv(tradeRow({
      filed_date: '2023-03-08', first_seen_at: seen, created_at: seen, tx_date: '2023-03-01',
    }));
    const posts = stubTarget();
    try {
      await dispatchWebhook(env, retry);
      expect(posts).toHaveLength(0);
      expect(row()).toMatchObject({ status: 'skipped', last_error: 'subscription filters no longer match transaction' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
