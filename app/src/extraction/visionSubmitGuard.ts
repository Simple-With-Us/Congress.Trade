/**
 * Guard for POST /ingest-local-vision after #2107's broad ?worker=local reclaim.
 *
 * Cascade / low-confidence / needs-reprocess review rows already hold a stored
 * extract. Local vision stamps confidence 0.97, so a shorter OCR can publish
 * (or overwrite the payload) and lock the filing — remaining trades never land
 * because drain skips scanned_pdf and pending excludes live txs.
 *
 * Empty / OCR-garbage / likely_garbage parks are the historic reclaim set and
 * may be replaced even when the incoming set is smaller.
 */

const REPLACEABLE_REVIEW_REASON =
  /extract_empty|no_transactions_extracted|ocr_unusable|form_chrome|likely_garbage/i;

function payloadTransactions(payloadJson: string | null | undefined): unknown[] {
  if (!payloadJson) return [];
  try {
    const payload = JSON.parse(payloadJson) as { transactions?: unknown };
    return Array.isArray(payload.transactions) ? payload.transactions : [];
  } catch {
    return [];
  }
}

export function storedReviewTransactionCount(payloadJson: string | null | undefined): number {
  if (!payloadJson) return 0;
  try {
    const payload = JSON.parse(payloadJson) as {
      transactions?: unknown;
      transactionCount?: unknown;
      truncated?: unknown;
    };
    const listed = Array.isArray(payload.transactions) ? payload.transactions.length : 0;
    // A truncated payload's claimed count is the dropped OCR flood, not a
    // complete extract.  Using 501 to block a later 409-row Gemini read is
    // how Khanna H-2024-8220192 / 8220711 stayed in review after #2149.
    if (payload.truncated === true || payload.truncated === 1) return listed;
    const claimed = typeof payload.transactionCount === 'number' && Number.isFinite(payload.transactionCount)
      ? payload.transactionCount
      : 0;
    return Math.max(listed, claimed);
  } catch {
    return 0;
  }
}

/** Rows that actually have a calendar date — form-chrome floods almost never do. */
export function storedReviewDatedCount(payloadJson: string | null | undefined): number {
  let n = 0;
  for (const row of payloadTransactions(payloadJson)) {
    if (!row || typeof row !== 'object') continue;
    const txDate = (row as { txDate?: unknown }).txDate;
    if (typeof txDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(txDate.trim())) n += 1;
  }
  return n;
}

export function storedReviewBlocksSmallerVisionSubmit(
  reason: string | null | undefined,
  payloadJson: string | null | undefined,
  incomingCount: number,
  incomingDatedCount?: number,
): boolean {
  if (REPLACEABLE_REVIEW_REASON.test(reason ?? '')) return false;
  const storedDated = storedReviewDatedCount(payloadJson);
  // A 400-row server_cpu letterhead inventory (almost no dates) must not
  // block a later Grok/Gemini read of the real lots.
  if (
    typeof incomingDatedCount === 'number'
    && Number.isFinite(incomingDatedCount)
    && incomingDatedCount > storedDated
  ) {
    return false;
  }
  // After #2151, local vision persists only dated rows and drops the rest.
  // Comparing raw incoming length would let a 300-row submit with 180 dates
  // look "larger" than a stored 250-lot extract, publish 180, and lock the
  // filing — remaining trades never land because drain skips scanned_pdf.
  const persistableIncoming =
    typeof incomingDatedCount === 'number' && Number.isFinite(incomingDatedCount)
      ? incomingDatedCount
      : incomingCount;
  return storedReviewTransactionCount(payloadJson) > persistableIncoming;
}
