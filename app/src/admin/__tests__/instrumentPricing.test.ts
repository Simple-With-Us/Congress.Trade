import { describe, expect, it, vi } from 'vitest';
import { buildAdminRouter } from '../routes.ts';
import type { Env } from '../../shared/types.ts';

vi.mock('../../secrets/infisical', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../secrets/infisical')>()),
  resolveSecrets: vi.fn(async () => ({})),
}));

function adminEnv(overrides?: { sqlRows?: Array<Record<string, unknown>> }): Env {
  return {
    ADMIN_OPEN_IN_DEV: 'true',
    APP_B_IMPORT_URL: 'https://peer.example',
    APP_B_INGEST_TOKEN: 'test-token',
    CONFIG_KV: {
      async get() { return null; },
      async put() {},
      async delete() {},
    },
    DB: {
      prepare(sql: string) {
        return {
          bind() { return this; },
          async first() { return null; },
          async all() {
            if (/time_provenance/i.test(sql)) {
              return { results: overrides?.sqlRows ?? [{ time_provenance: 'observed', n: 4 }] };
            }
            return { results: [] };
          },
          async run() { return { success: true }; },
        };
      },
    } as unknown as D1Database,
  } as unknown as Env;
}

describe('GET /instrument-pricing', () => {
  it('returns the capability matrix, committee mapping version, and provenance counts', async () => {
    const env = adminEnv({ sqlRows: [{ time_provenance: 'observed', n: 12 }, { time_provenance: 'claimed', n: 3 }] });
    const response = await buildAdminRouter().request('http://localhost/instrument-pricing', {}, env);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      capabilities: Array<{ class: string; minutePricing: string; label: string }>;
      committeeIndustry: { version: string; ruleCount: number };
      snapshotProvenance: Array<{ timeProvenance: string; n: number }>;
    };
    const byClass = Object.fromEntries(body.capabilities.map((c) => [c.class, c]));
    expect(byClass.equities_long.minutePricing).toBe('minute');
    expect(byClass.event_contract.minutePricing).toBe('none');
    expect(byClass.event_contract.label).toMatch(/Kalshi/i);
    expect(byClass.option.minutePricing).toBe('none');
    expect(body.committeeIndustry.ruleCount).toBeGreaterThan(0);
    expect(body.committeeIndustry.version).toBe('committee-sector-v1');
    expect(body.snapshotProvenance).toEqual([
      { timeProvenance: 'observed', n: 12 },
      { timeProvenance: 'claimed', n: 3 },
    ]);
  });
});

describe('GET /instrument-pricing/at', () => {
  it('refuses an option lookup without calling the peer', async () => {
    const env = adminEnv();
    const response = await buildAdminRouter().request(
      'http://localhost/instrument-pricing/at?ticker=AAPL&at=2026-08-16T15:00:00.000Z&isOption=1',
      {},
      env,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; reason?: string; instrumentClass?: string };
    expect(body).toMatchObject({ ok: false, reason: 'unsupported_instrument', instrumentClass: 'option' });
  });

  it('refuses a Kalshi event-contract lookup', async () => {
    const env = adminEnv();
    const response = await buildAdminRouter().request(
      'http://localhost/instrument-pricing/at?ticker=FED&at=2026-08-16T15:00:00.000Z&assetName=Kalshi%20Fed%20decision',
      {},
      env,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; reason?: string; instrumentClass?: string };
    expect(body).toMatchObject({
      ok: false,
      reason: 'unsupported_instrument',
      instrumentClass: 'event_contract',
    });
  });
});
