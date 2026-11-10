import type { Chamber, TxType, DeliveryChannel, SubscriptionFilters, Subscription, ClientTrade, User } from '../shared/types.ts';
import { normalizeTickerLogoSymbol } from '../ui/tickerLogos.ts';
import { asAssetCategories, asTxSource, mapFeedTransaction } from '../delivery/rows.ts';
import type { TxQueryParams } from '../delivery/rows.ts';
import type { ClientTradeRow, TradeSummaryRow, SecurityRefRow, MemberProfileRow } from './types.ts';
import { parseCommitteeNames } from '../shared/committeeNames.ts';
import type { Context } from 'hono';
import type { Env } from '../shared/types.ts';
import { getCurrentUserFromRequest } from '../auth/session.ts';
import {
  validateAndResolveSubscriptionFilters,
  type SubscriptionMemberInfo,
} from '../delivery/subscriptions.ts';
import { cleanFilerName } from '../extraction/nameNormalizer.ts';
import { executiveTitleFor } from '../shared/executiveTitles.ts';
import { memberPhotoUrl, normalizeMemberPhotoKey } from '../enrichment/memberPhotoPack.ts';

export type ClientContext = Context<{ Bindings: Env }>;

export class ClientInputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export type ClientErrorStatus = 400 | 401 | 402 | 404 | 409 | 429 | 500 | 501;

export function errorStatus(err: ClientInputError): ClientErrorStatus {
  if (err.status === 401 || err.status === 402 || err.status === 404 || err.status === 409 || err.status === 429 || err.status === 501) {
    return err.status;
  }
  if (err.status === 400) return 400;
  return 500;
}

export async function readJson(c: ClientContext): Promise<Record<string, unknown>> {
  try {
    const raw = await c.req.text();
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    throw new ClientInputError('invalid JSON body');
  }
}

export async function requireUser(c: ClientContext): Promise<User> {
  const user = await getCurrentUserFromRequest(c);
  if (!user) throw new ClientInputError('sign in required', 401);
  return user;
}

export function clientIdForUser(user: User): string {
  return `user:${user.id}`;
}

export function parseIntOrUndef(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function asChamber(v: string | undefined): Chamber | undefined {
  return v === 'house' || v === 'senate' || v === 'executive' ? v : undefined;
}

/**
 * Parse a CSV chamber selection (e.g. "house,executive"). Returns undefined
 * for absent/empty/fully-invalid input — the DEFAULT, which the feed queries
 * treat as house+senate (executive rows require explicit opt-in).
 */
export function asChambers(v: string | undefined): Chamber[] | undefined {
  if (!v || !v.trim()) return undefined;
  const parsed = Array.from(
    new Set(v.split(',').map((part) => asChamber(part.trim())).filter((c): c is Chamber => !!c)),
  ).sort();
  return parsed.length ? parsed : undefined;
}

export function asTxType(v: string | undefined): TxType | undefined {
  // Canonical storage is B|S|E; legacy form letter P (Purchase) → Buy.
  if (v === 'P' || v === 'p' || v === 'B' || v === 'b') return 'B';
  return v === 'S' || v === 'E' ? v : undefined;
}

/** CSV multi-type selection (e.g. "B,S"); undefined = no type filter. */
export function asTxTypes(v: string | undefined): TxType[] | undefined {
  if (!v || !v.trim()) return undefined;
  const parsed = Array.from(
    new Set(v.split(',').map((part) => asTxType(part.trim())).filter((t): t is TxType => !!t)),
  ).sort();
  return parsed.length ? parsed : undefined;
}

function asPartyBucket(v: string): 'D' | 'R' | 'O' | undefined {
  const c = v.trim().charAt(0).toUpperCase();
  return c === 'D' ? 'D' : c === 'R' ? 'R' : c === 'O' || c === 'I' ? 'O' : undefined;
}

/** CSV multi-party-bucket selection (e.g. "D,R"); undefined = no party filter. */
export function asPartyBuckets(v: string | undefined): Array<'D' | 'R' | 'O'> | undefined {
  if (!v || !v.trim()) return undefined;
  const parsed = Array.from(
    new Set(
      v
        .split(',')
        .map((part) => asPartyBucket(part))
        .filter((c): c is 'D' | 'R' | 'O' => !!c),
    ),
  ).sort();
  return parsed.length ? parsed : undefined;
}

export function asOrder(v: string | undefined): 'asc' | 'desc' | undefined {
  return v === 'desc' ? 'desc' : v === 'asc' ? 'asc' : undefined;
}

export function asSort(v: string | undefined): TxQueryParams['sort'] {
  // 'tx_date' was already a valid backend sort key (see `TxQueryParams.sort`
  // in delivery/rows.ts and /transactions' own `asTxSort`) but was missing
  // from this client-facing parser, so `GET /api/client/v1/feed?sort=tx_date`
  // silently fell back to cursor order. iOS sends `sort=tx_date` for its
  // Date sort control (owner punch list #2, item 7) — parse it here too.
  return v === 'published' ? 'published' : v === 'cursor' ? 'cursor' : v === 'tx_date' ? 'tx_date' : undefined;
}

export function asNonNegativeNumber(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function asDelivery(v: unknown): DeliveryChannel {
  if (v === 'sse' || v === undefined || v === null || v === '') return 'sse';
  if (v === 'webhook') return 'webhook';
  throw new ClientInputError("delivery must be 'sse' or 'webhook'");
}

export function arrayOfStrings(value: unknown, opts: { upper?: boolean } = {}): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ClientInputError('filters arrays must contain strings');
  const out = value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (opts.upper ? v.toUpperCase() : v));
  return Array.from(new Set(out));
}

/**
 * Validate a subscription filter set for create/update_subscription.  Member
 * names are resolved to filer ids here (a name that matches no one, or several
 * people, is a 400 that lists it) so a saved subscription can actually match.
 */
export async function normalizeFilters(env: Env, value: unknown): Promise<SubscriptionFilters> {
  const result = await validateAndResolveSubscriptionFilters(env, value);
  if (!result.ok) throw new ClientInputError(result.error);
  return result.filters;
}

export function publicSubscription(
  sub: Subscription,
  includeSecret = false,
  members?: SubscriptionMemberInfo,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: sub.id,
    delivery: sub.delivery,
    targetUrl: sub.targetUrl,
    filters: sub.filters,
    cursor: sub.cursor,
    active: sub.active,
    createdAt: sub.createdAt,
    hasSecret: Boolean(sub.secret),
  };
  if (members) {
    // Names for the stored filer ids, and entries that can never match (free-text
    // names saved before member resolution existed) so the owner can fix them.
    out.memberLabels = members.memberLabels;
    if (members.unresolvedMembers.length > 0) out.unresolvedMembers = members.unresolvedMembers;
  }
  if (includeSecret && sub.secret) {
    out.secret = sub.secret;
    if (sub.delivery === 'sse') {
      out.streamUrl = `/api/stream?subscription=${encodeURIComponent(sub.id)}&token=${encodeURIComponent(sub.secret)}`;
    }
  }
  return out;
}

export function filtersFromQuery(q: Record<string, string>): TxQueryParams {
  const types = asTxTypes(q.type);
  return {
    since: parseIntOrUndef(q.since),
    ticker: q.ticker || undefined,
    member: q.member || undefined,
    memberName: q.memberName || undefined,
    chambers: asChambers(q.chamber),
    // Multi-select `?type=B,S` when present; single-value still works via types[0]
    // path inside the query builder.
    type: types?.length === 1 ? types[0] : asTxType(q.type),
    types: types && types.length > 1 ? types : undefined,
    partyBuckets: asPartyBuckets(q.party),
    // Instrument-class dropdown ("All" / "Public Equities, Funds, & ETFs").
    // Parsed and applied SERVER-side (see TxQueryParams.assetCategories) so
    // the narrowed `total` is the real match count, not a recount of one
    // already-fetched page. `assetCategory` is accepted as an alias.
    assetCategories: asAssetCategories(q.assetClass ?? q.assetCategory),
    minAmount: asNonNegativeNumber(q.minAmount),
    maxAmount: asNonNegativeNumber(q.maxAmount),
    txDateMin: q.from || q.txDateMin || undefined,
    txDateMax: q.to || q.txDateMax || undefined,
    sort: asSort(q.sort),
    order: asOrder(q.order),
    limit: parseIntOrUndef(q.limit),
    // Offset-paged snapshot reads (iOS "Page X of Y", owner punch list #2 item
    // 8). Mirrors `/api/transactions`' own `offset=` param; guarded by the
    // same `MAX_PUBLIC_TX_OFFSET` depth cap in the `/feed` route below.
    offset: parseIntOrUndef(q.offset),
    source: asTxSource(q.source),
  };
}

export function clientLogoUrl(ticker: string | null): string | null {
  const symbol = normalizeTickerLogoSymbol(ticker);
  return symbol ? `/api/logos/ticker?symbol=${encodeURIComponent(symbol)}` : null;
}

export function clientTradeFromRow(row: ClientTradeRow): ClientTrade {
  const tx = mapFeedTransaction(row);
  const transaction = {
    date: tx.txDate,
    type: tx.txType,
    owner: tx.owner,
    amountMin: tx.amountMin,
    amountMax: tx.amountMax,
    estValue: row.est_value ?? null,
    isOption: tx.isOption,
  };
  return {
    id: tx.id,
    cursor: tx.cursorSeq,
    docId: tx.docId,
    member: {
      id: tx.filerId,
      name: tx.fullName ?? row.__member_name ?? null,
      chamber: (row.__chamber as Chamber | null) ?? null,
      party: row.__party ?? null,
      state: tx.state ?? null,
      photoUrl: tx.photoUrl ?? null,
    },
    asset: {
      name: tx.refCompanyName || tx.assetName,
      ticker: tx.ticker,
      // `type` stays the RAW disclosure value (House bracket code / Senate
      // label) — provenance, unchanged. The canonical cross-chamber rollup
      // rides alongside it: `typeCategory` is the machine slug a client
      // filters on, `typeCategoryLabel` the display string. Both were already
      // computed by mapTransaction and already declared on ClientAssetSchema
      // (and documented in docs/client-mobile-api.md) but were dropped here,
      // so no client could tell a stock from a municipal bond.
      type: tx.assetType,
      typeName: tx.assetTypeName ?? null,
      typeCategory: tx.assetTypeCategory ?? null,
      typeCategoryLabel: tx.assetTypeCategoryLabel ?? null,
      sector: tx.refSector ?? null,
      marketCapBucket: tx.refMarketCapBucket ?? null,
      // Same already-documented-but-dropped gap: the canonical company name
      // and the same-origin logo proxy path the web client renders. Both are
      // optional on the schema, so older decoders are unaffected.
      companyName: tx.refCompanyName ?? null,
      logoUrl: clientLogoUrl(tx.ticker),
    },
    transaction,
    filing: {
      filedDate: tx.filedDate ?? null,
      firstSeenAt: tx.firstSeenAt ?? null,
      sourceUrl: tx.sourceUrl ?? null,
    },
    confidence: tx.confidence,
    source: (tx.source === 'manual' ? 'primary' : tx.source) as "primary" | "seed_dataset",
  };
}

export function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function nullableNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value.length ? value : null;
}

export function usd(value: unknown): number {
  return Math.round(num(value));
}

export function detailLimit(value: string | undefined, fallback = 25): number {
  const n = parseIntOrUndef(value);
  if (!n || n <= 0) return fallback;
  return Math.min(n, 100);
}

export function baseSummary(row: TradeSummaryRow | null) {
  return {
    totalTrades: num(row?.total_trades),
    buyCount: num(row?.buy_count),
    sellCount: num(row?.sell_count),
    exchangeCount: num(row?.exchange_count),
    estimatedVolumeUsd: usd(row?.est_volume),
    estimatedNetFlowUsd: usd(row?.est_net_flow),
    firstTrade: str(row?.first_trade),
    lastTrade: str(row?.last_trade),
  };
}

export function securityRef(ticker: string, row: SecurityRefRow | null) {
  return {
    ticker,
    companyName: row?.company_name ?? null,
    logoUrl: clientLogoUrl(ticker),
    sector: row?.sector ?? null,
    industry: row?.industry ?? null,
    assetClass: row?.asset_class ?? null,
    country: row?.country ?? null,
    exchangeShort: row?.exchange_short ?? null,
    currency: row?.currency ?? null,
    marketCap: nullableNum(row?.market_cap),
    marketCapBucket: row?.market_cap_bucket ?? null,
    currentPrice: nullableNum(row?.current_price),
    currentPriceDate: row?.current_price_date ?? null,
  };
}

const BIOGUIDE_KEY = /^[A-Za-z]\d{6}$/;

/** Prefer the stored pack URL; if a row has a bioguide but no photo_url, still
 *  hand the client a same-origin `/api/photos/member` URL so iOS AsyncImage
 *  can load the face instead of falling through to a party-emoji tile. */
export function profilePhotoUrl(row: MemberProfileRow): string | null {
  const stored = str(row.photo_url);
  if (stored) return stored;
  const key =
    normalizeMemberPhotoKey(row.resolved_bioguide_id) ??
    (BIOGUIDE_KEY.test(row.bioguide_id) ? row.bioguide_id : null);
  return key ? memberPhotoUrl(key, 'https://congress.trade') : null;
}

export function memberProfile(row: MemberProfileRow | null, id: string) {
  if (!row) {
    return {
      id,
      name: null,
      chamber: null,
      party: null,
      state: null,
      district: null,
      committees: [],
      photoUrl: null,
      title: executiveTitleFor(id),
    };
  }
  const committees = parseCommitteeNames(row.committees);
  return {
    id: row.bioguide_id,
    // Every other server surface runs `filers.full_name` through
    // cleanFilerName before shipping it to a client — this one previously
    // didn't, so the iOS member-detail screen could show a raw DB string
    // (e.g. a bare `MANUAL-KHANNA`-style value) verbatim (scout report
    // scout2-name-surfaces-exec.md §1, client/utils.ts:313).
    name: row.full_name ? (cleanFilerName(row.full_name) || row.full_name) : null,
    chamber: asChamber(row.chamber ?? undefined) ?? null,
    party: row.party,
    state: row.state,
    district: row.district,
    committees: Array.isArray(committees) ? committees : [],
    photoUrl: profilePhotoUrl(row),
    // Curated agency/position label for executive-branch filers (see
    // shared/executiveTitles.ts); null for House/Senate filers.
    title: executiveTitleFor(row.bioguide_id, row.chamber),
  };
}
