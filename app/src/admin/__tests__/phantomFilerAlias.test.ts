/**
 * CT-1362 / CT-1360: MANUAL-* twins and last-name phantoms alias onto the
 * roster or EXEC id. Trades move. The source filer row stays, tombstoned.
 * Chamber and party are not rewritten.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedD1, type D1Database, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import { dedupeSplitFilerIdentities } from '../filerIdentityDedupe.ts';
import { phantomFilerAliasStatements } from '../../shared/phantomFilerAliases.ts';
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

interface Pair {
  alias: string;
  aliasName: string;
  canonical: string;
  canonicalName: string;
  canonicalChamber: string;
  canonicalState: string;
  canonicalParty: string | null;
  canonicalDistrict?: string | null;
  aliasChamber: string;
  aliasState: string;
  aliasParty: string | null;
  aliasDistrict?: string | null;
}

const PAIRS: Pair[] = [
  pair('MANUAL-WRIGHT', 'Christopher A Wright', 'EXEC-CWRIGHT', 'Chris Wright', 'executive'),
  pair('MANUAL-BURGUM', 'Douglas J Burgum', 'EXEC-DOUGLAS-J-BURGUM', 'Douglas J Burgum', 'executive'),
  pair('MANUAL-KRATSIOS', 'Michael J. Kratsios', 'EXEC-MICHAEL-J-KRATSIOS', 'Michael J. Kratsios', 'executive'),
  pair('MANUAL-BISIGNANO', 'Frank J. Bisignano', 'EXEC-FRANK-J-BISIGNANO', 'Frank J. Bisignano', 'executive'),
  pair('MANUAL-BAILEY', 'Sara Bailey', 'EXEC-SARA-BAILEY', 'Sara Bailey', 'executive'),
  pair('MANUAL-KUPOR', 'Scott A. Kupor', 'EXEC-SCOTT-A-KUPOR', 'Scott A. Kupor', 'executive'),
  pair('MANUAL-KEAN', 'Thomas H. Kean Jr.', 'house-nj07-thomas-h-kean', 'Thomas H. Kean Jr.', 'house', 'NJ', '7'),
  pair('MANUAL-STAUBER', 'Peter Allen Stauber', 'house-mn08-peter-allen-stauber', 'Peter Allen Stauber', 'house', 'MN', '8'),
  pair('MANUAL-ELVIRA', 'Maria Elvira', 'house-fl27-maria-elvira-salazar', 'Maria Elvira Salazar', 'house', 'FL', '27'),
  pair('MANUAL-DELANEY', 'John Delaney', 'house-md06-april-mcclain-delaney', 'April McClain Delaney', 'house', 'MD', '6', 'NY', '7', 'house'),
];

function pair(
  alias: string,
  aliasName: string,
  canonical: string,
  canonicalName: string,
  canonicalChamber: string,
  canonicalState = '',
  canonicalDistrict: string | null = null,
  aliasState = '',
  aliasDistrict: string | null = null,
  aliasChamber = 'senate',
): Pair {
  return {
    alias,
    aliasName,
    canonical,
    canonicalName,
    canonicalChamber,
    canonicalState,
    canonicalParty: canonicalChamber === 'executive' ? null : 'Democrat',
    canonicalDistrict,
    aliasChamber,
    aliasState,
    aliasParty: 'Republican',
    aliasDistrict,
  };
}

function insertFiler(row: {
  id: string;
  fullName: string;
  chamber: string;
  state: string;
  party?: string | null;
  district?: string | null;
}) {
  db.prepare(
    `INSERT INTO filers (bioguide_id, chamber, full_name, party, state, district)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.chamber, row.fullName, row.party ?? null, row.state, row.district ?? null);
}

let txSeq = 0;
function insertTx(filerId: string) {
  txSeq += 1;
  db.prepare(
    `INSERT INTO transactions (id, doc_id, filer_id, tx_date, source)
     VALUES (?, ?, ?, '2026-01-01', 'competitor_backfill')`,
  ).run(`tx-${txSeq}`, `COMPETITOR-${filerId}-${txSeq}`, filerId);
}

function seedPair(p: Pair, aliasTxs: number, canonicalTxs: number) {
  insertFiler({
    id: p.canonical,
    fullName: p.canonicalName,
    chamber: p.canonicalChamber,
    state: p.canonicalState,
    party: p.canonicalParty,
    district: p.canonicalDistrict,
  });
  insertFiler({
    id: p.alias,
    fullName: p.aliasName,
    chamber: p.aliasChamber,
    state: p.aliasState,
    party: p.aliasParty,
    district: p.aliasDistrict,
  });
  for (let i = 0; i < canonicalTxs; i++) insertTx(p.canonical);
  for (let i = 0; i < aliasTxs; i++) insertTx(p.alias);
}

describe('phantom filer alias (CT-1362 / CT-1360)', () => {
  it('re-points every named phantom onto its canonical id and stops double counting', async () => {
    for (const p of PAIRS) seedPair(p, 3, 2);
    db.prepare(
      `INSERT INTO filings (doc_id, chamber, filer_id, filing_type, ingest_status) VALUES ('doc-wright', 'executive', 'MANUAL-WRIGHT', 'P', 'persisted')`,
    ).run();

    const result = await dedupeSplitFilerIdentities(env);

    for (const p of PAIRS) {
      const detail = result.details.find((d) => d.aliasIds.includes(p.alias));
      expect(detail?.canonicalId, p.alias).toBe(p.canonical);
      const phantom = db.prepare(
        'SELECT bioguide_id, chamber, party, state, district, merged_into FROM filers WHERE bioguide_id = ?',
      ).get(p.alias) as {
        bioguide_id: string;
        chamber: string;
        party: string | null;
        state: string | null;
        district: string | null;
        merged_into: string | null;
      };
      expect(phantom.bioguide_id, p.alias).toBe(p.alias);
      expect(phantom.merged_into, p.alias).toBe(p.canonical);
      expect(phantom.chamber, p.alias).toBe(p.aliasChamber);
      expect(phantom.party, p.alias).toBe(p.aliasParty);
      expect(phantom.state ?? '', p.alias).toBe(p.aliasState);
      expect(phantom.district, p.alias).toBe(p.aliasDistrict ?? null);

      const canonical = db.prepare(
        'SELECT chamber, party, state, district FROM filers WHERE bioguide_id = ?',
      ).get(p.canonical) as { chamber: string; party: string | null; state: string | null; district: string | null };
      expect(canonical.chamber, p.canonical).toBe(p.canonicalChamber);
      expect(canonical.party, p.canonical).toBe(p.canonicalParty);
      expect(canonical.state ?? '', p.canonical).toBe(p.canonicalState);
      expect(canonical.district, p.canonical).toBe(p.canonicalDistrict ?? null);

      const owners = db.prepare(
        'SELECT DISTINCT filer_id FROM transactions WHERE deprecated_at IS NULL AND filer_id IN (?, ?)',
      ).all(p.canonical, p.alias) as Array<{ filer_id: string }>;
      expect(owners, p.alias).toEqual([{ filer_id: p.canonical }]);
    }

    const filing = db.prepare("SELECT filer_id FROM filings WHERE doc_id = 'doc-wright'").get() as { filer_id: string };
    expect(filing.filer_id).toBe('EXEC-CWRIGHT');

    const distinct = db.prepare(
      'SELECT COUNT(DISTINCT filer_id) AS n FROM transactions WHERE deprecated_at IS NULL',
    ).get() as { n: number };
    expect(distinct.n).toBe(PAIRS.length);

    const roster = db.prepare(
      `SELECT COALESCE(f.merged_into, t.filer_id) AS filer_id, COUNT(*) AS n
         FROM transactions t
         LEFT JOIN filers f ON f.bioguide_id = t.filer_id
        WHERE t.deprecated_at IS NULL
        GROUP BY COALESCE(f.merged_into, t.filer_id)`,
    ).all() as Array<{ filer_id: string; n: number }>;
    expect(roster).toHaveLength(PAIRS.length);
    expect(roster.every((row) => row.n === 5)).toBe(true);

    const again = await dedupeSplitFilerIdentities(env);
    expect(again.transactionsMoved).toBe(0);
    expect(again.aliasesTombstoned).toBe(0);
  });

  it('does not alias a bare surname, and does not send a different John Delaney id to April', async () => {
    insertFiler({ id: 'house-mn08-peter-allen-stauber', fullName: 'Peter Allen Stauber', chamber: 'house', state: 'MN', party: 'Republican', district: '8' });
    insertFiler({ id: 'MANUAL-ONLYLAST', fullName: 'Stauber', chamber: 'senate', state: '', party: null });
    insertFiler({ id: 'house-md06-april-mcclain-delaney', fullName: 'April McClain Delaney', chamber: 'house', state: 'MD', party: 'Democrat', district: '6' });
    insertFiler({ id: 'MANUAL-JOHN', fullName: 'John Delaney', chamber: 'house', state: 'NY', party: 'Democrat', district: '7' });
    insertTx('MANUAL-ONLYLAST');
    insertTx('MANUAL-JOHN');

    const result = await dedupeSplitFilerIdentities(env);

    expect(result.details.find((d) => d.aliasIds.includes('MANUAL-ONLYLAST'))).toBeUndefined();
    expect(result.details.find((d) => d.aliasIds.includes('MANUAL-JOHN'))).toBeUndefined();
    const left = db.prepare(
      "SELECT bioguide_id, merged_into FROM filers WHERE bioguide_id IN ('MANUAL-ONLYLAST', 'MANUAL-JOHN') ORDER BY bioguide_id",
    ).all() as Array<{ bioguide_id: string; merged_into: string | null }>;
    expect(left).toEqual([
      { bioguide_id: 'MANUAL-JOHN', merged_into: null },
      { bioguide_id: 'MANUAL-ONLYLAST', merged_into: null },
    ]);
  });

  it('name-matches a non-pinned MANUAL id onto the one full-name filer', async () => {
    insertFiler({ id: 'house-mn08-peter-allen-stauber', fullName: 'Peter Allen Stauber', chamber: 'house', state: 'MN', party: 'Republican', district: '8' });
    insertFiler({ id: 'MANUAL-PETE-STAUBER', fullName: 'Pete Stauber', chamber: 'senate', state: '', party: null });
    insertTx('MANUAL-PETE-STAUBER');

    const result = await dedupeSplitFilerIdentities(env);

    expect(result.details.find((d) => d.aliasIds.includes('MANUAL-PETE-STAUBER'))?.canonicalId).toBe('house-mn08-peter-allen-stauber');
    const phantom = db.prepare("SELECT chamber, merged_into FROM filers WHERE bioguide_id = 'MANUAL-PETE-STAUBER'").get() as {
      chamber: string;
      merged_into: string | null;
    };
    expect(phantom).toEqual({ chamber: 'senate', merged_into: 'house-mn08-peter-allen-stauber' });
  });

  it('dryRun reports the alias and writes nothing', async () => {
    seedPair(PAIRS[0], 1, 0);
    const result = await dedupeSplitFilerIdentities(env, { dryRun: true });
    expect(result.details.find((d) => d.aliasIds.includes('MANUAL-WRIGHT'))?.canonicalId).toBe('EXEC-CWRIGHT');
    const phantom = db.prepare("SELECT merged_into FROM filers WHERE bioguide_id = 'MANUAL-WRIGHT'").get() as { merged_into: string | null };
    expect(phantom.merged_into).toBeNull();
    expect(db.prepare("SELECT filer_id FROM transactions").all()).toEqual([{ filer_id: 'MANUAL-WRIGHT' }]);
  });

  it('the migrate statements are idempotent and match migration 0110', () => {
    const file = readFileSync(new URL('../../../migrations/0110_phantom_filer_aliases.sql', import.meta.url), 'utf8');
    const fromFile = file
      .replace(/--[^\n]*/g, '')
      .split(';')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const fromCode = phantomFilerAliasStatements().map((s) => s.replace(/\s+/g, ' ').trim());
    expect(fromFile).toEqual(fromCode);

    seedPair(PAIRS[8], 2, 1);
    db.exec(file);
    expect(db.prepare("SELECT DISTINCT filer_id FROM transactions WHERE deprecated_at IS NULL").all()).toEqual([
      { filer_id: 'house-fl27-maria-elvira-salazar' },
    ]);
    const phantom = db.prepare("SELECT bioguide_id, merged_into, chamber FROM filers WHERE bioguide_id = 'MANUAL-ELVIRA'").get() as {
      bioguide_id: string;
      merged_into: string | null;
      chamber: string;
    };
    expect(phantom).toEqual({
      bioguide_id: 'MANUAL-ELVIRA',
      merged_into: 'house-fl27-maria-elvira-salazar',
      chamber: 'senate',
    });
    db.exec(file);
    expect(db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE filer_id = 'MANUAL-ELVIRA' AND deprecated_at IS NULL").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM filers WHERE bioguide_id = 'MANUAL-ELVIRA'").get()).toEqual({ n: 1 });
  });
});
