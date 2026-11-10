/**
 * src/extraction/amendmentPredecessor.ts
 *
 * WHICH FILING AN AMENDED FILING IS ALLOWED TO SUPERSEDE.
 *
 * CT-2452 (P1).  The predecessor match used to be "same filer + same
 * filed_date, or a shared doc-id prefix", so publishing an amendment
 * soft-deprecated EVERY sibling PTR filed on the same day.  OGE files several
 * separate periodic transaction reports on one date and marks them "(2)",
 * "(3)", ... — they are different reporting periods, not versions of one
 * report.  The 2025-08-12 Trump 278-T family is the proof:
 *
 *   278T.pdf             E-2025-donald-j-trump-08-12-2025-278t          Jan 21 - Jun 13
 *   278T(2) AMENDED.pdf  E-2025-donald-j-trump-08-12-2025-278t-2-amended  Jul  1 - Jul 23
 *   278T(3).pdf          E-2025-donald-j-trump-08-12-2025-278t-3        Jul 25 + Aug  1
 *
 * Publishing the July amendment therefore soft-deprecated the other two
 * siblings — 545 real transactions of the President's disclosures — even
 * though the amendment's own first page ("Reporting Period: July 1, 2025 -
 * July 23, 2025") shows it supersedes NEITHER of them.
 *
 * THE RULE, in two conditions, both required:
 *
 *   1. RELATIONSHIP.  The candidate must be the filing the amendment
 *      actually amends.  OGE names an amendment after the document it amends
 *      ("278T(2) AMENDED.pdf" amends "278T(2).pdf"), and ogeDocId() lowers the
 *      filename into the doc-id slug, so the amended document's doc id is the
 *      amended document's doc id plus an "-amended" marker.  Stripping the
 *      marker yields the amended filing's doc id.
 *   2. PERIOD OVERLAP.  The candidate's OWN transaction dates must overlap
 *      the amended filing's own reporting period.  An amendment restates one
 *      reporting period, so a candidate whose rows fall in a different period
 *      is a different report that happened to be filed the same day.
 *
 * `filings` has no reporting-period column, so each period is the span of
 * that filing's own LIVE transaction dates (an amendment is published before
 * its predecessor is superseded, so both sides have live rows to measure).
 *
 * Every mismatch SKIPS and LOGS (doc id + both periods) instead of
 * deprecating.  Failing closed is the point: an over-broad deprecation
 * silently unpublishes real transactions and opens no queue row, while a
 * missed deprecation only leaves an old copy of a restated row visible
 * next to the amendment.
 */

import { get, run } from '../shared/db.ts';

/**
 * Trailing markers an OGE amendment carries after the amended document's
 * name.  Longest first: "-amendment" must be tested before "-amend".
 */
const AMENDMENT_DOC_ID_MARKERS = ['-amended', '-amendment', '-amend'] as const;

/** A span of transaction dates, as 'YYYY-MM-DD'. */
export interface ReportingPeriod {
  start: string;
  end: string;
}

/**
 * The doc id of the filing an amended filing amends, or null when the doc id
 * carries no amendment marker.
 *
 * OGE files an amendment as "<original filename> AMENDED.pdf" (sometimes
 * "AMENDED (2).pdf"), so the doc id of the amendment is the doc id of the
 * amended filing plus a marker.  Stripping it yields the amended filing's
 * doc id; nothing else is treated as a predecessor.
 *
 * Null means "no relationship can be derived" — NOT "fall back to guessing".
 * A doc id with no marker (a plain "…-278t-2" PTR) is a sibling report, not
 * an amendment, and must never be superseded by one.
 */
export function deriveAmendedPredecessorDocId(docId: string): string | null {
  let candidate = docId;
  // "…-278t-2-amended-1" (a second amendment) still amends "…-278t-2".
  const trailingSeq = /-\d+$/.exec(candidate);
  if (trailingSeq) candidate = candidate.slice(0, candidate.length - trailingSeq[0].length);
  const lower = candidate.toLowerCase();
  for (const marker of AMENDMENT_DOC_ID_MARKERS) {
    if (lower.endsWith(marker)) {
      const trimmed = candidate.slice(0, candidate.length - marker.length);
      return trimmed.length > 0 ? trimmed : null;
    }
  }
  return null;
}

/**
 * The reporting period of a filing, measured from its own live transaction
 * dates.  Null when the filing has no live rows to measure (nothing to
 * deprecate, and nothing to compare against).
 */
export async function reportingPeriodOf(
  db: D1Database,
  docId: string,
): Promise<ReportingPeriod | null> {
  const row = await get<{ start: string | null; end: string | null }>(
    db,
    `SELECT MIN(tx_date) AS start, MAX(tx_date) AS end
       FROM transactions
      WHERE doc_id = ?
        AND deprecated_at IS NULL
        AND tx_date IS NOT NULL
        AND tx_date <> ''`,
    [docId],
  );
  if (!row?.start || !row.end) return null;
  return { start: row.start, end: row.end };
}

/**
 * True when two reporting periods share at least one day.  'YYYY-MM-DD'
 * compares correctly as a string, so no date parsing is needed.
 */
export function reportingPeriodsOverlap(a: ReportingPeriod, b: ReportingPeriod): boolean {
  return a.start <= b.end && a.end >= b.start;
}

/** The filing row for a candidate predecessor, with its own filer + date. */
interface PredecessorFiling {
  doc_id: string;
  filer_id: string | null;
  filed_date: string | null;
}

/**
 * Find the filing an amendment supersedes.
 *
 * Exact doc-id match first.  The doc id is "<CHAMBER>-<year>-<slug>" and the
 * year comes from the filename's date, which an amendment and the document
 * it amends share — but when they differ, the same slug under a different
 * year prefix is still the same document, so a unique same-filer match on
 * the slug is accepted.  "Unique" matters: an ambiguous slug resolves to
 * nothing rather than to a guess.
 */
async function findPredecessorFiling(
  db: D1Database,
  predecessorDocId: string,
  filerId: string,
): Promise<PredecessorFiling | null> {
  const exact = await get<PredecessorFiling>(
    db,
    `SELECT doc_id, filer_id, filed_date
       FROM filings
      WHERE doc_id = ?
        AND ingest_status = 'persisted'`,
    [predecessorDocId],
  );
  if (exact) return exact;

  const slug = predecessorDocId.replace(/^[A-Za-z]+-\d{4}-/, '');
  if (!slug) return null;
  const sameSlug = await get<PredecessorFiling & { matches: number }>(
    db,
    `SELECT doc_id, filer_id, filed_date,
            (SELECT COUNT(*) FROM filings f2
              WHERE f2.doc_id LIKE '%-' || ? AND f2.filer_id = ?) AS matches
       FROM filings
      WHERE doc_id LIKE '%-' || ?
        AND filer_id = ?
        AND ingest_status = 'persisted'
      LIMIT 2`,
    [slug, filerId, slug, filerId],
  );
  if (!sameSlug || sameSlug.matches !== 1) return null;
  return sameSlug;
}

/**
 * Soft-deprecates the live transactions of the filing an amended filing
 * supersedes, and nothing else.
 *
 * Returns the number of rows deprecated (0 when the amendment supersedes no
 * filing).  Never throws: a deprecation that cannot be proven safe is
 * skipped, not guessed.
 */
export async function deprecatePredecessorFilingTransactions(
  db: D1Database,
  docId: string,
  filerId: string | null,
  filedDate: string | null,
  nowIso: string = new Date().toISOString(),
): Promise<number> {
  try {
    return await deprecatePredecessorRows(db, docId, filerId, filedDate, nowIso);
  } catch (err) {
    console.warn(
      'amendment deprecation skipped: database error',
      docId,
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
}

async function deprecatePredecessorRows(
  db: D1Database,
  docId: string,
  filerId: string | null,
  filedDate: string | null,
  nowIso: string,
): Promise<number> {
  if (!filerId) return 0;

  // 1. The amended filing's own reporting period.
  const amendedPeriod = await reportingPeriodOf(db, docId);
  if (!amendedPeriod) {
    console.warn(
      'amendment deprecation skipped: amended filing has no live rows to date the relationship',
      docId,
    );
    return 0;
  }

  // 2. The filing this amendment actually amends.
  const predecessorDocId = deriveAmendedPredecessorDocId(docId);
  if (!predecessorDocId) {
    console.warn(
      'amendment deprecation skipped: no amended predecessor derivable from the doc id',
      docId,
      `filed ${filedDate ?? 'unknown'}`,
    );
    return 0;
  }

  const predecessor = await findPredecessorFiling(db, predecessorDocId, filerId);
  if (!predecessor) {
    console.warn(
      'amendment deprecation skipped: amended predecessor is not an ingested filing',
      docId,
      predecessorDocId,
    );
    return 0;
  }

  // An amendment never supersedes another filer's filing, whatever the
  // doc id says, and a predecessor with no filer on record is not proof.
  if (predecessor.filer_id !== filerId) {
    console.warn(
      'amendment deprecation skipped: predecessor belongs to another filer',
      docId,
      predecessor.doc_id,
    );
    return 0;
  }

  // 3. The predecessor's own period must overlap the amended filing's.
  const predecessorPeriod = await reportingPeriodOf(db, predecessor.doc_id);
  if (!predecessorPeriod) {
    console.warn(
      'amendment deprecation skipped: predecessor has no live rows',
      docId,
      predecessor.doc_id,
    );
    return 0;
  }
  if (!reportingPeriodsOverlap(predecessorPeriod, amendedPeriod)) {
    console.warn(
      'amendment deprecation skipped: reporting periods are disjoint',
      docId,
      predecessor.doc_id,
      `predecessor ${predecessorPeriod.start}..${predecessorPeriod.end}`,
      `amended ${amendedPeriod.start}..${amendedPeriod.end}`,
    );
    return 0;
  }

  // 4. Deprecate exactly that filing's live rows.
  const reason = `superseded by amendment ${docId}`;
  const res = await run(
    db,
    `UPDATE transactions
        SET deprecated_at = ?,
            deprecated_reason = ?
      WHERE doc_id = ?
        AND deprecated_at IS NULL`,
    [nowIso, reason, predecessor.doc_id],
  );
  return res.meta?.changes ?? 0;
}
