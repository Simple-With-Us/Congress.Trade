import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deliver: vi.fn(async () => {}),
  captureException: vi.fn(),
  sentryRegistrations: [] as Array<{
    options: (env: Record<string, unknown>) => {
      tracesSampleRate: number;
      transportOptions: { fetch: typeof fetch };
      beforeSend: (event: Record<string, unknown>) => Record<string, unknown> | null;
      beforeSendTransaction: (event: Record<string, unknown>) => Record<string, unknown> | null;
      beforeSendLog: (log: Record<string, unknown>) => Record<string, unknown> | null;
    };
    handlerKeys: string[];
  }>,
}));

vi.mock('#sentry', () => ({
  withSentry: (
    options: (env: Record<string, unknown>) => {
      tracesSampleRate: number;
      transportOptions: { fetch: typeof fetch };
      beforeSend: (event: Record<string, unknown>) => Record<string, unknown> | null;
      beforeSendTransaction: (event: Record<string, unknown>) => Record<string, unknown> | null;
      beforeSendLog: (log: Record<string, unknown>) => Record<string, unknown> | null;
    },
    handler: Record<string, unknown>,
  ) => {
    mocks.sentryRegistrations.push({ options, handlerKeys: Object.keys(handler) });
    return handler;
  },
  setTags: vi.fn(),
  captureException: mocks.captureException,
  withMonitor: (_slug: string, callback: () => unknown) => callback(),
  consoleLoggingIntegration: vi.fn(() => ({})),
}));

vi.mock('../thirdPartyTelemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../thirdPartyTelemetry.ts')>()),
  deliverUsageTelemetryEvent: mocks.deliver,
}));

import worker from '../../index.ts';
import type { Env, QueueMessage, ThirdPartyUsageTelemetryEvent } from '../types.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

const event: ThirdPartyUsageTelemetryEvent = {
  eventId: 'ct-third-party:test-event',
  environment: 'test',
  provider: 'openai',
  service: 'llm',
  project: 'congress-trade',
  label: 'extract-document',
  billingMode: 'actual',
  metricType: 'usage',
  quantity: 1,
  unit: 'request',
  requests: 1,
  confidence: 'actual',
  occurredAt: '2026-07-13T12:00:00.000Z',
};

function messageBatch(queue: string) {
  const ack = vi.fn();
  const retry = vi.fn();
  const body: QueueMessage = { type: 'usage.telemetry', event };
  return {
    ack,
    retry,
    batch: {
      queue,
      messages: [{ body, attempts: 2, ack, retry }],
    } as unknown as MessageBatch<QueueMessage>,
  };
}

describe('usage telemetry queue routing', () => {
  it('disables Sentry transaction sampling for queue invocations only', () => {
    const queueRegistration = mocks.sentryRegistrations.find(({ handlerKeys }) => handlerKeys.includes('queue'));
    const requestRegistration = mocks.sentryRegistrations.find(({ handlerKeys }) => handlerKeys.includes('fetch'));
    expect(queueRegistration).toBeDefined();
    expect(requestRegistration).toBeDefined();

    const env = { SENTRY_TRACES_SAMPLE_RATE: '1' };
    expect(queueRegistration?.options(env).tracesSampleRate).toBe(0);
    expect(requestRegistration?.options(env).tracesSampleRate).toBe(1);
  });

  it('keeps actual Sentry envelope requests metered with queue tracing disabled', async () => {
    const queueRegistration = mocks.sentryRegistrations.find(({ handlerKeys }) => handlerKeys.includes('queue'));
    expect(queueRegistration).toBeDefined();
    const nativeFetch = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', nativeFetch);
    const send = vi.fn(async () => {});
    const env = {
      SENTRY_TRACES_SAMPLE_RATE: '1',
      USAGE_MONITOR_ENVIRONMENT: 'test',
      INGEST_QUEUE: { send },
    } as unknown as Env;
    const options = queueRegistration?.options(env as unknown as Record<string, unknown>);

    await options?.transportOptions.fetch(
      'https://o123.ingest.us.sentry.io/api/1/envelope/',
      { method: 'POST' },
    );

    expect(options?.tracesSampleRate).toBe(0);
    expect(nativeFetch).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'usage.telemetry',
      event: expect.objectContaining({ provider: 'sentry', label: 'send-envelope' }),
    }));
  });

  it('removes query credentials before Sentry event and transaction envelope serialization', () => {
    const queueRegistration = mocks.sentryRegistrations.find(({ handlerKeys }) => handlerKeys.includes('queue'));
    expect(queueRegistration).toBeDefined();
    const options = queueRegistration?.options({});
    if (!options) throw new Error('queue Sentry options missing');
    const credential = 'do-not-serialize-this-credential';
    const event = options.beforeSend({
      request: {
        url: `https://generativelanguage.googleapis.com/v1/models?key=${credential}&model=gemini`,
        query_string: [['api_key', credential], ['page', 'tuple-visible']],
        headers: [['authorization', `Bearer ${credential}`], ['accept', 'application/json']],
      },
      breadcrumbs: [{
        data: { url: `https://api.example.test/resource?api_key=${credential}&page=2` },
      }],
    });
    const transaction = options.beforeSendTransaction({
      spans: [{
        data: {
          'http.query': `token=${credential}&safe=visible`,
          'url.full': `https://api.example.test/resource?client_secret=${credential}&page=2`,
        },
      }],
    });
    const log = options.beforeSendLog({
      body: `provider failed at https://api.example.test/resource?access_token=${credential}&page=2`,
      attributes: { 'http.query': `api_key=${credential}&safe=visible` },
    });
    const serializedEnvelope = [
      JSON.stringify({ event_id: 'test-event' }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify(event),
      JSON.stringify({ type: 'transaction' }),
      JSON.stringify(transaction),
      JSON.stringify({ type: 'log' }),
      JSON.stringify(log),
    ].join('\n');

    expect(serializedEnvelope).not.toContain(credential);
    expect(serializedEnvelope).toContain('model=gemini');
    expect(serializedEnvelope).toContain('page=2');
    expect(serializedEnvelope).toContain('safe=visible');
    expect(serializedEnvelope).toContain('tuple-visible');
    expect(serializedEnvelope).toContain('application/json');
  });

  it('ACKs only after Usage Monitor accepts the event', async () => {
    mocks.deliver.mockResolvedValueOnce(undefined);
    const { batch, ack, retry } = messageBatch('congress-feed-ingest');
    await worker.queue(batch, {} as Env, {} as ExecutionContext);
    expect(mocks.deliver).toHaveBeenCalledWith(expect.anything(), event);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it('ACKs a deterministic per-event receiver reject without persisting poison to R2', async () => {
    mocks.deliver.mockRejectedValueOnce(Object.assign(new Error('invalid payload'), { status: 400 }));
    const { batch, ack, retry } = messageBatch('congress-feed-ingest');
    const put = vi.fn();
    const env = { RAW_FILES: { put } } as unknown as Env;

    await worker.queue(batch, env, {} as ExecutionContext);

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('ACKs after durably retaining a failed Usage Monitor delivery in R2', async () => {
    mocks.deliver.mockRejectedValueOnce(new Error('usage telemetry ingest failed'));
    const { batch, ack, retry } = messageBatch('congress-feed-ingest');
    const put = vi.fn(async () => {});
    const env = { RAW_FILES: { put } } as unknown as Env;
    await worker.queue(batch, env, {} as ExecutionContext);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledWith(
      '_ops/usage-telemetry/ct-third-party%3Atest-event.json',
      JSON.stringify(event),
      expect.anything(),
    );
    expect(put.mock.invocationCallOrder[0]).toBeLessThan(ack.mock.invocationCallOrder[0]);
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it('continues the same idempotent event through the high-retry ingest DLQ', async () => {
    mocks.deliver.mockResolvedValueOnce(undefined);
    const { batch, ack, retry } = messageBatch('congress-feed-ingest-dlq');
    await worker.queue(batch, {} as Env, {} as ExecutionContext);
    expect(mocks.deliver).toHaveBeenCalledWith(expect.anything(), event);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it('ACKs a DLQ receiver failure after durably retaining it in R2', async () => {
    mocks.deliver.mockRejectedValueOnce(new Error('usage telemetry ingest failed'));
    const { batch, ack, retry } = messageBatch('congress-feed-ingest-dlq');
    const put = vi.fn(async () => {});
    const env = { RAW_FILES: { put } } as unknown as Env;

    await worker.queue(batch, env, {} as ExecutionContext);

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.invocationCallOrder[0]).toBeLessThan(ack.mock.invocationCallOrder[0]);
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  /** CONFIG_KV double reporting the usage telemetry circuit breaker as open. */
  function openCircuitConfigKv() {
    const state = JSON.stringify({ consecutiveFailures: 5, openUntil: Date.now() + 60_000 });
    return {
      get: vi.fn(async (key: string, type?: string) => (
        key === 'usage_telemetry_circuit_breaker' && type === 'json' ? JSON.parse(state) : null
      )),
      put: vi.fn(async () => {}),
    };
  }

  it('routes a new usage.telemetry message straight to the R2 outbox without a delivery attempt while the circuit is open, then acks it', async () => {
    mocks.deliver.mockClear();
    const { batch, ack, retry } = messageBatch('congress-feed-ingest');
    const put = vi.fn(async () => {});
    const env = { RAW_FILES: { put }, CONFIG_KV: openCircuitConfigKv() } as unknown as Env;

    await worker.queue(batch, env, {} as ExecutionContext);

    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledWith(
      '_ops/usage-telemetry/ct-third-party%3Atest-event.json',
      JSON.stringify(event),
      expect.anything(),
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it('retries instead of ACKing when an open-circuit fallback write is not durable', async () => {
    mocks.deliver.mockClear();
    const { batch, ack, retry } = messageBatch('congress-feed-ingest');
    const put = vi.fn(async () => { throw new Error('R2 unavailable'); });
    const env = { RAW_FILES: { put }, CONFIG_KV: openCircuitConfigKv() } as unknown as Env;

    await worker.queue(batch, env, {} as ExecutionContext);

    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('retries instead of ACKing when the open-circuit R2 outbox is at capacity', async () => {
    mocks.deliver.mockClear();
    const { batch, ack, retry } = messageBatch('congress-feed-ingest');
    const put = vi.fn();
    const circuitState = { consecutiveFailures: 5, openUntil: Date.now() + 60_000 };
    const env = {
      RAW_FILES: { put },
      CONFIG_KV: {
        get: vi.fn(async (key: string, type?: string) => {
          if (key === 'usage_telemetry_circuit_breaker' && type === 'json') return circuitState;
          if (key === 'usage_telemetry_outbox_count') return '1';
          return null;
        }),
        put: vi.fn(async () => {}),
      },
      USAGE_TELEMETRY_FALLBACK_MAX_OBJECTS: '1',
    } as unknown as Env;

    await worker.queue(batch, env, {} as ExecutionContext);

    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('routes a DLQ usage.telemetry redelivery straight to the R2 outbox without a delivery attempt while the circuit is open, then acks it (no further DLQ churn)', async () => {
    mocks.deliver.mockClear();
    const { batch, ack, retry } = messageBatch('congress-feed-ingest-dlq');
    const put = vi.fn(async () => {});
    const env = { RAW_FILES: { put }, CONFIG_KV: openCircuitConfigKv() } as unknown as Env;

    await worker.queue(batch, env, {} as ExecutionContext);

    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledWith(
      '_ops/usage-telemetry/ct-third-party%3Atest-event.json',
      JSON.stringify(event),
      expect.anything(),
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });
});
