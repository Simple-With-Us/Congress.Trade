import { describe, expect, it } from 'vitest';
import {
  SEMANTIC_DARK,
  SEMANTIC_DARK_NEG,
  SEMANTIC_LIGHT,
  WCAG_AA_NORMAL_TEXT,
  contrastRatio,
  darkNegativeTextContrastCases,
  lightSemanticTextContrastCases,
} from '../semanticThemeTokens.ts';

describe('semanticThemeTokens (CT-1356)', () => {
  it('documents the pre-fix failure mode: dark --good on a light card is ~2:1', () => {
    const ratio = contrastRatio(SEMANTIC_DARK.good, '#ffffff');
    expect(ratio).toBeGreaterThan(1.8);
    expect(ratio).toBeLessThan(2.1);
  });

  it('keeps every light-mode semantic text case at or above 4.5:1', () => {
    const cases = lightSemanticTextContrastCases();
    const failures = cases.filter((c) => c.ratio < WCAG_AA_NORMAL_TEXT);
    expect(failures).toEqual([]);
  });

  it('pins light dashboard CSS variables to the canonical token module', () => {
    // Values are injected into dashboardHtml.ts from SEMANTIC_LIGHT — this
    // assertion catches drift if someone edits the template literals by hand.
    expect(SEMANTIC_LIGHT.buy).toBe('#166534');
    expect(SEMANTIC_LIGHT.sell).toBe('#991b1b');
    expect(SEMANTIC_LIGHT.warn).toBe('#9a3412');
    expect(SEMANTIC_LIGHT.good).toBe('#166534');
  });

  it('keeps dark pill chrome hues; --neg is lighter sell ink for status text', () => {
    expect(SEMANTIC_DARK.good).toBe('#34d399');
    expect(SEMANTIC_DARK.buy).toBe('#22c55e');
    expect(SEMANTIC_DARK.sell).toBe('#ef4444');
    expect(SEMANTIC_DARK.warn).toBe('#f59e0b');
    expect(SEMANTIC_DARK_NEG).toBe('#f87d80');
  });

  it('dark --neg text meets 4.5:1 on every dark panel surface and sell-tint mix', () => {
    const cases = darkNegativeTextContrastCases();
    const failures = cases.filter((c) => c.ratio < WCAG_AA_NORMAL_TEXT);
    expect(failures).toEqual([]);
    expect(contrastRatio(SEMANTIC_DARK.sell, '#172440')).toBeLessThan(WCAG_AA_NORMAL_TEXT);
    expect(contrastRatio(SEMANTIC_DARK_NEG, '#172440')).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });
});
