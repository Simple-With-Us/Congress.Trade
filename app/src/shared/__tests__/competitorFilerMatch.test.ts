/**
 * Board rows 2c0b428c / 591011b9: the ingest guard that stops a competitor
 * payload from minting a second filer for someone we already track.  Payload
 * shapes below are copied from the live /api/transactions rawText of 2026-09-18.
 */
import { describe, expect, it } from 'vitest';
import {
  assignCompetitorFilerId,
  competitorNameTokens,
  competitorNamesMatch,
  findExistingFilerForCompetitorReporter,
  isMintedCompetitorFilerId,
  type ExistingFilerCandidate,
} from '../competitorFilerMatch.ts';
import {
  chamberFromMemberType,
  competitorQualifiedManualFilerId,
  competitorReporterNames,
  parseCompetitorReporter,
} from '../competitorAttribution.ts';

function filer(o: Partial<ExistingFilerCandidate> & { filerId: string; fullName: string }): ExistingFilerCandidate {
  return { displayName: null, chamber: 'house', state: null, resolvedBioguideId: null, ...o };
}

const FILERS: ExistingFilerCandidate[] = [
  filer({ filerId: 'house-md06-april-mcclain-delaney', fullName: 'April McClain Delaney', state: 'MD' }),
  filer({ filerId: 'house-fl27-maria-elvira-salazar', fullName: 'Maria Elvira Salazar', state: 'FL' }),
  filer({ filerId: 'senate-susan-m-collins', fullName: 'Susan M. Collins', chamber: 'senate', state: 'ME' }),
  filer({ filerId: 'house-ga10-michael-a-collins', fullName: 'Michael A. Collins', displayName: 'Mac Collins', state: 'GA' }),
  filer({ filerId: 'house-tx03-nicholas-v-taylor', fullName: 'Nicholas V Taylor', state: 'TX' }),
  filer({ filerId: 'EXEC-DOUGLAS-J-BURGUM', fullName: 'Douglas J Burgum', chamber: 'executive' }),
  filer({ filerId: 'EXEC-CWRIGHT', fullName: 'Chris Wright', chamber: 'executive' }),
  filer({ filerId: 'EXEC-MICHAEL-J-KRATSIOS', fullName: 'Michael J. Kratsios', chamber: 'executive' }),
  filer({ filerId: 'EXEC-FRANK-J-BISIGNANO', fullName: 'Frank J. Bisignano', chamber: 'executive' }),
  filer({ filerId: 'EXEC-SARA-BAILEY', fullName: 'Sara Bailey', chamber: 'executive' }),
  filer({ filerId: 'EXEC-SCOTT-A-KUPOR', fullName: 'Scott A. Kupor', chamber: 'executive' }),
  filer({ filerId: 'house-nj07-thomas-h-kean', fullName: 'Thomas H. Kean Jr.', state: 'NJ' }),
  filer({ filerId: 'house-mn08-peter-allen-stauber', fullName: 'Peter Allen Stauber', state: 'MN' }),
  // Phantoms are never a valid target.
  filer({ filerId: 'MANUAL-DELANEY', fullName: 'John Delaney', state: 'NY' }),
  filer({ filerId: 'MANUAL-WRIGHT', fullName: 'Christopher A Wright', chamber: 'senate' }),
  filer({ filerId: 'MANUAL-ELVIRA', fullName: 'Maria Elvira', chamber: 'senate' }),
];

const DELANEY_PAYLOAD = JSON.stringify({
  name: 'April Delaney',
  reporter: 'Hon. April McClain Delaney',
  member_type: 'house',
  politician_id: '36b29b09-31d2-4ff4-a9d0-220ea79ee025',
});

describe('name matching primitives', () => {
  it('reduces honorifics, initials and suffixes to first..last tokens', () => {
    expect(competitorNameTokens('Hon. April McClain Delaney')).toEqual(['april', 'mcclain', 'delaney']);
    expect(competitorNameTokens('Thomas H. Kean, Jr')).toEqual(['thomas', 'kean']);
    expect(competitorNameTokens('Raúl M. Grijalva')).toEqual(['raul', 'grijalva']);
  });

  it('matches first+last through middle names and curated diminutives, never on the surname alone', () => {
    expect(competitorNamesMatch(['april', 'delaney'], ['april', 'mcclain', 'delaney'])).toBe(true);
    expect(competitorNamesMatch(['mike', 'collins'], ['michael', 'collins'])).toBe(true);
    expect(competitorNamesMatch(['john', 'delaney'], ['april', 'mcclain', 'delaney'])).toBe(false);
    expect(competitorNamesMatch(['delaney'], ['april', 'delaney'])).toBe(false);
  });

  it('recognises minted ids and the chamber a provider declares', () => {
    expect(isMintedCompetitorFilerId('MANUAL-DELANEY')).toBe(true);
    expect(isMintedCompetitorFilerId('house-md06-april-mcclain-delaney')).toBe(false);
    expect(chamberFromMemberType('executive')).toBe('executive');
    expect(chamberFromMemberType('Representatives')).toBe('house');
    expect(chamberFromMemberType('Senate')).toBe('senate');
    expect(chamberFromMemberType('')).toBeNull();
  });

  it('parses an executive member_type instead of dropping it', () => {
    expect(parseCompetitorReporter({ name: 'Pete Hegseth', member_type: 'executive' }).chamber).toBe('executive');
  });

  it('lists every reporter name in a payload, most specific first', () => {
    expect(competitorReporterNames(DELANEY_PAYLOAD)).toEqual(['Hon. April McClain Delaney', 'April Delaney']);
    expect(competitorReporterNames('not json')).toEqual([]);
  });
});

describe('findExistingFilerForCompetitorReporter', () => {
  it('attaches "April Delaney" to the real April McClain Delaney filer, never the MANUAL-DELANEY phantom (2c0b428c)', () => {
    const parsed = parseCompetitorReporter(DELANEY_PAYLOAD);
    const hit = findExistingFilerForCompetitorReporter({
      names: competitorReporterNames(DELANEY_PAYLOAD),
      chamber: parsed.chamber,
      state: parsed.state,
      candidates: FILERS,
    });
    expect(hit?.filerId).toBe('house-md06-april-mcclain-delaney');
  });

  it('attaches the truncated "Maria Elvira" through the curated alias to Salazar (MANUAL-ELVIRA)', () => {
    const hit = findExistingFilerForCompetitorReporter({
      names: ['Maria Elvira'],
      chamber: 'house',
      candidates: FILERS,
    });
    expect(hit?.filerId).toBe('house-fl27-maria-elvira-salazar');
  });

  it('does not attach "John Delaney" to anyone: a different first name is a hard miss', () => {
    expect(
      findExistingFilerForCompetitorReporter({ names: ['John Delaney'], chamber: 'house', candidates: FILERS }),
    ).toBeNull();
  });

  it('attaches an executive payload to its EXEC-* twin, including a curated diminutive ("Mike" vs "Michael")', () => {
    expect(
      findExistingFilerForCompetitorReporter({ names: ['Douglas J Burgum'], chamber: 'executive', candidates: FILERS })?.filerId,
    ).toBe('EXEC-DOUGLAS-J-BURGUM');
    expect(
      findExistingFilerForCompetitorReporter({ names: ['Mike Collins'], chamber: 'house', state: 'GA', candidates: FILERS })?.filerId,
    ).toBe('house-ga10-michael-a-collins');
  });

  it('a known state or chamber conflict is a hard miss (Sen. Susan Collins never absorbs Rep. Mike Collins)', () => {
    expect(
      findExistingFilerForCompetitorReporter({ names: ['Susan Collins'], chamber: 'house', state: 'GA', candidates: FILERS }),
    ).toBeNull();
    expect(
      findExistingFilerForCompetitorReporter({ names: ['Susan Collins'], chamber: 'house', candidates: FILERS }),
    ).toBeNull();
    expect(
      findExistingFilerForCompetitorReporter({ names: ['Susan Collins'], chamber: 'senate', state: 'ME', candidates: FILERS })?.filerId,
    ).toBe('senate-susan-m-collins');
  });

  it('is null when two live filers match (the dedupe pass merges them first, then a re-run resolves)', () => {
    const dup = [
      ...FILERS,
      filer({ filerId: 'house-md06-april-delaney', fullName: 'April Delaney', state: 'MD' }),
    ];
    expect(
      findExistingFilerForCompetitorReporter({ names: ['April Delaney'], chamber: 'house', candidates: dup }),
    ).toBeNull();
  });

  it('a payload bioguide id wins over the name', () => {
    const withBio = FILERS.map((f) =>
      f.filerId === 'house-ga10-michael-a-collins' ? { ...f, resolvedBioguideId: 'C001129' } : f,
    );
    expect(
      findExistingFilerForCompetitorReporter({ names: ['Someone Else'], bioguideId: 'C001129', candidates: withBio })?.filerId,
    ).toBe('house-ga10-michael-a-collins');
  });

  it('never returns a bare-surname match', () => {
    expect(findExistingFilerForCompetitorReporter({ names: ['Delaney'], candidates: FILERS })).toBeNull();
    expect(findExistingFilerForCompetitorReporter({ names: ['Kean'], candidates: FILERS })).toBeNull();
    expect(findExistingFilerForCompetitorReporter({ names: ['Wright'], candidates: FILERS })).toBeNull();
  });

  it('resolves each CT-1362 twin onto the roster or EXEC id, never the MANUAL phantom', () => {
    const cases: Array<[string, string]> = [
      ['Christopher A Wright', 'EXEC-CWRIGHT'],
      ['Chris Wright', 'EXEC-CWRIGHT'],
      ['Douglas J Burgum', 'EXEC-DOUGLAS-J-BURGUM'],
      ['Doug Burgum', 'EXEC-DOUGLAS-J-BURGUM'],
      ['Michael J. Kratsios', 'EXEC-MICHAEL-J-KRATSIOS'],
      ['Michael Kratsios', 'EXEC-MICHAEL-J-KRATSIOS'],
      ['Frank J. Bisignano', 'EXEC-FRANK-J-BISIGNANO'],
      ['Frank Bisignano', 'EXEC-FRANK-J-BISIGNANO'],
      ['Sara Bailey', 'EXEC-SARA-BAILEY'],
      ['Scott A. Kupor', 'EXEC-SCOTT-A-KUPOR'],
      ['Scott Kupor', 'EXEC-SCOTT-A-KUPOR'],
      ['Thomas H. Kean Jr.', 'house-nj07-thomas-h-kean'],
      ['Tom Kean', 'house-nj07-thomas-h-kean'],
      ['Peter Allen Stauber', 'house-mn08-peter-allen-stauber'],
      ['Pete Stauber', 'house-mn08-peter-allen-stauber'],
    ];
    for (const [name, filerId] of cases) {
      expect(findExistingFilerForCompetitorReporter({ names: [name], candidates: FILERS })?.filerId, name).toBe(filerId);
    }
  });
});

describe('assignCompetitorFilerId (ingest guard: a last name never creates a filer)', () => {
  it('attaches a full name to the existing id and does not mint', () => {
    expect(assignCompetitorFilerId({
      rawName: 'Christopher A Wright',
      chamber: 'executive',
      candidates: FILERS,
    })).toEqual({ filerId: 'EXEC-CWRIGHT', minted: false });
    expect(assignCompetitorFilerId({
      rawName: 'Hon. April McClain Delaney',
      chamber: 'house',
      state: 'MD',
      district: '6',
      candidates: FILERS,
    })).toEqual({ filerId: 'house-md06-april-mcclain-delaney', minted: false });
  });

  it('a last-name-only match never creates a new filer, even with a district or an existing namesake', () => {
    expect(assignCompetitorFilerId({ rawName: 'Delaney', candidates: FILERS })).toBeNull();
    expect(assignCompetitorFilerId({ rawName: 'Kean', candidates: FILERS })).toBeNull();
    expect(assignCompetitorFilerId({ rawName: 'Wright', candidates: FILERS })).toBeNull();
    expect(assignCompetitorFilerId({ rawName: 'Elvira', candidates: FILERS })).toBeNull();
    expect(assignCompetitorFilerId({
      rawName: 'Delaney',
      chamber: 'house',
      state: 'NY',
      district: '7',
      candidates: FILERS,
    })).toBeNull();
    expect(assignCompetitorFilerId({ rawName: 'Delaney', candidates: [] })).toBeNull();
  });
});

describe('competitorQualifiedManualFilerId (ingest guard: no filer from a last name alone)', () => {
  it('mints a first-name-qualified id', () => {
    expect(competitorQualifiedManualFilerId('Hon. April McClain Delaney')).toBe('MANUAL-APRIL-DELANEY');
    expect(competitorQualifiedManualFilerId('Thomas H. Kean, Jr')).toBe('MANUAL-THOMAS-KEAN');
  });

  it('refuses a bare surname', () => {
    expect(competitorQualifiedManualFilerId('Delaney')).toBeNull();
    expect(competitorQualifiedManualFilerId('')).toBeNull();
  });
});
