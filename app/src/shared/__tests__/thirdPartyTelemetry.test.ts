import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { UsageTelemetryV2EventSchema } from '@jaywedgeworth22/congress-trading-shared';
import type { Env, QueueMessage, ThirdPartyUsageTelemetryEvent } from '../types.ts';
import {
  deliverUsageTelemetryEvent,
  enqueueUsageTelemetryEvent,
  flushUsageTelemetryFallback,
  isUsageTelemetryCircuitOpen,
  isTerminalUsageTelemetryDeliveryError,
  persistUsageTelemetryFallback,
  providerForThirdPartyRequest,
  recordMeasuredThirdPartyUsage,
  stableMeasuredUsageIdempotencyKey,
  trackedFetch,
  UsageTelemetryCircuitOpenError,
  type MeasuredThirdPartyUsage,
  withThirdPartyTelemetry,
  withoutThirdPartyTelemetry,
} from '../thirdPartyTelemetry.ts';

const testModuleUrl = (import.meta as ImportMeta & { readonly url: string }).url;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const deliveryEvent: ThirdPartyUsageTelemetryEvent = {
  eventId: 'ct-third-party:delivery-test',
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

const legacyDeliveryEvent = {
  ...deliveryEvent,
  eventId: undefined,
  idempotencyKey: deliveryEvent.eventId,
  sourceApp: 'congress-trade' as const,
  keyRef: deliveryEvent.eventId,
};

function fakeEnv(messages: QueueMessage[]): Env {
  return {
    USAGE_MONITOR_ENVIRONMENT: 'test',
    INGEST_QUEUE: {
      send: vi.fn(async (message: QueueMessage) => {
        messages.push(message);
      }),
    },
  } as unknown as Env;
}

function fallbackBucket(initial: Record<string, string> = {}, uploadedAt: Record<string, Date> = {}) {
  const objects = new Map(Object.entries(initial));
  const put = vi.fn(async (key: string, value: unknown) => {
    if (typeof value !== 'string') throw new Error('test bucket expects string values');
    objects.set(key, value);
  });
  const remove = vi.fn(async (key: string | string[]) => {
    for (const item of Array.isArray(key) ? key : [key]) objects.delete(item);
  });
  const bucket = {
    put,
    delete: remove,
    async head(key: string) {
      return objects.has(key) ? {} : null;
    },
    async get(key: string) {
      const value = objects.get(key);
      return value == null ? null : { text: async () => value };
    },
    async list(options?: { prefix?: string; limit?: number }) {
      const filtered = [...objects.keys()]
        .filter((key) => !options?.prefix || key.startsWith(options.prefix));
      const keys = filtered.slice(0, options?.limit ?? filtered.length);
      return { objects: keys.map((key) => ({ key, uploaded: uploadedAt[key] })), truncated: false };
    },
  } as unknown as R2Bucket;
  return { bucket, objects, put, remove };
}

/** Minimal CONFIG_KV double for circuit-breaker + D1-drain-marker state. */
function fakeConfigKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const get = vi.fn(async (key: string, type?: string) => {
    const raw = store.get(key);
    if (raw == null) return null;
    return type === 'json' ? JSON.parse(raw) : raw;
  });
  const put = vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  });
  const del = vi.fn(async (key: string) => {
    store.delete(key);
  });
  return { kv: { get, put, delete: del } as unknown as KVNamespace, store, get, put, delete: del };
}

const CIRCUIT_KV_KEY = 'usage_telemetry_circuit_breaker';

/**
 * CONFIG_KV double that scripts successive reads of the circuit-breaker key so a
 * concurrent recorder updating it between another recorder's initial read and
 * its monotonic merge re-read can be simulated. Behaves as a plain store for
 * every other key (e.g. Infisical secret cache), and captures each value
 * written back to the circuit key.
 */
function scriptedCircuitKv(circuitReads: Array<Record<string, unknown> | null>) {
  const store = new Map<string, string>();
  const circuitPuts: Array<Record<string, unknown>> = [];
  let readIndex = 0;
  const get = vi.fn(async (key: string, type?: string) => {
    if (key === CIRCUIT_KV_KEY) {
      const value = circuitReads[Math.min(readIndex, circuitReads.length - 1)];
      readIndex += 1;
      return value; // kv.get(key, 'json') hands back an already-parsed object
    }
    const raw = store.get(key);
    if (raw == null) return null;
    return type === 'json' ? JSON.parse(raw) : raw;
  });
  const put = vi.fn(async (key: string, value: string) => {
    if (key === CIRCUIT_KV_KEY) circuitPuts.push(JSON.parse(value));
    else store.set(key, value);
  });
  const del = vi.fn(async (key: string) => { store.delete(key); });
  return { kv: { get, put, delete: del } as unknown as KVNamespace, circuitPuts, get, put };
}

/** Atomic singleton lease double for the half-open D1 coordination row. */
function probeLeaseD1() {
  let lease: { token: string; expiresAt: string } | null = null;
  const prepare = vi.fn((sql: string) => {
    let params: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        params = values;
        return statement;
      },
      async run() {
        if (/INSERT INTO usage_telemetry_probe_lease/i.test(sql)) {
          const [token, expiresAt, now] = params.map(String);
          if (lease && lease.expiresAt > now) return { success: true, meta: { changes: 0 } };
          lease = { token, expiresAt };
          return { success: true, meta: { changes: 1 } };
        }
        if (/DELETE FROM usage_telemetry_probe_lease/i.test(sql)) {
          if (lease?.token !== String(params[0])) return { success: true, meta: { changes: 0 } };
          lease = null;
          return { success: true, meta: { changes: 1 } };
        }
        throw new Error(`unexpected probe lease SQL: ${sql}`);
      },
    };
    return statement;
  });
  return {
    db: { prepare } as unknown as D1Database,
    getLease: () => lease,
    prepare,
  };
}

function fallbackD1(initial: Record<string, string> = {}) {
  let seq = 0;
  const stamp = () => new Date(Date.UTC(2026, 0, 1) + seq++).toISOString();
  const rows = new Map<string, { event_json: string; attempts: number; updated_at: string }>(
    Object.entries(initial).map(([key, eventJson]) => [key, { event_json: eventJson, attempts: 0, updated_at: stamp() }]),
  );
  const prepare = vi.fn((sql: string) => {
    let params: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        params = values;
        return statement;
      },
      async first<T>() {
        if (/COUNT\(\*\) AS pending/i.test(sql)) return { pending: rows.size } as T;
        return null as T | null;
      },
      async all<T>() {
        if (/FROM usage_telemetry_fallback_events/i.test(sql)) {
          const limit = Math.max(0, Number(params[0] ?? rows.size));
          // Mirror ORDER BY updated_at ASC so "move failing row to the back" is observable.
          const ordered = [...rows.entries()].sort((a, b) => a[1].updated_at.localeCompare(b[1].updated_at));
          return {
            results: ordered.slice(0, limit).map(([idempotency_key, row]) => ({
              idempotency_key,
              event_json: row.event_json,
              attempts: row.attempts,
            })) as T[],
          };
        }
        return { results: [] as T[] };
      },
      async run() {
        if (/DELETE FROM usage_telemetry_fallback_events/i.test(sql)) {
          rows.delete(String(params[0]));
        } else if (/UPDATE usage_telemetry_fallback_events/i.test(sql)) {
          const [attempts, updatedAt, key] = params;
          const row = rows.get(String(key));
          if (row) {
            row.attempts = Number(attempts);
            row.updated_at = String(updatedAt);
          }
        }
        return { success: true, meta: { changes: 1 } };
      },
    };
    return statement;
  });
  return { db: { prepare } as unknown as D1Database, rows, prepare };
}

describe('third-party usage telemetry', () => {
  it('classifies providers from an exact host allowlist and never emits an arbitrary host', () => {
    expect(providerForThirdPartyRequest('https://api.openai.com/v1/responses')).toBe('openai');
    expect(providerForThirdPartyRequest('https://api.openai.com.evil.example/v1')).toBe('external-api');
    expect(providerForThirdPartyRequest('https://tenant.cloudflareaccess.com/cdn-cgi/access/certs')).toBe('cloudflare-access');
    expect(providerForThirdPartyRequest('https://o123.ingest.us.sentry.io/api/1/envelope/')).toBe('sentry');
    expect(providerForThirdPartyRequest('https://http-intake.logs.us5.datadoghq.com/api/v2/logs')).toBe('datadog');
    expect(providerForThirdPartyRequest('https://customer.example/hook', 'subscriber-webhook')).toBe('webhook');
  });

  it('meters an SDK transport with an explicit Env without relying on handler context', async () => {
    const messages: QueueMessage[] = [];
    const env = fakeEnv(messages);
    await trackedFetch(
      'https://o123.ingest.sentry.io/api/1/envelope/',
      { method: 'POST' },
      { service: 'observability', operation: 'send-envelope' },
      vi.fn(async () => new Response('', { status: 200 })),
      { envOverride: env, silentQueueFailure: true },
    );
    const message = messages[0];
    if (message.type !== 'usage.telemetry') throw new Error('unexpected message');
    expect(message.event).toMatchObject({
      provider: 'sentry',
      service: 'observability',
      label: 'send-envelope',
      quantity: 1,
      unit: 'request',
    });
  });

  it('queues a receiver-compatible, secret-safe event for a successful attempt', async () => {
    const messages: QueueMessage[] = [];
    const inputUrl = 'https://api.openai.com/v1/responses?api_key=never-store-this';
    await withThirdPartyTelemetry(fakeEnv(messages), () =>
      trackedFetch(
        inputUrl,
        { headers: { authorization: 'Bearer never-store-this' }, body: 'secret-body', method: 'POST' },
        { service: 'llm', operation: 'extract-document', model: 'gpt-4o' },
        vi.fn(async () => new Response('{}', { status: 200 })),
      ),
    );

    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message.type).toBe('usage.telemetry');
    if (message.type !== 'usage.telemetry') throw new Error('unexpected message');
    expect(() => UsageTelemetryV2EventSchema.parse(message.event)).not.toThrow();
    expect(message.event).toMatchObject({
      provider: 'openai',
      service: 'llm',
      label: 'extract-document',
      metricType: 'usage',
      quantity: 1,
      unit: 'request',
      requests: 1,
      billingMode: 'actual',
      confidence: 'actual',
      metadata: { model: 'gpt-4o', success: true, status: 200 },
    });
    const serialized = JSON.stringify(message);
    expect(serialized).not.toContain('api_key');
    expect(serialized).not.toContain('never-store-this');
    expect(serialized).not.toContain('secret-body');
    expect(serialized).not.toContain('api.openai.com');
  });

  it('queues failures without leaking provider error messages', async () => {
    const messages: QueueMessage[] = [];
    const error = new TypeError('Bearer secret-token failed at https://private.example/path');
    await expect(
      withThirdPartyTelemetry(fakeEnv(messages), () =>
        trackedFetch(
          'https://api.mistral.ai/v1/ocr',
          undefined,
          { service: 'ocr', operation: 'extract-document', model: 'mistral-ocr-latest' },
          vi.fn(async () => { throw error; }),
        ),
      ),
    ).rejects.toBe(error);
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain('typeerror');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('private.example');
  });

  it('suppresses telemetry-delivery bootstrap calls to prevent recursive amplification', async () => {
    const messages: QueueMessage[] = [];
    const env = fakeEnv(messages);
    await withThirdPartyTelemetry(env, () =>
      withoutThirdPartyTelemetry(env, () =>
        trackedFetch(
          'https://app.infisical.com/api/v3/secrets/raw',
          undefined,
          { service: 'secret-management', operation: 'read-telemetry-bootstrap', dynamicTarget: 'infisical' },
          vi.fn(async () => new Response('{}', { status: 200 })),
        ),
      ),
    );
    expect(messages).toEqual([]);
  });

  it.each([
    ['service origin', 'https://usage.jays.services'],
    ['legacy full endpoint', 'https://usage.jays.services/api/ingest/usage/'],
  ])('sends to exactly one canonical ingest path from a %s config', async (_label, configuredUrl) => {
    const requestedUrls: string[] = [];
    const requestedBodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrls.push(typeof input === 'string' ? input : input.toString());
      requestedBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, schemaVersion: 2, received: 1, persisted: 1, duplicates: 0, pruned: 0, rejected: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const env = {
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_ENVIRONMENT: 'test',
      USAGE_MONITOR_INGEST_URL: configuredUrl,
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;

    await deliverUsageTelemetryEvent(env, deliveryEvent);

    expect(requestedUrls).toEqual(['https://usage.jays.services/api/ingest/usage']);
    expect(requestedBodies).toEqual([{
      schemaVersion: 2,
      producerId: 'congress-trade',
      events: [deliveryEvent],
    }]);
    expect(JSON.stringify(requestedBodies)).not.toMatch(/sourceApp|idempotencyKey|keyRef/);
  });

  const acceptedAck = {
    ok: true, schemaVersion: 2, received: 1,
    persisted: 1, duplicates: 0, pruned: 0, rejected: 0,
  };
  const incompleteAcks = [
    ['full rejection', { ...acceptedAck, persisted: 0, rejected: 1 }],
    ['rejection with receiver details', {
      ...acceptedAck, persisted: 0, rejected: 1,
      rejections: [{ index: 0, reason: 'private-response-value' }],
    }],
    ['partial rejection for the wrong batch', { ...acceptedAck, received: 2, rejected: 1 }],
    ['empty acknowledgement', { ...acceptedAck, received: 0, persisted: 0 }],
    ['wrong received count', { ...acceptedAck, received: 2, persisted: 2 }],
    ['inconsistent sum', { ...acceptedAck, persisted: 0 }],
    ['negative count', { ...acceptedAck, duplicates: -1, persisted: 2 }],
    ['fractional count', { ...acceptedAck, duplicates: 0.5, persisted: 0.5 }],
    ['missing counts', { ok: true, schemaVersion: 2 }],
    ['wrong version', { ...acceptedAck, schemaVersion: 1 }],
    ['unexpected schema field', { ...acceptedAck, schema: 'private-response-value' }],
    ['malformed JSON', 'not-json'],
  ] as const;

  it.each(incompleteAcks)('retains the original R2 event on a 202 with %s', async (_label, ack) => {
    const raw = JSON.stringify(deliveryEvent);
    const key = '_ops/usage-telemetry/ct-third-party%3Adelivery-test.json';
    const fallback = fallbackBucket({ [key]: raw });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      typeof ack === 'string' ? ack : JSON.stringify(ack), { status: 202 },
    )));
    const env = {
      RAW_FILES: fallback.bucket,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.example.test',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;

    await expect(deliverUsageTelemetryEvent(env, deliveryEvent)).rejects.toSatisfy((error: unknown) => {
      expect(isTerminalUsageTelemetryDeliveryError(error)).toBe(false);
      expect(String(error)).not.toContain('private-response-value');
      return true;
    });
    expect(await flushUsageTelemetryFallback(env)).toMatchObject({ delivered: 0, failed: 1 });
    expect(fallback.objects.get(key)).toBe(raw);
    expect(fallback.bucket.delete).not.toHaveBeenCalled();
    expect(fallback.put).not.toHaveBeenCalled();
  });

  it.each([
    ['persisted', { ...acceptedAck }],
    ['duplicate', { ...acceptedAck, persisted: 0, duplicates: 1 }],
    ['pruned', { ...acceptedAck, persisted: 0, pruned: 1 }],
  ])('removes an R2 receipt only after a valid %s ACK', async (_label, ack) => {
    const key = '_ops/usage-telemetry/ct-third-party%3Adelivery-test.json';
    const fallback = fallbackBucket({ [key]: JSON.stringify(deliveryEvent) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(ack), { status: 202 })));
    const env = {
      RAW_FILES: fallback.bucket,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.example.test',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;
    expect(await flushUsageTelemetryFallback(env)).toMatchObject({ delivered: 1, failed: 0 });
    expect(fallback.objects.has(key)).toBe(false);
  });

  it.each([
    ['v2', deliveryEvent], ['legacy', legacyDeliveryEvent],
  ])('retries a rejected %s event with unchanged identity and accepts a duplicate ACK', async (_label, event) => {
    const key = '_ops/usage-telemetry/ct-third-party%3Adelivery-test.json';
    const raw = JSON.stringify(event);
    const fallback = fallbackBucket({ [key]: raw });
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const ack = bodies.length === 1
        ? { ...acceptedAck, persisted: 0, rejected: 1 }
        : { ...acceptedAck, persisted: 0, duplicates: 1 };
      return new Response(JSON.stringify(ack), { status: 202 });
    }));
    const env = {
      RAW_FILES: fallback.bucket,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.example.test',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;
    expect(await flushUsageTelemetryFallback(env)).toMatchObject({ delivered: 0, failed: 1 });
    expect(fallback.objects.get(key)).toBe(raw);
    expect(await flushUsageTelemetryFallback(env)).toMatchObject({ delivered: 1, failed: 0 });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({ events: [{ eventId: deliveryEvent.eventId }] });
    expect(fallback.objects.has(key)).toBe(false);
  });

  it('persists the exact idempotent event to the R2 fallback when Queue hand-off fails', async () => {
    const fallback = fallbackBucket();
    const env = {
      INGEST_QUEUE: { send: vi.fn(async () => { throw new Error('queue unavailable'); }) },
      RAW_FILES: fallback.bucket,
    } as unknown as Env;

    const accepted = await enqueueUsageTelemetryEvent(env, deliveryEvent);

    expect(accepted).toBe(true);
    expect(fallback.put).toHaveBeenCalledOnce();
    const [key, value] = fallback.put.mock.calls[0];
    expect(key).toBe('_ops/usage-telemetry/ct-third-party%3Adelivery-test.json');
    expect(JSON.parse(String(value))).toEqual(deliveryEvent);
  });

  it('last-chance delivers directly when Queue and fallback persistence both fail', async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requestedUrls.push(typeof input === 'string' ? input : input.toString());
      return new Response(JSON.stringify({ ok: true, schemaVersion: 2, received: 1, persisted: 1, duplicates: 0, pruned: 0, rejected: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const env = {
      INGEST_QUEUE: { send: vi.fn(async () => { throw new Error('queue unavailable'); }) },
      RAW_FILES: { put: vi.fn(async () => { throw new TypeError('r2 unavailable'); }) },
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;

    const accepted = await enqueueUsageTelemetryEvent(env, deliveryEvent);

    expect(accepted).toBe(true);
    expect(requestedUrls).toEqual(['https://usage.jays.services/api/ingest/usage']);
  });

  it('never writes a new row to the legacy D1 fallback table, even when Queue, R2, and direct delivery all fail', async () => {
    // D1's usage_telemetry_fallback_events table is legacy-drain-only: this is
    // the exact failure combination that used to fall through to a D1 INSERT,
    // and that per-event D1 write (repeated for every event during a receiver
    // outage) is what caused the D1 read/write cost incident.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'receiver unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })));
    const fallback = fallbackD1();
    const env = {
      INGEST_QUEUE: { send: vi.fn(async () => { throw new Error('queue unavailable'); }) },
      RAW_FILES: { put: vi.fn(async () => { throw new TypeError('r2 unavailable'); }) },
      DB: fallback.db,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;

    const accepted = await enqueueUsageTelemetryEvent(env, deliveryEvent);

    expect(accepted).toBe(false);
    expect(fallback.prepare).not.toHaveBeenCalled();
    expect(fallback.rows.size).toBe(0);
    error.mockRestore();
  });

  it('reports a secret-safe terminal loss only when Queue, R2, and direct delivery all fail', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'receiver unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })));
    const env = {
      INGEST_QUEUE: { send: vi.fn(async () => { throw new Error('queue-secret-value'); }) },
      RAW_FILES: { put: vi.fn(async () => { throw new TypeError('r2-secret-value'); }) },
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;

    const accepted = await enqueueUsageTelemetryEvent(env, deliveryEvent);

    expect(accepted).toBe(false);
    const serializedLog = JSON.stringify(error.mock.calls);
    expect(serializedLog).toContain('usage telemetry durability exhausted');
    expect(serializedLog).toContain('TypeError');
    expect(serializedLog).toContain('Error');
    expect(serializedLog).not.toContain('queue-secret-value');
    expect(serializedLog).not.toContain('r2-secret-value');
    expect(serializedLog).not.toContain('receiver unavailable');
    error.mockRestore();
  });

  it('retains fallback events until the receiver accepts them, then deletes them', async () => {
    const key = '_ops/usage-telemetry/ct-third-party%3Adelivery-test.json';
    const fallback = fallbackBucket({ [key]: JSON.stringify(deliveryEvent) });
    let receiverAvailable = false;
    vi.stubGlobal('fetch', vi.fn(async () => receiverAvailable
      ? new Response(JSON.stringify({ ok: true, schemaVersion: 2, received: 1, persisted: 1, duplicates: 0, pruned: 0, rejected: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response(JSON.stringify({ error: 'receiver unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })));
    const env = {
      RAW_FILES: fallback.bucket,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;

    expect(await flushUsageTelemetryFallback(env)).toEqual({
      listed: 1, delivered: 0, failed: 1, expired: 0, skipped: false,
    });
    expect(fallback.objects.has(key)).toBe(true);
    expect(fallback.remove).not.toHaveBeenCalled();

    receiverAvailable = true;
    expect(await flushUsageTelemetryFallback(env)).toEqual({
      listed: 1, delivered: 1, failed: 0, expired: 0, skipped: false,
    });
    expect(fallback.objects.has(key)).toBe(false);
    expect(fallback.remove).toHaveBeenCalledWith(key);
  });

  it('retains legacy D1 fallback rows unchanged on a transient failure, then deletes on success', async () => {
    const fallback = fallbackD1({ [legacyDeliveryEvent.idempotencyKey]: JSON.stringify(legacyDeliveryEvent) });
    let receiverAvailable = false;
    vi.stubGlobal('fetch', vi.fn(async () => receiverAvailable
      ? new Response(JSON.stringify({ ok: true, schemaVersion: 2, received: 1, persisted: 1, duplicates: 0, pruned: 0, rejected: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response(JSON.stringify({ error: 'receiver unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })));
    const env = {
      RAW_FILES: fallbackBucket().bucket,
      DB: fallback.db,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;

    expect(await flushUsageTelemetryFallback(env)).toEqual({
      listed: 1, delivered: 0, failed: 1, expired: 0, skipped: false,
    });
    // Receiver failures retain the valid row unchanged for a later retry.
    expect(fallback.rows.get(legacyDeliveryEvent.idempotencyKey)?.attempts).toBe(0);
    expect(fallback.rows.has(legacyDeliveryEvent.idempotencyKey)).toBe(true);

    receiverAvailable = true;
    expect(await flushUsageTelemetryFallback(env)).toEqual({
      listed: 1, delivered: 1, failed: 0, expired: 0, skipped: false,
    });
    expect(fallback.rows.has(legacyDeliveryEvent.idempotencyKey)).toBe(false);
  });

  it('bounds deterministic receiver rejections so one valid legacy D1 row cannot poison the drain forever', async () => {
    const goodEvent = { ...legacyDeliveryEvent, idempotencyKey: 'ct-third-party:terminal-row-follower' };
    const fallback = fallbackD1({
      [legacyDeliveryEvent.idempotencyKey]: JSON.stringify(legacyDeliveryEvent),
      [goodEvent.idempotencyKey]: JSON.stringify(goodEvent),
    });
    const quarantine = fallbackBucket();
    const { kv } = fakeConfigKv();
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body)) as { events: ThirdPartyUsageTelemetryEvent[] };
      return parsed.events[0]?.eventId === legacyDeliveryEvent.idempotencyKey
        ? new Response(JSON.stringify({ error: 'idempotency conflict' }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(JSON.stringify({ ok: true, schemaVersion: 2, received: 1, persisted: 1, duplicates: 0, pruned: 0, rejected: 0 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
    }));
    const env = {
      RAW_FILES: quarantine.bucket,
      DB: fallback.db,
      CONFIG_KV: kv,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
      USAGE_TELEMETRY_CIRCUIT_FAILURE_THRESHOLD: '1',
    } as unknown as Env;

    expect(await flushUsageTelemetryFallback(env)).toMatchObject({ delivered: 1, failed: 1 });
    expect(fallback.rows.has(goodEvent.idempotencyKey)).toBe(false);
    expect(fallback.rows.get(legacyDeliveryEvent.idempotencyKey)?.attempts).toBe(1);
    expect(await isUsageTelemetryCircuitOpen(env)).toBe(false);
    for (let attempts = 2; attempts < 5; attempts += 1) {
      expect(await flushUsageTelemetryFallback(env)).toMatchObject({ delivered: 0, failed: 1 });
      expect(fallback.rows.get(legacyDeliveryEvent.idempotencyKey)?.attempts).toBe(attempts);
      expect(await isUsageTelemetryCircuitOpen(env)).toBe(false);
    }
    expect(await flushUsageTelemetryFallback(env)).toMatchObject({ delivered: 0, failed: 1 });
    expect(fallback.rows.has(legacyDeliveryEvent.idempotencyKey)).toBe(false);
    expect(quarantine.objects.has(
      '_ops/usage-telemetry-quarantine/ct-third-party%3Adelivery-test.json',
    )).toBe(true);
  });

  it('retains a terminal legacy D1 row when R2 quarantine persistence fails', async () => {
    const fallback = fallbackD1({ [legacyDeliveryEvent.idempotencyKey]: JSON.stringify(legacyDeliveryEvent) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid payload' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })));
    const env = {
      RAW_FILES: {
        list: vi.fn(async () => ({ objects: [], truncated: false })),
        put: vi.fn(async () => { throw new Error('R2 unavailable'); }),
      },
      DB: fallback.db,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;

    for (let i = 0; i < 6; i += 1) await flushUsageTelemetryFallback(env);
    expect(fallback.rows.get(legacyDeliveryEvent.idempotencyKey)?.attempts).toBe(4);
    expect(fallback.rows.has(legacyDeliveryEvent.idempotencyKey)).toBe(true);
  });

  it('quarantines a terminal R2 outbox object instead of replaying it forever', async () => {
    const poisonEvent = { ...legacyDeliveryEvent, idempotencyKey: 'ct-third-party:terminal-r2' };
    const outboxKey = '_ops/usage-telemetry/ct-third-party%3Aterminal-r2.json';
    const fallback = fallbackBucket({ [outboxKey]: JSON.stringify(poisonEvent) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'idempotency conflict' }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })));
    const env = {
      RAW_FILES: fallback.bucket,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;

    const result = await flushUsageTelemetryFallback(env);

    expect(result).toMatchObject({ listed: 1, delivered: 0, failed: 1, expired: 0, skipped: false });
    expect(fallback.objects.has(outboxKey)).toBe(false);
    expect(fallback.objects.has(
      '_ops/usage-telemetry-quarantine/ct-third-party%3Aterminal-r2.json',
    )).toBe(true);
  });

  it('quarantines malformed R2 bytes by source object identity before deleting the outbox object', async () => {
    const outboxKey = '_ops/usage-telemetry/malformed-object.json';
    const raw = 'not-valid-json{';
    const fallback = fallbackBucket({ [outboxKey]: raw });
    const env = { RAW_FILES: fallback.bucket } as unknown as Env;

    const result = await flushUsageTelemetryFallback(env);
    const quarantineKey = `_ops/usage-telemetry-quarantine/${encodeURIComponent(outboxKey)}.json`;

    expect(result).toMatchObject({ listed: 1, delivered: 0, failed: 1, expired: 0, skipped: false });
    expect(fallback.objects.has(outboxKey)).toBe(false);
    expect(fallback.objects.get(quarantineKey)).toBe(raw);
    expect(fallback.put).toHaveBeenCalledWith(
      quarantineKey,
      raw,
      expect.objectContaining({ customMetadata: { reason: 'malformed' } }),
    );
  });

  it('retains malformed R2 bytes when quarantine persistence fails', async () => {
    const outboxKey = '_ops/usage-telemetry/malformed-retained.json';
    const raw = 'still-not-valid-json{';
    const fallback = fallbackBucket({ [outboxKey]: raw });
    const quarantinePut = vi.fn(async () => { throw new Error('R2 quarantine unavailable'); });
    const env = {
      RAW_FILES: { ...fallback.bucket, put: quarantinePut },
    } as unknown as Env;

    const result = await flushUsageTelemetryFallback(env);

    expect(result).toMatchObject({ listed: 1, delivered: 0, failed: 1, expired: 0, skipped: false });
    expect(fallback.objects.get(outboxKey)).toBe(raw);
    expect(fallback.remove).not.toHaveBeenCalled();
    expect(quarantinePut).toHaveBeenCalledOnce();
  });

  it('retains an R2 event when a 400 response is receiver-wide rather than event-specific', async () => {
    const outboxKey = '_ops/usage-telemetry/ct-third-party%3Areceiver-contract.json';
    const fallback = fallbackBucket({ [outboxKey]: JSON.stringify(deliveryEvent) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'receiver unavailable' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })));
    const env = {
      RAW_FILES: fallback.bucket,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;

    const result = await flushUsageTelemetryFallback(env);

    expect(result).toMatchObject({ listed: 1, delivered: 0, failed: 1, expired: 0, skipped: false });
    expect(fallback.objects.has(outboxKey)).toBe(true);
    expect(fallback.objects.has(
      '_ops/usage-telemetry-quarantine/ct-third-party%3Areceiver-contract.json',
    )).toBe(false);
  });

  it('never ages out a valid legacy D1 row on transient receiver failures', async () => {
    const fallback = fallbackD1({ [legacyDeliveryEvent.idempotencyKey]: JSON.stringify(legacyDeliveryEvent) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'rate limited' }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    })));
    const env = {
      RAW_FILES: fallbackBucket().bucket,
      DB: fallback.db,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;

    for (let i = 0; i < 7; i += 1) await flushUsageTelemetryFallback(env);
    expect(fallback.rows.get(legacyDeliveryEvent.idempotencyKey)?.attempts).toBe(0);
    expect(fallback.rows.has(legacyDeliveryEvent.idempotencyKey)).toBe(true);
  });

  it('treats a malformed successful receiver response as transient for legacy D1 retention', async () => {
    const fallback = fallbackD1({ [legacyDeliveryEvent.idempotencyKey]: JSON.stringify(legacyDeliveryEvent) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"unexpected":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const env = {
      RAW_FILES: fallbackBucket().bucket,
      DB: fallback.db,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;

    for (let i = 0; i < 6; i += 1) await flushUsageTelemetryFallback(env);
    expect(fallback.rows.get(legacyDeliveryEvent.idempotencyKey)?.attempts).toBe(0);
    expect(fallback.rows.has(legacyDeliveryEvent.idempotencyKey)).toBe(true);
  });

  it('retains global receiver authentication failures and opens the outage circuit', async () => {
    const fallback = fallbackD1({ [legacyDeliveryEvent.idempotencyKey]: JSON.stringify(legacyDeliveryEvent) });
    const { kv } = fakeConfigKv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })));
    const env = {
      RAW_FILES: fallbackBucket().bucket,
      DB: fallback.db,
      CONFIG_KV: kv,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
      USAGE_TELEMETRY_CIRCUIT_FAILURE_THRESHOLD: '1',
    } as unknown as Env;

    await flushUsageTelemetryFallback(env);
    expect(fallback.rows.get(legacyDeliveryEvent.idempotencyKey)?.attempts).toBe(0);
    expect(fallback.rows.has(legacyDeliveryEvent.idempotencyKey)).toBe(true);
    expect(await isUsageTelemetryCircuitOpen(env)).toBe(true);
  });

  it('does not let one poison legacy D1 row wedge the drain: quarantines it after a bounded budget while rows behind it still deliver', async () => {
    // Oldest row is permanently unparseable (poison); a good row sits behind it.
    const poisonKey = 'ct-third-party:poison-legacy-row';
    const goodEvent = { ...legacyDeliveryEvent, idempotencyKey: 'ct-third-party:good-legacy-row' };
    const fallback = fallbackD1({
      [poisonKey]: 'not-valid-json{',
      [goodEvent.idempotencyKey]: JSON.stringify(goodEvent),
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, schemaVersion: 2, received: 1, persisted: 1, duplicates: 0, pruned: 0, rejected: 0 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const env = {
      RAW_FILES: fallbackBucket().bucket,
      DB: fallback.db,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;

    // First flush: poison row fails (parse) and is bumped+moved to back; the
    // good row behind it is delivered and deleted in the SAME cycle.
    const first = await flushUsageTelemetryFallback(env);
    expect(first).toMatchObject({ delivered: 1, failed: 1 });
    expect(fallback.rows.has(goodEvent.idempotencyKey)).toBe(false);
    expect(fallback.rows.get(poisonKey)?.attempts).toBe(1);

    // The poison row is dropped once it exhausts its bounded attempt budget (5),
    // so it can never block the drain forever.
    for (let i = 0; i < 5; i += 1) await flushUsageTelemetryFallback(env);
    expect(fallback.rows.has(poisonKey)).toBe(false);
  });

  it('marks the legacy D1 drain complete once observed empty, then skips further D1 queries', async () => {
    const { kv } = fakeConfigKv();
    const fallback = fallbackD1();
    const env = {
      RAW_FILES: fallbackBucket().bucket,
      DB: fallback.db,
      CONFIG_KV: kv,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;

    const first = await flushUsageTelemetryFallback(env);
    expect(first).toEqual({ listed: 0, delivered: 0, failed: 0, expired: 0, skipped: false });
    expect(fallback.prepare).toHaveBeenCalled();

    fallback.prepare.mockClear();
    const second = await flushUsageTelemetryFallback(env);
    expect(second).toEqual({ listed: 0, delivered: 0, failed: 0, expired: 0, skipped: false });
    expect(fallback.prepare).not.toHaveBeenCalled();
  });

  it('discards R2 outbox objects older than USAGE_TELEMETRY_FALLBACK_TTL_DAYS without attempting delivery', async () => {
    const staleKey = '_ops/usage-telemetry/stale-event.json';
    const freshKey = '_ops/usage-telemetry/fresh-event.json';
    const staleEvent = { ...legacyDeliveryEvent, idempotencyKey: 'ct-third-party:stale-event' };
    const freshEvent = { ...legacyDeliveryEvent, idempotencyKey: 'ct-third-party:fresh-event' };
    const now = new Date('2026-07-17T00:00:00.000Z');
    const fallback = fallbackBucket(
      { [staleKey]: JSON.stringify(staleEvent), [freshKey]: JSON.stringify(freshEvent) },
      {
        [staleKey]: new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000),
        [freshKey]: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
      },
    );
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, schemaVersion: 2, received: 1, persisted: 1, duplicates: 0, pruned: 0, rejected: 0 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const env = {
      RAW_FILES: fallback.bucket,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
      USAGE_TELEMETRY_FALLBACK_TTL_DAYS: '14',
    } as unknown as Env;

    const result = await flushUsageTelemetryFallback(env);

    expect(result).toMatchObject({ delivered: 1, failed: 0, expired: 1, skipped: false });
    expect(fallback.objects.has(staleKey)).toBe(false);
    expect(fallback.objects.has(freshKey)).toBe(false);
    // Only the fresh (non-expired) event ever reaches the receiver.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips the whole flush cycle without listing R2 or querying D1 while the circuit breaker is open', async () => {
    const list = vi.fn(async () => ({ objects: [], truncated: false }));
    const prepare = vi.fn();
    const { kv } = fakeConfigKv({
      usage_telemetry_circuit_breaker: JSON.stringify({ consecutiveFailures: 5, openUntil: Date.now() + 60_000 }),
    });
    const env = {
      CONFIG_KV: kv,
      RAW_FILES: { list },
      DB: { prepare },
    } as unknown as Env;

    const result = await flushUsageTelemetryFallback(env);

    expect(result).toEqual({ listed: 0, delivered: 0, failed: 0, expired: 0, skipped: true });
    expect(list).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('opens the circuit after consecutive delivery failures and suppresses further live delivery attempts without calling fetch', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'receiver unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { kv } = fakeConfigKv();
    const env = {
      CONFIG_KV: kv,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
      USAGE_TELEMETRY_CIRCUIT_FAILURE_THRESHOLD: '2',
    } as unknown as Env;

    await expect(deliverUsageTelemetryEvent(env, deliveryEvent)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await isUsageTelemetryCircuitOpen(env)).toBe(false);

    await expect(deliverUsageTelemetryEvent(env, deliveryEvent)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await isUsageTelemetryCircuitOpen(env)).toBe(true);

    await expect(deliverUsageTelemetryEvent(env, deliveryEvent)).rejects.toThrow(UsageTelemetryCircuitOpenError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('records a failure monotonically: a stale-closed recorder cannot re-close or lower a circuit a concurrent recorder just opened', async () => {
    // CONFIG_KV has no atomic increment, so a recorder that read a stale-closed
    // snapshot must not, on write-back, clobber an open circuit or drop the
    // failure count that a concurrent recorder advanced in the meantime. The
    // merge re-read observes the concurrently-opened state (3rd circuit read).
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'receiver unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const concurrentlyOpened = 9_999_999_999_999; // far-future openUntil set by a peer recorder
    const { kv, circuitPuts } = scriptedCircuitKv([
      { consecutiveFailures: 1, openUntil: null }, // isOpen() read: closed -> attempt delivery
      { consecutiveFailures: 1, openUntil: null }, // recordFailure initial read: proposes (2, null)
      { consecutiveFailures: 3, openUntil: concurrentlyOpened }, // merge re-read: peer opened it
    ]);
    const env = {
      CONFIG_KV: kv,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
      USAGE_TELEMETRY_CIRCUIT_FAILURE_THRESHOLD: '3',
    } as unknown as Env;

    await expect(deliverUsageTelemetryEvent(env, deliveryEvent)).rejects.toThrow();

    // The written state keeps the peer's open circuit and higher count intact,
    // rather than the stale (2, null) this recorder computed on its own.
    expect(circuitPuts).toHaveLength(1);
    expect(circuitPuts[0]).toEqual({ consecutiveFailures: 3, openUntil: concurrentlyOpened });
  });

  it('half-open probe: a successful delivery once the backoff window elapses fully closes the circuit again', async () => {
    let receiverAvailable = false;
    const fetchMock = vi.fn(async () => (receiverAvailable
      ? new Response(JSON.stringify({ ok: true, schemaVersion: 2, received: 1, persisted: 1, duplicates: 0, pruned: 0, rejected: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response(JSON.stringify({ error: 'receiver unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })));
    vi.stubGlobal('fetch', fetchMock);
    const { kv } = fakeConfigKv();
    const probeLease = probeLeaseD1();
    const env = {
      CONFIG_KV: kv,
      DB: probeLease.db,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
      USAGE_TELEMETRY_CIRCUIT_FAILURE_THRESHOLD: '1',
      USAGE_TELEMETRY_CIRCUIT_BASE_BACKOFF_MS: '30000',
    } as unknown as Env;

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:00:00.000Z'));
    await expect(deliverUsageTelemetryEvent(env, deliveryEvent)).rejects.toThrow();
    expect(await isUsageTelemetryCircuitOpen(env)).toBe(true);

    // Still within the backoff window: suppressed without a new fetch call.
    vi.setSystemTime(new Date('2026-07-17T00:00:15.000Z'));
    expect(await isUsageTelemetryCircuitOpen(env)).toBe(true);
    await expect(deliverUsageTelemetryEvent(env, deliveryEvent)).rejects.toThrow(UsageTelemetryCircuitOpenError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Backoff elapsed: the next attempt is the half-open probe. Receiver is
    // healthy again, so it succeeds and fully closes the circuit.
    receiverAvailable = true;
    vi.setSystemTime(new Date('2026-07-17T00:00:31.000Z'));
    expect(await isUsageTelemetryCircuitOpen(env)).toBe(false);
    await deliverUsageTelemetryEvent(env, deliveryEvent);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await isUsageTelemetryCircuitOpen(env)).toBe(false);
    expect(probeLease.getLease()).toBeNull();
  });

  it('allows only one concurrent half-open receiver probe across isolates', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:01:00.000Z'));
    const { kv } = fakeConfigKv({
      usage_telemetry_circuit_breaker: JSON.stringify({
        consecutiveFailures: 1,
        openUntil: Date.now() - 1,
      }),
    });
    const probeLease = probeLeaseD1();
    let resolveReceiver!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveReceiver = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      CONFIG_KV: kv,
      DB: probeLease.db,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;

    const firstProbe = deliverUsageTelemetryEvent(env, deliveryEvent);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(probeLease.getLease()).not.toBeNull();

    await expect(deliverUsageTelemetryEvent(env, deliveryEvent))
      .rejects.toThrow(UsageTelemetryCircuitOpenError);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await isUsageTelemetryCircuitOpen(env)).toBe(true);

    resolveReceiver(new Response(JSON.stringify({ ok: true, schemaVersion: 2, received: 1, persisted: 1, duplicates: 0, pruned: 0, rejected: 0 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await firstProbe;
    expect(probeLease.getLease()).toBeNull();
    expect(await isUsageTelemetryCircuitOpen(env)).toBe(false);
  });

  it('does not claim the half-open lease until secret resolution completes', async () => {
    const { kv } = fakeConfigKv({
      usage_telemetry_circuit_breaker: JSON.stringify({
        consecutiveFailures: 1,
        openUntil: Date.now() - 1,
      }),
    });
    const probeLease = probeLeaseD1();
    let releaseSecrets!: () => void;
    const secretGate = new Promise<void>((resolve) => { releaseSecrets = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/auth/universal-auth/login')) {
        await secretGate;
        return new Response(JSON.stringify({ accessToken: 'test-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/v3/secrets/raw')) {
        return new Response(JSON.stringify({
          secrets: [
            { secretKey: 'USAGE_MONITOR_INGEST_URL', secretValue: 'https://usage.jays.services/api/ingest/usage' },
            { secretKey: 'USAGE_MONITOR_INGEST_TOKEN', secretValue: 'test-ingest-token' },
          ],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('usage.jays.services')) {
        return new Response(JSON.stringify({ ok: true, schemaVersion: 2, received: 1, persisted: 1, duplicates: 0, pruned: 0, rejected: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected test request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      CONFIG_KV: kv,
      DB: probeLease.db,
      INFISICAL_BASE_URL: 'https://infisical-lease-order.test',
      INFISICAL_APP_PROJECT_ID: 'lease-order-project',
      INFISICAL_APP_CLIENT_ID: 'lease-order-client',
      INFISICAL_APP_CLIENT_SECRET: 'lease-order-secret',
      INFISICAL_ALLOW_ENV_FALLBACK: 'false',
      USAGE_MONITOR_ENABLED: 'true',
    } as unknown as Env;

    const pending = deliverUsageTelemetryEvent(env, deliveryEvent);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(probeLease.prepare).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes('usage.jays.services'))).toBe(true);

    releaseSecrets();
    await pending;
    expect(probeLease.prepare).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('usage.jays.services'))).toBe(true);
    expect(probeLease.getLease()).toBeNull();
  });

  it('does not let a stale-KV lease contender reopen the circuit after the owner succeeds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:01:30.000Z'));
    const expiredState = { consecutiveFailures: 2, openUntil: Date.now() - 1 };
    const probeGateState = { consecutiveFailures: 2, openUntil: Date.now() + 30_000 };
    const { kv, circuitPuts } = scriptedCircuitKv([
      expiredState,
      expiredState,
      probeGateState,
    ]);
    const probeLease = probeLeaseD1();
    let resolveReceiver!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveReceiver = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      CONFIG_KV: kv,
      DB: probeLease.db,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;

    const ownerProbe = deliverUsageTelemetryEvent(env, deliveryEvent);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(deliverUsageTelemetryEvent(env, deliveryEvent))
      .rejects.toThrow(UsageTelemetryCircuitOpenError);
    expect(fetchMock).toHaveBeenCalledOnce();

    resolveReceiver(new Response(JSON.stringify({ ok: true, schemaVersion: 2, received: 1, persisted: 1, duplicates: 0, pruned: 0, rejected: 0 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await ownerProbe;
    expect(circuitPuts).toEqual([
      probeGateState,
      { consecutiveFailures: 0, openUntil: null },
    ]);
    expect(probeLease.getLease()).toBeNull();
  });

  it('fails closed without calling the receiver when the half-open D1 lease cannot be claimed', async () => {
    const { kv } = fakeConfigKv({
      usage_telemetry_circuit_breaker: JSON.stringify({
        consecutiveFailures: 1,
        openUntil: Date.now() - 1,
      }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const prepare = vi.fn(() => { throw new Error('D1 unavailable'); });
    const env = {
      CONFIG_KV: kv,
      DB: { prepare },
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
      USAGE_TELEMETRY_CIRCUIT_FAILURE_THRESHOLD: '1',
    } as unknown as Env;

    await expect(deliverUsageTelemetryEvent(env, deliveryEvent))
      .rejects.toThrow(UsageTelemetryCircuitOpenError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await isUsageTelemetryCircuitOpen(env)).toBe(true);
    await expect(deliverUsageTelemetryEvent(env, deliveryEvent))
      .rejects.toThrow(UsageTelemetryCircuitOpenError);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('does not probe when the durable KV probe-in-flight gate cannot be persisted', async () => {
    const expiredState = { consecutiveFailures: 1, openUntil: Date.now() - 1 };
    const probeLease = probeLeaseD1();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      CONFIG_KV: {
        get: vi.fn(async () => expiredState),
        put: vi.fn(async () => { throw new Error('KV unavailable'); }),
      },
      DB: probeLease.db,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;

    await expect(deliverUsageTelemetryEvent(env, deliveryEvent))
      .rejects.toThrow(UsageTelemetryCircuitOpenError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(probeLease.getLease()).not.toBeNull();
  });

  it('fails closed without calling the receiver when CONFIG_KV cannot be read', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      CONFIG_KV: { get: vi.fn(async () => { throw new Error('KV unavailable'); }) },
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;

    await expect(deliverUsageTelemetryEvent(env, deliveryEvent))
      .rejects.toThrow(UsageTelemetryCircuitOpenError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed without calling the receiver when CONFIG_KV circuit state is malformed', async () => {
    const { kv } = fakeConfigKv({
      usage_telemetry_circuit_breaker: JSON.stringify({
        consecutiveFailures: -1,
        openUntil: 'not-a-timestamp',
      }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      CONFIG_KV: kv,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;

    await expect(deliverUsageTelemetryEvent(env, deliveryEvent))
      .rejects.toThrow(UsageTelemetryCircuitOpenError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts a hung receiver within the configured delivery timeout and opens the circuit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:02:00.000Z'));
    const { kv } = fakeConfigKv();
    let observedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      CONFIG_KV: kv,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
      USAGE_TELEMETRY_DELIVERY_TIMEOUT_MS: '100',
      USAGE_TELEMETRY_CIRCUIT_FAILURE_THRESHOLD: '1',
    } as unknown as Env;

    const pending = deliverUsageTelemetryEvent(env, deliveryEvent);
    const rejection = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(101);
    await rejection;
    expect(observedSignal?.aborted).toBe(true);
    expect(await isUsageTelemetryCircuitOpen(env)).toBe(true);
  });

  it('keeps the delivery timeout active while a receiver response body is stalled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:03:00.000Z'));
    const { kv } = fakeConfigKv();
    let observedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":'));
          observedSignal?.addEventListener('abort', () => {
            controller.error(new DOMException('Aborted', 'AbortError'));
          });
        },
      });
      return Promise.resolve(new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      CONFIG_KV: kv,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
      USAGE_TELEMETRY_DELIVERY_TIMEOUT_MS: '100',
      USAGE_TELEMETRY_CIRCUIT_FAILURE_THRESHOLD: '1',
    } as unknown as Env;

    const pending = deliverUsageTelemetryEvent(env, deliveryEvent);
    const rejection = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(101);
    await rejection;
    expect(observedSignal?.aborted).toBe(true);
    expect(await isUsageTelemetryCircuitOpen(env)).toBe(true);
  });

  it('drops a new fallback event once the R2 outbox is at USAGE_TELEMETRY_FALLBACK_MAX_OBJECTS capacity', async () => {
    const fallback = fallbackBucket({
      '_ops/usage-telemetry/existing-1.json': '{}',
      '_ops/usage-telemetry/existing-2.json': '{}',
    });
    const env = {
      RAW_FILES: fallback.bucket,
      USAGE_TELEMETRY_FALLBACK_MAX_OBJECTS: '2',
    } as unknown as Env;

    const accepted = await persistUsageTelemetryFallback(env, deliveryEvent, { silentFailure: true });

    expect(accepted).toBe(false);
    expect(fallback.put).not.toHaveBeenCalled();
  });

  it('throws at outbox capacity when the caller requires exact-event durability', async () => {
    const fallback = fallbackBucket({
      '_ops/usage-telemetry/existing.json': '{}',
    });
    const env = {
      RAW_FILES: fallback.bucket,
      USAGE_TELEMETRY_FALLBACK_MAX_OBJECTS: '1',
    } as unknown as Env;

    await expect(persistUsageTelemetryFallback(
      env,
      deliveryEvent,
      { silentFailure: true, throwOnFailure: true },
    )).rejects.toThrow('outbox is at capacity');
    expect(fallback.put).not.toHaveBeenCalled();
  });

  it('still writes a new fallback event under the R2 outbox capacity', async () => {
    const fallback = fallbackBucket({
      '_ops/usage-telemetry/existing-1.json': '{}',
    });
    const env = {
      RAW_FILES: fallback.bucket,
      USAGE_TELEMETRY_FALLBACK_MAX_OBJECTS: '2',
    } as unknown as Env;

    const accepted = await persistUsageTelemetryFallback(env, deliveryEvent);

    expect(accepted).toBe(true);
    expect(fallback.put).toHaveBeenCalledOnce();
  });

  it('enforces the cap with an O(1) KV counter read and does not list R2 when the counter is at capacity', async () => {
    const { kv, store } = fakeConfigKv({ usage_telemetry_outbox_count: '2' });
    const list = vi.fn();
    const put = vi.fn();
    const env = {
      CONFIG_KV: kv,
      RAW_FILES: { list, put },
      USAGE_TELEMETRY_FALLBACK_MAX_OBJECTS: '2',
    } as unknown as Env;

    const accepted = await persistUsageTelemetryFallback(env, deliveryEvent, { silentFailure: true });

    expect(accepted).toBe(false);
    // O(1): admission is gated on the KV counter, never an R2 list on the hot path.
    expect(list).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(store.get('usage_telemetry_outbox_count')).toBe('2');
  });

  it('increments the KV outbox counter on a successful fallback write, staying list-free', async () => {
    const { kv, store } = fakeConfigKv({ usage_telemetry_outbox_count: '1' });
    const list = vi.fn();
    const put = vi.fn(async () => {});
    const env = {
      CONFIG_KV: kv,
      RAW_FILES: { list, put },
      USAGE_TELEMETRY_FALLBACK_MAX_OBJECTS: '5',
    } as unknown as Env;

    const accepted = await persistUsageTelemetryFallback(env, deliveryEvent);

    expect(accepted).toBe(true);
    expect(list).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledOnce();
    expect(store.get('usage_telemetry_outbox_count')).toBe('2');
  });

  it('does not increment the KV outbox counter when an idempotent write overwrites an existing R2 object', async () => {
    const key = '_ops/usage-telemetry/ct-third-party%3Adelivery-test.json';
    const fallback = fallbackBucket({ [key]: JSON.stringify(deliveryEvent) });
    const { kv, store } = fakeConfigKv({ usage_telemetry_outbox_count: '1' });
    const env = {
      CONFIG_KV: kv,
      RAW_FILES: fallback.bucket,
      USAGE_TELEMETRY_FALLBACK_MAX_OBJECTS: '5',
    } as unknown as Env;

    expect(await persistUsageTelemetryFallback(env, deliveryEvent)).toBe(true);
    expect(fallback.put).toHaveBeenCalledOnce();
    expect(store.get('usage_telemetry_outbox_count')).toBe('1');
  });

  it('seeds the counter from a bounded paginated count spanning R2 list pages when the KV counter is missing', async () => {
    // R2 list pages at ~1000 objects, so a single list cannot establish the count
    // against a multi-thousand cap (the old list-based check could never enforce
    // it). Prove the seed count pages across the boundary and enforces the cap.
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ key: `_ops/usage-telemetry/p1-${i}.json` }));
    const page2 = Array.from({ length: 10 }, (_, i) => ({ key: `_ops/usage-telemetry/p2-${i}.json` }));
    const list = vi.fn(async (opts: { cursor?: string }) => (
      opts.cursor
        ? { objects: page2, truncated: false }
        : { objects: page1, truncated: true, cursor: 'next' }
    ));
    const put = vi.fn();
    const { kv, store } = fakeConfigKv(); // counter absent -> seed via paginated count
    const env = {
      CONFIG_KV: kv,
      RAW_FILES: { list, put },
      USAGE_TELEMETRY_FALLBACK_MAX_OBJECTS: '1005',
    } as unknown as Env;

    const accepted = await persistUsageTelemetryFallback(env, deliveryEvent, { silentFailure: true });

    expect(accepted).toBe(false); // 1010 >= 1005 — a single 1000-object page would have missed this
    expect(list).toHaveBeenCalledTimes(2);
    expect(put).not.toHaveBeenCalled();
    expect(store.get('usage_telemetry_outbox_count')).toBe('1010'); // seeded for O(1) future reads
  });

  it('accepts actual measured cost while dropping unapproved metadata fields', async () => {
    const messages: QueueMessage[] = [];
    await recordMeasuredThirdPartyUsage(fakeEnv(messages), {
      provider: 'openai',
      service: 'llm',
      operation: 'benchmark-cost',
      idempotencyKey: 'CT Batch Run 123 Cost',
      occurredAt: '2026-07-13T12:00:00.000Z',
      model: 'gpt-4o',
      metricType: 'cost',
      costUsd: 0.0123,
      billingMode: 'actual',
      confidence: 'actual',
      metadata: {
        costSource: 'usage-priced',
        benchmarkRunId: 'run-123',
        cacheWriteTokens: 31,
        cacheWriteOneHourTokens: 17,
        serviceTier: 'priority',
        toolName: 'attachment_search',
        attachmentSearchCalls: 2,
        costInUsdTicks: 321_000_000,
        requestUrl: 'https://never.example/secret',
      },
    });
    const message = messages[0];
    if (message.type !== 'usage.telemetry') throw new Error('unexpected message');
    expect(message.event.eventId).toBe('ct-batch-run-123-cost');
    expect(message.event.costUsd).toBe(0.0123);
    expect(message.event.metadata).toMatchObject({
      model: 'gpt-4o',
      costSource: 'usage-priced',
      benchmarkRunId: 'run-123',
      cacheWriteTokens: 31,
      cacheWriteOneHourTokens: 17,
      serviceTier: 'priority',
      toolName: 'attachment_search',
      attachmentSearchCalls: 2,
      costInUsdTicks: 321_000_000,
    });
    expect(JSON.stringify(message)).not.toContain('never.example');
  });

  it('preserves OpenRouter transport metadata and versions stable remapped keys', async () => {
    const messages: QueueMessage[] = [];
    await recordMeasuredThirdPartyUsage(fakeEnv(messages), {
      provider: 'openrouter',
      service: 'llm',
      operation: 'benchmark-cost',
      idempotencyKey: 'ct-openrouter-run-123-cost',
      occurredAt: '2026-07-18T12:00:00.000Z',
      model: 'openai/gpt-5.6-terra',
      metricType: 'cost',
      costUsd: 0.0123,
      billingMode: 'actual',
      confidence: 'actual',
    });
    const message = messages[0];
    if (message.type !== 'usage.telemetry') throw new Error('unexpected message');
    expect(message.event).toMatchObject({
      eventId: 'ct-openrouter-run-123-cost-transport-v2',
      provider: 'openai',
      metadata: { model: 'gpt-5.6-terra', transport: 'openrouter' },
    });
  });

  it('carries providerRequestId onto the queued event for monitor-side spend verification', async () => {
    const messages: QueueMessage[] = [];
    await recordMeasuredThirdPartyUsage(fakeEnv(messages), {
      provider: 'openrouter',
      service: 'llm',
      operation: 'production-provider-cost',
      idempotencyKey: 'ct-openrouter-doc-1-cost',
      occurredAt: '2026-07-18T12:00:00.000Z',
      model: 'openai/gpt-5.6-terra',
      metricType: 'cost',
      costUsd: 0.0123,
      billingMode: 'actual',
      confidence: 'actual',
      providerRequestId: 'gen-abc123',
    });
    const message = messages[0];
    if (message.type !== 'usage.telemetry') throw new Error('unexpected message');
    expect(() => UsageTelemetryV2EventSchema.parse(message.event)).not.toThrow();
    expect(message.event.providerRequestId).toBe('gen-abc123');
    // providerRequestId is never part of the idempotency-key basis: the key is
    // exactly the caller's key plus the PRE-EXISTING transport-v2 remap
    // versioning (see measuredUsageKey), with no id-derived component.
    expect(message.event.eventId).toBe('ct-openrouter-doc-1-cost-transport-v2');
  });

  it('omits providerRequestId from the queued event when the caller did not supply one', async () => {
    const messages: QueueMessage[] = [];
    await recordMeasuredThirdPartyUsage(fakeEnv(messages), {
      provider: 'gemini',
      service: 'llm',
      operation: 'production-tokens',
      idempotencyKey: 'ct-gemini-doc-2-tokens',
      occurredAt: '2026-07-18T12:00:00.000Z',
      model: 'gemini-3.5-flash',
      metricType: 'usage',
      quantity: 500,
      unit: 'token',
      billingMode: 'actual',
      confidence: 'actual',
    });
    const message = messages[0];
    if (message.type !== 'usage.telemetry') throw new Error('unexpected message');
    expect(() => UsageTelemetryV2EventSchema.parse(message.event)).not.toThrow();
    expect(message.event.providerRequestId).toBeUndefined();
    expect(JSON.stringify(message.event)).not.toContain('providerRequestId');
  });

  it('treats a blank or whitespace-only providerRequestId as absent rather than pushing an empty string', async () => {
    const messages: QueueMessage[] = [];
    await recordMeasuredThirdPartyUsage(fakeEnv(messages), {
      provider: 'openrouter',
      service: 'llm',
      operation: 'production-provider-cost',
      idempotencyKey: 'ct-openrouter-doc-3-cost',
      occurredAt: '2026-07-18T12:00:00.000Z',
      model: 'openai/gpt-5.6-terra',
      metricType: 'cost',
      costUsd: 0.01,
      billingMode: 'actual',
      confidence: 'actual',
      providerRequestId: '   ',
    });
    const message = messages[0];
    if (message.type !== 'usage.telemetry') throw new Error('unexpected message');
    // The shared schema's providerRequestId is `.min(1)` when present — an
    // empty/blank string would fail UsageTelemetryV2EventSchema.parse() inside
    // the delivery client, so this MUST collapse to omitted, not "".
    expect(() => UsageTelemetryV2EventSchema.parse(message.event)).not.toThrow();
    expect(message.event.providerRequestId).toBeUndefined();
  });

  it('clamps a pathologically long providerRequestId instead of letting it break schema-validated delivery', async () => {
    const messages: QueueMessage[] = [];
    const overlong = 'gen-'.padEnd(250, 'x');
    await recordMeasuredThirdPartyUsage(fakeEnv(messages), {
      provider: 'openrouter',
      service: 'llm',
      operation: 'production-provider-cost',
      idempotencyKey: 'ct-openrouter-doc-4-cost',
      occurredAt: '2026-07-18T12:00:00.000Z',
      model: 'openai/gpt-5.6-terra',
      metricType: 'cost',
      costUsd: 0.01,
      billingMode: 'actual',
      confidence: 'actual',
      providerRequestId: overlong,
    });
    const message = messages[0];
    if (message.type !== 'usage.telemetry') throw new Error('unexpected message');
    expect(() => UsageTelemetryV2EventSchema.parse(message.event)).not.toThrow();
    expect(message.event.providerRequestId).toHaveLength(200);
    expect(message.event.providerRequestId).toBe(overlong.slice(0, 200));
  });

  it('requires a valid occurrence timestamp at runtime for every explicit stable key', async () => {
    const messages: QueueMessage[] = [];
    const env = fakeEnv(messages);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const base = {
      provider: 'xai',
      service: 'llm',
      operation: 'benchmark-provider-cost',
      idempotencyKey: 'ct-sync-xai-response-123-cost',
      metricType: 'cost',
      quantity: 0,
      unit: 'usd',
      costUsd: 0,
    };

    await expect(recordMeasuredThirdPartyUsage(
      env,
      base as unknown as MeasuredThirdPartyUsage,
    )).resolves.toBe(false);
    await expect(recordMeasuredThirdPartyUsage(
      env,
      { ...base, occurredAt: 'not-a-timestamp' } as unknown as MeasuredThirdPartyUsage,
    )).resolves.toBe(false);
    expect(messages).toEqual([]);
    expect(diagnostic).toHaveBeenNthCalledWith(1, 'usage telemetry event rejected', {
      errorType: 'missingOccurredAt',
    });
    expect(diagnostic).toHaveBeenNthCalledWith(2, 'usage telemetry event rejected', {
      errorType: 'invalidOccurredAt',
    });
    const serializedDiagnostic = JSON.stringify(diagnostic.mock.calls);
    expect(serializedDiagnostic).not.toContain('ct-sync-xai-response-123-cost');
    expect(serializedDiagnostic).not.toContain('not-a-timestamp');
    diagnostic.mockRestore();
  });

  it('reconstructs byte-identical stable-key events for every measured dimension across time', async () => {
    const messages: QueueMessage[] = [];
    const env = fakeEnv(messages);
    const occurrence = '2026-07-13T12:00:00.123Z';
    const dimensions: Array<{
      suffix: string;
      service: string;
      metricType: 'usage' | 'cost';
      quantity: number;
      unit: 'token' | 'page' | 'call' | 'usd';
      costUsd?: number;
    }> = [
      { suffix: 'cost', service: 'llm', metricType: 'cost', quantity: 0, unit: 'usd', costUsd: 0 },
      { suffix: 'tokens', service: 'llm', metricType: 'usage', quantity: 950, unit: 'token' },
      { suffix: 'pages', service: 'ocr', metricType: 'usage', quantity: 3, unit: 'page' },
      { suffix: 'attachment-search', service: 'llm', metricType: 'usage', quantity: 2, unit: 'call' },
    ];
    const emit = async () => {
      for (const dimension of dimensions) {
        await recordMeasuredThirdPartyUsage(env, {
          provider: 'xai',
          service: dimension.service,
          operation: `benchmark-${dimension.suffix}`,
          idempotencyKey: await stableMeasuredUsageIdempotencyKey(
            'provider-result', dimension.suffix, 'xai', 'response-123',
          ),
          occurredAt: occurrence,
          model: 'grok-4.3',
          metricType: dimension.metricType,
          quantity: dimension.quantity,
          unit: dimension.unit,
          ...(dimension.costUsd == null ? {} : { costUsd: dimension.costUsd }),
          billingMode: 'actual',
          confidence: 'actual',
        });
      }
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T13:00:00.000Z'));
    await emit();
    vi.setSystemTime(new Date('2026-07-14T01:00:00.000Z'));
    await emit();

    expect(messages).toHaveLength(dimensions.length * 2);
    for (const [index, dimension] of dimensions.entries()) {
      expect(JSON.stringify(messages[index])).toBe(JSON.stringify(messages[index + dimensions.length]));
      const message = messages[index];
      if (message.type !== 'usage.telemetry') throw new Error('unexpected message');
      const expectedKey = await stableMeasuredUsageIdempotencyKey(
        'provider-result', dimension.suffix, 'xai', 'response-123',
      );
      expect(message.event).toMatchObject({
        eventId: expectedKey,
        occurredAt: occurrence,
        quantity: dimension.quantity,
        ...(dimension.costUsd == null ? {} : { costUsd: dimension.costUsd }),
      });
    }
  });
});

function workerTypeScriptFiles(root: URL): URL[] {
  const files: URL[] = [];
  for (const entry of readdirSync(root as any, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), root);
    if (entry.isDirectory()) files.push(...workerTypeScriptFiles(url));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(url);
  }
  return files;
}

function operatorJavaScriptFiles(root: URL): URL[] {
  const files: URL[] = [];
  for (const entry of readdirSync(root as any, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), root);
    if (entry.isDirectory()) files.push(...operatorJavaScriptFiles(url));
    else if (entry.name.endsWith('.mjs')) files.push(url);
  }
  return files;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function fetchMemberName(expression: ts.Expression): string | undefined {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (
    ts.isElementAccessExpression(current)
    && current.argumentExpression
    && (ts.isStringLiteral(current.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(current.argumentExpression))
  ) {
    return current.argumentExpression.text;
  }
  return undefined;
}

function isRawFetchReference(expression: ts.Expression, aliases: Set<string>): boolean {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    return current.text === 'fetch' || current.text === 'fetchImpl' || aliases.has(current.text);
  }
  const memberName = fetchMemberName(current);
  if (memberName === 'fetch' || memberName === 'fetchImpl') return true;
  if (
    ts.isBinaryExpression(current)
    && (current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || current.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return isRawFetchReference(current.left, aliases) || isRawFetchReference(current.right, aliases);
  }
  if (ts.isConditionalExpression(current)) {
    return isRawFetchReference(current.whenTrue, aliases) || isRawFetchReference(current.whenFalse, aliases);
  }
  if (
    ts.isCallExpression(current)
    && ts.isPropertyAccessExpression(current.expression)
    && current.expression.name.text === 'bind'
  ) {
    return isRawFetchReference(current.expression.expression, aliases);
  }
  return false;
}

function isRawFetchCallee(expression: ts.Expression, aliases: Set<string>): boolean {
  const current = unwrapExpression(expression);
  if (isRawFetchReference(current, aliases)) return true;
  return ts.isPropertyAccessExpression(current)
    && (current.name.text === 'call' || current.name.text === 'apply')
    && isRawFetchReference(current.expression, aliases);
}

function rawFetchAliases(ast: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  const candidates: Array<{ name: string; initializer: ts.Expression }> = [];
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        candidates.push({ name: node.name.text, initializer: node.initializer });
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const property = element.propertyName ?? element.name;
          if (
            ts.isIdentifier(element.name)
            && ((ts.isIdentifier(property) && property.text === 'fetch')
              || (ts.isStringLiteral(property) && property.text === 'fetch'))
          ) {
            aliases.add(element.name.text);
          }
        }
      }
    }
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)
    ) {
      candidates.push({ name: node.left.text, initializer: node.right });
    }
    ts.forEachChild(node, collect);
  };
  collect(ast);

  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      if (!aliases.has(candidate.name) && isRawFetchReference(candidate.initializer, aliases)) {
        aliases.add(candidate.name);
        changed = true;
      }
    }
  }
  return aliases;
}

function rawFetchViolations(relative: string, source: string): string[] {
  const ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const aliases = rawFetchAliases(ast);
  const violations: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isRawFetchCallee(node.expression, aliases)) {
      const callee = unwrapExpression(node.expression);
      const isTelemetryPrimitive =
        relative === 'shared/thirdPartyTelemetry.ts'
        && ts.isIdentifier(callee)
        && callee.text === 'fetchImpl';
      const isOperatorTelemetryPrimitive =
        relative === 'scripts/usage-telemetry.mjs'
        && ts.isIdentifier(callee)
        && callee.text === 'fetchImpl';
      // Agentless Datadog intake is unmetered on purpose: routing it through
      // trackedFetch would recurse if a later meter classified Datadog hosts.
      const isDatadogIntakePrimitive =
        relative === 'shared/datadogTransport.ts'
        && ts.isIdentifier(callee)
        && callee.text === 'fetchImpl';
      const isInternalHonoDispatch =
        relative === 'index.ts'
        && ts.isPropertyAccessExpression(callee)
        && ts.isIdentifier(callee.expression)
        && callee.expression.text === 'app'
        && callee.name.text === 'fetch';
      if (
        !isTelemetryPrimitive
        && !isOperatorTelemetryPrimitive
        && !isDatadogIntakePrimitive
        && !isInternalHonoDispatch
      ) {
        const pos = ast.getLineAndCharacterOfPosition(node.getStart(ast));
        violations.push(`${relative}:${pos.line + 1}:${callee.getText(ast)}`);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(ast);
  return violations;
}

describe('outbound-call inventory enforcement', () => {
  it('routes every deployed Worker and operator third-party fetch through a tracked transport', () => {
    const srcRoot = new URL('../../', testModuleUrl);
    const scriptsRoot = new URL('../../../scripts/', testModuleUrl);
    const violations: string[] = [];
    for (const file of workerTypeScriptFiles(srcRoot)) {
      const relative = decodeURIComponent(file.pathname.slice(srcRoot.pathname.length));
      // These are browser-side, same-origin API calls embedded in the dashboard.
      if (relative === 'ui/dashboardHtml.ts') continue;
      // This is an internal read-back to the monitor itself, not a billable third-party provider call.
      if (relative === 'shared/monitorBudgetGate.ts') continue;
      // Deno shims call worker.fetch which is not a third-party outbound call
      if (relative.startsWith('deno/')) continue;
      const source = readFileSync(file as any, 'utf8') as string;
      violations.push(...rawFetchViolations(relative, source));
    }
    for (const file of operatorJavaScriptFiles(scriptsRoot)) {
      const scriptRelative = decodeURIComponent(file.pathname.slice(scriptsRoot.pathname.length));
      // This operator script calls congress.trade's own admin route. The model
      // provider request it triggers happens inside the instrumented Worker.
      if (scriptRelative === 'retry-llamaparse-failed.mjs') continue;
      if (scriptRelative.endsWith('.mjs')) continue;
      const source = readFileSync(file as any, 'utf8') as string;
      violations.push(...rawFetchViolations(`scripts/${scriptRelative}`, source));
    }
    expect(violations).toEqual([]);
  }, 60_000);

  it('detects aliased, bound, destructured, and member fetch calls in server code', () => {
    const source = [
      'const alias = fetch;',
      'alias("https://example.test/alias");',
      'const bound = globalThis.fetch.bind(globalThis);',
      'bound("https://example.test/bound");',
      'const { fetch: destructured } = globalThis;',
      'destructured("https://example.test/destructured");',
      'client.fetch("https://example.test/member");',
      'globalThis.fetch.call(globalThis, "https://example.test/call");',
    ].join('\n');

    expect(rawFetchViolations('fixture.ts', source)).toEqual([
      'fixture.ts:2:alias',
      'fixture.ts:4:bound',
      'fixture.ts:6:destructured',
      'fixture.ts:7:client.fetch',
      'fixture.ts:8:globalThis.fetch.call',
    ]);
  });

  it('keeps browser dashboard source and the tracked transport boundary explicitly scoped out', () => {
    expect(rawFetchViolations('ui/dashboardHtml.ts', 'fetch("/api/health")')).toEqual([
      'ui/dashboardHtml.ts:1:fetch',
    ]);
    expect(rawFetchViolations(
      'shared/thirdPartyTelemetry.ts',
      'async function transport(fetchImpl: typeof fetch) { return fetchImpl("https://example.test"); }',
    )).toEqual([]);
    expect(rawFetchViolations(
      'shared/datadogTransport.ts',
      'async function transport(fetchImpl: typeof fetch) { return fetchImpl("https://example.test"); }',
    )).toEqual([]);
  });

  it('keeps the Usage Monitor ingest transport centralized and non-recursive', () => {
    const srcRoot = new URL('../../', testModuleUrl);
    const scriptsRoot = new URL('../../../scripts/', testModuleUrl);
    const owners: string[] = [];
    for (const file of workerTypeScriptFiles(srcRoot)) {
      const relative = decodeURIComponent(file.pathname.slice(srcRoot.pathname.length));
      if (readFileSync(file as any, 'utf8').includes('createUsageTelemetryClient')) owners.push(relative);
    }
    for (const file of operatorJavaScriptFiles(scriptsRoot)) {
      const relative = `scripts/${decodeURIComponent(file.pathname.slice(scriptsRoot.pathname.length))}`;
      if (readFileSync(file as any, 'utf8').includes('createUsageTelemetryClient')) owners.push(relative);
    }
    expect(owners.sort()).toEqual([
      'scripts/usage-telemetry.mjs',
      'shared/thirdPartyTelemetry.ts',
    ]);
  });
});
