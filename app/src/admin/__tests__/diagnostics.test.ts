import { describe, it, expect } from 'vitest';
import { buildAdminRouter } from '../routes.ts';

const app = buildAdminRouter();

function fakeDb() {
  return {
    prepare(sql: string) {
      return {
        params: [] as unknown[],
        bind(...params: unknown[]) {
          this.params = params;
          return this;
        },
        async all<T>() {
          if (/FROM ingest_log/i.test(sql)) {
            return {
              results: [
                {
                  source: 'house',
                  last_used_at: '2026-06-24T12:00:00.000Z',
                  calls_total: 10,
                  calls_last_24h: 4,
                  calls_today: 2,
                },
              ] as T[],
            };
          }
          if (/FROM securities_ref/i.test(sql) && /CASE\s+WHEN lower\(source\)/i.test(sql)) {
            return {
              results: [
                {
                  provider: 'massive',
                  calls_total: 2,
                  calls_last_24h: 1,
                  calls_today: 1,
                  last_used_at: '2026-06-24T11:30:00.000Z',
                  errors_last_24h: 0,
                },
              ] as T[],
            };
          }
          if (/FROM securities_ref/i.test(sql) && /COUNT\(\*\) AS calls_total/i.test(sql)) {
            return {
              results: [
                {
                  calls_total: 5,
                  calls_last_24h: 2,
                  calls_today: 1,
                  last_used_at: '2026-06-24T11:00:00.000Z',
                  errors_last_24h: 1,
                },
              ] as T[],
            };
          }
          if (/FROM securities_ref/i.test(sql) && /enrichment_error/i.test(sql)) {
            return {
              results: [
                {
                  enriched_at: '2026-06-24T11:00:00.000Z',
                  ticker: 'AAPL',
                  enrichment_error: 'FMP_HTTP_429 rate limited',
                },
              ] as T[],
            };
          }
          // Price cache freshness now reads the maintained, indexed
          // securities_ref.latest_price_date instead of MAX(date) over price_eod.
          if (/FROM securities_ref/i.test(sql) && /latest_price_date/i.test(sql)) {
            return { results: [{ last_used_at: '2026-06-24' }] as T[] };
          }
          if (/FROM price_eod/i.test(sql)) {
            return {
              results: [
                {
                  calls_total: 7,
                  calls_last_24h: 20,
                  calls_today: 3,
                  last_used_at: '2026-06-24',
                },
              ] as T[],
            };
          }
          if (/FROM spx_eod/i.test(sql)) {
            return {
              results: [
                {
                  calls_total: 100,
                  calls_last_24h: 1,
                  calls_today: 1,
                  last_used_at: '2026-06-24',
                },
              ] as T[],
            };
          }
          if (/FROM tx_performance/i.test(sql)) {
            return {
              results: [
                {
                  calls_total: 50,
                  calls_last_24h: 10,
                  calls_today: 5,
                  last_used_at: '2026-06-24T12:30:00.000Z',
                },
              ] as T[],
            };
          }
          if (/FROM filings/i.test(sql) && /COUNT\(\*\)/i.test(sql)) {
            return {
              results: [
                {
                  calls_total: 3,
                  calls_last_24h: 1,
                  calls_today: 1,
                  last_used_at: '2026-06-24T10:00:00.000Z',
                  errors_last_24h: 1,
                },
              ] as T[],
            };
          }
          if (/latest_import_at/i.test(sql) && /fundamentals_eod/i.test(sql)) {
            const readsReceiveTime = /max\(received_at\)/i.test(sql) && !/updated_at/i.test(sql);
            return {
              results: [
                {
                  imported_refs: 3,
                  fundamentals_rows: 2,
                  analyst_rows: 1,
                  latest_import_at: readsReceiveTime ? '2026-10-05T04:00:00.000Z' : '2020-01-01T00:00:00.000Z',
                },
              ] as T[],
            };
          }
          if (/FROM deliveries/i.test(sql)) return { results: [] as T[] };
          if (/FROM review_queue/i.test(sql)) return { results: [] as T[] };
          if (/FROM client_commands/i.test(sql)) return { results: [] as T[] };
          return { results: [] as T[] };
        },
        async first<T>() {
          return null as T | null;
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
        sql,
      };
    },
  } as unknown as D1Database;
}

describe('admin diagnostics API', () => {
  it('reports connection status and recent app errors without exposing secret values', async () => {
    const res = await app.request(
      '/diagnostics',
      { headers: { Authorization: 'Bearer admin-secret' } },
      {
        ADMIN_TOKEN: 'admin-secret',
        GEMINI_API_KEY: 'gemini-secret',
        FMP_API_KEY: 'fmp-secret',
        MASSIVE_API_KEY: 'massive-secret',
        PRICE_PROVIDER: 'massive',
        DB: fakeDb(),
      } as never,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connections: Array<{
        id: string;
        status: string;
        configured: boolean;
        callsToday: number;
        callsTotal?: number;
        lastUsedAt?: string | null;
      }>;
      errors: Array<{ area: string; subject: string; message: string }>;
      usageTelemetry: { state: string; ingestUrlConfigured: boolean; ingestTokenConfigured: boolean };
    };

    expect(body.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'provider:gemini',
          status: 'error',
          configured: true,
          callsToday: 1,
        }),
        expect.objectContaining({ id: 'source:house', status: 'ok', callsToday: 2 }),
        expect.objectContaining({ id: 'provider:socratic', status: 'warn', configured: false }),
        expect.objectContaining({ id: 'provider:massive', status: 'warn', configured: false }),
        expect.objectContaining({ id: 'cache:prices', status: 'warn', configured: false, callsToday: 0 }),
        expect.objectContaining({ id: 'cache:spx', status: 'warn', configured: false, callsToday: 0 }),
        expect.objectContaining({ id: 'cache:performance', status: 'warn', configured: false, callsToday: 0 }),
        expect.objectContaining({ id: 'telemetry:usage-monitor', status: 'error', configured: false }),
        expect.objectContaining({
          id: 'delivery:apns',
          status: 'warn',
          configured: false,
          note: expect.stringContaining('APNs credentials are not available'),
        }),
        expect.objectContaining({
          id: 'app-b:receive',
          lastUsedAt: '2026-10-05T04:00:00.000Z',
          callsTotal: 6,
        }),
      ]),
    );
    expect(body.usageTelemetry).toMatchObject({
      state: 'missing',
      ingestUrlConfigured: false,
      ingestTokenConfigured: false,
    });
    expect(JSON.stringify(body)).not.toContain('gemini-secret');
    expect(JSON.stringify(body)).not.toContain('fmp-secret');
    expect(JSON.stringify(body)).not.toContain('massive-secret');
    expect(body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          area: 'Enrichment',
          subject: 'AAPL',
          message: 'FMP_HTTP_429 rate limited',
        }),
      ]),
    );
  });

  it('surfaces apns_fanout lane errors and a failed trade-query probe', async () => {
    const res = await app.request(
      '/diagnostics',
      { headers: { Authorization: 'Bearer admin-secret' } },
      {
        ADMIN_TOKEN: 'admin-secret',
        DB: {
          prepare(sql: string) {
            return {
              params: [] as unknown[],
              bind(...params: unknown[]) {
                this.params = params;
                return this;
              },
              async all<T>() {
                return { results: [] as T[] };
              },
              async first<T>() {
                if (/FROM delivery_outbox o/i.test(sql) && /LEFT JOIN filers f ON f\.bioguide_id/i.test(sql)) {
                  throw new Error('no such column: f.id');
                }
                if (/FROM push_devices/i.test(sql)) return { n: 1 } as T;
                return null as T | null;
              },
              async run() {
                return { success: true, meta: { changes: 0 } };
              },
              sql,
            };
          },
        },
        CONFIG_KV: {
          async get(key: string) {
            if (key === 'apns:fanout:last_error') {
              return JSON.stringify({
                message: 'no such column: f.id',
                at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
              });
            }
            return null;
          },
          async put() {
            return undefined;
          },
        },
      } as never,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connections: Array<{ id: string; status: string; errorsLast24h: number; note: string }>;
      errors: Array<{ area: string; subject: string; message: string }>;
    };
    expect(body.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'delivery:apns',
          status: 'error',
          errorsLast24h: 2,
          note: expect.stringContaining('trade query failed'),
        }),
      ]),
    );
    expect(body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          area: 'APNs Fan-out',
          subject: 'apns_fanout',
          message: 'no such column: f.id',
        }),
      ]),
    );
    expect(JSON.stringify(body)).not.toContain('BEGIN PRIVATE KEY');
  });

  it('does not count a stored APNs lane error older than 24h', async () => {
    const res = await app.request(
      '/diagnostics',
      { headers: { Authorization: 'Bearer admin-secret' } },
      {
        ADMIN_TOKEN: 'admin-secret',
        DB: {
          prepare(sql: string) {
            return {
              params: [] as unknown[],
              bind(...params: unknown[]) {
                this.params = params;
                return this;
              },
              async all<T>() {
                return { results: [] as T[] };
              },
              async first<T>() {
                if (/FROM push_devices/i.test(sql)) return { n: 1 } as T;
                return null as T | null;
              },
              async run() {
                return { success: true, meta: { changes: 0 } };
              },
              sql,
            };
          },
        },
        CONFIG_KV: {
          async get(key: string) {
            if (key === 'apns:fanout:last_error') {
              return JSON.stringify({
                message: 'stale join error',
                at: new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString(),
              });
            }
            return null;
          },
          async put() {
            return undefined;
          },
        },
      } as never,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connections: Array<{ id: string; status: string; errorsLast24h: number; note: string }>;
      errors: Array<{ area: string; subject: string; message: string }>;
    };
    const card = body.connections.find((c) => c.id === 'delivery:apns');
    expect(card).toMatchObject({
      id: 'delivery:apns',
      errorsLast24h: 0,
    });
    expect(card?.status).not.toBe('error');
    expect(card?.note).toContain('older than 24h');
    expect(body.errors.filter((e) => e.subject === 'apns_fanout' && e.message === 'stale join error')).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('BEGIN PRIVATE KEY');
  });

  it('blocks Infisical secret mutation in preview before resolving credentials', async () => {
    const res = await app.request(
      '/diagnostics/secrets/update',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ source: 'app', key: 'FMP_API_KEY', value: 'must-not-write' }),
      },
      {
        ADMIN_TOKEN: 'admin-secret',
        PREVIEW_DEPLOYMENT: 'true',
        DB: fakeDb(),
      } as never,
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      code: 'preview_write_protected',
    });
  });

  it('reports configured Usage Monitor durability without exposing config values or inventing delivery receipts', async () => {
    const res = await app.request(
      '/diagnostics',
      { headers: { Authorization: 'Bearer admin-secret' } },
      {
        ADMIN_TOKEN: 'admin-secret',
        USAGE_MONITOR_ENABLED: 'true',
        USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/private-ingest',
        USAGE_MONITOR_INGEST_TOKEN: 'usage-monitor-secret-token',
        USAGE_MONITOR_ENVIRONMENT: 'production',
        INGEST_QUEUE: { send: async () => undefined },
        RAW_FILES: {
          list: async () => ({
            objects: [{ key: '_ops/usage-telemetry/a.json' }, { key: '_ops/usage-telemetry/b.json' }],
            truncated: false,
          }),
        },
        DB: fakeDb(),
      } as never,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      connections: Array<{ id: string; status: string; configured: boolean; note: string }>;
      usageTelemetry: Record<string, unknown>;
    };
    expect(body.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'telemetry:usage-monitor',
        status: 'warn',
        configured: true,
        note: expect.stringContaining('R2 fallback 2 pending'),
      }),
    ]));
    expect(body.usageTelemetry).toMatchObject({
      state: 'configured',
      enabled: true,
      ingestUrlConfigured: true,
      ingestTokenConfigured: true,
      environmentConfigured: true,
      queueConfigured: true,
      fallback: { available: true, pending: 2, truncated: false },
      receiverDeliveryObservability: 'not_persisted_locally',
    });
    expect(JSON.stringify(body)).not.toContain('usage-monitor-secret-token');
    expect(JSON.stringify(body)).not.toContain('private-ingest');
  });

  it('distinguishes an explicitly disabled Usage Monitor from missing configuration', async () => {
    const res = await app.request(
      '/diagnostics',
      { headers: { Authorization: 'Bearer admin-secret' } },
      {
        ADMIN_TOKEN: 'admin-secret',
        USAGE_MONITOR_ENABLED: 'false',
        DB: fakeDb(),
      } as never,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      usageTelemetry: { state: 'disabled', enabled: false },
      connections: expect.arrayContaining([
        expect.objectContaining({
          id: 'telemetry:usage-monitor',
          status: 'warn',
          configured: false,
          note: 'Explicitly disabled by USAGE_MONITOR_ENABLED',
        }),
      ]),
    });
  });
});

describe('admin diagnostics: provider-only stub markers', () => {
  it('leaves a sweep-closed truncated-payload stub marker out of filing errors', async () => {
    const { default: Database } = await import('libsql');
    const { d1Database } = await import('../../prices/__tests__/sqliteD1.ts');
    const { runMigrations } = await import('../migrations.ts');
    const { sweepProviderOnlyReviewStubs } = await import('../../ingestion/autonomySweeps.ts');

    const fileDb = new Database(':memory:');
    const d1 = d1Database(fileDb);
    try {
      await runMigrations(d1);
      const stub = 'provider-missing-quiver-house-quiver-3f9a61c0de';
      const marker = 'provider-only:quiver:quiver:3f9a61c0de';
      // Stub whose review payload was truncated to invalid JSON: the sweep keeps
      // the raw-key marker in filings.error.  It is newer than the real error.
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, ingest_status, filing_type, first_seen_at, source_url, error)
         VALUES (?, 'house', 'needs_review', 'P', '2026-08-25T00:00:00.000Z', NULL, ?)`,
      ).bind(stub, marker).run();
      await d1.prepare(
        `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved, review_revision)
         VALUES (?, 'provider_discovered_missing_official', ?, '2026-08-25T00:00:00.000Z', 0, 1)`,
      ).bind(stub, '{"reason":"provider_discovered_missing_official","prov').run();
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, ingest_status, filing_type, first_seen_at, error)
         VALUES ('H-2026-20049999', 'house', 'error', 'P', '2026-08-24T00:00:00.000Z', 'pdf fetch failed: HTTP 503')`,
      ).run();

      const env = { DB: d1 } as never;
      expect((await sweepProviderOnlyReviewStubs(env)).cleared).toBe(1);
      const swept = await d1.prepare('SELECT ingest_status, error FROM filings WHERE doc_id = ?')
        .bind(stub).first<{ ingest_status: string; error: string | null }>();
      // Raw-key preservation is intact: the marker is still stored.
      expect(swept?.ingest_status).toBe('verified_empty');
      expect(swept?.error).toBe(marker);

      const res = await app.request(
        '/diagnostics',
        { headers: { Authorization: 'Bearer admin-secret' } },
        { ADMIN_TOKEN: 'admin-secret', DB: d1 } as never,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { errors: Array<{ area: string; subject: string; message: string }> };
      const filingErrors = body.errors.filter((e) => e.area === 'Filing');
      expect(filingErrors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ subject: 'H-2026-20049999', message: 'pdf fetch failed: HTTP 503' }),
        ]),
      );
      expect(filingErrors.map((e) => e.subject)).not.toContain(stub);
      expect(JSON.stringify(body.errors)).not.toContain(marker);
    } finally {
      fileDb.close();
    }
  });
  it('keeps a duplicate-rejected stub out of filing errors after the official filing lands', async () => {
    const { default: Database } = await import('libsql');
    const { d1Database } = await import('../../prices/__tests__/sqliteD1.ts');
    const { runMigrations } = await import('../migrations.ts');
    const { sweepProviderOnlyReviewStubs } = await import('../../ingestion/autonomySweeps.ts');
    const { reconcileProviderMissingStubsWithOfficial } = await import('../../ingestion/providerMissingStubClose.ts');

    const fileDb = new Database(':memory:');
    const d1 = d1Database(fileDb);
    try {
      await runMigrations(d1);
      const rawKey = 'quiver:7b4d22e0f9';
      const stub = 'provider-missing-quiver-house-quiver-7b4d22e0f9';
      const marker = `provider-only:quiver:${rawKey}`;
      const official = 'H-2026-20048888';
      // Truncated review payload: the sweep keeps the raw-key marker.
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, ingest_status, filing_type, first_seen_at, source_url, error)
         VALUES (?, 'house', 'needs_review', 'P', '2026-08-25T00:00:00.000Z', NULL, ?)`,
      ).bind(stub, marker).run();
      await d1.prepare(
        `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved, review_revision)
         VALUES (?, 'provider_discovered_missing_official', ?, '2026-08-25T00:00:00.000Z', 0, 1)`,
      ).bind(stub, '{"reason":"provider_discovered_missing_official","prov').run();
      // Control: a stub in error status whose review row was never rejected as a
      // duplicate is a genuine error and must still show.
      const openErrStub = 'provider-missing-quiver-house-quiver-00ddee11ff';
      const openErrMarker = 'provider-only:quiver:quiver:00ddee11ff';
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, ingest_status, filing_type, first_seen_at, source_url, error)
         VALUES (?, 'house', 'error', 'P', '2026-08-25T06:00:00.000Z', NULL, ?)`,
      ).bind(openErrStub, openErrMarker).run();
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, ingest_status, filing_type, first_seen_at, error)
         VALUES ('H-2026-20049999', 'house', 'error', 'P', '2026-08-24T00:00:00.000Z', 'pdf fetch failed: HTTP 503')`,
      ).run();

      const env = {
        DB: d1,
        INGEST_QUEUE: { send: async () => undefined, sendBatch: async () => undefined },
      } as never;
      expect((await sweepProviderOnlyReviewStubs(env)).cleared).toBe(1);

      // The official filing lands later and matches only on the raw key.
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, ingest_status, filing_type, first_seen_at)
         VALUES (?, 'house', 'persisted', 'P', '2026-08-26T00:00:00.000Z')`,
      ).bind(official).run();
      await d1.prepare(
        `INSERT INTO trade_latency_candidates
           (trade_hash, doc_id, provider, chamber, congress_first_seen_at, provider_key, status, created_at, updated_at)
         VALUES (?, ?, 'quiver', 'house', '2026-08-26T00:00:00.000Z', ?, 'matched', '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')`,
      ).bind(`hash-${rawKey}`, official, rawKey).run();
      expect(await reconcileProviderMissingStubsWithOfficial(env, { now: new Date('2026-08-26T12:00:00.000Z') }))
        .toEqual({ scanned: 1, rejected: 1 });

      // The rejection flips the stub to error and keeps the marker (raw key intact).
      const rejected = await d1.prepare('SELECT ingest_status, error FROM filings WHERE doc_id = ?')
        .bind(stub).first<{ ingest_status: string; error: string | null }>();
      expect(rejected?.ingest_status).toBe('error');
      expect(rejected?.error).toBe(marker);
      const review = await d1.prepare('SELECT resolution_kind, resolution_reason FROM review_queue WHERE doc_id = ?')
        .bind(stub).first<{ resolution_kind: string; resolution_reason: string }>();
      expect(review?.resolution_kind).toBe('rejected');
      expect(review?.resolution_reason).toContain(official);

      const res = await app.request(
        '/diagnostics',
        { headers: { Authorization: 'Bearer admin-secret' } },
        { ADMIN_TOKEN: 'admin-secret', DB: d1 } as never,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { errors: Array<{ area: string; subject: string; message: string }> };
      const filingErrors = body.errors.filter((e) => e.area === 'Filing');
      expect(filingErrors.map((e) => e.subject)).not.toContain(stub);
      expect(JSON.stringify(body.errors)).not.toContain(marker);
      expect(filingErrors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ subject: 'H-2026-20049999', message: 'pdf fetch failed: HTTP 503' }),
          expect.objectContaining({ subject: openErrStub, message: openErrMarker }),
        ]),
      );
    } finally {
      fileDb.close();
    }
  });
});
