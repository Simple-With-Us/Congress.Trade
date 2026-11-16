/**
 * Board row 16b46688 — 32.6% of published trades carried no ticker.  The names
 * below are the real asset descriptions from Rep. Ro Khanna's H-2026-9116267
 * (live /api/transactions, 2026-09-18), matched against securities_ref-shaped
 * company names ("Uber Technologies, Inc.", "Coca-Cola Company (The)"...).
 */
import { describe, expect, it } from 'vitest';
import {
  buildIssuerNameIndex,
  issuerNameKeys,
  resolveTickerByIssuerName,
} from '../nameTickerBackfill.ts';

const REF: Array<{ ticker: string; name: string; priced?: boolean }> = [
  { ticker: 'UBER', name: 'Uber Technologies, Inc.' },
  { ticker: 'KO', name: 'Coca-Cola Company (The)' },
  { ticker: 'CMCSA', name: 'Comcast Corporation Class A' },
  { ticker: 'MSFT', name: 'Microsoft Corporation' },
  { ticker: 'V', name: 'Visa Inc.' },
  { ticker: 'TSLA', name: 'Tesla, Inc.' },
  { ticker: 'T', name: 'AT&T Inc.', priced: true },
  { ticker: 'T-PC', name: 'AT&T Inc.' },
  { ticker: 'HD', name: 'Home Depot, Inc. (The)' },
  { ticker: 'SBUX', name: 'Starbucks Corporation' },
  { ticker: 'CHWY', name: 'Chewy, Inc.' },
  { ticker: 'GEHC', name: 'GE HealthCare Technologies Inc.' },
  { ticker: 'APO', name: 'Apollo Global Management, Inc. (New)' },
  { ticker: 'NVDA', name: 'NVIDIA Corporation' },
  { ticker: 'AMZN', name: 'Amazon.com, Inc.' },
  { ticker: 'META', name: 'Meta Platforms, Inc. Class A' },
  { ticker: 'GOOGL', name: 'Alphabet Inc. Class A' },
  { ticker: 'GOOG', name: 'Alphabet Inc. Class C Capital Stock' },
  { ticker: 'JPM', name: 'JPMorgan Chase & Co.' },
  { ticker: 'JPM^J', name: 'JPMorgan Chase & Co. Depositary Shares, each representing 1/400th interest in a share of 4.75% Preferred Stock' },
];
const index = buildIssuerNameIndex(REF);

describe('issuerNameKeys', () => {
  it('drops legal forms, share descriptors, "the", parentheticals and a trailing footnote digit', () => {
    expect(issuerNameKeys('Uber Technologies Inc. CMN', { isQuery: true })?.base).toBe('uber technologies');
    expect(issuerNameKeys('Coca Cola Company (the) CMN', { isQuery: true })?.base).toBe('coca cola');
    expect(issuerNameKeys('Coca-Cola Company (The)')?.base).toBe('coca cola');
    // "Corp.CMN" fuses two words in the raw text; punctuation must split them.
    expect(issuerNameKeys('Starbucks Corp.CMN 6', { isQuery: true })?.base).toBe('starbucks');
  });

  it('keeps the share class as a separate, more specific key', () => {
    const k = issuerNameKeys('Comcast Corporation CMN Class A Voting', { isQuery: true });
    expect(k?.base).toBe('comcast');
    expect(k?.classed).toBe('comcast class a');
    expect(k?.shareClass).toBe('a');
  });

  it('flags bonds, preferreds, funds, options and coupons as non-equity', () => {
    for (const n of [
      'JPMorgan Chase & Co. Perp NN 6.8750%',
      'Microsoft Corp. 3.5% Notes due 2035',
      'JPMorgan Chase & Co. Preferred Series J',
      'Vanguard 500 Index Fund',
      'Apple Inc. Call Option',
    ]) {
      expect(issuerNameKeys(n, { isQuery: true })?.nonEquity, n).toBe(true);
    }
  });
});

describe('resolveTickerByIssuerName: the Khanna H-2026-9116267 names (all live ticker=null)', () => {
  const cases: Array<[string, string]> = [
    ['Uber Technologies Inc. CMN', 'UBER'],
    ['Coca Cola Company (the) CMN', 'KO'],
    ['Comcast Corporation CMN Class A Voting', 'CMCSA'],
    ['Microsoft Corporation CMN', 'MSFT'],
    ['Visa Inc. CMN Class A', 'V'],
    ['Tesla Inc. CMN', 'TSLA'],
    ['At&T Inc. CMN', 'T'],
    ['The Home Depot Inc. CMN', 'HD'],
    ['Starbucks Corp.CMN 6', 'SBUX'],
    ['Chewy Inc. CMN Class A', 'CHWY'],
    ['Ge Healthcare Technologies Inc. CMN', 'GEHC'],
    ['Apollo Global MGMT Inc. Com', 'APO'],
    ['Nvidia Corp.', 'NVDA'],
    ['Amazon.com Inc. CMN', 'AMZN'],
    ['Meta Platforms Inc. CMN Class A', 'META'],
  ];
  it.each(cases)('%s -> %s', (name, ticker) => {
    expect(resolveTickerByIssuerName(index, name)).toBe(ticker);
  });
});

describe('resolveTickerByIssuerName: never guesses', () => {
  it('does not resolve a bond, perpetual or preferred even when the issuer name matches exactly', () => {
    expect(resolveTickerByIssuerName(index, 'JPMorgan Chase & Co. Perp NN 6.8750% (')).toBeNull();
    expect(resolveTickerByIssuerName(index, 'JPMorgan Chase & Co. Preferred Series J')).toBeNull();
    // ...while the plain common-stock description still does.
    expect(resolveTickerByIssuerName(index, 'JPMorgan Chase & Co. CMN')).toBe('JPM');
  });

  it('resolves dual-class issuers by the described class and refuses to hand Class C the Class A ticker', () => {
    expect(resolveTickerByIssuerName(index, 'Alphabet Inc. CMN Class A')).toBe('GOOGL');
    expect(resolveTickerByIssuerName(index, 'Alphabet Inc. CMN Class C')).toBe('GOOG');
    // A bare "Alphabet" is ambiguous (two live tickers, both with class keys).
    expect(resolveTickerByIssuerName(index, 'Alphabet Inc.')).toBeNull();
    // Class C described, but the index only knows an un-classed name: refuse, never inherit Class A.
    const onlyUnclassed = buildIssuerNameIndex([{ ticker: 'GOOGL', name: 'Alphabet Inc.' }]);
    expect(resolveTickerByIssuerName(onlyUnclassed, 'Alphabet Inc. CMN Class C')).toBeNull();
    expect(resolveTickerByIssuerName(onlyUnclassed, 'Alphabet Inc. CMN Class A')).toBe('GOOGL');
  });

  it('is null when two tickers share a name and neither (or both) is priced', () => {
    const ambiguous = buildIssuerNameIndex([
      { ticker: 'AAA', name: 'Sample Holdings Inc.' },
      { ticker: 'AAB', name: 'Sample Holdings Inc.' },
    ]);
    expect(resolveTickerByIssuerName(ambiguous, 'Sample Holdings Inc. CMN')).toBeNull();
    const bothPriced = buildIssuerNameIndex([
      { ticker: 'AAA', name: 'Sample Holdings Inc.', priced: true },
      { ticker: 'AAB', name: 'Sample Holdings Inc.', priced: true },
    ]);
    expect(resolveTickerByIssuerName(bothPriced, 'Sample Holdings Inc. CMN')).toBeNull();
  });

  it('breaks a tie only toward the single priced line (AT&T vs its preferred series)', () => {
    expect(resolveTickerByIssuerName(index, 'AT&T Inc.')).toBe('T');
  });

  it('never lets a bond/preferred/fund NAME lend its ticker to an equity description', () => {
    // JPM^J's name is a preferred line: it is not indexed under "jpmorgan chase".
    expect(index.base.get('jpmorgan chase')?.has('JPM^J')).toBeFalsy();
  });

  it('is null for unknown issuers and empty input', () => {
    expect(resolveTickerByIssuerName(index, 'Totally Unlisted Private Partners LP')).toBeNull();
    expect(resolveTickerByIssuerName(index, '')).toBeNull();
    expect(resolveTickerByIssuerName(index, null)).toBeNull();
  });
});
