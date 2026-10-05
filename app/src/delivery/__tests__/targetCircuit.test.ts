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
import {
  DEFAULT_TARGET_DAILY_ATTEMPT_CAP,
  DEFAULT_TARGET_FAILURE_THRESHOLD,
  TARGET_PROBE_INTERVAL_SEC,
  checkTargetCircuit,
  flushParkedDeliveries,
  parkDelivery,
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

interface FakeStore {
  circuits: Map<string, CircuitState>;
  deliveries: Map<string, { subscription_id: string; tx_id: string; status: string; attempts: number; last_error: string | null }>;
  runs: Array<{ sql: string; params: unknown[] }>;
  /** Simulate losing the atomic half-open probe claim race. */
  claimDenied: boolean;
}

/** Minimal D1 fake covering the circuit + park/flush SQL shapes. */
function circuitEnv(extra: { subscriptions?: Array<Record<string, unknown>>; vars?: Record<string, string> } = {}): {
  env: Env;
  store: FakeStore;
  queueSends: unknown[];
} {
  const store: FakeStore = { circuits: new Map(), deliveries: new Map(), runs: [], claimDenied: false };
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
        const rows: unknown[] = [];
        const wantQuarantined = /status = 'quarantined'/i.test(sql);
        const wantParked = /status = 'parked'/i.test(sql);
        for (const d of store.deliveries.values()) {
          if (wantQuarantined && d.status !== 'quarantined') continue;
          if (wantParked && d.status !== 'parked') continue;
          const sub = (extra.subscriptions ?? []).find((s) => s.id === d.subscription_id);
          if (!sub) continue;
          rows.push({ subscription_id: d.subscription_id, tx_id: d.tx_id, target_url: sub.target_url });
        }
        return { results: rows as T[] };
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
        const [, subscriptionId, txId, lastError] = this.params as [string, string, string, string];
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
        });
        return { success: true, meta: { changes: 1 } };
      }
      if (/UPDATE deliveries SET status = 'quarantined'/i.test(sql)) {
        const [, subscriptionId, txId] = this.params as [string, string, string];
        const row = store.deliveries.get(`${subscriptionId}:${txId}`);
        if (row) row.status = 'quarantined';
        return { success: true, meta: { changes: row ? 1 : 0 } };
      }
      if (/UPDATE deliveries\s+SET status = 'parked'/i.test(sql) && /status = 'quarantined'/i.test(sql)) {
        const [, subscriptionId, txId] = this.params as [string, string, string];
        const row = store.deliveries.get(`${subscriptionId}:${txId}`);
        if (row && row.status === 'quarantined') {
          row.status = 'parked';
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
    id: 'tx_1', doc_id: 'doc_1', filer_id: 'bio_1', tx_date: '2026-06-20', owner: 'self',
    asset_name: 'Apple Inc.', ticker: 'AAPL', asset_type: 'stock', tx_type: 'B',
    amount_min: 1001, amount_max: 15000, is_option: 0, cap_gains_over_200: 0,
    raw_text: 'AAPL purchase', confidence: 0.99, source: 'primary',
    created_at: '2026-06-20T00:00:00.000Z', cursor_seq: 42,
  };
  const subRow = {
    id: 'sub_1', client_id: 'client_1', delivery: 'webhook',
    target_url: 'https://dead.socratictrade.com/hooks', secret: null, filters: '{}',
    cursor: 0, active: 1, created_at: '2026-06-20T00:00:00.000Z',
  };

  function webhookEnv(circuit: CircuitState): { env: Env; store: FakeStore; fetchSpy: ReturnType<typeof vi.fn> } {
    const { env, store } = circuitEnv({ subscriptions: [subRow] });
    store.circuits.set(circuit.target_key, circuit);
    const baseDb = env.DB;
    const prepare = (sql: string) => {
      const stmt = (baseDb as unknown as { prepare: (sql: string) => any }).prepare(sql);
      const inner = {
        bind(...params: unknown[]) { stmt.bind(...params); return inner; },
        async first<T>() {
          if (/FROM transactions WHERE id = \?/i.test(sql)) return txRow as T;
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
});
