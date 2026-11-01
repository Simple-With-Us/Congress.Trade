/**
 * POST /api/admin/amount-bounds-canonicalize — idempotent repair for live rows
 * whose amount_min sits one dollar below a STOCK Act bracket lower bound
 * (e.g. $1,000–$15,000 → $1,001–$15,000).  Forward path is
 * extraction/amounts.ts canonicalizeAmountBounds + normalizer; this backfills
 * already-published rows only.  competitor_backfill fabricated bands are
 * excluded.  Dry-run by default; no delivery fan-out (in-place metadata fix).
 */

import { bracketMidpoint } from '../analytics/compute.ts';
import { canonicalizeAmountBounds } from '../extraction/amounts.ts';
import { loadResolver, transactionRowKey } from '../extraction/normalizer.ts';
import { recordIngestionDecision } from '../shared/ingestionDecisions.ts';
import { STOCK_ACT_BRACKETS } from '../shared/brackets.ts';
import { all, run } from '../shared/db.ts';
import type { Env, TxSource, TxType } from '../shared/types.ts';

interface CandidateRow {
  id: string;
  doc_id: string;
  ticker: string | null;
  asset_name: string | null;
  tx_date: string | null;
  owner: string | null;
  asset_type: string | null;
  asset_type_name: string | null;
  tx_type: string | null;
  amount_min: number | null;
  amount_max: number | null;
  is_option: number | null;
  cap_gains_over_200: number | null;
  raw_text: string | null;
  filing_status: string | null;
  subholding: string | null;
  location: string | null;
  description: string | null;
  supplemental_text: string | null;
  source: TxSource;
  row_key: string | null;
}

export interface AmountBoundsCanonicalizeResult {
  dryRun: boolean;
  limit: number;
  matched: number;
  /** Rows that would change or did change (excludes collision skips on apply). */
  changed: number;
  collisionsSkipped: number;
  /** Counts keyed by canonical bracket label, e.g. "1001-15000". */
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

function rowIndexOf(rowKey: string | null): number | null {
  const m = /^v1:[^:]+:(\d+):/.exec(rowKey ?? '');
  return m ? Number(m[1]) : null;
}

function owner(value: string | null): 'self' | 'spouse' | 'joint' | 'dependent' | null {
  return value === 'self' || value === 'spouse' || value === 'joint' || value === 'dependent' ? value : null;
}

function side(value: string | null): TxType {
  if (value === 'P' || value === 'B') return 'B';
  return value === 'S' || value === 'E' ? value : 'B';
}

export async function canonicalizePublishedAmountBounds(
  env: Env,
  opts: { dryRun?: boolean; limit?: number; actor?: string | null } = {},
): Promise<AmountBoundsCanonicalizeResult> {
  const dryRun = opts.dryRun !== false;
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
  const predicate = offByOneAmountPredicate('t');
  const rows = await all<CandidateRow>(
    env.DB,
    `SELECT t.id, t.doc_id, t.ticker, t.asset_name, t.tx_date, t.owner, t.asset_type, t.asset_type_name,
            t.tx_type, t.amount_min, t.amount_max, t.is_option, t.cap_gains_over_200, t.raw_text,
            t.filing_status, t.subholding, t.location, t.description, t.supplemental_text, t.source, t.row_key
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
    changed: 0,
    collisionsSkipped: 0,
    byBracket: {},
    sample: [],
  };

  const resolver = dryRun ? null : await loadResolver(env);
  const auditByDoc = new Map<string, { txIds: string[]; changes: Array<Record<string, unknown>> }>();

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

    const rowIndex = rowIndexOf(row.row_key);
    const estValue = bracketMidpoint(canonical.min, canonical.max);
    let rowKey = row.row_key;
    if (rowIndex !== null) {
      rowKey = transactionRowKey(row.source, rowIndex, {
        txDate: row.tx_date,
        owner: owner(row.owner),
        assetName: row.asset_name ?? '',
        ticker: row.ticker && row.ticker.trim() ? row.ticker.trim().toUpperCase() : resolver!(null, row.asset_name ?? ''),
        assetType: row.asset_type,
        assetTypeName: row.asset_type_name,
        txType: side(row.tx_type),
        amountMin: canonical.min,
        amountMax: canonical.max,
        isOption: row.is_option === 1,
        capGainsOver200: row.cap_gains_over_200 === 1,
        rawText: row.raw_text ?? '',
        filingStatus: row.filing_status,
        subholding: row.subholding,
        location: row.location,
        description: row.description,
        supplementalText: row.supplemental_text,
      });
    }

    const update = await run(
      env.DB,
      'UPDATE OR IGNORE transactions SET amount_min = ?, amount_max = ?, est_value = ?, row_key = ? WHERE id = ?',
      [canonical.min, canonical.max, estValue, rowKey, row.id],
    );
    if ((update.meta?.changes ?? 0) === 0) {
      result.collisionsSkipped += 1;
      continue;
    }
    result.changed += 1;

    const bucket = auditByDoc.get(row.doc_id) ?? { txIds: [], changes: [] };
    bucket.txIds.push(row.id);
    bucket.changes.push({
      txId: row.id,
      before: { amountMin: row.amount_min, amountMax: row.amount_max },
      after: { amountMin: canonical.min, amountMax: canonical.max },
    });
    auditByDoc.set(row.doc_id, bucket);
  }

  if (!dryRun) {
    const nowIso = new Date().toISOString();
    for (const [docId, audit] of auditByDoc) {
      await recordIngestionDecision(env.DB, {
        docId,
        action: 'manual',
        source: 'admin',
        actor: opts.actor ?? null,
        reason: 'amount_bounds_canonicalize',
        payload: { repair: 'amount_bounds_canonicalize', changes: audit.changes },
        transactionIds: audit.txIds,
        createdAt: nowIso,
      });
    }
  }

  return result;
}
