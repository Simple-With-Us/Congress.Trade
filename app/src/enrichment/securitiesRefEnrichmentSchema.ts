/**
 * Thin helpers for stall SQL modules (schema probe lives in service.ts).
 */

import type { Env } from '../shared/types.ts';
import {
  enrichmentUnavailableExcludedSql,
  resetSecuritiesRefEnrichmentSchemaCacheForTests,
  securitiesRefHasEnrichmentUnavailableColumns,
} from './service.ts';

/** Pending-selector / stall SQL when 0104 columns are present (alias `sr`). */
export const ENRICHMENT_UNAVAILABLE_EXCLUDED_SR_SQL =
  '(sr.ticker IS NULL OR COALESCE(sr.enrichment_unavailable, 0) = 0)';

/** No-op filter when 0104 columns are not migrated yet. */
export const ENRICHMENT_UNAVAILABLE_EXCLUDED_LEGACY_SQL = '(1=1)';

/** True when enrichment_unavailable / enrichment_checked_at / reason columns exist. */
export async function hasEnrichment0104Columns(db: D1Database): Promise<boolean> {
  return securitiesRefHasEnrichmentUnavailableColumns(db as Env['DB']);
}

/** Reset probe cache (tests only). */
export function resetEnrichment0104ColumnsCache(): void {
  resetSecuritiesRefEnrichmentSchemaCacheForTests();
}

export async function enrichmentUnavailableExcludedSqlForDb(
  db: D1Database,
): Promise<string> {
  const columnsPresent = await securitiesRefHasEnrichmentUnavailableColumns(db as Env['DB']);
  return enrichmentUnavailableExcludedSql('sr', { columnsPresent });
}

export async function enrichmentUnavailableExcludedSqlForEnv(env: Env): Promise<string> {
  return enrichmentUnavailableExcludedSqlForDb(env.DB);
}
