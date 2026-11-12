import { describe, expect, it } from 'vitest';
import { memberNameMatchKey, sameFilerIdentity } from '../filerIdentityMatch.ts';

describe('memberNameMatchKey', () => {
  it('collapses a middle initial (with or without a trailing period)', () => {
    expect(memberNameMatchKey('Michael T. McCaul')).toBe('michael mccaul');
    expect(memberNameMatchKey('Michael T McCaul')).toBe('michael mccaul');
    expect(memberNameMatchKey('Michael McCaul')).toBe('michael mccaul');
  });

  it('drops generational suffixes', () => {
    expect(memberNameMatchKey('David McCormick Jr.')).toBe('david mccormick');
    expect(memberNameMatchKey('David McCormick III')).toBe('david mccormick');
  });

  it('is case-insensitive', () => {
    expect(memberNameMatchKey('MICHAEL T. MCCAUL')).toBe(memberNameMatchKey('michael mccaul'));
  });

  it('preserves a full middle name (not just an initial) — different key', () => {
    expect(memberNameMatchKey('Michael Thomas McCaul')).toBe('michael thomas mccaul');
    expect(memberNameMatchKey('Michael Thomas McCaul')).not.toBe(memberNameMatchKey('Michael McCaul'));
  });

  it('returns "" for a bare single-token name (cannot safely split first/last)', () => {
    expect(memberNameMatchKey('McCaul')).toBe('');
    expect(memberNameMatchKey('')).toBe('');
    expect(memberNameMatchKey(null)).toBe('');
    expect(memberNameMatchKey(undefined)).toBe('');
  });
});

describe('sameFilerIdentity', () => {
  const house = (fullName: string, state: string) => ({ fullName, chamber: 'house', state });

  it('matches the McCaul middle-initial fork within the same chamber+state', () => {
    expect(sameFilerIdentity(house('Michael T. McCaul', 'TX'), house('Michael McCaul', 'TX'))).toBe(true);
  });

  it('is case-insensitive on chamber and state', () => {
    expect(
      sameFilerIdentity(
        { fullName: 'Michael T. McCaul', chamber: 'House', state: 'tx' },
        { fullName: 'Michael McCaul', chamber: 'house', state: 'TX' },
      ),
    ).toBe(true);
  });

  it('never merges across chamber', () => {
    expect(
      sameFilerIdentity(
        { fullName: 'Michael T. McCaul', chamber: 'house', state: 'TX' },
        { fullName: 'Michael McCaul', chamber: 'senate', state: 'TX' },
      ),
    ).toBe(false);
  });

  it('never merges across state', () => {
    expect(sameFilerIdentity(house('Michael T. McCaul', 'TX'), house('Michael McCaul', 'CA'))).toBe(false);
  });

  it('does not merge a shared last name with a different first name', () => {
    expect(sameFilerIdentity(house('John Smith', 'CA'), house('Jane Smith', 'CA'))).toBe(false);
  });

  it('does not merge two different competitor House members from GA/PA with a shared last name', () => {
    // Rich McCormick (House, GA) vs David McCormick (Senate, PA) — regression
    // guard mirroring shared/executiveIdentity.ts's own "never bare last
    // name" rule; also proves chamber+state alone isn't enough on its own.
    expect(
      sameFilerIdentity(
        { fullName: 'Rich McCormick', chamber: 'house', state: 'GA' },
        { fullName: 'David McCormick', chamber: 'senate', state: 'PA' },
      ),
    ).toBe(false);
  });

  it('fails closed when state is missing on either side', () => {
    expect(sameFilerIdentity(house('Michael T. McCaul', 'TX'), { fullName: 'Michael McCaul', chamber: 'house', state: null })).toBe(false);
    expect(sameFilerIdentity({ fullName: 'Michael T. McCaul', chamber: 'house', state: '' }, house('Michael McCaul', 'TX'))).toBe(false);
  });

  it('fails closed when chamber is missing on either side', () => {
    expect(
      sameFilerIdentity(
        { fullName: 'Michael T. McCaul', chamber: null, state: 'TX' },
        house('Michael McCaul', 'TX'),
      ),
    ).toBe(false);
  });

  it('does not merge a full middle name difference (not just an initial)', () => {
    expect(sameFilerIdentity(house('Michael Thomas McCaul', 'TX'), house('Michael McCaul', 'TX'))).toBe(false);
  });
});
