import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PIPELINE_STALL_HOURS,
  readPipelineStallHours,
  sweepPipelineStallAlerts,
} from '../pipelineLoudAlerts.ts';
import { openMigratedD1, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
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

describe('st_peer_prices stall detector', () => {
  it('readPipelineStallHours defaults st_peer_prices to the general 6h window', () => {
    expect(readPipelineStallHours({} as Env, 'st_peer_prices')).toBe(DEFAULT_PIPELINE_STALL_HOURS);
    expect(readPipelineStallHours({} as Env, 'senate_fetch_success')).toBe(6);
  });

  it('ignores global price_checked_at when pending tickers were checked recently', async () => {
    seedTrade('FRESHP');
    seedTrade('STUCK');
    const recent = '2026-10-12T14:00:00.000Z';
    const old = '2026-10-01T00:00:00.000Z';
    db.prepare(
      `INSERT INTO securities_ref (ticker, latest_price_date, price_checked_at, source)
       VALUES ('FRESHP', '2026-10-10', ?, 'socratic'),
              ('STUCK', NULL, ?, 'socratic'),
              ('DONE', '2026-10-11', ?, 'socratic')`,
    ).run(recent, recent, old);

    const now = new Date('2026-10-12T18:00:00.000Z');
    const result = await sweepPipelineStallAlerts(envWithDb(), now);
    expect(result.evaluated).toContain('st_peer_prices');
    expect(result.alerted).not.toContain('st_peer_prices');
  });

  it('alerts with pending ticker sample when pending set is idle beyond threshold', async () => {
    const { captureMessage } = await import('../../deno/sentry.ts');
    for (let i = 1; i <= 6; i++) seedTrade(`JUNK${i}`);
    const stale = '2026-10-01T00:00:00.000Z';
    const stmt = db.prepare(
      `INSERT INTO securities_ref (ticker, price_checked_at, source)
       VALUES (?, ?, 'socratic')`,
    );
    for (let i = 1; i <= 6; i++) stmt.run(`JUNK${i}`, stale);

    const now = new Date('2026-10-12T18:00:00.000Z');
    const result = await sweepPipelineStallAlerts(envWithDb(), now);
    expect(result.alerted).toContain('st_peer_prices');
    const msg = (captureMessage as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes('st_peer_prices'),
    );
    expect(msg?.[0]).toContain('JUNK1');
    expect(msg?.[0]).toContain('pending sample');
  });

  it('still stalls when pending tickers have stale bars while corpus MAX is fresh', async () => {
    const { captureMessage } = await import('../../deno/sentry.ts');
    seedTrade('STALE1');
    const staleChecked = '2026-10-01T00:00:00.000Z';
    db.prepare(
      `INSERT INTO securities_ref (ticker, latest_price_date, price_checked_at, source)
       VALUES ('STALE1', '2026-10-01', ?, 'socratic')`,
    ).run(staleChecked);
    seedTrade('FRESH');
    db.prepare(
      `INSERT INTO securities_ref (ticker, latest_price_date, price_checked_at, source)
       VALUES ('FRESH', '2026-10-10', datetime('now'), 'socratic')`,
    ).run();
    db.prepare(
      `INSERT INTO price_eod (ticker, date, close) VALUES ('FRESH', '2026-10-10', 100)`,
    ).run();

    const now = new Date('2026-10-12T18:00:00.000Z');
    const result = await sweepPipelineStallAlerts(envWithDb(), now);
    expect(result.alerted).toContain('st_peer_prices');
    const msg = (captureMessage as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes('st_peer_prices'),
    );
    expect(msg?.[0]).toContain('STALE1');
  });

  it('does not stall on a tiny tail when corpus EOD is current through lastTradingDay', async () => {
    seedTrade('TAIL1');
    seedTrade('TAIL2');
    const stale = '2026-10-01T00:00:00.000Z';
    db.prepare(
      `INSERT INTO securities_ref (ticker, price_checked_at, source)
       VALUES ('TAIL1', ?, 'socratic'),
              ('TAIL2', ?, 'socratic')`,
    ).run(stale, stale);
    seedTrade('FRESH');
    db.prepare(
      `INSERT INTO securities_ref (ticker, latest_price_date, price_checked_at, source)
       VALUES ('FRESH', '2026-10-10', datetime('now'), 'socratic')`,
    ).run();
    db.prepare(
      `INSERT INTO price_eod (ticker, date, close) VALUES ('FRESH', '2026-10-10', 100)`,
    ).run();

    const now = new Date('2026-10-12T18:00:00.000Z');
    const result = await sweepPipelineStallAlerts(envWithDb(), now);
    expect(result.evaluated).toContain('st_peer_prices');
    expect(result.alerted).not.toContain('st_peer_prices');
  });

  it('does not stall when pending tickers were never price-checked', async () => {
    seedTrade('NEW1');
    seedTrade('NEW2');
    db.prepare(
      `INSERT INTO securities_ref (ticker, source) VALUES ('NEW1', 'socratic'), ('NEW2', 'socratic')`,
    ).run();

    const now = new Date('2026-10-12T18:00:00.000Z');
    const result = await sweepPipelineStallAlerts(envWithDb(), now);
    expect(result.evaluated).toContain('st_peer_prices');
    expect(result.alerted).not.toContain('st_peer_prices');
  });

  it('does not count COMPETITOR-* fixture-only tickers as pending', async () => {
    seedTrade('BHI');
    db.prepare(
      `UPDATE transactions SET doc_id = 'COMPETITOR-synthetic-bhi', source = 'competitor_backfill' WHERE ticker = 'BHI'`,
    ).run();
    db.prepare(
      `INSERT INTO securities_ref (ticker, price_checked_at, source) VALUES ('BHI', datetime('now', '-40 days'), 'socratic')`,
    ).run();

    const now = new Date('2026-10-12T18:00:00.000Z');
    const result = await sweepPipelineStallAlerts(envWithDb(), now);
    expect(result.evaluated).toContain('st_peer_prices');
    expect(result.alerted).not.toContain('st_peer_prices');
  });

  it('does not count price_unavailable tickers as pending', async () => {
    seedTrade('GHOST');
    db.prepare(
      `INSERT INTO securities_ref (ticker, price_unavailable, price_checked_at, price_unavailable_reason)
       VALUES ('GHOST', 1, datetime('now'), 'manual_junk')`,
    ).run();

    const now = new Date('2026-10-12T18:00:00.000Z');
    const result = await sweepPipelineStallAlerts(envWithDb(), now);
    expect(result.evaluated).toContain('st_peer_prices');
    expect(result.alerted).not.toContain('st_peer_prices');
  });
});
