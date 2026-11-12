import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../shared/types.ts';

// Scoped to the provider-ban circuit breaker in extractParsed(): a banned
// extractor must abort before extract() runs, and a KV read failure must be
// fault-tolerant (extraction proceeds) rather than silently skipping the ban
// check too.
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

function fakeDb(): { db: D1Database; runs: CapturedRun[] } {
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
          if (/FROM filings WHERE doc_id/i.test(sql)) return FILING_ROW as unknown as T;
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

describe('orchestrator provider-ban circuit breaker', () => {
  beforeEach(() => {
    mocks.buildExtractorPipeline.mockReset();
    mocks.reportAiUsage.mockReset();
  });

  it('skips extraction and propagates an error when the ban key is set', async () => {
    const extract = vi.fn();
    mocks.buildExtractorPipeline.mockReturnValue([
      { name: 'textPdf', canHandle: () => true, extract },
    ]);

    const bytes = new ArrayBuffer(8);
    const { db, runs } = fakeDb();
    const kvGet = vi.fn(async () => '1');
    const env = {
      DB: db,
      RAW_FILES: fakeRawFiles(bytes),
      CONFIG_KV: { get: kvGet, put: vi.fn(), delete: vi.fn() },
    } as unknown as Env;

    await expect(extractParsed(env, 'H-1')).rejects.toThrow(/circuit breaker is open/i);

    expect(kvGet).toHaveBeenCalledWith('provider_ban:textPdf');
    expect(extract).not.toHaveBeenCalled();

    const errorRun = runs.find((r) => /SET ingest_status = 'error'/i.test(r.sql));
    expect(errorRun?.params?.[0]).toEqual(expect.stringContaining('circuit breaker is open'));
    expect(errorRun?.params?.[1]).toBe('H-1');
    expect(errorRun?.params?.slice(2)).toEqual([
      'auto_published',
      'confirmed',
      'manual',
      'agreement_published',
    ]);
  });

  it('proceeds with extraction when the KV read throws', async () => {
    const extract = vi.fn(async () => ({
      transactions: [],
      confidence: 0.9,
      raw: 'text',
      extractor: 'textPdf',
    }));
    mocks.buildExtractorPipeline.mockReturnValue([
      { name: 'textPdf', canHandle: () => true, extract },
    ]);

    const bytes = new ArrayBuffer(8);
    const { db, runs } = fakeDb();
    const env = {
      DB: db,
      RAW_FILES: fakeRawFiles(bytes),
      CONFIG_KV: {
        get: vi.fn(async () => {
          throw new Error('kv down');
        }),
        put: vi.fn(),
        delete: vi.fn(),
      },
    } as unknown as Env;

    const result = await extractParsed(env, 'H-1');

    expect(extract).toHaveBeenCalledTimes(1);
    expect(result?.extractor).toBe('textPdf');
    expect(runs.some((r) => /SET ingest_status = 'error'/i.test(r.sql))).toBe(false);
  });

  it('does not let a vision ban block the text-first House wrapper', async () => {
    const extract = vi.fn(async () => ({
      transactions: [{ id: 'tx-1' }],
      confidence: 0.9,
      raw: 'text',
      extractor: 'textPdf',
    }));
    mocks.buildExtractorPipeline.mockReturnValue([
      {
        name: 'housePdf(textPdf,visionLlm)',
        circuitBreakerName: 'visionLlm',
        canHandle: () => true,
        extract,
      },
    ]);

    const { db } = fakeDb();
    const kvGet = vi.fn(async () => '1');
    const env = {
      DB: db,
      RAW_FILES: fakeRawFiles(new ArrayBuffer(8)),
      CONFIG_KV: { get: kvGet, put: vi.fn(), delete: vi.fn() },
    } as unknown as Env;

    const result = await extractParsed(env, 'H-1');

    expect(result?.extractor).toBe('textPdf');
    expect(extract).toHaveBeenCalledTimes(1);
    expect(kvGet).not.toHaveBeenCalled();
  });

  it('does not let a vision ban block the text-first OGE wrapper, including scans', async () => {
    const extract = vi.fn(async () => ({
      transactions: [{ id: 'tx-1' }],
      confidence: 0.97,
      raw: 'text',
      extractor: 'ogeText',
    }));
    mocks.buildExtractorPipeline.mockReturnValue([
      {
        name: 'ogePdf(ogeText,arbitrating(configuredVision,visionLlm-secondary))',
        circuitBreakerName: 'configuredVision',
        canHandle: () => true,
        extract,
      },
    ]);

    const { db } = fakeDb();
    const kvGet = vi.fn(async () => '1');
    const env = {
      DB: db,
      RAW_FILES: fakeRawFiles(new ArrayBuffer(8)),
      CONFIG_KV: { get: kvGet, put: vi.fn(), delete: vi.fn() },
    } as unknown as Env;

    const result = await extractParsed(env, 'H-1');

    expect(result?.extractor).toBe('ogeText');
    expect(extract).toHaveBeenCalledTimes(1);
    expect(kvGet).not.toHaveBeenCalled();
  });
});
