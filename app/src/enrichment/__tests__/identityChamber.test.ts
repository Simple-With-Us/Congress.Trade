/**
 * src/enrichment/__tests__/identityChamber.test.ts
 *
 * Board row 85f2170a: competitor-minted `MANUAL-*` filers carried a guessed
 * chamber ('senate' for anyone the roster did not match), so cabinet officials
 * showed as Senators and House members as Senators, and the chamber-keyed
 * dedupe passes could never merge them with their real filer.  Also covers the
 * mis-resolutions behind "Gillis Long" (a 1985 Representative), "Mark Green
 * WI-8" and a 1940s "John Delaney".
 *
 * Fixtures mirror the SHAPE of the live congress-legislators records (each
 * legislator's `terms` carries `type` and `end`), and the filer rows are copied
 * from the live /api/members and /api/transactions payloads of 2026-09-18.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideMintedChamber,
  executiveFilerIdsFromPhotoPack,
  loadIdentityEvidence,
  planIdentitySync,
  runIdentitySync,
  type IdentityEvidence,
  type IdentityFilerRow,
} from '../identitySync.ts';
import {
  indexLegislatorFallback,
  indexLegislators,
  indexLegislatorsByBioguide,
  isDisclosureEraLegislator,
  LEGISLATOR_SOURCES,
  type Legislator,
  type LegislatorIndexes,
} from '../legislators.ts';
import { dedupeSplitFilerIdentities } from '../../admin/filerIdentityDedupe.ts';
import { openMigratedD1 } from '../../prices/__tests__/sqliteD1.ts';
import type { Env } from '../../shared/types.ts';

const ROSTER: Legislator[] = [
  // Current roster first, historical after (the order buildLegislatorMap uses).
  {
    id: { bioguide: 'S001198' },
    name: { first: 'Dan', last: 'Sullivan', official_full: 'Dan Sullivan' },
    terms: [{ type: 'sen', party: 'Republican', state: 'AK', start: '2021-01-03', end: '2027-01-03' }],
  },
  {
    id: { bioguide: 'J000289' },
    name: { first: 'Jim', last: 'Jordan', official_full: 'Jim Jordan' },
    terms: [{ type: 'rep', party: 'Republican', state: 'OH', district: 4, start: '2025-01-03', end: '2027-01-03' }],
  },
  {
    id: { bioguide: 'M001232' },
    name: { first: 'April', last: 'McClain Delaney', official_full: 'April McClain Delaney' },
    terms: [{ type: 'rep', party: 'Democrat', state: 'MD', district: 6, start: '2025-01-03', end: '2027-01-03' }],
  },
  // Historical: two Mark Greens and two John Delaneys, the old one listed FIRST.
  {
    id: { bioguide: 'G000545' },
    name: { first: 'Mark', last: 'Green', official_full: 'Mark Green' },
    terms: [{ type: 'rep', party: 'Republican', state: 'WI', district: 8, start: '2003-01-03', end: '2007-01-03' }],
  },
  {
    id: { bioguide: 'G000590' },
    name: { first: 'Mark', middle: 'E.', last: 'Green', official_full: 'Mark E. Green' },
    terms: [{ type: 'rep', party: 'Republican', state: 'TN', district: 7, start: '2019-01-03', end: '2027-01-03' }],
  },
  {
    id: { bioguide: 'D000212' },
    name: { first: 'John', middle: 'J.', last: 'Delaney', official_full: 'John J. Delaney' },
    terms: [{ type: 'rep', party: 'Democrat', state: 'NY', district: 7, start: '1931-01-03', end: '1948-05-01' }],
  },
  {
    id: { bioguide: 'D000620' },
    name: { first: 'John', middle: 'K.', last: 'Delaney', official_full: 'John K. Delaney' },
    terms: [{ type: 'rep', party: 'Democrat', state: 'MD', district: 6, start: '2013-01-03', end: '2019-01-03' }],
  },
  // Gillis William Long: his MIDDLE name "William" is what mis-keyed "William Long" onto him.
  {
    id: { bioguide: 'L000417' },
    name: { first: 'Gillis', middle: 'William', last: 'Long', official_full: 'Gillis W. Long' },
    terms: [{ type: 'rep', party: 'Democrat', state: 'LA', district: 8, start: '1985-01-03', end: '1985-01-20' }],
  },
  {
    id: { bioguide: 'L000576' },
    name: { first: 'Billy', last: 'Long', official_full: 'Billy Long', nickname: 'Billy' },
    terms: [{ type: 'rep', party: 'Republican', state: 'MO', district: 7, start: '2021-01-03', end: '2023-01-03' }],
  },
  // A sitting House member who once was a Senator-elect is irrelevant here; Tulsi is the
  // "former legislator, now an official" case: her latest LEGISLATIVE term ended 2021.
  {
    id: { bioguide: 'G000571' },
    name: { first: 'Tulsi', last: 'Gabbard', official_full: 'Tulsi Gabbard' },
    terms: [{ type: 'rep', party: 'Democrat', state: 'HI', district: 2, start: '2019-01-03', end: '2021-01-03' }],
  },
  {
    id: { bioguide: 'S001150' },
    name: { first: 'Adam', last: 'Schiff', official_full: 'Adam B. Schiff' },
    terms: [{ type: 'sen', party: 'Democrat', state: 'CA', start: '2025-01-03', end: '2031-01-03' }],
  },
];

function indexesFrom(list: readonly Legislator[]): LegislatorIndexes {
  return {
    primary: indexLegislators(list),
    fallback: indexLegislatorFallback(list),
    byBioguide: indexLegislatorsByBioguide(list),
  };
}

function row(o: Partial<IdentityFilerRow>): IdentityFilerRow {
  return {
    bioguide_id: 'x',
    chamber: 'senate',
    full_name: null,
    party: null,
    state: null,
    district: null,
    resolved_bioguide_id: null,
    display_name: null,
    ...o,
  };
}

const indexes = indexesFrom(ROSTER);

describe('legislators index: chamber and recency', () => {
  it('records the chamber of the latest term and its end date', () => {
    const jordan = indexes.byBioguide.get('J000289')!;
    expect(jordan.chamber).toBe('house');
    expect(indexes.byBioguide.get('S001198')!.chamber).toBe('senate');
    expect(jordan.lastTermEnd).toBe('2027-01-03');
  });

  it('prefers the more recent holder of a shared name (2019 TN-7 Mark Green over the 2007 WI-8 one listed first)', () => {
    expect(indexes.primary.get('mark green')!.bioguide).toBe('G000590');
    expect(indexes.primary.get('john delaney')!.bioguide).toBe('D000620');
  });

  it('flags pre-STOCK-Act legislators as not disclosure-era', () => {
    expect(isDisclosureEraLegislator(indexes.byBioguide.get('L000417')!)).toBe(false);
    expect(isDisclosureEraLegislator(indexes.byBioguide.get('D000212')!)).toBe(false);
    expect(isDisclosureEraLegislator(indexes.byBioguide.get('D000620')!)).toBe(true);
  });
});

describe('planIdentitySync: chamber for competitor-minted MANUAL-* filers', () => {
  it('corrects a House member labelled senate from the roster (MANUAL-JORDAN, live: "Jim Jordan senate R OH-4")', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'MANUAL-JORDAN', full_name: 'Jim Jordan', chamber: 'senate', state: 'OH', district: '4', party: 'Republican', resolved_bioguide_id: 'J000289', display_name: 'Jim Jordan' })],
      indexes,
    );
    expect(plan.chambersCorrected).toBe(1);
    expect(plan.changes[0].kind).toBe('chamber');
    expect(plan.changes[0].after.chamber).toBe('house');
  });

  it('corrects a Senator labelled house from the roster (MANUAL-SULLIVAN, live: "Dan Sullivan house R AK") even though the payload said house', () => {
    const evidence: IdentityEvidence = { payloadChamber: new Map([['MANUAL-SULLIVAN', 'house']]) };
    const plan = planIdentitySync(
      [row({ bioguide_id: 'MANUAL-SULLIVAN', full_name: 'Dan Sullivan', chamber: 'house', state: 'AK', party: 'Republican', resolved_bioguide_id: 'S001198', display_name: 'Dan Sullivan' })],
      indexes,
      evidence,
    );
    expect(plan.changes[0].after.chamber).toBe('senate');
  });

  it('makes an official executive from the competitor payloads (MANUAL-HEGSETH, live: "Pete Hegseth senate party null")', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'MANUAL-HEGSETH', full_name: 'Pete Hegseth', chamber: 'senate' })],
      indexes,
      { payloadChamber: new Map([['MANUAL-HEGSETH', 'executive']]) },
    );
    expect(plan.chambersCorrected).toBe(1);
    expect(plan.changes[0].after.chamber).toBe('executive');
  });

  it('makes an official executive from curated executive data even with no payload evidence', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'MANUAL-BONDI', full_name: 'Pam Bondi', chamber: 'senate' })],
      indexes,
      { executiveFilerIds: new Set(['MANUAL-BONDI']) },
    );
    expect(plan.changes[0].after.chamber).toBe('executive');
  });

  it('makes MANUAL-WRIGHT executive from the curated EXEC-CWRIGHT alias ("Christopher A Wright")', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'MANUAL-WRIGHT', full_name: 'Christopher A Wright', chamber: 'senate' })],
      indexes,
    );
    expect(plan.changes[0].after.chamber).toBe('executive');
  });

  it('never invents a chamber: no evidence, no change, and senate is not a default', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'MANUAL-NOBODY', full_name: 'Nobody Known', chamber: 'senate' })],
      indexes,
    );
    expect(plan.changes.filter((c) => c.after.chamber !== undefined)).toEqual([]);
    expect(decideMintedChamber({ legislator: null, payloadChamber: null, curatedExecutive: false, executiveTwin: false })).toBeNull();
  });

  it('uses the payload house/senate only when the roster does not resolve the filer', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'MANUAL-HOLLINGSWORTH', full_name: 'Joseph Hollingsworth', chamber: 'senate' })],
      indexes,
      { payloadChamber: new Map([['MANUAL-HOLLINGSWORTH', 'house']]) },
    );
    expect(plan.changes[0].after.chamber).toBe('house');
  });

  it('treats a MANUAL-* that shares a name with a live executive filer as that official (lowest-priority evidence)', () => {
    const plan = planIdentitySync(
      [
        row({ bioguide_id: 'EXEC-DOUGLAS-J-BURGUM', full_name: 'Douglas J Burgum', chamber: 'executive' }),
        row({ bioguide_id: 'MANUAL-BURGUM', full_name: 'Douglas J Burgum', chamber: 'senate' }),
      ],
      indexes,
    );
    const burgum = plan.changes.find((c) => c.filerId === 'MANUAL-BURGUM');
    expect(burgum?.after.chamber).toBe('executive');
  });

  it('a former legislator who is now an official keeps the roster link but drops party/state/district (MANUAL-GABBARD)', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'MANUAL-GABBARD', full_name: 'Tulsi Gabbard', chamber: 'senate', party: 'Democrat', state: 'HI', district: '2', resolved_bioguide_id: 'G000571', display_name: 'Tulsi Gabbard' })],
      indexes,
      { payloadChamber: new Map([['MANUAL-GABBARD', 'executive']]), latestTxDate: new Map([['MANUAL-GABBARD', '2025-11-01']]) },
    );
    const change = plan.changes[0];
    expect(change.after.chamber).toBe('executive');
    expect(change.after.resolved_bioguide_id).toBe('G000571');
    expect(change.after.party).toBeNull();
    expect(change.after.state).toBeNull();
    expect(change.after.district).toBeNull();
    // The 2021 term end is far before the 2025 trades, but executives are exempt from that bound.
    expect(plan.staleResolutionsFixed).toBe(0);
  });

  it('never rewrites the chamber of a real house-*/senate-* filer (a member who moved chambers has one row per chamber)', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'house-ca28-adam-b-schiff', full_name: 'Adam B. Schiff', chamber: 'house', state: 'CA', district: '28', resolved_bioguide_id: 'S001150', display_name: 'Adam B. Schiff', party: 'Democrat' })],
      indexes,
    );
    expect(plan.changes.every((c) => c.after.chamber === undefined)).toBe(true);
  });

  it('strips the district from an executive filer that already has one (EXEC-SEAN-DUFFY, live: "executive WI-7")', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'EXEC-SEAN-DUFFY', full_name: 'Sean P. Duffy', chamber: 'executive', state: 'WI', district: '7', party: 'Republican', resolved_bioguide_id: 'S001198', display_name: 'Dan Sullivan' })],
      indexes,
    );
    expect(plan.changes[0].after.district).toBeNull();
  });
});

describe('planIdentitySync: implausible roster matches (Gillis Long / Mark Green / John Delaney)', () => {
  it('re-resolves "William Long" off Gillis Long (d. 1985, matched via his MIDDLE name) onto Billy Long', () => {
    // live: MANUAL-LONG "Gillis Long senate D LA-8", payload name "William Long".
    const plan = planIdentitySync(
      [row({ bioguide_id: 'MANUAL-LONG', full_name: 'William Long', chamber: 'senate', state: 'LA', district: '8', party: 'Democrat', resolved_bioguide_id: 'L000417', display_name: 'Gillis Long' })],
      indexes,
      { payloadChamber: new Map([['MANUAL-LONG', 'house']]), latestTxDate: new Map([['MANUAL-LONG', '2022-02-24']]) },
    );
    expect(plan.staleResolutionsFixed).toBe(1);
    const change = plan.changes[0];
    expect(change.after.resolved_bioguide_id).toBe('L000576');
    expect(change.after.state).toBe('MO');
    expect(change.after.district).toBe('7');
    expect(change.after.chamber).toBe('house');
  });

  it('does not resolve a brand-new "William Long" to Gillis Long by the middle-name key', () => {
    const plan = planIdentitySync([row({ bioguide_id: 'x', full_name: 'William Long', chamber: 'house' })], indexes);
    expect(plan.changes[0]?.after.resolved_bioguide_id).not.toBe('L000417');
  });

  it('re-resolves MANUAL-GREEN off the 2007 WI-8 Mark Green onto TN-7', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'MANUAL-GREEN', full_name: 'Mark Green', chamber: 'house', state: 'WI', district: '8', party: 'Republican', resolved_bioguide_id: 'G000545', display_name: 'Mark Green' })],
      indexes,
      { payloadChamber: new Map([['MANUAL-GREEN', 'house']]), latestTxDate: new Map([['MANUAL-GREEN', '2024-07-01']]) },
    );
    expect(plan.changes[0].after.resolved_bioguide_id).toBe('G000590');
    expect(plan.changes[0].after.state).toBe('TN');
    expect(plan.changes[0].after.district).toBe('7');
  });

  it('clears MANUAL-DELANEY\'s resolution to the 1940s John J. Delaney and, with trades in 2026, refuses the 2019-era John K. Delaney too', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'MANUAL-DELANEY', full_name: 'John Delaney', chamber: 'house', state: 'NY', district: '7', party: 'Democrat', resolved_bioguide_id: 'D000212', display_name: 'John Delaney' })],
      indexes,
      { payloadChamber: new Map([['MANUAL-DELANEY', 'house']]), latestTxDate: new Map([['MANUAL-DELANEY', '2026-06-17']]) },
    );
    const change = plan.changes[0];
    expect(change.kind).toBe('cleared');
    expect(change.after.resolved_bioguide_id).toBeNull();
    expect(change.after.state).toBeNull();
    expect(change.after.district).toBeNull();
    expect(change.after.party).toBeNull();
    expect(plan.staleResolutionsFixed).toBe(1);
  });

  it('is idempotent: a second pass over the corrected rows plans nothing', () => {
    const evidence: IdentityEvidence = {
      payloadChamber: new Map([['MANUAL-LONG', 'house']]),
      latestTxDate: new Map([['MANUAL-LONG', '2022-02-24']]),
    };
    const first = planIdentitySync(
      [row({ bioguide_id: 'MANUAL-LONG', full_name: 'William Long', chamber: 'senate', resolved_bioguide_id: 'L000417' })],
      indexes,
      evidence,
    );
    const a = first.changes[0].after;
    const second = planIdentitySync(
      [
        row({
          bioguide_id: 'MANUAL-LONG',
          full_name: 'William Long',
          chamber: a.chamber ?? 'senate',
          party: a.party ?? null,
          state: a.state ?? null,
          district: a.district ?? null,
          resolved_bioguide_id: a.resolved_bioguide_id ?? null,
          display_name: a.display_name ?? null,
        }),
      ],
      indexes,
      evidence,
    );
    expect(second.changes).toEqual([]);
  });
});

describe('executive photo pack evidence (real committed manifest)', () => {
  it('lists the executive-branch MANUAL-* officials the live Directory mislabelled as Senators', () => {
    const ids = executiveFilerIdsFromPhotoPack();
    for (const id of ['MANUAL-HEGSETH', 'MANUAL-BONDI', 'MANUAL-LUTNICK', 'MANUAL-BURGUM', 'MANUAL-MIRAN', 'MANUAL-ISAACMAN', 'MANUAL-LANDAU', 'MANUAL-BLANCHE']) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it('every executive-pack MANUAL-* filer with a senate label is corrected to executive (data test)', () => {
    const ids = [...executiveFilerIdsFromPhotoPack()].filter((id) => id.startsWith('MANUAL-'));
    expect(ids.length).toBeGreaterThan(15);
    const plan = planIdentitySync(
      ids.map((id) => row({ bioguide_id: id, full_name: `Official ${id.slice(7)}`, chamber: 'senate' })),
      indexes,
      { executiveFilerIds: new Set(ids) },
    );
    for (const id of ids) {
      const change = plan.changes.find((c) => c.filerId === id);
      expect(change?.after.chamber, id).toBe('executive');
    }
  });

  it('no MANUAL-* filer in the pack is listed as both an executive and a congressional face', () => {
    // executiveFilerIdsFromPhotoPack() only collects branch==='executive'; a filer id repeated under a congress face would be ambiguous.
    const exec = executiveFilerIdsFromPhotoPack();
    expect(exec.has('MANUAL-JORDAN')).toBe(false);
    expect(exec.has('MANUAL-FLEISHMANN')).toBe(false);
  });
});

describe('loadIdentityEvidence + runIdentitySync (in-memory D1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubRoster(list: Legislator[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === LEGISLATOR_SOURCES[0]) return new Response(JSON.stringify(list), { status: 200 });
        if (url === LEGISLATOR_SOURCES[1]) return new Response(JSON.stringify([]), { status: 200 });
        return new Response('nope', { status: 404 });
      }),
    );
  }

  function insertCompetitorTx(db: import('../../prices/__tests__/sqliteD1.ts').D1Database, n: number, filerId: string, memberType: string | null, txDate: string, raw?: string) {
    const rawText = raw ?? JSON.stringify(memberType === null ? { name: 'x' } : { name: 'x', member_type: memberType });
    return db
      .prepare(
        `INSERT INTO transactions (id, doc_id, filer_id, tx_date, raw_text, source, created_at)
         VALUES (?, ?, ?, ?, ?, 'competitor_backfill', '2026-01-01T00:00:00.000Z')`,
      )
      .bind(`tx-${filerId}-${n}`, `COMPETITOR-${filerId}-${n}`, filerId, txDate, rawText)
      .run();
  }

  it('reads the dominant payload member_type and the latest trade date per MANUAL-* filer', async () => {
    const { d1, close } = await openMigratedD1();
    try {
      for (let i = 0; i < 9; i++) await insertCompetitorTx(d1, i, 'MANUAL-A', 'executive', `2025-0${(i % 9) + 1}-10`);
      await insertCompetitorTx(d1, 99, 'MANUAL-A', 'house', '2024-01-01');
      // 60/40: no declared chamber (below the 80% majority).
      for (let i = 0; i < 6; i++) await insertCompetitorTx(d1, i, 'MANUAL-B', 'house', '2022-01-01');
      for (let i = 10; i < 14; i++) await insertCompetitorTx(d1, i, 'MANUAL-B', 'senate', '2022-06-01');
      // Non-JSON payload rows must not break the aggregate.
      await insertCompetitorTx(d1, 200, 'MANUAL-C', null, '2023-03-03', 'not json at all');
      // Rows on other filers / sources are ignored.
      await insertCompetitorTx(d1, 300, 'house-real', 'executive', '2026-01-01');

      const ev = await loadIdentityEvidence({ DB: d1 } as unknown as Env);
      expect(ev.payloadChamber?.get('MANUAL-A')).toBe('executive');
      expect(ev.payloadChamber?.has('MANUAL-B')).toBe(false);
      expect(ev.payloadChamber?.has('MANUAL-C')).toBe(false);
      expect(ev.latestTxDate?.get('MANUAL-A')).toBe('2025-09-10');
      expect(ev.latestTxDate?.get('MANUAL-C')).toBe('2023-03-03');
      expect(ev.latestTxDate?.has('house-real')).toBe(false);
    } finally {
      close();
    }
  });

  it('end to end: corrects the chamber, then the dedupe pass merges the phantom into the real filer and the EXEC twin', async () => {
    const { d1, db, close } = await openMigratedD1();
    try {
      stubRoster(ROSTER);
      const ins = (id: string, chamber: string, name: string, state: string | null, district: string | null, resolved: string | null) =>
        d1
          .prepare('INSERT INTO filers (bioguide_id, chamber, full_name, state, district, resolved_bioguide_id) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(id, chamber, name, state, district, resolved)
          .run();
      await ins('house-oh04-james-d-jordan', 'house', 'James D. Jordan', 'OH', '4', 'J000289');
      await ins('MANUAL-JORDAN', 'senate', 'Jim Jordan', 'OH', '4', 'J000289');
      await ins('EXEC-DOUGLAS-J-BURGUM', 'executive', 'Douglas J Burgum', null, null, null);
      await ins('MANUAL-BURGUM', 'senate', 'Douglas J Burgum', null, null, null);
      for (let i = 0; i < 3; i++) {
        await d1
          .prepare("INSERT INTO transactions (id, doc_id, filer_id, tx_date, source) VALUES (?, ?, 'house-oh04-james-d-jordan', '2026-01-01', 'primary')")
          .bind(`hj-${i}`, `doc-hj-${i}`)
          .run();
      }
      for (let i = 0; i < 5; i++) await insertCompetitorTx(d1, i, 'MANUAL-BURGUM', 'executive', '2025-06-01');
      await insertCompetitorTx(d1, 0, 'MANUAL-JORDAN', 'house', '2025-06-01');

      const env = { DB: d1 } as unknown as Env;
      const dry = await runIdentitySync(env, { dryRun: true });
      expect(dry.chambersCorrected).toBe(2);
      expect(
        (db.prepare("SELECT chamber FROM filers WHERE bioguide_id = 'MANUAL-BURGUM'").get() as { chamber: string }).chamber,
      ).toBe('senate');

      const result = await runIdentitySync(env);
      expect(result.chambersCorrected).toBe(2);

      // runIdentitySync's trailing dedupe already merged both phantoms.
      const alias = (id: string) =>
        db.prepare('SELECT merged_into FROM filers WHERE bioguide_id = ?').get(id) as { merged_into: string | null };
      expect(alias('MANUAL-JORDAN').merged_into).toBe('house-oh04-james-d-jordan');
      // The canonical id is the real EXEC-* id (it carries the curated title), not the MANUAL-* one that has more transactions.
      expect(alias('MANUAL-BURGUM').merged_into).toBe('EXEC-DOUGLAS-J-BURGUM');
      const owners = db.prepare("SELECT DISTINCT filer_id FROM transactions WHERE filer_id IN ('MANUAL-BURGUM','EXEC-DOUGLAS-J-BURGUM')").all();
      expect(owners).toEqual([{ filer_id: 'EXEC-DOUGLAS-J-BURGUM' }]);

      // Idempotent.
      const again = await dedupeSplitFilerIdentities(env);
      expect(again.clustersFound).toBe(0);
    } finally {
      close();
    }
  });
});
