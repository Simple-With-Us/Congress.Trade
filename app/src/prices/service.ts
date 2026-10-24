/**
 * src/prices/service.ts
 * OWNER: prices
 *
 * Price refresh. Per run: refresh the S&P 500 series once, then for the tickers
 * that most need it (newest-traded first, then backfill), fetch one EOD history
 * call each — which yields both the trade-date anchor and the current price —
 * and compute per-trade performance anchors. History comes from Socratic.Trade
 * (`APP_B_IMPORT_URL` + `APP_B_INGEST_TOKEN`). FMP, Massive, and Tiingo are not
 * price sources.
 */

import type { Env } from '../shared/types.ts';
import { ensurePriceUnavailableReasonColumn } from '../admin/ensurePeerSchema.ts';
import { all, batchPrepared, get, run } from '../shared/db.ts';
import {
  excludeCompetitorFixtureTransactionSql,
  tickerHasNonCompetitorFixtureTrade,
} from '../shared/competitorFixtures.ts';
import { getSharedFmpPacer } from '../shared/pace.ts';
import type { PriceClient } from './fmp.ts';
import { buildPeerPriceClient } from './peer.ts';
import type { Close } from './compute.ts';
import { resolveSecrets } from '../secrets/infisical.ts';

/**
 * Per-run ticker cap. Socratic.Trade serves EOD from its own database — no
 * metered FMP quota — so the bound is run duration. 5000 clears the traded
 * universe in one run. FMP_DAILY_CALL_CAP is not a price budget.
 */
const PEER_DAILY_CAP = 5000;
/**
 * How long a ticker stays negative-cached after a SECOND (or later) consecutive
 * empty EOD-history fetch before we retry it. Bounds the "delisted/foreign/
 * non-equity ticker can never be priced" set (~544 tickers) so it stops
 * re-selecting forever, while still letting a temporarily-empty ticker recover
 * on its own. Also the cadence for the stalled-listing negative cache below
 * (`price_unavailable = PRICE_UNAVAILABLE_STALLED`), unchanged from before this
 * file introduced the two-stage not-found backoff.
 */
const PRICE_UNAVAILABLE_RECHECK_DAYS = 30;
/**
 * How long a ticker stays negative-cached after its FIRST empty EOD-history
 * fetch. Shorter than the escalated tier above so a ticker that is merely
 * newly-listed, briefly delisted, or hit a one-off provider gap gets a fast
 * second look before falling back to the slower 30-day cadence on a second
 * consecutive miss (see `PRICE_UNAVAILABLE_NOT_FOUND` below).
 */
const PRICE_UNAVAILABLE_FIRST_RECHECK_DAYS = 7;
/**
 * If a successful fetch's newest close is older than this many days, the ticker's
 * price series has effectively stopped (delisted/halted) even though it still has
 * cached history. We negative-cache it (with the retry TTL) so it isn't
 * re-selected + re-fetched every single day. A generous bar keeps weekends,
 * holidays, and normal provider lag from ever tripping it — only a series that is
 * weeks stale gets marked.
 */
export const PRICE_STALE_LISTING_DAYS = 14;

/**
 * `securities_ref.price_unavailable` values. Kept as small non-negative
 * integers (no new migration needed — the column is already a plain,
 * unconstrained INTEGER) so the not-found backoff can have two escalating
 * stages while the pre-existing stalled-listing negative-cache keeps its own
 * distinct cadence:
 *   0                    — priced normally.
 *   1 (NOT_FOUND_FIRST)  — first consecutive empty-history result; 7-day recheck.
 *   2 (NOT_FOUND_AGAIN)  — second+ consecutive empty-history result; 30-day recheck.
 *   3 (STALLED)          — a fetch succeeded but its newest close is weeks stale
 *                          (PRICE_STALE_LISTING_DAYS); unchanged 30-day recheck.
 *   4 (NOT_COVERED)      — Socratic.Trade cannot price this ticker (repeat miss
 *                          or stuck-while-pending sweep, CT-2443); excluded from
 *                          every pending predicate UNCONDITIONALLY (no TTL) and
 *                          retried only by the daily not-covered re-check.
 */
// Exported (FIRST + NOT_COVERED) so the other pending predicates
// (admin/routes.ts's marketPending, export/priceNeeds.ts, prices/
// peerPricePending.ts) can mirror this file's CASE without re-deriving the
// magic numbers in a second file.
export const PRICE_UNAVAILABLE_NOT_FOUND_FIRST = 1;
const PRICE_UNAVAILABLE_NOT_FOUND_AGAIN = 2;
const PRICE_UNAVAILABLE_STALLED = 3;
export const PRICE_UNAVAILABLE_NOT_COVERED = 4;

/**
 * Shared `AND ...` clause excluding stage-4 (not covered by ST) tickers from
 * a pending predicate. Every pending predicate (selectTickersNeedingPrices,
 * the st_peer_prices SQL, marketPending, the price-needs export) uses this so
 * the exclusion cannot drift between the four copies. Unconditional — no TTL,
 * no binds.
 */
export function priceNotCoveredExclusionSql(srAlias = 'sr'): string {
  return `COALESCE(${srAlias}.price_unavailable, 0) <> ${PRICE_UNAVAILABLE_NOT_COVERED}`;
}

/** Repeat empty-history miss on a ticker already at stage 2 (rule a). */
export const NOT_COVERED_CAUSE_REPEAT_EMPTY = 'no EOD history after repeat re-check';
/** Repeat stale-listing result on a ticker already at stage 3 (rule a). */
export const NOT_COVERED_CAUSE_REPEAT_STALLED = 'stale listing after repeat re-check';
/** Pending with no price_checked_at progress for 72h while the corpus is fresh (rule b). */
export const NOT_COVERED_CAUSE_STUCK_PENDING = 'no price_checked_at progress for 72h while pending';

/** `st_not_covered since <ISO date>: <cause>` — the since-date is kept when the daily re-check restamps. */
export function notCoveredReason(now: Date, cause: string): string {
  return `st_not_covered since ${now.toISOString().slice(0, 10)}: ${cause}`;
}

/** Provider / import confirmed no EOD history for this symbol. */
export const PRICE_UNAVAILABLE_REASON_PEER_NO_EOD = 'socratic_no_eod_history';
/** Peer import push carried no closes and no cached price rows. */
export const PRICE_UNAVAILABLE_REASON_PEER_IMPORT_EMPTY = 'socratic_import_no_price';

const PRICE_UNAVAILABLE_REASON_MAX_LEN = 500;

function normalizePriceUnavailableReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) return PRICE_UNAVAILABLE_REASON_PEER_NO_EOD;
  return trimmed.length > PRICE_UNAVAILABLE_REASON_MAX_LEN
    ? trimmed.slice(0, PRICE_UNAVAILABLE_REASON_MAX_LEN)
    : trimmed;
}

/**
 * Negative-cache a ticker as unpriceable (excluded from pending price work and
 * the st_peer_prices stall detector). Uses the same two-stage not-found backoff
 * as an empty EOD fetch unless `stage` is set explicitly.
 */
export async function markTickerPriceUnavailable(
  env: Env,
  ticker: string,
  reason: string,
  opts: { checkedAt?: string; stage?: number; force?: boolean } = {},
): Promise<void> {
  const sym = ticker.trim().toUpperCase();
  if (!sym) return;
  if (!opts.force && !(await tickerHasNonCompetitorFixtureTrade(env, sym))) return;
  await ensurePriceUnavailableReasonColumn(env.DB);
  const nowIso = opts.checkedAt ?? new Date().toISOString();
  const reasonText = normalizePriceUnavailableReason(reason);
  const stageFirst = PRICE_UNAVAILABLE_NOT_FOUND_FIRST;
  const stageAgain = PRICE_UNAVAILABLE_NOT_FOUND_AGAIN;
  if (opts.stage != null) {
    await run(
      env.DB,
      `INSERT INTO securities_ref (ticker, price_unavailable, price_checked_at, price_unavailable_reason)
         VALUES (?, ?, ?, ?)
       ON CONFLICT(ticker) DO UPDATE SET
         price_unavailable = excluded.price_unavailable,
         price_checked_at = excluded.price_checked_at,
         price_unavailable_reason = excluded.price_unavailable_reason`,
      [sym, opts.stage, nowIso, reasonText],
    );
    return;
  }
  await run(
    env.DB,
    `INSERT INTO securities_ref (ticker, price_unavailable, price_checked_at, price_unavailable_reason)
       VALUES (?, ${stageFirst}, ?, ?)
     ON CONFLICT(ticker) DO UPDATE SET
       price_unavailable = CASE
         WHEN securities_ref.price_unavailable IN (${stageFirst}, ${stageAgain})
           THEN ${stageAgain}
         ELSE ${stageFirst}
       END,
       price_checked_at = excluded.price_checked_at,
       price_unavailable_reason = excluded.price_unavailable_reason`,
    [sym, nowIso, reasonText],
  );
}
type EnvX = Env & {
  FMP_MAX_PER_MINUTE?: string;
  APP_B_IMPORT_URL?: string;
  /** Bearer token for the peer's bearer-gated read endpoints. */
  APP_B_INGEST_TOKEN?: string;
};

interface PricePlan {
  client: PriceClient;
  /** Always false: prices are not metered against the FMP day counter. */
  fmpBudgeted: boolean;
  /** Always true when a plan exists: Socratic.Trade is the only price source. */
  peerOnly: boolean;
}

/**
 * EOD history is Socratic.Trade only. PRICE_PROVIDER, FMP_API_KEY, and
 * MASSIVE/TIINGO keys are ignored so a stale env cannot fall back to a vendor.
 * Missing peer config returns null (price refresh no-ops and diagnostics warn).
 */
function pricePlan(env: EnvX): PricePlan | null {
  if (!env.APP_B_IMPORT_URL || !env.APP_B_INGEST_TOKEN) return null;
  return {
    client: buildPeerPriceClient(env.APP_B_IMPORT_URL, fetch, env.APP_B_INGEST_TOKEN, {
      strict: true,
    }),
    fmpBudgeted: false,
    peerOnly: true,
  };
}

export interface PriceRefreshClient {
  client: PriceClient;
  fmpBudgeted: boolean;
  pace: () => Promise<void>;
}

/**
 * The price client + pacer runPriceRefresh uses, shared with the daily
 * not-covered re-check (CT-2443) so both lanes hit Socratic.Trade through the
 * same client and per-minute gate. Null when the peer is not configured.
 */
export async function buildPriceRefreshClient(
  env: Env,
  opts: { maxPerMinute?: number } = {},
): Promise<PriceRefreshClient | null> {
  const runtimeSecrets = await resolveSecrets(env, [
    'APP_B_IMPORT_URL',
    'APP_B_INGEST_TOKEN',
    'FMP_MAX_PER_MINUTE',
  ]);
  const envx = { ...(env as EnvX), ...runtimeSecrets };
  const plan = pricePlan(envx);
  if (!plan) return null;
  // Shared per-isolate FMP pacer (same instance enrichment + the disclosure
  // probe use), so concurrent FMP work stays under the per-minute cap together.
  // Fall back to FMP_MAX_PER_MINUTE when the caller omits it (e.g. an admin
  // endpoint), so the shared singleton isn't memoized into a no-op.
  const fmpMaxPerMinute =
    opts.maxPerMinute ?? (parseInt(envx.FMP_MAX_PER_MINUTE || '', 10) || undefined);
  return {
    client: plan.client,
    fmpBudgeted: plan.fmpBudgeted,
    pace: getSharedFmpPacer(fmpMaxPerMinute),
  };
}

/**
 * Statuses that mean the provider key/plan itself is broken, so every subsequent
 * call this run would fail identically (auth/plan) — as opposed to a one-off
 * transient blip (a plain 5xx/network error). Every price client (FMP, Massive,
 * Tiingo — see ./fmp.ts, ./massive.ts, ./tiingo.ts) throws
 * `<PROVIDER>_HTTP_<status>` for a non-2xx, non-404 response, so matching just
 * the numeric suffix (not the provider prefix) classifies all three uniformly.
 */
const FATAL_PRICE_PROVIDER_ERROR = /_HTTP_(401|402|403)$/;
/**
 * 429 is always run-fatal on the current peer-only EOD path.  Price refresh
 * talks only to Socratic.Trade (`fmpBudgeted` is always false); a rate-limited
 * peer would otherwise keep walking ~thousands of tickers with the same failure.
 * Auth/plan 401/402/403 stay fatal via FATAL_PRICE_PROVIDER_ERROR.  The
 * `fmpBudgeted` parameter is retained for call-site compatibility but no longer
 * gates 429 — there is no metered FMP price client on this path anymore.
 */
const RATE_LIMIT_PROVIDER_ERROR = /_HTTP_429$/;
export function isFatalPriceProviderError(e: unknown, _fmpBudgeted: boolean): boolean {
  const message = e instanceof Error ? e.message : String(e ?? '');
  if (FATAL_PRICE_PROVIDER_ERROR.test(message)) return true;
  return RATE_LIMIT_PROVIDER_ERROR.test(message);
}

function isoDaysAgo(days: number, from = new Date()): string {
  return new Date(from.getTime() - days * 86400000).toISOString().slice(0, 10);
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** True when the newest close is old enough that the series has effectively stopped (delisted/halted). */
export function isStaleListingDate(latestDate: string, now = new Date()): boolean {
  return latestDate < isoDaysAgo(PRICE_STALE_LISTING_DAYS, now);
}
/** Full ISO instant `days` before `from` (for TTL comparisons on price_checked_at). */
function isoInstantDaysAgo(days: number, from = new Date()): string {
  return new Date(from.getTime() - days * 86400000).toISOString();
}

/**
 * A negative-cached ticker whose price_checked_at is at or after this cutoff is
 * still excluded from pricing selection + the backfill pending count; older
 * than it, it's eligible for a re-check. This is the ESCALATED (30-day) tier —
 * a second-or-later consecutive not-found result, and the (unchanged) stalled-
 * listing cadence. Kept as the original name/signature (no `from` default
 * change, still exported) because `admin/routes.ts`'s `marketPending` imports
 * it directly with no args for its own simplified pending estimate.
 */
export function priceUnavailableCutoffIso(from = new Date()): string {
  return isoInstantDaysAgo(PRICE_UNAVAILABLE_RECHECK_DAYS, from);
}

/**
 * The FIRST-stage (7-day) not-found recheck cutoff — see
 * PRICE_UNAVAILABLE_NOT_FOUND_FIRST / PRICE_UNAVAILABLE_FIRST_RECHECK_DAYS.
 * Only a ticker's FIRST consecutive empty-history result uses this shorter
 * cutoff; a second (or later) consecutive miss escalates to the slower
 * `priceUnavailableCutoffIso` (30-day) cadence instead.
 */
export function priceUnavailableFirstRecheckCutoffIso(from = new Date()): string {
  return isoInstantDaysAgo(PRICE_UNAVAILABLE_FIRST_RECHECK_DAYS, from);
}

/** The current calendar date (Y/M/D) in US Eastern time, where the market close +
 *  EOD publish happen. Computed via Intl so it's DST-correct in the Worker. */
function easternYmd(from: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(from);
  const pick = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: pick('year'), m: pick('month'), d: pick('day') };
}

/**
 * The most recent COMPLETED US trading day (YYYY-MM-DD): the latest weekday
 * strictly before *today in US Eastern time*, walking back over Sat/Sun.
 *
 * Anchored on Eastern — NOT UTC — on purpose. The daily job fires at 00:00 UTC,
 * which is the PRIOR weekday's evening in ET, before that session's EOD close is
 * reliably published. A UTC-midnight "yesterday" bar (the earlier version) then
 * demanded a close that doesn't exist yet, so the newest tickers looked stale
 * every run and were re-selected forever — the whole daily budget churning the
 * same head of the list instead of draining the backlog. Using the ET calendar
 * day and requiring the weekday strictly before it keeps the bar at/behind what
 * providers have actually published. Market holidays aren't modeled (they'd
 * over-select ~9 days/yr, each now a cheap incremental fetch), only weekends.
 */
export function lastTradingDay(from = new Date()): string {
  const { y, m, d } = easternYmd(from);
  // Anchor the ET calendar day at UTC midnight so the day/weekend math is exact.
  const day = new Date(Date.UTC(y, m - 1, d));
  day.setUTCDate(day.getUTCDate() - 1); // the prior session (today's isn't published yet)
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

export interface PriceRefreshResult {
  hasFmpKey: boolean;
  spxUpdated: boolean;
  tickersPriced: number;
  tradesComputed: number;
  fmpCalls: number;
  budgetRemaining: number;
  dryRun: boolean;
  errors: string[];
  /** True when an auth/plan/rate-limit error (401/402/403/429) stopped the run
   *  early — see isFatalPriceProviderError.  Peer EOD is the only price path,
   *  so a 429 aborts rather than walking the full ticker list.  Remaining
   *  un-attempted tickers are left untouched for the next run. */
  aborted: boolean;
  /** True only when this run selected the WHOLE pending set (selection was not
   *  truncated by the budget) and walked it without aborting.  The CT-2443
   *  not-covered sweep relies on it:  a stale price_checked_at only means "ST
   *  had a chance and gave nothing" when the ticker was actually attempted. */
  attemptedAllPending: boolean;
  /** What THIS run actually fetched (for the App B outbound push — our delta only). */
  shareSpx: Close[];
  sharePrices: Array<{ ticker: string; closes: Close[]; currentPrice: number; currentPriceDate: string }>;
}

/**
 * Tickers that have trades and missing or stale cached prices, OLDEST-traded
 * first (by `cursor_seq` ASC). Newest-first used to mean a steady inflow of
 * newly-traded tickers could perpetually crowd out the tail of the backlog —
 * every day's fresh trades sort ahead of it, so a ticker stuck at the back
 * (still unpriced, still stale) could starve indefinitely under a budget that
 * never quite covers the whole pending set. Oldest-first guarantees FIFO
 * drain: the longest-waiting tickers are always attempted first, so the
 * backlog actually shrinks over time instead of shuffling in place.
 *
 * Freshness is judged against the last COMPLETED trading day (not calendar
 * yesterday) so a ticker already carrying Friday's close isn't re-selected all
 * weekend. Negative-cached tickers are excluded per their OWN stage-based TTL
 * (see PRICE_UNAVAILABLE_NOT_FOUND_FIRST/_AGAIN/_STALLED above): a ticker's
 * first empty result gets a fast 7-day recheck, escalating to the slower
 * 30-day cadence on a second (or later) consecutive miss, or for a stalled
 * listing — so the pool actually drains. Stage-4 (not covered by ST) tickers
 * are excluded unconditionally, outside any TTL. Selection reads the maintained,
 * indexed `securities_ref.latest_price_date` instead of scanning the whole
 * price_eod table with a `MAX(date) GROUP BY ticker` subquery.
 */
export async function selectTickersNeedingPrices(
  env: Env,
  limit: number,
  opts: { freshThrough?: string; unavailableCutoff?: string; firstUnavailableCutoff?: string } = {},
): Promise<string[]> {
  if (limit <= 0) return [];
  const freshThrough = opts.freshThrough ?? lastTradingDay();
  const unavailableCutoff = opts.unavailableCutoff ?? priceUnavailableCutoffIso();
  const firstUnavailableCutoff = opts.firstUnavailableCutoff ?? priceUnavailableFirstRecheckCutoffIso();
  const rows = await all<{ ticker: string }>(
    env.DB,
    `SELECT t.ticker AS ticker
       FROM transactions t
       LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
      WHERE t.ticker IS NOT NULL AND t.ticker <> '' AND t.tx_date IS NOT NULL AND t.tx_date >= '1990-01-01'
        AND ${excludeCompetitorFixtureTransactionSql('t')}
        AND t.deprecated_at IS NULL
        AND (
          sr.latest_price_date IS NULL
          OR sr.latest_price_date < ?
          OR NOT EXISTS (SELECT 1 FROM price_eod pe WHERE pe.ticker = t.ticker)
          -- Do NOT re-select solely on current_price IS NULL: that would
          -- perpetually re-queue tickers that already have a fresh
          -- latest_price_date (termination guarantee). Stamp missing
          -- current_price from local price_eod via backfillCurrentPricesFromEod
          -- before the peer refresh instead.  DO re-select when metadata says
          -- fresh but there is no local price_eod — otherwise two tickers can
          -- sit forever with a stamped latest_price_date and never re-price.
        )
        AND NOT (
          COALESCE(sr.price_unavailable, 0) <> 0
          AND sr.price_checked_at IS NOT NULL
          AND sr.price_checked_at >= CASE
                WHEN sr.price_unavailable = ${PRICE_UNAVAILABLE_NOT_FOUND_FIRST} THEN ?
                ELSE ?
              END
        )
        AND ${priceNotCoveredExclusionSql('sr')}
      GROUP BY t.ticker
      ORDER BY MAX(t.cursor_seq) ASC
      LIMIT ?`,
    [freshThrough, firstUnavailableCutoff, unavailableCutoff, limit],
  );
  return rows.map((r) => r.ticker);
}

/**
 * Cheap local repair: stamp securities_ref.current_price / current_price_date /
 * latest_price_date from the newest price_eod row when those anchors are NULL
 * but history already exists. No provider calls. Fixes the common bulk-load /
 * partial-import gap where EOD rows landed without the display-critical
 * current-price columns, which starves performance leaderboards and the UI.
 */
export async function backfillCurrentPricesFromEod(
  env: Env,
): Promise<{ currentPriceFilled: number; latestDateFilled: number }> {
  const latest = await run(
    env.DB,
    `UPDATE securities_ref
        SET latest_price_date = (
          SELECT MAX(pe.date) FROM price_eod pe WHERE pe.ticker = securities_ref.ticker
        )
      WHERE latest_price_date IS NULL
        AND EXISTS (SELECT 1 FROM price_eod pe WHERE pe.ticker = securities_ref.ticker)`,
  );
  const current = await run(
    env.DB,
    `UPDATE securities_ref
        SET current_price = (
              SELECT pe.close FROM price_eod pe
               WHERE pe.ticker = securities_ref.ticker
               ORDER BY pe.date DESC LIMIT 1
            ),
            current_price_date = (
              SELECT pe.date FROM price_eod pe
               WHERE pe.ticker = securities_ref.ticker
               ORDER BY pe.date DESC LIMIT 1
            )
      WHERE current_price IS NULL
        AND EXISTS (SELECT 1 FROM price_eod pe WHERE pe.ticker = securities_ref.ticker)`,
  );
  return {
    currentPriceFilled: current.meta?.changes ?? 0,
    latestDateFilled: latest.meta?.changes ?? 0,
  };
}

export interface TickerEodFetchPlan {
  trades: Array<{ id: string; tx_date: string }>;
  from: string;
  to: string;
}

/**
 * Per-ticker EOD fetch window, shared by runPriceRefresh and the daily
 * not-covered re-check (CT-2443). Null when the ticker has no dated trades.
 * Decide the fetch window from the CACHED coverage (min + max date):
 *  - cold cache (no rows): fetch the full trade-based history once.
 *  - a gap below the cache (oldest trade predates the earliest cached close,
 *    e.g. a historical backfill added an older trade): fetch from the oldest
 *    trade so its trade/filing anchors can be computed.
 *  - otherwise the historical range is already complete: use the cheap 7-day
 *    incremental window off the latest cached close. This is the key guard —
 *    without checking the earliest cached close, a ticker whose oldest trade
 *    predates its cache (i.e. essentially every ticker) would re-download its
 *    entire multi-year series every stale day; the no-op upsert guard avoids
 *    row writes but not the provider transfer or per-row D1 work.
 */
export async function planTickerEodFetch(
  env: Env,
  ticker: string,
): Promise<TickerEodFetchPlan | null> {
  const trades = await all<{ id: string; tx_date: string }>(
    env.DB,
    `SELECT t.id AS id, t.tx_date AS tx_date
       FROM transactions t
      WHERE t.ticker = ? AND t.tx_date IS NOT NULL AND t.tx_date <> '' AND t.tx_date >= '1990-01-01'`,
    [ticker],
  );
  if (trades.length === 0) return null;

  const cached = await get<{ mn: string | null; mx: string | null }>(
    env.DB,
    'SELECT MIN(date) AS mn, MAX(date) AS mx FROM price_eod WHERE ticker = ?',
    [ticker],
  );
  let oldestTrade: string | null = null;
  for (const t of trades) {
    if (t.tx_date < '1990-01-01') continue;
    if (oldestTrade == null || t.tx_date < oldestTrade) oldestTrade = t.tx_date;
  }
  let from: string;
  if (!oldestTrade) {
    from = cached?.mx ? isoDaysAgo(7, new Date(cached.mx)) : isoDaysAgo(365 * 5);
  } else if (cached?.mx) {
    const hasGapBelowCache = cached.mn != null && oldestTrade < cached.mn;
    from = hasGapBelowCache
      ? isoDaysAgo(7, new Date(oldestTrade))
      : isoDaysAgo(7, new Date(cached.mx));
  } else {
    from = isoDaysAgo(7, new Date(oldestTrade));
  }
  return { trades, from, to: today() };
}

export interface TickerEodWriteOpts {
  /** price_unavailable stage to stamp (0 clears; 4 also stamps `reason`). */
  stage: number;
  /** Only written when stage is NOT_COVERED; stages 0/3 clear the reason. */
  reason?: string | null;
}

/**
 * The one upsert path for a successful non-empty EOD fetch, shared by
 * runPriceRefresh and the daily not-covered re-check: cache closes (no-op
 * guard skips unchanged rows in the re-fetched overlap window), record
 * current_price / latest_price_date + the market-cap recompute, stamp the
 * given stage, and recompute per-trade anchors from the CACHED price_eod /
 * spx_eod series. `hist[0]` must be the newest close (clients normalize to
 * date-descending).
 */
export async function writeTickerEodHistory(
  env: Env,
  ticker: string,
  hist: Close[],
  nowIso: string,
  opts: TickerEodWriteOpts,
): Promise<void> {
  for (let i = 0; i < hist.length; i += 100) {
    await batchPrepared(
      env.DB,
      hist.slice(i, i + 100).map((c) =>
        env.DB.prepare(
          'INSERT INTO price_eod (ticker, date, close) VALUES (?, ?, ?) ON CONFLICT(ticker, date) DO UPDATE SET close=excluded.close WHERE price_eod.close <> excluded.close',
        ).bind(ticker, c.date, c.close),
      ),
    );
  }
  // Current price = latest cached close; record latest_price_date (the indexed
  // column selection + freshness read from instead of scanning price_eod).
  // When we know the share count, recompute market_cap (= shares_outstanding *
  // price) + its bucket so the cap tracks the latest close. The bucket
  // thresholds mirror marketCapBucket() in enrichment/compute.ts.
  const latest = hist[0];
  await run(
    env.DB,
    `INSERT INTO securities_ref (ticker, current_price, current_price_date, latest_price_date, price_unavailable, price_checked_at, price_unavailable_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ticker) DO UPDATE SET
       current_price=excluded.current_price,
       current_price_date=excluded.current_price_date,
       latest_price_date=excluded.latest_price_date,
       price_unavailable=excluded.price_unavailable,
       price_checked_at=excluded.price_checked_at,
       price_unavailable_reason=CASE
         WHEN excluded.price_unavailable = ${PRICE_UNAVAILABLE_NOT_COVERED} THEN excluded.price_unavailable_reason
         WHEN excluded.price_unavailable IN (0, ${PRICE_UNAVAILABLE_STALLED}) THEN NULL
         ELSE securities_ref.price_unavailable_reason END,
       market_cap = CASE
         WHEN securities_ref.shares_outstanding IS NOT NULL AND securities_ref.shares_outstanding > 0
           THEN securities_ref.shares_outstanding * excluded.current_price
         ELSE securities_ref.market_cap END,
       market_cap_bucket = CASE
         WHEN securities_ref.shares_outstanding IS NULL OR securities_ref.shares_outstanding <= 0
           THEN securities_ref.market_cap_bucket
         WHEN securities_ref.shares_outstanding * excluded.current_price >= 200000000000 THEN 'mega'
         WHEN securities_ref.shares_outstanding * excluded.current_price >=  10000000000 THEN 'large'
         WHEN securities_ref.shares_outstanding * excluded.current_price >=   2000000000 THEN 'mid'
         WHEN securities_ref.shares_outstanding * excluded.current_price >=    300000000 THEN 'small'
         WHEN securities_ref.shares_outstanding * excluded.current_price >=     50000000 THEN 'micro'
         ELSE 'nano' END`,
    [
      ticker,
      latest.close,
      latest.date,
      latest.date,
      opts.stage,
      nowIso,
      opts.reason ?? null,
    ],
  );
  // Per-trade anchors: recompute from the CACHED price_eod / spx_eod series (not
  // the freshly-fetched window, which now spans only recent days) so narrowing
  // the fetch never overwrites historical trade/filing anchors with nulls.
  // Filing anchor = the close on/before the disclosure date (the only price a
  // copy-trader could have acted on), falling back to the trade date.
  //
  // spx_at_trade/spx_at_filing use COALESCE(newly-computed, existing row's
  // value) on conflict — NOT a blind overwrite. This ticker's OWN price fetch
  // just succeeded (we're past the `hist.length === 0` guard above), but the
  // S&P side is a SEPARATE, once-per-run fetch (step 1) that can fail or only
  // partially extend spx_eod independently of this ticker's price success. A
  // blind `spx_at_trade=excluded.spx_at_trade` would then null out a
  // previously-good anchor whenever this run's spx_eod coverage doesn't (yet)
  // reach a given trade/filing date — preserving the last good anchor instead
  // is strictly safer than regressing a known value to null.
  await run(
    env.DB,
    `INSERT INTO tx_performance (tx_id, price_at_trade, spx_at_trade, price_at_filing, spx_at_filing, computed_at)
     SELECT t.id,
       (SELECT close FROM price_eod p WHERE p.ticker = t.ticker AND p.date <= t.tx_date ORDER BY p.date DESC LIMIT 1),
       (SELECT close FROM spx_eod s WHERE s.date <= t.tx_date ORDER BY s.date DESC LIMIT 1),
       (SELECT close FROM price_eod p WHERE p.ticker = t.ticker AND p.date <= COALESCE(f.filed_date, f.first_seen_at, t.tx_date) ORDER BY p.date DESC LIMIT 1),
       (SELECT close FROM spx_eod s WHERE s.date <= COALESCE(f.filed_date, f.first_seen_at, t.tx_date) ORDER BY s.date DESC LIMIT 1),
       ?
     FROM transactions t
     LEFT JOIN filings f ON f.doc_id = t.doc_id
     WHERE t.ticker = ? AND t.tx_date IS NOT NULL AND t.tx_date <> '' AND t.tx_date >= '1990-01-01'
     ON CONFLICT(tx_id) DO UPDATE SET
       price_at_trade=excluded.price_at_trade,
       spx_at_trade=COALESCE(excluded.spx_at_trade, tx_performance.spx_at_trade),
       price_at_filing=excluded.price_at_filing,
       spx_at_filing=COALESCE(excluded.spx_at_filing, tx_performance.spx_at_filing),
       computed_at=excluded.computed_at`,
    [nowIso, ticker],
  );
}

export async function runPriceRefresh(
  env: Env,
  opts: { max?: number; dryRun?: boolean; maxPerMinute?: number; signal?: AbortSignal } = {},
): Promise<PriceRefreshResult> {
  const dryRun = opts.dryRun === true;
  const result: PriceRefreshResult = {
    hasFmpKey: false,
    spxUpdated: false,
    tickersPriced: 0,
    tradesComputed: 0,
    fmpCalls: 0,
    budgetRemaining: 0,
    dryRun,
    errors: [],
    aborted: false,
    attemptedAllPending: false,
    shareSpx: [],
    sharePrices: [],
  };
  const plan = await buildPriceRefreshClient(env, { maxPerMinute: opts.maxPerMinute });
  if (!plan) return result; // no usable price provider configured
  const { client, fmpBudgeted, pace } = plan;

  const cap = PEER_DAILY_CAP;
  let budget = opts.max ?? cap;
  result.budgetRemaining = budget;
  if (budget <= 0) return result;

  let calls = 0;

  // 1) Refresh the S&P 500 series (one call). Same gap-based window as per-ticker:
  //    backfill from the oldest trade only when the cached SPX series doesn't yet
  //    cover it (so older trades' spx_at_trade/spx_at_filing anchors can be
  //    computed); once complete, use the cheap 7-day incremental window instead of
  //    re-downloading the whole ~3,500-row series every run.
  const spxCached = await get<{ mn: string | null; mx: string | null }>(
    env.DB,
    'SELECT MIN(date) AS mn, MAX(date) AS mx FROM spx_eod',
  );
  const oldestTradeRow = await get<{ d: string | null }>(
    env.DB,
    // Year 1202 (and any other pre-market garbage) must not force a full-history
    // pull on every run. Seven such rows were keeping the S&P window open back
    // to the 13th century, so the cheap 7-day incremental path never ran.
    "SELECT MIN(tx_date) AS d FROM transactions WHERE tx_date >= '1990-01-01'",
  );
  let spxFrom: string;
  if (spxCached?.mx) {
    const hasGapBelowCache =
      oldestTradeRow?.d != null && spxCached.mn != null && oldestTradeRow.d < spxCached.mn;
    spxFrom = hasGapBelowCache
      ? isoDaysAgo(7, new Date(oldestTradeRow.d as string))
      : isoDaysAgo(7, new Date(spxCached.mx));
  } else {
    spxFrom = oldestTradeRow?.d ? isoDaysAgo(7, new Date(oldestTradeRow.d)) : isoDaysAgo(365 * 5);
  }
  let spx: Close[] = [];
  try {
    await pace();
    // Count the ATTEMPT (not just a successful outcome) against the shared
    // daily meter: the provider bills/rate-limits every request it receives,
    // whether it 2xxs, 404s, or 429s, so an attempt that throws still spent
    // real quota and must not be under-reported to addDailyUsed below.
    calls++;
    budget--;
    spx = await client.spxHistory(spxFrom, today());
    if (spx.length && !dryRun) {
      for (let i = 0; i < spx.length; i += 100) {
        await batchPrepared(
          env.DB,
          spx.slice(i, i + 100).map((c) =>
            env.DB.prepare(
              // No-op guard: only write when the close actually changed, so the
              // re-fetched overlap window doesn't churn identical rows.
              'INSERT INTO spx_eod (date, close) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET close=excluded.close WHERE spx_eod.close <> excluded.close',
            ).bind(c.date, c.close),
          ),
        );
      }
      result.spxUpdated = true;
      result.shareSpx = spx;
    }
  } catch (e) {
    result.errors.push('spx: ' + (e as Error).message);
    // Auth/plan/rate-limit failure: every subsequent call this run (SPX or any
    // ticker) would fail the same way, so abort rather than walking the rest of
    // the ticker list.  Remaining tickers are left untouched for the next run —
    // no negative-cache writes, no partial state.  Peer EOD treats 429 as fatal
    // (see RATE_LIMIT_PROVIDER_ERROR) so a rate-limited Socratic.Trade cannot
    // burn thousands of identical retries in one refresh.
    if (isFatalPriceProviderError(e, fmpBudgeted)) result.aborted = true;
  }

  // 2) Per-ticker EOD history + per-trade performance anchors. Skipped
  // entirely once the run has been aborted above.
  if (!result.aborted) {
    // #2724 writes price_unavailable_reason.  Coolify does not run migrate,
    // so the column is added here or the ticker INSERT throws and the
    // pending-set clock never moves (CT-2409).
    await ensurePriceUnavailableReasonColumn(env.DB);
  }
  const selectBudget = budget;
  const tickers = result.aborted ? [] : await selectTickersNeedingPrices(env, budget);
  for (const ticker of tickers) {
    if (opts.signal?.aborted) {
      result.aborted = true;
      break;
    }
    if (budget <= 0) break;
    const nowIso = new Date().toISOString();
    const fetchPlan = await planTickerEodFetch(env, ticker);
    if (!fetchPlan) continue;
    const { trades, from, to } = fetchPlan;
    let hist: Close[] = [];
    try {
      await pace();
      // Count the attempt regardless of outcome (see the SPX comment above).
      calls++;
      budget--;
      hist = await client.eodHistory(ticker, from, to);
    } catch (e) {
      result.errors.push(ticker + ': ' + (e as Error).message);
      if (isFatalPriceProviderError(e, fmpBudgeted)) {
        // Same auth/plan/rate-limit will fail identically for every remaining
        // ticker — abort the whole run instead of walking thousands of peers
        // that cannot succeed.  Tickers not yet reached this run are left
        // completely untouched (no negative-cache write) for next time.
        result.aborted = true;
        break;
      }
      continue;
    }
    if (hist.length === 0) {
      // Reaching here means the provider returned a CONFIRMED empty result (a 2xx
      // with no rows, or a 404 "unknown symbol") — the price clients THROW on
      // transient/global failures (401/402/403/429/5xx), which are caught above
      // and skip the ticker without marking it. So an empty here is a genuine
      // "no closes for this ticker" (delisted, foreign, or non-equity), never a
      // rate-limit/outage. Negative-cache it: without this, the backfill loop's
      // done:true — which requires "traded tickers with no price_eod row == 0" —
      // is unreachable for the ~544 such tickers, so the loop (and its D1
      // write/read spend) never stopped. Two-stage backoff: the FIRST
      // consecutive miss gets a fast 7-day recheck (PRICE_UNAVAILABLE_NOT_
      // FOUND_FIRST); a SECOND (or later) consecutive miss escalates to the
      // slower 30-day cadence (PRICE_UNAVAILABLE_NOT_FOUND_AGAIN) — see
      // selectTickersNeedingPrices. A ticker that was previously priced or
      // stalled (not already in a not-found streak) always restarts at stage 1.
      // CT-2443 rule (a): a repeat miss on a ticker ALREADY at stage 2 (i.e.
      // the 30-day re-check that ended in another miss) terminates at stage 4
      // (not covered by ST) instead of cycling 2 → 2 forever.
      if (!dryRun) {
        const prev = await get<{ price_unavailable: number | null }>(
          env.DB,
          'SELECT price_unavailable FROM securities_ref WHERE ticker = ?',
          [ticker],
        );
        if (Number(prev?.price_unavailable ?? 0) === PRICE_UNAVAILABLE_NOT_FOUND_AGAIN) {
          await markTickerPriceUnavailable(
            env,
            ticker,
            notCoveredReason(new Date(nowIso), NOT_COVERED_CAUSE_REPEAT_EMPTY),
            { checkedAt: nowIso, stage: PRICE_UNAVAILABLE_NOT_COVERED },
          );
        } else {
          await markTickerPriceUnavailable(env, ticker, PRICE_UNAVAILABLE_REASON_PEER_NO_EOD, {
            checkedAt: nowIso,
          });
        }
      }
      continue;
    }
    result.tickersPriced++;
    if (dryRun) continue;

    // If the newest available close is weeks stale, the series has stopped
    // (delisted/halted) even though the fetch wasn't empty — negative-cache it
    // (TTL-bounded) so it isn't re-selected + re-fetched daily forever;
    // otherwise clear any prior negative-cache. CT-2443 rule (a): a stale
    // result on a ticker ALREADY at stage 3 terminates at stage 4 (not
    // covered by ST) instead of cycling 3 → 3 forever.
    const latest = hist[0];
    const priceStalled = isStaleListingDate(latest.date);
    let stage = priceStalled ? PRICE_UNAVAILABLE_STALLED : 0;
    let reason: string | null = null;
    if (priceStalled) {
      const prev = await get<{ price_unavailable: number | null }>(
        env.DB,
        'SELECT price_unavailable FROM securities_ref WHERE ticker = ?',
        [ticker],
      );
      if (Number(prev?.price_unavailable ?? 0) === PRICE_UNAVAILABLE_STALLED) {
        stage = PRICE_UNAVAILABLE_NOT_COVERED;
        reason = notCoveredReason(new Date(nowIso), NOT_COVERED_CAUSE_REPEAT_STALLED);
      }
    }
    await writeTickerEodHistory(env, ticker, hist, nowIso, { stage, reason });
    result.sharePrices.push({ ticker, closes: hist, currentPrice: latest.close, currentPriceDate: latest.date });
    result.tradesComputed += trades.length;
  }

  result.attemptedAllPending =
    !result.aborted && !dryRun && selectBudget > 0 && tickers.length < selectBudget;
  result.fmpCalls = calls;
  result.budgetRemaining = Math.max(0, budget);
  return result;
}

/** The latest cached S&P close (for read-time current-return computation). */
export async function latestSpxClose(env: Env): Promise<number | null> {
  const row = await get<{ close: number }>(env.DB, 'SELECT close FROM spx_eod ORDER BY date DESC LIMIT 1');
  return row ? row.close : null;
}
