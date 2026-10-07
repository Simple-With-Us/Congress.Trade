import { createClient } from '@libsql/client';
import { handleIngestMessage } from '../../queueHandlers.ts';
import { isTerminalUsageTelemetryDeliveryError } from '../../shared/thirdPartyTelemetry.ts';
import { describe, expect, it, vi } from 'vitest';
import type { Env, QueueMessage } from '../../shared/types.ts';
import {
  drainDurableQueue,
  DurableQueueAdapter,
  DurableQueueLeaseLostError,
  DURABLE_QUEUE_MAX_DEAD_LETTER_CYCLES,
  requeueFailedDurableJobs,
  type DurableQueueHandlers,
} from '../durableQueue.ts';
import { D1DatabaseShim } from '../shims.ts';
import { settleLlmSpend } from '../../shared/llmSpend.ts';

const START = new Date('2026-07-22T16:00:00.000Z');

async function createHarness() {
  const client = createClient({ url: 'file::memory:' });
  await client.execute(`
    CREATE TABLE deno_runtime_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_name TEXT NOT NULL,
      dedupe_key TEXT,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      dead_letter_pending INTEGER NOT NULL DEFAULT 0,
      dead_letter_cycles INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      lease_until TEXT,
      lease_token TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await client.execute(`
    CREATE UNIQUE INDEX idx_deno_runtime_queue_active_dedupe
      ON deno_runtime_queue(queue_name, dedupe_key)
      WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'processing')
  `);

  let current = new Date(START);
  const now = () => new Date(current);
  const setNow = (value: Date) => { current = new Date(value); };
  const db = new D1DatabaseShim(client as never) as unknown as D1Database;
  const ingest = new DurableQueueAdapter<QueueMessage>(db, 'ingest', now);
  const delivery = new DurableQueueAdapter<QueueMessage>(db, 'delivery', now);
  const env = {
    DB: db,
    INGEST_QUEUE: ingest,
    DELIVERY_QUEUE: delivery,
  } as unknown as Env;

  async function rows() {
    return (await client.execute(
      'SELECT id, queue_name, payload, status, attempts, dead_letter_pending, available_at, lease_until, last_error FROM deno_runtime_queue ORDER BY id',
    )).rows;
  }

  return { client, db, ingest, delivery, env, now, setNow, rows };
}

function createHandlers(overrides: Partial<DurableQueueHandlers> = {}): DurableQueueHandlers {
  return {
    handleIngestMessage: vi.fn(async () => {}),
    handleDeliveryMessage: vi.fn(async () => true),
    handleDeadLetterMessage: vi.fn(async () => {}),
    handleCorruptDeadLetterMessage: vi.fn(async () => {}),
    isTerminalDeadLetterError: vi.fn(() => false),
    completeIngestionOutbox: vi.fn(async () => 'completed'),
    completeDeliveryOutbox: vi.fn(async () => 'completed'),
    ...overrides,
  };
}

describe('Deno durable queue', () => {
  it('persists send/sendBatch messages and propagates database failures', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.send({
        type: 'filing.new',
        docId: 'doc-1',
        chamber: 'house',
        sourceUrl: 'https://example.test/doc-1.pdf',
      });
      await harness.ingest.sendBatch([
        { body: { type: 'filing.fetched', docId: 'doc-1' } },
        { body: { type: 'filing.extracted', docId: 'doc-1' }, delaySeconds: 60 },
      ]);

      const rows = await harness.rows();
      expect(rows).toHaveLength(3);
      expect(rows.map((row) => row.status)).toEqual(['pending', 'pending', 'pending']);
      expect(rows.map((row) => JSON.parse(String(row.payload)).type)).toEqual([
        'filing.new',
        'filing.fetched',
        'filing.extracted',
      ]);
      expect(rows[2].available_at).toBe('2026-07-22T16:01:00.000Z');

      await harness.ingest.send({
        type: 'filing.new',
        docId: 'doc-1',
        chamber: 'house',
        sourceUrl: 'https://example.test/doc-1.pdf',
      });
      expect(await harness.rows()).toHaveLength(3);

      await harness.client.execute('DROP TABLE deno_runtime_queue');
      await expect(harness.ingest.send({ type: 'filing.fetched', docId: 'doc-2' }))
        .rejects.toThrow('D1 statement error');
    } finally {
      harness.client.close();
    }
  });

  it('revalidates a guarded producer at the final batch write boundary', async () => {
    const harness = await createHarness();
    try {
      const guard = vi.fn(async () => {
        throw new Error('lease lost before queue persist');
      });
      const guarded = harness.ingest.withWriteGuard(guard);

      await expect(guarded.sendBatch([{
        body: { type: 'filing.fetched', docId: 'must-not-persist' },
      }])).rejects.toThrow('lease lost before queue persist');
      expect(guard).toHaveBeenCalledOnce();
      expect(await harness.rows()).toHaveLength(0);
    } finally {
      harness.client.close();
    }
  });

  it('maps libSQL write metadata to D1 changes semantics', async () => {
    const harness = await createHarness();
    try {
      const inserted = await harness.db.prepare(`
        INSERT INTO deno_runtime_queue
          (queue_name, payload, status, attempts, available_at, created_at, updated_at)
        VALUES ('ingest', '{}', 'pending', 0, ?, ?, ?)
      `).bind(START.toISOString(), START.toISOString(), START.toISOString()).run();
      expect(inserted.meta.changes).toBe(1);
      expect(inserted.meta.last_row_id).toBe(1);

      const missed = await harness.db.prepare(
        "UPDATE deno_runtime_queue SET status = 'completed' WHERE id = -1",
      ).run();
      expect(missed.meta.changes).toBe(0);
    } finally {
      harness.client.close();
    }
  });

  it('claims and completes a successful canonical ingest message', async () => {
    const harness = await createHarness();
    try {
      const message: QueueMessage = {
        type: 'filing.new',
        docId: 'doc-success',
        chamber: 'senate',
        sourceUrl: 'https://example.test/doc-success.pdf',
      };
      await harness.ingest.send(message);
      const handlers = createHandlers();

      await expect(drainDurableQueue(harness.env, 'ingest', handlers, { now: harness.now }))
        .resolves.toEqual({ claimed: 1, completed: 1, retried: 0, failed: 0 });
      expect(handlers.handleIngestMessage).toHaveBeenCalledWith(
        expect.objectContaining({ DB: expect.anything() }),
        message,
        1,
        expect.objectContaining({
          assertOwned: expect.any(Function),
          renew: expect.any(Function),
        }),
      );
      expect(handlers.completeIngestionOutbox).toHaveBeenCalledWith(
        expect.objectContaining({ DB: expect.anything() }),
        'doc-success',
      );
      expect((await harness.rows())[0]).toMatchObject({ status: 'completed', attempts: 1, lease_until: null });
    } finally {
      harness.client.close();
    }
  });

  it('allows autopilot.tick continuation enqueue while prior claim is still processing', async () => {
    // Regression: continuation used a stable per-runId dedupe key and was
    // INSERT OR IGNOREd against the still-processing claim, stalling the run.
    const harness = await createHarness();
    try {
      await harness.ingest.send({
        type: 'autopilot.tick',
        runId: 'run-1',
        tickId: 'tick-1',
      });
      // Simulate the consumer having claimed the first tick (status=processing).
      await harness.client.execute({
        sql: `UPDATE deno_runtime_queue
                 SET status = 'processing', lease_until = ?, lease_token = 'lease-1'
               WHERE queue_name = 'ingest'`,
        args: [new Date(harness.now().getTime() + 60_000).toISOString()],
      });

      await harness.ingest.send({
        type: 'autopilot.tick',
        runId: 'run-1',
        tickId: 'tick-2',
      });

      const rows = await harness.rows();
      expect(rows).toHaveLength(2);
      const statuses = rows.map((r) => r.status).sort();
      expect(statuses).toEqual(['pending', 'processing']);
      const payloads = rows.map((r) => JSON.parse(String(r.payload)) as { tickId: string });
      expect(payloads.map((p) => p.tickId).sort()).toEqual(['tick-1', 'tick-2']);
    } finally {
      harness.client.close();
    }
  });

  it('drops a duplicate active autopilot.tick with the same tickId (true redelivery)', async () => {
    const harness = await createHarness();
    try {
      const msg = {
        type: 'autopilot.tick' as const,
        runId: 'run-1',
        tickId: 'tick-same',
      };
      await harness.ingest.send(msg);
      await harness.ingest.send(msg); // same tickId while first is still pending
      expect(await harness.rows()).toHaveLength(1);
    } finally {
      harness.client.close();
    }
  });

  it('prefers agreement.check / autopilot.tick over usage.telemetry when draining', async () => {
    const harness = await createHarness();
    try {
      const nowIso = harness.now().toISOString();
      // Insert telemetry first (lower id / earlier) so FIFO would pick it unless
      // priority ordering is active.
      await harness.client.execute({
        sql: `INSERT INTO deno_runtime_queue
          (queue_name, payload, status, available_at, created_at, updated_at)
          VALUES ('ingest', ?, 'pending', ?, ?, ?)`,
        args: [
          JSON.stringify({ type: 'usage.telemetry', event: { eventId: 'e1' } }),
          nowIso, nowIso, nowIso,
        ],
      });
      await harness.client.execute({
        sql: `INSERT INTO deno_runtime_queue
          (queue_name, payload, status, available_at, created_at, updated_at)
          VALUES ('ingest', ?, 'pending', ?, ?, ?)`,
        args: [
          JSON.stringify({ type: 'filing.fetched', docId: 'doc-mid' }),
          nowIso, nowIso, nowIso,
        ],
      });
      await harness.client.execute({
        sql: `INSERT INTO deno_runtime_queue
          (queue_name, payload, status, available_at, created_at, updated_at)
          VALUES ('ingest', ?, 'pending', ?, ?, ?)`,
        args: [
          JSON.stringify({
            type: 'agreement.check',
            docId: 'H-priority',
            rawObjectKey: 'raw/H-priority',
            escalationTier: 1,
            claimToken: 'tok',
          }),
          nowIso, nowIso, nowIso,
        ],
      });

      const seen: string[] = [];
      const handlers = createHandlers({
        handleIngestMessage: vi.fn(async (_env, message) => {
          seen.push(message.type);
        }),
      });

      await expect(drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        limit: 2,
        claimSize: 1,
      })).resolves.toEqual({ claimed: 2, completed: 2, retried: 0, failed: 0 });

      expect(seen).toEqual(['agreement.check', 'filing.fetched']);
    } finally {
      harness.client.close();
    }
  });

  it('retries handler failures with exponential availability backoff', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.send({ type: 'filing.fetched', docId: 'doc-retry' });
      const ingestHandler = vi.fn(async () => {});
      ingestHandler.mockRejectedValueOnce(new Error('provider unavailable'));
      const handlers = createHandlers({ handleIngestMessage: ingestHandler });

      await expect(drainDurableQueue(harness.env, 'ingest', handlers, { now: harness.now }))
        .resolves.toEqual({ claimed: 1, completed: 0, retried: 1, failed: 0 });
      expect((await harness.rows())[0]).toMatchObject({
        status: 'pending',
        attempts: 1,
        available_at: '2026-07-22T16:00:30.000Z',
        last_error: 'provider unavailable',
      });

      harness.setNow(new Date('2026-07-22T16:00:29.999Z'));
      expect(await drainDurableQueue(harness.env, 'ingest', handlers, { now: harness.now }))
        .toEqual({ claimed: 0, completed: 0, retried: 0, failed: 0 });

      harness.setNow(new Date('2026-07-22T16:00:30.000Z'));
      expect(await drainDurableQueue(harness.env, 'ingest', handlers, { now: harness.now }))
        .toEqual({ claimed: 1, completed: 1, retried: 0, failed: 0 });
      expect((await harness.rows())[0]).toMatchObject({ status: 'completed', attempts: 2, last_error: null });
    } finally {
      harness.client.close();
    }
  });

  it('honors finite handler-requested retry delays', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.send({ type: 'filing.fetched', docId: 'retry-after' });
      const handlers = createHandlers({
        handleIngestMessage: vi.fn(async () => {
          throw Object.assign(new Error('rate limited'), { delaySeconds: 123 });
        }),
      });

      expect(await drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
      })).toEqual({ claimed: 1, completed: 0, retried: 1, failed: 0 });
      expect((await harness.rows())[0]).toMatchObject({
        status: 'pending',
        available_at: '2026-07-22T16:02:03.000Z',
      });
    } finally {
      harness.client.close();
    }
  });

  it('reclaims an expired processing lease without touching a live lease', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.sendBatch([
        { body: { type: 'filing.fetched', docId: 'stale' } },
        { body: { type: 'filing.fetched', docId: 'live' } },
      ]);
      await harness.client.execute({
        sql: `UPDATE deno_runtime_queue
              SET status = 'processing', attempts = 1, lease_until = ?
              WHERE id = ?`,
        args: ['2026-07-22T15:59:59.000Z', 1],
      });
      await harness.client.execute({
        sql: `UPDATE deno_runtime_queue
              SET status = 'processing', attempts = 1, lease_until = ?
              WHERE id = ?`,
        args: ['2026-07-22T16:05:00.000Z', 2],
      });
      const handlers = createHandlers();

      expect(await drainDurableQueue(harness.env, 'ingest', handlers, { now: harness.now }))
        .toEqual({ claimed: 1, completed: 1, retried: 0, failed: 0 });
      expect(handlers.handleIngestMessage).toHaveBeenCalledWith(
        expect.objectContaining({ DB: expect.anything() }),
        { type: 'filing.fetched', docId: 'stale' },
        2,
        expect.any(Object),
      );
      expect(await harness.rows()).toEqual([
        expect.objectContaining({ status: 'completed', attempts: 2, lease_until: null }),
        expect.objectContaining({ status: 'processing', attempts: 1, lease_until: '2026-07-22T16:05:00.000Z' }),
      ]);
    } finally {
      harness.client.close();
    }
  });

  it('gives concurrent claimers disjoint jobs', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.sendBatch([
        { body: { type: 'filing.fetched', docId: 'concurrent-a' } },
        { body: { type: 'filing.fetched', docId: 'concurrent-b' } },
      ]);
      const seen: string[] = [];
      const handlers = createHandlers({
        handleIngestMessage: vi.fn(async (_env, message) => {
          if (message.type === 'filing.fetched') seen.push(message.docId);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }),
      });

      const results = await Promise.all([
        drainDurableQueue(harness.env, 'ingest', handlers, {
          now: harness.now,
          limit: 1,
          claimSize: 1,
        }),
        drainDurableQueue(harness.env, 'ingest', handlers, {
          now: harness.now,
          limit: 1,
          claimSize: 1,
        }),
      ]);
      expect(results).toEqual([
        { claimed: 1, completed: 1, retried: 0, failed: 0 },
        { claimed: 1, completed: 1, retried: 0, failed: 0 },
      ]);
      expect(seen.sort()).toEqual(['concurrent-a', 'concurrent-b']);
    } finally {
      harness.client.close();
    }
  });

  it('rejects completion from a stale lease token', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.send({ type: 'filing.fetched', docId: 'stale-worker' });
      let releaseHandler!: () => void;
      const handlerBlocked = new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      let handlerStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        handlerStarted = resolve;
      });
      const handlers = createHandlers({
        handleIngestMessage: vi.fn(async () => {
          handlerStarted();
          await handlerBlocked;
        }),
      });

      const drain = drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        limit: 1,
      });
      await started;
      await harness.client.execute(`
        UPDATE deno_runtime_queue
           SET lease_token = 'replacement-owner',
               lease_until = '2026-07-22T16:20:00.000Z'
         WHERE id = 1
      `);
      releaseHandler();

      await expect(drain).resolves.toEqual({
        claimed: 1,
        completed: 0,
        retried: 0,
        failed: 0,
      });
      expect((await harness.rows())[0]).toMatchObject({
        status: 'processing',
        lease_until: '2026-07-22T16:20:00.000Z',
      });
    } finally {
      harness.client.close();
    }
  });

  it('fences handler side effects after lease ownership is lost', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.send({ type: 'filing.fetched', docId: 'fenced-worker' });
      let releaseHandler!: () => void;
      const handlerBlocked = new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      let handlerStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        handlerStarted = resolve;
      });
      let sideEffectCommitted = false;
      const handlers = createHandlers({
        handleIngestMessage: vi.fn(async (guardedEnv) => {
          handlerStarted();
          await handlerBlocked;
          await guardedEnv.INGEST_QUEUE.send({
            type: 'filing.fetched',
            docId: 'must-not-enqueue',
          });
          sideEffectCommitted = true;
        }),
      });

      const drain = drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        limit: 1,
      });
      await started;
      await harness.client.execute(`
        UPDATE deno_runtime_queue
           SET lease_token = 'replacement-owner',
               lease_until = '2026-07-22T16:20:00.000Z'
         WHERE id = 1
      `);
      // Move past the assertOwned() freshness cache so the next guarded write
      // re-verifies ownership against the stolen row instead of the cache.
      harness.setNow(new Date(harness.now().getTime() + 101_000));
      releaseHandler();

      await expect(drain).resolves.toEqual({
        claimed: 1,
        completed: 0,
        retried: 0,
        failed: 0,
      });
      expect(sideEffectCommitted).toBe(false);
      expect(await harness.rows()).toHaveLength(1);
    } finally {
      harness.client.close();
    }
  });

  it('persists an idempotent paid-response receipt after lease loss while ordinary DB writes stay fenced', async () => {
    const harness = await createHarness();
    try {
      await harness.client.execute(`
        CREATE TABLE llm_spend_settlements (
          settlement_id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          provider_response_id TEXT,
          attempt_id TEXT NOT NULL,
          day TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          requested_model TEXT NOT NULL,
          resolved_model TEXT,
          doc_id TEXT,
          -- no purpose column: exercises rolling-deploy fallback in settleLlmSpend
          usd REAL NOT NULL,
          receipt_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      await harness.client.execute(`
        CREATE UNIQUE INDEX idx_llm_spend_settlements_response
          ON llm_spend_settlements(provider, provider_response_id)
          WHERE provider_response_id IS NOT NULL
      `);
      await harness.ingest.send({ type: 'filing.fetched', docId: 'paid-after-lease' });
      const handlers = createHandlers({
        handleIngestMessage: vi.fn(async (guardedEnv) => {
          await harness.client.execute(`
            UPDATE deno_runtime_queue
               SET lease_token = 'replacement-owner',
                   lease_until = '2026-07-22T16:20:00.000Z'
             WHERE id = 1
          `);
          // Expire the assertOwned() freshness cache so the guarded write
          // below re-verifies ownership against the stolen row.
          harness.setNow(new Date(harness.now().getTime() + 101_000));
          await settleLlmSpend(guardedEnv, {
            provider: 'openai',
            requestedModel: 'gpt-5.6-terra',
            resolvedModel: 'gpt-5.6-terra-2026-07-01',
            providerResponseId: 'resp_paid_after_lease',
            attemptId: 'attempt-paid-after-lease',
            docId: 'paid-after-lease',
            usd: 0.0123,
            occurredAt: '2026-07-22T16:00:01.000Z',
          });
          await expect(
            guardedEnv.DB.prepare(
              `INSERT INTO deno_runtime_queue
                 (queue_name, payload, status, attempts, available_at, created_at, updated_at)
               VALUES ('ingest', '{}', 'pending', 0, ?, ?, ?)`,
            ).bind(START.toISOString(), START.toISOString(), START.toISOString()).run(),
          ).rejects.toThrow('durable queue lease is no longer owned');
        }),
      });

      await expect(drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        limit: 1,
      })).resolves.toEqual({ claimed: 1, completed: 0, retried: 0, failed: 0 });
      const receipts = await harness.client.execute(
        'SELECT provider, provider_response_id, usd FROM llm_spend_settlements',
      );
      expect(receipts.rows).toEqual([
        expect.objectContaining({
          provider: 'openai',
          provider_response_id: 'resp_paid_after_lease',
          usd: 0.0123,
        }),
      ]);
      expect(await harness.rows()).toHaveLength(1);
    } finally {
      harness.client.close();
    }
  });

  it('fences R2 object body reads after lease ownership is lost', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.send({ type: 'filing.fetched', docId: 'fenced-r2-read' });
      const arrayBuffer = vi.fn(async () => new ArrayBuffer(1));
      (harness.env as Env & { RAW_FILES: unknown }).RAW_FILES = {
        get: vi.fn(async () => ({ arrayBuffer })),
      };
      const handlers = createHandlers({
        handleIngestMessage: vi.fn(async (guardedEnv) => {
          const object = await guardedEnv.RAW_FILES.get('raw/fenced-r2-read');
          await harness.client.execute(`
            UPDATE deno_runtime_queue
               SET lease_token = 'replacement-owner',
                   lease_until = '2026-07-22T16:20:00.000Z'
             WHERE id = 1
          `);
          // Expire the assertOwned() freshness cache so reading the object
          // body re-verifies ownership against the stolen row.
          harness.setNow(new Date(harness.now().getTime() + 101_000));
          await object?.arrayBuffer();
        }),
      });

      await expect(drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        limit: 1,
      })).resolves.toEqual({ claimed: 1, completed: 0, retried: 0, failed: 0 });
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(await harness.rows()).toHaveLength(1);
    } finally {
      harness.client.close();
    }
  });

  it('fences R2 body stream reads after lease ownership is lost', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.send({ type: 'filing.fetched', docId: 'fenced-r2-stream' });
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      });
      (harness.env as Env & { RAW_FILES: unknown }).RAW_FILES = {
        get: vi.fn(async () => ({ body: new ReadableStream<Uint8Array>({ pull }) })),
      };
      const handlers = createHandlers({
        handleIngestMessage: vi.fn(async (guardedEnv) => {
          const object = await guardedEnv.RAW_FILES.get('raw/fenced-r2-stream');
          await harness.client.execute(`
            UPDATE deno_runtime_queue
               SET lease_token = 'replacement-owner',
                   lease_until = '2026-07-22T16:20:00.000Z'
             WHERE id = 1
          `);
          await object?.body.getReader().read();
        }),
      });

      await expect(drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        limit: 1,
      })).resolves.toEqual({ claimed: 1, completed: 0, retried: 0, failed: 0 });
      expect(await harness.rows()).toHaveLength(1);
    } finally {
      harness.client.close();
    }
  });

  it('completes delivery outboxes only after successful canonical dispatch', async () => {
    const harness = await createHarness();
    try {
      await harness.delivery.send({ type: 'delivery.dispatch', txId: 'tx-retry' });
      const deliveryHandler = vi.fn(async () => true);
      deliveryHandler.mockRejectedValueOnce(new Error('webhook timeout'));
      const completeDelivery = vi.fn(async () => 'completed');
      const handlers = createHandlers({
        handleDeliveryMessage: deliveryHandler,
        completeDeliveryOutbox: completeDelivery,
      });

      expect(await drainDurableQueue(harness.env, 'delivery', handlers, { now: harness.now }))
        .toEqual({ claimed: 1, completed: 0, retried: 1, failed: 0 });
      expect(completeDelivery).not.toHaveBeenCalled();

      harness.setNow(new Date('2026-07-22T16:00:30.000Z'));
      expect(await drainDurableQueue(harness.env, 'delivery', handlers, { now: harness.now }))
        .toEqual({ claimed: 1, completed: 1, retried: 0, failed: 0 });
      expect(completeDelivery).toHaveBeenCalledOnce();
      expect(completeDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ DB: expect.anything() }),
        'tx-retry',
      );

      await harness.delivery.send({ type: 'delivery.dispatch', txId: 'tx-no-completion' });
      deliveryHandler.mockResolvedValueOnce(false);
      expect(await drainDurableQueue(harness.env, 'delivery', handlers, { now: harness.now }))
        .toEqual({ claimed: 1, completed: 1, retried: 0, failed: 0 });
      expect(completeDelivery).toHaveBeenCalledOnce();
    } finally {
      harness.client.close();
    }
  });

  it('marks exhausted messages failed after durable dead-letter handling', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.send({ type: 'filing.fetched', docId: 'doc-poison' });
      const deadLetter = vi.fn(async () => {});
      const handlers = createHandlers({
        handleIngestMessage: vi.fn(async () => { throw new Error('poison message'); }),
        handleDeadLetterMessage: deadLetter,
      });

      expect(await drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        maxAttempts: 1,
      })).toEqual({ claimed: 1, completed: 0, retried: 0, failed: 1 });
      expect(deadLetter).toHaveBeenCalledWith(
        expect.objectContaining({ DB: expect.anything() }),
        'ingest-dlq',
        { type: 'filing.fetched', docId: 'doc-poison' },
        1,
        expect.any(Object),
      );
      expect((await harness.rows())[0]).toMatchObject({
        status: 'failed',
        attempts: 1,
        lease_until: null,
        last_error: 'poison message',
      });
      expect(handlers.completeIngestionOutbox).not.toHaveBeenCalled();
    } finally {
      harness.client.close();
    }
  });

  it('durably retries dead-letter recovery without rerunning primary work', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.send({ type: 'filing.fetched', docId: 'dlq-retry' });
      const primary = vi.fn(async () => {
        throw new Error('primary poison');
      });
      const deadLetter = vi.fn(async () => {});
      deadLetter.mockRejectedValueOnce(new Error('receipt unavailable'));
      const handlers = createHandlers({
        handleIngestMessage: primary,
        handleDeadLetterMessage: deadLetter,
      });

      expect(await drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        maxAttempts: 1,
      })).toEqual({ claimed: 1, completed: 0, retried: 1, failed: 0 });
      expect((await harness.rows())[0]).toMatchObject({
        status: 'pending',
        dead_letter_pending: 1,
        attempts: 1,
      });

      harness.setNow(new Date('2026-07-22T16:00:30.000Z'));
      expect(await drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        maxAttempts: 1,
      })).toEqual({ claimed: 1, completed: 0, retried: 0, failed: 1 });
      expect(primary).toHaveBeenCalledOnce();
      expect(deadLetter).toHaveBeenCalledTimes(2);
      expect((await harness.rows())[0]).toMatchObject({
        status: 'failed',
        dead_letter_pending: 0,
        attempts: 2,
      });
    } finally {
      harness.client.close();
    }
  });

  it('terminalizes a poison dead-letter receipt after the recovery cycle cap', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.send({ type: 'filing.fetched', docId: 'dlq-cap' });
      const primary = vi.fn(async () => {
        throw new Error('primary poison');
      });
      const deadLetter = vi.fn(async () => {
        throw new Error('receipt permanently unavailable');
      });
      const handlers = createHandlers({
        handleIngestMessage: primary,
        handleDeadLetterMessage: deadLetter,
      });

      // Primary exhausts its budget -> durable dead-letter receipt.
      expect(await drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        maxAttempts: 1,
      })).toEqual({ claimed: 1, completed: 0, retried: 1, failed: 0 });

      // Simulate a receipt that has already burned its recovery cycles.
      await harness.client.execute(
        `UPDATE deno_runtime_queue SET dead_letter_cycles = ${DURABLE_QUEUE_MAX_DEAD_LETTER_CYCLES}`,
      );

      harness.setNow(new Date('2026-07-22T16:00:30.000Z'));
      expect(await drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        maxAttempts: 1,
      })).toEqual({ claimed: 1, completed: 0, retried: 0, failed: 1 });
      expect(primary).toHaveBeenCalledOnce();
      // Once in the initial dead-lettering drain, once in the resumed receipt
      // drain that hits the cycle cap.
      expect(deadLetter).toHaveBeenCalledTimes(2);
      const row = (await harness.rows())[0];
      expect(row).toMatchObject({ status: 'failed', dead_letter_pending: 0 });
      expect(String(row.last_error)).toContain('dead-letter recovery budget exhausted');
    } finally {
      harness.client.close();
    }
  });

  it('retries a rejected 202 usage ACK without completing the receipt, then accepts the same event as a duplicate', async () => {
    const harness = await createHarness();
    try {
      const event = {
        eventId: 'ct-third-party:queue-ack-test',
        provider: 'openai', service: 'llm', billingMode: 'actual' as const,
        metricType: 'usage' as const, quantity: 1, unit: 'request', requests: 1,
        confidence: 'actual' as const, occurredAt: START.toISOString(),
      };
      const message: QueueMessage = { type: 'usage.telemetry', event };
      await harness.ingest.send(message);
      Object.assign(harness.env, {
        USAGE_MONITOR_ENABLED: 'true',
        USAGE_MONITOR_INGEST_URL: 'https://usage.example.test',
        USAGE_MONITOR_INGEST_TOKEN: 'test-token',
      });
      const bodies: unknown[] = [];
      vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({
          ok: true, schemaVersion: 2, received: 1, persisted: 0, pruned: 0,
          rejected: bodies.length === 1 ? 1 : 0,
          duplicates: bodies.length === 1 ? 0 : 1,
        }), { status: 202 });
      }));
      const handlers = createHandlers({
        handleIngestMessage,
        isTerminalDeadLetterError: (_message, error) => isTerminalUsageTelemetryDeliveryError(error),
      });
      expect(await drainDurableQueue(harness.env, 'ingest', handlers, { now: harness.now }))
        .toEqual({ claimed: 1, completed: 0, retried: 1, failed: 0 });
      const row = (await harness.rows())[0];
      expect(row.status).toBe('pending');
      expect(JSON.parse(String(row.payload))).toEqual(message);
      expect(handlers.completeIngestionOutbox).not.toHaveBeenCalled();

      harness.setNow(new Date(String(row.available_at)));
      expect(await drainDurableQueue(harness.env, 'ingest', handlers, { now: harness.now }))
        .toEqual({ claimed: 1, completed: 1, retried: 0, failed: 0 });
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toEqual(bodies[0]);
      expect((await harness.rows())[0].status).toBe('completed');
    } finally {
      vi.unstubAllGlobals();
      harness.client.close();
    }
  });

  it('terminalizes deterministic primary telemetry rejects immediately', async () => {
    const harness = await createHarness();
    try {
      const telemetry = {
        type: 'usage.telemetry',
        event: { idempotencyKey: 'primary-terminal-event' },
      } as QueueMessage;
      await harness.ingest.send(telemetry);
      const terminal = Object.assign(new Error('invalid payload'), { status: 400 });
      const primary = vi.fn(async () => {
        throw terminal;
      });
      const deadLetter = vi.fn(async () => {});
      const handlers = createHandlers({
        handleIngestMessage: primary,
        handleDeadLetterMessage: deadLetter,
        isTerminalDeadLetterError: vi.fn((_message, error) => error === terminal),
      });

      expect(await drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
      })).toEqual({ claimed: 1, completed: 0, retried: 0, failed: 1 });
      expect(primary).toHaveBeenCalledOnce();
      expect(deadLetter).not.toHaveBeenCalled();
      expect((await harness.rows())[0]).toMatchObject({
        status: 'failed',
        dead_letter_pending: 0,
        last_error: 'invalid payload',
      });
    } finally {
      harness.client.close();
    }
  });

  it('terminalizes deterministic telemetry DLQ rejects without re-pending', async () => {
    const harness = await createHarness();
    try {
      const telemetry = {
        type: 'usage.telemetry',
        event: { idempotencyKey: 'terminal-event' },
      } as QueueMessage;
      await harness.ingest.send(telemetry);
      const terminal = Object.assign(new Error('invalid payload'), { status: 400 });
      const deadLetter = vi.fn(async () => {
        throw terminal;
      });
      const handlers = createHandlers({
        handleIngestMessage: vi.fn(async () => {
          throw new Error('primary delivery failed');
        }),
        handleDeadLetterMessage: deadLetter,
        isTerminalDeadLetterError: vi.fn((_message, error) => error === terminal),
      });

      expect(await drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        maxAttempts: 1,
      })).toEqual({ claimed: 1, completed: 0, retried: 0, failed: 1 });
      expect(deadLetter).toHaveBeenCalledOnce();
      expect((await harness.rows())[0]).toMatchObject({
        status: 'failed',
        dead_letter_pending: 0,
        last_error: 'invalid payload',
      });
    } finally {
      harness.client.close();
    }
  });

  it('rejects malformed producer messages before persistence', async () => {
    const harness = await createHarness();
    try {
      await expect(harness.ingest.send({ type: 'filing.fetched' } as QueueMessage))
        .rejects.toThrow('docId is required');
      await expect(harness.delivery.send({
        type: 'filing.fetched',
        docId: 'wrong-queue',
      } as QueueMessage)).rejects.toThrow('invalid delivery queue message type');
      expect(await harness.rows()).toHaveLength(0);
    } finally {
      harness.client.close();
    }
  });

  it('accepts filing.local_wait_check producer messages (scanned_pdf local vision wait)', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.send({ type: 'filing.local_wait_check', docId: 'scan-wait-1' });
      await expect(
        harness.ingest.send({ type: 'filing.local_wait_check' } as QueueMessage),
      ).rejects.toThrow('docId is required');
      const rows = await harness.rows();
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].payload as string)).toEqual({
        type: 'filing.local_wait_check',
        docId: 'scan-wait-1',
      });
    } finally {
      harness.client.close();
    }
  });

  it('durably receipts and terminalizes corrupt legacy messages', async () => {
    const harness = await createHarness();
    try {
      await harness.client.execute({
        sql: `INSERT INTO deno_runtime_queue
          (queue_name, payload, status, attempts, dead_letter_pending,
           available_at, created_at, updated_at)
          VALUES ('ingest', ?, 'pending', 0, 0, ?, ?, ?)`,
        args: [
          JSON.stringify({ type: 'filing.fetched' }),
          START.toISOString(),
          START.toISOString(),
          START.toISOString(),
        ],
      });
      const corruptReceipt = vi.fn(async () => {});
      const handlers = createHandlers({
        handleCorruptDeadLetterMessage: corruptReceipt,
      });

      expect(await drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        maxAttempts: 1,
      })).toEqual({ claimed: 1, completed: 0, retried: 0, failed: 1 });
      expect(corruptReceipt).toHaveBeenCalledWith(
        expect.objectContaining({ DB: expect.anything() }),
        'ingest-dlq',
        { type: 'filing.fetched' },
        1,
        expect.stringContaining('docId is required'),
        expect.any(Object),
      );
      expect((await harness.rows())[0]).toMatchObject({
        status: 'failed',
        dead_letter_pending: 0,
      });
    } finally {
      harness.client.close();
    }
  });

  it('receipts malformed JSON when resuming a pending dead-letter receipt', async () => {
    const harness = await createHarness();
    try {
      await harness.client.execute({
        sql: `INSERT INTO deno_runtime_queue
          (queue_name, payload, status, attempts, dead_letter_pending,
           available_at, last_error, created_at, updated_at)
          VALUES ('ingest', ?, 'pending', 1, 1, ?, ?, ?, ?)`,
        args: [
          '{not-json',
          START.toISOString(),
          'initial corrupt receipt failed',
          START.toISOString(),
          START.toISOString(),
        ],
      });
      const corruptReceipt = vi.fn(async () => {});
      const handlers = createHandlers({
        handleCorruptDeadLetterMessage: corruptReceipt,
      });

      expect(await drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        maxAttempts: 1,
      })).toEqual({ claimed: 1, completed: 0, retried: 0, failed: 1 });
      expect(corruptReceipt).toHaveBeenCalledWith(
        expect.anything(),
        'ingest-dlq',
        '{not-json',
        2,
        'initial corrupt receipt failed',
        expect.any(Object),
      );
      expect((await harness.rows())[0]).toMatchObject({
        status: 'failed',
        dead_letter_pending: 0,
      });
    } finally {
      harness.client.close();
    }
  });

  it('caches lease ownership checks across proxied handler statements', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.send({ type: 'filing.fetched', docId: 'doc-cache' });
      const executeSpy = vi.spyOn(harness.client, 'execute');
      const leaseVerifyQueries = () =>
        executeSpy.mock.calls.filter(([statement]) => {
          const sql = typeof statement === 'string' ? statement : statement?.sql;
          return typeof sql === 'string' && sql.trimStart().startsWith('SELECT id');
        }).length;
      const handlers = createHandlers({
        handleIngestMessage: async (env) => {
          for (let i = 0; i < 5; i += 1) {
            await env.DB.prepare('SELECT 1 AS ok').all();
          }
        },
      });

      expect(await drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
      })).toEqual({ claimed: 1, completed: 1, retried: 0, failed: 0 });
      // The claim-time renew() seeds the freshness cache, so every proxied
      // statement plus the dispatch-boundary asserts reuse it: zero ownership
      // verification queries on the hot path.
      expect(leaseVerifyQueries()).toBe(0);
    } finally {
      harness.client.close();
    }
  });

  it('re-verifies ownership after the freshness window and fails writes on a lost lease', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.send({ type: 'filing.fetched', docId: 'doc-stolen' });
      let observed: unknown = null;
      const handlers = createHandlers({
        handleIngestMessage: async (env) => {
          await env.DB.prepare('SELECT 1 AS ok').all();
          // Simulate another worker reclaiming the row while this handler runs.
          await harness.client.execute(`
            UPDATE deno_runtime_queue
            SET lease_token = 'other-worker', lease_until = '2999-01-01T00:00:00.000Z'
            WHERE status = 'processing'
          `);
          // Move past the freshness window (leaseMs / 6 = 10s here) so the next
          // guarded statement must hit the database instead of the cache.
          harness.setNow(new Date(harness.now().getTime() + 11_000));
          try {
            await env.DB.prepare('SELECT 1 AS ok').all();
          } catch (error) {
            observed = error;
            throw error;
          }
        },
      });

      expect(await drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        leaseMs: 60_000,
      })).toEqual({ claimed: 1, completed: 0, retried: 0, failed: 0 });
      expect(observed).toBeInstanceOf(DurableQueueLeaseLostError);
      // The losing worker must not complete or retry the stolen row.
      expect((await harness.rows())[0]).toMatchObject({
        status: 'processing',
      });
    } finally {
      harness.client.close();
    }
  });
});

describe('requeueFailedDurableJobs', () => {
  interface SeedRow {
    queue?: string;
    dedupe?: string | null;
    type: string;
    status?: string;
    attempts?: number;
    cycles?: number;
    error?: string | null;
    lease?: boolean;
  }

  async function seed(harness: Awaited<ReturnType<typeof createHarness>>, rows: SeedRow[]) {
    for (const r of rows) {
      await harness.db.prepare(`
        INSERT INTO deno_runtime_queue
          (queue_name, dedupe_key, payload, status, attempts, dead_letter_cycles,
           available_at, lease_until, lease_token, last_error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        r.queue ?? 'ingest',
        r.dedupe ?? null,
        JSON.stringify({ type: r.type, docId: 'doc-1' }),
        r.status ?? 'failed',
        r.attempts ?? 5,
        r.cycles ?? 2,
        START.toISOString(),
        r.lease ? START.toISOString() : null,
        r.lease ? 'tok' : null,
        r.error === undefined ? 'boom' : r.error,
        START.toISOString(),
        START.toISOString(),
      ).run();
    }
  }

  it('dryRun counts failed rows by type without writing', async () => {
    const harness = await createHarness();
    try {
      await seed(harness, [
        { type: 'filing.extracted' },
        { type: 'filing.extracted' },
        { type: 'filing.new' },
        { type: 'usage.telemetry', status: 'completed' },
      ]);
      const r = await requeueFailedDurableJobs(harness.env, { dryRun: true });
      expect(r).toMatchObject({
        ok: true, dryRun: true, matched: 3, requeued: 0,
        byType: { 'filing.extracted': 2, 'filing.new': 1 },
      });
      expect((await harness.rows()).filter((x) => x.status === 'failed')).toHaveLength(3);
    } finally {
      harness.client.close();
    }
  });

  it('resets failed rows to a fresh pending state', async () => {
    const harness = await createHarness();
    try {
      await seed(harness, [{ type: 'filing.extracted', lease: true }]);
      const r = await requeueFailedDurableJobs(harness.env, {});
      expect(r).toMatchObject({ matched: 1, requeued: 1, skippedConflict: 0 });
      const rows = await harness.rows();
      expect(rows[0]).toMatchObject({
        status: 'pending',
        attempts: 0,
        last_error: null,
        lease_until: null,
      });
    } finally {
      harness.client.close();
    }
  });

  it('skips rows whose dedupe key is held by an active sibling', async () => {
    const harness = await createHarness();
    try {
      await seed(harness, [
        { type: 'filing.extracted', dedupe: 'ingest:filing.extracted:doc-1' },
        { type: 'filing.extracted', dedupe: 'ingest:filing.extracted:doc-1', status: 'pending' },
        { type: 'filing.extracted', dedupe: 'ingest:filing.extracted:doc-2' },
      ]);
      const r = await requeueFailedDurableJobs(harness.env, {});
      expect(r).toMatchObject({ matched: 2, requeued: 1, skippedConflict: 1 });
      // The conflicted row stays failed; the uncontended one requeues.
      const rows = await harness.rows();
      expect(rows[0]).toMatchObject({ status: 'failed' });
      expect(rows[2]).toMatchObject({ status: 'pending', attempts: 0 });
    } finally {
      harness.client.close();
    }
  });

  it('honors the type filter and limit', async () => {
    const harness = await createHarness();
    try {
      await seed(harness, [
        { type: 'filing.extracted' },
        { type: 'filing.extracted' },
        { type: 'filing.new' },
      ]);
      const r = await requeueFailedDurableJobs(harness.env, { type: 'filing.extracted', limit: 1 });
      expect(r).toMatchObject({ matched: 2, requeued: 1 });
      const pending = (await harness.rows()).filter((x) => x.status === 'pending');
      expect(pending).toHaveLength(1);
      // filing.new untouched.
      const failed = (await harness.rows()).filter((x) => x.status === 'failed');
      expect(failed).toHaveLength(2);
    } finally {
      harness.client.close();
    }
  });

  it('scopes to the requested queue', async () => {
    const harness = await createHarness();
    try {
      await seed(harness, [
        { type: 'filing.extracted', queue: 'ingest' },
        { type: 'delivery.dispatch', queue: 'delivery' },
      ]);
      const r = await requeueFailedDurableJobs(harness.env, { queue: 'delivery' });
      expect(r).toMatchObject({ queue: 'delivery', matched: 1, requeued: 1 });
      const rows = await harness.rows();
      expect(rows[0]).toMatchObject({ status: 'failed' }); // ingest row untouched
      expect(rows[1]).toMatchObject({ status: 'pending' });
    } finally {
      harness.client.close();
    }
  });
});

describe('requeueFailedDurableJobs duplicate dedupe keys', () => {
  it('requeues only the newest failed row per dedupe key (prod incident 2026-08-01)', async () => {
    const harness = await createHarness();
    try {
      // Two failed rows sharing one dedupe key — the active-dedupe index
      // tolerates failed duplicates but forbids two active rows, so flipping
      // both to pending violates it (this exact shape broke the first prod
      // requeue attempt with SQLITE_CONSTRAINT).
      for (let i = 0; i < 2; i++) {
        await harness.db.prepare(`
          INSERT INTO deno_runtime_queue
            (queue_name, dedupe_key, payload, status, attempts, dead_letter_cycles,
             available_at, lease_until, lease_token, last_error, created_at, updated_at)
          VALUES ('ingest', 'ingest:filing.extracted:doc-9', ?, 'failed', 5, 2, ?, NULL, NULL, 'boom', ?, ?)
        `).bind(
          JSON.stringify({ type: 'filing.extracted', docId: 'doc-9' }),
          START.toISOString(), START.toISOString(), START.toISOString(),
        ).run();
      }
      const r = await requeueFailedDurableJobs(harness.env, {});
      expect(r).toMatchObject({ matched: 2, requeued: 1 });
      const rows = await harness.rows();
      // Newest (id 2) requeued, oldest stays failed.
      expect(rows[0]).toMatchObject({ status: 'failed' });
      expect(rows[1]).toMatchObject({ status: 'pending', attempts: 0 });
    } finally {
      harness.client.close();
    }
  });
});
