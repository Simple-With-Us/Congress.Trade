import { describe, it, expect } from 'vitest';
import { buildMajorityRows, sameRowSet } from '../agreement.ts';
import { arbitrationRowKey } from '../../extractors/types.ts';
import type { CandidateDocResult } from '../bakeoff.ts';
import type { ParsedTx } from '../../shared/types.ts';

/**
 * Direct, no-I/O tests for the agreement-cascade fingerprint's text-field
 * normalization (materialRowFingerprint / sameRowSet), independent of the
 * full cascade integration tests in agreementCascade.test.ts. Exercised via
 * sameRowSet (the only exported entry point onto materialRowFingerprint) so
 * the tests never depend on the comparator's internal shape.
 */

function tx(over: Partial<ParsedTx> = {}): ParsedTx {
  return {
    txDate: '2026-06-19',
    owner: 'self',
    assetName: 'Apple Inc.',
    ticker: 'AAPL',
    assetType: 'ST',
    assetTypeName: 'Stock',
    txType: 'B',
    amountMin: 1001,
    amountMax: 15000,
    isOption: false,
    capGainsOver200: false,
    rawText: 'raw',
    filingStatus: null,
    subholding: null,
    location: null,
    description: null,
    supplementalText: null,
    confidence: 0.9,
    ...over,
  };
}

function read(rows: ParsedTx[], over: Partial<CandidateDocResult> = {}): CandidateDocResult {
  return {
    provider: 'openai',
    model: 'gpt-5.6-terra',
    docId: 'doc-1',
    ok: true,
    latencyMs: 100,
    rowCount: rows.length,
    rowKeys: rows.map((t) => arbitrationRowKey(t)),
    avgConfidence: rows.length ? rows.reduce((s, t) => s + t.confidence, 0) / rows.length : 0,
    rows,
    ...over,
  };
}

describe('agreement cascade text normalization — sameRowSet', () => {
  it('casing/punctuation/company-suffix variants of the SAME disclosed text agree when normalizeText=true', () => {
    // The production regression shape from the 324/324 cascade_unresolved
    // sample: both vendors correctly read "First Data Corp." but format it
    // differently — mixed case with a period, vs all-caps with no period.
    const a = read([tx({ assetName: 'First Data Corp.', ticker: null, confidence: 0.9 })]);
    const b = read([tx({ assetName: 'FIRST DATA CORP', ticker: null, confidence: 0.8 })]);
    expect(sameRowSet(a, b, true)).toBe(true);
  });

  it('a comma-punctuated variant of the same text also agrees when normalizeText=true', () => {
    const a = read([tx({ assetName: 'First Data Corp.', ticker: null })]);
    const c = read([tx({ assetName: 'First Data, Corp.', ticker: null })]);
    expect(sameRowSet(a, c, true)).toBe(true);
  });

  it('free-text field drift (description/subholding/supplementalText) also agrees when normalizeText=true', () => {
    const a = read([tx({
      description: 'Joint Account.', subholding: 'IRA, Fidelity', supplementalText: 'See Part 3.',
    })]);
    const b = read([tx({
      description: 'JOINT ACCOUNT', subholding: 'IRA Fidelity', supplementalText: 'SEE PART 3',
    })]);
    expect(sameRowSet(a, b, true)).toBe(true);
  });

  it('different tickers never agree, regardless of normalizeText', () => {
    const a = read([tx({ ticker: 'AAPL' })]);
    const b = read([tx({ ticker: 'MSFT' })]);
    expect(sameRowSet(a, b, true)).toBe(false);
    expect(sameRowSet(a, b, false)).toBe(false);
  });

  it('different amount brackets never agree, regardless of normalizeText', () => {
    const a = read([tx({ amountMin: 1001, amountMax: 15000 })]);
    const b = read([tx({ amountMin: 15001, amountMax: 50000 })]);
    expect(sameRowSet(a, b, true)).toBe(false);
    expect(sameRowSet(a, b, false)).toBe(false);
  });

  it('different owner/txType/filingStatus never agree — the 9 strict fields are unaffected by normalizeText', () => {
    const base = tx({ assetName: 'First Data Corp.' });
    expect(sameRowSet(read([base]), read([tx({ ...base, owner: 'spouse' })]), true)).toBe(false);
    expect(sameRowSet(read([base]), read([tx({ ...base, txType: 'S' })]), true)).toBe(false);
    expect(sameRowSet(read([base]), read([tx({ ...base, filingStatus: 'Amended' })]), true)).toBe(false);
  });

  it('kill-switch: the SAME near-miss text pair that agrees when normalizeText=true disagrees when normalizeText=false (restores legacy byte-strict behavior)', () => {
    const a = read([tx({ assetName: 'First Data Corp.', ticker: null })]);
    const b = read([tx({ assetName: 'FIRST DATA CORP', ticker: null })]);
    expect(sameRowSet(a, b, true)).toBe(true);
    expect(sameRowSet(a, b, false)).toBe(false);
  });

  it('row pairing (arbitrationRowKey) is unaffected by text drift when a ticker is present', () => {
    const t1 = tx({ ticker: 'AAPL', assetName: 'Apple Inc.' });
    const t2 = tx({ ticker: 'AAPL', assetName: 'APPLE INCORPORATED, COMMON STOCK' });
    expect(arbitrationRowKey(t1)).toBe(arbitrationRowKey(t2));
  });
});

describe('buildMajorityRows owner-qualified keys (CT-2397)', () => {
  function lot(owner: ParsedTx['owner'], amountMin: number, amountMax: number): ParsedTx {
    return tx({
      ticker: 'COO',
      assetName: 'Cooper Companies',
      owner,
      txDate: '2026-09-11',
      amountMin,
      amountMax,
    });
  }

  it('publishes same-day spouse and dependent lots instead of ambiguous_multi_lot', () => {
    const spouse = lot('spouse', 1001, 15000);
    const dependent = lot('dependent', 15001, 50000);
    const built = buildMajorityRows([
      read([spouse, dependent], { model: 'a' }),
      read([spouse, dependent], { model: 'b' }),
      read([dependent, spouse], { model: 'c' }),
    ], 3, true);
    expect(built.ok).toBe(true);
    expect(built.rows.map((row) => row.owner).sort()).toEqual(['dependent', 'spouse']);
    const byOwner = Object.fromEntries(built.rows.map((row) => [row.owner, [row.amountMin, row.amountMax]]));
    expect(byOwner.spouse).toEqual([1001, 15000]);
    expect(byOwner.dependent).toEqual([15001, 50000]);
  });

  it('still rejects two lots that share owner as ambiguous_multi_lot', () => {
    const first = lot('self', 1001, 15000);
    const second = lot('self', 15001, 50000);
    const built = buildMajorityRows([
      read([first, second]),
      read([first, second]),
      read([first, second]),
    ], 3, true);
    expect(built.ok).toBe(false);
    expect(built.reason).toContain('ambiguous_multi_lot:COO|2026-09-11|B|SELF');
  });

  it('still aligns a single lot when one read omitted owner', () => {
    const spouse = lot('spouse', 1001, 15000);
    const bare = lot(null, 1001, 15000);
    const built = buildMajorityRows([
      read([spouse], { model: 'a' }),
      read([spouse], { model: 'b' }),
      read([bare], { model: 'c' }),
    ], 3, true);
    expect(built.ok).toBe(true);
    expect(built.rows).toHaveLength(1);
    expect(built.rows[0].owner).toBe('spouse');
  });
});
