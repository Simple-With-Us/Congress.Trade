import { describe, expect, it } from 'vitest';
import { formatPartyLabel } from '../partyLabel.ts';

describe('formatPartyLabel', () => {
  it('spells out bare single-letter codes (curated executive filers)', () => {
    expect(formatPartyLabel('R')).toBe('Republican');
    expect(formatPartyLabel('D')).toBe('Democrat');
    expect(formatPartyLabel('I')).toBe('Independent');
  });

  it('normalizes already-spelled-out congress-legislators values to the same labels', () => {
    expect(formatPartyLabel('Republican')).toBe('Republican');
    expect(formatPartyLabel('Democrat')).toBe('Democrat');
    expect(formatPartyLabel('Democratic')).toBe('Democrat');
    expect(formatPartyLabel('Independent')).toBe('Independent');
  });

  it('is case-insensitive', () => {
    expect(formatPartyLabel('r')).toBe('Republican');
    expect(formatPartyLabel('democrat')).toBe('Democrat');
  });

  it('trims whitespace', () => {
    expect(formatPartyLabel('  R  ')).toBe('Republican');
  });

  it('returns null for empty/missing input', () => {
    expect(formatPartyLabel('')).toBeNull();
    expect(formatPartyLabel(null)).toBeNull();
    expect(formatPartyLabel(undefined)).toBeNull();
  });

  it('passes through unrecognized values unchanged', () => {
    expect(formatPartyLabel('O')).toBe('O');
    expect(formatPartyLabel('Green')).toBe('Green');
  });
});
