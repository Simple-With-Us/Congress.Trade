import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import {
  acquireSseLease,
  createSseBackpressureStream,
  drainSseBacklog,
  MAX_DRAIN_PAGES_PER_TICK,
  openSseStream,
  releaseSseLease,
  SSE_LEASE_MS,
  SseSlowReaderError,
  SseStreamDeadlineError,
} from '../sse.ts';
import type { Subscription } from '../../shared/types.ts';
import { freshDeliveryDay, freshDeliveryIso } from './freshDeliveryFixtures.ts';

const sub = {
  id: 'sub_1', client_id: 'client_1', delivery: 'sse', target_url: null,
  secret: 'stream-secret', filters: '{}', cursor: 0, active: 1,
  created_at: '2026-01-01T00:00:00.000Z',
};

function makeEnv(opts: { quota?: boolean; rateCount?: string | null } = {}) {
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const leases = new Map<string, { expires: string }>();
  const prepare = (sql: string) => ({
    params: [] as unknown[], bind(...params: unknown[]) { this.params = params; return this; },
    async first<T>() {
      if (/FROM subscriptions/i.test(sql)) return sub as T;
      return null as T | null;
    },
    async all<T>() { return { results: [] as T[] }; },
    async run() {
      writes.push({ sql, params: this.params });
      if (/INSERT INTO sse_leases/i.test(sql)) {
        if (opts.quota) throw new Error('D1_ERROR: sse subscription connection quota exceeded');
        leases.set(String(this.params[0]), { expires: String(this.params[3]) });
      } else if (/DELETE FROM sse_leases WHERE id/i.test(sql)) {
        leases.delete(String(this.params[0]));
      } else if (/DELETE FROM sse_leases WHERE expires_at/i.test(sql)) {
        const now = String(this.params[0]);
        for (const [id, lease] of leases) if (lease.expires <= now) leases.delete(id);
      }
      return { success: true, meta: { changes: 1 } };
    },
  });
  const env = {
    DB: { prepare } as unknown as D1Database,
    CONFIG_KV: {
      get: vi.fn(async () => opts.rateCount ?? null),
      put: vi.fn(async () => {}), delete: vi.fn(async () => {}),
    },
  } as unknown as Env;
  return { env, writes, leases };
}

describe('durable SSE admission', () => {
  it('bounds catch-up work per tick and resumes monotonically beyond the cap', async () => {
    const rows = Array.from({ length: 1_201 }, (_, index) => ({
      id: `tx_${index + 1}`, doc_id: 'doc_1', filer_id: null, tx_date: freshDeliveryDay,
      owner: 'self', asset_name: 'Asset', ticker: null, asset_type: 'stock', tx_type: 'B',
      amount_min: 1001, amount_max: 15000, is_option: 0, cap_gains_over_200: 0,
      raw_text: '', confidence: 1, source: 'primary',
      filed_date: freshDeliveryDay,
      first_seen_at: freshDeliveryIso,
      created_at: freshDeliveryIso,
      cursor_seq: index + 1,
    }));
    let queries = 0;
    const env = {
      DB: {
        prepare: () => ({
          params: [] as unknown[], bind(...params: unknown[]) { this.params = params; return this; },
          async all<T>() {
            queries += 1;
            const cursor = Number(this.params[0]);
            const limit = Number(this.params[1]);
            return { results: rows.filter((row) => row.cursor_seq > cursor).slice(0, limit) as T[] };
          },
        }),
      } as unknown as D1Database,
    } as unknown as Env;
    const subscription: Subscription = {
      id: 'sub', clientId: 'client', delivery: 'sse', targetUrl: null, secret: 'secret',
      filters: {}, cursor: 0, active: true, createdAt: '',
    };
    const first = await drainSseBacklog(env, subscription, 0, async () => {});
    expect(first).toBe(MAX_DRAIN_PAGES_PER_TICK * 200);
    expect(queries).toBe(MAX_DRAIN_PAGES_PER_TICK);
    const second = await drainSseBacklog(env, subscription, first, async () => {});
    expect(second).toBe(1_201);
    expect(second).toBeGreaterThan(first);
    expect(queries).toBe(MAX_DRAIN_PAGES_PER_TICK + 2);
  });

  it('authenticates the stream token before consuming a lease', async () => {
    const { env, writes } = makeEnv();
    const response = await openSseStream(env, sub.id, 0, 'wrong-token', '203.0.113.1');
    expect(response.status).toBe(401);
    expect(writes.some((write) => /sse_leases/i.test(write.sql))).toBe(false);
  });

  it('returns 429 when the race-safe D1 quota trigger rejects admission', async () => {
    const { env } = makeEnv({ quota: true });
    const response = await openSseStream(env, sub.id, 0, sub.secret, '203.0.113.1');
    expect(response.status).toBe(429);
  });

  it('creates an expiry beyond stream lifetime and releases idempotently', async () => {
    const { env, leases } = makeEnv();
    const now = new Date('2026-07-01T00:00:00.000Z');
    const id = await acquireSseLease(env, sub.id, sub.client_id, now);
    expect(Date.parse(leases.get(id)?.expires ?? '') - now.getTime()).toBe(SSE_LEASE_MS);
    await releaseSseLease(env, id);
    await releaseSseLease(env, id);
    expect(leases.size).toBe(0);
  });

  it('returns 429 when the authenticated subscription open rate is exhausted', async () => {
    const { env, writes } = makeEnv({ rateCount: '10' });
    const response = await openSseStream(env, sub.id, 0, sub.secret, '203.0.113.1');
    expect(response.status).toBe(429);
    expect(writes.some((write) => /INSERT INTO sse_leases/i.test(write.sql))).toBe(false);
  });

  it('does not resolve a backlog high-water cursor before its frame is accepted', async () => {
    const row = {
      id: 'tx_1', doc_id: 'doc_1', filer_id: null, tx_date: freshDeliveryDay,
      owner: 'self', asset_name: 'Asset', ticker: null, asset_type: 'stock', tx_type: 'B',
      amount_min: 1001, amount_max: 15000, is_option: 0, cap_gains_over_200: 0,
      raw_text: '', confidence: 1, source: 'primary',
      filed_date: freshDeliveryDay,
      first_seen_at: freshDeliveryIso,
      created_at: freshDeliveryIso,
      cursor_seq: 1,
    };
    const env = {
      DB: {
        prepare: () => ({
          async all<T>() { return { results: [row] as T[] }; },
          bind() { return this; },
        }),
      } as unknown as D1Database,
    } as unknown as Env;
    const subscription: Subscription = {
      id: 'sub', clientId: 'client', delivery: 'sse', targetUrl: null, secret: 'secret',
      filters: {}, cursor: 0, active: true, createdAt: '',
    };
    let acceptFrame: (() => void) | undefined;
    const accepted = new Promise<void>((resolve) => { acceptFrame = resolve; });
    let settled = false;
    let sendCalled = false;

    const draining = drainSseBacklog(env, subscription, 0, async () => {
      sendCalled = true;
      await accepted;
    })
      .finally(() => { settled = true; });
    await vi.waitFor(() => expect(sendCalled).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);

    acceptFrame?.();
    await expect(draining).resolves.toBe(1);
  });

  it('allows only one backpressured frame in flight and aborts a slow reader', async () => {
    const stream = createSseBackpressureStream(20);
    const deadlineAt = Date.now() + 500;
    const pending = stream.write('first frame', deadlineAt);
    await Promise.resolve();

    await expect(stream.write('must not queue', deadlineAt)).rejects.toThrow('concurrent SSE write rejected');
    await expect(pending).rejects.toBeInstanceOf(SseSlowReaderError);

    const reader = stream.readable.getReader();
    await expect(reader.read()).rejects.toBeInstanceOf(SseSlowReaderError);
  });

  it('closes gracefully when the deadline has already passed (no abort on natural end)', async () => {
    // Regression: close(deadlineAt) used to throw SseStreamDeadlineError the
    // moment the deadline elapsed, so every stream reaching its natural
    // maxStreamMs terminated via abort() — a transport error to the client —
    // instead of a clean end-of-stream. Past-deadline close now gets a small
    // bounded grace to flush writer.close().
    const stream = createSseBackpressureStream(50);
    const reader = stream.readable.getReader();
    const readLoop = (async () => {
      const chunks: unknown[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return chunks;
        chunks.push(value);
      }
    })();

    await stream.write('data: last frame\n\n', Date.now() + 1_000);
    await expect(stream.close(Date.now() - 5)).resolves.toBeUndefined();
    await expect(readLoop).resolves.toHaveLength(1);
  });

  it('still bounds a past-deadline write against a reader that never drains', async () => {
    const stream = createSseBackpressureStream(50);
    // Nobody reads: writer.ready never resolves, so the clamped 10ms grace
    // budget must expire and classify the failure as a deadline error.
    await expect(stream.write('data: frame\n\n', Date.now() - 5))
      .rejects.toBeInstanceOf(SseStreamDeadlineError);
  });

  it('closes and releases the lease when a client never reads', async () => {
    const { env, leases } = makeEnv();
    const response = await openSseStream(env, sub.id, 0, sub.secret, '203.0.113.1', {
      maxStreamMs: 500,
      pollIntervalMs: 10,
      reconnectGraceMs: 20,
      slowReaderTimeoutMs: 20,
    });
    expect(response.status).toBe(200);

    await vi.waitFor(() => expect(leases.size).toBe(0), { timeout: 500 });
    if (!response.body) throw new Error('expected SSE response body');
    const reader = response.body.getReader();
    await expect(reader.read()).rejects.toBeInstanceOf(SseSlowReaderError);
  });

  it('emits reconnect and ends within the overall stream deadline', async () => {
    const { env, leases } = makeEnv();
    const startedAt = Date.now();
    const response = await openSseStream(env, sub.id, 7, sub.secret, '203.0.113.1', {
      maxStreamMs: 250,
      pollIntervalMs: 10,
      reconnectGraceMs: 125,
      slowReaderTimeoutMs: 150,
    });

    const payload = await response.text();
    expect(payload).toContain('event: cursor\ndata: 7');
    expect(payload).toContain('event: reconnect');
    expect(Date.now() - startedAt).toBeLessThan(750);
    await vi.waitFor(() => expect(leases.size).toBe(0), { timeout: 750 });
  });
});
