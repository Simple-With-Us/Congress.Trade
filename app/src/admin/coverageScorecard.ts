/**
 * Coverage scorecard — honest "do we have the universe?" view.
 *
 * Owner 2026-08-07: stop claiming completeness without a computed report.
 * This is NOT a credit/budget tool; it answers:
 *   - how many filings we know about
 *   - how many have transactions
 *   - status mix + filed/first_seen range
 *   - whether a green "complete" bar is met (strict, computed)
 */

import type { Env } from '../shared/types.ts';

export interface CoverageScorecard {
  asOf: string;
  filings: {
    total: number;
    byChamber: Record<string, number>;
    byStatus: Record<string, number>;
    earliestFirstSeen: string | null;
    latestFirstSeen: string | null;
    earliestFiled: string | null;
    latestFiled: string | null;
  };
  transactions: {
    total: number;
    docsWithTransactions: number;
  };
  /** Share of filings that already have ≥1 transaction row. */
  extractionCoveragePct: number;
  /**
   * True only when every filing is past raw-fetch AND has transactions OR is
   * terminal error/empty with an explicit error. Computed, never claimed.
   */
  complete: boolean;
  completeReasons: string[];
  notes: string[];
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function buildCoverageScorecard(env: Env, now = new Date()): Promise<CoverageScorecard> {
  const db = env.DB;
  const notes: string[] = [];
  const completeReasons: string[] = [];

  const totalRow = await db.prepare('SELECT COUNT(*) AS n FROM filings').first<{ n: number }>();
  const total = num(totalRow?.n);

  const byChamberRows = await db.prepare(
    `SELECT COALESCE(chamber, 'unknown') AS k, COUNT(*) AS n FROM filings GROUP BY 1`,
  ).all<{ k: string; n: number }>();
  const byChamber: Record<string, number> = {};
  for (const row of byChamberRows.results ?? []) byChamber[row.k] = num(row.n);

  const byStatusRows = await db.prepare(
    `SELECT COALESCE(ingest_status, 'unknown') AS k, COUNT(*) AS n FROM filings GROUP BY 1`,
  ).all<{ k: string; n: number }>();
  const byStatus: Record<string, number> = {};
  for (const row of byStatusRows.results ?? []) byStatus[row.k] = num(row.n);

  const range = await db.prepare(
    `SELECT MIN(first_seen_at) AS earliest_first_seen,
            MAX(first_seen_at) AS latest_first_seen,
            MIN(filed_date) AS earliest_filed,
            MAX(filed_date) AS latest_filed
       FROM filings`,
  ).first<{
    earliest_first_seen: string | null;
    latest_first_seen: string | null;
    earliest_filed: string | null;
    latest_filed: string | null;
  }>();

  const txTotalRow = await db.prepare('SELECT COUNT(*) AS n FROM transactions').first<{ n: number }>();
  // Only count filings that have ≥1 transaction — never orphan tx doc_ids
  // (restores / provider seeds can leave txs for docs not in filings).
  const docsWithTxRow = await db.prepare(
    `SELECT COUNT(*) AS n FROM filings f
      WHERE EXISTS (
        SELECT 1 FROM transactions t
         WHERE t.doc_id = f.doc_id
      )`,
  ).first<{ n: number }>();
  const docsWithTransactions = num(docsWithTxRow?.n);
  const extractionCoveragePct = total > 0
    ? Math.round((docsWithTransactions / total) * 10_000) / 100
    : 0;

  // Terminal-ish statuses that may legitimately have zero rows (empty/corrupt).
  const terminalOkWithoutTx = (byStatus['error'] ?? 0)
    + (byStatus['rejected'] ?? 0)
    + (byStatus['empty'] ?? 0);
  const needTx = total - terminalOkWithoutTx;
  if (docsWithTransactions < needTx) {
    completeReasons.push(
      `docs_with_transactions ${docsWithTransactions} < filings needing extraction ${needTx}`,
    );
  }
  const pendingLike = (byStatus['pending'] ?? 0)
    + (byStatus['new'] ?? 0)
    + (byStatus['fetched'] ?? 0)
    + (byStatus['classified'] ?? 0)
    + (byStatus['extraction_pending_local'] ?? 0);
  if (pendingLike > 0) {
    completeReasons.push(`pipeline_pending_or_mid_stage ${pendingLike}`);
  }
  if (total === 0) {
    completeReasons.push('no_filings_in_db');
    notes.push(
      'Empty filings table usually means cutover/restore gap, not "no PTRs exist in the world".',
    );
  }

  // First-seen clustering signal: many docs sharing the same first_seen hour
  // after a restore looks like a bulk re-import, not same-day discovery.
  try {
    const cluster = await db.prepare(
      `SELECT substr(first_seen_at, 1, 13) AS hour, COUNT(*) AS n
         FROM filings
        WHERE first_seen_at IS NOT NULL
        GROUP BY 1
        ORDER BY n DESC
        LIMIT 1`,
    ).first<{ hour: string; n: number }>();
    if (cluster && num(cluster.n) >= 50) {
      notes.push(
        `largest first_seen hour bucket: ${cluster.hour}… with ${num(cluster.n)} filings `
        + `(bulk import / empty-DB rediscovery pattern if unexpected)`,
      );
    }
  } catch {
    /* optional diagnostic */
  }

  notes.push(
    'complete is computed only: green when no mid-stage backlog and every non-terminal filing has ≥1 transaction.',
  );

  return {
    asOf: now.toISOString(),
    filings: {
      total,
      byChamber,
      byStatus,
      earliestFirstSeen: range?.earliest_first_seen ?? null,
      latestFirstSeen: range?.latest_first_seen ?? null,
      earliestFiled: range?.earliest_filed ?? null,
      latestFiled: range?.latest_filed ?? null,
    },
    transactions: {
      total: num(txTotalRow?.n),
      docsWithTransactions,
    },
    extractionCoveragePct,
    complete: completeReasons.length === 0 && total > 0,
    completeReasons,
    notes,
  };
}
