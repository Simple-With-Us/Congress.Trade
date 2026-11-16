/**
 * Pipeline hardening from the Trump OGE 278-T repairs (GB-Publisher):
 * impossible dates, junk asset names, off-by-one bracket lower bounds, and the
 * 278-T row-completeness gate.  Each guard is checked at its pure helper and
 * at scoreFields, the shared row rubric every pipeline publisher runs.
 */
import { describe, expect, it } from 'vitest';

import { canonicalizeAmountBounds } from '../amounts.ts';
import {
  junkAssetNameReason,
  OCR_TX_DATE_AFTER_FILED_GRACE_DAYS,
  validateTxDate,
} from '../ocrSanity.ts';
import { HARD_FAILURE_FLAGS, hasHardFailureFlags, scoreFields, type TickerResolver } from '../normalizer.ts';
import { assessOgeRowCompleteness, parseOgeTransactionRows } from '../ogeText.ts';

const NULL_RESOLVER: TickerResolver = () => null;
const TODAY = '2026-10-25';

function score(fields: Partial<Parameters<typeof scoreFields>[1]>, filedDate: string | null = '2026-09-08') {
  return scoreFields(
    0.97,
    {
      ticker: null,
      assetName: 'Badger Meter Inc.',
      amountMin: 50001,
      amountMax: 100000,
      txType: 'S',
      txDate: '2026-07-29',
      rawText: null,
      ...fields,
    },
    filedDate,
    NULL_RESOLVER,
  );
}

describe('trade-date window (pipeline publish path)', () => {
  it('holds the impossible OCR dates the Trump filings published', () => {
    // 1202-07-02 (09-08-2026 filing) and 2006-03-02 (4/20 filing).
    const y1202 = score({ txDate: '1202-07-02' }, '2026-09-08');
    expect(y1202.flags).toContain('tx_date_too_old');
    expect(hasHardFailureFlags([y1202])).toBe(true);
    const y2006 = score({ txDate: '2006-03-02' }, '2026-04-20');
    expect(y2006.flags).toContain('tx_date_too_old');
    expect(hasHardFailureFlags([y2006])).toBe(true);
  });

  it('holds a trade dated more than the grace window after the filing', () => {
    const check = validateTxDate('2026-10-20', { filedDate: '2026-09-08', today: TODAY });
    expect(check.ok).toBe(false);
    if (check.ok === false) expect(check.code).toBe('tx_date_after_filing_window');
    const scored = score({ txDate: '2026-10-20' }, '2026-09-08');
    expect(scored.flags).toContain('tx_date_after_filing_window');
    expect(HARD_FAILURE_FLAGS).toContain('tx_date_after_filing_window');
  });

  it('keeps small after-filed skew soft (Sessions precedent) up to the grace edge', () => {
    expect(OCR_TX_DATE_AFTER_FILED_GRACE_DAYS).toBe(31);
    const edge = validateTxDate('2025-11-22', { filedDate: '2025-10-22', today: TODAY });
    expect(edge.ok).toBe(true);
    const past = validateTxDate('2025-11-23', { filedDate: '2025-10-22', today: TODAY });
    expect(past.ok).toBe(false);
    const skew = score({ txDate: '2025-10-24' }, '2025-10-22');
    expect(skew.flags).toContain('tx_after_filed_date');
    expect(hasHardFailureFlags([skew])).toBe(false);
  });
});

describe('junk asset names', () => {
  it('flags blank names and names that start with junk glyphs', () => {
    for (const name of ['', '   ', '••• APPLE INC', '\u2022 MICROSOFT CORP', '"Tesla Inc', "' NVIDIA CORP", '\u201cAlphabet', '... Apple', '-- MSFT', '| Oracle', '\uFFFDCostco']) {
      expect(junkAssetNameReason(name), name).not.toBeNull();
    }
    expect(junkAssetNameReason('')).toBe('blank_asset_name');
    expect(junkAssetNameReason('••• APPLE INC')).toBe('junk_leading_glyph');
  });

  it('passes real names, including ones that start with digits, $ or (', () => {
    for (const name of ['3M Co', 'Apple Inc.', '$ Treasury Note', '(The) Walt Disney Co', 'S&P 500 ETF', 'AT&T INC', 'iShares Core', 'Miami Dade Cnty FL 5.00 % Due Oct 1, 2031', '-Apple']) {
      expect(junkAssetNameReason(name), name).toBeNull();
    }
  });

  it('scoreFields holds a junk-led name as bad_asset_name', () => {
    const scored = score({ assetName: '••• Badger Meter Inc.' });
    expect(scored.flags).toContain('bad_asset_name');
    expect(hasHardFailureFlags([scored])).toBe(true);
    expect(score({}).flags).not.toContain('bad_asset_name');
  });
});

describe('amount bracket lower bounds', () => {
  it('snaps an off-by-one lower bound to the canonical OGE/House bracket', () => {
    expect(canonicalizeAmountBounds(1000, 15000)).toEqual({ min: 1001, max: 15000, changed: true });
    expect(canonicalizeAmountBounds(15000, 50000)).toEqual({ min: 15001, max: 50000, changed: true });
    expect(canonicalizeAmountBounds(1000000, 5000000)).toEqual({ min: 1000001, max: 5000000, changed: true });
    expect(canonicalizeAmountBounds(50000000, null)).toEqual({ min: 50000001, max: null, changed: true });
  });

  it('leaves canonical brackets and the $0-$1,000 tier alone, and refuses the rest', () => {
    expect(canonicalizeAmountBounds(1001, 15000)).toEqual({ min: 1001, max: 15000, changed: false });
    expect(canonicalizeAmountBounds(0, 1000)).toEqual({ min: 0, max: 1000, changed: false });
    expect(canonicalizeAmountBounds(1000, 20000)).toBeNull();
    expect(canonicalizeAmountBounds(999, 15000)).toBeNull();
    expect(canonicalizeAmountBounds(null, 15000)).toBeNull();
  });

  it('scoreFields publishes $1,000-$15,000 as $1,001-$15,000 without a penalty', () => {
    const scored = score({ amountMin: 1000, amountMax: 15000 });
    expect(scored.amountMin).toBe(1001);
    expect(scored.amountMax).toBe(15000);
    expect(scored.flags).not.toContain('invalid_amount');
  });

  it('scoreFields flags a pair no bracket contains instead of publishing it raw', () => {
    const scored = score({ amountMin: 1000, amountMax: 20000 });
    expect(scored.flags).toContain('invalid_amount');
    expect(hasHardFailureFlags([scored])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 278-T completeness
// ---------------------------------------------------------------------------

const HEADER = 'Transactions # DESCRIPTION TYPE DATE NOTIFICATION RECEIVED OVER 30 DAYS AGO AMOUNT';
const NAMES = ['Apple Inc.', 'Microsoft Corp.', 'Badger Meter Inc.', 'Teleflex Inc.', 'Etsy Inc.', 'Lazard Inc.', 'Costco Whsl Corp.', 'Plexus Corp.', 'Cooper Cos Inc.', 'Xencor Inc.'];

/** A flattened 278-T text layer with rows 1..10; `garble` rows lose their type word. */
function oge278tText(garble: number[] = []): string {
  const rows = NAMES.map((name, i) => {
    const n = i + 1;
    const type = garble.includes(n) ? 'Salo' : 'Sale';
    return `${n} ${name} ${type} 07/29/2026 No $1,001 - $15,000`;
  });
  return `Trump, Donald J. - Page 2 ${HEADER} ${rows.join(' ')} Trump, Donald J. - Page 3 Endnotes`;
}

describe('assessOgeRowCompleteness', () => {
  it('reports complete when every numbered row parsed', () => {
    const text = oge278tText();
    const rows = parseOgeTransactionRows(text);
    expect(rows).toHaveLength(10);
    const result = assessOgeRowCompleteness(text, rows);
    expect(result).toMatchObject({ expectedRows: 10, missingCount: 0, evidence: 'text_layer' });
  });

  it('reports the row a garbled type word dropped', () => {
    const text = oge278tText([5]);
    const rows = parseOgeTransactionRows(text);
    expect(rows.length).toBe(9);
    const result = assessOgeRowCompleteness(text, rows);
    expect(result?.expectedRows).toBe(10);
    expect(result?.missingCount).toBe(1);
    expect(result?.missingRowNumbers).toHaveLength(1);
  });

  it('compares counts only for a reader whose rows carry no row numbers', () => {
    const text = oge278tText();
    const visionRows = NAMES.slice(0, 8).map((name) => ({ rawText: `sale $1 001 - $15 000 ${name.toUpperCase()}`, supplementalText: null }));
    const result = assessOgeRowCompleteness(text, visionRows);
    expect(result).toMatchObject({ expectedRows: 10, missingCount: 2, missingRowNumbers: [] });
    const fullVision = NAMES.map((name) => ({ rawText: `sale ${name}`, supplementalText: null }));
    expect(assessOgeRowCompleteness(text, fullVision)?.missingCount).toBe(0);
  });

  it('uses the rows\' own numbers when there is no text layer (vision / hand transcription)', () => {
    const rows = [1, 2, 3, 5, 6].map((n) => ({ rawText: `#${n} ROW`, supplementalText: `OGE 278-T row ${n}, page 2 of 3` }));
    const result = assessOgeRowCompleteness(null, rows);
    expect(result).toMatchObject({ expectedRows: 6, evidence: 'parsed_row_numbers', missingRowNumbers: [4], missingCount: 1 });
  });

  it('returns null (unknown, not complete) without a 278-T table or row numbers', () => {
    expect(assessOgeRowCompleteness('no table here', [{ rawText: 'Apple purchase', supplementalText: null }])).toBeNull();
    expect(assessOgeRowCompleteness(null, [{ rawText: 'Apple purchase', supplementalText: null }])).toBeNull();
  });
});
