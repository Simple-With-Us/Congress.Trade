import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sweepPipelineStallAlerts } from '../pipelineLoudAlerts.ts';
import { collectStInboundMarketDataMetrics } from '../../share/stInboundMarketDataHealth.ts';
import { openMigratedD1, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import { PRICE_DRAIN_LAST_PROGRESS_KEY } from '../../prices/peerPriceDrainProgress.ts';
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

vi.mock('../../secrets/infisical.ts', () => ({
  resolveSecrets: vi.fn(async () => ({
    APP_B_IMPORT_URL: 'https://st.example/import',
    APP_B_INGEST_TOKEN: 'peer',
  })),
}));

vi.mock('../../delivery/targetCircuit.ts', () => ({
  targetKeyForUrl: vi.fn(() => null),
  checkTargetCircuit: vi.fn(async () => ({ allowed: true, probe: false })),
}));

vi.mock('../../shared/pipelineHealth.ts', () => ({
  checkPipelineHealth: vi.fn(async () => ({ status: 'ok', checks: [] })),
  collectEmptyFetchHandoffCheck: vi.fn(async () => ({
    check: { id: 'empty_fetch_handoff', status: 'ok', detail: 'none', value: 0 },
    wakeDocId: null,
  })),
}));

let db: SqliteDatabase;
let d1: D1Database;
let close: () => void;

beforeEach(async () => {
  vi.clearAllMocks();
  const opened = await openMigratedD1();
  db = opened.db;
  d1 = opened.d1;
  close = opened.close;
});
afterEach(() => close());

function envWithDb(kv?: Map<string, string>): Env {
  return { DB: d1, CONFIG_KV: createKv(kv) } as Env;
}

function createKv(initial?: Map<string, string>) {
  const store = initial ?? new Map<string, string>();
  return {
    get: async (key: string) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      if (key === PRICE_DRAIN_LAST_PROGRESS_KEY) return raw;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

function seedTrade(ticker: string): void {
  db.prepare(
    `INSERT INTO transactions (id, ticker, tx_date, source, created_at, cursor_seq)
     VALUES (?, ?, '2026-11-01', 'primary', '2026-11-01T00:00:00Z', ?)`,
  ).run(`tx-${ticker}`, ticker, ticker.length);
}

describe('st_inbound_market_data stall detector (CT-2497)', () => {
  it('does not page when push streams are stale but st_peer_prices pull is still advancing', async () => {
    const { captureMessage } = await import('../../deno/sentry.ts');
    db.prepare(
      `INSERT INTO fundamentals_eod (ticker, date, source, updated_at, received_at)
       VALUES ('AAPL', '2026-09-20', 'imported', '2026-09-20', '2026-09-20T08:20:38Z')`,
    ).run();
    db.prepare(
      `INSERT INTO analyst_consensus (ticker, date, source, updated_at, received_at)
       VALUES ('AAPL', '2026-09-20', 'imported', '2026-09-20', '2026-09-20T08:20:38Z')`,
    ).run();
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

    const kv = new Map([[PRICE_DRAIN_LAST_PROGRESS_KEY, recent]]);
    const now = new Date('2026-10-12T18:00:00.000Z');
    const metrics = await collectStInboundMarketDataMetrics(envWithDb(kv), now);
    expect(metrics.stalled).toBe(false);
    expect(metrics.status).toBe('degraded');
    const result = await sweepPipelineStallAlerts(envWithDb(kv), now);
    expect(result.evaluated).toContain('st_inbound_market_data');
    expect(result.alerted).not.toContain('st_inbound_market_data');
    const inboundPages = (captureMessage as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).includes('st_inbound_market_data'),
    );
    expect(inboundPages).toHaveLength(0);
  });

  it('pages when both donated push streams and peer pull are stale', async () => {
    const { captureMessage } = await import('../../deno/sentry.ts');
    db.prepare(
      `INSERT INTO fundamentals_eod (ticker, date, source, updated_at, received_at)
       VALUES ('AAPL', '2026-10-06', 'imported', '2026-10-06', '2026-10-06T08:20:38Z')`,
    ).run();
    for (let i = 1; i <= 3; i++) seedTrade(`STK${i}`);
    const stale = '2026-10-01T00:00:00.000Z';
    const stmt = db.prepare(
      `INSERT INTO securities_ref (ticker, price_checked_at, source)
       VALUES (?, ?, 'socratic')`,
    );
    for (let i = 1; i <= 3; i++) stmt.run(`STK${i}`, stale);

    const now = new Date('2026-11-12T00:00:00.000Z');
    const result = await sweepPipelineStallAlerts(envWithDb(), now);
    expect(result.alerted).toContain('st_inbound_market_data');
    const inboundPages = (captureMessage as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).includes('st_inbound_market_data'),
    );
    expect(inboundPages.length).toBeGreaterThan(0);
  });
});
