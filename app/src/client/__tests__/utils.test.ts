/**
 * src/client/__tests__/utils.test.ts
 *
 * Pure query-string parsing unit tests for `GET /api/client/v1/feed`'s helpers
 * (no DB, no router). Added alongside the iOS punch list #2 sort/pagination
 * work: `sort=tx_date` and `offset=` were previously accepted by the shared
 * `TxQueryParams`/`buildTransactionsQuery` SQL builder (see
 * `../../delivery/__tests__/buildTransactionsQuery.test.ts`) but silently
 * dropped by this file's query-string parser before ever reaching it.
 */
import { describe, expect, it } from 'vitest';
import { asSort, filtersFromQuery, memberProfile, profilePhotoUrl } from '../utils.ts';
import type { MemberProfileRow } from '../types.ts';

describe('asSort', () => {
  it('accepts tx_date alongside the existing published/cursor keys', () => {
    expect(asSort('tx_date')).toBe('tx_date');
    expect(asSort('published')).toBe('published');
    expect(asSort('cursor')).toBe('cursor');
  });

  it('falls back to undefined (backend default: cursor order) for unknown values', () => {
    expect(asSort('amount')).toBeUndefined();
    expect(asSort(undefined)).toBeUndefined();
    expect(asSort('')).toBeUndefined();
  });
});

describe('filtersFromQuery offset', () => {
  it('parses a numeric offset= for snapshot page navigation', () => {
    const params = filtersFromQuery({ offset: '150' } as Record<string, string>);
    expect(params.offset).toBe(150);
  });

  it('omits offset when absent so the query builder defaults to page 1', () => {
    const params = filtersFromQuery({} as Record<string, string>);
    expect(params.offset).toBeUndefined();
  });

  it('threads sort=tx_date through to TxQueryParams', () => {
    const params = filtersFromQuery({ sort: 'tx_date', order: 'desc' } as Record<string, string>);
    expect(params.sort).toBe('tx_date');
    expect(params.order).toBe('desc');
  });

  it('parses source=all and ignores unknown source values', () => {
    expect(filtersFromQuery({ source: 'all' } as Record<string, string>).source).toBe('all');
    expect(filtersFromQuery({ source: 'seed_dataset' } as Record<string, string>).source).toBe('seed_dataset');
    expect(filtersFromQuery({} as Record<string, string>).source).toBeUndefined();
    expect(filtersFromQuery({ source: 'nope' } as Record<string, string>).source).toBeUndefined();
  });
});

describe('profilePhotoUrl', () => {
  const row = (over: Partial<MemberProfileRow> = {}): MemberProfileRow => ({
    bioguide_id: 'house-ca17-ro-khanna',
    chamber: 'house',
    full_name: 'Ro Khanna',
    party: 'Democrat',
    state: 'CA',
    district: '17',
    committees: null,
    photo_url: null,
    resolved_bioguide_id: 'K000389',
    ...over,
  });

  it('keeps a stored pack URL', () => {
    expect(profilePhotoUrl(row({ photo_url: 'https://congress.trade/api/photos/member?key=K000389' })))
      .toBe('https://congress.trade/api/photos/member?key=K000389');
  });

  it('synthesizes a pack URL from resolved_bioguide_id when photo_url is missing', () => {
    expect(profilePhotoUrl(row())).toBe('https://congress.trade/api/photos/member?key=K000389');
  });

  it('does not invent a URL for a slug-only filer with no photo', () => {
    expect(profilePhotoUrl(row({ resolved_bioguide_id: null }))).toBeNull();
  });
});

describe('memberProfile committees', () => {
  const row = (over: Partial<MemberProfileRow> = {}): MemberProfileRow => ({
    bioguide_id: 'senate-al-tommy-tuberville',
    chamber: 'senate',
    full_name: 'Tommy Tuberville',
    party: 'Republican',
    state: 'AL',
    district: null,
    committees: null,
    photo_url: null,
    resolved_bioguide_id: 'T000278',
    ...over,
  });

  it('parses a JSON string list', () => {
    expect(
      memberProfile(row({ committees: '["Senate Armed Services"]' }), 'senate-al-tommy-tuberville')
        .committees,
    ).toEqual(['Senate Armed Services']);
  });

  it('accepts a driver-decoded array on the text column', () => {
    expect(
      memberProfile(
        row({ committees: ['Senate Armed Services'] as unknown as string }),
        'senate-al-tommy-tuberville',
      ).committees,
    ).toEqual(['Senate Armed Services']);
  });
});
