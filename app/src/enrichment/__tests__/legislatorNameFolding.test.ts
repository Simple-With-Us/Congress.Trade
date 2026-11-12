/**
 * src/enrichment/__tests__/legislatorNameFolding.test.ts
 *
 * Regression tests for the two name-key mismatches that left real members with
 * no photo, party or state on the live site:
 *
 *   - congress-legislators stores accented spellings (Barragán, Grijalva,
 *     Sánchez) that disclosure filings write unaccented, and
 *   - the roster writes O’Halleran with a typographic apostrophe (U+2019)
 *     while filings use an ASCII one.
 *
 * Both are the same name; before folding they were different map keys, so the
 * lookup silently returned nothing.
 */

import { describe, it, expect } from 'vitest';
import {
  foldNameChars,
  indexLegislators,
  normName,
  fallbackNameKeys,
  type Legislator,
} from '../legislators.ts';

const ROSTER: Legislator[] = [
  {
    id: { bioguide: 'B001300' },
    name: { first: 'Nanette', middle: 'Diaz', last: 'Barragán', official_full: 'Nanette Diaz Barragán' },
    terms: [{ type: 'rep', party: 'Democrat', state: 'CA', district: 44, start: '2025-01-03' }],
  },
  {
    id: { bioguide: 'G000551' },
    name: { first: 'Raúl', middle: 'M.', last: 'Grijalva', official_full: 'Raúl M. Grijalva' },
    terms: [{ type: 'rep', party: 'Democrat', state: 'AZ', district: 7, start: '2025-01-03' }],
  },
  {
    id: { bioguide: 'S001156' },
    name: { first: 'Linda', middle: 'T.', last: 'Sánchez', official_full: 'Linda T. Sánchez' },
    terms: [{ type: 'rep', party: 'Democrat', state: 'CA', district: 38, start: '2025-01-03' }],
  },
  {
    id: { bioguide: 'O000171' },
    name: { first: 'Tom', last: 'O’Halleran', official_full: 'Tom O’Halleran' },
    terms: [{ type: 'rep', party: 'Democrat', state: 'AZ', district: 1, start: '2021-01-03' }],
  },
];

describe('foldNameChars', () => {
  it('strips diacritics without touching the letters', () => {
    expect(foldNameChars('Barragán')).toBe('Barragan');
    expect(foldNameChars('Raúl M. Grijalva')).toBe('Raul M. Grijalva');
    expect(foldNameChars('Sánchez')).toBe('Sanchez');
  });

  it('drops apostrophes so both quote styles collapse together', () => {
    expect(foldNameChars('O’Halleran')).toBe('OHalleran');
    expect(foldNameChars("O'Halleran")).toBe('OHalleran');
  });

  it('leaves an already-plain name alone', () => {
    expect(foldNameChars('Ron Wyden')).toBe('Ron Wyden');
  });
});

describe('normName', () => {
  it('maps accented and unaccented spellings onto one key', () => {
    expect(normName('Nanette Barragan')).toBe(normName('Nanette Barragán'));
    expect(normName('Raul Grijalva')).toBe(normName('Raúl M. Grijalva'));
    expect(normName('Linda T. Sanchez')).toBe(normName('Linda T. Sánchez'));
  });

  it('maps both apostrophe styles onto one key', () => {
    expect(normName("Tom O'Halleran")).toBe(normName('Tom O’Halleran'));
  });

  it('still drops middle initials and generational suffixes', () => {
    expect(normName('Ron L Wyden')).toBe('ron wyden');
    expect(normName('James Conley Justice II')).toBe('james conley justice');
  });
});

describe('indexLegislators lookups that previously missed', () => {
  const index = indexLegislators(ROSTER);

  it.each([
    ['Nanette Barragan', 'B001300'],
    ['Raul Grijalva', 'G000551'],
    ['Linda T. Sanchez', 'S001156'],
    ['Linda Sanchez', 'S001156'],
    ["Tom O'Halleran", 'O000171'],
  ])('resolves %s to %s', (filerName, bioguide) => {
    expect(index.get(normName(filerName))?.bioguide).toBe(bioguide);
  });

  it('does not invent a match for somebody who is not on the roster', () => {
    expect(index.get(normName('Arjun Mody'))).toBeUndefined();
  });
});

describe('fallbackNameKeys', () => {
  it('folds accents so the first+last fallback matches too', () => {
    expect(fallbackNameKeys('Nanette Barragan')).toEqual(fallbackNameKeys('Nanette Barragán'));
  });
});
