import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ST_PEER_ENRICHMENT_STALL_HOURS,
  readPipelineStallHours,
  sweepPipelineStallAlerts,
} from '../pipelineLoudAlerts.ts';
import {
  openMigratedD1,
  openMigratedD1Before0104,
  type SqliteDatabase,
} from '../../prices/__tests__/sqliteD1.ts';
import { resetSecuritiesRefEnrichmentSchemaCacheForTests } from '../../enrichment/service.ts';
import type { Env } from '../../shared/types.ts';

vi.mock('../reviewQueueNotify.ts', () => ({
  notifyReviewQueuePublisher: vi.fn(async () => {}),
  notifyPipelineStallPublisher: vi.fn(async () => {}),
}));

vi.mock('../../deno/sentry.ts', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('../ogeSource.ts', () => ({
  ogeWatchEnabled: vi.fn(async () => false),
}));

vi.mock('../../enrichment/service.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../enrichment/service.ts')>();
  return {
    ...actual,
    hasConfiguredKeyedEnrichmentProvider: vi.fn(async () => true),
  };
});

vi.mock('../../secrets/infisical.ts', () => ({
  resolveSecrets: vi.fn(async () => ({})),
}));

vi.mock('../../delivery/targetCircuit.ts', () => ({
  targetKeyForUrl: vi.fn(() => null),
  checkTargetCircuit: vi.fn(async () => ({ allowed: true, probe: false })),
}));

vi.mock('../../shared/pipelineHealth.ts', () => ({
  checkPipelineHealth: vi.fn(async () => ({ status: 'ok', checks: [] })),
}));

let db: SqliteDatabase;
let d1: D1Database;
let close: () => void;

beforeEach(async () => {
  const opened = await openMigratedD1();
  db = opened.db;
  d1 = opened.d1;
  close = opened.close;
});
afterEach(() => close());

function seedTrade(ticker: string): void {
  db.prepare(
    `INSERT INTO transactions (id, ticker, tx_date, source, created_at)
     VALUES (?, ?, '2026-01-05', 'primary', '2026-01-05T00:00:00Z')`,
  ).run(`tx-${ticker}`, ticker);
}

function envWithDb(): Env {
  return { DB: d1, CONFIG_KV: createKv() } as Env;
}

function createKv() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => {
      const raw = store.get(key);
      return raw ? JSON.parse(raw) : null;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

describe('st_peer_enrichment stall detector', () => {
  it('readPipelineStallHours defaults st_peer_enrichment to 30h', () => {
    expect(readPipelineStallHours({} as Env, 'st_peer_enrichment')).toBe(
      DEFAULT_ST_PEER_ENRICHMENT_STALL_HOURS,
    );
    expect(readPipelineStallHours({} as Env, 'senate_fetch_success')).toBe(6);
  });

  it('ignores global socratic enriched_at when pending tickers were checked recently', async () => {
    seedTrade('FRESH');
    seedTrade('STUCK');
    const recent = '2026-10-12T12:00:00.000Z';
    const old = '2026-10-01T00:00:00.000Z';
    db.prepare(
      `INSERT INTO securities_ref (ticker, enriched_at, enrichment_checked_at, source)
       VALUES ('FRESH', NULL, ?, 'socratic'),
              ('STUCK', NULL, ?, 'socratic'),
              ('DONE', ?, ?, 'socratic')`,
    ).run(recent, recent, old, old);

    const now = new Date('2026-10-12T18:00:00.000Z');
    const result = await sweepPipelineStallAlerts(envWithDb(), now);
    expect(result.evaluated).toContain('st_peer_enrichment');
    expect(result.alerted).not.toContain('st_peer_enrichment');
  });

  it('alerts with pending ticker sample when pending set is idle beyond threshold', async () => {
    const { captureMessage } = await import('../../deno/sentry.ts');
    seedTrade('JUNK1');
    seedTrade('JUNK2');
    const stale = '2026-10-01T00:00:00.000Z';
    db.prepare(
      `INSERT INTO securities_ref (ticker, enrichment_checked_at, source)
       VALUES ('JUNK1', ?, 'socratic'),
              ('JUNK2', ?, 'socratic')`,
    ).run(stale, stale);

    const now = new Date('2026-10-12T18:00:00.000Z');
    const result = await sweepPipelineStallAlerts(envWithDb(), now);
    expect(result.alerted).toContain('st_peer_enrichment');
    const msg = (captureMessage as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes('st_peer_enrichment'),
    );
    expect(msg?.[0]).toContain('JUNK1');
    expect(msg?.[0]).toContain('JUNK2');
    expect(msg?.[0]).toContain('pending sample');
  });

  it('does not stall when pending tickers were never enrichment-checked', async () => {
    seedTrade('NEW1');
    seedTrade('NEW2');
    db.prepare(
      `INSERT INTO securities_ref (ticker, source) VALUES ('NEW1', 'socratic'), ('NEW2', 'socratic')`,
    ).run();

    const now = new Date('2026-10-12T18:00:00.000Z');
    const result = await sweepPipelineStallAlerts(envWithDb(), now);
    expect(result.evaluated).toContain('st_peer_enrichment');
    expect(result.alerted).not.toContain('st_peer_enrichment');
  });

  it('does not count COMPETITOR-* fixture-only tickers as pending', async () => {
    seedTrade('GNKOQ');
    db.prepare(
      `UPDATE transactions SET doc_id = 'COMPETITOR-synthetic-gnkoq', source = 'competitor_backfill' WHERE ticker = 'GNKOQ'`,
    ).run();
    db.prepare(
      `INSERT INTO securities_ref (ticker, enrichment_checked_at, source)
       VALUES ('GNKOQ', datetime('now', '-40 days'), 'socratic')`,
    ).run();

    const now = new Date('2026-10-12T18:00:00.000Z');
    const result = await sweepPipelineStallAlerts(envWithDb(), now);
    expect(result.evaluated).toContain('st_peer_enrichment');
    expect(result.alerted).not.toContain('st_peer_enrichment');
  });

  it('does not count enrichment_unavailable tickers as pending', async () => {
    seedTrade('GHOST');
    db.prepare(
      `INSERT INTO securities_ref (ticker, enrichment_unavailable, enrichment_checked_at, enrichment_unavailable_reason)
       VALUES ('GHOST', 1, datetime('now'), 'manual_junk')`,
    ).run();

    const now = new Date('2026-10-12T18:00:00.000Z');
    const result = await sweepPipelineStallAlerts(envWithDb(), now);
    expect(result.evaluated).toContain('st_peer_enrichment');
    expect(result.alerted).not.toContain('st_peer_enrichment');
  });
});

describe('st_peer_enrichment stall (pre-0104 schema)', () => {
  let preDb: SqliteDatabase;
  let preD1: D1Database;
  let preClose: () => void;

  beforeEach(async () => {
    resetSecuritiesRefEnrichmentSchemaCacheForTests();
    const opened = await openMigratedD1Before0104();
    preDb = opened.db;
    preD1 = opened.d1;
    preClose = opened.close;
  });
  afterEach(() => {
    preClose();
    resetSecuritiesRefEnrichmentSchemaCacheForTests();
  });

  it('evaluates stall SQL without enrichment_unavailable columns', async () => {
    preDb.prepare(
      `INSERT INTO transactions (id, ticker, tx_date, source, created_at)
       VALUES ('tx-old', 'OLDSCHEMA', '2026-01-05', 'primary', '2026-01-05T00:00:00Z')`,
    ).run();
    preDb.prepare(`INSERT INTO securities_ref (ticker, source) VALUES ('OLDSCHEMA', 'socratic')`).run();
    const env = { DB: preD1, CONFIG_KV: createKv() } as Env;
    const now = new Date('2026-10-12T18:00:00.000Z');
    const result = await sweepPipelineStallAlerts(env, now);
    expect(result.evaluated).toContain('st_peer_enrichment');
    expect(result.alerted).not.toContain('st_peer_enrichment');
  });
});
