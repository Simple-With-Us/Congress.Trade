/**
 * src/admin/ogeRowIndexCleanup.ts
 *
 * POST /api/admin/clean-oge-row-numbers — one-off (and safely repeatable)
 * cleanup of executive (OGE 278-T, doc_id 'E-%') rows already stored with the
 * table's "#" column glued onto the asset name: "3641 Microsoft Corp. Com" ->
 * "Microsoft Corp. Com" (board row 3d31c7b9).  Forward-looking extraction is
 * fixed in extraction/normalizer.ts (recomputeTransactions) and ogeText.ts.
 *
 * Per filing (never per row) it applies extraction/ogeRowIndex.ts's verdict —
 * the leading number is only stripped when the filing's own rows show the "#"
 * column — then re-runs ticker resolution over the cleaned name for rows that
 * have no ticker, and recomputes row_key (which fingerprints asset name and
 * ticker) exactly like runTickerBackfill does.  raw_text is never touched, so
 * the original OCR is preserved.  UPDATE OR IGNORE: a cleaned row that would
 * collide with an existing (doc_id, source, row_key) is left as is and counted.
 *
 * `dryRun` (the route's default) reports every planned change and writes nothing.
 */

import type { Env, TxSource, TxType } from '../shared/types.ts';
import { all, run } from '../shared/db.ts';
import { loadResolver, transactionRowKey } from '../extraction/normalizer.ts';
import { ogeRowIndexVerdict, stripLeadingRowIndex } from '../extraction/ogeRowIndex.ts';

interface StoredRow {
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

export interface OgeRowIndexCleanupResult {
  dryRun: boolean;
  docsScanned: number;
  docsStripped: number;
  rowsChanged: number;
  tickersResolved: number;
  /** Rows whose cleaned row_key collided with an existing row and were left untouched. */
  collisionsSkipped: number;
  sample: Array<{ id: string; docId: string; before: string; after: string; ticker: string | null }>;
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

export async function cleanOgeRowIndexes(
  env: Env,
  opts: { dryRun?: boolean; docLimit?: number } = {},
): Promise<OgeRowIndexCleanupResult> {
  const dryRun = opts.dryRun !== false;
  const docLimit = Math.max(1, Math.min(opts.docLimit ?? 200, 2000));
  const docs = await all<{ doc_id: string }>(
    env.DB,
    `SELECT DISTINCT t.doc_id AS doc_id
       FROM transactions t
      WHERE t.doc_id LIKE 'E-%'
        AND t.deprecated_at IS NULL
        AND t.asset_name GLOB '[0-9]*'
        AND EXISTS (SELECT 1 FROM filings f WHERE f.doc_id = t.doc_id AND f.chamber = 'executive')
      ORDER BY t.doc_id
      LIMIT ?`,
    [docLimit],
  );
  const resolver = await loadResolver(env);
  const result: OgeRowIndexCleanupResult = {
    dryRun,
    docsScanned: docs.length,
    docsStripped: 0,
    rowsChanged: 0,
    tickersResolved: 0,
    collisionsSkipped: 0,
    sample: [],
  };

  for (const { doc_id: docId } of docs) {
    const rows = await all<StoredRow>(
      env.DB,
      `SELECT id, doc_id, ticker, asset_name, tx_date, owner, asset_type, asset_type_name, tx_type,
              amount_min, amount_max, is_option, cap_gains_over_200, raw_text, filing_status,
              subholding, location, description, supplemental_text, source, row_key
         FROM transactions
        WHERE doc_id = ? AND deprecated_at IS NULL
        ORDER BY id`,
      [docId],
    );
    const verdict = ogeRowIndexVerdict(rows.map((r) => r.asset_name));
    if (!verdict.strip) continue;
    result.docsStripped += 1;

    for (const row of rows) {
      const before = row.asset_name ?? '';
      const after = stripLeadingRowIndex(before);
      if (!after || after === before.trim()) continue;
      const hadTicker = !!(row.ticker && row.ticker.trim());
      const ticker = hadTicker ? row.ticker!.trim().toUpperCase() : resolver(null, after);
      const rowIndex = rowIndexOf(row.row_key);
      const rowKey =
        rowIndex === null
          ? row.row_key
          : transactionRowKey(row.source, rowIndex, {
              txDate: row.tx_date,
              owner: owner(row.owner),
              assetName: after,
              ticker,
              assetType: row.asset_type,
              assetTypeName: row.asset_type_name,
              txType: side(row.tx_type),
              amountMin: row.amount_min,
              amountMax: row.amount_max,
              isOption: row.is_option === 1,
              capGainsOver200: row.cap_gains_over_200 === 1,
              rawText: row.raw_text ?? '',
              filingStatus: row.filing_status,
              subholding: row.subholding,
              location: row.location,
              description: row.description,
              supplementalText: row.supplemental_text,
            });
      if (!hadTicker && ticker) result.tickersResolved += 1;
      if (result.sample.length < 25) result.sample.push({ id: row.id, docId, before, after, ticker: ticker ?? null });
      if (dryRun) {
        result.rowsChanged += 1;
        continue;
      }
      const res = await run(
        env.DB,
        'UPDATE OR IGNORE transactions SET asset_name = ?, ticker = ?, row_key = ? WHERE id = ?',
        [after, ticker ?? null, rowKey, row.id],
      );
      if ((res.meta?.changes ?? 0) > 0) result.rowsChanged += 1;
      else result.collisionsSkipped += 1;
    }
  }
  return result;
}
