import { describe, expect, it } from 'vitest';

import {
  fixCapsLWord,
  fixOcrDateToken,
  isValidCalendarDateYMD,
  matchKnownIssuer,
  normalizeEmbeddedOcrDates,
  normalizeOcrAssetName,
  validateTxDate,
} from '../ocrSanity.ts';
import { scoreFields } from '../normalizer.ts';

/**
 * CT-2441: OCR-sanity guards shared by the admin review path and the machine
 * extraction path.  Real Sep 17 Trump 278-T examples first, then impossible
 * dates, range rules, and the false-positive guards that must stay clean.
 */

const NULL_RESOLVER = () => null;

describe('isValidCalendarDateYMD', () => {
  it('accepts real dates', () => {
    expect(isValidCalendarDateYMD('2026-08-04')).toBe(true);
    expect(isValidCalendarDateYMD('2024-02-29')).toBe(true);
  });

  it('rejects impossible dates', () => {
    expect(isValidCalendarDateYMD('2026-02-30')).toBe(false);
    expect(isValidCalendarDateYMD('2023-02-29')).toBe(false);
    expect(isValidCalendarDateYMD('2026-13-01')).toBe(false);
    expect(isValidCalendarDateYMD('2026-00-10')).toBe(false);
    expect(isValidCalendarDateYMD('2026-04-31')).toBe(false);
    expect(isValidCalendarDateYMD('08/04/2026')).toBe(false);
    expect(isValidCalendarDateYMD('2026-8-4')).toBe(false);
    expect(isValidCalendarDateYMD('')).toBe(false);
  });
});

describe('validateTxDate', () => {
  it('accepts a clean trade date inside the filing window', () => {
    const check = validateTxDate('2026-08-04', { filedDate: '2026-09-17', today: '2026-10-23' });
    expect(check).toEqual({ ok: true, iso: '2026-08-04' });
  });

  it('rejects impossible dates with the bad_tx_date code', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2023-02-29', '08/04/2026', '']) {
      const check = validateTxDate(bad, { filedDate: '2026-09-17', today: '2026-10-23' });
      expect(check.ok).toBe(false);
      if (check.ok === false) expect(check.code).toBe('bad_tx_date');
    }
  });

  it('rejects future dates', () => {
    const check = validateTxDate('2026-10-24', { filedDate: '2026-09-17', today: '2026-10-23' });
    expect(check.ok).toBe(false);
    if (check.ok === false) expect(check.code).toBe('future_tx_date');
  });

  it('accepts after-filed trades per the tested soft rule', () => {
    // Sessions precedent: signed 2025-10-22 with a 10/24/2025 purchase.
    // After-filed skew stays a soft penalty in scoreFields, never a reject.
    const skewed = validateTxDate('2025-10-24', { filedDate: '2025-10-22', today: '2026-10-23' });
    expect(skewed.ok).toBe(true);
    const later = validateTxDate('2025-11-20', { filedDate: '2025-10-22', today: '2026-10-23' });
    expect(later.ok).toBe(true);
  });

  it('rejects dates more than two years before the filing date', () => {
    const old = validateTxDate('2023-01-01', { filedDate: '2026-09-17', today: '2026-10-23' });
    expect(old.ok).toBe(false);
    if (old.ok === false) expect(old.code).toBe('tx_date_too_old');
    const inside = validateTxDate('2025-06-01', { filedDate: '2026-09-17', today: '2026-10-23' });
    expect(inside.ok).toBe(true);
  });

  it('falls back to the absolute floor without a filing date', () => {
    const ancient = validateTxDate('1989-12-31', { today: '2026-10-23' });
    expect(ancient.ok).toBe(false);
    const modern = validateTxDate('2012-06-01', { today: '2026-10-23' });
    expect(modern.ok).toBe(true);
  });
});

describe('fixOcrDateToken', () => {
  it('maps confusable letters to digits', () => {
    expect(fixOcrDateToken('07/lS/2031')).toEqual({ iso: '2031-07-15', fixed: '07/15/2031' });
    expect(fixOcrDateToken('O8/1S/2030')).toEqual({ iso: '2030-08-15', fixed: '08/15/2030' });
  });

  it('repairs glued dates only when unambiguous', () => {
    expect(fixOcrDateToken('8/1012026')).toEqual({ iso: '2026-08-10', fixed: '8/10/2026' });
    expect(fixOcrDateToken('7/812026')).toEqual({ iso: '2026-07-08', fixed: '7/8/2026' });
    expect(fixOcrDateToken('717/2026')).toEqual({ iso: '2026-07-17', fixed: '7/17/2026' });
    // 11/1 and 11/11 both read validly, so no confident fix exists.
    expect(fixOcrDateToken('11/112026')).toBeNull();
  });

  it('returns clean dates unchanged', () => {
    expect(fixOcrDateToken('08/15/2030')).toEqual({ iso: '2030-08-15', fixed: '08/15/2030' });
  });

  it('accepts month/year tokens without holding them', () => {
    expect(fixOcrDateToken('08/2030')).toEqual({ iso: '2030-08-01', fixed: '08/2030' });
    expect(fixOcrDateToken('O8/2O3O')).toEqual({ iso: '2030-08-01', fixed: '08/2030' });
    expect(fixOcrDateToken('13/2030')).toBeNull();
  });

  it('refuses impossible dates even after mapping', () => {
    expect(fixOcrDateToken('02/30/2026')).toBeNull();
    expect(fixOcrDateToken('13/01/2026')).toBeNull();
    expect(fixOcrDateToken('13/lS/2031')).toBeNull();
  });
});

describe('normalizeEmbeddedOcrDates', () => {
  it('fixes an OCR-garbled maturity date', () => {
    const result = normalizeEmbeddedOcrDates('Space Exploration Notes Due 07/lS/2031');
    expect(result.text).toBe('Space Exploration Notes Due 07/15/2031');
    expect(result.changed).toBe(true);
    expect(result.holdReasons).toHaveLength(0);
  });

  it('holds impossible embedded dates instead of saving them', () => {
    const result = normalizeEmbeddedOcrDates('Bond Due 02/30/2026');
    expect(result.changed).toBe(false);
    expect(result.holdReasons).toHaveLength(1);
  });

  it('fixes a confusable month/year maturity instead of letting it through', () => {
    const result = normalizeEmbeddedOcrDates('Tarrant Rev Bie PTC 5.00 % Due O8/2O3O');
    expect(result.text).toBe('Tarrant Rev Bie PTC 5.00 % Due 08/2030');
    expect(result.changed).toBe(true);
    expect(result.holdReasons).toHaveLength(0);
  });

  it('holds a confusable month/year maturity with an impossible month', () => {
    const result = normalizeEmbeddedOcrDates('Muni Bond Due lS/2O3O');
    expect(result.changed).toBe(false);
    expect(result.holdReasons.join(' ')).toContain("unreadable embedded date 'lS/2O3O'");
  });

  it('never reads an all-letter slash token as a month/year date', () => {
    const result = normalizeEmbeddedOcrDates('Holdings S/BOSS Trust');
    expect(result.changed).toBe(false);
    expect(result.holdReasons).toHaveLength(0);
  });

  it('holds an unreadable month in a maturity window', () => {
    const result = normalizeEmbeddedOcrDates('Rev Bie PTC 5.00 % Duo Sao 1 2028');
    expect(result.holdReasons.join(' ')).toContain("unreadable month 'Sao'");
  });

  it('still fixes Duo before a garbled month while holding the month', () => {
    const result = normalizeOcrAssetName('Tarrant Rev Bie PTC 5.00 % Duo Sao 1 2028');
    expect(result.name).toBe('Tarrant Rev Bie PTC 5.00 % Due Sao 1 2028');
    expect(result.dateHolds.join(' ')).toContain("unreadable month 'Sao'");
  });

  it('leaves non-date slashes and clean dates alone', () => {
    for (const clean of [
      'Bexar Cnty TX Hosp Dist CTF Oblig DB 8/E 5.00 % Due Feb 15 2028',
      'Louisville Rev Bie 5.00 % Due Oct 1, 2047',
      'US TREASURY DUE 08/15/2030 0.625%',
      'King Cnty Wash Ltd 4.00% 12/1/32',
      'Muni Bond Due 08/2030',
    ]) {
      const result = normalizeEmbeddedOcrDates(clean);
      expect(result.changed).toBe(false);
      expect(result.holdReasons).toHaveLength(0);
    }
  });
});

describe('matchKnownIssuer', () => {
  it('matches the Sep 17 Uber row within distance 2', () => {
    expect(matchKnownIssuer('Uber Technolo1des Inc.')).toEqual({
      canonical: 'Uber Technologies Inc.',
      distance: 2,
    });
  });

  it('reports exact matches at distance 0', () => {
    expect(matchKnownIssuer('Uber Technologies Inc.')).toEqual({
      canonical: 'Uber Technologies Inc.',
      distance: 0,
    });
  });

  it('returns null far from every known issuer', () => {
    expect(matchKnownIssuer('Commonwealth Pa Fing Auth Tob MSTR SETTlMT')).toBeNull();
  });
});

describe('normalizeOcrAssetName — Sep 17 rows', () => {
  it('repairs the Uber typo via the known-issuer match', () => {
    const result = normalizeOcrAssetName('Uber Technolo1des Inc.');
    expect(result.name).toBe('Uber Technologies Inc.');
    expect(result.changed).toBe(true);
    expect(result.nameHolds).toHaveLength(0);
    expect(result.dateHolds).toHaveLength(0);
  });

  it('uppercases the stray l and Duo in the Commonwealth row', () => {
    const result = normalizeOcrAssetName(
      'Commonwealth Pa Fing Auth Tob MSTR SETTlMT PMT Rev Bie 5.00 % Duo Jun 1 2027',
    );
    expect(result.name).toBe(
      'Commonwealth Pa Fing Auth Tob MSTR SETTLMT PMT Rev Bie 5.00 % Due Jun 1 2027',
    );
    expect(result.nameHolds).toHaveLength(0);
    expect(result.dateHolds).toHaveLength(0);
  });

  it('repairs the SpaceX row dates and rate but holds the unreadable word', () => {
    const result = normalizeOcrAssetName(
      'Space Exploration Techn Senior Unsec\\iRED Notes Regs Due 07/lS/2031 0S.350%',
    );
    expect(result.name).toContain('Due 07/15/2031');
    expect(result.name).toContain('05.350%');
    expect(result.name).not.toContain('\\');
    expect(result.nameHolds.length).toBeGreaterThan(0);
    expect(result.dateHolds).toHaveLength(0);
  });

  it('repairs StepStone, L3Harris, Amazon, and Blackstone rows', () => {
    expect(normalizeOcrAssetName('STEPSlONE Group Inc.').name).toBe('StepStone Group Inc.');
    expect(normalizeOcrAssetName('l3HARRJS Technologies in').name).toBe('L3Harris Technologies Inc.');
    expect(normalizeOcrAssetName('Ama20n.Com Inc.').name).toBe('Amazon.com, Inc.');
    expect(normalizeOcrAssetName('BLACKSlONE MTG TR Inc. REIT').name).toBe(
      'BLACKSTONE MTG TR Inc. REIT',
    );
  });

  it('repairs a garbled word when a suffix blocks the whole-name match', () => {
    const result = normalizeOcrAssetName('Uber Technolo1des Inc. CMN');
    expect(result.name).toBe('Uber Technologies Inc. CMN');
    expect(result.nameHolds).toHaveLength(0);
  });

  it('repairs every copy of a repeated garbled word, not just the first', () => {
    const result = normalizeOcrAssetName('Uber Technolo1des Fund Technolo1des Holdings');
    expect(result.name).not.toContain('Technolo1des');
    expect(result.name).toBe('Uber Technologies Fund Technologies Holdings');
    expect(result.nameHolds).toHaveLength(0);
  });

  it('holds rows with no confident fix instead of guessing', () => {
    for (const garbled of [
      'Legal200m Com Inc.',
      'V3nRUard Index Fds MornlnO<Tar Mid Can ETF',
      'Ge Hc:Althc::Are Tcchnol01les Inc.',
      'Federated Hermes Government Oblll1::It1ons Fund Class Cu S',
    ]) {
      const result = normalizeOcrAssetName(garbled);
      expect(result.nameHolds.length).toBeGreaterThan(0);
    }
  });

  it('removes a stray backslash but holds the still-unreadable word', () => {
    const result = normalizeOcrAssetName('INl\\Jit');
    expect(result.name).toBe('INlJit');
    expect(result.nameHolds.length).toBeGreaterThan(0);
  });

  it('holds caps-l words with no known resolution instead of guessing L', () => {
    // Truth is NVIDIA CORP / unknown: no substitution yields a known token.
    const nv = normalizeOcrAssetName('NVlOIACORP');
    expect(nv.name).not.toBe('NVLOIACORP');
    expect(nv.name).toBe('NVlOIACORP');
    expect(nv.changed).toBe(false);
    expect(nv.nameHolds.length).toBeGreaterThan(0);
    const mob = normalizeOcrAssetName('MOBIUlY Global Inc.');
    expect(mob.name).not.toBe('MOBIULY Global Inc.');
    expect(mob.name).toBe('MOBIUlY Global Inc.');
    expect(mob.changed).toBe(false);
    expect(mob.nameHolds.length).toBeGreaterThan(0);
  });

  it('fixes caps-l words only when exactly one substitution is known', () => {
    // Truth is PPTYS (l->T) and MLTI (l->I): the uniquely known candidates.
    const pptys = normalizeOcrAssetName('JBG Smith PPlYS');
    expect(pptys.name).toBe('JBG Smith PPTYS');
    expect(pptys.name).not.toContain('PPLYS');
    expect(pptys.nameHolds).toHaveLength(0);
    const mlti = normalizeOcrAssetName(
      'Columbus in MLTl SCH BLDG Corp. Pptytax 1ST MTG Rev Bie ST Intrcpt 5.00 % Due Jul 15 2027',
    );
    expect(mlti.name).toContain('Columbus in MLTI SCH BLDG Corp.');
    expect(mlti.name).not.toContain('MLTL');
    expect(mlti.nameHolds).toHaveLength(0);
    const cnty = normalizeOcrAssetName('Miami-Dade CNlY');
    expect(cnty.name).toBe('Miami-Dade CNTY');
    expect(cnty.nameHolds).toHaveLength(0);
  });

  it('keeps the trusted caps-l fixes working', () => {
    expect(normalizeOcrAssetName('Commonwealth Pa Fing Auth Tob MSTR SETTlMT').name).toContain(
      'SETTLMT',
    );
    expect(normalizeOcrAssetName('BLACKSlONE MTG TR Inc. REIT').name).toBe(
      'BLACKSTONE MTG TR Inc. REIT',
    );
  });

  it('holds when two substitutions both yield known words', () => {
    expect(fixCapsLWord('TAlL', 'TAlL', new Set(['tall', 'tail']))).toBeNull();
    expect(fixCapsLWord('TAlL', 'TAlL', new Set(['tail']))).toEqual({
      winner: 'TAIL',
      kind: 'word',
    });
  });

  it('tries l->1 only where a digit reading is sensible', () => {
    expect(fixCapsLWord('ABl1', 'ABl1', new Set(['ab11']))).toEqual({
      winner: 'AB11',
      kind: 'word',
    });
    expect(fixCapsLWord('ABlC', 'ABlC', new Set(['ab1c']))).toBeNull();
    expect(fixCapsLWord('ABllll', 'ABllll', new Set(['abllll']))).toBeNull();
  });
});

describe('normalizeOcrAssetName — false-positive guards', () => {
  it('leaves legit names untouched', () => {
    for (const clean of [
      '3M Co',
      'Alphabet Inc Class A',
      'S&P 500',
      'US Treasury Note 91282CJL6',
      '91282CJL6',
      'Invesco QQQ Trust, Series 2021A',
      'ACME Corp 5.25% Due 08/15/2030',
      'L3Harris Technologies Inc.',
      'Amazon.com, Inc.',
      'Uber Technologies Inc. CMN',
      'Duo Security LLC',
      'B2Gold Corp',
      'Apple Inc.',
      'US TREASURY DUE 08/15/2030 0.625%',
      'King Cnty Wash Ltd 4.00% 12/1/32',
      'Muni Rev Rate/Coupon: 5.0% Matures: 05/01/2026',
    ]) {
      const result = normalizeOcrAssetName(clean);
      expect(result.name).toBe(clean);
      expect(result.changed).toBe(false);
      expect(result.nameHolds).toHaveLength(0);
      expect(result.dateHolds).toHaveLength(0);
    }
  });
});

describe('scoreFields OCR integration', () => {
  const base = {
    ticker: null as string | null,
    amountMin: 1001,
    amountMax: 15000,
    txType: 'B',
    txDate: '2024-06-14',
  };

  it('does not flag a name the normalizer confidently repairs', () => {
    const scored = scoreFields(
      0.97,
      { ...base, assetName: 'Uber Technolo1des Inc.' },
      '2024-07-01',
      NULL_RESOLVER,
    );
    expect(scored.flags).not.toContain('ocr_name_hold');
    expect(scored.flags).not.toContain('ocr_date_hold');
  });

  it('holds unfixable name and date garble as hard failures', () => {
    const name = scoreFields(
      0.97,
      { ...base, assetName: 'Legal200m Com Inc.' },
      '2024-07-01',
      NULL_RESOLVER,
    );
    expect(name.flags).toContain('ocr_name_hold');
    const date = scoreFields(
      0.97,
      { ...base, assetName: 'Bond Due 02/30/2026' },
      '2024-07-01',
      NULL_RESOLVER,
    );
    expect(date.flags).toContain('ocr_date_hold');
  });

  it('flags impossible and out-of-range trade dates', () => {
    const bad = scoreFields(
      0.97,
      { ...base, assetName: 'Apple Inc.', txDate: '2026-02-30' },
      '2026-09-17',
      NULL_RESOLVER,
    );
    expect(bad.flags).toContain('bad_tx_date');
    const old = scoreFields(
      0.97,
      { ...base, assetName: 'Apple Inc.', txDate: '2020-01-01' },
      '2026-09-17',
      NULL_RESOLVER,
    );
    expect(old.flags).toContain('tx_date_too_old');
  });

  it('keeps after-filed skew soft, never a hard failure', () => {
    const skewed = scoreFields(
      0.97,
      { ...base, assetName: 'Apple Inc.', txDate: '2025-10-24' },
      '2025-10-22',
      NULL_RESOLVER,
    );
    expect(skewed.flags).toContain('tx_after_filed_date');
    expect(skewed.flags).not.toContain('bad_tx_date');
    expect(skewed.flags).not.toContain('tx_date_too_old');
    expect(skewed.flags).not.toContain('future_tx_date');
  });
});
