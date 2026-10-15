/**
 * src/delivery/__tests__/matchesFilters.test.ts
 *
 * Unit tests for the pure subscription-filter predicates. No DB / no network:
 * matchesFilters and matchesFiltersWithChamber are pure functions over a
 * Transaction + SubscriptionFilters. Fixtures are inline.
 */

import { describe, it, expect } from 'vitest';
import { matchesFilters, matchesFiltersWithChamber, matchesFiltersWithContext } from '../subscriptions.ts';
import type { SubscriptionFilters, Transaction } from '../../shared/types.ts';

const FRESH_STAMP = new Date().toISOString();
const FRESH_DAY = FRESH_STAMP.slice(0, 10);

/** Build a Transaction fixture with sensible defaults, overridable per-test. */
function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx_1',
    docId: 'doc_1',
    filerId: 'M000001',
    txDate: FRESH_DAY,
    owner: 'self',
    assetName: 'Apple Inc.',
    ticker: 'AAPL',
    assetType: 'stock',
    txType: 'B',
    amountMin: 1_000,
    amountMax: 15_000,
    isOption: false,
    capGainsOver200: false,
    rawText: 'AAPL purchase $1,001 - $15,000',
    confidence: 0.99,
    source: 'primary',
    createdAt: FRESH_STAMP,
    firstSeenAt: FRESH_STAMP,
    filedDate: FRESH_DAY,
    cursorSeq: 42,
    ...overrides,
  };
}

describe('matchesFilters', () => {
  it('matches when filters are empty (match-all)', () => {
    expect(matchesFilters(tx(), {})).toBe(true);
  });

  it('matches when filters is undefined-ish (defensive)', () => {
    // Cast: the predicate guards against a missing filters object.
    expect(matchesFilters(tx(), undefined as unknown as SubscriptionFilters)).toBe(true);
  });

  // --- members[] ----------------------------------------------------------
  it('matches when filerId is in members[]', () => {
    expect(matchesFilters(tx({ filerId: 'M000001' }), { members: ['M000001', 'S000002'] })).toBe(
      true,
    );
  });

  it('rejects when filerId is not in members[]', () => {
    expect(matchesFilters(tx({ filerId: 'M000001' }), { members: ['S000002'] })).toBe(false);
  });

  it('rejects when filerId is null but members[] is set', () => {
    expect(matchesFilters(tx({ filerId: null }), { members: ['M000001'] })).toBe(false);
  });

  // --- tickers[] (case-insensitive) --------------------------------------
  it('matches tickers[] case-insensitively', () => {
    expect(matchesFilters(tx({ ticker: 'aapl' }), { tickers: ['AAPL'] })).toBe(true);
    expect(matchesFilters(tx({ ticker: 'AAPL' }), { tickers: ['aapl'] })).toBe(true);
  });

  it('rejects when ticker not in tickers[]', () => {
    expect(matchesFilters(tx({ ticker: 'TSLA' }), { tickers: ['AAPL', 'MSFT'] })).toBe(false);
  });

  it('rejects when ticker is null but tickers[] is set', () => {
    expect(matchesFilters(tx({ ticker: null }), { tickers: ['AAPL'] })).toBe(false);
  });

  // --- minAmount vs amountMin --------------------------------------------
  it('matches when amountMin >= minAmount', () => {
    expect(matchesFilters(tx({ amountMin: 50_000 }), { minAmount: 15_000 })).toBe(true);
    expect(matchesFilters(tx({ amountMin: 15_000 }), { minAmount: 15_000 })).toBe(true);
  });

  it('rejects when amountMin < minAmount', () => {
    expect(matchesFilters(tx({ amountMin: 1_000 }), { minAmount: 15_000 })).toBe(false);
  });

  it('treats null amountMin as 0 against minAmount', () => {
    expect(matchesFilters(tx({ amountMin: null }), { minAmount: 1 })).toBe(false);
    expect(matchesFilters(tx({ amountMin: null }), { minAmount: 0 })).toBe(true);
  });

  // --- maxAmount ----------------------------------------------------------
  it('rejects when amountMin > maxAmount, matches at the boundary', () => {
    expect(matchesFilters(tx({ amountMin: 100_000 }), { maxAmount: 50_000 })).toBe(false);
    expect(matchesFilters(tx({ amountMin: 50_000 }), { maxAmount: 50_000 })).toBe(true);
  });

  it('supports a min/max amount range together', () => {
    const range: SubscriptionFilters = { minAmount: 15_001, maxAmount: 50_000 };
    expect(matchesFilters(tx({ amountMin: 1_000 }), range)).toBe(false); // below
    expect(matchesFilters(tx({ amountMin: 50_001 }), range)).toBe(false); // above
    expect(matchesFilters(tx({ amountMin: 25_000 }), range)).toBe(true); // inside
  });

  // --- sides[] ------------------------------------------------------------
  it('excludes backfill trades unless includeBackfill is true', () => {
    const old = tx({
      txDate: '2020-01-01',
      firstSeenAt: '2020-01-01T00:00:00.000Z',
      filedDate: '2020-01-01',
      createdAt: '2020-01-02T00:00:00.000Z',
    });
    expect(matchesFilters(old, {})).toBe(false);
    expect(matchesFilters(old, { includeBackfill: true })).toBe(true);
    expect(matchesFilters(tx({ firstSeenAt: new Date().toISOString() }), {})).toBe(true);
  });

  it('filters by transaction side (buys only)', () => {
    expect(matchesFilters(tx({ txType: 'B' }), { sides: ['B'] })).toBe(true);
    expect(matchesFilters(tx({ txType: 'S' }), { sides: ['B'] })).toBe(false);
    expect(matchesFilters(tx({ txType: 'S' }), { sides: ['B', 'S'] })).toBe(true);
  });

  // --- combined (AND semantics) ------------------------------------------
  it('AND-s all clauses; all must pass', () => {
    const filters: SubscriptionFilters = {
      members: ['M000001'],
      tickers: ['AAPL'],
      minAmount: 1_000,
    };
    expect(matchesFilters(tx(), filters)).toBe(true);
    // one clause fails -> whole predicate fails
    expect(matchesFilters(tx({ ticker: 'TSLA' }), filters)).toBe(false);
  });
});

describe('matchesFiltersWithContext (sector + market cap)', () => {
  const ctx = (over: Record<string, unknown> = {}) => ({
    chamber: 'house',
    sector: 'Technology',
    marketCapBucket: 'mega',
    ...over,
  });

  it('matches when sector is in sectors[]', () => {
    expect(matchesFiltersWithContext(tx(), { sectors: ['Technology', 'Energy'] }, ctx())).toBe(true);
  });

  it('rejects when sector not in sectors[], or is unresolved', () => {
    expect(matchesFiltersWithContext(tx(), { sectors: ['Energy'] }, ctx())).toBe(false);
    expect(matchesFiltersWithContext(tx(), { sectors: ['Technology'] }, ctx({ sector: null }))).toBe(false);
  });

  it('matches/rejects by market-cap bucket', () => {
    expect(matchesFiltersWithContext(tx(), { marketCapBuckets: ['mega', 'large'] }, ctx())).toBe(true);
    expect(matchesFiltersWithContext(tx(), { marketCapBuckets: ['small'] }, ctx())).toBe(false);
    expect(matchesFiltersWithContext(tx(), { marketCapBuckets: ['mega'] }, ctx({ marketCapBucket: null }))).toBe(false);
  });

  it('AND-s context clauses with base + chamber filters', () => {
    const filters: SubscriptionFilters = {
      chambers: ['house'],
      sectors: ['Technology'],
      marketCapBuckets: ['mega'],
      sides: ['B'],
    };
    expect(matchesFiltersWithContext(tx(), filters, ctx())).toBe(true);
    expect(matchesFiltersWithContext(tx({ txType: 'S' }), filters, ctx())).toBe(false);
    expect(matchesFiltersWithContext(tx(), filters, ctx({ marketCapBucket: 'small' }))).toBe(false);
  });
});

describe('matchesFiltersWithChamber', () => {
  it('passes through to matchesFilters when no chambers[] given', () => {
    expect(matchesFiltersWithChamber(tx(), {}, 'house')).toBe(true);
    expect(matchesFiltersWithChamber(tx(), {}, null)).toBe(true);
  });

  it('matches when chamber is in chambers[]', () => {
    expect(matchesFiltersWithChamber(tx(), { chambers: ['house'] }, 'house')).toBe(true);
  });

  it('rejects when chamber not in chambers[]', () => {
    expect(matchesFiltersWithChamber(tx(), { chambers: ['senate'] }, 'house')).toBe(false);
  });

  it('rejects when chamber is unknown (null) but chambers[] is set', () => {
    expect(matchesFiltersWithChamber(tx(), { chambers: ['house'] }, null)).toBe(false);
  });

  it('still enforces base filters in addition to chamber', () => {
    expect(
      matchesFiltersWithChamber(tx({ ticker: 'TSLA' }), { tickers: ['AAPL'], chambers: ['house'] }, 'house'),
    ).toBe(false);
  });
});
