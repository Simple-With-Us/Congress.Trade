/**
 * Synthetic competitor inject rows (`doc_id LIKE 'COMPETITOR-%'`, source
 * `competitor_backfill`).  These must not drive ST peer stall detectors or
 * negative-cache real tickers that only appear on fixture disclosures.
 */

import type { Env } from './types.ts';
import { get } from './db.ts';

/** SQL: transaction row is not from inject_competitor_data synthetic docs. */
export function excludeCompetitorFixtureTransactionSql(txAlias = 't'): string {
  return `(${txAlias}.doc_id IS NULL OR ${txAlias}.doc_id NOT LIKE 'COMPETITOR-%')`;
}

/**
 * True when the ticker has at least one non-deprecated trade row that is not a
 * COMPETITOR-* synthetic doc (real PTR / disclosure corpus).
 */
export async function tickerHasNonCompetitorFixtureTrade(env: Env, ticker: string): Promise<boolean> {
  const sym = ticker.trim();
  if (!sym) return false;
  const row = await get<{ n: number }>(
    env.DB,
    `SELECT COUNT(*) AS n FROM transactions
      WHERE ticker = ?
        AND deprecated_at IS NULL
        AND ${excludeCompetitorFixtureTransactionSql('transactions')}`,
    [sym],
  );
  return Number(row?.n ?? 0) > 0;
}
