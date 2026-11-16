import { describe, expect, it } from 'vitest';
import {
  EXECUTIVE_TITLES,
  EXECUTIVE_TITLES_SHORT,
  EXECUTIVE_TITLE_MAX_LENGTH,
  DEFAULT_EXECUTIVE_TITLE,
  executiveTitleFor,
  executiveTitleForBudget,
  executiveTitleForms,
  fitExecutiveTitle,
  shortExecutiveTitle,
} from '../executiveTitles.ts';

describe('executiveTitleFor', () => {
  it('returns the curated title for a known executive filer', () => {
    expect(executiveTitleFor('EXEC-DJT')).toBe('President');
    expect(executiveTitleFor('EXEC-BESSENT')).toBe('Treasury Secretary');
    expect(executiveTitleFor('EXEC-CWRIGHT')).toBe('Energy Secretary');
    expect(executiveTitleFor('EXEC-MCMAHON')).toBe('Education Secretary');
  });

  it('maps every -ERM/dated duplicate variant of a curated person to the same title', () => {
    // The identity-dedupe merge may pick either variant id as canonical, so
    // both must resolve to the same display title.
    expect(executiveTitleFor('EXEC-ANTHONY-J-BLINKEN')).toBe('Secretary of State');
    expect(executiveTitleFor('EXEC-ANTHONY-J-BLINKEN-2025-ERM')).toBe('Secretary of State');
    expect(executiveTitleFor('EXEC-BARBARA-M-BARRETT')).toBe('Secretary of the Air Force');
    expect(executiveTitleFor('EXEC-BARBARA-M-BARRETT-2021-ERM')).toBe('Secretary of the Air Force');
    expect(executiveTitleFor('EXEC-BABARA-M-BARRETT')).toBe('Secretary of the Air Force');
  });

  it('falls back to the default label for an EXEC-* id with no curated entry', () => {
    expect(executiveTitleFor('EXEC-SOME-UNCURATED-NOMINEE')).toBe(DEFAULT_EXECUTIVE_TITLE);
  });

  it('returns null for a non-executive (House/Senate) filer id', () => {
    expect(executiveTitleFor('house-tx10-jane-smith')).toBeNull();
    expect(executiveTitleFor('senate-ted-cruz')).toBeNull();
    expect(executiveTitleFor('MANUAL-KHANNA')).toBeNull();
  });

  it('gives a competitor-minted MANUAL-* official filed under chamber=executive the truthful fallback, never a guessed title (85f2170a)', () => {
    expect(executiveTitleFor('MANUAL-HEGSETH', 'executive')).toBe(DEFAULT_EXECUTIVE_TITLE);
    // A House member stays title-less even when a chamber is passed.
    expect(executiveTitleFor('MANUAL-JORDAN', 'house')).toBeNull();
    expect(executiveTitleFor('MANUAL-JORDAN', 'senate')).toBeNull();
    // A curated EXEC-* id keeps its curated title regardless of the chamber argument.
    expect(executiveTitleFor('EXEC-CWRIGHT', 'executive')).toBe('Energy Secretary');
  });

  it('returns null for missing/empty input', () => {
    expect(executiveTitleFor(null)).toBeNull();
    expect(executiveTitleFor(undefined)).toBeNull();
    expect(executiveTitleFor('')).toBeNull();
  });

  it('every curated key starts with EXEC- (guards against a typoed map key silently never matching)', () => {
    for (const key of Object.keys(EXECUTIVE_TITLES)) {
      expect(key.startsWith('EXEC-')).toBe(true);
    }
  });
});

describe('EXECUTIVE_TITLES_SHORT', () => {
  it('covers every curated title plus the uncurated fallback', () => {
    const covered = new Set(Object.keys(EXECUTIVE_TITLES_SHORT));
    for (const title of Object.values(EXECUTIVE_TITLES)) {
      expect(covered.has(title), `no short form for "${title}"`).toBe(true);
    }
    expect(covered.has(DEFAULT_EXECUTIVE_TITLE)).toBe(true);
  });

  it('never abbreviates to something longer than the full title', () => {
    for (const [long, short] of Object.entries(EXECUTIVE_TITLES_SHORT)) {
      expect(short.length, `"${short}" is not shorter than "${long}"`).toBeLessThanOrEqual(long.length);
      expect(short.trim()).toBe(short);
      expect(short.length).toBeGreaterThan(0);
    }
  });

  it('keeps every short form inside a narrow-cell budget (<= 19 chars)', () => {
    // 'Transportation Sec.' is the longest short form; anything past it stops
    // being "short" for the compact rows that reach for these.
    for (const short of Object.values(EXECUTIVE_TITLES_SHORT)) {
      expect(short.length, `"${short}" exceeds the 19-char short budget`).toBeLessThanOrEqual(19);
    }
  });

  it('exposes the longest curated title length (28 = "Social Security Commissioner")', () => {
    expect(EXECUTIVE_TITLE_MAX_LENGTH).toBe('Social Security Commissioner'.length);
    expect(EXECUTIVE_TITLE_MAX_LENGTH).toBe(28);
  });
});

describe('shortExecutiveTitle', () => {
  it('abbreviates a curated title', () => {
    expect(shortExecutiveTitle('Treasury Secretary')).toBe('Treasury Sec.');
    expect(shortExecutiveTitle('Social Security Commissioner')).toBe('SSA Commissioner');
    expect(shortExecutiveTitle('MCC Chief Executive Officer')).toBe('MCC CEO');
    expect(shortExecutiveTitle(DEFAULT_EXECUTIVE_TITLE)).toBe('Executive');
  });

  it('passes an unrecognised title through rather than inventing an abbreviation', () => {
    expect(shortExecutiveTitle('Ambassador to Freedonia')).toBe('Ambassador to Freedonia');
  });

  it('returns null for blank input', () => {
    expect(shortExecutiveTitle(null)).toBeNull();
    expect(shortExecutiveTitle('   ')).toBeNull();
  });
});

describe('fitExecutiveTitle', () => {
  it('keeps the full title when it fits', () => {
    expect(fitExecutiveTitle('Treasury Secretary', 30)).toBe('Treasury Secretary');
    expect(fitExecutiveTitle('Treasury Secretary', 18)).toBe('Treasury Secretary');
  });

  it('drops to the short form only once the full title overflows', () => {
    expect(fitExecutiveTitle('Treasury Secretary', 17)).toBe('Treasury Sec.');
    expect(fitExecutiveTitle('Social Security Commissioner', 20)).toBe('SSA Commissioner');
  });

  it('treats a missing/zero budget as unconstrained (longest form wins)', () => {
    expect(fitExecutiveTitle('Treasury Secretary')).toBe('Treasury Secretary');
    expect(fitExecutiveTitle('Treasury Secretary', 0)).toBe('Treasury Secretary');
    expect(fitExecutiveTitle('Treasury Secretary', Number.NaN)).toBe('Treasury Secretary');
  });

  it('returns the complete short form rather than a chopped string when even that overflows', () => {
    // 'MCC CEO' (7) still exceeds a 4-char budget; a real title the layout can
    // ellipsize beats 'MCC…' invented here.
    expect(fitExecutiveTitle('MCC Chief Executive Officer', 4)).toBe('MCC CEO');
  });

  it('never truncates mid-word', () => {
    for (const title of Object.values(EXECUTIVE_TITLES)) {
      for (const budget of [4, 8, 12, 16, 20, 28]) {
        const fitted = fitExecutiveTitle(title, budget);
        expect(fitted === title || fitted === EXECUTIVE_TITLES_SHORT[title]).toBe(true);
      }
    }
  });

  it('every curated title fits the full 28-char budget without abbreviating', () => {
    for (const title of Object.values(EXECUTIVE_TITLES)) {
      expect(fitExecutiveTitle(title, EXECUTIVE_TITLE_MAX_LENGTH)).toBe(title);
    }
  });

  it('returns null for blank input', () => {
    expect(fitExecutiveTitle(null, 10)).toBeNull();
    expect(fitExecutiveTitle('', 10)).toBeNull();
  });
});

describe('executiveTitleForBudget', () => {
  it('resolves the filer then fits the budget', () => {
    expect(executiveTitleForBudget('EXEC-BESSENT', 30)).toBe('Treasury Secretary');
    expect(executiveTitleForBudget('EXEC-BESSENT', 14)).toBe('Treasury Sec.');
    expect(executiveTitleForBudget('EXEC-FRANK-J-BISIGNANO', 20)).toBe('SSA Commissioner');
  });

  it('shortens the uncurated fallback too, and never prefixes a real title with it', () => {
    expect(executiveTitleForBudget('EXEC-SOME-UNCURATED-NOMINEE', 30)).toBe('Executive Branch');
    expect(executiveTitleForBudget('EXEC-SOME-UNCURATED-NOMINEE', 12)).toBe('Executive');
    expect(executiveTitleForBudget('EXEC-BESSENT', 12)).not.toContain('Executive');
  });

  it('stays null for congressional filers', () => {
    expect(executiveTitleForBudget('house-tx10-jane-smith', 12)).toBeNull();
  });
});

describe('executiveTitleForms', () => {
  it('snapshots both maps plus both fallbacks for inlining into the browser bundle', () => {
    const forms = executiveTitleForms();
    expect(forms.titles['EXEC-BESSENT']).toBe('Treasury Secretary');
    expect(forms.short['Treasury Secretary']).toBe('Treasury Sec.');
    expect(forms.fallback).toBe(DEFAULT_EXECUTIVE_TITLE);
    expect(forms.fallbackShort).toBe('Executive');
  });

  it('returns copies, so a caller mutating the snapshot cannot corrupt the source maps', () => {
    const forms = executiveTitleForms();
    forms.titles['EXEC-BESSENT'] = 'Chief Vandal';
    forms.short['Treasury Secretary'] = 'Chief Vandal';
    expect(EXECUTIVE_TITLES['EXEC-BESSENT']).toBe('Treasury Secretary');
    expect(EXECUTIVE_TITLES_SHORT['Treasury Secretary']).toBe('Treasury Sec.');
  });

  it('serializes to JSON cleanly (it is embedded in the dashboard bundle)', () => {
    expect(() => JSON.parse(JSON.stringify(executiveTitleForms()))).not.toThrow();
  });
});
