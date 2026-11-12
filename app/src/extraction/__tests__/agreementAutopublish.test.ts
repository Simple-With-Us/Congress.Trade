import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { maybeRunAgreementAutopublish, handleAgreementCheck } from '../agreement.ts';
import { clearResolverCache } from '../normalizer.ts';

beforeEach(() => {
  clearResolverCache();
});

/** A genuinely-parseable PDF: the Anthropic candidate pre-validates bytes
 *  with pdf-lib (normalizePdfForAnthropic) before any provider call. */
async function validPdfArrayBuffer(): Promise<ArrayBuffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  const bytes = await pdf.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * The autonomous agreement → auto-publish flow is split in two:
 *   - maybeRunAgreementAutopublish (cron backstop): picks unattempted review
 *     docs, ENQUEUES an agreement.check for each, and stamps the attempt. It does
 *     NO model work itself, so the cron's waitUntil can never cancel it.
 *   - handleAgreementCheck (queue consumer): runs the slow cross-vendor read and
 *     publishes the doc when the two models fully agree.
 * Providers stubbed via global.fetch.
 */

const ROW_AAPL = '[{"ticker":"AAPL","assetName":"Apple Inc.","txDate":"2026-06-19","txType": "B","amountRange":"$1,001 - $15,000","isOption":false,"capGainsOver200":false,"confidence":0.9}]';

function makeEnv(flag: string | undefined) {
  const inserted: unknown[][] = [];
  const attempted: string[] = [];
  const resolved: string[] = [];
  const sent: unknown[] = [];
  const review = { resolved: 0, attempts: 0, tier: null as number | null, token: null as string | null, claimedAt: null as string | null, nextAttemptAt: null as string | null };
  const db = {
    prepare(sql: string) {
      return {
        params: [] as unknown[],
        bind(...p: unknown[]) { this.params = p; return this; },
        async first<T>() {
          if (/SELECT doc_id, chamber, filer_id/i.test(sql)) {
            return { doc_id: this.params[0], chamber: 'house', filer_id: 'P1', filing_type: 'P', filed_date: '2026-06-20', source_url: 'u', raw_object_key: 'raw/x', ingest_status: 'needs_review', doc_kind: 'scanned_pdf', extractor: null, model_version: null, confidence: null, first_seen_at: '2026-06-20', source_updated_at: null, error: null } as T;
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
          if (/FROM review_queue rq JOIN filings/i.test(sql)) {
            return { results: [{ doc_id: 'H-AP-1', raw_object_key: 'raw/H-AP-1' }] as T[] };
          }
          if (/FROM securities_master/i.test(sql)) return { results: [] as T[] };
          return { results: [] as T[] };
        },
        async run() {
          if (/SET agreement_attempts = \?,\s*agreement_tier = \?/i.test(sql)) {
            const [nextAttempts, tier, , token, claimedAt, docId, expectedToken, observedAttempts, max] = this.params as [number, number, string, string, string, string, string, number, number];
            if (review.resolved === 0 && review.token === expectedToken && review.attempts === observedAttempts && review.attempts < max) {
              review.attempts = nextAttempts;
              review.tier = tier;
              review.token = token;
              review.claimedAt = claimedAt;
              attempted.push(docId);
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (/SET agreement_claim_token = \?, agreement_claimed_at = \?, agreement_next_attempt_at = NULL/i.test(sql)) {
            const [token, claimedAt, docId, max] = this.params as [string, string, string, number];
            if (review.resolved === 0 && review.attempts < max && review.token === null) {
              review.token = token;
              review.claimedAt = claimedAt;
              attempted.push(docId);
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
          if (/INSERT (?:OR IGNORE )?INTO transactions/i.test(sql)) {
            const guardToken = String(this.params[this.params.length - 1]);
            if (review.resolved === 0 && review.token === guardToken) {
              inserted.push(this.params);
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (/SET resolved = 1,/i.test(sql)) {
            const [docId, expectedToken] = this.params as [string, string];
            if (review.resolved === 0 && review.token === expectedToken) {
              review.resolved = 1;
              review.token = null;
              resolved.push(docId);
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (/SET agreement_next_attempt_at = \?, agreement_claim_token = NULL/i.test(sql)) {
            const [nextAttemptAt, , expectedToken] = this.params as [string, string, string];
            if (review.token === expectedToken) {
              review.nextAttemptAt = nextAttemptAt;
              review.token = null;
              review.claimedAt = null;
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
    AGREEMENT_AUTOPUBLISH_ENABLED: flag,
    ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', GEMINI_API_KEY: 'k', MISTRAL_API_KEY: 'k',
    AGREEMENT_HOUSE_MODEL_C: 'openai:gpt-4o',
    AGREEMENT_HOUSE_MODEL_D: 'anthropic:claude-sonnet-5',
    DB: db,
    RAW_FILES: { get: async () => ({ arrayBuffer: validPdfArrayBuffer }) },
    INGEST_QUEUE: { send: async (m: unknown) => { sent.push(m); } },
    DELIVERY_QUEUE: { send: async () => {}, sendBatch: async () => {} },
  } as never;
  return { env, inserted, attempted, resolved, sent, review };
}

function stubAgree(text: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('api.openai.com')) return { ok: true, json: async () => ({ output_text: text, choices: [{ message: { content: text } }] }) } as unknown as Response;
    if (String(url).includes('api.anthropic.com')) return { ok: true, json: async () => ({ content: [{ type: 'text', text }] }) } as unknown as Response;
    return { ok: false, status: 404, text: async () => 'x' } as unknown as Response;
  }));
}

describe('maybeRunAgreementAutopublish (cron backstop)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is a no-op when the flag is off', async () => {
    const { env, sent } = makeEnv(undefined);
    const out = await maybeRunAgreementAutopublish(env);
    expect(out).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('enqueues an agreement.check and stamps the attempt (no model work)', async () => {
    const { env, sent, attempted, inserted } = makeEnv('true');
    const out = await maybeRunAgreementAutopublish(env);
    expect(out).toMatchObject({ attempted: 1, enqueued: 1 });
    expect(sent).toEqual([
      expect.objectContaining({
        type: 'agreement.check', docId: 'H-AP-1', rawObjectKey: 'raw/H-AP-1', escalationTier: 1,
        claimToken: expect.any(String),
      }),
    ]);
    expect(attempted).toContain('H-AP-1'); // attempt stamped so it won't re-enqueue
    expect(inserted).toHaveLength(0); // the cron itself publishes nothing
  });

  it('atomically leases a doc so concurrent scheduler passes enqueue it once', async () => {
    const { env, sent } = makeEnv('true');
    const [a, b] = await Promise.all([
      maybeRunAgreementAutopublish(env),
      maybeRunAgreementAutopublish(env),
    ]);
    expect((a?.enqueued ?? 0) + (b?.enqueued ?? 0)).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('resolves AGREEMENT_AUTOPUBLISH_ENABLED via Infisical, overriding the raw (unset) env value', async () => {
    // Raw env flag is undefined — without Infisical this would stay a no-op.
    const { env, sent } = makeEnv(undefined);
    Object.assign(env, {
      INFISICAL_BASE_URL: 'https://infisical.test',
      INFISICAL_ENV: 'prod',
      INFISICAL_APP_PROJECT_ID: 'agreement-autopublish-app',
      INFISICAL_APP_CLIENT_ID: 'app-client',
      INFISICAL_APP_CLIENT_SECRET: 'app-secret-agreement-autopublish',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/api/v1/auth/universal-auth/login')) {
          return Response.json({ accessToken: 'infisical-token' });
        }
        if (String(url).includes('/api/v3/secrets/raw')) {
          return Response.json({ secrets: [{ secretKey: 'AGREEMENT_AUTOPUBLISH_ENABLED', secretValue: 'true' }] });
        }
        return new Response('not found', { status: 404 });
      }),
    );

    const out = await maybeRunAgreementAutopublish(env);
    expect(out).toMatchObject({ attempted: 1, enqueued: 1 });
    expect(sent).toEqual([
      expect.objectContaining({
        type: 'agreement.check', docId: 'H-AP-1', rawObjectKey: 'raw/H-AP-1', escalationTier: 1,
        claimToken: expect.any(String),
      }),
    ]);
  });
});

describe('handleAgreementCheck (queue consumer)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('publishes an agreeing doc', async () => {
    stubAgree(ROW_AAPL);
    const { env, inserted, resolved } = makeEnv('true');
    await handleAgreementCheck(env, 'H-AP-1', 'raw/H-AP-1');
    expect(inserted).toHaveLength(1);
    expect(resolved).toContain('H-AP-1');
  });

  it('is a no-op when the flag is off', async () => {
    stubAgree(ROW_AAPL);
    const { env, inserted } = makeEnv(undefined);
    await handleAgreementCheck(env, 'H-AP-1', 'raw/H-AP-1');
    expect(inserted).toHaveLength(0);
  });

  it('does not publish when a human resolves the review during model reads', async () => {
    const { env, inserted, review } = makeEnv('true');
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls += 1;
      if (calls === 2) review.resolved = 1;
      if (String(url).includes('api.openai.com')) return { ok: true, json: async () => ({ output_text: ROW_AAPL, choices: [{ message: { content: ROW_AAPL } }] }) } as unknown as Response;
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: ROW_AAPL }] }) } as unknown as Response;
    }));
    await handleAgreementCheck(env, 'H-AP-1', 'raw/H-AP-1');
    expect(inserted).toHaveLength(0);
    expect(review.resolved).toBe(1);
  });

  it('backs off a transient candidate read failure instead of escalating or terminating', async () => {
    const { env, inserted, sent, review } = makeEnv('true');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('api.openai.com')) {
        return { ok: false, status: 429, text: async () => 'rate limited' } as unknown as Response;
      }
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: ROW_AAPL }] }) } as unknown as Response;
    }));
    await handleAgreementCheck(env, 'H-AP-1', 'raw/H-AP-1');
    expect(inserted).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(review.attempts).toBe(1);
    expect(review.nextAttemptAt).toEqual(expect.any(String));
    expect(review.token).toBeNull();
  });

  it('releases the rotated claim for retry when an unexpected handler error throws', async () => {
    const { env, review } = makeEnv('true');
    (env as unknown as { RAW_FILES: { get: () => Promise<never> } }).RAW_FILES = {
      get: async () => { throw new Error('R2 temporarily unavailable'); },
    };

    await expect(handleAgreementCheck(env, 'H-AP-1', 'raw/H-AP-1')).rejects.toThrow(
      'R2 temporarily unavailable',
    );
    expect(review.attempts).toBe(1);
    expect(review.nextAttemptAt).toEqual(expect.any(String));
    expect(review.token).toBeNull();
  });
});
