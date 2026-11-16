import { describe, expect, it } from 'vitest';
import {
  chamberForMatchedCompetitorFiler,
  chamberForMintedCompetitorInsert,
  competitorHouseFilerId,
  competitorManualFilerId,
  competitorReporterMismatch,
  hasCompetitorCryptoMarker,
  parseCompetitorReporter,
} from '../competitorAttribution.ts';

describe('parseCompetitorReporter', () => {
  it('parses a Quiver-shaped payload (Representative + District)', () => {
    const parsed = parseCompetitorReporter(
      JSON.stringify({ Representative: 'Hon. Michael A. Collins Jr', District: 'GA10', Ticker: 'ACME' }),
    );
    expect(parsed.name).toBe('Hon. Michael A. Collins Jr');
    expect(parsed.state).toBe('GA');
    expect(parsed.district).toBe('10');
    expect(parsed.chamber).toBe('house');
  });

  it('parses an FMP-shaped payload (firstName/lastName)', () => {
    const parsed = parseCompetitorReporter({ firstName: 'Susan', lastName: 'Collins', office: 'ME' });
    expect(parsed.name).toBe('Susan Collins');
    expect(parsed.state).toBe('ME');
    expect(parsed.district).toBeNull();
  });

  it('picks up a direct bioguide id when the payload carries one', () => {
    const parsed = parseCompetitorReporter({ name: 'Someone', BioGuideID: 'C001035' });
    expect(parsed.bioguideId).toBe('C001035');
  });

  it('returns all-null fields for unparseable / empty input, never throws', () => {
    expect(parseCompetitorReporter(null)).toEqual({ name: null, state: null, district: null, chamber: null, bioguideId: null });
    expect(parseCompetitorReporter('not json')).toEqual({ name: null, state: null, district: null, chamber: null, bioguideId: null });
    expect(parseCompetitorReporter({})).toEqual({ name: null, state: null, district: null, chamber: null, bioguideId: null });
  });
});

describe('competitorReporterMismatch', () => {
  it('flags a chamber mismatch', () => {
    const parsed = parseCompetitorReporter({ Representative: 'Mike Collins', District: 'GA10' });
    expect(competitorReporterMismatch(parsed, { chamber: 'senate', state: 'GA', resolvedBioguideId: null })).toBe(true);
  });

  it('flags a state mismatch', () => {
    const parsed = parseCompetitorReporter({ Representative: 'Mike Collins', District: 'GA10' });
    expect(competitorReporterMismatch(parsed, { chamber: 'house', state: 'ME', resolvedBioguideId: null })).toBe(true);
  });

  it('flags a resolved-bioguide mismatch', () => {
    const parsed = parseCompetitorReporter({ name: 'Someone', BioGuideID: 'C001035' });
    expect(competitorReporterMismatch(parsed, { chamber: null, state: null, resolvedBioguideId: 'X000001' })).toBe(true);
  });

  it('is false when chamber and state agree', () => {
    const parsed = parseCompetitorReporter({ Representative: 'Mike Collins', District: 'GA10' });
    expect(competitorReporterMismatch(parsed, { chamber: 'house', state: 'GA', resolvedBioguideId: null })).toBe(false);
  });

  it('fails closed (false) when there is nothing to compare on either side', () => {
    const parsed = parseCompetitorReporter({ name: 'Someone' });
    expect(competitorReporterMismatch(parsed, { chamber: null, state: null, resolvedBioguideId: null })).toBe(false);
  });
});

describe('hasCompetitorCryptoMarker', () => {
  it('matches a trailing [CT] marker in notes', () => {
    expect(hasCompetitorCryptoMarker({ notes: 'Aeromexico common stock [CT]' }, 'Aeromexico', 'AERO')).toBe(true);
  });

  it('matches an explicit crypto keyword in notes', () => {
    expect(hasCompetitorCryptoMarker({ notes: 'Purchase of Bitcoin' }, null, null)).toBe(true);
  });

  it('matches a crypto ticker even without notes', () => {
    expect(hasCompetitorCryptoMarker({}, 'Sun Communities', 'SUI')).toBe(true);
  });

  it('is false for an ordinary equity payload', () => {
    expect(hasCompetitorCryptoMarker({ notes: 'Common stock purchase' }, 'Apple Inc.', 'AAPL')).toBe(false);
  });
});

describe('chamberForMintedCompetitorInsert / chamberForMatchedCompetitorFiler', () => {
  it('never falls back to a provider feed default for new MANUAL-* filers', () => {
    expect(chamberForMintedCompetitorInsert({ name: 'Pete Hegseth', state: null, district: null, chamber: null, bioguideId: null })).toBeNull();
    expect(chamberForMintedCompetitorInsert({ name: 'Jim Jordan', state: 'OH', district: '4', chamber: 'house', bioguideId: null })).toBe('house');
  });

  it('prefers a known existing filer chamber, else payload evidence only', () => {
    const parsed = { name: 'Susan Collins', state: 'ME', district: null, chamber: 'house', bioguideId: null };
    expect(chamberForMatchedCompetitorFiler('senate', parsed)).toBe('senate');
    expect(chamberForMatchedCompetitorFiler('senate', { ...parsed, chamber: null })).toBe('senate');
    expect(chamberForMatchedCompetitorFiler('', { ...parsed, chamber: 'executive' })).toBe('executive');
    expect(chamberForMatchedCompetitorFiler(null, { ...parsed, chamber: null })).toBeNull();
  });
});

describe('competitorHouseFilerId / competitorManualFilerId', () => {
  it('mints a house-<district>-<slug> id from a name + state + district', () => {
    const id = competitorHouseFilerId('Hon. Michael A. Collins Jr', 'GA', '10');
    expect(id).toMatch(/^house-ga10-.*collins/);
  });

  it('mints the MANUAL-<LASTNAME> convention id', () => {
    expect(competitorManualFilerId('Susan M. Collins')).toBe('MANUAL-COLLINS');
  });

  it('returns null when no usable name is given', () => {
    expect(competitorHouseFilerId('', 'GA', '10')).toBeNull();
    expect(competitorManualFilerId('')).toBeNull();
  });
});
