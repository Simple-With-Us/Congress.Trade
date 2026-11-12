import { describe, expect, it } from 'vitest';
import { checkReadiness } from '../readiness.ts';

function dbMissing(fragment?: string): D1Database {
  return { prepare(sql: string) { return {
    bind() { return this; },
    async first<T>() { if (fragment && sql.includes(fragment)) throw new Error('missing'); return ({ ok: 1 } as T); },
  }; } } as unknown as D1Database;
}

describe('checkReadiness', () => {
  it('reports current schema ready', async () => {
    expect(await checkReadiness(dbMissing())).toEqual({ ok: true, db: true, schema: true, missing: [] });
  });

  it('reports a missing required table without leaking the database error', async () => {
    const result = await checkReadiness(dbMissing('delivery_outbox'));
    expect(result).toEqual({
      ok: false,
      db: true,
      schema: false,
      missing: ['delivery_outbox', 'idx_delivery_outbox_ready'],
    });
  });

  it('requires independent dead-letter cycle accounting on both outboxes', async () => {
    const result = await checkReadiness(dbMissing('dead_letter_cycles'));
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['delivery_outbox', 'ingestion_outbox']);
  });

  it('requires the materialized transaction estimate and ordered Stripe state', async () => {
    expect((await checkReadiness(dbMissing('est_value'))).missing).toEqual(['transactions']);
    expect((await checkReadiness(dbMissing('FROM stripe_webhook_events'))).missing).toEqual([
      'stripe_webhook_events',
    ]);
    expect((await checkReadiness(dbMissing('last_event_priority'))).missing).toEqual([
      'stripe_subscription_event_state',
    ]);
  });

  it('requires durable benchmark history tables and indexes', async () => {
    expect((await checkReadiness(dbMissing('FROM benchmark_model_results'))).missing).toEqual([
      'benchmark_model_results',
    ]);

    const db = { prepare(sql: string) { return {
      bind() { return this; },
      async first<T>() {
        if (sql.includes("name = 'idx_benchmark_results_run_model'")) return null as T | null;
        return ({ name: 'present' } as T);
      },
    }; } } as unknown as D1Database;
    expect((await checkReadiness(db)).missing).toEqual(['idx_benchmark_results_run_model']);
  });

  it('probes benchmark request profiles and paid-cell lease columns used at runtime', async () => {
    const queries: string[] = [];
    const db = { prepare(sql: string) {
      queries.push(sql);
      return {
        bind() { return this; },
        async first<T>() { return ({ ok: 1 } as T); },
      };
    } } as unknown as D1Database;

    expect((await checkReadiness(db)).ok).toBe(true);
    expect(queries.find((sql) => sql.includes('FROM benchmark_runs'))).toContain('request_profile_json');
    const resultProbe = queries.find((sql) => sql.includes('FROM benchmark_model_results'));
    expect(resultProbe).toContain('claim_token');
    expect(resultProbe).toContain('lease_until');
  });

  it('requires the atomic benchmark daily call reservation ledger', async () => {
    expect((await checkReadiness(dbMissing('FROM benchmark_daily_call_usage'))).missing).toEqual([
      'benchmark_daily_call_usage',
    ]);
  });

  it('requires the chamber-scoped benchmark settings mutation lease', async () => {
    expect((await checkReadiness(dbMissing('FROM benchmark_settings_leases'))).missing).toEqual([
      'benchmark_settings_leases',
    ]);
  });

  it('requires the singleton usage-telemetry half-open probe lease', async () => {
    expect((await checkReadiness(dbMissing('FROM usage_telemetry_probe_lease'))).missing).toEqual([
      'usage_telemetry_probe_lease',
    ]);
  });

  it('reports a missing quota trigger even when all columns exist', async () => {
    const db = { prepare(sql: string) { return {
      bind() { return this; },
      async first<T>() {
        if (sql.includes("name = 'trg_sse_client_connection_quota'")) return null as T | null;
        return ({ name: 'present' } as T);
      },
    }; } } as unknown as D1Database;
    const result = await checkReadiness(db);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['trg_sse_client_connection_quota']);
  });

  it('requires the unique delivery idempotency index to exist', async () => {
    const db = { prepare(sql: string) { return {
      bind() { return this; },
      async first<T>() {
        if (sql.includes("name = 'idx_deliveries_subscription_tx'")) return null as T | null;
        return ({ name: 'present' } as T);
      },
    }; } } as unknown as D1Database;
    expect((await checkReadiness(db)).missing).toEqual(['idx_deliveries_subscription_tx']);
  });

  it('requires the live-row review publication index', async () => {
    const db = { prepare(sql: string) { return {
      bind() { return this; },
      async first<T>() {
        if (sql.includes("name = 'idx_transactions_live_doc_source_rowkey'")) return null as T | null;
        return ({ name: 'present' } as T);
      },
    }; } } as unknown as D1Database;
    expect((await checkReadiness(db)).missing).toEqual(['idx_transactions_live_doc_source_rowkey']);
  });

  it('requires the Stripe claim and event-order indexes', async () => {
    const db = { prepare(sql: string) { return {
      bind() { return this; },
      async first<T>() {
        if (sql.includes("name = 'idx_stripe_subscription_event_customer'")) return null as T | null;
        return ({ name: 'present' } as T);
      },
    }; } } as unknown as D1Database;
    expect((await checkReadiness(db)).missing).toEqual(['idx_stripe_subscription_event_customer']);
  });

  it('requires the outbox, lease, SSE, and source-attempt indexes', async () => {
    const db = { prepare(sql: string) { return {
      bind() { return this; },
      async first<T>() {
        if (sql.includes("name = 'idx_ingestion_outbox_ready'")) return null as T | null;
        return ({ name: 'present' } as T);
      },
    }; } } as unknown as D1Database;
    expect((await checkReadiness(db)).missing).toEqual(['idx_ingestion_outbox_ready']);
  });

  it('does not require idx_tx_twin_seek (0088 is migrate-only; Coolify auto-deploy does not run it)', async () => {
    expect(await checkReadiness(dbMissing('idx_tx_twin_seek'))).toEqual({
      ok: true,
      db: true,
      schema: true,
      missing: [],
    });
  });
});
