/**
 * POST /api/admin/amount-bounds-canonicalize — idempotent repair for live rows
 * whose amount_min sits one dollar below a STOCK Act bracket lower bound
 * (e.g. $1,000–$15,000 → $1,001–$15,000).  Forward path is
 * extraction/amounts.ts canonicalizeAmountBounds + normalizer; this backfills
 * already-published rows only.  competitor_backfill fabricated bands are
 * excluded.  Dry-run by default; no delivery fan-out (in-place metadata fix).
 *
 * row_key is left unchanged on purpose: it is the row's durable identity
 * (delivery outbox, re-ingest INSERT OR IGNORE), and tradeIdentity already
 * treats 1000|1001 lower bounds as the same band for twin matching.
 */

import { bracketMidpoint } from '../analytics/compute.ts';
import { canonicalizeAmountBounds } from '../extraction/amounts.ts';
import { STOCK_ACT_BRACKETS } from '../shared/brackets.ts';
import { all, batch, first, type SqlParam } from '../shared/db.ts';
import { uuid } from '../shared/ids.ts';
import type { Env, TxSource } from '../shared/types.ts';

interface CandidateRow {
  id: string;
  doc_id: string;
  amount_min: number | null;
  amount_max: number | null;
  source: TxSource;
}

export interface AmountBoundsCanonicalizeResult {
  dryRun: boolean;
  limit: number;
  matched: number;
  /** Rows in the candidate backlog (same predicate as the page query). */
  totalCandidates: number;
  /** True when totalCandidates exceeds matched (operator should rerun). */
  hasMore: boolean;
  /** Rows that would change (dry run) or did change (apply). */
  changed: number;
  /** Candidate-row counts keyed by canonical bracket label, e.g. "1001-15000". */
  byBracket: Record<string, number>;
  sample: Array<{
    id: string;
    docId: string;
    source: string;
    beforeMin: number;
    beforeMax: number | null;
    afterMin: number;
    afterMax: number | null;
  }>;
}

function offByOneAmountPredicate(alias = 't'): string {
  const parts: string[] = [];
  for (const b of STOCK_ACT_BRACKETS) {
    if (b.min === 0) continue;
    if (b.max === null) {
      parts.push(`(${alias}.amount_min = ${b.min - 1} AND ${alias}.amount_max IS NULL)`);
    } else {
      parts.push(`(${alias}.amount_min = ${b.min - 1} AND ${alias}.amount_max = ${b.max})`);
    }
  }
  return parts.length ? `(${parts.join(' OR ')})` : '0';
}

function bracketLabel(min: number, max: number | null): string {
  return max === null ? `${min}-open` : `${min}-${max}`;
}

export async function canonicalizePublishedAmountBounds(
  env: Env,
  opts: { dryRun?: boolean; limit?: number; actor?: string | null } = {},
): Promise<AmountBoundsCanonicalizeResult> {
  const dryRun = opts.dryRun !== false;
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 1000));
  const predicate = offByOneAmountPredicate('t');
  const countRow = await first<{ n: number }>(
    env.DB,
    `SELECT COUNT(*) AS n
       FROM transactions t
      WHERE t.deprecated_at IS NULL
        AND t.source <> 'competitor_backfill'
        AND ${predicate}`,
  );
  const totalCandidates = Number(countRow?.n ?? 0);

  const rows = await all<CandidateRow>(
    env.DB,
    `SELECT t.id, t.doc_id, t.amount_min, t.amount_max, t.source
       FROM transactions t
      WHERE t.deprecated_at IS NULL
        AND t.source <> 'competitor_backfill'
        AND ${predicate}
      ORDER BY t.id
      LIMIT ?`,
    [limit],
  );

  const result: AmountBoundsCanonicalizeResult = {
    dryRun,
    limit,
    matched: rows.length,
    totalCandidates,
    hasMore: totalCandidates > rows.length,
    changed: 0,
    byBracket: {},
    sample: [],
  };

  const pendingByDoc = new Map<
    string,
    Array<{ row: CandidateRow; afterMin: number; afterMax: number | null }>
  >();

  for (const row of rows) {
    const canonical = canonicalizeAmountBounds(row.amount_min, row.amount_max);
    if (!canonical?.changed) continue;

    const label = bracketLabel(canonical.min, canonical.max);
    result.byBracket[label] = (result.byBracket[label] ?? 0) + 1;

    if (result.sample.length < 20) {
      result.sample.push({
        id: row.id,
        docId: row.doc_id,
        source: row.source,
        beforeMin: row.amount_min as number,
        beforeMax: row.amount_max,
        afterMin: canonical.min,
        afterMax: canonical.max,
      });
    }

    if (dryRun) {
      result.changed += 1;
      continue;
    }

    const bucket = pendingByDoc.get(row.doc_id) ?? [];
    bucket.push({
      row,
      afterMin: canonical.min,
      afterMax: canonical.max,
    });
    pendingByDoc.set(row.doc_id, bucket);
  }

  if (!dryRun && pendingByDoc.size > 0) {
    const nowIso = new Date().toISOString();
    for (const [docId, pending] of pendingByDoc) {
      const auditChanges = pending.map(({ row, afterMin, afterMax }) => ({
        txId: row.id,
        before: { amountMin: row.amount_min, amountMax: row.amount_max },
        after: { amountMin: afterMin, amountMax: afterMax },
      }));
      const txIds = pending.map(({ row }) => row.id);
      const statements: Array<[string, SqlParam[]]> = pending.map(({ row, afterMin, afterMax }) => {
        const estValue = bracketMidpoint(afterMin, afterMax);
        return [
          `UPDATE transactions SET amount_min = ?, amount_max = ?, est_value = ?
            WHERE id = ? AND deprecated_at IS NULL AND amount_min = ? AND amount_max IS ?`,
          [afterMin, afterMax, estValue, row.id, row.amount_min, row.amount_max],
        ];
      });
      statements.push([
        `INSERT INTO ingestion_decisions
           (id, doc_id, action, source, actor, reason, payload, transaction_ids, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuid(),
          docId,
          'auto_published',
          'admin',
          opts.actor ?? null,
          'amount_bounds_canonicalize',
          JSON.stringify({ repair: 'amount_bounds_canonicalize', changes: auditChanges }),
          JSON.stringify(txIds),
          nowIso,
        ],
      ]);
      // Guarded UPDATEs: a concurrent bounds edit makes that row a no-op (meta.changes=0).
      const results = await batch(env.DB, statements);
      for (const r of results.slice(0, pending.length)) {
        result.changed += r?.meta?.changes ?? 0;
      }
    }
  }

  return result;
}
