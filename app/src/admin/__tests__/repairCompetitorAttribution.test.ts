/**
 * src/admin/__tests__/repairCompetitorAttribution.test.ts
 *
 * Runs repairCompetitorAttribution against a real, fully-migrated in-memory
 * SQLite DB (see prices/__tests__/sqliteD1.ts), same harness as
 * filerIdentityDedupe.test.ts — the repair SQL's correctness (which rows
 * move, which stay put, what gets created) is exactly what's under test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedD1, type D1Database, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import { repairCompetitorAttribution } from '../competitorAttributionRepair.ts';
import { competitorHouseFilerId } from '../../shared/competitorAttribution.ts';
import type { Env } from '../../shared/types.ts';

let db: SqliteDatabase;
let d1: D1Database;
let env: Env;

beforeEach(async () => {
  ({ db, d1 } = await openMigratedD1());
  env = { DB: d1 } as unknown as Env;
});

afterEach(() => {
  db.close();
});

function insertFiler(row: {
  id: string;
  fullName: string;
  chamber: string;
  state: string;
  district?: string | null;
  resolvedBioguideId?: string | null;
}) {
  db.prepare(
    `INSERT INTO filers (bioguide_id, chamber, full_name, state, district, resolved_bioguide_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.chamber, row.fullName, row.state, row.district ?? null, row.resolvedBioguideId ?? null);
}

let txSeq = 0;
function insertCompetitorTx(row: {
  filerId: string | null;
  rawText: string;
  assetName?: string | null;
  ticker?: string | null;
  assetType?: string | null;
}) {
  txSeq += 1;
  const id = `tx-${txSeq}`;
  db.prepare(
    `INSERT INTO transactions
       (id, doc_id, filer_id, tx_date, asset_name, ticker, asset_type, tx_type,
        raw_text, source, created_at)
     VALUES (?, ?, ?, '2026-01-15', ?, ?, ?, 'P', ?, 'competitor_backfill', '2026-01-15T00:00:00.000Z')`,
  ).run(
    id,
    `COMPETITOR-${id}`,
    row.filerId,
    row.assetName ?? 'Some Asset',
    row.ticker ?? 'TICK',
    row.assetType ?? 'stock',
    row.rawText,
  );
  return id;
}

function getTx(id: string) {
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as Record<string, unknown>;
}

describe('repairCompetitorAttribution', () => {
  it('reassigns a chamber+state mismatch (Rep. Mike Collins GA-10 stuck on Sen. Susan Collins ME)', async () => {
    insertFiler({ id: 'senate-susan-collins', fullName: 'Susan M. Collins', chamber: 'senate', state: 'ME' });
    const rawText = JSON.stringify({
      Representative: 'Hon. Michael A. Collins Jr',
      District: 'GA10',
      Ticker: 'ACME',
      Transaction: 'Purchase',
    });
    const txId = insertCompetitorTx({ filerId: 'senate-susan-collins', rawText, assetName: 'Acme Corp', ticker: 'ACME' });

    const result = await repairCompetitorAttribution(env, { dryRun: false });

    expect(result.scanned).toBe(1);
    expect(result.mismatched).toBe(1);
    expect(result.reassigned).toBe(1);
    expect(result.created).toBe(1);
    expect(result.unparseable).toBe(0);
    expect(result.dryRun).toBe(false);

    const expectedFilerId = competitorHouseFilerId('Hon. Michael A. Collins Jr', 'GA', '10');
    expect(expectedFilerId).toBeTruthy();

    const tx = getTx(txId);
    expect(tx.filer_id).toBe(expectedFilerId);

    const newFiler = db.prepare('SELECT * FROM filers WHERE bioguide_id = ?').get(expectedFilerId) as
      | Record<string, unknown>
      | undefined;
    expect(newFiler).toBeTruthy();
    expect(newFiler?.chamber).toBe('house');
    expect(newFiler?.state).toBe('GA');
    expect(newFiler?.district).toBe('10');

    expect(result.details).toHaveLength(1);
    expect(result.details[0]).toMatchObject({
      fromFilerId: 'senate-susan-collins',
      toFilerId: expectedFilerId,
      count: 1,
    });

    // The mis-attributed Senate filer never sees this transaction again.
    const staleCount = db
      .prepare("SELECT COUNT(*) AS n FROM transactions WHERE filer_id = 'senate-susan-collins'")
      .get() as { n: number };
    expect(staleCount.n).toBe(0);
  });

  it('is a no-op when the raw reporter matches the assigned filer (same chamber + state)', async () => {
    insertFiler({ id: 'house-ga10-michael-collins', fullName: 'Michael Collins', chamber: 'house', state: 'GA', district: '10' });
    const rawText = JSON.stringify({ Representative: 'Michael Collins', District: 'GA10', Ticker: 'ACME' });
    const txId = insertCompetitorTx({ filerId: 'house-ga10-michael-collins', rawText });

    const result = await repairCompetitorAttribution(env, { dryRun: false });

    expect(result.scanned).toBe(1);
    expect(result.mismatched).toBe(0);
    expect(result.reassigned).toBe(0);
    expect(result.created).toBe(0);
    expect(result.details).toHaveLength(0);

    const tx = getTx(txId);
    expect(tx.filer_id).toBe('house-ga10-michael-collins');

    const filerCount = db.prepare('SELECT COUNT(*) AS n FROM filers').get() as { n: number };
    expect(filerCount.n).toBe(1);
  });

  it('reclassifies a crypto disclosure mis-stored as asset_type=stock', async () => {
    insertFiler({ id: 'house-ga10-michael-collins', fullName: 'Michael Collins', chamber: 'house', state: 'GA', district: '10' });
    const rawText = JSON.stringify({
      Representative: 'Michael Collins',
      District: 'GA10',
      Ticker: 'SUI',
      notes: 'Sui Network purchase [CT]',
    });
    const txId = insertCompetitorTx({
      filerId: 'house-ga10-michael-collins',
      rawText,
      assetName: 'Sun Communities',
      ticker: 'SUI',
      assetType: 'stock',
    });

    const result = await repairCompetitorAttribution(env, { dryRun: false });

    expect(result.cryptoReclassified).toBe(1);
    // Same-chamber/state reporter — no attribution mismatch alongside the crypto fix.
    expect(result.mismatched).toBe(0);

    const tx = getTx(txId);
    expect(tx.asset_type).toBe('CT');
    expect(tx.asset_type_name).toBe('Cryptocurrency');
  });

  it('does not reclassify a row that already carries no crypto marker', async () => {
    insertFiler({ id: 'house-ga10-michael-collins', fullName: 'Michael Collins', chamber: 'house', state: 'GA', district: '10' });
    const rawText = JSON.stringify({ Representative: 'Michael Collins', District: 'GA10', notes: 'Ordinary equity buy' });
    const txId = insertCompetitorTx({ filerId: 'house-ga10-michael-collins', rawText, assetName: 'Acme Corp', ticker: 'ACME' });

    const result = await repairCompetitorAttribution(env, { dryRun: false });

    expect(result.cryptoReclassified).toBe(0);
    const tx = getTx(txId);
    expect(tx.asset_type).toBe('stock');
  });

  it('counts unparseable rows (raw_text with no derivable reporter name)', async () => {
    insertFiler({ id: 'senate-susan-collins', fullName: 'Susan M. Collins', chamber: 'senate', state: 'ME' });
    insertCompetitorTx({ filerId: 'senate-susan-collins', rawText: JSON.stringify({ Ticker: 'ACME', Transaction: 'Purchase' }) });

    const result = await repairCompetitorAttribution(env, { dryRun: false });

    expect(result.unparseable).toBe(1);
    expect(result.mismatched).toBe(0);
    expect(result.reassigned).toBe(0);
  });

  it('dryRun reports the same counts but writes nothing', async () => {
    insertFiler({ id: 'senate-susan-collins', fullName: 'Susan M. Collins', chamber: 'senate', state: 'ME' });
    const rawText = JSON.stringify({
      Representative: 'Hon. Michael A. Collins Jr',
      District: 'GA10',
      Ticker: 'SUI',
      notes: 'Sui purchase [CT]',
    });
    const txId = insertCompetitorTx({
      filerId: 'senate-susan-collins',
      rawText,
      assetName: 'Sun Communities',
      ticker: 'SUI',
      assetType: 'stock',
    });

    const result = await repairCompetitorAttribution(env, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.mismatched).toBe(1);
    expect(result.reassigned).toBe(1);
    expect(result.created).toBe(1);
    expect(result.cryptoReclassified).toBe(1);

    // Nothing actually written: transaction untouched, no new filer row.
    const tx = getTx(txId);
    expect(tx.filer_id).toBe('senate-susan-collins');
    expect(tx.asset_type).toBe('stock');

    const filerCount = db.prepare('SELECT COUNT(*) AS n FROM filers').get() as { n: number };
    expect(filerCount.n).toBe(1);

    // Re-running for real still finds (and fixes) the same row — dryRun never
    // consumed the fix.
    const second = await repairCompetitorAttribution(env, { dryRun: false });
    expect(second.reassigned).toBe(1);
    expect(second.cryptoReclassified).toBe(1);
  });

  it('is idempotent — a second run finds nothing left to fix', async () => {
    insertFiler({ id: 'senate-susan-collins', fullName: 'Susan M. Collins', chamber: 'senate', state: 'ME' });
    const rawText = JSON.stringify({
      Representative: 'Hon. Michael A. Collins Jr',
      District: 'GA10',
      Ticker: 'SUI',
      notes: 'Sui purchase [CT]',
    });
    insertCompetitorTx({
      filerId: 'senate-susan-collins',
      rawText,
      assetName: 'Sun Communities',
      ticker: 'SUI',
      assetType: 'stock',
    });

    await repairCompetitorAttribution(env, { dryRun: false });
    const second = await repairCompetitorAttribution(env, { dryRun: false });

    expect(second.mismatched).toBe(0);
    expect(second.reassigned).toBe(0);
    expect(second.created).toBe(0);
    expect(second.cryptoReclassified).toBe(0);
  });
});

// Board rows 2c0b428c / 591011b9.  Payload shapes are copied from the live
// /api/transactions rawText of 2026-09-18 (Unusual Whales injects).
describe('repairCompetitorAttribution: last-name-minted MANUAL-* phantoms', () => {
  const april = (reporter: string) =>
    JSON.stringify({ name: 'April Delaney', reporter, member_type: 'house', politician_id: '36b29b09' });
  const john = JSON.stringify({ name: 'John Delaney', reporter: 'John Delaney', member_type: 'house', politician_id: 'f3bbf954' });

  function seedDelaney() {
    insertFiler({ id: 'house-md06-april-mcclain-delaney', fullName: 'April McClain Delaney', chamber: 'house', state: 'MD', district: '6', resolvedBioguideId: 'M001232' });
    insertFiler({ id: 'MANUAL-DELANEY', fullName: 'John Delaney', chamber: 'house', state: 'NY', district: '7' });
  }

  it('re-keys only the rows whose reporter is April McClain Delaney; the "John Delaney" rows and non-JSON rows stay (MANUAL-DELANEY fused two people)', async () => {
    seedDelaney();
    const a1 = insertCompetitorTx({ filerId: 'MANUAL-DELANEY', rawText: april('Hon. April McClain Delaney'), ticker: 'HUBB' });
    const a2 = insertCompetitorTx({ filerId: 'MANUAL-DELANEY', rawText: april('April McClain'), ticker: 'TECH' });
    const a3 = insertCompetitorTx({ filerId: 'MANUAL-DELANEY', rawText: april('April Delaney'), ticker: 'CDAY' });
    const j1 = insertCompetitorTx({ filerId: 'MANUAL-DELANEY', rawText: john, ticker: 'MKL' });
    const fmp = insertCompetitorTx({ filerId: 'MANUAL-DELANEY', rawText: 'not json', ticker: 'MIDD' });

    const result = await repairCompetitorAttribution(env, { dryRun: false });

    expect(result.rekeyed).toBe(3);
    expect(result.unmatchedMinted).toBe(2);
    expect(result.tombstoned).toBe(0);
    for (const id of [a1, a2, a3]) expect(getTx(id).filer_id).toBe('house-md06-april-mcclain-delaney');
    expect(getTx(j1).filer_id).toBe('MANUAL-DELANEY');
    expect(getTx(fmp).filer_id).toBe('MANUAL-DELANEY');
    const cluster = result.details.find((d) => d.fromFilerId === 'MANUAL-DELANEY');
    expect(cluster?.toFilerId).toBe('house-md06-april-mcclain-delaney');
    expect(cluster?.count).toBe(3);
    // The phantom still holds rows, so it is NOT tombstoned.
    const phantom = db.prepare("SELECT merged_into FROM filers WHERE bioguide_id = 'MANUAL-DELANEY'").get() as { merged_into: string | null };
    expect(phantom.merged_into).toBeNull();
  });

  it('tombstones (never deletes) a phantom the re-key emptied, MANUAL-ELVIRA -> house-fl27-maria-elvira-salazar', async () => {
    insertFiler({ id: 'house-fl27-maria-elvira-salazar', fullName: 'Maria Elvira Salazar', chamber: 'house', state: 'FL', district: '27' });
    insertFiler({ id: 'MANUAL-ELVIRA', fullName: 'Maria Elvira Salazar', chamber: 'senate', state: 'FL', district: '27' });
    const payloads = [
      { name: 'Maria Elvira', reporter: 'Hon. Maria Elvira Salazar', member_type: 'house' },
      { name: 'Maria Elvira', reporter: 'Maria Elvira', member_type: 'house' },
      { name: 'Maria Elvira', reporter: 'Maria Salazar', member_type: 'house' },
    ];
    const ids = payloads.map((p) => insertCompetitorTx({ filerId: 'MANUAL-ELVIRA', rawText: JSON.stringify(p) }));

    const result = await repairCompetitorAttribution(env, { dryRun: false });

    expect(result.rekeyed).toBe(3);
    expect(result.tombstoned).toBe(1);
    for (const id of ids) expect(getTx(id).filer_id).toBe('house-fl27-maria-elvira-salazar');
    const phantom = db.prepare("SELECT bioguide_id, merged_into FROM filers WHERE bioguide_id = 'MANUAL-ELVIRA'").get() as { bioguide_id: string; merged_into: string | null };
    expect(phantom.merged_into).toBe('house-fl27-maria-elvira-salazar');
    const audit = db.prepare("SELECT canonical_filer_id, reason FROM filer_identity_merges WHERE alias_filer_id = 'MANUAL-ELVIRA'").get() as { canonical_filer_id: string; reason: string };
    expect(audit).toEqual({ canonical_filer_id: 'house-fl27-maria-elvira-salazar', reason: 'competitor-last-name-rekey' });

    const second = await repairCompetitorAttribution(env, { dryRun: false });
    expect(second.rekeyed).toBe(0);
    expect(second.tombstoned).toBe(0);
  });

  it('dryRun reports the same counts and writes nothing', async () => {
    insertFiler({ id: 'house-fl27-maria-elvira-salazar', fullName: 'Maria Elvira Salazar', chamber: 'house', state: 'FL', district: '27' });
    insertFiler({ id: 'MANUAL-ELVIRA', fullName: 'Maria Elvira Salazar', chamber: 'senate', state: 'FL', district: '27' });
    const id = insertCompetitorTx({
      filerId: 'MANUAL-ELVIRA',
      rawText: JSON.stringify({ name: 'Maria Elvira', reporter: 'Hon. Maria Elvira Salazar', member_type: 'house' }),
    });

    const result = await repairCompetitorAttribution(env, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.rekeyed).toBe(1);
    expect(result.tombstoned).toBe(1);
    expect(getTx(id).filer_id).toBe('MANUAL-ELVIRA');
    const phantom = db.prepare("SELECT merged_into FROM filers WHERE bioguide_id = 'MANUAL-ELVIRA'").get() as { merged_into: string | null };
    expect(phantom.merged_into).toBeNull();
  });

  it('re-keys a MANUAL-* executive onto its EXEC-* twin (MANUAL-BURGUM -> EXEC-DOUGLAS-J-BURGUM)', async () => {
    insertFiler({ id: 'EXEC-DOUGLAS-J-BURGUM', fullName: 'Douglas J Burgum', chamber: 'executive', state: '' });
    insertFiler({ id: 'MANUAL-BURGUM', fullName: 'Douglas J Burgum', chamber: 'senate', state: '' });
    const id = insertCompetitorTx({
      filerId: 'MANUAL-BURGUM',
      rawText: JSON.stringify({ name: 'Douglas J Burgum', reporter: 'Douglas J Burgum', member_type: 'executive' }),
    });

    const result = await repairCompetitorAttribution(env, { dryRun: false });

    expect(result.rekeyed).toBe(1);
    expect(getTx(id).filer_id).toBe('EXEC-DOUGLAS-J-BURGUM');
    // Chamber conflict is a hard miss: a house-chamber payload never lands on the EXEC row.
    const id2 = insertCompetitorTx({
      filerId: 'MANUAL-BURGUM',
      rawText: JSON.stringify({ name: 'Douglas Burgum', member_type: 'house' }),
    });
    await repairCompetitorAttribution(env, { dryRun: false });
    expect(getTx(id2).filer_id).not.toBe('EXEC-DOUGLAS-J-BURGUM');
  });

  it('does not count a row as unmatched when the attribution-mismatch step later reassigns it in the same run', async () => {
    insertFiler({ id: 'MANUAL-SMITH', fullName: 'Jane Smith', chamber: 'senate', state: 'ME' });
    const id = insertCompetitorTx({
      filerId: 'MANUAL-SMITH',
      rawText: JSON.stringify({ name: 'Jane Smith', member_type: 'house', District: 'GA10' }),
    });

    const result = await repairCompetitorAttribution(env, { dryRun: false });

    expect(result.rekeyed).toBe(0);
    expect(result.reassigned).toBe(1);
    expect(result.unmatchedMinted).toBe(0);
    expect(getTx(id).filer_id).not.toBe('MANUAL-SMITH');
  });

  it('leaves a row alone when two live filers match (ambiguous)', async () => {
    insertFiler({ id: 'house-md06-april-mcclain-delaney', fullName: 'April McClain Delaney', chamber: 'house', state: 'MD' });
    insertFiler({ id: 'house-md06-april-delaney', fullName: 'April Delaney', chamber: 'house', state: 'MD' });
    insertFiler({ id: 'MANUAL-DELANEY', fullName: 'April Delaney', chamber: 'house', state: 'MD' });
    const id = insertCompetitorTx({ filerId: 'MANUAL-DELANEY', rawText: april('April McClain') });

    const result = await repairCompetitorAttribution(env, { dryRun: false });

    expect(result.rekeyed).toBe(0);
    expect(result.unmatchedMinted).toBe(1);
    expect(getTx(id).filer_id).toBe('MANUAL-DELANEY');
  });
});
