import { afterEach, describe, it, expect, vi } from 'vitest';
import type { Env, QueueMessage } from '../../shared/types.ts';
import { withThirdPartyTelemetry } from '../../shared/thirdPartyTelemetry.ts';
import {
  batchPrompt,
  decodeAnthropicLine,
  decodeOpenAiLine,
  decodeMistralLine,
  decodeXaiResult,
  parseJsonl,
  isBatchProvider,
  normalizeBatchChamber,
  BatchTerminalPayloadError,
  parseOpenAiBatchUsage,
  parseOpenAiBatchTimestamps,
  pollBatch,
  submitBatch,
  type BatchDoc,
} from '../batchExtract.ts';
import { EXECUTIVE_SYSTEM_PROMPT, SYSTEM_PROMPT, arrayBufferToBase64 } from '../visionLlm.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('parseJsonl', () => {
  it('parses non-blank JSON lines and skips garbage', () => {
    const out = parseJsonl('{"a":1}\n\n  \nnot json\n{"b":2}');
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('isBatchProvider', () => {
  it('accepts the four supported providers only', () => {
    for (const p of ['anthropic', 'openai', 'mistral', 'xai']) expect(isBatchProvider(p)).toBe(true);
    for (const p of ['gemini', 'cohere', '', null, 42]) expect(isBatchProvider(p)).toBe(false);
  });
});

describe('batch lease cancellation', () => {
  it('propagates the lease signal to submit and poll provider requests', async () => {
    const controller = new AbortController();
    const resultsUrl = 'https://api.anthropic.com/v1/messages/batches/batch-signal/results';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      const url = String(input);
      if (url.endsWith('/v1/messages/batches')) return Response.json({ id: 'batch-signal' });
      if (url.endsWith('/v1/messages/batches/batch-signal')) {
        return Response.json({ processing_status: 'ended', results_url: resultsUrl });
      }
      if (url === resultsUrl) return new Response('');
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = { ANTHROPIC_API_KEY: 'test-key' } as unknown as Env;
    const bytes = new TextEncoder().encode('%PDF-1.4 fake').buffer as ArrayBuffer;

    await expect(submitBatch(env, 'anthropic', 'claude-sonnet-5', [
      { docId: 'H-signal', chamber: 'house', bytes },
    ], controller.signal)).resolves.toBe('batch-signal');
    await expect(pollBatch(env, 'anthropic', 'batch-signal', controller.signal))
      .resolves.toMatchObject({ done: true, status: 'ended' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('starts no provider request after the lease signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('lease lost'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const env = { ANTHROPIC_API_KEY: 'test-key' } as unknown as Env;

    await expect(pollBatch(env, 'anthropic', 'batch-aborted', controller.signal))
      .rejects.toThrow('lease lost');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('batch chamber prompts', () => {
  it('uses the Executive OGE prompt for Executive filings and congressional prompt otherwise', () => {
    expect(normalizeBatchChamber('executive', 'unknown')).toBe('executive');
    expect(normalizeBatchChamber(null, 'E-278T-1')).toBe('executive');
    expect(normalizeBatchChamber(null, 'S-1')).toBe('senate');
    expect(normalizeBatchChamber(null, 'H-1')).toBe('house');
    expect(batchPrompt('executive', 'object')).toContain(EXECUTIVE_SYSTEM_PROMPT);
    expect(batchPrompt('executive', 'object')).not.toContain(SYSTEM_PROMPT);
    expect(batchPrompt('house', 'array')).toContain(SYSTEM_PROMPT);
    expect(batchPrompt('senate', 'array')).toContain(SYSTEM_PROMPT);
  });

  it('embeds the Executive prompt in a submitted Executive batch request', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ id: 'batch-executive' }));
    vi.stubGlobal('fetch', fetchMock);
    const bytes = new TextEncoder().encode('%PDF-1.4 fake').buffer as ArrayBuffer;

    await expect(submitBatch(
      { ANTHROPIC_API_KEY: 'test-key' } as unknown as Env,
      'anthropic',
      'claude-sonnet-5',
      [{ docId: 'E-278T-1', chamber: 'executive', bytes }],
    )).resolves.toBe('batch-executive');

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.requests[0].params.messages[0].content[1].text)
      .toContain(EXECUTIVE_SYSTEM_PROMPT);
  });
});

describe('decodeXaiResult', () => {
  it('decodes a chat_get_completion result into rows', () => {
    const item = {
      batch_request_id: 'H-7',
      batch_result: { response: { chat_get_completion: {
        choices: [{ message: { content: '{"transactions":[{"ticker":"NVDA","assetName":"Nvidia","txType": "B","amountRange":"$1,001 - $15,000"}]}' } }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 20 },
          cost_in_usd_ticks: 321_000_000,
          num_server_side_tools_used: 2,
        },
      } } },
    };
    const r = decodeXaiResult(item);
    expect(r).toMatchObject({ docId: 'H-7', ok: true });
    expect(r.rows[0].ticker).toBe('NVDA');
    expect(r.usage).toEqual({
      promptTokens: 120,
      completionTokens: 30,
      cachedTokens: 20,
      costInUsdTicks: 321_000_000,
      attachmentSearchCalls: 2,
    });
  });

  it('decodes a responses-shaped result via output_text', () => {
    const item = {
      batch_request_id: 'H-8',
      batch_result: { response: { responses: {
        output_text: '[{"ticker":"AMD","assetName":"AMD","txType":"S","amountRange":"$1,001 - $15,000"}]',
        usage: { input_tokens: 200, output_tokens: 40, input_tokens_details: { cached_tokens: 50 } },
      } } },
    };
    const r = decodeXaiResult(item);
    expect(r.rows[0].ticker).toBe('AMD');
    expect(r.usage).toEqual({ promptTokens: 200, completionTokens: 40, cachedTokens: 50 });
  });
});

describe('decodeAnthropicLine', () => {
  it('decodes a succeeded message into rows', () => {
    const line = {
      custom_id: 'H-1',
      result: {
        type: 'succeeded',
        message: {
          content: [{ type: 'text', text: '[{"ticker":"AAPL","assetName":"Apple","txType": "B","amountRange":"$1,001 - $15,000"}]' }],
          usage: { input_tokens: 300, output_tokens: 60, cache_read_input_tokens: 100 },
        },
      },
    };
    const r = decodeAnthropicLine(line);
    expect(r).toMatchObject({ docId: 'H-1', ok: true });
    expect(r.rows[0]).toMatchObject({ ticker: 'AAPL', txType: 'B' });
    expect(r.usage).toEqual({ promptTokens: 300, completionTokens: 60, cachedTokens: 100 });
  });

  it('marks an errored line as not ok', () => {
    const r = decodeAnthropicLine({ custom_id: 'H-2', result: { type: 'errored', error: { type: 'overloaded' } } });
    expect(r).toMatchObject({ docId: 'H-2', ok: false });
    expect(r.rows).toHaveLength(0);
  });

  it('salvages complete leading rows (and marks them) when the batch result was truncated', () => {
    const line = {
      custom_id: 'H-truncated',
      result: {
        type: 'succeeded',
        message: {
          stop_reason: 'max_tokens',
          content: [{
            type: 'text',
            // Cut off mid-second-row: no retry is possible for an already-submitted batch.
            text: '[{"ticker":"AAPL","assetName":"Apple Inc.","txType": "B","amountRange":"$1,001 - $15,000"},{"ticker":"MSFT","assetName":"Micro',
          }],
          usage: { input_tokens: 300, output_tokens: 8000 },
        },
      },
    };
    const r = decodeAnthropicLine(line);
    expect(r).toMatchObject({ docId: 'H-truncated', ok: true });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ ticker: 'AAPL' });
    expect(r.rows[0].extractionWarnings).toContain('salvaged_truncated_output');
  });

  it('still fails when stop_reason is max_tokens but nothing can be salvaged', () => {
    const line = {
      custom_id: 'H-empty-truncated',
      result: {
        type: 'succeeded',
        message: {
          stop_reason: 'max_tokens',
          content: [{ type: 'text', text: '[{"ticker":"AAPL","assetName":"Apple Inc.' }],
          usage: { input_tokens: 300, output_tokens: 8000 },
        },
      },
    };
    const r = decodeAnthropicLine(line);
    expect(r).toMatchObject({ docId: 'H-empty-truncated', ok: false });
    expect(r.rows).toHaveLength(0);
  });

  it('does not attempt salvage (and fails normally) for truncated JSON without stop_reason max_tokens', () => {
    const line = {
      custom_id: 'H-not-truncated-reason',
      result: {
        type: 'succeeded',
        message: {
          stop_reason: 'end_turn',
          content: [{
            type: 'text',
            text: '[{"ticker":"AAPL","assetName":"Apple Inc.","txType": "B","amountRange":"$1,001 - $15,000"},{"ticker":"MSFT","assetName":"Micro',
          }],
          usage: { input_tokens: 300, output_tokens: 60 },
        },
      },
    };
    const r = decodeAnthropicLine(line);
    expect(r).toMatchObject({ docId: 'H-not-truncated-reason', ok: false });
    expect(r.rows).toHaveLength(0);
  });
});

describe('pollBatch Anthropic lifecycle timestamps', () => {
  it('propagates provider RFC3339 times even when the terminal batch is polled late', async () => {
    const env = {
      ANTHROPIC_API_KEY: 'test-key',
      USAGE_MONITOR_ENVIRONMENT: 'test',
      INGEST_QUEUE: { send: vi.fn(async () => undefined) },
    } as unknown as Env;
    const resultsUrl = 'https://api.anthropic.com/v1/messages/batches/batch-late/results';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/messages/batches/batch-late')) {
        return Response.json({
          processing_status: 'ended',
          results_url: resultsUrl,
          created_at: '2026-06-01T10:00:00+00:00',
          ended_at: '2026-06-02T10:00:00Z',
        });
      }
      if (url === resultsUrl) return new Response('');
      throw new Error(`unexpected fetch: ${url}`);
    }));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));

    await expect(withThirdPartyTelemetry(
      env,
      () => pollBatch(env, 'anthropic', 'batch-late'),
    )).resolves.toMatchObject({
      done: true,
      status: 'ended',
      submittedAt: '2026-06-01T10:00:00.000Z',
      terminalAt: '2026-06-02T10:00:00.000Z',
    });
  });

  it('fails soft on invalid RFC3339 values and never trusts a nonterminal ended_at', async () => {
    const env = { ANTHROPIC_API_KEY: 'test-key' } as unknown as Env;
    const resultsUrl = 'https://api.anthropic.com/v1/messages/batches/batch-invalid/results';
    let statusPoll = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === resultsUrl) return new Response('');
      statusPoll++;
      return Response.json(statusPoll === 1 ? {
        processing_status: 'in_progress',
        created_at: '2026-06-01T10:00:00Z',
        ended_at: '2026-06-02T10:00:00Z',
      } : {
        processing_status: 'ended',
        results_url: resultsUrl,
        created_at: '2026-02-30T10:00:00Z',
        ended_at: 'not-a-date',
      });
    }));

    const nonterminal = await pollBatch(env, 'anthropic', 'batch-running');
    expect(nonterminal.submittedAt).toBe('2026-06-01T10:00:00.000Z');
    expect(nonterminal).not.toHaveProperty('terminalAt');
    const invalid = await pollBatch(env, 'anthropic', 'batch-invalid');
    expect(invalid).not.toHaveProperty('submittedAt');
    expect(invalid).not.toHaveProperty('terminalAt');
  });
});

// Per-item PDF pre-validation for the Anthropic BATCH path (mirrors #461's
// sync-path validatePdfForAnthropic gate — bakeoff.ts runAnthropic,
// anthropicVision.ts — but excludes-and-records instead of retrying, since a
// batch request is one HTTP call for N docs).
describe('submitBatch/pollBatch Anthropic: per-item PDF pre-validation', () => {
  const INVALID_PDF_ERROR = 'anthropic: invalid PDF (unparseable by pdf-lib)';
  const validBytes = () => new TextEncoder().encode('%PDF-1.4 fake').buffer as ArrayBuffer;
  const invalidBytes = () => new TextEncoder().encode('this is not a pdf').buffer as ArrayBuffer;

  it('excludes an invalid-PDF doc from the provider request, records it ok:false with the stable sync-path error, and still submits + decodes the valid docs', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ id: 'batch-mixed-validation' }));
    vi.stubGlobal('fetch', fetchMock);

    const docs: BatchDoc[] = [
      { docId: 'H-valid-1', chamber: 'house', bytes: validBytes() },
      { docId: 'H-invalid', chamber: 'house', bytes: invalidBytes() },
      { docId: 'H-valid-2', chamber: 'house', bytes: validBytes() },
    ];

    const providerBatchId = await submitBatch(
      { ANTHROPIC_API_KEY: 'test-key' } as unknown as Env,
      'anthropic',
      'claude-sonnet-5',
      docs,
    );

    // Exactly one provider call (create-batch), and only the two valid docs
    // are in it — the invalid doc never reaches Anthropic.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.requests).toHaveLength(2);
    expect(request.requests.map((r: { custom_id: string }) => r.custom_id))
      .toEqual(['H-valid-1', 'H-valid-2']);
    // ORIGINAL bytes sent, not a pdf-lib resave (mirrors #461's sync-path decision).
    expect(request.requests[0].params.messages[0].content[0].source.data)
      .toBe(arrayBufferToBase64(docs[0].bytes));

    // The provider only ever saw the two valid docs, so its results only
    // cover those two custom_ids.
    const resultsUrl = 'https://api.anthropic.com/v1/messages/batches/batch-mixed-validation/results';
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/messages/batches/batch-mixed-validation')) {
        return Response.json({ processing_status: 'ended', results_url: resultsUrl });
      }
      if (url === resultsUrl) {
        const lines = [
          { custom_id: 'H-valid-1', result: { type: 'succeeded', message: {
            content: [{ type: 'text', text: '[{"ticker":"AAPL","assetName":"Apple","txType": "B","amountRange":"$1,001 - $15,000"}]' }],
          } } },
          { custom_id: 'H-valid-2', result: { type: 'succeeded', message: {
            content: [{ type: 'text', text: '[]' }],
          } } },
        ];
        return new Response(lines.map((l) => JSON.stringify(l)).join('\n'));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const poll = await pollBatch(
      { ANTHROPIC_API_KEY: 'test-key' } as unknown as Env,
      'anthropic',
      providerBatchId,
    );

    expect(poll.done).toBe(true);
    expect(poll.results).toHaveLength(3);
    const byDocId = Object.fromEntries(poll.results.map((r) => [r.docId, r]));
    expect(byDocId['H-valid-1']).toMatchObject({ ok: true });
    expect(byDocId['H-valid-2']).toMatchObject({ ok: true });
    // The excluded doc's recorded failure is bit-for-bit the same shape
    // decodeAnthropicLine would produce for a real per-item provider error —
    // so providerFailure.ts classification and review-queue routing treat it
    // identically — with the exact stable error string.
    expect(byDocId['H-invalid']).toEqual({ docId: 'H-invalid', ok: false, error: INVALID_PDF_ERROR, rows: [] });
  });

  it('makes zero provider calls and records every doc as failed when an entire batch fails pre-validation', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const docs: BatchDoc[] = [
      { docId: 'H-bad-1', chamber: 'house', bytes: invalidBytes() },
      { docId: 'H-bad-2', chamber: 'house', bytes: invalidBytes() },
    ];

    const providerBatchId = await submitBatch(
      { ANTHROPIC_API_KEY: 'test-key' } as unknown as Env,
      'anthropic',
      'claude-sonnet-5',
      docs,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    const poll = await pollBatch(
      { ANTHROPIC_API_KEY: 'test-key' } as unknown as Env,
      'anthropic',
      providerBatchId,
    );
    // pollAnthropic must also make zero provider calls for an all-synthetic id.
    expect(fetchMock).not.toHaveBeenCalled();

    expect(poll).toEqual({
      done: true,
      failed: false,
      status: 'ended',
      results: [
        { docId: 'H-bad-1', ok: false, error: INVALID_PDF_ERROR, rows: [] },
        { docId: 'H-bad-2', ok: false, error: INVALID_PDF_ERROR, rows: [] },
      ],
    });
  });

  it('keeps batch_jobs.doc_ids accounting consistent: every submitted docId resolves to exactly one terminal result, whether some or all docs fail pre-validation', async () => {
    const checkAccounting = async (docs: BatchDoc[]) => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'https://api.anthropic.com/v1/messages/batches') {
          return Response.json({ id: 'batch-accounting' });
        }
        if (url.endsWith('/v1/messages/batches/batch-accounting')) {
          const resultsUrl = 'https://api.anthropic.com/v1/messages/batches/batch-accounting/results';
          return Response.json({ processing_status: 'ended', results_url: resultsUrl });
        }
        if (url === 'https://api.anthropic.com/v1/messages/batches/batch-accounting/results') {
          const lines = docs
            .filter((d) => d.docId.startsWith('valid'))
            .map((d) => JSON.stringify({ custom_id: d.docId, result: { type: 'succeeded', message: {
              content: [{ type: 'text', text: '[]' }],
            } } }));
          return new Response(lines.join('\n'));
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const env = { ANTHROPIC_API_KEY: 'test-key' } as unknown as Env;
      // Mirrors what callers (admin/routes.ts POST /batch-submit,
      // batchCron.ts generateBatchJobs) persist as batch_jobs.doc_ids: every
      // docId handed to submitBatch, computed from the input list BEFORE any
      // internal pre-validation exclusion.
      const expectedDocIds = docs.map((d) => d.docId);
      const providerBatchId = await submitBatch(env, 'anthropic', 'claude-sonnet-5', docs);
      const poll = await pollBatch(env, 'anthropic', providerBatchId);

      expect(poll.done).toBe(true);
      const resultDocIds = poll.results.map((r) => r.docId);
      expect(new Set(resultDocIds).size).toBe(resultDocIds.length); // no duplicate results
      expect(new Set(resultDocIds)).toEqual(new Set(expectedDocIds)); // no missing / no extra docIds
      vi.unstubAllGlobals();
    };

    // Mixed: some docs excluded, some sent to the provider.
    await checkAccounting([
      { docId: 'valid-1', chamber: 'house', bytes: validBytes() },
      { docId: 'invalid-1', chamber: 'house', bytes: invalidBytes() },
      { docId: 'valid-2', chamber: 'house', bytes: validBytes() },
    ]);
    // All-invalid: zero docs ever reach the provider.
    await checkAccounting([
      { docId: 'invalid-1', chamber: 'house', bytes: invalidBytes() },
      { docId: 'invalid-2', chamber: 'house', bytes: invalidBytes() },
    ]);
  });

  it('leaves a plain (non-composite) real provider batch id untouched when no doc is excluded', async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 'msgbatch_plain_id' }));
    vi.stubGlobal('fetch', fetchMock);

    const docs: BatchDoc[] = [{ docId: 'H-only-valid', chamber: 'house', bytes: validBytes() }];
    await expect(submitBatch(
      { ANTHROPIC_API_KEY: 'test-key' } as unknown as Env,
      'anthropic',
      'claude-sonnet-5',
      docs,
    )).resolves.toBe('msgbatch_plain_id');
  });
});

describe('decodeOpenAiLine', () => {
  it('decodes a chat-completions batch output line into rows', () => {
    const line = {
      custom_id: 'H-3',
      response: { status_code: 200, body: {
        choices: [{ message: { content: '{"transactions":[{"ticker":"MSFT","assetName":"Microsoft","txType":"S","amountRange":"$1,001 - $15,000"}]}' } }],
        usage: { prompt_tokens: 400, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 110 } },
      } },
    };
    const r = decodeOpenAiLine(line);
    expect(r).toMatchObject({ docId: 'H-3', ok: true });
    expect(r.rows[0]).toMatchObject({ ticker: 'MSFT', txType: 'S' });
    expect(r.usage).toEqual({ promptTokens: 400, completionTokens: 80, cachedTokens: 110 });
  });

  it('decodes a Responses batch output line into rows and usage', () => {
    const line = {
      custom_id: 'H-responses',
      response: { status_code: 200, body: {
        model: 'gpt-5.6-terra',
        output_text: '{"transactions":[{"ticker":"MSFT","assetName":"Microsoft","txType":"S","amountRange":"$1,001 - $15,000"}]}',
        usage: { input_tokens: 500, output_tokens: 90, input_tokens_details: { cached_tokens: 120 } },
      } },
    };
    const r = decodeOpenAiLine(line);
    expect(r).toMatchObject({
      docId: 'H-responses',
      ok: true,
      resolvedModel: 'gpt-5.6-terra',
      usage: { promptTokens: 500, completionTokens: 90, cachedTokens: 120 },
    });
    expect(r.rows[0]).toMatchObject({ ticker: 'MSFT', txType: 'S' });
  });

  it('salvages complete leading rows (and marks them) when Responses output is truncated', () => {
    const r = decodeOpenAiLine({
      custom_id: 'H-incomplete',
      response: { status_code: 200, body: {
        model: 'gpt-5.6-terra',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [{ content: [{ text: '[{"ticker":"AAPL","assetName":"Apple Inc.","txType": "B","amountRange":"$1,001 - $15,000"},{"ticker":"MSFT","assetName":"Micro' }] }],
        usage: { input_tokens: 500, output_tokens: 8_000 },
      } },
    });
    expect(r).toMatchObject({
      docId: 'H-incomplete',
      ok: true,
      usage: { promptTokens: 500, completionTokens: 8_000 },
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].ticker).toBe('AAPL');
    expect(r.rows[0].extractionWarnings).toContain('salvaged_truncated_output');
  });

  it('rejects a Responses refusal while retaining usage', () => {
    const r = decodeOpenAiLine({
      custom_id: 'H-refusal',
      response: { status_code: 200, body: {
        model: 'gpt-5.6-sol',
        status: 'completed',
        output: [{ content: [{ refusal: 'Unable to process this document.' }] }],
        usage: { input_tokens: 700, output_tokens: 12 },
      } },
    });
    expect(r).toMatchObject({
      docId: 'H-refusal',
      ok: false,
      error: 'refusal: Unable to process this document.',
      usage: { promptTokens: 700, completionTokens: 12 },
    });
  });

  it('marks a line with an error object as not ok', () => {
    const r = decodeOpenAiLine({ custom_id: 'H-4', error: { message: 'bad request' } });
    expect(r.ok).toBe(false);
    expect(r.usage).toBeUndefined();
  });

  it('retains billed usage when the model output cannot be parsed', () => {
    const r = decodeOpenAiLine({
      custom_id: 'H-parse',
      response: {
        status_code: 200,
        body: {
          choices: [{ message: { content: 'not json' } }],
          usage: { prompt_tokens: 41, completion_tokens: 7 },
        },
      },
    });
    expect(r).toMatchObject({ ok: false, usage: { promptTokens: 41, completionTokens: 7 } });
  });

  it('decodes bounded HTTP and response-body errors while retaining billed usage', () => {
    const r = decodeOpenAiLine({
      custom_id: 'H-http-error',
      response: {
        status_code: 429,
        body: {
          error: {
            code: 'rate_limit_exceeded',
            message: 'x'.repeat(1_000),
          },
          usage: { prompt_tokens: 9, completion_tokens: 0 },
        },
      },
    });
    expect(r).toMatchObject({
      docId: 'H-http-error',
      ok: false,
      usage: { promptTokens: 9, completionTokens: 0 },
    });
    expect(r.error).toContain('HTTP 429');
    expect(r.error).toContain('rate_limit_exceeded');
    expect(r.error?.length).toBeLessThanOrEqual(300);
  });
});

describe('submitBatch OpenAI GPT-5.6', () => {
  it('blocks low-level GPT-4o batch submission before calling a provider', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const bytes = new TextEncoder().encode('%PDF-1.4 fake').buffer as ArrayBuffer;
    await expect(submitBatch(
      { OPENAI_API_KEY: 'must-not-use' } as unknown as Env,
      'openai',
      'gpt-4o-2024-11-20',
      [{ docId: 'H-retired', chamber: 'house', bytes }],
    )).rejects.toThrow('GPT-4o is retired');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('submits uploaded PDFs through Responses with Terra production settings', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      id: fetchMock.mock.calls.length === 3 ? 'batch-terra' : `file-${fetchMock.mock.calls.length}`,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const bytes = new TextEncoder().encode('%PDF-1.4 fake').buffer as ArrayBuffer;

    await expect(submitBatch(
      { OPENAI_API_KEY: 'test-key' } as unknown as Env,
      'openai',
      'gpt-5.6-terra',
      [{ docId: 'H-terra', chamber: 'house', bytes }],
    )).resolves.toBe('batch-terra');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const jsonlForm = fetchMock.mock.calls[1]?.[1]?.body as FormData;
    const jsonlFile = jsonlForm.get('file') as Blob;
    const request = JSON.parse(await jsonlFile.text());
    expect(request).toMatchObject({
      custom_id: 'H-terra',
      url: '/v1/responses',
      body: {
        model: 'gpt-5.6-terra',
        reasoning: { effort: 'medium' },
        store: false,
        text: { format: { type: 'json_schema', strict: true } },
      },
    });
    expect(request.body.input[0].content[0]).toEqual({
      type: 'input_file',
      file_id: 'file-1',
      detail: 'high',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      endpoint: '/v1/responses',
    });
  });
});

describe('OpenAI batch lifecycle timestamps', () => {
  it('uses the status-specific terminal field and parses documented Unix seconds', () => {
    const createdAt = Date.parse('2026-07-01T10:00:00.000Z') / 1_000;
    const completedAt = Date.parse('2026-07-01T11:00:00.000Z') / 1_000;
    const failedAt = Date.parse('2026-07-01T12:00:00.000Z') / 1_000;

    expect(parseOpenAiBatchTimestamps({
      status: 'completed',
      created_at: createdAt,
      completed_at: completedAt,
      failed_at: failedAt,
    })).toEqual({
      submittedAt: '2026-07-01T10:00:00.000Z',
      terminalAt: '2026-07-01T11:00:00.000Z',
    });
  });

  it('falls back only to another valid terminal field and ignores nonterminal stale fields', () => {
    const expiredAt = Date.parse('2026-07-02T11:00:00.000Z') / 1_000;
    expect(parseOpenAiBatchTimestamps({
      status: 'failed',
      created_at: 'not-a-number',
      failed_at: -1,
      expired_at: expiredAt,
    })).toEqual({ terminalAt: '2026-07-02T11:00:00.000Z' });
    expect(parseOpenAiBatchTimestamps({
      status: 'in_progress',
      completed_at: expiredAt,
    })).toEqual({});
    expect(parseOpenAiBatchTimestamps(null)).toEqual({});
    expect(parseOpenAiBatchTimestamps([])).toEqual({});
  });
});

describe('OpenAI batch aggregate usage', () => {
  it('accepts complete non-negative integer token totals and optional cached tokens', () => {
    expect(parseOpenAiBatchUsage({
      input_tokens: 300,
      output_tokens: 40,
      input_tokens_details: { cached_tokens: 120 },
    })).toEqual({ promptTokens: 300, completionTokens: 40, cachedTokens: 120 });
    expect(parseOpenAiBatchUsage({ input_tokens: 0, output_tokens: 0 })).toEqual({
      promptTokens: 0,
      completionTokens: 0,
    });
  });

  it.each([
    null,
    { input_tokens: 10 },
    { input_tokens: 10, output_tokens: -1 },
    { input_tokens: 10.5, output_tokens: 1 },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
    { input_tokens: 10, output_tokens: 1, input_tokens_details: 'invalid' },
    { input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 11 } },
  ])('fails soft for an incomplete or invalid aggregate: %j', (value) => {
    expect(parseOpenAiBatchUsage(value)).toBeUndefined();
  });
});

describe('pollBatch OpenAI terminal results', () => {
  it('closes a completed error-file-only batch and decodes failed documents', async () => {
    const env = { OPENAI_API_KEY: 'test-key' } as unknown as Env;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-errors-only')) {
        return Response.json({ status: 'completed', error_file_id: 'file-errors' });
      }
      if (url.endsWith('/v1/files/file-errors/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-error',
          error: { message: 'request rejected' },
        })}\n`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    await expect(pollBatch(env, 'openai', 'batch-errors-only')).resolves.toMatchObject({
      done: true,
      failed: false,
      status: 'completed',
      results: [{ docId: 'H-error', ok: false, rows: [] }],
    });
  });

  it('closes a completed batch with neither result file', async () => {
    const env = { OPENAI_API_KEY: 'test-key' } as unknown as Env;
    const fetchMock = vi.fn(async () => Response.json({ status: 'completed' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(pollBatch(env, 'openai', 'batch-empty')).resolves.toEqual({
      done: true,
      failed: false,
      status: 'completed',
      results: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('merges output and error files in stable output-first order', async () => {
    const env = { OPENAI_API_KEY: 'test-key' } as unknown as Env;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-mixed')) {
        return Response.json({
          status: 'completed',
          output_file_id: 'file-output',
          error_file_id: 'file-errors',
        });
      }
      if (url.endsWith('/v1/files/file-output/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-output',
          response: {
            status_code: 200,
            body: { choices: [{ message: { content: '{"transactions":[]}' } }] },
          },
        })}\n`);
      }
      if (url.endsWith('/v1/files/file-errors/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-error',
          error: { message: 'request rejected' },
        })}\n`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const poll = await pollBatch(env, 'openai', 'batch-mixed');
    expect(poll).toMatchObject({ done: true, failed: false, status: 'completed' });
    expect(poll.results.map((result) => [result.docId, result.ok])).toEqual([
      ['H-output', true],
      ['H-error', false],
    ]);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://api.openai.com/v1/batches/batch-mixed',
      'https://api.openai.com/v1/files/file-output/content',
      'https://api.openai.com/v1/files/file-errors/content',
    ]);
  });

  it('fetches an identical nonempty output/error file id only once', async () => {
    const env = { OPENAI_API_KEY: 'test-key' } as unknown as Env;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-same-file')) {
        return Response.json({
          status: 'completed',
          output_file_id: 'file-shared',
          error_file_id: 'file-shared',
        });
      }
      if (url.endsWith('/v1/files/file-shared/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-once',
          error: { message: 'request rejected' },
        })}\n`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const poll = await pollBatch(env, 'openai', 'batch-same-file');
    expect(poll.results).toHaveLength(1);
    expect(poll.results[0]).toMatchObject({ docId: 'H-once', ok: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects any malformed nonblank result JSONL line instead of dropping it', async () => {
    const env = { OPENAI_API_KEY: 'test-key' } as unknown as Env;
    const submittedAt = '2026-07-13T12:00:00.000Z';
    const terminalAt = '2026-07-13T12:01:00.000Z';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-malformed')) {
        return Response.json({
          status: 'completed',
          output_file_id: 'file-malformed',
          created_at: Date.parse(submittedAt) / 1_000,
          completed_at: Date.parse(terminalAt) / 1_000,
          usage: { input_tokens: 12, output_tokens: 3 },
          errors: {
            data: [
              { code: 'batch_expired', message: 'must not enter terminal context' },
              { code: 'unsafe / code', message: 'must not enter terminal context either' },
            ],
          },
        });
      }
      if (url.endsWith('/v1/files/file-malformed/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-valid',
          error: { message: 'request rejected' },
        })}\nnot-json\n`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    const poll = pollBatch(env, 'openai', 'batch-malformed');
    await expect(poll).rejects.toBeInstanceOf(BatchTerminalPayloadError);
    await expect(poll).rejects.toMatchObject({
      code: 'malformed_result_jsonl',
      providerStatus: 'completed',
      context: {
        aggregateUsage: { promptTokens: 12, completionTokens: 3 },
        providerErrors: {
          count: 2,
          summaries: ['batch_expired', 'provider_error'],
        },
        returnedDocs: 1,
        observedDocIds: ['H-valid'],
        submittedAt,
        terminalAt,
      },
    });
  });

  it('preserves prior-file and pre-malformed identities when the later result file is invalid', async () => {
    const env = { OPENAI_API_KEY: 'test-key' } as unknown as Env;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-late-malformed')) {
        return Response.json({
          status: 'failed',
          output_file_id: 'file-valid-output',
          error_file_id: 'file-partial-error',
          errors: {
            data: [{ code: 'batch_failed', message: 'arbitrary provider detail' }],
          },
        });
      }
      if (url.endsWith('/v1/files/file-valid-output/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-output',
          response: {
            status_code: 200,
            body: { choices: [{ message: { content: '{"transactions":[]}' } }] },
          },
        })}\n`);
      }
      if (url.endsWith('/v1/files/file-partial-error/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-error',
          error: { message: 'request rejected' },
        })}\nnot-json\n`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    const poll = pollBatch(env, 'openai', 'batch-late-malformed');
    await expect(poll).rejects.toMatchObject({
      code: 'malformed_result_jsonl',
      providerStatus: 'failed',
      context: {
        providerErrors: { count: 1, summaries: ['batch_failed'] },
        returnedDocs: 2,
        observedDocIds: ['H-output', 'H-error'],
      },
    });
    await expect(poll).rejects.not.toMatchObject({
      context: { providerErrors: { summaries: ['arbitrary provider detail'] } },
    });
  });

  it('bounds observed identity context while retaining the exact decoded result count', async () => {
    const env = { OPENAI_API_KEY: 'test-key' } as unknown as Env;
    const decodedLines = Array.from({ length: 201 }, (_, index) => JSON.stringify({
      custom_id: `H-${index + 1}`,
      error: { code: 'request_failed' },
    })).join('\n');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-context-bound')) {
        return Response.json({ status: 'completed', output_file_id: 'file-context-bound' });
      }
      if (url.endsWith('/v1/files/file-context-bound/content')) {
        return new Response(`${decodedLines}\nnot-json\n`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    const poll = pollBatch(env, 'openai', 'batch-context-bound');
    await expect(poll).rejects.toMatchObject({
      context: {
        returnedDocs: 201,
        observedDocIdsTruncated: true,
      },
    });
    try {
      await poll;
      throw new Error('expected malformed terminal payload');
    } catch (error) {
      expect(error).toBeInstanceOf(BatchTerminalPayloadError);
      const typed = error as BatchTerminalPayloadError;
      expect(typed.context.observedDocIds).toHaveLength(200);
      expect(typed.context.observedDocIds?.[0]).toBe('H-1');
      expect(typed.context.observedDocIds?.[199]).toBe('H-200');
    }
  });

  it('counts Batch-object inline errors and retains only safe bounded codes', async () => {
    const env = { OPENAI_API_KEY: 'test-key' } as unknown as Env;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-inline-errors')) {
        return Response.json({
          status: 'failed',
          errors: {
            data: [
              { code: 'batch_expired', message: 'sensitive arbitrary message' },
              { code: 'not safe / code', message: 'another message' },
            ],
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    await expect(pollBatch(env, 'openai', 'batch-inline-errors')).resolves.toMatchObject({
      done: true,
      failed: true,
      status: 'failed',
      providerErrors: {
        count: 2,
        summaries: ['batch_expired', 'provider_error'],
      },
    });
  });

  it('returns completed requests from a failed batch output file for persistence and metering', async () => {
    const messages: QueueMessage[] = [];
    const env = {
      OPENAI_API_KEY: 'test-key',
      USAGE_MONITOR_ENVIRONMENT: 'test',
      INGEST_QUEUE: {
        send: vi.fn(async (message: QueueMessage) => {
          messages.push(message);
        }),
      },
    } as unknown as Env;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-partial')) {
        return Response.json({
          status: 'expired',
          output_file_id: 'file-output',
          created_at: Date.parse('2026-06-01T10:00:00.000Z') / 1_000,
          expired_at: Date.parse('2026-06-02T10:00:00.000Z') / 1_000,
        });
      }
      if (url.endsWith('/v1/files/file-output/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-partial',
          response: {
            status_code: 200,
            body: {
              model: 'gpt-4o-2024-11-20',
              choices: [{
                message: {
                  content: '{"transactions":[{"ticker":"MSFT","assetName":"Microsoft","txType": "B","amountRange":"$1,001 - $15,000"}]}',
                },
              }],
              usage: {
                prompt_tokens: 41,
                completion_tokens: 7,
                prompt_tokens_details: { cached_tokens: 5 },
              },
            },
          },
        })}\n`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));

    const result = await withThirdPartyTelemetry(
      env,
      () => pollBatch(env, 'openai', 'batch-partial'),
    );

    expect(result).toMatchObject({
      done: true,
      failed: true,
      status: 'expired',
      submittedAt: '2026-06-01T10:00:00.000Z',
      terminalAt: '2026-06-02T10:00:00.000Z',
      results: [{
        docId: 'H-partial',
        ok: true,
        resolvedModel: 'gpt-4o-2024-11-20',
        usage: { promptTokens: 41, completionTokens: 7, cachedTokens: 5 },
      }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(messages.filter((message) => message.type === 'usage.telemetry')).toHaveLength(2);
  });
});

describe('decodeMistralLine', () => {
  it('decodes an OCR document_annotation into rows', () => {
    const line = {
      custom_id: 'H-5',
      response: { body: {
        document_annotation: JSON.stringify({ transactions: [{ ticker: 'TSLA', assetName: 'Tesla', txType: 'B', amountRange: '$1,001 - $15,000' }] }),
        usage_info: { pages_processed: 6 },
      } },
    };
    const r = decodeMistralLine(line);
    expect(r).toMatchObject({ docId: 'H-5', ok: true });
    expect(r.rows[0].ticker).toBe('TSLA');
    expect(r.usage).toEqual({ pagesProcessed: 6 });
  });

  it('also accepts the annotation directly on the line body', () => {
    const r = decodeMistralLine({ custom_id: 'H-6', body: { document_annotation: { transactions: [{ assetName: 'X', ticker: 'XOM', txType: 'B', amountRange: '$1,001 - $15,000' }] } } });
    expect(r.rows[0].ticker).toBe('XOM');
  });

  it('retains completed OCR pages exposed by a failed job output file', async () => {
    const env = {
      MISTRAL_API_KEY: 'test-key',
      USAGE_MONITOR_ENVIRONMENT: 'test',
      INGEST_QUEUE: { send: vi.fn(async () => undefined) },
    } as unknown as Env;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batch/jobs/job-partial')) {
        return Response.json({ status: 'FAILED', output_file: 'output-partial' });
      }
      if (url.endsWith('/v1/files/output-partial/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-partial',
          response: { body: { document_annotation: { transactions: [] }, usage_info: { pages_processed: 4 } } },
        })}\n`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    await expect(withThirdPartyTelemetry(
      env,
      () => pollBatch(env, 'mistral', 'job-partial'),
    )).resolves.toMatchObject({
      done: true,
      failed: true,
      status: 'FAILED',
      results: [{ docId: 'H-partial', ok: true, usage: { pagesProcessed: 4 } }],
    });
  });

  it('propagates provider Unix-second times even when the terminal job is polled late', async () => {
    const env = {
      MISTRAL_API_KEY: 'test-key',
      USAGE_MONITOR_ENVIRONMENT: 'test',
      INGEST_QUEUE: { send: vi.fn(async () => undefined) },
    } as unknown as Env;
    const createdAt = Date.parse('2026-06-01T10:00:00.000Z') / 1_000;
    const completedAt = Date.parse('2026-06-02T10:00:00.000Z') / 1_000;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batch/jobs/job-late')) {
        return Response.json({
          status: 'SUCCESS',
          output_file: 'output-late',
          created_at: createdAt,
          completed_at: completedAt,
        });
      }
      if (url.endsWith('/v1/files/output-late/content')) return new Response('');
      throw new Error(`unexpected fetch: ${url}`);
    }));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));

    await expect(withThirdPartyTelemetry(
      env,
      () => pollBatch(env, 'mistral', 'job-late'),
    )).resolves.toMatchObject({
      done: true,
      status: 'SUCCESS',
      submittedAt: '2026-06-01T10:00:00.000Z',
      terminalAt: '2026-06-02T10:00:00.000Z',
    });
  });

  it('fails soft on invalid Unix seconds and never trusts nonterminal completed_at', async () => {
    const env = { MISTRAL_API_KEY: 'test-key' } as unknown as Env;
    const createdAt = Date.parse('2026-06-01T10:00:00.000Z') / 1_000;
    const completedAt = Date.parse('2026-06-02T10:00:00.000Z') / 1_000;
    let statusPoll = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/files/output-invalid/content')) return new Response('');
      statusPoll++;
      return Response.json(statusPoll === 1 ? {
        status: 'RUNNING',
        created_at: createdAt,
        completed_at: completedAt,
      } : {
        status: 'SUCCESS',
        output_file: 'output-invalid',
        created_at: 1.5,
        completed_at: 'not-an-integer',
      });
    }));

    const nonterminal = await pollBatch(env, 'mistral', 'job-running');
    expect(nonterminal.submittedAt).toBe('2026-06-01T10:00:00.000Z');
    expect(nonterminal).not.toHaveProperty('terminalAt');
    const invalid = await pollBatch(env, 'mistral', 'job-invalid');
    expect(invalid).not.toHaveProperty('submittedAt');
    expect(invalid).not.toHaveProperty('terminalAt');
  });
});
