/**
 * src/extraction/orchestrator.ts
 * OWNER: integration (wires ingestion -> extraction -> normalizer)
 *
 * Consumes {type:'filing.extracted'} (emitted by the classifier). Loads the
 * classified filing + its raw R2 object, routes it to the first extractor in
 * buildExtractorPipeline() whose canHandle() returns true, runs extraction, and
 * hands the parsed rows to normalize() which validates, persists, and fans out
 * delivery.
 *
 * This closes the seam the foundation left as a no-op in index.ts: the
 * classifier emits filing.extracted, and THIS function is what index.ts invokes
 * for that message.
 */

import type { Env, Filing, DocKind, Chamber, ParsedTx } from '../shared/types.ts';
import type { DurableQueueLeaseContext } from '../deno/durableQueue.ts';
import { get, run } from '../shared/db.ts';
import {
  buildExtractorPipeline,
  type ExtractorModelRun,
  type ExtractorParseDisposition,
  type ExtractorResult,
  type ExtractorUsage,
} from '../extractors/types.ts';
import { isDeterministicExtractor, normalize } from './normalizer.ts';
import {
  maybeRecoverOgeRowsViaLocalOcr,
  ogeLocalOcrReviewPayload,
  OGE_LOCAL_OCR_EXTRACTOR,
} from './ogeLocalOcr.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import { enqueueAgreementCheck } from './agreement.ts';
import { ensureDocClass } from './docClassifier.ts';
import { evaluateExtractQuality, shouldEnqueueAgreement } from './extractRouting.ts';
import { reportAiUsage } from '../shared/telemetry.ts';
import {
  assertDocLlmSpendAllowed,
  isLlmDocBudgetHalt,
  LlmDocBudgetExceededError,
} from '../shared/llmSpend.ts';

interface FilingRow {
  doc_id: string;
  chamber: string | null;
  filer_id: string | null;
  filing_type: string | null;
  filed_date: string | null;
  source_url: string | null;
  raw_object_key: string | null;
  ingest_status: string | null;
  doc_kind: string | null;
  extractor: string | null;
  model_version: string | null;
  confidence: number | null;
  first_seen_at: string | null;
  source_updated_at: string | null;
  error: string | null;
}

/** Map a snake_case D1 filings row to the camelCase Filing contract. */
function rowToFiling(r: FilingRow): Filing {
  return {
    docId: r.doc_id,
    chamber: (r.chamber as Chamber) ?? 'house',
    filerId: r.filer_id,
    filingType: r.filing_type ?? 'P',
    filedDate: r.filed_date,
    sourceUrl: r.source_url ?? '',
    rawObjectKey: r.raw_object_key,
    ingestStatus: (r.ingest_status as Filing['ingestStatus']) ?? 'classified',
    docKind: (r.doc_kind as DocKind) ?? 'unknown',
    extractor: r.extractor,
    modelVersion: r.model_version,
    confidence: r.confidence,
    firstSeenAt: r.first_seen_at ?? new Date().toISOString(),
    sourceUpdatedAt: r.source_updated_at,
    error: r.error,
  };
}

async function markError(
  env: Env,
  docId: string,
  message: string,
  lease?: DurableQueueLeaseContext,
): Promise<void> {
  await lease?.assertOwned();
  await run(
    env.DB,
    "UPDATE filings SET ingest_status = 'error', error = ? WHERE doc_id = ?",
    [message.slice(0, 500), docId],
  );
}

function isProviderRateLimit(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b(429|402|too many requests|quota exceeded|rate[- ]?limit|payment required)\b/i.test(message);
}

export function providerForModel(model: string | undefined): string {
  const normalized = model?.trim().toLowerCase() ?? '';
  // OpenRouter slugs are 'vendor/model' — attribute usage to the UNDERLYING
  // vendor so cost/usage reporting stays comparable across transports.
  const slash = normalized.indexOf('/');
  if (slash > 0) {
    const vendor = normalized.slice(0, slash);
    if (vendor === 'google') return 'gemini';
    if (vendor === 'x-ai') return 'xai';
    if (vendor === 'mistralai') return 'mistral';
    if (vendor === 'openrouter') return 'openrouter'; // e.g. openrouter/auto
    return vendor; // openai, anthropic, deepseek, qwen, amazon, z-ai, mistral, ...
  }
  if (normalized.startsWith('gemini')) return 'gemini';
  if (/^(gpt-|chatgpt-|o\d)/.test(normalized)) return 'openai';
  if (normalized.startsWith('claude')) return 'anthropic';
  if (normalized.startsWith('grok')) return 'xai';
  if (normalized.includes('mistral')) return 'mistral';
  // OpenRouter model slugs use a provider/model naming convention
  // (e.g. qwen/qwen-2.5-vl-72b-instruct:free). Direct-provider model
  // strings never contain a '/', so a slash is a reliable indicator of
  // an OpenRouter-transported model. This ensures usage-monitor
  // dimensions correctly attribute OpenRouter consumption to its
  // billing transport rather than recording it as 'unknown'.
  if (normalized.includes('/')) return 'openrouter';
  return 'unknown';
}

function telemetryModelRuns(
  value: {
    extractor?: string;
    modelVersion?: string;
    resolvedModel?: string;
    providerRequestId?: string;
    usage?: ExtractorUsage;
    modelRuns?: ExtractorModelRun[];
  },
  fallbackExtractor: string,
): ExtractorModelRun[] {
  if (value.modelRuns?.length) return value.modelRuns;
  if (!value.modelVersion && !value.resolvedModel && !value.providerRequestId && !value.usage) return [];
  return [{
    extractor: value.extractor ?? fallbackExtractor,
    modelVersion: value.modelVersion ?? value.resolvedModel,
    providerRequestId: value.providerRequestId,
    usage: value.usage,
  }];
}

async function reportExtractorUsage(env: Env, runs: ExtractorModelRun[]): Promise<void> {
  for (const modelRun of runs) {
    if (!modelRun.usage) continue;
    await reportAiUsage(env, {
      provider: providerForModel(modelRun.modelVersion),
      model: modelRun.modelVersion ?? 'unknown',
      component: 'orchestrator',
      // `|| undefined` so a blank id from an upstream extractor can never
      // reach the wire as "" (the shared schema rejects empty strings).
      providerRequestId: modelRun.providerRequestId || undefined,
      ...modelRun.usage,
    });
  }
}

/**
 * Extract + normalize a classified filing.
 *
 * Throws on extractor failure (e.g. transient LLM error) AFTER recording the
 * error on the filing, so the queue consumer can retry per wrangler.toml. A
 * filing whose docKind has no matching extractor is routed to review rather
 * than retried forever.
 */
export async function extractAndNormalize(
  env: Env,
  docId: string,
  lease?: DurableQueueLeaseContext,
): Promise<void> {
  await lease?.assertOwned();
  // Owner: never re-spend LLM on docs that already have transaction rows
  // unless an explicit admin reprocess path is used (extractParsed forceVision
  // / reprocess options). Early return avoids R2 loads + provider calls.
  try {
    await assertDocLlmSpendAllowed(env, docId);
  } catch (err) {
    if (err instanceof LlmDocBudgetExceededError || isLlmDocBudgetHalt(err)) {
      console.info(`orchestrator: skip paid extract for ${docId}: ${(err as Error).message}`);
      return;
    }
    throw err;
  }
  const extracted = await extractParsed(env, docId, lease, { keepBytes: true });
  if (!extracted) return; // missing row / raw object: already recorded as error.

  await lease?.assertOwned();

  // CT-2448: before the OGE path parks a 278-T as `oge_text_unreadable`,
  // run the local tesseract pass over the stored PDF.  When both reads agree
  // the recovered rows go through the same normalize() decision model as any
  // other extraction; when they do not, the filing parks exactly as it does
  // today and the park payload lists the rows that did not reconcile.
  let ocrOutcome = null;
  try {
    ocrOutcome = await maybeRecoverOgeRowsViaLocalOcr(
      env,
      extracted.filing,
      extracted.bytes ?? null,
      extracted.parseDisposition,
    );
  } catch (err) {
    console.warn('orchestrator: local OGE OCR retry failed:', docId, (err as Error).message);
  }

  const recovered = ocrOutcome?.status === 'rows' ? ocrOutcome : null;
  const effective = recovered
    ? {
      ...extracted,
      transactions: recovered.rows,
      extractor: OGE_LOCAL_OCR_EXTRACTOR,
      parseDisposition: 'rows' as ExtractorParseDisposition,
    }
    : extracted;

  const result = await normalize(env, effective.filing, effective.transactions, {
    extractor: effective.extractor,
    modelVersion: effective.modelVersion ?? null,
    sourceText: effective.raw,
    parseDisposition: effective.parseDisposition,
    reviewPayload: ocrOutcome ? ogeLocalOcrReviewPayload(ocrOutcome) : null,
  });

  // Fast path: a doc that just landed in review gets a cross-vendor agreement
  // check enqueued immediately (self-gates on the flag; the per-minute cron is
  // the backstop). Best-effort — a failure here must not fail the extraction.
  //
  // A2: never enqueue paid agreement for deterministic text/html/OGE extractors.
  // Those either already published at the lower confidence gate (A1) or belong
  // in human review for hard flags — OpenRouter quota must not be spent on them.
  // Electronic / typed House PTRs and already-failed letterhead reads also skip
  // the trio — do not spend more models on junk.
  const quality = evaluateExtractQuality(extracted.transactions);
  if (
    result.needsReview
    && !isDeterministicExtractor(extracted.extractor, extracted.filing.docKind)
    && shouldEnqueueAgreement({
      filing: extracted.filing,
      extractor: extracted.extractor,
      quality,
      reviewReason: result.reviewReason,
    })
  ) {
    try {
      await lease?.assertOwned();
      await enqueueAgreementCheck(env, extracted.filing.docId, extracted.filing.rawObjectKey);
    } catch (err) {
      console.warn('inline agreement enqueue failed:', docId, (err as Error).message);
    }
  }
}

/** Result of re-running extraction (no normalize/persist). */
export interface ExtractedFiling {
  filing: Filing;
  transactions: ParsedTx[];
  extractor: string;
  modelVersion: string | null;
  /** Extractor raw text. Part 7 "None" is visible here when the parser yields 0 rows. */
  raw: string;
  modelRuns?: ExtractorModelRun[];
  parseDisposition?: ExtractorParseDisposition;
  /** The stored raw PDF, when the caller asked for it (CT-2448 local OCR retry). */
  bytes?: ArrayBuffer;
}

/**
 * Run only the extraction half: load the filing + its raw R2 object and route it
 * to the matching extractor, returning the parsed rows WITHOUT normalizing or
 * persisting. Returns null (after recording an error on the filing) when the row
 * or raw object is missing. Shared by extractAndNormalize() and the admin
 * reprocess path, which re-extracts from the already-stored R2 raw — so it never
 * re-fetches from the source — then recomputes confidence in place.
 */
export async function extractParsed(
  env: Env,
  docId: string,
  lease?: DurableQueueLeaseContext,
  options?: { forceVision?: boolean; keepBytes?: boolean }
): Promise<ExtractedFiling | null> {
  await lease?.assertOwned();
  const row = await get<FilingRow>(
    env.DB,
    `SELECT doc_id, chamber, filer_id, filing_type, filed_date, source_url,
            raw_object_key, ingest_status, doc_kind, extractor, model_version,
            confidence, first_seen_at, source_updated_at, error
       FROM filings WHERE doc_id = ?`,
    [docId],
  );
  if (!row) {
    console.warn(`orchestrator: no filings row for ${docId}; skipping`);
    return null;
  }

  const filing = rowToFiling(row);
  if (options?.forceVision) {
    filing.docKind = 'scanned_pdf';
  }

  if (!filing.rawObjectKey) {
    await markError(env, docId, 'orchestrator: missing raw_object_key', lease);
    return null;
  }

  await lease?.assertOwned();
  let obj = await env.RAW_FILES.get(filing.rawObjectKey);
  let bytes: ArrayBuffer;
  if (!obj) {
    if (filing.sourceUrl) {
      console.warn(`orchestrator: R2 object not found, falling back to source_url: ${filing.sourceUrl}`);
      const res = await trackedFetch(filing.sourceUrl, {
        headers: { 'User-Agent': 'congress.trade/1.0 (+https://congress.trade)' }
      }, {
        service: 'disclosure-source',
        operation: 'loaddocbytes.source_url_fallback',
        dynamicTarget: 'filing-source'
      }, fetch, { envOverride: env });
      if (!res.ok) {
        await markError(env, docId, `orchestrator: R2 object not found and fetch failed: HTTP ${res.status}`, lease);
        return null;
      }
      bytes = await res.arrayBuffer();
      // Cache it back to R2 for future runs
      await env.RAW_FILES.put(filing.rawObjectKey, bytes);
    } else {
      await markError(env, docId, `orchestrator: R2 object ${filing.rawObjectKey} not found and no source_url`, lease);
      return null;
    }
  } else {
    bytes = await obj.arrayBuffer();
  }

  await lease?.assertOwned();

  // Complexity signal for cascade tiering: raw byte length. Recorded as soon as
  // bytes are in hand (independent of whether extraction later succeeds).
  // Best-effort — a failure here must never fail extraction.
  try {
    await run(env.DB, 'UPDATE filings SET raw_bytes = ? WHERE doc_id = ?', [bytes.byteLength, docId]);
  } catch (err) {
    lease?.signal.throwIfAborted();
    console.warn('orchestrator: failed to record raw_bytes:', docId, (err as Error).message);
  }

  // Pre-extraction document classification (typed / clean_scan / hard_scan /
  // empty / corrupt): deterministic signals first, one ~free enum-constrained
  // model call only for ambiguous scans, cached on filings.doc_class. Feeds
  // cascade tiering, autopilot ordering, and per-class handling. Best-effort —
  // never fails or delays extraction on error.
  try {
    await lease?.assertOwned();
    await ensureDocClass(
      env,
      docId,
      bytes,
      filing.docKind,
      lease ? { signal: lease.signal } : {},
    );
  } catch (err) {
    lease?.signal.throwIfAborted();
    console.warn('orchestrator: doc classification failed:', docId, (err as Error).message);
  }



  const html =
    filing.docKind === 'senate_html'
      ? new TextDecoder('utf-8').decode(new Uint8Array(bytes))
      : undefined;

  // Route to the first extractor that can handle this docKind.
  const pipeline = buildExtractorPipeline(env);
  const extractor = pipeline.find((e) => e.canHandle(filing));

  if (!extractor) {
    // Unknown / unsupported doc form (e.g. an ambiguous scan): no extractor, no
    // parsed rows. Callers decide what to do (normalize([]) routes to review).
    return { filing, transactions: [], extractor: 'none', modelVersion: null, raw: '' };
  }

  const breakerName = extractor.circuitBreakerName ?? extractor.name;
  // HousePdfExtractor / OgePdfExtractor try deterministic text parsing first.
  // A vision-provider ban must not block that healthy path before it gets a
  // chance to run. OgePdf also needs the unpdf attempt on scanned_pdf
  // (Burns-class misclassifications); its vision fallback is fail-soft.
  // ConfiguredVisionExtractor checks the concrete candidate provider before
  // each primary/failover attempt. The wrapper name is not a valid provider
  // scope, so never consult or write provider_ban:configuredVision here.
  const configuredVisionOwnsBreaker = extractor.name.includes('configuredVision');
  const checkBreaker = !configuredVisionOwnsBreaker
    && !(extractor.name.startsWith('housePdf(') && filing.docKind === 'text_pdf')
    && !extractor.name.startsWith('ogePdf(');
  const breakerKey = `provider_ban:${breakerName}`;
  let isBanned: string | null = null;
  if (checkBreaker && env.CONFIG_KV) {
    try {
      isBanned = await env.CONFIG_KV.get(breakerKey);
    } catch (kvErr) {
      // Only the KV read is fault-tolerant (a down KV must not block extraction).
      // The ban check itself must run outside this try — otherwise its throw
      // below would be caught right here and silently swallowed, defeating the
      // circuit breaker entirely.
      console.warn('orchestrator: failed to read circuit breaker from KV:', (kvErr as Error).message);
    }
  }
  if (checkBreaker && isBanned) {
    const message = `orchestrator: ${breakerName} provider rate limit circuit breaker is open (banned due to recent 429/402). Reprocess this filing later.`;
    await markError(env, docId, message, lease);
    throw new Error(message);
  }

  // CT-2448: copy the PDF for the local OCR retry before the extractor runs.
  // An extractor may detach the buffer it is handed (pdf.js takes ownership),
  // which would leave the retry with an empty document.  Only copied when
  // asked for, so the admin reprocess path keeps its current memory profile.
  const ocrBytes = options?.keepBytes ? bytes.slice(0) : undefined;

  let result;
  try {
    await lease?.assertOwned();
    result = await extractor.extract({ filing, bytes, html, signal: lease?.signal });
    await lease?.assertOwned();
  } catch (err) {
    const cast = err as Error & {
      usage?: ExtractorUsage;
      resolvedModel?: string;
      providerRequestId?: string;
      modelRuns?: ExtractorModelRun[];
    };
    // Await every durable Queue hand-off even on failed arbitration/parses;
    // those provider calls were already billed before the error was thrown.
    await lease?.assertOwned();
    await reportExtractorUsage(env, telemetryModelRuns(cast, extractor.name));

    const detail = (err as Error).message;
    const message = isProviderRateLimit(err)
      ? `orchestrator: ${extractor.name} temporarily unavailable: provider quota/rate limit. Reprocess this filing later.`
      : `orchestrator: ${extractor.name} failed: ${detail}`;
    await markError(env, docId, message, lease);

    if (isProviderRateLimit(err) && env.CONFIG_KV && !configuredVisionOwnsBreaker) {
      try {
        await env.CONFIG_KV.put(breakerKey, String(Date.now() + 3600 * 1000), { expirationTtl: 3600 });
      } catch (kvErr) {
        console.warn('orchestrator: failed to set circuit breaker in KV:', (kvErr as Error).message);
      }
    }

    // Re-throw so the queue retries transient failures, including a rate limit
    // that's still exhausted after visionLlm's in-request fetchWithRetry backoff
    // (a few seconds) — the queue's own retry cadence (max_retries in
    // wrangler.toml) covers a longer provider quota window than a single
    // message attempt can.
    throw err;
  }

  await lease?.assertOwned();
  await reportExtractorUsage(env, telemetryModelRuns(result, result.extractor));

  // Complexity signal for cascade tiering: page count, when the extractor
  // cheaply exposed it (e.g. TextPdfExtractor reads pdf.numPages off the
  // document proxy it already parsed for text — no extra page merge). Not
  // part of the ExtractorResult contract, so read it via an optional-property
  // cast rather than widening that interface. Best-effort — a failure here
  // must never fail extraction.
  try {
    const pageCount = (result as ExtractorResult & { pageCount?: number | null }).pageCount ?? null;
    if (pageCount !== null) {
      await run(env.DB, 'UPDATE filings SET page_count = ? WHERE doc_id = ?', [pageCount, docId]);
    }
  } catch (err) {
    console.warn('orchestrator: failed to record page_count:', docId, (err as Error).message);
  }

  return {
    filing,
    transactions: result.transactions,
    extractor: result.extractor,
    modelVersion: result.modelVersion ?? null,
    raw: result.raw ?? '',
    modelRuns: result.modelRuns,
    parseDisposition: result.parseDisposition,
    // CT-2448: the pre-extractor copy above, so the retry reads the full PDF
    // even when an extractor detached the shared buffer it was handed.
    bytes: ocrBytes,
  };
}
