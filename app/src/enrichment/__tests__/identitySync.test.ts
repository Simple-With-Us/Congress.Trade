/**
 * src/enrichment/__tests__/identitySync.test.ts
 *
 * Unit + integration tests for the bioguide-driven identity sync: primary
 * (first-last/nickname-last/official_full) and fallback (state-gated
 * first+last-token) bioguide resolution, display_name computation (legislator
 * official_full for resolved filers, best-effort cleanup for unresolved
 * ones), authoritative party/state/district overwrite, and the write path.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  planIdentitySync,
  fallbackCleanDisplayName,
  runIdentitySync,
  type IdentityFilerRow,
} from '../identitySync.ts';
import {
  indexLegislators,
  indexLegislatorFallback,
  indexLegislatorsByBioguide,
  LEGISLATOR_SOURCES,
  type Legislator,
  type LegislatorIndexes,
} from '../legislators.ts';
import { openMigratedD1 } from '../../prices/__tests__/sqliteD1.ts';
import type { Env } from '../../shared/types.ts';

// A representative slice of congress-legislators-shaped fixture data covering
// each resolution path this module must exercise: direct primary match,
// nickname-carrying primary match, a state-gated fallback match (both the
// parenthetical-nickname legal name and a multi-word surname), two same-named
// people needing state disambiguation, and two negative controls (people
// who must NOT cross-match each other despite a shared last name/substring).
//
// M000355 and C001098 below are copied VERBATIM from the live
// https://unitedstates.github.io/congress-legislators/legislators-current.json
// `name` objects (fetched 2026-08-10) — no "middle"/"nickname" field exists
// for either in the real data (McConnell has no middle field at all; Cruz's
// "first" is literally "Ted", not a nickname pointing at a separate legal
// first name). A prior version of this fixture invented a "Mitchell"/"Mitch"
// nickname split and a "Rafael"/"Ted" first/nickname split that do not exist
// in the real feed — see the debug findings in identitySync.ts's module doc
// comment and the curated MEMBER_NAME_ALIASES entries in
// shared/memberIdentity.ts this real shape now requires.
const FIXTURE_LEGISLATORS: Legislator[] = [
  {
    id: { bioguide: 'M000355' },
    name: { first: 'Mitch', last: 'McConnell', official_full: 'Mitch McConnell' },
    terms: [{ type: 'sen', party: 'Republican', state: 'KY', start: '2021-01-03' }],
  },
  {
    id: { bioguide: 'C001098' },
    name: { first: 'Ted', last: 'Cruz', official_full: 'Ted Cruz' },
    terms: [{ type: 'sen', party: 'Republican', state: 'TX', start: '2019-01-03' }],
  },
  {
    id: { bioguide: 'C001075' },
    name: { first: 'Bill', last: 'Cassidy', official_full: 'Bill Cassidy' },
    terms: [{ type: 'sen', party: 'Republican', state: 'LA', start: '2021-01-03' }],
  },
  {
    id: { bioguide: 'S001198' },
    name: { first: 'Dan', last: 'Sullivan', official_full: 'Dan Sullivan' },
    terms: [{ type: 'sen', party: 'Republican', state: 'AK', start: '2021-01-03' }],
  },
  {
    id: { bioguide: 'U000039' },
    name: { first: 'Tom', middle: 'S.', last: 'Udall', official_full: 'Tom Udall' },
    terms: [{ type: 'sen', party: 'Democrat', state: 'NM', start: '2015-01-03', end: '2021-01-03' }],
  },
  {
    id: { bioguide: 'R000608' },
    name: { first: 'Jacky', last: 'Rosen', official_full: 'Jacky Rosen' },
    terms: [{ type: 'sen', party: 'Democrat', state: 'NV', start: '2019-01-03' }],
  },
  {
    id: { bioguide: 'B001299' },
    name: { first: 'Jim', last: 'Banks', official_full: 'Jim Banks' },
    terms: [{ type: 'sen', party: 'Republican', state: 'IN', start: '2023-01-03' }],
  },
  {
    // Negative-control target: same surname as no one else in this fixture
    // set, but must NOT be matched by an unrelated first name ("George")
    // sharing that surname — there is no diminutive or curated-alias bridge
    // from "George" to "David", so this must stay a last-name-only miss.
    id: { bioguide: 'P000612' },
    name: { first: 'David', last: 'Perdue', official_full: 'David Perdue' },
    terms: [{ type: 'sen', party: 'Republican', state: 'GA', start: '2015-01-03', end: '2021-01-03' }],
  },
  {
    id: { bioguide: 'V000139' },
    name: { first: 'Matthew', last: 'Van Epps', official_full: 'Matt Van Epps', nickname: 'Matt' },
    terms: [{ type: 'rep', party: 'Republican', state: 'TN', district: 7, start: '2025-01-03' }],
  },
  {
    id: { bioguide: 'G000596' },
    name: { first: 'Marjorie', last: 'Greene', official_full: 'Marjorie Taylor Greene' },
    terms: [{ type: 'rep', party: 'Republican', state: 'GA', district: 14, start: '2021-01-03' }],
  },
  {
    id: { bioguide: 'G000545' },
    name: { first: 'Mark', last: 'Green', official_full: 'Mark Green' },
    terms: [{ type: 'rep', party: 'Republican', state: 'TN', district: 7, start: '2019-01-03' }],
  },
  {
    id: { bioguide: 'D000212' },
    name: { first: 'John', last: 'Delaney', official_full: 'John Delaney' },
    terms: [{ type: 'rep', party: 'Democrat', state: 'MD', district: 6, start: '2013-01-03' }],
  },
  {
    id: { bioguide: 'M001232' },
    name: { first: 'April', last: 'Delaney', official_full: 'April McClain Delaney' },
    terms: [{ type: 'rep', party: 'Democrat', state: 'MD', district: 6, start: '2025-01-03' }],
  },
  {
    id: { bioguide: 'M001242' },
    name: { first: 'Bernardo', last: 'Moreno', official_full: 'Bernie Moreno', nickname: 'Bernie' },
    terms: [{ type: 'sen', party: 'Republican', state: 'OH', start: '2025-01-03' }],
  },
  {
    id: { bioguide: 'T000476' },
    name: { first: 'Thomas', last: 'Tillis', official_full: 'Thom Tillis', nickname: 'Thom' },
    terms: [{ type: 'sen', party: 'Republican', state: 'NC', start: '2015-01-03' }],
  },
  // No official_full, no nickname — exercises the "first last" display-name fallback.
  {
    id: { bioguide: 'X000900' },
    name: { first: 'Pat', last: 'Nolastnamefallback' },
    terms: [{ type: 'rep', party: 'Independent', state: 'VT', district: 0, start: '2021-01-03' }],
  },
];

function indexesFrom(list: readonly Legislator[]): LegislatorIndexes {
  return {
    primary: indexLegislators(list),
    fallback: indexLegislatorFallback(list),
    byBioguide: indexLegislatorsByBioguide(list),
  };
}

function row(overrides: Partial<IdentityFilerRow>): IdentityFilerRow {
  return {
    bioguide_id: 'x',
    chamber: 'house',
    full_name: null,
    party: null,
    state: null,
    district: null,
    resolved_bioguide_id: null,
    display_name: null,
    ...overrides,
  };
}

describe('planIdentitySync — primary map resolution', () => {
  const indexes = indexesFrom(FIXTURE_LEGISLATORS);

  it('resolves a legal-name variant with embedded suffix/initial via the curated MEMBER_NAME_ALIASES entry (no middle field in the real data) and sets the campaign-sign display name', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'senate-a-mitchell-jr-mcconnell', full_name: 'A. Mitchell Jr. McConnell', chamber: 'senate', state: 'KY' })],
      indexes,
    );
    expect(plan.bioguideResolved).toBe(1);
    expect(plan.displayNamesSet).toBe(1);
    const change = plan.changes[0];
    expect(change.after.resolved_bioguide_id).toBe('M000355');
    expect(change.after.display_name).toBe('Mitch McConnell');
    expect(change.after.party).toBe('Republican');
    expect(change.after.state).toBe('KY');
    expect(change.after.district).toBeNull();
  });

  it('resolves the legal first name via the curated MEMBER_NAME_ALIASES entry (real data has no "Rafael" anywhere on Ted Cruz\'s record)', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'seed-senate-rafael-e-cruz', full_name: 'Rafael E Cruz', chamber: 'senate', state: 'TX' })],
      indexes,
    );
    expect(plan.changes[0]?.after.resolved_bioguide_id).toBe('C001098');
    expect(plan.changes[0]?.after.display_name).toBe('Ted Cruz');
  });

  it('does not cross-match Marjorie Taylor Greene with Mark Green', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'house-ga14-marjorie-taylor-greene', full_name: 'Marjorie Taylor Greene', chamber: 'house', state: 'GA' })],
      indexes,
    );
    expect(plan.changes[0]?.after.resolved_bioguide_id).toBe('G000596');
    expect(plan.changes[0]?.after.resolved_bioguide_id).not.toBe('G000545');
  });

  it('does not cross-match April McClain Delaney with John Delaney', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'house-md06-april-mcclain-delaney', full_name: 'April McClain Delaney', chamber: 'house', state: 'MD' })],
      indexes,
    );
    expect(plan.changes[0]?.after.resolved_bioguide_id).toBe('M001232');
    expect(plan.changes[0]?.after.resolved_bioguide_id).not.toBe('D000212');
  });

  it('resolves the legal first name directly (Bernardo -> Bernie Moreno) and prefers official_full for display', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'senate-bernardo-moreno', full_name: 'Bernardo Moreno', chamber: 'senate', state: 'OH' })],
      indexes,
    );
    expect(plan.changes[0]?.after.resolved_bioguide_id).toBe('M001242');
    expect(plan.changes[0]?.after.display_name).toBe('Bernie Moreno');
  });

  it('falls back to "first last" for the display name when official_full and nickname are both missing', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'house-vt00-pat-x', full_name: 'Pat Nolastnamefallback', chamber: 'house', state: 'VT' })],
      indexes,
    );
    expect(plan.changes[0]?.after.display_name).toBe('Pat Nolastnamefallback');
  });

  it('does not attempt bioguide backfill for executive-chamber filers even when the name would otherwise match', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'EXEC-SOMETHING', full_name: 'Mitch McConnell', chamber: 'executive' })],
      indexes,
    );
    expect(plan.bioguideResolved).toBe(0);
    expect(plan.unresolved).toBe(1);
  });
});

// Production dryRun miss report (#1654-follow-up): 275 unresolved filers, only
// 37 gained a bioguide. Debugging against the REAL live congress-legislators
// JSON (see legislators.ts's DIMINUTIVE_GROUPS doc comment) found two
// distinct root causes:
//   - Cassidy/Sullivan/Udall/Rosen/Banks: the filing carries the member's
//     formal/legal first name ("William", "Daniel", "Thomas", "Jacklyn",
//     "James") while congress-legislators indexes them under the informal
//     name they go by ("Bill", "Dan", "Tom", "Jacky", "Jim") — a genuine
//     diminutive gap, fixed generically by legislators.diminutiveKeyVariants
//     retried through the state-gated fallback index.
//   - Cruz/McConnell: NOT a diminutive gap — "Rafael"/"Ted" and
//     "Mitchell"/"Mitch" share no lexical root, AND (confirmed against the
//     live JSON) neither member's record carries any field linking their
//     legal first/middle name to the short name congress-legislators uses.
//     No generic key-derivation can produce these; they're covered by the
//     curated MEMBER_NAME_ALIASES allow-list in shared/memberIdentity.ts
//     instead (see the primary-map describe block above for those two).
describe('planIdentitySync — diminutive-bridged fallback resolution (real name records)', () => {
  const indexes = indexesFrom(FIXTURE_LEGISLATORS);

  it('resolves "William Cassidy" -> Bill Cassidy via the diminutive-retried fallback key', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'x', full_name: 'William Cassidy', chamber: 'senate', state: 'LA' })],
      indexes,
    );
    expect(plan.changes[0]?.after.resolved_bioguide_id).toBe('C001075');
    expect(plan.changes[0]?.after.display_name).toBe('Bill Cassidy');
  });

  it('resolves "Daniel S Sullivan" -> Dan Sullivan via the diminutive-retried fallback key', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'x', full_name: 'Daniel S Sullivan', chamber: 'senate', state: 'AK' })],
      indexes,
    );
    expect(plan.changes[0]?.after.resolved_bioguide_id).toBe('S001198');
    expect(plan.changes[0]?.after.display_name).toBe('Dan Sullivan');
  });

  it('resolves "Thomas Udall" -> Tom Udall via the diminutive-retried fallback key', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'x', full_name: 'Thomas Udall', chamber: 'senate', state: 'NM' })],
      indexes,
    );
    expect(plan.changes[0]?.after.resolved_bioguide_id).toBe('U000039');
    expect(plan.changes[0]?.after.display_name).toBe('Tom Udall');
  });

  it('resolves "Jacklyn S Rosen" -> Jacky Rosen via the diminutive-retried fallback key', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'x', full_name: 'Jacklyn S Rosen', chamber: 'senate', state: 'NV' })],
      indexes,
    );
    expect(plan.changes[0]?.after.resolved_bioguide_id).toBe('R000608');
    expect(plan.changes[0]?.after.display_name).toBe('Jacky Rosen');
  });

  it('resolves "James E Banks" -> Jim Banks via the diminutive-retried fallback key', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'x', full_name: 'James E Banks', chamber: 'senate', state: 'IN' })],
      indexes,
    );
    expect(plan.changes[0]?.after.resolved_bioguide_id).toBe('B001299');
    expect(plan.changes[0]?.after.display_name).toBe('Jim Banks');
  });

  it('does NOT resolve "George E Perdue" to David Perdue — same surname, unrelated first name, no diminutive or alias bridge', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'x', full_name: 'George E Perdue', chamber: 'senate', state: 'GA' })],
      indexes,
    );
    expect(plan.bioguideResolved).toBe(0);
    expect(plan.changes.some((c) => c.after.resolved_bioguide_id === 'P000612')).toBe(false);
  });

  it('still does not resolve "George E Perdue" when the state is absent', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'x', full_name: 'George E Perdue', chamber: 'senate', state: null })],
      indexes,
    );
    expect(plan.bioguideResolved).toBe(0);
  });
});

describe('planIdentitySync — state-gated fallback resolution', () => {
  const indexes = indexesFrom(FIXTURE_LEGISLATORS);

  it('resolves a parenthetical-nickname legal name via the fallback key when the state matches', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'seed-senate-rafael-edward-ted-cruz', full_name: 'Rafael Edward (Ted) Cruz', chamber: 'senate', state: 'TX' })],
      indexes,
    );
    expect(plan.changes[0]?.after.resolved_bioguide_id).toBe('C001098');
  });

  it('resolves the same name with no state on file when the fallback key is unambiguous', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'x', full_name: 'Rafael Edward (Ted) Cruz', chamber: 'senate', state: null })],
      indexes,
    );
    expect(plan.changes[0]?.after.resolved_bioguide_id).toBe('C001098');
  });

  it('refuses the fallback match when the filer state does not match', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'x', full_name: 'Rafael Edward (Ted) Cruz', chamber: 'senate', state: 'OH' })],
      indexes,
    );
    expect(plan.bioguideResolved).toBe(0);
  });

  it('resolves a multi-word surname via the last-two-tokens fallback key ("Van Epps")', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'house-tn07-matthew-robert-van-epps', full_name: 'Matthew Robert Van Epps', chamber: 'house', state: 'TN' })],
      indexes,
    );
    expect(plan.changes[0]?.after.resolved_bioguide_id).toBe('V000139');
    expect(plan.changes[0]?.after.display_name).toBe('Matt Van Epps');
    expect(plan.changes[0]?.after.district).toBe('7');
  });

  it('also resolves the multi-word surname with no state on file (unambiguous key)', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'x', full_name: 'Matthew Robert Van Epps', chamber: 'house', state: null })],
      indexes,
    );
    expect(plan.changes[0]?.after.resolved_bioguide_id).toBe('V000139');
  });
});

describe('planIdentitySync — fallback ambiguity (two legislators sharing a key)', () => {
  // Deliberately identical first/last so BOTH candidates land under the same
  // fallback key ("sam cole") when a filer's raw name carries an extra
  // middle name/word neither of their official_full strings contains.
  const AMBIGUOUS: Legislator[] = [
    {
      id: { bioguide: 'X000001' },
      name: { first: 'Sam', last: 'Cole', official_full: 'Sam Cole' },
      terms: [{ type: 'rep', party: 'R', state: 'AZ', district: 1, start: '2021-01-03' }],
    },
    {
      id: { bioguide: 'X000002' },
      name: { first: 'Sam', last: 'Cole', official_full: 'Sam Cole' },
      terms: [{ type: 'rep', party: 'D', state: 'CA', district: 2, start: '2021-01-03' }],
    },
  ];
  const indexes = indexesFrom(AMBIGUOUS);

  it('resolves to the one candidate whose state matches', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'x', full_name: 'Sam Middleton Cole', chamber: 'house', state: 'AZ' })],
      indexes,
    );
    expect(plan.changes[0]?.after.resolved_bioguide_id).toBe('X000001');
  });

  it('does not resolve when the filer has no state and both candidates share the key', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'x', full_name: 'Sam Middleton Cole', chamber: 'house', state: null })],
      indexes,
    );
    expect(plan.bioguideResolved).toBe(0);
  });

  it('does not resolve when the filer state matches neither candidate', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'x', full_name: 'Sam Middleton Cole', chamber: 'house', state: 'TX' })],
      indexes,
    );
    expect(plan.bioguideResolved).toBe(0);
  });
});

describe('planIdentitySync — authoritative fields + never-overwrite', () => {
  const indexes = indexesFrom(FIXTURE_LEGISLATORS);

  it('overwrites party/state/district for an already-resolved filer, fixing bad MANUAL-* metadata', () => {
    const plan = planIdentitySync(
      [
        row({
          bioguide_id: 'MANUAL-DELANEY',
          full_name: 'John Delaney',
          display_name: 'John Delaney', // already correct — isolates this case to fields-only
          chamber: 'house',
          state: 'NY',
          district: '7',
          resolved_bioguide_id: 'D000212',
        }),
      ],
      indexes,
    );
    expect(plan.bioguideResolved).toBe(0); // already resolved — not a new backfill
    expect(plan.displayNamesSet).toBe(0);
    expect(plan.fieldsBackfilled).toBe(1);
    const change = plan.changes[0];
    expect(change.kind).toBe('fields');
    expect(change.after.state).toBe('MD');
    expect(change.after.district).toBe('6');
  });

  it('forces district to NULL for a resolved senator even if a stray value was stored', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'x', full_name: 'Thom Tillis', chamber: 'senate', state: 'NC', district: '5' })],
      indexes,
    );
    expect(plan.changes[0]?.after.district).toBeNull();
  });

  it('never overwrites an existing resolved_bioguide_id, even if the stored name textually keys to someone else', () => {
    const plan = planIdentitySync(
      [row({ bioguide_id: 'weird', full_name: 'Ted Cruz', chamber: 'senate', state: 'TX', resolved_bioguide_id: 'M000355' })],
      indexes,
    );
    expect(plan.changes.some((c) => c.after.resolved_bioguide_id && c.after.resolved_bioguide_id !== 'M000355')).toBe(false);
    expect(plan.bioguideResolved).toBe(0);
  });

  it('is idempotent: a second pass over already-correct rows produces no changes', () => {
    const first = planIdentitySync(
      [row({ bioguide_id: 'x', full_name: 'Thom Tillis', chamber: 'senate', state: 'NC' })],
      indexes,
    );
    const after = first.changes[0].after;
    const second = planIdentitySync(
      [
        row({
          bioguide_id: 'x',
          full_name: 'Thom Tillis',
          chamber: 'senate',
          party: after.party ?? null,
          state: after.state ?? null,
          district: after.district ?? null,
          resolved_bioguide_id: after.resolved_bioguide_id ?? null,
          display_name: after.display_name ?? null,
        }),
      ],
      indexes,
    );
    expect(second.changes).toEqual([]);
  });
});

describe('fallbackCleanDisplayName', () => {
  it('strips a "YYYY ERM" suffix', () => {
    expect(fallbackCleanDisplayName('Barbara M Barrett 2021 ERM')).toBe('Barbara M Barrett');
  });

  it('strips a dotted date fragment', () => {
    expect(fallbackCleanDisplayName('Alice Albright 10.24..2022')).toBe('Alice Albright');
  });

  it('flips "Last [multi-word], First" even when the last-name chunk has an embedded suffix', () => {
    expect(fallbackCleanDisplayName('Justice II, James Conley')).toBe('James Conley Justice II');
  });

  it('normalizes a Jr suffix comma without flipping name order', () => {
    // "or similar sane form": the middle-initial period is not part of the
    // documented rule set, so this only pins name order + suffix punctuation.
    const result = fallbackCleanDisplayName('David A Perdue , Jr');
    expect(result).toMatch(/^David A\.? Perdue, Jr\.$/);
    expect(result).not.toMatch(/,\s*$/);
  });

  it('normalizes a roman-numeral suffix without a comma', () => {
    expect(fallbackCleanDisplayName('Joseph Manchin, Iii')).toBe('Joseph Manchin III');
  });

  it('returns null for a blank name', () => {
    expect(fallbackCleanDisplayName(' ')).toBeNull();
    expect(fallbackCleanDisplayName('')).toBeNull();
    expect(fallbackCleanDisplayName(null)).toBeNull();
  });

  it('title-cases an ALL-CAPS name', () => {
    expect(fallbackCleanDisplayName('NEAL PATRICK DUNN')).toBe('Neal Patrick Dunn');
  });

  it('strips a bare ERM token without a year', () => {
    expect(fallbackCleanDisplayName('Adewale Adeyemo ERM')).toBe('Adewale Adeyemo');
  });

  it('drops empty parens left behind by other cleanup', () => {
    expect(fallbackCleanDisplayName('Elisabeth (Betsy) P DeVos')).toContain('Betsy');
  });
});

describe('runIdentitySync (integration, in-memory D1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubLegislatorFetch(list: Legislator[]) {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === LEGISLATOR_SOURCES[0]) {
        return new Response(JSON.stringify(list), { status: 200 });
      }
      if (url === LEGISLATOR_SOURCES[1]) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchImpl);
    return fetchImpl;
  }

  it('dryRun reports the plan and writes nothing', async () => {
    const { d1, close } = await openMigratedD1();
    try {
      stubLegislatorFetch(FIXTURE_LEGISLATORS);
      await d1
        .prepare(
          "INSERT INTO filers (bioguide_id, chamber, full_name, party, state, district, resolved_bioguide_id) " +
            "VALUES ('senate-a-mitchell-jr-mcconnell', 'senate', 'A. Mitchell Jr. McConnell', NULL, 'KY', NULL, NULL)",
        )
        .run();
      const env = { DB: d1 } as unknown as Env;

      const result = await runIdentitySync(env, { dryRun: true });
      expect(result.dryRun).toBe(true);
      expect(result.bioguideResolved).toBe(1);
      expect(result.sample?.[0]?.after.resolved_bioguide_id).toBe('M000355');

      const row = await d1
        .prepare('SELECT resolved_bioguide_id, display_name FROM filers WHERE bioguide_id = ?')
        .bind('senate-a-mitchell-jr-mcconnell')
        .first<{ resolved_bioguide_id: string | null; display_name: string | null }>();
      expect(row!.resolved_bioguide_id).toBeNull();
      expect(row!.display_name).toBeNull();
    } finally {
      close();
    }
  });

  it('writes resolved_bioguide_id, display_name, and authoritative fields; blank name stays NULL; is idempotent', async () => {
    const { d1, close } = await openMigratedD1();
    try {
      stubLegislatorFetch(FIXTURE_LEGISLATORS);
      await d1
        .prepare(
          "INSERT INTO filers (bioguide_id, chamber, full_name, party, state, district, resolved_bioguide_id) " +
            "VALUES ('senate-a-mitchell-jr-mcconnell', 'senate', 'A. Mitchell Jr. McConnell', NULL, 'KY', NULL, NULL)",
        )
        .run();
      await d1
        .prepare(
          "INSERT INTO filers (bioguide_id, chamber, full_name, party, state, district, resolved_bioguide_id) " +
            "VALUES ('MANUAL-', 'house', ' ', NULL, NULL, NULL, NULL)",
        )
        .run();
      await d1
        .prepare(
          "INSERT INTO filers (bioguide_id, chamber, full_name, party, state, district, resolved_bioguide_id) " +
            "VALUES ('EXEC-BARBARA-M-BARRETT-2021-ERM', 'executive', 'Barbara M Barrett 2021 ERM', NULL, NULL, NULL, NULL)",
        )
        .run();

      const env = { DB: d1 } as unknown as Env;
      const result = await runIdentitySync(env);
      expect(result.dryRun).toBe(false);
      expect(result.bioguideResolved).toBe(1);
      // Only Barrett produces an actual change — the blank filer's cleaned
      // value is NULL, same as its already-NULL display_name, so it's a no-op.
      expect(result.cleaned).toBe(1);
      expect(result.unresolved).toBe(2);

      const mcconnell = await d1
        .prepare('SELECT resolved_bioguide_id, display_name, party, state, district FROM filers WHERE bioguide_id = ?')
        .bind('senate-a-mitchell-jr-mcconnell')
        .first<{ resolved_bioguide_id: string; display_name: string; party: string; state: string; district: string | null }>();
      expect(mcconnell!.resolved_bioguide_id).toBe('M000355');
      expect(mcconnell!.display_name).toBe('Mitch McConnell');
      expect(mcconnell!.party).toBe('Republican');
      expect(mcconnell!.state).toBe('KY');
      expect(mcconnell!.district).toBeNull();

      const blank = await d1
        .prepare('SELECT display_name FROM filers WHERE bioguide_id = ?')
        .bind('MANUAL-')
        .first<{ display_name: string | null }>();
      expect(blank!.display_name).toBeNull();

      const barrett = await d1
        .prepare('SELECT display_name FROM filers WHERE bioguide_id = ?')
        .bind('EXEC-BARBARA-M-BARRETT-2021-ERM')
        .first<{ display_name: string | null }>();
      expect(barrett!.display_name).toBe('Barbara M Barrett');

      // Re-run: same fixtures, nothing left to change.
      const second = await runIdentitySync(env);
      expect(second.bioguideResolved).toBe(0);
      expect(second.displayNamesSet).toBe(0);
      expect(second.fieldsBackfilled).toBe(0);
      expect(second.cleaned).toBe(0);
    } finally {
      close();
    }
  });
});
