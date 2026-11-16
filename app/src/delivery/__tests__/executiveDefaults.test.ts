import { describe, expect, it } from 'vitest';
import { buildTransactionsQuery, buildTransactionsCountQuery } from '../rows.ts';
import { matchesFiltersWithChamber } from '../subscriptions.ts';
import { buildCommonFilters, asChambers } from '../../analytics/sql.ts';
import type { Transaction } from '../../shared/types.ts';
import { freshDeliveryDay, freshDeliveryIso } from './freshDeliveryFixtures.ts';

/**
 * Executive (OGE 278-T) rows are now INCLUDED in the feed, analytics, and 
 * subscription delivery by default, to ensure that executive trades are
 * discoverable and surfaced alongside congressional trades.
 */

describe('feed default includes executive', () => {
  it('does NOT add the executive-exclusion clause when no chamber filter is set', () => {
    const q = buildTransactionsQuery({ limit: 10 });
    expect(q.sql).not.toContain("COALESCE(fl.chamber, f.chamber) <> 'executive'");
  });

  it('uses IN(...) for an explicit multi-chamber selection (no default clause)', () => {
    const q = buildTransactionsQuery({ chambers: ['executive', 'house'], limit: 10 });
    expect(q.sql).toContain('COALESCE(fl.chamber, f.chamber) IN (?, ?)');
    expect(q.params).toContain('executive');
    expect(q.params).toContain('house');
    expect(q.sql).not.toContain("<> 'executive'");
  });

  it('keeps the count query consistent with the feed', () => {
    const q = buildTransactionsCountQuery({});
    expect(q.sql).not.toContain("<> 'executive'");
  });

  it('single-chamber equality still works (back-compat)', () => {
    const q = buildTransactionsQuery({ chamber: 'senate', limit: 10 });
    expect(q.sql).toContain('COALESCE(fl.chamber, f.chamber) = ?');
    expect(q.params).toContain('senate');
  });
});

describe('analytics default includes executive', () => {
  it('default filters DO NOT carry the exclusion clause', () => {
    const { where } = buildCommonFilters({ window: '90d' });
    expect(where.join(' AND ')).not.toContain("<> 'executive'");
  });

  it('explicit chambers list replaces the default clause', () => {
    const { where, params } = buildCommonFilters({ window: '90d', chambers: ['executive'] });
    const sql = where.join(' AND ');
    expect(sql).toContain('IN (?)');
    expect(sql).not.toContain("<> 'executive'");
    expect(params).toContain('executive');
  });

  it('asChambers parses, validates, dedupes, and sorts CSV input', () => {
    expect(asChambers('senate,executive,house,senate')).toEqual(['executive', 'house', 'senate']);
    expect(asChambers('executive')).toEqual(['executive']);
    expect(asChambers('bogus,also-bogus')).toBeUndefined();
    expect(asChambers('')).toBeUndefined();
    expect(asChambers(undefined)).toBeUndefined();
  });
});

describe('subscription delivery default includes executive', () => {
  const tx = {
    id: 't1',
    ticker: 'NVDA',
    txType: 'B',
    amountMin: 1001,
    amountMax: 15000,
    txDate: freshDeliveryDay,
    filedDate: freshDeliveryDay,
    firstSeenAt: freshDeliveryIso,
    createdAt: freshDeliveryIso,
  } as unknown as Transaction;

  it('a subscription with NO chambers filter receives executive rows', () => {
    expect(matchesFiltersWithChamber(tx, {}, 'house')).toBe(true);
    expect(matchesFiltersWithChamber(tx, {}, null)).toBe(true);
    expect(matchesFiltersWithChamber(tx, {}, 'executive')).toBe(true);
  });

  it('an explicit chambers filter including executive receives them', () => {
    expect(matchesFiltersWithChamber(tx, { chambers: ['executive'] as never }, 'executive')).toBe(true);
    expect(matchesFiltersWithChamber(tx, { chambers: ['house'] as never }, 'executive')).toBe(false);
  });
});

