import { describe, expect, it } from 'vitest';

import { formatMemberSeat } from '../routes.ts';
import { resolveOgMeta } from '../ogMeta.ts';

/**
 * `formatMemberSeat` is what makes the politician share card say
 * "Ro Khanna (D-CA-17)" or "Donald J. Trump (President)" instead of a bare
 * name. Every shape asserted here was taken from live `filers` / `/api/members`
 * rows, not invented — see the doc comment on the function for the encodings
 * that bite (NULL party, NULL district, '0' at-large, EXEC-* positions).
 */
describe('formatMemberSeat — congressional seats', () => {
  it('formats a House seat as party-state-district', () => {
    expect(formatMemberSeat('K000389', 'house', 'Democrat', 'CA', '17')).toBe('D-CA-17');
    expect(formatMemberSeat('M001157', 'house', 'Republican', 'TX', '10')).toBe('R-TX-10');
  });

  it('formats a Senate seat with Sen instead of a district number', () => {
    // Senators carry a NULL district — the seat token must come from the chamber.
    expect(formatMemberSeat('T000278', 'senate', 'Republican', 'AL', null)).toBe('R-AL-Sen');
    expect(formatMemberSeat('C000174', 'senate', 'Democrat', 'DE', null)).toBe('D-DE-Sen');
  });

  it("renders at-large House seats as AL, never as district '0'", () => {
    // '0' is the at-large encoding. Printing "D-DE-0" would name a district
    // that does not exist.
    expect(formatMemberSeat('B001303', 'house', 'Democrat', 'DE', '0')).toBe('D-DE-AL');
    expect(formatMemberSeat('H001096', 'house', 'Republican', 'WY', '00')).toBe('R-WY-AL');
  });

  it('strips leading zeros from a padded district', () => {
    expect(formatMemberSeat('G000583', 'house', 'Democrat', 'NJ', '05')).toBe('D-NJ-5');
  });

  it('omits the party initial when party is unknown', () => {
    // ~14% of live filers have a NULL party; the seat is still worth showing,
    // and a naive join would emit a leading "-".
    expect(formatMemberSeat('X000001', 'house', null, 'CA', '17')).toBe('CA-17');
    expect(formatMemberSeat('X000002', 'senate', '', 'TX', null)).toBe('TX-Sen');
  });

  it('returns null when a congressional row has no state', () => {
    expect(formatMemberSeat('X000003', 'house', 'Democrat', null, '17')).toBeNull();
    expect(formatMemberSeat('X000004', 'house', 'Democrat', '   ', '17')).toBeNull();
  });

  it('is case- and whitespace-insensitive on chamber and state', () => {
    expect(formatMemberSeat('K000389', ' House ', 'Democrat', ' ca ', ' 17 ')).toBe('D-CA-17');
    expect(formatMemberSeat('S000033', 'SENATE', 'Independent', 'vt', null)).toBe('I-VT-Sen');
  });
});

describe('formatMemberSeat — executive-branch positions', () => {
  it('shows the curated position, not a district', () => {
    // Executive filers DO hold a seat — it is just a job title, and it lives
    // only in the curated shared/executiveTitles.ts map.
    expect(formatMemberSeat('EXEC-DJT', 'executive', 'Republican', null, null)).toBe('President');
    expect(formatMemberSeat('EXEC-BESSENT', 'executive', null, null, null)).toBe('Treasury Secretary');
    expect(formatMemberSeat('EXEC-MCMAHON', 'executive', null, null, null)).toBe('Education Secretary');
  });

  it('never emits the word "Executive" for an uncurated filer', () => {
    // executiveTitleFor() falls back to 'Executive Branch'; that is exactly the
    // label the owner asked not to show, so a bare name is the right answer.
    expect(formatMemberSeat('EXEC-NOT-CURATED', 'executive', 'Republican', null, null)).toBeNull();
  });

  it('ignores a state on an executive row rather than inventing a seat', () => {
    // EXEC-MCCORMICK carries state 'PA' in live data. Checking state before
    // chamber would render "R-PA" — a congressional seat descriptor built from
    // an executive-branch filing row.
    expect(formatMemberSeat('EXEC-MCCORMICK', 'executive', 'Republican', 'PA', null)).toBe(
      'U.S. Senator (PA)',
    );
  });

  it('flattens a title that already contains parentheses', () => {
    // The descriptor is rendered inside parentheses, so 'U.S. Senator (PA)'
    // would nest as "David McCormick (U.S. Senator (PA))".
    const meta = resolveOgMeta('https://congress.trade/?member=EXEC-MCCORMICK', 'https://congress.trade', {
      memberDisplayName: 'David McCormick',
      memberDistrict: formatMemberSeat('EXEC-MCCORMICK', 'executive', 'Republican', 'PA', null),
    });
    expect(meta.title).toBe('David McCormick (U.S. Senator, PA)');
  });

  it('recognises an EXEC- id even if the chamber column is missing', () => {
    expect(formatMemberSeat('EXEC-DJT', null, null, null, null)).toBe('President');
  });
});

describe('politician share title', () => {
  it('renders a congressional seat in parentheses after the name', () => {
    const meta = resolveOgMeta('https://congress.trade/?member=K000389', 'https://congress.trade', {
      memberDisplayName: 'Ro Khanna',
      memberDistrict: formatMemberSeat('K000389', 'house', 'Democrat', 'CA', '17'),
    });
    expect(meta.title).toBe('Ro Khanna (D-CA-17)');
    // The redundant site suffix stays gone — the URL and card art already carry it.
    expect(meta.title).not.toContain('Congress.Trade');
  });

  it('renders an executive position in parentheses after the name', () => {
    const meta = resolveOgMeta('https://congress.trade/?member=EXEC-DJT', 'https://congress.trade', {
      memberDisplayName: 'Donald J. Trump',
      memberDistrict: formatMemberSeat('EXEC-DJT', 'executive', 'Republican', null, null),
    });
    expect(meta.title).toBe('Donald J. Trump (President)');
  });

  it('does not truncate the longest curated title', () => {
    // 'Social Security Commissioner' is 28 chars; the old 24-char cap cut it
    // mid-word to "Social Security Commissio…".
    const meta = resolveOgMeta('https://congress.trade/?member=EXEC-FRANK-J-BISIGNANO', 'https://congress.trade', {
      memberDisplayName: 'Frank J. Bisignano',
      memberDistrict: formatMemberSeat('EXEC-FRANK-J-BISIGNANO', 'executive', null, null, null),
    });
    expect(meta.title).toBe('Frank J. Bisignano (Social Security Commissioner)');
    expect(meta.title).not.toContain('…');
  });

  it('falls back to a bare name when there is no seat to show', () => {
    const meta = resolveOgMeta('https://congress.trade/?member=X000003', 'https://congress.trade', {
      memberDisplayName: 'Some Filer',
      memberDistrict: formatMemberSeat('X000003', 'house', 'Democrat', null, null),
    });
    expect(meta.title).toBe('Some Filer');
  });
});
