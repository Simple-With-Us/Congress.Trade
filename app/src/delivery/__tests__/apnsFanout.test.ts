import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import type { ApnsHttpRequest } from '../../shared/apns.ts';
import { openMigratedD1, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import * as infisical from '../../secrets/infisical.ts';
import {
  APNS_FANOUT_TRADE_PENDING_SQL,
  APNS_FANOUT_TRADE_SCHEMA_SQL,
  APNS_FANOUT_TRADE_SQL,
  apnsLaneErrorIsRecent,
  fanOutApnsProductEvents,
  officialFilingPushData,
  inspectApnsFanoutDiagnostics,
  probeApnsPendingEvents,
  readApnsFanoutLastError,
  resolveApnsConfig,
} from '../apnsFanout.ts';

const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

const liveToken = 'a'.repeat(64);
const deadToken = 'b'.repeat(64);

function mockEnv(opts: {
  devices?: Array<{ token: string; env?: string; userId?: string; active?: number }>;
  trades?: Array<Record<string, unknown>>;
  reviews?: Array<Record<string, unknown>>;
  preferences?: Array<{
    userId: string;
    watchlist?: unknown;
    notificationSettings?: unknown;
  }>;
  prepared?: string[];
}): Env {
  const prepared = opts.prepared;
  const devices = (opts.devices ?? []).map((d, i) => ({
    id: `pdev_${i}`,
    user_id: d.userId ?? 'user_1',
    platform: 'apns',
    token: d.token,
    app_bundle: 'trade.congress.ios',
    env: d.env ?? 'production',
    active: d.active ?? 1,
    created_at: '2026-08-13T00:00:00.000Z',
    updated_at: '2026-08-13T00:00:00.000Z',
  }));
  const trades = opts.trades ?? [];
  const reviews = opts.reviews ?? [];
  const preferences = (opts.preferences ?? []).map((p) => ({
    user_id: p.userId,
    saved_filters: '{}',
    watchlist: JSON.stringify(p.watchlist ?? []),
    notification_settings: JSON.stringify(p.notificationSettings ?? {}),
    default_window: null as string | null,
    updated_at: '2026-08-13T00:00:00.000Z',
  }));

  const prepare = (sql: string) => {
    prepared?.push(sql);
    const stmt = {
      params: [] as unknown[],
      bind(...params: unknown[]) {
        this.params = params;
        return this;
      },
      async first<T>() {
        if (/FROM push_devices WHERE id = \? AND user_id = \?/i.test(sql)) {
          const row = devices.find((d) => d.id === this.params[0] && d.user_id === this.params[1]);
          return (row ?? null) as T | null;
        }
        if (/FROM delivery_outbox o/i.test(sql) && /SELECT 1 AS ok/i.test(sql)) {
          const since = String(this.params[0] ?? '');
          return (trades.some((t) => String(t.created_at) > since) ? { ok: 1 } : null) as T | null;
        }
        if (/FROM review_queue/i.test(sql) && /SELECT 1 AS ok/i.test(sql)) {
          const since = String(this.params[0] ?? '');
          return (reviews.some((r) => String(r.created_at) > since) ? { ok: 1 } : null) as T | null;
        }
        return null as T | null;
      },
      async all<T>() {
        if (/FROM push_devices\s+WHERE platform = 'apns' AND active = 1/i.test(sql)) {
          return { results: devices.filter((d) => d.active === 1) as T[], meta: {} };
        }
        if (/FROM user_preferences/i.test(sql)) {
          const wanted = new Set(this.params.map((p) => String(p)));
          return {
            results: preferences.filter((p) => wanted.has(p.user_id)) as T[],
            meta: {},
          };
        }
        if (/FROM delivery_outbox o/i.test(sql)) {
          const since = String(this.params[0] ?? '');
          return {
            results: trades.filter((t) => String(t.created_at) > since) as T[],
            meta: {},
          };
        }
        if (/FROM review_queue/i.test(sql)) {
          const since = String(this.params[0] ?? '');
          return {
            results: reviews.filter((r) => String(r.created_at) > since) as T[],
            meta: {},
          };
        }
        return { results: [] as T[], meta: {} };
      },
      async run() {
        if (/UPDATE push_devices SET active = 0/i.test(sql)) {
          const token = String(this.params[this.params.length - 1] ?? '');
          const userId = String(this.params[1] ?? '');
          for (const d of devices) {
            if (d.user_id === userId && d.token === token) d.active = 0;
          }
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    };
    return stmt;
  };

  return {
    DB: { prepare } as unknown as Env['DB'],
    CONFIG_KV: {
      async get() {
        return null;
      },
      async put() {
        return undefined;
      },
    } as unknown as Env['CONFIG_KV'],
  } as Env;
}

const config = {
  keyId: 'P4US7YTWH4',
  teamId: 'CC8UTF7ATG',
  bundleId: 'trade.congress.ios',
  privateKeyPem: pem,
};

describe('fanOutApnsProductEvents', () => {

  it('no-ops when APNs is not configured', async () => {
    const result = await fanOutApnsProductEvents(mockEnv({}), {
      loadConfig: () => null,
      now: new Date('2026-08-13T18:00:00.000Z'),
    });
    expect(result.skipped).toBe('not_configured');
  });

  it('sends one filing digest per disclosure, not a review-queue page to users', async () => {
    const env = mockEnv({
      devices: [
        { token: liveToken, env: 'production' },
        { token: deadToken, env: 'sandbox' },
      ],
      trades: [
        {
          id: 'tx_1',
          ticker: 'NVDA',
          tx_type: 'P',
          asset_name: 'NVIDIA Corp',
          created_at: '2026-08-13T17:30:00.000Z',
          filer_name: 'Jane Pelosi',
        },
      ],
      reviews: [
        {
          doc_id: 'H-99',
          reason: 'Low-confidence extraction',
          created_at: '2026-08-13T17:40:00.000Z',
        },
      ],
    });
    const calls: ApnsHttpRequest[] = [];
    const result = await fanOutApnsProductEvents(env, {
      loadConfig: () => config,
      now: new Date('2026-08-13T18:00:00.000Z'),
      readState: async () => ({
        lastTradeAt: '2026-08-13T16:00:00.000Z',
        lastReviewAt: '2026-08-13T16:00:00.000Z',
      }),
      writeState: async () => undefined,
      transport: async (req) => {
        calls.push(req);
        if (req.path.endsWith(deadToken)) {
          return { status: 410, body: JSON.stringify({ reason: 'Unregistered' }) };
        }
        return { status: 200, body: '' };
      },
    });

    expect(result.skipped).toBeUndefined();
    expect(result.trades).toBe(1);
    expect(result.reviews).toBe(1);
    expect(result.delivered).toBe(1);
    expect(result.retired).toBe(1);
    expect(calls).toHaveLength(2);
    const alerts = calls.map((c) => {
      const body = JSON.parse(c.body) as { aps: { alert: { title: string; body: string } } };
      return body.aps.alert;
    });
    expect(alerts.every((a) => a.title === 'Jane Pelosi')).toBe(true);
    expect(alerts.every((a) => a.body === 'Filed 1 trade (1 buy).')).toBe(true);
    expect(alerts.some((a) => /bought|Review needed/i.test(`${a.title} ${a.body}`))).toBe(false);
    expect(calls[0]?.headers['apns-topic']).toBe('trade.congress.ios');
  });

  it('persists the lane error when fan-out throws after devices are listed', async () => {
    const kv = new Map<string, string>();
    const env = mockEnv({ devices: [{ token: liveToken }] });
    env.CONFIG_KV = {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
      },
    } as unknown as Env['CONFIG_KV'];

    await expect(
      fanOutApnsProductEvents(env, {
        loadConfig: () => config,
        now: new Date('2026-08-13T18:00:00.000Z'),
        readState: async () => {
          throw new Error('no such column: f.id');
        },
        writeState: async () => undefined,
      }),
    ).rejects.toThrow(/no such column: f\.id/);

    await expect(readApnsFanoutLastError(env)).resolves.toMatchObject({
      message: 'no such column: f.id',
      at: '2026-08-13T18:00:00.000Z',
    });
  });

  it('skips the unindexed trade scan when the cheap probe finds nothing', async () => {
    const prepared: string[] = [];
    const env = mockEnv({ devices: [{ token: liveToken }], prepared });
    const result = await fanOutApnsProductEvents(env, {
      loadConfig: () => config,
      now: new Date('2026-08-13T18:00:00.000Z'),
      readState: async () => ({
        lastTradeAt: '2026-08-13T16:00:00.000Z',
        lastReviewAt: '2026-08-13T16:00:00.000Z',
      }),
      writeState: async () => undefined,
    });
    expect(result.skipped).toBe('no_pending');
    expect(prepared.some((sql) => sql === APNS_FANOUT_TRADE_SQL)).toBe(false);
    expect(prepared.some((sql) => sql === APNS_FANOUT_TRADE_PENDING_SQL)).toBe(true);
  });

  it('persists a device-list throw as the lane error', async () => {
    const kv = new Map<string, string>();
    const env = mockEnv({});
    const originalPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/FROM push_devices\s+WHERE platform = 'apns' AND active = 1/i.test(sql) && !/COUNT/i.test(sql)) {
        return {
          bind() {
            return this;
          },
          async all() {
            throw new Error('no such table: push_devices');
          },
          async first() {
            throw new Error('no such table: push_devices');
          },
          async run() {
            return { meta: { changes: 0 } };
          },
        };
      }
      return originalPrepare(sql);
    }) as Env['DB']['prepare'];
    env.CONFIG_KV = {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
      },
    } as unknown as Env['CONFIG_KV'];

    await expect(
      fanOutApnsProductEvents(env, {
        loadConfig: () => config,
        now: new Date('2026-08-13T18:00:00.000Z'),
      }),
    ).rejects.toThrow(/no such table: push_devices/);
    await expect(readApnsFanoutLastError(env)).resolves.toMatchObject({
      message: 'no such table: push_devices',
      at: '2026-08-13T18:00:00.000Z',
    });
  });

  it('does not advance the cursor when APNs returns a retryable or auth error', async () => {
    const state = {
      lastTradeAt: '2026-08-13T16:00:00.000Z',
      lastReviewAt: '2026-08-13T16:00:00.000Z',
    };
    const kv = new Map<string, string>();
    const env = mockEnv({
      devices: [{ token: liveToken }],
      trades: [
        {
          id: 'tx_1',
          ticker: 'NVDA',
          tx_type: 'P',
          asset_name: 'NVIDIA Corp',
          created_at: '2026-08-13T17:30:00.000Z',
          filer_name: 'Jane Pelosi',
        },
      ],
    });
    env.CONFIG_KV = {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
      },
    } as unknown as Env['CONFIG_KV'];
    const written: Array<{ lastTradeAt: string; lastReviewAt: string }> = [];
    const result = await fanOutApnsProductEvents(env, {
      loadConfig: () => config,
      now: new Date('2026-08-13T18:00:00.000Z'),
      readState: async () => ({ ...state }),
      writeState: async (_env, next) => {
        written.push({ ...next });
      },
      transport: async () => ({ status: 403, body: JSON.stringify({ reason: 'Forbidden' }) }),
    });
    expect(result.delivered).toBe(0);
    expect(written).toEqual([
      { lastTradeAt: '2026-08-13T16:00:00.000Z', lastReviewAt: '2026-08-13T16:00:00.000Z' },
    ]);
    await expect(readApnsFanoutLastError(env)).resolves.toMatchObject({
      message: expect.stringMatching(/403|Forbidden|auth/i),
    });
  });

  it('does not recover on a lane error older than 24h when nothing is pending', async () => {
    const prepared: string[] = [];
    const kv = new Map<string, string>();
    kv.set(
      'apns:fanout:last_error',
      JSON.stringify({ message: 'stale join error', at: '2026-08-12T12:00:00.000Z' }),
    );
    const env = mockEnv({ devices: [{ token: liveToken }], prepared });
    env.CONFIG_KV = {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
      },
    } as unknown as Env['CONFIG_KV'];
    const result = await fanOutApnsProductEvents(env, {
      loadConfig: () => config,
      now: new Date('2026-08-13T18:00:00.000Z'),
      readState: async () => ({
        lastTradeAt: '2026-08-13T16:00:00.000Z',
        lastReviewAt: '2026-08-13T16:00:00.000Z',
      }),
      writeState: async () => undefined,
    });
    expect(result.skipped).toBe('no_pending');
    expect(prepared.some((sql) => sql === APNS_FANOUT_TRADE_SQL)).toBe(false);
  });

  it('still runs TRADE_SQL when a recent lane error needs recovery', async () => {
    const prepared: string[] = [];
    const kv = new Map<string, string>();
    kv.set(
      'apns:fanout:last_error',
      JSON.stringify({ message: 'no such column: f.id', at: '2026-08-13T17:50:00.000Z' }),
    );
    const env = mockEnv({ devices: [{ token: liveToken }], prepared });
    env.CONFIG_KV = {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
      },
    } as unknown as Env['CONFIG_KV'];

    const result = await fanOutApnsProductEvents(env, {
      loadConfig: () => config,
      now: new Date('2026-08-13T18:00:00.000Z'),
      readState: async () => ({
        lastTradeAt: '2026-08-13T16:00:00.000Z',
        lastReviewAt: '2026-08-13T16:00:00.000Z',
      }),
      writeState: async () => undefined,
      transport: async () => ({ status: 200, body: '' }),
    });
    expect(result.skipped).toBeUndefined();
    expect(prepared.some((sql) => sql === APNS_FANOUT_TRADE_SQL)).toBe(true);
  });

  it('resolveApnsConfig uses Infisical-resolved secrets, not raw Env only', async () => {
    const spy = vi.spyOn(infisical, 'resolveSecrets').mockResolvedValue({
      APNS_KEY_ID: 'P4US7YTWH4',
      APNS_TEAM_ID: 'CC8UTF7ATG',
      APNS_BUNDLE_ID: 'trade.congress.ios',
      APNS_P8: pem,
      APNS_PRIVATE_KEY: undefined,
      [`APNS_PRIVATE_KEY${'_B64'}`]: undefined,
    });
    try {
      const resolved = await resolveApnsConfig({} as Env);
      expect(resolved).toMatchObject({
        keyId: 'P4US7YTWH4',
        teamId: 'CC8UTF7ATG',
        bundleId: 'trade.congress.ios',
      });
      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining(['APNS_KEY_ID', 'APNS_P8', 'APNS_PRIVATE_KEY']),
      );

      const env = mockEnv({
        devices: [{ token: liveToken }],
        trades: [
          {
            id: 'tx_1',
            ticker: 'NVDA',
            tx_type: 'P',
            asset_name: 'NVIDIA Corp',
            created_at: '2026-08-13T17:30:00.000Z',
            filer_name: 'Jane Pelosi',
          },
        ],
      });
      const result = await fanOutApnsProductEvents(env, {
        now: new Date('2026-08-13T18:00:00.000Z'),
        readState: async () => ({
          lastTradeAt: '2026-08-13T16:00:00.000Z',
          lastReviewAt: '2026-08-13T16:00:00.000Z',
        }),
        writeState: async () => undefined,
        transport: async () => ({ status: 200, body: '' }),
      });
      expect(result.skipped).toBeUndefined();
      expect(result.trades).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('probeApnsPendingEvents', () => {
  it('drives from delivery_outbox, not an unindexed transactions.created_at scan', () => {
    expect(APNS_FANOUT_TRADE_PENDING_SQL).toMatch(/FROM delivery_outbox o/i);
    expect(APNS_FANOUT_TRADE_PENDING_SQL).toMatch(/AND EXISTS/i);
    expect(APNS_FANOUT_TRADE_PENDING_SQL).toMatch(/o\.status != 'suppressed'/);
    expect(APNS_FANOUT_TRADE_PENDING_SQL).toMatch(/t\.id = o\.tx_id/i);
    expect(APNS_FANOUT_TRADE_PENDING_SQL).not.toMatch(/ORDER BY t\.created_at/i);
  });

  it('returns false on empty outbox/review tables', async () => {
    const env = mockEnv({});
    await expect(
      probeApnsPendingEvents(env, '2026-08-13T16:00:00.000Z', '2026-08-13T16:00:00.000Z'),
    ).resolves.toBe(false);
  });
});

describe('apnsLaneErrorIsRecent', () => {
  const now = new Date('2026-08-20T04:00:00.000Z');
  it('accepts errors inside 24h and rejects older ones', () => {
    expect(apnsLaneErrorIsRecent('2026-08-19T12:00:00.000Z', now)).toBe(true);
    expect(apnsLaneErrorIsRecent('2026-08-18T12:00:00.000Z', now)).toBe(false);
    expect(apnsLaneErrorIsRecent(null, now)).toBe(false);
  });
});

const BROKEN_FILERS_ID_SQL = APNS_FANOUT_TRADE_SQL.replace(
  'LEFT JOIN filers f ON f.bioguide_id = t.filer_id',
  'LEFT JOIN filers f ON f.id = t.filer_id',
);

function seedOfficialTrade(db: SqliteDatabase): void {
  db.prepare(
    `INSERT INTO filers (bioguide_id, chamber, full_name, display_name)
     VALUES (?, 'house', ?, ?)`,
  ).run('P000197', 'Nancy Pelosi', 'Nancy Pelosi');
  db.prepare(
    `INSERT INTO transactions
       (id, doc_id, filer_id, ticker, tx_type, asset_name, created_at, deprecated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    'tx_real_1',
    'H-1',
    'P000197',
    'NVDA',
    'P',
    'NVIDIA Corp',
    '2026-08-13T17:30:00.000Z',
  );
  db.prepare(
    `INSERT INTO delivery_outbox (tx_id, status, available_at, created_at, updated_at)
     VALUES (?, 'completed', ?, ?, ?)`,
  ).run(
    'tx_real_1',
    '2026-08-13T17:30:00.000Z',
    '2026-08-13T17:30:00.000Z',
    '2026-08-13T17:30:00.000Z',
  );
}

describe('APNS_FANOUT_TRADE_SQL against real migrations', () => {
  let close = (): void => undefined;

  afterEach(() => {
    close();
  });

  it('throws on f.id and returns COALESCE(display_name, full_name) on bioguide_id', async () => {
    const opened = await openMigratedD1();
    close = opened.close;
    seedOfficialTrade(opened.db);

    expect(() => opened.db.prepare(BROKEN_FILERS_ID_SQL).all('2026-08-13T16:00:00.000Z')).toThrow(
      /no such column: f\.id/i,
    );

    const rows = opened.db.prepare(APNS_FANOUT_TRADE_SQL).all('2026-08-13T16:00:00.000Z') as Array<{
      id: string;
      ticker: string;
      filer_name: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'tx_real_1',
      ticker: 'NVDA',
      filer_name: 'Nancy Pelosi',
    });
    expect(APNS_FANOUT_TRADE_SQL).toContain('LEFT JOIN filers f ON f.bioguide_id = t.filer_id');
    expect(APNS_FANOUT_TRADE_SQL).not.toContain('f.id = t.filer_id');

    const pending = opened.db.prepare(APNS_FANOUT_TRADE_PENDING_SQL).get('2026-08-13T16:00:00.000Z');
    expect(pending).toEqual({ ok: 1 });
    const idle = opened.db.prepare(APNS_FANOUT_TRADE_PENDING_SQL).get('2026-08-13T18:00:00.000Z');
    expect(idle).toBeUndefined();
  });

  it('fan-out executes the real SQL and calls sendAll with the joined name', async () => {
    const opened = await openMigratedD1();
    close = opened.close;
    seedOfficialTrade(opened.db);
    opened.db.prepare(
      `INSERT INTO push_devices
         (id, user_id, platform, token, app_bundle, env, active, created_at, updated_at)
       VALUES (?, ?, 'apns', ?, 'trade.congress.ios', 'production', 1, ?, ?)`,
    ).run(
      'pdev_1',
      'user_1',
      liveToken,
      '2026-08-13T00:00:00.000Z',
      '2026-08-13T00:00:00.000Z',
    );

    const kv = new Map<string, string>();
    const env = {
      DB: opened.d1,
      CONFIG_KV: {
        async get(key: string) {
          return kv.get(key) ?? null;
        },
        async put(key: string, value: string) {
          kv.set(key, value);
        },
      },
    } as unknown as Env;

    const inspect = await inspectApnsFanoutDiagnostics(env);
    expect(inspect.queryOk).toBe(true);
    expect(inspect.queryError).toBeNull();
    expect(inspect.activeDevices).toBe(1);
    expect(APNS_FANOUT_TRADE_SCHEMA_SQL).toContain('LEFT JOIN filers f ON f.bioguide_id = t.filer_id');
    expect(APNS_FANOUT_TRADE_SCHEMA_SQL).not.toMatch(/created_at >/i);
    expect(APNS_FANOUT_TRADE_SCHEMA_SQL).not.toMatch(/ORDER BY/i);

    const calls: ApnsHttpRequest[] = [];
    const result = await fanOutApnsProductEvents(env, {
      loadConfig: () => config,
      now: new Date('2026-08-13T18:00:00.000Z'),
      readState: async () => ({
        lastTradeAt: '2026-08-13T16:00:00.000Z',
        lastReviewAt: '2026-08-13T16:00:00.000Z',
      }),
      writeState: async () => undefined,
      transport: async (req) => {
        calls.push(req);
        return { status: 200, body: '' };
      },
    });

    expect(result.skipped).toBeUndefined();
    expect(result.trades).toBe(1);
    expect(result.delivered).toBe(1);
    const alert = (JSON.parse(calls[0]?.body ?? '{}') as { aps: { alert: { title: string; body: string } } }).aps.alert;
    expect(alert.title).toBe('Nancy Pelosi, Representative');
    expect(alert.body).toBe('Filed 1 trade (1 buy).');
    await expect(readApnsFanoutLastError(env)).resolves.toBeNull();
  });
});

function alertFrom(req: ApnsHttpRequest): { title: string; body: string } {
  return (JSON.parse(req.body) as { aps: { alert: { title: string; body: string } } }).aps.alert;
}

describe('officialFilingPushData', () => {
  it('sends snake_case aliases the shipped iOS AppDelegate already reads', () => {
    expect(officialFilingPushData([
      { id: 'tx_1', doc_id: 'H-1', ticker: 'NVDA' },
      { id: 'tx_2', doc_id: 'H-1', ticker: 'AAPL' },
    ])).toEqual({
      kind: 'official_filing',
      docId: 'H-1',
      doc_id: 'H-1',
      txIds: ['tx_1', 'tx_2'],
      tradeId: 'tx_1',
      trade_id: 'tx_1',
      tickers: ['NVDA', 'AAPL'],
    });
  });
});

describe('fanOutApnsProductEvents targeting', () => {
  it('collapses two trades on one filing into a single digest', async () => {
    const env = mockEnv({
      devices: [{ token: liveToken }],
      trades: [
        {
          id: 'tx_1',
          doc_id: 'H-1',
          ticker: 'NVDA',
          tx_type: 'P',
          amount_min: 1001,
          created_at: '2026-08-13T17:30:00.000Z',
          filer_name: 'Nancy Pelosi',
          chamber: 'house',
          state: 'CA',
          district: '11',
        },
        {
          id: 'tx_2',
          doc_id: 'H-1',
          ticker: 'AAPL',
          tx_type: 'S',
          amount_min: 15001,
          created_at: '2026-08-13T17:31:00.000Z',
          filer_name: 'Nancy Pelosi',
          chamber: 'house',
          state: 'CA',
          district: '11',
        },
      ],
    });
    const calls: ApnsHttpRequest[] = [];
    const result = await fanOutApnsProductEvents(env, {
      loadConfig: () => config,
      now: new Date('2026-08-13T18:00:00.000Z'),
      readState: async () => ({
        lastTradeAt: '2026-08-13T16:00:00.000Z',
        lastReviewAt: '2026-08-13T16:00:00.000Z',
      }),
      writeState: async () => undefined,
      transport: async (req) => {
        calls.push(req);
        return { status: 200, body: '' };
      },
    });
    expect(result.trades).toBe(2);
    expect(result.delivered).toBe(1);
    expect(calls).toHaveLength(1);
    expect(alertFrom(calls[0]!)).toEqual({
      title: "Nancy Pelosi, Representative from California's 11th District",
      body: 'Filed 2 trades (1 buy, 1 sell).',
    });
    const payload = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(payload.doc_id).toBe('H-1');
    expect(payload.docId).toBe('H-1');
    expect(payload.trade_id).toBe('tx_1');
    expect(payload.tradeId).toBe('tx_1');
    expect(payload.txIds).toEqual(['tx_1', 'tx_2']);
    expect(payload.kind).toBe('official_filing');
  });

  it('does not push when the account chose Off', async () => {
    const env = mockEnv({
      devices: [{ token: liveToken, userId: 'user_off' }],
      preferences: [{ userId: 'user_off', notificationSettings: { pushMode: 'off' } }],
      trades: [
        {
          id: 'tx_1',
          ticker: 'NVDA',
          tx_type: 'P',
          created_at: '2026-08-13T17:30:00.000Z',
          filer_name: 'Jane Pelosi',
        },
      ],
    });
    const calls: ApnsHttpRequest[] = [];
    const result = await fanOutApnsProductEvents(env, {
      loadConfig: () => config,
      now: new Date('2026-08-13T18:00:00.000Z'),
      readState: async () => ({
        lastTradeAt: '2026-08-13T16:00:00.000Z',
        lastReviewAt: '2026-08-13T16:00:00.000Z',
      }),
      writeState: async () => undefined,
      transport: async (req) => {
        calls.push(req);
        return { status: 200, body: '' };
      },
    });
    expect(result.delivered).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('watchlist mode keeps only matching ticker/side/amount rows', async () => {
    const env = mockEnv({
      devices: [{ token: liveToken, userId: 'user_w' }],
      preferences: [{
        userId: 'user_w',
        watchlist: ['NVDA'],
        notificationSettings: {
          pushMode: 'watchlist',
          watchlistRules: { NVDA: { minAmount: 50001, sides: 'buys' } },
        },
      }],
      trades: [
        {
          id: 'tx_keep',
          doc_id: 'H-1',
          ticker: 'NVDA',
          tx_type: 'P',
          amount_min: 50001,
          created_at: '2026-08-13T17:30:00.000Z',
          filer_name: 'Jane Pelosi',
        },
        {
          id: 'tx_small',
          doc_id: 'H-1',
          ticker: 'NVDA',
          tx_type: 'P',
          amount_min: 1001,
          created_at: '2026-08-13T17:31:00.000Z',
          filer_name: 'Jane Pelosi',
        },
        {
          id: 'tx_other',
          doc_id: 'H-2',
          ticker: 'AAPL',
          tx_type: 'P',
          amount_min: 50001,
          created_at: '2026-08-13T17:32:00.000Z',
          filer_name: 'Jane Pelosi',
        },
      ],
    });
    const calls: ApnsHttpRequest[] = [];
    await fanOutApnsProductEvents(env, {
      loadConfig: () => config,
      now: new Date('2026-08-13T18:00:00.000Z'),
      readState: async () => ({
        lastTradeAt: '2026-08-13T16:00:00.000Z',
        lastReviewAt: '2026-08-13T16:00:00.000Z',
      }),
      writeState: async () => undefined,
      transport: async (req) => {
        calls.push(req);
        return { status: 200, body: '' };
      },
    });
    expect(calls).toHaveLength(1);
    expect(alertFrom(calls[0]!)).toEqual({
      title: 'Jane Pelosi',
      body: 'Filed 1 trade (1 buy).',
    });
  });

  it('does not announce an exchange as a purchase', async () => {
    const env = mockEnv({
      devices: [{ token: liveToken }],
      trades: [
        {
          id: 'tx_e',
          ticker: 'NVDA',
          tx_type: 'E',
          created_at: '2026-08-13T17:30:00.000Z',
          filer_name: 'Jane Pelosi',
        },
      ],
    });
    const calls: ApnsHttpRequest[] = [];
    await fanOutApnsProductEvents(env, {
      loadConfig: () => config,
      now: new Date('2026-08-13T18:00:00.000Z'),
      readState: async () => ({
        lastTradeAt: '2026-08-13T16:00:00.000Z',
        lastReviewAt: '2026-08-13T16:00:00.000Z',
      }),
      writeState: async () => undefined,
      transport: async (req) => {
        calls.push(req);
        return { status: 200, body: '' };
      },
    });
    expect(alertFrom(calls[0]!)).toEqual({
      title: 'Jane Pelosi',
      body: 'Filed 1 trade (1 exchange).',
    });
  });
});
