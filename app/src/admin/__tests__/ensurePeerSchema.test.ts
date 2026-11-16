/**
 * CT-2409: Coolify auto-deploy does not run POST /api/admin/migrate, so the
 * peer write path has to add price_unavailable_reason and received_at itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ensurePeerImportSchemaColumns, ensurePriceUnavailableReasonColumn } from '../ensurePeerSchema.ts';
import { openMigratedD1, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';

let db: SqliteDatabase;
let close: () => void;

afterEach(() => close?.());

function columnNames(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe('ensurePeerImportSchemaColumns', () => {
  it('no-ops when the request has no database', async () => {
    await expect(ensurePeerImportSchemaColumns(undefined)).resolves.toBeUndefined();
    await expect(ensurePriceUnavailableReasonColumn(undefined)).resolves.toBeUndefined();
  });

  it('adds the congress-share columns when the host database never migrated them', async () => {
    const opened = await openMigratedD1();
    db = opened.db;
    close = opened.close;
    db.exec('ALTER TABLE securities_ref DROP COLUMN price_unavailable_reason');
    db.exec('ALTER TABLE fundamentals_eod DROP COLUMN received_at');
    db.exec('ALTER TABLE analyst_consensus DROP COLUMN received_at');
    expect(columnNames('securities_ref')).not.toContain('price_unavailable_reason');
    expect(columnNames('fundamentals_eod')).not.toContain('received_at');

    await ensurePeerImportSchemaColumns(opened.d1);

    expect(columnNames('securities_ref')).toContain('price_unavailable_reason');
    expect(columnNames('fundamentals_eod')).toContain('received_at');
    expect(columnNames('analyst_consensus')).toContain('received_at');
    await ensurePeerImportSchemaColumns(opened.d1);
  });
});
