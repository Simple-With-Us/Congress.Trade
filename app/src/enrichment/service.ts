/**
 * src/enrichment/service.ts
 * OWNER: enrichment
 *
 * Enrichment runner. Each run fills tickers that most need it (newest-traded
 * first, then older un-enriched ones). Company profile / sector / market-cap
 * fields come from Socratic.Trade (`APP_B_IMPORT_URL` + `APP_B_INGEST_TOKEN`).
 * FMP is not on this path — free FMP keys are disclosure-latency probes only.
 * Direct Massive / Intrinio / Twelve Data / Finnhub / Tiingo keys are not
 * enrichment fallbacks. SEC EDGAR remains the free public CIK/SIC baseline
 * when ST has no profile for a symbol. EDGAR calls use their own per-minute
 * gate. The historical FMP day-counter helpers stay exported so latency and
 * older imports can still read `fmp:calls:*`; this runner does not spend them.
 */

import type { Env } from '../shared/types.ts';
import { all, run } from '../shared/db.ts';
import type { SqlParam } from '../shared/db.ts';
import { mergeRefs } from './compute.ts';
import { buildSecProvider } from './sec.ts';
import { buildSocraticProvider, isTickerShapedSymbol } from './socratic.ts';
import { getSharedFmpPacer, getSharedEdgarPacer } from '../shared/pace.ts';
import type { EnrichmentProvider, SecurityRef } from './types.ts';
import { resolveSecrets } from '../secrets/infisical.ts';

/** Exported so jobs.ts can reserve a price-refresh budget floor against the
 *  same default the FMP daily-call-cap parsing falls back to here. */
export const DEFAULT_DAILY_CAP = 230;

type EnvX = Env & {
  FMP_DAILY_CALL_CAP?: string;
  FMP_MAX_PER_MINUTE?: string;
  EDGAR_MAX_PER_MINUTE?: string;
  APP_B_IMPORT_URL?: string;
  APP_B_INGEST_TOKEN?: string;
};

interface ChainEntry {
  name: string;
  provider: EnrichmentProvider;
  /** True only for FMP, whose calls are metered against the daily budget. */
  budgeted: boolean;
}

/**
 * Keyed providers whose `source` marker blocks re-enrichment of a row that is
 * still missing display-critical fields (sector, country, market cap). Only
 * Socratic.Trade is on the live chain. Legacy vendor names are intentionally
 * absent so an older `fmp` / `massive` row that is still missing those fields
 * is retried through ST.
 */
const KEYED_PROVIDER_SOURCE_MARKERS = ['socratic'];

function keyedSourceTriedSql(alias: string): string {
  return '(' + KEYED_PROVIDER_SOURCE_MARKERS.map((s) => `${alias}.source LIKE '%${s}%'`).join(' OR ') + ')';
}

function missingDisplayCriticalSql(alias: string): string {
  return `(${alias}.company_name IS NULL OR ${alias}.company_name = ''
          OR ${alias}.sector IS NULL OR ${alias}.sector = ''
          OR ${alias}.country IS NULL OR ${alias}.country = ''
          OR (${alias}.market_cap IS NULL AND (${alias}.market_cap_bucket IS NULL OR ${alias}.market_cap_bucket = '')))`;
}

/**
 * Marker written to `securities_ref.enrichment_error` for a TRANSIENT failure
 * (a provider threw — network error, 5xx, or an FMP/tier 401/402/403/429 —
 * never a clean "no data" result). `enriched_at` stays NULL for these, so the
 * ticker remains selectable by the base `enrichmentNeededSql` predicate (which
 * only tests `enriched_at`); only a DETERMINISTIC no-data outcome (every
 * provider returned null without throwing) tombstones a ticker via
 * `upsertEmpty`.  A ticker-shaped tombstone is eligible for one more peer
 * attempt until that attempt is recorded on `source`.  The transient marker
 * provides attempt-aging: each consecutive
 * transient miss doubles the backoff (capped), so a sustained outage or a
 * broken key/rate-limit doesn't get hammered every single cron tick while
 * still recovering automatically once the provider is healthy again.
 */
export const NO_PROVIDER_DATA_ERROR = 'no provider data';
export const NOT_AN_EQUITY_ERROR = 'not an equity';

const TRANSIENT_RETRY_PREFIX = 'transient-retry:';
const TRANSIENT_RETRY_BASE_BACKOFF_MS = 60 * 60 * 1000; // 1 hour
const TRANSIENT_RETRY_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface TransientRetryState {
  /** Consecutive transient-failure count (never reset except by a success). */
  attempts: number;
  /** Epoch ms before which another attempt should not be made. */
  nextEligibleAt: number;
}

/** Parse a transient-retry marker out of `enrichment_error`. Null for anything
 *  else (a real tombstone message, or the field is empty/absent). */
export function parseTransientRetryMarker(raw: string | null | undefined): TransientRetryState | null {
  if (!raw || !raw.startsWith(TRANSIENT_RETRY_PREFIX)) return null;
  const rest = raw.slice(TRANSIENT_RETRY_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep < 0) return null;
  const attempts = parseInt(rest.slice(0, sep), 10);
  const nextEligibleAt = Date.parse(rest.slice(sep + 1));
  if (!Number.isFinite(attempts) || attempts <= 0 || !Number.isFinite(nextEligibleAt)) return null;
  return { attempts, nextEligibleAt };
}

/** Whether a ticker carrying this `enrichment_error` value is due for another
 *  attempt yet (no marker at all — never failed transiently — is eligible). */
export function transientRetryEligible(raw: string | null | undefined, now = Date.now()): boolean {
  const state = parseTransientRetryMarker(raw);
  return !state || now >= state.nextEligibleAt;
}

/** The next marker to persist after another transient miss: attempts + 1,
 *  backoff doubling from the base up to the cap. */
export function nextTransientRetryMarker(raw: string | null | undefined, now = Date.now()): string {
  const prior = parseTransientRetryMarker(raw);
  const attempts = (prior?.attempts ?? 0) + 1;
  const backoffMs = Math.min(
    TRANSIENT_RETRY_MAX_BACKOFF_MS,
    TRANSIENT_RETRY_BASE_BACKOFF_MS * 2 ** (attempts - 1),
  );
  return `${TRANSIENT_RETRY_PREFIX}${attempts}:${new Date(now + backoffMs).toISOString()}`;
}

/**
 * Obvious non-equity: the ticker or asset name contains MUNICIPAL, TREASURY,
 * or CORPORATE BOND, or the ticker is more than one word and is not
 * ticker-shaped.  A normal 1-5 letter symbol is never classified just because
 * a profile is missing (a keyword has to be on that symbol itself, and those
 * phrases are longer than five letters).
 */
export function obviousNonEquity(ticker: string, assetName?: string | null): boolean {
  const raw = ticker.trim().toUpperCase();
  const name = (assetName ?? '').toUpperCase();
  // A normal 1-5 letter ticker stays eligible.  A missing profile is not a classification.
  if (/^[A-Z]{1,5}$/.test(raw)) return false;
  const keyword = (s: string) =>
    s.includes('MUNICIPAL') || s.includes('TREASURY') || s.includes('CORPORATE BOND');
  // Ticker-shaped symbols (including BRK/B → BRK.B) are classified only when the
  // symbol itself contains a non-equity marker such as TREASURY.
  if (isTickerShapedSymbol(raw)) return keyword(raw);
  if (keyword(raw) || keyword(name)) return true;
  return raw.split(/\s+/).filter(Boolean).length > 1;
}

/** SQLite GLOB complement is `^` (this build treats `!` as a literal). */
function tickerShapedExprSql(expr: string): string {
  return `(LENGTH(${expr}) BETWEEN 1 AND 10
    AND ${expr} GLOB '[A-Z]*'
    AND NOT (${expr} GLOB '*[^A-Z0-9.]*'))`;
}

/** `BRK/B` / `BF/B` → dotted peer symbol.  Same rule as `peerProfileSymbol`. */
function aliasedTickerSql(col: string): string {
  const upper = `UPPER(${col})`;
  const slash = [
    "'[A-Z]/[A-Z]'",
    "'[A-Z][A-Z]/[A-Z]'",
    "'[A-Z][A-Z][A-Z]/[A-Z]'",
    "'[A-Z][A-Z][A-Z][A-Z]/[A-Z]'",
    "'[A-Z][A-Z][A-Z][A-Z][A-Z]/[A-Z]'",
  ].map((glob) => `${upper} GLOB ${glob}`).join(' OR ');
  return `CASE WHEN ${slash} THEN REPLACE(${upper}, '/', '.') ELSE ${upper} END`;
}

/** Spaces or non-equity words on a name.  `LP` is a token so ALPHABET is not a hit. */
function nameBlocksTombstoneRetrySql(col: string): string {
  const u = `UPPER(IFNULL(${col}, ''))`;
  return `(INSTR(IFNULL(${col}, ''), ' ') > 0
    OR ${u} LIKE '%MUNICIPAL%'
    OR ${u} LIKE '%TREASURY%'
    OR ${u} LIKE '%BOND%'
    OR ${u} LIKE '%FUND%'
    OR ${u} = 'LP'
    OR ${u} LIKE 'LP %'
    OR ${u} LIKE '% LP'
    OR ${u} LIKE '% LP %'
    OR ${u} LIKE '% LP.%'
    OR ${u} LIKE '%L.P.%')`;
}

/**
 * One more peer attempt for a ticker-shaped `no provider data` tombstone whose
 * `source` does not yet record socratic.  A space, or MUNICIPAL / TREASURY /
 * BOND / FUND / LP, on the ticker or on any asset name blocks the retry.
 *
 * The keyed form of `enrichmentNeededSql` references `transactions`.  Every
 * caller already joins that table as the ticker source.
 */
function tickerShapedTombstoneRetrySql(alias: string): string {
  return `(${alias}.enrichment_error = '${NO_PROVIDER_DATA_ERROR}'
    AND (${alias}.source IS NULL OR ${alias}.source NOT LIKE '%socratic%')
    AND ${tickerShapedExprSql(aliasedTickerSql(`${alias}.ticker`))}
    AND NOT ${nameBlocksTombstoneRetrySql(`${alias}.ticker`)}
    AND NOT EXISTS (
      SELECT 1 FROM transactions tx_ne
      WHERE tx_ne.ticker = ${alias}.ticker
        AND ${nameBlocksTombstoneRetrySql('tx_ne.asset_name')}
    ))`;
}

/**
 * SQL predicate for tickers still worth enriching. With no keyed provider, one
 * SEC/EDGAR pass is enough; EDGAR cannot fill country or market cap. Once a
 * keyed provider exists, retry EDGAR/imported rows that are still missing
 * display-critical company metadata, and retry a ticker-shaped
 * "no provider data" tombstone once.  Rows already attempted by a keyed source
 * are not hammered forever if the provider itself lacks a field.  Country is
 * not invented when the peer omits it.
 */
export function enrichmentNeededSql(alias = 'sr', retryIncompleteWithKeyedProvider = false): string {
  if (!retryIncompleteWithKeyedProvider) {
    return `(${alias}.ticker IS NULL OR ${alias}.enriched_at IS NULL)`;
  }
  return `(${alias}.ticker IS NULL
          OR ${alias}.enriched_at IS NULL
          OR (${missingDisplayCriticalSql(alias)}
              AND NOT ${keyedSourceTriedSql(alias)}
              AND (${alias}.enrichment_error IS NULL OR ${alias}.enrichment_error = ''
                   OR ${alias}.enrichment_error LIKE '${TRANSIENT_RETRY_PREFIX}%'))
          OR ${tickerShapedTombstoneRetrySql(alias)})`;
}

/**
 * Whether Socratic.Trade is configured to fill display-critical company fields.
 * Direct vendor keys (FMP, Massive, Tiingo, …) do not count: they are not on
 * the enrichment chain. Without the peer, re-enrichment SQL skips tickers that
 * already have `enriched_at`, even if sector/country/market cap are still
 * empty — otherwise EDGAR-only runs would re-select the newest tickers forever.
 */
export async function hasConfiguredKeyedEnrichmentProvider(env: Env): Promise<boolean> {
  const keys = await resolveSecrets(env, ['APP_B_IMPORT_URL', 'APP_B_INGEST_TOKEN']);
  return Boolean(keys.APP_B_IMPORT_URL && keys.APP_B_INGEST_TOKEN);
}

/**
 * Profile chain: Socratic.Trade first when the peer is configured, then SEC
 * EDGAR for public CIK/SIC identity. No FMP and no direct market-data vendors.
 */
export function enrichmentChainNames(env: EnvX): string[] {
  return buildEnrichmentChain(env).map((entry) => entry.name);
}

function buildEnrichmentChain(env: EnvX): ChainEntry[] {
  const chain: ChainEntry[] = [];
  if (env.APP_B_IMPORT_URL && env.APP_B_INGEST_TOKEN) {
    chain.push({
      name: 'socratic',
      provider: buildSocraticProvider(env.APP_B_IMPORT_URL, env.APP_B_INGEST_TOKEN),
      budgeted: false,
    });
  }
  chain.push({ name: 'edgar', provider: buildSecProvider(), budgeted: false });
  return chain;
}

/** Display-critical coverage: stop walking the chain early once these are set. */
function isCovered(partials: Array<Partial<SecurityRef>>): boolean {
  let name = false;
  let sector = false;
  let mcap = false;
  for (const p of partials) {
    if (p.companyName) name = true;
    if (p.sector) sector = true;
    if (p.marketCap != null) mcap = true;
  }
  return name && sector && mcap;
}

function dayKey(now = new Date()): string {
  return 'fmp:calls:' + now.toISOString().slice(0, 10);
}

/** FMP calls already spent today (from the KV day-counter). */
export async function getDailyUsed(env: Env): Promise<number> {
  try {
    const v = await env.CONFIG_KV.get(dayKey());
    const n = v ? parseInt(v, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
async function setDailyUsed(env: Env, n: number): Promise<void> {
  try {
    await env.CONFIG_KV.put(dayKey(), String(n), { expirationTtl: 172800 });
  } catch {
    /* best effort */
  }
}

/** Add `n` to today's FMP call counter (shared by enrichment + price refresh). */
export async function addDailyUsed(env: Env, n: number): Promise<number> {
  const used = await getDailyUsed(env);
  const next = used + Math.max(0, Math.floor(n));
  await setDailyUsed(env, next);
  return next;
}

/** A ticker selected for enrichment, plus its current `enrichment_error` (used
 *  to honor a still-pending transient-retry backoff before spending a call). */
export interface EnrichCandidate {
  ticker: string;
  enrichmentError: string | null;
  assetName: string | null;
}

/** Distinct tickers that still need enrichment, newest-traded first. */
export async function selectTickersToEnrich(
  env: Env,
  limit: number,
  retryIncompleteWithKeyedProvider = false,
): Promise<EnrichCandidate[]> {
  if (limit <= 0) return [];
  const rows = await all<{ ticker: string; enrichment_error: string | null; asset_name: string | null }>(
    env.DB,
    `SELECT t.ticker AS ticker,
            MAX(sr.enrichment_error) AS enrichment_error,
            MAX(t.asset_name) AS asset_name
       FROM transactions t
       LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
      WHERE t.ticker IS NOT NULL AND t.ticker <> ''
        AND ${enrichmentNeededSql('sr', retryIncompleteWithKeyedProvider)}
      GROUP BY t.ticker
      ORDER BY MAX(t.cursor_seq) DESC
      LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({
    ticker: r.ticker,
    enrichmentError: r.enrichment_error ?? null,
    assetName: r.asset_name ?? null,
  }));
}

export interface EnrichResult {
  hasFmpKey: boolean;
  dailyCap: number;
  usedBefore: number;
  scanned: number;
  enriched: number;
  fmpCalls: number;
  failures: number;
  budgetRemaining: number;
  dryRun: boolean;
  errors: string[];
  /** Refs THIS run enriched (for the App B outbound push — our own fetches only). */
  shareRefs: SecurityRef[];
}

/**
 * Run one budgeted enrichment pass. `max` caps how many tickers this invocation
 * processes (also bounded by the remaining FMP budget when a key is set).
 */
export async function runEnrichment(
  env: Env,
  opts: { max?: number; dryRun?: boolean; maxPerMinute?: number; edgarMaxPerMinute?: number; signal?: AbortSignal; deadlineMs?: number } = {},
): Promise<EnrichResult> {
  const runtimeSecrets = await resolveSecrets(env, [
    'FMP_MAX_PER_MINUTE',
    'EDGAR_MAX_PER_MINUTE',
    'APP_B_IMPORT_URL',
    'APP_B_INGEST_TOKEN',
  ]);
  const envx = { ...(env as EnvX), ...runtimeSecrets };
  const dryRun = opts.dryRun === true;
  // Profiles are not metered against the FMP day counter. `max` is a per-run
  // slice; the default is higher when ST is configured because those reads
  // are not a free-tier FMP budget.
  const hasSocratic = !!(envx.APP_B_IMPORT_URL && envx.APP_B_INGEST_TOKEN);
  const selectLimit = opts.max != null
    ? Math.max(0, Math.floor(opts.max))
    : hasSocratic ? 500 : 200;

  const result: EnrichResult = {
    hasFmpKey: false,
    dailyCap: 0,
    usedBefore: 0,
    scanned: 0,
    enriched: 0,
    fmpCalls: 0,
    failures: 0,
    budgetRemaining: 0,
    dryRun,
    errors: [],
    shareRefs: [],
  };
  if (selectLimit <= 0) return result;

  const chain = buildEnrichmentChain(envx);
  // Only providers in KEYED_PROVIDER_SOURCE_MARKERS can fill display-critical
  // fields (sector, country, market cap). Tiingo alone, for example, enriches
  // name + exchange but never sector/market cap, so it must not enable keyed-
  // retry mode: that would re-select the same newest tickers on every run
  // because Tiingo's source marker is excluded from keyedSourceTriedSql,
  // making the rows appear perpetually "not yet tried by a keyed provider."
  const hasKeyedProvider = chain.some((e) => KEYED_PROVIDER_SOURCE_MARKERS.includes(e.name));
  const candidates = await selectTickersToEnrich(env, selectLimit, hasKeyedProvider);
  // Shared per-isolate FMP pacer, so a concurrent price refresh or disclosure
  // probe can't blow the per-minute cap by pacing only its own calls. Fall back
  // to FMP_MAX_PER_MINUTE when a caller (e.g. an admin endpoint whose body omits
  // it) passes nothing, so the memoized singleton is never poisoned into a
  // permanent no-op just because an unconfigured caller happened to run first.
  const fmpMaxPerMinute =
    opts.maxPerMinute ?? (parseInt(envx.FMP_MAX_PER_MINUTE || '', 10) || undefined);
  const pace = getSharedFmpPacer(fmpMaxPerMinute);
  // SEC EDGAR's own dedicated pacer — a separate provider with a separate
  // fair-access limit, so it does NOT draw on the FMP budget/pacer above. Same
  // env fallback so admin-triggered runs don't poison it either.
  const edgarMaxPerMinute =
    opts.edgarMaxPerMinute ?? (parseInt(envx.EDGAR_MAX_PER_MINUTE || '', 10) || undefined);
  const edgarPace = getSharedEdgarPacer(edgarMaxPerMinute);
  const runStartedAt = Date.now();

  for (const candidate of candidates) {
    // Time-sliced execution: stop starting new candidates when the caller's
    // deadline/abort fires. Completed work (refs, usage counters) is already
    // persisted per candidate, so a partial slice simply resumes next run —
    // the daily FMP cap and candidate predicates self-limit total spend.
    if (opts.signal?.aborted) break;
    if (opts.deadlineMs !== undefined && Date.now() - runStartedAt >= opts.deadlineMs) break;
    // Honor a still-pending transient-retry backoff (see TRANSIENT_RETRY_PREFIX
    // above) without spending a scan/provider call on it this run — it will be
    // reselected once eligible, by the same base predicate (enriched_at stays
    // NULL for these), on this or a later run.
    if (!transientRetryEligible(candidate.enrichmentError, runStartedAt)) continue;
    const ticker = candidate.ticker;
    result.scanned++;
    if (obviousNonEquity(ticker, candidate.assetName)) {
      // Leave the retry set without asking the peer.  A normal 1-5 letter miss
      // never reaches here.
      if (!dryRun) await upsertEmpty(env, ticker, NOT_AN_EQUITY_ERROR);
      continue;
    }
    // Quality-ranked chain (best first). Each provider fills only what better
    // ones missed; we stop early once the display-critical fields are covered.
    const collected: Array<Partial<SecurityRef>> = [];
    // True once ANY provider in the chain THROWS (network error, 5xx, or an
    // FMP tier failure) while resolving this ticker. That is categorically
    // different from every provider cleanly returning null: a thrown error
    // means we don't actually know whether the ticker has data, so it must
    // not be tombstoned — only a clean, exception-free "nothing found" from
    // every provider is a deterministic no-data outcome.
    let hadTransientError = false;
    for (const entry of chain) {
      try {
        // Every provider paces before its call, each against its own budget:
        // EDGAR uses its dedicated gate (free, but still fair-access limited);
        // everything else shares the FMP per-minute gate.
        await (entry.name === 'edgar' ? edgarPace() : pace());
        const ref = await entry.provider.fetchRef(ticker);
        if (ref) collected.push(ref);
      } catch (e) {
        hadTransientError = true;
        result.errors.push(ticker + ' ' + entry.name + ': ' + (e as Error).message);
      }
      if (isCovered(collected)) break; // display-critical fields satisfied
    }

    if (collected.length === 0) {
      result.failures++;
      if (!dryRun) {
        if (hadTransientError) {
          // Transient (retryable) failure: never tombstone. Persist an
          // attempt-aged backoff marker so this run's provider outage/rate
          // limit doesn't get hammered again next cron tick, while keeping
          // the ticker selectable (enriched_at stays untouched/NULL).
          await markTransientEnrichmentFailure(env, ticker, candidate.enrichmentError, runStartedAt);
        } else if (hasKeyedProvider) {
          // Deterministic no-data (every provider ran cleanly and found
          // nothing): tombstone only when a keyed provider was actually
          // consulted; a key-less SEC-only miss stays eligible.
          await upsertEmpty(env, ticker, NO_PROVIDER_DATA_ERROR, true);
        }
      }
      continue;
    }
    // mergeRefs is last-wins; the chain is best-first, so reverse so the best
    // provider's non-null fields win.
    const merged = mergeRefs(ticker, [...collected].reverse());
    if (!dryRun) {
      await upsertRef(env, merged);
      result.shareRefs.push(merged);
    }
    result.enriched++;
  }

  result.fmpCalls = 0;
  result.budgetRemaining = 0;
  return result;
}

/** Upsert one fully-formed SecurityRef (used by the runner + the import API). */
export async function upsertSecurityRef(env: Env, ref: SecurityRef): Promise<void> {
  return upsertRef(env, ref);
}

/**
 * Non-destructive upsert for SHARED data from another app (the import API).
 * Unlike upsertRef, this never overwrites an existing non-null column with an
 * incoming null (so a partial ref — e.g. only company/sector/marketCap — fills
 * gaps without erasing fields App A already enriched), and it does NOT set
 * enriched_at: an imported partial leaves the ticker eligible for App A's own
 * FMP/SEC enrichment to complete (CIK, exchange, country, …). is_etf/is_adr and
 * source are preserved on conflict (set only when first inserting the row).
 */
/**
 * Non-destructive upsert SQL for an imported (shared) SecurityRef. Extracted as
 * a constant so both the single-row path (importSecurityRef) and the batched
 * import path (prepareImportSecurityRef + DB.batch in the import route) reuse
 * exactly the same statement.
 */
const IMPORT_SECURITY_REF_SQL = `INSERT INTO securities_ref (
       ticker, company_name, sector, industry, asset_class, is_etf, is_adr,
       country, state_hq, state_of_incorp, exchange, exchange_short, currency,
       market_cap, market_cap_bucket, shares_outstanding, ipo_date, cik, sic_code, sic_description, source
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(ticker) DO UPDATE SET
       company_name=COALESCE(excluded.company_name, securities_ref.company_name),
       sector=COALESCE(excluded.sector, securities_ref.sector),
       industry=COALESCE(excluded.industry, securities_ref.industry),
       asset_class=COALESCE(excluded.asset_class, securities_ref.asset_class),
       country=COALESCE(excluded.country, securities_ref.country),
       state_hq=COALESCE(excluded.state_hq, securities_ref.state_hq),
       state_of_incorp=COALESCE(excluded.state_of_incorp, securities_ref.state_of_incorp),
       exchange=COALESCE(excluded.exchange, securities_ref.exchange),
       exchange_short=COALESCE(excluded.exchange_short, securities_ref.exchange_short),
       currency=COALESCE(excluded.currency, securities_ref.currency),
       market_cap=COALESCE(excluded.market_cap, securities_ref.market_cap),
       market_cap_bucket=COALESCE(excluded.market_cap_bucket, securities_ref.market_cap_bucket),
       shares_outstanding=COALESCE(excluded.shares_outstanding, securities_ref.shares_outstanding),
       ipo_date=COALESCE(excluded.ipo_date, securities_ref.ipo_date),
       cik=COALESCE(excluded.cik, securities_ref.cik),
       sic_code=COALESCE(excluded.sic_code, securities_ref.sic_code),
       sic_description=COALESCE(excluded.sic_description, securities_ref.sic_description)`;

function importSecurityRefBindings(ref: SecurityRef): SqlParam[] {
  return [
    ref.ticker, ref.companyName, ref.sector, ref.industry, ref.assetClass,
    ref.isEtf ? 1 : 0, ref.isAdr ? 1 : 0, ref.country, ref.stateHq, ref.stateOfIncorp,
    ref.exchange, ref.exchangeShort, ref.currency, ref.marketCap, ref.marketCapBucket,
    ref.sharesOutstanding ?? null, ref.ipoDate, ref.cik, ref.sicCode, ref.sicDescription, ref.source,
  ];
}

/**
 * Bound, ready-to-execute statement for one imported SecurityRef. Returning the
 * prepared statement (instead of awaiting it) lets the import route collect many
 * refs and flush them through a single `DB.batch(...)` per chunk — a sequential
 * `await` per row was the dominant cause of "Worker exceeded CPU time limit" and
 * "D1 overloaded" errors on /api/admin/securities/import.
 */
export function prepareImportSecurityRef(env: Env, ref: SecurityRef): D1PreparedStatement {
  return env.DB.prepare(IMPORT_SECURITY_REF_SQL).bind(...importSecurityRefBindings(ref));
}

export async function importSecurityRef(env: Env, ref: SecurityRef): Promise<void> {
  await run(env.DB, IMPORT_SECURITY_REF_SQL, importSecurityRefBindings(ref));
}

async function upsertRef(env: Env, ref: SecurityRef): Promise<void> {
  await run(
    env.DB,
    `INSERT INTO securities_ref (
       ticker, company_name, sector, industry, asset_class, is_etf, is_adr,
       country, state_hq, state_of_incorp, exchange, exchange_short, currency,
       market_cap, market_cap_bucket, shares_outstanding, ipo_date, cik, sic_code, sic_description,
       source, enriched_at, enrichment_error
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
     ON CONFLICT(ticker) DO UPDATE SET
       company_name=COALESCE(excluded.company_name, securities_ref.company_name),
       sector=COALESCE(excluded.sector, securities_ref.sector),
       industry=COALESCE(excluded.industry, securities_ref.industry),
       asset_class=COALESCE(excluded.asset_class, securities_ref.asset_class),
       is_etf=CASE WHEN excluded.is_etf = 1 THEN 1 ELSE securities_ref.is_etf END,
       is_adr=CASE WHEN excluded.is_adr = 1 THEN 1 ELSE securities_ref.is_adr END,
       country=COALESCE(excluded.country, securities_ref.country),
       state_hq=COALESCE(excluded.state_hq, securities_ref.state_hq),
       state_of_incorp=COALESCE(excluded.state_of_incorp, securities_ref.state_of_incorp),
       exchange=COALESCE(excluded.exchange, securities_ref.exchange),
       exchange_short=COALESCE(excluded.exchange_short, securities_ref.exchange_short),
       currency=COALESCE(excluded.currency, securities_ref.currency),
       market_cap=COALESCE(excluded.market_cap, securities_ref.market_cap),
       market_cap_bucket=COALESCE(excluded.market_cap_bucket, securities_ref.market_cap_bucket),
       shares_outstanding=COALESCE(excluded.shares_outstanding, securities_ref.shares_outstanding),
       ipo_date=COALESCE(excluded.ipo_date, securities_ref.ipo_date),
       cik=COALESCE(excluded.cik, securities_ref.cik),
       sic_code=COALESCE(excluded.sic_code, securities_ref.sic_code),
       sic_description=COALESCE(excluded.sic_description, securities_ref.sic_description),
       source=CASE
         WHEN securities_ref.source IS NULL OR securities_ref.source = '' THEN excluded.source
         WHEN excluded.source IS NULL OR excluded.source = '' THEN securities_ref.source
         WHEN securities_ref.source LIKE '%' || excluded.source || '%' THEN securities_ref.source
         ELSE securities_ref.source || '+' || excluded.source
       END,
       enriched_at=excluded.enriched_at, enrichment_error=NULL`,
    [
      ref.ticker, ref.companyName, ref.sector, ref.industry, ref.assetClass,
      ref.isEtf ? 1 : 0, ref.isAdr ? 1 : 0, ref.country, ref.stateHq, ref.stateOfIncorp,
      ref.exchange, ref.exchangeShort, ref.currency, ref.marketCap, ref.marketCapBucket,
      ref.sharesOutstanding ?? null, ref.ipoDate, ref.cik, ref.sicCode, ref.sicDescription, ref.source,
      new Date().toISOString(),
    ],
  );
}

async function upsertEmpty(env: Env, ticker: string, err: string, recordPeerAttempt = false): Promise<void> {
  // A clean miss keeps the error text.  Recording socratic on `source` is what
  // makes the ticker-shaped tombstone ineligible for a second retry.
  const peerSource = recordPeerAttempt ? 'socratic' : null;
  await run(
    env.DB,
    `INSERT INTO securities_ref (ticker, enriched_at, enrichment_error, source) VALUES (?,?,?,?)
     ON CONFLICT(ticker) DO UPDATE SET
       enriched_at=excluded.enriched_at,
       enrichment_error=excluded.enrichment_error,
       source=CASE
         WHEN ? = 0 THEN securities_ref.source
         WHEN securities_ref.source IS NULL OR securities_ref.source = '' THEN excluded.source
         WHEN securities_ref.source LIKE '%socratic%' THEN securities_ref.source
         ELSE securities_ref.source || '+socratic'
       END`,
    [ticker, new Date().toISOString(), err, peerSource, recordPeerAttempt ? 1 : 0],
  );
}

/**
 * Persist a transient-retry backoff marker for a ticker that hit a retryable
 * failure this run. Deliberately does NOT touch `enriched_at` (unlike
 * upsertEmpty) — leaving it untouched/NULL keeps the ticker selectable by the
 * base enrichmentNeededSql predicate, so it is retried (once eligible) rather
 * than permanently tombstoned.
 */
async function markTransientEnrichmentFailure(
  env: Env,
  ticker: string,
  priorEnrichmentError: string | null,
  now: number,
): Promise<void> {
  const marker = nextTransientRetryMarker(priorEnrichmentError, now);
  await run(
    env.DB,
    `INSERT INTO securities_ref (ticker, enrichment_error) VALUES (?, ?)
     ON CONFLICT(ticker) DO UPDATE SET enrichment_error = excluded.enrichment_error`,
    [ticker, marker],
  );
}
