import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import {
  acquireBenchmarkSettingsLease,
  assertBenchmarkSettingsLease,
  BenchmarkCallReservationError,
  BenchmarkSettingsLeaseBusyError,
  BenchmarkSettingsLeaseLostError,
  benchmarkReadIsAutonomous,
  benchmarkUsageHasProviderReportedCost,
  buildAdminRouter,
  persistBenchmarkSelectionAudit,
  releaseBenchmarkSettingsLease,
  reserveBenchmarkCalls,
} from '../routes.ts';

const AUTH = {
  authorization: 'Bearer admin-secret',
  'content-type': 'application/json',
};

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    ADMIN_TOKEN: 'admin-secret',
    AGREEMENT_HOUSE_MODEL_A: 'openai:gpt-5.6-terra',
    AGREEMENT_HOUSE_MODEL_B: 'anthropic:claude-sonnet-5',
    AGREEMENT_HOUSE_MODEL_C: 'mistral:mistral-ocr-latest',
    AGREEMENT_HOUSE_MODEL_D: 'openai:gpt-5.6-terra',
    AGREEMENT_HOUSE_MODEL_E: 'anthropic:claude-sonnet-5',
    OPENAI_API_KEY: 'openai-key',
    ANTHROPIC_API_KEY: 'anthropic-key',
    MISTRAL_API_KEY: 'mistral-key',
    DB: {
      prepare(sql: string) {
        const statement = {
          params: [] as unknown[],
          bind(...params: unknown[]) {
            statement.params = params;
            return statement;
          },
          async first<T>() {
            if (/SELECT raw_object_key FROM filings WHERE doc_id/i.test(sql)) {
              return { raw_object_key: 'raw/H-1' } as T;
            }
            return null as T | null;
          },
          async all<T>() {
            if (/FROM filings f[\s\S]*LEFT JOIN review_queue/i.test(sql)) {
              return { results: [{ doc_id: 'H-1', resolved: 1 }] as T[] };
            }
            if (/FROM transactions/i.test(sql)) {
              return { results: [{
                ticker: 'AAPL',
                asset_name: 'Apple Inc.',
                tx_date: '2026-07-01',
                tx_type: 'B',
                amount_min: 1_001,
                amount_max: 15_000,
                owner: 'self',
                asset_type: 'ST',
                is_option: 0,
                cap_gains_over_200: 0,
              }] as T[] };
            }
            return { results: [] as T[] };
          },
          async run() {
            return { success: true, meta: { changes: 1 } };
          },
        };
        return statement;
      },
      async batch() {
        return [];
      },
    } as unknown as D1Database,
    ...overrides,
  } as unknown as Env;
}

interface ReservationStatement {
  sql: string;
  params: unknown[];
  bind(...params: unknown[]): ReservationStatement;
}

function atomicReservationDb(
  delegate: D1Database,
  initialReservedCalls = 0,
  options: { fail?: boolean; initialDay?: string } = {},
): { db: D1Database; reservedCalls: (day?: string) => number } {
  const initialDay = options.initialDay ?? new Date().toISOString().slice(0, 10);
  const reservedCallsByDay = new Map<string, number>();
  if (initialReservedCalls > 0) reservedCallsByDay.set(initialDay, initialReservedCalls);
  const db = {
    prepare(sql: string) {
      if (!sql.includes('benchmark_daily_call_usage')) return delegate.prepare(sql);
      const statement: ReservationStatement = {
        sql,
        params: [],
        bind(...params: unknown[]) {
          statement.params = params;
          return statement;
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      const reservation = statements as unknown as ReservationStatement[];
      if (!reservation[0]?.sql?.includes('benchmark_daily_call_usage')) {
        return delegate.batch(statements);
      }
      if (options.fail) throw new Error('D1 reservation unavailable');
      const plannedCalls = Number(reservation[1]?.params[0]);
      const day = String(reservation[1]?.params[2]);
      const dailyCap = Number(reservation[1]?.params[4]);
      const usedBefore = reservedCallsByDay.get(day) ?? 0;
      const accepted = Number.isSafeInteger(plannedCalls)
        && plannedCalls > 0
        && usedBefore + plannedCalls <= dailyCap;
      if (!reservedCallsByDay.has(day)) reservedCallsByDay.set(day, 0);
      if (accepted) reservedCallsByDay.set(day, usedBefore + plannedCalls);
      const usedAfter = reservedCallsByDay.get(day) ?? 0;
      return [
        { success: true, meta: { changes: usedBefore > 0 ? 0 : 1 } },
        { success: true, meta: { changes: accepted ? 1 : 0 } },
        { success: true, meta: { changes: 0 }, results: [{ reserved_calls: usedAfter }] },
      ] as unknown as D1Result[];
    },
  } as unknown as D1Database;
  return {
    db,
    reservedCalls: (day = new Date().toISOString().slice(0, 10)) => reservedCallsByDay.get(day) ?? 0,
  };
}

function settingsLeaseDb(): D1Database {
  let lease: {
    chamber: string;
    ownerToken: string;
    leaseUntil: string;
    createdAt: string;
    updatedAt: string;
  } | null = null;
  return {
    prepare(sql: string) {
      const statement = {
        params: [] as unknown[],
        bind(...params: unknown[]) {
          statement.params = params;
          return statement;
        },
        async run() {
          if (/INSERT INTO benchmark_settings_leases/i.test(sql)) {
            const [chamber, ownerToken, leaseUntil, createdAt, updatedAt] = statement.params as string[];
            const accepted = lease === null || lease.leaseUntil <= createdAt;
            if (accepted) lease = { chamber, ownerToken, leaseUntil, createdAt, updatedAt };
            return { success: true, meta: { changes: accepted ? 1 : 0 } } as D1Result;
          }
          if (/DELETE FROM benchmark_settings_leases/i.test(sql)) {
            const [chamber, ownerToken] = statement.params as string[];
            const accepted = lease?.chamber === chamber && lease.ownerToken === ownerToken;
            if (accepted) lease = null;
            return { success: true, meta: { changes: accepted ? 1 : 0 } } as D1Result;
          }
          return { success: true, meta: { changes: 0 } } as D1Result;
        },
        async first<T>() {
          if (/SELECT[\s\S]*lease_until[\s\S]*FROM benchmark_settings_leases/i.test(sql) && lease) {
            return {
              owner_token: lease.ownerToken,
              lease_until: lease.leaseUntil,
            } as T;
          }
          return null as T | null;
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function claimableBenchmarkDb(
  requestProfile: Record<string, unknown>,
  initialClaim: { outcome: string; claim_token: string | null; lease_until: string } | null = null,
  options: { blockFirstClaimUntilSecond?: boolean } = {},
): D1Database {
  const run = {
    id: 'run-1', chamber: 'house', status: 'running',
    requested_doc_count: 1, completed_doc_count: 0, model_count: 1,
    models_json: JSON.stringify([BENCHMARK_MODELS[0]]),
    request_profile_json: JSON.stringify(requestProfile),
    started_at: '2026-07-13T12:00:00.000Z',
    completed_at: null, duration_ms: null, known_cost_usd: null,
    cost_covered_calls: 0, invoked_calls: 0, summary_json: null,
    selected_lineup_json: null, selected_at: null, selection_error: null,
    selection_audit_json: null, error: null,
    created_at: '2026-07-13T12:00:00.000Z', updated_at: '2026-07-13T12:00:00.000Z',
  };
  const document = {
    run_id: 'run-1', doc_id: 'H-1', ordinal: 0, resolved: 0, ground_truth_json: null,
  };
  let claim: { outcome: string; claim_token: string | null; lease_until: string } | null = initialClaim;
  let completed: Record<string, unknown> | null = null;
  let releaseFirstClaim: (() => void) | null = null;
  return {
    prepare(sql: string) {
      const statement = {
        params: [] as unknown[],
        bind(...params: unknown[]) { statement.params = params; return statement; },
        async first<T>() {
          if (/SELECT raw_object_key FROM filings WHERE doc_id/i.test(sql)) {
            return { raw_object_key: null } as T;
          }
          if (/SELECT outcome, claim_token, lease_until/i.test(sql)) return claim as T | null;
          return (/FROM benchmark_runs/i.test(sql) ? run : null) as T | null;
        },
        async all<T>() {
          if (/FROM benchmark_run_documents/i.test(sql)) return { results: [document] as T[] };
          if (/FROM benchmark_model_results/i.test(sql)) {
            const result = completed ?? (claim ? benchmarkMeasurement('openai', 'gpt-5.6-terra', {
              invoked: 0,
              ok: 0,
              autonomous: 0,
              outcome: claim.outcome,
              cost_usd: null,
              cost_source: 'unknown',
              claim_token: claim.claim_token,
              lease_until: claim.lease_until,
            }) : null);
            return { results: result ? [result] as T[] : [] as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          if (/INSERT INTO benchmark_model_results/i.test(sql)) {
            const startedAt = String(statement.params[4]);
            const allowRetry = Number(statement.params[9]) === 1;
            const accepted = claim === null
              || (allowRetry && claim.outcome === 'running' && claim.lease_until <= startedAt);
            if (accepted) {
              claim = {
                outcome: 'running',
                claim_token: String(statement.params[5]),
                lease_until: String(statement.params[6]),
              };
            }
            if (options.blockFirstClaimUntilSecond) {
              if (accepted && releaseFirstClaim === null) {
                await new Promise<void>((resolve) => { releaseFirstClaim = resolve; });
              } else if (!accepted && releaseFirstClaim !== null) {
                const release = releaseFirstClaim;
                releaseFirstClaim = null;
                release();
              }
            }
            return { success: true, meta: { changes: accepted ? 1 : 0 } } as D1Result;
          }
          if (/DELETE FROM benchmark_model_results/i.test(sql)) {
            const claimToken = String(statement.params[4]);
            const accepted = claim?.claim_token === claimToken;
            if (accepted) claim = null;
            return { success: true, meta: { changes: accepted ? 1 : 0 } } as D1Result;
          }
          if (/UPDATE benchmark_model_results[\s\S]*SET claim_token = NULL, lease_until = \?/i.test(sql)) {
            const claimToken = String(statement.params[5]);
            const accepted = claim?.claim_token === claimToken;
            if (accepted && claim) {
              claim = { ...claim, claim_token: null, lease_until: String(statement.params[0]) };
            }
            return { success: true, meta: { changes: accepted ? 1 : 0 } } as D1Result;
          }
          if (/UPDATE benchmark_model_results SET/i.test(sql) && claim) {
            completed = benchmarkMeasurement(String(statement.params[24]), String(statement.params[25]), {
              invoked: Number(statement.params[1]),
              ok: Number(statement.params[2]),
              outcome: String(statement.params[3]),
              autonomous: Number(statement.params[4]),
              error: statement.params[5],
              row_count: Number(statement.params[6]),
              latency_ms: statement.params[8],
              cost_usd: statement.params[9],
              cost_source: statement.params[10],
              result_json: statement.params[14],
              claim_token: null,
              lease_until: null,
            });
            claim = null;
            return { success: true, meta: { changes: 1 } } as D1Result;
          }
          return { success: true, meta: { changes: 0 } } as D1Result;
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

const BENCHMARK_MODELS = [
  { provider: 'openai', model: 'gpt-5.6-terra' },
  { provider: 'gemini', model: 'gemini-3.5-flash' },
  { provider: 'anthropic', model: 'claude-sonnet-5' },
];

function benchmarkMeasurement(
  provider: string,
  model: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    run_id: 'run-1', doc_id: 'H-1', provider, model, resolved_model: model,
    invoked: 1, ok: 1, outcome: 'would_publish', autonomous: 1, error: null,
    row_count: 1, avg_confidence: 0.99, latency_ms: 100, cost_usd: 0.001,
    cost_source: 'usage_priced', cost_detail_json: '{}', provider_request_id: null,
    usage_json: '{}', result_json: JSON.stringify({ rows: [], flags: [] }),
    perfect_match: 1, true_positive: 1, false_positive: 0, false_negative: 0,
    started_at: null, completed_at: null, created_at: '2026-07-13T12:00:01.000Z',
    ...overrides,
  };
}

type CircuitModel = { provider: string; model: string };

function circuitRowKey(docId: string, model: CircuitModel): string {
  return `${docId}\u0000${model.provider}\u0000${model.model}`;
}

function benchmarkCircuitDb(options: {
  docIds: string[];
  models: CircuitModel[];
  results?: Array<Record<string, unknown>>;
}) {
  const rows = new Map<string, Record<string, unknown>>();
  for (const result of options.results ?? []) {
    rows.set(circuitRowKey(String(result.doc_id), {
      provider: String(result.provider), model: String(result.model),
    }), { ...result });
  }
  let claimAttempts = 0;
  const documents = options.docIds.map((docId, ordinal) => ({
    run_id: 'run-1', doc_id: docId, ordinal, resolved: 0, ground_truth_json: null,
  }));
  const requestProfile = {
    paidCallAuthorization: {
      version: 1,
      scope: 'initial_model_document_cells',
      reservedDay: new Date().toISOString().slice(0, 10),
      reservedCalls: options.docIds.length * options.models.length,
      documentCount: options.docIds.length,
      models: options.models,
    },
  };
  const runRow = {
    id: 'run-1', chamber: 'house', status: 'running',
    requested_doc_count: options.docIds.length,
    completed_doc_count: rows.size,
    model_count: options.models.length,
    models_json: JSON.stringify(options.models),
    request_profile_json: JSON.stringify(requestProfile),
    started_at: '2026-07-14T12:00:00.000Z', completed_at: null, duration_ms: null,
    known_cost_usd: null, cost_covered_calls: 0, invoked_calls: 0, summary_json: null,
    selected_lineup_json: null, selected_at: null, selection_error: null,
    selection_audit_json: null, error: null,
    created_at: '2026-07-14T12:00:00.000Z', updated_at: '2026-07-14T12:00:00.000Z',
  };

  const db = {
    prepare(sql: string) {
      const statement = {
        params: [] as unknown[],
        bind(...params: unknown[]) { statement.params = params; return statement; },
        async first<T>() {
          if (/SELECT raw_object_key FROM filings WHERE doc_id/i.test(sql)) {
            return { raw_object_key: `raw/${String(statement.params[0])}.pdf` } as T;
          }
          if (/SELECT outcome, claim_token, lease_until/i.test(sql)) {
            const model = { provider: String(statement.params[2]), model: String(statement.params[3]) };
            const row = rows.get(circuitRowKey(String(statement.params[1]), model));
            return row ? {
              outcome: row.outcome,
              claim_token: row.claim_token ?? null,
              lease_until: row.lease_until ?? null,
            } as T : null;
          }
          return (/FROM benchmark_runs/i.test(sql) ? runRow : null) as T | null;
        },
        async all<T>() {
          if (/FROM benchmark_run_documents/i.test(sql)) return { results: documents as T[] };
          if (/FROM benchmark_model_results/i.test(sql)) return { results: [...rows.values()] as T[] };
          return { results: [] as T[] };
        },
        async run() {
          if (/SELECT \?, \?, \?, \?, 0, 0, 'running'/i.test(sql)) {
            claimAttempts += 1;
            const model = { provider: String(statement.params[2]), model: String(statement.params[3]) };
            const key = circuitRowKey(String(statement.params[1]), model);
            if (rows.has(key)) return { success: true, meta: { changes: 0 } } as D1Result;
            rows.set(key, benchmarkMeasurement(model.provider, model.model, {
              doc_id: statement.params[1], invoked: 0, ok: 0, outcome: 'running',
              autonomous: 0, row_count: 0, avg_confidence: null, latency_ms: null,
              cost_usd: null, cost_source: 'unknown', cost_detail_json: null,
              usage_json: null, result_json: null, perfect_match: null,
              true_positive: null, false_positive: null, false_negative: null,
              started_at: statement.params[4], completed_at: null,
              claim_token: statement.params[5], lease_until: statement.params[6],
              created_at: statement.params[7],
            }));
            return { success: true, meta: { changes: 1 } } as D1Result;
          }
          if (/VALUES \(\?, \?, \?, \?, NULL, 0, 0, 'skipped'/i.test(sql)) {
            const model = { provider: String(statement.params[2]), model: String(statement.params[3]) };
            const key = circuitRowKey(String(statement.params[1]), model);
            if (rows.has(key)) return { success: true, meta: { changes: 0 } } as D1Result;
            rows.set(key, benchmarkMeasurement(model.provider, model.model, {
              doc_id: statement.params[1], resolved_model: null,
              invoked: 0, ok: 0, outcome: 'skipped', autonomous: 0,
              error: statement.params[4], row_count: 0, avg_confidence: null,
              latency_ms: null, cost_usd: null, cost_source: 'unknown',
              cost_detail_json: statement.params[5], provider_request_id: null,
              usage_json: null, result_json: statement.params[6], perfect_match: null,
              true_positive: null, false_positive: null, false_negative: null,
              started_at: statement.params[7], completed_at: statement.params[8],
              claim_token: null, lease_until: null, created_at: statement.params[9],
            }));
            return { success: true, meta: { changes: 1 } } as D1Result;
          }
          if (/UPDATE benchmark_model_results SET/i.test(sql)) {
            const model = { provider: String(statement.params[24]), model: String(statement.params[25]) };
            const key = circuitRowKey(String(statement.params[23]), model);
            const existing = rows.get(key);
            if (
              !existing
              || existing.outcome !== 'running'
              || existing.claim_token !== statement.params[26]
            ) return { success: true, meta: { changes: 0 } } as D1Result;
            rows.set(key, benchmarkMeasurement(model.provider, model.model, {
              doc_id: statement.params[23], resolved_model: statement.params[0],
              invoked: statement.params[1], ok: statement.params[2], outcome: statement.params[3],
              autonomous: statement.params[4], error: statement.params[5], row_count: statement.params[6],
              avg_confidence: statement.params[7], latency_ms: statement.params[8],
              cost_usd: statement.params[9], cost_source: statement.params[10],
              cost_detail_json: statement.params[11], provider_request_id: statement.params[12],
              usage_json: statement.params[13], result_json: statement.params[14],
              perfect_match: statement.params[15], true_positive: statement.params[16],
              false_positive: statement.params[17], false_negative: statement.params[18],
              started_at: statement.params[19], completed_at: statement.params[20],
              created_at: statement.params[21], claim_token: null, lease_until: null,
            }));
            return { success: true, meta: { changes: 1 } } as D1Result;
          }
          return { success: true, meta: { changes: 0 } } as D1Result;
        },
      };
      return statement;
    },
    async batch(statements: D1PreparedStatement[]) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  } as unknown as D1Database;
  return { db, rows, claimAttempts: () => claimAttempts };
}

function benchmarkFailureRow(
  docId: string,
  model: CircuitModel,
  failure: { code: string; scope: 'provider' | 'model'; retryable: false; message: string },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return benchmarkMeasurement(model.provider, model.model, {
    doc_id: docId, invoked: 1, ok: 0, outcome: 'skipped', autonomous: 0,
    error: failure.code, row_count: 0, avg_confidence: 0, latency_ms: 25,
    cost_usd: null, cost_source: 'unknown', perfect_match: null,
    true_positive: null, false_positive: null, false_negative: null,
    result_json: JSON.stringify({ rows: [], flags: [], failure }),
    ...overrides,
  });
}

function persistedBenchmarkDb(
  results: Array<Record<string, unknown>>,
  groundTruth: unknown[] = [],
  status: 'running' | 'completed' = 'completed',
  documentIds: string[] = ['H-1'],
): D1Database {
  const run = {
    id: 'run-1', chamber: 'house', status,
    requested_doc_count: documentIds.length,
    completed_doc_count: status === 'completed' ? documentIds.length : 0,
    model_count: 3,
    models_json: JSON.stringify(BENCHMARK_MODELS),
    started_at: '2026-07-13T12:00:00.000Z',
    completed_at: '2026-07-13T12:01:00.000Z', duration_ms: 60_000,
    known_cost_usd: null, cost_covered_calls: 0, invoked_calls: 0,
    summary_json: null, selected_lineup_json: null, selected_at: null,
    selection_error: null, selection_audit_json: null, error: null,
    created_at: '2026-07-13T12:00:00.000Z', updated_at: '2026-07-13T12:01:00.000Z',
  };
  const documents = documentIds.map((docId, ordinal) => ({
    run_id: 'run-1', doc_id: docId, ordinal, resolved: 1,
    ground_truth_json: JSON.stringify(groundTruth),
  }));
  return {
    prepare(sql: string) {
      const statement = {
        bind() { return statement; },
        async first<T>() {
          if (/SELECT outcome, claim_token, lease_until/i.test(sql)) {
            const result = results[0];
            return result ? {
              outcome: result.outcome,
              claim_token: result.claim_token ?? 'other-worker',
              lease_until: result.lease_until ?? '2099-01-01T00:00:00.000Z',
            } as T : null;
          }
          return (/FROM benchmark_runs/i.test(sql) ? run : null) as T | null;
        },
        async all<T>() {
          if (/FROM benchmark_run_documents/i.test(sql)) return { results: documents as T[] };
          if (/FROM benchmark_model_results/i.test(sql)) return { results: results as T[] };
          return { results: [] as T[] };
        },
        async run() { return { success: true, meta: { changes: 0 } }; },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function cancellableBenchmarkDb(initialStatus: 'running' | 'completed' | 'failed') {
  const run = {
    id: 'run-1', chamber: 'house', status: initialStatus,
    requested_doc_count: 1, completed_doc_count: 0, model_count: 1,
    models_json: JSON.stringify([BENCHMARK_MODELS[0]]), request_profile_json: '{}',
    started_at: '2026-07-14T12:00:00.000Z',
    completed_at: initialStatus === 'running' ? null : '2026-07-14T12:01:00.000Z',
    duration_ms: initialStatus === 'running' ? null : 60_000,
    known_cost_usd: null, cost_covered_calls: 0, invoked_calls: 0,
    summary_json: null, selected_lineup_json: null, selected_at: null,
    selection_error: null, selection_audit_json: null,
    error: initialStatus === 'failed' ? 'cancelled_by_operator' : null,
    created_at: '2026-07-14T12:00:00.000Z', updated_at: '2026-07-14T12:00:00.000Z',
  };
  let cancelWrites = 0;
  const db = {
    prepare(sql: string) {
      const statement = {
        params: [] as unknown[],
        bind(...params: unknown[]) { statement.params = params; return statement; },
        async first<T>() { return (/FROM benchmark_runs/i.test(sql) ? run : null) as T | null; },
        async all<T>() { return { results: [] as T[] }; },
        async run() {
          if (/UPDATE benchmark_runs[\s\S]*status = 'failed'/i.test(sql)) {
            const accepted = run.status === 'running';
            if (accepted) {
              run.status = 'failed';
              run.completed_at = String(statement.params[0]);
              run.duration_ms = 1;
              run.error = String(statement.params[2]);
              run.updated_at = String(statement.params[3]);
              cancelWrites += 1;
            }
            return { success: true, meta: { changes: accepted ? 1 : 0 } } as D1Result;
          }
          return { success: true, meta: { changes: 0 } } as D1Result;
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, cancelWrites: () => cancelWrites };
}

function activeRunCreationRaceDb() {
  let activeLookups = 0;
  let paidReservationBatches = 0;
  const activeRun = {
    id: 'run-existing', chamber: 'house', status: 'running',
    requested_doc_count: 1, completed_doc_count: 0, model_count: 1,
    models_json: JSON.stringify([BENCHMARK_MODELS[0]]), request_profile_json: '{}',
    started_at: '2026-07-14T12:00:00.000Z', completed_at: null, duration_ms: null,
    known_cost_usd: null, cost_covered_calls: 0, invoked_calls: 0, summary_json: null,
    selected_lineup_json: null, selected_at: null, selection_error: null,
    selection_audit_json: null, error: null,
    created_at: '2026-07-14T12:00:00.000Z', updated_at: '2026-07-14T12:00:00.000Z',
  };
  interface Statement {
    sql: string;
    params: unknown[];
    bind(...params: unknown[]): Statement;
    first<T>(): Promise<T | null>;
    all<T>(): Promise<{ results: T[] }>;
    run(): Promise<D1Result>;
  }
  const db = {
    prepare(sql: string) {
      const statement: Statement = {
        sql,
        params: [],
        bind(...params: unknown[]) { statement.params = params; return statement; },
        async first<T>() {
          if (/SELECT id FROM benchmark_runs[\s\S]*status = 'running'/i.test(sql)) {
            activeLookups += 1;
            return (activeLookups === 1 ? null : { id: activeRun.id }) as T | null;
          }
          if (/SELECT \* FROM benchmark_runs/i.test(sql)) return activeRun as T;
          return null;
        },
        async all<T>() {
          if (/FROM filings f[\s\S]*LEFT JOIN review_queue/i.test(sql)) {
            return { results: [{ doc_id: 'H-1', resolved: 1 }] as T[] };
          }
          if (/FROM transactions/i.test(sql)) {
            return { results: [{
              ticker: 'AAPL', asset_name: 'Apple Inc.', tx_date: '2026-07-01',
              tx_type: 'B', amount_min: 1_001, amount_max: 15_000, owner: 'self',
              asset_type: 'ST', is_option: 0, cap_gains_over_200: 0,
            }] as T[] };
          }
          return { results: [] as T[] };
        },
        async run() { return { success: true, meta: { changes: 1 } } as D1Result; },
      };
      return statement;
    },
    async batch(statements: D1PreparedStatement[]) {
      const sql = (statements[0] as unknown as Statement | undefined)?.sql ?? '';
      if (/benchmark_daily_call_usage/i.test(sql)) {
        paidReservationBatches += 1;
        return [] as D1Result[];
      }
      if (/INSERT INTO benchmark_runs/i.test(sql)) {
        throw new Error('UNIQUE constraint failed: benchmark_runs.chamber');
      }
      return [] as D1Result[];
    },
  } as unknown as D1Database;
  return { db, paidReservationBatches: () => paidReservationBatches };
}

describe('durable benchmark admin routes', () => {
  it('uses structural publishability, not model confidence, for individual autonomy', () => {
    expect(benchmarkReadIsAutonomous('would_publish', 1)).toBe(true);
    expect(benchmarkReadIsAutonomous('would_publish', 0)).toBe(false);
    expect(benchmarkReadIsAutonomous('agree_but_hardfail', 1)).toBe(false);
  });

  it('does not emit a second benchmark cost event for provider-reported xAI cost ticks', () => {
    expect(benchmarkUsageHasProviderReportedCost({ costInUsdTicks: 321_000_000 })).toBe(true);
    expect(benchmarkUsageHasProviderReportedCost({ costInUsdTicks: 0 })).toBe(true);
    expect(benchmarkUsageHasProviderReportedCost({ costInUsdTicks: -1 })).toBe(false);
    expect(benchmarkUsageHasProviderReportedCost({ costInUsdTicks: Number.NaN })).toBe(false);
    expect(benchmarkUsageHasProviderReportedCost({ promptTokens: 100, completionTokens: 20 })).toBe(false);
  });

  it('preserves a successful settings result when only its D1 receipt fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(persistBenchmarkSelectionAudit(async () => {
        throw new Error('D1 unavailable');
      })).resolves.toEqual({
        auditPersisted: false,
        warning: 'Settings were saved and verified, but the benchmark selection receipt could not be persisted.',
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('requires explicit paid-run confirmation and reports the planned call count', async () => {
    const response = await buildAdminRouter().request('/benchmark/runs', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        chamber: 'house',
        limit: 1,
        models: [{ provider: 'mistral', model: 'mistral-ocr-latest' }],
      }),
    }, env());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      requiresConfirmation: true,
      plannedCalls: 1,
      documentCount: 1,
      configuredModels: [{ provider: 'mistral', model: 'mistral-ocr-latest', configured: true }],
    });
  });

  it('checks project-visible OpenAI access and excludes known-unavailable GPT-5.6 models before reserving calls', async () => {
    const base = env();
    const ledger = atomicReservationDb(base.DB);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      object: 'list',
      data: [{ id: 'gpt-5.6-terra' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    try {
      const response = await buildAdminRouter().request('/benchmark/runs', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({
          chamber: 'house',
          limit: 1,
          models: [
            { provider: 'openai', model: 'gpt-5.6-luna' },
            { provider: 'openai', model: 'gpt-5.6-terra' },
          ],
          confirmPaidRun: true,
        }),
      }, env({ DB: ledger.db, BENCHMARK_DAILY_CALL_CAP: '5' }));

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        plannedCalls: 1,
        run: {
          models: [{ provider: 'openai', model: 'gpt-5.6-terra' }],
          requestProfile: {
            modelAccess: {
              status: 'ready',
              models: [
                { model: 'gpt-5.6-luna', availability: 'unavailable' },
                { model: 'gpt-5.6-terra', availability: 'available' },
              ],
            },
          },
        },
        skippedModels: [{
          provider: 'openai', model: 'gpt-5.6-luna', reason: 'known_unavailable',
          failure: { code: 'model_access_denied', scope: 'model', retryable: false },
        }],
      });
      expect(ledger.reservedCalls()).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/models');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('reuses successful prior cells before reserving only the remaining paid calls', async () => {
    const base = env();
    const reuseDb = {
      prepare(sql: string) {
        const statement = base.DB.prepare(sql) as D1PreparedStatement & { sql?: string };
        statement.sql = sql;
        return statement;
      },
      async batch(statements: D1PreparedStatement[]) {
        const firstSql = String((statements[0] as unknown as { sql?: string }).sql ?? '');
        if (/INSERT INTO benchmark_model_results/i.test(firstSql) && /SELECT bmr\.\*/i.test(firstSql)) {
          return [
            { success: true, meta: { changes: 1 } },
            { success: true, meta: { changes: 0 } },
          ] as unknown as D1Result[];
        }
        return base.DB.batch(statements);
      },
    } as unknown as D1Database;
    const ledger = atomicReservationDb(reuseDb);

    const response = await buildAdminRouter().request('/benchmark/runs', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        chamber: 'house',
        limit: 1,
        models: [
          { provider: 'mistral', model: 'mistral-ocr-latest' },
          { provider: 'anthropic', model: 'claude-sonnet-5' },
        ],
        confirmPaidRun: true,
      }),
    }, env({ DB: ledger.db, BENCHMARK_DAILY_CALL_CAP: '5' }));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      plannedCalls: 2,
      callsNeedingReservation: 1,
      reusedCells: 1,
      reusedBillableCells: 1,
      reuseEligibleCells: 2,
      run: {
        requestProfile: {
          paidCallAuthorization: {
            reservedCalls: 1,
            documentCount: 1,
            models: [
              { provider: 'mistral', model: 'mistral-ocr-latest' },
              { provider: 'anthropic', model: 'claude-sonnet-5' },
            ],
          },
        },
      },
    });
    expect(ledger.reservedCalls()).toBe(1);
  });

  it('atomically rejects a same-chamber creation race before reserving paid calls', async () => {
    const fixture = activeRunCreationRaceDb();
    const response = await buildAdminRouter().request('/benchmark/runs', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        chamber: 'house',
        limit: 1,
        models: [{ provider: 'mistral', model: 'mistral-ocr-latest' }],
        confirmPaidRun: true,
      }),
    }, env({ DB: fixture.db, BENCHMARK_DAILY_CALL_CAP: '5' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'benchmark_run_already_active',
      existingRunId: 'run-existing',
      run: { id: 'run-existing', status: 'running', chamber: 'house' },
    });
    expect(fixture.paidReservationBatches()).toBe(0);
  });

  it('fails closed before reservation when OpenAI access readiness is inconclusive', async () => {
    const base = env();
    const ledger = atomicReservationDb(base.DB);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'rate_limit_exceeded', message: 'Requests per minute exceeded' },
    }), { status: 429, headers: { 'content-type': 'application/json' } }));
    try {
      const response = await buildAdminRouter().request('/benchmark/runs', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({
          chamber: 'house',
          limit: 1,
          models: [{ provider: 'openai', model: 'gpt-5.6-sol' }],
          confirmPaidRun: true,
        }),
      }, env({ DB: ledger.db, BENCHMARK_DAILY_CALL_CAP: '5' }));

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: 'benchmark_model_access_unknown',
        retryable: true,
        models: [{ provider: 'openai', model: 'gpt-5.6-sol' }],
        access: {
          status: 'error',
          errorCode: 'catalog_rate_limited',
          models: [{ model: 'gpt-5.6-sol', availability: 'unknown' }],
        },
      });
      expect(ledger.reservedCalls()).toBe(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('excludes model/autopublish-resolved filings from benchmark ground truth', async () => {
    const base = env();
    let selectionSql = '';
    let groundTruthQueried = false;
    const db = {
      prepare(sql: string) {
        if (/FROM filings f[\s\S]*LEFT JOIN review_queue/i.test(sql)) {
          selectionSql = sql;
          return {
            bind() { return this; },
            async all<T>() {
              // This filing is resolved only by a model receipt. The SQL's
              // admin/latest-decision provenance expression must label it 0.
              return { results: [{ doc_id: 'AUTO-1', resolved: 0 }] as T[] };
            },
          };
        }
        if (/FROM transactions t/i.test(sql)) {
          groundTruthQueried = true;
          throw new Error('model-resolved rows must not be loaded as ground truth');
        }
        return base.DB.prepare(sql);
      },
      async batch(statements: D1PreparedStatement[]) { return base.DB.batch(statements); },
    } as unknown as D1Database;

    const response = await buildAdminRouter().request('/benchmark/runs', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        chamber: 'house',
        limit: 1,
        models: [{ provider: 'xai', model: 'grok-4.3' }],
      }),
    }, env({ DB: db }));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      docs: [{ docId: 'AUTO-1', resolved: false }],
      resolvedDocumentCount: 0,
    });
    expect(groundTruthQueried).toBe(false);
    expect(selectionSql).toContain("d.source = 'admin'");
    expect(selectionSql).toContain("d.action IN ('confirmed', 'manual')");
    expect(selectionSql).toContain("'amount_bounds_canonicalize'");
    expect(selectionSql).toContain('ORDER BY d.created_at DESC, d.id DESC');
  });

  it('re-scores a saved run from persisted rows without invoking a provider', async () => {
    const truth = {
      ticker: 'AAPL', assetName: 'Apple Inc.', txDate: '2026-07-01', txType: 'B',
      amountMin: 1_001, amountMax: 15_000, owner: 'self', assetType: 'ST',
      assetTypeName: 'Stocks (including ADRs)', isOption: false, capGainsOver200: false,
      filingStatus: null, subholding: null, location: null, description: null, supplementalText: null,
    };
    const runRow: Record<string, unknown> = {
      id: 'run-1', chamber: 'house', status: 'running', requested_doc_count: 1,
      completed_doc_count: 0, model_count: 1,
      models_json: JSON.stringify([{ provider: 'openai', model: 'gpt-5.6-terra' }]),
      request_profile_json: JSON.stringify({ version: 'ct-benchmark-profile-v1' }),
      started_at: '2026-07-14T12:00:00.000Z', completed_at: null, duration_ms: null,
      known_cost_usd: null, cost_covered_calls: 0, invoked_calls: 0, summary_json: null,
      selected_lineup_json: null, selected_at: null, selection_error: null,
      selection_audit_json: null, error: null, created_at: '2026-07-14T12:00:00.000Z',
      updated_at: '2026-07-14T12:00:00.000Z',
    };
    const document = {
      run_id: 'run-1', doc_id: 'H-1', ordinal: 0, resolved: 1,
      ground_truth_json: JSON.stringify([truth]),
    };
    const measurement: Record<string, unknown> = {
      ...benchmarkMeasurement('openai', 'gpt-5.6-terra', {
        result_json: JSON.stringify({ rows: [{ ...truth, filingStatus: 'New' }], flags: [] }),
        perfect_match: 0, true_positive: 0, false_positive: 1, false_negative: 1,
      }),
    };
    const db = {
      prepare(sql: string) {
        const statement = {
          params: [] as unknown[],
          bind(...params: unknown[]) { statement.params = params; return statement; },
          async first<T>() { return (/FROM benchmark_runs/i.test(sql) ? runRow : null) as T | null; },
          async all<T>() {
            if (/FROM benchmark_run_documents/i.test(sql)) return { results: [document] as T[] };
            if (/FROM benchmark_model_results/i.test(sql)) return { results: [measurement] as T[] };
            return { results: [] as T[] };
          },
          async run() {
            if (/UPDATE benchmark_model_results/i.test(sql)) {
              measurement.perfect_match = statement.params[0];
              measurement.true_positive = statement.params[1];
              measurement.false_positive = statement.params[2];
              measurement.false_negative = statement.params[3];
              return { success: true, meta: { changes: 1 } } as unknown as D1Result;
            }
            if (/UPDATE benchmark_runs SET request_profile_json/i.test(sql)) {
              runRow.request_profile_json = statement.params[0];
              runRow.updated_at = statement.params[1];
              return { success: true, meta: { changes: 1 } } as unknown as D1Result;
            }
            return { success: true, meta: { changes: 0 } } as unknown as D1Result;
          },
        };
        return statement;
      },
      async batch(prepared: D1PreparedStatement[]) {
        return Promise.all(prepared.map((statement) => statement.run()));
      },
    } as unknown as D1Database;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const response = await buildAdminRouter().request('/benchmark/runs/run-1/rescore', {
        method: 'POST', headers: AUTH,
      }, env({ DB: db }));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        rescoredMeasurements: 1,
        scoringProfile: 'ct-benchmark-scoring-v2-row-identity-strict-document',
        run: {
          requestProfile: { scoringProfile: 'ct-benchmark-scoring-v2-row-identity-strict-document' },
          results: [{ perfectMatch: false, truePositive: 1, falsePositive: 0, falseNegative: 0 }],
        },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('stops a running benchmark idempotently without provider calls or deleting partial results', async () => {
    const fixture = cancellableBenchmarkDb('running');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const first = await buildAdminRouter().request('/benchmark/runs/run-1/cancel', {
        method: 'POST', headers: AUTH,
      }, env({ DB: fixture.db }));
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({
        run: { id: 'run-1', status: 'failed', error: 'cancelled_by_operator' },
      });

      const repeated = await buildAdminRouter().request('/benchmark/runs/run-1/cancel', {
        method: 'POST', headers: AUTH,
      }, env({ DB: fixture.db }));
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toMatchObject({
        run: { id: 'run-1', status: 'failed', error: 'cancelled_by_operator' },
      });
      expect(fixture.cancelWrites()).toBe(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('does not overwrite a completed benchmark when cancellation races with completion', async () => {
    const fixture = cancellableBenchmarkDb('completed');
    const response = await buildAdminRouter().request('/benchmark/runs/run-1/cancel', {
      method: 'POST', headers: AUTH,
    }, env({ DB: fixture.db }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'benchmark run is completed' });
    expect(fixture.cancelWrites()).toBe(0);
  });

  it('atomically rejects a concurrent reservation that would exceed the daily cap', async () => {
    const base = env();
    const ledger = atomicReservationDb(base.DB);
    const reservationEnv = env({
      DB: ledger.db,
      BENCHMARK_DAILY_CALL_CAP: '5',
    });

    const outcomes = await Promise.allSettled([
      reserveBenchmarkCalls(reservationEnv, 4),
      reserveBenchmarkCalls(reservationEnv, 4),
    ]);

    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<{
        usedToday: number;
        dailyCap: number;
        reservedDay: string;
      }> =>
        outcome.status === 'fulfilled',
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value).toEqual({
      usedToday: 4,
      dailyCap: 5,
      reservedDay: new Date().toISOString().slice(0, 10),
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      reason: 'cap_reached',
      usedToday: 4,
      dailyCap: 5,
    });
    expect(rejected[0]?.reason).toBeInstanceOf(BenchmarkCallReservationError);
    expect(ledger.reservedCalls()).toBe(4);
  });

  it('serializes chamber settings mutations and only lets the owner release its lease', async () => {
    const db = settingsLeaseDb();
    const now = '2026-07-13T12:00:00.000Z';
    const outcomes = await Promise.allSettled([
      acquireBenchmarkSettingsLease(db, 'house', { now, ownerToken: 'writer-a' }),
      acquireBenchmarkSettingsLease(db, 'house', { now, ownerToken: 'writer-b' }),
    ]);

    const acquired = outcomes.find(
      (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireBenchmarkSettingsLease>>> =>
        outcome.status === 'fulfilled',
    );
    const blocked = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    expect(acquired?.value.ownerToken).toMatch(/^writer-[ab]$/);
    expect(blocked?.reason).toBeInstanceOf(BenchmarkSettingsLeaseBusyError);
    expect(await releaseBenchmarkSettingsLease(db, {
      chamber: 'house', ownerToken: 'not-the-owner', leaseUntil: acquired!.value.leaseUntil,
    })).toBe(false);
    expect(await releaseBenchmarkSettingsLease(db, acquired!.value)).toBe(true);
    await expect(acquireBenchmarkSettingsLease(db, 'house', {
      now: '2026-07-13T12:00:01.000Z', ownerToken: 'writer-c',
    })).resolves.toMatchObject({ ownerToken: 'writer-c' });
  });

  it('fences settings mutations by owner token and lease expiry', async () => {
    const db = settingsLeaseDb();
    const original = await acquireBenchmarkSettingsLease(db, 'house', {
      now: '2026-07-13T12:00:00.000Z',
      leaseMs: 30_000,
      ownerToken: 'writer-a',
    });
    await expect(assertBenchmarkSettingsLease(
      db,
      original,
      '2026-07-13T12:00:29.999Z',
    )).resolves.toBeUndefined();
    await expect(assertBenchmarkSettingsLease(
      db,
      original,
      '2026-07-13T12:00:30.000Z',
    )).rejects.toBeInstanceOf(BenchmarkSettingsLeaseLostError);

    const successor = await acquireBenchmarkSettingsLease(db, 'house', {
      now: '2026-07-13T12:00:30.000Z',
      leaseMs: 30_000,
      ownerToken: 'writer-b',
    });
    await expect(assertBenchmarkSettingsLease(
      db,
      original,
      '2026-07-13T12:00:30.001Z',
    )).rejects.toBeInstanceOf(BenchmarkSettingsLeaseLostError);
    await expect(assertBenchmarkSettingsLease(
      db,
      successor,
      '2026-07-13T12:00:30.001Z',
    )).resolves.toBeUndefined();
  });

  it('fails closed with 503 when the paid-call reservation ledger is unavailable', async () => {
    const base = env();
    const ledger = atomicReservationDb(base.DB, 0, { fail: true });
    const response = await buildAdminRouter().request('/benchmark/runs', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        chamber: 'house',
        limit: 1,
        models: [{ provider: 'mistral', model: 'mistral-ocr-latest' }],
        confirmPaidRun: true,
      }),
    }, env({ DB: ledger.db, BENCHMARK_DAILY_CALL_CAP: '5' }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'benchmark daily call reservation is temporarily unavailable',
      code: 'benchmark_call_reservation_unavailable',
      plannedCalls: 1,
      reusedCalls: 0,
      dailyCap: 5,
      retryable: true,
    });
    expect(ledger.reservedCalls()).toBe(0);
  });

  it('returns the durable count when the daily cap rejects a paid run', async () => {
    const base = env();
    const ledger = atomicReservationDb(base.DB, 5);
    const response = await buildAdminRouter().request('/benchmark/runs', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        chamber: 'house',
        limit: 1,
        models: [{ provider: 'mistral', model: 'mistral-ocr-latest' }],
        confirmPaidRun: true,
      }),
    }, env({ DB: ledger.db, BENCHMARK_DAILY_CALL_CAP: '5' }));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: 'benchmark daily call cap reached',
      plannedCalls: 1,
      reusedCalls: 0,
      usedToday: 5,
      dailyCap: 5,
    });
    expect(ledger.reservedCalls()).toBe(5);
  });

  it('persists an explicit initial-cell authorization with a paid run reservation', async () => {
    const base = env();
    const ledger = atomicReservationDb(base.DB);
    const response = await buildAdminRouter().request('/benchmark/runs', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        chamber: 'house',
        limit: 1,
        models: [{ provider: 'mistral', model: 'mistral-ocr-latest' }],
        confirmPaidRun: true,
      }),
    }, env({ DB: ledger.db, BENCHMARK_DAILY_CALL_CAP: '5' }));

    expect(response.status).toBe(201);
    const responseBody = await response.json() as {
      run: { requestProfile: { paidCallAuthorization: { reservedDay: string } } };
      cap: { reservedDay: string };
    };
    expect(responseBody).toMatchObject({
      run: {
        requestProfile: {
          paidCallAuthorization: {
            version: 1,
            scope: 'initial_model_document_cells',
            reservedDay: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
            reservedCalls: 1,
            documentCount: 1,
            models: [{ provider: 'mistral', model: 'mistral-ocr-latest' }],
          },
        },
      },
    });
    expect(responseBody.run.requestProfile.paidCallAuthorization.reservedDay)
      .toBe(responseBody.cap.reservedDay);
    expect(ledger.reservedCalls()).toBe(1);
  });

  it('does not charge the daily cap twice for an authorized initial run cell', async () => {
    const authorizedDb = claimableBenchmarkDb({
      paidCallAuthorization: {
        version: 1,
        scope: 'initial_model_document_cells',
        reservedDay: new Date().toISOString().slice(0, 10),
        reservedCalls: 1,
        documentCount: 1,
        models: [{ provider: 'openai', model: 'gpt-5.6-terra' }],
      },
    });
    const ledger = atomicReservationDb(authorizedDb, 1);
    const response = await buildAdminRouter().request('/benchmark/dry-run/H-1', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ runId: 'run-1', models: { a: BENCHMARK_MODELS[0] } }),
    }, env({ DB: ledger.db, BENCHMARK_DAILY_CALL_CAP: '5' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runId: 'run-1', outcome: 'skipped', reason: 'filing_or_raw_object_missing', invoked: false,
    });
    expect(ledger.reservedCalls()).toBe(1);
  });

  it('expires an initial-cell authorization at the UTC day boundary', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-13T23:59:59.900Z'));
      const requestProfile = {
        paidCallAuthorization: {
          version: 1,
          scope: 'initial_model_document_cells',
          reservedDay: new Date().toISOString().slice(0, 10),
          reservedCalls: 1,
          documentCount: 1,
          models: [{ provider: 'openai', model: 'gpt-5.6-terra' }],
        },
      };
      const ledger = atomicReservationDb(claimableBenchmarkDb(requestProfile), 1);
      vi.setSystemTime(new Date('2026-07-14T00:00:00.100Z'));

      const unconfirmed = await buildAdminRouter().request('/benchmark/dry-run/H-1', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ runId: 'run-1', models: { a: BENCHMARK_MODELS[0] } }),
      }, env({ DB: ledger.db, BENCHMARK_DAILY_CALL_CAP: '5' }));

      expect(unconfirmed.status).toBe(409);
      expect(await unconfirmed.json()).toMatchObject({
        code: 'benchmark_cell_reservation_required',
        requiresConfirmation: true,
        plannedCalls: 1,
      });
      expect(ledger.reservedCalls('2026-07-13')).toBe(1);
      expect(ledger.reservedCalls('2026-07-14')).toBe(0);

      const confirmed = await buildAdminRouter().request('/benchmark/dry-run/H-1', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({
          runId: 'run-1',
          models: { a: BENCHMARK_MODELS[0] },
          confirmPaidRun: true,
        }),
      }, env({ DB: ledger.db, BENCHMARK_DAILY_CALL_CAP: '5' }));

      expect(confirmed.status).toBe(200);
      expect(await confirmed.json()).toMatchObject({
        runId: 'run-1', outcome: 'skipped', reason: 'filing_or_raw_object_missing', invoked: false,
      });
      expect(ledger.reservedCalls('2026-07-13')).toBe(1);
      expect(ledger.reservedCalls('2026-07-14')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reserves a cross-day cell only once under concurrent confirmed delivery', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-14T00:00:00.100Z'));
      const requestProfile = {
        paidCallAuthorization: {
          version: 1,
          scope: 'initial_model_document_cells',
          reservedDay: '2026-07-13',
          reservedCalls: 1,
          documentCount: 1,
          models: [{ provider: 'openai', model: 'gpt-5.6-terra' }],
        },
      };
      const ledger = atomicReservationDb(claimableBenchmarkDb(requestProfile, null, {
        blockFirstClaimUntilSecond: true,
      }), 1, {
        initialDay: '2026-07-13',
      });
      const request = () => buildAdminRouter().request('/benchmark/dry-run/H-1', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({
          runId: 'run-1',
          models: { a: BENCHMARK_MODELS[0] },
          confirmPaidRun: true,
        }),
      }, env({ DB: ledger.db, BENCHMARK_DAILY_CALL_CAP: '5' }));

      const responses = await Promise.all([request(), request()]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 202]);
      expect(ledger.reservedCalls('2026-07-13')).toBe(1);
      expect(ledger.reservedCalls('2026-07-14')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed for legacy initial-cell authorizations without a reservation day', async () => {
    const legacyDb = claimableBenchmarkDb({
      paidCallAuthorization: {
        version: 1,
        scope: 'initial_model_document_cells',
        reservedCalls: 1,
        documentCount: 1,
        models: [{ provider: 'openai', model: 'gpt-5.6-terra' }],
      },
    });
    const ledger = atomicReservationDb(legacyDb, 1);
    const response = await buildAdminRouter().request('/benchmark/dry-run/H-1', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ runId: 'run-1', models: { a: BENCHMARK_MODELS[0] } }),
    }, env({ DB: ledger.db, BENCHMARK_DAILY_CALL_CAP: '5' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'benchmark_cell_reservation_required',
      requiresConfirmation: true,
      plannedCalls: 1,
    });
    expect(ledger.reservedCalls()).toBe(1);
  });

  it('requires and reserves the full legacy A+B agreement lineup before any provider call', async () => {
    const lineup = {
      a: { provider: 'openai', model: 'gpt-5.6-terra' },
      b: { provider: 'anthropic', model: 'claude-sonnet-5' },
    };
    const unconfirmed = await buildAdminRouter().request('/benchmark/dry-run/H-1', {
      method: 'POST', headers: AUTH, body: JSON.stringify({ models: lineup }),
    }, env());
    expect(unconfirmed.status).toBe(409);
    expect(await unconfirmed.json()).toMatchObject({
      requiresConfirmation: true,
      plannedCalls: 2,
      configuredModels: [lineup.a, lineup.b],
    });

    const base = env();
    const ledger = atomicReservationDb(base.DB, 1);
    const capped = await buildAdminRouter().request('/benchmark/dry-run/H-1', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ models: lineup, confirmPaidRun: true }),
    }, env({ DB: ledger.db, BENCHMARK_DAILY_CALL_CAP: '2' }));
    expect(capped.status).toBe(429);
    expect(await capped.json()).toMatchObject({ plannedCalls: 2, usedToday: 1, dailyCap: 2 });
    expect(ledger.reservedCalls()).toBe(1);
  });

  it('accepts an all-OpenRouter agreement lineup whose underlying vendors are distinct', async () => {
    const lineup = {
      a: { provider: 'llamaparse', model: 'cost-effective' },
      b: { provider: 'openrouter', model: 'google/gemini-3.8-flash' },
      c: { provider: 'openrouter', model: 'openai/gpt-5.6-terra' },
    };
    const response = await buildAdminRouter().request('/benchmark/dry-run/H-1', {
      method: 'POST', headers: AUTH, body: JSON.stringify({ models: lineup }),
    }, env({ LLAMAPARSE_API_KEY: 'llamaparse-key', OPENROUTER_API_KEY: 'openrouter-key' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      requiresConfirmation: true,
      plannedCalls: 3,
      configuredModels: [lineup.a, lineup.b, lineup.c],
    });
  });

  it('rejects an agreement lineup with identical model labels', async () => {
    const lineup = {
      a: { provider: 'openrouter', model: 'openai/gpt-5.6-terra' },
      b: { provider: 'openrouter', model: 'openai/gpt-5.6-terra' },
    };
    const response = await buildAdminRouter().request('/benchmark/dry-run/H-1', {
      method: 'POST', headers: AUTH, body: JSON.stringify({ models: lineup }),
    }, env());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'agreement benchmark models must be distinct',
    });
  });

  it('rejects the catalog-form OpenRouter auto route before model distinctness checks', async () => {
    const lineup = {
      a: { provider: 'openrouter', model: 'openrouter/auto' },
      b: { provider: 'openrouter', model: 'openai/gpt-5.6-terra' },
    };
    const response = await buildAdminRouter().request('/benchmark/dry-run/H-1', {
      method: 'POST', headers: AUTH, body: JSON.stringify({ models: lineup }),
    }, env());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'openrouter/auto cannot be used in agreement benchmarks because its routing is unpredictable',
    });
  });

  it('returns pending instead of duplicating a paid cell held by another lease', async () => {
    const running = benchmarkMeasurement('openai', 'gpt-5.6-terra', {
      invoked: 0,
      ok: 0,
      autonomous: 0,
      outcome: 'running',
      cost_usd: null,
      cost_source: 'unknown',
      claim_token: 'other-worker',
      lease_until: '2099-01-01T00:00:00.000Z',
    });
    const response = await buildAdminRouter().request('/benchmark/dry-run/H-1', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ runId: 'run-1', models: { a: BENCHMARK_MODELS[0] } }),
    }, env({ DB: persistedBenchmarkDb([running], [], 'running') }));

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      runId: 'run-1',
      docId: 'H-1',
      pending: true,
      state: 'running',
      leaseUntil: '2099-01-01T00:00:00.000Z',
    });
  });

  it('gates four concurrent non-canary cells, then makes one deterministic provider call and replays the filled failures', async () => {
    const model = { provider: 'openai', model: 'gpt-5.6-terra' };
    const docIds = ['H-1', 'H-2', 'H-3', 'H-4', 'H-5'];
    const circuit = benchmarkCircuitDb({ docIds, models: [model] });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: 'model_not_found',
        message: 'Project proj_private does not have access to model gpt-5.6-terra',
      },
    }), { status: 403, headers: { 'content-type': 'application/json' } }));
    const testEnv = env({
      DB: circuit.db,
      RAW_FILES: {
        async get() {
          return { arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer };
        },
      } as unknown as R2Bucket,
    });
    const request = (docId: string) => buildAdminRouter().request(`/benchmark/dry-run/${docId}`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ runId: 'run-1', models: { a: model }, confirmPaidRun: true }),
    }, testEnv);

    try {
      const gated = await Promise.all(docIds.slice(1).map(request));
      expect(gated.map((response) => response.status)).toEqual([202, 202, 202, 202]);
      for (const response of gated) {
        expect(await response.json()).toMatchObject({
          pending: true,
          state: 'provider_canary',
          canaryDocId: 'H-1',
          canaryModel: model,
          retryAfterMs: 1_000,
        });
      }
      expect(circuit.claimAttempts()).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();

      const canary = await request('H-1');
      expect(canary.status).toBe(200);
      expect(await canary.json()).toMatchObject({
        ok: false,
        invoked: true,
        error: 'The current openai project does not have access to gpt-5.6-terra.',
        failure: {
          code: 'model_access_denied', scope: 'model', retryable: false,
        },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(circuit.claimAttempts()).toBe(1);

      const replayed = await Promise.all(docIds.slice(1).map(request));
      expect(replayed.map((response) => response.status)).toEqual([200, 200, 200, 200]);
      for (const response of replayed) {
        expect(await response.json()).toMatchObject({
          cached: true,
          ok: false,
          invoked: false,
          error: 'model_access_denied',
          failure: { code: 'model_access_denied', scope: 'model', retryable: false },
          blockedBy: { provider: 'openai', model: 'gpt-5.6-terra', docId: 'H-1' },
        });
      }
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(circuit.claimAttempts()).toBe(1);
      expect(circuit.rows.size).toBe(5);
      expect(JSON.stringify([...circuit.rows.values()])).not.toContain('proj_private');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('fills only the failed model for a model-scoped block and replays the structured cause', async () => {
    const terra = { provider: 'openai', model: 'gpt-5.6-terra' };
    const luna = { provider: 'openai', model: 'gpt-5.6-luna' };
    const failure = {
      code: 'model_access_denied', scope: 'model' as const, retryable: false as const,
      message: 'The current openai project does not have access to gpt-5.6-terra.',
    };
    const circuit = benchmarkCircuitDb({
      docIds: ['H-1', 'H-2'],
      models: [terra, luna],
      results: [benchmarkFailureRow('H-1', terra, failure)],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const response = await buildAdminRouter().request('/benchmark/dry-run/H-2', {
        method: 'POST', headers: AUTH,
        body: JSON.stringify({ runId: 'run-1', models: { a: terra } }),
      }, env({ DB: circuit.db }));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        cached: true,
        invoked: false,
        failure,
        blockedBy: { provider: 'openai', model: 'gpt-5.6-terra', docId: 'H-1' },
      });
      expect([...circuit.rows.keys()].sort()).toEqual([
        circuitRowKey('H-1', terra),
        circuitRowKey('H-2', terra),
      ].sort());
      expect(circuit.claimAttempts()).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('fills sibling models for a provider-scoped block without overwriting an in-flight cell', async () => {
    const terra = { provider: 'openai', model: 'gpt-5.6-terra' };
    const luna = { provider: 'openai', model: 'gpt-5.6-luna' };
    const haiku = { provider: 'anthropic', model: 'claude-sonnet-5' };
    const failure = {
      code: 'provider_usage_limit', scope: 'provider' as const, retryable: false as const,
      message: 'openai rejected the request because the account usage limit was reached.',
    };
    const running = benchmarkMeasurement(luna.provider, luna.model, {
      doc_id: 'H-2', invoked: 0, ok: 0, outcome: 'running', autonomous: 0,
      error: 'in_flight_sentinel', row_count: 0, avg_confidence: null,
      latency_ms: null, cost_usd: null, cost_source: 'unknown',
      result_json: JSON.stringify({ sentinel: true }), perfect_match: null,
      true_positive: null, false_positive: null, false_negative: null,
      claim_token: 'active-owner', lease_until: '2099-01-01T00:00:00.000Z',
    });
    const circuit = benchmarkCircuitDb({
      docIds: ['H-1', 'H-2'],
      models: [terra, luna, haiku],
      results: [benchmarkFailureRow('H-1', terra, failure), running],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const response = await buildAdminRouter().request('/benchmark/dry-run/H-1', {
        method: 'POST', headers: AUTH,
        body: JSON.stringify({ runId: 'run-1', models: { a: luna } }),
      }, env({ DB: circuit.db }));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        cached: true,
        invoked: false,
        failure,
        blockedBy: { provider: 'openai', model: 'gpt-5.6-terra', docId: 'H-1' },
      });
      expect([...circuit.rows.keys()].sort()).toEqual([
        circuitRowKey('H-1', terra),
        circuitRowKey('H-2', terra),
        circuitRowKey('H-1', luna),
        circuitRowKey('H-2', luna),
      ].sort());
      const preserved = circuit.rows.get(circuitRowKey('H-2', luna));
      expect(preserved).toMatchObject({
        outcome: 'running', error: 'in_flight_sentinel', claim_token: 'active-owner',
        result_json: JSON.stringify({ sentinel: true }),
      });
      expect([...circuit.rows.keys()].some((key) => key.includes('anthropic'))).toBe(false);
      expect(circuit.claimAttempts()).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('does not silently retry an expired paid cell with an unknown outcome', async () => {
    const orphaned = benchmarkMeasurement('openai', 'gpt-5.6-terra', {
      invoked: 0,
      ok: 0,
      autonomous: 0,
      outcome: 'running',
      cost_usd: null,
      cost_source: 'unknown',
      claim_token: 'expired-worker',
      lease_until: '2026-01-01T00:00:00.000Z',
    });
    const response = await buildAdminRouter().request('/benchmark/dry-run/H-1', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ runId: 'run-1', models: { a: BENCHMARK_MODELS[0] } }),
    }, env({ DB: persistedBenchmarkDb([orphaned], [], 'running') }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'benchmark_attempt_outcome_unknown',
      state: 'orphaned',
      requiresRetryConfirmation: true,
    });
  });

  it('atomically reserves another paid call before an explicitly confirmed unknown-outcome retry', async () => {
    const ledger = atomicReservationDb(claimableBenchmarkDb({}, {
      outcome: 'running',
      claim_token: 'expired-worker',
      lease_until: '2026-01-01T00:00:00.000Z',
    }), 5);
    const response = await buildAdminRouter().request('/benchmark/dry-run/H-1', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        runId: 'run-1',
        models: { a: BENCHMARK_MODELS[0] },
        confirmRetryAfterUnknownOutcome: true,
      }),
    }, env({ DB: ledger.db, BENCHMARK_DAILY_CALL_CAP: '5' }));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: 'benchmark daily call cap reached',
      plannedCalls: 1,
      usedToday: 5,
      dailyCap: 5,
    });
    expect(ledger.reservedCalls()).toBe(5);
  });

  it('validates explicit unknown-outcome retry confirmation', async () => {
    const response = await buildAdminRouter().request('/benchmark/dry-run/H-1', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        runId: 'run-1',
        models: { a: BENCHMARK_MODELS[0] },
        confirmRetryAfterUnknownOutcome: 'yes',
      }),
    }, env());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'confirmRetryAfterUnknownOutcome must be a boolean',
    });
  });

  it('returns an effective chamber lineup, opaque version, and credential booleans', async () => {
    const response = await buildAdminRouter().request(
      '/benchmark/settings/house',
      { headers: AUTH },
      env(),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      chamber: 'house',
      valid: true,
      writeProtected: false,
      lineup: {
        a: { provider: 'mistral', model: 'mistral-ocr-latest' },
        b: { provider: 'openai', model: 'gpt-5.6-terra' },
        c: { provider: 'anthropic', model: 'claude-sonnet-5' },
      },
    });
    expect(body.version).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(body)).not.toContain('openai-key');
  });

  it('returns an effective chamber primary/failover, opaque version, and credential booleans', async () => {
    const response = await buildAdminRouter().request(
      '/benchmark/roles/house',
      { headers: AUTH },
      env(),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      chamber: 'house',
      valid: true,
      writeProtected: false,
      roles: {
        primary: { provider: 'openai', model: 'gpt-5.6-terra' },
        failover: { provider: 'anthropic', model: 'claude-sonnet-5' },
      },
    });
    expect(body.version).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(body)).not.toContain('openai-key');
  });

  it('rejects an identical primary/failover model pair before any write', async () => {
    const initial = await buildAdminRouter().request(
      '/benchmark/roles/house',
      { headers: AUTH },
      env(),
    );
    const initialBody = await initial.json() as Record<string, unknown>;

    const rejected = await buildAdminRouter().request('/benchmark/roles/house', {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({
        primary: { provider: 'openai', model: 'gpt-5.6-terra' },
        failover: { provider: 'openai', model: 'gpt-5.6-terra' },
        expectedVersion: initialBody.version,
      }),
    }, env());
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: 'primary and failover must be different models',
    });
  });

  it('rejects a stale expectedVersion when saving primary/failover', async () => {
    const response = await buildAdminRouter().request('/benchmark/roles/house', {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({
        primary: { provider: 'mistral', model: 'mistral-ocr-latest' },
        failover: { provider: 'openai', model: 'gpt-5.6-terra' },
        expectedVersion: 'stale-version',
      }),
    }, env());
    expect(response.status).toBe(409);
    const body = await response.json() as Record<string, unknown>;
    expect(body.error).toMatch(/reload and retry/);
  });

  it('keeps primary/failover settings read-only in preview deployments', async () => {
    const response = await buildAdminRouter().request('/benchmark/roles/house', {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({
        primary: { provider: 'mistral', model: 'mistral-ocr-latest' },
        failover: { provider: 'openai', model: 'gpt-5.6-terra' },
        expectedVersion: 'never-read',
      }),
    }, env({
      PREVIEW_DEPLOYMENT: 'true',
      DB: {
        prepare() { throw new Error('preview guard must run before D1 or Infisical writes'); },
      } as unknown as D1Database,
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'benchmark role settings are read-only in preview deployments',
      code: 'preview_write_protected',
    });
  });

  it('keeps chamber lineup settings read-only in preview deployments', async () => {
    const response = await buildAdminRouter().request('/benchmark/settings/house', {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({
        a: BENCHMARK_MODELS[0], b: BENCHMARK_MODELS[1], c: BENCHMARK_MODELS[2],
        sourceRunId: 'run-1', expectedVersion: 'never-read',
      }),
    }, env({
      PREVIEW_DEPLOYMENT: 'true',
      DB: {
        prepare() { throw new Error('preview guard must run before D1 or Infisical writes'); },
      } as unknown as D1Database,
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'benchmark lineup settings are read-only in preview deployments',
      code: 'preview_write_protected',
    });
  });

  it('validates history chamber filters before querying D1', async () => {
    const response = await buildAdminRouter().request(
      '/benchmark/runs?chamber=oge',
      { headers: AUTH },
      env(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid chamber' });
  });

  it('simulates a measured tier-one agreement with actual cost and parallel wall time', async () => {
    const parsed = {
      ticker: 'AAPL',
      assetName: 'Apple Inc.',
      txDate: '2026-07-01',
      txType: 'B',
      amountMin: 1_001,
      amountMax: 15_000,
      owner: 'self',
      assetType: 'ST',
      assetTypeName: 'Stock',
      isOption: false,
      capGainsOver200: false,
      rawText: 'Apple Inc.',
      confidence: 0.99,
    };
    const run = {
      id: 'run-1', chamber: 'house', status: 'completed',
      requested_doc_count: 1, completed_doc_count: 1, model_count: 3,
      models_json: JSON.stringify([
        { provider: 'openai', model: 'gpt-5.6-terra' },
        { provider: 'gemini', model: 'gemini-3.5-flash' },
        { provider: 'anthropic', model: 'claude-sonnet-5' },
      ]),
      started_at: '2026-07-13T12:00:00.000Z',
      completed_at: '2026-07-13T12:01:00.000Z', duration_ms: 60_000,
      known_cost_usd: 0.003, cost_covered_calls: 2, invoked_calls: 2,
      summary_json: null, selected_lineup_json: null, selected_at: null,
      selection_error: null, selection_audit_json: null, error: null,
      created_at: '2026-07-13T12:00:00.000Z', updated_at: '2026-07-13T12:01:00.000Z',
    };
    const document = {
      run_id: 'run-1', doc_id: 'H-1', ordinal: 0, resolved: 1,
      ground_truth_json: JSON.stringify([parsed]),
    };
    const measurement = (provider: string, model: string, latency: number, cost: number) => ({
      run_id: 'run-1', doc_id: 'H-1', provider, model, resolved_model: model,
      invoked: 1, ok: 1, outcome: 'would_publish', autonomous: 1, error: null,
      row_count: 1, avg_confidence: 0.99, latency_ms: latency, cost_usd: cost,
      cost_source: 'usage_priced', cost_detail_json: '{}', provider_request_id: null,
      usage_json: '{}', result_json: JSON.stringify({ rows: [parsed], flags: [] }),
      perfect_match: 1, true_positive: 1, false_positive: 0, false_negative: 0,
      started_at: null, completed_at: null, created_at: '2026-07-13T12:00:01.000Z',
    });
    const results = [
      measurement('openai', 'gpt-5.6-terra', 100, 0.001),
      measurement('gemini', 'gemini-3.5-flash', 200, 0.002),
      measurement('anthropic', 'claude-sonnet-5', 300, 0.004),
    ];
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async first<T>() {
            return (/FROM benchmark_runs/i.test(sql) ? run : null) as T | null;
          },
          async all<T>() {
            if (/FROM benchmark_run_documents/i.test(sql)) return { results: [document] as T[] };
            if (/FROM benchmark_model_results/i.test(sql)) return { results: results as T[] };
            return { results: [] as T[] };
          },
        };
        return statement;
      },
    } as unknown as D1Database;

    const response = await buildAdminRouter().request('/benchmark/runs/run-1/simulate', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        a: { provider: 'openai', model: 'gpt-5.6-terra' },
        b: { provider: 'gemini', model: 'gemini-3.5-flash' },
        c: { provider: 'anthropic', model: 'claude-sonnet-5' },
      }),
    }, env({ DB: db }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      documentsSimulated: 1,
      incompleteDocuments: 0,
      tier1AutonomyRate: 1,
      cascadeAutonomyRate: 1,
      accuracyRate: 1,
      requiredCalls: 2,
      invokedCalls: 2,
      costCoveredCalls: 2,
      knownCostUsd: 0.003,
      actualCostPerDocumentUsd: 0.003,
      avgWallClockMs: 300,
      p50WallClockMs: 300,
      p95WallClockMs: 300,
    });
  });

  it('models disagreement as tier-one A+B followed by fresh tier-two A+B+C', async () => {
    const rowA = {
      ticker: 'AAPL', assetName: 'Apple Inc.', txDate: '2026-07-01', txType: 'B',
      amountMin: 1_001, amountMax: 15_000, owner: 'self', assetType: 'ST',
      assetTypeName: 'Stock', isOption: false, capGainsOver200: false,
      rawText: 'Apple', confidence: 0.99,
    };
    const rowB = { ...rowA, ticker: 'MSFT', assetName: 'Microsoft Corp.' };
    const results = [
      benchmarkMeasurement('openai', 'gpt-5.6-terra', {
        latency_ms: 100, cost_usd: 0.001,
        result_json: JSON.stringify({ rows: [rowA], flags: [] }),
      }),
      benchmarkMeasurement('gemini', 'gemini-3.5-flash', {
        latency_ms: 200, cost_usd: 0.002,
        result_json: JSON.stringify({ rows: [rowB], flags: [] }),
      }),
      benchmarkMeasurement('anthropic', 'claude-sonnet-5', {
        latency_ms: 300, cost_usd: 0.004,
        result_json: JSON.stringify({ rows: [rowA], flags: [] }),
      }),
    ];
    const response = await buildAdminRouter().request('/benchmark/runs/run-1/simulate', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ a: BENCHMARK_MODELS[0], b: BENCHMARK_MODELS[1], c: BENCHMARK_MODELS[2] }),
    }, env({ DB: persistedBenchmarkDb(results, [rowA]) }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      documentsSimulated: 1,
      incompleteDocuments: 0,
      requiredCalls: 5,
      invokedCalls: 5,
      costCoveredCalls: 5,
      knownCostUsd: 0.01,
      actualCostPerDocumentUsd: 0.01,
      avgWallClockMs: 900,
      p50WallClockMs: 900,
      p95WallClockMs: 900,
    });
  });

  it('excludes unavailable required readings and blocks saving their model', async () => {
    const results = [
      benchmarkMeasurement('openai', 'gpt-5.6-terra', {
        invoked: 0, ok: 0, autonomous: 0, cost_usd: null, cost_source: 'unknown',
      }),
      benchmarkMeasurement('gemini', 'gemini-3.5-flash', { cost_usd: 0.002 }),
      benchmarkMeasurement('anthropic', 'claude-sonnet-5', { cost_usd: 0.004 }),
    ];
    const db = persistedBenchmarkDb(results);
    const simulation = await buildAdminRouter().request('/benchmark/runs/run-1/simulate', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ a: BENCHMARK_MODELS[0], b: BENCHMARK_MODELS[1], c: BENCHMARK_MODELS[2] }),
    }, env({ DB: db }));
    expect(simulation.status).toBe(200);
    expect(await simulation.json()).toMatchObject({
      documentsSimulated: 0,
      incompleteDocuments: 1,
      requiredCalls: 2,
      invokedCalls: 1,
      costCoveredCalls: 1,
      actualCostPerDocumentUsd: null,
    });

    const save = await buildAdminRouter().request('/benchmark/settings/house', {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({
        a: BENCHMARK_MODELS[0], b: BENCHMARK_MODELS[1], c: BENCHMARK_MODELS[2],
        sourceRunId: 'run-1', expectedVersion: 'unused-before-validation',
      }),
    }, env({ DB: db }));
    expect(save.status).toBe(409);
    expect(await save.json()).toMatchObject({
      error: 'selected models require full successful coverage plus autonomous and scored evidence',
      invalidModelCoverage: [{
        model: BENCHMARK_MODELS[0],
        requiredReadings: 1,
        measuredReadings: 1,
        invokedReadings: 0,
        successfulReadings: 0,
        failedReadings: 0,
        autonomousReadings: 0,
        scoredReadings: 0,
      }],
    });
  });

  it('blocks promotion of a model that was invoked but failed every reading', async () => {
    const results = [
      benchmarkMeasurement('openai', 'gpt-5.6-terra', {
        ok: 0, autonomous: 0, outcome: 'skipped', error: 'model_not_found',
      }),
      benchmarkMeasurement('gemini', 'gemini-3.5-flash'),
      benchmarkMeasurement('anthropic', 'claude-sonnet-5'),
    ];
    const response = await buildAdminRouter().request('/benchmark/settings/house', {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({
        a: BENCHMARK_MODELS[0], b: BENCHMARK_MODELS[1], c: BENCHMARK_MODELS[2],
        sourceRunId: 'run-1', expectedVersion: 'unused-before-validation',
      }),
    }, env({ DB: persistedBenchmarkDb(results) }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      invalidModelCoverage: [{
        model: BENCHMARK_MODELS[0], invokedReadings: 1, successfulReadings: 0,
      }],
    });
  });

  it('blocks promotion when a model has even one failed reading among successful ones', async () => {
    const results = BENCHMARK_MODELS.flatMap((model) => [
      benchmarkMeasurement(model.provider, model.model, { doc_id: 'H-1' }),
      benchmarkMeasurement(model.provider, model.model, {
        doc_id: 'H-2',
        ...(model.provider === 'openai' ? {
          ok: 0, autonomous: 0, outcome: 'skipped', error: 'provider_failure',
          perfect_match: null, true_positive: null, false_positive: null, false_negative: null,
        } : {}),
      }),
    ]);
    const response = await buildAdminRouter().request('/benchmark/settings/house', {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({
        a: BENCHMARK_MODELS[0], b: BENCHMARK_MODELS[1], c: BENCHMARK_MODELS[2],
        sourceRunId: 'run-1', expectedVersion: 'unused-before-validation',
      }),
    }, env({ DB: persistedBenchmarkDb(results, [], 'completed', ['H-1', 'H-2']) }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      invalidModelCoverage: [{
        model: BENCHMARK_MODELS[0], requiredReadings: 2, measuredReadings: 2,
        invokedReadings: 2, successfulReadings: 1, failedReadings: 1,
        autonomousReadings: 1, scoredReadings: 1,
      }],
    });
  });
});
