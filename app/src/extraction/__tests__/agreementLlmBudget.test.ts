import { describe, it, expect, afterEach, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { handleAgreementCheck } from '../agreement.ts';

/** A genuinely-parseable PDF: the Anthropic candidate pre-validates bytes
 *  with pdf-lib (normalizePdfForAnthropic) before any provider call. */
async function validPdfArrayBuffer(): Promise<ArrayBuffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  const bytes = await pdf.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Daily LLM budget guardrail (AGREEMENT_DAILY_LLM_BUDGET) for the AUTONOMOUS
 * agreement/cascade path only — handleAgreementCheck reserves this tier's
 * candidate reads (2 for tier 1) atomically against an in-memory llm_budget
 * table BEFORE spending an agreement attempt or running any model call:
 *   - each resolved doc decrements (consumes) the daily budget by its read count.
 *   - at cap, the cascade defers: no model calls, no attempt bump, no
 *     escalation enqueue, and a diagnostics receipt (ingestion_decisions) is
 *     written with reason 'llm_budget_exhausted'.
 *   - "-1" is the explicit unlimited sentinel and never touches the counter.
 *   - the counter is keyed per UTC day, so a different (e.g. prior) day's
 *     exhausted counter never blocks today's reservation.
 * The operator-triggered /agreement-reprocess endpoint calls processAgreementDoc
 * directly and never reaches handleAgreementCheck, so it is intentionally not
 * exercised here — it stays uncapped by construction (see routes.ts).
 */

const row = (ticker: string, txType: string, amountRange: string | null) =>
  JSON.stringify([{
    ticker,
    assetName: `${ticker} Inc.`,
    txDate: '2026-06-19',
    txType,
    amountRange,
    isOption: false,
    capGainsOver200: false,
    confidence: 0.9,
  }]);

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Stub openai (A) / anthropic (B) so a tier-1 pair reads unanimously. */
function stubUnanimous(payload: string) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('api.openai.com')) { calls.push('openai'); return { ok: true, json: async () => ({ output_text: payload, choices: [{ message: { content: payload } }] }) } as unknown as Response; }
    if (u.includes('api.anthropic.com')) { calls.push('anthropic'); return { ok: true, json: async () => ({ content: [{ type: 'text', text: payload }] }) } as unknown as Response; }
    return { ok: false, status: 404, text: async () => 'nope' } as unknown as Response;
  }));
  return calls;
}

interface Captured {
  inserted: unknown[][];
  attemptsBumped: number[];
  sent: unknown[];
  decisions: Array<{ action: unknown; reason: unknown; payload: Record<string, unknown> | null }>;
}

/** llmBudget: shared in-memory day -> reads map, seedable across test scenarios. */
function makeEnv(opts: {
  llmBudget?: Map<string, number>;
  envVars?: Record<string, unknown>;
} = {}) {
  const cap: Captured = { inserted: [], attemptsBumped: [], sent: [], decisions: [] };
  const llmBudget = opts.llmBudget ?? new Map<string, number>();
  const review = { resolved: 0, attempts: 0, tier: null as number | null, token: null as string | null, claimedAt: null as string | null, nextAttemptAt: null as string | null };

  const db = {
    prepare(sql: string) {
      return {
        params: [] as unknown[],
        bind(...p: unknown[]) { this.params = p; return this; },
        async first<T>() {
          if (/SELECT doc_id, chamber, filer_id/i.test(sql)) {
            return {
              doc_id: this.params[0], chamber: 'house', filer_id: 'P1', filing_type: 'P',
              filed_date: '2026-06-20', source_url: 'u', raw_object_key: 'raw/x',
              ingest_status: 'needs_review', doc_kind: 'scanned_pdf', extractor: null,
              model_version: null, confidence: null, first_seen_at: '2026-06-20',
              source_updated_at: null, error: null,
            } as T;
          }
          if (/SELECT page_count, raw_bytes FROM filings/i.test(sql)) {
            return { page_count: null, raw_bytes: null } as T;
          }
          if (/SELECT resolved, agreement_attempts, agreement_tier/i.test(sql)) {
            return {
              resolved: review.resolved,
              agreement_attempts: review.attempts,
              agreement_tier: review.tier,
              agreement_next_attempt_at: review.nextAttemptAt,
              agreement_claim_token: review.token,
              agreement_claimed_at: review.claimedAt,
            } as T;
          }
          return null as T | null;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          if (/SET agreement_attempts = \?,\s*agreement_tier = \?/i.test(sql)) {
            const [nextAttempts, tier, , token, claimedAt, , expectedToken, observedAttempts, max] = this.params as [number, number, string, string, string, string, string, number, number];
            if (review.resolved === 0 && review.token === expectedToken && review.attempts === observedAttempts && review.attempts < max) {
              review.attempts = nextAttempts;
              review.tier = tier;
              review.token = token;
              review.claimedAt = claimedAt;
              cap.attemptsBumped.push(review.attempts);
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (/SET agreement_claim_token = \?, agreement_claimed_at = \?, agreement_next_attempt_at = NULL/i.test(sql)) {
            const [token, claimedAt, , max] = this.params as [string, string, string, number];
            if (review.resolved === 0 && review.attempts < max && review.token === null) {
              review.token = token;
              review.claimedAt = claimedAt;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (/SET agreement_claim_token = \?, agreement_claimed_at = \?/i.test(sql)) {
            const [token, claimedAt, , expected] = this.params as [string, string, string, string];
            if (review.resolved === 0 && (review.token === expected || review.token === null)) {
              review.token = token;
              review.claimedAt = claimedAt;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (/MAX\(COALESCE\(agreement_attempts, 0\) - 1, 0\)/i.test(sql)) {
            const expected = String(this.params[this.params.length - 1]);
            if (review.token === expected) {
              review.attempts = Math.max(review.attempts - 1, 0);
              review.nextAttemptAt = this.params[0] as string | null;
              review.token = null;
              review.claimedAt = null;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (/INSERT OR IGNORE INTO llm_budget/i.test(sql)) {
            const [day] = this.params as [string];
            const existed = llmBudget.has(day);
            if (!existed) llmBudget.set(day, 0);
            return { success: true, meta: { changes: existed ? 0 : 1 } };
          }
          if (/UPDATE llm_budget SET reads = reads \+ \?/i.test(sql)) {
            const [count, day, , budget] = this.params as [number, string, number, number];
            const current = llmBudget.get(day) ?? 0;
            if (current + count <= budget) {
              llmBudget.set(day, current + count);
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (/INSERT (?:OR IGNORE )?INTO transactions/i.test(sql)) {
            const guardToken = String(this.params[this.params.length - 1]);
            if (review.resolved === 0 && review.token === guardToken) {
              cap.inserted.push(this.params);
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          } else if (/INSERT INTO ingestion_decisions/i.test(sql)) {
            const payloadRaw = this.params[6];
            cap.decisions.push({
              action: this.params[2], reason: this.params[5],
              payload: typeof payloadRaw === 'string' ? JSON.parse(payloadRaw) : null,
            });
          } else if (/SET resolved = 1,/i.test(sql)) {
            const expectedToken = String(this.params[1]);
            if (review.resolved === 0 && review.token === expectedToken) {
              review.resolved = 1;
              review.token = null;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;

  const env = {
    AGREEMENT_AUTOPUBLISH_ENABLED: 'true',
    AGREEMENT_HOUSE_MODEL_C: 'openai:gpt-4o',
    AGREEMENT_HOUSE_MODEL_D: 'anthropic:claude-sonnet-5',
    OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k',
    DB: db,
    RAW_FILES: { get: async () => ({ arrayBuffer: validPdfArrayBuffer }) },
    INGEST_QUEUE: { send: async (m: unknown) => { cap.sent.push(m); } },
    DELIVERY_QUEUE: { send: async () => {}, sendBatch: async () => {} },
    ...(opts.envVars ?? {}),
  } as never;
  return { env, cap, llmBudget, review };
}

describe('agreement daily LLM budget guardrail', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('decrements (consumes) the daily counter by each resolved doc\'s read count', async () => {
    stubUnanimous(row('AAPL', 'B', '$1,001 - $15,000'));
    const { env, cap, llmBudget } = makeEnv();

    await handleAgreementCheck(env, 'H-1', 'raw/H-1');
    expect(cap.inserted).toHaveLength(1); // tier-1 unanimous publish, unaffected
    expect(llmBudget.get(todayKey())).toBe(2); // A + B = 2 reads consumed

    const second = makeEnv({ llmBudget });
    await handleAgreementCheck(second.env, 'H-2', 'raw/H-2');
    expect(llmBudget.get(todayKey())).toBe(4); // second doc consumes 2 more
  });

  it('defers at cap WITHOUT consuming an agreement attempt, escalating, or calling any model', async () => {
    const calls = stubUnanimous(row('AAPL', 'B', '$1,001 - $15,000'));
    const seeded = new Map([[todayKey(), 2]]); // already at the cap
    const { env, cap, review } = makeEnv({ llmBudget: seeded, envVars: { AGREEMENT_DAILY_LLM_BUDGET: '2' } });

    await handleAgreementCheck(env, 'H-3', 'raw/H-3');

    expect(calls).toHaveLength(0); // no candidate reads happened
    expect(cap.inserted).toHaveLength(0);
    expect(review.attempts).toBe(0); // claim was rolled back; no agreement attempt spent
    expect(cap.sent).toHaveLength(0); // no tier-2 escalation enqueued
    expect(seeded.get(todayKey())).toBe(2); // counter untouched by the blocked attempt
    const receipt = cap.decisions.find((d) => d.reason === 'llm_budget_exhausted');
    expect(receipt).toBeTruthy();
    expect(receipt?.payload).toMatchObject({ resolvedBy: 'agreement-cascade', tier: 1, budget: 2, detail: 'budget_exhausted' });
  });

  it('"-1" is unlimited and never touches the counter', async () => {
    stubUnanimous(row('AAPL', 'B', '$1,001 - $15,000'));
    const { env, cap, llmBudget } = makeEnv({ envVars: { AGREEMENT_DAILY_LLM_BUDGET: '-1' } });

    await handleAgreementCheck(env, 'H-4', 'raw/H-4');

    expect(cap.inserted).toHaveLength(1); // publish proceeds regardless of budget
    expect(llmBudget.has(todayKey())).toBe(false); // unlimited path never reserves
  });

  it('day rollover: a prior day pinned at its cap does not block today', async () => {
    stubUnanimous(row('AAPL', 'B', '$1,001 - $15,000'));
    const seeded = new Map([['2020-01-01', 2]]); // an old day, fully exhausted
    const { env, cap, llmBudget } = makeEnv({ llmBudget: seeded, envVars: { AGREEMENT_DAILY_LLM_BUDGET: '2' } });

    await handleAgreementCheck(env, 'H-5', 'raw/H-5');

    expect(cap.inserted).toHaveLength(1); // today's fresh counter allows it
    expect(llmBudget.get(todayKey())).toBe(2);
    expect(llmBudget.get('2020-01-01')).toBe(2); // yesterday's row is untouched
  });

  it('0 / unset falls back to the 300/day default rather than unlimited', async () => {
    stubUnanimous(row('AAPL', 'B', '$1,001 - $15,000'));
    const { env, cap, llmBudget } = makeEnv({ envVars: { AGREEMENT_DAILY_LLM_BUDGET: '0' } });

    await handleAgreementCheck(env, 'H-6', 'raw/H-6');

    expect(cap.inserted).toHaveLength(1);
    expect(llmBudget.get(todayKey())).toBe(2); // counter WAS touched — not unlimited
  });
});
