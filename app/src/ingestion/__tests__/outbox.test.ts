import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import {
  completeIngestionOutbox,
  flushIngestionOutbox,
  INGESTION_ENQUEUED_STALE_MS,
  reconnectDeadLetteredIngestionOutbox,
  requeueFailedIngestionOutbox,
} from '../outbox.ts';

function makeEnv(sendFails = false) {
  const row = {
    doc_id: 'doc_1', chamber: 'house' as const, source_url: 'https://example.com/doc.pdf',
    status: 'pending', attempts: 0, available_at: '2026-01-01T00:00:00.000Z',
    dead_letter_cycles: 0,
    updated_at: '2026-01-01T00:00:00.000Z',
    last_error: null as string | null,
  };
  let fail = sendFails;
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) { this.params = params; return this; },
    async all<T>() {
      // CT-2459: bulk claim is UPDATE..RETURNING via all() — simulate the
      // claim transition here so `run()` no longer sees it.
      if (/SET status = 'sending'/i.test(sql) && /RETURNING/i.test(sql)) {
        const now = String(this.params[1]);
        const staleBefore = String(this.params[this.params.length - 1]);
        const ready = (['pending', 'sending'].includes(row.status) && row.available_at <= now)
          || (row.status === 'enqueued' && row.updated_at <= staleBefore);
        if (!ready) return { results: [] as T[] };
        row.status = 'sending'; row.attempts += 1;
        row.available_at = String(this.params[0]); row.updated_at = now;
        return { results: [{ doc_id: row.doc_id, attempts: row.attempts }] as T[] };
      }
      if (/WHERE doc_id = \?/i.test(sql)) return { results: [row] as T[] };
      const now = String(this.params[0]);
      const staleBefore = String(this.params[1]);
      const ready = (['pending', 'sending'].includes(row.status) && row.available_at <= now)
        || (row.status === 'enqueued' && row.updated_at <= staleBefore);
      return { results: ready ? [row] as T[] : [] as T[] };
    },
    async run() {
      if (/SET status = 'sending'/i.test(sql)) {
        row.status = 'sending'; row.attempts += 1; row.available_at = String(this.params[0]); row.updated_at = String(this.params[1]);
      } else if (/SET status = 'enqueued'/i.test(sql)) {
        row.status = 'enqueued'; row.available_at = String(this.params[0]); row.updated_at = String(this.params[1]);
      } else if (/SET status = 'completed'/i.test(sql)) {
        if (row.status === 'completed') return { success: true, meta: { changes: 0 } };
        row.status = 'completed'; row.available_at = String(this.params[0]); row.updated_at = String(this.params[1]);
      } else if (/SET status = 'pending'/i.test(sql)) {
        row.status = 'pending'; row.available_at = String(this.params[0]); row.last_error = String(this.params[1]); row.updated_at = String(this.params[2]);
        if (/dead_letter_cycles = dead_letter_cycles \+ 1/i.test(sql)) row.dead_letter_cycles += 1;
      } else if (/SET status = 'failed'/i.test(sql)) {
        row.status = 'failed'; row.last_error = String(this.params[0]);
      }
      return { success: true, meta: { changes: 1 } };
    },
  });
  const send = vi.fn(async () => { if (fail) throw new Error('queue unavailable'); });
  // CT-2459: flush prefers sendBatch; route it through `send` so the
  // outage simulation and call assertions keep covering every message.
  const sendBatch = vi.fn(async (messages: Array<{ body: unknown }>) => {
    for (const m of messages) await send(m.body as never);
  });
  const env = {
    DB: { prepare } as unknown as D1Database,
    INGEST_QUEUE: { send, sendBatch },
  } as unknown as Env;
  return { env, row, send, recoverQueue: () => { fail = false; } };
}

describe('ingestion discovery outbox', () => {
  it('retains a queue outage and later recovers the filing.new handoff', async () => {
    const { env, row, send, recoverQueue } = makeEnv(true);
    expect(await flushIngestionOutbox(env, { now: new Date('2026-07-01T00:00:00.000Z') }))
      .toEqual({ claimed: 1, enqueued: 0, failed: 1 });
    expect(row.status).toBe('pending');
    expect(row.last_error).toBe('queue unavailable');

    recoverQueue();
    expect(await flushIngestionOutbox(env, { now: new Date('2026-07-01T00:01:00.000Z') }))
      .toEqual({ claimed: 1, enqueued: 1, failed: 0 });
    expect(send).toHaveBeenLastCalledWith({
      type: 'filing.new', docId: 'doc_1', chamber: 'house', sourceUrl: 'https://example.com/doc.pdf',
    });
    expect(row.status).toBe('enqueued');
  });

  it('completes canonical work permanently and never replays it', async () => {
    const { env, row, send } = makeEnv();
    row.status = 'enqueued';
    expect(await completeIngestionOutbox(env, 'doc_1', new Date('2026-07-01T00:00:00.000Z')))
      .toBe('completed');
    expect(await flushIngestionOutbox(env, { now: new Date('2027-07-01T00:00:00.000Z') }))
      .toEqual({ claimed: 0, enqueued: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(row.status).toBe('completed');
    expect(await reconnectDeadLetteredIngestionOutbox(
      env, 'doc_1', 'late filing.new DLQ', new Date(), { reopenCompleted: false },
    )).toEqual({ status: 'completed', deadLetterCycles: 0 });
  });

  it('replays only stale enqueued discovery work after DLQ loss', async () => {
    const now = new Date('2026-07-01T04:00:00.000Z');
    const stale = makeEnv();
    stale.row.status = 'enqueued';
    stale.row.updated_at = new Date(now.getTime() - INGESTION_ENQUEUED_STALE_MS - 1).toISOString();
    expect(await flushIngestionOutbox(stale.env, { now })).toEqual({ claimed: 1, enqueued: 1, failed: 0 });
    expect(stale.send).toHaveBeenCalledOnce();

    const fresh = makeEnv();
    fresh.row.status = 'enqueued';
    fresh.row.updated_at = new Date(now.getTime() - INGESTION_ENQUEUED_STALE_MS + 1).toISOString();
    expect(await flushIngestionOutbox(fresh.env, { now })).toEqual({ claimed: 0, enqueued: 0, failed: 0 });
    expect(fresh.send).not.toHaveBeenCalled();
  });

  it('reconnects a later-stage ingest dead letter to the canonical start', async () => {
    const { env, row } = makeEnv();
    row.status = 'enqueued'; row.attempts = 99;
    expect(await reconnectDeadLetteredIngestionOutbox(
      env, 'doc_1', 'filing.fetched exhausted', new Date('2026-07-01T00:00:00.000Z'),
    )).toEqual({ status: 'pending', deadLetterCycles: 1 });
    expect(row.status).toBe('pending');
    expect(row.last_error).toBe('filing.fetched exhausted');
  });

  it('caps poison dead-letter restart cycles', async () => {
    const { env, row } = makeEnv();
    row.status = 'enqueued'; row.attempts = 0; row.dead_letter_cycles = 5;
    expect(await reconnectDeadLetteredIngestionOutbox(env, 'doc_1', 'poison'))
      .toEqual({ status: 'failed', deadLetterCycles: 5 });
    expect(row.status).toBe('failed');
  });

  it('requeues failed rows with a fresh dead-letter budget, scoped by doc-id prefix', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const env = {
      DB: {
        prepare: (sql: string) => ({
          params: [] as unknown[],
          bind(...params: unknown[]) { this.params = params; return this; },
          async run() { calls.push({ sql, params: this.params }); return { success: true, meta: { changes: 500 } }; },
        }),
      } as unknown as D1Database,
    } as unknown as Env;

    expect(await requeueFailedIngestionOutbox(env, {
      docIdPrefix: 'H-2015-%_', now: new Date('2026-07-12T05:00:00.000Z'),
    })).toBe(500);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/SET status = 'pending', attempts = 0, dead_letter_cycles = 0/);
    expect(calls[0].sql).toMatch(/WHERE status = 'failed' AND doc_id LIKE \?/);
    // LIKE wildcards in the caller-supplied prefix are stripped, not honored.
    expect(calls[0].params).toEqual([
      '2026-07-12T05:00:00.000Z', '2026-07-12T05:00:00.000Z', 'H-2015-%',
    ]);
  });
});
