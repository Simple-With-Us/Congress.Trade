/**
 * src/analytics/sql.ts
 * OWNER: analytics
 *
 * Shared, dependency-free SQL fragments + filter builders for the analytics
 * layer (the `/api/analytics/*` endpoints). Every aggregation query is built
 * from these pieces so the bracket-midpoint convention, the party/chamber
 * resolution, and the common window/source/confidence filters are applied
 * IDENTICALLY everywhere — and so each builder stays a pure function that can be
 * unit-tested without a database (mirrors src/delivery/rows.ts).
 *
 * Conventions baked into the fragments below:
 *   - transactions are aliased `t`, filers `fl`, filings `f`, securities `sm`.
 *   - Disclosed amounts are STOCK Act *brackets*, never exact: every dollar
 *     metric uses the bracket MIDPOINT ({@link BRACKET_MIDPOINT_SQL}). The
 *     open-ended top tier ($50,000,001+) has amount_max IS NULL and falls back
 *     to the bracket floor (amount_min). All $ figures are therefore ESTIMATES.
 *   - party is frequently empty in the data (seed filers store party='',
 *     executive-branch and manual filers have none), so it is bucketed into
 *     D / R / O by first letter: D and R are matched, and EVERYTHING else
 *     (Independent, minor parties, and no party on file) is 'O' — labelled
 *     "Other / No party" in the UI.  The bucket is total (never NULL), so a
 *     party filter always partitions the data: All == D + R + O.  Row-level
 *     `partyBucket` fields in API responses are separate and still `null` when
 *     no party is on file.
 */

import { WINDOW_PRESETS as SHARED_WINDOW_PRESETS } from '@jaywedgeworth22/congress-trading-shared';
import type { Chamber, TxType } from '../shared/types.ts';
import type { SqlParam } from '../shared/db.ts';
import {
  fabricatedCompetitorAmountSql,
  TWIN_DEDUPE_SQL,
} from '../shared/tradeIdentity.ts';

// ---------------------------------------------------------------------------
// Enumerations + validators (closed sets → safe to interpolate as literals)
// ---------------------------------------------------------------------------

/**
 * A window is either 'all', `<N>d` (N whole days, e.g. '90d'), or a calendar-year
 * preset (`this_cy` / `last_cy`). Any positive `<N>d` is also valid.
 */
export const WINDOW_PRESETS = SHARED_WINDOW_PRESETS;
export type Window = string; // always produced via asWindow()
const WINDOW_RE = /^(\d{1,5})d$/;
const MAX_WINDOW_DAYS = 36500; // ~100y guardrail against absurd inputs
const CALENDAR_WINDOWS = new Set(['this_cy', 'last_cy']);

export function isWindow(v: unknown): v is Window {
  if (v === 'all') return true;
  if (typeof v !== 'string') return false;
  if (CALENDAR_WINDOWS.has(v)) return true;
  const m = WINDOW_RE.exec(v);
  if (!m) return false;
  const n = Number(m[1]);
  return n >= 1 && n <= MAX_WINDOW_DAYS;
}
/** Coerce arbitrary input to a valid Window, falling back to `fallback`. */
export function asWindow(v: unknown, fallback: Window = '90d'): Window {
  return isWindow(v) ? (v as Window) : fallback;
}
/** Number of days a window spans, or null for 'all'. Defaults to 30 on garbage. */
export function windowDays(w: Window): number | null {
  if (w === 'all') return null;
  if (w === 'this_cy') {
    const now = new Date();
    const start = Date.UTC(now.getUTCFullYear(), 0, 1);
    return Math.max(1, Math.ceil((Date.now() - start) / 86_400_000));
  }
  if (w === 'last_cy') return 365;
  const m = WINDOW_RE.exec(w);
  return m ? Number(m[1]) : 30;
}

export const SOURCE_FILTERS = ['primary', 'seed_dataset', 'manual', 'all'] as const;
export type SourceFilter = (typeof SOURCE_FILTERS)[number];
export function asSourceFilter(v: unknown, fallback: SourceFilter = 'all'): SourceFilter {
  return typeof v === 'string' && (SOURCE_FILTERS as readonly string[]).includes(v)
    ? (v as SourceFilter)
    : fallback;
}

/**
 * Party bucket filter value.  `O` means "Other / No party": Independents, minor
 * parties AND filers with no party on file (see {@link PARTY_BUCKET_SQL}).
 */
export type PartyBucket = 'D' | 'R' | 'O';
export function asPartyBucket(v: unknown): PartyBucket | undefined {
  if (typeof v !== 'string' || v.length === 0) return undefined;
  const c = v[0].toUpperCase();
  return c === 'D' ? 'D' : c === 'R' ? 'R' : c === 'O' || c === 'I' ? 'O' : undefined;
}

/** CSV multi-party selection (e.g. "D,R"). Undefined = no party filter. */
export function asPartyBuckets(v: unknown): PartyBucket[] | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const parsed = Array.from(
    new Set(
      v
        .split(',')
        .map((part) => asPartyBucket(part.trim()))
        .filter((c): c is PartyBucket => !!c),
    ),
  ).sort();
  return parsed.length ? parsed : undefined;
}

export function asChamber(v: unknown): Chamber | undefined {
  return v === 'house' || v === 'senate' || v === 'executive' ? v : undefined;
}

/**
 * Parse a CSV chamber selection (e.g. "house,executive"). Returns undefined
 * for an empty/absent/fully-invalid value — the DEFAULT selection, which every
 * query below treats as house+senate: executive (OGE 278-T) rows only appear
 * when explicitly requested, so a single mega-filing can't swamp the
 * congressional analytics.
 */
export function asChambers(v: unknown): Chamber[] | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const parsed = Array.from(
    new Set(v.split(',').map((part) => asChamber(part.trim())).filter((c): c is Chamber => !!c)),
  ).sort(); // sorted so KV cache keys are stable across selection order
  return parsed.length ? parsed : undefined;
}

/** Canonical B|S|E. Legacy form letter P (Purchase) → Buy. */
export function asTxType(v: unknown): TxType | undefined {
  if (typeof v !== 'string') return undefined;
  if (v === 'P' || v === 'p' || v === 'B' || v === 'b') return 'B';
  return v === 'S' || v === 'E' ? v : undefined;
}

/** CSV multi-type selection (e.g. "B,S"). Undefined = no type filter. */
export function asTxTypes(v: unknown): TxType[] | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const parsed = Array.from(
    new Set(v.split(',').map((part) => asTxType(part.trim())).filter((t): t is TxType => !!t)),
  ).sort();
  return parsed.length ? parsed : undefined;
}

/**
 * Narrow a caller-requested type set to an endpoint's allowed universe
 * (cluster/conviction are directional B/S only). Absent request → allowed.
 * Empty intersection keeps a no-row bind so we do not silently widen.
 */
export function constrainTxTypes(requested: TxType[] | undefined, allowed: TxType[]): TxType[] {
  if (!requested?.length) return [...allowed];
  const allow = new Set(allowed);
  const next = requested.filter((t) => allow.has(t));
  return next.length ? next : (['__none__'] as unknown as TxType[]);
}

/**
 * Map a window to the SQLite date modifier used in `date('now', ?)`. `all` and
 * calendar-year presets return null (calendar years use absolute date bounds in
 * buildCommonFilters). Returned offset strings are a closed set, never user input.
 */
export function windowToOffset(w: Window): string | null {
  if (w === 'all' || CALENDAR_WINDOWS.has(w)) return null;
  const d = windowDays(w);
  return d == null ? null : `-${d} days`;
}

// ---------------------------------------------------------------------------
// Time bucketing (for the time-series endpoints)
// ---------------------------------------------------------------------------

export type Granularity = 'day' | 'week' | 'month';
export function isGranularity(v: unknown): v is Granularity {
  return v === 'day' || v === 'week' || v === 'month';
}
/** Sensible default bucket size for a window when the caller doesn't override. */
export function autoGranularity(w: Window): Granularity {
  const d = windowDays(w);
  if (d == null) return 'month'; // all
  if (d <= 31) return 'day';
  if (d <= 120) return 'week';
  return 'month';
}
/** strftime() format string for a granularity. */
export function granularityFormat(g: Granularity): string {
  return g === 'day' ? '%Y-%m-%d' : g === 'week' ? '%Y-W%W' : '%Y-%m';
}

// ---------------------------------------------------------------------------
// Reusable SQL expression fragments
// ---------------------------------------------------------------------------

/**
 * Estimated dollar value of one transaction from its STOCK Act bracket. Uses
 * the bracket midpoint; the open top tier (amount_max IS NULL) falls back to the
 * floor (amount_min); a fully-missing amount contributes 0. THE single source
 * of truth for "$" — every dollar metric interpolates this exact expression.
 */
const RAW_BRACKET_MIDPOINT_SQL =
  '(CASE WHEN t.amount_max IS NOT NULL THEN (t.amount_min + t.amount_max) / 2.0 ' +
  'WHEN t.amount_min IS NOT NULL THEN t.amount_min ELSE 0 END)';

/**
 * Estimated dollar value of one transaction from its STOCK Act bracket.
 * Fabricated competitor_backfill $1,001–$15,000 defaults contribute 0
 * (DATACORRECTNESS-02) until a real bracket exists.
 */
export const BRACKET_MIDPOINT_SQL =
  `(CASE WHEN ${fabricatedCompetitorAmountSql('t')} THEN 0 ELSE ${RAW_BRACKET_MIDPOINT_SQL} END)`;

/** Signed midpoint: +mid for purchases, -mid for sales, 0 otherwise (net flow). */
export const SIGNED_MIDPOINT_SQL =
  "(CASE WHEN t.tx_type IN ('B', 'P') THEN " +
  BRACKET_MIDPOINT_SQL +
  " WHEN t.tx_type = 'S' THEN -" +
  BRACKET_MIDPOINT_SQL +
  ' ELSE 0 END)';

/**
 * Stock-only dollars for headline Net Flow / Approx. Volume / ticker
 * net-flow (DATACORRECTNESS-10). Option premiums stay out of the $ KPIs
 * even when the request does not pass excludeOptions.
 */
export const STOCK_MIDPOINT_SQL =
  `(CASE WHEN t.is_option = 1 THEN 0 ELSE ${BRACKET_MIDPOINT_SQL} END)`;
export const STOCK_SIGNED_MIDPOINT_SQL =
  "(CASE WHEN t.is_option = 1 THEN 0 WHEN t.tx_type IN ('B', 'P') THEN " +
  BRACKET_MIDPOINT_SQL +
  " WHEN t.tx_type = 'S' THEN -" +
  BRACKET_MIDPOINT_SQL +
  ' ELSE 0 END)';

/** Chamber resolved from the filers table, falling back to the owning filing. */
export const CHAMBER_EXPR = 'COALESCE(fl.chamber, f.chamber)';

/**
 * Party bucketed to 'D' | 'R' | 'O' by first letter.  Total: anything that is
 * not D or R — Independent, minor parties, empty/NULL party (seed, executive
 * and manual filers) or a transaction whose filer has no `filers` row — is 'O'
 * ("Other / No party").  Never NULL, so the three buckets partition the data
 * and `party=D,R,O` returns exactly what no party filter returns.  Keep in sync
 * with PARTY_BUCKET_SQL_LOCAL in delivery/rows.ts (asserted by a test).
 */
export const PARTY_BUCKET_SQL =
  "(CASE WHEN UPPER(SUBSTR(TRIM(COALESCE(fl.party, '')), 1, 1)) = 'D' THEN 'D' " +
  "WHEN UPPER(SUBSTR(TRIM(COALESCE(fl.party, '')), 1, 1)) = 'R' THEN 'R' " +
  "ELSE 'O' END)";

/** A non-null, non-empty ticker (the analytics definition of "a resolved asset"). */
export const TICKER_RESOLVED_SQL = "(t.ticker IS NOT NULL AND t.ticker <> '' AND t.ticker NOT IN ('NONE', '--', 'N/A', 'NA', 'NULL', '—'))";

/**
 * Standard FROM/JOIN for analytics queries. Always LEFT JOINs filers (party,
 * chamber, name, photo) and filings (chamber fallback, filed_date for lag), so
 * the common filters below can reference `fl` / `f` in any query. Seed rows
 * whose filer/ filing meta is missing are preserved (LEFT, not INNER).
 */
export const ANALYTICS_FROM_JOINS =
  'FROM transactions t ' +
  'LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id ' +
  'LEFT JOIN filings f ON f.doc_id = t.doc_id ';

/** As {@link ANALYTICS_FROM_JOINS} but also joins the securities master (name). */
export const ANALYTICS_FROM_JOINS_SECURITIES =
  ANALYTICS_FROM_JOINS + 'LEFT JOIN securities_master sm ON sm.ticker = t.ticker ';

/**
 * As {@link ANALYTICS_FROM_JOINS} but also joins the enrichment reference
 * (securities_ref `sr`) so a query can group/filter by real GICS sector and
 * market-cap bucket. LEFT, so un-enriched tickers are preserved (sr.* NULL).
 */
export const ANALYTICS_FROM_JOINS_REF =
  ANALYTICS_FROM_JOINS + 'LEFT JOIN securities_ref sr ON sr.ticker = t.ticker ';

// ---------------------------------------------------------------------------
// Common filter builder
// ---------------------------------------------------------------------------

export interface CommonFilters {
  /** Time window applied to t.tx_date. 'all' drops the date clause. */
  window?: Window;
  chamber?: Chamber;
  /**
   * Multi-chamber selection (takes precedence over `chamber`). ABSENT means
   * the default congressional view: house + senate + unresolved, with
   * executive rows excluded (see {@link asChambers}).
   */
  chambers?: Chamber[];
  /** Party bucket (D/R/O, O = Other / No party); matched against {@link PARTY_BUCKET_SQL}. */
  party?: PartyBucket;
  /** Multi-party selection (takes precedence over `party`). */
  parties?: PartyBucket[];
  /** 'all' (default) applies no source filter; else t.source = source. */
  source?: SourceFilter;
  /** Minimum per-row confidence (omit for no filter). */
  minConf?: number;
  /** Require a resolved (non-null, non-empty) ticker. */
  tickerNotNull?: boolean;
  /** Restrict to these transaction types (e.g. ['B','S']). */
  txTypes?: TxType[];
  /** Restrict to this explicit set of tickers (e.g. a precomputed candidate set). */
  tickers?: string[];
  /** Exclude option rows (is_option = 1) — for common-stock-only views. */
  excludeOptions?: boolean;
}

/**
 * Build the shared WHERE fragments + ordered bind params for an analytics query.
 * Params are emitted in WHERE-clause order; callers that also bind SELECT-side
 * params (e.g. a strftime() format) must prepend those before these.
 */
export function buildCommonFilters(p: CommonFilters): { where: string[]; params: SqlParam[] } {
  const where: string[] = [];
  const params: SqlParam[] = [];

  // Retracted (un-published) rows never appear in any analytics aggregate.
  where.push('t.deprecated_at IS NULL');
  // Same "real, first-class disclosed trade" guards the public feed applies
  // unconditionally (see buildTxFilters in src/delivery/rows.ts). Before this,
  // Trends aggregates (e.g. the "Trades" summary KPI) counted synthetic
  // provider-discovered placeholders, filer-less orphan rows, and
  // competitor-only executive injects that the Trades tab has never shown —
  // inflating every Trends number above the feed's total for what should be
  // the identical underlying universe (owner report: the Trends "TRADES" stat
  // running far ahead of the Trades tab's own total). Mirrored here (not
  // imported) so this module stays dependency-free, matching its own "mirrors
  // src/delivery/rows.ts" convention.
  where.push("SUBSTR(t.doc_id, 1, 17) != 'provider-missing-'");
  where.push('t.filer_id IS NOT NULL');
  where.push(
    "NOT (t.source = 'competitor_backfill' AND t.filer_id LIKE 'EXEC-%' AND t.doc_id LIKE 'COMPETITOR%')",
  );
  // Same real-world trade must count once (DATACORRECTNESS-01). Twin
  // guard lives in shared/tradeIdentity.ts so the feed uses the same rule.
  // Relies on idx_tx_twin_seek (0088 / #2062) so this is an index SEARCH.
  where.push(TWIN_DEDUPE_SQL);

  const win = p.window ?? '30d';
  if (win === 'this_cy') {
    // Inclusive from Jan 1 of the current UTC calendar year.
    where.push("t.tx_date >= date(strftime('%Y', 'now') || '-01-01')");
  } else if (win === 'last_cy') {
    // Full previous UTC calendar year [Jan 1, Jan 1 this year).
    where.push("t.tx_date >= date(strftime('%Y', 'now') || '-01-01', '-1 year')");
    where.push("t.tx_date < date(strftime('%Y', 'now') || '-01-01')");
  } else {
    const offset = windowToOffset(win);
    if (offset) {
      where.push("t.tx_date >= date('now', ?)");
      params.push(offset);
    }
  }
  if (p.chambers && p.chambers.length) {
    where.push(`${CHAMBER_EXPR} IN (${p.chambers.map(() => '?').join(', ')})`);
    for (const c of p.chambers) params.push(c);
  } else if (p.chamber) {
    where.push(`${CHAMBER_EXPR} = ?`);
    params.push(p.chamber);
  } else {
    // Default view = all chambers. We no longer exclude executive filings by default.
  }
  if (p.parties && p.parties.length) {
    where.push(`${PARTY_BUCKET_SQL} IN (${p.parties.map(() => '?').join(', ')})`);
    for (const b of p.parties) params.push(b);
  } else if (p.party) {
    where.push(`${PARTY_BUCKET_SQL} = ?`);
    params.push(p.party);
  }
  if (p.source && p.source !== 'all') {
    if (p.source === 'primary') {
      where.push("t.source IN ('primary', 'manual')");
    } else {
      where.push('t.source = ?');
      params.push(p.source);
    }
  }
  if (typeof p.minConf === 'number' && Number.isFinite(p.minConf)) {
    where.push('t.confidence >= ?');
    params.push(p.minConf);
  }
  if (p.tickerNotNull) {
    where.push(TICKER_RESOLVED_SQL);
  }
  if (p.txTypes && p.txTypes.length) {
    // Expand Buy (B) to include legacy Purchase letter P during migration window.
    const expanded = new Set<string>();
    for (const ty of p.txTypes) {
      expanded.add(ty);
      const code = String(ty);
      if (code === 'B' || code === 'P') {
        expanded.add('B');
        expanded.add('P');
      }
    }
    const list = [...expanded];
    where.push(`t.tx_type IN (${list.map(() => '?').join(', ')})`);
    for (const ty of list) params.push(ty);
  }
  if (p.tickers && p.tickers.length) {
    where.push(`t.ticker IN (${p.tickers.map(() => '?').join(', ')})`);
    for (const tk of p.tickers) params.push(tk);
  }
  if (p.excludeOptions) {
    where.push('t.is_option = 0');
  }

  return { where, params };
}

/** Render a WHERE clause (with trailing space) from fragments, or '' if none. */
export function whereSql(where: string[]): string {
  return where.length ? `WHERE ${where.join(' AND ')} ` : '';
}

/** Clamp an arbitrary limit to a sane integer in [1, max]. */
export function clampLimit(v: unknown, fallback: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}
