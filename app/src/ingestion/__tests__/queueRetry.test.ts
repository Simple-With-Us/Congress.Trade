import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchFiling: vi.fn(async () => {}),
  extractAndNormalize: vi.fn(async () => {
    throw new Error('provider HTTP 429 retry-after: 90');
  }),
}));

vi.mock('#sentry', () => ({
  withSentry: (_opts: unknown, handler: unknown) => handler,
  setTags: vi.fn(), captureException: vi.fn(),
  withMonitor: (_slug: string, callback: () => unknown) => callback(),
  consoleLoggingIntegration: vi.fn(() => ({})),
}));

vi.mock('../../extraction/orchestrator', () => ({
  extractAndNormalize: mocks.extractAndNormalize,
}));

vi.mock('../fetcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fetcher.ts')>()),
  fetchFiling: mocks.fetchFiling,
}));

import worker from '../../index.ts';
import type { Env, QueueMessage } from '../../shared/types.ts';

describe('ingest queue delayed retry policy', () => {
  it('completes only filing.new durably before ACK', async () => {
    const writes: string[] = [];
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind() { return this; },
          async run() { writes.push(sql); return { success: true, meta: { changes: 1 } }; },
        }),
      } as unknown as D1Database,
    } as Env;
    const ack = vi.fn(); const retry = vi.fn();
    const body = {
      type: 'filing.new', docId: 'doc_1', chamber: 'house', sourceUrl: 'https://example.com/doc.pdf',
    } as QueueMessage;
    await worker.queue(
      { queue: 'congress-feed-ingest', messages: [{ body, attempts: 1, ack, retry }] } as unknown as MessageBatch<QueueMessage>,
      env,
      {} as ExecutionContext,
    );
    expect(mocks.fetchFiling).toHaveBeenCalledWith(env, 'doc_1', 1);
    expect(writes.some((sql) => /UPDATE ingestion_outbox/i.test(sql) && /status = 'completed'/i.test(sql))).toBe(true);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it('retries filing.new instead of ACKing when durable completion fails', async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind() { return this; },
          async run() { throw new Error('completion unavailable'); },
        }),
      } as unknown as D1Database,
    } as Env;
    const ack = vi.fn(); const retry = vi.fn();
    const body = {
      type: 'filing.new', docId: 'doc_2', chamber: 'senate', sourceUrl: 'https://example.com/doc',
    } as QueueMessage;
    await worker.queue(
      { queue: 'congress-feed-ingest', messages: [{ body, attempts: 1, ack, retry }] } as unknown as MessageBatch<QueueMessage>,
      env,
      {} as ExecutionContext,
    );
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('detects a missing legacy filing origin before ACKing completed work', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = {
      DB: {
        prepare: () => ({
          bind() { return this; },
          async run() { return { success: true, meta: { changes: 0 } }; },
          async all<T>() { return { results: [] as T[] }; },
        }),
      } as unknown as D1Database,
    } as Env;
    const ack = vi.fn(); const retry = vi.fn();
    const body = {
      type: 'filing.new', docId: 'doc_missing', chamber: 'house', sourceUrl: 'https://example.com/doc',
    } as QueueMessage;
    await worker.queue(
      { queue: 'congress-feed-ingest', messages: [{ body, attempts: 1, ack, retry }] } as unknown as MessageBatch<QueueMessage>,
      env,
      {} as ExecutionContext,
    );
    expect(warn).toHaveBeenCalledWith('ingest.dead_letter', {
      queue: 'ingest',
      reason: 'outbox_missing',
    });
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('delays a later-stage provider 429 instead of burning retries immediately', async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const body = { type: 'filing.extracted', docId: 'doc_1' } as QueueMessage;
    const batch = {
      queue: 'congress-feed-ingest', messages: [{ body, attempts: 2, ack, retry }],
    } as unknown as MessageBatch<QueueMessage>;
    await worker.queue(batch, {} as Env, {} as ExecutionContext);
    expect(mocks.extractAndNormalize).toHaveBeenCalledWith(expect.anything(), 'doc_1');
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 90 });
    expect(ack).not.toHaveBeenCalled();
  });
});
