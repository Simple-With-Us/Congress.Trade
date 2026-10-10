import { describe, it, expect } from 'vitest';
import { formatTradeEvent, openSseStream, SSE_BACKLOG_DRAIN_INTERVAL_MS } from '../sse.ts';
import type { Env, Transaction } from '../../shared/types.ts';
import type { SubscriptionRow } from '../rows.ts';

/**
 * Cross-app contract guard. Agentic Trading's stream consumer
 * (congress-trade-events.ts) keys delivery on `type === 'congress.trade'` and
 * reads `data.trades`. This test pins the SSE frame to that shared contract so a
 * regression back to the old `trade.new` / bare-tx shape (which the peer app
 * silently dropped) fails the build.
 */
const tx = {
  id: 'tx_123',
  cursorSeq: 42,
  ticker: 'AAPL',
  txType: 'buy',
} as unknown as Transaction;

describe('formatTradeEvent (SSE cross-app contract)', () => {
  const frame = formatTradeEvent(tx);

  it('emits the canonical congress.trade event name', () => {
    expect(frame).toContain('\nevent: congress.trade\n');
    expect(frame).not.toContain('trade.new');
  });

  it('emits a shared CongressEvent envelope with data.trades', () => {
    const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))!;
    const payload = JSON.parse(dataLine.slice('data: '.length));
    expect(payload.type).toBe('congress.trade');
    expect(payload.id).toBe('42');
    expect(typeof payload.emittedAt).toBe('string');
    expect(Array.isArray(payload.data?.trades)).toBe(true);
    expect(payload.data.trades).toHaveLength(1);
    expect(payload.data.trades[0].id).toBe('tx_123');
  });

  it('carries cursorSeq as the SSE id for Last-Event-ID resume', () => {
    expect(frame.startsWith('id: 42\n')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
  });
});

describe('openSseStream live-tail backlog drain (cross-region safety net)', () => {
  const subRow: SubscriptionRow = {
    id: 'sub_1',
    client_id: 'ops-integration', // not user:* so the entitlement re-check passes
    delivery: 'sse',
    target_url: null,
    secret: 'stream-secret',
    filters: '{}',
    cursor: 0,
    active: 1,
    created_at: '2026-01-01T00:00:00.000Z',
  };

  function makeEnv(counter: { backlogReads: number; backlogSince?: number[] }, hwm = 0): Env {
    const prepare = (sql: string) => ({
      params: [] as unknown[],
      bind(...params: unknown[]) {
        this.params = params;
        return this;
      },
      async first<T>() {
        if (/FROM subscriptions WHERE id = \?/i.test(sql)) return subRow as T;
        if (/SELECT active FROM subscriptions/i.test(sql)) return { active: 1 } as T;
        if (/MAX\(cursor_seq\)/i.test(sql)) return { hwm } as T;
        return null as T | null;
      },
      async all<T>() {
        if (/MAX\(cursor_seq\)/i.test(sql)) {
          return { results: [{ hwm }] as T[] };
        }
        if (/idx_tx_cursor/i.test(sql)) {
          counter.backlogReads += 1;
          counter.backlogSince?.push(Number(this.params[0]));
          return { results: [] as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        return { success: true, meta: { changes: 1 } };
      },
    });
    // No CONFIG_KV: rate limiting fails open, D1-budget flush is a no-op.
    return { DB: { prepare } as unknown as D1Database } as unknown as Env;
  }

  async function readToClose(res: Response): Promise<string> {
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

  it('re-drains the durable backlog on the drain interval, not only on broadcast gaps', async () => {
    const counter = { backlogReads: 0 };
    const res = await openSseStream(makeEnv(counter), 'sub_1', 0, 'stream-secret', '127.0.0.1', {
      maxStreamMs: 500,
      pollIntervalMs: 15,
      backlogDrainIntervalMs: 40,
      reconnectGraceMs: 10,
    });
    expect(res.status).toBe(200);
    const body = await readToClose(res);
    // Initial catch-up replay = 1 read; the live tail must keep draining on the
    // interval (≈6 ticks of 40ms in 260ms) even though no BroadcastChannel
    // message ever arrives in this isolate.
    expect(counter.backlogReads).toBeGreaterThanOrEqual(2);
    expect(body).toContain('event: ping');
    expect(body).toContain('event: reconnect');
  });

  it('exposes a sane default drain cadence (30-60s per the cross-region fix)', () => {
    expect(SSE_BACKLOG_DRAIN_INTERVAL_MS).toBeGreaterThanOrEqual(30_000);
    expect(SSE_BACKLOG_DRAIN_INTERVAL_MS).toBeLessThanOrEqual(60_000);
  });

  it('does not replay history when no resume cursor is provided (live tail at HWM)', async () => {
    const counter = { backlogReads: 0, backlogSince: [] as number[] };
    const hwm = 12_345;
    const res = await openSseStream(makeEnv(counter, hwm), 'sub_1', undefined, 'stream-secret', '127.0.0.1', {
      maxStreamMs: 120,
      pollIntervalMs: 10,
      backlogDrainIntervalMs: 200,
      reconnectGraceMs: 10,
    });
    expect(res.status).toBe(200);
    const body = await readToClose(res);
    expect(body).toContain(`event: cursor\ndata: ${hwm}`);
    // No initial catch-up drain; periodic safety-net drains use the live cursor.
    expect(counter.backlogReads).toBe(0);
  });

  it('still runs catch-up replay when since=0 is explicit', async () => {
    const counter = { backlogReads: 0, backlogSince: [] as number[] };
    const res = await openSseStream(makeEnv(counter, 99), 'sub_1', 0, 'stream-secret', '127.0.0.1', {
      maxStreamMs: 80,
      pollIntervalMs: 10,
      reconnectGraceMs: 10,
    });
    expect(res.status).toBe(200);
    await readToClose(res);
    expect(counter.backlogReads).toBeGreaterThanOrEqual(1);
    expect(counter.backlogSince[0]).toBe(0);
  });
});
