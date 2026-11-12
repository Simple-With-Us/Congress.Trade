import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../shared/types.ts';

// No pre-existing orchestrator test file to extend (only admin/reprocessHardFailure.test.ts,
// which mocks the orchestrator module entirely rather than exercising it) — this file is new,
// scoped narrowly to the raw_bytes/page_count persistence added to extractParsed().
const mocks = vi.hoisted(() => ({
  buildExtractorPipeline: vi.fn(),
  reportAiUsage: vi.fn(async () => {}),
}));

vi.mock('../../extractors/types', async () => {
  const actual = await vi.importActual<typeof import('../../extractors/types')>(
    '../../extractors/types',
  );
  return {
    ...actual,
    buildExtractorPipeline: mocks.buildExtractorPipeline,
  };
});

vi.mock('../../shared/telemetry', () => ({
  reportAiUsage: mocks.reportAiUsage,
}));

import { extractParsed } from '../orchestrator.ts';

const FILING_ROW = {
  doc_id: 'H-1',
  chamber: 'house',
  filer_id: 'house-ca01-test-member',
  filing_type: 'P',
  filed_date: '2026-06-30',
  source_url: 'https://example.test/H-1.pdf',
  raw_object_key: 'raw/H-1.pdf',
  ingest_status: 'classified',
  doc_kind: 'text_pdf',
  extractor: null,
  model_version: null,
  confidence: null,
  first_seen_at: '2026-06-30T00:00:00.000Z',
  source_updated_at: null,
  error: null,
};

interface CapturedRun {
  sql: string;
  params: unknown[];
}

function fakeDb(row: Record<string, unknown> = FILING_ROW): { db: D1Database; runs: CapturedRun[] } {
  const runs: CapturedRun[] = [];
  const db = {
    prepare(sql: string) {
      let params: unknown[] = [];
      return {
        bind(...p: unknown[]) {
          params = p;
          return this;
        },
        async first<T>() {
          if (/FROM filings WHERE doc_id/i.test(sql)) return row as unknown as T;
          return null as T | null;
        },
        async run() {
          runs.push({ sql, params });
          return { success: true, meta: { changes: 1 } };
        },
        async all<T>() {
          return { results: [] as T[] };
        },
      };
    },
  } as unknown as D1Database;
  return { db, runs };
}

function fakeRawFiles(bytes: ArrayBuffer) {
  return {
    async get() {
      return { arrayBuffer: async () => bytes } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;
}

describe('orchestrator complexity signals (raw_bytes / page_count)', () => {
  beforeEach(() => {
    mocks.buildExtractorPipeline.mockReset();
    mocks.reportAiUsage.mockReset();
  });

  it('records raw_bytes and page_count after a successful extraction', async () => {
    mocks.buildExtractorPipeline.mockReturnValue([
      {
        name: 'textPdf',
        canHandle: () => true,
        extract: async () => ({
          transactions: [],
          confidence: 0.9,
          raw: 'text',
          extractor: 'textPdf',
          pageCount: 4,
        }),
      },
    ]);

    const bytes = new ArrayBuffer(1234);
    const { db, runs } = fakeDb();
    const env = { DB: db, RAW_FILES: fakeRawFiles(bytes) } as unknown as Env;

    const result = await extractParsed(env, 'H-1');
    expect(result).not.toBeNull();

    const rawBytesRun = runs.find((r) => /SET raw_bytes = \? WHERE doc_id/i.test(r.sql));
    expect(rawBytesRun?.params).toEqual([1234, 'H-1']);

    const pageCountRun = runs.find((r) => /SET page_count = \? WHERE doc_id/i.test(r.sql));
    expect(pageCountRun?.params).toEqual([4, 'H-1']);
  });

  it('records raw_bytes but skips page_count when the extractor result has no page count', async () => {
    mocks.buildExtractorPipeline.mockReturnValue([
      {
        name: 'visionLlm',
        canHandle: () => true,
        extract: async () => ({
          transactions: [],
          confidence: 0.8,
          raw: 'text',
          extractor: 'visionLlm',
          // no pageCount field — the vision path doesn't expose one cheaply.
        }),
      },
    ]);

    const bytes = new ArrayBuffer(42);
    const { db, runs } = fakeDb();
    const env = { DB: db, RAW_FILES: fakeRawFiles(bytes) } as unknown as Env;

    await extractParsed(env, 'H-1');

    const rawBytesRun = runs.find((r) => /SET raw_bytes = \? WHERE doc_id/i.test(r.sql));
    expect(rawBytesRun?.params).toEqual([42, 'H-1']);

    const pageCountRun = runs.find((r) => /SET page_count = \? WHERE doc_id/i.test(r.sql));
    expect(pageCountRun).toBeUndefined();
  });

  it('reports every arbitrated model run and returns their provider request identities', async () => {
    const modelRuns = [
      {
        extractor: 'vision-primary',
        modelVersion: 'gemini-3.5-flash',
        providerRequestId: 'primary-request',
        usage: { promptTokens: 100, completionTokens: 20 },
      },
      {
        extractor: 'vision-secondary',
        modelVersion: 'gemini-2.5-pro',
        providerRequestId: 'secondary-request',
        usage: { promptTokens: 120, completionTokens: 30 },
      },
    ];
    mocks.buildExtractorPipeline.mockReturnValue([{
      name: 'arbitrating(vision-primary,vision-secondary)',
      canHandle: () => true,
      extract: async () => ({
        transactions: [],
        confidence: 0.8,
        raw: 'text',
        extractor: 'arbitrating(vision-primary,vision-secondary)',
        modelVersion: 'gemini-3.5-flash',
        modelRuns,
      }),
    }]);
    const bytes = new ArrayBuffer(42);
    const { db } = fakeDb();
    const env = { DB: db, RAW_FILES: fakeRawFiles(bytes) } as unknown as Env;

    const extracted = await extractParsed(env, 'H-1');

    expect(extracted?.modelRuns).toEqual(modelRuns);
    expect(mocks.reportAiUsage).toHaveBeenNthCalledWith(1, env, expect.objectContaining({
      provider: 'gemini',
      model: 'gemini-3.5-flash',
      promptTokens: 100,
      completionTokens: 20,
    }));
    expect(mocks.reportAiUsage).toHaveBeenNthCalledWith(2, env, expect.objectContaining({
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      promptTokens: 120,
      completionTokens: 30,
    }));
  });

  it('uses the provider-resolved model attached to a failed parse', async () => {
    const providerError = Object.assign(new Error('parse failed'), {
      resolvedModel: 'gemini-2.5-pro-20260701',
      providerRequestId: 'failed-request',
      usage: { promptTokens: 0, completionTokens: 17, cachedTokens: 3 },
    });
    mocks.buildExtractorPipeline.mockReturnValue([{
      name: 'vision-secondary',
      canHandle: () => true,
      extract: async () => { throw providerError; },
    }]);
    const bytes = new ArrayBuffer(42);
    const { db } = fakeDb();
    const env = { DB: db, RAW_FILES: fakeRawFiles(bytes) } as unknown as Env;

    await expect(extractParsed(env, 'H-1')).rejects.toBe(providerError);

    expect(mocks.reportAiUsage).toHaveBeenCalledWith(env, expect.objectContaining({
      provider: 'gemini',
      model: 'gemini-2.5-pro-20260701',
      promptTokens: 0,
      completionTokens: 17,
      cachedTokens: 3,
    }));
  });
});

describe('orchestrator OCR byte retention (CT-2448)', () => {
  beforeEach(() => {
    mocks.buildExtractorPipeline.mockReset();
    mocks.reportAiUsage.mockReset();
    mocks.buildExtractorPipeline.mockReturnValue([
      {
        name: 'textPdf',
        canHandle: () => true,
        extract: async () => ({
          transactions: [],
          confidence: 0.9,
          raw: 'text',
          extractor: 'textPdf',
        }),
      },
    ]);
  });

  const EXECUTIVE_ROW = {
    doc_id: 'E-2026-donald-j-trump-08-12-2026-278t',
    chamber: 'executive',
    filer_id: 'EXEC-DJT',
    // Realistic: the watcher stores executive filings with filing_type 'P'.
    filing_type: 'P',
    filed_date: '2026-08-12',
    source_url: 'https://example.test/E-278t.pdf',
    raw_object_key: 'raw/E-278t.pdf',
    ingest_status: 'classified',
    doc_kind: 'text_pdf',
    extractor: null,
    model_version: null,
    confidence: null,
    first_seen_at: '2026-08-12T00:00:00.000Z',
    source_updated_at: null,
    error: null,
  };

  it('keeps a PDF copy for an executive 278-T when keepBytes is set', async () => {
    const bytes = new ArrayBuffer(1234);
    const { db } = fakeDb(EXECUTIVE_ROW);
    const env = { DB: db, RAW_FILES: fakeRawFiles(bytes) } as unknown as Env;

    const result = await extractParsed(env, EXECUTIVE_ROW.doc_id, undefined, { keepBytes: true });

    expect(result?.bytes).toBeInstanceOf(ArrayBuffer);
    expect(result?.bytes?.byteLength).toBe(1234);
    // A copy, not the buffer the extractor may detach.
    expect(result?.bytes).not.toBe(bytes);
  });

  it('skips the PDF copy for filings the local OCR pass cannot retry', async () => {
    const bytes = new ArrayBuffer(1234);
    const { db } = fakeDb();
    const env = { DB: db, RAW_FILES: fakeRawFiles(bytes) } as unknown as Env;

    const result = await extractParsed(env, 'H-1', undefined, { keepBytes: true });

    expect(result).not.toBeNull();
    expect(result?.bytes).toBeUndefined();
  });

  it('skips the PDF copy without keepBytes even for an executive 278-T', async () => {
    const bytes = new ArrayBuffer(1234);
    const { db } = fakeDb(EXECUTIVE_ROW);
    const env = { DB: db, RAW_FILES: fakeRawFiles(bytes) } as unknown as Env;

    const result = await extractParsed(env, EXECUTIVE_ROW.doc_id);

    expect(result).not.toBeNull();
    expect(result?.bytes).toBeUndefined();
  });
});
