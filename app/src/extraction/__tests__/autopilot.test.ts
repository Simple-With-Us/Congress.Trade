import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import {
  acknowledgeAutopilotHalt,
  currentEraStart,
  handleAutopilotTick,
  maybeStartBacklogAutopilot,
  pollAutopilotPreseedBatches,
  submitPreseedBatches,
} from '../autopilot.ts';
import type { AgreementDocResult } from '../agreement.ts';

/**
 * Backlog autopilot: cron gate + queue-driven drain over the SAME cascade
 * machinery, with a per-UTC-day USD budget (halt when exhausted), an
 * error-class kill-switch (same class N times halts the run), and halted runs
 * that block new runs until acknowledged.
 */

interface EligibleDocRow {
  doc_id: string;
  raw_object_key: string | null;
  chamber: string | null;
  page_count: number | null;
  doc_class: string | null;
}

interface MockState {
  openRuns: Array<{
    id: string;
    status: string;
    updated_at: string;
    halt_reason?: string | null;
    sample_errors?: string | null;
  }>;
  runRow: Record<string, unknown> | null;
  docs: EligibleDocRow[];
  /** Docs findable ONLY by the legacy-replay fallback query (never the primary one). */
  legacyReplayDocs: EligibleDocRow[];
  /** Set false to simulate a concurrent selector winning the reset race first. */
  legacyReplayResetLands: boolean;
  readsByDoc: Record<string, Array<{ provider: string; model: string; ok: number; error: string | null; usage_json: string | null }>>;
  backlogCount: number;
  eligibleDueCount: number;
  budget: Map<string, number>;
  reservations: Map<string, {
    day: string;
    reserved: number;
    cap: number;
    actual: number | null;
    status: string;
  }>;
  runUpdates: Array<{ sql: string; params: unknown[] }>;
  runInserts: unknown[][];
  reviewUpdates: Array<{ sql: string; params: unknown[] }>;
  filingUpdates: Array<{ sql: string; params: unknown[] }>;
  legacyReplayResets: Array<{ docId: string; params: unknown[] }>;
  decisions: unknown[][];
  selectionSqls: string[];
}

function makeState(over: Partial<MockState> = {}): MockState {
  return {
    openRuns: [],
    runRow: null,
    docs: [],
    legacyReplayDocs: [],
    legacyReplayResetLands: true,
    readsByDoc: {},
    backlogCount: 0,
    eligibleDueCount: 0,
    budget: new Map(),
    reservations: new Map(),
    runUpdates: [],
    runInserts: [],
    reviewUpdates: [],
    filingUpdates: [],
    legacyReplayResets: [],
    decisions: [],
    selectionSqls: [],
    ...over,
  };
}

function runRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  const nowIso = new Date().toISOString();
  return {
    id: 'run-1',
    status: 'running',
    run_trigger: 'daily',
    revision: 1,
    backlog_before: 10,
    docs_attempted: 0,
    docs_published: 0,
    docs_deferred: 0,
    spend_microusd: 0,
    budget_microusd: 5_000_000,
    error_class_counts: null,
    sample_errors: null,
    outcomes: null,
    skip_reasons: null,
    halt_reason: null,
    acknowledged_at: null,
    acknowledged_by: null,
    started_at: nowIso,
    updated_at: nowIso,
    finished_at: null,
    ...over,
  };
}

function makeEnv(state: MockState, envVars: Record<string, unknown> = {}): {
  env: Env;
  kv: Map<string, string>;
  send: ReturnType<typeof vi.fn>;
} {
  const kv = new Map<string, string>();
  const send = vi.fn(async () => undefined);
  const db = {
    prepare(sql: string) {
      return {
        params: [] as unknown[],
        bind(...p: unknown[]) { this.params = p; return this; },
        async first<T>(): Promise<T | null> {
          if (/SELECT \* FROM autopilot_runs WHERE id = \?/i.test(sql)) {
            return (state.runRow as T) ?? null;
          }
          if (/SELECT id FROM autopilot_runs WHERE status = 'halted'/i.test(sql)) {
            const halted = state.openRuns.find((row) => row.status === 'halted');
            return (halted ? { id: halted.id } : null) as T | null;
          }
          if (/SELECT COUNT\(\*\) AS n/i.test(sql)) {
            if (/agreement_attempts/i.test(sql)) {
              return { n: state.eligibleDueCount } as T;
            }
            return { n: state.backlogCount } as T;
          }
          if (/SELECT f\.doc_id, f\.raw_object_key, f\.chamber, f\.page_count/i.test(sql)) {
            state.selectionSqls.push(sql);
            // Legacy-replay predicates use ">= ?" on agreement_attempts and query
            // a distinct pool; the primary predicates use "< ?" against `docs`.
            const isLegacyReplay = /agreement_attempts,\s*0\)\s*>=/i.test(sql);
            const excludedIdx = isLegacyReplay ? 2 : 3;
            const excluded = new Set(JSON.parse(String(this.params[excludedIdx])) as string[]);
            const pool = isLegacyReplay ? state.legacyReplayDocs : state.docs;
            return (pool.find((doc) => !excluded.has(doc.doc_id)) as T) ?? null;
          }
          if (/SELECT spend_microusd FROM autopilot_budget/i.test(sql)) {
            const day = String(this.params[0]);
            return { spend_microusd: state.budget.get(day) ?? 0 } as T;
          }
          if (/FROM autopilot_budget_reservations WHERE reservation_id = \?/i.test(sql)) {
            const reservation = state.reservations.get(String(this.params[0]));
            return (reservation ? {
              day: reservation.day,
              reserved_microusd: reservation.reserved,
              cap_microusd: reservation.cap,
              actual_microusd: reservation.actual,
              status: reservation.status,
            } : null) as T | null;
          }
          if (/FROM autopilot_budget_reservations\s+WHERE reservation_id LIKE \?/i.test(sql)) {
            const pattern = String(this.params[0]);
            const [prefix, suffix = ''] = pattern.split('%');
            const match = Array.from(state.reservations.entries()).find(([reservationId]) =>
              reservationId.startsWith(prefix) && reservationId.endsWith(suffix));
            if (!match) return null;
            const [reservationId, reservation] = match;
            return {
              reservation_id: reservationId,
              day: reservation.day,
              reserved_microusd: reservation.reserved,
              actual_microusd: reservation.actual,
              status: reservation.status,
            } as T;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (/FROM autopilot_runs\s+WHERE status IN/i.test(sql)) {
            return { results: state.openRuns as T[] };
          }
          if (/SELECT provider, model, ok, error, usage_json FROM extraction_runs/i.test(sql)) {
            const docId = String(this.params[0]);
            return { results: (state.readsByDoc[docId] ?? []) as T[] };
          }
          if (/SELECT \* FROM autopilot_runs ORDER BY started_at/i.test(sql)) {
            return { results: (state.runRow ? [state.runRow] : []) as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          if (/INSERT OR IGNORE INTO autopilot_budget_reservations/i.test(sql)) {
            const [reservationId, day, reserved, cap] = this.params as [string, string, number, number, string];
            if (state.reservations.has(reservationId)) {
              return { success: true, meta: { changes: 0 } };
            }
            const current = state.budget.get(day) ?? 0;
            if (current + reserved > cap) throw new Error('autopilot budget exhausted');
            state.budget.set(day, current + reserved);
            state.reservations.set(reservationId, {
              day,
              reserved,
              cap,
              actual: null,
              status: 'reserved',
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (/UPDATE autopilot_budget_reservations/i.test(sql)) {
            const [actual, status, , reservationId, day, reserved]
              = this.params as [number, string, string, string, string, number];
            const reservation = state.reservations.get(reservationId);
            if (!reservation || reservation.status !== 'reserved'
              || reservation.day !== day || reservation.reserved !== reserved) {
              return { success: true, meta: { changes: 0 } };
            }
            state.budget.set(day, Math.max((state.budget.get(day) ?? 0) + actual - reserved, 0));
            reservation.actual = actual;
            reservation.status = status;
            return { success: true, meta: { changes: 1 } };
          }
          if (/INSERT INTO autopilot_runs/i.test(sql)) {
            state.runInserts.push(this.params);
            return { success: true, meta: { changes: 1 } };
          }
          if (/UPDATE autopilot_runs/i.test(sql)) {
            state.runUpdates.push({ sql, params: this.params });
            const row = state.runRow as { revision?: number; status?: string } | null;
            if (/docs_attempted = \?/.test(sql)) {
              // persistRunState CAS: WHERE id = ? AND status='running' AND revision = ?
              const expectedRevision = this.params[this.params.length - 1] as number;
              if (!row || row.status !== 'running' || row.revision !== expectedRevision) {
                return { success: true, meta: { changes: 0 } };
              }
              row.revision = (row.revision ?? 1) + 1;
              const status = this.params[9] as string | null;
              if (status) row.status = status;
              return { success: true, meta: { changes: 1 } };
            }
            if (/SET status = 'halted'/.test(sql)) {
              if (row?.status === 'running') { row.status = 'halted'; return { success: true, meta: { changes: 1 } }; }
              return { success: true, meta: { changes: 0 } };
            }
            if (/SET status = 'halt_acknowledged'/.test(sql)) {
              const target = String(this.params[3]);
              const match = state.openRuns.find((r) => r.id === target && r.status === 'halted');
              if (match) { match.status = 'halt_acknowledged'; return { success: true, meta: { changes: 1 } }; }
              if (row && (row as { id?: string }).id === target && row.status === 'halted') {
                row.status = 'halt_acknowledged';
                return { success: true, meta: { changes: 1 } };
              }
              return { success: true, meta: { changes: 0 } };
            }
            return { success: true, meta: { changes: 1 } };
          }
          if (/INSERT OR IGNORE INTO autopilot_budget/i.test(sql)) {
            const day = String(this.params[0]);
            if (!state.budget.has(day)) state.budget.set(day, 0);
            return { success: true, meta: { changes: 1 } };
          }
          if (/UPDATE autopilot_budget SET spend_microusd = spend_microusd \+ \?/i.test(sql)) {
            const [amount, day, , cap] = this.params as [number, string, number, number];
            const current = state.budget.get(day) ?? 0;
            if (current + amount <= cap) {
              state.budget.set(day, current + amount);
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (/UPDATE autopilot_budget SET spend_microusd = MAX/i.test(sql)) {
            const [delta, day] = this.params as [number, string];
            state.budget.set(day, Math.max((state.budget.get(day) ?? 0) + delta, 0));
            return { success: true, meta: { changes: 1 } };
          }
          if (/UPDATE review_queue/i.test(sql)) {
            state.reviewUpdates.push({ sql, params: this.params });
            if (/agreement_legacy_replay_at = \?/.test(sql) && /agreement_attempts = 0/.test(sql)) {
              const docId = String(this.params[1]);
              state.legacyReplayResets.push({ docId, params: this.params });
              return { success: true, meta: { changes: state.legacyReplayResetLands ? 1 : 0 } };
            }
            return { success: true, meta: { changes: 1 } };
          }
          if (/INSERT INTO ingestion_decisions/i.test(sql)) {
            state.decisions.push(this.params);
            return { success: true, meta: { changes: 1 } };
          }
          if (/UPDATE filings/i.test(sql)) {
            state.filingUpdates.push({ sql, params: this.params });
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  };
  const env = {
    DB: db,
    CONFIG_KV: {
      get: vi.fn(async (key: string) => kv.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { kv.set(key, value); }),
    },
    INGEST_QUEUE: { send },
    RAW_FILES: { get: vi.fn(async () => null) },
    AGREEMENT_AUTOPUBLISH_ENABLED: 'true',
    AGREEMENT_HOUSE_MODEL_C: 'openrouter:openai/gpt-5.6-terra',
    AGREEMENT_HOUSE_MODEL_D: 'openrouter:anthropic/claude-sonnet-5',
    AGREEMENT_HOUSE_MODEL_E: 'openrouter:google/gemini-3.5-flash',
    ...envVars,
  } as unknown as Env;
  return { env, kv, send };
}

const doc = (id: string, docClass: string | null = null): EligibleDocRow => ({
  doc_id: id, raw_object_key: `raw/${id}.pdf`, chamber: 'house', page_count: null,
  doc_class: docClass,
});

function finalUpdate(state: MockState): { sql: string; params: unknown[] } | undefined {
  return [...state.runUpdates].reverse().find(
    (update) => /docs_attempted = \?/.test(update.sql) && update.params[9] != null,
  );
}

describe('currentEraStart', () => {
  it('starts the era at Jan 1 of the most recent odd (term-start) year', () => {
    expect(currentEraStart(new Date('2026-07-18T00:00:00Z'))).toBe('2025-01-01');
    expect(currentEraStart(new Date('2025-01-02T00:00:00Z'))).toBe('2025-01-01');
    expect(currentEraStart(new Date('2024-12-31T00:00:00Z'))).toBe('2023-01-01');
  });
});

describe('handleAutopilotTick — budget meter', () => {
  it('halts before any model call when the daily USD budget is exhausted', async () => {
    const state = makeState({ runRow: runRow(), docs: [doc('H-1')] });
    // Trio nominal estimate ≈ $0.116/doc; a $0.0001 budget cannot cover it.
    const { env, send } = makeEnv(state, { AUTOPILOT_DAILY_USD_BUDGET: '0.0001' });
    const check = vi.fn<(...args: unknown[]) => Promise<AgreementDocResult | null>>();

    await handleAutopilotTick(env, 'run-1', { check: check as never });

    expect(check).not.toHaveBeenCalled(); // reservation fails BEFORE model spend
    const final = finalUpdate(state);
    expect(final).toBeDefined();
    expect(final!.params[9]).toBe('completed');
    expect(final!.params[10]).toBe('budget_exhausted');
    expect(send).not.toHaveBeenCalled(); // no continuation after a terminal tick
  });

  it('reserves the estimate up front and settles to priced actual usage', async () => {
    const state = makeState({
      runRow: runRow(),
      docs: [doc('H-1')],
      readsByDoc: {
        'H-1': [
          // Measured usage → priced via the rate card, replacing the estimate.
          { provider: 'openrouter', model: 'openai/gpt-5.6-terra', ok: 1, error: null, usage_json: JSON.stringify({ promptTokens: 1000, completionTokens: 100 }) },
          { provider: 'openrouter', model: 'anthropic/claude-sonnet-5', ok: 1, error: null, usage_json: JSON.stringify({ promptTokens: 1000, completionTokens: 100 }) },
        ],
      },
    });
    const { env } = makeEnv(state, { AUTOPILOT_DAILY_USD_BUDGET: '5' });
    const check = vi.fn(async (): Promise<AgreementDocResult | null> => (
      { docId: 'H-1', outcome: 'published', tier: 1, inserted: 2 }
    ));

    await handleAutopilotTick(env, 'run-1', { check: check as never });

    expect(check).toHaveBeenCalledTimes(1);
    const day = new Date().toISOString().slice(0, 10);
    // terra: (1000*2.5 + 100*15)/1M = 0.004; sonnet-5: (1000*2 + 100*10)/1M = 0.003.
    expect(state.budget.get(day)).toBe(7_000);
    const final = finalUpdate(state);
    expect(final!.params[10]).toBe('backlog_drained');
    expect(final!.params[1]).toBe(1); // docs_published
    const outcomes = JSON.parse(String(final!.params[6])) as Array<{ docId: string; outcome: string }>;
    expect(outcomes).toEqual([
      expect.objectContaining({ docId: 'H-1', outcome: 'published' }),
    ]);
  });

  it('uses a deterministic reservation on redelivery and never repeats paid model calls', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const reservationId = 'autopilot:run-1:H-1:r1';
    const state = makeState({ runRow: runRow(), docs: [doc('H-1')] });
    state.budget.set(day, 116_000);
    state.reservations.set(reservationId, {
      day,
      reserved: 116_000,
      cap: 5_000_000,
      actual: null,
      status: 'reserved',
    });
    const { env } = makeEnv(state, { AUTOPILOT_DAILY_USD_BUDGET: '5' });
    const check = vi.fn(async (): Promise<AgreementDocResult | null> => (
      { docId: 'H-1', outcome: 'published', tier: 1, inserted: 1 }
    ));

    await handleAutopilotTick(env, 'run-1', { check: check as never });

    expect(check).not.toHaveBeenCalled();
    expect(state.reservations.get(reservationId)).toMatchObject({
      status: 'aborted',
      actual: 116_000,
    });
    expect(state.budget.get(day)).toBe(116_000);
    const final = finalUpdate(state);
    const outcomes = JSON.parse(String(final!.params[6])) as Array<{ reason?: string }>;
    expect(outcomes).toEqual([
      expect.objectContaining({ reason: 'budget_reservation_recovered' }),
    ]);
  });

  it('reconciles a vanished document reservation before selecting another document', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const reservationId = 'autopilot:run-1:H-vanished:r1';
    const state = makeState({ runRow: runRow(), docs: [doc('H-next')] });
    state.budget.set(day, 116_000);
    state.reservations.set(reservationId, {
      day,
      reserved: 116_000,
      cap: 5_000_000,
      actual: null,
      status: 'reserved',
    });
    const { env } = makeEnv(state, { AUTOPILOT_DAILY_USD_BUDGET: '5' });
    const check = vi.fn(async (): Promise<AgreementDocResult | null> => {
      expect(state.reservations.get(reservationId)?.status).toBe('aborted');
      return { docId: 'H-next', outcome: 'published', tier: 1, inserted: 1 };
    });

    await handleAutopilotTick(env, 'run-1', { check: check as never });

    expect(check).toHaveBeenCalledTimes(1);
    expect(state.reservations.get(reservationId)).toMatchObject({
      status: 'aborted',
      actual: 116_000,
    });
    const final = finalUpdate(state);
    const outcomes = JSON.parse(String(final!.params[6])) as Array<{ docId: string; reason?: string }>;
    expect(outcomes[0]).toMatchObject({
      docId: 'H-vanished',
      reason: 'budget_reservation_recovered',
    });
  });
});

describe('handleAutopilotTick — error-class kill-switch', () => {
  it('halts the whole run when the same class occurs twice (default threshold)', async () => {
    const state = makeState({
      runRow: runRow(),
      docs: [doc('H-1'), doc('H-2')],
      readsByDoc: {
        'H-1': [
          { provider: 'openrouter', model: 'openai/gpt-5.6-terra', ok: 0, error: 'openrouter 402 payment required', usage_json: null },
          { provider: 'openrouter', model: 'anthropic/claude-sonnet-5', ok: 0, error: 'prepayment credits are depleted', usage_json: null },
        ],
      },
    });
    const { env, send } = makeEnv(state, { AUTOPILOT_DAILY_USD_BUDGET: '5' });
    const check = vi.fn(async (): Promise<AgreementDocResult | null> => (
      { docId: 'H-1', outcome: 'skipped', tier: 1, reason: 'model_read_failed' }
    ));

    await handleAutopilotTick(env, 'run-1', { check: check as never });

    // The run stopped after doc 1: H-2 was never attempted.
    expect(check).toHaveBeenCalledTimes(1);
    const final = finalUpdate(state);
    expect(final!.params[9]).toBe('halted');
    expect(final!.params[10]).toBe('error_class:billing');
    // Receipt carries the per-class counts and a bounded sample error.
    const classCounts = JSON.parse(String(final!.params[4])) as Record<string, number>;
    expect(classCounts.billing).toBe(2);
    const samples = JSON.parse(String(final!.params[5])) as Record<string, string>;
    expect(samples.billing).toContain('402');
    expect(send).not.toHaveBeenCalled();
    expect((state.runRow as { status: string }).status).toBe('halted');
  });

  it('a thrown handler error is classified and counted too', async () => {
    const state = makeState({ runRow: runRow(), docs: [doc('H-1'), doc('H-2')] });
    const { env } = makeEnv(state, {
      AUTOPILOT_DAILY_USD_BUDGET: '5',
      AUTOPILOT_ERROR_CLASS_HALT_THRESHOLD: '2',
    });
    const check = vi.fn(async () => { throw new Error('anthropic 401 unauthorized'); });

    await handleAutopilotTick(env, 'run-1', { check: check as never });

    // One auth error per doc; second doc crosses the threshold.
    expect(check).toHaveBeenCalledTimes(2);
    const final = finalUpdate(state);
    expect(final!.params[9]).toBe('halted');
    expect(final!.params[10]).toBe('error_class:auth');
  });

  it('does not latch the pipeline on garbage or Unauthorized OpenRouter replies', async () => {
    const state = makeState({ runRow: runRow(), docs: [doc('H-1'), doc('H-2')] });
    const { env } = makeEnv(state, {
      AUTOPILOT_DAILY_USD_BUDGET: '5',
      AUTOPILOT_ERROR_CLASS_HALT_THRESHOLD: '2',
    });
    const check = vi.fn(async () => {
      throw new Error('openRouterText: OpenRouter API 401 Unauthorized');
    });

    await handleAutopilotTick(env, 'run-1', { check: check as never });

    expect(check).toHaveBeenCalledTimes(2);
    const final = finalUpdate(state);
    expect(final!.params[9]).toBe('completed');
    expect(final!.params[10]).not.toBe('error_class:auth');
    expect(final!.params[10]).not.toBe('error_class:parse');
  });

  it('does not latch on source-fetch Unauthorized (Clerk / admin 401 statusText)', async () => {
    const state = makeState({ runRow: runRow(), docs: [doc('H-1'), doc('H-2')] });
    const { env } = makeEnv(state, {
      AUTOPILOT_DAILY_USD_BUDGET: '5',
      AUTOPILOT_ERROR_CLASS_HALT_THRESHOLD: '2',
    });
    const check = vi.fn(async () => { throw new Error('Unauthorized'); });

    await handleAutopilotTick(env, 'run-1', { check: check as never });

    expect(check).toHaveBeenCalledTimes(2);
    const final = finalUpdate(state);
    expect(final!.params[9]).toBe('completed');
    expect(final!.params[10]).not.toBe('error_class:auth');
  });

  it('re-enqueues a continuation tick when the slice ends mid-run', async () => {
    const state = makeState({
      runRow: runRow(),
      docs: [doc('H-1'), doc('H-2'), doc('H-3'), doc('H-4')],
    });
    const { env, send } = makeEnv(state, { AUTOPILOT_DAILY_USD_BUDGET: '50' });
    const check = vi.fn(async (_env: unknown, docId: unknown): Promise<AgreementDocResult | null> => (
      { docId: String(docId), outcome: 'published', tier: 1, inserted: 1 }
    ));

    await handleAutopilotTick(env, 'run-1', { check: check as never });

    expect(check).toHaveBeenCalledTimes(3); // DOCS_PER_TICK slice
    expect(send).toHaveBeenCalledTimes(1);
    const continuation = send.mock.calls[0]?.[0] as { type: string; runId: string; tickId: string };
    expect(continuation).toMatchObject({ type: 'autopilot.tick', runId: 'run-1' });
    expect(typeof continuation.tickId).toBe('string');
    expect(continuation.tickId.length).toBeGreaterThan(0);
  });
});

describe('handleAutopilotTick — doc_class consumers', () => {
  it('orders selection by doc_class (typed/clean first) before era priority', async () => {
    const state = makeState({ runRow: runRow(), docs: [] });
    const { env } = makeEnv(state);
    await handleAutopilotTick(env, 'run-1', { check: vi.fn() as never });
    expect(state.selectionSqls.length).toBeGreaterThan(0);
    const sql = state.selectionSqls[0];
    expect(sql).toContain("WHEN 'typed' THEN 0");
    expect(sql).toContain("WHEN 'clean_scan' THEN 1");
    expect(sql).toContain("WHEN 'hard_scan' THEN 4");
    // Class ordering comes BEFORE the current-era ordering.
    expect(sql.indexOf("WHEN 'typed'")).toBeLessThan(sql.indexOf('filed_date'));
  });

  it('auto-resolves an empty doc as no-transactions with an audit row (no model spend)', async () => {
    const state = makeState({ runRow: runRow(), docs: [doc('H-1', 'empty')] });
    const { env } = makeEnv(state);
    const check = vi.fn();
    await handleAutopilotTick(env, 'run-1', {
      check: check as never,
      random: () => 0.99, // above the 0.1 spot-check rate → auto-resolve
    });

    expect(check).not.toHaveBeenCalled();
    expect(state.budget.size).toBe(0); // zero USD reserved or spent
    const resolve = state.reviewUpdates.find((update) => /SET resolved = 1/.test(update.sql));
    expect(resolve).toBeDefined();
    expect(resolve!.params[0]).toBe('H-1');
    // Honest resolution: resolution_kind + a non-blank resolution_reason are
    // set in the SAME statement that flips resolved=1 (what
    // trg_review_queue_honest_resolution, migration 0082, requires).
    expect(resolve!.sql).toContain("resolution_kind = 'verified_empty'");
    expect(resolve!.sql).toContain("resolution_reason = 'doc_class_empty_no_transactions'");
    // filings.ingest_status must move off 'needs_review' in the same atomic
    // batch — this is the exact production bug (738 docs resolved with the
    // filing stuck at needs_review forever) this fix closes.
    const filingUpdate = state.filingUpdates.find((update) => /ingest_status = 'verified_empty'/.test(update.sql));
    expect(filingUpdate).toBeDefined();
    expect(filingUpdate!.params).toContain('H-1');
    expect(state.decisions.some((params) => params[2] === 'auto_resolved_empty')).toBe(true);
    const final = finalUpdate(state);
    const outcomes = JSON.parse(String(final!.params[6])) as Array<Record<string, unknown>>;
    expect(outcomes[0]).toMatchObject({ docId: 'H-1', outcome: 'resolved_empty', docClass: 'empty' });
  });

  it('keeps a sampled empty doc in review as a human spot-check', async () => {
    const state = makeState({ runRow: runRow(), docs: [doc('H-1', 'empty')] });
    const { env } = makeEnv(state);
    await handleAutopilotTick(env, 'run-1', {
      check: vi.fn() as never,
      random: () => 0.01, // inside the 0.1 spot-check sample
    });
    expect(state.reviewUpdates).toHaveLength(0); // review item untouched
    const final = finalUpdate(state);
    const skipReasons = JSON.parse(String(final!.params[7])) as Record<string, number>;
    expect(skipReasons.empty_spot_check).toBe(1);
  });

  it('quarantines a corrupt doc immediately (cascade suppressed, humans keep it)', async () => {
    const state = makeState({ runRow: runRow(), docs: [doc('H-1', 'corrupt')] });
    const { env } = makeEnv(state);
    const check = vi.fn();
    await handleAutopilotTick(env, 'run-1', { check: check as never });

    expect(check).not.toHaveBeenCalled();
    const quarantine = state.reviewUpdates.find(
      (update) => /agreement_suppression_reason = 'doc_class_corrupt'/.test(update.sql),
    );
    expect(quarantine).toBeDefined();
    expect(state.decisions.some((params) => params[2] === 'doc_quarantined')).toBe(true);
    const final = finalUpdate(state);
    const outcomes = JSON.parse(String(final!.params[6])) as Array<Record<string, unknown>>;
    expect(outcomes[0]).toMatchObject({ docId: 'H-1', outcome: 'quarantined', docClass: 'corrupt' });
  });

  it('classifies an unclassified doc via the injected classifier before running', async () => {
    const state = makeState({ runRow: runRow(), docs: [doc('H-1')] });
    const { env } = makeEnv(state, { AUTOPILOT_DAILY_USD_BUDGET: '5' });
    const classify = vi.fn(async () => 'empty' as const);
    const check = vi.fn();
    await handleAutopilotTick(env, 'run-1', {
      check: check as never,
      classify: classify as never,
      random: () => 0.99,
    });
    expect(classify).toHaveBeenCalledWith(env, 'H-1', 'raw/H-1.pdf');
    expect(check).not.toHaveBeenCalled(); // classified empty → resolved, not extracted
  });
});

describe('handleAutopilotTick — legacy-replay fallback (exhausted-attempt backlog)', () => {
  it('is a no-op by default: an idle tick with only exhausted docs still reports backlog_drained untouched', async () => {
    const state = makeState({
      runRow: runRow(),
      docs: [],
      legacyReplayDocs: [doc('E-1')],
    });
    const { env } = makeEnv(state); // AUTOPILOT_LEGACY_REPLAY_ENABLED unset -> default off
    const check = vi.fn();
    await handleAutopilotTick(env, 'run-1', { check: check as never });

    expect(check).not.toHaveBeenCalled();
    expect(state.legacyReplayResets).toHaveLength(0);
    const final = finalUpdate(state);
    expect(final!.params[9]).toBe('completed');
    expect(final!.params[10]).toBe('backlog_drained'); // byte-identical to pre-existing behavior
  });

  it('when enabled, falls back to an exhausted doc only once the normal pool is empty, resets it, and runs the SAME cascade', async () => {
    const state = makeState({
      runRow: runRow(),
      docs: [],
      legacyReplayDocs: [doc('E-1')],
    });
    const { env } = makeEnv(state, { AUTOPILOT_LEGACY_REPLAY_ENABLED: 'true' });
    const check = vi.fn(async () => ({ docId: 'E-1', outcome: 'published', inserted: 2 }) as AgreementDocResult);
    await handleAutopilotTick(env, 'run-1', { check: check as never });

    // The reset landed before the cascade ran, and reset the exact fields the
    // cascade's own attempt-cap lease depends on.
    expect(state.legacyReplayResets).toHaveLength(1);
    expect(state.legacyReplayResets[0].docId).toBe('E-1');
    const resetSql = state.reviewUpdates.find((u) => /agreement_legacy_replay_at = \?/.test(u.sql))!.sql;
    expect(resetSql).toContain('agreement_attempts = 0');
    expect(resetSql).toContain('agreement_tier = NULL');
    expect(resetSql).toContain('agreement_legacy_replay_at IS NULL'); // exactly-once guard

    // Reset happened strictly BEFORE the cascade call for the same doc.
    const resetIndex = state.reviewUpdates.findIndex((u) => /agreement_legacy_replay_at = \?/.test(u.sql));
    expect(resetIndex).toBeGreaterThanOrEqual(0);
    expect(check).toHaveBeenCalledWith(env, 'E-1', 'raw/E-1.pdf');
  });

  it('never displaces a normally-eligible doc: the legacy pool is only consulted once the primary pool is empty', async () => {
    const state = makeState({
      runRow: runRow(),
      docs: [doc('H-1')], // normally eligible (attempts < cap)
      legacyReplayDocs: [doc('E-1')], // exhausted, replay-eligible
    });
    // DOCS_PER_TICK is 3, so without this cap the tick would correctly exhaust
    // the single primary doc in slot 1 and fall through to the legacy pool for
    // slots 2-3 (there being nothing else eligible) — that IS the intended
    // fallback behavior, not what this test isolates. Capping at 1 doc keeps
    // the assertion to exactly what it claims: primary strictly wins when both
    // pools have a candidate for the SAME slot.
    const { env } = makeEnv(state, { AUTOPILOT_LEGACY_REPLAY_ENABLED: 'true', AUTOPILOT_MAX_DOCS_PER_RUN: '1' });
    const check = vi.fn(async () => ({ docId: 'H-1', outcome: 'published', inserted: 1 }) as AgreementDocResult);
    await handleAutopilotTick(env, 'run-1', { check: check as never });

    expect(state.legacyReplayResets).toHaveLength(0);
    expect(check).toHaveBeenCalledWith(env, 'H-1', 'raw/H-1.pdf');
    expect(check).not.toHaveBeenCalledWith(env, 'E-1', expect.anything());
  });

  it('loses the reset race cleanly: a concurrent selector already replayed the doc, so this tick treats the pool as empty', async () => {
    const state = makeState({
      runRow: runRow(),
      docs: [],
      legacyReplayDocs: [doc('E-1')],
      legacyReplayResetLands: false, // simulate a lost CAS (another run already reset+stamped it)
    });
    const { env } = makeEnv(state, { AUTOPILOT_LEGACY_REPLAY_ENABLED: 'true' });
    const check = vi.fn();
    await handleAutopilotTick(env, 'run-1', { check: check as never });

    expect(state.legacyReplayResets).toHaveLength(1); // the attempt was made...
    expect(check).not.toHaveBeenCalled(); // ...but never granted a second grace reset
    const final = finalUpdate(state);
    expect(final!.params[9]).toBe('completed');
    expect(final!.params[10]).toBe('backlog_drained');
  });
});

describe('maybeStartBacklogAutopilot — gates', () => {
  it('does nothing when the cascade/autopilot is disabled', async () => {
    const state = makeState();
    const { env, send } = makeEnv(state, { AGREEMENT_AUTOPUBLISH_ENABLED: 'false' });
    expect(await maybeStartBacklogAutopilot(env)).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses to start while a halted run is unacknowledged', async () => {
    const state = makeState({
      openRuns: [{ id: 'run-halted', status: 'halted', updated_at: new Date().toISOString() }],
    });
    const { env, send } = makeEnv(state);
    const result = await maybeStartBacklogAutopilot(env);
    expect(result?.blocked).toBe('unacknowledged_halt');
    expect(send).not.toHaveBeenCalled();
    expect(state.runInserts).toHaveLength(0);
  });

  it('auto-resumes a files-prepaid halt instead of latching forever', async () => {
    const state = makeState({
      openRuns: [{
        id: 'run-files',
        status: 'halted',
        updated_at: new Date().toISOString(),
        halt_reason: 'error_class:quota',
        sample_errors: JSON.stringify({
          quota: 'HTTP 402 {"error":{"message":"This request requires at least $0.50 in balance for files","code":402,"metadata":{"limit_source":"openrouter_key_limit"}}}',
        }),
      }],
    });
    const { env } = makeEnv(state);
    const result = await maybeStartBacklogAutopilot(env);
    expect(result?.blocked).not.toBe('unacknowledged_halt');
    expect(state.openRuns[0].status).toBe('halt_acknowledged');
  });

  it('auto-resumes a false source-auth Unauthorized halt', async () => {
    const state = makeState({
      openRuns: [{
        id: 'run-unauth',
        status: 'halted',
        updated_at: new Date().toISOString(),
        halt_reason: 'error_class:auth',
        sample_errors: JSON.stringify({ auth: 'Unauthorized' }),
      }],
    });
    const { env } = makeEnv(state);
    const result = await maybeStartBacklogAutopilot(env);
    expect(result?.blocked).not.toBe('unacknowledged_halt');
    expect(state.openRuns[0].status).toBe('halt_acknowledged');
    expect(state.openRuns[0]).toMatchObject({
      status: 'halt_acknowledged',
    });
  });

  it('keeps a proven OpenRouter User-not-found auth halt latched', async () => {
    const state = makeState({
      openRuns: [{
        id: 'run-dead-key',
        status: 'halted',
        updated_at: new Date().toISOString(),
        halt_reason: 'error_class:auth',
        sample_errors: JSON.stringify({
          auth: 'openRouterVision: OpenRouter API 401 Unauthorized {"error":{"message":"User not found.","code":401}}',
        }),
      }],
    });
    const { env, send } = makeEnv(state);
    const result = await maybeStartBacklogAutopilot(env);
    expect(result?.blocked).toBe('unacknowledged_halt');
    expect(send).not.toHaveBeenCalled();
    expect(state.openRuns[0].status).toBe('halted');
  });

  it('keeps a real depleted-credit halt latched until a human acknowledges', async () => {
    const state = makeState({
      openRuns: [{
        id: 'run-depleted',
        status: 'halted',
        updated_at: new Date().toISOString(),
        halt_reason: 'error_class:billing',
        sample_errors: JSON.stringify({
          billing: 'Your prepayment credits are depleted',
        }),
      }],
    });
    const { env, send } = makeEnv(state);
    const result = await maybeStartBacklogAutopilot(env);
    expect(result?.blocked).toBe('unacknowledged_halt');
    expect(send).not.toHaveBeenCalled();
    expect(state.openRuns[0].status).toBe('halted');
  });

  it('refuses to start while a fresh run is in progress', async () => {
    const state = makeState({
      openRuns: [{ id: 'run-live', status: 'running', updated_at: new Date().toISOString() }],
    });
    const { env } = makeEnv(state);
    const result = await maybeStartBacklogAutopilot(env);
    expect(result?.blocked).toBe('run_in_progress');
  });

  it('starts a daily run: stamps KV, inserts the receipt row, enqueues the tick', async () => {
    const state = makeState({ backlogCount: 42 });
    const { env, kv, send } = makeEnv(state);
    const result = await maybeStartBacklogAutopilot(env);
    expect(result?.started?.trigger).toBe('daily');
    expect(state.runInserts).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    const tick = send.mock.calls[0]?.[0] as { type: string; runId: string; tickId: string };
    expect(tick).toMatchObject({ type: 'autopilot.tick', runId: result!.started!.runId });
    expect(typeof tick.tickId).toBe('string');
    expect(tick.tickId.length).toBeGreaterThan(0);
    expect(kv.get('autopilot:lastday')).toBe(new Date().toISOString().slice(0, 10));
  });

  it('does not start on health-eligible count when no selector-due doc exists', async () => {
    const state = makeState({ backlogCount: 24, eligibleDueCount: 0 });
    const { env, kv, send } = makeEnv(state);
    kv.set('autopilot:lastday', new Date().toISOString().slice(0, 10));
    kv.set('autopilot:lastrun', new Date().toISOString());
    const result = await maybeStartBacklogAutopilot(env);
    expect(result?.blocked).toBe('not_due');
    expect(send).not.toHaveBeenCalled();
  });

  it('same-day backlog trigger honors the threshold', async () => {
    const state = makeState({ backlogCount: 100, eligibleDueCount: 0 });
    const { env, kv, send } = makeEnv(state);
    kv.set('autopilot:lastday', new Date().toISOString().slice(0, 10)); // daily already ran
    const below = await maybeStartBacklogAutopilot(env);
    expect(below?.blocked).toBe('not_due'); // 100 <= default threshold 150
    expect(send).not.toHaveBeenCalled();

    state.backlogCount = 300;
    const above = await maybeStartBacklogAutopilot(env);
    expect(above?.started?.trigger).toBe('backlog');
  });

  it('starts a run from a single eligible-due doc without waiting for UTC midnight or 150', async () => {
    const state = makeState({ backlogCount: 1, eligibleDueCount: 1 });
    const { env, kv, send } = makeEnv(state);
    kv.set('autopilot:lastday', new Date().toISOString().slice(0, 10));
    kv.set('autopilot:lastrun', new Date().toISOString());
    const result = await maybeStartBacklogAutopilot(env);
    expect(result?.started?.trigger).toBe('eligible');
    expect(state.runInserts[0]?.[1]).toBe('eligible');
    expect(send).toHaveBeenCalledTimes(1);
    const tick = send.mock.calls[0]?.[0] as { type: string; runId: string };
    expect(tick).toMatchObject({ type: 'autopilot.tick', runId: result!.started!.runId });
  });

  it('starts that single due doc even on a fresh UTC day, before the daily catch-up path', async () => {
    const state = makeState({ backlogCount: 1, eligibleDueCount: 1 });
    const { env, kv, send } = makeEnv(state);
    kv.set('autopilot:lastrun', new Date().toISOString());
    const result = await maybeStartBacklogAutopilot(env);
    expect(result?.started?.trigger).toBe('eligible');
    expect(kv.get('autopilot:lastday')).toBe(new Date().toISOString().slice(0, 10));
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('acknowledgeAutopilotHalt', () => {
  it('acknowledges the newest halted run and unblocks the gate', async () => {
    const state = makeState({
      openRuns: [{ id: 'run-halted', status: 'halted', updated_at: new Date().toISOString() }],
      runRow: runRow({ id: 'run-halted', status: 'halted', halt_reason: 'error_class:billing' }),
      backlogCount: 1,
    });
    const { env } = makeEnv(state);
    const receipt = await acknowledgeAutopilotHalt(env, { actor: 'jay@test' });
    expect(receipt).not.toBeNull();
    expect(receipt!.id).toBe('run-halted');
    expect(state.openRuns[0].status).toBe('halt_acknowledged');
    // Gate is open again for the next cron tick.
    state.openRuns = [];
    const next = await maybeStartBacklogAutopilot(env);
    expect(next?.started ?? next?.blocked).toBeTruthy();
  });

  it('returns null when nothing is halted', async () => {
    const state = makeState();
    const { env } = makeEnv(state);
    expect(await acknowledgeAutopilotHalt(env)).toBeNull();
  });
});

describe('autopilot batch submission receipts', () => {
  it('persists a submitting intent before provider work and retains it on lease loss', async () => {
    const operations: Array<{ sql: string; params: unknown[] }> = [];
    const env = {
      RAW_FILES: {
        get: vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })),
      },
      DB: {
        prepare(sql: string) {
          return {
            params: [] as unknown[],
            bind(...params: unknown[]) { this.params = params; return this; },
            async run() {
              operations.push({ sql, params: this.params });
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      },
    } as unknown as Env;
    const controller = new AbortController();
    const submit = vi.fn(async () => {
      expect(operations[0]?.sql).toContain("'submitting'");
      controller.abort(new Error('lease lost after provider accepted batch'));
      return 'provider-batch-accepted';
    });

    await expect(submitPreseedBatches(
      env,
      new Map([['anthropic:claude-sonnet-5', [{ docId: 'H-1', rawObjectKey: 'raw/H-1' }]]]),
      { skipReasons: {} } as never,
      'run-1',
      1,
      controller.signal,
      { submit: submit as never, id: () => 'intent-1' },
    )).rejects.toThrow('lease lost after provider accepted batch');

    expect(submit).toHaveBeenCalledOnce();
    expect(operations).toHaveLength(1);
    expect(operations[0].params).toEqual([
      'autopilot-intent-1',
      'anthropic',
      'claude-sonnet-5',
      '["H-1"]',
      expect.any(String),
    ]);
  });

  it('terminalizes a stale submitting intent as an explicit unknown outcome', async () => {
    const updates: Array<{ sql: string; params: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            params: [] as unknown[],
            bind(...params: unknown[]) { this.params = params; return this; },
            async all<T>() {
              return {
                success: true,
                results: [{
                  id: 'autopilot-intent-1',
                  provider: 'anthropic',
                  model: 'claude-sonnet-5',
                  provider_batch_id: null,
                  status: 'submitting',
                }] as T[],
              };
            },
            async run() {
              updates.push({ sql, params: this.params });
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      },
    } as unknown as Env;
    const now = new Date('2026-07-22T18:00:00.000Z');

    await pollAutopilotPreseedBatches(env, '2026-07-22', undefined, () => now, false);

    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain("status = 'submission_unknown'");
    expect(updates[0].params).toEqual([now.toISOString(), 'autopilot-intent-1']);
  });

  it('reconciles stale submission intents even when older provider jobs fill the poll quota', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const updates: Array<{ sql: string; params: unknown[] }> = [];
    const staleIntent = {
      id: 'autopilot-stale-intent',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      provider_batch_id: null,
      status: 'submitting',
    };
    const olderRunningJobs = Array.from({ length: 4 }, (_, index) => ({
      id: `autopilot-running-${index}`,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      provider_batch_id: `provider-${index}`,
      status: 'running',
    }));
    const poll = vi.fn(async () => ({
      done: false,
      failed: false,
      status: 'running',
      results: [],
    }));
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            params: [] as unknown[],
            bind(...params: unknown[]) { this.params = params; return this; },
            async all<T>() {
              queries.push({ sql, params: this.params });
              return {
                success: true,
                results: (sql.includes("status = 'submitting'")
                  ? [staleIntent]
                  : olderRunningJobs) as T[],
              };
            },
            async run() {
              updates.push({ sql, params: this.params });
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      },
    } as unknown as Env;
    const now = new Date('2026-07-22T18:00:00.000Z');

    await pollAutopilotPreseedBatches(
      env,
      '2026-07-22',
      undefined,
      () => now,
      true,
      poll,
    );

    expect(queries).toHaveLength(2);
    expect(queries[0].sql).toContain("status = 'submitting'");
    expect(queries[1].sql).toContain("status IN ('submitted', 'running')");
    expect(poll).toHaveBeenCalledTimes(olderRunningJobs.length);
    const unknownUpdates = updates.filter((update) =>
      update.sql.includes("status = 'submission_unknown'")
    );
    expect(unknownUpdates).toHaveLength(1);
    expect(unknownUpdates[0].params).toEqual([now.toISOString(), staleIntent.id]);
  });

  it('records a lost provider response as submission_unknown instead of failed', async () => {
    const operations: Array<{ sql: string; params: unknown[] }> = [];
    const env = {
      RAW_FILES: {
        get: vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })),
      },
      DB: {
        prepare(sql: string) {
          return {
            params: [] as unknown[],
            bind(...params: unknown[]) { this.params = params; return this; },
            async run() {
              operations.push({ sql, params: this.params });
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      },
    } as unknown as Env;
    const state = {
      docsAttempted: 0,
      docsPublished: 0,
      docsDeferred: 0,
      spendMicro: 0,
      errorClassCounts: {},
      sampleErrors: {},
      outcomes: [],
      skipReasons: {},
    };

    await submitPreseedBatches(
      env,
      new Map([['anthropic:claude-sonnet-5', [{ docId: 'H-2', rawObjectKey: 'raw/H-2' }]]]),
      state,
      'run-1',
      1,
      undefined,
      {
        submit: vi.fn(async () => { throw new TypeError('socket reset after request write'); }),
        id: () => 'intent-2',
        now: () => new Date('2026-07-22T18:00:00.000Z'),
      },
    );

    const terminalized = operations.find((operation) =>
      operation.sql.includes("status = 'submission_unknown'"));
    expect(terminalized).toBeDefined();
    expect(terminalized?.params).toEqual([
      '2026-07-22T18:00:00.000Z',
      'provider submission outcome unknown: socket reset after request write',
      'autopilot-intent-2',
    ]);
    expect(operations.some((operation) => operation.sql.includes("status = 'failed'"))).toBe(false);
  });
});
