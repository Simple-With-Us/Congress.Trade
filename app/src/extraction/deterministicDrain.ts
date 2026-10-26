/**
 * Deterministic review drain (A2) — independent of OpenRouter / autopilot halt.
 *
 * House text PDF, Senate HTML, and OGE text already extract structured rows
 * without vision. When they land in review (or were parked by an older gate),
 * re-run extract+normalize from the stored R2 copy. Never calls agreement or
 * OpenRouter, so a quota halt cannot strand free publish paths.
 */

import type { Env, Filing, ParsedTx } from '../shared/types.ts';
import { all, get, run } from '../shared/db.ts';
import { extractAndNormalize, extractParsed } from './orchestrator.ts';
import { isDeterministicExtractor, normalize } from './normalizer.ts';
import { countHousePtrTails } from './ptrTails.ts';
import { recordIngestionDecision } from '../shared/ingestionDecisions.ts';
import { DEFAULT_AGREEMENT_ATTEMPT_CAP } from './reviewQueueHealth.ts';

export interface DeterministicDrainResult {
  scanned: number;
  published: number;
  stillReview: number;
  skipped: number;
  errors: number;
}

const DEFAULT_LIMIT = 40;

function countPayloadPtrTails(transactions: unknown[]): number {
  let n = 0;
  for (const tx of transactions) {
    if (!tx || typeof tx !== 'object') continue;
    const raw = (tx as { rawText?: unknown }).rawText;
    if (typeof raw === 'string' && raw) n += countHousePtrTails(raw);
  }
  return n;
}

/** True when the parked review payload is a sliced stump, not the full extract. */
export function storedReviewPayloadIsIncomplete(
  payload: {
    transactions?: unknown[];
    truncated?: boolean;
    transactionCount?: number;
  } | null,
): boolean {
  if (!payload) return true;
  const txs = Array.isArray(payload.transactions) ? payload.transactions : [];
  if (txs.length === 0) return true;
  if (payload.truncated === true) return true;
  if (typeof payload.transactionCount === 'number' && payload.transactionCount > txs.length) {
    return true;
  }
  // One stored row whose rawText still contains later `[ST] S date $amount`
  // tails is the glued-PTR class (H-2025-20030212). Publishing it would land
  // 1 of N trades and skip re-extract — same failure as a truncated McCaul.
  return countPayloadPtrTails(txs) > txs.length;
}

function payloadToParsedTx(row: Record<string, unknown>): ParsedTx {
  return {
    txDate: typeof row.txDate === 'string' ? row.txDate : null,
    owner: (row.owner as ParsedTx['owner']) ?? null,
    assetName: typeof row.assetName === 'string' ? row.assetName : '',
    ticker: typeof row.ticker === 'string' ? row.ticker : null,
    assetType: typeof row.assetType === 'string' ? row.assetType : null,
    assetTypeName: typeof row.assetTypeName === 'string' ? row.assetTypeName : null,
    txType: (row.txType as ParsedTx['txType']) ?? 'B',
    amountMin: typeof row.amountMin === 'number' ? row.amountMin : null,
    amountMax: typeof row.amountMax === 'number' ? row.amountMax : null,
    isOption: Boolean(row.isOption),
    capGainsOver200: Boolean(row.capGainsOver200),
    rawText: typeof row.rawText === 'string' ? row.rawText : '',
    confidence: typeof row.confidence === 'number' ? row.confidence : 0.6,
    filingStatus: typeof row.filingStatus === 'string' ? row.filingStatus : null,
    subholding: typeof row.subholding === 'string' ? row.subholding : null,
    location: typeof row.location === 'string' ? row.location : null,
    description: typeof row.description === 'string' ? row.description : null,
    supplementalText: typeof row.supplementalText === 'string' ? row.supplementalText : null,
  };
}

async function tryPublishStoredPayload(
  env: Env,
  row: {
    doc_id: string;
    doc_kind: string | null;
    extractor: string | null;
    reason: string | null;
    payload: string | null;
  },
): Promise<'published' | 'still' | 'skip'> {
  const reason = (row.reason || '').toLowerCase();
  if (reason.includes('form_chrome') || reason.includes('ocr_unusable')) return 'skip';
  if (!isDeterministicExtractor(row.extractor, row.doc_kind)) return 'skip';
  // Filings held for the old 200-row cap stored a sliced payload (`truncated:
  // true`, 200 of 219). Publishing that stump marks the filing persisted and
  // skips re-extract — the rest of the trades never land.
  if (reason.includes('extraction_row_limit') || reason.includes('row_limit_exceeded')) {
    return 'still';
  }
  let payload: {
    transactions?: unknown[];
    truncated?: boolean;
    transactionCount?: number;
  } | null = null;
  if (row.payload) {
    try {
      payload = JSON.parse(row.payload) as {
        transactions?: unknown[];
        truncated?: boolean;
        transactionCount?: number;
      };
    } catch {
      return 'still';
    }
  }
  if (storedReviewPayloadIsIncomplete(payload) || !payload?.transactions) return 'still';
  const txs = payload.transactions;
  const filing = await get<Filing>(
    env.DB,
    `SELECT doc_id as docId, chamber, filer_id as filerId, filing_type as filingType,
            filed_date as filedDate, source_url as sourceUrl, raw_object_key as rawObjectKey,
            ingest_status as ingestStatus, doc_kind as docKind, extractor, model_version as modelVersion,
            confidence, first_seen_at as firstSeenAt, source_updated_at as sourceUpdatedAt, error
       FROM filings WHERE doc_id = ?`,
    [row.doc_id],
  );
  if (!filing) return 'still';
  const parsed = txs
    .filter((tx): tx is Record<string, unknown> => !!tx && typeof tx === 'object')
    .map(payloadToParsedTx);
  const result = await normalize(env, filing, parsed, {
    extractor: row.extractor ?? filing.extractor ?? undefined,
    modelVersion: filing.modelVersion,
  });
  if (result.published) {
    await recordIngestionDecision(env.DB, {
      docId: row.doc_id,
      source: 'pipeline',
      action: 'auto_published',
      reason: 'deterministic_drain_stored_payload',
      payload: { extractor: row.extractor, docKind: row.doc_kind, rowCount: parsed.length },
    }).catch(() => undefined);
    return 'published';
  }
  return 'still';
}

/**
 * Re-extract + normalize unresolved review rows for deterministic doc kinds.
 * Safe to call every minute; LIMIT-bounded; no provider LLM spend.
 */
export async function maybeRunDeterministicReviewDrain(
  env: Env,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<DeterministicDrainResult> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), 50);
  const out: DeterministicDrainResult = {
    scanned: 0,
    published: 0,
    stillReview: 0,
    skipped: 0,
    errors: 0,
  };

  let rows: Array<{
    doc_id: string;
    raw_object_key: string | null;
    doc_kind: string | null;
    extractor: string | null;
    reason: string | null;
    payload: string | null;
    agreement_attempts: number | null;
  }>;
  try {
    rows = await all(
      env.DB,
      `SELECT f.doc_id, f.raw_object_key, f.doc_kind, f.extractor,
              rq.reason, rq.payload, rq.agreement_attempts
         FROM review_queue rq
         JOIN filings f ON f.doc_id = rq.doc_id
        WHERE rq.resolved = 0
          AND f.raw_object_key IS NOT NULL
          AND COALESCE(rq.reason, '') NOT LIKE '%form_chrome_only%'
          AND COALESCE(rq.reason, '') NOT LIKE '%ocr_unusable%'
          -- A future-tx-date hard fail cannot be fixed by deterministic
          -- re-extraction (same parser, same misread date), so re-flagging it
          -- every minute is pure churn (observed 2026-08-20: H-2025-20033330
          -- revision climbing ~1/min for days).
          AND COALESCE(rq.reason, '') NOT LIKE '%future_tx_date%'
          -- Same for a trade dated past the filing window (the parser reads
          -- the same date again) and a 278-T parked for missing rows (the
          -- same reader drops the same rows); both need a human or vision.
          AND COALESCE(rq.reason, '') NOT LIKE '%tx_date_after_filing_window%'
          AND COALESCE(rq.reason, '') NOT LIKE '%oge_rows_incomplete%'
          -- Attempt-capped cascade disagreement is human-review terminal.
          -- Re-extracting the same textPdf every minute (live 2026-08-26:
          -- H-2026-20035235 revision 3600+, H-2026-20035196 2700+) only
          -- re-opens the cascade receipt. Uncapped cascade rows still drain.
          AND NOT (
            COALESCE(rq.reason, '') = 'agreement_cascade_unresolved'
            AND COALESCE(rq.agreement_attempts, 0) >= ${DEFAULT_AGREEMENT_ATTEMPT_CAP}
          )
          AND LOWER(COALESCE(f.doc_kind, '')) <> 'scanned_pdf'
          AND (
            LOWER(COALESCE(f.doc_kind, '')) IN ('text_pdf', 'senate_html', 'oge_html', 'oge_text')
            OR (
              -- Unknown-kind docs are only drainable when the extractor itself
              -- is deterministic; the extractor string alone is NOT enough.
              -- A scanned_pdf can carry a stale 'textPdf' extractor label
              -- (observed 2026-08-20: H-2024-20025111). Re-extracting it here
              -- produced garbage every minute, which the agreement recovery
              -- then re-flagged as cascade_unresolved — an infinite per-minute
              -- review_revision / receipt ping-pong with zero model spend.
              LOWER(COALESCE(f.doc_kind, '')) IN ('', 'unknown')
              AND LOWER(COALESCE(f.extractor, '')) IN (
                'textpdf', 'text_pdf', 'senatehtml', 'senate_html',
                'ogetext', 'oge_text', 'oge-text', 'openroutertext', 'open_router_text'
              )
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM transactions t
             WHERE t.doc_id = rq.doc_id
               AND t.source IN ('primary', 'manual')
               AND t.deprecated_at IS NULL
          )
        ORDER BY rq.created_at DESC
        LIMIT ?`,
      [limit],
    );
  } catch (err) {
    console.warn('deterministicDrain: selector failed:', (err as Error).message);
    return out;
  }

  for (const row of rows) {
    if (opts.signal?.aborted) break;
    out.scanned++;
    // Belt-and-braces: a scanned_pdf must never be re-extracted by the
    // deterministic path even if the extractor string looks text-ish.
    if ((row.doc_kind ?? '').trim().toLowerCase() === 'scanned_pdf') {
      out.skipped++;
      continue;
    }
    if (
      (row.reason ?? '').trim() === 'agreement_cascade_unresolved'
      && (Number(row.agreement_attempts) || 0) >= DEFAULT_AGREEMENT_ATTEMPT_CAP
    ) {
      out.skipped++;
      continue;
    }
    if (!isDeterministicExtractor(row.extractor, row.doc_kind)) {
      out.skipped++;
      continue;
    }
    try {
      const fromPayload = await tryPublishStoredPayload(env, row);
      if (fromPayload === 'published') {
        out.published++;
        continue;
      }
      if (fromPayload === 'skip') {
        out.skipped++;
        continue;
      }
      // Prefer full extract+normalize from stored R2 (text/html extractors only).
      await extractAndNormalize(env, row.doc_id);
      const live = await all<{ n: number }>(
        env.DB,
        `SELECT COUNT(*) AS n FROM transactions
          WHERE doc_id = ? AND deprecated_at IS NULL AND source IN ('primary', 'manual')`,
        [row.doc_id],
      );
      if ((live[0]?.n ?? 0) > 0) {
        out.published++;
        await recordIngestionDecision(env.DB, {
          docId: row.doc_id,
          source: 'pipeline',
          action: 'auto_published',
          reason: 'deterministic_drain_reextract',
          payload: { extractor: row.extractor, docKind: row.doc_kind },
        }).catch(() => undefined);
      } else {
        // Fallback: extractParsed + normalize once more with explicit extractor.
        const extracted = await extractParsed(env, row.doc_id);
        if (!extracted || !isDeterministicExtractor(extracted.extractor, extracted.filing.docKind)) {
          out.stillReview++;
          continue;
        }
        const result = await normalize(env, extracted.filing, extracted.transactions, {
          extractor: extracted.extractor,
          modelVersion: extracted.modelVersion,
          sourceText: extracted.raw,
          parseDisposition: extracted.parseDisposition,
        });
        if (result.published) {
          out.published++;
        } else {
          out.stillReview++;
        }
      }
    } catch (err) {
      out.errors++;
      console.warn(
        'deterministicDrain: failed for',
        row.doc_id,
        (err as Error).message,
      );
    }
  }

  if (out.scanned > 0) {
    console.log('deterministicDrain:', JSON.stringify(out));
  }
  return out;
}

/**
 * A5 / C8: re-queue rejected scanned filings that still have raw bytes for
 * local vision (never OpenRouter). Bounded, idempotent, one attempt budget
 * stamp so we do not loop forever.  Skip `local_vision_exhausted` — the Mac
 * worker already spent its three tries (often a genuine NOTHING TO REPORT).
 */
export interface LocalVisionRequeueResult {
  requeued: number;
  skipped: number;
}

export async function sweepRejectedScannedForLocalVision(
  env: Env,
  opts: { limit?: number } = {},
): Promise<LocalVisionRequeueResult> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const nowIso = new Date().toISOString();
  // Only honest garbage/OCR rejects with stored raw — not provider-missing stubs.
  const candidates = await all<{ doc_id: string }>(
    env.DB,
    `SELECT f.doc_id
       FROM filings f
       LEFT JOIN review_queue rq ON rq.doc_id = f.doc_id
      WHERE f.raw_object_key IS NOT NULL
        AND f.doc_id NOT LIKE 'provider-missing-%'
        AND LOWER(COALESCE(f.doc_kind, '')) IN ('scanned_pdf', 'unknown', '')
        AND (
          f.ingest_status = 'error'
          OR (rq.resolved = 1 AND rq.resolution_kind = 'rejected')
        )
        AND (
          COALESCE(f.error, '') LIKE '%ocr_unusable%'
          OR COALESCE(f.error, '') LIKE '%server_cpu%'
          OR COALESCE(rq.reason, '') LIKE '%ocr_unusable%'
          OR COALESCE(rq.reason, '') LIKE '%form_chrome%'
          OR COALESCE(rq.resolution_reason, '') LIKE '%ocr_unusable%'
          OR COALESCE(rq.resolution_reason, '') LIKE '%server_cpu%'
          OR COALESCE(rq.resolution_reason, '') LIKE '%form_chrome%'
        )
        AND COALESCE(f.error, '') NOT LIKE '%local_vision_requeue_once%'
        AND COALESCE(f.error, '') NOT LIKE '%local_vision_exhausted%'
      ORDER BY f.first_seen_at ASC
      LIMIT ?`,
    [limit],
  );

  let requeued = 0;
  for (const c of candidates) {
    const expires = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    try {
      await run(
        env.DB,
        `UPDATE filings
            SET ingest_status = 'extraction_pending_local',
                local_wait_expires_at = ?,
                error = COALESCE(error || ';', '') || 'local_vision_requeue_once:' || ?,
                extractor = COALESCE(NULLIF(extractor, ''), 'local_mac')
          WHERE doc_id = ?`,
        [expires, nowIso, c.doc_id],
      );
      // Re-open review if it was rejected so the queue is honest again.
      await run(
        env.DB,
        `UPDATE review_queue
            SET resolved = 0,
                resolution_kind = NULL,
                resolution_reason = NULL,
                resolved_at = NULL,
                reason = COALESCE(reason, 'local_vision_requeue')
          WHERE doc_id = ? AND resolved = 1`,
        [c.doc_id],
      ).catch(() => undefined);
      try {
        await env.INGEST_QUEUE.send({
          type: 'filing.local_wait_check',
          docId: c.doc_id,
        });
      } catch {
        // Queue may be unavailable; ceiling sweep still advances pending_local.
      }
      requeued++;
    } catch (err) {
      console.warn('localVision requeue failed:', c.doc_id, (err as Error).message);
    }
  }
  if (requeued > 0) {
    console.log('localVision requeue:', JSON.stringify({ requeued, candidates: candidates.length }));
  }
  return { requeued, skipped: candidates.length - requeued };
}
