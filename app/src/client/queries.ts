import type { Env, Subscription, User } from '../shared/types.ts';
import { all, first, get } from '../shared/db.ts';
import {
  buildTransactionsCountQuery,
  buildTransactionsQuery,
  buildTxFilters,
  escapeLikePattern,
  mapSubscription,
  readCursorHighWater,
} from '../delivery/rows.ts';
import type { SubscriptionRow, TxQueryParams } from '../delivery/rows.ts';
import type {
  ClientTradeListEnvelope,
  ClientTradeRow,
  MemberProfileRow,
  ResolvedMember,
  SecurityRefRow,
} from './types.ts';
import {
  clientTradeFromRow,
  clientIdForUser,
  ClientInputError,
  num,
} from './utils.ts';
import { getSubscription } from '../delivery/subscriptions.ts';
import type { ClientTrade } from '../shared/types.ts';

export const SUBSCRIPTION_COLS =
  'id, client_id, delivery, target_url, secret, filters, cursor, active, created_at';

export const CLIENT_TRADE_SELECT =
  'SELECT t.*, COALESCE(fl.chamber, f.chamber) AS __chamber, COALESCE(fl.display_name, fl.full_name) AS __member_name, fl.party AS __party, ' +
  'COALESCE(fl.display_name, fl.full_name) AS filer_full_name, fl.state AS filer_state, ' +
  'fl.photo_url AS filer_photo_url, ' +
  'sr.company_name AS ref_company_name, sr.sector AS ref_sector, sr.market_cap AS ref_market_cap, ' +
  'sr.market_cap_bucket AS ref_market_cap_bucket, sr.country AS ref_country, ' +
  'sr.exchange_short AS ref_exchange_short, sr.asset_class AS ref_asset_class, ' +
  'f.filed_date AS filing_filed_date, f.first_seen_at AS filing_first_seen_at, f.source_url AS filing_source_url ' +
  'FROM transactions t ' +
  'LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id ' +
  'LEFT JOIN filings f ON f.doc_id = t.doc_id ' +
  'LEFT JOIN securities_ref sr ON sr.ticker = t.ticker ';

export const CLIENT_TRADE_BY_ID_SQL =
  CLIENT_TRADE_SELECT + 'WHERE t.deprecated_at IS NULL AND t.id = ? LIMIT 1';

export function tickerSummarySql(
  ticker: string,
  extra: TxQueryParams = {},
): { sql: string; params: Array<string | number> } {
  const { where, params } = buildTxFilters({ ...extra, ticker }, false);
  return {
    sql:
      'SELECT COUNT(*) AS total_trades, ' +
      "SUM(CASE WHEN t.tx_type IN ('B', 'P') THEN 1 ELSE 0 END) AS buy_count, " +
      "SUM(CASE WHEN t.tx_type = 'S' THEN 1 ELSE 0 END) AS sell_count, " +
      "SUM(CASE WHEN t.tx_type = 'E' THEN 1 ELSE 0 END) AS exchange_count, " +
      'COUNT(DISTINCT t.filer_id) AS member_count, ' +
      `SUM(t.est_value) AS est_volume, ` +
      `SUM(CASE WHEN t.tx_type IN ('B', 'P') THEN t.est_value WHEN t.tx_type = 'S' THEN -t.est_value ELSE 0 END) AS est_net_flow, ` +
      'MIN(t.tx_date) AS first_trade, MAX(t.tx_date) AS last_trade ' +
      'FROM transactions t ' +
      'LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id ' +
      'LEFT JOIN filings f ON f.doc_id = t.doc_id ' +
      `WHERE ${where.join(' AND ')}`,
    params,
  };
}

export function memberSummarySql(
  memberId: string,
  extra: TxQueryParams = {},
): { sql: string; params: Array<string | number> } {
  const { where, params } = buildTxFilters({ ...extra, member: memberId }, false);
  return {
    sql:
      'SELECT COUNT(*) AS total_trades, ' +
      "SUM(CASE WHEN t.tx_type IN ('B', 'P') THEN 1 ELSE 0 END) AS buy_count, " +
      "SUM(CASE WHEN t.tx_type = 'S' THEN 1 ELSE 0 END) AS sell_count, " +
      "SUM(CASE WHEN t.tx_type = 'E' THEN 1 ELSE 0 END) AS exchange_count, " +
      "COUNT(DISTINCT CASE WHEN t.ticker IS NOT NULL AND t.ticker <> '' THEN t.ticker END) AS unique_tickers, " +
      "COUNT(DISTINCT COALESCE(CASE WHEN t.ticker IS NOT NULL AND t.ticker <> '' THEN t.ticker END, NULLIF(t.asset_name, ''))) AS unique_assets, " +
      `SUM(t.est_value) AS est_volume, ` +
      `SUM(CASE WHEN t.tx_type IN ('B', 'P') THEN t.est_value WHEN t.tx_type = 'S' THEN -t.est_value ELSE 0 END) AS est_net_flow, ` +
      'MIN(t.tx_date) AS first_trade, MAX(t.tx_date) AS last_trade ' +
      'FROM transactions t ' +
      'LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id ' +
      'LEFT JOIN filings f ON f.doc_id = t.doc_id ' +
      `WHERE ${where.join(' AND ')}`,
    params,
  };
}

export async function readClientTradeList(env: Env, params: TxQueryParams): Promise<ClientTradeListEnvelope> {
  const built = buildTransactionsQuery(params);
  const rows = await all<ClientTradeRow>(env.DB, built.sql, built.params);
  const items = rows.map(clientTradeFromRow);
  const maxCursor = items.reduce((m, t) => (t.cursor > m ? t.cursor : m), params.since ?? 0);

  // Zero-delta incremental poll: a `?since=` cursor that comes back with no
  // new rows is the steady-state case for both known clients (the dashboard's
  // fetchUpdates() and the web app's poll() both bail out — `if (!txs.length)
  // return` / `if (delta.items.length > 0)` — before ever reading `total` on
  // an empty delta). Skip the full unindexed COUNT(*) scan entirely rather
  // than paying D1 read cost for a number no conforming client observes.
  // `total` is omitted here (not falsely reported as 0) so a future consumer
  // that reads it on every poll can tell "not computed this round" apart from
  // "actually zero".
  if (params.since !== undefined && items.length === 0) {
    const hwm = await readCursorHighWater(env);
    const effectiveCursor =
      maxCursor > 1_000_000_000_000 || (hwm > 0 && maxCursor > hwm)
        ? Math.min(maxCursor, hwm)
        : maxCursor;
    return { items, cursor: effectiveCursor, count: 0, limit: built.limit };
  }

  const countQuery = buildTransactionsCountQuery(params);
  const countRow = await first<{ total: number | string | null }>(env.DB, countQuery.sql, countQuery.params);
  return {
    items,
    cursor: maxCursor,
    count: items.length,
    total: num(countRow?.total ?? items.length),
    limit: built.limit,
  };
}

export async function getClientTrade(env: Env, id: string): Promise<ClientTrade | null> {
  const row = await get<ClientTradeRow>(env.DB, CLIENT_TRADE_BY_ID_SQL, [id]);
  return row ? clientTradeFromRow(row) : null;
}

export async function getSecurityRef(env: Env, ticker: string): Promise<SecurityRefRow | null> {
  return get<SecurityRefRow>(
    env.DB,
    'SELECT ticker, company_name, sector, industry, asset_class, country, exchange_short, currency, market_cap, market_cap_bucket, current_price, current_price_date FROM securities_ref WHERE ticker = ?',
    [ticker],
  );
}

const MEMBER_PROFILE_COLS =
  'bioguide_id, chamber, COALESCE(display_name, full_name) AS full_name, party, state, district, committees, photo_url, resolved_bioguide_id';

// CT-2459: 5-minute isolate memo for term -> member resolution. The
// fallback name search is an unindexed LOWER(full_name) LIKE scan and ran
// BEFORE the KV cache lookup on member routes, so even cache hits paid
// 1-3 DB queries per request. Filer profiles change rarely; null results
// are not memoized (a newly added filer resolves immediately).
const MEMBER_RESOLVE_CACHE_MS = 5 * 60_000;
const memberResolveCache = new Map<string, { resolved: ResolvedMember; expiresAtMs: number }>();

/** Test hook: drop the resolve memo. */
export function resetMemberResolveCacheForTests(): void {
  memberResolveCache.clear();
}

export async function resolveMember(env: Env, value: string): Promise<ResolvedMember | null> {
  const term = value.trim();
  const memoKey = term.toLowerCase();
  const memo = memberResolveCache.get(memoKey);
  if (memo && memo.expiresAtMs > Date.now()) return memo.resolved;
  const resolved = await resolveMemberUncached(env, term);
  if (resolved) {
    if (memberResolveCache.size >= 500) memberResolveCache.clear();
    memberResolveCache.set(memoKey, {
      resolved,
      expiresAtMs: Date.now() + MEMBER_RESOLVE_CACHE_MS,
    });
  }
  return resolved;
}

async function resolveMemberUncached(env: Env, term: string): Promise<ResolvedMember | null> {
  const byId = await get<MemberProfileRow>(
    env.DB,
    `SELECT ${MEMBER_PROFILE_COLS} FROM filers WHERE LOWER(bioguide_id) = LOWER(?) LIMIT 1`,
    [term],
  );
  if (byId) return { id: byId.bioguide_id, profile: byId };
  // Official bioguides (K000389) live on filers.resolved_bioguide_id while the
  // PK is a house-/senate- slug.  Directory rows use the slug (and have a
  // photo); a trade or Trends tap that still carries the bioguide used to
  // miss the profile and return photoUrl: null — iOS then painted the party
  // donkey instead of the face already on the roster.
  const byResolved = await get<MemberProfileRow>(
    env.DB,
    `SELECT ${MEMBER_PROFILE_COLS} FROM filers WHERE LOWER(resolved_bioguide_id) = LOWER(?) LIMIT 1`,
    [term],
  );
  if (byResolved) return { id: byResolved.bioguide_id, profile: byResolved };
  const likeTerm = `%${escapeLikePattern(term.toLowerCase())}%`;
  const byName = await get<MemberProfileRow>(
    env.DB,
    `SELECT ${MEMBER_PROFILE_COLS} FROM filers` +
      " WHERE LOWER(full_name) = LOWER(?) OR LOWER(full_name) LIKE ? ESCAPE '\\'" +
      " OR LOWER(display_name) = LOWER(?) OR LOWER(display_name) LIKE ? ESCAPE '\\'" +
      " ORDER BY CASE WHEN LOWER(full_name) = LOWER(?) OR LOWER(display_name) = LOWER(?) THEN 0 ELSE 1 END, full_name LIMIT 1",
    [term, likeTerm, term, likeTerm, term, term],
  );
  if (byName) return { id: byName.bioguide_id, profile: byName };
  if (/^[A-Za-z0-9_-]{1,64}$/.test(term)) return { id: term, profile: null };
  return null;
}

export async function listUserSubscriptions(env: Env, user: User): Promise<Subscription[]> {
  const rows = await all<SubscriptionRow>(
    env.DB,
    `SELECT ${SUBSCRIPTION_COLS} FROM subscriptions WHERE client_id = ? ORDER BY created_at DESC`,
    [clientIdForUser(user)],
  );
  return rows.map(mapSubscription);
}

export async function getOwnedSubscription(env: Env, user: User, id: string): Promise<Subscription> {
  const sub = await getSubscription(env, id);
  if (!sub || sub.clientId !== clientIdForUser(user)) {
    throw new ClientInputError('subscription not found', 404);
  }
  return sub;
}
