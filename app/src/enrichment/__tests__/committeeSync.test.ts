/**
 * src/enrichment/__tests__/committeeSync.test.ts
 *
 * Unit tests for the committee-membership sync: committees-current +
 * committee-membership-current parsing, subcommittee rollup/dedupe, that the
 * resulting display names actually hit conflicts.ts's curated
 * committee->sector matcher, and the update-plan logic (skip unchanged /
 * unmatched, only touch resolved_bioguide_id filers).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  buildCommitteeIndex,
  buildBioguideCommitteeMap,
  planCommitteeUpdates,
  fetchBioguideCommitteeMap,
  runCommitteeSync,
  parseHouseClerkMemberData,
  mergeBioguideCommitteeMaps,
  effectiveBioguide,
  COMMITTEES_CURRENT_URL,
  COMMITTEE_MEMBERSHIP_URL,
  HOUSE_CLERK_MEMBER_DATA_URL,
  type CommitteeRecord,
  type CommitteeMembershipMap,
  type FilerCommitteeRow,
} from '../committeeSync.ts';
import { committeeConflict, oversightSectors } from '../../analytics/conflicts.ts';
import { openMigratedD1 } from '../../prices/__tests__/sqliteD1.ts';
import type { Env } from '../../shared/types.ts';

// A trimmed-but-real-shaped fixture: a few top-level committees (one with a
// subcommittee), mirroring committees-current.json's actual field names.
const FIXTURE_COMMITTEES: CommitteeRecord[] = [
  {
    type: 'house',
    name: 'House Committee on Agriculture',
    thomas_id: 'HSAG',
    house_committee_id: 'AG',
    subcommittees: [{ thomas_id: '15', name: 'Forestry and Horticulture' }],
  },
  {
    type: 'house',
    name: 'House Committee on Financial Services',
    thomas_id: 'HSBA',
    house_committee_id: 'BA',
    subcommittees: [{ thomas_id: '20', name: 'Capital Markets' }],
  },
  {
    type: 'house',
    name: 'House Committee on the Judiciary',
    thomas_id: 'HSJU',
    house_committee_id: 'JU',
  },
  {
    type: 'senate',
    name: 'Senate Committee on Armed Services',
    thomas_id: 'SSAS',
  },
  {
    type: 'senate',
    name: 'Senate Committee on Finance',
    thomas_id: 'SSFI',
  },
  // Missing thomas_id/name — must be skipped, not crash.
  { type: 'joint', name: undefined, thomas_id: 'JUNK' } as unknown as CommitteeRecord,
];

// Membership keyed the way committee-membership-current.json actually is:
// top-level thomas_id for full-committee members, thomas_id+subcommittee
// thomas_id for subcommittee-only members.
const FIXTURE_MEMBERSHIP: CommitteeMembershipMap = {
  HSAG: [
    { name: 'Jane Farmer', bioguide: 'F000111', party: 'majority', rank: 1, title: 'Chair' },
    { name: 'Sam Rancher', bioguide: 'R000222' },
  ],
  HSAG15: [
    // Subcommittee-only membership for someone NOT on the full committee list
    // above — still must roll up to "House Committee on Agriculture".
    { name: 'Pat Forester', bioguide: 'F000333' },
    // Also appears on the full committee (HSAG) — must dedupe to one name.
    { name: 'Jane Farmer', bioguide: 'F000111' },
  ],
  HSBA: [{ name: 'Alex Banker', bioguide: 'B000444' }],
  HSBA20: [{ name: 'Alex Banker', bioguide: 'B000444' }],
  SSAS: [{ name: 'Chris Colonel', bioguide: 'C000555' }],
  SSFI: [{ name: 'Alex Banker', bioguide: 'B000444' }], // sits on two committees
  // A key with no corresponding committee record (stale/unmapped) — skipped.
  ZZZZ: [{ name: 'Nobody', bioguide: 'N000999' }],
  // A member entry missing bioguide — skipped, not crash.
  HSFAKE: [{ name: 'No Bioguide' }] as never,
};

function fixtureMap(): Map<string, string[]> {
  const index = buildCommitteeIndex(FIXTURE_COMMITTEES);
  return buildBioguideCommitteeMap(FIXTURE_MEMBERSHIP, index);
}

describe('buildCommitteeIndex', () => {
  it('indexes top-level committees and rolls subcommittee keys up to their parent thomas_id', () => {
    const index = buildCommitteeIndex(FIXTURE_COMMITTEES);
    expect(index.nameByThomasId.get('HSAG')).toBe('House Committee on Agriculture');
    expect(index.parentThomasIdByKey.get('HSAG')).toBe('HSAG');
    expect(index.parentThomasIdByKey.get('HSAG15')).toBe('HSAG');
    expect(index.parentThomasIdByKey.get('HSBA20')).toBe('HSBA');
    expect(index.parentThomasIdByKey.has('JUNK')).toBe(false); // no name -> skipped
  });
});

describe('buildBioguideCommitteeMap', () => {
  it('rolls subcommittee memberships up to the parent committee display name', () => {
    const map = fixtureMap();
    // Subcommittee-only member still gets the parent committee name.
    expect(map.get('F000333')).toEqual(['House Committee on Agriculture']);
  });

  it('dedupes when a member appears on both the full committee and its subcommittee', () => {
    const map = fixtureMap();
    expect(map.get('F000111')).toEqual(['House Committee on Agriculture']);
    expect(map.get('B000444')).toEqual(
      ['House Committee on Financial Services', 'Senate Committee on Finance'].slice().sort(),
    );
  });

  it('sorts the output names deterministically', () => {
    const map = fixtureMap();
    const names = map.get('B000444')!;
    expect(names).toEqual([...names].sort());
  });

  it('skips membership keys with no matching committee record', () => {
    const map = fixtureMap();
    expect(map.has('N000999')).toBe(false);
  });

  it('skips member entries with no bioguide id', () => {
    const map = fixtureMap();
    for (const names of map.values()) {
      expect(names).not.toContain('No Bioguide');
    }
  });
});

describe('committee names match conflicts.ts COMMITTEE_SECTOR_RULES', () => {
  it('a real Financial Services member is flagged for a Financials-sector trade', () => {
    const map = fixtureMap();
    const committees = map.get('B000444')!; // Financial Services + Finance
    const result = committeeConflict(committees, 'Financials');
    expect(result.conflict).toBe(true);
    expect(result.viaCommittees.length).toBeGreaterThan(0);
  });

  it('a real Armed Services member is flagged for an Industrials-sector trade', () => {
    const map = fixtureMap();
    const committees = map.get('C000555')!;
    expect(oversightSectors(committees).has('Industrials')).toBe(true);
    expect(committeeConflict(committees, 'Industrials').conflict).toBe(true);
  });

  it('does not false-positive Senate Finance against "Financials" leaking into unrelated sectors', () => {
    // Senate Finance oversees Health Care + Financials per the curated map —
    // a Materials-sector trade should NOT be flagged via Finance alone.
    const map = fixtureMap();
    const financeOnly = ['Senate Committee on Finance'];
    expect(committeeConflict(financeOnly, 'Materials').conflict).toBe(false);
    expect(committeeConflict(financeOnly, 'Financials').conflict).toBe(true);
  });

  it('an Agriculture committee member (full + subcommittee rollup) matches the agriculture rule', () => {
    const map = fixtureMap();
    const committees = map.get('F000111')!;
    expect(committeeConflict(committees, 'Consumer Staples').conflict).toBe(true);
  });
});

describe('planCommitteeUpdates', () => {
  const bioguideMap = new Map<string, string[]>([
    ['B000444', ['House Committee on Financial Services', 'Senate Committee on Finance']],
    ['C000555', ['Senate Committee on Armed Services']],
  ]);

  it('produces an update for a resolved filer whose stored committees differ', () => {
    const filers: FilerCommitteeRow[] = [
      { bioguide_id: 'house-x1-alex-banker', resolved_bioguide_id: 'B000444', committees: '[]' },
    ];
    const plan = planCommitteeUpdates(filers, bioguideMap);
    expect(plan.updates).toEqual([
      {
        filerId: 'house-x1-alex-banker',
        committees: ['House Committee on Financial Services', 'Senate Committee on Finance'],
      },
    ]);
    expect(plan.skipped).toBe(0);
    expect(plan.unmatched).toBe(0);
  });

  it('skips a filer whose stored committees JSON already matches (idempotent re-run)', () => {
    const filers: FilerCommitteeRow[] = [
      {
        bioguide_id: 'senate-armed-chris',
        resolved_bioguide_id: 'C000555',
        committees: JSON.stringify(['Senate Committee on Armed Services']),
      },
    ];
    const plan = planCommitteeUpdates(filers, bioguideMap);
    expect(plan.updates).toEqual([]);
    expect(plan.skipped).toBe(1);
    expect(plan.unmatched).toBe(0);
  });

  it('counts a resolved filer with no memberships as unmatched, not updated', () => {
    const filers: FilerCommitteeRow[] = [
      { bioguide_id: 'house-nobody', resolved_bioguide_id: 'N000000', committees: null },
    ];
    const plan = planCommitteeUpdates(filers, bioguideMap);
    expect(plan.updates).toEqual([]);
    expect(plan.skipped).toBe(0);
    expect(plan.unmatched).toBe(1);
  });

  it('ignores filers with no usable bioguide entirely', () => {
    const filers: FilerCommitteeRow[] = [
      { bioguide_id: 'house-unresolved', resolved_bioguide_id: null, committees: null },
    ];
    const plan = planCommitteeUpdates(filers, bioguideMap);
    expect(plan.updates).toEqual([]);
    expect(plan.skipped).toBe(0);
    expect(plan.unmatched).toBe(0);
    expect(plan.noBioguide).toBe(1);
  });

  it('uses a bioguide-shaped filer PK when resolved_bioguide_id is missing', () => {
    const filers: FilerCommitteeRow[] = [
      { bioguide_id: 'B000444', resolved_bioguide_id: null, committees: null },
    ];
    const plan = planCommitteeUpdates(filers, bioguideMap);
    expect(plan.updates).toEqual([
      {
        filerId: 'B000444',
        committees: ['House Committee on Financial Services', 'Senate Committee on Finance'],
      },
    ]);
    expect(plan.noBioguide).toBe(0);
  });
});

describe('effectiveBioguide', () => {
  it('prefers resolved_bioguide_id over the filer PK', () => {
    expect(
      effectiveBioguide({ bioguide_id: 'house-x', resolved_bioguide_id: 'K000389' }),
    ).toBe('K000389');
  });

  it('falls back to a bioguide-shaped PK', () => {
    expect(effectiveBioguide({ bioguide_id: 'a000372', resolved_bioguide_id: null })).toBe('A000372');
  });

  it('returns null for slug filer ids without a resolved bioguide', () => {
    expect(effectiveBioguide({ bioguide_id: 'house-ca17-ro-khanna', resolved_bioguide_id: null })).toBeNull();
  });
});

describe('parseHouseClerkMemberData + merge', () => {
  const CLERK_XML = `<?xml version="1.0"?>
    <MemberData>
      <members>
        <member>
          <member-info><bioguideID>M001212</bioguideID></member-info>
          <committee-assignments>
            <committee comcode="AG00" rank="15"/>
            <committee comcode="JU00" rank="13"/>
            <subcommittee subcomcode="AG15" rank="2"/>
          </committee-assignments>
        </member>
        <member>
          <member-info><bioguideID>B000444</bioguideID></member-info>
          <committee-assignments>
            <committee comcode="BA00" rank="1"/>
          </committee-assignments>
        </member>
      </members>
    </MemberData>`;

  it('maps Clerk comcodes to congress-legislators display names via house_committee_id', () => {
    const index = buildCommitteeIndex(FIXTURE_COMMITTEES);
    const map = parseHouseClerkMemberData(CLERK_XML, index);
    expect(map.get('M001212')).toEqual([
      'House Committee on Agriculture',
      'House Committee on the Judiciary',
    ]);
    expect(map.get('B000444')).toEqual(['House Committee on Financial Services']);
  });

  it('unions primary + secondary maps without losing either source', () => {
    const primary = new Map<string, string[]>([
      ['B000444', ['Senate Committee on Finance']],
    ]);
    const secondary = new Map<string, string[]>([
      ['B000444', ['House Committee on Financial Services']],
      ['M001212', ['House Committee on Agriculture']],
    ]);
    const merged = mergeBioguideCommitteeMaps(primary, secondary);
    expect(merged.get('B000444')).toEqual([
      'House Committee on Financial Services',
      'Senate Committee on Finance',
    ]);
    expect(merged.get('M001212')).toEqual(['House Committee on Agriculture']);
  });
});

describe('fetchBioguideCommitteeMap', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches congress-legislators + House Clerk and builds the rolled-up map', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === COMMITTEES_CURRENT_URL) {
        return new Response(JSON.stringify(FIXTURE_COMMITTEES), { status: 200 });
      }
      if (url === COMMITTEE_MEMBERSHIP_URL) {
        return new Response(JSON.stringify(FIXTURE_MEMBERSHIP), { status: 200 });
      }
      if (url === HOUSE_CLERK_MEMBER_DATA_URL) {
        return new Response(
          `<MemberData><member><bioguideID>M001212</bioguideID><committee comcode="AG00"/></member></MemberData>`,
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchImpl);

    const map = await fetchBioguideCommitteeMap();
    expect(map.get('C000555')).toEqual(['Senate Committee on Armed Services']);
    expect(map.get('M001212')).toEqual(['House Committee on Agriculture']);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('throws when a primary source URL responds non-OK', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchImpl);
    await expect(fetchBioguideCommitteeMap()).rejects.toThrow(/fetch failed/i);
  });

  it('continues when only the House Clerk secondary source fails', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === COMMITTEES_CURRENT_URL) {
        return new Response(JSON.stringify(FIXTURE_COMMITTEES), { status: 200 });
      }
      if (url === COMMITTEE_MEMBERSHIP_URL) {
        return new Response(JSON.stringify(FIXTURE_MEMBERSHIP), { status: 200 });
      }
      if (url === HOUSE_CLERK_MEMBER_DATA_URL) {
        return new Response('clerk down', { status: 503 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const map = await fetchBioguideCommitteeMap();
    expect(map.get('C000555')).toEqual(['Senate Committee on Armed Services']);
  });
});

describe('runCommitteeSync (integration, in-memory D1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes committees for resolved filers, skips unresolved/unmatched, and is idempotent', async () => {
    const { d1, close } = await openMigratedD1();
    try {
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === COMMITTEES_CURRENT_URL) {
          return new Response(JSON.stringify(FIXTURE_COMMITTEES), { status: 200 });
        }
        if (url === COMMITTEE_MEMBERSHIP_URL) {
          return new Response(JSON.stringify(FIXTURE_MEMBERSHIP), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      });
      vi.stubGlobal('fetch', fetchImpl);

      await d1
        .prepare(
          "INSERT INTO filers (bioguide_id, chamber, full_name, party, state, district, committees, resolved_bioguide_id) " +
            "VALUES ('senate-armed-chris', 'senate', 'Chris Colonel', 'R', 'TX', '', '[]', 'C000555')",
        )
        .run();
      await d1
        .prepare(
          "INSERT INTO filers (bioguide_id, chamber, full_name, party, state, district, committees, resolved_bioguide_id) " +
            "VALUES ('house-unresolved', 'house', 'No Bioguide Yet', 'D', 'CA', '12', NULL, NULL)",
        )
        .run();
      await d1
        .prepare(
          "INSERT INTO filers (bioguide_id, chamber, full_name, party, state, district, committees, resolved_bioguide_id) " +
            "VALUES ('house-no-committees', 'house', 'Nobody Serves', 'I', 'NY', '3', NULL, 'N000000')",
        )
        .run();

      const env = { DB: d1 } as unknown as Env;
      const result = await runCommitteeSync(env);
      expect(result.filersScanned).toBe(3);
      expect(result.updated).toBe(1); // senate-armed-chris
      expect(result.unmatched).toBe(1); // house-no-committees (N000000 has no memberships)
      expect(result.noBioguide).toBe(1); // house-unresolved
      expect(result.skipped).toBe(0);

      const row = await d1.prepare('SELECT committees FROM filers WHERE bioguide_id = ?').bind('senate-armed-chris').first<{
        committees: string;
      }>();
      expect(JSON.parse(row!.committees)).toEqual(['Senate Committee on Armed Services']);

      const untouched = await d1
        .prepare('SELECT committees FROM filers WHERE bioguide_id = ?')
        .bind('house-unresolved')
        .first<{ committees: string | null }>();
      expect(untouched!.committees).toBeNull();

      // Re-run: same fetch fixtures, nothing should change (idempotent).
      const second = await runCommitteeSync(env);
      expect(second.updated).toBe(0);
      expect(second.skipped).toBe(1);
      expect(second.unmatched).toBe(1);
      expect(second.noBioguide).toBe(1);
    } finally {
      close();
    }
  });
});
