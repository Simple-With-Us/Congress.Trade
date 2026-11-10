/**
 * src/admin/__tests__/filerIdentityDedupe.test.ts
 *
 * Runs dedupeSplitFilerIdentities against a real, fully-migrated in-memory
 * SQLite DB (see prices/__tests__/sqliteD1.ts) rather than a hand-rolled
 * mock — the merge SQL's correctness (which rows move, which stay put, the
 * COALESCE-preserve metadata backfill) is exactly what's under test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedD1, type D1Database, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import { dedupeSplitFilerIdentities } from '../filerIdentityDedupe.ts';
import { repairMemberIdentityMerges } from '../routes.ts';
import { MEMBER_FILER_MERGES } from '../../shared/memberIdentity.ts';
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
  party?: string | null;
  district?: string | null;
  photoUrl?: string | null;
  resolvedBioguideId?: string | null;
}) {
  db.prepare(
    `INSERT INTO filers (bioguide_id, chamber, full_name, party, state, district, photo_url, resolved_bioguide_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.chamber,
    row.fullName,
    row.party ?? null,
    row.state,
    row.district ?? null,
    row.photoUrl ?? null,
    row.resolvedBioguideId ?? null,
  );
}

let txSeq = 0;
function insertTx(filerId: string, opts: { deprecated?: boolean } = {}) {
  txSeq += 1;
  db.prepare(
    `INSERT INTO transactions (id, doc_id, filer_id, tx_date, deprecated_at)
     VALUES (?, ?, ?, '2026-01-01', ?)`,
  ).run(`tx-${txSeq}`, `doc-${txSeq}`, filerId, opts.deprecated ? '2026-02-01T00:00:00.000Z' : null);
}

function insertFiling(docId: string, filerId: string) {
  db.prepare(`INSERT INTO filings (doc_id, chamber, filer_id, filing_type, ingest_status) VALUES (?, 'house', ?, 'P', 'persisted')`).run(
    docId,
    filerId,
  );
}

describe('dedupeSplitFilerIdentities', () => {
  it('merges a middle-initial fork (issue #1452, the McCaul pair) onto the higher-tx_count row', async () => {
    insertFiler({ id: 'house-tx10-michael-t-mccaul', fullName: 'Michael T. McCaul', chamber: 'house', state: 'TX' });
    insertFiler({ id: 'house-tx10-michael-mccaul', fullName: 'Michael McCaul', chamber: 'house', state: 'TX' });
    for (let i = 0; i < 5; i++) insertTx('house-tx10-michael-t-mccaul');
    for (let i = 0; i < 3; i++) insertTx('house-tx10-michael-mccaul');
    insertFiling('doc-a', 'house-tx10-michael-t-mccaul');
    insertFiling('doc-b', 'house-tx10-michael-mccaul');

    const result = await dedupeSplitFilerIdentities(env);

    expect(result.clustersFound).toBe(1);
    expect(result.aliasesTombstoned).toBe(1);
    expect(result.transactionsMoved).toBe(3);
    expect(result.filingsMoved).toBe(1);
    expect(result.details[0].canonicalId).toBe('house-tx10-michael-t-mccaul');
    expect(result.details[0].aliasIds).toEqual(['house-tx10-michael-mccaul']);

    // The alias row is tombstoned, never deleted.
    const alias = db.prepare('SELECT bioguide_id, merged_into FROM filers WHERE bioguide_id = ?').get(
      'house-tx10-michael-mccaul',
    ) as { bioguide_id: string; merged_into: string | null };
    expect(alias).toBeTruthy();
    expect(alias.merged_into).toBe('house-tx10-michael-t-mccaul');

    // Every transaction now attributes to the canonical id — one distinct
    // filer instead of two split stat lines.
    const distinctFilers = db
      .prepare('SELECT DISTINCT filer_id FROM transactions')
      .all() as Array<{ filer_id: string }>;
    expect(distinctFilers).toEqual([{ filer_id: 'house-tx10-michael-t-mccaul' }]);

    // Durable, auditable mapping — never silently lost.
    const mapping = db
      .prepare('SELECT alias_filer_id, canonical_filer_id FROM filer_identity_merges WHERE alias_filer_id = ?')
      .get('house-tx10-michael-mccaul') as { alias_filer_id: string; canonical_filer_id: string };
    expect(mapping.canonical_filer_id).toBe('house-tx10-michael-t-mccaul');
  });

  it('is idempotent — a second run finds nothing left to merge', async () => {
    insertFiler({ id: 'house-tx10-michael-t-mccaul', fullName: 'Michael T. McCaul', chamber: 'house', state: 'TX' });
    insertFiler({ id: 'house-tx10-michael-mccaul', fullName: 'Michael McCaul', chamber: 'house', state: 'TX' });
    insertTx('house-tx10-michael-t-mccaul');
    insertTx('house-tx10-michael-mccaul');

    await dedupeSplitFilerIdentities(env);
    const second = await dedupeSplitFilerIdentities(env);

    expect(second.clustersFound).toBe(0);
    expect(second.aliasesTombstoned).toBe(0);
    expect(second.transactionsMoved).toBe(0);
    expect(second.filingsMoved).toBe(0);
  });

  it('self-heals a straggler transaction that lands under an already-merged alias id', async () => {
    insertFiler({ id: 'house-tx10-michael-t-mccaul', fullName: 'Michael T. McCaul', chamber: 'house', state: 'TX' });
    insertFiler({ id: 'house-tx10-michael-mccaul', fullName: 'Michael McCaul', chamber: 'house', state: 'TX' });
    // Give the "-t-" row more transactions so it deterministically wins
    // canonical (tx_count tie-break), matching the first test above.
    for (let i = 0; i < 3; i++) insertTx('house-tx10-michael-t-mccaul');
    insertTx('house-tx10-michael-mccaul');
    const first = await dedupeSplitFilerIdentities(env);
    expect(first.details[0].canonicalId).toBe('house-tx10-michael-t-mccaul');

    // Simulate a race: something inserts one more row under the now-tombstoned
    // alias id after the first merge pass.
    insertTx('house-tx10-michael-mccaul');

    const second = await dedupeSplitFilerIdentities(env);
    expect(second.resweptRows).toBeGreaterThanOrEqual(1);

    const stragglers = db
      .prepare("SELECT COUNT(*) AS n FROM transactions WHERE filer_id = 'house-tx10-michael-mccaul'")
      .get() as { n: number };
    expect(stragglers.n).toBe(0);
  });

  it('does not merge across state', async () => {
    insertFiler({ id: 'a', fullName: 'Michael T. McCaul', chamber: 'house', state: 'TX' });
    insertFiler({ id: 'b', fullName: 'Michael McCaul', chamber: 'house', state: 'CA' });
    insertTx('a');
    insertTx('b');

    const result = await dedupeSplitFilerIdentities(env);
    expect(result.clustersFound).toBe(0);
  });

  it('does not merge across chamber', async () => {
    insertFiler({ id: 'a', fullName: 'Michael T. McCaul', chamber: 'house', state: 'TX' });
    insertFiler({ id: 'b', fullName: 'Michael McCaul', chamber: 'senate', state: 'TX' });
    insertTx('a');
    insertTx('b');

    const result = await dedupeSplitFilerIdentities(env);
    expect(result.clustersFound).toBe(0);
  });

  it('does not merge two different people who share a last name', async () => {
    insertFiler({ id: 'a', fullName: 'John Smith', chamber: 'house', state: 'CA' });
    insertFiler({ id: 'b', fullName: 'Jane Smith', chamber: 'house', state: 'CA' });
    insertTx('a');
    insertTx('b');

    const result = await dedupeSplitFilerIdentities(env);
    expect(result.clustersFound).toBe(0);
    const rows = db.prepare('SELECT bioguide_id, merged_into FROM filers ORDER BY bioguide_id').all() as Array<{
      bioguide_id: string;
      merged_into: string | null;
    }>;
    expect(rows.every((r) => r.merged_into === null)).toBe(true);
  });

  it('prefers a resolved_bioguide_id match as canonical even against a higher tx_count, and backfills metadata onto it without overwriting what it already has', async () => {
    insertFiler({
      id: 'house-tx10-michael-t-mccaul',
      fullName: 'Michael T. McCaul',
      chamber: 'house',
      state: 'TX',
      party: 'Republican',
      // No resolved_bioguide_id — but wins on raw tx_count alone.
    });
    insertFiler({
      id: 'house-tx10-michael-mccaul',
      fullName: 'Michael McCaul',
      chamber: 'house',
      state: 'TX',
      district: '10',
      photoUrl: 'https://example.test/mccaul.jpg',
      resolvedBioguideId: 'M001157',
    });
    // The non-resolved row has far more transactions, but resolved_bioguide_id
    // (an authoritative congress-legislators match) outranks tx_count.
    for (let i = 0; i < 10; i++) insertTx('house-tx10-michael-t-mccaul');
    insertTx('house-tx10-michael-mccaul');

    const result = await dedupeSplitFilerIdentities(env);
    expect(result.details[0].canonicalId).toBe('house-tx10-michael-mccaul');

    const canonical = db
      .prepare('SELECT party, district, photo_url, resolved_bioguide_id FROM filers WHERE bioguide_id = ?')
      .get('house-tx10-michael-mccaul') as {
      party: string | null;
      district: string | null;
      photo_url: string | null;
      resolved_bioguide_id: string | null;
    };
    expect(canonical.party).toBe('Republican'); // filled from the alias
    expect(canonical.district).toBe('10'); // preserved, not overwritten
    expect(canonical.photo_url).toBe('https://example.test/mccaul.jpg');
    expect(canonical.resolved_bioguide_id).toBe('M001157');
  });

  it('ignores rows already tombstoned by an earlier merge (never re-clusters them)', async () => {
    insertFiler({ id: 'a', fullName: 'Michael T. McCaul', chamber: 'house', state: 'TX' });
    insertFiler({ id: 'b', fullName: 'Michael McCaul', chamber: 'house', state: 'TX' });
    insertTx('a');
    insertTx('b');
    await dedupeSplitFilerIdentities(env);

    // A brand-new third fork of the same person shows up later.
    insertFiler({ id: 'c', fullName: 'Mike McCaul', chamber: 'house', state: 'TX' });
    insertTx('c');
    const second = await dedupeSplitFilerIdentities(env);

    // "Mike" != "Michael" under memberNameMatchKey (not a middle-initial
    // variance), so it forms its own singleton — not merged, and the
    // already-tombstoned 'b' is not reconsidered.
    expect(second.clustersFound).toBe(0);
    const bRow = db.prepare('SELECT merged_into FROM filers WHERE bioguide_id = ?').get('b') as {
      merged_into: string | null;
    };
    expect(bRow.merged_into).toBe('a');
  });
});

describe('dedupeSplitFilerIdentities — bioguide-keyed pass', () => {
  it('merges two non-tombstoned filers sharing (resolved_bioguide_id, chamber) — the McConnell/Mitchell cluster', async () => {
    // Same person (Mitch McConnell, KY), same resolved bioguide, but a
    // name/state variance ("A. Mitchell Jr. McConnell", no state on file)
    // pass A's chamber+state name-key rule can never reach on its own.
    insertFiler({
      id: 'senate-a-mitchell-jr-mcconnell',
      fullName: 'A. Mitchell Jr. McConnell',
      chamber: 'senate',
      state: '',
      resolvedBioguideId: 'M000355',
    });
    insertFiler({
      id: 'senate-mitch-mcconnell',
      fullName: 'Mitch McConnell',
      chamber: 'senate',
      state: 'KY',
      resolvedBioguideId: 'M000355',
    });
    insertTx('senate-a-mitchell-jr-mcconnell');
    for (let i = 0; i < 3; i++) insertTx('senate-mitch-mcconnell');

    const result = await dedupeSplitFilerIdentities(env);

    const bioguideDetail = result.details.find((d) => d.reason === 'bioguide');
    expect(bioguideDetail).toBeTruthy();
    expect(bioguideDetail?.canonicalId).toBe('senate-mitch-mcconnell');
    expect(bioguideDetail?.aliasIds).toEqual(['senate-a-mitchell-jr-mcconnell']);

    const alias = db.prepare('SELECT merged_into FROM filers WHERE bioguide_id = ?').get(
      'senate-a-mitchell-jr-mcconnell',
    ) as { merged_into: string | null };
    expect(alias.merged_into).toBe('senate-mitch-mcconnell');

    const mapping = db
      .prepare('SELECT reason FROM filer_identity_merges WHERE alias_filer_id = ?')
      .get('senate-a-mitchell-jr-mcconnell') as { reason: string };
    expect(mapping.reason).toBe('bioguide');
  });

  it('does not merge the same bioguide across different chamber rows (EXEC-MCCORMICK vs Senate Dave McCormick, by design)', async () => {
    insertFiler({
      id: 'senate-dave-mccormick',
      fullName: 'Dave McCormick',
      chamber: 'senate',
      state: 'PA',
      resolvedBioguideId: 'M001243',
    });
    insertFiler({
      id: 'EXEC-MCCORMICK',
      fullName: 'David McCormick',
      chamber: 'executive',
      state: '',
      resolvedBioguideId: 'M001243',
    });
    insertTx('senate-dave-mccormick');
    insertTx('EXEC-MCCORMICK');

    const result = await dedupeSplitFilerIdentities(env);

    expect(result.details.find((d) => d.reason === 'bioguide')).toBeUndefined();
    expect(result.details.find((d) => d.reason === 'exec-name-normalization')).toBeUndefined();

    const rows = db.prepare('SELECT bioguide_id, merged_into FROM filers ORDER BY bioguide_id').all() as Array<{
      bioguide_id: string;
      merged_into: string | null;
    }>;
    expect(rows.every((r) => r.merged_into === null)).toBe(true);
  });
});

describe('dedupeSplitFilerIdentities — exec name-key pass (ERM/date/year noise)', () => {
  it('merges chamber=executive rows whose names differ only by a "YYYY ERM" suffix', async () => {
    insertFiler({ id: 'EXEC-BARBARA-M-BARRETT', fullName: 'Barbara M Barrett', chamber: 'executive', state: '' });
    insertFiler({
      id: 'EXEC-BARBARA-M-BARRETT-2021-ERM',
      fullName: 'Barbara M Barrett 2021 ERM',
      chamber: 'executive',
      state: '',
    });
    insertTx('EXEC-BARBARA-M-BARRETT-2021-ERM');

    const result = await dedupeSplitFilerIdentities(env);

    const execDetail = result.details.find((d) => d.reason === 'exec-name-normalization');
    expect(execDetail).toBeTruthy();
    expect(execDetail?.canonicalId).toBe('EXEC-BARBARA-M-BARRETT-2021-ERM');
    expect(execDetail?.aliasIds).toEqual(['EXEC-BARBARA-M-BARRETT']);
  });

  it('merges three-way ERM/year/dotted-date forks of the same exec nominee (Adeyemo, Albright)', async () => {
    insertFiler({ id: 'EXEC-ADEWALE-ADEYEMO', fullName: 'Adewale Adeyemo', chamber: 'executive', state: '' });
    insertFiler({
      id: 'EXEC-ADEWALE-ADEYEMO-2025-ERM',
      fullName: 'Adewale Adeyemo 2025 ERM',
      chamber: 'executive',
      state: '',
    });
    insertFiler({ id: 'EXEC-ALICE-ALBRIGHT', fullName: 'Alice Albright', chamber: 'executive', state: '' });
    insertFiler({
      id: 'EXEC-ALICE-ALBRIGHT-10-24-2022',
      fullName: 'Alice Albright 10.24..2022',
      chamber: 'executive',
      state: '',
    });
    insertFiler({
      id: 'EXEC-ALICE-ALBRIGHT-2025-ERM',
      fullName: 'Alice Albright 2025 ERM',
      chamber: 'executive',
      state: '',
    });
    insertTx('EXEC-ADEWALE-ADEYEMO');
    insertTx('EXEC-ALICE-ALBRIGHT-10-24-2022');

    const result = await dedupeSplitFilerIdentities(env);

    const execDetails = result.details.filter((d) => d.reason === 'exec-name-normalization');
    expect(execDetails).toHaveLength(2);

    const adeyemo = execDetails.find((d) => d.canonicalId === 'EXEC-ADEWALE-ADEYEMO');
    expect(adeyemo?.aliasIds).toEqual(['EXEC-ADEWALE-ADEYEMO-2025-ERM']);

    const albright = execDetails.find((d) => d.canonicalId === 'EXEC-ALICE-ALBRIGHT-10-24-2022');
    expect(albright?.aliasIds?.sort()).toEqual(['EXEC-ALICE-ALBRIGHT', 'EXEC-ALICE-ALBRIGHT-2025-ERM']);
  });

  it('never merges an executive-branch row with a house/senate row sharing the same name (chamber-scoped)', async () => {
    insertFiler({ id: 'EXEC-SOMEBODY', fullName: 'Chris Coons', chamber: 'executive', state: '' });
    insertFiler({ id: 'senate-chris-coons', fullName: 'Chris Coons', chamber: 'senate', state: 'DE' });
    insertTx('EXEC-SOMEBODY');
    insertTx('senate-chris-coons');

    const result = await dedupeSplitFilerIdentities(env);

    expect(result.details.find((d) => d.reason === 'exec-name-normalization')).toBeUndefined();
    const rows = db.prepare('SELECT bioguide_id, merged_into FROM filers ORDER BY bioguide_id').all() as Array<{
      bioguide_id: string;
      merged_into: string | null;
    }>;
    expect(rows.every((r) => r.merged_into === null)).toBe(true);
  });
});

describe('dedupeSplitFilerIdentities — dryRun', () => {
  it('reports clusters and counts without writing anything', async () => {
    insertFiler({ id: 'house-tx10-michael-t-mccaul', fullName: 'Michael T. McCaul', chamber: 'house', state: 'TX' });
    insertFiler({ id: 'house-tx10-michael-mccaul', fullName: 'Michael McCaul', chamber: 'house', state: 'TX' });
    for (let i = 0; i < 5; i++) insertTx('house-tx10-michael-t-mccaul');
    for (let i = 0; i < 3; i++) insertTx('house-tx10-michael-mccaul');
    insertFiling('doc-a', 'house-tx10-michael-t-mccaul');
    insertFiling('doc-b', 'house-tx10-michael-mccaul');

    const result = await dedupeSplitFilerIdentities(env, { dryRun: true });

    expect(result.clustersFound).toBe(1);
    expect(result.aliasesTombstoned).toBe(1);
    expect(result.transactionsMoved).toBe(3);
    expect(result.filingsMoved).toBe(1);
    expect(result.resweptRows).toBe(0);
    expect(result.details[0].canonicalId).toBe('house-tx10-michael-t-mccaul');
    expect(result.details[0].aliasIds).toEqual(['house-tx10-michael-mccaul']);

    // Nothing written: no tombstone, no audit row, no filer_id rewrite.
    const alias = db.prepare('SELECT merged_into FROM filers WHERE bioguide_id = ?').get(
      'house-tx10-michael-mccaul',
    ) as { merged_into: string | null };
    expect(alias.merged_into).toBeNull();

    const mergeRows = db.prepare('SELECT COUNT(*) AS n FROM filer_identity_merges').get() as { n: number };
    expect(mergeRows.n).toBe(0);

    const distinctFilers = db
      .prepare('SELECT DISTINCT filer_id FROM transactions ORDER BY filer_id')
      .all() as Array<{ filer_id: string }>;
    expect(distinctFilers).toEqual([
      { filer_id: 'house-tx10-michael-mccaul' },
      { filer_id: 'house-tx10-michael-t-mccaul' },
    ]);

    // A real run afterward still finds the exact same cluster fresh — the
    // dryRun call above changed nothing on disk.
    const real = await dedupeSplitFilerIdentities(env);
    expect(real.clustersFound).toBe(1);
    expect(real.details[0].canonicalId).toBe('house-tx10-michael-t-mccaul');
  });

  it('does not write the bioguide or exec passes either', async () => {
    insertFiler({
      id: 'senate-a-mitchell-jr-mcconnell',
      fullName: 'A. Mitchell Jr. McConnell',
      chamber: 'senate',
      state: '',
      resolvedBioguideId: 'M000355',
    });
    insertFiler({
      id: 'senate-mitch-mcconnell',
      fullName: 'Mitch McConnell',
      chamber: 'senate',
      state: 'KY',
      resolvedBioguideId: 'M000355',
    });
    insertFiler({ id: 'EXEC-BARBARA-M-BARRETT', fullName: 'Barbara M Barrett', chamber: 'executive', state: '' });
    insertFiler({
      id: 'EXEC-BARBARA-M-BARRETT-2021-ERM',
      fullName: 'Barbara M Barrett 2021 ERM',
      chamber: 'executive',
      state: '',
    });

    const result = await dedupeSplitFilerIdentities(env, { dryRun: true });

    expect(result.details.find((d) => d.reason === 'bioguide')).toBeTruthy();
    expect(result.details.find((d) => d.reason === 'exec-name-normalization')).toBeTruthy();

    const rows = db.prepare('SELECT bioguide_id, merged_into FROM filers ORDER BY bioguide_id').all() as Array<{
      bioguide_id: string;
      merged_into: string | null;
    }>;
    expect(rows.every((r) => r.merged_into === null)).toBe(true);
    const mergeRows = db.prepare('SELECT COUNT(*) AS n FROM filer_identity_merges').get() as { n: number };
    expect(mergeRows.n).toBe(0);
  });
});

describe('curated Dunn merge group (MEMBER_FILER_MERGES)', () => {
  it('has the Neal Patrick Dunn group absorbing MANUAL-FACS and MANUAL-', () => {
    const group = MEMBER_FILER_MERGES.find((g) => g.canonicalId === 'house-fl02-neal-patrick-dunn');
    expect(group).toBeTruthy();
    expect(group?.canonicalName).toBe('Neal Patrick Dunn');
    expect(group?.chamber).toBe('house');
    expect(group?.state).toBe('FL');
    expect(group?.district).toBe('02');
    expect(group?.resolvedBioguideId).toBe('D000628');
    expect(group?.aliasIds).toEqual(['MANUAL-FACS', 'MANUAL-']);
  });

  it('repairMemberIdentityMerges merges MANUAL-FACS and the blank-name MANUAL- filer onto the canonical Dunn row', async () => {
    insertFiler({
      id: 'house-fl02-neal-patrick-dunn',
      fullName: 'Neal Patrick Dunn',
      chamber: 'house',
      state: 'FL',
      district: '02',
    });
    insertFiler({ id: 'MANUAL-FACS', fullName: 'Neal Patrick Dunn FACS', chamber: 'house', state: '' });
    insertFiler({ id: 'MANUAL-', fullName: ' ', chamber: 'house', state: '' });
    insertTx('house-fl02-neal-patrick-dunn');
    for (let i = 0; i < 4; i++) insertTx('MANUAL-FACS');
    for (let i = 0; i < 8; i++) insertTx('MANUAL-');

    const result = await repairMemberIdentityMerges(env);

    const dunnDetail = result.details.find((d) => d.canonicalId === 'house-fl02-neal-patrick-dunn');
    expect(dunnDetail).toBeTruthy();
    expect(dunnDetail?.deleted.slice().sort()).toEqual(['MANUAL-', 'MANUAL-FACS']);
    expect(dunnDetail?.transactionsMoved).toBe(12);

    const canonical = db
      .prepare('SELECT full_name, resolved_bioguide_id FROM filers WHERE bioguide_id = ?')
      .get('house-fl02-neal-patrick-dunn') as { full_name: string; resolved_bioguide_id: string | null };
    expect(canonical.full_name).toBe('Neal Patrick Dunn');
    expect(canonical.resolved_bioguide_id).toBe('D000628');

    // Curated path hard-deletes aliases (unlike the generic dedupe passes,
    // which tombstone) — see applyMemberFilerMerge in admin/routes.ts.
    expect(db.prepare("SELECT bioguide_id FROM filers WHERE bioguide_id = 'MANUAL-FACS'").get()).toBeUndefined();
    expect(db.prepare("SELECT bioguide_id FROM filers WHERE bioguide_id = 'MANUAL-'").get()).toBeUndefined();

    const allTx = db.prepare('SELECT DISTINCT filer_id FROM transactions').all() as Array<{ filer_id: string }>;
    expect(allTx).toEqual([{ filer_id: 'house-fl02-neal-patrick-dunn' }]);
  });
});

// Board row 591011b9: EXEC-* vs MANUAL-* twins.  Once identitySync labels the
// MANUAL-* row 'executive' the exec pass can cluster them; the canonical id must
// be the real EXEC-* one (it carries the curated title) even when the phantom
// holds more transactions.
describe('dedupeSplitFilerIdentities: EXEC-* twin of a MANUAL-* phantom', () => {
  it('merges MANUAL-BURGUM into EXEC-DOUGLAS-J-BURGUM although the phantom has 69 rows to the EXEC row\'s 6', async () => {
    insertFiler({ id: 'EXEC-DOUGLAS-J-BURGUM', fullName: 'Douglas J Burgum', chamber: 'executive', state: '' });
    insertFiler({ id: 'MANUAL-BURGUM', fullName: 'Douglas J Burgum', chamber: 'executive', state: '' });
    for (let i = 0; i < 6; i++) insertTx('EXEC-DOUGLAS-J-BURGUM');
    for (let i = 0; i < 69; i++) insertTx('MANUAL-BURGUM');

    const result = await dedupeSplitFilerIdentities(env);

    expect(result.clustersFound).toBe(1);
    expect(result.details[0].canonicalId).toBe('EXEC-DOUGLAS-J-BURGUM');
    expect(result.details[0].aliasIds).toEqual(['MANUAL-BURGUM']);
    expect(result.transactionsMoved).toBe(69);
    const owners = db.prepare('SELECT DISTINCT filer_id FROM transactions').all();
    expect(owners).toEqual([{ filer_id: 'EXEC-DOUGLAS-J-BURGUM' }]);
  });

  it('merges "Christopher A Wright" into the curated EXEC-CWRIGHT ("Chris Wright"): their name keys differ, the curated alias joins them', async () => {
    insertFiler({ id: 'EXEC-CWRIGHT', fullName: 'Chris Wright', chamber: 'executive', state: '' });
    insertFiler({ id: 'MANUAL-WRIGHT', fullName: 'Christopher A Wright', chamber: 'executive', state: '' });
    insertTx('EXEC-CWRIGHT');
    for (let i = 0; i < 4; i++) insertTx('MANUAL-WRIGHT');

    const result = await dedupeSplitFilerIdentities(env);

    expect(result.details[0]?.canonicalId).toBe('EXEC-CWRIGHT');
    expect(result.details[0]?.aliasIds).toEqual(['MANUAL-WRIGHT']);
  });

  it('while the phantom is still labelled senate nothing merges (the chamber fix must land first)', async () => {
    insertFiler({ id: 'EXEC-DOUGLAS-J-BURGUM', fullName: 'Douglas J Burgum', chamber: 'executive', state: '' });
    insertFiler({ id: 'MANUAL-BURGUM', fullName: 'Douglas J Burgum', chamber: 'senate', state: '' });
    insertTx('MANUAL-BURGUM');

    const result = await dedupeSplitFilerIdentities(env, { dryRun: true });

    expect(result.clustersFound).toBe(0);
  });

  it('a real house-* id stays canonical over a MANUAL-* twin that carries more rows', async () => {
    insertFiler({ id: 'house-ca47-alan-s-lowenthal', fullName: 'Alan S. Lowenthal', chamber: 'house', state: 'CA', resolvedBioguideId: 'L000579' });
    insertFiler({ id: 'MANUAL-LOWENTHAL', fullName: 'Alan S. Lowenthal', chamber: 'house', state: 'CA', resolvedBioguideId: 'L000579' });
    for (let i = 0; i < 2; i++) insertTx('house-ca47-alan-s-lowenthal');
    for (let i = 0; i < 9; i++) insertTx('MANUAL-LOWENTHAL');

    const result = await dedupeSplitFilerIdentities(env);

    expect(result.details.map((d) => d.canonicalId)).toEqual(['house-ca47-alan-s-lowenthal']);
  });
});

