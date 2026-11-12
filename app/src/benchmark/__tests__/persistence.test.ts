import { describe, expect, it } from 'vitest';
import {
  beginBenchmarkRun,
  clearBenchmarkRuns,
  BenchmarkRunStateConflictError,
  claimBenchmarkMeasurement,
  completeBenchmarkRun,
  failBenchmarkRun,
  recordBenchmarkSelection,
  releaseBenchmarkMeasurementClaim,
  rescoreBenchmarkRun,
  reuseSuccessfulBenchmarkMeasurements,
  saveBenchmarkMeasurement,
  saveUnavailableBenchmarkMeasurementsIfAbsent,
  summarizeBenchmarkMeasurements,
  type BenchmarkRunDetail,
} from '../persistence.ts';

interface CapturedStatement {
  sql: string;
  params: unknown[];
}

function captureDb(): { db: D1Database; statements: CapturedStatement[] } {
  const statements: CapturedStatement[] = [];
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        params = values;
        return statement;
      },
      async run() {
        statements.push({ sql, params });
        return { success: true, meta: { changes: 1 } } as unknown as D1Result;
      },
    };
    return statement;
  };
  const db = {
    prepare,
    async batch(prepared: D1PreparedStatement[]) {
      const results: D1Result[] = [];
      for (const statement of prepared) results.push(await statement.run());
      return results;
    },
  } as unknown as D1Database;
  return { db, statements };
}

type Result = BenchmarkRunDetail['results'][number];

function result(over: Partial<Result> = {}): Result {
  return {
    runId: 'run-1',
    docId: 'doc-1',
    provider: 'openai',
    model: 'gpt-test',
    resolvedModel: 'gpt-test-2026-07-01',
    invoked: true,
    ok: true,
    outcome: 'would_publish',
    autonomous: true,
    error: null,
    rowCount: 2,
    avgConfidence: 0.95,
    latencyMs: 100,
    costUsd: 0.001,
    costSource: 'usage_priced',
    costDetail: null,
    providerRequestId: null,
    usage: null,
    result: null,
    perfectMatch: true,
    truePositive: 2,
    falsePositive: 0,
    falseNegative: 0,
    startedAt: null,
    completedAt: null,
    ...over,
  };
}

describe('benchmark persistence', () => {
  it('requires explicit confirmation before retrying an expired paid cell', async () => {
    let row: { outcome: string; claim_token: string | null; lease_until: string } | null = null;
    const db = {
      prepare(sql: string) {
        let params: unknown[] = [];
        const statement = {
          bind(...values: unknown[]) { params = values; return statement; },
          async run() {
            if (/UPDATE benchmark_model_results[\s\S]*SET claim_token = NULL/.test(sql)) {
              const accepted = row?.claim_token === String(params[5]);
              if (accepted && row) row = { ...row, claim_token: null, lease_until: String(params[0]) };
              return { success: true, meta: { changes: accepted ? 1 : 0 } } as unknown as D1Result;
            }
            if (/INSERT INTO benchmark_model_results/.test(sql)) {
              const now = String(params[4]);
              if (!row || (params[9] === 1 && row.outcome === 'running' && row.lease_until <= now)) {
                row = {
                  outcome: 'running',
                  claim_token: String(params[5]),
                  lease_until: String(params[6]),
                };
                return { success: true, meta: { changes: 1 } } as unknown as D1Result;
              }
            }
            return { success: true, meta: { changes: 0 } } as unknown as D1Result;
          },
          async first<T>() {
            if (/SELECT status FROM benchmark_runs/i.test(sql)) {
              return { status: 'running' } as T;
            }
            return row as T | null;
          },
        };
        return statement;
      },
    } as unknown as D1Database;

    const first = await claimBenchmarkMeasurement(db, {
      runId: 'run-1', docId: 'doc-1', provider: 'openai', model: 'gpt-test',
      now: '2026-07-13T12:00:00.000Z', leaseMs: 60_000,
    });
    expect(first).toMatchObject({ claimed: true, state: 'claimed' });

    const concurrent = await claimBenchmarkMeasurement(db, {
      runId: 'run-1', docId: 'doc-1', provider: 'openai', model: 'gpt-test',
      now: '2026-07-13T12:00:30.000Z', leaseMs: 60_000,
    });
    expect(concurrent).toEqual({
      claimed: false,
      claimToken: null,
      leaseUntil: '2026-07-13T12:01:00.000Z',
      state: 'running',
      reclaimedUnknownOutcome: false,
    });

    const orphaned = await claimBenchmarkMeasurement(db, {
      runId: 'run-1', docId: 'doc-1', provider: 'openai', model: 'gpt-test',
      now: '2026-07-13T12:01:00.000Z', leaseMs: 60_000,
    });
    expect(orphaned).toEqual({
      claimed: false,
      claimToken: null,
      leaseUntil: '2026-07-13T12:01:00.000Z',
      state: 'orphaned',
      reclaimedUnknownOutcome: false,
    });

    const reclaimed = await claimBenchmarkMeasurement(db, {
      runId: 'run-1', docId: 'doc-1', provider: 'openai', model: 'gpt-test',
      now: '2026-07-13T12:01:00.000Z', leaseMs: 60_000,
      allowRetryAfterUnknownOutcome: true,
    });
    expect(reclaimed).toMatchObject({
      claimed: true,
      state: 'claimed',
      reclaimedUnknownOutcome: true,
    });
    expect(reclaimed.claimToken).not.toBe(first.claimToken);
    if (!reclaimed.claimToken) throw new Error('expected reclaimed benchmark claim token');

    await expect(releaseBenchmarkMeasurementClaim(db, {
      runId: 'run-1', docId: 'doc-1', provider: 'openai', model: 'gpt-test',
      claimToken: reclaimed.claimToken, preserveUnknownOutcome: true,
      now: '2026-07-13T12:01:00.000Z',
    })).resolves.toBe(true);
    await expect(claimBenchmarkMeasurement(db, {
      runId: 'run-1', docId: 'doc-1', provider: 'openai', model: 'gpt-test',
      now: '2026-07-13T12:01:00.001Z', leaseMs: 60_000,
    })).resolves.toMatchObject({ claimed: false, state: 'orphaned' });
  });

  it('deletes only the matching fresh uninvoked claim when reservation fails', async () => {
    const { db, statements } = captureDb();
    await expect(releaseBenchmarkMeasurementClaim(db, {
      runId: 'run-1',
      docId: 'doc-1',
      provider: 'openai',
      model: 'gpt-test',
      claimToken: 'claim-1',
      preserveUnknownOutcome: false,
    })).resolves.toBe(true);

    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toMatch(/DELETE FROM benchmark_model_results/);
    expect(statements[0]?.sql).toMatch(/outcome = 'running' AND invoked = 0 AND claim_token = \?/);
    expect(statements[0]?.params).toEqual([
      'run-1', 'doc-1', 'openai', 'gpt-test', 'claim-1',
    ]);
  });

  it('fills deterministic unavailable cells without overwriting an existing claim', async () => {
    const statements: CapturedStatement[] = [];
    let call = 0;
    const db = {
      prepare(sql: string) {
        const statement = {
          params: [] as unknown[],
          bind(...params: unknown[]) { statement.params = params; return statement; },
          async run() {
            statements.push({ sql, params: statement.params });
            call++;
            return {
              success: true,
              meta: { changes: call === 1 ? 1 : 0 },
            } as unknown as D1Result;
          },
        };
        return statement;
      },
      async batch(prepared: D1PreparedStatement[]) {
        return Promise.all(prepared.map((statement) => statement.run()));
      },
    } as unknown as D1Database;

    const saved = await saveUnavailableBenchmarkMeasurementsIfAbsent(db, [
      {
        runId: 'run-1', docId: 'H-2', provider: 'openai', model: 'gpt-5.6-terra',
        error: 'blocked_by_model_failure:model_access_denied',
        costDetail: { unknownReason: 'not_invoked' },
        result: { failure: { code: 'model_access_denied', scope: 'model', retryable: false } },
        createdAt: '2026-07-14T12:00:00.000Z',
      },
      {
        runId: 'run-1', docId: 'H-3', provider: 'openai', model: 'gpt-5.6-terra',
        error: 'blocked_by_model_failure:model_access_denied',
        createdAt: '2026-07-14T12:00:00.000Z',
      },
    ]);

    expect(saved).toEqual({ attempted: 2, inserted: 1 });
    expect(statements).toHaveLength(2);
    expect(statements[0]?.sql).toMatch(/ON CONFLICT \(run_id, doc_id, provider, model\) DO NOTHING/);
    expect(statements[0]?.sql).toContain("VALUES (?, ?, ?, ?, NULL, 0, 0, 'skipped'");
    expect(statements[0]?.sql).toMatch(/'skipped', 0, \?, 0, NULL, NULL, NULL/);
    expect(statements[0]?.sql).not.toContain('DO UPDATE');
    expect(statements[0]?.params).toEqual([
      'run-1',
      'H-2',
      'openai',
      'gpt-5.6-terra',
      'blocked_by_model_failure:model_access_denied',
      '{"unknownReason":"not_invoked"}',
      '{"failure":{"code":"model_access_denied","scope":"model","retryable":false}}',
      '2026-07-14T12:00:00.000Z',
      '2026-07-14T12:00:00.000Z',
      '2026-07-14T12:00:00.000Z',
    ]);
  });

  it('starts a chamber-scoped run and snapshots its ordered documents', async () => {
    const { db, statements } = captureDb();
    const run = await beginBenchmarkRun(db, {
      id: 'run-1',
      chamber: 'executive',
      models: [
        { provider: 'openai', model: 'gpt-test' },
        { provider: 'anthropic', model: 'claude-test' },
      ],
      documents: [
        { docId: 'doc-1', resolved: true, groundTruth: [{ ticker: 'AAPL' }] },
        { docId: 'doc-2', resolved: false },
      ],
      startedAt: '2026-07-13T12:00:00.000Z',
      requestProfile: { version: 'benchmark-v1', serviceTier: 'default' },
    });

    expect(run).toMatchObject({
      id: 'run-1',
      chamber: 'executive',
      status: 'running',
      requestedDocCount: 2,
      selectedLineup: null,
      requestProfile: { version: 'benchmark-v1', serviceTier: 'default' },
    });
    expect(statements).toHaveLength(3);
    expect(statements[0].sql).toContain('INSERT INTO benchmark_runs');
    expect(statements[0].params).toContain('{"version":"benchmark-v1","serviceTier":"default"}');
    expect(statements[1]).toMatchObject({
      params: ['run-1', 'doc-1', 0, 1, '[{"ticker":"AAPL"}]'],
    });
    expect(statements[2]).toMatchObject({ params: ['run-1', 'doc-2', 1, 0, null] });
  });

  it('copies prior successful same-chamber doc/model measurements without provider calls', async () => {
    const statements: CapturedStatement[] = [];
    let call = 0;
    const db = {
      prepare(sql: string) {
        const statement = {
          params: [] as unknown[],
          bind(...params: unknown[]) { statement.params = params; return statement; },
          async run() {
            statements.push({ sql, params: statement.params });
            call++;
            return { success: true, meta: { changes: call === 1 ? 1 : 0 } } as unknown as D1Result;
          },
        };
        return statement;
      },
      async batch(prepared: D1PreparedStatement[]) {
        return Promise.all(prepared.map((statement) => statement.run()));
      },
    } as unknown as D1Database;

    const reused = await reuseSuccessfulBenchmarkMeasurements(db, {
      runId: 'run-new',
      chamber: 'house',
      models: [
        { provider: 'openai', model: 'gpt-5.6-terra' },
        { provider: 'anthropic', model: 'claude-sonnet-5' },
      ],
      billableModels: [{ provider: 'openai', model: 'gpt-5.6-terra' }],
      documents: [{ docId: 'H-1', resolved: true }],
      reusedAt: '2026-07-15T12:00:00.000Z',
    });

    expect(reused).toEqual({ attempted: 2, reused: 1, reusedBillable: 1 });
    expect(statements).toHaveLength(2);
    expect(statements[0]?.sql).toMatch(/JOIN benchmark_runs br ON br.id = bmr.run_id/);
    expect(statements[0]?.sql).toMatch(/br.chamber = \?/);
    expect(statements[0]?.sql).toMatch(/bmr.ok = 1/);
    expect(statements[0]?.sql).toMatch(/ON CONFLICT \(run_id, doc_id, provider, model\) DO NOTHING/);
    expect(statements[0]?.params).toEqual([
      'run-new',
      'H-1',
      '2026-07-15T12:00:00.000Z',
      'house',
      'run-new',
      'H-1',
      'openai',
      'gpt-5.6-terra',
    ]);
  });

  it('persists auditable usage-priced cost without treating missing cost as zero', async () => {
    const { db, statements } = captureDb();
    await saveBenchmarkMeasurement(db, {
      runId: 'run-1',
      docId: 'doc-1',
      provider: 'openai',
      model: 'gpt-test',
      resolvedModel: 'gpt-test-2026-07-01',
      invoked: true,
      ok: true,
      outcome: 'would_publish',
      autonomous: true,
      rowCount: 2,
      latencyMs: 325,
      costUsd: 0.001234,
      costSource: 'usage_priced',
      costDetail: {
        rateCardVersion: '2026-07-13',
        billedUsage: { inputTokens: 100, outputTokens: 20 },
      },
      usage: { promptTokens: 100, completionTokens: 20 },
      perfectMatch: true,
      truePositive: 2,
      falsePositive: 0,
      falseNegative: 0,
      createdAt: '2026-07-13T12:00:01.000Z',
    });

    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain('ON CONFLICT (run_id, doc_id, provider, model)');
    expect(statements[0].params).toContain(0.001234);
    expect(statements[0].params).toContain('usage_priced');
    expect(statements[0].params).toContain('gpt-test-2026-07-01');
  });

  it('uses a lease token to prevent stale workers from overwriting a benchmark cell', async () => {
    const { db, statements } = captureDb();
    await saveBenchmarkMeasurement(db, {
      runId: 'run-1',
      docId: 'doc-1',
      provider: 'openai',
      model: 'gpt-test',
      invoked: true,
      ok: true,
      outcome: 'would_publish',
      autonomous: true,
      rowCount: 1,
      costUsd: 0.001,
      costSource: 'usage_priced',
      claimToken: 'claim-1',
    });

    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain("AND claim_token = ? AND outcome = 'running'");
    expect(statements[0].params.at(-1)).toBe('claim-1');
  });

  it('rejects a dollar value whose source is unknown', async () => {
    const { db } = captureDb();
    await expect(saveBenchmarkMeasurement(db, {
      runId: 'run-1',
      docId: 'doc-1',
      provider: 'openai',
      model: 'gpt-test',
      invoked: true,
      ok: false,
      autonomous: false,
      rowCount: 0,
      costUsd: 0,
      costSource: 'unknown',
    })).rejects.toThrow('unknown cost source requires costUsd=null');
  });

  it('records the selected A/B/C lineup with a non-secret settings receipt', async () => {
    const { db, statements } = captureDb();
    await recordBenchmarkSelection(db, 'run-1', {
      lineup: {
        a: { provider: 'openai', model: 'gpt-test' },
        b: { provider: 'anthropic', model: 'claude-test' },
        c: null,
      },
      selectedAt: '2026-07-13T12:05:00.000Z',
      audit: { chamber: 'house', keys: ['AGREEMENT_HOUSE_MODEL_C', 'AGREEMENT_HOUSE_MODEL_D'] },
    });

    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain('selected_lineup_json');
    expect(statements[0].params[0]).toBe(
      '{"a":{"provider":"openai","model":"gpt-test"},"b":{"provider":"anthropic","model":"claude-test"},"c":null}',
    );
    expect(String(statements[0].params[3])).toContain('AGREEMENT_HOUSE_MODEL_C');
  });

  it('clears one chamber benchmark history only after active runs are stopped', async () => {
    const statements: CapturedStatement[] = [];
    const db = {
      prepare(sql: string) {
        let params: unknown[] = [];
        const statement = {
          bind(...values: unknown[]) { params = values; return statement; },
          async first<T>() {
            return null as T | null;
          },
          async all<T>() {
            if (/FROM benchmark_runs WHERE chamber/i.test(sql)) {
              return { results: [{ id: 'run-a' }, { id: 'run-b' }] as T[] };
            }
            return { results: [] as T[] };
          },
          async run() {
            statements.push({ sql, params });
            return { success: true, meta: { changes: sql.includes('benchmark_runs') ? 2 : 4 } } as unknown as D1Result;
          },
        };
        return statement;
      },
    } as unknown as D1Database;

    await expect(clearBenchmarkRuns(db, 'senate')).resolves.toEqual({
      runsDeleted: 2,
      documentsDeleted: 4,
      resultsDeleted: 4,
    });
    expect(statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining('DELETE FROM benchmark_model_results'),
      expect.stringContaining('DELETE FROM benchmark_run_documents'),
      expect.stringContaining('DELETE FROM benchmark_runs'),
    ]);
    expect(statements[2].params).toEqual(['run-a', 'run-b', 'senate']);
  });

  it('atomically stops only a running benchmark', async () => {
    const { db, statements } = captureDb();
    await expect(failBenchmarkRun(
      db,
      'run-1',
      'cancelled_by_operator',
      '2026-07-14T14:00:00.000Z',
    )).resolves.toBe(true);

    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain("WHERE id = ? AND status = 'running'");
    expect(statements[0]?.params).toEqual([
      '2026-07-14T14:00:00.000Z',
      '2026-07-14T14:00:00.000Z',
      'cancelled_by_operator',
      '2026-07-14T14:00:00.000Z',
      'run-1',
    ]);
  });

  it('cannot complete over a concurrent cancellation', async () => {
    const runRow = {
      id: 'run-1', chamber: 'house', status: 'running' as 'running' | 'completed' | 'failed',
      requested_doc_count: 1, completed_doc_count: 0, model_count: 1,
      models_json: JSON.stringify([{ provider: 'openai', model: 'gpt-test' }]),
      request_profile_json: JSON.stringify({
        scoringProfile: 'ct-benchmark-scoring-v2-row-identity-strict-document',
      }),
      started_at: '2026-07-14T12:00:00.000Z', completed_at: null, duration_ms: null,
      known_cost_usd: null, cost_covered_calls: 0, invoked_calls: 0, summary_json: null,
      selected_lineup_json: null, selected_at: null, selection_error: null,
      selection_audit_json: null, error: null as string | null,
      created_at: '2026-07-14T12:00:00.000Z', updated_at: '2026-07-14T12:00:00.000Z',
    };
    const document = {
      run_id: 'run-1', doc_id: 'doc-1', ordinal: 0, resolved: 1,
      ground_truth_json: '[]',
    };
    const measurement = {
      run_id: 'run-1', doc_id: 'doc-1', provider: 'openai', model: 'gpt-test',
      resolved_model: 'gpt-test', invoked: 1, ok: 1, outcome: 'would_publish',
      autonomous: 1, error: null, row_count: 0, avg_confidence: 0.9,
      latency_ms: 100, cost_usd: 0.01, cost_source: 'usage_priced',
      cost_detail_json: null, provider_request_id: null, usage_json: null,
      result_json: '{"rows":[],"flags":[]}', perfect_match: 1,
      true_positive: 0, false_positive: 0, false_negative: 0,
      started_at: '2026-07-14T12:00:00.000Z', completed_at: '2026-07-14T12:00:01.000Z',
      claim_token: null, lease_until: null, created_at: '2026-07-14T12:00:01.000Z',
    };
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async first<T>() { return (/FROM benchmark_runs/i.test(sql) ? runRow : null) as T | null; },
          async all<T>() {
            if (/FROM benchmark_run_documents/i.test(sql)) return { results: [document] as T[] };
            if (/FROM benchmark_model_results/i.test(sql)) return { results: [measurement] as T[] };
            return { results: [] as T[] };
          },
          async run() {
            if (/SET status = 'completed'/i.test(sql)) {
              // The cancel UPDATE wins after completion's initial read.
              runRow.status = 'failed';
              runRow.error = 'cancelled_by_operator';
              return { success: true, meta: { changes: 0 } } as D1Result;
            }
            return { success: true, meta: { changes: 0 } } as D1Result;
          },
        };
        return statement;
      },
    } as unknown as D1Database;

    await expect(completeBenchmarkRun(
      db,
      'run-1',
      '2026-07-14T12:01:00.000Z',
    )).rejects.toEqual(expect.objectContaining({
      name: 'BenchmarkRunStateConflictError',
      status: 'failed',
    } satisfies Partial<BenchmarkRunStateConflictError>));
    expect(runRow).toMatchObject({ status: 'failed', error: 'cancelled_by_operator' });
  });
});

describe('summarizeBenchmarkMeasurements', () => {
  const models = [
    { provider: 'openai', model: 'gpt-test' },
    { provider: 'anthropic', model: 'claude-test' },
  ];

  it('reports actual latency percentiles and a cost/doc only at full coverage', () => {
    const summary = summarizeBenchmarkMeasurements(models, 2, [
      result({ docId: 'doc-1', latencyMs: 100, costUsd: 0.001 }),
      result({ docId: 'doc-2', latencyMs: 300, costUsd: 0.003, perfectMatch: false, truePositive: 1, falsePositive: 1, falseNegative: 1 }),
      result({ docId: 'doc-1', provider: 'anthropic', model: 'claude-test', latencyMs: 200, costUsd: 0.002 }),
      result({ docId: 'doc-2', provider: 'anthropic', model: 'claude-test', latencyMs: 400, costUsd: 0.004 }),
    ]);

    expect(summary).toMatchObject({
      documentCount: 2,
      invokedCalls: 4,
      coveredInvocations: 4,
      costCoverageRate: 1,
      knownCostUsd: 0.01,
      actualCostPerDocumentUsd: 0.005,
      avgLatencyMs: 250,
      p50LatencyMs: 200,
      p95LatencyMs: 400,
    });
    expect(summary.models[0]).toMatchObject({
      provider: 'openai',
      docsMeasured: 2,
      perfectMatches: 1,
      perfectMatchRate: 0.5,
      avgLatencyMs: 200,
      p50LatencyMs: 100,
      p95LatencyMs: 300,
      knownCostUsd: 0.004,
      actualCostPerDocumentUsd: 0.002,
    });
  });

  it('keeps known spend visible but nulls actual cost/doc when any invoked call is unpriced', () => {
    const summary = summarizeBenchmarkMeasurements(models, 1, [
      result({ costUsd: 0.001 }),
      result({
        provider: 'anthropic',
        model: 'claude-test',
        costUsd: null,
        costSource: 'unknown',
      }),
      result({
        provider: 'anthropic',
        model: 'claude-test',
        docId: 'not-invoked',
        invoked: false,
        latencyMs: 0,
        costUsd: null,
        costSource: 'unknown',
      }),
    ]);

    expect(summary).toMatchObject({
      invokedCalls: 2,
      coveredInvocations: 1,
      costCoverageRate: 0.5,
      knownCostUsd: 0.001,
      actualCostPerDocumentUsd: null,
      avgLatencyMs: 100,
    });
    expect(summary.models[1]).toMatchObject({
      providerCalls: 1,
      unavailableDocs: 1,
      docsOk: 1,
      failures: 0,
      autonomousDocs: 1,
      autonomyRate: 1,
      coveredInvocations: 0,
      costCoverageRate: 0,
      knownCostUsd: 0,
      actualCostPerDocumentUsd: null,
    });
  });

  it('reports successful extraction speed separately from provider-failure latency', () => {
    const summary = summarizeBenchmarkMeasurements(models, 2, [
      result({ docId: 'doc-1', latencyMs: 100 }),
      result({
        docId: 'doc-2',
        latencyMs: 5,
        ok: false,
        autonomous: false,
        outcome: 'skipped',
        perfectMatch: null,
        truePositive: null,
        falsePositive: null,
        falseNegative: null,
      }),
    ]);

    expect(summary).toMatchObject({
      avgLatencyMs: 100,
      p50LatencyMs: 100,
      p95LatencyMs: 100,
      avgFailureLatencyMs: 5,
      p50FailureLatencyMs: 5,
      p95FailureLatencyMs: 5,
    });
    expect(summary.models[0]).toMatchObject({
      providerCalls: 2,
      docsOk: 1,
      failures: 1,
      autonomyRate: 1,
      resolvedDocs: 1,
      avgLatencyMs: 100,
      avgFailureLatencyMs: 5,
    });
  });

  it('reports autonomy and confidence as unavailable when every provider call fails', () => {
    const summary = summarizeBenchmarkMeasurements(models.slice(0, 1), 1, [
      result({
        ok: false,
        outcome: 'skipped',
        autonomous: false,
        avgConfidence: 0,
        perfectMatch: null,
        truePositive: null,
        falsePositive: null,
        falseNegative: null,
      }),
    ]);

    expect(summary.models[0]).toMatchObject({
      providerCalls: 1,
      docsOk: 0,
      failures: 1,
      autonomousDocs: 0,
      autonomyRate: null,
      avgConfidence: null,
      resolvedDocs: 0,
      f1: null,
    });
  });

  it('reports F1 as zero when scored rows have no true positives', () => {
    const summary = summarizeBenchmarkMeasurements(models.slice(0, 1), 1, [
      result({ perfectMatch: false, truePositive: 0, falsePositive: 2, falseNegative: 3 }),
    ]);
    expect(summary.models[0].f1).toBe(0);
  });
});

describe('rescoreBenchmarkRun', () => {
  it('repairs saved score columns and stamps the current profile without provider calls', async () => {
    const truth = {
      ticker: 'AAPL', assetName: 'Apple Inc.', txDate: '2026-07-01', txType: 'B',
      amountMin: 1_001, amountMax: 15_000, owner: 'self', assetType: 'ST',
      assetTypeName: 'Stocks (including ADRs)', isOption: false, capGainsOver200: false,
      filingStatus: null, subholding: null, location: null, description: null, supplementalText: null,
    };
    const candidate = { ...truth, assetTypeName: null, filingStatus: 'New' };
    const runRow: Record<string, unknown> = {
      id: 'run-1', chamber: 'house', status: 'running', requested_doc_count: 1,
      completed_doc_count: 0, model_count: 1,
      models_json: JSON.stringify([{ provider: 'openai', model: 'gpt-test' }]),
      request_profile_json: JSON.stringify({ version: 'ct-benchmark-profile-v1' }),
      started_at: '2026-07-14T12:00:00.000Z', completed_at: null, duration_ms: null,
      known_cost_usd: null, cost_covered_calls: 0, invoked_calls: 0, summary_json: null,
      selected_lineup_json: null, selected_at: null, selection_error: null,
      selection_audit_json: null, error: null, created_at: '2026-07-14T12:00:00.000Z',
      updated_at: '2026-07-14T12:00:00.000Z',
    };
    const documentRow = {
      run_id: 'run-1', doc_id: 'H-1', ordinal: 0, resolved: 1,
      ground_truth_json: JSON.stringify([truth]),
    };
    const measurementRow: Record<string, unknown> = {
      run_id: 'run-1', doc_id: 'H-1', provider: 'openai', model: 'gpt-test',
      resolved_model: 'gpt-test', invoked: 1, ok: 1, outcome: 'would_publish',
      autonomous: 1, error: null, row_count: 1, avg_confidence: 0.95, latency_ms: 100,
      cost_usd: 0.001, cost_source: 'usage_priced', cost_detail_json: '{}',
      provider_request_id: null, usage_json: '{}',
      result_json: JSON.stringify({ rows: [candidate], flags: [] }),
      perfect_match: 0, true_positive: 0, false_positive: 1, false_negative: 1,
      started_at: null, completed_at: null, claim_token: null, lease_until: null,
      created_at: '2026-07-14T12:00:01.000Z',
    };
    const db = {
      prepare(sql: string) {
        const statement = {
          params: [] as unknown[],
          bind(...params: unknown[]) { statement.params = params; return statement; },
          async first<T>() { return (/FROM benchmark_runs/i.test(sql) ? runRow : null) as T | null; },
          async all<T>() {
            if (/FROM benchmark_run_documents/i.test(sql)) return { results: [documentRow] as T[] };
            if (/FROM benchmark_model_results/i.test(sql)) return { results: [measurementRow] as T[] };
            return { results: [] as T[] };
          },
          async run() {
            if (/UPDATE benchmark_model_results/i.test(sql)) {
              measurementRow.perfect_match = statement.params[0];
              measurementRow.true_positive = statement.params[1];
              measurementRow.false_positive = statement.params[2];
              measurementRow.false_negative = statement.params[3];
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

    const rescored = await rescoreBenchmarkRun(db, 'run-1', '2026-07-14T12:05:00.000Z');

    expect(rescored).toMatchObject({
      rescoredMeasurements: 1,
      scoringProfile: 'ct-benchmark-scoring-v2-row-identity-strict-document',
      run: {
        requestProfile: { scoringProfile: 'ct-benchmark-scoring-v2-row-identity-strict-document' },
        results: [{ perfectMatch: false, truePositive: 1, falsePositive: 0, falseNegative: 0 }],
      },
    });
  });
});
