import { describe, expect, it } from 'vitest';
import {
  AUTO_TRANSIENT_DLQ_MAX_CYCLES,
  classifyFailedOutboxRow,
  isPoisonDlqError,
  isTransientDlqError,
  requeueTransientFailedDurableJobs,
  requeueTransientFailedIngestionOutbox,
  sweepTransientDeadLetters,
} from '../transientDlq.ts';
import type { Env } from '../../shared/types.ts';

describe('transient vs poison DLQ classification', () => {
  it('treats retry-budget, rate-limit, and transient 403 as replayable', () => {
    expect(isTransientDlqError('consumer retry budget exhausted; received by ingest-dlq')).toBe(true);
    expect(isTransientDlqError('Usage telemetry ingest failed: Too many requests. Slow down.')).toBe(true);
    expect(isTransientDlqError('filing.extracted HTTP 403')).toBe(true);
    expect(isTransientDlqError('fetcher: Unauthorized')).toBe(true);
    expect(isTransientDlqError('usage telemetry circuit is open; live delivery suppressed')).toBe(true);
  });

  it('treats lock and cron-deadline failures as replayable and parked rows as not', () => {
    expect(isTransientDlqError('SQLITE_BUSY: database is locked')).toBe(true);
    expect(isTransientDlqError('Deno cron tick exceeded 45000ms deadline')).toBe(true);
    expect(isTransientDlqError('parked: human review')).toBe(false);
    expect(classifyFailedOutboxRow(
      { last_error: 'parked: human review', dead_letter_cycles: 0, updated_at: '2026-10-05T12:00:00.000Z' },
      '2026-10-04T12:00:00.000Z',
    )).toBe('parked');
    expect(classifyFailedOutboxRow(
      { last_error: 'SQLITE_BUSY: database is locked', dead_letter_cycles: 1, updated_at: '2026-10-01T00:00:00.000Z' },
      '2026-10-04T12:00:00.000Z',
    )).toBe('retryable');
    expect(classifyFailedOutboxRow(
      { last_error: 'SQLITE_BUSY: database is locked', dead_letter_cycles: AUTO_TRANSIENT_DLQ_MAX_CYCLES, updated_at: '2026-10-01T00:00:00.000Z' },
      '2026-10-04T12:00:00.000Z',
    )).toBe('non_retryable');
  });

  it('leaves poison payloads failed', () => {
    expect(isPoisonDlqError('invalid ingest queue message type: filing.local_wait_check')).toBe(true);
    expect(isTransientDlqError('invalid ingest queue message type: filing.local_wait_check')).toBe(false);
    expect(isPoisonDlqError('Please enable R2 through the Cloudflare Dashboard.')).toBe(true);
    expect(isTransientDlqError('Please enable R2 through the Cloudflare Dashboard.')).toBe(false);
  });
});

function memoryOutbox(rows: Array<{ doc_id: string; status: string; last_error: string }>) {
  const store = rows.map((row) => ({ ...row, attempts: 6, dead_letter_cycles: 2 }));
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          params: [] as unknown[],
          bind(...params: unknown[]) { this.params = params; return this; },
          async all() {
            const limit = Number(this.params[0] ?? 100);
            return {
              results: store.filter((row) => row.status === 'failed').slice(0, limit),
              meta: { changes: 0 },
            };
          },
          async run() {
            if (/dead_letter_cycles = dead_letter_cycles \+ 1/.test(sql)) {
              const docId = String(this.params[2]);
              const cap = Number(this.params[3]);
              const row = store.find((entry) => entry.doc_id === docId);
              if (
                row
                && row.status === 'failed'
                && row.dead_letter_cycles < cap
                && !row.last_error.startsWith('parked:')
              ) {
                row.status = 'pending';
                row.dead_letter_cycles += 1;
                return { success: true, meta: { changes: 1 } };
              }
              return { success: true, meta: { changes: 0 } };
            }
            if (/UPDATE ingestion_outbox/.test(sql)) {
              const ids = new Set(this.params.slice(2).map(String));
              let changes = 0;
              for (const row of store) {
                if (row.status === 'failed' && ids.has(row.doc_id)) {
                  row.status = 'pending';
                  changes += 1;
                }
              }
              return { success: true, meta: { changes } };
            }
            return { success: true, meta: { changes: 0 } };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, store };
}

describe('requeueTransientFailedIngestionOutbox', () => {
  it('requeues exhausted retries and leaves poison', async () => {
    const { env, store } = memoryOutbox([
      { doc_id: 'H-1', status: 'failed', last_error: 'consumer retry budget exhausted; received by ingest-dlq' },
      { doc_id: 'H-2', status: 'failed', last_error: 'invalid ingest queue message type: filing.local_wait_check' },
      { doc_id: 'H-3', status: 'failed', last_error: 'consumer retry budget exhausted; received by ingest-dlq' },
    ]);
    const dry = await requeueTransientFailedIngestionOutbox(env, { dryRun: true, limit: 10 });
    expect(dry).toMatchObject({
      dryRun: true, matchedTransient: 2, requeued: 0, skippedPoison: 1,
    });
    expect(store.filter((row) => row.status === 'failed')).toHaveLength(3);

    const applied = await requeueTransientFailedIngestionOutbox(env, {
      now: new Date('2026-08-14T00:00:00.000Z'),
      limit: 10,
    });
    expect(applied.requeued).toBe(2);
    expect(store.find((row) => row.doc_id === 'H-2')?.status).toBe('failed');
    expect(store.find((row) => row.doc_id === 'H-1')?.status).toBe('pending');
    expect(store.find((row) => row.doc_id === 'H-3')?.status).toBe('pending');
  });

  it('bounds the apply batch', async () => {
    const { env, store } = memoryOutbox(
      Array.from({ length: 5 }, (_, i) => ({
        doc_id: `H-${i}`,
        status: 'failed',
        last_error: 'consumer retry budget exhausted; received by ingest-dlq',
      })),
    );
    const applied = await requeueTransientFailedIngestionOutbox(env, { limit: 2 });
    expect(applied.requeued).toBe(2);
    expect(store.filter((row) => row.status === 'pending')).toHaveLength(2);
    expect(store.filter((row) => row.status === 'failed')).toHaveLength(3);
  });

  it('auto-retries transient rows with a cycle cap and leaves parked rows failed', async () => {
    const { env, store } = memoryOutbox([
      { doc_id: 'H-busy', status: 'failed', last_error: 'SQLITE_BUSY: database is locked' },
      { doc_id: 'H-parked', status: 'failed', last_error: 'parked: needs a human' },
      { doc_id: 'H-poison', status: 'failed', last_error: 'invalid ingest queue message type: filing.local_wait_check' },
    ]);
    const capped = store.find((row) => row.doc_id === 'H-busy');
    if (!capped) throw new Error('missing row');
    const parked = store.find((row) => row.doc_id === 'H-parked')!;
    parked.dead_letter_cycles = 0;
    const applied = await requeueTransientFailedIngestionOutbox(env, {
      auto: true,
      now: new Date('2026-10-05T18:00:00.000Z'),
      limit: 10,
    });
    expect(applied.requeued).toBe(1);
    expect(applied.skippedParked).toBe(1);
    expect(applied.skippedPoison).toBe(1);
    expect(store.find((row) => row.doc_id === 'H-busy')).toMatchObject({
      status: 'pending',
      dead_letter_cycles: 3,
    });
    expect(store.find((row) => row.doc_id === 'H-parked')?.status).toBe('failed');
    expect(store.find((row) => row.doc_id === 'H-poison')?.status).toBe('failed');

    capped.dead_letter_cycles = AUTO_TRANSIENT_DLQ_MAX_CYCLES;
    capped.status = 'failed';
    const stopped = await requeueTransientFailedIngestionOutbox(env, { auto: true, limit: 10 });
    expect(stopped.requeued).toBe(0);
    expect(stopped.skippedCapped).toBe(1);
    expect(capped.status).toBe('failed');
  });
});

function memoryDurable(rows: Array<{
  id: number;
  last_error: string;
  status?: string;
  dedupe_key?: string | null;
}>) {
  const store = rows.map((row) => ({
    queue_name: 'ingest',
    status: row.status ?? 'failed',
    attempts: 9,
    dead_letter_cycles: 2,
    dead_letter_pending: 0,
    ...row,
  }));
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          params: [] as unknown[],
          bind(...params: unknown[]) { this.params = params; return this; },
          async all() {
            const limit = Number(this.params[1] ?? 100);
            return {
              results: store
                .filter((row) => row.queue_name === this.params[0] && row.status === 'failed')
                .slice(0, limit),
              meta: { changes: 0 },
            };
          },
          async run() {
            if (/dead_letter_cycles = dead_letter_cycles \+ 1/.test(sql)) {
              const id = Number(this.params[2]);
              const cap = Number(this.params[3]);
              const row = store.find((entry) => entry.id === id);
              if (!row || row.status !== 'failed' || row.dead_letter_cycles >= cap) {
                return { success: true, meta: { changes: 0 } };
              }
              if (row.dedupe_key && store.some((other) =>
                other !== row
                && other.dedupe_key === row.dedupe_key
                && (other.status === 'pending' || other.status === 'processing'))) {
                return { success: true, meta: { changes: 0 } };
              }
              row.status = 'pending';
              row.dead_letter_cycles += 1;
              return { success: true, meta: { changes: 1 } };
            }
            if (!/UPDATE deno_runtime_queue/.test(sql)) {
              return { success: true, meta: { changes: 0 } };
            }
            const ids = new Set(this.params.slice(2).map(Number));
            let changes = 0;
            for (const row of store) {
              if (row.status !== 'failed' || !ids.has(row.id)) continue;
              if (row.dedupe_key && store.some((other) =>
                other !== row
                && other.dedupe_key === row.dedupe_key
                && (other.status === 'pending' || other.status === 'processing'))) {
                continue;
              }
              row.status = 'pending';
              changes += 1;
            }
            return { success: true, meta: { changes } };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, store };
}

describe('requeueTransientFailedDurableJobs', () => {
  it('requeues rate-limit / 403 and leaves invalid message types', async () => {
    const { env, store } = memoryDurable([
      { id: 1, last_error: 'filing.extracted HTTP 403' },
      { id: 2, last_error: 'invalid ingest queue message type: filing.local_wait_check' },
      { id: 3, last_error: 'Usage telemetry ingest failed: Too many requests. Slow down.' },
    ]);
    const applied = await requeueTransientFailedDurableJobs(env, { limit: 10 });
    expect(applied.requeued).toBe(2);
    expect(applied.skippedPoison).toBe(1);
    expect(store.find((row) => row.id === 2)?.status).toBe('failed');
    expect(store.find((row) => row.id === 1)?.status).toBe('pending');
  });

  it('auto-retries a busy durable job once per cycle', async () => {
    const { env, store } = memoryDurable([
      { id: 9, last_error: 'SQLITE_BUSY: database is locked' },
    ]);
    const applied = await requeueTransientFailedDurableJobs(env, { auto: true, limit: 5 });
    expect(applied.requeued).toBe(1);
    expect(store.find((row) => row.id === 9)).toMatchObject({
      status: 'pending',
      dead_letter_cycles: 3,
    });
  });
});

describe('sweepTransientDeadLetters', () => {
  it('requeues ingestion and both durable queues without touching poison', async () => {
    const ingestion = memoryOutbox([
      { doc_id: 'H-busy', status: 'failed', last_error: 'database is locked' },
    ]);
    const durable = memoryDurable([
      { id: 1, last_error: 'Deno cron tick exceeded 45000ms deadline' },
      { id: 2, last_error: 'invalid payload' },
    ]);
    const env = {
      DB: {
        prepare(sql: string) {
          if (/ingestion_outbox/.test(sql)) return ingestion.env.DB.prepare(sql);
          return durable.env.DB.prepare(sql);
        },
      },
    } as unknown as Env;
    const result = await sweepTransientDeadLetters(env, new Date('2026-10-05T18:00:00.000Z'));
    expect(result.ingestion.requeued).toBe(1);
    expect(result.ingestQueue.requeued + result.deliveryQueue.requeued).toBeGreaterThanOrEqual(1);
    expect(ingestion.store.find((row) => row.doc_id === 'H-busy')?.status).toBe('pending');
  });
});
