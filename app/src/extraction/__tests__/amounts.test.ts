import { describe, it, expect } from 'vitest';
import { normalizeOcrAmountToken, parseAmountRange } from '../amounts.ts';
import { isValidBracket } from '../../shared/brackets.ts';

describe('parseAmountRange -> canonical bracket', () => {
  it('parses a standard hyphen range', () => {
    const r = parseAmountRange('$1,001 - $15,000');
    expect(r).toMatchObject({ min: 1001, max: 15000, exact: true });
    expect(isValidBracket(r.min!, r.max)).toBe(true);
  });

  it('parses an en-dash range', () => {
    const r = parseAmountRange('$15,001–$50,000');
    expect(r).toMatchObject({ min: 15001, max: 50000, exact: true });
  });

  it('parses a "to" range', () => {
    const r = parseAmountRange('$50,001 to $100,000');
    expect(r).toMatchObject({ min: 50001, max: 100000, exact: true });
  });

  it('parses the open-ended top tier', () => {
    const r = parseAmountRange('$50,000,001 +');
    expect(r.min).toBe(50000001);
    expect(r.max).toBeNull();
    expect(isValidBracket(r.min!, r.max)).toBe(true);
  });

  it('handles "Over $50,000,000" as the open top tier', () => {
    const r = parseAmountRange('Over $50,000,000');
    expect(r.min).toBe(50000001);
    expect(r.max).toBeNull();
  });

  it('returns nulls for empty/garbage', () => {
    expect(parseAmountRange('')).toMatchObject({ min: null, max: null, exact: false });
    expect(parseAmountRange('n/a')).toMatchObject({ min: null, max: null });
  });

  it('every canonical bracket round-trips to a valid bracket', () => {
    const samples: Array<[string, number, number | null]> = [
      ['$0 - $1,000', 0, 1000],
      ['$1,001 - $15,000', 1001, 15000],
      ['$100,001 - $250,000', 100001, 250000],
      ['$1,000,001 - $5,000,000', 1000001, 5000000],
    ];
    for (const [raw, min, max] of samples) {
      const r = parseAmountRange(raw);
      expect(r.min).toBe(min);
      expect(r.max).toBe(max);
      expect(isValidBracket(r.min!, r.max)).toBe(true);
    }
  });

  it('snaps exact sub-$1,001 dollar amounts onto the $0–$1,000 tier', () => {
    const r = parseAmountRange('$456.00');
    expect(r).toMatchObject({ min: 0, max: 1000, exact: true });
    expect(isValidBracket(r.min!, r.max)).toBe(true);
    const r2 = parseAmountRange('$1,000');
    expect(r2).toMatchObject({ min: 0, max: 1000, exact: true });
  });

  it('extracts a STOCK Act range from freeform PTR raw lines without date/CUSIP false positives', () => {
    const r = parseAmountRange(
      'SP California St Go Call 12/1/27 4% due 12/1/47 [GS] S (partial) 12/02/2024 12/11/2024 $1,001 - $15,000 F S: New S O: Victoria Kelly Trust ICA',
    );
    expect(r).toMatchObject({ min: 1001, max: 15000, exact: true });
  });

  it('collapses OCR spaced thousands onto the STOCK Act bracket', () => {
    expect(parseAmountRange('$15 001 - $50 000')).toMatchObject({ min: 15001, max: 50000, exact: true });
    expect(parseAmountRange('$1 001 - $15 000')).toMatchObject({ min: 1001, max: 15000, exact: true });
    expect(parseAmountRange('$50 001 - $100 000')).toMatchObject({ min: 50001, max: 100000, exact: true });
    expect(parseAmountRange('$1 000 001 - $5 000 000')).toMatchObject({
      min: 1000001,
      max: 5000000,
      exact: true,
    });
    expect(isValidBracket(15001, 50000)).toBe(true);
  });

  it('does not turn a following 3-digit row number into the upper bound', () => {
    const r = parseAmountRange(
      '126 QUALCOMM INC sale 7/17/2026 No $15,001 - $50 000 127 INTUIT INC',
    );
    expect(r).toMatchObject({ min: 15001, max: 50000, exact: true });
  });

  it('does not shorten a comma- or period-grouped trailing 3-digit group', () => {
    // Only a whitespace-separated trailing group can be a flattened 278-T row
    // index. Thousands punctuation means the digits belong to the amount, so a
    // corrupted upper bound must not collapse onto a canonical bracket.
    for (const raw of ['$1,001 - $15,000,999', '$1,001 - $15.000.999', '$1.001 - $15.000,999']) {
      const r = parseAmountRange(raw);
      expect(r).toMatchObject({ min: 1001, max: 15000999, exact: false });
      expect(isValidBracket(r.min!, r.max)).toBe(false);
    }
    // The whitespace-separated row index is still dropped.
    expect(parseAmountRange('$1,001 - $15,000 999')).toMatchObject({ min: 1001, max: 15000, exact: true });
    expect(parseAmountRange('$1,001 - $15 000 999')).toMatchObject({ min: 1001, max: 15000, exact: true });
  });

  it('treats a period as thousands only when every group is exactly 3 digits', () => {
    expect(parseAmountRange('$15.001 - $50.000')).toMatchObject({ min: 15001, max: 50000, exact: true });
    expect(parseAmountRange('$1.000.001 - $5.000.000')).toMatchObject({
      min: 1000001,
      max: 5000000,
      exact: true,
    });
    expect(parseAmountRange('$500.001 - $1.000.000')).toMatchObject({
      min: 500001,
      max: 1000000,
      exact: true,
    });
    expect(parseAmountRange('$1.000 001 - $5 000 000')).toMatchObject({
      min: 1000001,
      max: 5000000,
      exact: true,
    });
    expect(normalizeOcrAmountToken('$456.00')).toBe('456.00');
    expect(normalizeOcrAmountToken('15.001')).toBe('15001');
    expect(normalizeOcrAmountToken('1 000 001')).toBe('1000001');
  });

  it('parses the mixed forms that used to invert to (15001, 50), (1001, 15), (50001, 100)', () => {
    expect(parseAmountRange('$15,001 - $50 000')).toMatchObject({ min: 15001, max: 50000, exact: true });
    expect(parseAmountRange('$15 001 - $50.000')).toMatchObject({ min: 15001, max: 50000, exact: true });
    expect(parseAmountRange('$1,001 - $15 000')).toMatchObject({ min: 1001, max: 15000, exact: true });
    expect(parseAmountRange('$50,001 - $100 000')).toMatchObject({ min: 50001, max: 100000, exact: true });
    expect(parseAmountRange('$100 001 • $250 000')).toMatchObject({ min: 100001, max: 250000, exact: true });
    expect(parseAmountRange('$50 001·$100 000')).toMatchObject({ min: 50001, max: 100000, exact: true });
  });

  it('parses a spaced or period open top tier', () => {
    expect(parseAmountRange('$50 000 001 +')).toMatchObject({ min: 50000001, max: null, exact: true });
    expect(parseAmountRange('$50.000.001 +')).toMatchObject({ min: 50000001, max: null, exact: true });
    expect(isValidBracket(parseAmountRange('$50 000 001 +').min!, null)).toBe(true);
  });

  it('does not treat fund-name / bond-year digits as a dollar amount', () => {
    for (const raw of [
      'BDT Capital Partners Fund 4 LP',
      'Mays-Allocate 2025 LP',
      'Dawson Portfolio Finance 6 LP',
      'OSWEGO ILL GO BDS 2016',
    ]) {
      expect(parseAmountRange(raw)).toMatchObject({ min: null, max: null, exact: false });
    }
  });
});
