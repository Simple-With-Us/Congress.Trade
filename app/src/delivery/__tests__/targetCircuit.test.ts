/**
 * GOVERNOR 3 tests — the per-target outbound circuit breaker.
 *
 * Pins the storm contract (the socratictrade.com 401 storm: 696 failed
 * attempts) down to: threshold failures open the circuit, an open circuit
 * PARKS deliveries without throwing (so the queue never retries), the open
 * window elapsing admits exactly ONE hourly probe, a 2xx auto-closes, and the
 * daily failed-attempt cap is the hard backstop.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { freshDeliveryDay, freshDeliveryIso } from './freshDeliveryFixtures.ts';
import {
  DEFAULT_TARGET_DAILY_ATTEMPT_CAP,
  DEFAULT_TARGET_FAILURE_THRESHOLD,
  TARGET_PROBE_INTERVAL_SEC,
  checkTargetCircuit,
  flushParkedDeliveries,
  parkDelivery,
  quarantineAutoRecoverEnabled,
  recoverQuarantinedDeliveries,
  recordTargetFailure,
  recordTargetSuccess,
  targetKeyForUrl,
} from '../targetCircuit.ts';
import { dispatchWebhook, DeliveryRetryError } from '../webhook.ts';

interface CircuitState {
  target_key: string;
  consecutive_failures: number;
  open_until: string | null;
  failures_day: string | null;
  failures_today: number;
  last_error: string | null;
  updated_at: string;
}

interface FakeDelivery {
  subscription_id: string;
  tx_id: string;
  status: string;
  attempts: number;
  last_error: string | null;
  updated_at?: string;
}

interface FakeStore {
  circuits: Map<string, CircuitState>;
  deliveries: Map<string, FakeDelivery>;
  runs: Array<{ sql: string; params: unknown[] }>;
  /** Simulate losing the atomic half-open probe claim race. */
  claimDenied: boolean;
  /** tx ids with no transactions row (swept by retention) for the LEFT JOIN. */
  missingTx: Set<string>;
  /** tx ids whose transactions row is deprecated (retracted). */
  retractedTx: Set<string>;
  /** SQL of every parked/quarantined scan, in order. */
  scans: string[];
}

/** Minimal D1 fake covering the circuit + park/flush SQL shapes. */
function circuitEnv(extra: { subscriptions?: Array<Record<string, unknown>>; vars?: Record<string, string> } = {}): {
  env: Env;
  store: FakeStore;
  queueSends: unknown[];
} {
  const store: FakeStore = {
    circuits: new Map(),
    deliveries: new Map(),
    runs: [],
    claimDenied: false,
    missingTx: new Set(),
    retractedTx: new Set(),
    scans: [],
  };
  const queueSends: unknown[] = [];
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async first<T>() {
      if (/FROM delivery_target_circuit WHERE target_key = \?/i.test(sql)) {
        const row = store.circuits.get(this.params[0] as string);
        return (row ? { ...row } : null) as T | null;
      }
      if (/SELECT COUNT\(\*\) AS c FROM deliveries/i.test(sql)) {
        const subscriptionId = this.params[0] as string;
        let c = 0;
        for (const d of store.deliveries.values()) {
          if (d.subscription_id === subscriptionId && d.status === 'parked') c += 1;
        }
        return { c } as T;
      }
      return null as T | null;
    },
    async all<T>() {
      if (/FROM delivery_target_circuit WHERE target_key = \?/i.test(sql)) {
        const row = store.circuits.get(this.params[0] as string);
        return { results: (row ? [{ ...row }] : []) as T[] };
      }
      if (/FROM deliveries d\s+JOIN subscriptions s/i.test(sql)) {
        const rows: Array<{ updated_at: string; row: unknown }> = [];
        const wantQuarantined = /status = 'quarantined'/i.test(sql);
        const wantParked = /status = 'parked'/i.test(sql);
        // LEFT JOIN transactions: the tx_state CASE and the undeliverable-only /
        // live-only filters.
        const joinsTransactions = /LEFT JOIN transactions t/i.test(sql);
        const undeliverableOnly = /\(t\.id IS NULL OR t\.deprecated_at IS NOT NULL\)/i.test(sql);
        const liveOnly = /\(t\.id IS NOT NULL AND t\.deprecated_at IS NULL\)/i.test(sql);
        store.scans.push(sql);
        for (const d of store.deliveries.values()) {
          if (wantQuarantined && d.status !== 'quarantined') continue;
          if (wantParked && d.status !== 'parked') continue;
          const sub = (extra.subscriptions ?? []).find((s) => s.id === d.subscription_id);
          if (!sub) continue;
          const txState = !joinsTransactions
            ? undefined
            : store.missingTx.has(d.tx_id)
              ? 'missing'
              : store.retractedTx.has(d.tx_id)
                ? 'retracted'
                : null;
          if (undeliverableOnly && !txState) continue;
          if (liveOnly && txState) continue;
          rows.push({
            updated_at: d.updated_at ?? '',
            row: { subscription_id: d.subscription_id, tx_id: d.tx_id, target_url: sub.target_url, tx_state: txState },
          });
        }
        // ORDER BY d.updated_at ASC LIMIT n (stable: insertion order breaks ties).
        rows.sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0));
        const limit = Number(/LIMIT (\d+)/i.exec(sql)?.[1] ?? rows.length);
        return { results: rows.slice(0, limit).map((r) => r.row) as T[] };
      }
      return { results: [] as T[] };
    },
    async run() {
      store.runs.push({ sql, params: this.params });
      if (/INSERT INTO delivery_target_circuit/i.test(sql)) {
        const [targetKey, openUntil, day, lastError, nowIso] = this.params as [string, string | null, string, string, string];
        const existing = store.circuits.get(targetKey);
        if (!existing) {
          store.circuits.set(targetKey, {
            target_key: targetKey,
            consecutive_failures: 1,
            open_until: openUntil,
            failures_day: day,
            failures_today: 1,
            last_error: lastError,
            updated_at: nowIso,
          });
        } else {
          existing.consecutive_failures += 1;
          if (openUntil && (!existing.open_until || existing.open_until < openUntil)) {
            existing.open_until = openUntil;
          }
          existing.failures_today = existing.failures_day === day ? existing.failures_today + 1 : 1;
          existing.failures_day = day;
          existing.last_error = lastError;
          existing.updated_at = nowIso;
        }
        return { success: true, meta: { changes: 1 } };
      }
      if (/UPDATE delivery_target_circuit\s+SET open_until = \?/i.test(sql)) {
        // half-open probe claim: conditional on the exact open_until value
        const [probeUntil, nowIso, targetKey, expectedOpenUntil] = this.params as [string, string, string, string];
        const row = store.circuits.get(targetKey);
        if (store.claimDenied || !row || row.open_until !== expectedOpenUntil) {
          return { success: true, meta: { changes: 0 } };
        }
        row.open_until = probeUntil;
        row.updated_at = nowIso;
        return { success: true, meta: { changes: 1 } };
      }
      if (/UPDATE delivery_target_circuit\s+SET consecutive_failures = 0/i.test(sql)) {
        const [nowIso, targetKey] = this.params as [string, string];
        const row = store.circuits.get(targetKey);
        if (row) {
          row.consecutive_failures = 0;
          row.open_until = null;
          row.last_error = null;
          row.updated_at = nowIso;
        }
        return { success: true, meta: { changes: row ? 1 : 0 } };
      }
      if (/INSERT INTO deliveries .*'parked'/is.test(sql)) {
        const [, subscriptionId, txId, lastError, nowIso] = this.params as [string, string, string, string, string];
        const key = `${subscriptionId}:${txId}`;
        const existing = store.deliveries.get(key);
        if (existing && ['delivered', 'skipped', 'quarantined'].includes(existing.status)) {
          return { success: true, meta: { changes: 0 } };
        }
        store.deliveries.set(key, {
          subscription_id: subscriptionId,
          tx_id: txId,
          status: 'parked',
          attempts: existing?.attempts ?? 0,
          last_error: lastError,
          updated_at: nowIso,
        });
        return { success: true, meta: { changes: 1 } };
      }
      if (/UPDATE deliveries SET status = 'quarantined'/i.test(sql)) {
        const [nowIso, subscriptionId, txId] = this.params as [string, string, string];
        const row = store.deliveries.get(`${subscriptionId}:${txId}`);
        if (row) {
          row.status = 'quarantined';
          row.updated_at = nowIso;
        }
        return { success: true, meta: { changes: row ? 1 : 0 } };
      }
      if (/UPDATE deliveries\s+SET status = 'parked'/i.test(sql) && /status = 'quarantined'/i.test(sql)) {
        const [nowIso, subscriptionId, txId] = this.params as [string, string, string];
        const row = store.deliveries.get(`${subscriptionId}:${txId}`);
        if (row && row.status === 'quarantined') {
          row.status = 'parked';
          row.updated_at = nowIso;
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      }
      if (/UPDATE deliveries\s+SET status = 'skipped'/i.test(sql) && /status IN \('parked', 'quarantined'\)/i.test(sql)) {
        const [reason, nowIso, subscriptionId, txId] = this.params as [string, string, string, string];
        const row = store.deliveries.get(`${subscriptionId}:${txId}`);
        if (row && (row.status === 'parked' || row.status === 'quarantined')) {
          row.status = 'skipped';
          row.last_error = reason;
          row.updated_at = nowIso;
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      }
      return { success: true, meta: { changes: 1 } };
    },
  });
  const env = {
    DB: { prepare } as unknown as D1Database,
    DELIVERY_QUEUE: { send: vi.fn(async (msg: unknown) => void queueSends.push(msg)) },
    CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
    ...(extra.vars ?? {}),
  } as unknown as Env;
  return { env, store, queueSends };
}

const TARGET = 'webhook:dead.socratictrade.com';

describe('targetKeyForUrl', () => {
  it('keys by kind + lowercase host and rejects unparseable urls', () => {
    expect(targetKeyForUrl('https://Hooks.Example.TEST/path?q=1')).toBe('webhook:hooks.example.test');
    expect(targetKeyForUrl('https://peer.example.test/x', 'peer-app')).toBe('peer-app:peer.example.test');
    expect(targetKeyForUrl('not a url')).toBeNull();
    expect(targetKeyForUrl(null)).toBeNull();
  });
});

describe('circuit lifecycle: open → hourly probe → close', () => {
  it('opens after the failure threshold with an exponential window', async () => {
    const { env, store } = circuitEnv();
    const now = new Date('2026-07-18T12:00:00.000Z');
    for (let i = 1; i < DEFAULT_TARGET_FAILURE_THRESHOLD; i++) {
      const record = await recordTargetFailure(env, TARGET, 'HTTP 401', now);
      expect(record?.opened).toBe(false);
    }
    const opened = await recordTargetFailure(env, TARGET, 'HTTP 401', now);
    expect(opened?.opened).toBe(true);
    expect(opened?.consecutiveFailures).toBe(DEFAULT_TARGET_FAILURE_THRESHOLD);
    // First open window = base backoff (60s), well under the 1h probe cap.
    const openUntil = Date.parse(store.circuits.get(TARGET)!.open_until!);
    expect(openUntil).toBe(now.getTime() + 60_000);

    // While open: every check is denied — nothing may touch the target.
    const gate = await checkTargetCircuit(env, TARGET, new Date(now.getTime() + 30_000));
    expect(gate.allowed).toBe(false);
    expect(gate).toMatchObject({ reason: 'circuit-open' });
  });

  it('admits exactly ONE probe per hour once the window elapses, then auto-closes on success', async () => {
    const { env, store } = circuitEnv();
    const now = new Date('2026-07-18T12:00:00.000Z');
    for (let i = 0; i < DEFAULT_TARGET_FAILURE_THRESHOLD; i++) {
      await recordTargetFailure(env, TARGET, 'HTTP 401', now);
    }
    const afterWindow = new Date(now.getTime() + 61_000);
    const probe = await checkTargetCircuit(env, TARGET, afterWindow);
    expect(probe).toEqual({ allowed: true, probe: true });
    // A later checker sees the probe LEASE as an open circuit and stays parked.
    const follower = await checkTargetCircuit(env, TARGET, afterWindow);
    expect(follower.allowed).toBe(false);
    expect(follower).toMatchObject({ reason: 'circuit-open' });
    // The probe lease itself caps probing at one per hour.
    const lease = Date.parse(store.circuits.get(TARGET)!.open_until!);
    expect(lease).toBe(afterWindow.getTime() + TARGET_PROBE_INTERVAL_SEC * 1000);

    // A TRUE concurrent contender — one that read the same expired window but
    // lost the atomic conditional claim — is denied as probe-contended.
    store.circuits.get(TARGET)!.open_until = afterWindow.toISOString();
    store.claimDenied = true;
    const contender = await checkTargetCircuit(env, TARGET, new Date(afterWindow.getTime() + 1000));
    expect(contender.allowed).toBe(false);
    expect(contender).toMatchObject({ reason: 'probe-contended' });
    store.claimDenied = false;
    store.circuits.get(TARGET)!.open_until = new Date(
      afterWindow.getTime() + TARGET_PROBE_INTERVAL_SEC * 1000,
    ).toISOString();

    // Probe 2xx → circuit closes; normal traffic flows again.
    await recordTargetSuccess(env, TARGET, afterWindow);
    const closed = await checkTargetCircuit(env, TARGET, afterWindow);
    expect(closed).toEqual({ allowed: true, probe: false });
    expect(store.circuits.get(TARGET)!.consecutive_failures).toBe(0);
  });

  it('enforces the daily failed-attempt cap as the hard backstop', async () => {
    const { env, store } = circuitEnv();
    const now = new Date('2026-07-18T12:00:00.000Z');
    await recordTargetFailure(env, TARGET, 'HTTP 401', now);
    const row = store.circuits.get(TARGET)!;
    row.failures_today = DEFAULT_TARGET_DAILY_ATTEMPT_CAP;
    row.open_until = null; // even with a closed circuit…
    const gate = await checkTargetCircuit(env, TARGET, now);
    expect(gate.allowed).toBe(false);
    expect(gate).toMatchObject({ reason: 'daily-cap' });
    // …until the next UTC day.
    const nextDay = new Date('2026-07-19T00:00:01.000Z');
    expect((await checkTargetCircuit(env, TARGET, nextDay)).allowed).toBe(true);
  });

  it('fails open when the circuit table is missing (pre-migration)', async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind() { return this; },
          async first() { throw new Error('no such table: delivery_target_circuit'); },
          async all() { throw new Error('no such table: delivery_target_circuit'); },
          async run() { throw new Error('no such table: delivery_target_circuit'); },
        }),
      } as unknown as D1Database,
    } as unknown as Env;
    expect(await checkTargetCircuit(env, TARGET)).toEqual({ allowed: true, probe: false });
  });
});

describe('parked-not-retried storm scenario (dispatchWebhook)', () => {
  const txRow = {
    id: 'tx_1', doc_id: 'doc_1', filer_id: 'bio_1', tx_date: freshDeliveryDay, owner: 'self',
    asset_name: 'Apple Inc.', ticker: 'AAPL', asset_type: 'stock', tx_type: 'B',
    amount_min: 1001, amount_max: 15000, is_option: 0, cap_gains_over_200: 0,
    raw_text: 'AAPL purchase', confidence: 0.99, source: 'primary',
    filed_date: freshDeliveryDay,
    first_seen_at: freshDeliveryIso,
    created_at: freshDeliveryIso, cursor_seq: 42,
  };
  const subRow = {
    id: 'sub_1', client_id: 'client_1', delivery: 'webhook',
    target_url: 'https://dead.socratictrade.com/hooks', secret: null, filters: '{}',
    cursor: 0, active: 1, created_at: '2026-06-20T00:00:00.000Z',
  };

  function webhookEnv(
    circuit: CircuitState,
    transactionRow: typeof txRow = txRow,
  ): { env: Env; store: FakeStore; fetchSpy: ReturnType<typeof vi.fn> } {
    const { env, store } = circuitEnv({ subscriptions: [subRow] });
    store.circuits.set(circuit.target_key, circuit);
    const baseDb = env.DB;
    const prepare = (sql: string) => {
      const stmt = (baseDb as unknown as { prepare: (sql: string) => any }).prepare(sql);
      const inner = {
        bind(...params: unknown[]) { stmt.bind(...params); return inner; },
        async first<T>() {
          if (/FROM transactions WHERE id = \?/i.test(sql)) return transactionRow as T;
          if (/SELECT chamber FROM filings/i.test(sql)) return { chamber: 'house' } as T;
          if (/FROM securities_ref/i.test(sql)) return { sector: 'Technology', market_cap_bucket: 'mega' } as T;
          if (/FROM subscriptions\s+WHERE id = \?/is.test(sql)) return subRow as T;
          return stmt.first();
        },
        async all<T>() {
          if (/active = 1 AND delivery = 'webhook' AND id > \?/i.test(sql)) return { results: [subRow] as T[] };
          return stmt.all();
        },
        async run() { return stmt.run(); },
      };
      return inner;
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    (env as { DB: unknown }).DB = { prepare } as unknown as D1Database;
    return { env, store, fetchSpy };
  }

  it('parks behind an open circuit: no HTTP attempt, no DeliveryRetryError, durable parked row', async () => {
    const openUntil = new Date(Date.now() + 30 * 60_000).toISOString();
    const { env, store, fetchSpy } = webhookEnv({
      target_key: TARGET,
      consecutive_failures: 5,
      open_until: openUntil,
      failures_day: new Date().toISOString().slice(0, 10),
      failures_today: 5,
      last_error: 'HTTP 401',
      updated_at: new Date().toISOString(),
    });
    try {
      let thrown: unknown = null;
      let result: Awaited<ReturnType<typeof dispatchWebhook>> | null = null;
      try {
        result = await dispatchWebhook(env, 'tx_1');
      } catch (err) {
        thrown = err;
      }
      // Parked means COMPLETED — never a DeliveryRetryError back into the queue.
      expect(thrown).toBeNull();
      expect(thrown).not.toBeInstanceOf(DeliveryRetryError);
      expect(result?.outboxComplete).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
    // No target HTTP attempt while the circuit is open.
    expect(fetchSpy).not.toHaveBeenCalled();
    // The delivery parked durably instead of throwing into a queue retry storm.
    expect(store.deliveries.get('sub_1:tx_1')).toMatchObject({ status: 'parked' });
    // Circuit failure count unchanged: a parked delivery is not an attempt.
    expect(store.circuits.get(TARGET)!.failures_today).toBe(5);
  });

  it('targeted redispatch clears parked rows when freshness filters reject the trade', async () => {
    const backfillTx = {
      ...txRow,
      id: 'tx_old',
      filed_date: '2020-01-01',
      tx_date: '2020-01-01',
      first_seen_at: freshDeliveryIso,
    };
    const { env, store, fetchSpy } = webhookEnv(
      {
        target_key: TARGET,
        consecutive_failures: 0,
        open_until: null,
        failures_day: new Date().toISOString().slice(0, 10),
        failures_today: 0,
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      backfillTx,
    );
    store.deliveries.set('sub_1:tx_old', {
      subscription_id: 'sub_1',
      tx_id: 'tx_old',
      status: 'parked',
      attempts: 0,
      last_error: 'target circuit: circuit-open',
    });
    try {
      await dispatchWebhook(env, {
        type: 'delivery.dispatch',
        txId: 'tx_old',
        subscriptionId: 'sub_1',
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.deliveries.get('sub_1:tx_old')).toMatchObject({
      status: 'skipped',
      last_error: 'subscription filters no longer match transaction',
    });
  });

  it('never resurrects a delivered row when parking', async () => {
    const { env, store } = circuitEnv();
    store.deliveries.set('sub_1:tx_9', {
      subscription_id: 'sub_1', tx_id: 'tx_9', status: 'delivered', attempts: 1, last_error: null,
    });
    expect(await parkDelivery(env, 'sub_1', 'tx_9', 'circuit-open')).toBe('skipped');
    expect(store.deliveries.get('sub_1:tx_9')!.status).toBe('delivered');
  });

  it('quarantines overflow past the parked-depth cap and alerts once', async () => {
    const { env, store } = circuitEnv({ vars: { DELIVERY_TARGET_PARKED_CAP: '2' } });
    expect(await parkDelivery(env, 'sub_1', 'tx_1', 'circuit-open')).toBe('parked');
    expect(await parkDelivery(env, 'sub_1', 'tx_2', 'circuit-open')).toBe('parked');
    expect(await parkDelivery(env, 'sub_1', 'tx_3', 'circuit-open')).toBe('quarantined');
    expect(store.deliveries.get('sub_1:tx_3')!.status).toBe('quarantined');
  });
});

describe('recoverQuarantinedDeliveries', () => {
  const sub = {
    id: 'sub_1', client_id: 'client_1', delivery: 'webhook',
    target_url: 'https://dead.socratictrade.com/hooks', active: 1,
  };

  it('recovers quarantined rows to parked when the target circuit is closed and headroom exists', async () => {
    const { env, store } = circuitEnv({ subscriptions: [sub], vars: { DELIVERY_TARGET_PARKED_CAP: '5' } });
    store.deliveries.set('sub_1:tx_q', {
      subscription_id: 'sub_1', tx_id: 'tx_q', status: 'quarantined', attempts: 0, last_error: 'overflow',
    });
    const result = await recoverQuarantinedDeliveries(env, { limit: 10 });
    expect(result).toMatchObject({ scanned: 1, recovered: 1, skipped: 0 });
    expect(store.deliveries.get('sub_1:tx_q')!.status).toBe('parked');
  });

  it('skips recovery while the target circuit is still open', async () => {
    const { env, store } = circuitEnv({ subscriptions: [sub] });
    const now = new Date('2026-07-18T12:00:00.000Z');
    store.circuits.set(TARGET, {
      target_key: TARGET,
      consecutive_failures: 6,
      open_until: new Date(now.getTime() + 3600_000).toISOString(),
      failures_day: '2026-07-18',
      failures_today: 6,
      last_error: 'HTTP 401',
      updated_at: now.toISOString(),
    });
    store.deliveries.set('sub_1:tx_q', {
      subscription_id: 'sub_1', tx_id: 'tx_q', status: 'quarantined', attempts: 0, last_error: 'overflow',
    });
    const result = await recoverQuarantinedDeliveries(env, { limit: 10, now });
    expect(result).toMatchObject({ scanned: 1, recovered: 0, skipped: 1 });
    expect(store.deliveries.get('sub_1:tx_q')!.status).toBe('quarantined');
  });

  it('honors ignoreCircuit for operator replay', async () => {
    const { env, store } = circuitEnv({ subscriptions: [sub] });
    const now = new Date('2026-07-18T12:00:00.000Z');
    store.circuits.set(TARGET, {
      target_key: TARGET,
      consecutive_failures: 6,
      open_until: new Date(now.getTime() + 3600_000).toISOString(),
      failures_day: '2026-07-18',
      failures_today: 6,
      last_error: 'HTTP 401',
      updated_at: now.toISOString(),
    });
    store.deliveries.set('sub_1:tx_q', {
      subscription_id: 'sub_1', tx_id: 'tx_q', status: 'quarantined', attempts: 0, last_error: 'overflow',
    });
    const result = await recoverQuarantinedDeliveries(env, { limit: 10, now, ignoreCircuit: true });
    expect(result.recovered).toBe(1);
    expect(store.deliveries.get('sub_1:tx_q')!.status).toBe('parked');
  });

  it('skips rows whose transaction is gone or retracted instead of re-parking them, even at the parked cap', async () => {
    const { env, store } = circuitEnv({ subscriptions: [sub], vars: { DELIVERY_TARGET_PARKED_CAP: '1' } });
    // Parked depth is at the cap, so no live row can be recovered...
    store.deliveries.set('sub_1:tx_parked', {
      subscription_id: 'sub_1', tx_id: 'tx_parked', status: 'parked', attempts: 0, last_error: null,
    });
    store.deliveries.set('sub_1:tx_gone', {
      subscription_id: 'sub_1', tx_id: 'tx_gone', status: 'quarantined', attempts: 0, last_error: 'overflow',
      updated_at: '2026-07-21T00:00:00.000Z',
    });
    store.deliveries.set('sub_1:tx_retracted', {
      subscription_id: 'sub_1', tx_id: 'tx_retracted', status: 'quarantined', attempts: 0, last_error: 'overflow',
      updated_at: '2026-07-21T00:01:00.000Z',
    });
    store.deliveries.set('sub_1:tx_live', {
      subscription_id: 'sub_1', tx_id: 'tx_live', status: 'quarantined', attempts: 0, last_error: 'overflow',
      updated_at: '2026-07-21T00:02:00.000Z',
    });
    store.missingTx.add('tx_gone');
    store.retractedTx.add('tx_retracted');

    // ...but undeliverable rows need no headroom: they leave the backlog for good.
    const result = await recoverQuarantinedDeliveries(env, { limit: 10 });
    expect(result).toMatchObject({ scanned: 3, terminalized: 2, recovered: 0, skipped: 1 });
    expect(store.deliveries.get('sub_1:tx_gone')).toMatchObject({
      status: 'skipped', last_error: 'transaction no longer exists',
    });
    expect(store.deliveries.get('sub_1:tx_retracted')).toMatchObject({
      status: 'skipped', last_error: 'transaction retracted',
    });
    expect(store.deliveries.get('sub_1:tx_live')!.status).toBe('quarantined');
  });

  it('reaches undeliverable rows behind live rows that cannot recover yet', async () => {
    const { env, store } = circuitEnv({ subscriptions: [sub] });
    const now = new Date('2026-07-18T12:00:00.000Z');
    store.circuits.set(TARGET, {
      target_key: TARGET,
      consecutive_failures: 6,
      open_until: new Date(now.getTime() + 3600_000).toISOString(),
      failures_day: '2026-07-18',
      failures_today: 6,
      last_error: 'HTTP 401',
      updated_at: now.toISOString(),
    });
    // The oldest row is live and the circuit is open, so it is declined and
    // keeps its updated_at.  A single oldest-first page of one would return it
    // every pass and never reach the swept row behind it.
    store.deliveries.set('sub_1:tx_live', {
      subscription_id: 'sub_1', tx_id: 'tx_live', status: 'quarantined', attempts: 0, last_error: 'overflow',
      updated_at: '2026-07-20T00:00:00.000Z',
    });
    store.deliveries.set('sub_1:tx_gone', {
      subscription_id: 'sub_1', tx_id: 'tx_gone', status: 'quarantined', attempts: 0, last_error: 'overflow',
      updated_at: '2026-07-21T00:00:00.000Z',
    });
    store.missingTx.add('tx_gone');

    const result = await recoverQuarantinedDeliveries(env, { limit: 1, now });
    expect(result).toMatchObject({ scanned: 2, terminalized: 1, recovered: 0, skipped: 1 });
    expect(store.deliveries.get('sub_1:tx_gone')!.status).toBe('skipped');
    expect(store.deliveries.get('sub_1:tx_live')!.status).toBe('quarantined');
  });

  it('counts undeliverable rows on a dryRun without writing', async () => {
    const { env, store } = circuitEnv({ subscriptions: [sub] });
    store.deliveries.set('sub_1:tx_gone', {
      subscription_id: 'sub_1', tx_id: 'tx_gone', status: 'quarantined', attempts: 0, last_error: 'overflow',
    });
    store.missingTx.add('tx_gone');
    const result = await recoverQuarantinedDeliveries(env, { limit: 10, dryRun: true });
    expect(result).toMatchObject({ scanned: 1, terminalized: 1, recovered: 0 });
    expect(store.deliveries.get('sub_1:tx_gone')!.status).toBe('quarantined');
  });
});

describe('quarantine auto-recovery gate (DELIVERY_TARGET_QUARANTINE_AUTO_RECOVER)', () => {
  const sub = {
    id: 'sub_1', client_id: 'client_1', delivery: 'webhook',
    target_url: 'https://dead.socratictrade.com/hooks', active: 1,
  };

  it('is an off-by-default truthy knob', () => {
    expect(quarantineAutoRecoverEnabled({} as Env)).toBe(false);
    expect(quarantineAutoRecoverEnabled({ DELIVERY_TARGET_QUARANTINE_AUTO_RECOVER: 'off' } as Env)).toBe(false);
    expect(quarantineAutoRecoverEnabled({ DELIVERY_TARGET_QUARANTINE_AUTO_RECOVER: 'true' } as Env)).toBe(true);
    expect(quarantineAutoRecoverEnabled({ DELIVERY_TARGET_QUARANTINE_AUTO_RECOVER: '1' } as Env)).toBe(true);
  });

  it('leaves live quarantined rows alone while off, but still skips the undeliverable rows behind them', async () => {
    const { env, store, queueSends } = circuitEnv({ subscriptions: [sub], vars: { DELIVERY_TARGET_PARKED_CAP: '5' } });
    // The live row is the OLDEST.  A scan that picked it up and declined it
    // would refill every page and never reach the swept row behind it.
    store.deliveries.set('sub_1:tx_live', {
      subscription_id: 'sub_1', tx_id: 'tx_live', status: 'quarantined', attempts: 0, last_error: 'overflow',
      updated_at: '2026-07-20T00:00:00.000Z',
    });
    store.deliveries.set('sub_1:tx_gone', {
      subscription_id: 'sub_1', tx_id: 'tx_gone', status: 'quarantined', attempts: 0, last_error: 'overflow',
      updated_at: '2026-07-21T00:00:00.000Z',
    });
    store.missingTx.add('tx_gone');

    const result = await flushParkedDeliveries(env, { limit: 1 });
    expect(result).toMatchObject({ quarantineRecovered: 0, quarantineTerminalized: 1, released: 0 });
    expect(store.deliveries.get('sub_1:tx_live')!.status).toBe('quarantined');
    expect(store.deliveries.get('sub_1:tx_gone')).toMatchObject({
      status: 'skipped', last_error: 'transaction no longer exists',
    });
    expect(queueSends).toHaveLength(0);
  });

  it('backs the undeliverable scan off for an hour after a pass that skips nothing', async () => {
    const { env, store } = circuitEnv({ subscriptions: [sub] });
    const t0 = new Date('2026-10-24T12:00:00.000Z');
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
    const quarantinedScans = () => store.scans.filter((sql) => /status = 'quarantined'/i.test(sql)).length;
    const quarantine = (txId: string) => store.deliveries.set(`sub_1:${txId}`, {
      subscription_id: 'sub_1', tx_id: txId, status: 'quarantined', attempts: 0, last_error: 'overflow',
      updated_at: '2026-07-21T00:00:00.000Z',
    });
    quarantine('tx_gone_1');
    store.missingTx.add('tx_gone_1');

    // A pass that skips rows keeps the scan running every tick.
    expect(await flushParkedDeliveries(env, { limit: 10, now: t0 })).toMatchObject({ quarantineTerminalized: 1 });
    expect(await flushParkedDeliveries(env, { limit: 10, now: at(1) })).toMatchObject({ quarantineTerminalized: 0 });
    expect(quarantinedScans()).toBe(2);

    // That empty pass backs it off: a row retracted now waits out the hour,
    // and the ticks in between run no quarantined scan at all.
    quarantine('tx_gone_2');
    store.retractedTx.add('tx_gone_2');
    expect(await flushParkedDeliveries(env, { limit: 10, now: at(2) })).toMatchObject({ quarantineTerminalized: 0 });
    expect(await flushParkedDeliveries(env, { limit: 10, now: at(60) })).toMatchObject({ quarantineTerminalized: 0 });
    expect(quarantinedScans()).toBe(2);
    expect(store.deliveries.get('sub_1:tx_gone_2')!.status).toBe('quarantined');

    // An explicit operator call is never backed off.
    quarantine('tx_gone_3');
    store.missingTx.add('tx_gone_3');
    expect(await recoverQuarantinedDeliveries(env, { limit: 10, now: at(3) })).toMatchObject({ terminalized: 2 });

    // The first scheduled pass after the hour scans again.
    quarantine('tx_gone_4');
    store.missingTx.add('tx_gone_4');
    expect(await flushParkedDeliveries(env, { limit: 10, now: at(61) })).toMatchObject({ quarantineTerminalized: 1 });
    expect(store.deliveries.get('sub_1:tx_gone_4')!.status).toBe('skipped');
  });

  it('re-parks and releases live quarantined rows when on', async () => {
    const { env, store, queueSends } = circuitEnv({
      subscriptions: [sub],
      vars: { DELIVERY_TARGET_PARKED_CAP: '5', DELIVERY_TARGET_QUARANTINE_AUTO_RECOVER: 'true' },
    });
    store.deliveries.set('sub_1:tx_live', {
      subscription_id: 'sub_1', tx_id: 'tx_live', status: 'quarantined', attempts: 0, last_error: 'overflow',
    });
    const result = await flushParkedDeliveries(env, { limit: 10 });
    expect(result).toMatchObject({ quarantineRecovered: 1, released: 1 });
    expect(queueSends).toEqual([{ type: 'delivery.dispatch', txId: 'tx_live', subscriptionId: 'sub_1' }]);
  });
});

describe('flushParkedDeliveries', () => {
  const sub = {
    id: 'sub_1', client_id: 'client_1', delivery: 'webhook',
    target_url: 'https://dead.socratictrade.com/hooks', active: 1,
  };

  it('releases the whole backlog once the target circuit is closed', async () => {
    const { env, store, queueSends } = circuitEnv({ subscriptions: [sub] });
    store.deliveries.set('sub_1:tx_1', { subscription_id: 'sub_1', tx_id: 'tx_1', status: 'parked', attempts: 0, last_error: null });
    store.deliveries.set('sub_1:tx_2', { subscription_id: 'sub_1', tx_id: 'tx_2', status: 'parked', attempts: 0, last_error: null });
    const result = await flushParkedDeliveries(env, { limit: 10 });
    expect(result).toMatchObject({ scanned: 2, released: 2 });
    expect(queueSends).toEqual([
      { type: 'delivery.dispatch', txId: 'tx_1', subscriptionId: 'sub_1' },
      { type: 'delivery.dispatch', txId: 'tx_2', subscriptionId: 'sub_1' },
    ]);
  });

  it('releases nothing while the circuit is open, and exactly one probe candidate once due', async () => {
    const { env, store, queueSends } = circuitEnv({ subscriptions: [sub] });
    store.deliveries.set('sub_1:tx_1', { subscription_id: 'sub_1', tx_id: 'tx_1', status: 'parked', attempts: 0, last_error: null });
    store.deliveries.set('sub_1:tx_2', { subscription_id: 'sub_1', tx_id: 'tx_2', status: 'parked', attempts: 0, last_error: null });
    const now = new Date('2026-07-18T12:00:00.000Z');
    store.circuits.set(TARGET, {
      target_key: TARGET,
      consecutive_failures: 6,
      open_until: new Date(now.getTime() + 3600_000).toISOString(),
      failures_day: '2026-07-18',
      failures_today: 6,
      last_error: 'HTTP 401',
      updated_at: now.toISOString(),
    });
    expect(await flushParkedDeliveries(env, { limit: 10, now })).toMatchObject({ released: 0, skipped: 2 });
    expect(queueSends).toHaveLength(0);

    // Window elapsed → exactly one probe candidate re-dispatches.
    const later = new Date(now.getTime() + 2 * 3600_000);
    expect(await flushParkedDeliveries(env, { limit: 10, now: later })).toMatchObject({ released: 1, skipped: 1 });
    expect(queueSends).toHaveLength(1);
  });

  it('skips swept or retracted rows in place so they cannot starve the live row behind them', async () => {
    const { env, store, queueSends } = circuitEnv({ subscriptions: [sub] });
    // The production wedge: the 50 oldest parked rows point at transactions the
    // July retention sweep deleted (one retracted here), and a live row waits
    // behind them.  Before the fix every flush re-released the same 50 forever.
    for (let i = 0; i < 50; i++) {
      const txId = `tx_orphan_${String(i).padStart(2, '0')}`;
      store.deliveries.set(`sub_1:${txId}`, {
        subscription_id: 'sub_1', tx_id: txId, status: 'parked', attempts: 0,
        last_error: 'target circuit: circuit-open',
        updated_at: `2026-07-21T00:${String(i).padStart(2, '0')}:00.000Z`,
      });
      if (i === 7) store.retractedTx.add(txId);
      else store.missingTx.add(txId);
    }
    store.deliveries.set('sub_1:tx_live', {
      subscription_id: 'sub_1', tx_id: 'tx_live', status: 'parked', attempts: 0,
      last_error: 'target circuit: circuit-open', updated_at: '2026-09-30T17:33:00.000Z',
    });

    const first = await flushParkedDeliveries(env, { limit: 50 });
    expect(first).toMatchObject({ scanned: 50, terminalized: 50, released: 0 });
    expect(queueSends).toHaveLength(0);
    expect(store.deliveries.get('sub_1:tx_orphan_00')).toMatchObject({
      status: 'skipped', last_error: 'transaction no longer exists',
    });
    expect(store.deliveries.get('sub_1:tx_orphan_07')).toMatchObject({
      status: 'skipped', last_error: 'transaction retracted',
    });

    const second = await flushParkedDeliveries(env, { limit: 50 });
    expect(second).toMatchObject({ scanned: 1, terminalized: 0, released: 1 });
    expect(queueSends).toEqual([{ type: 'delivery.dispatch', txId: 'tx_live', subscriptionId: 'sub_1' }]);
    // A released row is not touched (no updated_at bump), so the delivery
    // claim's compare-and-set on updated_at stays the only writer.
    expect(store.deliveries.get('sub_1:tx_live')).toMatchObject({
      status: 'parked', updated_at: '2026-09-30T17:33:00.000Z',
    });
  });

  it('skips undeliverable rows even while the target circuit is open', async () => {
    const { env, store, queueSends } = circuitEnv({ subscriptions: [sub] });
    const now = new Date('2026-07-18T12:00:00.000Z');
    store.circuits.set(TARGET, {
      target_key: TARGET,
      consecutive_failures: 6,
      open_until: new Date(now.getTime() + 3600_000).toISOString(),
      failures_day: '2026-07-18',
      failures_today: 6,
      last_error: 'HTTP 401',
      updated_at: now.toISOString(),
    });
    store.deliveries.set('sub_1:tx_gone', { subscription_id: 'sub_1', tx_id: 'tx_gone', status: 'parked', attempts: 0, last_error: null });
    store.deliveries.set('sub_1:tx_live', { subscription_id: 'sub_1', tx_id: 'tx_live', status: 'parked', attempts: 0, last_error: null });
    store.missingTx.add('tx_gone');
    expect(await flushParkedDeliveries(env, { limit: 10, now })).toMatchObject({ terminalized: 1, released: 0, skipped: 1 });
    expect(store.deliveries.get('sub_1:tx_gone')!.status).toBe('skipped');
    expect(store.deliveries.get('sub_1:tx_live')!.status).toBe('parked');
    expect(queueSends).toHaveLength(0);
  });
});
