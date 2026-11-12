import { describe, expect, it } from 'vitest';
import {
  canonicalizeTxType,
  canonicalizeTxTypeOrBuy,
  isBuyTxType,
  txTypeDisplayLetter,
  txTypeLabel,
} from '../txType.ts';

describe('canonicalizeTxType → B|S|E', () => {
  it('maps all buy aliases to B (including legacy P)', () => {
    expect(canonicalizeTxType('purchase')).toBe('B');
    expect(canonicalizeTxType('buy')).toBe('B');
    expect(canonicalizeTxType('bought')).toBe('B');
    expect(canonicalizeTxType('B')).toBe('B');
    expect(canonicalizeTxType('b')).toBe('B');
    expect(canonicalizeTxType('P')).toBe('B');
    expect(canonicalizeTxType('p')).toBe('B');
  });

  it('maps sales and exchanges', () => {
    expect(canonicalizeTxType('sale_full')).toBe('S');
    expect(canonicalizeTxType('sale_partial')).toBe('S');
    expect(canonicalizeTxType('sell')).toBe('S');
    expect(canonicalizeTxType('S')).toBe('S');
    expect(canonicalizeTxType('exchange')).toBe('E');
    expect(canonicalizeTxType('E')).toBe('E');
  });

  it('returns null for empty/unknown', () => {
    expect(canonicalizeTxType('')).toBeNull();
    expect(canonicalizeTxType('n/a')).toBeNull();
  });
});

describe('labels + helpers', () => {
  it('labels Buy/Sell/Exchange', () => {
    expect(txTypeLabel('B')).toBe('Buy');
    expect(txTypeLabel('P')).toBe('Buy');
    expect(txTypeLabel('S')).toBe('Sell');
    expect(txTypeLabel('E')).toBe('Exchange');
    expect(txTypeLabel(null)).toBeNull();
  });

  it('display letter is B for buys', () => {
    expect(txTypeDisplayLetter('P')).toBe('B');
    expect(txTypeDisplayLetter('B')).toBe('B');
    expect(txTypeDisplayLetter('S')).toBe('S');
  });

  it('defaults unknown to Buy via OrBuy', () => {
    expect(canonicalizeTxTypeOrBuy(null)).toBe('B');
    expect(canonicalizeTxTypeOrBuy('garbage')).toBe('B');
  });

  it('isBuyTxType dual-reads P', () => {
    expect(isBuyTxType('B')).toBe(true);
    expect(isBuyTxType('P')).toBe(true);
    expect(isBuyTxType('S')).toBe(false);
  });
});
