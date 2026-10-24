/**
 * src/extraction/normalizer.ts
 * OWNER: extraction agent
 *
 * The validator / normalizer + persistence step. Turns extractor output
 * (ParsedTx[]) into persistence-ready Transaction rows and writes the result:
 *   - resolve ticker against securities_master (exact ticker, then alias JSON)
 *   - enforce the canonical STOCK Act bracket set (see src/shared/brackets.ts)
 *   - sanity-check tx_date <= filed_date and tx_type in {B,S,E} (legacy P coerced to B)
 *   - compute per-tx confidence = extractor confidence x validation penalties
 *   - route low-confidence docs to review_queue; otherwise INSERT transactions,
 *     mark filings persisted, and fan out delivery.dispatch per tx.
 *
 * index.ts does NOT delegate persistence to a separate module (the
 * `filing.extracted` queue case is a no-op hook), so this function owns the full
 * normalize + persist path. The extraction orchestrator calls:
 *     const result = await normalize(env, filing, extractorResult.transactions);
 * after running buildExtractorPipeline(env).
 */

import type { Env, Filing, Owner, ParsedTx, Transaction, TxType, TxSource } from '../shared/types.ts';
import {
  isDeletedFilingStatus,
  looksLikeHeaderContaminatedAsset,
  looksLikeNothingToReport,
  looksLikeOgePart7ExplicitNone,
  dropPtrFormSamplesForPublish,
  looksLikePtrFormSampleAsset,
  looksLikePtrFormSampleRow,
  looksLikeSeeAttachmentPointer,
} from './extractRouting.ts';
import {
  handCheckReviewReason,
  mergeHandCheckIntoReviewReason,
  NEEDS_HAND_CHECK_MAC_VISION,
  NEEDS_HAND_CHECK_SCANNED_VISION,
  requiresHandCheckBeforePublish,
} from './handCheckPublish.ts';
import type { ExtractorParseDisposition } from '../extractors/types.ts';
import {
  closeUnreadableExecutive,
  closeVerifiedEmptyExecutive,
  EXECUTIVE_EMPTY_RESOLUTION_REASON,
  OGE_TEXT_UNREADABLE_REASON,
} from './executiveDisposition.ts';
import { all, batch, fromBool, get, parseJson, run } from '../shared/db.ts';
import { isValidBracket, matchBracket, nearestBracket } from '../shared/brackets.ts';
import { canonicalizeAssetType, inferHouseAssetTypeCode, HOUSE_ASSET_TYPE_NAMES } from '../shared/assetTypes.ts';
import { prepareExtractedTx } from './prepareTx.ts';
import { uuid } from '../shared/ids.ts';
import { recordTradeLatencyCandidates } from '../ingestion/tradeLatency.ts';
import { notifyReviewQueuePublisher } from '../ingestion/reviewQueueNotify.ts';
import { estimateTransactionValue } from '../shared/transactionValue.ts';
import { computeDisclosureLagDays, computeStockActStatus } from '../shared/stockAct.ts';
import {
  isPlaceholderTicker,
  resolvePreferredTickerFromAssetName,
  resolveTickerDeterministic,
} from './tickerNormalize.ts';
import {
  cleanFilerName,
  isJunkAssetString,
  cleanAssetString,
  simplifyCompanyName,
  splitAssetNameDetail,
} from './nameNormalizer.ts';
import { resolveContinuousTicker } from '@jaywedgeworth22/congress-trading-shared';
import { flushDeliveryOutbox } from '../delivery/outbox.ts';
import { deprecatePredecessorFilingTransactions } from './agreement.ts';
import { stripOgeRowIndexes } from './ogeRowIndex.ts';
import {
  addIssuerName,
  emptyIssuerNameIndex,
  loadIssuerNameIndex,
  resolveTickerByIssuerName,
  type IssuerNameIndex,
} from '../enrichment/nameTickerBackfill.ts';
import { parseAmountRange } from './amounts.ts';
import { issuerWords, normalizeEmbeddedOcrDates, normalizeOcrAssetName, validateTxDate } from './ocrSanity.ts';
import type { OcrNameResult } from './ocrSanity.ts';
import { canonicalizeTxType } from '../shared/txType.ts';
import {
  PIPELINE_TX_SOURCES_SQL,
  VISION_SUPERSEDE_REASON,
  canSupersedeResolvedVision,
  isVisionTxSource,
  supersededPipelineSourcesSql,
} from './sourceSupersede.ts';

/**
 * Per-tx confidence at or above this threshold is trusted for auto-publish. If a
 * filing's lowest per-tx confidence falls below it (or any structural validation
 * fails), the whole filing is routed to review instead of being published.
 */
export const CONFIDENCE_THRESHOLD = 0.95;
/**
 * Deterministic extractors (House text PDF, Senate HTML, OGE text) already
 * produce structured rows without vision hallucination. They historically sat
 * forever in review when OpenRouter agreement was halted because their base
 * confidence (~0.55–0.65) is below the vision threshold. Publish them when
 * mechanical hard flags are clean.
 */
export const DETERMINISTIC_CONFIDENCE_THRESHOLD = 0.55;
/** Sanity cap only — real PTRs (McCaul munis, Khanna) routinely exceed 200. */
export const MAX_PUBLISH_TRANSACTIONS_PER_FILING = 2000;
/** Run the garbage heuristic above this count; do not block clean large filings. */
const LARGE_FILING_GARBAGE_REVIEW = 200;

/** Extractors / doc kinds that do not require multi-model agreement. */
const DETERMINISTIC_EXTRACTORS = new Set([
  'textpdf',
  'text_pdf',
  'senatehtml',
  'senate_html',
  'ogetext',
  'oge_text',
  'oge-text',
]);

export function isDeterministicExtractor(
  extractor: string | null | undefined,
  docKind?: string | null,
): boolean {
  const compact = (extractor || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (compact) {
    if (
      DETERMINISTIC_EXTRACTORS.has(compact)
      || compact === 'textpdf'
      || compact === 'senatehtml'
      || compact === 'ogetext'
    ) {
      return true;
    }
    // Cheap OpenRouter text fallback on typed PTRs is not vision.  Default
    // model confidence is 0.55 — same publish bar as textPdf.  Live 2026-08-18:
    // 14 electronic House PTRs sat in review at 0.6 solely because
    // "openrouter" in the extractor name inherited the 0.95 vision gate.
    if (compact === 'openroutertext' || compact === 'open_router_text') {
      const kind = (docKind || '').trim().toLowerCase();
      return kind === 'text_pdf' || kind === 'senate_html' || kind === 'oge_html' || kind === 'oge_text';
    }
    // Explicit vision/OCR extractors must never inherit the deterministic
    // threshold from a text/html doc_kind (scanned reclassifications, etc.).
    if (
      compact.includes('vision')
      || compact.includes('grok')
      || compact.includes('server_cpu')
      || compact.includes('openrouter')
      || compact.includes('anthropic')
      || compact.includes('mistral')
      || compact.includes('llamaparse')
      || compact.includes('local_mac')
      || compact.includes('local_grok')
    ) {
      return false;
    }
  }
  const kind = (docKind || '').trim().toLowerCase();
  return kind === 'text_pdf' || kind === 'senate_html' || kind === 'oge_html' || kind === 'oge_text';
}

export function confidenceThresholdFor(
  extractor: string | null | undefined,
  docKind?: string | null,
): number {
  return isDeterministicExtractor(extractor, docKind)
    ? DETERMINISTIC_CONFIDENCE_THRESHOLD
    : CONFIDENCE_THRESHOLD;
}

/** Mac Grok-CLI / local_mac vision — subscription path, not server_cpu OCR. */
export function isLocalVisionExtractor(extractor: string | null | undefined): boolean {
  const compact = (extractor || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return compact.includes('local_grok')
    || compact.includes('local_mac')
    || compact.includes('mac_vision');
}

function hardFlagsBlockingPublish(
  flags: readonly string[],
  localVision: boolean,
): string[] {
  return flags.filter((flag) => {
    // Local Grok/Gemini reads of long PTR grids often miss one checkbox or
    // date.  Holding the whole filing for that one row is how Khanna
    // H-2025-8221264 (209 dated lots + one blank SAP line) sat in review.
    if (localVision && (flag === 'no_amount' || flag === 'missing_tx_date')) return false;
    return HARD_FAILURE_FLAG_SET.has(flag);
  });
}

export class TransactionPublishLimitError extends Error {}

// Multiplicative penalties applied to the extractor's per-row confidence when a
// validation check is soft-failed. Each is in (0,1]; they compound.
const PENALTY_UNRESOLVED_TICKER = 0.85; // asset/ticker could not be resolved
const PENALTY_INVALID_BRACKET = 0.6; //   amount range is not a canonical bracket
const PENALTY_FUTURE_TX_DATE = 0.7; //    tx_date after the filing's filed_date or today
const PENALTY_MISSING_TX_DATE = 0.7; //   tx_date is missing entirely
const PENALTY_BAD_TX_TYPE = 0.5; //       tx_type not in {B,S,E}
const PENALTY_BAD_ASSET_NAME = 0.4; //    parsed asset contains PTR header chrome
const PENALTY_BAD_TX_DATE = 0.4; //       tx_date is impossible or wildly out of range
const PENALTY_OCR_HOLD = 0.4; //          asset name has unfixable OCR garble

/** Outcome of normalizing one filing's extracted rows. */
export interface NormalizeResult {
  /** Rows that passed validation and were persisted (or staged for review). */
  transactions: Transaction[];
  /** The minimum per-tx confidence across the filing (0 when no rows were read). */
  minConfidence: number;
  /** Whether the filing was routed to review_queue rather than published. */
  needsReview: boolean;
  /** True only when this invocation won the persistence/review-state CAS. */
  published: boolean;
  /** Review-queue reason when needsReview is true (agreement hard-stop input). */
  reviewReason?: string;
  /** True when this invocation resolved the filing's review state with
   *  nothing new to persist (a terminal no-op success, e.g.
   *  amendment_already_persisted / deleted_rows_applied).  Distinct from a
   *  lost CAS, which is also needsReview:false / published:false. */
  settled?: boolean;
}

interface ReviewSnapshot {
  resolved: number;
  review_revision: number;
  agreement_suppressed_at: string | null;
  payload: string | null;
}

export interface FlaggedTx {
  tx: Transaction;
  flags: string[];
}

/** Flags that force a filing to human review regardless of soft confidence. */
export const HARD_FAILURE_FLAGS = [
  'no_amount',
  'invalid_amount',
  'bad_tx_type',
  'suspected_constant_tx_type',
  'bad_asset_name',
  'unreadable_is_option',
  'unreadable_cap_gains',
  'future_tx_date',
  'missing_tx_date',
  'bad_tx_date',
  'tx_date_too_old',
  'ocr_name_hold',
  'ocr_date_hold',
];
const HARD_FAILURE_FLAG_SET = new Set<string>(HARD_FAILURE_FLAGS);

export function hasHardFailureFlags(flagged: Iterable<{ flags: readonly string[] }>): boolean {
  for (const f of flagged) {
    if (f.flags.some((flag) => HARD_FAILURE_FLAG_SET.has(flag))) return true;
  }
  return false;
}

type RowKeyFields = Pick<
  ParsedTx,
  | 'txDate'
  | 'owner'
  | 'assetName'
  | 'ticker'
  | 'assetType'
  | 'assetTypeName'
  | 'txType'
  | 'amountMin'
  | 'amountMax'
  | 'isOption'
  | 'capGainsOver200'
  | 'rawText'
  | 'filingStatus'
  | 'subholding'
  | 'location'
  | 'description'
  | 'supplementalText'
>;

/**
 * Stable identity for one parsed row within one filing. The row index keeps
 * duplicate disclosed rows distinct; the fingerprint catches changed edits at
 * the same position. The unique DB key is (doc_id, source, row_key).
 */
export function transactionRowKey(
  source: Transaction['source'],
  rowIndex: number,
  fields: RowKeyFields,
): string {
  const payload = [
    fields.txDate ?? '',
    normalizeText(fields.owner ?? null),
    normalizeText(fields.assetName),
    (fields.ticker ?? '').toUpperCase(),
    normalizeText(fields.assetType),
    rowKeyAssetTypeName(fields.assetType, fields.assetTypeName ?? null),
    fields.txType ?? '',
    fields.amountMin ?? '',
    fields.amountMax ?? '',
    fields.isOption ? '1' : '0',
    fields.capGainsOver200 ? '1' : '0',
    normalizeText(fields.rawText),
    normalizeText(fields.filingStatus ?? null),
    normalizeText(fields.subholding ?? null),
    normalizeText(fields.location ?? null),
    normalizeText(fields.description ?? null),
    normalizeText(fields.supplementalText ?? null),
  ].join('\u001f');
  return `v1:${source}:${rowIndex}:${fnv1a32(payload)}`;
}

function rowKeyAssetTypeName(assetType: string | null | undefined, assetTypeName: string | null): string {
  const type = normalizeText(assetType ?? null);
  const name = normalizeText(assetTypeName);
  return name && name !== type ? name : '';
}

/**
 * Re-derive Transaction rows (with the current, recalibrated confidence rubric)
 * from parsed rows WITHOUT any DB write or delivery fan-out. Shared by normalize()
 * and the admin reprocess path, which recomputes confidence for already-persisted
 * filings and updates the existing rows in place.
 */
export async function recomputeTransactions(
  env: Env,
  filing: Filing,
  parsed: ParsedTx[],
  sourceOverride?: TxSource,
): Promise<FlaggedTx[]> {
  const nowIso = new Date().toISOString();
  const [resolver, nameIndex] = await Promise.all([loadResolver(env), loadNameIndex(env)]);
  // Word-level OCR evidence from securities_ref company names, derived once
  // for the whole filing so per-row scoring stays cheap.
  const ocrExtraWords = issuerWords(nameIndex.values());
  // An executive 278-T's "#" column arrives glued onto the asset name on the
  // scanned path ("3641 Microsoft Corp. Com"); strip it before the resolver sees
  // the name, when the filing itself shows the pattern (board row 3d31c7b9).
  const rows = filing.chamber === 'executive' ? stripOgeRowIndexes(parsed) : parsed;
  return rows.map((p, rowIndex) =>
    buildTransaction(p, filing, resolver, nowIso, rowIndex, sourceOverride, nameIndex, ocrExtraWords),
  );
}

/** securities_master row shape. `aliases` is a JSON string array. */
export interface SecRow {
  ticker: string;
  name: string | null;
  aliases: string | null;
}

/** securities_ref row shape (only the columns this module reads). */
interface SecRefRow {
  ticker: string;
  company_name: string | null;
}

/**
 * Normalize + validate parsed transactions for a filing, then persist.
 *
 * Behaviour:
 *   - Drop PTR form-chrome rows (Clerk letterhead / table headers) before scoring
 *     so OCR noise never reaches review_queue as fake "transactions".
 *   - Build a Transaction for each remaining ParsedTx, applying ticker resolution
 *     and validation penalties to derive a final per-tx confidence.
 *   - needsReview = (no rows) OR (minConfidence < CONFIDENCE_THRESHOLD) OR any
 *     hard structural problem (invalid bracket, bad tx_type).
 *   - If needsReview: write a review_queue row + filings.ingest_status =
 *     'needs_review'; do NOT INSERT transactions and do NOT publish.
 *   - Else: INSERT each transaction (source='primary'), set ingest_status =
 *     'persisted', and enqueue { type:'delivery.dispatch', txId } per row.
 *   - In all cases store filings.confidence / extractor / model_version.
 */
export async function normalize(
  env: Env,
  filing: Filing,
  parsed: ParsedTx[],
  meta?: {
    extractor?: string;
    modelVersion?: string | null;
    source?: TxSource;
    /** Full document text.  Zero parsed rows still need this to see Part 7 "None". */
    sourceText?: string | null;
    /** Set by ogeText.  `empty` and `unreadable` are different zero-row outcomes. */
    parseDisposition?: ExtractorParseDisposition;
  },
): Promise<NormalizeResult> {
  const nowIso = new Date().toISOString();
  const extractorName = meta?.extractor ?? filing.extractor ?? null;
  const modelVersion = meta?.modelVersion ?? filing.modelVersion ?? null;
  const source = meta?.source ?? 'primary';
  const sourceText = meta?.sourceText ?? null;

  // Drop form-chrome rows up front. Pure letterhead OCR floods were parking
  // hundreds of "Clerk of the House…" fakes in review_queue and burning the
  // agreement cascade budget on documents with zero real trades.
  const usableParsed = dropPtrFormSamplesForPublish(filing.docId, parsed).filter((p) =>
    !looksLikeHeaderContaminatedAsset(p.assetName)
    && !looksLikeSeeAttachmentPointer(p.assetName)
    && !looksLikeSeeAttachmentPointer(p.rawText)
    && !looksLikeNothingToReport(p.assetName)
  );
  const droppedFormChrome = parsed.length - usableParsed.length;
  const sawOgePart7ExplicitNone = looksLikeOgePart7ExplicitNone(sourceText)
    || parsed.some((p) =>
      looksLikeOgePart7ExplicitNone(p.assetName) || looksLikeOgePart7ExplicitNone(p.rawText)
    );
  const sawNothingToReport = sawOgePart7ExplicitNone || parsed.some((p) =>
    looksLikeNothingToReport(p.assetName) || looksLikeNothingToReport(p.rawText)
  );

  const allFlagged: FlaggedTx[] = await recomputeTransactions(env, filing, usableParsed, source);
  const deletedFlagged = allFlagged.filter((f) => isDeletedFilingStatus(f.tx.filingStatus));
  const flagged = allFlagged.filter((f) => !isDeletedFilingStatus(f.tx.filingStatus));

  const minConfidence = flagged.length
    ? Math.min(...flagged.map((f) => f.tx.confidence))
    : 0;

  // Local vision: an omitted amount checkbox on an otherwise-read row
  // (prod H-2025-9115689 page 4) must not hold sibling trades.  Gate
  // confidence on the rows that have amounts; still persist the omitted
  // ones with null brackets.  If every row omitted the amount, keep the
  // real (penalized) min so the filing stays in review — pretending we
  // met the threshold used to auto-publish amount-less extracts as live
  // (sideways / portrait Grok CLI misses, 2026-08-21).
  // Mac vision-worker always posts source=local_mac, including OpenRouter
  // cascade hits labeled openrouter_google_gemini_…  Those must use the same
  // omitted-checkbox soften as local Grok.  Otherwise a 13+ page PTR that
  // #2142 sent to Gemini parks the whole packet when one attached-schedule
  // row has no amount box (Rogers / Khanna).
  const localVision = isLocalVisionExtractor(extractorName) || source === 'local_mac';
  const gateRows = localVision
    ? flagged.filter((f) => hardFlagsBlockingPublish(f.flags, true).length === 0
      && !f.flags.includes('no_amount')
      && !f.flags.includes('missing_tx_date'))
    : flagged;
  const gateMinConfidence = gateRows.length
    ? Math.min(...gateRows.map((f) => f.tx.confidence))
    : minConfidence;

  // Hard structural failures force review regardless of the soft confidence.
  const hasHardFailure = localVision
    ? flagged.some((f) => hardFlagsBlockingPublish(f.flags, true).length > 0)
    : hasHardFailureFlags(flagged);
  const hardFailureCount = flagged.filter((f) =>
    f.flags.some((flag) => HARD_FAILURE_FLAG_SET.has(flag)),
  ).length;
  const exceedsSanityCap = flagged.length > MAX_PUBLISH_TRANSACTIONS_PER_FILING;
  const largeAndGarbage =
    flagged.length > LARGE_FILING_GARBAGE_REVIEW && oversizedLooksLikeGarbage(flagged);
  const exceedsPublishLimit = exceedsSanityCap || largeAndGarbage;
  const ocrUnusable = isMostlyGarbageOcrExtraction(
    parsed.length,
    flagged.length,
    hardFailureCount,
  );
  // Deterministic text/html extractors publish at a lower confidence gate so
  // OpenRouter agreement outages cannot strand already-structured rows.
  const confThreshold = confidenceThresholdFor(extractorName, filing.docKind);

  let needsReview =
    flagged.length === 0
    || gateMinConfidence < confThreshold
    || hasHardFailure
    || exceedsPublishLimit
    || ocrUnusable;

  const isAmendment =
    /amend|\(2\)|278t\(\d+\)/i.test(filing.docId) ||
    (filing.filingType && /amend/i.test(filing.filingType)) ||
    parsed.some((p) => p.filingStatus && /amend/i.test(p.filingStatus));

  if (isAmendment) {
    for (const f of flagged) {
      if (!f.tx.filingStatus) {
        f.tx.filingStatus = 'amended';
      }
    }
  }

  // Local vision: persist siblings even when one grid row omitted a date.
  // Do not insert the undated row into the live feed.
  const persistFlagged = localVision
    ? flagged.filter((f) => !f.flags.includes('missing_tx_date'))
    : flagged;
  const transactions = persistFlagged.map((f) => f.tx);

  // Capture the queue version before any material state transition. The
  // review-open and publish batches below are conditional on this snapshot, so
  // a human decision that lands first wins without partial transaction rows.
  const reviewSnapshot = await get<ReviewSnapshot>(
    env.DB,
    `SELECT resolved, review_revision, agreement_suppressed_at, payload
       FROM review_queue WHERE doc_id = ?`,
    [filing.docId],
  );

  const handCheckRequired = requiresHandCheckBeforePublish(filing, extractorName, source)
    && reviewSnapshot?.resolved !== 1
    && flagged.length > 0;
  if (handCheckRequired) {
    needsReview = true;
  }

  // A completed decision is authoritative unless a later complete vision
  // extract is replacing a truncated confirm on the same doc_id. Replaying
  // an older/smaller extraction must not append a competing live row set.
  if (reviewSnapshot?.resolved === 1) {
    const incomingSource = transactions[0]?.source;
    const liveBySource = await all<{ source: string; n: number; dated: number }>(
      env.DB,
      `SELECT source,
              COUNT(*) AS n,
              SUM(CASE WHEN tx_date GLOB '????-??-??' THEN 1 ELSE 0 END) AS dated
         FROM transactions
        WHERE doc_id = ? AND deprecated_at IS NULL
          AND source IN (${PIPELINE_TX_SOURCES_SQL})
        GROUP BY source`,
      [filing.docId],
    );
    let liveSameSource = 0;
    let liveOther = 0;
    let liveOtherDated = 0;
    for (const row of liveBySource) {
      const n = Number(row.n) || 0;
      const dated = Number(row.dated) || 0;
      if (row.source === incomingSource) liveSameSource += n;
      else {
        liveOther += n;
        liveOtherDated += dated;
      }
    }
    const incomingDatedCount = transactions.filter(
      (tx) => typeof tx.txDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(tx.txDate),
    ).length;
    if (!canSupersedeResolvedVision({
      incomingSource,
      incomingCount: transactions.length,
      incomingDatedCount,
      liveSameSource,
      liveOther,
      liveOtherDated,
    })) {
      // textPdf Deleted amendments are not vision supersedes.  A hand-rejected
      // later official PTR (Hern H-2026-20035196) must still unpublish the
      // matching live row on reprocess after deploy.
      if (deletedFlagged.length > 0) {
        await deprecateDeletedMatches(env, filing, deletedFlagged, nowIso);
        return {
          transactions: [],
          minConfidence: 0,
          needsReview: false,
          published: false,
          reviewReason: 'deleted_rows_applied',
        };
      }
      return { transactions, minConfidence, needsReview: false, published: false };
    }
  }

  if (needsReview) {
    // A refused 278-T is not an empty filing.  docClassifier calls every
    // text_pdf `typed`, so this is the park the empty doc-class path misses.
    // The row stays open for a human.  It is not resolved in this tick.
    if (
      filing.chamber === 'executive'
      && flagged.length === 0
      && reviewSnapshot?.resolved !== 1
      && meta?.parseDisposition === 'unreadable'
    ) {
      const closed = await closeUnreadableExecutive(env, filing.docId, {
        nowIso,
        respectSuppression: true,
        insertIfAbsent: true,
        // Close only the review version we read: a human revision that lands
        // after the snapshot must win over this stale zero-row parse.
        reviewRevision: reviewSnapshot?.review_revision ?? null,
      });
      if (closed) {
        return {
          transactions: [],
          minConfidence: 0,
          needsReview: true,
          published: false,
          reviewReason: OGE_TEXT_UNREADABLE_REASON,
        };
      }
    }
    // Form-sample chrome alone is not NTR.  Example Mega Corp is printed on
    // every House PTR; OCR often reads it and misses the real trades.
    if (flagged.length === 0 && sawNothingToReport) {
      const resolutionReason = sawOgePart7ExplicitNone
        ? 'oge_part7_explicit_none'
        : 'nothing_to_report';
      const closed = await resolveVerifiedEmpty(
        env,
        filing,
        nowIso,
        reviewSnapshot,
        resolutionReason,
      );
      if (closed) {
        return {
          transactions: [],
          minConfidence: 0,
          needsReview: false,
          published: false,
          reviewReason: resolutionReason,
        };
      }
    }
    // 278e with no 278-T table and no rows, including a Part 7 that does not
    // literally say None.  A successful read that already found rows blocks this.
    if (
      filing.chamber === 'executive'
      && flagged.length === 0
      && reviewSnapshot?.resolved !== 1
      && meta?.parseDisposition === 'empty'
    ) {
      const closed = await closeVerifiedEmptyExecutive(env, filing.docId, {
        nowIso,
        respectSuppression: true,
        insertIfAbsent: true,
        // Close only the review version we read: a retry-auto that bumps the
        // revision must not let a stale empty parse close the freshly
        // released row (same guard as the unreadable branch above).
        reviewRevision: reviewSnapshot?.review_revision ?? null,
      });
      if (closed) {
        return {
          transactions: [],
          minConfidence: 0,
          needsReview: false,
          published: false,
          reviewReason: EXECUTIVE_EMPTY_RESOLUTION_REASON,
        };
      }
    }
    if (flagged.length === 0 && deletedFlagged.length > 0) {
      await deprecateDeletedMatches(env, filing, deletedFlagged, nowIso);
      const closed = await resolveProcessedNoNewRows(
        env,
        filing,
        nowIso,
        reviewSnapshot,
        'deleted_rows_applied',
      );
      if (closed) {
        return {
          transactions: [],
          minConfidence: 0,
          needsReview: false,
          published: false,
          reviewReason: 'deleted_rows_applied',
          settled: true,
        };
      }
    }
    let reason = exceedsPublishLimit
      ? classifyRowLimitReason(flagged)
      : reviewReason(flagged, minConfidence, confThreshold);
    if (handCheckRequired && flagged.length > 0) {
      reason = mergeHandCheckIntoReviewReason(
        reason,
        handCheckReviewReason(filing, extractorName, source),
      );
    }
    // A refused text layer that could not be closed still must not be labeled
    // as an empty extract.  ocr_unusable is already a health terminal and an
    // agreement hard-stop.
    if (filing.chamber === 'executive' && meta?.parseDisposition === 'unreadable' && flagged.length === 0) {
      reason = OGE_TEXT_UNREADABLE_REASON;
    }
    // When every extracted row was form chrome (or empty after drop), tag the
    // park reason so ops/dashboard can tell OCR letterhead floods from real
    // low-confidence trades — and agreement can skip burning budget on them.
    if (flagged.length === 0 && droppedFormChrome > 0) {
      reason = reason
        ? `form_chrome_only,${reason}`
        : 'form_chrome_only,extract_empty_failure,no_transactions_extracted';
    }
    // Majority OCR garbage (server_cpu letterhead inventories): do not park
    // hundreds of fake rows for humans/agreement — empty extract_empty class
    // so local-vision pending can re-claim the stored raw copy.
    let reviewFlagged = flagged;
    if (ocrUnusable && !exceedsPublishLimit && meta?.parseDisposition !== 'unreadable') {
      // Keep dated, non-chrome rows (amendment letters with one real Treasury
      // line). Only wipe when nothing recoverable remains.
      const keepable = flagged.filter((f) =>
        Boolean(f.tx.txDate) && !looksLikeHeaderContaminatedAsset(f.tx.assetName)
      );
      if (keepable.length === 0) {
        reason = `ocr_unusable,extract_empty_failure,no_transactions_extracted`;
        if (droppedFormChrome > 0) reason = `form_chrome_only,${reason}`;
        reviewFlagged = [];
      } else {
        reviewFlagged = keepable;
        reason = reviewReason(
          keepable,
          Math.min(...keepable.map((f) => f.tx.confidence)),
          confThreshold,
        );
      }
    }
    const routed = await routeToReview(
      env,
      filing,
      reviewFlagged,
      ocrUnusable && reviewFlagged.length === 0 ? 0 : minConfidence,
      nowIso,
      {
        extractor: extractorName,
        modelVersion,
        reasonOverride:
          exceedsPublishLimit
          || (flagged.length === 0 && droppedFormChrome > 0)
          || ocrUnusable
          || (filing.chamber === 'executive' && meta?.parseDisposition === 'unreadable')
          || handCheckRequired
            ? reason
            : undefined,
      },
      reviewSnapshot,
    );
    const wiped = ocrUnusable && reviewFlagged.length === 0;
    return {
      transactions: wiped ? [] : (ocrUnusable ? reviewFlagged.map((f) => f.tx) : transactions),
      minConfidence: wiped ? 0 : minConfidence,
      needsReview: routed,
      published: false,
      reviewReason: reason,
    };
  }

  const persistable: Transaction[] = [];
  for (const tx of transactions) {
    if (await matchingLiveTransactionExists(env, filing, tx)) continue;
    persistable.push(tx);
  }
  if (deletedFlagged.length > 0) {
    await deprecateDeletedMatches(env, filing, deletedFlagged, nowIso);
  }
  if (persistable.length === 0) {
    const closed = await resolveProcessedNoNewRows(
      env,
      filing,
      nowIso,
      reviewSnapshot,
      deletedFlagged.length > 0 ? 'deleted_rows_applied' : 'amendment_already_persisted',
    );
    return {
      transactions: [],
      minConfidence,
      needsReview: !closed,
      published: false,
      reviewReason: deletedFlagged.length > 0 ? 'deleted_rows_applied' : 'amendment_already_persisted',
      settled: closed,
    };
  }

  const persisted = await persistNormalizedPublish(
    env,
    filing.docId,
    persistable,
    reviewSnapshot,
    nowIso,
    {
      confidence: minConfidence,
      extractor: extractorName,
      modelVersion,
    },
  );
  if (!persisted.published) {
    return { transactions, minConfidence, needsReview: false, published: false };
  }
  const insertedIds = persisted.insertedIds;

  if (isAmendment && filing.filerId) {
    await deprecatePredecessorFilingTransactions(
      env.DB,
      filing.docId,
      filing.filerId,
      filing.filedDate,
      nowIso,
    );
  }

  // Best-effort immediate flush. The durable outbox row was committed in the
  // same D1 batch as each transaction, so a queue outage cannot lose delivery;
  // the scheduled reconciler retries any row left pending.
  if (insertedIds.length > 0) {
    await flushDeliveryOutbox(env, { txIds: insertedIds, limit: insertedIds.length }).catch((err) =>
      console.error('normalize: delivery outbox flush failed', (err as Error).message),
    );
  }

  return { transactions, minConfidence, needsReview: false, published: true };
}

// ---------------------------------------------------------------------------
// Per-transaction normalization + validation
// ---------------------------------------------------------------------------

/** Build a Transaction (+ flags) from one ParsedTx, applying validation penalties. */
function buildTransaction(
  p: ParsedTx,
  filing: Filing,
  resolve: TickerResolver,
  nowIso: string,
  rowIndex: number,
  sourceOverride?: TxSource,
  nameIndex?: NameIndex,
  ocrExtraWords?: ReadonlySet<string>,
): FlaggedTx {
  const placeholders = new Set(['NONE', '--', 'N/A', 'NA', 'NULL', '—']);
  const prepared = prepareExtractedTx(p);
  let rawTicker = prepared.ticker;
  if (rawTicker && placeholders.has(rawTicker.toUpperCase())) {
    rawTicker = null;
  }
  let rawAssetName = prepared.assetName;
  if (rawAssetName && placeholders.has(rawAssetName.toUpperCase())) {
    rawAssetName = null;
  }
  p = { ...prepared, ticker: rawTicker, assetName: rawAssetName ?? prepared.assetName };

  // Lift disclosure-form scaffolding (House [GS] codes, footnote markers, the
  // rigid "Rate/Coupon: … Matures: …" suffix, the "(Exchanged) …" second leg)
  // out of the displayed name and into the cleaning_note audit column, which
  // the web surfaces as the "Notes" column.
  const assetDetail = splitAssetNameDetail(rawAssetName, rawTicker);
  const cleanedAssetName = assetDetail.name;
  // Confident OCR fixes apply to the stored name with an audit note; the
  // scoring below holds rows whose garble has no confident fix.
  const ocr = normalizeOcrAssetName(cleanedAssetName, { extraKnownWords: ocrExtraWords });
  // The split above lifts shape-only maturity suffixes ("Due 02/30/2026")
  // into the cleaning note before the scan, so an impossible maturity date
  // would escape the guard and publish in the user-visible Notes column
  // while the admin path (which scans the raw string) 400s the same row.
  // Merge date holds from the raw name too; dedupe tokens both scans see.
  const rawDateHolds = normalizeEmbeddedOcrDates(rawAssetName ?? '').holdReasons.filter(
    (reason) => !ocr.dateHolds.includes(reason),
  );
  const ocrResult: OcrNameResult = rawDateHolds.length > 0
    ? { ...ocr, dateHolds: [...ocr.dateHolds, ...rawDateHolds] }
    : ocr;
  const ocrAssetName = ocrResult.name;
  const ocrNote = ocrResult.notes.length > 0 ? `normalized OCR artifacts: ${ocrResult.notes.join('; ')}` : null;
  const s = scoreFields(
    p.confidence,
    {
      ticker: rawTicker,
      // Score the OCR-repaired name so ticker resolution and the consistency
      // checks see the canonical issuer, not the garble.
      assetName: ocrAssetName,
      amountMin: p.amountMin,
      amountMax: p.amountMax,
      txType: p.txType,
      txDate: p.txDate,
      rawText: p.rawText,
    },
    filing.filedDate,
    resolve,
    nameIndex,
    ocrExtraWords,
    ocrResult,
  );
  // Models (and local_mac OCR) often leave assetType null even when the PTR
  // line says "Common Stock" or carries a House [ST] code. Infer before
  // category rollup so review UI + feed show ST instead of Unknown.
  const inferredType = inferHouseAssetTypeCode(p.assetType, {
    assetTypeName: p.assetTypeName,
    assetName: ocrAssetName,
    rawText: p.rawText,
    isOption: p.isOption,
  });
  const resolvedAssetType = p.assetType?.trim() || inferredType?.code || null;
  const resolvedAssetTypeName =
    p.assetTypeName?.trim() ||
    (resolvedAssetType && HOUSE_ASSET_TYPE_NAMES[resolvedAssetType.toUpperCase()]
      ? HOUSE_ASSET_TYPE_NAMES[resolvedAssetType.toUpperCase()]
      : null) ||
    inferredType?.label ||
    null;
  const assetType = canonicalizeAssetType(resolvedAssetType, resolvedAssetTypeName, {
    isOption: p.isOption,
    assetName: ocrAssetName,
    rawText: p.rawText,
  });

  const txSource = sourceOverride ?? (p as { source?: TxSource }).source ?? 'primary';

  const tx: Transaction = {
    id: uuid(),
    docId: filing.docId,
    filerId: filing.filerId,
    txDate: p.txDate,
    owner: normalizeOwner(p.owner),
    assetName: ocrAssetName || s.ticker || '(unknown)',
    ticker: s.ticker,
    assetType: resolvedAssetType,
    assetTypeName: resolvedAssetTypeName,
    assetTypeCategory: assetType.category,
    assetTypeCategoryLabel: assetType.categoryLabel,
    txType: s.txType,
    amountMin: s.amountMin,
    amountMax: s.amountMax,
    isOption: Boolean(p.isOption),
    capGainsOver200: Boolean(p.capGainsOver200),
    rawText: p.rawText ?? '',
    filingStatus: p.filingStatus ?? null,
    subholding: p.subholding ?? null,
    location: p.location ?? null,
    description: p.description ?? null,
    supplementalText: p.supplementalText ?? null,
    confidence: s.confidence,
    source: txSource,
    rowKey: transactionRowKey(txSource, rowIndex, {
      ...p,
      ticker: s.ticker,
      txType: s.txType,
      amountMin: s.amountMin,
      amountMax: s.amountMax,
    }),
    firstSeenAt: filing.firstSeenAt,
    filedDate: filing.filedDate,
    createdAt: nowIso,
    cleaningNote: [assetDetail.note, ocrNote].filter(Boolean).join('; ') || null,
    // cursor_seq is assigned by the DB trigger on insert.
    cursorSeq: 0,
  };

  return {
    tx,
    flags: [
      ...s.flags,
      ...(p.extractionWarnings ?? []).filter((flag) =>
        flag === 'unreadable_is_option' || flag === 'unreadable_cap_gains' || flag === 'suspected_constant_tx_type'),
    ],
  };
}

/** Result of applying the shared validation rubric to one row's fields. */
export interface ScoredFields {
  confidence: number;
  flags: string[];
  ticker: string | null;
  amountMin: number | null;
  amountMax: number | null;
  txType: TxType;
}

/**
 * Apply the shared validation rubric to one row's fields, starting from `base`
 * confidence and compounding penalties. Used by BOTH the live normalizer and the
 * seed backfill so every source is scored identically — provenance (parsed by us
 * vs imported) is tracked separately via transactions.source, NOT baked into
 * this number.
 *
 * Penalizes only genuine problems: a supplied-but-unresolvable ticker, a
 * missing/inverted amount, a bad tx_type, or a tx_date after the filing date.
 * Ticker-less assets and plausible non-canonical amounts are accepted/snapped
 * without penalty.
 */
export function scoreFields(
  base: number,
  fields: {
    ticker: string | null;
    assetName: string | null;
    amountMin: number | null;
    amountMax: number | null;
    txType: string | null;
    txDate: string | null;
    rawText?: string | null;
  },
  filedDate: string | null,
  resolve: TickerResolver,
  nameIndex?: NameIndex,
  ocrExtraWords?: ReadonlySet<string>,
  precomputedOcr?: OcrNameResult,
): ScoredFields {
  const flags: string[] = [];
  let confidence = clamp01(base);

  const assetName = fields.assetName?.trim() ?? '';
  if (
    !assetName ||
    /^(?:\(?unknown\)?|n\/?a|none|null|-|unreadable)$/i.test(assetName) ||
    looksLikeHeaderContaminatedAsset(assetName)
  ) {
    flags.push('bad_asset_name');
    confidence *= PENALTY_BAD_ASSET_NAME;
  }

  // --- ticker resolution: exact symbol, then alias/name lookup --------------
  // Only PENALIZE when a ticker string was supplied but couldn't be resolved
  // (a likely mis-parse). Many disclosures legitimately have no ticker — bonds,
  // real estate, private funds — and that should NOT lower confidence.
  // A dash / "N/A" / blank is a "no ticker" marker, not an unresolved ticker —
  // treat it like a legitimately symbol-less asset (bond, fund) and don't penalize.
  const hadTickerInput = !!(fields.ticker && fields.ticker.trim()) && !isPlaceholderTicker(fields.ticker);
  const resolved = resolve(fields.ticker, fields.assetName);
  let ticker = fields.ticker;
  if (resolved) {
    ticker = resolved;
  } else if (hadTickerInput) {
    flags.push('unresolved_ticker');
    confidence *= PENALTY_UNRESOLVED_TICKER;
  } else {
    ticker = null;
  }

  // --- ticker <-> asset-name consistency (hallucination signal) -------------
  // Informational only, NOT penalized: securities_master/securities_ref have
  // known coverage gaps (e.g. crypto/bond tickers), so a "no known name for
  // this ticker" case must never look like a mismatch. This flag exists to
  // feed the per-filing garbage_ratio computed in normalize() for the
  // extraction_row_limit_exceeded review-queue triage split, not to affect
  // per-row confidence or the publish decision for ordinary filings.
  if (ticker && nameIndex) {
    const knownName = nameIndex.get(ticker);
    if (knownName) {
      const simplifiedAsset = simplifyCompanyName(assetName);
      const tickerAsName = simplifiedAsset === ticker.toLowerCase();
      if (
        simplifiedAsset
        && !tickerAsName
        && !namesPlausiblyMatch(simplifiedAsset, knownName)
      ) {
        flags.push('ticker_asset_mismatch');
      }
    }
  }

  // --- amount validation ----------------------------------------------------
  // Penalize only TRULY unusable amounts (missing, or a nonsensical range). A
  // plausible range that isn't an exact canonical bracket is snapped to the
  // nearest STOCK Act bracket WITHOUT penalty.
  //
  // rawText contradiction checks only run against a clear embedded STOCK Act
  // dollar range (see parseAmountRange). Freeform PTR lines with dates/CUSIPs
  // must not invent false invalid_amount hard failures on already-canonical
  // structured brackets (review-queue flood class, 2026-08-10).
  let amountMin = fields.amountMin;
  let amountMax = fields.amountMax;

  if (amountMin === null || amountMin === undefined) {
    flags.push('no_amount');
    confidence *= PENALTY_INVALID_BRACKET;
  } else if (isValidBracket(amountMin, amountMax)) {
    const b = matchBracket(amountMin, amountMax);
    if (b) {
      amountMin = b.min;
      amountMax = b.max;
    }
    // Structured amounts are already a canonical bracket. Only flag when
    // rawText contains a *different* exact canonical dollar range.
    if (fields.rawText) {
      const parsedRange = parseAmountRange(fields.rawText);
      const rawAgreesWithStructured = rawTextContainsBracket(
        fields.rawText,
        amountMin,
        amountMax,
      );
      if (
        !rawAgreesWithStructured
        && parsedRange.exact
        && parsedRange.min !== null
        && (parsedRange.min !== amountMin
          || (parsedRange.max ?? null) !== (amountMax ?? null))
      ) {
        flags.push('invalid_amount');
        confidence *= PENALTY_INVALID_BRACKET;
      }
    }
  } else if (amountMin >= 0 && (amountMax === null || amountMax >= amountMin)) {
    const b = nearestBracket(amountMin, amountMax);
    if (b) {
      amountMin = b.min;
      amountMax = b.max;
    }
  } else {
    flags.push('invalid_amount');
    confidence *= PENALTY_INVALID_BRACKET;
  }

  // --- tx_type must be B / S / E (Purchase/P/buy → B) ----------------------
  let txType = (canonicalizeTxType(fields.txType) ?? fields.txType) as TxType;
  if (!isTxType(txType)) {
    flags.push('bad_tx_type');
    confidence *= PENALTY_BAD_TX_TYPE;
    txType = 'B';
  }

  // --- tx_date sanity -------------------------------------------------------
  // Shared strict check: impossible, future, and far-too-old dates are hard
  // failures (held for review, never published).  A trade after the filing
  // date stays soft (tx_after_filed_date penalty only): the tested rule
  // publishes after-filed trades, since a PTR can list a trade after Clerk's
  // filed_date (signature stamp vs transaction box) — Pete Sessions
  // H-2025-20033330 signed 2025-10-22 with a 10/24/2025 purchase, and parking
  // that as future_tx_date hid a real disclosed lot.
  if (!fields.txDate) {
    flags.push('missing_tx_date');
    confidence *= PENALTY_MISSING_TX_DATE;
  } else {
    const dateCheck = validateTxDate(fields.txDate, { filedDate });
    if (dateCheck.ok === false) {
      if (dateCheck.code === 'future_tx_date') {
        flags.push('future_tx_date');
        confidence *= PENALTY_FUTURE_TX_DATE;
      } else if (dateCheck.code === 'bad_tx_date') {
        flags.push('bad_tx_date');
        confidence *= PENALTY_BAD_TX_DATE;
      } else {
        flags.push('tx_date_too_old');
        confidence *= PENALTY_BAD_TX_DATE;
      }
    } else if (filedDate && fields.txDate > filedDate) {
      flags.push('tx_after_filed_date');
      confidence *= PENALTY_FUTURE_TX_DATE;
    }
  }

  // --- OCR sanity on the asset name -----------------------------------------
  // Confident fixes are applied by the caller (buildTransaction); unfixable
  // garble is a hard failure so the row is held, never published.  Reference
  // names from securities_ref feed word-level evidence only.  buildTransaction
  // passes its already-computed result so the scan runs once per row.
  const ocr = precomputedOcr ?? normalizeOcrAssetName(assetName, { extraKnownWords: ocrExtraWords });
  if (ocr.dateHolds.length > 0) {
    flags.push('ocr_date_hold');
    confidence *= PENALTY_OCR_HOLD;
  }
  if (ocr.nameHolds.length > 0) {
    flags.push('ocr_name_hold');
    confidence *= PENALTY_OCR_HOLD;
  }

  return { confidence: clamp01(confidence), flags, ticker, amountMin, amountMax, txType };
}

export {
  looksLikeHeaderContaminatedAsset,
  looksLikePtrFormSampleAsset,
  looksLikePtrFormSampleRow,
  looksLikeSeeAttachmentPointer,
  looksLikeNothingToReport,
  isDeletedFilingStatus,
} from './extractRouting.ts';

/**
 * True when an OCR extraction is mostly form chrome / unreadable placeholders
 * and should NOT open a multi-hundred-row review item. Prefer extract_empty /
 * ocr_unusable so local-vision can requeue without human review noise.
 */
export function isMostlyGarbageOcrExtraction(
  originalCount: number,
  usableCount: number,
  hardFailureCount: number,
): boolean {
  if (originalCount < 12) return false;
  if (usableCount === 0 && originalCount > 0) return true;
  const usableRatio = usableCount / originalCount;
  if (usableRatio < 0.3) return true;
  if (usableCount > 0 && hardFailureCount / usableCount >= 0.7 && originalCount >= 20) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Ticker resolution against securities_master
// ---------------------------------------------------------------------------

export type TickerResolver = (ticker: string | null, assetName: string | null) => string | null;

/** Process-local securities_master cache (Deno isolate / Worker reuse). */
const RESOLVER_TTL_MS = 10 * 60 * 1000;
let resolverCache: { loadedAt: number; resolver: TickerResolver } | null = null;

/** Drop the in-process securities_master resolver cache (tests / admin reload). */
export function clearResolverCache(): void {
  resolverCache = null;
}

/**
 * Load securities_master once (per isolate, TTL-bounded) and return an
 * in-memory ticker resolver. The master table is ~10k rows and changes rarely;
 * Turso was re-reading all of them on every normalize/agreement call.
 */
export async function loadResolver(env: Env): Promise<TickerResolver> {
  const now = Date.now();
  if (resolverCache && now - resolverCache.loadedAt < RESOLVER_TTL_MS) {
    return resolverCache.resolver;
  }
  const secRows = await all<SecRow>(env.DB, 'SELECT ticker, name, aliases FROM securities_master');
  // securities_ref carries the enriched, current company names (94%+ of tickered
  // trades resolve to one); it is what lets a no-ticker description resolve by issuer name.
  const issuerIndex = await loadIssuerNameIndex(env);
  const resolver = buildResolver(secRows, issuerIndex);
  resolverCache = { loadedAt: now, resolver };
  return resolver;
}

/**
 * Build an in-memory resolver from securities_master rows. Resolution order:
 *   1. exact ticker symbol match (case-insensitive),
 *   2. exact alias match (alias JSON array, case-insensitive),
 *   3. exact security name match (case-insensitive).
 *   4. (no ticker supplied only) unique issuer-name match through the
 *      legal-form/descriptor-stripped index in enrichment/nameTickerBackfill.ts
 *      — "Uber Technologies Inc. CMN" -> UBER (board row 16b46688).
 * Returns the canonical ticker, or null when nothing matches.
 */
export function buildResolver(rows: SecRow[], issuerIndex?: IssuerNameIndex): TickerResolver {
  const byTicker = new Map<string, string>();
  const issuerNames = issuerIndex ?? emptyIssuerNameIndex();
  const byAlias = new Map<string, string>();
  const byName = new Map<string, string>();
  const bySimplifiedName = new Map<string, string>();

  for (const r of rows) {
    const canonical = (r.ticker || '').toUpperCase();
    if (!canonical) continue;
    byTicker.set(canonical, canonical);
    if (r.name) {
      addIssuerName(issuerNames, canonical, r.name);
      byName.set(r.name.trim().toLowerCase(), canonical);
      const simplified = simplifyCompanyName(r.name);
      if (simplified && !bySimplifiedName.has(simplified)) {
        bySimplifiedName.set(simplified, canonical);
      }
    }
    const aliases = parseJson<string[]>(r.aliases, []);
    for (const a of aliases) {
      if (typeof a === 'string' && a.trim()) {
        byAlias.set(a.trim().toLowerCase(), canonical);
        const simplifiedAlias = simplifyCompanyName(a);
        if (simplifiedAlias && !bySimplifiedName.has(simplifiedAlias)) {
          bySimplifiedName.set(simplifiedAlias, canonical);
        }
      }
    }
  }

  return (ticker, assetName) => {
    const t = (ticker || '').trim().toUpperCase();
    const preferred = resolvePreferredTickerFromAssetName(assetName, (issuerName: string) => {
      const key = issuerName.trim().toLowerCase();
      return byAlias.get(key) ?? byName.get(key) ?? byTicker.get(key.toUpperCase()) ?? null;
    });
    if (preferred) return preferred;

    // Curated stale→current aliases (e.g. FB→META) take precedence over the
    // master, because the master can carry a STALE row for a reassigned ticker
    // (SEC reassigned FB to a ProShares ETF after Meta moved to META).
    const continuous = resolveContinuousTicker(t);
    if (continuous !== t && byTicker.has(continuous)) return byTicker.get(continuous)!;
    if (t && byTicker.has(t)) return byTicker.get(t)!;
    const name = (assetName || '').trim().toLowerCase();
    const simplifiedName = simplifyCompanyName(assetName || '');
    if (simplifiedName && bySimplifiedName.has(simplifiedName)) return bySimplifiedName.get(simplifiedName)!;
    if (name && byAlias.has(name)) return byAlias.get(name)!;
    if (name && byName.has(name)) return byName.get(name)!;
    // No ticker supplied: resolve the description by issuer name.  Only ever when
    // there is NO ticker input — a row that carries its own (even unlisted)
    // symbol keeps the deterministic path below and is never re-pointed by name.
    if (!t) {
      const byIssuer = resolveTickerByIssuerName(issuerNames, assetName);
      if (byIssuer) return byIssuer;
    }
    // Also try the raw ticker as an alias (sometimes asset name lands in ticker).
    const tl = t.toLowerCase();
    if (tl && byAlias.has(tl)) return byAlias.get(tl)!;
    // Deterministic fallback: `$`-series strip, punctuation variants, curated
    // stale→current aliases (probed against the master), then syntactic
    // acceptance of a well-formed symbol the master doesn't list yet. This is
    // what clears the dominant `unresolved_ticker` review-queue reason.
    return resolveTickerDeterministic(t, (sym: string) => (byTicker.has(sym) ? byTicker.get(sym)! : null));
  };
}

// ---------------------------------------------------------------------------
// Ticker <-> asset-name consistency (hallucination signal)
// ---------------------------------------------------------------------------

/** ticker -> simplifyCompanyName(known company name), for the mismatch check only. */
export type NameIndex = Map<string, string>;

const NAME_INDEX_TTL_MS = 10 * 60 * 1000;
let nameIndexCache: { loadedAt: number; index: NameIndex } | null = null;

/** Drop the in-process name-index cache (tests / admin reload). */
export function clearNameIndexCache(): void {
  nameIndexCache = null;
}

/**
 * Load a ticker -> simplified-company-name index for the ticker/assetName
 * consistency check in scoreFields(), sourced from securities_ref.company_name
 * only (enriched daily from SEC EDGAR/FMP — fresher than securities_master,
 * which is a stale, manually-reseeded one-time import; see loadResolver()'s
 * doc comment). securities_ref lives in the same D1 database as
 * securities_master, reachable via the same shared env.DB binding, but
 * nothing under extraction/ had queried it before this — it was simply
 * unused, not unreachable. Deliberately does NOT also read securities_master
 * here: loadResolver() already reads it once per isolate/TTL window for
 * ticker resolution, and a second independent read of the same ~10k-row
 * table would double that cost for no real coverage gain, since the master
 * table's own name data is the noisier of the two anyway. A ticker
 * securities_ref hasn't enriched yet simply has no entry, which correctly
 * skips the mismatch check (absence of data is not evidence of mismatch),
 * exactly like the existing "no ticker" / crypto / bond cases.
 */
export async function loadNameIndex(env: Env): Promise<NameIndex> {
  const now = Date.now();
  if (nameIndexCache && now - nameIndexCache.loadedAt < NAME_INDEX_TTL_MS) {
    return nameIndexCache.index;
  }
  const index: NameIndex = new Map();
  try {
    const refRows = await all<SecRefRow>(
      env.DB,
      'SELECT ticker, company_name FROM securities_ref WHERE company_name IS NOT NULL',
    );
    for (const r of refRows) {
      const t = (r.ticker || '').toUpperCase();
      const simplified = simplifyCompanyName(r.company_name || '');
      if (t && simplified) index.set(t, simplified);
    }
  } catch {
    // Fail open: an empty index just means the mismatch check below never
    // fires (no penalty either way), never a hard failure.
    index.clear();
  }
  nameIndexCache = { loadedAt: now, index };
  return index;
}

/**
 * True when two simplified company names plausibly refer to the same issuer.
 * Exact match or substring containment either direction (tolerates partial
 * historical forms, e.g. "apple computer" vs "apple").
 */
function namesPlausiblyMatch(a: string, b: string): boolean {
  if (!a || !b) return true; // nothing to compare against is not evidence of mismatch
  return a === b || a.includes(b) || b.includes(a);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const CONDITIONAL_BULK_INSERT_TX_SQL = `INSERT OR IGNORE INTO transactions (
  id, doc_id, filer_id, tx_date, owner, asset_name, ticker, asset_type,
  tx_type, amount_min, amount_max, is_option, cap_gains_over_200,
  raw_text, asset_type_name, filing_status, subholding, location, description,
  supplemental_text, row_key, confidence, source, created_at, cursor_seq,
  first_seen_at, filed_date, est_value, disclosure_lag_days, stock_act_status,
  cleaning_note
) SELECT
  json_extract(value, '$.id'), json_extract(value, '$.docId'),
  json_extract(value, '$.filerId'), json_extract(value, '$.txDate'),
  json_extract(value, '$.owner'), json_extract(value, '$.assetName'),
  json_extract(value, '$.ticker'), json_extract(value, '$.assetType'),
  json_extract(value, '$.txType'), json_extract(value, '$.amountMin'),
  json_extract(value, '$.amountMax'), json_extract(value, '$.isOption'),
  json_extract(value, '$.capGainsOver200'), json_extract(value, '$.rawText'),
  json_extract(value, '$.assetTypeName'), json_extract(value, '$.filingStatus'),
  json_extract(value, '$.subholding'), json_extract(value, '$.location'),
  json_extract(value, '$.description'), json_extract(value, '$.supplementalText'),
  json_extract(value, '$.rowKey'), json_extract(value, '$.confidence'),
  json_extract(value, '$.source'), json_extract(value, '$.createdAt'), NULL,
  json_extract(value, '$.firstSeenAt'), json_extract(value, '$.filedDate'),
  json_extract(value, '$.estValue'), json_extract(value, '$.disclosureLagDays'),
  json_extract(value, '$.stockActStatus'),
  json_extract(value, '$.cleaningNote')
  FROM json_each(?)`;

function transactionInsertJson(transactions: Transaction[]): string {
  return JSON.stringify(transactions.map((tx) => ({
    id: tx.id,
    docId: tx.docId,
    filerId: tx.filerId,
    txDate: tx.txDate,
    owner: tx.owner,
    assetName: tx.assetName,
    ticker: tx.ticker,
    assetType: tx.assetType,
    txType: tx.txType,
    amountMin: tx.amountMin,
    amountMax: tx.amountMax,
    isOption: fromBool(tx.isOption),
    capGainsOver200: fromBool(tx.capGainsOver200),
    rawText: tx.rawText,
    assetTypeName: tx.assetTypeName ?? null,
    filingStatus: tx.filingStatus ?? null,
    subholding: tx.subholding ?? null,
    location: tx.location ?? null,
    description: tx.description ?? null,
    supplementalText: tx.supplementalText ?? null,
    rowKey: tx.rowKey ?? null,
    confidence: tx.confidence,
    source: tx.source,
    createdAt: tx.createdAt,
    firstSeenAt: tx.firstSeenAt ?? null,
    filedDate: tx.filedDate ?? null,
    estValue: estimateTransactionValue(tx.amountMin, tx.amountMax),
    disclosureLagDays: computeDisclosureLagDays(tx.txDate, tx.filedDate),
    stockActStatus: computeStockActStatus(tx.txDate, tx.filedDate),
    cleaningNote: tx.cleaningNote ?? null,
  })));
}

const BULK_DELIVERY_OUTBOX_SQL = `INSERT OR IGNORE INTO delivery_outbox
  (tx_id, status, attempts, available_at, last_error, created_at, updated_at)
SELECT DISTINCT t.id, 'pending', 0, ?, NULL, ?, ?
  FROM transactions t
  JOIN json_each(?) requested
    ON (
      json_extract(requested.value, '$.rowKey') IS NOT NULL
      AND t.doc_id = json_extract(requested.value, '$.docId')
      AND t.source = json_extract(requested.value, '$.source')
      AND t.row_key = json_extract(requested.value, '$.rowKey')
    ) OR (
      json_extract(requested.value, '$.rowKey') IS NULL
      AND t.id = json_extract(requested.value, '$.id')
    )
 WHERE t.deprecated_at IS NULL`;

interface PublicationMetadata {
  confidence: number;
  extractor: string | null;
  modelVersion: string | null;
}

/**
 * Atomically publish a normalized row set. A first-pass filing is guarded by
 * the continued absence of a review row. A previously reviewed filing is
 * guarded by the unresolved revision captured before the batch. Both paths
 * commit exact rows, the filing state, and delivery intents together.
 */
async function persistNormalizedPublish(
  env: Env,
  docId: string,
  transactions: Transaction[],
  review: ReviewSnapshot | null,
  nowIso: string,
  metadata: PublicationMetadata,
): Promise<{ published: boolean; insertedIds: string[] }> {
  if (transactions.length > MAX_PUBLISH_TRANSACTIONS_PER_FILING) {
    throw new TransactionPublishLimitError(
      `refusing to publish ${transactions.length} transactions; limit is ${MAX_PUBLISH_TRANSACTIONS_PER_FILING}`,
    );
  }
  const insertRowsJson = transactionInsertJson(transactions);
  const rowKeysJson = JSON.stringify(transactions.map((tx) => tx.rowKey ?? ''));
  const incomingSource = transactions[0]?.source ?? 'primary';
  const supersededSourcesSql = supersededPipelineSourcesSql(incomingSource);
  if (review?.resolved === 1 && !isVisionTxSource(incomingSource)) {
    return { published: false, insertedIds: [] };
  }
  const exactLiveSet = `(SELECT COUNT(*) FROM transactions
      WHERE doc_id = ? AND source IN (${PIPELINE_TX_SOURCES_SQL})
        AND deprecated_at IS NULL) = ?
    AND (SELECT COUNT(*) FROM transactions
      WHERE doc_id = ? AND source IN ('primary', 'local_mac', 'server_cpu') AND deprecated_at IS NULL
        AND row_key IN (SELECT value FROM json_each(?))) = ?`;
  const exactLiveSetParams = [
    docId, transactions.length,
    docId, rowKeysJson, transactions.length,
  ];

  const auditPayload = JSON.stringify({
    minConfidence: metadata.confidence,
    extractor: metadata.extractor,
    modelVersion: metadata.modelVersion,
    transactionCount: transactions.length,
    supersededPriorSources: Boolean(supersededSourcesSql),
  });

  const visionDeprecate = (
    gateSql: string,
    gateParams: unknown[],
  ): [string, unknown[]] | null => {
    if (!supersededSourcesSql) return null;
    return [
      `UPDATE transactions
          SET deprecated_at = ?, deprecated_reason = ?
        WHERE doc_id = ? AND source IN (${supersededSourcesSql}) AND deprecated_at IS NULL
          AND ${gateSql}`,
      [nowIso, VISION_SUPERSEDE_REASON, docId, ...gateParams],
    ];
  };

  let statements: Array<[string, any[]]>;
  let transitionIndex: number;
  if (review) {
    const revision = review.review_revision;
    const expectedResolved = review.resolved === 1 ? 1 : 0;
    // NOTE: do NOT require agreement_suppressed_at IS NULL here.
    // agreement_suppressed_at only gates the multi-model agreement cascade
    // (no OpenRouter / budget ops). Local Grok / server_cpu vision must still
    // be able to publish once rows clear CONFIDENCE_THRESHOLD — otherwise
    // "requeue for local_mac" becomes a permanent dead-end.
    const reviewGate = `EXISTS (SELECT 1 FROM review_queue
            WHERE doc_id = ? AND resolved = ${expectedResolved} AND review_revision = ?)`;
    const reviewGateParams = [docId, revision];
    statements = [
      [
        `${CONDITIONAL_BULK_INSERT_TX_SQL}
          WHERE ${reviewGate}`,
        [insertRowsJson, ...reviewGateParams],
      ],
    ];
    const deprecate = visionDeprecate(reviewGate, reviewGateParams);
    if (deprecate) statements.push(deprecate);
    statements.push(
      [
        `INSERT INTO review_queue (doc_id)
          SELECT ?
           WHERE ${reviewGate}
             AND NOT (${exactLiveSet})`,
        [
          docId, ...reviewGateParams,
          ...exactLiveSetParams,
        ],
      ],
      [
        `${BULK_DELIVERY_OUTBOX_SQL}
          AND ${reviewGate}`,
        [nowIso, nowIso, nowIso, insertRowsJson, ...reviewGateParams],
      ],
      [
        `UPDATE filings
            SET ingest_status = 'persisted', error = NULL,
                confidence = ?, extractor = ?, model_version = ?
          WHERE doc_id = ?
            AND ${reviewGate}
            AND ${exactLiveSet}`,
        [
          metadata.confidence, metadata.extractor, metadata.modelVersion,
          docId, ...reviewGateParams,
          ...exactLiveSetParams,
        ],
      ],
      [
        `INSERT OR IGNORE INTO ingestion_decisions
           (id, doc_id, action, source, actor, reason, payload, transaction_ids, created_at)
         SELECT ?, ?, 'auto_published', 'pipeline', NULL, ?, ?,
                COALESCE((
                  SELECT json_group_array(id) FROM (
                    SELECT id FROM transactions
                     WHERE doc_id = ? AND source IN ('primary', 'local_mac', 'server_cpu') AND deprecated_at IS NULL
                     ORDER BY id ASC
                  )
                ), '[]'), ?
          WHERE ${reviewGate}
            AND ${exactLiveSet}`,
        [
          `decision:auto_published:${docId}`, docId,
          expectedResolved === 1 ? 'superseded_prior_sources' : 'passed_normalization',
          auditPayload, docId, nowIso,
          ...reviewGateParams,
          ...exactLiveSetParams,
        ],
      ],
    );
    if (expectedResolved === 1) {
      statements.push([
        `UPDATE review_queue
            SET agreement_next_attempt_at = NULL,
                agreement_claim_token = NULL,
                agreement_claimed_at = NULL,
                agreement_suppressed_at = NULL,
                agreement_suppression_reason = NULL,
                resolution_kind = 'published',
                resolution_reason = 'auto_published',
                review_revision = review_revision + 1
          WHERE doc_id = ? AND resolved = 1 AND review_revision = ?
            AND ${exactLiveSet}`,
        [
          docId, revision,
          ...exactLiveSetParams,
        ],
      ]);
    } else {
      statements.push([
        `UPDATE review_queue
            SET resolved = 1,
                agreement_next_attempt_at = NULL,
                agreement_claim_token = NULL,
                agreement_claimed_at = NULL,
                agreement_suppressed_at = NULL,
                agreement_suppression_reason = NULL,
                resolution_kind = 'published',
                resolution_reason = 'auto_published',
                resolved_at = CURRENT_TIMESTAMP,
                review_revision = review_revision + 1
          WHERE doc_id = ? AND resolved = 0 AND review_revision = ?
            AND ${exactLiveSet}`,
        [
          docId, revision,
          ...exactLiveSetParams,
        ],
      ]);
    }
    transitionIndex = statements.length - 1;
  } else {
    const firstPassGate = `NOT EXISTS (SELECT 1 FROM review_queue WHERE doc_id = ?)
            AND EXISTS (SELECT 1 FROM filings
              WHERE doc_id = ? AND ingest_status <> 'persisted')`;
    const firstPassGateParams = [docId, docId];
    statements = [
      [
        `${CONDITIONAL_BULK_INSERT_TX_SQL}
          WHERE ${firstPassGate}`,
        [insertRowsJson, ...firstPassGateParams],
      ],
    ];
    const firstPassDeprecate = visionDeprecate(firstPassGate, firstPassGateParams);
    if (firstPassDeprecate) statements.push(firstPassDeprecate);
    statements.push(
      [
        `INSERT INTO filings (doc_id)
          SELECT ?
           WHERE ${firstPassGate}
             AND NOT (${exactLiveSet})`,
        [
          docId, docId, docId,
          docId, transactions.length,
          docId, rowKeysJson, transactions.length,
        ],
      ],
      [
        `${BULK_DELIVERY_OUTBOX_SQL}
          AND NOT EXISTS (SELECT 1 FROM review_queue WHERE doc_id = ?)
          AND EXISTS (SELECT 1 FROM filings
            WHERE doc_id = ? AND ingest_status <> 'persisted')`,
        [nowIso, nowIso, nowIso, insertRowsJson, docId, docId],
      ],
      [
        `UPDATE filings
            SET ingest_status = 'persisted', error = NULL,
                confidence = ?, extractor = ?, model_version = ?
          WHERE doc_id = ? AND ingest_status <> 'persisted'
            AND NOT EXISTS (SELECT 1 FROM review_queue WHERE doc_id = ?)
            AND ${exactLiveSet}`,
        [
          metadata.confidence, metadata.extractor, metadata.modelVersion,
          docId, docId,
          docId, transactions.length,
          docId, rowKeysJson, transactions.length,
        ],
      ],
      [
        `INSERT OR IGNORE INTO ingestion_decisions
           (id, doc_id, action, source, actor, reason, payload, transaction_ids, created_at)
         SELECT ?, ?, 'auto_published', 'pipeline', NULL, 'passed_normalization', ?,
                COALESCE((
                  SELECT json_group_array(id) FROM (
                    SELECT id FROM transactions
                     WHERE doc_id = ? AND source IN ('primary', 'local_mac', 'server_cpu') AND deprecated_at IS NULL
                     ORDER BY id ASC
                  )
                ), '[]'), ?
          WHERE NOT EXISTS (SELECT 1 FROM review_queue WHERE doc_id = ?)
            AND EXISTS (SELECT 1 FROM filings
              WHERE doc_id = ? AND ingest_status = 'persisted')
            AND ${exactLiveSet}`,
        [
          `decision:auto_published:${docId}`, docId, auditPayload, docId, nowIso,
          docId, docId,
          docId, transactions.length,
          docId, rowKeysJson, transactions.length,
        ],
      ],
    );
    // Filing persisted-status update is the CAS winner (audit is last).
    transitionIndex = statements.length - 2;
  }

  // A bounded FMP recovery may have populated low-fidelity seed rows under the
  // same canonical Senate report id.  Keep those rows visible until a complete
  // primary set is proven and the filing transition succeeds, then retire them
  // in the same atomic batch so the dashboard never double-counts both copies.
  statements.push([
    `UPDATE transactions
        SET deprecated_at = ?, deprecated_reason = 'upgraded_by_primary'
      WHERE doc_id = ? AND source = 'seed_dataset' AND deprecated_at IS NULL
        AND EXISTS (SELECT 1 FROM filings
          WHERE doc_id = ? AND ingest_status = 'persisted')
        AND ${exactLiveSet}`,
    [
      nowIso, docId, docId,
      docId, transactions.length,
      docId, rowKeysJson, transactions.length,
    ],
  ]);

  let results: D1Result[];
  try {
    results = await batch(env.DB, statements);
  } catch (err) {
    if (/UNIQUE constraint failed: (?:review_queue|filings)\.doc_id/i.test((err as Error).message)) {
      throw new Error(`normalized publish exact-set conflict for ${docId}`);
    }
    throw err;
  }
  if ((results[transitionIndex]?.meta?.changes ?? 0) === 0) {
    return { published: false, insertedIds: [] };
  }

  const insertedCount = results[0]?.meta?.changes ?? 0;
  const liveRows = await all<{ id: string }>(
    env.DB,
    `SELECT id FROM transactions
      WHERE doc_id = ? AND source IN ('primary', 'local_mac', 'server_cpu') AND deprecated_at IS NULL
        AND row_key IN (SELECT value FROM json_each(?))`,
    [docId, rowKeysJson],
  );
  const insertedIds = liveRows.length > 0
    ? liveRows.map((row) => row.id)
    : insertedCount === transactions.length
      ? transactions.map((tx) => tx.id)
      : [];
  return { published: true, insertedIds };
}

/** Low-level idempotent row + durable-outbox insert for non-publication callers. */
export async function persistTransactions(env: Env, transactions: Transaction[]): Promise<string[]> {
  if (transactions.length > MAX_PUBLISH_TRANSACTIONS_PER_FILING) {
    throw new TransactionPublishLimitError(
      `refusing to publish ${transactions.length} transactions; limit is ${MAX_PUBLISH_TRANSACTIONS_PER_FILING}`,
    );
  }
  if (transactions.length === 0) return [];
  const insertRowsJson = transactionInsertJson(transactions);
  const proposedIdsJson = JSON.stringify(transactions.map((tx) => tx.id));
  const results = await batch(env.DB, [
    [CONDITIONAL_BULK_INSERT_TX_SQL, [insertRowsJson]],
    [BULK_DELIVERY_OUTBOX_SQL, [
      transactions[0].createdAt,
      transactions[0].createdAt,
      transactions[0].createdAt,
      insertRowsJson,
    ]],
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 0) return [];
  const inserted = await all<{ id: string }>(
    env.DB,
    `SELECT id FROM transactions WHERE id IN (SELECT value FROM json_each(?))`,
    [proposedIdsJson],
  );
  const insertedIds = inserted.map((row) => row.id);
  if (insertedIds.length > 0) {
    await recordTradeLatencyCandidates(env, transactions.filter(t => insertedIds.includes(t.id)), new Date().toISOString());
  }
  return insertedIds;
}

/** Atomically persist review state, metadata, and its idempotent audit receipt. */
async function routeToReview(
  env: Env,
  filing: Filing,
  flagged: FlaggedTx[],
  minConfidence: number,
  nowIso: string,
  meta: {
    extractor: string | null;
    modelVersion: string | null;
    reasonOverride?: string;
  },
  review: ReviewSnapshot | null,
): Promise<boolean> {
  const reason = meta.reasonOverride ?? reviewReason(flagged, minConfidence);
  // A zero-row pass has nothing new to stage. When the existing review holds
  // staged candidates only in its payload (a terminal close was refused for
  // exactly that reason), rewriting the payload with an empty candidate list
  // would let a later zero-row pass close the filing verified-empty and lose
  // them. Leave the row untouched instead.
  if (flagged.length === 0 && review && review.resolved !== 1) {
    try {
      const staged = JSON.parse(review.payload ?? '{}') as { transactionCount?: unknown };
      if (typeof staged.transactionCount === 'number' && staged.transactionCount > 0) {
        console.warn(
          'routeToReview: zero-row pass preserves staged payload candidates:',
          filing.docId,
        );
        return true;
      }
    } catch {
      // Unparseable payload: fall through and rewrite as usual.
    }
  }
  const truncated = flagged.length > MAX_PUBLISH_TRANSACTIONS_PER_FILING;
  const payload = JSON.stringify({
    minConfidence,
    extractor: meta.extractor,
    modelVersion: meta.modelVersion,
    transactionCount: flagged.length,
    truncated,
    transactions: flagged
      .slice(0, MAX_PUBLISH_TRANSACTIONS_PER_FILING)
      .map((f) => ({ ...f.tx, flags: f.flags })),
  });
  const decisionPayload = JSON.stringify({
    minConfidence,
    extractor: meta.extractor,
    modelVersion: meta.modelVersion,
    transactionCount: flagged.length,
    truncated,
  });

  const nextRevision = review ? review.review_revision + 1 : 1;
  const transition: [string, any[]] = review
    ? [
        `UPDATE review_queue
            SET reason = ?,
                payload = ?,
                agreement_claim_token = NULL,
                agreement_claimed_at = NULL,
                review_revision = review_revision + 1
          WHERE doc_id = ? AND resolved = 0 AND review_revision = ?`,
        [reason, payload, filing.docId, review.review_revision],
      ]
    : [
        `INSERT OR IGNORE INTO review_queue (doc_id, reason, payload, created_at, resolved)
           SELECT ?, ?, ?, ?, 0
            WHERE EXISTS (SELECT 1 FROM filings
              WHERE doc_id = ? AND ingest_status <> 'persisted')`,
        [filing.docId, reason, payload, nowIso, filing.docId],
      ];
  const results = await batch(env.DB, [
    transition,
    [
      `UPDATE filings
          SET confidence = ?, extractor = ?, model_version = ?,
              ingest_status = 'needs_review'
        WHERE doc_id = ? AND EXISTS (
          SELECT 1 FROM review_queue
           WHERE doc_id = ? AND resolved = 0 AND review_revision = ?
        )`,
      [minConfidence, meta.extractor, meta.modelVersion, filing.docId, filing.docId, nextRevision],
    ],
    [
      `INSERT OR IGNORE INTO ingestion_decisions
         (id, doc_id, action, source, actor, reason, payload, transaction_ids, created_at)
       SELECT ?, ?, 'review_opened', 'pipeline', NULL, ?, ?, '[]', ?
        WHERE EXISTS (SELECT 1 FROM review_queue
          WHERE doc_id = ? AND resolved = 0 AND review_revision = ?)`,
      [
        `decision:review_opened:${filing.docId}`,
        filing.docId,
        reason,
        decisionPayload,
        nowIso,
        filing.docId,
        nextRevision,
      ],
    ],
  ]);
  const queueTouched = (results[0]?.meta?.changes ?? 0) > 0;
  const handCheckWake = reason.includes(NEEDS_HAND_CHECK_MAC_VISION)
    || reason.includes(NEEDS_HAND_CHECK_SCANNED_VISION);
  if (queueTouched && (!review || handCheckWake)) {
    void notifyReviewQueuePublisher(env, {
      docId: filing.docId,
      reason,
      kind: review ? 'reopen' : 'insert',
      at: nowIso,
    });
  }
  return queueTouched;
}

function isAmendedFilingStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && /\bamend/i.test(status);
}

async function matchingLiveTransactionExists(
  env: Env,
  filing: Filing,
  tx: Transaction,
): Promise<boolean> {
  if (!filing.filerId || !tx.txDate || !tx.txType) return false;
  if (!isAmendedFilingStatus(tx.filingStatus) && !isAmendedFilingStatus(filing.filingType)) {
    return false;
  }
  try {
    const row = await get<{ id: string }>(
      env.DB,
      tx.ticker
        ? `SELECT id FROM transactions
            WHERE filer_id = ? AND deprecated_at IS NULL AND doc_id <> ?
              AND tx_date = ? AND tx_type = ? AND ticker = ?
            LIMIT 1`
        : `SELECT id FROM transactions
            WHERE filer_id = ? AND deprecated_at IS NULL AND doc_id <> ?
              AND tx_date = ? AND tx_type = ? AND ticker IS NULL
              AND LOWER(asset_name) = LOWER(?)
            LIMIT 1`,
      tx.ticker
        ? [filing.filerId, filing.docId, tx.txDate, tx.txType, tx.ticker]
        : [filing.filerId, filing.docId, tx.txDate, tx.txType, tx.assetName],
    );
    return Boolean(row?.id);
  } catch {
    return false;
  }
}

async function deprecateDeletedMatches(
  env: Env,
  filing: Filing,
  deleted: FlaggedTx[],
  nowIso: string,
): Promise<number> {
  if (!filing.filerId || deleted.length === 0) return 0;
  let changes = 0;
  const reason = `deleted by later official PTR ${filing.docId}`;
  for (const row of deleted) {
    const tx = row.tx;
    if (!tx.txDate || !tx.txType) continue;
    try {
      const result = await run(
        env.DB,
        tx.ticker
          ? `UPDATE transactions
                SET deprecated_at = ?, deprecated_reason = ?
              WHERE filer_id = ? AND deprecated_at IS NULL AND doc_id <> ?
                AND tx_date = ? AND tx_type = ? AND ticker = ?`
          : `UPDATE transactions
                SET deprecated_at = ?, deprecated_reason = ?
              WHERE filer_id = ? AND deprecated_at IS NULL AND doc_id <> ?
                AND tx_date = ? AND tx_type = ? AND ticker IS NULL
                AND LOWER(asset_name) = LOWER(?)`,
        tx.ticker
          ? [nowIso, reason, filing.filerId, filing.docId, tx.txDate, tx.txType, tx.ticker]
          : [nowIso, reason, filing.filerId, filing.docId, tx.txDate, tx.txType, tx.assetName],
      );
      changes += result.meta?.changes ?? 0;
    } catch (err) {
      console.warn('deprecateDeletedMatches failed:', filing.docId, (err as Error).message);
    }
  }
  return changes;
}

export async function resolveVerifiedEmpty(
  env: Env,
  filing: Filing,
  nowIso: string,
  review: ReviewSnapshot | null,
  resolutionReason: string,
): Promise<boolean> {
  return writeResolvedReview(env, filing, nowIso, review, {
    resolutionKind: 'verified_empty',
    resolutionReason,
    ingestStatus: 'verified_empty',
    reason: resolutionReason,
  });
}

async function resolveProcessedNoNewRows(
  env: Env,
  filing: Filing,
  nowIso: string,
  review: ReviewSnapshot | null,
  resolutionReason: string,
): Promise<boolean> {
  // This doc inserted zero live rows.  trg_review_queue_honest_resolution
  // aborts resolved=1 + published unless a live transaction exists on THIS
  // doc_id.  verified_empty is the honest close (migration 0082).
  return writeResolvedReview(env, filing, nowIso, review, {
    resolutionKind: 'verified_empty',
    resolutionReason,
    ingestStatus: 'verified_empty',
    reason: resolutionReason,
  });
}

async function writeResolvedReview(
  env: Env,
  filing: Filing,
  nowIso: string,
  review: ReviewSnapshot | null,
  opts: {
    resolutionKind: 'verified_empty' | 'published';
    resolutionReason: string;
    ingestStatus: string;
    reason: string;
  },
): Promise<boolean> {
  const nextRevision = review ? review.review_revision + 1 : 1;
  const transition: [string, any[]] = review
    ? [
        `UPDATE review_queue
            SET resolved = 1,
                reason = ?,
                agreement_claim_token = NULL,
                agreement_claimed_at = NULL,
                agreement_suppressed_at = NULL,
                agreement_suppression_reason = NULL,
                resolution_kind = ?,
                resolution_reason = ?,
                resolved_at = ?,
                review_revision = review_revision + 1
          WHERE doc_id = ? AND resolved = 0 AND review_revision = ?`,
        [opts.reason, opts.resolutionKind, opts.resolutionReason, nowIso, filing.docId, review.review_revision],
      ]
    : [
        `INSERT OR IGNORE INTO review_queue (
            doc_id, reason, payload, created_at, resolved,
            resolution_kind, resolution_reason, resolved_at
          ) SELECT ?, ?, '{}', ?, 1, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM filings WHERE doc_id = ? AND ingest_status <> 'persisted')`,
        [filing.docId, opts.reason, nowIso, opts.resolutionKind, opts.resolutionReason, nowIso, filing.docId],
      ];
  const results = await batch(env.DB, [
    transition,
    [
      `UPDATE filings
          SET ingest_status = ?, error = NULL
        WHERE doc_id = ?
          AND EXISTS (
            SELECT 1 FROM review_queue
             WHERE doc_id = ? AND resolved = 1 AND resolution_kind = ?
               AND review_revision = ?
          )`,
      [opts.ingestStatus, filing.docId, filing.docId, opts.resolutionKind, nextRevision],
    ],
  ]);
  return (results[0]?.meta?.changes ?? 0) > 0;
}

function reviewReason(
  flagged: FlaggedTx[],
  minConfidence: number,
  confThreshold: number = CONFIDENCE_THRESHOLD,
): string {
  const reasons = new Set<string>();
  for (const f of flagged) for (const flag of f.flags) reasons.add(flag);
  // Empty extract is total failure, not a soft "low confidence" park alone.
  // Keep legacy token for dashboard filters; lead with extract_empty_failure.
  if (flagged.length === 0) {
    reasons.add('extract_empty_failure');
    reasons.add('no_transactions_extracted');
  }
  if (flagged.length > 0 && minConfidence < confThreshold) {
    reasons.add('low_confidence');
  }
  return Array.from(reasons).join(',') || 'needs_review';
}

/**
 * When a filing is rejected purely for exceeding MAX_PUBLISH_TRANSACTIONS_PER_FILING,
 * the raw row count alone can't tell an operator "this is 250 hallucinated OCR
 * duplicates" apart from "this is a real, unusually large filing" — both look
 * identical in review_queue without opening the payload. This computes a cheap
 * per-filing garbage_ratio (duplicate rows + hard-failure rows + ticker/name
 * mismatches, as a share of all flagged rows) plus a confidence-uniformity
 * check (many rows landing at the EXACT same confidence is itself a garbling
 * signature — see H-2025-8221264: 200+ rows all at 0.189) and folds both into
 * the review_queue reason string so triage doesn't require eyeballing raw
 * counts. This does NOT change the publish decision — exceedsPublishLimit
 * already blocked ALL of these rows from being published regardless of this
 * classification; it only changes which reason string + priority they land
 * under. The 0.5 ratio threshold is a starting heuristic (see docs/rollouts
 * for the pilot that calibrates it), not a proven cutoff.
 */
function oversizedLooksLikeGarbage(flagged: FlaggedTx[]): boolean {
  const total = flagged.length;
  if (total === 0) return false;

  const rowKeys = flagged.map((f) => transactionRowKey('primary', 0, f.tx));
  const keyCounts = new Map<string, number>();
  for (const k of rowKeys) keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);

  let garbageRows = 0;
  for (let i = 0; i < flagged.length; i += 1) {
    const f = flagged[i];
    const isDuplicate = (keyCounts.get(rowKeys[i]) ?? 0) > 1;
    const isHardFailure = f.flags.some((flag) => HARD_FAILURE_FLAG_SET.has(flag));
    const isMismatch = f.flags.includes('ticker_asset_mismatch');
    if (isDuplicate || isHardFailure || isMismatch) garbageRows += 1;
  }
  const garbageRatio = garbageRows / total;

  const confidences = flagged.map((f) => f.tx.confidence);
  const mean = confidences.reduce((a, b) => a + b, 0) / confidences.length;
  const variance = confidences.reduce((a, b) => a + (b - mean) ** 2, 0) / confidences.length;
  const confidenceStdev = Math.sqrt(variance);
  // Vision/OpenRouter cap every row at 0.6, so uniform 0.6 is a ceiling
  // artifact, not OCR garble. Only treat a razor-flat LOW score as garbage
  // (H-2025-8221264: 200+ rows all at 0.189).
  const suspiciouslyUniformLow = total > 50 && confidenceStdev < 0.01 && mean < 0.45;

  return garbageRatio >= 0.5 || suspiciouslyUniformLow;
}

function classifyRowLimitReason(flagged: FlaggedTx[]): string {
  const total = flagged.length;
  if (total === 0) return 'extraction_row_limit_exceeded';

  const rowKeys = flagged.map((f) => transactionRowKey('primary', 0, f.tx));
  const keyCounts = new Map<string, number>();
  for (const k of rowKeys) keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
  let garbageRows = 0;
  for (let i = 0; i < flagged.length; i += 1) {
    const f = flagged[i];
    const isDuplicate = (keyCounts.get(rowKeys[i]) ?? 0) > 1;
    const isHardFailure = f.flags.some((flag) => HARD_FAILURE_FLAG_SET.has(flag));
    const isMismatch = f.flags.includes('ticker_asset_mismatch');
    if (isDuplicate || isHardFailure || isMismatch) garbageRows += 1;
  }
  const garbageRatio = garbageRows / total;
  const ratioLabel = garbageRatio.toFixed(2);
  return oversizedLooksLikeGarbage(flagged)
    ? `extraction_row_limit_exceeded_likely_garbage:${ratioLabel}`
    : `extraction_row_limit_exceeded_needs_reprocess:${ratioLabel}`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** True when rawText already contains the structured canonical dollar range. */
function rawTextContainsBracket(
  raw: string,
  min: number,
  max: number | null,
): boolean {
  const compact = raw.replace(/[$,\s]/g, '');
  if (max == null) {
    return compact.includes(`${min}+`) || /over50,?000,?000/i.test(raw);
  }
  return compact.includes(`${min}-${max}`)
    || compact.toLowerCase().includes(`${min}to${max}`);
}

function isTxType(v: unknown): v is TxType {
  return v === 'B' || v === 'S' || v === 'E';
}

function normalizeOwner(o: Owner | null): Owner | null {
  if (o === 'self' || o === 'spouse' || o === 'joint' || o === 'dependent') return o;
  return null;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function normalizeText(value: string | null): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
