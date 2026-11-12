import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { buildAdminRouter } from '../routes.ts';

/** A genuinely-parseable PDF: the Anthropic candidate pre-validates bytes
 *  with pdf-lib (normalizePdfForAnthropic) before any provider call. */
async function validPdfArrayBuffer(): Promise<ArrayBuffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  const bytes = await pdf.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * End-to-end pipeline test (providers mocked): a document is run through the
 * bake-off endpoint, each model's reading is persisted to extraction_runs, and
 * the review dashboard APIs surface the per-model comparison + full readings.
 *
 * The LLM HTTP calls are stubbed via global.fetch so the test is hermetic; the
 * D1 surface is a small in-memory fake that captures extraction_runs writes and
 * serves them back to the read endpoints — mirroring real prod behaviour.
 */

const app = buildAdminRouter();
const AUTH = { Authorization: 'Bearer test-admin' };

interface ExtractionRunRow {
  id: string;
  batch_id: string | null;
  doc_id: string;
  provider: string;
  model: string;
  kind: string;
  ok: number;
  error: string | null;
  row_count: number;
  latency_ms: number | null;
  avg_confidence: number | null;
  result_json: string | null;
  usage_json: string | null;
  created_at: string;
}

function makeEnv() {
  const extractionRuns: ExtractionRunRow[] = [];
  const usageEvents: unknown[] = [];

  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...p: unknown[]) {
      this.params = p;
      return this;
    },
    async first<T>() {
      // bake-off doc lookup
      if (/SELECT doc_id, raw_object_key FROM filings WHERE doc_id = \?/i.test(sql)) {
        return { doc_id: this.params[0], raw_object_key: 'raw/' + this.params[0] } as T;
      }
      return null as T | null;
    },
    async all<T>() {
      if (/FROM extraction_runs WHERE doc_id IN/i.test(sql)) {
        const ids = this.params.map(String);
        return { results: extractionRuns.filter((r) => ids.includes(r.doc_id)) as T[] };
      }
      if (/FROM extraction_runs WHERE doc_id = \?/i.test(sql)) {
        return { results: extractionRuns.filter((r) => r.doc_id === this.params[0]) as T[] };
      }
      if (/FROM review_queue rq/i.test(sql)) {
        // one pending review item for our doc
        return {
          results: [
            {
              doc_id: 'H-TEST-1',
              reason: 'low_confidence',
              payload: '{"minConfidence":0.6,"transactions":[]}',
              created_at: '2026-06-25T00:00:00.000Z',
              resolved: 0,
              source_url: 'https://example/doc.pdf',
              raw_object_key: 'raw/H-TEST-1',
              doc_kind: 'scanned_pdf',
              ingest_status: 'needs_review',
              manual_rows: 0,
              live_rows: 0,
            },
          ] as T[],
        };
      }
      return { results: [] as T[] };
    },
    async run() {
      if (/INSERT INTO extraction_runs/i.test(sql)) {
        const p = this.params;
        extractionRuns.push({
          id: String(p[0]),
          batch_id: p[1] == null ? null : String(p[1]),
          doc_id: String(p[2]),
          provider: String(p[3]),
          model: String(p[4]),
          kind: 'bakeoff',
          ok: Number(p[5]),
          error: p[6] == null ? null : String(p[6]),
          row_count: Number(p[7]),
          latency_ms: p[8] == null ? null : Number(p[8]),
          avg_confidence: p[9] == null ? null : Number(p[9]),
          result_json: p[10] == null ? null : String(p[10]),
          usage_json: p[11] == null ? null : String(p[11]),
          created_at: String(p[12]),
        });
      }
      return { success: true, meta: { changes: 1 } };
    },
  });

  const env = {
    ADMIN_TOKEN: 'test-admin',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    OPENAI_API_KEY: 'sk-openai-test',
    DB: { prepare } as unknown as D1Database,
    RAW_FILES: {
      get: async () => ({ arrayBuffer: validPdfArrayBuffer }),
    },
    INGEST_QUEUE: {
      send: async (message: unknown) => { usageEvents.push(message); },
    },
  } as never;

  return { env, extractionRuns, usageEvents };
}

describe('extraction_runs E2E: bake-off → store → dashboard', () => {
  beforeEach(() => {
    // Stub the Anthropic vision call to return one clean transaction.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('api.anthropic.com')) {
          return {
            ok: true,
            json: async () => ({
              content: [
                {
                  type: 'text',
                  text: '[{"ticker":"AAPL","assetName":"Apple Inc.","txType": "B","amountRange":"$1,001 - $15,000","confidence":0.9}]',
                },
              ],
            }),
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => 'not stubbed' } as unknown as Response;
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('persists each model reading and surfaces it on the review dashboard', async () => {
    const { env, extractionRuns } = makeEnv();

    // 1) Run the bake-off on one doc with one (mocked) model → persists a run.
    const bake = await app.request(
      '/bakeoff',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ docIds: ['H-TEST-1'], models: [{ provider: 'anthropic', model: 'claude-sonnet-5' }] }),
      },
      env,
    );
    expect(bake.status).toBe(200);
    const bakeBody = (await bake.json()) as { ok: boolean; persisted: boolean; batchId: string | null; perDoc: Record<string, Record<string, unknown>> };
    expect(bakeBody.ok).toBe(true);
    expect(bakeBody.persisted).toBe(true);
    expect(bakeBody.batchId).toBeTruthy();
    expect(bakeBody.perDoc['H-TEST-1']['anthropic:claude-sonnet-5']).toBe(1);

    // The reading was stored with the extracted row + a confidence.
    expect(extractionRuns).toHaveLength(1);
    expect(extractionRuns[0]).toMatchObject({ doc_id: 'H-TEST-1', provider: 'anthropic', ok: 1, row_count: 1 });
    expect(JSON.parse(extractionRuns[0].result_json!)[0]).toMatchObject({ ticker: 'AAPL', txType: 'B' });

    // 2) Review-queue list attaches the per-model summary + a status.
    const list = await app.request('/review-queue', { headers: AUTH }, env);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      items: Array<{ docId: string; status: string; models: Array<{ provider: string; ok: boolean; rowCount: number; avgConfidence: number }> }>;
    };
    const item = listBody.items.find((i) => i.docId === 'H-TEST-1')!;
    expect(item.status).toBe('pending');
    expect(item.models).toHaveLength(1);
    expect(item.models[0]).toMatchObject({ provider: 'anthropic', ok: true, rowCount: 1 });
    expect(item.models[0].avgConfidence).toBeGreaterThan(0);

    // 3) The full-readings endpoint returns the stored rows for viewing.
    const ext = await app.request('/review/H-TEST-1/extractions', { headers: AUTH }, env);
    expect(ext.status).toBe(200);
    const extBody = (await ext.json()) as { runs: Array<{ provider: string; rows: Array<{ ticker: string }> }> };
    expect(extBody.runs).toHaveLength(1);
    expect(extBody.runs[0].rows[0].ticker).toBe('AAPL');
  });
});

describe('extraction_runs E2E: openai token usage capture', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects GPT-4o before starting a new bake-off read', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { env, extractionRuns } = makeEnv();

    const bake = await app.request('/bakeoff', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        docIds: ['H-TEST-1'],
        models: [{ provider: 'openai', model: 'gpt-4o' }],
      }),
    }, env);

    expect(bake.status).toBe(400);
    await expect(bake.json()).resolves.toMatchObject({ error: expect.stringContaining('retired') });
    expect(extractionRuns).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('persists usage_json when the openai response includes a usage field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('api.openai.com')) {
          return {
            ok: true,
            json: async () => ({
              model: 'gpt-5.6-terra',
              status: 'completed',
              output_text: '{"transactions":[{"ticker":"AAPL","assetName":"Apple Inc.","txType": "B","amountRange":"$1,001 - $15,000"}]}',
              choices: [{ message: { content: '{"transactions":[{"ticker":"AAPL","assetName":"Apple Inc.","txType": "B","amountRange":"$1,001 - $15,000"}]}' } }],
              usage: {
                input_tokens: 1200,
                output_tokens: 80,
                input_tokens_details: { cached_tokens: 300 },
              },
            }),
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => 'not stubbed' } as unknown as Response;
      }),
    );

    const { env, extractionRuns, usageEvents } = makeEnv();
    const bake = await app.request(
      '/bakeoff',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ docIds: ['H-TEST-1'], models: [{ provider: 'openai', model: 'gpt-5.6-terra' }] }),
      },
      env,
    );
    expect(bake.status).toBe(200);
    const bakeBody = (await bake.json()) as { ok: boolean; persisted: boolean };
    expect(bakeBody.ok).toBe(true);
    expect(bakeBody.persisted).toBe(true);

    expect(extractionRuns).toHaveLength(1);
    expect(extractionRuns[0]).toMatchObject({ doc_id: 'H-TEST-1', provider: 'openai', ok: 1, row_count: 1 });
    expect(JSON.parse(extractionRuns[0].usage_json!)).toEqual({
      promptTokens: 1200,
      completionTokens: 80,
      cachedTokens: 300,
    });
    expect(usageEvents).toContainEqual(expect.objectContaining({
      type: 'usage.telemetry',
      event: expect.objectContaining({
        provider: 'openai',
        label: 'bakeoff-tokens',
        quantity: 1280,
        unit: 'token',
      }),
    }));
  });

  it('persists usage_json as null when the openai response omits usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('api.openai.com')) {
          return {
            ok: true,
            json: async () => ({
              model: 'gpt-5.6-terra',
              status: 'completed',
              output_text: '{"transactions":[{"ticker":"AAPL","assetName":"Apple Inc.","txType": "B","amountRange":"$1,001 - $15,000"}]}',
              choices: [{ message: { content: '{"transactions":[{"ticker":"AAPL","assetName":"Apple Inc.","txType": "B","amountRange":"$1,001 - $15,000"}]}' } }],
              // no `usage` field — older models / some error paths omit it.
            }),
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => 'not stubbed' } as unknown as Response;
      }),
    );

    const { env, extractionRuns } = makeEnv();
    const bake = await app.request(
      '/bakeoff',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ docIds: ['H-TEST-1'], models: [{ provider: 'openai', model: 'gpt-5.6-terra' }] }),
      },
      env,
    );
    expect(bake.status).toBe(200);

    expect(extractionRuns).toHaveLength(1);
    expect(extractionRuns[0]).toMatchObject({ doc_id: 'H-TEST-1', provider: 'openai', ok: 1 });
    expect(JSON.parse(extractionRuns[0].usage_json!)).toBeNull();
  });
});
