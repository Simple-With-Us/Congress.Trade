import { describe, expect, it } from 'vitest';
// Worker production code intentionally omits Node typings; this test validates
// checked-in SQL/config artifacts under Vitest's Node runtime.
import { existsSync, readFileSync } from 'node:fs';
import { buildAdminRouter } from '../routes.ts';

const app = buildAdminRouter();
const testModuleUrl = (import.meta as ImportMeta & { readonly url: string }).url;

function setting(text: string, key: string): string {
  const match = text.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"$`, 'm'));
  expect(match, `${key} must be explicit`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('review queue durable state migration', () => {
  it('uses collision-safe 0033-0037 files and guards replay + human holds', () => {
    const deliveryMigration = (new URL('../../../migrations/0030_delivery_outbox.sql', testModuleUrl) as any);
    const migration33 = (new URL('../../../migrations/0033_doc_complexity_signals.sql', testModuleUrl) as any);
    const migration34 = (new URL('../../../migrations/0034_agreement_cascade.sql', testModuleUrl) as any);
    const migration35 = (new URL('../../../migrations/0035_llm_budget.sql', testModuleUrl) as any);
    const migration36 = (new URL('../../../migrations/0036_review_resolution_safety.sql', testModuleUrl) as any);
    const migration37 = (new URL('../../../migrations/0037_review_revision.sql', testModuleUrl) as any);
    const migration38 = (new URL('../../../migrations/0038_benchmark_runs.sql', testModuleUrl) as any);

    expect(existsSync(deliveryMigration)).toBe(true);
    expect(existsSync(migration33)).toBe(true);
    expect(existsSync(migration34)).toBe(true);
    expect(existsSync(migration35)).toBe(true);
    expect(existsSync(migration36)).toBe(true);
    expect(existsSync(migration37)).toBe(true);
    expect(existsSync(migration38)).toBe(true);
    expect(existsSync((new URL('../../../migrations/0025_doc_complexity_signals.sql', testModuleUrl) as any))).toBe(false);
    expect(existsSync((new URL('../../../migrations/0026_agreement_cascade.sql', testModuleUrl) as any))).toBe(false);
    expect(existsSync((new URL('../../../migrations/0027_llm_budget.sql', testModuleUrl) as any))).toBe(false);
    expect(existsSync((new URL('../../../migrations/0030_doc_complexity_signals.sql', testModuleUrl) as any))).toBe(false);
    expect(existsSync((new URL('../../../migrations/0031_agreement_cascade.sql', testModuleUrl) as any))).toBe(false);
    expect(existsSync((new URL('../../../migrations/0032_llm_budget.sql', testModuleUrl) as any))).toBe(false);

    expect(readFileSync(deliveryMigration, 'utf8') as string).toMatch(
      /CREATE TABLE IF NOT EXISTS delivery_outbox/i,
    );
    const sql = readFileSync(migration34, 'utf8') as string;
    expect(sql).toMatch(/ADD COLUMN agreement_next_attempt_at TEXT/i);
    expect(sql).toMatch(/ADD COLUMN agreement_claim_token TEXT/i);
    expect(sql).toMatch(/ADD COLUMN agreement_claimed_at TEXT/i);
    expect(sql).toMatch(/ADD COLUMN agreement_legacy_replay_at TEXT/i);
    expect(sql).toMatch(/idx_review_queue_agreement_eligible/i);
    expect(sql).toMatch(/idx_review_queue_agreement_claim/i);
    expect(sql).toMatch(/WHERE resolved = 0[\s\S]*agreement_legacy_replay_at IS NULL/i);
    expect(sql).toMatch(/agreement_attempted_at >= '2026-06-26T00:00:00\.000Z'/i);
    expect(sql).toMatch(/agreement_attempted_at < '2026-07-11T00:00:00\.000Z'/i);

    const safetySql = readFileSync(migration36, 'utf8') as string;
    expect(safetySql).toMatch(/ADD COLUMN agreement_suppressed_at TEXT/i);
    expect(safetySql).toMatch(/reason LIKE 'unpublished:%'/i);
    const createLiveIndex = safetySql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_live_doc_source_rowkey');
    const dropOldIndex = safetySql.indexOf('DROP INDEX IF EXISTS idx_transactions_doc_source_rowkey');
    expect(createLiveIndex).toBeGreaterThan(-1);
    expect(dropOldIndex).toBeGreaterThan(createLiveIndex);
    expect(safetySql).toMatch(/deprecated_at IS NULL/i);
    expect(safetySql).not.toMatch(/review_delivery_outbox/i);
    expect(readFileSync(migration37, 'utf8') as string).toMatch(
      /ADD COLUMN review_revision INTEGER NOT NULL DEFAULT 1/i,
    );
    expect(readFileSync(migration38, 'utf8') as string).toMatch(
      /CREATE TABLE IF NOT EXISTS benchmark_model_results/i,
    );
  });

  it('mirrors lease fields, indexes, and guarded replay in POST /migrate order', async () => {
    const statements: string[] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return this;
          },
          async run() {
            statements.push(sql);
            return { success: true, meta: { changes: 1 } };
          },
          async all() {
            return { results: [], success: true };
          },
          async first() {
            return null;
          },
        };
      },
    } as unknown as D1Database;

    // This test asserts statement ORDER, not schema readiness. The stub above
    // implements only prepare().bind().run(), so checkReadiness cannot probe it
    // and reports db:false — which /migrate now correctly treats as a failure.
    // Skip the postcondition here; it is covered directly in migrate.test.ts.
    const res = await app.request(
      '/migrate',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ skipSchemaVerify: true }),
      },
      { ADMIN_TOKEN: 'admin-secret', DB: db } as never,
    );

    expect(res.status).toBe(200);
    const addLegacy = statements.findIndex((sql) => /ADD COLUMN agreement_legacy_replay_at/i.test(sql));
    const eligibleIndex = statements.findIndex((sql) => /idx_review_queue_agreement_eligible/i.test(sql));
    const replay = statements.findIndex((sql) => /agreement_legacy_replay_at = CURRENT_TIMESTAMP/i.test(sql));
    const addSuppression = statements.findIndex((sql) => /ADD COLUMN agreement_suppressed_at/i.test(sql));
    const createLiveIndex = statements.findIndex((sql) => /idx_transactions_live_doc_source_rowkey/i.test(sql));
    const dropOldIndex = statements.findIndex((sql) => /DROP INDEX IF EXISTS idx_transactions_doc_source_rowkey/i.test(sql));
    const outbox = statements.findIndex((sql) => /CREATE TABLE IF NOT EXISTS delivery_outbox/i.test(sql));
    const addReviewRevision = statements.findIndex((sql) => /ADD COLUMN review_revision/i.test(sql));
    const benchmarkRuns = statements.findIndex((sql) => /CREATE TABLE IF NOT EXISTS benchmark_runs/i.test(sql));
    expect(outbox).toBeGreaterThan(-1);
    expect(addLegacy).toBeGreaterThan(-1);
    expect(addLegacy).toBeGreaterThan(outbox);
    expect(eligibleIndex).toBeGreaterThan(addLegacy);
    expect(replay).toBeGreaterThan(eligibleIndex);
    expect(statements[replay]).toMatch(/WHERE resolved = 0[\s\S]*agreement_legacy_replay_at IS NULL/i);
    expect(addSuppression).toBeGreaterThan(replay);
    expect(createLiveIndex).toBeGreaterThan(addSuppression);
    expect(dropOldIndex).toBeGreaterThan(createLiveIndex);
    expect(addReviewRevision).toBeGreaterThan(dropOldIndex);
    expect(benchmarkRuns).toBeGreaterThan(addReviewRevision);
    expect(statements.some((sql) => /review_delivery_outbox/i.test(sql))).toBe(false);
  });
});
