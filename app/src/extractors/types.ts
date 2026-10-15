/**
 * src/extractors/types.ts
 * Pluggable extractor framework. The framework contracts + the env-driven
 * arbitration WIRING are implemented here; the concrete extractors (senateHtml,
 * textPdf, visionLlm) are stubs in src/extraction/* that the extraction agent
 * fills against the Extractor interface below.
 */

import type { Env, Filing, ParsedTx } from '../shared/types.ts';
import { IngestRetryError } from '../ingestion/fetcher.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import {
  classifyHouseExtractRoute,
  looksLikeOgePart7ExplicitNone,
  looksLikePlausibleTradeTable,
} from '../extraction/extractRouting.ts';
import { isProvenOpenRouterCredentialRejection } from '../extraction/openRouterReply.ts';

// ---------------------------------------------------------------------------
// Arbitration merge helpers (pure, unit-testable)
// ---------------------------------------------------------------------------

const ROW_KEY_CACHE = new WeakMap<ParsedTx, string>();

function arbitrationOwnerSegment(owner: ParsedTx['owner']): string {
  if (owner === 'self' || owner === 'spouse' || owner === 'joint' || owner === 'dependent') {
    return owner;
  }
  return '';
}

/**
 * Stable matching key for a parsed row: ticker (or asset name when no ticker) +
 * transaction date + transaction type + owner. Two extractors that read the same
 * row should produce the same key even if other fields differ slightly. Distinct
 * owners on the same ticker/date/type are separate lots (House PTR DC vs SP).
 */
export function arbitrationRowKey(tx: ParsedTx): string {
  const cached = ROW_KEY_CACHE.get(tx);
  if (cached !== undefined) return cached;
  const sym = (tx.ticker || tx.assetName || '').trim().toUpperCase();
  const key = `${sym}|${tx.txDate ?? ''}|${tx.txType}|${arbitrationOwnerSegment(tx.owner)}`;
  ROW_KEY_CACHE.set(tx, key);
  return key;
}

/** Count how many of the comparable fields two matched rows agree on, out of N. */
export function fieldAgreement(a: ParsedTx, b: ParsedTx): { agree: number; total: number } {
  const eqStr = (x: string | null, y: string | null) =>
    (x ?? '').trim().toUpperCase() === (y ?? '').trim().toUpperCase();
  const checks = [
    a.txType === b.txType,
    a.amountMin === b.amountMin && a.amountMax === b.amountMax,
    eqStr(a.ticker, b.ticker),
    a.owner === b.owner,
    a.isOption === b.isOption,
  ];
  return { agree: checks.filter(Boolean).length, total: checks.length };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function modelRunsForResult(result: ExtractorResult): ExtractorModelRun[] {
  if (result.modelRuns?.length) {
    return result.modelRuns.map((run) => ({
      ...run,
      usage: run.usage ? { ...run.usage } : undefined,
    }));
  }
  if (!result.modelVersion && !result.providerRequestId && !result.usage) return [];
  return [{
    extractor: result.extractor,
    modelVersion: result.modelVersion,
    providerRequestId: result.providerRequestId,
    usage: result.usage ? { ...result.usage } : undefined,
  }];
}

function modelRunsForError(error: object, extractor: string): ExtractorModelRun[] {
  const cast = error as {
    modelRuns?: ExtractorModelRun[];
    resolvedModel?: string;
    providerRequestId?: string;
    usage?: ExtractorUsage;
  };
  if (cast.modelRuns?.length) {
    return cast.modelRuns.map((run) => ({
      ...run,
      usage: run.usage ? { ...run.usage } : undefined,
    }));
  }
  if (!cast.resolvedModel && !cast.providerRequestId && !cast.usage) return [];
  return [{
    extractor,
    modelVersion: cast.resolvedModel,
    providerRequestId: cast.providerRequestId,
    usage: cast.usage ? { ...cast.usage } : undefined,
  }];
}

/**
 * Reconcile two extractor results into one. The PRIMARY row set stays
 * authoritative (deterministic output), but per-row and document confidence are
 * re-weighted by how well the secondary corroborates it:
 *   - matched + all fields agree  -> confidence nudged UP toward agreement.
 *   - matched + partial agreement -> confidence scaled DOWN by the agreement ratio.
 *   - primary-only (no match)     -> confidence halved (only one extractor saw it).
 * Rows the secondary found but the primary missed drag the DOCUMENT confidence
 * down (so the normalizer routes contested docs to human review) without being
 * blindly injected into the output.
 */
export function mergeResults(primary: ExtractorResult, secondary: ExtractorResult): ExtractorResult {
  const secByKey = new Map<string, ParsedTx>();
  for (const tx of secondary.transactions) secByKey.set(arbitrationRowKey(tx), tx);

  const matchedKeys = new Set<string>();
  const transactions: ParsedTx[] = primary.transactions.map((p) => {
    const key = arbitrationRowKey(p);
    const match = secByKey.get(key);
    if (!match) {
      // Only the primary saw this row — corroboration absent.
      return { ...p, confidence: clamp01(p.confidence * 0.5) };
    }
    matchedKeys.add(key);
    const { agree, total } = fieldAgreement(p, match);
    if (agree === total) {
      // Full agreement: average the two and nudge up, capped at 1.
      const base = (p.confidence + match.confidence) / 2;
      return { ...p, confidence: clamp01(base + 0.1) };
    }
    // Partial agreement: scale down by the agreement ratio.
    return { ...p, confidence: clamp01(p.confidence * (agree / total)) };
  });

  // Rows present only in the secondary (primary missed them) = contested doc.
  const secondaryOnly = secondary.transactions.filter(
    (s) => !matchedKeys.has(arbitrationRowKey(s)),
  ).length;
  const primaryOnly = primary.transactions.length - matchedKeys.size;

  const meanRowConf =
    transactions.length > 0
      ? transactions.reduce((s, t) => s + t.confidence, 0) / transactions.length
      : Math.min(primary.confidence, secondary.confidence);

  // Document agreement factor: matched rows / the larger of the two row counts.
  const denom = Math.max(primary.transactions.length, secondary.transactions.length, 1);
  const agreementFactor = matchedKeys.size / denom;
  const docConfidence = clamp01(meanRowConf * (0.5 + 0.5 * agreementFactor));
  const modelRuns = [...modelRunsForResult(primary), ...modelRunsForResult(secondary)];

  return {
    transactions,
    confidence: docConfidence,
    raw: `primary(${primary.extractor}):\n${primary.raw}\n\n---\nsecondary(${secondary.extractor}) [primaryOnly=${primaryOnly}, secondaryOnly=${secondaryOnly}]:\n${secondary.raw}`,
    extractor: `arbitrating(${primary.extractor},${secondary.extractor})`,
    arbitrationCounts: { primaryOnly, secondaryOnly },
    modelVersion: primary.modelVersion,
    providerRequestId: primary.providerRequestId,
    usage: primary.usage ? { ...primary.usage } : undefined,
    modelRuns: modelRuns.length ? modelRuns : undefined,
  };
}

// ---------------------------------------------------------------------------
// Core contracts
// ---------------------------------------------------------------------------

export interface ExtractorUsage {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  cacheWriteOneHourTokens?: number;
  pagesProcessed?: number;
  serviceTier?: string;
  /** Provider-reported dollar charge for the request (e.g. OpenRouter usage
   *  accounting `usage.cost`); preferred over rate-card estimates downstream. */
  costUsd?: number;
}

/** One provider/model invocation retained across arbitration. */
export interface ExtractorModelRun {
  extractor: string;
  modelVersion?: string;
  providerRequestId?: string;
  usage?: ExtractorUsage;
}

/**
 * What a zero-row deterministic parse means.  `empty` is a real miss.
 * `unreadable` is a refusal (garbled index / a 278-T the parser would not
 * trust).  Absent on extractors that do not make this distinction.
 */
export type ExtractorParseDisposition = 'rows' | 'empty' | 'unreadable';

/** Result of running an extractor over one filing. */
export interface ExtractorResult {
  /** Parsed (pre-normalization) transactions. */
  transactions: ParsedTx[];
  /** Deterministic empty-vs-refusal signal.  See ExtractorParseDisposition. */
  parseDisposition?: ExtractorParseDisposition;
  /** Document-level confidence in [0,1]. */
  confidence: number;
  /** Raw extracted text/markup retained for audit + review. */
  raw: string;
  /** Name of the extractor that produced this result. */
  extractor: string;
  /** Model/version identifier when an LLM was used (optional). */
  modelVersion?: string;
  /** Provider request identifier retained for audit/support, when returned. */
  providerRequestId?: string;
  /** Billed usage reported by the provider API, when available. */
  usage?: ExtractorUsage;
  /** Every underlying model call when arbitration combines multiple results. */
  modelRuns?: ExtractorModelRun[];
  /** Present only on arbitrated results: rows each side saw that the other
   *  missed. The merged row set stays primary-authoritative, so a contested
   *  doc can have an empty `transactions` array with `secondaryOnly` > 0. */
  arbitrationCounts?: { primaryOnly: number; secondaryOnly: number };
}

/** Input handed to an extractor. One of bytes/html is typically present. */
export interface ExtractorInput {
  filing: Filing;
  /** Queue-lease cancellation propagated to provider transports when present. */
  signal?: AbortSignal;
  /** Raw bytes (PDF) when applicable. */
  bytes?: ArrayBuffer;
  /** Raw HTML (Senate eFD) when applicable. */
  html?: string;
  /** Already-extracted text for the cheap OpenRouter text path (no Files). */
  extractedText?: string;
}

/**
 * A pluggable extraction strategy. Implementations live in src/extraction/*.
 * canHandle() lets buildExtractorPipeline() route a filing to the right one.
 */
export interface Extractor {
  /** Stable extractor name, recorded on filings.extractor. */
  name: string;
  /** Optional concrete provider scope for the rate-limit circuit breaker. */
  circuitBreakerName?: string;
  /** True if this extractor can handle the given filing (by docKind etc.). */
  canHandle(f: Filing): boolean;
  /** Run extraction. Implementations resolve to an ExtractorResult. */
  extract(input: ExtractorInput): Promise<ExtractorResult>;
}

// ---------------------------------------------------------------------------
// Arbitration: run a primary extractor, optionally cross-check with a secondary
// ---------------------------------------------------------------------------

/**
 * ArbitratingExtractor wraps a primary Extractor and an optional secondary one.
 *
 * Behaviour (the env-driven WIRING is real; the compare/merge is a documented
 * stub returning the primary result for now):
 *   - ALWAYS runs the primary extractor.
 *   - If a secondary is present AND the arbitration flag is enabled
 *     (env.ARBITRATION_ENABLED === 'true'), ALSO runs the secondary and
 *     arbitrates between the two results. The secondary resolves its key lazily
 *     so it can come from Infisical at extraction time.
 *   - Otherwise returns the primary result unchanged.
 */
export class ArbitratingExtractor implements Extractor {
  readonly name: string;
  readonly circuitBreakerName: string;

  constructor(
    private readonly primary: Extractor,
    private readonly env: Env,
    private readonly secondary?: Extractor,
  ) {
    this.name = `arbitrating(${primary.name}${secondary ? `,${secondary.name}` : ''})`;
    this.circuitBreakerName = primary.circuitBreakerName ?? primary.name;
  }

  canHandle(f: Filing): boolean {
    return this.primary.canHandle(f);
  }

  /** True iff secondary arbitration should run for the current config. The
   *  flag resolves through Infisical (env fallback) at extraction time, so
   *  arbitration can be toggled without a redeploy. */
  private async arbitrationEnabled(): Promise<boolean> {
    if (this.secondary === undefined) return false;
    try {
      const live = (await resolveSecret(this.env, 'ARBITRATION_ENABLED')).value;
      return (live ?? this.env.ARBITRATION_ENABLED) === 'true';
    } catch {
      return this.env.ARBITRATION_ENABLED === 'true';
    }
  }

  async extract(input: ExtractorInput): Promise<ExtractorResult> {
    // 1) Always run the primary extractor.
    const primaryResult = await this.primary.extract(input);

    // 2) Config-driven switch: only arbitrate when fully configured.
    if (!(await this.arbitrationEnabled()) || !this.secondary) {
      return primaryResult;
    }

    // 3) Run the secondary and arbitrate.
    try {
      const secondaryResult = await this.secondary.extract(input);
      return this.arbitrate(primaryResult, secondaryResult);
    } catch (error) {
      // The primary request was already billed. Preserve it alongside any usage
      // attached to the secondary error so the orchestrator can report both.
      if (error && typeof error === 'object') {
        const modelRuns = [
          ...modelRunsForResult(primaryResult),
          ...modelRunsForError(error, this.secondary.name),
        ];
        if (modelRuns.length) {
          try {
            Object.assign(error, { modelRuns });
          } catch {
            // Preserve the provider's original error if it is non-extensible.
          }
        }
      }
      throw error;
    }
  }

  /**
   * Compare/merge primary vs secondary results via {@link mergeResults}:
   * row-by-row reconciliation keyed on ticker/date/type, confidence-weighted by
   * field agreement, with contested documents (rows seen by only one extractor)
   * pushed toward the review queue through a lowered document confidence. The
   * primary row set stays authoritative so output remains deterministic.
   */
  private arbitrate(primary: ExtractorResult, secondary: ExtractorResult): ExtractorResult {
    return mergeResults(primary, secondary);
  }
}

/**
 * FallbackExtractor tries the primary extractor first. If it throws an error
 * (e.g. rate limit, API key missing), it runs the secondary extractor instead,
 * preserving any usage incurred by the failed primary run.
 */
export class FallbackExtractor implements Extractor {
  readonly name: string;
  readonly circuitBreakerName: string;

  constructor(
    private readonly primary: Extractor,
    private readonly secondary: Extractor,
  ) {
    this.name = `fallback(${primary.name},${secondary.name})`;
    this.circuitBreakerName = primary.circuitBreakerName ?? primary.name;
  }

  canHandle(f: Filing): boolean {
    return this.primary.canHandle(f) || this.secondary.canHandle(f);
  }

  async extract(input: ExtractorInput): Promise<ExtractorResult> {
    try {
      return await this.primary.extract(input);
    } catch (error) {
      const secondaryResult = await this.secondary.extract(input);
      if (error && typeof error === 'object') {
        const primaryRuns = modelRunsForError(error, this.primary.name);
        const secRuns = modelRunsForResult(secondaryResult);
        const modelRuns = [...primaryRuns, ...secRuns];
        if (modelRuns.length > 0) {
          secondaryResult.modelRuns = modelRuns;
        }
      }
      return secondaryResult;
    }
  }
}

/**
 * House PDFs often have extractable text even when the cheap byte-sniff
 * classifier misses it. Prefer deterministic text parsing. Electronic / typed
 * PTRs never fall through to OpenRouter Files. Vision/Files is only for
 * documents classified as real scans, and only when the cheap read was empty
 * (not letterhead junk).
 */
export class HousePdfExtractor implements Extractor {
  readonly name: string;
  readonly circuitBreakerName: string;

  constructor(
    private readonly textPdf: Extractor,
    private readonly visionPdf: Extractor,
    private readonly cheapText?: Extractor,
  ) {
    this.name = this.cheapText
      ? `housePdf(${textPdf.name},${this.cheapText.name},${visionPdf.name})`
      : `housePdf(${textPdf.name},${visionPdf.name})`;
    this.circuitBreakerName = visionPdf.circuitBreakerName ?? visionPdf.name;
  }

  canHandle(f: Filing): boolean {
    return f.chamber === 'house' && (f.docKind === 'text_pdf' || f.docKind === 'scanned_pdf');
  }

  async extract(input: ExtractorInput): Promise<ExtractorResult> {
    const route = classifyHouseExtractRoute(input.filing);
    let textResult: ExtractorResult | null = null;
    try {
      textResult = await this.textPdf.extract(input);
    } catch {
      // Text-layer parsing can fail on image-only or malformed PDFs.
    }

    if (textResult) {
      if (textResult.transactions.length > 0) {
        // A cheap read that already failed (letterhead / headers) must not
        // escalate to Files or the agreement trio. Orchestrator + agreement
        // consult evaluateExtractQuality on these rows.
        return textResult;
      }
      if (!route.allowFiles) {
        if (
          this.cheapText
          && looksLikePlausibleTradeTable(textResult.raw)
        ) {
          try {
            const cheap = await this.cheapText.extract({
              ...input,
              extractedText: textResult.raw,
            });
            return cheap;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Proven dead-key rejections must still fail closed.  Garbage /
            // Unauthorized replies skip this one doc instead of Files.
            if (isProvenOpenRouterCredentialRejection(message)) throw err;
            return textResult;
          }
        }
        return textResult;
      }
    }

    if (!route.allowFiles) {
      return textResult ?? {
        transactions: [],
        confidence: 0.2,
        raw: '',
        extractor: this.textPdf.name,
      };
    }
    return this.visionPdf.extract(input);
  }
}

/**
 * Executive 278-T PDFs are often tagged `scanned_pdf` even when unpdf can
 * still recover a usable text layer (Burns-class misclassifications). Always
 * try the deterministic OGE parser first. Paid OpenRouter vision runs only
 * when that parse yields zero rows on a true scan, and is fail-soft: missing
 * keys, parse errors, and provider 4xx return the empty text result instead
 * of failing the extract. Budget/rate-limit `IngestRetryError` still
 * propagates so the queue can back off.
 */
export class OgePdfExtractor implements Extractor {
  readonly name: string;
  readonly circuitBreakerName: string;

  constructor(
    private readonly ogeText: Extractor,
    private readonly visionPdf: Extractor,
  ) {
    this.name = `ogePdf(${ogeText.name},${visionPdf.name})`;
    this.circuitBreakerName = visionPdf.circuitBreakerName ?? visionPdf.name;
  }

  canHandle(f: Filing): boolean {
    return f.chamber === 'executive' && (f.docKind === 'text_pdf' || f.docKind === 'scanned_pdf');
  }

  async extract(input: ExtractorInput): Promise<ExtractorResult> {
    let textResult: ExtractorResult | null = null;
    let textError: unknown = null;
    try {
      textResult = await this.ogeText.extract(input);
      if (textResult.transactions.length > 0) return textResult;
      // 278e termination/annual reports often have a real text layer and a
      // Part 7 body of "None". That is an honest empty, not a scan to vision.
      if (looksLikeOgePart7ExplicitNone(textResult.raw)) return textResult;
    } catch (error) {
      // Image-only or malformed PDFs can throw in unpdf; vision is the fallback
      // for scans. Typed 278-T files keep their previous throw behavior.
      textError = error;
    }

    // Typed executive PDFs with no matching rows are usually empty/termination
    // reports (Fudge-class). Do not charge vision for those.
    if (input.filing.docKind === 'text_pdf') {
      if (textResult) return textResult;
      throw textError instanceof Error ? textError : new Error('ogePdf: ogeText failed');
    }

    try {
      const vision = await this.visionPdf.extract(input);
      if (vision.transactions.length > 0) return vision;
      // A refused text layer must stay unreadable when vision also finds
      // nothing.  An honest empty text layer stays empty.  Under arbitration
      // the merged row set is primary-authoritative: the secondary vision
      // read may have found rows (secondaryOnly > 0) that route the doc to
      // human review.  Restoring the terminal state on the empty merged array
      // alone would bury that signal, so require that EVERY vision read found
      // nothing first.
      const secondarySawRows = (vision.arbitrationCounts?.secondaryOnly ?? 0) > 0;
      if (
        !secondarySawRows
        && (textResult?.parseDisposition === 'unreadable' || textResult?.parseDisposition === 'empty')
      ) {
        return { ...vision, parseDisposition: textResult.parseDisposition, transactions: [] };
      }
      return vision;
    } catch (error) {
      if (error instanceof IngestRetryError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      const fallback = textResult ?? emptyOgeTextResult();
      return {
        ...fallback,
        // Vision never confirmed this read: an 'unreadable' disposition from
        // the refused text layer must not survive the fail-soft, or
        // normalize() resolves the filing rejected without a successful
        // zero-row vision read. An 'empty' disposition is positive evidence
        // from the text layer (a bounded, readable empty Part 7) that needs
        // no vision confirmation, so it survives.
        parseDisposition:
          fallback.parseDisposition === 'unreadable' ? undefined : fallback.parseDisposition,
        raw: `${fallback.raw}\n\n---\nogePdf vision fail-soft: ${reason}`,
      };
    }
  }
}

function emptyOgeTextResult(): ExtractorResult {
  return {
    transactions: [],
    confidence: 0.3,
    raw: '',
    extractor: 'ogeText',
  };
}

// ---------------------------------------------------------------------------
// Pipeline construction
// ---------------------------------------------------------------------------

/**
 * Build the configured ordered extractor pipeline for this environment.
 *
 * Returns references to the concrete (stub) extractor classes that the
 * extraction agent implements in src/extraction/*:
 *   - SenateHtmlExtractor (senate_html)
 *   - TextPdfExtractor    (text_pdf, House PTR layout)
 *   - OgeTextExtractor    (text_pdf, chamber='executive' — OGE 278-T layout)
 *   - OgePdfExtractor     (executive text_pdf + scanned_pdf — unpdf first,
 *                          fail-soft OpenRouter vision only for true scans)
 *   - VisionLlmExtractor  (scanned_pdf — uses GEMINI_API_KEY)
 *
 * The classifier picks a docKind; the queue handler iterates this pipeline and
 * uses the first extractor whose canHandle() returns true. The vision extractor
 * is wrapped in an ArbitratingExtractor; when ARBITRATION_API_KEY is set (and
 * ARBITRATION_ENABLED === 'true'), a second, independent vision extractor — a
 * different model keyed by ARBITRATION_API_KEY — cross-checks every scanned doc.
 */
export function buildExtractorPipeline(env: Env): Extractor[] {
  const senateHtml = new SenateHtmlExtractor(env);
  const textPdf = new TextPdfExtractor();
  const ogeText = new OgeTextExtractor();

  const geminiVision = new VisionLlmExtractor(env);
  const anthropicVision = new AnthropicVisionExtractor(env);
  const visionLlmWithFallback = new FallbackExtractor(geminiVision, anthropicVision);

  // Per-chamber PRIMARY/FAILOVER extraction model (AGREEMENT_*_MODEL_A/_B),
  // provider-generic via the bake-off harness. Unmigrated/dev chambers (no
  // explicit primary configured) delegate straight through to the legacy
  // vision-LLM fallback chain above, so behavior is unchanged until an
  // operator opts a chamber in.
  const configuredVision = new ConfiguredVisionExtractor(env, visionLlmWithFallback);

  // The secondary is ALWAYS constructed (construction does no I/O): its API
  // key, model, and the ARBITRATION_ENABLED switch all resolve lazily at
  // extraction time (Infisical first, env fallback), so arbitration can be
  // turned on entirely from Infisical without a redeploy. When the flag stays
  // off, ArbitratingExtractor never invokes this instance.
  const secondary = new VisionLlmExtractor(env, {
    apiKeyName: 'ARBITRATION_API_KEY',
    modelEnvName: 'ARBITRATION_MODEL',
    defaultModel: 'gemini-3.8-flash',
    name: 'visionLlm-secondary',
  });

  const visionArbitrated = new ArbitratingExtractor(configuredVision, env, secondary);
  const cheapText = new OpenRouterTextExtractor(env);
  const housePdf = new HousePdfExtractor(textPdf, visionArbitrated, cheapText);
  const ogePdf = new OgePdfExtractor(ogeText, visionArbitrated);

  // ogePdf is ordered before the generic textPdf so executive-chamber PDFs
  // (OGE 278-T layout) get the parser tuned for their table, instead of
  // silently matching the House-tuned parser and yielding zero rows.
  // scanned_pdf executive filings stay on this wrapper (unpdf first, then
  // fail-soft vision) rather than jumping straight to paid vision.
  return [senateHtml, housePdf, ogePdf, textPdf, visionArbitrated];
}

// ---------------------------------------------------------------------------
// Re-exported concrete extractor stub classes (implemented by extraction agent)
// ---------------------------------------------------------------------------

import { SenateHtmlExtractor } from '../extraction/senateHtml.ts';
import { TextPdfExtractor } from '../extraction/textPdf.ts';
import { OgeTextExtractor } from '../extraction/ogeText.ts';
import { VisionLlmExtractor } from '../extraction/visionLlm.ts';
import { AnthropicVisionExtractor } from '../extraction/anthropicVision.ts';
import { ConfiguredVisionExtractor } from '../extraction/configuredVision.ts';
import { OpenRouterTextExtractor } from '../extraction/openRouterText.ts';

export {
  SenateHtmlExtractor, TextPdfExtractor, OgeTextExtractor, VisionLlmExtractor, AnthropicVisionExtractor,
  ConfiguredVisionExtractor, OpenRouterTextExtractor,
};
