/**
 * src/delivery/rows.ts
 * OWNER: delivery agent (helper)
 *
 * Row <-> domain mappers shared by the delivery + admin modules. D1 stores
 * SQLite scalars (TEXT/INTEGER/REAL); these helpers translate raw rows into the
 * camelCase domain shapes declared in shared/types.ts and back again. Kept
 * dependency-free and pure so they are trivially unit-testable.
 */

import type {
  Chamber,
  DeliveryChannel,
  Env,
  Filing,
  Owner,
  Subscription,
  SubscriptionFilters,
  Transaction,
  TxSource,
  TxType,
} from '../shared/types.ts';
import { all, first, get, parseJson, toBool } from '../shared/db.ts';
import type { StockActStatus } from '../shared/stockAct.ts';
import {
  canonicalAssetTypeCategorySql,
  canonicalizeAssetType,
  isAssetTypeCategory,
} from '../shared/assetTypes.ts';
import type { AssetTypeCategory } from '../shared/assetTypes.ts';
import { resolveAssetDisplayName } from '../shared/companyName.ts';
import { plainCleaningNote } from '../shared/cleaningNote.ts';
import { cleanFilerName } from '../extraction/nameNormalizer.ts';
import { tradeLearnedAt } from './tradeLearnedAt.ts';
import { sanitizeCompetitorPublication, TWIN_DEDUPE_SQL } from '../shared/tradeIdentity.ts';

// ---------------------------------------------------------------------------
// Raw row shapes (mirror the D1 column names in migrations/0001_init.sql)
// ---------------------------------------------------------------------------

export interface TransactionRow {
  id: string;
  doc_id: string;
  filer_id: string | null;
  tx_date: string | null;
  owner: string | null;
  asset_name: string | null;
  ticker: string | null;
  asset_type: string | null;
  asset_type_name?: string | null;
  tx_type: string | null;
  amount_min: number | null;
  amount_max: number | null;
  is_option: number | null;
  cap_gains_over_200: number | null;
  raw_text: string | null;
  filing_status?: string | null;
  subholding?: string | null;
  location?: string | null;
  description?: string | null;
  supplemental_text?: string | null;
  confidence: number | null;
  source: string | null;
  row_key?: string | null;
  created_at: string | null;
  cursor_seq: number | null;
  est_value: number | null;
  disclosure_lag_days?: number | null;
  stock_act_status?: string | null;
  cleaning_note?: string | null;
  // Migration 0020 added these directly on `transactions` (backfilled from the
  // owning filing, and populated at insert time by every persistTransactions()
  // caller — see extraction/normalizer.ts). `t.*` always selects them; typed
  // here so mapFeedTransaction can fall back to them when a row has no
  // matching `filings` record (competitor_backfill rows: doc_id LIKE
  // 'COMPETITOR-%' with no OGE/clerk filing behind them, so the `f.` LEFT JOIN
  // below never matches, but persistTransactions() still wrote a real
  // first_seen_at/filed_date onto the transaction row itself).
  first_seen_at?: string | null;
  filed_date?: string | null;
}

/**
 * A transaction row with the filer's identity joined in (LEFT JOIN filers).
 * Used by the dashboard feed + SSE stream so each row can show a resolved
 * politician name + headshot. The filer columns are nullable: transactions.filer_id
 * may be null or may not resolve to a filers row (e.g. seed/backfill rows).
 */
export interface FeedTransactionRow extends TransactionRow {
  filer_full_name: string | null;
  filer_state: string | null;
  filer_photo_url: string | null;
  // Official Bioguide ID matched by member enrichment (migration 0066); null
  // until the enrichment job matches the filer name. Optional so tests building
  // a feed row needn't supply it.
  filer_bioguide_id?: string | null;
  filing_filed_date: string | null;
  filing_first_seen_at: string | null;
  filing_source_url?: string | null;
  filing_raw_object_key?: string | null;
  // Cross-referenced asset reference data (securities_ref); null until enriched,
  // optional so callers/tests that build a feed row needn't supply them.
  ref_company_name?: string | null;
  ref_sector?: string | null;
  ref_market_cap?: number | null;
  ref_market_cap_bucket?: string | null;
  ref_country?: string | null;
  ref_exchange_short?: string | null;
  ref_asset_class?: string | null;
  /** Present only when the feed SELECT aliases `fl.party`.  SSE/CSV omit it. */
  filer_party?: string | null;
  price_at_trade?: number | null;
  spx_at_trade?: number | null;
  price_at_filing?: number | null;
  spx_at_filing?: number | null;
  latency_provider?: string | null;
  latency_observed_at?: string | null;
  latency_provider_published_at?: string | null;
  latency_congress_first_seen_at?: string | null;
  latency_status?: string | null;
}

export interface SubscriptionRow {
  id: string;
  client_id: string | null;
  delivery: string | null;
  target_url: string | null;
  secret: string | null;
  filters: string | null;
  cursor: number | null;
  active: number | null;
  created_at: string | null;
}

export interface FilingRow {
  doc_id: string;
  chamber: string | null;
  filer_id: string | null;
  filing_type: string | null;
  filed_date: string | null;
  source_url: string | null;
  raw_object_key: string | null;
  ingest_status: string | null;
  doc_kind: string | null;
  extractor: string | null;
  model_version: string | null;
  confidence: number | null;
  first_seen_at: string | null;
  source_updated_at: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function mapTransaction(row: TransactionRow): Transaction {
  const isOption = toBool(row.is_option);
  const assetType = canonicalizeAssetType(row.asset_type, row.asset_type_name ?? null, {
    isOption,
    assetName: row.asset_name ?? null,
  });
  const transaction: Transaction & { estValue: number | null } = {
    id: row.id,
    docId: row.doc_id,
    filerId: row.filer_id,
    txDate: row.tx_date,
    owner: (row.owner as Owner | null) ?? null,
    // Server-side display-name resolution (review #1453): every endpoint that
    // serves a Transaction — feed, /filings/:docId, webhooks — shows the same
    // cleaned-up name, not raw ALL-CAPS filing text on some paths and a
    // title-cased name on others. No securities_ref name is available at this
    // base-row level (see mapFeedTransaction for the ref-aware upgrade), so
    // this only strips generic placeholders and title-cases real text.
    assetName: resolveAssetDisplayName(row.asset_name, row.ticker, null) ?? '',
    ticker: row.ticker,
    assetType: row.asset_type,
    assetTypeName: row.asset_type_name ?? null,
    assetTypeCategory: assetType.category,
    assetTypeCategoryLabel: assetType.categoryLabel,
    // Honest passthrough: a filing row with no disclosed side (row.tx_type
    // NULL — malformed/partial source text) is surfaced as null, never
    // silently defaulted to Buy. Downstream aggregates already
    // treat a non-matching tx_type as "not counted" (see tickerSummarySql/
    // memberSummarySql's buy/sell CASE expressions and
    // subscriptions.ts's `sides` filter), so a null side is naturally
    // excluded from buy/sell/exchange counts rather than misreported as a buy.
    // Storage codes B|S|E; legacy P coerced to B on read.
    txType: ((row.tx_type === 'B' || row.tx_type === 'P') ? 'B' : row.tx_type) as TxType,
    amountMin: row.amount_min,
    amountMax: row.amount_max,
    estValue: row.est_value ?? null,
    isOption,
    capGainsOver200: toBool(row.cap_gains_over_200),
    rawText: row.raw_text ?? '',
    filingStatus: row.filing_status ?? null,
    subholding: row.subholding ?? null,
    location: row.location ?? null,
    description: row.description ?? null,
    supplementalText: row.supplemental_text ?? null,
    confidence: row.confidence ?? 0,
    source: (row.source as TxSource) ?? 'primary',
    rowKey: row.row_key ?? null,
    createdAt: row.created_at ?? '',
    cursorSeq: row.cursor_seq ?? 0,
    disclosureLagDays: row.disclosure_lag_days ?? null,
    stockActStatus: (row.stock_act_status as StockActStatus | null) ?? null,
    cleaningNote: plainCleaningNote(row.cleaning_note ?? null) || null,
  };
  return sanitizeCompetitorPublication({
    ...transaction,
    filedDate: row.filed_date ?? null,
  });
}

/**
 * Map a feed row (transaction + joined filer identity) to a Transaction,
 * carrying the resolved politician name/state/headshot. Kept separate from
 * mapTransaction so the webhook/normalizer paths (which never join filers) are
 * unaffected.
 */
function selectedNumber(row: object, key: string): number | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(row, key)) return undefined;
  const value = (row as Record<string, unknown>)[key];
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Later minus earlier, in seconds.  Same rounding as admin disclosure-latency. */
function deltaSeconds(later: string | null, earlier: string | null): number | null {
  if (!later || !earlier) return null;
  const a = Date.parse(later);
  const b = Date.parse(earlier);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((a - b) / 1000) : null;
}

const LATENCY_ROW_KEYS = [
  'latency_provider',
  'latency_observed_at',
  'latency_provider_published_at',
  'latency_congress_first_seen_at',
  'latency_status',
] as const;

/**
 * One latency object, or null when the columns were selected and every one is
 * null.  Undefined when this query did not select the latency columns.
 */
function feedLatency(row: FeedTransactionRow): Transaction['latency'] {
  if (!LATENCY_ROW_KEYS.some((key) => Object.prototype.hasOwnProperty.call(row, key))) return undefined;
  const provider = row.latency_provider ?? null;
  const observedAt = row.latency_observed_at ?? null;
  const providerPublishedAt = row.latency_provider_published_at ?? null;
  const congressFirstSeenAt = row.latency_congress_first_seen_at ?? null;
  const status = row.latency_status ?? null;
  if (
    provider == null &&
    observedAt == null &&
    providerPublishedAt == null &&
    congressFirstSeenAt == null &&
    status == null
  ) {
    return null;
  }
  return {
    provider,
    observedAt,
    providerPublishedAt,
    congressFirstSeenAt,
    providerDeltaSec: deltaSeconds(observedAt, congressFirstSeenAt),
    providerPublishedDeltaSec: deltaSeconds(providerPublishedAt, congressFirstSeenAt),
    status,
  };
}

export function mapFeedTransaction(row: FeedTransactionRow): Transaction {
  const transaction = mapTransaction(row);

  // Re-resolve from the raw filing text with the joined securities_ref name
  // available (mapTransaction already resolved a ref-less baseline above;
  // this is the ref-aware upgrade — prefers the canonical company name,
  // maps "<TICKER> Stock"-style placeholders to it, and leaves genuinely
  // unknown assets exactly as filed). See shared/companyName.ts.
  transaction.assetName =
    resolveAssetDisplayName(row.asset_name, row.ticker, row.ref_company_name) || transaction.assetName;

  const mapped = sanitizeCompetitorPublication({
    ...transaction,
    fullName: row.filer_full_name ? (cleanFilerName(row.filer_full_name) || row.filer_full_name) : null,
    state: row.filer_state,
    photoUrl: row.filer_photo_url,
    bioguideId: row.filer_bioguide_id ?? null,
    // Prefer the joined filing's own filed_date/first_seen_at (the normal
    // case — a real House/Senate/OGE filing exists and `f.` matched). Fall
    // back to the transaction row's own columns when there is no matching
    // `filings` row at all (competitor_backfill: `persistTransactions()`
    // still wrote a real filedDate/firstSeenAt onto `t.*` even though there's
    // no filing PDF to join against). Seed-dataset rows correctly stay null
    // either way — the source watcher dump the seed backfill reads has no
    // disclosure-date/first-seen equivalent, so `t.filed_date`/
    // `t.first_seen_at` are null there too; this fallback recovers real,
    // already-persisted data, never fabricates a value.  Competitor rows
    // whose only date is filed_date = tx_date are stripped below.
    filedDate: row.filing_filed_date ?? row.filed_date ?? null,
    firstSeenAt: tradeLearnedAt(
      row.filing_first_seen_at ?? row.first_seen_at,
      row.created_at,
      row.tx_date,
    ),
    sourceUrl: row.filing_source_url ?? undefined,
    pdfUrl: row.filing_raw_object_key ? `/api/documents/${row.doc_id}/pdf` : undefined,
    refCompanyName: row.ref_company_name,
    refSector: row.ref_sector,
    refMarketCap: row.ref_market_cap,
    refMarketCapBucket: row.ref_market_cap_bucket,
    refCountry: row.ref_country,
    refExchangeShort: row.ref_exchange_short,
    refAssetClass: row.ref_asset_class,
  });
  if (Object.prototype.hasOwnProperty.call(row, 'filer_party')) {
    mapped.party = row.filer_party ?? null;
  }
  const priceAtTrade = selectedNumber(row, 'price_at_trade');
  const spxAtTrade = selectedNumber(row, 'spx_at_trade');
  const priceAtFiling = selectedNumber(row, 'price_at_filing');
  const spxAtFiling = selectedNumber(row, 'spx_at_filing');
  if (priceAtTrade !== undefined) mapped.priceAtTrade = priceAtTrade;
  if (spxAtTrade !== undefined) mapped.spxAtTrade = spxAtTrade;
  if (priceAtFiling !== undefined) mapped.priceAtFiling = priceAtFiling;
  if (spxAtFiling !== undefined) mapped.spxAtFiling = spxAtFiling;
  const latency = feedLatency(row);
  if (latency !== undefined) mapped.latency = latency;
  return mapped;
}

export function mapSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    clientId: row.client_id ?? '',
    delivery: (row.delivery as DeliveryChannel) ?? 'webhook',
    targetUrl: row.target_url,
    secret: row.secret,
    filters: parseJson<SubscriptionFilters>(row.filters, {}),
    cursor: row.cursor ?? 0,
    active: toBool(row.active),
    createdAt: row.created_at ?? '',
  };
}

export function mapFiling(row: FilingRow): Filing {
  return {
    docId: row.doc_id,
    chamber: (row.chamber as Chamber) ?? 'house',
    filerId: row.filer_id,
    filingType: row.filing_type ?? 'P',
    filedDate: row.filed_date,
    sourceUrl: row.source_url ?? '',
    rawObjectKey: row.raw_object_key,
    ingestStatus: (row.ingest_status as Filing['ingestStatus']) ?? 'new',
    docKind: (row.doc_kind as Filing['docKind']) ?? 'unknown',
    extractor: row.extractor,
    modelVersion: row.model_version,
    confidence: row.confidence,
    firstSeenAt: row.first_seen_at ?? '',
    sourceUpdatedAt: row.source_updated_at,
    error: row.error,
  };
}

/** Public-safe projection of {@link Filing} for unauthenticated responses. */
export type PublicFiling = Omit<Filing, 'rawObjectKey' | 'extractor' | 'modelVersion' | 'error'>;

/**
 * Strip internal infrastructure detail from a Filing before it reaches an
 * anonymous caller (the public `GET /filings/:docId` REST endpoint): the R2
 * object key of the raw fetched document (`rawObjectKey`), the extractor/model
 * slug that produced the result (`extractor`, `modelVersion`), and any raw
 * provider/parsing error text (`error`) are internal operational detail, not
 * something a public API response should hand out. `mapFiling` itself stays
 * full-fidelity for internal callers (admin routes, the agreement/normalizer
 * recompute path) — this is a projection applied only at the public edge.
 */
export function toPublicFiling(filing: Filing): PublicFiling {
  const { rawObjectKey: _rawObjectKey, extractor: _extractor, modelVersion: _modelVersion, error: _error, ...pub } = filing;
  if (filing.rawObjectKey) pub.pdfUrl = `/api/documents/${filing.docId}/pdf`;
  return pub;
}

/**
 * Escape SQLite LIKE metacharacters (`%`, `_`, and the escape character
 * itself) in user-supplied text before it is wrapped in wildcards and bound
 * to a `LIKE ? ESCAPE '\'` clause. Without this, a search term containing a
 * literal `%` or `_` silently broadens the match (e.g. a member search for
 * `A_Smith` would match `AxSmith` too) instead of the literal substring the
 * caller typed. Pair every use with `ESCAPE '\'` in the SQL.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Resolve a free-text member name to a `filers.bioguide_id` so the feed can
 * filter on the indexed `transactions.filer_id` column instead of a
 * full-corpus `LOWER(full_name) LIKE` join path (a raw memberName filter
 * defeats the nested keyset in buildTransactionsQuery — see
 * canNestTransactionKeyset). Exact match ranks first, then substring, mirroring
 * the client API's resolveMember (src/client/queries.ts). Uses
 * `idx_filers_full_name_lower` (migration 0075). Returns null when no filer
 * matches; callers then keep the legacy LIKE fallback so transactions whose
 * filer_id never resolved to a filers row stay reachable by name text.
 */
export async function resolveMemberFilerId(env: Env, memberName: string): Promise<string | null> {
  const term = memberName.trim();
  if (!term) return null;
  // A substring like "Capito" can match SEVERAL filers rows for the same real
  // person (e.g. the live "Shelley Moore Capito" plus a dormant seed row
  // "Shelley M Capito" that holds no live transactions, or an alias row
  // tombstoned by the identity dedupe in migration 0078). Picking alphabetically
  // silently returned the dead row and the search showed ZERO trades for an
  // active senator. Rank: exact name first, then canonical (not merged away),
  // then filers that actually have live transactions, then name.
  const row = await get<{ bioguide_id: string }>(
    env.DB,
    `SELECT COALESCE(f.merged_into, f.bioguide_id) AS bioguide_id
       FROM filers f
      WHERE LOWER(f.full_name) = LOWER(?) OR LOWER(f.full_name) LIKE ? ESCAPE '\\'
         OR LOWER(f.display_name) = LOWER(?) OR LOWER(f.display_name) LIKE ? ESCAPE '\\'
      ORDER BY CASE WHEN LOWER(f.full_name) = LOWER(?) OR LOWER(f.display_name) = LOWER(?) THEN 0 ELSE 1 END,
               CASE WHEN f.merged_into IS NULL THEN 0 ELSE 1 END,
               EXISTS(SELECT 1 FROM transactions t
                       WHERE t.filer_id = f.bioguide_id AND t.deprecated_at IS NULL) DESC,
               f.full_name
      LIMIT 1`,
    [
      term,
      `%${escapeLikePattern(term.toLowerCase())}%`,
      term,
      `%${escapeLikePattern(term.toLowerCase())}%`,
      term,
      term,
    ],
  );
  return row?.bioguide_id ?? null;
}

/** One `filers` row a free-text member name could refer to (see {@link findMemberCandidates}). */
export interface MemberCandidate {
  /** Canonical filer id: `COALESCE(merged_into, bioguide_id)`. */
  filerId: string;
  name: string | null;
  /** The name equals the filer's full/display name (case-insensitive) rather than merely containing it. */
  exact: boolean;
  /** The canonical filer has at least one live (non-deprecated) transaction. */
  live: boolean;
}

/**
 * Every filer a free-text member name could mean, best first: exact name
 * matches, then filers with live transactions, then name.  Same WHERE clause as
 * {@link resolveMemberFilerId}, but it returns several rows so a caller that
 * must not guess (subscription filters) can tell "one person" from "several".
 */
export async function findMemberCandidates(
  env: Env,
  memberName: string,
  limit = 25,
): Promise<MemberCandidate[]> {
  const term = memberName.trim();
  if (!term) return [];
  const like = `%${escapeLikePattern(term.toLowerCase())}%`;
  const rows = await all<{ filer_id: string; name: string | null; is_exact: number; is_live: number }>(
    env.DB,
    `SELECT COALESCE(f.merged_into, f.bioguide_id) AS filer_id,
            COALESCE(cf.display_name, cf.full_name, f.display_name, f.full_name) AS name,
            CASE WHEN LOWER(f.full_name) = LOWER(?) OR LOWER(f.display_name) = LOWER(?) THEN 1 ELSE 0 END AS is_exact,
            EXISTS(SELECT 1 FROM transactions t
                    WHERE t.filer_id IN (f.bioguide_id, COALESCE(f.merged_into, f.bioguide_id))
                      AND t.deprecated_at IS NULL) AS is_live
       FROM filers f
       LEFT JOIN filers cf ON cf.bioguide_id = f.merged_into
      WHERE LOWER(f.full_name) = LOWER(?) OR LOWER(f.full_name) LIKE ? ESCAPE '\\'
         OR LOWER(f.display_name) = LOWER(?) OR LOWER(f.display_name) LIKE ? ESCAPE '\\'
      ORDER BY is_exact DESC, is_live DESC, f.full_name
      LIMIT ?`,
    [term, term, term, like, term, like, limit],
  );
  return rows.map((row) => ({
    filerId: row.filer_id,
    name: row.name ? (cleanFilerName(row.name) || row.name) : null,
    exact: Number(row.is_exact) === 1,
    live: Number(row.is_live) === 1,
  }));
}

export type MemberPick =
  | { kind: 'match'; filerId: string; name: string | null }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: Array<{ filerId: string; name: string | null }> };

/**
 * Decide whether a name identifies exactly one member.  Duplicate rows of one
 * canonical filer (an alias tombstone plus its survivor) collapse first; then
 * exact-name matches win over substring matches, and filers with live trades win
 * over dormant duplicates (the "Shelley M Capito" seed row).  If more than one
 * person is still left, the name is ambiguous — never guess.
 */
export function pickMemberCandidate(candidates: MemberCandidate[]): MemberPick {
  const byId = new Map<string, MemberCandidate>();
  for (const cand of candidates) {
    const prev = byId.get(cand.filerId);
    byId.set(
      cand.filerId,
      prev
        ? { ...prev, name: prev.name ?? cand.name, exact: prev.exact || cand.exact, live: prev.live || cand.live }
        : cand,
    );
  }
  let pool = [...byId.values()];
  if (pool.length === 0) return { kind: 'none' };
  const exact = pool.filter((cand) => cand.exact);
  if (exact.length > 0) pool = exact;
  const live = pool.filter((cand) => cand.live);
  if (live.length > 0) pool = live;
  if (pool.length === 1) return { kind: 'match', filerId: pool[0].filerId, name: pool[0].name };
  return { kind: 'ambiguous', candidates: pool.map(({ filerId, name }) => ({ filerId, name })) };
}

// ---------------------------------------------------------------------------
// Transactions query builder (the REST `?since=` cursor backstop)
// ---------------------------------------------------------------------------

const TX_SOURCE_VALUES = new Set<TxSource>([
  'primary',
  'seed_dataset',
  'manual',
  'competitor_backfill',
  'local_mac',
  'server_cpu',
]);

/** Parse `?source=` for the public + client feeds. Unknown values are ignored. */
export function asTxSource(v: string | undefined): TxQueryParams['source'] {
  if (!v) return undefined;
  const key = v.trim().toLowerCase();
  if (key === 'all') return 'all';
  if (TX_SOURCE_VALUES.has(key as TxSource)) return key as TxSource;
  return undefined;
}

export interface TxQueryParams {
  since?: number;
  offset?: number;
  ticker?: string;
  member?: string;
  memberName?: string;
  chamber?: Chamber;
  /**
   * Multi-chamber selection (takes precedence over `chamber`). ABSENT means
   * the default congressional view: house + senate + unresolved-chamber rows,
   * with executive (OGE 278-T) rows excluded — they appear only on explicit
   * request so a single mega-filing can't swamp the feed.
   */
  chambers?: Chamber[];
  /**
   * Multi-select party-bucket filter (D/R/O, bucketed from `filers.party` by
   * first letter — same bucketing as PARTY_BUCKET_SQL in analytics/sql.ts,
   * duplicated locally in {@link PARTY_BUCKET_SQL_LOCAL} so this module stays
   * dependency-free). `O` is "Other / No party": Independents, minor parties
   * AND rows whose filer has no party on file, so D + R + O always equals the
   * unfiltered result. ABSENT/empty means no party filter. Exposed on the
   * public feed as `?party=D,R` — the same param shape the Trends analytics
   * endpoints already accept, so a party chip selection filters both tabs
   * identically.
   */
  partyBuckets?: Array<'D' | 'R' | 'O'>;
  type?: TxType;
  /**
   * Multi-select transaction type filter (B/S/E). Takes precedence over `type`
   * when non-empty. Exposed as `?type=B,S` on public + client feeds so multi-
   * select side chips can narrow both the page rows and the COUNT(*) total.
   */
  types?: TxType[];
  /**
   * Canonical instrument-class filter (`AssetTypeCategory`), e.g.
   * `['fund', 'public_equity']` for the owner's "Public Equities, Funds, &
   * ETFs" dropdown option. Exposed on the public + client feeds as
   * `?assetClass=equities_funds` (see {@link asAssetCategories}).
   *
   * Deliberately SERVER-side: a client that instead filtered one already
   * fetched page would report a count drawn from that page, which is exactly
   * the "shows 100 because that's the page size" class of bug. Applied through
   * the shared {@link buildTxFilters}, so `buildTransactionsCountQuery`'s
   * `total` — and the CSV export set — narrow with it.
   *
   * ABSENT/empty means no instrument-class filter (the "All" option).
   */
  assetCategories?: AssetTypeCategory[];
  /**
   * STOCK Act 45-day classification filter (`transactions.stock_act_status`,
   * stored by migration 0065). Exposed on the public feed as `?stockAct=late`
   * etc. Rows with unknown dates (NULL status) are excluded when set.
   */
  stockAct?: StockActStatus;
  /**
   * Beneficial-owner filter (`transactions.owner`, canonicalized at insert to
   * self/spouse/joint/dependent). Exposed on the public feed as `?owner=spouse`
   * etc. Rows with unknown owner (NULL) are excluded when set.
   */
  owner?: Owner;
  /** Inclusive filter on the disclosed bracket floor (`amount_min`). */
  minAmount?: number;
  /** Inclusive filter on the disclosed bracket floor (`amount_min`). */
  maxAmount?: number;
  limit?: number;
  /**
   * Freemium gate: only rows whose filing date (or, lacking a filing, trade
   * date) is on/after this `YYYY-MM-DD` are returned. Applied to both the feed
   * and the count, so non-premium visitors see a consistent recent window.
   */
  filedSince?: string;
  /**
   * Rolling-window bounds on the *trade* date (`transactions.tx_date`), each a
   * `YYYY-MM-DD`. Exposed on the public feed as `?from=`/`?to=` so a consumer
   * pulling, say, the last 90 days can pass `from = today-90d` and have the
   * server drop out-of-window rows. This matters because the feed is ordered by
   * cursor_seq ASC (oldest first): without a server-side floor, a bounded pager
   * would have to walk every historical row before reaching recent trades.
   * Filters on tx_date specifically (not filed_date) so the window matches the
   * trade itself; rows with a null tx_date are excluded when a bound is set.
   */
  txDateMin?: string;
  txDateMax?: string;
  /**
   * Sort expression for snapshot reads. Defaults to cursor_seq so incremental
   * consumers keep the forward-cursor contract; the public UI can request
   * `published` to sort by filing/import time instead of insertion order.
   * `order=desc` with no explicit sort uses {@link NEWEST_SNAPSHOT_ORDER_SQL}
   * so a historical backfill cannot occupy page 1 (#2180).
   */
  sort?: 'cursor' | 'published' | 'tx_date';
  /**
   * Sort direction. Defaults to `'asc'` (oldest-first), which
   * preserves the forward-cursor reconciliation contract: callers page by
   * feeding the returned max `cursor` back as the next `since`, so an
   * incremental sync resumes gap-free. Pass `'desc'` for a newest-first
   * "latest trades" snapshot (e.g. a sibling app rendering the most recent N) —
   * pair it with `?from=` to bound the window. DESC is a snapshot, not a
   * resumable forward pager, so incremental-sync consumers should keep the
   * default. Only the closed `'asc'|'desc'` literal reaches the SQL, never raw
   * caller text.
   *
   * NOTE: `GET /api/client/v1/feed` (src/client/routes.ts) applies its own
   * default ON TOP of this one — `undefined` here becomes `'desc'` before it
   * ever reaches this builder, but ONLY when the request also has no `since`
   * cursor. The oldest rows in cursor_seq order are bulk-imported
   * `seed_dataset` rows with no owning `filings` row (null filedDate/
   * firstSeenAt/sourceUrl), so an unparameterized public "feed" defaulting to
   * oldest-first served a wall of empty filing objects. `/api/transactions`
   * (src/delivery/rest.ts, the website) and `/feed.xml` are unaffected — they
   * either pass their own explicit `order` or accept this builder's ASC
   * default unchanged.
   */
  order?: 'asc' | 'desc';
  /**
   * Provenance filter. ABSENT / `primary` is the public default (#1453):
   * hide `seed_dataset` historic copies so the default feed is not
   * primary+seed duplicates. Pass `all` to include seed rows (admin / CSV
   * opt-in). Any other {@link TxSource} value is an exact match.
   */
  source?: TxSource | 'all';
}

export interface BuiltQuery {
  sql: string;
  params: Array<string | number>;
  limit: number;
  offset: number;
}

/** Default and hard-cap page sizes for the transactions endpoint. */
export const DEFAULT_TX_LIMIT = 100;
export const MAX_TX_LIMIT = 250;

/**
 * Cheap-index candidate window before twin-collapse (issue #2062 follow-up).
 * The published page still applies {@link TWIN_DEDUPE_SQL}, but only after
 * SQLite walks ORDER+LIMIT on the live filters. Putting NOT EXISTS in the
 * same WHERE as the driving LIMIT lets the planner evaluate the correlated
 * subquery against the full corpus before returning a row — the 20s+
 * zero-byte hang still seen on SHA c2b6757e after COUNT was fixed.
 */
export function twinCandidateLimit(limit: number, offset: number): number {
  const needed = Math.max(1, offset + limit);
  // Slack covers source-twins inside the cheap window so OFFSET still
  // lands on the requested unique page. Cap slack, never the needed
  // prefix — a hard cap of MAX_TX_LIMIT*8 would empty offset=2000
  // (the public pager ceiling).
  const slack = Math.min(MAX_TX_LIMIT * 8, Math.max(needed * 3, 32));
  return needed + slack;
}

/**
 * Historical freemium feed constants retained for compatibility. The public
 * transactions feed is not currently gated; Premium is enforced on CSV export
 * and UI enrichment workflows.
 */
export const FREE_WINDOW_DAYS = 30;
export const FREE_TX_LIMIT = 50;

/**
 * Shared FROM/JOIN clause for the transactions feed. Chamber + politician name are
 * resolved primarily through the `filers` table (joined on bioguide_id), which
 * is the authoritative source for the seed dataset — those rows have no owning
 * `filings` row, so a filings-only chamber join would silently drop them. We
 * also LEFT JOIN `filings` and COALESCE the chamber so live pipeline rows
 * (which DO have a filing) still resolve when the filer meta is missing.
 */
const TX_FROM_JOINS =
  'FROM transactions t ' +
  'LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id ' +
  'LEFT JOIN filings f ON f.doc_id = t.doc_id ' +
  'LEFT JOIN securities_ref sr ON sr.ticker = t.ticker ';

/**
 * Joins-lite FROM for the COUNT companions. No WHERE clause ever references
 * `securities_ref` (see buildTxFilters), so joining it into count/today
 * aggregates is a pure waste of Turso rows read on every non-incremental poll.
 * Filers/filings stay: member/chamber/filedSince filters resolve through them.
 */
const TX_FROM_JOINS_LITE =
  'FROM transactions t ' +
  'LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id ' +
  'LEFT JOIN filings f ON f.doc_id = t.doc_id ';

/** Cross-referenced asset fields (securities_ref) carried on each feed row. */
const REF_SELECT =
  'sr.company_name AS ref_company_name, ' +
  'sr.sector AS ref_sector, sr.market_cap AS ref_market_cap, ' +
  'sr.market_cap_bucket AS ref_market_cap_bucket, sr.country AS ref_country, ' +
  'sr.exchange_short AS ref_exchange_short, sr.asset_class AS ref_asset_class, ';

/** Price anchors plus one latency candidate.  Outer feed SELECT only. */
const FEED_ENRICH_SELECT =
  'txp.price_at_trade AS price_at_trade, txp.spx_at_trade AS spx_at_trade, ' +
  'txp.price_at_filing AS price_at_filing, txp.spx_at_filing AS spx_at_filing, ' +
  'tlc.provider AS latency_provider, tlc.provider_first_seen_at AS latency_observed_at, ' +
  'tlc.provider_published_at AS latency_provider_published_at, ' +
  'tlc.congress_first_seen_at AS latency_congress_first_seen_at, tlc.status AS latency_status ';

/**
 * Left joins after the page is already limited.  tx_performance is 1:1 on tx_id.
 * The latency join is one row: correlated LIMIT 1 on rowid, preferring status
 * `matched`, then the earliest provider_first_seen_at.  A miss leaves the
 * latency columns NULL and does not multiply feed rows.
 */
const FEED_ENRICH_JOINS =
  'LEFT JOIN tx_performance txp ON txp.tx_id = t.id ' +
  'LEFT JOIN trade_latency_candidates tlc ON tlc.rowid = (' +
  'SELECT c.rowid FROM trade_latency_candidates c ' +
  'WHERE c.doc_id = t.doc_id ' +
  "AND (c.ticker IS NULL OR c.ticker = '' OR UPPER(c.ticker) = UPPER(COALESCE(t.ticker, ''))) " +
  "AND (c.tx_date IS NULL OR c.tx_date = '' OR c.tx_date = t.tx_date) " +
  "AND (c.tx_type IS NULL OR c.tx_type = '' OR c.tx_type = t.tx_type) " +
  "ORDER BY CASE WHEN c.status = 'matched' THEN 0 ELSE 1 END, " +
  "CASE WHEN c.provider_first_seen_at IS NULL OR c.provider_first_seen_at = '' THEN 1 ELSE 0 END, " +
  'c.provider_first_seen_at, c.provider LIMIT 1) ';

/** SQL expression resolving the chamber, preferring the filers table. */
const CHAMBER_EXPR = 'COALESCE(fl.chamber, f.chamber)';

/**
 * Party bucketed to 'D' | 'R' | 'O' by first letter.  Total: anything that is
 * not D or R (Independent, minor parties, empty/NULL party, or a transaction
 * whose filer has no `filers` row) is 'O' ("Other / No party"), never NULL, so
 * the three buckets partition the feed and `party=D,R,O` equals no filter.
 * Mirrors PARTY_BUCKET_SQL in analytics/sql.ts — duplicated (not imported) so
 * this module stays dependency-free/independently testable, matching this
 * file's existing convention of each surface owning its own filter SQL.  The
 * two strings are asserted identical in analytics/__tests__/partyPartition.test.ts.
 */
export const PARTY_BUCKET_SQL_LOCAL =
  "(CASE WHEN UPPER(SUBSTR(TRIM(COALESCE(fl.party, '')), 1, 1)) = 'D' THEN 'D' " +
  "WHEN UPPER(SUBSTR(TRIM(COALESCE(fl.party, '')), 1, 1)) = 'R' THEN 'R' " +
  "ELSE 'O' END)";

/**
 * Canonical instrument-category expression over the transaction row itself
 * (`asset_type` House bracket code, `asset_type_name` label, `is_option`) —
 * literally the same generator the Trends analytics builders use
 * (`canonicalAssetTypeCategorySql`, see analytics/builders.ts), so an
 * asset-class selection buckets a row identically on the Trades feed and on
 * Trends. Built once at module load: the CASE is large (one branch per House
 * code + label alias) but entirely static.
 *
 * Only `transactions` columns are referenced, so this filter is safe inside
 * the nested keyset subquery (see {@link canNestTransactionKeyset}) — no join
 * has to run before the LIMIT.
 *
 * Known edge, honestly stated: the TypeScript {@link canonicalizeAssetType}
 * ALSO infers a code from the asset name when `asset_type` is blank
 * ("… Common Stock" -> ST). The SQL form has no such inference, so the rare
 * row with an empty `asset_type`/`asset_type_name` buckets as `unknown` for
 * filtering even though the row it renders shows an inferred category. That
 * gap is in the shared generator, not here; it is narrow (blank type AND
 * blank type name) and identical to what the Trends tabs already do.
 */
const ASSET_TYPE_CATEGORY_SQL = canonicalAssetTypeCategorySql(
  't.asset_type',
  't.asset_type_name',
  't.is_option',
);

/**
 * Named instrument-class groups for the public `?assetClass=` filter, so a
 * client ships a stable slug instead of hard-coding the taxonomy. Owner ask
 * (2026-08-11): the Trades dropdown offers "All" and "Public Equities, Funds,
 * & ETFs" — the latter is `public_equity` (ST: stocks incl. ADRs) plus `fund`,
 * which is where the taxonomy already puts every pooled wrapper a reader lumps
 * in with stocks (EF = ETF, MF = mutual fund, ET = exchange-traded note,
 * MA = managed account). Raw category slugs still work, so a future dropdown
 * option needs no server change.
 */
export const ASSET_CLASS_GROUPS: Record<string, AssetTypeCategory[]> = {
  equities_funds: ['fund', 'public_equity'],
};

/**
 * Parse `?assetClass=` into a category list. Accepts a group slug
 * (`equities_funds`), raw `AssetTypeCategory` slugs, or a CSV mixing both;
 * separators in a slug are normalized (`equities-funds`, `equities funds`).
 *
 * Returns `undefined` — meaning NO filter — for absent/empty input, for the
 * explicit `all` sentinel (the dropdown's default option), and for input that
 * matches nothing, which is the same lenient fallback every other filter
 * parser in this module uses (`asChambers`, `asTxTypes`, `asPartyBuckets`).
 */
export function asAssetCategories(v: string | null | undefined): AssetTypeCategory[] | undefined {
  if (!v || !v.trim()) return undefined;
  const out = new Set<AssetTypeCategory>();
  for (const part of v.toLowerCase().split(',')) {
    const key = part.trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!key || key === 'all') continue;
    const group = ASSET_CLASS_GROUPS[key];
    if (group) {
      for (const category of group) out.add(category);
      continue;
    }
    if (isAssetTypeCategory(key)) out.add(key);
  }
  return out.size ? Array.from(out).sort() : undefined;
}

/** O(1) indexed MAX query over transactions.cursor_seq */
export async function readCursorHighWater(env: Env): Promise<number> {
  const row = await first<{ hwm: number | null }>(env.DB, 'SELECT MAX(cursor_seq) AS hwm FROM transactions', []);
  return Number(row?.hwm ?? 0);
}

export interface TxFilterOptions {
  /**
   * When true (default), collapse source-twins so one real-world trade
   * publishes once. Unbounded COUNT / today-filings must pass false: the
   * correlated NOT EXISTS is O(live rows) index seeks and was the 2026-08-19
   * first-page hang (issue #2062). Published page / CSV / client summaries
   * keep the guard.
   */
  twinDedupe?: boolean;
}

/**
 * Build the shared WHERE clauses + bound params for the transactions feed.
 * `includeCursor` controls whether the `cursor_seq > since` backstop clause is
 * added — the count query omits it so it reports ALL rows matching the
 * ticker/member/type/chamber filters (independent of paging position).
 */
export function buildTxFilters(
  p: TxQueryParams,
  includeCursor: boolean,
  opts: TxFilterOptions = {},
): { where: string[]; params: Array<string | number> } {
  const where: string[] = [];
  const params: Array<string | number> = [];

  // Retracted (un-published) rows are never served on the feed.
  where.push('t.deprecated_at IS NULL');
  // Synthetic provider-discovered placeholder rows without an official filing stay off the main feed.
  where.push("SUBSTR(t.doc_id, 1, 17) != 'provider-missing-'");
  where.push('t.filer_id IS NOT NULL');
  // Competitor-only executive injects (COMPETITOR-* doc ids on EXEC-* filers)
  // have no OGE PDF / hosted filing. Keep them in the DB for coverage forensics,
  // but do not present them as first-class feed rows until a real E- filing exists.
  where.push(
    "NOT (t.source = 'competitor_backfill' AND t.filer_id LIKE 'EXEC-%' AND t.doc_id LIKE 'COMPETITOR%')",
  );
  if (opts.twinDedupe !== false) {
    where.push(TWIN_DEDUPE_SQL);
  }
  // Public default (#1453): hide historic seed copies so the default view is
  // not primary+seed duplicates. Literal (no bound param) so existing param
  // order stays stable. `source=all` opts back in; any other TxSource is exact.
  if (!p.source || p.source === 'primary') {
    where.push("t.source <> 'seed_dataset'");
  }

  if (includeCursor) {
    const since = Number.isFinite(p.since) ? Number(p.since) : 0;
    where.push('t.cursor_seq > ?');
    params.push(since);
  }

  if (p.source && p.source !== 'all' && p.source !== 'primary') {
    where.push('t.source = ?');
    params.push(p.source);
  }

  if (p.ticker) {
    where.push('t.ticker = ?');
    params.push(p.ticker.toUpperCase());
  }
  if (p.member) {
    where.push('t.filer_id = ?');
    params.push(p.member);
  }
  if (p.memberName) {
    where.push(
      '(LOWER(COALESCE(fl.full_name, t.filer_id, \'\')) LIKE ? ESCAPE \'\\\'' +
        ' OR LOWER(COALESCE(fl.display_name, \'\')) LIKE ? ESCAPE \'\\\')',
    );
    const likeTerm = `%${escapeLikePattern(p.memberName.toLowerCase())}%`;
    params.push(likeTerm, likeTerm);
  }
  const typeList = (p.types && p.types.length ? p.types : (p.type ? [p.type] : [])) as TxType[];
  if (typeList.length === 1 && typeList[0] !== 'B') {
    // Single non-buy type: keep the historic `=` form (tests + query plans).
    where.push('t.tx_type = ?');
    params.push(typeList[0]);
  } else if (typeList.length) {
    // Multi-select or Buy: B dual-reads legacy P until migrate lands.
    const expanded = new Set<string>();
    for (const t of typeList) {
      if (t === 'B') {
        expanded.add('B');
        expanded.add('P');
      } else {
        expanded.add(t);
      }
    }
    const vals = Array.from(expanded);
    where.push(`t.tx_type IN (${vals.map(() => '?').join(', ')})`);
    params.push(...vals);
  }
  if (p.stockAct) {
    where.push('t.stock_act_status = ?');
    params.push(p.stockAct);
  }
  if (p.owner) {
    where.push('t.owner = ?');
    params.push(p.owner);
  }
  if (p.chambers && p.chambers.length) {
    where.push(`${CHAMBER_EXPR} IN (${p.chambers.map(() => '?').join(', ')})`);
    params.push(...p.chambers);
  } else if (p.chamber) {
    where.push(`${CHAMBER_EXPR} = ?`);
    params.push(p.chamber);
  } else {
    // Default view = all chambers. Executive rows are no longer excluded by default.
  }
  if (p.partyBuckets && p.partyBuckets.length) {
    where.push(`${PARTY_BUCKET_SQL_LOCAL} IN (${p.partyBuckets.map(() => '?').join(', ')})`);
    params.push(...p.partyBuckets);
  }
  if (Number.isFinite(p.minAmount)) {
    where.push('t.amount_min >= ?');
    params.push(Number(p.minAmount));
  }
  if (Number.isFinite(p.maxAmount)) {
    where.push('t.amount_min <= ?');
    params.push(Number(p.maxAmount));
  }
  if (p.filedSince) {
    // Prefer the filing date; seed rows without a filing fall back to tx_date.
    where.push('COALESCE(f.filed_date, t.tx_date) >= ?');
    params.push(p.filedSince);
  }
  // Rolling-window bounds on the trade date itself. A row with a null tx_date
  // can't satisfy a date comparison, so it's naturally excluded once a bound is
  // set (the comparison is NULL -> not true), which is the intended behavior.
  if (p.txDateMin) {
    where.push('t.tx_date >= ?');
    params.push(p.txDateMin.slice(0, 10));
  }
  if (p.txDateMax) {
    where.push('t.tx_date <= ?');
    params.push(p.txDateMax.slice(0, 10));
  }
  // Appended last on purpose: bound-parameter order is positional, so keeping
  // this clause at the tail leaves every existing caller's param sequence
  // untouched.
  if (p.assetCategories && p.assetCategories.length) {
    where.push(`${ASSET_TYPE_CATEGORY_SQL} IN (${p.assetCategories.map(() => '?').join(', ')})`);
    params.push(...p.assetCategories);
  }

  return { where, params };
}

/**
 * Newest-first snapshot order for `order=desc` when the caller did not pick
 * `sort=cursor` / `sort=tx_date` / `sort=published`.  Uses columns that live
 * on `transactions` so {@link canNestTransactionKeyset} stays true (no
 * filings join before LIMIT).  A 2024 backfill with a high ingest cursor
 * cannot outrank a later-seen 2026 row (#2180).
 */
export const NEWEST_SNAPSHOT_ORDER_SQL =
  'COALESCE(t.first_seen_at, t.filed_date, t.tx_date, t.cursor_seq)';

/**
 * True when the feed WHERE/ORDER only touch `transactions` columns (plus the
 * always-on deprecated_at filter). In that case we can keyset+LIMIT first and
 * join filers/filings/securities_ref afterwards — Turso was reading ~20k+ rows
 * per LIMIT 50 poll when the joins ran before the limit.
 */
function canNestTransactionKeyset(p: TxQueryParams): boolean {
  if (p.memberName) return false;
  if (p.chamber) return false;
  if (p.chambers && p.chambers.length) return false;
  if (p.partyBuckets && p.partyBuckets.length) return false;
  if (p.filedSince) return false;
  if (p.sort === 'published') return false;
  // `assetCategories` is deliberately absent from this bail-out list: its SQL
  // reads only `transactions` columns (see ASSET_TYPE_CATEGORY_SQL), so the
  // instrument-class filter stays inside the nested keyset and still narrows
  // before the LIMIT.
  return true;
}

/**
 * Build the parameterized SQL for `GET /transactions`. Orders by cursor_seq
 * ASC by default (so callers can use the max returned cursor to page forward),
 * or by {@link NEWEST_SNAPSHOT_ORDER_SQL} DESC when `order: 'desc'` with no
 * explicit sort (a newest-first snapshot that is not ingest-cursor order).
 * Always returns only rows with cursor_seq > since (the reconciliation backstop).
 *
 * `chamber` is resolved via the `filers` table (authoritative for seed data),
 * falling back to the owning filing's chamber. The politician's full name and
 * resolved chamber are SELECTed alongside `t.*` as `__member_name`/`__chamber`
 * so the REST handler can attach them without changing the Transaction type.
 *
 * Pure + deterministic so it can be unit-tested without a DB.
 */
export function buildTransactionsQuery(p: TxQueryParams): BuiltQuery {
  const { where, params } = buildTxFilters(p, true, { twinDedupe: false });

  // LIMIT/OFFSET are interpolated directly into the SQL text below (D1/SQLite
  // has no bound-parameter form for them), so a fractional value here isn't
  // just cosmetic — it can produce invalid SQL (e.g. `LIMIT 50.5`) and a 500.
  // Floor BEFORE the <=0/>MAX clamp so e.g. `?limit=0.5` clamps to the
  // default instead of slipping through as a truthy-but-fractional 0.5.
  let limit = Number.isFinite(p.limit) ? Math.floor(Number(p.limit)) : DEFAULT_TX_LIMIT;
  if (limit <= 0) limit = DEFAULT_TX_LIMIT;
  if (limit > MAX_TX_LIMIT) limit = MAX_TX_LIMIT;
  let offset = Number.isFinite(p.offset) ? Math.floor(Number(p.offset)) : 0;
  if (offset < 0) offset = 0;

  // Closed enum -> only the literal 'ASC'/'DESC' is interpolated, never caller
  // text. ASC stays the default to keep the forward-cursor paging contract.
  // DESC without an explicit sort is a "latest trades" snapshot: order by
  // when we learned / when it was filed / the trade date, not ingest cursor.
  // `sort=cursor` keeps the old ingest-newest behavior for callers that want it.
  const direction = p.order === 'desc' ? 'DESC' : 'ASC';
  const orderExpr =
    p.sort === 'published'
      ? 'COALESCE(f.first_seen_at, f.filed_date, t.created_at, t.cursor_seq)'
      : p.sort === 'tx_date'
        ? 't.tx_date'
        : p.sort === 'cursor'
          ? 't.cursor_seq'
          : p.order === 'desc'
            ? NEWEST_SNAPSHOT_ORDER_SQL
            : 't.cursor_seq';
  const orderClause =
    orderExpr === 't.cursor_seq'
      ? `t.cursor_seq ${direction}`
      : `${orderExpr} ${direction}, t.cursor_seq ${direction}`;

  const selectList =
    `SELECT t.*, ${CHAMBER_EXPR} AS __chamber, COALESCE(fl.display_name, fl.full_name) AS __member_name, fl.party AS __party, fl.party AS filer_party, ` +
    'COALESCE(fl.display_name, fl.full_name) AS filer_full_name, fl.state AS filer_state, ' +
    'fl.photo_url AS filer_photo_url, fl.resolved_bioguide_id AS filer_bioguide_id, ' +
    REF_SELECT +
    'f.filed_date AS filing_filed_date, f.first_seen_at AS filing_first_seen_at, f.source_url AS filing_source_url, f.raw_object_key AS filing_raw_object_key, ' +
    FEED_ENRICH_SELECT;

  const pageLimitClause =
    `LIMIT ${limit}` + (offset > 0 ? ` OFFSET ${offset}` : '');
  const candidateLimit = twinCandidateLimit(limit, offset);
  const cheapWhere = where.join(' AND ');

  // Walk the cheap live filters to a bounded candidate page FIRST, then
  // collapse source-twins. NOT EXISTS still reads the full table for each
  // candidate (correct Fleischmann semantics) but only for this window —
  // not for every live row before LIMIT, and not dependent on idx_tx_twin_seek
  // existing (Coolify auto-deploy never runs POST /api/admin/migrate).
  if (canNestTransactionKeyset(p)) {
    const sql =
      selectList +
      'FROM (' +
      'SELECT t.* FROM (' +
      'SELECT t.* FROM transactions t ' +
      `WHERE ${cheapWhere} ` +
      `ORDER BY ${orderClause} ` +
      `LIMIT ${candidateLimit}` +
      ') t ' +
      `WHERE ${TWIN_DEDUPE_SQL} ` +
      `ORDER BY ${orderClause} ` +
      pageLimitClause +
      ') t ' +
      'LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id ' +
      'LEFT JOIN filings f ON f.doc_id = t.doc_id ' +
      'LEFT JOIN securities_ref sr ON sr.ticker = t.ticker ' +
      FEED_ENRICH_JOINS;
    return { sql, params, limit, offset };
  }

  const sql =
    selectList +
    'FROM (' +
    'SELECT t.* ' +
    TX_FROM_JOINS_LITE +
    `WHERE ${cheapWhere} ` +
    `ORDER BY ${orderClause} ` +
    `LIMIT ${candidateLimit}` +
    ') t ' +
    'LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id ' +
    'LEFT JOIN filings f ON f.doc_id = t.doc_id ' +
    'LEFT JOIN securities_ref sr ON sr.ticker = t.ticker ' +
    FEED_ENRICH_JOINS +
    `WHERE ${TWIN_DEDUPE_SQL} ` +
    `ORDER BY ${orderClause} ` +
    pageLimitClause;

  return { sql, params, limit, offset };
}

/**
 * Build the COUNT(*) companion query for `GET /transactions`. Uses the SAME
 * ticker/member/type/chamber filters as {@link buildTransactionsQuery} but
 * deliberately drops the cursor backstop so the total reflects every matching
 * row, not just the unseen tail. Returned as `total` in the API response.
 *
 * Twin-dedupe stays off this unbounded COUNT (issue #2062). `total` is the
 * live-row count before source-twin collapse; the page itself still publishes
 * one row per real-world trade.
 */
export function buildTransactionsCountQuery(
  p: TxQueryParams,
): { sql: string; params: Array<string | number> } {
  const { where, params } = buildTxFilters(p, false, { twinDedupe: false });
  const sql =
    'SELECT COUNT(*) AS total ' +
    TX_FROM_JOINS_LITE +
    (where.length ? `WHERE ${where.join(' AND ')}` : '');
  return { sql, params };
}

/** Count distinct filings first imported today for the same feed filters. */
export function buildTransactionsTodayFilingsQuery(
  p: TxQueryParams,
  todayIso: string,
): { sql: string; params: Array<string | number> } {
  const { where, params } = buildTxFilters(p, false, { twinDedupe: false });
  const allWhere = [...where, 'substr(COALESCE(f.first_seen_at, t.created_at), 1, 10) = ?'];
  const sql =
    'SELECT COUNT(DISTINCT t.doc_id) AS total ' +
    TX_FROM_JOINS_LITE +
    `WHERE ${allWhere.join(' AND ')}`;
  return { sql, params: [...params, todayIso.slice(0, 10)] };
}

/**
 * @deprecated Product policy (2026-08-06): Premium CSV export is the full
 * match set — no row cap. Free users get no CSV. Cost control is Premium
 * auth + per-IP rate limit, not incomplete files. Kept as a named constant
 * only so older tests/call sites that pass an explicit test limit still
 * compile; production export does not apply this as a default.
 */
export const MAX_EXPORT_ROWS = Number.MAX_SAFE_INTEGER;

/**
 * Build the query backing the CSV export. Unlike the paged feed it drops the
 * cursor backstop and returns the full matching set (newest-first). Same
 * ticker/member/type/chamber filters as the feed.
 *
 * Optional `maxRows` is for tests / rare operator tooling only — omit it for
 * production Premium export so the file is complete.
 */
export function buildTransactionsExportQuery(
  p: TxQueryParams,
  maxRows?: number | null,
): BuiltQuery {
  const { where, params } = buildTxFilters(p, false);
  const hasLimit =
    maxRows != null && Number.isFinite(maxRows) && Math.floor(Number(maxRows)) > 0;
  const limit = hasLimit ? Math.floor(Number(maxRows)) : Number.MAX_SAFE_INTEGER;
  const sql =
    `SELECT t.*, ${CHAMBER_EXPR} AS __chamber, COALESCE(fl.display_name, fl.full_name) AS __member_name, fl.party AS __party, ` +
    'COALESCE(fl.display_name, fl.full_name) AS filer_full_name, fl.state AS filer_state, ' +
    'fl.photo_url AS filer_photo_url, fl.resolved_bioguide_id AS filer_bioguide_id, ' +
    REF_SELECT +
    'f.filed_date AS filing_filed_date, f.first_seen_at AS filing_first_seen_at, f.source_url AS filing_source_url ' +
    TX_FROM_JOINS +
    (where.length ? `WHERE ${where.join(' AND ')} ` : '') +
    `ORDER BY ${NEWEST_SNAPSHOT_ORDER_SQL} DESC, t.cursor_seq DESC` +
    (hasLimit ? ` LIMIT ${limit}` : '');
  return { sql, params, limit, offset: 0 };
}
