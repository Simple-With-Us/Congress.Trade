import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env, Filing } from '../../shared/types.ts';

const unpdfMocks = vi.hoisted(() => ({
  getDocumentProxy: vi.fn().mockResolvedValue({ numPages: 5 }),
}));
vi.mock('unpdf', () => ({
  getDocumentProxy: unpdfMocks.getDocumentProxy,
}));

import {
  OpenRouterVisionExtractor,
  OPENROUTER_EXTRACTION_RESPONSE_FORMAT,
  annotationObjectKey,
  chooseParserEngine,
  gemini37FlashProviderPreference,
  isEngineOverrideRejection,
  parseMaxPrice,
  prefersPageImages,
  supportsNativeVision,
  supportsStructuredOutputs,
} from '../openRouterVision.ts';

const filing = (): Filing => ({
  docId: 'S-1',
  chamber: 'senate',
  filerId: 'F1',
  filingType: 'P',
  filedDate: '2026-06-19',
  sourceUrl: 'https://x',
  rawObjectKey: 'raw/senate/S-1.pdf',
  ingestStatus: 'classified',
  docKind: 'scanned_pdf',
  extractor: null,
  modelVersion: null,
  confidence: null,
  firstSeenAt: '2026-06-19T00:00:00.000Z',
  sourceUpdatedAt: null,
  error: null,
});

const env = { OPENROUTER_API_KEY: 'test-key' } as unknown as Env;

afterEach(() => vi.unstubAllGlobals());

describe('OpenRouterVisionExtractor', () => {
  it('correctly maps the openrouter JSON response', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'gen-123',
        model: 'google/gemini-3.5-flash',
        choices: [
          {
            message: {
              content: JSON.stringify({
                transactions: [
                  {
                    ticker: 'AAPL',
                    assetName: 'Apple Inc.',
                    txType: 'B',
                    amountRange: '$1,001 - $15,000',
                    txDate: '2026-05-01',
                    owner: 'Self',
                    assetType: 'Stock',
                  },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const ex = new OpenRouterVisionExtractor(env);
    const result = await ex.extract({
      filing: filing(),
      bytes: new TextEncoder().encode('dummy pdf bytes').buffer as ArrayBuffer,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    
    // Verify the output maps correctly
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].ticker).toBe('AAPL');
    expect(result.transactions[0].assetName).toBe('Apple Inc.');
    
    // Verify usage mapping
    expect(result.usage).toMatchObject({ promptTokens: 100, completionTokens: 50 });
    
    // Verify extractor name
    expect(result.extractor).toBe('openRouterVision');
  });

  it('skips a bare Unauthorized reply without a second Files call', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => '{"error":{"message":"Unauthorized","code":401}}',
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const ex = new OpenRouterVisionExtractor(env);
    await expect(ex.extract({
      filing: filing(),
      bytes: new TextEncoder().encode('dummy pdf bytes').buffer as ArrayBuffer,
    })).rejects.toThrow(/openRouterReply:unauth_reply/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws an error if no API key is provided', async () => {
    const emptyEnv = {} as Env;
    const ex = new OpenRouterVisionExtractor(emptyEnv);
    
    await expect(
      ex.extract({
        filing: filing(),
        bytes: new TextEncoder().encode('dummy pdf bytes').buffer as ArrayBuffer,
      }),
    ).rejects.toThrow('openRouterVision: API key is not configured');
  });

  it('captures the OpenRouter generation id as providerRequestId on the result', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'gen-123',
        model: 'google/gemini-3.5-flash',
        choices: [{ message: { content: JSON.stringify({ transactions: [] }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const ex = new OpenRouterVisionExtractor(env);
    const result = await ex.extract({
      filing: filing(),
      bytes: new TextEncoder().encode('dummy pdf bytes').buffer as ArrayBuffer,
    });

    expect(result.providerRequestId).toBe('gen-123');
  });

  it('omits providerRequestId entirely when the response carries no id', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model: 'google/gemini-3.5-flash',
        choices: [{ message: { content: JSON.stringify({ transactions: [] }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const ex = new OpenRouterVisionExtractor(env);
    const result = await ex.extract({
      filing: filing(),
      bytes: new TextEncoder().encode('dummy pdf bytes').buffer as ArrayBuffer,
    });

    expect(result.providerRequestId).toBeUndefined();
    expect('providerRequestId' in result && result.providerRequestId !== undefined).toBe(false);
  });

  it('maps a blank response id to undefined, never an empty string', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: '',
        model: 'google/gemini-3.5-flash',
        choices: [{ message: { content: JSON.stringify({ transactions: [] }) } }],
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const ex = new OpenRouterVisionExtractor(env);
    const result = await ex.extract({
      filing: filing(),
      bytes: new TextEncoder().encode('dummy pdf bytes').buffer as ArrayBuffer,
    });

    expect(result.providerRequestId).toBeUndefined();
  });

  it('attaches usage to error when parsing fails', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'gen-123',
        model: 'google/gemini-3.5-flash',
        choices: [
          {
            message: {
              content: 'definitely not valid JSON',
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const ex = new OpenRouterVisionExtractor(env);
    let caughtErr: Error & { usage?: any } | undefined;
    
    try {
      await ex.extract({
        filing: filing(),
        bytes: new TextEncoder().encode('dummy pdf bytes').buffer as ArrayBuffer,
      });
    } catch (err) {
      caughtErr = err as any;
    }
    
    expect(caughtErr).toBeDefined();
    expect(caughtErr?.message).toContain('openRouterReply:garbage');
    expect(caughtErr?.usage).toMatchObject({ promptTokens: 100, completionTokens: 50 });
    // The call was billed before the parse failure: the generation id must
    // survive onto the thrown error for bakeoff.ts's error-path telemetry.
    expect((caughtErr as Error & { providerRequestId?: string })?.providerRequestId).toBe('gen-123');
  });

  it('spreads classifier enrichment into the request body with keys flat under trace', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'gen-1',
        choices: [{ message: { content: JSON.stringify({ transactions: [] }) } }],
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const enrichedEnv = {
      OPENROUTER_API_KEY: 'test-key',
      USAGE_MONITOR_ENVIRONMENT: 'test',
      CF_VERSION_METADATA: { id: 'abc123def456', tag: 'v42' },
    } as unknown as Env;
    const ex = new OpenRouterVisionExtractor(enrichedEnv);
    await ex.extract({
      filing: filing(),
      bytes: new TextEncoder().encode('dummy pdf bytes').buffer as ArrayBuffer,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // Top-level user = deterministic per-doc id; session_id absent (no run id
    // in scope), never "".
    expect(body.user).toBe('S-1');
    expect('session_id' in body).toBe(false);
    // Classifier keys FLAT under trace — no metadata sub-object anywhere.
    // Purpose tags (purpose/generation_name/chamber) ride alongside the shared
    // static classifier fields for call-purpose reporting.
    expect(body.trace).toEqual({
      sourceApp: 'congress-trade',
      environment: 'test',
      service: 'openRouterVision',
      feature: 'vision-extract-senate',
      keyRef: 'OPENROUTER_API_KEY',
      gitSha: 'abc123def456',
      purpose: 'vision_extract',
      generation_name: 'PTR vision extraction',
      chamber: 'senate',
    });
    expect(body.trace.metadata).toBeUndefined();
    expect('metadata' in body).toBe(false);
    // Enrichment must never displace the core request fields.
    expect(body.model).toBe('~google/gemini-flash-latest');
    expect(body.provider).toEqual({
      order: ['Google'],
      allow_fallbacks: true,
      require_parameters: true,
    });
    expect(body.messages).toHaveLength(1);
  });

  it('keeps user deterministic across repeated extractions of the same document', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'gen-1',
        choices: [{ message: { content: JSON.stringify({ transactions: [] }) } }],
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const ex = new OpenRouterVisionExtractor(env);
    const bytes = new TextEncoder().encode('dummy pdf bytes').buffer as ArrayBuffer;
    await ex.extract({ filing: filing(), bytes });
    await ex.extract({ filing: filing(), bytes });

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string));
    expect(bodies).toHaveLength(2);
    expect(bodies[0].user).toBe('S-1');
    expect(bodies[1].user).toBe('S-1');
    expect(bodies[0].trace).toEqual(bodies[1].trace);
  });

  it('omits user (never "") when the filing has no docId, keeping trace intact', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'gen-1',
        choices: [{ message: { content: JSON.stringify({ transactions: [] }) } }],
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const ex = new OpenRouterVisionExtractor(env);
    // The bake-off harness constructs partial Filing literals; docId may be
    // missing entirely. `user` must be omitted, not sent as "".
    await ex.extract({
      filing: { docKind: 'scanned_pdf', chamber: 'senate' } as unknown as Filing,
      bytes: new TextEncoder().encode('dummy pdf bytes').buffer as ArrayBuffer,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect('user' in body).toBe(false);
    expect(body.trace).toMatchObject({
      sourceApp: 'congress-trade',
      service: 'openRouterVision',
      feature: 'vision-extract-senate',
      keyRef: 'OPENROUTER_API_KEY',
    });
  });

  it('degrades to an unenriched request when classifier enrichment throws, without failing extraction', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'gen-degraded',
        choices: [{ message: { content: JSON.stringify({ transactions: [] }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // A >80-char gitSha fails the shared builder's STATIC-field validation at
    // runtime — exactly the class of unexpected error the call site must
    // degrade on rather than fail the paid extraction call.
    const badEnv = {
      OPENROUTER_API_KEY: 'test-key',
      CF_VERSION_METADATA: { id: 'x'.repeat(100), tag: 'v1' },
    } as unknown as Env;
    const ex = new OpenRouterVisionExtractor(badEnv);
    const result = await ex.extract({
      filing: filing(),
      bytes: new TextEncoder().encode('dummy pdf bytes').buffer as ArrayBuffer,
    });

    // Extraction succeeded; the request went out WITHOUT any enrichment.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect('trace' in body).toBe(false);
    expect('user' in body).toBe(false);
    expect('session_id' in body).toBe(false);
    expect(result.extractor).toBe('openRouterVision');
    expect(result.providerRequestId).toBe('gen-degraded');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('classifier enrichment failed'),
      expect.any(String),
    );
    warn.mockRestore();
  });

  it('propagates page count for mistral-ocr model', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'gen-123',
        model: 'mistral/mistral-ocr-latest',
        choices: [
          {
            message: {
              content: JSON.stringify({ transactions: [] }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const ex = new OpenRouterVisionExtractor(env, { model: 'mistral/mistral-ocr-latest' });
    const result = await ex.extract({
      filing: filing(),
      bytes: new TextEncoder().encode('dummy pdf bytes').buffer as ArrayBuffer,
    });

    expect(result.usage).toMatchObject({ promptTokens: 100, completionTokens: 50, pagesProcessed: 5 });
    expect((result as any).pageCount).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// OpenRouter feature adoption (annotation reuse, engine routing, structured
// outputs, provider prefs, usage accounting)
// ---------------------------------------------------------------------------

function okPayload(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: async () => ({
      id: 'gen-1',
      model: 'served/model-slug',
      provider: 'TestProvider',
      choices: [{ message: { content: JSON.stringify({ transactions: [] }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      ...overrides,
    }),
  } as unknown as Response;
}

function lastRequestBody(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, any> {
  return JSON.parse(String(fetchMock.mock.calls[call][1].body));
}

describe('gemini37FlashProviderPreference', () => {
  it('pins Flash latest and 3.8 (plus batch) to Vertex/Google with fallbacks', () => {
    expect(gemini37FlashProviderPreference('~google/gemini-flash-latest')).toEqual({
      order: ['Google'],
      allow_fallbacks: true,
    });
    expect(gemini37FlashProviderPreference('google/gemini-3.8-flash')).toEqual({
      order: ['Google'],
      allow_fallbacks: true,
    });
    expect(gemini37FlashProviderPreference('google/gemini-3.8-flash:batch')).toEqual({
      order: ['Google'],
      allow_fallbacks: true,
    });
  });

  // Regression guard for sentry[bot] review on #2529: the provider-preference
  // function must recognise every spelling the production caller can pass
  // (OpenRouter forwarders occasionally normalise away the `google/` prefix;
  // users can paste the slug with a leading `~`; a future caller may pass the
  // bare slug from a config var). All of these must route through the
  // 75%-off Vertex endpoint, not the 50%-off AI Studio default.
  it('recognises every spelling of gemini-3.8-flash and routes to Vertex', () => {
    const expected = { order: ['Google'], allow_fallbacks: true };
    expect(gemini37FlashProviderPreference('google/gemini-3.8-flash')).toEqual(expected);
    expect(gemini37FlashProviderPreference('~google/gemini-3.8-flash')).toEqual(expected);
    expect(gemini37FlashProviderPreference('gemini-3.8-flash')).toEqual(expected);
    expect(gemini37FlashProviderPreference('  google/gemini-3.8-flash  ')).toEqual(expected);
    expect(gemini37FlashProviderPreference('GOOGLE/GEMINI-3.8-FLASH')).toEqual(expected);
  });

  it('does not pin other models', () => {
    expect(gemini37FlashProviderPreference('anthropic/claude-sonnet-5')).toEqual({});
    expect(gemini37FlashProviderPreference('google/gemini-3.5-flash-lite')).toEqual({});
    expect(gemini37FlashProviderPreference('google/gemini-3.5-flash')).toEqual({});
  });
});

describe('supportsNativeVision', () => {
  it('matches the current anthropic/claude-* catalog slugs', () => {
    expect(supportsNativeVision('anthropic/claude-sonnet-5')).toBe(true);
    expect(supportsNativeVision('anthropic/claude-haiku-4.5')).toBe(true);
    expect(supportsNativeVision('anthropic/claude-3-opus')).toBe(true);
  });
  it('matches Gemini Flash latest and DeepSeek Flash Vision without paying mistral-ocr', () => {
    expect(supportsNativeVision('~google/gemini-flash-latest')).toBe(true);
    expect(supportsNativeVision('google/gemini-flash-latest')).toBe(true);
    expect(supportsNativeVision('google/gemini-3.8-flash')).toBe(true);
    expect(supportsNativeVision('deepseek/deepseek-v4-flash-vision-exp')).toBe(true);
  });
  it('rejects models without native PDF / vision input', () => {
    expect(supportsNativeVision('amazon/nova-lite-v1')).toBe(false);
    expect(supportsNativeVision('z-ai/glm-4.6v')).toBe(false);
    expect(supportsNativeVision('qwen/qwen3-vl-8b-instruct')).toBe(false);
    expect(supportsNativeVision('deepseek/deepseek-v4-flash')).toBe(false);
  });
});

describe('prefersPageImages', () => {
  it('routes Qwen VL and GLM-V to raster pages instead of PDF file-parser', () => {
    expect(prefersPageImages('qwen/qwen3-vl-8b-instruct')).toBe(true);
    expect(prefersPageImages('qwen/qwen3-vl-30b-a3b-instruct')).toBe(true);
    expect(prefersPageImages('z-ai/glm-4.6v')).toBe(true);
  });
  it('does not force images on native-PDF models', () => {
    expect(prefersPageImages('x-ai/grok-4.5')).toBe(false);
    expect(prefersPageImages('google/gemini-3.8-flash')).toBe(false);
    expect(prefersPageImages('anthropic/claude-sonnet-5')).toBe(false);
  });
});

describe('supportsStructuredOutputs', () => {
  it('allows vendors verified to list structured_outputs', () => {
    for (const model of [
      'openai/gpt-5.6-terra', 'anthropic/claude-sonnet-5', 'google/gemini-3.5-flash',
      '~google/gemini-flash-latest',
      'deepseek/deepseek-v4-flash', 'qwen/qwen3-vl-8b-instruct', 'x-ai/grok-4.5',
    ]) expect(supportsStructuredOutputs(model), model).toBe(true);
  });
  it('keeps unverified vendors and special routes on the prompt-JSON fallback', () => {
    for (const model of [
      'amazon/nova-lite-v1', 'z-ai/glm-4.6v', 'mistral/mistral-ocr-latest', 'openrouter/auto',
    ]) expect(supportsStructuredOutputs(model), model).toBe(false);
  });
});

describe('chooseParserEngine', () => {
  it('routes typed documents to the free cloudflare-ai engine, even for native models', () => {
    expect(chooseParserEngine({ model: 'anthropic/claude-sonnet-5', docClass: 'typed' })).toBe('cloudflare-ai');
    expect(chooseParserEngine({ model: 'amazon/nova-lite-v1', docKind: 'text_pdf' })).toBe('cloudflare-ai');
  });
  it('prefers doc_class over doc_kind when both are present', () => {
    expect(chooseParserEngine({ model: 'amazon/nova-lite-v1', docClass: 'typed', docKind: 'scanned_pdf' })).toBe('cloudflare-ai');
    expect(chooseParserEngine({ model: 'amazon/nova-lite-v1', docClass: 'hard_scan', docKind: 'text_pdf' })).toBe('mistral-ocr');
  });
  it('lets native-vision models read scans natively and routes the rest to mistral-ocr', () => {
    expect(chooseParserEngine({ model: 'anthropic/claude-sonnet-5', docKind: 'scanned_pdf' })).toBeNull();
    expect(chooseParserEngine({ model: '~google/gemini-flash-latest', docKind: 'scanned_pdf' })).toBeNull();
    expect(chooseParserEngine({ model: 'deepseek/deepseek-v4-flash-vision-exp', docKind: 'scanned_pdf' })).toBeNull();
    expect(chooseParserEngine({ model: 'amazon/nova-lite-v1', docKind: 'scanned_pdf' })).toBe('mistral-ocr');
    expect(chooseParserEngine({ model: 'deepseek/deepseek-v4-flash', docKind: 'scanned_pdf' })).toBe('mistral-ocr');
  });
  it('honors the engine knobs', () => {
    expect(chooseParserEngine({ model: 'amazon/nova-lite-v1', docClass: 'typed', textEngine: 'mistral-ocr' })).toBe('mistral-ocr');
    expect(chooseParserEngine({ model: 'amazon/nova-lite-v1', docKind: 'scanned_pdf', scanEngine: 'cloudflare-ai' })).toBe('cloudflare-ai');
  });
});

describe('parseMaxPrice / isEngineOverrideRejection', () => {
  it('parses valid max-price JSON and rejects junk', () => {
    expect(parseMaxPrice('{"prompt":5,"completion":20}')).toEqual({ prompt: 5, completion: 20 });
    expect(parseMaxPrice('not json')).toBeNull();
    expect(parseMaxPrice('{"prompt":"high"}')).toBeNull();
    expect(parseMaxPrice(undefined)).toBeNull();
  });
  it('classifies engine-override rejections as 4xx mentioning the plugin', () => {
    expect(isEngineOverrideRejection(404, 'file-parser engine override not allowed')).toBe(true);
    expect(isEngineOverrideRejection(400, 'invalid plugin configuration')).toBe(true);
    expect(isEngineOverrideRejection(500, 'engine exploded')).toBe(false);
    expect(isEngineOverrideRejection(429, 'rate limited')).toBe(false);
  });
});

describe('OpenRouterVisionExtractor OpenRouter features', () => {
  
  it('omits minimum/maximum on number fields (Anthropic-via-OpenRouter rejects them)', () => {
    const conf = (OPENROUTER_EXTRACTION_RESPONSE_FORMAT as any).json_schema.schema
      .properties.transactions.items.properties.confidence;
    expect(conf).toEqual({ type: 'number' });
    expect(conf).not.toHaveProperty('minimum');
    expect(conf).not.toHaveProperty('maximum');
  });

  it('defaults to Flash latest and pins Vertex/Google', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okPayload());
    vi.stubGlobal('fetch', fetchMock);

    const ex = new OpenRouterVisionExtractor(env);
    await ex.extract({ filing: filing(), bytes: new TextEncoder().encode('x').buffer as ArrayBuffer });

    const body = lastRequestBody(fetchMock);
    expect(body.model).toBe('~google/gemini-flash-latest');
    expect(body.provider).toEqual({
      order: ['Google'],
      allow_fallbacks: true,
      require_parameters: true,
    });
  });

  it('still pins Vertex/Google when an explicit 3.8 Flash slug is requested', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okPayload());
    vi.stubGlobal('fetch', fetchMock);

    const ex = new OpenRouterVisionExtractor(env, { model: 'google/gemini-3.8-flash' });
    await ex.extract({ filing: filing(), bytes: new TextEncoder().encode('x').buffer as ArrayBuffer });

    const body = lastRequestBody(fetchMock);
    expect(body.model).toBe('google/gemini-3.8-flash');
    expect(body.provider.order).toEqual(['Google']);
  });

  it('leaves Flash Lite and Claude provider prefs unchanged', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okPayload());
    vi.stubGlobal('fetch', fetchMock);

    const lite = new OpenRouterVisionExtractor(env, { model: 'google/gemini-3.5-flash-lite' });
    await lite.extract({ filing: filing(), bytes: new TextEncoder().encode('x').buffer as ArrayBuffer });
    expect(lastRequestBody(fetchMock, 0).model).toBe('google/gemini-3.5-flash-lite');
    expect(lastRequestBody(fetchMock, 0).provider).toEqual({ require_parameters: true });

    const claude = new OpenRouterVisionExtractor(env, { model: 'anthropic/claude-sonnet-5' });
    await claude.extract({ filing: filing(), bytes: new TextEncoder().encode('x').buffer as ArrayBuffer });
    expect(lastRequestBody(fetchMock, 1).model).toBe('anthropic/claude-sonnet-5');
    expect(lastRequestBody(fetchMock, 1).provider).toEqual({ require_parameters: true });
  });

  it('sends strict json_schema + require_parameters + usage accounting for structured-output models', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okPayload());
    vi.stubGlobal('fetch', fetchMock);

    const ex = new OpenRouterVisionExtractor(env, { model: 'anthropic/claude-sonnet-5' });
    await ex.extract({ filing: filing(), bytes: new TextEncoder().encode('x').buffer as ArrayBuffer });

    const body = lastRequestBody(fetchMock);
    expect(body.response_format).toEqual(OPENROUTER_EXTRACTION_RESPONSE_FORMAT);
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.usage).toEqual({ include: true });
    // Native-vision model on a scan: no file-parser plugin, healing stays on.
    expect(body.plugins).toEqual([{ id: 'response-healing' }]);
  });

  it('falls back to prompt-JSON json_object for models without structured outputs', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okPayload());
    vi.stubGlobal('fetch', fetchMock);

    const ex = new OpenRouterVisionExtractor(env, { model: 'amazon/nova-lite-v1' });
    await ex.extract({ filing: filing(), bytes: new TextEncoder().encode('x').buffer as ArrayBuffer });

    const body = lastRequestBody(fetchMock);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.provider).toBeUndefined();
    // Non-native model on a scan: mistral-ocr file-parser engine attached.
    expect(body.plugins).toEqual([
      { id: 'response-healing' },
      { id: 'file-parser', pdf: { engine: 'mistral-ocr' } },
    ]);
  });

  it('routes typed documents (doc_class) to the free cloudflare-ai engine', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okPayload());
    vi.stubGlobal('fetch', fetchMock);

    const ex = new OpenRouterVisionExtractor(env, { model: 'anthropic/claude-sonnet-5' });
    const typedFiling = { ...filing(), docClass: 'typed' } as unknown as Filing;
    await ex.extract({ filing: typedFiling, bytes: new TextEncoder().encode('x').buffer as ArrayBuffer });

    const body = lastRequestBody(fetchMock);
    expect(body.plugins).toEqual([
      { id: 'response-healing' },
      { id: 'file-parser', pdf: { engine: 'cloudflare-ai' } },
    ]);
  });

  it('falls back to doc_kind (text_pdf) for the free engine when doc_class is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okPayload());
    vi.stubGlobal('fetch', fetchMock);

    // Non-native model + text_pdf doc_kind, no doc_class: the typed-document
    // routing must still land on the free engine via the doc_kind fallback,
    // not on the non-native scanned-document mistral-ocr path.
    const ex = new OpenRouterVisionExtractor(env, { model: 'amazon/nova-lite-v1' });
    const textFiling = { ...filing(), docKind: 'text_pdf' } as Filing;
    await ex.extract({ filing: textFiling, bytes: new TextEncoder().encode('x').buffer as ArrayBuffer });

    const body = lastRequestBody(fetchMock);
    expect(body.plugins).toEqual([
      { id: 'response-healing' },
      { id: 'file-parser', pdf: { engine: 'cloudflare-ai' } },
    ]);
  });

  it('applies the OPENROUTER_MAX_PRICE ceiling knob to provider preferences', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okPayload());
    vi.stubGlobal('fetch', fetchMock);

    const pricedEnv = { ...env, OPENROUTER_MAX_PRICE: '{"prompt":5,"completion":20}' } as unknown as Env;
    const ex = new OpenRouterVisionExtractor(pricedEnv, { model: 'anthropic/claude-sonnet-5' });
    await ex.extract({ filing: filing(), bytes: new TextEncoder().encode('x').buffer as ArrayBuffer });

    const body = lastRequestBody(fetchMock);
    expect(body.provider).toEqual({ require_parameters: true, max_price: { prompt: 5, completion: 20 } });
  });

  it('degrades to default engine selection when the request-level engine is rejected', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => '{"error":{"message":"file-parser engine override not allowed"}}',
      } as unknown as Response)
      .mockResolvedValueOnce(okPayload());
    vi.stubGlobal('fetch', fetchMock);

    const ex = new OpenRouterVisionExtractor(env, { model: 'amazon/nova-lite-v1' });
    const result = await ex.extract({ filing: filing(), bytes: new TextEncoder().encode('x').buffer as ArrayBuffer });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastRequestBody(fetchMock, 0).plugins).toContainEqual({ id: 'file-parser', pdf: { engine: 'mistral-ocr' } });
    expect(lastRequestBody(fetchMock, 1).plugins).toEqual([{ id: 'response-healing' }]);
    expect(result.transactions).toEqual([]);
  });

  it('reuses stored file annotations and skips the parser plugin', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okPayload());
    vi.stubGlobal('fetch', fetchMock);

    const storedAnnotations = [{ type: 'file', file: { filename: 'document.pdf', content: 'parsed' } }];
    const put = vi.fn();
    const annotatedEnv = {
      ...env,
      RAW_FILES: {
        get: async (key: string) =>
          key === annotationObjectKey('S-1')
            ? { text: async () => JSON.stringify(storedAnnotations) }
            : null,
        put,
      },
    } as unknown as Env;

    const ex = new OpenRouterVisionExtractor(annotatedEnv, { model: 'amazon/nova-lite-v1' });
    await ex.extract({ filing: filing(), bytes: new TextEncoder().encode('x').buffer as ArrayBuffer });

    const body = lastRequestBody(fetchMock);
    // Reuse shape: user(file) -> assistant(annotations) -> user(prompt).
    expect(body.messages).toHaveLength(3);
    expect(body.messages[1].role).toBe('assistant');
    expect(body.messages[1].annotations).toEqual(storedAnnotations);
    // The parse is skipped via annotations — no file-parser engine attached.
    expect(body.plugins).toEqual([{ id: 'response-healing' }]);
    expect(put).not.toHaveBeenCalled();
  });

  it('persists first-read annotations for later reuse', async () => {
    const responseAnnotations = [{ type: 'file', file: { filename: 'document.pdf', content: 'parsed' } }];
    const fetchMock = vi.fn().mockResolvedValueOnce(okPayload({
      choices: [{ message: { content: JSON.stringify({ transactions: [] }), annotations: responseAnnotations } }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const put = vi.fn(async (_key: string, _value: string, _opts?: unknown) => undefined);
    const annotatedEnv = {
      ...env,
      RAW_FILES: { get: async () => null, put },
    } as unknown as Env;

    const ex = new OpenRouterVisionExtractor(annotatedEnv, { model: 'amazon/nova-lite-v1' });
    await ex.extract({ filing: filing(), bytes: new TextEncoder().encode('x').buffer as ArrayBuffer });

    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0]).toBe(annotationObjectKey('S-1'));
    expect(JSON.parse(String(put.mock.calls[0][1]))).toEqual(responseAnnotations);
  });

  it('captures provider-reported cost, cached tokens, and the served model id', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okPayload({
      id: 'gen-9',
      model: 'google/gemini-3.5-flash-20260519',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        cost: 0.0123,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const ex = new OpenRouterVisionExtractor(env, { model: 'google/gemini-3.5-flash' });
    const result = await ex.extract({ filing: filing(), bytes: new TextEncoder().encode('x').buffer as ArrayBuffer });

    expect(result.usage).toMatchObject({
      promptTokens: 100,
      completionTokens: 50,
      cachedTokens: 40,
      costUsd: 0.0123,
    });
    expect(result.modelVersion).toBe('google/gemini-3.5-flash-20260519');
    expect(result.providerRequestId).toBe('gen-9');
  });
});
