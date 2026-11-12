import { describe, it, expect, vi, afterEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  VisionLlmExtractor,
  fetchWithRetry,
  salvageTruncatedTransactions,
  parseTruncationAwareJson,
  markSalvaged,
  validatePdfForAnthropic,
  resavePdfForAnthropic,
  isAnthropicInvalidPdfError,
} from '../visionLlm.ts';
import type { Env, Filing, ParsedTx } from '../../shared/types.ts';

const filing = (): Filing => ({
  docId: 'doc1',
  chamber: 'house',
  filerId: 'F1',
  filingType: 'P',
  filedDate: '2024-07-01',
  sourceUrl: 'https://x',
  rawObjectKey: 'raw/house/doc1.pdf',
  ingestStatus: 'classified',
  docKind: 'scanned_pdf',
  extractor: null,
  modelVersion: null,
  confidence: null,
  firstSeenAt: '2024-07-01T00:00:00.000Z',
  sourceUpdatedAt: null,
  error: null,
});

const env = { GEMINI_API_KEY: 'test-key' } as unknown as Env;
function makeBytes(s: string): ArrayBuffer {
  const src = new TextEncoder().encode(s);
  const buf = new ArrayBuffer(src.byteLength);
  new Uint8Array(buf).set(src);
  return buf;
}
const bytes: ArrayBuffer = makeBytes('%PDF-1.7 scanned');

const mockGenerateContent = vi.fn();

vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class {
      models = {
        generateContent: mockGenerateContent
      };
    }
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  mockGenerateContent.mockClear();
});

describe('VisionLlmExtractor', () => {
  it('canHandle only scanned_pdf', () => {
    const ex = new VisionLlmExtractor(env);
    expect(ex.canHandle({ ...filing(), docKind: 'scanned_pdf' })).toBe(true);
    expect(ex.canHandle({ ...filing(), docKind: 'text_pdf' })).toBe(false);
  });

  it('POSTs to Gemini once and maps the JSON array to ParsedTx[]', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify([
        {
          txDate: '2024-06-14',
          owner: 'spouse',
          assetName: 'Apple Inc.',
          ticker: 'aapl',
          assetType: 'ST',
          txType: 'B',
          amountRange: '$1,001 - $15,000',
          isOption: false,
          capGainsOver200: false,
          confidence: 0.95,
        },
      ]),
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15
      },
      modelVersion: 'gemini-3.5-flash-test'
    });

    const ex = new VisionLlmExtractor(env);
    const result = await ex.extract({ filing: filing(), bytes });

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);

    expect(result.extractor).toBe('visionLlm');
    expect(result.modelVersion).toBeTruthy();
    expect(result.transactions).toHaveLength(1);
    const t = result.transactions[0];
    expect(t.ticker).toBe('AAPL');
    expect(t.amountMin).toBe(1001);
    expect(t.amountMax).toBe(15000);
    // Conservative: per-row confidence capped at the default floor (~0.6).
    expect(t.confidence).toBeLessThanOrEqual(0.6);
  });


  it('throws on an API error', async () => {
    mockGenerateContent.mockRejectedValueOnce(
      Object.assign(new Error('overloaded'), { status: 503 })
    );
    const ex = new VisionLlmExtractor(env);
    await expect(ex.extract({ filing: filing(), bytes })).rejects.toThrow(/overloaded/);
  });

  it('skips chunking for massive context models (e.g. Gemini, Claude 3, OpenRouter) even with >50 pages', async () => {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < 60; i++) {
      pdf.addPage([200, 200]);
    }
    const saved = await pdf.save();
    const testBytes = saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer;

    mockGenerateContent.mockResolvedValueOnce({
      text: '[]',
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      modelVersion: 'gemini-2.0-flash-test'
    });

    const ex = new VisionLlmExtractor(env, { model: 'openrouter:openai/gpt-4o' });
    await ex.extract({ filing: filing(), bytes: testBytes });

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  it('chunks into 50-page segments for older/non-massive context models with >50 pages', async () => {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < 60; i++) {
      pdf.addPage([200, 200]);
    }
    const saved = await pdf.save();
    const testBytes = saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer;

    mockGenerateContent.mockResolvedValue({
      text: '[]',
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      modelVersion: 'legacy-model'
    });

    const ex = new VisionLlmExtractor(env, { model: 'legacy-model' });
    await ex.extract({ filing: filing(), bytes: testBytes });

    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });
});



describe('fetchWithRetry', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retries a 429 then returns the success (no real delay)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithRetry('https://x', { method: 'POST' }, 'test', {
      sleep: async () => {},
      jitter: () => 0,
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxAttempts on a persistent 429', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithRetry('https://x', {}, 'test', {
      maxAttempts: 3,
      sleep: async () => {},
      jitter: () => 0,
    });
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-429 4xx status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithRetry('https://x', {}, 'test', { sleep: async () => {} });
    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a transient 500 then returns the success', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('server error', { status: 500 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithRetry('https://x', {}, 'test', {
      sleep: async () => {},
      jitter: () => 0,
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([522, 529, 503, 502])('retries Cloudflare/upstream status %d', async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('upstream error', { status }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithRetry('https://x', {}, 'test', {
      sleep: async () => {},
      jitter: () => 0,
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxAttempts on a persistent 5xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithRetry('https://x', {}, 'test', {
      maxAttempts: 3,
      sleep: async () => {},
      jitter: () => 0,
    });
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a network error then returns the success', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithRetry('https://x', {}, 'test', {
      sleep: async () => {},
      jitter: () => 0,
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws the network error once maxAttempts is exhausted', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      fetchWithRetry('https://x', {}, 'test', {
        maxAttempts: 2,
        sleep: async () => {},
        jitter: () => 0,
      }),
    ).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry after the caller aborts the request', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new DOMException('The operation was aborted', 'AbortError');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchWithRetry('https://x', { signal: controller.signal }, 'test', {
        sleep: async () => {},
      }),
    ).rejects.toThrow('aborted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});


describe('salvageTruncatedTransactions', () => {
  it('recovers complete leading rows from a truncated bare array and drops the trailing partial row', () => {
    const text = '[{"ticker":"AAPL","assetName":"Apple Inc.","txType": "B","amountRange":"$1,001 - $15,000"},{"ticker":"MSFT","assetName":"Microsoft","txType":"S","amountRange":"$15,001 - $50,00';
    const rows = salvageTruncatedTransactions(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ticker: 'AAPL' });
  });

  it('recovers rows nested inside a wrapper object ({"transactions": [...]}) even when truncated', () => {
    const text = '{"transactions":[{"ticker":"AAPL","assetName":"Apple Inc.","txType": "B","amountRange":"$1,001 - $15,000"},{"ticker":"MSFT","assetName":"Microsoft","txType":"S","amountRange":"$15,00';
    const rows = salvageTruncatedTransactions(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ticker: 'AAPL' });
  });

  it('recovers every row from a complete, well-formed array (same result as a normal parse)', () => {
    const text = JSON.stringify([
      { ticker: 'AAPL', assetName: 'Apple Inc.', txType: 'B', amountRange: '$1,001 - $15,000' },
      { ticker: 'MSFT', assetName: 'Microsoft', txType: 'S', amountRange: '$15,001 - $50,000' },
    ]);
    const rows = salvageTruncatedTransactions(text);
    expect(rows).toHaveLength(2);
    expect(rows[1].ticker).toBe('MSFT');
  });

  it('drops a row truncated mid-string value even though brace counting alone would look balanced', () => {
    const text = '[{"ticker":"AAPL","assetName":"Apple Inc.","txType": "B","amountRange":"$1,001 - $15,000"},{"ticker":"MSFT","assetName":"Microsoft is a tech compan';
    const rows = salvageTruncatedTransactions(text);
    expect(rows).toHaveLength(1);
    expect(rows[0].ticker).toBe('AAPL');
  });

  it('returns an empty array when the output is cut off before the first complete row', () => {
    const text = '[{"ticker":"AAPL","assetName":"Apple Inc.';
    expect(salvageTruncatedTransactions(text)).toEqual([]);
  });

  it('returns an empty array when there is no JSON array in the text at all', () => {
    expect(salvageTruncatedTransactions('not json at all')).toEqual([]);
  });

  it('strips a fenced ```json code block before scanning', () => {
    const text = '```json\n[{"ticker":"AAPL","assetName":"Apple Inc.","txType": "B","amountRange":"$1,001 - $15,000"}]\n```';
    const rows = salvageTruncatedTransactions(text);
    expect(rows).toHaveLength(1);
  });
});

describe('parseTruncationAwareJson', () => {
  it('parses complete JSON normally regardless of stop_reason', () => {
    const text = '[{"ticker":"AAPL","assetName":"Apple Inc.","txType": "B","amountRange":"$1,001 - $15,000"}]';
    expect(parseTruncationAwareJson(text, false)).toEqual({ rows: JSON.parse(text), salvaged: false });
    expect(parseTruncationAwareJson(text, true)).toEqual({ rows: JSON.parse(text), salvaged: false });
  });

  it('salvages complete leading rows when stop_reason is max_tokens and the JSON is truncated', () => {
    const text = '[{"ticker":"AAPL","assetName":"Apple Inc.","txType": "B","amountRange":"$1,001 - $15,000"},{"ticker":"MSFT","assetName":"Micro';
    const result = parseTruncationAwareJson(text, true);
    expect(result.salvaged).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].ticker).toBe('AAPL');
  });

  it('still throws on truncated JSON when stop_reason is not max_tokens (genuine parse failure)', () => {
    const text = '[{"ticker":"AAPL","assetName":"Apple Inc.","txType": "B","amountRange":"$1,001 - $15,000"},{"ticker":"MSFT","assetName":"Micro';
    expect(() => parseTruncationAwareJson(text, false)).toThrow();
    expect(() => parseTruncationAwareJson(text, false)).toThrow();
  });

  it('throws when stop_reason is max_tokens but salvage recovers nothing (cut off before any row)', () => {
    const text = '[{"ticker":"AAPL","assetName":"Apple Inc.';
    expect(() => parseTruncationAwareJson(text, true)).toThrow();
  });
});

describe('markSalvaged', () => {
  const baseTx: ParsedTx = {
    txDate: null,
    owner: null,
    assetName: 'Apple Inc.',
    ticker: 'AAPL',
    assetType: null,
    txType: 'B',
    amountMin: 1001,
    amountMax: 15000,
    isOption: false,
    capGainsOver200: false,
    rawText: '{}',
    confidence: 0.6,
  };

  it('appends the salvaged-output marker', () => {
    const marked = markSalvaged(baseTx);
    expect(marked.extractionWarnings).toEqual(['salvaged_truncated_output']);
  });

  it('preserves existing warnings and does not duplicate the marker on repeat calls', () => {
    const withWarning: ParsedTx = { ...baseTx, extractionWarnings: ['unreadable_is_option'] };
    const marked = markSalvaged(withWarning);
    expect(marked.extractionWarnings).toEqual(['unreadable_is_option', 'salvaged_truncated_output']);
    expect(markSalvaged(marked).extractionWarnings).toEqual(['unreadable_is_option', 'salvaged_truncated_output']);
  });
});

/** A hand-written minimal PDF (not pdf-lib-generated) that pdf-lib CAN parse
 *  but whose pdf-lib resave produces different bytes — lets tests assert
 *  "original bytes, not resaved" without relying on incidental byte
 *  equality between two pdf-lib serializations. */
function handWrittenPdfBytes(): ArrayBuffer {
  const text = [
    '%PDF-1.4',
    '1 0 obj',
    '<< /Type /Catalog /Pages 2 0 R >>',
    'endobj',
    '2 0 obj',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    'endobj',
    '3 0 obj',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    'endobj',
    'xref',
    '0 4',
    '0000000000 65535 f ',
    '0000000009 00000 n ',
    '0000000058 00000 n ',
    '0000000115 00000 n ',
    'trailer',
    '<< /Size 4 /Root 1 0 R >>',
    'startxref',
    '190',
    '%%EOF',
  ].join('\n');
  const src = new TextEncoder().encode(text);
  const buf = new ArrayBuffer(src.byteLength);
  new Uint8Array(buf).set(src);
  return buf;
}

describe('validatePdfForAnthropic', () => {
  it('returns the ORIGINAL bytes unchanged for a valid, parseable PDF (does NOT resave)', async () => {
    const validBytes = handWrittenPdfBytes();

    const result = await validatePdfForAnthropic(validBytes);
    expect(result).toBe(validBytes);
    expect(new Uint8Array(result)).toEqual(new Uint8Array(validBytes));
  });

  it('throws a stable, secret-safe message for unparseable bytes', async () => {
    const bytes = new TextEncoder().encode('not a pdf at all').buffer as ArrayBuffer;
    await expect(validatePdfForAnthropic(bytes)).rejects.toThrow('anthropic: invalid PDF (unparseable by pdf-lib)');
  });
});

describe('resavePdfForAnthropic', () => {
  it('round-trips a valid PDF through pdf-lib, producing a still-loadable (but re-serialized) PDF', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    const saved = await pdf.save();
    const validBytes = saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer;

    const resaved = await resavePdfForAnthropic(validBytes);
    // Still a valid, re-loadable PDF after the resave round-trip.
    await expect(PDFDocument.load(resaved)).resolves.toBeTruthy();
  });

  it('throws a stable, secret-safe message for unparseable bytes', async () => {
    const bytes = new TextEncoder().encode('not a pdf at all').buffer as ArrayBuffer;
    await expect(resavePdfForAnthropic(bytes)).rejects.toThrow('anthropic: invalid PDF (unparseable by pdf-lib)');
  });
});

describe('isAnthropicInvalidPdfError', () => {
  it('matches the receipted invalid-PDF message text', () => {
    expect(isAnthropicInvalidPdfError(
      'messages.0.content.0.pdf.source.base64.data: The PDF specified was not valid.',
    )).toBe(true);
  });

  it('matches on the field-path fragment alone', () => {
    expect(isAnthropicInvalidPdfError('invalid_request_error: pdf.source.base64.data is malformed')).toBe(true);
  });

  it('does not match unrelated error text', () => {
    expect(isAnthropicInvalidPdfError('anthropic 429 rate limited')).toBe(false);
    expect(isAnthropicInvalidPdfError('anthropic 500 internal server error')).toBe(false);
  });
});
