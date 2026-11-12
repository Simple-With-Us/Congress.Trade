import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { buildAdminRouter } from '../routes.ts';
import { clearResolverCache } from '../../extraction/normalizer.ts';

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
 * Agreement-based auto-publish: two cross-vendor models are run per doc; when
 * they agree on the full row set the read is published, otherwise it stays in
 * review. Providers are stubbed via global.fetch; the D1 surface is an in-memory
 * fake that captures transaction inserts + filing/review updates.
 */

const app = buildAdminRouter();
const AUTH = { Authorization: 'Bearer test-admin', 'content-type': 'application/json' };

const ROW_AAPL = '[{"ticker":"AAPL","assetName":"Apple Inc.","txDate":"2026-06-19","txType": "B","amountRange":"$1,001 - $15,000","isOption":false,"capGainsOver200":false,"confidence":0.9}]';
const ROW_MSFT = '[{"ticker":"MSFT","assetName":"Microsoft","txDate":"2026-06-19","txType":"S","amountRange":"$1,001 - $15,000","isOption":false,"capGainsOver200":false,"confidence":0.9}]';

function makeEnv() {
  const insertedTx: unknown[][] = [];
  const filingUpdates: string[] = [];
  const reviewResolved: string[] = [];
  const db = {
    prepare(sql: string) {
      return {
        params: [] as unknown[],
        bind(...p: unknown[]) { this.params = p; return this; },
        async first<T>() {
          if (/SELECT doc_id, raw_object_key FROM filings/i.test(sql)) {
            return { doc_id: this.params[0], raw_object_key: 'raw/' + this.params[0] } as T;
          }
          if (/SELECT doc_id, chamber, filer_id/i.test(sql)) {
            return { doc_id: this.params[0], chamber: 'house', filer_id: 'P1', filing_type: 'P', filed_date: '2026-06-20', source_url: 'u', raw_object_key: 'raw/x', ingest_status: 'needs_review', doc_kind: 'scanned_pdf', extractor: null, model_version: null, confidence: null, first_seen_at: '2026-06-20', source_updated_at: null, error: null } as T;
          }
          if (/SELECT resolved, agreement_attempts/i.test(sql)) {
            return {
              resolved: 0,
              agreement_attempts: 0,
              agreement_tier: null,
              agreement_next_attempt_at: null,
              agreement_claim_token: null,
              agreement_claimed_at: null,
              agreement_suppressed_at: null,
              agreement_suppression_reason: null,
              review_revision: 1,
            } as T;
          }
          return null as T | null;
        },
        async all<T>() {
          if (/FROM securities_master/i.test(sql)) return { results: [] as T[] }; // empty master → well-formed accept
          return { results: [] as T[] };
        },
        async run() {
          if (/INSERT (?:OR IGNORE )?INTO transactions/i.test(sql)) insertedTx.push(this.params);
          else if (/UPDATE filings/i.test(sql)) filingUpdates.push(String(this.params[1] ?? this.params[0]));
          else if (/UPDATE review_queue\s+SET resolved/i.test(sql)) reviewResolved.push(String(this.params[0]));
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;

  const env = {
    ADMIN_TOKEN: 'test-admin',
    ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', OPENROUTER_API_KEY: 'k',
    DB: db,
    RAW_FILES: { get: async () => ({ arrayBuffer: validPdfArrayBuffer }) },
    DELIVERY_QUEUE: { send: async () => {}, sendBatch: async () => {} },
  } as never;
  return { env, insertedTx, reviewResolved };
}

function stubBoth(openaiText: string, anthropicText: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('api.openai.com')) {
      return { ok: true, json: async () => ({
        model: 'gpt-5.6-terra',
        status: 'completed',
        output_text: openaiText,
      }) } as unknown as Response;
    }
    if (String(url).includes('api.anthropic.com')) {
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: anthropicText }] }) } as unknown as Response;
    }
    return { ok: false, status: 404, text: async () => 'nope' } as unknown as Response;
  }));
}

const MODELS = JSON.stringify([{ provider: 'openai', model: 'gpt-5.6-terra' }, { provider: 'anthropic', model: 'claude-sonnet-5' }]);

/** Both openrouter-transported reads return the same content, keyed only by
 *  the openrouter.ai endpoint (both trio members share one transport). */
function stubOpenRouter(content: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('openrouter.ai')) {
      return { ok: true, json: async () => ({
        id: 'gen-or-1',
        model: 'served/model-slug',
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }) } as unknown as Response;
    }
    return { ok: false, status: 404, text: async () => 'nope' } as unknown as Response;
  }));
}

describe('agreement-reprocess', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('dry-run (default) previews a publish on agreement without writing', async () => {
    stubBoth(ROW_AAPL, ROW_AAPL);
    const { env, insertedTx } = makeEnv();
    const res = await app.request('/agreement-reprocess', { method: 'POST', headers: AUTH, body: JSON.stringify({ docIds: ['H-1'], models: JSON.parse(MODELS) }) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dryRun: boolean; summary: { wouldPublish: number; published: number }; results: Array<{ outcome: string }> };
    expect(body.dryRun).toBe(true);
    expect(body.summary.wouldPublish).toBe(1);
    expect(body.summary.published).toBe(0);
    expect(body.results[0].outcome).toBe('would_publish');
    expect(insertedTx).toHaveLength(0); // nothing written in dry-run
  });

  it('publishes on full agreement when dryRun=false', async () => {
    stubBoth(ROW_AAPL, ROW_AAPL);
    const { env, insertedTx, reviewResolved } = makeEnv();
    const res = await app.request('/agreement-reprocess', { method: 'POST', headers: AUTH, body: JSON.stringify({ docIds: ['H-1'], models: JSON.parse(MODELS), dryRun: false }) }, env);
    const body = (await res.json()) as { summary: { published: number }; results: Array<{ outcome: string; inserted: number }> };
    expect(body.summary.published).toBe(1);
    expect(body.results[0]).toMatchObject({ outcome: 'published', inserted: 1 });
    expect(insertedTx).toHaveLength(1);
    expect(reviewResolved).toContain('H-1');
  });

  it('keeps a doc in review when the two models disagree', async () => {
    stubBoth(ROW_AAPL, ROW_MSFT); // different tickers → row sets differ
    const { env, insertedTx } = makeEnv();
    const res = await app.request('/agreement-reprocess', { method: 'POST', headers: AUTH, body: JSON.stringify({ docIds: ['H-1'], models: JSON.parse(MODELS), dryRun: false }) }, env);
    const body = (await res.json()) as { summary: { published: number; disagree: number }; results: Array<{ outcome: string }> };
    expect(body.summary.disagree).toBe(1);
    expect(body.summary.published).toBe(0);
    expect(body.results[0].outcome).toBe('disagree');
    expect(insertedTx).toHaveLength(0);
  });

  it('rejects a request that is not exactly two models', async () => {
    const { env } = makeEnv();
    const res = await app.request('/agreement-reprocess', { method: 'POST', headers: AUTH, body: JSON.stringify({ docIds: ['H-1'], models: [{ provider: 'openai', model: 'gpt-4o' }] }) }, env);
    expect(res.status).toBe(400);
  });

  it('rejects GPT-4o for a new agreement re-read', async () => {
    const { env } = makeEnv();
    const res = await app.request('/agreement-reprocess', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        models: [
          { provider: 'openai', model: 'gpt-4o' },
          { provider: 'anthropic', model: 'claude-sonnet-5' },
        ],
      }),
    }, env);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('retired') });
  });

  // --- OR-capable whitelist: OpenRouter-transported models are accepted from
  // the same benchmark catalog (DEFAULT_CANDIDATES), but distinctness is
  // measured over the UNDERLYING vendor so two openrouter slugs from the same
  // vendor can't corroborate each other. ---

  it('accepts two openrouter-transported models with distinct underlying vendors', async () => {
    stubOpenRouter(ROW_AAPL);
    const { env, insertedTx } = makeEnv();
    const orModels = JSON.stringify([
      { provider: 'openrouter', model: 'openai/gpt-5.6-terra' },
      { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' },
    ]);
    const res = await app.request('/agreement-reprocess', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ docIds: ['H-1'], models: JSON.parse(orModels), dryRun: false }),
    }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: { published: number }; results: Array<{ outcome: string }> };
    expect(body.summary.published).toBe(1);
    expect(body.results[0].outcome).toBe('published');
    expect(insertedTx).toHaveLength(1);
  });

  it('rejects two identical model labels (model distinctness only)', async () => {
    const { env } = makeEnv();
    const res = await app.request('/agreement-reprocess', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        docIds: ['H-1'],
        models: [
          { provider: 'openrouter', model: 'openai/gpt-5.6-terra' },
          { provider: 'openrouter', model: 'openai/gpt-5.6-terra' },
        ],
      }),
    }, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('duplicate_model_lineup');
    expect(body.error).toContain('distinct');
  });
});
