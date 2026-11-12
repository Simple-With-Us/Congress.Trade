/**
 * src/delivery/__tests__/assetClassFilter.test.ts
 *
 * The `?assetClass=` instrument-class filter (owner ask 2026-08-11: an extra
 * dropdown offering "All" or "Public Equities, Funds, & ETFs").
 *
 * Two things are load-bearing and tested here:
 *  1. the selection is parsed into canonical categories, not raw caller text;
 *  2. it lands in the SHARED `buildTxFilters`, so the page query, the COUNT
 *     companion behind `total`, and the CSV export set all narrow together.
 *     A client-side filter over one fetched page would instead report a count
 *     capped at the page size.
 */

import { describe, it, expect } from 'vitest';
import {
  asAssetCategories,
  ASSET_CLASS_GROUPS,
  buildTransactionsQuery,
  buildTransactionsCountQuery,
  buildTransactionsTodayFilingsQuery,
  buildTransactionsExportQuery,
} from '../rows.ts';

describe('asAssetCategories', () => {
  it('expands the "Public Equities, Funds, & ETFs" group to public_equity + fund', () => {
    expect(asAssetCategories('equities_funds')).toEqual(['fund', 'public_equity']);
    // The group is what the dropdown option means; ETFs/mutual funds/ETNs and
    // managed accounts all canonicalize to `fund` (see shared/assetTypes.ts).
    expect(ASSET_CLASS_GROUPS.equities_funds).toEqual(['fund', 'public_equity']);
  });

  it('treats absent, empty, and the explicit "all" sentinel as NO filter', () => {
    expect(asAssetCategories(undefined)).toBeUndefined();
    expect(asAssetCategories(null)).toBeUndefined();
    expect(asAssetCategories('')).toBeUndefined();
    expect(asAssetCategories('   ')).toBeUndefined();
    expect(asAssetCategories('all')).toBeUndefined();
    expect(asAssetCategories('All')).toBeUndefined();
  });

  it('accepts raw category slugs and a CSV mixing a group with raw slugs, deduped', () => {
    expect(asAssetCategories('crypto')).toEqual(['crypto']);
    expect(asAssetCategories('equities_funds,crypto')).toEqual(['crypto', 'fund', 'public_equity']);
    // `fund` is already inside the group — it must not appear twice (a
    // duplicate would bind a redundant param into the IN list).
    expect(asAssetCategories('equities_funds,fund')).toEqual(['fund', 'public_equity']);
  });

  it('normalizes slug separators and casing', () => {
    expect(asAssetCategories('Equities-Funds')).toEqual(['fund', 'public_equity']);
    expect(asAssetCategories('equities funds')).toEqual(['fund', 'public_equity']);
    expect(asAssetCategories('PUBLIC_EQUITY')).toEqual(['public_equity']);
  });

  it('falls back to no filter on unrecognized input rather than inventing a category', () => {
    expect(asAssetCategories('not_a_category')).toBeUndefined();
    expect(asAssetCategories('crypto,not_a_category')).toEqual(['crypto']);
  });

  it('never lets caller text reach the SQL — only closed-enum slugs survive', () => {
    expect(asAssetCategories("public_equity'); DROP TABLE transactions;--")).toBeUndefined();
  });
});

describe('asset-class filtering in the shared transactions filters', () => {
  it('is absent from the SQL when no asset class is selected', () => {
    expect(buildTransactionsQuery({}).sql).not.toContain("ELSE 'other' END) IN");
    expect(buildTransactionsCountQuery({}).sql).not.toContain("ELSE 'other' END) IN");
  });

  it('adds one IN clause over the canonical category expression, with the categories bound as params', () => {
    const q = buildTransactionsQuery({ assetCategories: asAssetCategories('equities_funds') });
    expect(q.sql).toContain("ELSE 'other' END) IN (?, ?)");
    expect(q.sql).toContain("upper(trim(coalesce(t.asset_type, ''))) = 'ST'");
    // The filter must live INSIDE the nested keyset subquery (the part before
    // the enrichment joins) so it narrows before the LIMIT rather than after.
    // It references only `transactions` columns — no securities_ref lookup,
    // which would have forced the slow join-then-limit plan.
    const keyset = q.sql.slice(
      q.sql.indexOf('SELECT t.* FROM transactions t'),
      q.sql.indexOf(') t LEFT JOIN filers'),
    );
    expect(keyset).toContain("ELSE 'other' END) IN (?, ?)");
    expect(keyset).not.toContain('sr.');
    // since=0 is bound first; the categories are appended last.
    expect(q.params).toEqual([0, 'fund', 'public_equity']);
  });

  it('narrows the COUNT companion behind `total` with the SAME clause and params', () => {
    const count = buildTransactionsCountQuery({ assetCategories: ['fund', 'public_equity'] });
    expect(count.sql).toContain("ELSE 'other' END) IN (?, ?)");
    // No cursor backstop on the count query, so the categories are the only
    // bound params — `total` is the full match count for the selection, not
    // the size of the page that was served.
    expect(count.params).toEqual(['fund', 'public_equity']);
  });

  it('composes with the other feed filters and keeps their bound-param order intact', () => {
    const q = buildTransactionsQuery({
      since: 7,
      ticker: 'aapl',
      member: 'P000197',
      minAmount: 1_000,
      assetCategories: ['public_equity'],
    });
    // Existing filters keep their historic positions; the category is appended.
    expect(q.params).toEqual([7, 'AAPL', 'P000197', 1_000, 'public_equity']);
  });

  it('carries into the CSV export and today-filings queries so every surface agrees', () => {
    const exported = buildTransactionsExportQuery({ assetCategories: ['crypto'] });
    expect(exported.sql).toContain("ELSE 'other' END) IN (?)");
    expect(exported.params).toEqual(['crypto']);

    const today = buildTransactionsTodayFilingsQuery({ assetCategories: ['crypto'] }, '2026-08-11');
    expect(today.sql).toContain("ELSE 'other' END) IN (?)");
    expect(today.params).toEqual(['crypto', '2026-08-11']);
  });

  it('buckets an options row by the is_option flag, matching the Trends builders', () => {
    const q = buildTransactionsQuery({ assetCategories: ['option'] });
    expect(q.sql).toContain("WHEN t.is_option = 1 THEN 'option'");
  });
});
