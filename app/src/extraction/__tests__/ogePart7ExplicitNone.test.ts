import { describe, expect, it } from 'vitest';
import {
  looksLikeNothingToReport,
  looksLikeOgePart7ExplicitNone,
} from '../extractRouting.ts';

describe('looksLikeOgePart7ExplicitNone', () => {
  it('matches a Bondi-style Part 7 whose body is only None', () => {
    const bondi = [
      'OGE Form 278e',
      '7. Transactions',
      'None',
      '',
      '8. Positions Held Outside',
    ].join('\n');
    expect(looksLikeOgePart7ExplicitNone(bondi)).toBe(true);
    expect(looksLikeOgePart7ExplicitNone('Part 7. Transactions\nN/A')).toBe(true);
    expect(looksLikeOgePart7ExplicitNone('7. Transactions\nNo transactions to report')).toBe(true);
    // Kept off the generic nothing-to-report detector.
    expect(looksLikeNothingToReport('7. Transactions\nNone')).toBe(false);
  });

  it('does not match Part 7 when a transaction row follows the heading', () => {
    expect(looksLikeOgePart7ExplicitNone('7. Transactions\n1 Apple Inc (AAPL) Purchase 01/02/2024')).toBe(false);
    expect(looksLikeOgePart7ExplicitNone('Part 7: Transactions\n1 Apple Inc Common Stock')).toBe(false);
  });

  it('stays false for empty text and for zero-row OCR that never says Part 7 None', () => {
    expect(looksLikeOgePart7ExplicitNone('')).toBe(false);
    expect(looksLikeOgePart7ExplicitNone(null)).toBe(false);
    expect(looksLikeOgePart7ExplicitNone(undefined)).toBe(false);
    const trumpBareZero = [
      'OGE Form 278-T',
      '1 Fobn.iary QUALCOMM salo 06/10/2022 No 50 000',
      'row 3600 garbled amount',
    ].join('\n');
    expect(looksLikeOgePart7ExplicitNone(trumpBareZero)).toBe(false);
    expect(looksLikeOgePart7ExplicitNone('None')).toBe(false);
  });
});
