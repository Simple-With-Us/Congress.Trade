/**
 * src/delivery/__tests__/buildTransactionsQuery.test.ts
 *
 * Unit tests for the GET /transactions cursor query builder. Pure + deterministic
 * (no DB), so we assert on the generated SQL shape and bound parameter order.
 */

import { describe, it, expect } from 'vitest';
import {
  asTxSource,
  buildTransactionsQuery,
  buildTransactionsCountQuery,
  buildTransactionsTodayFilingsQuery,
  buildTransactionsExportQuery,
  mapFeedTransaction,
  mapTransaction,
  toPublicFiling,
  escapeLikePattern,
  DEFAULT_TX_LIMIT,
  MAX_TX_LIMIT,
  twinCandidateLimit,
  NEWEST_SNAPSHOT_ORDER_SQL,
  type TxQueryParams,
  type FeedTransactionRow,
  type TransactionRow,
} from '../rows.ts';
import { TWIN_DEDUPE_SQL } from '../../shared/tradeIdentity.ts';
import type { Filing } from '../../shared/types.ts';

describe('twinCandidateLimit', () => {
  it('over-fetches a bounded slack so OFFSET still covers the unique page', () => {
    expect(twinCandidateLimit(5, 0)).toBe(37);
    expect(twinCandidateLimit(100, 0)).toBe(400);
    expect(twinCandidateLimit(25, 50)).toBe(300);
  });

  it('never returns fewer rows than offset+limit (public pager ceiling is 2000)', () => {
    const deep = twinCandidateLimit(250, 2000);
    expect(deep).toBeGreaterThanOrEqual(2250);
    expect(deep).toBe(4250);
  });
});

describe('asTxSource', () => {
  it('accepts all / primary / seed_dataset and ignores junk', () => {
    expect(asTxSource('all')).toBe('all');
    expect(asTxSource('primary')).toBe('primary');
    expect(asTxSource('SEED_DATASET')).toBe('seed_dataset');
    expect(asTxSource('nope')).toBeUndefined();
    expect(asTxSource(undefined)).toBeUndefined();
  });
});

describe('buildTransactionsQuery', () => {
  it('left-joins price and one latency row on the page, not on count or csv', () => {
    const nested = buildTransactionsQuery({});
    expect(nested.sql).toContain('LEFT JOIN tx_performance txp ON txp.tx_id = t.id');
    expect(nested.sql).toContain('trade_latency_candidates tlc');
    expect(nested.sql).toContain('LIMIT 1');
    const unnested = buildTransactionsQuery({ memberName: 'Pelo' });
    expect(unnested.sql).toContain('LEFT JOIN tx_performance txp ON txp.tx_id = t.id');
    expect(unnested.sql).toContain('trade_latency_candidates tlc');
    expect(buildTransactionsCountQuery({}).sql).not.toContain('tx_performance');
    expect(buildTransactionsCountQuery({}).sql).not.toContain('trade_latency_candidates');
    expect(buildTransactionsExportQuery({}).sql).not.toContain('tx_performance');
    expect(buildTransactionsExportQuery({}).sql).not.toContain('trade_latency_candidates');
  });

  it('always filters cursor_seq > since (defaulting since to 0) and orders by cursor ASC', () => {
    const q = buildTransactionsQuery({});
    expect(q.sql).toContain('t.cursor_seq > ?');
    expect(q.sql).toContain('ORDER BY t.cursor_seq ASC');
    expect(q.params).toEqual([0]);
    expect(q.limit).toBe(DEFAULT_TX_LIMIT);
    // Hot path nests keyset+LIMIT before enrichment joins.
    expect(q.sql).toContain('SELECT t.* FROM transactions t');
    expect(q.sql).toMatch(/\) t LEFT JOIN filers/);
  });

  it('defaults to hiding seed_dataset historic copies (#1453)', () => {
    const q = buildTransactionsQuery({});
    expect(q.sql).toContain("t.source <> 'seed_dataset'");
    expect(q.params).toEqual([0]);
    const count = buildTransactionsCountQuery({});
    expect(count.sql).toContain("t.source <> 'seed_dataset'");
    const all = buildTransactionsQuery({ source: 'all' });
    expect(all.sql).not.toContain("t.source <> 'seed_dataset'");
    const seed = buildTransactionsQuery({ source: 'seed_dataset' });
    expect(seed.sql).toContain('t.source = ?');
    expect(seed.params).toEqual([0, 'seed_dataset']);
  });

  it('hides competitor-only executive orphans (no official OGE doc) from the public feed', () => {
    const q = buildTransactionsQuery({});
    expect(q.sql).toContain("t.source = 'competitor_backfill'");
    expect(q.sql).toContain("t.filer_id LIKE 'EXEC-%'");
    expect(q.sql).toContain("t.doc_id LIKE 'COMPETITOR%'");
    expect(q.sql).toContain('NOT EXISTS');
    const count = buildTransactionsCountQuery({});
    expect(count.sql).toContain("t.source = 'competitor_backfill'");
    // Unbounded COUNT must not carry the correlated twin guard (#2062).
    expect(count.sql).not.toContain('NOT EXISTS');
  });

  it('uses the supplied since cursor as the first bound param', () => {
    const q = buildTransactionsQuery({ since: 1234 });
    expect(q.params[0]).toBe(1234);
  });

  it('upper-cases ticker and appends it in WHERE/param order', () => {
    const q = buildTransactionsQuery({ since: 5, ticker: 'aapl' });
    expect(q.sql).toContain('t.ticker = ?');
    expect(q.params).toEqual([5, 'AAPL']);
  });

  it('filters by politician (member/filer_id)', () => {
    const q = buildTransactionsQuery({ member: 'M000001' });
    expect(q.sql).toContain('t.filer_id = ?');
    expect(q.params).toEqual([0, 'M000001']);
  });

  it('filters by fuzzy politician name server-side', () => {
    const q = buildTransactionsQuery({ memberName: 'Pelo' });
    expect(q.sql).toContain("LOWER(COALESCE(fl.full_name, t.filer_id, '')) LIKE ?");
    // Also matches display_name (the "campaign sign" preferred name) so a
    // search by either name finds the filer — see rows.ts buildTxFilters.
    expect(q.sql).toContain("LOWER(COALESCE(fl.display_name, '')) LIKE ?");
    expect(q.sql).toContain("ESCAPE '\\'");
    expect(q.params).toEqual([0, '%pelo%', '%pelo%']);
  });

  it('escapes LIKE metacharacters in memberName so they are matched literally', () => {
    const q = buildTransactionsQuery({ memberName: 'A_B%C' });
    // A literal '_' must not act as a single-char wildcard, and a literal '%'
    // must not act as a multi-char wildcard. Same escaped term is bound
    // twice: once for the full_name branch, once for display_name.
    expect(q.params).toEqual([0, '%a\\_b\\%c%', '%a\\_b\\%c%']);
  });

  it('filters by tx type', () => {
    const q = buildTransactionsQuery({ type: 'S' });
    expect(q.sql).toContain('t.tx_type = ?');
    expect(q.params).toEqual([0, 'S']);
  });

  it('filters by STOCK Act status on the stored transactions column (keyset-eligible)', () => {
    const q = buildTransactionsQuery({ stockAct: 'late' });
    expect(q.sql).toContain('t.stock_act_status = ?');
    expect(q.params).toEqual([0, 'late']);
    // transactions-only filter: stays on the nested keyset path (no early joins).
    expect(q.sql).toContain('SELECT t.* FROM transactions t');
    const count = buildTransactionsCountQuery({ stockAct: 'severely_late' });
    expect(count.sql).toContain('t.stock_act_status = ?');
    expect(count.params).toEqual(['severely_late']);
  });

  it('filters by beneficial owner on the canonical transactions column (keyset-eligible)', () => {
    const q = buildTransactionsQuery({ owner: 'spouse' });
    expect(q.sql).toContain('t.owner = ?');
    expect(q.params).toEqual([0, 'spouse']);
    expect(q.sql).toContain('SELECT t.* FROM transactions t');
    const count = buildTransactionsCountQuery({ owner: 'joint' });
    expect(count.sql).toContain('t.owner = ?');
    expect(count.params).toEqual(['joint']);
  });

  it('resolves chamber via the filers table (authoritative for seed data)', () => {
    const q = buildTransactionsQuery({ chamber: 'senate' });
    // Chamber filters need the join BEFORE the cheap LIMIT; twin-collapse
    // still waits until after that candidate window (#2062).
    expect(q.sql).toContain('LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id');
    expect(q.sql).toContain('LEFT JOIN filings f ON f.doc_id = t.doc_id');
    expect(q.sql).toContain('COALESCE(fl.chamber, f.chamber) = ?');
    expect(q.params).toEqual([0, 'senate']);
    expect(q.sql).toMatch(/FROM \(SELECT t\.\* FROM \(SELECT t\.\*, \(.+\) AS __sort_key FROM transactions t/);
    expect(q.sql).toContain(`LIMIT ${twinCandidateLimit(DEFAULT_TX_LIMIT, 0)}`);
  });

  it('filters by party bucket via the filers table (same bucketing as the Trends analytics endpoints)', () => {
    const q = buildTransactionsQuery({ partyBuckets: ['D'] });
    // Party filters need the join BEFORE limit, same as chamber.
    expect(q.sql).toContain('LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id');
    expect(q.sql).toContain(
      "(CASE WHEN UPPER(SUBSTR(TRIM(COALESCE(fl.party, '')), 1, 1)) = 'D' THEN 'D' " +
        "WHEN UPPER(SUBSTR(TRIM(COALESCE(fl.party, '')), 1, 1)) = 'R' THEN 'R' " +
        "ELSE 'O' END) IN (?)",
    );
    expect(q.params).toEqual([0, 'D']);
    expect(q.sql).toMatch(/FROM \(SELECT t\.\* FROM \(SELECT t\.\*, \(.+\) AS __sort_key FROM transactions t/);
    expect(q.sql).toContain(`LIMIT ${twinCandidateLimit(DEFAULT_TX_LIMIT, 0)}`);
    const count = buildTransactionsCountQuery({ partyBuckets: ['D', 'R'] });
    expect(count.sql).toContain('IN (?, ?)');
    expect(count.params).toEqual(['D', 'R']);
  });

  it('an unfiltered party query does not narrow the count (regression guard for the "applying a filter changes the count" fix)', () => {
    const unfiltered = buildTransactionsCountQuery({});
    const filtered = buildTransactionsCountQuery({ partyBuckets: ['D'] });
    expect(unfiltered.sql).not.toContain('IN (?)');
    expect(filtered.sql).toContain('IN (?)');
    expect(filtered.params).toContain('D');
  });

  it('nests keyset before joins for ticker-only filters', () => {
    const q = buildTransactionsQuery({ since: 9, ticker: 'aapl', limit: 25 });
    expect(q.sql).toContain('SELECT t.* FROM transactions t');
    expect(q.sql).toContain('t.ticker = ?');
    expect(q.sql).toMatch(/LIMIT 25\) t LEFT JOIN filers/);
    expect(q.params).toEqual([9, 'AAPL']);
  });

  it('nests a cheap candidate window when memberName requires filers', () => {
    const q = buildTransactionsQuery({ memberName: 'Pelo' });
    expect(q.sql).toContain("LOWER(COALESCE(fl.full_name, t.filer_id, '')) LIKE ?");
    expect(q.sql).toMatch(/FROM \(SELECT t\.\* FROM \(SELECT t\.\*, \(.+\) AS __sort_key FROM transactions t/);
    expect(q.sql).toContain('LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id');
  });

  it('limits the page before the enrichment joins on the non-nested path', () => {
    // The latency join carries a correlated subquery: it must run once per
    // page row, not once per candidate row, so the page LIMIT has to sit in
    // a derived table below the enrichment joins.
    const q = buildTransactionsQuery({ memberName: 'Pelo' });
    expect(q.sql).toMatch(/LIMIT 100\) t LEFT JOIN filers fl/);
    const enrichIdx = q.sql.indexOf('LEFT JOIN tx_performance txp');
    const pageLimitIdx = q.sql.indexOf('LIMIT 100) t');
    expect(enrichIdx).toBeGreaterThan(pageLimitIdx);
  });

  it('selects the resolved chamber + politician name alongside t.*', () => {
    const q = buildTransactionsQuery({});
    expect(q.sql).toContain('SELECT t.*, COALESCE(fl.chamber, f.chamber) AS __chamber');
    // display_name (the curated "campaign sign" preferred name) wins over
    // full_name when set — see migrations/0083_filers_display_name.sql.
    expect(q.sql).toContain('COALESCE(fl.display_name, fl.full_name) AS __member_name');
    expect(q.sql).toContain('fl.party AS __party');
  });

  it('joins filers to project the politician name/state/headshot for the feed', () => {
    const q = buildTransactionsQuery({});
    expect(q.sql).toContain('LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id');
    expect(q.sql).toContain('COALESCE(fl.display_name, fl.full_name) AS filer_full_name');
    expect(q.sql).toContain('fl.state AS filer_state');
    expect(q.sql).toContain('fl.photo_url AS filer_photo_url');
    expect(q.sql).toContain('fl.resolved_bioguide_id AS filer_bioguide_id');
    expect(q.sql).toContain('f.source_url AS filing_source_url');
  });

  it('composes all filters in a stable param order', () => {
    const params: TxQueryParams = {
      since: 10,
      ticker: 'msft',
      member: 'M000001',
      type: 'P',
      chamber: 'house',
      minAmount: 15_001,
      maxAmount: 50_000,
    };
    const q = buildTransactionsQuery(params);
    expect(q.params).toEqual([10, 'MSFT', 'M000001', 'P', 'house', 15_001, 50_000]);
    expect(q.sql).toContain('t.amount_min >= ?');
    expect(q.sql).toContain('t.amount_min <= ?');
    // WHERE clauses AND-ed together.
    expect(q.sql).toContain(' AND ');
  });

  it('bounds the trade date with txDateMin (?from=) after the other filters', () => {
    const q = buildTransactionsQuery({ since: 7, ticker: 'aapl', txDateMin: '2026-03-24' });
    expect(q.sql).toContain('t.tx_date >= ?');
    // Stable order: cursor, ticker, then the trade-date floor.
    expect(q.params).toEqual([7, 'AAPL', '2026-03-24']);
  });

  it('bounds the trade date on both sides with txDateMin/txDateMax', () => {
    const q = buildTransactionsQuery({ txDateMin: '2026-01-01', txDateMax: '2026-03-31' });
    expect(q.sql).toContain('t.tx_date >= ?');
    expect(q.sql).toContain('t.tx_date <= ?');
    expect(q.params).toEqual([0, '2026-01-01', '2026-03-31']);
  });

  it('normalizes a full ISO timestamp down to YYYY-MM-DD', () => {
    const q = buildTransactionsQuery({ txDateMin: '2026-03-24T12:34:56Z' });
    expect(q.params).toEqual([0, '2026-03-24']);
  });

  it('applies the default limit when none/invalid is given', () => {
    expect(buildTransactionsQuery({}).limit).toBe(DEFAULT_TX_LIMIT);
    expect(buildTransactionsQuery({ limit: 0 }).limit).toBe(DEFAULT_TX_LIMIT);
    expect(buildTransactionsQuery({ limit: -5 }).limit).toBe(DEFAULT_TX_LIMIT);
  });

  it('honors a valid explicit limit and embeds it in the SQL', () => {
    const q = buildTransactionsQuery({ limit: 25 });
    expect(q.limit).toBe(25);
    expect(q.offset).toBe(0);
    expect(q.sql).toContain('LIMIT 25');
  });

  it('honors a non-negative offset for snapshot page navigation', () => {
    const q = buildTransactionsQuery({ limit: 25, offset: 50, order: 'desc' });
    expect(q.limit).toBe(25);
    expect(q.offset).toBe(50);
    expect(q.sql).toContain(`ORDER BY ${NEWEST_SNAPSHOT_ORDER_SQL} DESC, t.cursor_seq DESC`);
    expect(q.sql).toContain('LIMIT 25 OFFSET 50');
  });

  it('clamps negative offsets to zero and omits OFFSET 0', () => {
    const q = buildTransactionsQuery({ offset: -10 });
    expect(q.offset).toBe(0);
    expect(q.sql).not.toContain('OFFSET');
  });

  it('caps the limit at MAX_TX_LIMIT', () => {
    const q = buildTransactionsQuery({ limit: 10_000 });
    expect(q.limit).toBe(MAX_TX_LIMIT);
    expect(q.sql).toContain(`LIMIT ${MAX_TX_LIMIT}`);
  });

  it('floors a fractional limit instead of embedding it verbatim (would be invalid SQL)', () => {
    const q = buildTransactionsQuery({ limit: 50.9 });
    expect(q.limit).toBe(50);
    expect(q.sql).toContain('LIMIT 50');
    expect(q.sql).not.toContain('50.9');
  });

  it('floors BEFORE clamping so a fractional value under 1 falls back to the default, not 0', () => {
    const q = buildTransactionsQuery({ limit: 0.5 });
    expect(q.limit).toBe(DEFAULT_TX_LIMIT);
  });

  it('floors a fractional offset instead of embedding it verbatim', () => {
    const q = buildTransactionsQuery({ limit: 25, offset: 10.7 });
    expect(q.offset).toBe(10);
    expect(q.sql).toContain('OFFSET 10');
    expect(q.sql).not.toContain('10.7');
  });

  it('treats a non-finite limit (NaN/Infinity) as absent, not as literal SQL text', () => {
    expect(buildTransactionsQuery({ limit: NaN }).limit).toBe(DEFAULT_TX_LIMIT);
    expect(buildTransactionsQuery({ limit: Infinity }).limit).toBe(DEFAULT_TX_LIMIT);
  });

  it('defaults to oldest-first (ORDER BY cursor_seq ASC) when order is omitted', () => {
    const q = buildTransactionsQuery({});
    expect(q.sql).toContain('ORDER BY t.cursor_seq ASC');
    expect(q.sql).not.toContain('DESC');
  });

  it('orders newest-first by learned/filed/trade date when order is "desc" (#2180)', () => {
    const q = buildTransactionsQuery({ order: 'desc' });
    expect(q.sql).toContain(`ORDER BY ${NEWEST_SNAPSHOT_ORDER_SQL} DESC, t.cursor_seq DESC`);
    expect(q.sql).not.toMatch(/FROM transactions t WHERE[\s\S]+ORDER BY t\.cursor_seq DESC LIMIT /);
    // The direction is a SQL literal, never a bound param — params unchanged.
    expect(q.params).toEqual([0]);
  });

  it('keeps ingest-cursor newest-first when sort is explicitly "cursor"', () => {
    const q = buildTransactionsQuery({ order: 'desc', sort: 'cursor' });
    expect(q.sql).toContain('ORDER BY t.cursor_seq DESC');
    expect(q.sql).not.toContain(NEWEST_SNAPSHOT_ORDER_SQL);
  });

  it('does not let a high ingest cursor outrank a later-seen row in the desc snapshot SQL', () => {
    const q = buildTransactionsQuery({ order: 'desc', limit: 8 });
    expect(q.sql).toContain(NEWEST_SNAPSHOT_ORDER_SQL);
    expect(q.sql).toContain('t.first_seen_at');
    expect(q.sql).toContain('t.filed_date');
    expect(q.sql).toContain('t.tx_date');
    // Nested keyset stays on transactions columns (no filings join before LIMIT).
    expect(q.sql).toMatch(
      /FROM transactions t WHERE[\s\S]+ORDER BY COALESCE\(t\.first_seen_at, t\.filed_date, t\.tx_date, t\.cursor_seq\) DESC, t\.cursor_seq DESC LIMIT /,
    );
  });

  it('treats order: "asc" the same as the default (ASC)', () => {
    const q = buildTransactionsQuery({ order: 'asc' });
    expect(q.sql).toContain('ORDER BY t.cursor_seq ASC');
  });

  it('keeps the cursor backstop + filters intact in desc (snapshot) mode', () => {
    const q = buildTransactionsQuery({ since: 7, ticker: 'aapl', order: 'desc' });
    expect(q.sql).toContain('t.cursor_seq > ?');
    expect(q.sql).toContain(`ORDER BY ${NEWEST_SNAPSHOT_ORDER_SQL} DESC, t.cursor_seq DESC`);
    // order adds no bound param; same param order as the asc path.
    expect(q.params).toEqual([7, 'AAPL']);
  });

  it('can sort snapshot pages by published/imported time', () => {
    const q = buildTransactionsQuery({ sort: 'published', order: 'desc', limit: 25 });
    expect(q.sql).toContain('ORDER BY COALESCE(f.first_seen_at, f.filed_date, t.created_at, t.cursor_seq) DESC, t.cursor_seq DESC');
    expect(q.params).toEqual([0]);
  });

  it('collapses twins after a cheap candidate LIMIT (live first-page shape)', () => {
    const q = buildTransactionsQuery({ order: 'desc', limit: 5, offset: 0 });
    const candidate = twinCandidateLimit(5, 0);
    expect(q.sql).toContain(`LIMIT ${candidate}`);
    expect(q.sql).toContain('LIMIT 5');
    expect(q.sql).toContain(TWIN_DEDUPE_SQL);
    const innerWhere = q.sql.match(
      /SELECT t\.\* FROM transactions t WHERE ([\s\S]+?) ORDER BY COALESCE\(t\.first_seen_at, t\.filed_date, t\.tx_date, t\.cursor_seq\) DESC, t\.cursor_seq DESC LIMIT /,
    )?.[1];
    expect(innerWhere).toBeTruthy();
    expect(innerWhere).not.toContain('NOT EXISTS');
    expect(innerWhere).not.toContain('FROM transactions d');
    expect(q.sql.indexOf(`LIMIT ${candidate}`)).toBeLessThan(q.sql.indexOf(TWIN_DEDUPE_SQL));
  });

  it('does not interpolate untrusted values directly (ticker/member-filer are bound, not inlined)', () => {
    const q = buildTransactionsQuery({ ticker: "'; DROP TABLE transactions;--" });
    // The malicious string must appear only as a bound parameter, never in SQL.
    expect(q.sql).not.toContain('DROP TABLE');
    expect(q.params).toContain("'; DROP TABLE TRANSACTIONS;--");
  });
});

describe('buildTransactionsCountQuery', () => {
  it('does not run the correlated twin-dedupe subquery on the unbounded COUNT', () => {
    const q = buildTransactionsCountQuery({});
    expect(q.sql).not.toContain(TWIN_DEDUPE_SQL);
    expect(q.sql).not.toContain('FROM transactions d');
    expect(buildTransactionsTodayFilingsQuery({}, '2026-08-19').sql).not.toContain(TWIN_DEDUPE_SQL);
    expect(buildTransactionsQuery({}).sql).toContain(TWIN_DEDUPE_SQL);
    expect(buildTransactionsExportQuery({}).sql).toContain(TWIN_DEDUPE_SQL);
  });

  it('counts ALL rows ignoring the cursor backstop', () => {
    const q = buildTransactionsCountQuery({ since: 1234 });
    expect(q.sql).toContain('SELECT COUNT(*) AS total');
    // No cursor clause and no since param: total spans the whole filtered set.
    expect(q.sql).not.toContain('cursor_seq');
    expect(q.params).toEqual([]);
  });

  it('reuses the same ticker/member-filer/type filters (minus the cursor)', () => {
    const q = buildTransactionsCountQuery({
      since: 99,
      ticker: 'msft',
      member: 'M000001',
      type: 'P',
    });
    expect(q.sql).toContain('t.ticker = ?');
    expect(q.sql).toContain('t.filer_id = ?');
    expect(q.sql).toContain('t.tx_type = ?');
    expect(q.params).toEqual(['MSFT', 'M000001', 'P']);
  });

  it('filters chamber via the filers table (COALESCE), same as the page query', () => {
    const q = buildTransactionsCountQuery({ chamber: 'senate' });
    expect(q.sql).toContain('LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id');
    expect(q.sql).toContain('COALESCE(fl.chamber, f.chamber) = ?');
    expect(q.params).toEqual(['senate']);
  });

  it('excludes retracted rows even when no other filters are given', () => {
    const q = buildTransactionsCountQuery({});
    // The only WHERE clause is the always-on retracted (un-published) guard.
    expect(q.sql).toContain('WHERE t.deprecated_at IS NULL');
    expect(q.params).toEqual([]);
  });

  it('honors the trade-date window so the total reflects the windowed set', () => {
    const q = buildTransactionsCountQuery({ txDateMin: '2026-03-24', txDateMax: '2026-06-22' });
    expect(q.sql).toContain('t.tx_date >= ?');
    expect(q.sql).toContain('t.tx_date <= ?');
    // No cursor backstop in the count query.
    expect(q.params).toEqual(['2026-03-24', '2026-06-22']);
  });

  it('uses the joins-lite FROM (no securities_ref join no filter ever reads)', () => {
    const q = buildTransactionsCountQuery({ ticker: 'aapl', chamber: 'house', memberName: 'Pelo' });
    expect(q.sql).not.toContain('securities_ref');
    // Filers/filings stay: chamber + memberName filters resolve through them.
    expect(q.sql).toContain('LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id');
    expect(q.sql).toContain('LEFT JOIN filings f ON f.doc_id = t.doc_id');
  });
});

describe('buildTransactionsTodayFilingsQuery', () => {
  it('counts distinct docs imported today with the same feed filters', () => {
    const q = buildTransactionsTodayFilingsQuery(
      { ticker: 'aapl', chamber: 'house' },
      '2026-06-24T12:00:00Z',
    );
    expect(q.sql).toContain('COUNT(DISTINCT t.doc_id) AS total');
    expect(q.sql).toContain('t.ticker = ?');
    expect(q.sql).toContain('COALESCE(fl.chamber, f.chamber) = ?');
    expect(q.sql).toContain('substr(COALESCE(f.first_seen_at, t.created_at), 1, 10) = ?');
    expect(q.params).toEqual(['AAPL', 'house', '2026-06-24']);
  });

  it('uses the joins-lite FROM (no securities_ref join) like the COUNT companion', () => {
    const q = buildTransactionsTodayFilingsQuery({ ticker: 'aapl' }, '2026-06-24');
    expect(q.sql).not.toContain('securities_ref');
    expect(q.sql).toContain('LEFT JOIN filings f ON f.doc_id = t.doc_id');
  });
});

describe('mapFeedTransaction', () => {
  function feedRow(over: Partial<FeedTransactionRow> = {}): FeedTransactionRow {
    return {
      id: 't1',
      doc_id: 'H-2024-1',
      filer_id: 'P000197',
      tx_date: '2024-01-02',
      owner: 'self',
      asset_name: 'Acme',
      ticker: 'ACME',
      asset_type: 'stock',
      tx_type: 'B',
      amount_min: 1001,
      amount_max: 15000,
      is_option: 0,
      cap_gains_over_200: 0,
      raw_text: '',
      est_value: 8000.5,
      confidence: 0.9,
      source: 'primary',
      created_at: '2024-01-03T00:00:00Z',
      cursor_seq: 5,
      filer_full_name: 'Nancy Pelosi',
      filer_state: 'CA',
      filer_photo_url: 'https://unitedstates.github.io/images/congress/225x275/P000197.jpg',
      filer_bioguide_id: 'P000197',
      filing_filed_date: '2024-01-01',
      filing_first_seen_at: '2024-01-02T12:00:00Z',
      filing_source_url: 'https://disclosures.example/doc.pdf',
      ...over,
    };
  }

  it('carries the joined filer identity onto the Transaction', () => {
    const tx = mapFeedTransaction(feedRow());
    expect(tx.fullName).toBe('Nancy Pelosi');
    expect(tx.state).toBe('CA');
    expect(tx.photoUrl).toContain('P000197.jpg');
    // resolved Bioguide identity (migration 0066)
    expect(tx.bioguideId).toBe('P000197');
    // filing timestamps for the per-row latency column
    expect(tx.filedDate).toBe('2024-01-01');
    expect(tx.firstSeenAt).toBe('2024-01-02T12:00:00Z');
    // first-seen after the trade date stays the filing listing stamp.
    expect(tx.sourceUrl).toBe('https://disclosures.example/doc.pdf');
    // base transaction mapping still applies
    expect(tx.ticker).toBe('ACME');
    expect(tx.cursorSeq).toBe(5);
    expect((tx as typeof tx & { estValue: number | null }).estValue).toBe(8000.5);
  });

  it('falls back to the transaction row\'s own filed_date/first_seen_at when there is no matching filings row (competitor_backfill)', () => {
    // competitor_backfill rows (doc_id LIKE 'COMPETITOR-%') have no OGE/clerk
    // filing behind them, so the `filings` LEFT JOIN never matches and
    // filing_filed_date/filing_first_seen_at come back null — but a real
    // provider-supplied filedDate (distinct from tx_date) still publishes.
    const tx = mapFeedTransaction(
      feedRow({
        source: 'competitor_backfill',
        doc_id: 'COMPETITOR-abc123',
        filing_filed_date: null,
        filing_first_seen_at: null,
        filing_source_url: undefined,
        filed_date: '2026-07-20',
        first_seen_at: '2026-07-20T09:00:00.000Z',
        amount_min: 50001,
        amount_max: 100000,
        est_value: 75000.5,
        confidence: 0.4,
      }),
    );
    expect(tx.filedDate).toBe('2026-07-20');
    expect(tx.firstSeenAt).toBe('2026-07-20T09:00:00.000Z');
    expect(tx.amountMin).toBe(50001);
    expect(tx.amountMax).toBe(100000);
  });

  it('does not publish fabricated competitor $1,001–$15,000 or filed_date=tx_date', () => {
    const tx = mapFeedTransaction(
      feedRow({
        source: 'competitor_backfill',
        doc_id: 'COMPETITOR-fleischmann_TSCO_2026-06-09_sell',
        tx_date: '2026-06-09',
        filing_filed_date: null,
        filing_first_seen_at: null,
        filed_date: '2026-06-09',
        first_seen_at: '2026-06-09T00:00:00.000Z',
        amount_min: 1001,
        amount_max: 15000,
        est_value: 8000.5,
        confidence: 100,
        disclosure_lag_days: 0,
        stock_act_status: 'on_time',
      }),
    );
    expect(tx.amountMin).toBeNull();
    expect(tx.amountMax).toBeNull();
    expect(tx.filedDate).toBeNull();
    expect(tx.disclosureLagDays).toBeNull();
    expect(tx.stockActStatus).toBeNull();
    expect(tx.confidence).toBe(0);
    expect((tx as typeof tx & { estValue: number | null }).estValue).toBeNull();
  });

  it('stays honestly null when neither the filing join nor the transaction row has a value (seed_dataset)', () => {
    // Seed-dataset rows (bulk historical import, no filing PDF ever polled)
    // set firstSeenAt/filedDate to null at construction time (see
    // backfill/seed.ts) — the fallback must not fabricate a value from
    // created_at or any other proxy.
    const tx = mapFeedTransaction(
      feedRow({
        doc_id: 'seed-senate',
        filing_filed_date: null,
        filing_first_seen_at: null,
        filing_source_url: undefined,
        filed_date: null,
        first_seen_at: null,
      }),
    );
    expect(tx.filedDate).toBeNull();
    expect(tx.firstSeenAt).toBeNull();
  });

  it('does not report filing first-seen when that stamp predates this trade', () => {
    // Live Hern shape: House live search listed the DocID on July 30;
    // this trade is Aug 5; we persisted the row on Aug 11.
    const tx = mapFeedTransaction(
      feedRow({
        tx_date: '2026-08-05',
        created_at: '2026-08-11T13:06:49.836Z',
        filing_filed_date: '2026-08-10',
        filing_first_seen_at: '2026-07-30T15:32:12.565Z',
      }),
    );
    expect(tx.filedDate).toBe('2026-08-10');
    expect(tx.firstSeenAt).toBe('2026-08-11T13:06:49.836Z');
  });

  it('omits firstSeenAt rather than inventing when persist time also predates the trade', () => {
    const tx = mapFeedTransaction(
      feedRow({
        tx_date: '2026-08-05',
        created_at: '2026-07-31T00:00:00.000Z',
        filing_first_seen_at: '2026-07-30T15:32:12.565Z',
      }),
    );
    expect(tx.firstSeenAt).toBeNull();
  });

  it('canonicalizes malformed stored filer names at the API boundary', () => {
    const tx = mapFeedTransaction(feedRow({ filer_full_name: 'Richard Dean Dr McCormick' }));
    expect(tx.fullName).toBe('Richard Dean McCormick');
  });

  it('tolerates an unresolved filer (nulls pass through, never throws)', () => {
    const tx = mapFeedTransaction(
      feedRow({ filer_full_name: null, filer_state: null, filer_photo_url: null }),
    );
    expect(tx.fullName).toBeNull();
    expect(tx.state).toBeNull();
    expect(tx.photoUrl).toBeNull();
  });

  it('surfaces a NULL tx_type honestly as null, never silently defaulted to P (Buy)', () => {
    const tx = mapFeedTransaction(feedRow({ tx_type: null }));
    expect(tx.txType).toBeNull();
  });

  it('maps a "<TICKER> Stock" placeholder to the securities_ref canonical name (review #1453)', () => {
    const tx = mapFeedTransaction(
      feedRow({ asset_name: 'UNH Stock', ticker: 'UNH', ref_company_name: 'UnitedHealth Group Incorporated' }),
    );
    expect(tx.assetName).toBe('UnitedHealth Group Incorporated');
  });

  it('resolves the single-letter ticker X (US Steel) to its ref company name, not a blank/raw name', () => {
    const tx = mapFeedTransaction(
      feedRow({ asset_name: 'X', ticker: 'X', ref_company_name: 'United States Steel Corporation' }),
    );
    expect(tx.assetName).toBe('United States Steel Corporation');
  });

  it('leaves a genuinely unknown asset (no ref, no useful ticker match) as its filing text', () => {
    const tx = mapFeedTransaction(feedRow({ asset_name: 'Securities', ticker: null, ref_company_name: null }));
    expect(tx.assetName).toBe('Securities');
  });

  it('omits price, party, and latency when the query did not select them', () => {
    const tx = mapFeedTransaction(feedRow());
    expect(tx.priceAtTrade).toBeUndefined();
    expect(tx.party).toBeUndefined();
    expect(tx.latency).toBeUndefined();
  });

  it('maps price anchors, raw party, and one latency object when those columns are present', () => {
    const tx = mapFeedTransaction(feedRow({
      filer_party: 'Democratic',
      price_at_trade: 10.5,
      spx_at_trade: 5000,
      price_at_filing: 11,
      spx_at_filing: 5010,
      latency_provider: 'fmp',
      latency_observed_at: '2026-01-16T00:00:12.000Z',
      latency_provider_published_at: '2026-01-16T00:01:00.000Z',
      latency_congress_first_seen_at: '2026-01-16T00:00:00.000Z',
      latency_status: 'matched',
    }));
    expect(tx.party).toBe('Democratic');
    expect(tx.priceAtTrade).toBe(10.5);
    expect(tx.spxAtTrade).toBe(5000);
    expect(tx.priceAtFiling).toBe(11);
    expect(tx.spxAtFiling).toBe(5010);
    expect(tx.latency).toEqual({
      provider: 'fmp',
      observedAt: '2026-01-16T00:00:12.000Z',
      providerPublishedAt: '2026-01-16T00:01:00.000Z',
      congressFirstSeenAt: '2026-01-16T00:00:00.000Z',
      providerDeltaSec: 12,
      providerPublishedDeltaSec: 60,
      status: 'matched',
    });
  });

  it('publishes latency null when the columns were selected and no candidate matched', () => {
    const tx = mapFeedTransaction(feedRow({
      price_at_trade: null,
      spx_at_trade: null,
      price_at_filing: null,
      spx_at_filing: null,
      latency_provider: null,
      latency_observed_at: null,
      latency_provider_published_at: null,
      latency_congress_first_seen_at: null,
      latency_status: null,
    }));
    expect(tx.priceAtTrade).toBeNull();
    expect(tx.latency).toBeNull();
  });
});

describe('mapTransaction: honest tx_type passthrough', () => {
  function txRow(over: Partial<TransactionRow> = {}): TransactionRow {
    return {
      id: 't1',
      doc_id: 'H-1',
      filer_id: 'P000197',
      tx_date: '2024-01-02',
      owner: 'self',
      asset_name: 'Acme',
      ticker: 'ACME',
      asset_type: 'stock',
      tx_type: 'B',
      amount_min: 1001,
      amount_max: 15000,
      is_option: 0,
      cap_gains_over_200: 0,
      raw_text: '',
      confidence: 0.9,
      source: 'primary',
      created_at: '2024-01-03T00:00:00Z',
      cursor_seq: 5,
      est_value: null,
      ...over,
    };
  }

  it('passes a disclosed side through unchanged', () => {
    expect(mapTransaction(txRow({ tx_type: 'S' })).txType).toBe('S');
  });

  it('passes a NULL tx_type through as null rather than defaulting to P', () => {
    expect(mapTransaction(txRow({ tx_type: null })).txType).toBeNull();
  });
});

describe('mapTransaction: display-name cleanup (review #1453)', () => {
  function txRow(over: Partial<TransactionRow> = {}): TransactionRow {
    return {
      id: 't1',
      doc_id: 'H-1',
      filer_id: 'P000197',
      tx_date: '2024-01-02',
      owner: 'self',
      asset_name: 'Acme',
      ticker: 'ACME',
      asset_type: 'stock',
      tx_type: 'B',
      amount_min: 1001,
      amount_max: 15000,
      is_option: 0,
      cap_gains_over_200: 0,
      raw_text: '',
      confidence: 0.9,
      source: 'primary',
      created_at: '2024-01-03T00:00:00Z',
      cursor_seq: 5,
      est_value: null,
      ...over,
    };
  }

  // Every endpoint that serves a Transaction (not just the joined feed) now
  // shows the same cleaned-up name — this is the base mapper used by
  // GET /filings/:docId and the outbound webhook, which don't join
  // securities_ref, and previously showed raw ALL-CAPS filing text next to
  // the normalized names the feed already showed.
  it('title-cases raw ALL-CAPS filing names even with no securities_ref join available', () => {
    expect(mapTransaction(txRow({ asset_name: 'CLEVELAND-CLIFFS INC.', ticker: 'CLF' })).assetName).toBe(
      'Cleveland-Cliffs Inc.',
    );
    expect(mapTransaction(txRow({ asset_name: 'MICROSOFT CORP', ticker: 'MSFT' })).assetName).toBe(
      'Microsoft Corp.',
    );
  });

  it('degrades a "<TICKER> Stock" placeholder to the bare ticker rather than a mangled title-case', () => {
    expect(mapTransaction(txRow({ asset_name: 'UNH Stock', ticker: 'UNH' })).assetName).toBe('UNH');
  });

  it('leaves a genuinely unknown, ticker-less asset name unchanged (never invents one)', () => {
    expect(mapTransaction(txRow({ asset_name: 'Securities', ticker: null })).assetName).toBe(
      'Securities',
    );
  });
});

describe('escapeLikePattern', () => {
  it('backslash-escapes %, _, and a literal backslash', () => {
    expect(escapeLikePattern('a_b%c')).toBe('a\\_b\\%c');
    expect(escapeLikePattern('C:\\path')).toBe('C:\\\\path');
  });

  it('leaves ordinary text unchanged', () => {
    expect(escapeLikePattern('Pelosi')).toBe('Pelosi');
  });
});

describe('toPublicFiling', () => {
  const fullFiling: Filing = {
    docId: 'H-2026-1',
    chamber: 'house',
    filerId: 'P000197',
    filingType: 'P',
    filedDate: '2026-06-19',
    sourceUrl: 'https://disclosures-clerk.house.gov/doc.pdf',
    rawObjectKey: 'raw/2026/H-2026-1.pdf',
    ingestStatus: 'extracted',
    docKind: 'text_pdf',
    extractor: 'openrouter-vision',
    modelVersion: 'anthropic/claude-sonnet-5',
    confidence: 0.92,
    firstSeenAt: '2026-06-20T00:00:00.000Z',
    sourceUpdatedAt: null,
    error: null,
  };

  it('strips the R2 object key, extractor/model slug, and raw error text', () => {
    const pub = toPublicFiling(fullFiling);
    expect(pub).not.toHaveProperty('rawObjectKey');
    expect(pub).not.toHaveProperty('extractor');
    expect(pub).not.toHaveProperty('modelVersion');
    expect(pub).not.toHaveProperty('error');
    expect(JSON.stringify(pub)).not.toContain('openrouter-vision');
    expect(JSON.stringify(pub)).not.toContain('claude-sonnet-5');
    expect(JSON.stringify(pub)).not.toContain('raw/2026');
  });

  it('keeps every non-internal field intact', () => {
    const pub = toPublicFiling(fullFiling);
    expect(pub).toMatchObject({
      docId: 'H-2026-1',
      chamber: 'house',
      filerId: 'P000197',
      filingType: 'P',
      filedDate: '2026-06-19',
      sourceUrl: 'https://disclosures-clerk.house.gov/doc.pdf',
      ingestStatus: 'extracted',
      docKind: 'text_pdf',
      confidence: 0.92,
      firstSeenAt: '2026-06-20T00:00:00.000Z',
    });
  });

  it('still strips a populated raw error/model slug (a failed extraction is still internal detail)', () => {
    const pub = toPublicFiling({
      ...fullFiling,
      error: 'provider timeout after 3 retries: connect ECONNREFUSED 10.0.0.1:443',
    });
    expect(JSON.stringify(pub)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(pub)).not.toContain('10.0.0.1');
  });
});
