/**
 * Detect migration 0104 enrichment columns on securities_ref (cached per isolate).
 */

import type { Env } from '../shared/types.ts';
import { get } from '../shared/db.ts';

let enrichment0104ColumnsReady: boolean | null = null;

/** True when enrichment_unavailable / enrichment_checked_at / reason columns exist. */
export async function hasEnrichment0104Columns(db: D1Database): Promise<boolean> {
  if (enrichment0104ColumnsReady !== null) return enrichment0104ColumnsReady;
  try {
    const row = await get<{ ok: number }>(
      db,
      `SELECT 1 AS ok FROM pragma_table_info('securities_ref')
        WHERE name = 'enrichment_unavailable' LIMIT 1`,
    );
    enrichment0104ColumnsReady = row?.ok === 1;
  } catch {
    enrichment0104ColumnsReady = false;
  }
  return enrichment0104ColumnsReady;
}

/** Reset probe cache (tests only). */
export function resetEnrichment0104ColumnsCache(): void {
  enrichment0104ColumnsReady = null;
}

/** Pending-selector / stall SQL when 0104 columns are present (alias `sr`). */
export const ENRICHMENT_UNAVAILABLE_EXCLUDED_SR_SQL =
  '(sr.ticker IS NULL OR COALESCE(sr.enrichment_unavailable, 0) = 0)';

/** No-op filter when 0104 columns are not migrated yet. */
export const ENRICHMENT_UNAVAILABLE_EXCLUDED_LEGACY_SQL = '(1=1)';

export async function enrichmentUnavailableExcludedSqlForDb(
  db: D1Database,
): Promise<string> {
  return (await hasEnrichment0104Columns(db))
    ? ENRICHMENT_UNAVAILABLE_EXCLUDED_SR_SQL
    : ENRICHMENT_UNAVAILABLE_EXCLUDED_LEGACY_SQL;
}

export async function enrichmentUnavailableExcludedSqlForEnv(env: Env): Promise<string> {
  return enrichmentUnavailableExcludedSqlForDb(env.DB);
}
