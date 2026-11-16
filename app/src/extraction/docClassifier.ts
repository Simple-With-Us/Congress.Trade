/**
 * src/extraction/docClassifier.ts
 *
 * PRE-EXTRACTION DOCUMENT CLASSIFIER. Assigns every filing a doc_class
 * (persisted on filings.doc_class — the lighter fit next to the 0033
 * page_count/raw_bytes complexity signals):
 *
 *   typed       digitally-generated text layer (text PDF / Senate eFD HTML)
 *   clean_scan  machine-printed scan, clearly legible
 *   hard_scan   handwritten / skewed / low-res / very large scan
 *   empty       no transaction content (blank form, cover sheet only)
 *   corrupt     not a readable document at all
 *
 * TWO TIERS, cost target ~$0:
 *  1. DETERMINISTIC signals first — PDF text-layer markers (the ingestion
 *     classifier's heuristics), pdf-lib loadability, page count, byte size,
 *     and bytes-per-page as an image-density proxy. All free; most were
 *     already computed by the pipeline (doc_kind, page_count, raw_bytes).
 *  2. Only for the ambiguous middle (a scan that is neither clearly clean nor
 *     clearly hard), ONE cheap OpenRouter call on a bottom-tier model using
 *     the FREE parse engine, output constrained to the enum via structured
 *     outputs. Any failure falls back to 'hard_scan' (the safest class: full
 *     trio) without blocking anything.
 *
 * CONSUMERS (wired in this PR): the backlog autopilot's run ordering
 * (typed/clean first — cheapest wins), the agreement cascade's start tier
 * (hard_scan → tier 2 full trio), empty auto-resolve + corrupt quarantine in
 * the autopilot, and doc_class as a receipt/attribution dimension.
 */

import type { Env } from '../shared/types.ts';
import { get, run } from '../shared/db.ts';
// CT-2459: pdf-lib dynamic-imported at first use (startup graph trim).
import { resolveSecrets } from '../secrets/infisical.ts';
import { keyFor } from './bakeoff.ts';
import { looksLikePdf } from '../ingestion/classifier.ts';
import { isHouseElectronicDocId } from './extractRouting.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import {
  OPENROUTER_PURPOSE,
  buildOpenRouterClassifier,
  openRouterAttributionHeaders,
} from '../shared/openRouterAttribution.ts';

export type DocClass = 'typed' | 'clean_scan' | 'hard_scan' | 'empty' | 'corrupt';

export const DOC_CLASSES: readonly DocClass[] = [
  'typed', 'clean_scan', 'hard_scan', 'empty', 'corrupt',
];

/** Autopilot ordering priority: cheapest-to-resolve classes first. */
export const DOC_CLASS_ORDER_SQL = `CASE COALESCE(f.doc_class, '')
           WHEN 'typed' THEN 0
           WHEN 'clean_scan' THEN 1
           WHEN 'empty' THEN 2
           WHEN '' THEN 3
           WHEN 'hard_scan' THEN 4
           ELSE 5 END`;

// Deterministic thresholds (bytes-per-page as a cheap image-density proxy).
const EMPTY_MAX_BYTES_PER_PAGE = 8 * 1024;
const CLEAN_MAX_BYTES_PER_PAGE = 300 * 1024;
const HARD_MIN_BYTES_PER_PAGE = 600 * 1024;
const HARD_MIN_TOTAL_BYTES = 2 * 1024 * 1024;
const HARD_MIN_PAGES = 10;
const SNIFF_BYTES = 256 * 1024;

export interface DocClassSignals {
  byteLength: number;
  /** pdf-lib could load the document (only meaningful when it claims %PDF). */
  pdfLoadable: boolean;
  claimsPdf: boolean;
  pageCount: number | null;
  /** Text-layer markers (/Font + BT..Tj) present in the byte prefix. */
  hasTextLayer: boolean;
  /** /Subtype /Image marker present in the byte prefix. */
  hasImages: boolean;
  /** Pipeline docKind hint when known (text_pdf | scanned_pdf | senate_html | unknown). */
  docKind?: string | null;
  /** Filing id — House 20xxxxxx electronic PTRs are typed without a model call. */
  docId?: string | null;
}

/** Compute the free deterministic signals for a raw document. */
export async function computeDocClassSignals(
  bytes: ArrayBuffer,
  docKind?: string | null,
): Promise<DocClassSignals> {
  const view = new Uint8Array(bytes);
  const claimsPdf = looksLikePdf(view);
  const prefix = new TextDecoder('latin1').decode(
    view.subarray(0, Math.min(view.length, SNIFF_BYTES)),
  );
  const hasFont = prefix.includes('/Font');
  const hasTextShow = /\bBT\b[\s\S]*?\b(Tj|TJ)\b/.test(prefix) || /\)\s*Tj/.test(prefix);
  const hasImages = /\/Subtype\s*\/Image/.test(prefix);
  let pdfLoadable = false;
  let pageCount: number | null = null;
  if (claimsPdf) {
    try {
      const { PDFDocument } = await import('pdf-lib');
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
      pageCount = pdf.getPageCount();
      pdfLoadable = true;
    } catch {
      pdfLoadable = false;
    }
  }
  return {
    byteLength: view.byteLength,
    pdfLoadable,
    claimsPdf,
    pageCount,
    // Fonts mean a real text layer even when Flate-compressed streams hide
    // BT..Tj from the raw sniff (same bias as classifyPdfBytes). Requiring
    // both markers sent typed House PTRs to the scan/Files path.
    hasTextLayer: hasFont || hasTextShow,
    hasImages,
    docKind: docKind ?? null,
  };
}

/**
 * Tier-1 decision. Returns null for the ambiguous middle (goes to the model
 * tier); every non-null answer is confident enough to persist.
 */
export function decideDocClass(signals: DocClassSignals): DocClass | null {
  if (signals.byteLength === 0) return 'corrupt';
  if (signals.claimsPdf && !signals.pdfLoadable) return 'corrupt';
  if (signals.docKind === 'senate_html') return 'typed';
  if (signals.docId && isHouseElectronicDocId(signals.docId)) return 'typed';
  if (signals.docKind === 'text_pdf' || signals.hasTextLayer) return 'typed';
  if (!signals.claimsPdf) {
    // Not a PDF, not eFD HTML: the pipeline calls this docKind 'unknown';
    // there is nothing our extractors can read.
    return signals.docKind === 'unknown' ? 'corrupt' : null;
  }
  const pages = signals.pageCount ?? 0;
  if (pages === 0) return 'empty';
  const bytesPerPage = signals.byteLength / pages;
  if (!signals.hasImages && bytesPerPage < EMPTY_MAX_BYTES_PER_PAGE) return 'empty';
  if (
    pages > HARD_MIN_PAGES
    || signals.byteLength > HARD_MIN_TOTAL_BYTES
    || bytesPerPage > HARD_MIN_BYTES_PER_PAGE
  ) return 'hard_scan';
  if (bytesPerPage <= CLEAN_MAX_BYTES_PER_PAGE) return 'clean_scan';
  return null; // ambiguous density band → one cheap model call
}

// ---------------------------------------------------------------------------
// Tier 2 — one cheap enum-constrained OpenRouter classification call
// ---------------------------------------------------------------------------

export interface DocClassifierKnobs {
  enabled: boolean;
  model: string;
  parseEngine: string;
}

interface DocClassifierSecretEnv {
  DOC_CLASSIFIER_ENABLED?: string;
  DOC_CLASSIFIER_MODEL?: string;
  DOC_CLASSIFIER_PARSE_ENGINE?: string;
}

export async function resolveDocClassifierKnobs(env: Env): Promise<DocClassifierKnobs> {
  let secrets: DocClassifierSecretEnv = {};
  try {
    secrets = (await resolveSecrets(env, [
      'DOC_CLASSIFIER_ENABLED',
      'DOC_CLASSIFIER_MODEL',
      'DOC_CLASSIFIER_PARSE_ENGINE',
    ])) as DocClassifierSecretEnv;
  } catch {
    // Resolver outage: deterministic tier still works; model tier disabled.
    return { enabled: false, model: 'google/gemini-3.5-flash-lite', parseEngine: 'cloudflare-ai' };
  }
  return {
    enabled: secrets.DOC_CLASSIFIER_ENABLED !== 'false',
    model: secrets.DOC_CLASSIFIER_MODEL || 'google/gemini-3.5-flash-lite',
    parseEngine: secrets.DOC_CLASSIFIER_PARSE_ENGINE || 'cloudflare-ai',
  };
}

const CLASSIFIER_PROMPT = `Classify this U.S. financial-disclosure document. Reply with JSON {"doc_class": X} where X is exactly one of:
"typed" (digitally generated, selectable text layer),
"clean_scan" (scanned form, machine-printed, clearly legible),
"hard_scan" (scanned form that is handwritten, skewed, low-resolution, or otherwise hard to read),
"empty" (no transaction content: blank form or cover page only),
"corrupt" (not a readable document).`;

function arrayBufferToBase64Chunked(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode(...view.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function parseDocClassReply(text: string): DocClass | null {
  try {
    const parsed = JSON.parse(text) as { doc_class?: unknown };
    if (typeof parsed.doc_class === 'string' && (DOC_CLASSES as string[]).includes(parsed.doc_class)) {
      return parsed.doc_class as DocClass;
    }
  } catch {
    // Fall through to a token scan of unstructured output.
  }
  const lower = text.toLowerCase();
  return DOC_CLASSES.find((cls) => lower.includes(`"${cls}"`) || lower.includes(cls)) ?? null;
}

/**
 * ONE bottom-tier OpenRouter call with the free parse engine and an
 * enum-constrained structured output. Never throws; null on any failure.
 */
export async function classifyDocClassWithModel(
  env: Env,
  bytes: ArrayBuffer,
  knobs: DocClassifierKnobs,
  signal?: AbortSignal,
): Promise<DocClass | null> {
  try {
    signal?.throwIfAborted();
    const key = await keyFor(env, 'openrouter');
    if (!key) return null;
    const classifierEnrichment = buildOpenRouterClassifier(env, {
      service: 'docClassifier',
      purpose: OPENROUTER_PURPOSE.DOC_CLASS,
      feature: 'doc-class',
      keyRef: 'OPENROUTER_API_KEY',
    });
    const res = await trackedFetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...openRouterAttributionHeaders(),
      },
      body: JSON.stringify({
        model: knobs.model,
        max_tokens: 32,
        plugins: [{ id: 'file-parser', pdf: { engine: knobs.parseEngine } }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'doc_class',
            strict: true,
            schema: {
              type: 'object',
              properties: { doc_class: { type: 'string', enum: [...DOC_CLASSES] } },
              required: ['doc_class'],
              additionalProperties: false,
            },
          },
        },
        messages: [{
          role: 'user',
          content: [
            {
              type: 'file',
              file: {
                filename: 'document.pdf',
                file_data: `[PDF attachment removed — 0 KB]${arrayBufferToBase64Chunked(bytes)}`,
              },
            },
            { type: 'text', text: CLASSIFIER_PROMPT },
          ],
        }],
        // App classifier tags for OpenRouter Activity + Usage-Monitor filters.
        ...classifierEnrichment,
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    }, { service: 'llm', operation: 'classify-document', model: knobs.model });
    if (!res.ok) {
      console.warn(`doc classifier: OpenRouter ${res.status}`);
      return null;
    }
    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = payload.choices?.[0]?.message?.content ?? '';
    return text ? parseDocClassReply(text) : null;
  } catch (err) {
    signal?.throwIfAborted();
    console.warn('doc classifier: model call failed:', (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Orchestration: resolve-or-classify + persist
// ---------------------------------------------------------------------------

export interface DocClassResult {
  docClass: DocClass;
  source: 'persisted' | 'deterministic' | 'model' | 'fallback';
}

export interface EnsureDocClassDeps {
  /** Injectable for tests; defaults to computeDocClassSignals. */
  computeSignals?: typeof computeDocClassSignals;
  /** Injectable for tests; defaults to classifyDocClassWithModel. */
  classifyModel?: typeof classifyDocClassWithModel;
  /** Abort classification and persistence when the durable queue lease is lost. */
  signal?: AbortSignal;
}

/**
 * Return the filing's doc_class, classifying + persisting it when absent.
 * Deterministic signals first; one cheap model call only for the ambiguous
 * middle; 'hard_scan' (full trio — the safest treatment) when both tiers
 * abstain. Never throws; a pre-migration DB simply skips persistence.
 */
export async function ensureDocClass(
  env: Env,
  docId: string,
  bytes: ArrayBuffer,
  docKindHint?: string | null,
  deps: EnsureDocClassDeps = {},
): Promise<DocClassResult> {
  const computeSignals = deps.computeSignals ?? computeDocClassSignals;
  const classifyModel = deps.classifyModel ?? classifyDocClassWithModel;
  const signal = deps.signal;
  signal?.throwIfAborted();
  try {
    const row = await get<{ doc_class: string | null; doc_kind: string | null }>(
      env.DB,
      'SELECT doc_class, doc_kind FROM filings WHERE doc_id = ?',
      [docId],
    );
    if (row?.doc_class && (DOC_CLASSES as string[]).includes(row.doc_class)) {
      return { docClass: row.doc_class as DocClass, source: 'persisted' };
    }
    if (!docKindHint && row?.doc_kind) docKindHint = row.doc_kind;
  } catch {
    signal?.throwIfAborted();
    // doc_class column not migrated yet — classify without the cache.
  }

  let docClass: DocClass | null = null;
  let source: DocClassResult['source'] = 'deterministic';
  try {
    signal?.throwIfAborted();
    const signals = await computeSignals(bytes, docKindHint);
    signal?.throwIfAborted();
    docClass = decideDocClass({ ...signals, docId });
    if (!docClass && isHouseElectronicDocId(docId)) docClass = 'typed';
  } catch (err) {
    signal?.throwIfAborted();
    console.warn('doc classifier: signal computation failed:', docId, (err as Error).message);
  }
  if (!docClass) {
    const knobs = await resolveDocClassifierKnobs(env);
    if (knobs.enabled) {
      docClass = signal
        ? await classifyModel(env, bytes, knobs, signal)
        : await classifyModel(env, bytes, knobs);
      signal?.throwIfAborted();
      source = 'model';
    }
  }
  if (!docClass) {
    docClass = 'hard_scan';
    source = 'fallback';
  }
  try {
    signal?.throwIfAborted();
    await run(env.DB, 'UPDATE filings SET doc_class = ? WHERE doc_id = ?', [docClass, docId]);
  } catch {
    signal?.throwIfAborted();
    // Pre-migration DB: the classification still informs this invocation.
  }
  return { docClass, source };
}
