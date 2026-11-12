import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  maybeRunDeterministicReviewDrain,
  storedReviewPayloadIsIncomplete,
  sweepRejectedScannedForLocalVision,
} from '../deterministicDrain.ts';

const mocks = vi.hoisted(() => ({
  extractAndNormalize: vi.fn(),
  extractParsed: vi.fn(),
  normalize: vi.fn(),
  recordIngestionDecision: vi.fn(),
}));

vi.mock('../orchestrator.ts', () => ({
  extractAndNormalize: mocks.extractAndNormalize,
  extractParsed: mocks.extractParsed,
}));

vi.mock('../normalizer.ts', async () => {
  const actual = await vi.importActual<typeof import('../normalizer.ts')>('../normalizer.ts');
  return {
    ...actual,
    normalize: mocks.normalize,
  };
});

vi.mock('../../shared/ingestionDecisions.ts', () => ({
  recordIngestionDecision: mocks.recordIngestionDecision,
}));

function makeEnv(rows: Array<Record<string, unknown>>, opts: { liveTx?: number } = {}) {
  const queue: unknown[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const bound: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) {
            bound.push(...args);
            return stmt;
          },
          async all() {
            if (/FROM review_queue/i.test(sql) || /FROM filings f/i.test(sql) && /review_queue/i.test(sql)) {
              return { results: rows };
            }
            if (/COUNT\(\*\)/i.test(sql)) {
              return { results: [{ n: opts.liveTx ?? 0 }] };
            }
            if (/local_vision_requeue/i.test(sql) || /ocr_unusable/i.test(sql)) {
              return { results: rows };
            }
            return { results: [] };
          },
          async run() {
            return { meta: { changes: 1 } };
          },
          async first() {
            const row = rows[0];
            if (!row) return null;
            return {
              docId: row.doc_id,
              chamber: 'house',
              filerId: 'f1',
              filingType: 'P',
              filedDate: '2024-06-01',
              sourceUrl: null,
              rawObjectKey: row.raw_object_key,
              ingestStatus: 'needs_review',
              docKind: row.doc_kind,
              extractor: row.extractor,
              modelVersion: null,
              confidence: 0.6,
              firstSeenAt: null,
              sourceUpdatedAt: null,
              error: null,
            };
          },
        };
        return stmt;
      },
      batch: async () => [],
    },
    INGEST_QUEUE: {
      send: async (msg: unknown) => {
        queue.push(msg);
      },
    },
    RAW_FILES: {},
  } as unknown as import('../../shared/types.ts').Env;
  return { env, queue };
}

describe('storedReviewPayloadIsIncomplete', () => {
  it('treats a sliced 200-of-219 review payload as incomplete', () => {
    expect(storedReviewPayloadIsIncomplete({
      truncated: true,
      transactionCount: 219,
      transactions: Array.from({ length: 200 }, () => ({ ticker: 'X' })),
    })).toBe(true);
  });

  it('treats transactionCount ahead of the stored rows as incomplete even without truncated', () => {
    expect(storedReviewPayloadIsIncomplete({
      transactionCount: 219,
      transactions: Array.from({ length: 200 }, () => ({ ticker: 'X' })),
    })).toBe(true);
  });

  it('accepts a complete payload', () => {
    expect(storedReviewPayloadIsIncomplete({
      truncated: false,
      transactionCount: 2,
      transactions: [{ ticker: 'AAPL' }, { ticker: 'MSFT' }],
    })).toBe(false);
  });

  it('treats a one-row payload whose rawText still contains later PTR tails as incomplete', () => {
    expect(storedReviewPayloadIsIncomplete({
      truncated: false,
      transactionCount: 1,
      transactions: [{
        ticker: 'AMZN',
        assetName: 'Allegheny Cnty Pa Hosp Dev Auth',
        rawText:
          'ALLEGHENY CNTY PA HOSP DEV AUTH [GS] S 03/27/2025 03/27/2025 $100,001 - $250,000 F S: New Amazon.com, Inc. (AMZN) [ST] S 04/03/2025 04/03/2025 $1,001 - $15,000',
      }],
    })).toBe(true);
  });
});

describe('maybeRunDeterministicReviewDrain', () => {
  beforeEach(() => {
    mocks.extractAndNormalize.mockReset();
    mocks.extractParsed.mockReset();
    mocks.normalize.mockReset();
    mocks.recordIngestionDecision.mockReset().mockResolvedValue('id');
  });

  it('re-extracts deterministic review rows and counts publish', async () => {
    const { env } = makeEnv(
      [{ doc_id: 'H-1', raw_object_key: 'raw/h1.pdf', doc_kind: 'text_pdf', extractor: 'textPdf' }],
      { liveTx: 2 },
    );
    mocks.extractAndNormalize.mockResolvedValue(undefined);
    const r = await maybeRunDeterministicReviewDrain(env, { limit: 5 });
    expect(mocks.extractAndNormalize).toHaveBeenCalledWith(env, 'H-1');
    expect(r.scanned).toBe(1);
    expect(r.published).toBe(1);
    expect(r.errors).toBe(0);
  });

  it('skips non-deterministic extractors even if selected', async () => {
    const { env } = makeEnv([
      { doc_id: 'H-2', raw_object_key: 'raw/h2.pdf', doc_kind: 'scanned_pdf', extractor: 'server_cpu_v1' },
    ]);
    const r = await maybeRunDeterministicReviewDrain(env);
    expect(mocks.extractAndNormalize).not.toHaveBeenCalled();
    // The mock DB returns the row regardless of the SQL WHERE clause; the
    // in-loop scanned_pdf guard is what must hold it back.
    expect(r.scanned).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.stillReview).toBe(0);
  });

  it('skips attempt-capped cascade disagreements instead of re-extracting every minute', async () => {
    const { env } = makeEnv([
      {
        doc_id: 'H-2026-20035235',
        raw_object_key: 'raw/h.pdf',
        doc_kind: 'text_pdf',
        extractor: 'textPdf',
        reason: 'agreement_cascade_unresolved',
        agreement_attempts: 3,
      },
    ]);
    const r = await maybeRunDeterministicReviewDrain(env, { limit: 5 });
    expect(mocks.extractAndNormalize).not.toHaveBeenCalled();
    expect(r.scanned).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.published).toBe(0);
  });

  it('never re-extracts a scanned_pdf even when the extractor string looks deterministic (2026-08-20 ping-pong)', async () => {
    // Regression: H-2024-20025111 carried doc_kind=scanned_pdf with a stale
    // extractor='textPdf'. The old selector matched on the extractor string,
    // re-extracted the scan as text every minute (garbage), the normalizer
    // re-flagged it, and the agreement recovery flipped it back to
    // agreement_cascade_unresolved — an infinite per-minute ping-pong that
    // burned CPU and review_revision without ever publishing.
    const { env } = makeEnv([
      { doc_id: 'H-2024-20025111', raw_object_key: 'raw/h.pdf', doc_kind: 'scanned_pdf', extractor: 'textPdf' },
    ]);
    const r = await maybeRunDeterministicReviewDrain(env, { limit: 5 });
    expect(mocks.extractAndNormalize).not.toHaveBeenCalled();
    expect(mocks.extractParsed).not.toHaveBeenCalled();
    expect(mocks.normalize).not.toHaveBeenCalled();
    expect(r.scanned).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.stillReview).toBe(0);
  });

  it('does not publish a truncated stored review payload; re-extracts instead', async () => {
    const payload = JSON.stringify({
      truncated: true,
      transactionCount: 219,
      transactions: Array.from({ length: 200 }, () => ({
        txDate: '2024-01-01',
        owner: 'self',
        assetName: 'City of El Paso TX GO',
        ticker: null,
        assetType: 'GS',
        txType: 'B',
        amountMin: 1001,
        amountMax: 15000,
      })),
    });
    const { env } = makeEnv(
      [{
        doc_id: 'H-2024-8220320',
        raw_object_key: 'raw/h.pdf',
        doc_kind: 'text_pdf',
        extractor: 'textPdf',
        reason: 'extraction_row_limit_exceeded_needs_reprocess:0.00',
        payload,
      }],
      { liveTx: 219 },
    );
    mocks.extractAndNormalize.mockResolvedValue(undefined);
    const r = await maybeRunDeterministicReviewDrain(env, { limit: 5 });
    expect(mocks.normalize).not.toHaveBeenCalled();
    expect(mocks.extractAndNormalize).toHaveBeenCalledWith(env, 'H-2024-8220320');
    expect(r.published).toBe(1);
  });

  it('publishes a complete stored payload without re-extracting', async () => {
    const payload = JSON.stringify({
      truncated: false,
      transactionCount: 2,
      transactions: [
        {
          txDate: '2024-01-01',
          owner: 'self',
          assetName: 'Apple Inc',
          ticker: 'AAPL',
          assetType: 'ST',
          txType: 'B',
          amountMin: 1001,
          amountMax: 15000,
        },
        {
          txDate: '2024-01-02',
          owner: 'self',
          assetName: 'Microsoft',
          ticker: 'MSFT',
          assetType: 'ST',
          txType: 'S',
          amountMin: 1001,
          amountMax: 15000,
        },
      ],
    });
    const { env } = makeEnv([
      {
        doc_id: 'H-1',
        raw_object_key: 'raw/h1.pdf',
        doc_kind: 'text_pdf',
        extractor: 'textPdf',
        reason: 'low_confidence',
        payload,
      },
    ]);
    mocks.normalize.mockResolvedValue({ published: true });
    const r = await maybeRunDeterministicReviewDrain(env, { limit: 5 });
    expect(mocks.normalize).toHaveBeenCalled();
    expect(mocks.extractAndNormalize).not.toHaveBeenCalled();
    expect(r.published).toBe(1);
  });

  it('re-extracts cheap openRouterText rows on typed House PTRs', async () => {
    const { env } = makeEnv(
      [{ doc_id: 'H-2024-20025959', raw_object_key: 'raw/h.pdf', doc_kind: 'text_pdf', extractor: 'openRouterText' }],
      { liveTx: 1 },
    );
    mocks.extractAndNormalize.mockResolvedValue(undefined);
    const r = await maybeRunDeterministicReviewDrain(env, { limit: 5 });
    expect(mocks.extractAndNormalize).toHaveBeenCalledWith(env, 'H-2024-20025959');
    expect(r.scanned).toBe(1);
    expect(r.published).toBe(1);
    expect(r.skipped).toBe(0);
  });
});

describe('sweepRejectedScannedForLocalVision', () => {
  it('requeues rejected scanned docs with raw into extraction_pending_local', async () => {
    const { env, queue } = makeEnv([{ doc_id: 'H-scan-1' }]);
    const r = await sweepRejectedScannedForLocalVision(env, { limit: 10 });
    expect(r.requeued).toBe(1);
    expect(queue).toEqual([{ type: 'filing.local_wait_check', docId: 'H-scan-1' }]);
  });

  it('does not treat local_vision_exhausted as a reason to reopen the queue', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../deterministicDrain.ts', import.meta.url), 'utf8'),
    );
    expect(src).toContain("NOT LIKE '%local_vision_exhausted%'");
    expect(src).not.toMatch(/OR COALESCE\(f\.error, ''\) LIKE '%local_vision_exhausted%'/);
  });
});
