/**
 * src/extraction/visionLlm.ts
 * OWNER: extraction agent
 *
 * Vision/LLM extractor for scanned-image PDFs (docKind 'scanned_pdf').
 *
 * Many House PTRs are scanned, hand-annotated paper forms with no text layer.
 * We send the raw PDF bytes (Gemini accepts application/pdf inline) to Google
 * Gemini's generateContent endpoint with a strict JSON responseSchema and parse
 * the structured array of transactions back into ParsedTx[].
 *
 * Design goals:
 *   - ONE network call per document (keep token use low).
 *   - Deterministic, schema-constrained output (responseMimeType JSON).
 *   - Conservative confidence so most scanned docs route to human review.
 *   - On any API/parse failure: throw, so the pipeline marks the filing errored.
 */

import { jsonrepair } from 'jsonrepair';
import type { Extractor, ExtractorInput, ExtractorResult } from '../extractors/types.ts';
import type { Env, Filing, Owner, ParsedTx, TxType } from '../shared/types.ts';
import { parseAmountRange } from './amounts.ts';
import { PDFDocument } from 'pdf-lib';
import { resolveSecret } from '../secrets/infisical.ts';
import { get } from '../shared/db.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import { assertLlmSpendWithinCeiling, settleLlmSpend } from '../shared/llmSpend.ts';
import { GoogleGenAI } from '@google/genai';
import { candidateSpendUsd } from './bakeoff.ts';

/**
 * Per-isolate sliding-window request throttle for the Gemini free/low tiers.
 * Only engages when GEMINI_RPM_LIMIT is set; isolates do not coordinate, so
 * treat the limit as per-isolate (set it below the account cap when scaling).
 */
class RateLimiter {
  private queue: number[] = [];

  async wait(rpmLimitStr: string | undefined) {
    if (!rpmLimitStr) return;
    const rpm = parseInt(rpmLimitStr, 10);
    if (isNaN(rpm) || rpm <= 0) return;

    const now = Date.now();
    this.queue = this.queue.filter(t => now - t < 60000);

    if (this.queue.length >= rpm) {
      const oldest = this.queue[0];
      const waitTime = 60000 - (now - oldest);
      if (waitTime > 0) {
        await new Promise(r => setTimeout(r, waitTime));
      }
    }
    this.queue.push(Date.now());
  }
}

const geminiRateLimiter = new RateLimiter();

/**
 * Gemini model id. Centralized + documented so it is trivial to bump.
 * NOTE: Flash model ids rotate; if calls start 404-ing, update this to the
 * current Flash generation — the request/response contract below is unchanged
 * across Flash generations. Current as of 2026-09: 'gemini-3.8-flash'.
 * Override via env var VISION_PRIMARY_MODEL.
 */
const DEFAULT_MODEL = 'gemini-3.8-flash';



/** Default confidence floor for vision output (most route to review). */
const DEFAULT_CONFIDENCE = 0.6;

/** Optional overrides for building a second, independent vision extractor. */
export interface VisionLlmOptions {
  /** API key to use instead of env.GEMINI_API_KEY (e.g. ARBITRATION_API_KEY). */
  apiKey?: string;
  /** Runtime secret name to resolve when apiKey is not supplied. */
  apiKeyName?: keyof Env & string;
  /** Model id to use instead of the default (a different model = real cross-check). */
  model?: string;
  /** Config name resolved at extraction time when `model` is not supplied
   *  (Infisical first, env fallback) — so model choice is live-tunable. */
  modelEnvName?: keyof Env & string;
  /** Fallback model when neither `model` nor the resolved config name is set. */
  defaultModel?: string;
  /** Override extractor name (so arbitration can tell the two apart). */
  name?: string;
  /** The caller owns paid-response settlement (used by runCandidateOnDoc). */
  meterExternally?: boolean;
}

export class VisionLlmExtractor implements Extractor {
  readonly name: string;
  private readonly modelOverride?: string;
  private readonly modelEnvName: keyof Env & string;
  private readonly defaultModel: string;
  private readonly apiKeyOverride?: string;
  private readonly apiKeyName: keyof Env & string;
  private readonly meterExternally: boolean;

  constructor(
    private readonly env: Env,
    options: VisionLlmOptions = {},
  ) {
    this.name = options.name ?? 'visionLlm';
    this.modelOverride = options.model;
    this.modelEnvName = options.modelEnvName ?? 'VISION_PRIMARY_MODEL';
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL;
    this.apiKeyOverride = options.apiKey;
    this.apiKeyName = options.apiKeyName ?? 'GEMINI_API_KEY';
    this.meterExternally = options.meterExternally ?? false;
  }

  canHandle(f: Filing): boolean {
    return f.docKind === 'scanned_pdf';
  }

  /** Explicit override > Infisical/env config name > default. Resolved per
   *  extraction so a model swap in Infisical applies without a redeploy. */
  private async resolveModel(): Promise<string> {
    if (this.modelOverride) return this.modelOverride;
    try {
      return (await resolveSecret(this.env, this.modelEnvName)).value || this.defaultModel;
    } catch {
      return (this.env[this.modelEnvName] as string | undefined) || this.defaultModel;
    }
  }

    async extract(input: ExtractorInput): Promise<ExtractorResult> {
    // GOVERNOR 1: the Gemini SDK path performs its own fetches (it cannot ride
    // the fetchWithRetry spend guard), so gate the whole extraction here.
    // Throws a terminal LlmBudgetExceededError (error-class 'budget').
    await assertLlmSpendWithinCeiling(this.env, 'gemini');
let keyString = this.apiKeyOverride ?? (await resolveSecret(this.env, this.apiKeyName)).value;
    if (!keyString && this.apiKeyName === 'GEMINI_API_KEY') {
      keyString = (await resolveSecret(this.env, 'CT_GEMINI_API_KEY' as any)).value;
    }
    if (!keyString) throw new Error(`${this.name}: API key is not configured`);
    // The key secret may hold several comma-separated keys; rotate to the next
    // one when a request fails (rate limit / quota) instead of giving up.
    const keys = keyString.split(',').map(k => k.trim()).filter(Boolean);
    if (!input.bytes) throw new Error(`${this.name}: no bytes provided on ExtractorInput`);

    const model = await this.resolveModel();
    const accountingAttemptId = crypto.randomUUID();
    const accountingOccurredAt = new Date().toISOString();

    // Check if we need to chunk (only for scanned_pdf which is all this extractor handles)
    let chunks: ArrayBuffer[] = [input.bytes];
    let pageCount = 0;
    
    // Dynamically skip chunking for models with massive context windows:
    // - All Gemini models (1.5, 2.0, 2.5, 3.0, 3.5 - any variant)
    // - All Claude 3+ models (claude-3, claude-sonnet, claude-opus, etc.)
    // - GPT-4o and later (gpt-4o, gpt-4.1, gpt-5, o1, o3, o4)
    // - Any model accessed via OpenRouter (since OpenRouter handles PDF processing natively server-side)
    const lowerModel = model.toLowerCase();
    const isMassiveContextModel =
      lowerModel.includes('gemini') ||
      lowerModel.includes('claude-3') ||
      lowerModel.includes('claude-sonnet') ||
      lowerModel.includes('claude-opus') ||
      lowerModel.includes('claude-haiku') ||
      lowerModel.includes('gpt-4o') ||
      lowerModel.includes('gpt-4.1') ||
      lowerModel.includes('gpt-5') ||
      /(^|[\/:])(o1|o3|o4)/.test(lowerModel) ||
      lowerModel.includes('openrouter');

    try {
      const pdfDoc = await PDFDocument.load(input.bytes, { ignoreEncryption: true });
      pageCount = pdfDoc.getPageCount();
      const MAX_PAGES = 50;
      if (pageCount > MAX_PAGES && !isMassiveContextModel) {
        chunks = [];
        for (let i = 0; i < pageCount; i += MAX_PAGES) {
          const end = Math.min(i + MAX_PAGES, pageCount);
          const newPdf = await PDFDocument.create();
          const copiedPages = await newPdf.copyPages(pdfDoc, Array.from({ length: end - i }, (_, idx) => i + idx));
          copiedPages.forEach((page) => newPdf.addPage(page));
          const newBytes = await newPdf.save();
          chunks.push((newBytes.buffer as ArrayBuffer).slice(newBytes.byteOffset, newBytes.byteOffset + newBytes.byteLength));
        }
      }
    } catch (err) {
      console.warn(`${this.name}: Failed to parse PDF for chunking (${(err as Error).message}), falling back to raw bytes`);
    }

    let allRows: ParsedTx[] = [];
    let combinedRaw = '';
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCachedTokens = 0;
    let resolvedModel = model;
    let providerRequestId: string | undefined;

    // Metadata-grounded prompt: known filing facts (chamber, form type, filed
    // year, page count, filer name) orient the model on the form layout.
    const promptContext = await loadExtractionPromptContext(
      this.env,
      input.filing,
      pageCount > 0 ? pageCount : undefined,
    );
    const prompt = buildExtractionPrompt(promptContext);

    for (let i = 0; i < chunks.length; i++) {
      try {
        const chunkBytes = chunks[i];

        let res;
        let lastError: Error | null = null;
        let jsonText = '';

        for (const k of keys) {
          try {
            await geminiRateLimiter.wait(this.env.GEMINI_RPM_LIMIT);
            const ai = new GoogleGenAI({ apiKey: k });
            
            res = await ai.models.generateContent({
              model: model,
              contents: [
                {
                  role: 'user',
                  parts: [
                    { text: prompt },
                    {
                      inlineData: {
                        mimeType: 'application/pdf',
                        data: arrayBufferToBase64(chunkBytes),
                      },
                    },
                  ],
                },
              ],
              config: {
                abortSignal: input.signal,
                temperature: 0,
                responseMimeType: 'application/json',
                responseSchema: RESPONSE_SCHEMA as any,
              }
            });

            if (res.modelVersion) {
              resolvedModel = res.modelVersion;
            }
            if ((res as any).responseId) {
              providerRequestId = (res as any).responseId;
            }

            jsonText = res.text || '';

            if (res.usageMetadata) {
              totalPromptTokens += res.usageMetadata.promptTokenCount ?? 0;
              totalCompletionTokens +=
                (res.usageMetadata.candidatesTokenCount ?? 0) +
                (res.usageMetadata.thoughtsTokenCount ?? 0);
              totalCachedTokens += res.usageMetadata.cachedContentTokenCount ?? 0;
            }
            
            if (!jsonText) {
              throw new Error(`${this.name}: Gemini returned no candidate text for chunk ${i + 1}/${chunks.length}`);
            }

            lastError = null;
            break;
          } catch (e: any) {
            lastError = e as Error;
            continue;
          }
        }

        if (!res || lastError) {
          throw lastError ?? new Error(`${this.name}: all API keys failed`);
        }

        combinedRaw += (i > 0 ? '\n\n--- CHUNK ---\n\n' : '') + jsonText;

        let parsed;
        try {
          parsed = parseModelJson(jsonText);
        } catch (err) {
          throw new Error(`${this.name}: could not parse model JSON in chunk ${i + 1}/${chunks.length}: ${(err as Error).message}`);
        }

        allRows.push(...parsed.map(toParsedTx));
      } catch (error) {
        // Any prior successful chunk was already billed. Attach the aggregate
        // provider usage to every later failure path (HTTP, JSON decode,
        // response validation, or row mapping), not only model-JSON failures.
        const failure = error instanceof Error ? error : new Error(String(error));
        const usage = totalPromptTokens + totalCompletionTokens + totalCachedTokens > 0
          ? {
              promptTokens: totalPromptTokens,
              completionTokens: totalCompletionTokens,
              cachedTokens: totalCachedTokens,
            }
          : undefined;
        if (usage && !this.meterExternally) {
          await settleLlmSpend(this.env, {
            provider: 'gemini',
            requestedModel: model,
            resolvedModel,
            providerResponseId: chunks.length === 1 ? providerRequestId : null,
            attemptId: accountingAttemptId,
            docId: input.filing.docId,
            usd: candidateSpendUsd('gemini', model, resolvedModel, usage) ?? 0,
            occurredAt: accountingOccurredAt,
          });
        }
        throw Object.assign(failure, {
          ...(usage ? { usage } : {}),
          resolvedModel,
          providerRequestId,
        });
      }
    }

    const docConfidence =
      allRows.length > 0
        ? allRows.reduce((s, r) => s + r.confidence, 0) / allRows.length
        : DEFAULT_CONFIDENCE;

    const usage = totalPromptTokens > 0 || totalCompletionTokens > 0
      ? {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          cachedTokens: totalCachedTokens,
        }
      : undefined;

    if (usage && !this.meterExternally) {
      await settleLlmSpend(this.env, {
        provider: 'gemini',
        requestedModel: model,
        resolvedModel,
        providerResponseId: chunks.length === 1 ? providerRequestId : null,
        attemptId: accountingAttemptId,
        docId: input.filing.docId,
        usd: candidateSpendUsd('gemini', model, resolvedModel, usage) ?? 0,
        occurredAt: accountingOccurredAt,
      });
    }

    return {
      transactions: allRows,
      confidence: docConfidence,
      raw: combinedRaw,
      extractor: this.name,
      modelVersion: resolvedModel,
      providerRequestId,
      usage,
    };
  }
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

/** Stable identifier for the extraction instructions sent to vision models.
 *  BUMP DISCIPLINE: any change to SYSTEM_PROMPT / EXECUTIVE_SYSTEM_PROMPT /
 *  buildExtractionPrompt's grounding block requires a new version string. */
export const EXTRACTION_PROMPT_VERSION = 'stock-act-ptr-v5-grounded';

export const SYSTEM_PROMPT = `You are a meticulous data-extraction engine for U.S. congressional STOCK Act
Periodic Transaction Reports (PTRs). The attached document is a scanned PTR.
Extract EVERY disclosed transaction row. For each transaction return:
- txDate: the transaction date in YYYY-MM-DD (use the EXACT transaction/trade date column, NOT the notification date. Do not guess). null if illegible.
- owner: one of "self","spouse","joint","dependent" (map SP->spouse, DC->dependent, JT->joint, blank/self->self).
- assetName: the security/asset name as written. null if illegible.
- ticker: the stock ticker symbol in UPPERCASE. Look VERY CAREFULLY in the asset description column, often in parentheses like (AAPL) or a standalone column. Do not miss the ticker if it is visible. null only if it is truly missing.
- assetType: short asset-type code/label if shown (e.g. "ST","OP","Stock","Option"), else null.
- assetTypeName: expanded asset-type name if the document or code is clear, else null.
- txType: one of "B" (Buy/Purchase), "S" (Sell/Sale), "E" (Exchange). Map "Purchase"/"P"/"Buy" to "B". Map "Sale (Full)", "Sale (Partial)" or "S (partial)" to "S". Pay extremely close attention to the Transaction Type column; do not hallucinate "B" if it says "S" or "Sale". null if illegible.
- amountRange: the disclosed amount bracket exactly as printed, e.g. "$1,001 - $15,000" or "$50,000,001 +". These amounts are CHECKBOX BANDS: identify WHICH band column is marked and transcribe that band's own printed range. If you cannot tell which column is marked, or the band-to-dollar legend is too small/blurred to read at this resolution, return null. NEVER guess, and never fall back to the first or most common band — a null amount is correct when the band is not readable.
- isOption: true if the holding is an option/call/put/warrant.
- capGainsOver200: true only if a ">$200" capital-gains box/flag is checked.
- filingStatus: row-specific filing status such as "New", if shown.
- subholding: row-specific account/subholding text, if shown.
- location: row-specific location text, if shown.
- description: row-specific description text, if shown.
- supplementalText: remaining row-specific notes/details that are not already captured; do not include page titles, headers, footers, or generic instructions.
- confidence: YOUR confidence for this row in [0,1], lowering it when handwriting or scan quality is poor.
Return ONLY the structured JSON array. Do not guess values you cannot read; use null instead.`;

export const EXECUTIVE_SYSTEM_PROMPT = `You are a meticulous data-extraction engine for U.S. Executive Branch OGE Form 278-T Periodic Transaction Reports.
The attached document is a scanned OGE Form 278-T.
Extract EVERY disclosed transaction row. For each transaction return:
- txDate: the transaction date in YYYY-MM-DD (use the EXACT "Transaction Date", NOT the "Notification Date". Do not guess). null if illegible.
- owner: one of "self","spouse","joint","dependent" (if unspecified or blank, use "self").
- assetName: the security/asset name as written (often under "Description"). null if illegible.
- ticker: the stock ticker symbol in UPPERCASE. Look VERY CAREFULLY in the asset description column, often in parentheses like (AAPL) or a standalone column. Do not miss the ticker if it is visible. null only if it is truly missing.
- assetType: short asset-type code/label if shown (e.g. "Stock", "Option"), else null.
- assetTypeName: expanded asset-type name if the document or code is clear, else null.
- txType: one of "B" (Buy/Purchase), "S" (Sell/Sale), "E" (Exchange). Map "Purchase"/"P"/"Buy" to "B", "Sale"/"Sell"/"Sale (Partial)" to "S", "Exchange" to "E". Pay extremely close attention to the Transaction Type column; do not hallucinate "B" if it says "S" or "Sale". null if illegible.
- amountRange: the disclosed amount bracket exactly as printed, e.g. "$1,001 - $15,000" or "$15,001 - $50,000". These amounts are CHECKBOX BANDS: identify WHICH band column is marked and transcribe that band's own printed range. If you cannot tell which column is marked, or the band-to-dollar legend is too small/blurred to read at this resolution, return null. NEVER guess, and never fall back to the first or most common band — a null amount is correct when the band is not readable.
- isOption: true if the holding is an option/call/put/warrant.
- capGainsOver200: false (rarely applicable on OGE forms).
- filingStatus: row-specific filing status such as "New", if shown.
- subholding: row-specific account/subholding text, if shown.
- location: row-specific location text, if shown.
- description: row-specific description text, if shown.
- supplementalText: capture the "Notification Date" or other notes here.
- confidence: YOUR confidence for this row in [0,1], lowering it when handwriting or scan quality is poor.
Return ONLY the structured JSON array. Do not guess values you cannot read; use null instead.`;

// ---------------------------------------------------------------------------
// Metadata-grounded prompts (EXTRACTION_PROMPT_VERSION 'stock-act-ptr-v3-grounded')
//
// The ingestion pipeline already KNOWS several facts about every filing
// (chamber, form-type code, filed date, page count, registered filer name)
// before any model reads it. Injecting them lets the models orient on the
// correct form layout instead of guessing it blind — a measured driver of
// cross-model disagreement on scanned PTRs. The grounding block is strictly
// orienting context: models are told to never invent rows from it and to
// never let it override what the document itself shows.
// ---------------------------------------------------------------------------

export interface ExtractionPromptContext {
  chamber?: string | null;
  /** Filing-type code as ingested (e.g. 'P' for a PTR, 'A' for an amendment). */
  filingType?: string | null;
  /** ISO date (or date-time) the filing was filed; only the year is injected. */
  filedDate?: string | null;
  pageCount?: number | null;
  /** Filer name as registered in the filers table. */
  filerName?: string | null;
}

function chamberFact(chamber: string | null | undefined): string | null {
  if (chamber === 'house') return 'Chamber: U.S. House of Representatives (House PTR form)';
  if (chamber === 'senate') return 'Chamber: U.S. Senate (Senate PTR form)';
  if (chamber === 'executive') return 'Chamber: Executive Branch (OGE Form 278-T)';
  return null;
}

/**
 * Select the chamber-appropriate base prompt and append the KNOWN DOCUMENT
 * FACTS grounding block for whichever metadata is available. With no usable
 * metadata the base prompt is returned unchanged.
 */
export function buildExtractionPrompt(context: ExtractionPromptContext = {}): string {
  const base = context.chamber === 'executive' ? EXECUTIVE_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const facts: string[] = [];
  const chamber = chamberFact(context.chamber);
  if (chamber) facts.push(chamber);
  const filingType = context.filingType?.trim();
  if (filingType) facts.push(`Filing-type code: ${filingType.slice(0, 24)}`);

  if (typeof context.pageCount === 'number' && Number.isFinite(context.pageCount) && context.pageCount > 0) {
    facts.push(`Document page count: ${Math.round(context.pageCount)}`);
  }
  const filerName = context.filerName?.trim();
  if (filerName) facts.push(`Filer name (as registered): ${filerName.slice(0, 120)}`);
  if (!facts.length) return base;
  return `${base}\n\nKNOWN DOCUMENT FACTS (verified ingestion metadata — use them to orient on the correct form layout and to disambiguate hard-to-read header fields; NEVER invent transactions from them, and NEVER let them override what the document itself legibly shows):\n${facts.map((fact) => `- ${fact}`).join('\n')}`;
}

/**
 * Assemble the prompt context for a filing, filling gaps from D1 best-effort
 * (filings row for filing_type/filed_date/page_count, filers row for the
 * registered name). Never throws and never blocks extraction: with no DB (or
 * a partial synthetic filing, as in the bake-off harness) it simply returns
 * whatever facts are already on the filing object.
 */
export async function loadExtractionPromptContext(
  env: Env | undefined,
  filing: Partial<Filing> | undefined,
  pageCountHint?: number | null,
): Promise<ExtractionPromptContext> {
  const context: ExtractionPromptContext = {
    chamber: filing?.chamber ?? null,
    filingType: filing?.filingType ?? null,
    filedDate: filing?.filedDate ?? null,
    pageCount: pageCountHint ?? null,
  };
  const docId = filing?.docId;
  if (!env?.DB || !docId) return context;
  try {
    const row = await get<{
      chamber: string | null;
      filing_type: string | null;
      filed_date: string | null;
      page_count: number | null;
      filer_id: string | null;
    }>(
      env.DB,
      'SELECT chamber, filing_type, filed_date, page_count, filer_id FROM filings WHERE doc_id = ?',
      [docId],
    );
    if (row) {
      context.chamber = context.chamber ?? row.chamber;
      context.filingType = context.filingType ?? row.filing_type;
      context.filedDate = context.filedDate ?? row.filed_date;
      if (context.pageCount == null && row.page_count != null) context.pageCount = row.page_count;
      const filerId = filing?.filerId ?? row.filer_id;
      if (filerId) {
        const filer = await get<{ full_name: string | null }>(
          env.DB,
          'SELECT full_name FROM filers WHERE bioguide_id = ?',
          [filerId],
        );
        if (filer?.full_name) context.filerName = filer.full_name;
      }
    }
  } catch {
    // Pre-migration DB / lookup hiccup: extraction proceeds with what we have.
  }
  return context;
}

/** Gemini responseSchema constraining output to our transaction array. */
const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      txDate: { type: 'STRING', nullable: true },
      owner: { type: 'STRING', enum: ['self', 'spouse', 'joint', 'dependent'], nullable: true },
      assetName: { type: 'STRING', nullable: true },
      ticker: { type: 'STRING', nullable: true },
      assetType: { type: 'STRING', nullable: true },
      assetTypeName: { type: 'STRING', nullable: true },
      txType: { type: 'STRING', enum: ['B', 'S', 'E', 'P'], nullable: true },
      amountRange: { type: 'STRING', nullable: true },
      isOption: { type: 'BOOLEAN', nullable: true },
      capGainsOver200: { type: 'BOOLEAN', nullable: true },
      filingStatus: { type: 'STRING', nullable: true },
      subholding: { type: 'STRING', nullable: true },
      location: { type: 'STRING', nullable: true },
      description: { type: 'STRING', nullable: true },
      supplementalText: { type: 'STRING', nullable: true },
      confidence: { type: 'NUMBER' },
    },
    required: ['assetName', 'txType', 'amountRange', 'isOption', 'capGainsOver200'],
  },
} as const;



// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

interface ModelTx {
  txDate?: string | null;
  owner?: string | null;
  assetName?: string | null;
  ticker?: string | null;
  assetType?: string | null;
  assetTypeName?: string | null;
  txType?: string | null;
  amountRange?: string | null;
  isOption?: boolean | null;
  capGainsOver200?: boolean | null;
  filingStatus?: string | null;
  subholding?: string | null;
  location?: string | null;
  description?: string | null;
  supplementalText?: string | null;
  confidence?: number;
}

function extractJsonFallback(text: string): unknown {
  const startIdx = text.search(/[[{]/);
  if (startIdx === -1) return undefined;
  
  const targetText = text.substring(startIdx);
  const openChar = targetText[0];
  const closeChar = openChar === '[' ? ']' : '}';
  
  let depth = 0;
  let inString = false;
  let escape = false;
  
  // 1. Try to find a balanced block first
  for (let i = 0; i < targetText.length; i++) {
    const char = targetText[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    
    if (!inString) {
      if (char === openChar) depth++;
      else if (char === closeChar) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(targetText.substring(0, i + 1));
          } catch {
            break; // Fall through to jsonrepair
          }
        }
      }
    }
  }

  // 2. If balanced block extraction failed, fallback to jsonrepair
  try {
    const repaired = jsonrepair(targetText);
    return JSON.parse(repaired);
  } catch (err) {
    console.warn('visionLlm: jsonrepair fallback failed:', (err as Error).message);
    return undefined;
  }
}

export function parseModelJson(text: string): ModelTx[] {
  let cleaned = text.trim();
  // Strip ```json ... ``` fences if the model wrapped them despite the schema.
  cleaned = cleaned.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  
  let value: unknown;
  let parseError: Error | undefined;
  try {
    value = JSON.parse(cleaned);
  } catch (err) {
    parseError = err as Error;
  }

  // If initial JSON.parse failed, try to find a valid JSON array or object
  if (value === undefined) {
    value = extractJsonFallback(cleaned);

    if (value === undefined) {
      throw new Error(`visionLlm: could not parse model JSON: ${parseError?.message}`);
    }
  }

  if (Array.isArray(value)) return value as ModelTx[];
  // Some responses wrap the array, e.g. { transactions: [...] }.
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) return v as ModelTx[];
    }
  }
  throw new Error('visionLlm: model JSON was not a transaction array');
}

/**
 * Locate the first `[` or `{` character in `text` that is not inside a JSON
 * string literal. Returns -1 when the bracket never appears. Shared by
 * {@link salvageTruncatedTransactions} to find the transaction array even
 * when it is nested inside a wrapper object (e.g. `{"transactions": [...]}`).
 */
function firstUnquotedBracket(text: string, bracket: '[' | '{'): number {
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && char === bracket) return i;
  }
  return -1;
}

/**
 * Bounded salvage for a provider response that was cut off mid-output (e.g.
 * Anthropic `stop_reason: 'max_tokens'`). Recovers every COMPLETE leading
 * transaction object from the (possibly truncated) JSON array and drops the
 * trailing partial row, instead of failing the whole read. Reuses the
 * balanced-bracket scanning approach of {@link extractJsonFallback}, but scans
 * per-array-element rather than for one top-level structure so a truncated
 * final element does not poison the rows found before it.
 *
 * Handles both a bare `[...]` array and a wrapper object
 * `{"transactions": [...]}` (the shape returned when the JSON schema wraps
 * the array) — it locates the first unquoted `[` in the text and salvages
 * elements from there. Returns `[]` when no array start is found or no
 * element ever completes (e.g. the output was cut off before the first row).
 */
export function salvageTruncatedTransactions(text: string): ModelTx[] {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();

  const arrayStart = firstUnquotedBracket(cleaned, '[');
  if (arrayStart === -1) return [];

  const rows: ModelTx[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let elemStart = -1;

  for (let i = arrayStart + 1; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{' || char === '[') {
      if (depth === 0) elemStart = i;
      depth++;
      continue;
    }
    if (char === '}' || char === ']') {
      if (depth === 0) {
        // The array's own closing bracket (or a stray one) — nothing more to
        // salvage either way.
        break;
      }
      depth--;
      if (depth === 0 && elemStart !== -1) {
        const candidate = cleaned.slice(elemStart, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            rows.push(parsed as ModelTx);
          }
        } catch {
          // A malformed "complete" element means the scan lost sync with the
          // real structure (extremely unlikely given balanced-bracket
          // tracking); stop rather than risk salvaging out-of-order rows.
          break;
        }
        elemStart = -1;
      }
    }
  }
  return rows;
}

/** Result of a truncation-aware parse: rows plus whether salvage kicked in. */
export interface TruncationAwareParseResult {
  rows: ModelTx[];
  /** True when the full JSON failed to parse and rows were recovered via salvage. */
  salvaged: boolean;
}
export type AnthropicParseResult = TruncationAwareParseResult;

/**
 * Attempts to parse LLM JSON output. If the text fails to parse AND the provider
 * indicated a truncation reason, attempts to salvage the valid leading rows.
 */
export function parseTruncationAwareJson(
  text: string,
  isProviderTruncated: boolean = false,
): TruncationAwareParseResult {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();

  try {
    const rows = JSON.parse(cleaned);
    if (Array.isArray(rows)) return { rows: rows as ModelTx[], salvaged: false };
    if (rows && typeof rows === 'object') {
      const obj = rows as Record<string, unknown>;
      for (const v of Object.values(obj)) {
        if (Array.isArray(v)) return { rows: v as ModelTx[], salvaged: false };
      }
    }
  } catch (err) {
    const isActuallyTruncated = !cleaned.endsWith(']') && !cleaned.endsWith('}');
    if (isActuallyTruncated) {
      if (isProviderTruncated) {
        const salvaged = salvageTruncatedTransactions(text);
        if (salvaged.length > 0) return { rows: salvaged, salvaged: true };
        throw new Error('visionLlm: truncated output (max_tokens) could not be salvaged');
      }
      throw new Error(`visionLlm: could not parse model JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { rows: parseModelJson(text), salvaged: false };
}

export const parseAnthropicModelJson = (text: string, stopReason?: string | null) => 
  parseTruncationAwareJson(text, stopReason === 'max_tokens');

/** Append the salvaged-output provenance marker without duplicating it. */
export function markSalvaged(tx: ParsedTx): ParsedTx {
  const warnings = tx.extractionWarnings ?? [];
  if (warnings.includes('salvaged_truncated_output')) return tx;
  return { ...tx, extractionWarnings: [...warnings, 'salvaged_truncated_output'] };
}

/**
 * Validate PDF bytes before they are base64-encoded into an Anthropic
 * `document` block, WITHOUT altering them. Anthropic's API 400s outright on
 * some malformed PDFs (a production Senate-corpus drain hit 8 hard failures
 * from invalid PDF objects in one run), so pdf-lib's loader is used as a
 * pre-flight parseability check; `ignoreEncryption` keeps
 * encrypted-but-otherwise-valid PDFs from being rejected as corrupt.
 *
 * The ORIGINAL bytes are returned unchanged on success. Bytes are NOT
 * resaved/re-serialized here by default: a 2026-07-15 production receipt
 * (doc H-2026-20034954; Anthropic request ids req_011Cd4nNWmv3LPBZwfys7KhM
 * and req_011Cd4nNpBAjfCCXj29EqSF7) showed Anthropic's PDF parser rejecting
 * pdf-lib's re-serialized output — with `400 invalid_request_error: "...
 * pdf.source.base64.data: The PDF specified was not valid."` — for a document
 * it had previously read successfully in its ORIGINAL form. Unconditionally
 * substituting resaved bytes (the pre-2026-07-15 behavior) traded that
 * regression for the invalid-PDF fix it was meant to provide. Resaving is now
 * a repair fallback only, tried after the original bytes are rejected (see
 * {@link resavePdfForAnthropic} and {@link isAnthropicInvalidPdfError}).
 *
 * Throws a stable, secret-safe error (no raw pdf-lib parser detail) when the
 * PDF is unparseable outright, so the caller can short-circuit BEFORE making
 * any provider call.
 */
export async function validatePdfForAnthropic(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  try {
    await PDFDocument.load(bytes, { ignoreEncryption: true });
    return bytes;
  } catch {
    throw new Error('anthropic: invalid PDF (unparseable by pdf-lib)');
  }
}

/**
 * Repair-fallback ONLY: round-trip PDF bytes through pdf-lib's loader +
 * serializer, returning the RE-SERIALIZED bytes. pdf-lib's serializer can
 * repair some recoverable structural issues that make Anthropic reject a PDF
 * outright — but its output is also sometimes rejected by Anthropic's parser
 * for PDFs the ORIGINAL bytes were accepted for (see
 * {@link validatePdfForAnthropic} for the receipted regression this caused
 * when it was the unconditional default). Callers should reach for this only
 * as a one-shot retry after the original bytes 400 with an invalid-PDF error
 * (see {@link isAnthropicInvalidPdfError}), never as the primary bytes sent.
 */
export async function resavePdfForAnthropic(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  try {
    const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const saved = await pdfDoc.save();
    return (saved.buffer as ArrayBuffer).slice(saved.byteOffset, saved.byteOffset + saved.byteLength);
  } catch {
    throw new Error('anthropic: invalid PDF (unparseable by pdf-lib)');
  }
}

/**
 * True when an Anthropic error detail matches the receipted invalid-PDF
 * failure class (production doc H-2026-20034954, 2026-07-15) — the provider
 * rejecting the PDF bytes it was sent as unparseable. Callers use this to
 * decide whether a one-shot resave-repair retry
 * ({@link resavePdfForAnthropic}) is worth attempting before surfacing the
 * error to the caller.
 */
export function isAnthropicInvalidPdfError(detail: string): boolean {
  return detail.includes('The PDF specified was not valid') || detail.includes('pdf.source.base64.data');
}

export function toParsedTx(m: ModelTx): ParsedTx {
  const parsedAmount = parseAmountRange(m.amountRange ?? '');
  const { min, max } = parsedAmount;
  const modelConf = typeof m.confidence === 'number' ? clamp01(m.confidence) : DEFAULT_CONFIDENCE;
  // Cap vision confidence at the conservative default so scanned docs lean to review.
  const confidence = Math.min(modelConf, DEFAULT_CONFIDENCE);

  const extractionWarnings: ParsedTx['extractionWarnings'] = [];
  if (typeof m.isOption !== 'boolean') extractionWarnings.push('unreadable_is_option');
  if (typeof m.capGainsOver200 !== 'boolean') extractionWarnings.push('unreadable_cap_gains');
  // CT-2415 Guard 2: the bracket was snapped onto a canonical tier, not matched
  // from what the form printed. On a checkbox-band PTR that is an inferred
  // amount, so flag it for refusal instead of shipping it as a real read.
  if (parsedAmount.snapped && min !== null) extractionWarnings.push('band_amount_inferred');

  return {
    txDate: m.txDate ?? null,
    owner: normalizeOwner(m.owner),
    assetName: (m.assetName ?? '').trim(),
    ticker: m.ticker ? m.ticker.trim().toUpperCase() : null,
    assetType: m.assetType ?? null,
    assetTypeName: cleanNullable(m.assetTypeName),
    txType: normalizeTxType(m.txType),
    amountMin: min,
    amountMax: max,
    isOption: Boolean(m.isOption),
    capGainsOver200: Boolean(m.capGainsOver200),
    ...(extractionWarnings.length ? { extractionWarnings } : {}),
    rawText: JSON.stringify(m),
    filingStatus: cleanNullable(m.filingStatus),
    subholding: cleanNullable(m.subholding),
    location: cleanNullable(m.location),
    description: cleanNullable(m.description),
    supplementalText: cleanNullable(m.supplementalText),
    confidence,
  };
}

function cleanNullable(value: string | null | undefined): string | null {
  const cleaned = (value ?? '').trim();
  return cleaned || null;
}

function normalizeOwner(raw: string | null | undefined): Owner | null {
  const s = (raw ?? '').toLowerCase();
  if (s === 'spouse') return 'spouse';
  if (s === 'joint') return 'joint';
  if (s === 'dependent' || s === 'child') return 'dependent';
  if (s === 'self') return 'self';
  return null;
}

function normalizeTxType(raw: string | null | undefined): TxType {
  const s = (raw ?? '').toUpperCase().trim();
  // Storage B|S|E; legacy form P and buy synonyms → B.
  if (s === 'P' || s === 'B' || s === 'BUY' || s === 'PURCHASE') return 'B';
  if (s === 'S' || s === 'SELL' || s === 'SALE') return 'S';
  if (s === 'E' || s === 'EXCHANGE') return 'E';
  // ParsedTx historically narrows this field to TxType, but the shared
  // normalizer must see an invalid value so it can hard-flag unreadable rows.
  return '' as TxType;
}

// ---------------------------------------------------------------------------
// Gemini wire types + helpers
// ---------------------------------------------------------------------------



export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  // btoa is available in the Workers runtime.
  return btoa(binary);
}



function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// 429 (rate limit) and transient 5xx (including Cloudflare's 522 connection-timeout
// and 529 overloaded) are worth a retry. Other 4xx (bad request, auth, invalid PDF,
// etc.) are the caller's problem and won't succeed on a second attempt.
function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  name = 'fetch',
  opts: {
    maxAttempts?: number;
    sleep?: (ms: number) => Promise<void>;
    jitter?: () => number;
    model?: string;
    /** GOVERNOR 1: when set, every network attempt (including retries) is
     *  pre-flighted against the daily LLM USD ceiling. A budget halt throws a
     *  terminal LlmBudgetExceededError (error-class 'budget') that is never
     *  retried here — no retry storm, no failover spend. */
    spendGuard?: { env: Env; provider: string };
  } = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const jitter = opts.jitter ?? (() => Math.floor(Math.random() * 250));

  for (let attempt = 1; ; attempt++) {
    if (opts.spendGuard) {
      await assertLlmSpendWithinCeiling(opts.spendGuard.env, opts.spendGuard.provider);
    }
    // res/networkErr are scoped per attempt (not hoisted across iterations) so a
    // network error on attempt N+1 can't be masked by a stale Response left over
    // from a retryable-but-successful-fetch attempt N.
    let res: Response | undefined;
    let networkErr: unknown;
    try {
      res = await trackedFetch(
        url,
        init,
        { service: 'llm', operation: attempt === 1 ? 'extract-document' : 'extract-document-retry', model: opts.model },
      );
    } catch (err) {
      networkErr = err;
    }

    // An AbortSignal is one-shot. Once a caller's deadline has fired, reusing
    // the same init would make every subsequent attempt fail immediately and
    // would only add misleading retry delays to an already-cancelled request.
    const callerAborted = init.signal?.aborted === true;
    const shouldRetry = !callerAborted && (networkErr !== undefined || (res !== undefined && isRetryable(res.status)));
    if (!shouldRetry || attempt === maxAttempts) {
      if (networkErr !== undefined) throw networkErr;
      return res as Response;
    }

    const retryAfterSec = res ? Number(res.headers.get('retry-after')) : NaN;
    const backoffMs =
      Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.min(retryAfterSec * 1000, 30_000)
        : Math.min(500 * 2 ** (attempt - 1), 8_000) + jitter();
    if (res) {
      // Release the errored response body so the connection can be reused.
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      console.warn(`${name}: ${res.status} — retry ${attempt}/${maxAttempts - 1} in ${backoffMs}ms`);
    } else {
      console.warn(`${name}: network error (${(networkErr as Error)?.message ?? networkErr}) — retry ${attempt}/${maxAttempts - 1} in ${backoffMs}ms`);
    }
    await sleep(backoffMs);
  }
}
