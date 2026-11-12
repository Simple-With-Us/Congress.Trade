/**
 * src/shared/__tests__/companyName.test.ts
 *
 * Coverage for the server-side asset display-name resolver (review #1453):
 * feed showed "UNH Stock"/"UPS Stock" placeholders, bare "Securities", raw
 * ALL-CAPS filing names next to normalized ones, and ticker "X" (US Steel)
 * with no company name in the drawer. See src/shared/companyName.ts.
 */
import { describe, expect, it } from 'vitest';
import { normalizeCompanyName, resolveAssetDisplayName } from '../companyName.ts';

describe('normalizeCompanyName', () => {
  it('title-cases ALL-CAPS filing names and normalizes Inc./Corp. punctuation', () => {
    expect(normalizeCompanyName('CLEVELAND-CLIFFS INC.', 'CLF')).toBe('Cleveland-Cliffs Inc.');
    expect(normalizeCompanyName('MICROSOFT CORP', 'MSFT')).toBe('Microsoft Corp.');
  });

  it('preserves already-mixed-case names (e.g. camel-cased brand names) untouched', () => {
    expect(normalizeCompanyName('UnitedHealth Group Incorporated', 'UNH')).toBe(
      'UnitedHealth Group Incorporated',
    );
  });

  it('keeps a single-letter ticker used as the name in uppercase', () => {
    expect(normalizeCompanyName('X', 'X')).toBe('X');
  });
});

describe('resolveAssetDisplayName', () => {
  it('prefers the securities_ref canonical name over raw filing text', () => {
    expect(
      resolveAssetDisplayName('CLEVELAND-CLIFFS INC.', 'CLF', 'Cleveland-Cliffs, Inc.'),
    ).toBe('Cleveland-Cliffs, Inc.');
  });

  it('maps a "<TICKER> Stock" placeholder to the canonical ref name when the ticker resolves', () => {
    expect(
      resolveAssetDisplayName('UNH Stock', 'UNH', 'UnitedHealth Group Incorporated'),
    ).toBe('UnitedHealth Group Incorporated');
    expect(resolveAssetDisplayName('UPS Stock', 'UPS', 'United Parcel Service, Inc.')).toBe(
      'United Parcel Service, Inc.',
    );
  });

  it('falls back to the bare ticker for a "<TICKER> Stock" placeholder with no ref name yet', () => {
    // Degrades gracefully instead of showing a mangled title-case of the
    // placeholder itself ("Unh Stock").
    expect(resolveAssetDisplayName('UNH Stock', 'UNH', null)).toBe('UNH');
    expect(resolveAssetDisplayName('UPS Common Stock', 'UPS', undefined)).toBe('UPS');
  });

  it('also recognizes "<TICKER> Securities" as a generic placeholder', () => {
    expect(resolveAssetDisplayName('X Securities', 'X', 'United States Steel Corporation')).toBe(
      'United States Steel Corporation',
    );
  });

  it('resolves the single-letter ticker X (US Steel) to its canonical name when a ref name exists', () => {
    expect(resolveAssetDisplayName('X', 'X', 'United States Steel Corporation')).toBe(
      'United States Steel Corporation',
    );
    // No filing text at all (ticker-only row), same outcome.
    expect(resolveAssetDisplayName(null, 'X', 'United States Steel Corporation')).toBe(
      'United States Steel Corporation',
    );
  });

  it('shows the bare single-letter ticker X when no ref name is available yet (not blank)', () => {
    expect(resolveAssetDisplayName('X', 'X', null)).toBe('X');
    expect(resolveAssetDisplayName('', 'X', null)).toBe('X');
  });

  it('title-cases real filing-provided text (punctuation/casing) when no ref name is available', () => {
    expect(normalizeText('CLEVELAND-CLIFFS INC.', 'CLF')).toBe('Cleveland-Cliffs Inc.');
    expect(normalizeText('MICROSOFT CORP', 'MSFT')).toBe('Microsoft Corp.');
    function normalizeText(name: string, ticker: string) {
      return resolveAssetDisplayName(name, ticker, null);
    }
  });

  it('leaves a genuinely unknown asset exactly as filed — never invents a name', () => {
    // Bare "Securities" with no ticker to resolve against: nothing we can do
    // better than pass the filing text straight through.
    expect(resolveAssetDisplayName('Securities', null, null)).toBe('Securities');
    expect(resolveAssetDisplayName('Securities', '', undefined)).toBe('Securities');
    // Real, specific (if unfamiliar) filing text with no ticker and no ref
    // name is still cleaned up cosmetically (title-case), not replaced.
    expect(resolveAssetDisplayName('GREATER BOSTON WATER TRUST', null, null)).toBe(
      'Greater Boston Water Trust',
    );
  });

  it('returns null (not empty string) for a genuinely empty asset with nothing to fall back on', () => {
    expect(resolveAssetDisplayName('', null, null)).toBeNull();
    expect(resolveAssetDisplayName(null, null, null)).toBeNull();
  });

  it('strips the boilerplate "Common Stock" suffix from otherwise real names', () => {
    expect(resolveAssetDisplayName('Apple Inc - Common Stock', 'AAPL', null)).toBe('Apple Inc.');
  });
});
