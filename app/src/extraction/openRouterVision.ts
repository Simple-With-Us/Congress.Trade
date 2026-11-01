/**
 * src/extraction/openRouterVision.ts
 * OWNER: extraction agent
 *
 * OpenRouter / OpenAI-compatible Vision extractor for PDF disclosure documents.
 *
 * OpenRouter-feature adoption (https://openrouter.ai/docs/guides/overview/multimodal/pdfs):
 *   - FILE-ANNOTATION REUSE: the first successful OpenRouter read of a document
 *     returns `choices[0].message.annotations` describing the parsed PDF. We
 *     persist those annotations to R2 (keyed by doc id) and send them back on
 *     every later OpenRouter call for the same document (agreement-trio members
 *     2/3, cascade retries, operator reprocess), which makes OpenRouter skip
 *     the PDF parse — the parse fee is paid ONCE per document instead of once
 *     per model read.
 *   - ENGINE ROUTING: the file-parser plugin engine is chosen from the
 *     document's classification — typed/text PDFs use the FREE `cloudflare-ai`
 *     markdown engine (the deprecated `pdf-text` engine redirects here), scans
 *     use `mistral-ocr` ($2/1k pages), and native-vision models read scans
 *     directly (billed as input tokens). Both knobs are overridable.
 *   - STRUCTURED OUTPUTS: models verified to support `structured_outputs` get
 *     a strict `json_schema` response_format (plus provider
 *     `require_parameters` so requests never route to providers that ignore
 *     response_format); everything else keeps the prompt-JSON + `json_object`
 *     fallback. The `response-healing` plugin stays on as backup either way.
 *   - USAGE ACCOUNTING: `usage: { include: true }` returns the actual charged
 *     cost per request; it is captured (with cached-token detail and the served
 *     model id) into the extractor usage so extraction_runs/telemetry record
 *     provider-reported dollars instead of only rate-card estimates.
 */

import type { Extractor, ExtractorInput, ExtractorResult } from '../extractors/types.ts';
import type { Env, Filing, ParsedTx } from '../shared/types.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { sendPushover } from '../shared/pushover.ts';
import type { OpenRouterRequestEnrichment } from '@jaywedgeworth22/congress-trading-shared';
import {
  OPENROUTER_PURPOSE,
  buildOpenRouterClassifier,
  openRouterAttributionHeaders,
} from '../shared/openRouterAttribution.ts';
import {
  buildExtractionPrompt,
  loadExtractionPromptContext,
  parseTruncationAwareJson,
  toParsedTx,
  fetchWithRetry,
  arrayBufferToBase64,
  markSalvaged,
} from './visionLlm.ts';
import {
  assertOpenRouterBudgetCircuitAllowsCall,
  isOpenRouterBudgetHttp,
  noteOpenRouterBudgetFailure,
  noteOpenRouterBudgetSuccess,
} from '../shared/openRouterBudgetCircuit.ts';
import {
  classifyOpenRouterReply,
  docScopedOpenRouterError,
  isDocScopedOpenRouterReply,
} from './openRouterReply.ts';
import { IngestRetryError } from '../ingestion/fetcher.ts';

/**
 * OpenRouter Flash-latest alias.  Live catalog 2026-08-21: this slug
 * "always redirects to the latest model in the Google Gemini Flash family"
 * and currently prices as Gemini 3.7 ($0.375/$1.875, Vertex 75% off).
 * Bare `google/gemini-flash-latest` 404s — the `~` prefix is required.
 */
export const OPENROUTER_GEMINI_FLASH = '~google/gemini-flash-latest';
/** Pinned 3.7 batch/offline slug (the latest alias has no `:batch` variant). */
export const OPENROUTER_GEMINI_FLASH_BATCH = 'google/gemini-3.8-flash:batch';
const DEFAULT_MODEL = OPENROUTER_GEMINI_FLASH;

function isOpenRouterGeminiFlashLatest(model: string): boolean {
  const base = model.trim().replace(/:batch$/i, '').replace(/^~/, '').toLowerCase();
  return base === 'google/gemini-flash-latest' || base === 'gemini-flash-latest';
}

function isOpenRouterGemini37Flash(model: string): boolean {
  const base = model.trim().replace(/:batch$/i, '').replace(/^~/, '').toLowerCase();
  return base === 'google/gemini-3.8-flash' || base === 'gemini-3.8-flash';
}

/**
 * Vertex/`Google` is the 75%-off Gemini Flash endpoint for current latest
 * (3.7) and the pinned 3.7 slug.  AI Studio is only 50% off.  Fall back
 * if Vertex is down rather than failing the read.
 */
export function gemini37FlashProviderPreference(model: string): {
  order: string[];
  allow_fallbacks: boolean;
} | Record<string, never> {
  if (!isOpenRouterGeminiFlashLatest(model) && !isOpenRouterGemini37Flash(model)) return {};
  return { order: ['Google'], allow_fallbacks: true };
}

const DEFAULT_CONFIDENCE = 0.6;
const MAX_TOKENS = 65000;

/** file-parser engine for typed/text PDFs (FREE markdown conversion). */
const DEFAULT_TEXT_ENGINE = 'cloudflare-ai';
/** file-parser engine for scanned PDFs read by non-native-vision models. */
const DEFAULT_SCAN_ENGINE = 'mistral-ocr';

interface OpenAIChatPayload {
  /** OpenRouter's generation id for this response (e.g. "gen-..."), used as
   *  providerRequestId for monitor-side spend verification. */
  id?: string;
  /** Served model slug (may differ from the requested alias). */
  model?: string;
  /** Upstream provider name that actually served the request. */
  provider?: string;
  choices?: Array<{
    message?: {
      content?: string;
      /** File annotations from OpenRouter's PDF parser (reusable). */
      annotations?: unknown[];
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** Actual charged cost in USD credits (present with usage.include=true). */
    cost?: number;
    cost_details?: { upstream_inference_cost?: number | null } | null;
    prompt_tokens_details?: { cached_tokens?: number } | null;
  };
}

export interface OpenRouterVisionOptions {
  apiKey?: string;
  apiKeyName?: keyof Env & string;
  model?: string;
  modelEnvName?: keyof Env & string;
  defaultModel?: string;
  name?: string;
}


/** Returns true for models that accept a PDF as a `type: 'file'` attachment natively. */
export function supportsNativeVision(model: string): boolean {
  const m = model.toLowerCase();
  if (m.includes('gpt-4o')) return true;
  if (m.includes('gpt-5')) return true;
  // Anthropic slugs on OpenRouter are generation-suffixed family names
  // (anthropic/claude-sonnet-5, anthropic/claude-haiku-4.5, ...) — the old
  // claude-3/4/5 substring test missed every current slug and fell back to a
  // paid mistral-ocr parse for models that read PDFs natively.
  if (/claude-(?:\d|sonnet|haiku|opus)/.test(m)) return true;
  if (m.includes('gemini-1.5') || m.includes('gemini-2') || m.includes('gemini-3')) return true;
  // `~google/gemini-flash-latest` has file modality (verified 2026-08-21) but
  // does not contain `gemini-3`, so the generation test above misses it.
  if (/gemini-flash-latest/.test(m)) return true;
  // x-ai/grok-4.x lists `file` input modality on the live catalog (2026-07-18).
  if (/grok-4/.test(m)) return true;
  // DeepSeek V4 Flash Vision (exp or later).  Catalog lists image, not file;
  // skip paid mistral-ocr so a future seat does not double-pay.  Text-only
  // `deepseek-v4-flash` stays on the OCR plugin.
  if (/deepseek[-/].*flash-vision|deepseek[-/].*-vision(?:-|$)/.test(m)) return true;
  return false;
}

/**
 * True when the model reads raster pages (image_url) but not PDF `file`
 * attachments.  Sending a PDF through OpenRouter's file-parser would bill
 * mistral-ocr (~$2/1k pages) — the opposite of a cheap cascade.  The Mac
 * vision-worker therefore attaches page PNGs/JPEGs for these slugs.
 *
 * Keep in sync with `model_uses_page_images` in services/vision-worker/worker.py.
 */
export function prefersPageImages(model: string): boolean {
  const m = model.toLowerCase();
  if (supportsNativeVision(m)) return false;
  if (/qwen/.test(m) && /vl/.test(m)) return true;
  if (/glm-4/.test(m) && /v/.test(m)) return true;
  if (/deepseek[-/].*flash-vision|deepseek[-/].*-vision(?:-|$)/.test(m)) return true;
  return false;
}

/**
 * Models verified (live /api/v1/models `supported_parameters`, 2026-07-18) to
 * support `structured_outputs` via OpenRouter. Slug-vendor allowlist rather
 * than per-model so new same-vendor generations inherit the behavior; vendors
 * whose listings lack `structured_outputs` (amazon/nova*, z-ai/glm*) and the
 * unpredictable `openrouter/auto` router stay on the prompt-JSON fallback.
 */
export function supportsStructuredOutputs(model: string): boolean {
  const m = model.trim().replace(/^~/, '').toLowerCase();
  if (m.includes('mistral-ocr')) return false; // OCR endpoint, not a chat model
  const slash = m.indexOf('/');
  if (slash <= 0) return false;
  const vendor = m.slice(0, slash);
  return ['openai', 'anthropic', 'google', 'deepseek', 'qwen', 'x-ai'].includes(vendor);
}

/**
 * Strict JSON schema for the extraction reply (same row shape as
 * `MISTRAL_ANNOTATION_SCHEMA` in bakeoff.ts — kept as a separate literal to
 * avoid an import cycle; `parseModelJson` unwraps the `transactions` wrapper).
 */
export const OPENROUTER_EXTRACTION_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'extraction',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        transactions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              txDate: { type: ['string', 'null'] },
              owner: { type: ['string', 'null'] },
              assetName: { type: ['string', 'null'] },
              ticker: { type: ['string', 'null'] },
              assetType: { type: ['string', 'null'] },
              assetTypeName: { type: ['string', 'null'] },
              txType: { type: ['string', 'null'] },
              amountRange: { type: ['string', 'null'] },
              isOption: { type: ['boolean', 'null'] },
              capGainsOver200: { type: ['boolean', 'null'] },
              filingStatus: { type: ['string', 'null'] },
              subholding: { type: ['string', 'null'] },
              location: { type: ['string', 'null'] },
              description: { type: ['string', 'null'] },
              supplementalText: { type: ['string', 'null'] },
              // Anthropic (via OpenRouter) rejects minimum/maximum on number
              // types in strict json_schema ("For 'number' type, properties
              // maximum, minimum are not supported"). Clamp in normalizer.
              confidence: { type: 'number' },
            },
            required: [
              'assetName',
              'ticker',
              'assetType',
              'assetTypeName',
              'txType',
              'amountRange',
              'txDate',
              'owner',
              'isOption',
              'capGainsOver200',
              'filingStatus',
              'subholding',
              'location',
              'description',
              'supplementalText',
              'confidence',
            ],
          },
        },
      },
      required: ['transactions'],
    },
  },
} as const;

/**
 * Pick the file-parser engine for one request. Preference order for the
 * document signal: `doc_class` (per-filing classification from the extraction
 * autopilot: typed | clean_scan | hard_scan | empty | corrupt) when present,
 * else `doc_kind` (text_pdf | scanned_pdf). Returns `null` when no plugin
 * should be attached (native-vision model reading a scan natively).
 */
export function chooseParserEngine(input: {
  model: string;
  docClass?: string | null;
  docKind?: string | null;
  textEngine?: string;
  scanEngine?: string;
}): string | null {
  const textEngine = input.textEngine?.trim() || DEFAULT_TEXT_ENGINE;
  const scanEngine = input.scanEngine?.trim() || DEFAULT_SCAN_ENGINE;
  const docClass = input.docClass?.trim().toLowerCase();
  const docKind = input.docKind?.trim().toLowerCase();
  const isTyped = docClass ? docClass === 'typed' : docKind === 'text_pdf';
  // Typed documents: the FREE markdown engine beats native token-billed page
  // parsing for every model, so attach it even for native-vision models.
  if (isTyped) return textEngine;
  // Scans (clean_scan / hard_scan / scanned_pdf / unknown): native-vision
  // models read the PDF directly; everything else needs the OCR engine.
  return supportsNativeVision(input.model) ? null : scanEngine;
}

/** R2 object key holding a document's reusable OpenRouter file annotations. */
export function annotationObjectKey(docId: string): string {
  return `openrouter/annotations/${docId}.json`;
}

/** Best-effort load of persisted annotations; any failure reads as "none". */
async function loadStoredAnnotations(env: Env, docId: string): Promise<unknown[] | null> {
  try {
    const bucket = (env as { RAW_FILES?: R2Bucket }).RAW_FILES;
    if (!bucket?.get) return null;
    const obj = await bucket.get(annotationObjectKey(docId));
    if (!obj) return null;
    const parsed: unknown = JSON.parse(await obj.text());
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/** Best-effort persist; extraction never fails because the cache write did. */
async function storeAnnotations(env: Env, docId: string, annotations: unknown[]): Promise<void> {
  try {
    const bucket = (env as { RAW_FILES?: R2Bucket }).RAW_FILES;
    if (!bucket?.put) return;
    await bucket.put(annotationObjectKey(docId), JSON.stringify(annotations), {
      httpMetadata: { contentType: 'application/json' },
    });
  } catch (err) {
    console.warn(`openRouterVision: annotation cache write failed for ${docId}: ${(err as Error).message}`);
  }
}

/**
 * True when a non-OK OpenRouter reply looks like a rejected request-level
 * plugin/engine override (the account has "Prevent overrides" enabled in the
 * OpenRouter dashboard). The caller degrades to OpenRouter's default engine
 * selection (native → mistral-ocr) instead of failing the read.
 */
export function isEngineOverrideRejection(status: number, detail: string): boolean {
  if (status < 400 || status >= 500) return false;
  return /\b(engine|plugin|file-parser|override)\b/i.test(detail);
}

/** Parse the OPENROUTER_MAX_PRICE knob: JSON like {"prompt":5,"completion":20}
 *  (USD per million tokens, matching OpenRouter provider max_price units). */
export function parseMaxPrice(raw: string | undefined): Record<string, number> | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const key of ['prompt', 'completion', 'image', 'request'] as const) {
      const value = parsed[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

export class OpenRouterVisionExtractor implements Extractor {
  readonly name: string;
  private readonly modelOverride?: string;
  private readonly modelEnvName: keyof Env & string;
  private readonly defaultModel: string;
  private readonly apiKeyOverride?: string;
  private readonly apiKeyName: keyof Env & string;

  constructor(
    private readonly env: Env,
    options: OpenRouterVisionOptions = {},
  ) {
    this.name = options.name ?? 'openRouterVision';
    this.modelOverride = options.model;
    this.modelEnvName = options.modelEnvName ?? 'OPENROUTER_MODEL';
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL;
    this.apiKeyOverride = options.apiKey;
    this.apiKeyName = options.apiKeyName ?? 'OPENROUTER_API_KEY';
  }

  canHandle(f: Filing): boolean {
    return f.docKind === 'scanned_pdf';
  }

  private async resolveModel(): Promise<string> {
    if (this.modelOverride) return this.modelOverride;
    try {
      return (await resolveSecret(this.env, this.modelEnvName)).value || this.defaultModel;
    } catch {
      return (this.env[this.modelEnvName] as string | undefined) || this.defaultModel;
    }
  }

  /** Live-tunable knob: Infisical first, env fallback, then default. */
  private async resolveKnob(name: keyof Env & string, fallback: string): Promise<string> {
    try {
      const resolved = (await resolveSecret(this.env, name)).value;
      if (resolved) return resolved;
    } catch {
      /* fall through to env */
    }
    return (this.env[name] as string | undefined) || fallback;
  }

  /**
   * Usage-compliance classifier metadata for the OpenRouter request: a stable
   * `trace` object (sourceApp/environment/service/feature/keyRef/gitSha) plus
   * a deterministic per-document `user` id, per
   * DESIGN-usage-compliance-classifier.md §2. Built once per extraction call
   * (not per fetchWithRetry attempt) so `user` stays byte-identical across
   * retries of the same document. Delegates to shared openRouterAttribution.
   */
  private buildClassifierEnrichment(input: ExtractorInput): OpenRouterRequestEnrichment | undefined {
    const chamber = input.filing.chamber || undefined;
    return buildOpenRouterClassifier(this.env, {
      service: this.name,
      purpose: OPENROUTER_PURPOSE.VISION_EXTRACT,
      feature: chamber ? `vision-extract-${chamber}` : 'vision-extract',
      chamber,
      keyRef: this.apiKeyName,
      // Deterministic per-doc id — never "" (omit when missing).
      user: input.filing.docId || undefined,
    });
  }

  async extract(input: ExtractorInput): Promise<ExtractorResult> {
    const key = this.apiKeyOverride ?? (await resolveSecret(this.env, this.apiKeyName)).value;
    if (!key) throw new Error(`${this.name}: API key is not configured`);
    if (!input.bytes) throw new Error(`${this.name}: no bytes provided on ExtractorInput`);

    const model = await this.resolveModel();
    const docId = input.filing.docId || null;
    // doc_class is being added by the extraction-autopilot lane; read it
    // structurally so this routing works the moment the column ships without
    // coupling to that lane's type change.
    const docClass = (input.filing as Filing & { docClass?: string | null }).docClass ?? null;

    // Computed once per extraction call — never per retry — so `user` stays
    // deterministic across fetchWithRetry's internal attempts.
    const classifierEnrichment = this.buildClassifierEnrichment(input);

    let pagesProcessed: number | undefined = undefined;
    if (model.toLowerCase().includes('mistral-ocr')) {
      try {
        const { getDocumentProxy } = await import('unpdf');
        const pdf = await getDocumentProxy(new Uint8Array(input.bytes.slice(0)));
        pagesProcessed = typeof pdf.numPages === 'number' && Number.isFinite(pdf.numPages) ? pdf.numPages : undefined;
      } catch {
        // ignore
      }
    }

    // Metadata-grounded prompt: known filing facts (chamber, form type, filed
    // year, page count, filer name) orient the model on the form layout.
    const promptContext = await loadExtractionPromptContext(this.env, input.filing, pagesProcessed);
    const promptToUse = buildExtractionPrompt(promptContext);

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCachedTokens = 0;
    let providerCostUsd: number | undefined;
    let resolvedModel = model;
    let providerRequestId: string | undefined;
    let combinedRaw = '';
    let allRows: ParsedTx[] = [];

    try {
      // Use OpenRouter's native file type for universal PDF processing (via native support or internal OCR plugins).
      // We can pass the URL directly instead of a massive Base64 string if the URL is available.
      let fileData: string;
      if (input.filing.sourceUrl) {
        fileData = input.filing.sourceUrl;
      } else {
        fileData = `data:application/pdf;base64,${arrayBufferToBase64(input.bytes)}`;
      }

      // Mistral OCR via OpenRouter requires image_url with the document URL
      // (or base64 data URI) — NOT the file-parser plugin approach.
      const isMistralOcr = model.includes('mistral-ocr');
      const structured = !isMistralOcr && supportsStructuredOutputs(model);
      const maxPrice = parseMaxPrice(await this.resolveKnob('OPENROUTER_MAX_PRICE', ''));

      // Reuse persisted file annotations so OpenRouter skips re-parsing fees
      // for later reads of the same document (trio members 2/3, retries).
      const storedAnnotations = !isMistralOcr && docId
        ? await loadStoredAnnotations(this.env, docId)
        : null;

      const engine = isMistralOcr || storedAnnotations
        ? null
        : chooseParserEngine({
            model,
            docClass,
            docKind: input.filing.docKind,
            textEngine: await this.resolveKnob('OPENROUTER_PDF_ENGINE_TEXT', DEFAULT_TEXT_ENGINE),
            scanEngine: await this.resolveKnob('OPENROUTER_PDF_ENGINE_SCANNED', DEFAULT_SCAN_ENGINE),
          });

      const buildMessages = (): unknown[] => {
        if (isMistralOcr) {
          // Per OpenRouter docs: Mistral OCR accepts `image_url` pointing to the PDF.
          return [
            {
              role: 'user',
              content: [
                { type: 'text', text: `${promptToUse}\nReturn ONLY the JSON array.` },
                { type: 'image_url', image_url: { url: fileData } },
              ],
            },
          ];
        }
        const fileBlock = {
          type: 'file',
          file: { filename: 'document.pdf', file_data: fileData },
        };
        const promptBlock = { type: 'text', text: `${promptToUse}\nReturn ONLY the JSON array.` };
        if (storedAnnotations) {
          // Annotation-reuse shape from the OpenRouter PDF docs: the original
          // user message (file re-sent for hash dedup), the assistant message
          // carrying the parser's annotations, then the actual ask.
          return [
            { role: 'user', content: [{ type: 'text', text: 'Document attached.' }, fileBlock] },
            { role: 'assistant', content: 'Document parsed.', annotations: storedAnnotations },
            { role: 'user', content: [promptBlock] },
          ];
        }
        return [{ role: 'user', content: [fileBlock, promptBlock] }];
      };

      const callOpenRouter = async (
        includeEngine: boolean,
      ): Promise<{ payload: OpenAIChatPayload } | { rejection: string; status: number }> => {
        const plugins = [
          { id: 'response-healing' },
          ...(includeEngine && engine ? [{ id: 'file-parser', pdf: { engine } }] : []),
        ];
        const provider = {
          ...gemini37FlashProviderPreference(model),
          ...(structured ? { require_parameters: true } : {}),
          ...(maxPrice ? { max_price: maxPrice } : {}),
        };

        // Owner: no million retries when the key is out of budget — short
        // burst then hourly cool-down (openRouterBudgetCircuit).
        await assertOpenRouterBudgetCircuitAllowsCall(this.env);

        const res = await fetchWithRetry(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${key}`,
              'Content-Type': 'application/json',
              ...openRouterAttributionHeaders(),
            },
            body: JSON.stringify({
              model,
              max_tokens: MAX_TOKENS,
              response_format: structured
                ? OPENROUTER_EXTRACTION_RESPONSE_FORMAT
                : { type: 'json_object' },
              usage: { include: true },
              ...(Object.keys(provider).length ? { provider } : {}),
              plugins,
              messages: buildMessages(),
              // Usage-compliance classifier metadata (top-level user/session_id
              // + flat trace object) — undefined when enrichment degraded, in
              // which case this spreads nothing.
              ...classifierEnrichment,
            }),
            signal: input.signal
              ? AbortSignal.any([input.signal, AbortSignal.timeout(600_000)])
              : AbortSignal.timeout(600_000),
          },
          this.name,
          // Budget 402/403 are not retryable at HTTP layer; maxAttempts=3 only
          // covers transient 429/5xx. Burst+hourly lives in the circuit module.
          { model, maxAttempts: 3, spendGuard: { env: this.env, provider: 'openrouter' } }
        );

        if (!res.ok) {
          let detail = '';
          try {
            detail = (await res.text()).slice(0, 500);
          } catch {
            /* ignore */
          }
          if (includeEngine && engine && isEngineOverrideRejection(res.status, detail)) {
            return { rejection: detail, status: res.status };
          }
          if (isOpenRouterBudgetHttp(res.status, detail)) {
            await sendPushover(this.env, {
              title: 'OpenRouter Budget Alert',
              message: `OpenRouter HTTP ${res.status} budget cap reached for model ${model} (doc: ${docId ?? 'unknown'}). Circuit will trip after a short burst; not waiting on credits as a strategy.`,
              priority: 1,
            }).catch(() => {});

            const backupKey = (await resolveSecret(this.env, 'OPENROUTER_BACKUP_API_KEY')).value;
            if (backupKey && backupKey !== key) {
              console.warn(`${this.name}: HTTP ${res.status} budget cap; attempting failover to OPENROUTER_BACKUP_API_KEY`);
              await assertOpenRouterBudgetCircuitAllowsCall(this.env);
              const backupRes = await fetchWithRetry(
                'https://openrouter.ai/api/v1/chat/completions',
                {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${backupKey}`,
                    'Content-Type': 'application/json',
                    ...openRouterAttributionHeaders(),
                  },
                  body: JSON.stringify({
                    model,
                    max_tokens: MAX_TOKENS,
                    response_format: structured
                      ? OPENROUTER_EXTRACTION_RESPONSE_FORMAT
                      : { type: 'json_object' },
                    usage: { include: true },
                    ...(Object.keys(provider).length ? { provider } : {}),
                    plugins,
                    messages: buildMessages(),
                    // Backup key still tags as OPENROUTER_BACKUP_API_KEY so
                    // Usage-Monitor key attribution can split primary vs backup.
                    ...buildOpenRouterClassifier(this.env, {
                      service: this.name,
                      purpose: OPENROUTER_PURPOSE.VISION_EXTRACT,
                      feature: input.filing.chamber
                        ? `vision-extract-${input.filing.chamber}`
                        : 'vision-extract',
                      chamber: input.filing.chamber || undefined,
                      keyRef: 'OPENROUTER_BACKUP_API_KEY',
                      user: input.filing.docId || undefined,
                    }),
                  }),
                  signal: input.signal
                    ? AbortSignal.any([input.signal, AbortSignal.timeout(600_000)])
                    : AbortSignal.timeout(600_000),
                },
                this.name,
                { model, maxAttempts: 3, spendGuard: { env: this.env, provider: 'openrouter' } }
              );
              if (backupRes.ok) {
                await noteOpenRouterBudgetSuccess(this.env);
                return { payload: (await backupRes.json()) as OpenAIChatPayload };
              }
              let backupDetail = '';
              try {
                backupDetail = (await backupRes.text()).slice(0, 500);
              } catch {
                /* ignore */
              }
              if (isOpenRouterBudgetHttp(backupRes.status, backupDetail)) {
                const trip = await noteOpenRouterBudgetFailure(
                  this.env,
                  `HTTP ${backupRes.status} ${backupDetail}`,
                );
                throw new IngestRetryError(
                  `${this.name}: OpenRouter API ${backupRes.status} budget ${backupDetail.slice(0, 200)}`,
                  trip.delaySeconds,
                );
              }
            }

            const trip = await noteOpenRouterBudgetFailure(
              this.env,
              `HTTP ${res.status} ${detail}`,
            );
            throw new IngestRetryError(
              `${this.name}: OpenRouter API ${res.status} ${res.statusText} ${detail}`,
              trip.delaySeconds,
            );
          }
          const kind = classifyOpenRouterReply({
            httpStatus: res.status,
            statusText: res.statusText,
            bodyText: detail,
          });
          if (isDocScopedOpenRouterReply(kind)) {
            throw docScopedOpenRouterError(kind, `${res.status} ${res.statusText} ${detail}`);
          }
          throw new Error(`${this.name}: OpenRouter API ${res.status} ${res.statusText} ${detail}`);
        }

        await noteOpenRouterBudgetSuccess(this.env);
        return { payload: (await res.json()) as OpenAIChatPayload };
      };

      let call = await callOpenRouter(true);
      let degradedEngine = false;
      if ('rejection' in call) {
        // Account-level "Prevent overrides" (or an engine the account can't
        // request) rejected the request-level engine. Degrade to OpenRouter's
        // default selection (native → mistral-ocr) rather than failing.
        console.warn(
          `${this.name}: request-level engine '${engine}' rejected (${call.status}); retrying with default engine selection`,
        );
        degradedEngine = true;
        const retried = await callOpenRouter(false);
        if ('rejection' in retried) {
          throw new Error(`${this.name}: OpenRouter API ${retried.status} ${retried.rejection}`);
        }
        call = retried;
      }
      const { payload } = call;

      // Generation id for monitor-side spend verification. Never an empty
      // string — `payload.id` is either a real id or omitted entirely.
      providerRequestId = payload.id || undefined;
      totalPromptTokens = payload.usage?.prompt_tokens ?? 0;
      totalCompletionTokens = payload.usage?.completion_tokens ?? 0;
      totalCachedTokens = payload.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      if (typeof payload.usage?.cost === 'number' && Number.isFinite(payload.usage.cost) && payload.usage.cost >= 0) {
        providerCostUsd = payload.usage.cost;
      }
      if (payload.model) resolvedModel = payload.model;
      if (payload.id) providerRequestId = payload.id;

      const message = payload.choices?.[0]?.message;
      const text = message?.content ?? '';

      // Persist first-read annotations so every later read skips parsing fees.
      const responseAnnotations = message?.annotations;
      if (!isMistralOcr && docId && !storedAnnotations && Array.isArray(responseAnnotations) && responseAnnotations.length > 0) {
        await storeAnnotations(this.env, docId, responseAnnotations);
      }

      // Structured log of which parse path actually served this read.
      console.log(JSON.stringify({
        event: 'openrouter_pdf_read',
        docId,
        model,
        servedModel: payload.model ?? null,
        servedProvider: payload.provider ?? null,
        requestedEngine: isMistralOcr ? 'mistral-ocr(image_url)' : engine ?? 'native-or-default',
        degradedEngine,
        annotationsReused: Boolean(storedAnnotations),
        annotationsReturned: Array.isArray(responseAnnotations) ? responseAnnotations.length : 0,
        structuredOutput: structured,
        costUsd: providerCostUsd ?? null,
      }));

      const replyKind = classifyOpenRouterReply({
        httpStatus: 200,
        completionText: text,
      });
      if (isDocScopedOpenRouterReply(replyKind)) {
        throw docScopedOpenRouterError(replyKind, text || 'empty completion');
      }
      if (!text) {
        throw new Error(`${this.name}: OpenRouter returned no text block`);
      }

      combinedRaw = text;

      let parsedRows;
      let salvaged = false;
      const finishReason = payload.choices?.[0]?.finish_reason;
      try {
        const result = parseTruncationAwareJson(text, finishReason === 'length');
        parsedRows = result.rows;
        salvaged = result.salvaged;
      } catch (err) {
        throw new Error(`${this.name}: could not parse model JSON: ${(err as Error).message}`);
      }

      allRows = parsedRows.map(toParsedTx).map((tx: ParsedTx) => (salvaged ? markSalvaged(tx) : tx));
    } catch (err) {
      const usage =
        totalPromptTokens > 0 || totalCompletionTokens > 0 || pagesProcessed != null || providerCostUsd != null
          ? {
              promptTokens: totalPromptTokens,
              completionTokens: totalCompletionTokens,
              ...(totalCachedTokens > 0 ? { cachedTokens: totalCachedTokens } : {}),
              ...(pagesProcessed != null ? { pagesProcessed } : {}),
              ...(providerCostUsd != null ? { costUsd: providerCostUsd } : {}),
            }
          : undefined;
      // Attach the generation id even on a post-response failure (e.g. JSON
      // parse error) — the call was already billed and a downstream consumer
      // (bakeoff.ts's error path) reads providerRequestId off the thrown error.
      throw Object.assign(err as Error, { usage, resolvedModel, providerRequestId });
    }

    const docConfidence =
      allRows.length > 0
        ? allRows.reduce((s, r) => s + r.confidence, 0) / allRows.length
        : DEFAULT_CONFIDENCE;

    const usage =
      totalPromptTokens > 0 || totalCompletionTokens > 0 || pagesProcessed != null || providerCostUsd != null
        ? {
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            ...(totalCachedTokens > 0 ? { cachedTokens: totalCachedTokens } : {}),
            ...(pagesProcessed != null ? { pagesProcessed } : {}),
            ...(providerCostUsd != null ? { costUsd: providerCostUsd } : {}),
          }
        : undefined;

    const result = {
      transactions: allRows,
      confidence: docConfidence,
      raw: combinedRaw,
      extractor: this.name,
      modelVersion: resolvedModel,
      providerRequestId,
      usage,
      pageCount: pagesProcessed,
    };
    return result;
  }
}
