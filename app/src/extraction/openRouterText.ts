/**
 * Cheap text-only OpenRouter extract. Sends already-extracted PDF/HTML text
 * as a chat message. Never attaches `type: file` and never uses the
 * file-parser plugin — that is the $0.50 Files prepaid hold path.
 *
 * Default model is Flash-Lite. Typical typed PTR: a few thousand input
 * tokens + a short JSON completion, far below OPENROUTER_FILES_HOLD_USD.
 */

import type { Extractor, ExtractorInput, ExtractorResult } from '../extractors/types.ts';
import type { Env, Filing, ParsedTx } from '../shared/types.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import {
  OPENROUTER_PURPOSE,
  buildOpenRouterClassifier,
  openRouterAttributionHeaders,
} from '../shared/openRouterAttribution.ts';
import {
  OPENROUTER_EXTRACTION_RESPONSE_FORMAT,
  supportsStructuredOutputs,
} from './openRouterVision.ts';
import {
  assertOpenRouterBudgetCircuitAllowsCall,
  isOpenRouterBudgetHttp,
  noteOpenRouterBudgetFailure,
  noteOpenRouterBudgetSuccess,
} from '../shared/openRouterBudgetCircuit.ts';
import { IngestRetryError } from '../ingestion/fetcher.ts';
import {
  buildExtractionPrompt,
  fetchWithRetry,
  loadExtractionPromptContext,
  markSalvaged,
  parseTruncationAwareJson,
  toParsedTx,
} from './visionLlm.ts';
import {
  classifyOpenRouterReply,
  docScopedOpenRouterError,
  isDocScopedOpenRouterReply,
  type DocScopedOpenRouterKind,
} from './openRouterReply.ts';

export const OPENROUTER_TEXT_MODEL_DEFAULT = 'google/gemini-3.5-flash-lite';
const DEFAULT_CONFIDENCE = 0.55;
const MAX_TOKENS = 16000;
const MAX_TEXT_CHARS = 60_000;

export interface OpenRouterTextOptions {
  apiKey?: string;
  apiKeyName?: keyof Env & string;
  model?: string;
  defaultModel?: string;
  name?: string;
}

export class OpenRouterTextExtractor implements Extractor {
  readonly name: string;
  private readonly modelOverride?: string;
  private readonly defaultModel: string;
  private readonly apiKeyOverride?: string;
  private readonly apiKeyName: keyof Env & string;

  constructor(
    private readonly env: Env,
    options: OpenRouterTextOptions = {},
  ) {
    this.name = options.name ?? 'openRouterText';
    this.modelOverride = options.model;
    this.defaultModel = options.defaultModel ?? OPENROUTER_TEXT_MODEL_DEFAULT;
    this.apiKeyOverride = options.apiKey;
    this.apiKeyName = options.apiKeyName ?? 'OPENROUTER_API_KEY';
  }

  canHandle(f: Filing): boolean {
    return f.docKind === 'text_pdf' || f.docKind === 'senate_html';
  }

  private async resolveModel(): Promise<string> {
    // Do not inherit OPENROUTER_MODEL (often Grok / Files). Cheap text stays
    // on Flash-Lite unless a caller passes an explicit model override.
    if (this.modelOverride) return this.modelOverride;
    return this.defaultModel;
  }

  async extract(input: ExtractorInput): Promise<ExtractorResult> {
    const key = this.apiKeyOverride ?? (await resolveSecret(this.env, this.apiKeyName)).value;
    if (!key) throw new Error(`${this.name}: API key is not configured`);

    const extractedText = (input.extractedText ?? input.html ?? '').trim();
    if (!extractedText) {
      throw new Error(`${this.name}: no extracted text provided (refusing Files fallback)`);
    }

    const model = await this.resolveModel();
    const promptContext = await loadExtractionPromptContext(this.env, input.filing);
    const promptToUse = buildExtractionPrompt(promptContext);
    const clipped = extractedText.length > MAX_TEXT_CHARS
      ? extractedText.slice(0, MAX_TEXT_CHARS)
      : extractedText;
    const structured = supportsStructuredOutputs(model);
    const classifierEnrichment = buildOpenRouterClassifier(this.env, {
      service: this.name,
      purpose: OPENROUTER_PURPOSE.TEXT_EXTRACT,
      feature: input.filing.chamber ? `text-extract-${input.filing.chamber}` : 'text-extract',
      chamber: input.filing.chamber || undefined,
      keyRef: this.apiKeyName,
      user: input.filing.docId || undefined,
    });

    const requestHeaders = {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...openRouterAttributionHeaders(),
    };
    const requestBody = JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      response_format: structured
        ? OPENROUTER_EXTRACTION_RESPONSE_FORMAT
        : { type: 'json_object' },
      usage: { include: true },
      ...(structured ? { provider: { require_parameters: true } } : {}),
      plugins: [{ id: 'response-healing' }],
      messages: [
        {
          role: 'user',
          content: `${promptToUse}\n\nDOCUMENT TEXT (already extracted locally — do not invent trades from letterhead or column headers):\n${clipped}\n\nReturn ONLY the JSON object.`,
        },
      ],
      ...classifierEnrichment,
    });

    let lastDocScoped: { kind: DocScopedOpenRouterKind; detail: string } | null = null;
    let payload: {
      id?: string;
      model?: string;
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        cost?: number;
        prompt_tokens_details?: { cached_tokens?: number } | null;
      };
    } | null = null;
    let text = '';

    // One cheap retry on a garbage / Unauthorized reply, then skip this doc.
    // Proven dead-key rejections throw immediately and stay fail-closed.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await assertOpenRouterBudgetCircuitAllowsCall(this.env);
      const res = await fetchWithRetry(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          headers: requestHeaders,
          body: requestBody,
          signal: input.signal
            ? AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
            : AbortSignal.timeout(120_000),
        },
        this.name,
        { model, maxAttempts: 3, spendGuard: { env: this.env, provider: 'openrouter' } },
      );

      if (!res.ok) {
        let detail = '';
        try {
          detail = (await res.text()).slice(0, 500);
        } catch {
          /* ignore */
        }
        const kind = classifyOpenRouterReply({
          httpStatus: res.status,
          statusText: res.statusText,
          bodyText: detail,
        });
        if (isDocScopedOpenRouterReply(kind)) {
          lastDocScoped = { kind, detail: `${res.status} ${res.statusText} ${detail}` };
          continue;
        }
        if (isOpenRouterBudgetHttp(res.status, detail)) {
          const trip = await noteOpenRouterBudgetFailure(this.env, `HTTP ${res.status} ${detail}`);
          throw new IngestRetryError(
            `${this.name}: OpenRouter API ${res.status} ${res.statusText} ${detail}`,
            trip.delaySeconds,
          );
        }
        throw new Error(`${this.name}: OpenRouter API ${res.status} ${res.statusText} ${detail}`);
      }

      await noteOpenRouterBudgetSuccess(this.env);
      payload = await res.json() as {
        id?: string;
        model?: string;
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          cost?: number;
          prompt_tokens_details?: { cached_tokens?: number } | null;
        };
      };
      text = payload.choices?.[0]?.message?.content ?? '';
      const kind = classifyOpenRouterReply({
        httpStatus: res.status,
        statusText: res.statusText,
        completionText: text,
      });
      if (isDocScopedOpenRouterReply(kind)) {
        lastDocScoped = { kind, detail: text || 'empty completion' };
        continue;
      }
      break;
    }

    if (!payload || !text) {
      if (lastDocScoped) {
        throw docScopedOpenRouterError(lastDocScoped.kind, lastDocScoped.detail);
      }
      throw new Error(`${this.name}: OpenRouter returned no text block`);
    }

    const parsed = parseTruncationAwareJson(text, payload.choices?.[0]?.finish_reason === 'length');
    const allRows: ParsedTx[] = parsed.rows.map(toParsedTx).map((tx) => (
      parsed.salvaged ? markSalvaged(tx) : tx
    ));
    const docConfidence = allRows.length > 0
      ? allRows.reduce((sum, row) => sum + row.confidence, 0) / allRows.length
      : DEFAULT_CONFIDENCE;
    const promptTokens = payload.usage?.prompt_tokens ?? 0;
    const completionTokens = payload.usage?.completion_tokens ?? 0;
    const cachedTokens = payload.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const costUsd = typeof payload.usage?.cost === 'number' && Number.isFinite(payload.usage.cost)
      ? payload.usage.cost
      : undefined;

    return {
      transactions: allRows,
      confidence: docConfidence,
      raw: text,
      extractor: this.name,
      modelVersion: payload.model ?? model,
      providerRequestId: payload.id || undefined,
      usage: (promptTokens > 0 || completionTokens > 0 || costUsd != null)
        ? {
            promptTokens,
            completionTokens,
            ...(cachedTokens > 0 ? { cachedTokens } : {}),
            ...(costUsd != null ? { costUsd } : {}),
          }
        : undefined,
    };
  }
}
