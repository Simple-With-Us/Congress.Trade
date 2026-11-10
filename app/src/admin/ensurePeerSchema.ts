/**
 * Apply the peer-price / congress-share columns that Coolify auto-deploy does
 * not add.  POST /api/admin/migrate is still the canonical list; this is the
 * same idempotent ALTER, run before the statements that throw when the column
 * is missing (CT-2409).  Duplicate-column errors are success.
 */

import type { Env } from '../shared/types.ts';
import { run } from '../shared/db.ts';
import {
  ENRICHMENT_UNAVAILABLE_SCHEMA_STATEMENTS,
  MARKET_IMPORT_PROVENANCE_SCHEMA_STATEMENTS,
  PRICE_UNAVAILABLE_REASON_SCHEMA_STATEMENTS,
} from './migrations.ts';

type AppDb = Env['DB'];

const appliedByDb = new WeakMap<AppDb, Set<string>>();

/** Price refresh only needs this column.  Import also needs provenance. */
export const PRICE_REFRESH_SCHEMA_STATEMENTS = PRICE_UNAVAILABLE_REASON_SCHEMA_STATEMENTS;

export const PEER_IMPORT_SCHEMA_STATEMENTS = [
  ...PRICE_UNAVAILABLE_REASON_SCHEMA_STATEMENTS,
  ...ENRICHMENT_UNAVAILABLE_SCHEMA_STATEMENTS,
  ...MARKET_IMPORT_PROVENANCE_SCHEMA_STATEMENTS,
] as const;

export function isDuplicateColumnError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /duplicate column name/i.test(message);
}

function isCacheableDb(db: AppDb | null | undefined): db is AppDb {
  return typeof db === 'object' && db !== null;
}

async function applySchemaStatements(db: AppDb | null | undefined, statements: readonly string[]): Promise<void> {
  // Auth tests hit /securities/import with no DB.  A missing database is not
  // a schema failure; the handler's own empty-body path still has to answer.
  if (!isCacheableDb(db)) return;
  let applied = appliedByDb.get(db);
  if (!applied) {
    applied = new Set();
    appliedByDb.set(db, applied);
  }
  for (const sql of statements) {
    if (applied.has(sql)) continue;
    try {
      await run(db, sql);
      applied.add(sql);
    } catch (err) {
      if (isDuplicateColumnError(err)) {
        applied.add(sql);
        continue;
      }
      console.warn('peer schema ensure failed:', (err as Error).message);
    }
  }
}

/** securities_ref.price_unavailable_reason (migration 0103). */
export async function ensurePriceUnavailableReasonColumn(db: AppDb | null | undefined): Promise<void> {
  await applySchemaStatements(db, PRICE_REFRESH_SCHEMA_STATEMENTS);
}

/**
 * Columns the securities import writes: price reason, enrichment negative-cache,
 * and fundamentals/analyst received_at (0101).
 */
export async function ensurePeerImportSchemaColumns(db: AppDb | null | undefined): Promise<void> {
  await applySchemaStatements(db, PEER_IMPORT_SCHEMA_STATEMENTS);
}
