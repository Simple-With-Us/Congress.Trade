/**
 * src/ingestion/tradeLatency.ts
 * OWNER: ingestion
 *
 * Provider-latency monitor for congressional disclosures. Candidates are
 * created when congress.trade first sees a new filing; provider observations
 * are populated from third-party "latest" endpoints. The public comparison
 * is deliberately limited to the intersection of both feeds and publishes
 * the provider-observed denominator separately, so a congress.trade miss
 * cannot silently turn into a speed win.
 */

import type { Env, Transaction } from '../shared/types.ts';
import { all, run, batch, get } from '../shared/db.ts';
import type { SqlParam } from '../shared/db.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { notifyAdmin } from '../alerts/notify.ts';
import { assertFmpTierOk } from '../shared/fmpStatus.ts';
import { getLastPollAt, setLastPollAt } from '../shared/config.ts';
import type { DiscoveredFiling } from './watcher.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import { cleanFilerName } from '../extraction/nameNormalizer.ts';
import { resolveExecutiveFilerIdFromName } from '../shared/executiveIdentity.ts';
import {
  DEFAULT_PROBE_SCHEDULE_CONFIG,
  probeScheduleConfigFromEnv,
  probeTierAt,
  probeYieldWeightAt,
  type ProbeScheduleConfig,
} from './probeSchedule.ts';
import { logProbeCadence } from './probeCadenceLog.ts';
import { ALL_CHAMBERS, previousSuccessfulProbeAt, recordProbeRun } from './probeRunLog.ts';
import { scheduleCtPublishSnapshot } from './latencyPriceSnapshots.ts';
import {
  closeProviderMissingStubIfOfficialPersisted,
  enqueueOfficialSenateFromProviderObservation,
  findOfficialCounterpartDocIdForObservation,
} from './providerMissingStubClose.ts';
import { createProxiedFetch, resolveResidentialProxyUrl } from '../shared/proxyFetch.ts';

type Chamber = 'house' | 'senate' | 'executive';
/**
 * Latency race providers. FMP family lives here (and on Mac scout) — not on
 * Socratic.Trade product surfaces. `fmp` = direct stable host; `fmp_rapidapi` =
 * RapidAPI alternate path. When both paths are enabled we **alternate**
 * (exactly one avenue per probe cycle) so free-tier daily quotas are not
 * doubled for the same answer a minute apart.
 */
export type ProviderId =
  | 'fmp'
  | 'fmp_rapidapi'
  | 'unusual_whales'
  | 'quiver'
  | 'finnhub'
  | 'ainvest'
  | 'capitol_trades';

/** Operational lifecycle for a latency source (admin + scout badges). */
export type LatencySourceStatus = 'off' | 'running' | 'error' | 'stopped' | 'unknown';

/** FMP family provider ids (CT latency + Mac scout only). */
export const FMP_FAMILY_PROVIDER_IDS: readonly ProviderId[] = ['fmp', 'fmp_rapidapi'] as const;

export function isFmpFamilyProvider(id: string): boolean {
  return (FMP_FAMILY_PROVIDER_IDS as readonly string[]).includes(id);
}

type EnvWithWatch = Env & {
  DISCLOSURE_LATENCY_WATCH_ENABLED?: string;
  DISCLOSURE_LATENCY_PROVIDERS?: string;
  DISCLOSURE_LATENCY_WATCH_LIMIT?: string;
  /** @deprecated Latency probes use FMP_LATENCY_API_KEY (+ secondary) only. */
  FMP_API_KEY?: string;
  FMP_DAILY_CALL_CAP?: string;
  FMP_DISCLOSURE_WATCH_ENABLED?: string;
  FMP_DISCLOSURE_WATCH_LIMIT?: string;
  UNUSUAL_WHALES_API_KEY?: string;
  /** Alias used in Infisical (no underscores in “unusualwhales”). */
  UNUSUALWHALES_API_KEY?: string;
  QUIVER_API_KEY?: string;
  QUIVER_API_TOKEN?: string;
  FINNHUB_API_KEY?: string;
  AINVEST_API_KEY?: string;
  UW_DEEP_MATCH_DATES_PER_RUN?: string;
  /** Daily HTTP call budget for Unusual Whales latency probes (default 240). */
  UW_LATENCY_DAILY_CAP?: string;
  /** Daily HTTP call budget for Quiver latency probes (default 360; 3 calls/run). */
  QUIVER_LATENCY_DAILY_CAP?: string;
  /** Free-tier keys reserved for disclosure-latency probes only. */
  FMP_LATENCY_API_KEY?: string;
  /** Per-key daily cap for latency probes (default 235; free plan is 250). */
  FMP_LATENCY_DAILY_CAP?: string;
  /**
   * Master switch for FMP-family latency probes (stable + RapidAPI paths).
   * Default OFF — no FMP spend until operator sets true/1/yes/on.
   * Independent of DISCLOSURE_LATENCY_WATCH_ENABLED (UW/QQ can still run).
   */
  FMP_LATENCY_PROBE_ENABLED?: string;
  /**
   * Comma-separated FMP path ids eligible when FMP_LATENCY_PROBE_ENABLED is on:
   * `stable` (id=fmp) and/or `rapidapi` (id=fmp_rapidapi).
   * Default **stable only**. RapidAPI FMP authenticates (`/v3/profile/AAPL`
   * 200) but has no house/senate-latest (404) and no OGE/executive-latest
   * (stable 404; RapidAPI 400, same as company key-executives — not an OGE
   * feed). Rechecked 2026-09-04. Dual free-tier keys on stable are the
   * congress probe. Opt in with `stable,rapidapi` only if the marketplace
   * later lists those disclosure endpoints; when both are enabled the probe
   * loop **rotates** (one path per cycle).
   */
  FMP_LATENCY_PATHS?: string;
  /** Override base for stable FMP disclosures (default financialmodelingprep.com/stable). */
  FMP_STABLE_BASE_URL?: string;
  /** Override base for RapidAPI FMP disclosures. */
  FMP_RAPIDAPI_BASE_URL?: string;
  /** RapidAPI host header (default financial-modeling-prep.p.rapidapi.com). */
  FMP_RAPIDAPI_HOST?: string;
  /**
   * Optional dedicated RapidAPI key for FMP path. Preferred over shared
   * RAPIDAPI_KEY. Never falls back to free-tier FMP_LATENCY_* (those are
   * native FMP query keys; RapidAPI marketplace needs a RapidAPI key).
   */
  FMP_RAPIDAPI_KEY?: string;
  /**
   * Shared RapidAPI marketplace key (Socratic.Trade convention). One account
   * key for all RapidAPI-hosted products; CT uses it only for FMP latency /
   * scout when FMP_RAPIDAPI_KEY is unset.
   */
  RAPIDAPI_KEY?: string;
  /** Daily HTTP call budget for FMP-via-RapidAPI path (default 500). */
  FMP_RAPIDAPI_DAILY_CAP?: string;
};

interface CandidateRow {
  trade_hash: string;
  doc_id: string;
  provider: ProviderId;
  chamber: Chamber;
  source_url: string | null;
  filed_date: string | null;
  filer_name: string | null;
  ticker: string | null;
  tx_date: string | null;
  tx_type: string | null;
  congress_first_seen_at: string;
  attempts: number;
}

interface ProviderObservationRow {
  provider: ProviderId;
  chamber: Chamber;
  provider_key: string;
  trade_hash: string;
  first_observed_at: string;
  last_observed_at: string;
  provider_published_at: string | null;
  source_url: string | null;
  filed_date: string | null;
  filer_name: string | null;
  payload: string | null;
  /** Last successful probe of this lane strictly before first_observed_at, or
   *  null when none exists (cold start). Publication window lower bound —
   *  see probeRunLog.ts. Not selected by every query site; only populated
   *  where the caller needs it to bracket trade_latency_candidates.provider_window_*. */
  prev_probe_at?: string | null;
}

export interface DisclosureProviderRow {
  provider: ProviderId;
  chamber: Chamber;
  providerKey: string;
  tradeHash: string;
  payload: Record<string, unknown>;
  sourceUrl: string | null;
  filedDate: string | null;
  filerName: string | null;
  providerPublishedAt: string | null;
}

export type FmpDisclosureRow = DisclosureProviderRow;

export interface CandidateMatch {
  providerKey: string;
  matchMethod: string;
}

export interface DisclosureLatencyProviderStatus {
  id: ProviderId;
  label: string;
  configured: boolean;
  requiresMembership: boolean;
  supportsDirectLatest: boolean;
  timestampKind: 'provider' | 'monitor' | 'none';
  /**
   * Lifecycle badge for admin/scout UI:
   *  - off     intentional disable (grey) — default for FMP family
   *  - running probe path active (green)
   *  - error   enabled but failing (red)
   *  - stopped would run but missing keys/config (red-ish / warn)
   *  - unknown cannot determine
   */
  operationalStatus: LatencySourceStatus;
  /** Path family tag for multi-path providers (e.g. fmp stable vs rapidapi). */
  pathId?: string;
  reason?: string;
}

export interface DisclosureLatencyProviderRun extends DisclosureLatencyProviderStatus {
  enabled: boolean;
  fetchedRows: number;
  pending: number;
  matched: number;
  errors: string[];
}

export interface DisclosureLatencyProbeResult {
  enabled: boolean;
  reason?: string;
  fetchedRows: number;
  pending: number;
  matched: number;
  errors: string[];
  providers: DisclosureLatencyProviderRun[];
}

/**
 * Whether a lane's coverage ratio is trustworthy enough to publish.
 * `contradiction` is a self-check failure, not a measurement.
 */
export type CoverageIntegrity = 'ok' | 'contradiction';

/** Whether this lane's stored observations have usable filer identity. */
export type ParserHealth = 'ok' | 'unhealthy';

export interface DisclosureLatencyProviderMetrics {
  provider: ProviderId;
  label: string;
  /** Lifecycle for scoreboard (FMP family defaults to off). */
  operationalStatus?: LatencySourceStatus;
  /** Set on publicSummary rows: whether the public scoreboard paints this lane. */
  publiclyShown?: boolean;
  candidates: number;
  /**
   * Concurrent races only (both first-seen in window, |delta| ≤ max concurrent
   * hours). Drives lead/win stats and preliminary/usable gates.
   */
  matched: number;
  /** High-confidence overlap matches in the score window (coverage density). */
  strongMatched: number;
  /**
   * Pairings in the score window that left one identity axis unverified
   * (see {@link matchStrength}). Reported, never folded into the headline.
   */
  weakMatched: number;
  pending: number;
  errored: number;
  /** Rows observed by the provider during the active monitor window. */
  providerObserved: number;
  /** Provider rows old enough that a late congress.trade match is no longer pending. */
  maturedProviderObserved: number;
  /** Provider rows with NO pairing of any strength after the grace period. */
  unmatchedProvider: number;
  /**
   * Matured unmatched rows after the corpus pass — CT has no transaction with
   * this lastName/ticker/date/side, regardless of import path.
   */
  unmatchedProviderCtMissing: number;
  /**
   * Matured provider rows that pair only via {@link CORPUS_MATCH_METHOD}:
   * congress.trade has the trade, but the CT copy was seed / backfill /
   * historical-lag and was never eligible to race. Not a coverage miss.
   */
  unmatchedProviderCtExcluded: number;
  /**
   * Provider rows we stored whose trade hash has no filer segment, so nothing
   * could ever match them. Non-zero means a provider parser is broken — this
   * is the alarm that would have caught FMP's 309-of-309 silent failure.
   */
  observedRowsMissingFiler: number;
  /** `unhealthy` = enough rows with empty filer hashes that a win/loss claim is not publishable. */
  parserHealth: ParserHealth;
  /** Recent provider rows still inside the late-match grace period. */
  pendingProvider: number;
  /** congress.trade candidates old enough for a directional coverage estimate. */
  maturedCandidates: number;
  /** Jointly observed, high-confidence rows in the matured provider cohort. */
  maturedMatched: number;
  /** Matured provider rows paired only by a weak method. */
  maturedWeakMatched: number;
  /** congress.trade coverage of the provider-observed matured cohort. */
  ctCoveragePct: number | null;
  /** Provider coverage of the congress.trade matured candidate cohort. */
  providerCoveragePct: number | null;
  /** Jaccard overlap of the two matured observed cohorts. */
  overlapPct: number | null;
  /**
   * `contradiction` means the coverage JOIN is broken, NOT that coverage is
   * zero. Set when this lane observed matured provider rows, matched none of
   * them, yet holds strong pairings in `trade_latency_candidates`. Both cannot
   * be true, so `ctCoveragePct` and `overlapPct` are suppressed to `null`
   * rather than published as a 0% we did not measure. See the guard in
   * {@link computeProviderMetrics}.
   */
  coverageIntegrity: CoverageIntegrity;
  /**
   * Strong CT <-> provider pairings on file for this lane in the coverage
   * window. The evidence behind `coverageIntegrity` — with `maturedMatched`
   * it makes the contradiction legible instead of requiring a DB query.
   */
  coverageStrongPairingsOnFile: number;
  /** insufficient = too few matured rows; limited = coverage too low for a
   *  full claim; preliminary = enough matched timing for a soft claim;
   *  usable = coverage + sample gates pass for a full Ahead/Behind claim. */
  comparisonStatus: 'insufficient' | 'limited' | 'preliminary' | 'usable';
  comparisonBasis: 'matched-overlap-only';
  ctAheadMonitorCount: number;
  providerAheadMonitorCount: number;
  tieMonitorCount: number;
  avgMonitorDeltaSec: number | null;
  medianMonitorDeltaSec: number | null;
  p90MonitorDeltaSec: number | null;
  avgProviderPublishedDeltaSec: number | null;
  medianProviderPublishedDeltaSec: number | null;
  ctAheadPublishedCount: number;
  providerAheadPublishedCount: number;
  tiePublishedCount: number;
  /** Whether this provider uses monitor (crawler first-seen) or provider (provider's own semantic timestamp) for timing. */
  timestampKind: 'monitor' | 'provider' | 'none';
}

/**
 * "N of M matched" — the scope denominator.
 *
 * WHAT M COUNTS (`total`). Distinct disclosed trade lines, one per
 * `chamber:trade_hash`, that satisfy ALL THREE of:
 *
 *   1. In window. The line entered one of the two feeds within
 *      `windowHours` (14 days, {@link LATENCY_PROVIDER_MATCH_LOOKBACK_HOURS}) —
 *      `congress_first_seen_at` for our side, `first_observed_at` for the
 *      provider side. One window, applied to whichever clock the row has.
 *      This is deliberately the LONGER of the two windows in this module: the
 *      7-day score window governs lead-time statistics, not coverage.
 *   2. In our realm of concern. Sitting House members, sitting Senate members,
 *      and the executive filers we track by name — POTUS, VP, and the
 *      Senate-confirmed cabinet secretaries / agency heads curated in
 *      `shared/executiveIdentity.ts`. House and Senate lane rows qualify by
 *      construction: both our crawlers and every provider's congressional
 *      endpoint are already restricted to sitting members. Executive lane rows
 *      qualify ONLY when the disclosed name resolves to a curated executive.
 *      Anything else — an unknown chamber, an executive-lane name we do not
 *      track, a row with no filer name at all — is EXCLUDED from both N and M
 *      and counted in `excludedOutOfScope`, never quietly parked in the
 *      denominator where it would depress the ratio.
 *   3. Live. Backfills and historical crawls are excluded on our side
 *      ({@link isLiveRaceImport}); they are not races and were never eligible
 *      to be won or lost.
 *
 * A line both sides saw counts ONCE. Provider observations that carry a
 * confirmed pairing are folded onto the paired candidate's `trade_hash`, so a
 * provider whose hash differs from ours cannot inflate M by appearing as a
 * second, separate disclosure.
 *
 * WHAT N COUNTS (`matched`). The subset of M carrying a STRONG CT <-> provider
 * pairing (see {@link matchStrength}). `matchedIncludingWeak` adds the
 * weak-method pairings for anyone who wants the looser figure; the headline is
 * the strong one.
 *
 * WHAT M IS NOT. It is not "every disclosure Congress filed" — we cannot count
 * filings neither side has seen. M is the union of what the two feeds
 * surfaced.
 *
 * READ `providerOnly` AFTER THE CORPUS PASS. A provider "latest" endpoint
 * returns rows by DISCLOSURE date, and a filing disclosed this week routinely
 * contains older transactions. Those used to land in `providerOnly` even when
 * congress.trade already had the trade via seed / backfill / historical crawl
 * ({@link CORPUS_MATCH_METHOD} now folds those onto both-sides). What remains
 * in `providerOnly` is the subset with no CT transaction of that identity.
 */
export interface DisclosureLatencyScope {
  /** Window applied to both clocks (hours). */
  windowHours: number;
  /** M — distinct in-scope disclosed trade lines seen by either side. */
  total: number;
  /** N — in-scope lines with a strong CT <-> provider pairing. */
  matched: number;
  /** N including weak-method pairings. */
  matchedIncludingWeak: number;
  /** In-scope lines only congress.trade saw. */
  ctOnly: number;
  /** In-scope lines only a provider saw (our ingestion gap). */
  providerOnly: number;
  /** N / M as a percentage, null when M is 0. */
  matchedPct: number | null;
  /** Rows dropped for failing the realm-of-concern test (never in M). */
  excludedOutOfScope: number;
  /** Rows dropped because their trade hash had no filer segment (parser fault). */
  excludedMissingFiler: number;
}

export interface DisclosureLatencyTotals {
  candidates: number;
  matched: number;
  pending: number;
  errored: number;
  providerObserved: number;
  maturedProviderObserved: number;
  unmatchedProvider: number;
  unmatchedProviderCtMissing: number;
  unmatchedProviderCtExcluded: number;
  comparableProviders: number;
  configuredComparableProviders: number;
}

export interface DisclosureLatencySummary {
  generatedAt: string;
  /** Scoreboard observation window in hours (currently 168 = 7 days). */
  windowHours: number;
  /** Max |delta| hours for a race to count toward lead/win timing. */
  maxConcurrentDeltaHours: number;
  totals: DisclosureLatencyTotals;
  /** "N of M matched" across our whole realm of concern. */
  scope: DisclosureLatencyScope;
  providers: DisclosureLatencyProviderMetrics[];
  providerStatuses: DisclosureLatencyProviderStatus[];
  publicSummary: {
    generatedAt: string;
    windowHours: number;
    maxConcurrentDeltaHours: number;
    totals: DisclosureLatencyTotals;
    scope: DisclosureLatencyScope;
    providers: DisclosureLatencyProviderMetrics[];
  };
}

/** Alternate FMP HTTP path (stable host vs RapidAPI) for dual-path race. */
export type FmpLatencyPathId = 'stable' | 'rapidapi';

export interface FmpLatencyPathDefinition {
  pathId: FmpLatencyPathId;
  /** Matches ProviderId used in trade_latency_candidates / observations. */
  providerId: ProviderId;
  label: string;
  defaultBaseUrl: string;
  auth: 'query' | 'rapidapi';
  rapidApiHost?: string;
}

/**
 * Registered FMP path collection for CT latency + Mac scout.
 * Default operational state is ON for CT when latency keys present; explicit
 * FMP_LATENCY_PROBE_ENABLED=false forces OFF (grey).
 * When ON, enabled paths are rotated (one HTTP avenue per probe cycle).
 */
export const FMP_LATENCY_PATHS: readonly FmpLatencyPathDefinition[] = [
  {
    pathId: 'stable',
    providerId: 'fmp',
    label: 'FMP Stable',
    defaultBaseUrl: 'https://financialmodelingprep.com/stable',
    auth: 'query',
  },
  {
    pathId: 'rapidapi',
    providerId: 'fmp_rapidapi',
    label: 'FMP RapidAPI',
    defaultBaseUrl: 'https://financial-modeling-prep.p.rapidapi.com/stable',
    auth: 'rapidapi',
    rapidApiHost: 'financial-modeling-prep.p.rapidapi.com',
  },
] as const;

interface ProviderDefinition {
  id: ProviderId;
  label: string;
  secretNames: string[];
  requiresMembership: boolean;
  supportsDirectLatest: boolean;
  timestampKind: 'provider' | 'monitor' | 'none';
  /** FMP path id when this provider is an FMP-family alternate path. */
  fmpPathId?: FmpLatencyPathId;
  reason?: string;
  fetchRows?: (
    apiKey: string,
    max: number,
    fetchImpl: typeof fetch,
    pace?: () => Promise<void>,
    opts?: { baseUrl?: string; auth?: 'query' | 'rapidapi'; rapidApiHost?: string },
  ) => Promise<DisclosureProviderRow[]>;
}

const DEFAULT_LIMIT = 100;
const PAYLOAD_LIMIT = 20_000;
/**
 * Unusual Whales' recent-trades page only holds ~200 rows, so a pending
 * observation whose filing has scrolled outside that window can never match
 * on the normal pass. The deep-match pass re-queries recent-trades anchored
 * to specific transaction dates (see runUnusualWhalesDeepMatch) for up to
 * this many distinct dates per probe run, rotating through the stranded
 * backlog least-recently-checked first. 0 disables the pass entirely (e.g.
 * once a trial API key lapses and the extra calls would just 401).
 */
const UW_DEEP_MATCH_DEFAULT_DATES_PER_RUN = 8;
const UW_DEEP_MATCH_MAX_DATES_PER_RUN = 25;
/** Upper bound on how many provably-outside-window pending rows we'll scan
 *  per run to pick deep-match dates from; well above the ~52 UW rows
 *  currently stranded in production. */
const UW_DEEP_MATCH_CANDIDATE_LIMIT = 500;
/** Bind-parameter chunk size for `IN (...)` lookups (D1 caps bound params per
 *  statement; stay comfortably under it). */
const SQL_IN_CHUNK = 50;
/**
 * FMP free-tier keys for latency monitoring ONLY (owner 2026-08).
 *
 * - Slot 1: FMP_LATENCY_API_KEY
 * - Slot 2: FMP_LATENCY_API_KEY_2, else FMP_API_KEY when distinct from slot 1
 *   (owner: two free-tier accounts; no known per-IP limit — rotate both for ~2×
 *   daily capacity on the stable host).
 * - Each key has its own daily counter (not shared with enrichment/prices spend).
 * - Cap ~235/key/day (free plan is 250; leave headroom for 429s / manual tests).
 * - House+senate latest = 2 HTTP calls per probe run.
 * - Adaptive ET-weighted spacing spreads remaining budget across the rest of the
 *   UTC day, denser during US publish hours (roughly 8–18 America/New_York).
 */
/** Second key name is built (not a bare `…API_KEY_2` literal) so gitleaks
 *  does not false-positive the env var *name* as a secret value. */
const FMP_LATENCY_KEY_PRIMARY = 'FMP_LATENCY_API_KEY';
const FMP_LATENCY_KEY_SECONDARY = `${FMP_LATENCY_KEY_PRIMARY}_2`;
/** Preferred names for slot 2; FMP_API_KEY is last-resort free-tier fallback. */
const FMP_LATENCY_SLOT2_SECRET_NAMES = [FMP_LATENCY_KEY_SECONDARY, 'FMP_API_KEY'] as const;
const FMP_LATENCY_SECRET_NAMES = [FMP_LATENCY_KEY_PRIMARY, FMP_LATENCY_KEY_SECONDARY] as const;
type FmpLatencyKeySlot = '1' | '2';
/** Free-tier daily limit is 250; reserve margin so we never trip the hard wall. */
export const FMP_LATENCY_DAILY_CAP_PER_KEY = 235;
/** house-latest + senate-latest per successful FMP probe fetch. */
export const FMP_LATENCY_CALLS_PER_RUN = 2;
/** Floor spacing even when budget is flush (avoid hammering free tier). */
const FMP_LATENCY_MIN_INTERVAL_SEC = 60;
/** Cap spacing so a late-day recovery can still burn remaining budget. */
const FMP_LATENCY_MAX_INTERVAL_SEC = 45 * 60;

/**
 * 4-level America/New_York publish-yield bands for disclosure latency probes.
 * Politicians almost always file during US business hours on weekdays; we
 * burn daily API budget denser in high-yield windows and sacrifice nights.
 *
 * Relative frequency weights (peak ≈ 3× mid, ≈ 7.5× low):
 *   peak  3.0  — weekday 08–12 ET (morning filing surge)
 *   high  2.0  — weekday 12–16 ET
 *   mid   1.0  — weekday 06–08 + 16–20 ET
 *   low   0.4  — nights / late evening; weekends downshifted further
 */
export type DisclosurePublishYieldBand = 'peak' | 'high' | 'mid' | 'low';

export const DISCLOSURE_PUBLISH_YIELD_WEIGHT: Record<DisclosurePublishYieldBand, number> = {
  peak: 3.0,
  high: 2.0,
  mid: 1.0,
  low: 0.4,
};

/**
 * Sources with independent daily HTTP budgets + yield-weighted spacing.
 * `fmp_rapidapi` is the RapidAPI marketplace avenue (shared RAPIDAPI_KEY from
 * Socratic.Trade); free-tier FMP_LATENCY_* keys stay on the stable host only.
 */
export type LatencyBudgetSourceId = 'unusual_whales' | 'quiver' | 'fmp_rapidapi';

export interface LatencySourceBudgetSpec {
  id: LatencyBudgetSourceId;
  /** CONFIG_KV / last-poll namespace. */
  pollSource: string;
  dayKeyPrefix: string;
  envCapKey: string;
  defaultDailyCap: number;
  /** Hard ceiling for env override (safety). */
  maxDailyCap: number;
  /** HTTP calls reserved for a normal successful probe (before deep-match). */
  callsPerRun: number;
  minIntervalSec: number;
  maxIntervalSec: number;
}

/**
 * Per-source daily caps (HTTP call units). Tunable via Infisical.
 * - UW: 1 call for recent-trades; deep-match dates spend extra from remaining.
 * - QQ: house + senate + trump bulk = 3 calls per probe.
 * - FMP RapidAPI: house+senate = 2 calls; separate marketplace quota (not free-tier).
 *   With dual free keys (~235×2) + this path, total FMP fleet can be ~2×+ free-only.
 */
export const LATENCY_SOURCE_BUDGETS: Record<LatencyBudgetSourceId, LatencySourceBudgetSpec> = {
  unusual_whales: {
    id: 'unusual_whales',
    pollSource: 'disclosure-latency-uw',
    dayKeyPrefix: 'latency-budget:uw',
    envCapKey: 'UW_LATENCY_DAILY_CAP',
    // ~4 peak probes/hr if budget full; leaves headroom for deep-match dates.
    defaultDailyCap: 240,
    maxDailyCap: 2000,
    callsPerRun: 1,
    minIntervalSec: 60,
    maxIntervalSec: 45 * 60,
  },
  quiver: {
    id: 'quiver',
    pollSource: 'disclosure-latency-qq',
    dayKeyPrefix: 'latency-budget:qq',
    envCapKey: 'QUIVER_LATENCY_DAILY_CAP',
    // 3 HTTP/run; 360 calls ≈ 120 probes/day, denser in peak ET hours.
    defaultDailyCap: 360,
    maxDailyCap: 5000,
    callsPerRun: 3,
    minIntervalSec: 60,
    maxIntervalSec: 45 * 60,
  },
  fmp_rapidapi: {
    id: 'fmp_rapidapi',
    pollSource: 'disclosure-latency-fmp-rapidapi',
    dayKeyPrefix: 'latency-budget:fmp-rapidapi',
    envCapKey: 'FMP_RAPIDAPI_DAILY_CAP',
    // Conservative default; ST lists marketplace FMP high — CT is latency-only.
    // Override via Infisical if the RapidAPI FMP plan is larger.
    defaultDailyCap: 500,
    maxDailyCap: 50_000,
    callsPerRun: FMP_LATENCY_CALLS_PER_RUN,
    minIntervalSec: 60,
    maxIntervalSec: 45 * 60,
  },
};

/**
 * Resolve RapidAPI marketplace key for FMP path (Socratic.Trade pattern).
 * Order: FMP_RAPIDAPI_KEY (dedicated) → RAPIDAPI_KEY (shared marketplace).
 * Does **not** fall back to free-tier FMP_LATENCY_* — those are native FMP
 * query keys and do not authenticate RapidAPI hosts.
 */
export async function resolveFmpRapidApiKey(env: Env): Promise<string | null> {
  const envx = env as unknown as Record<string, string | undefined>;
  for (const name of ['FMP_RAPIDAPI_KEY', 'RAPIDAPI_KEY'] as const) {
    const value = (await resolveSecret(env, name as keyof Env & string)).value ?? envx[name];
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function fmpLatencyDayKey(slot: FmpLatencyKeySlot, now = new Date()): string {
  return `fmp-latency:calls:key${slot}:` + now.toISOString().slice(0, 10);
}

function fmpLatencyPollSource(slot: FmpLatencyKeySlot): string {
  return `fmp-disclosure-latency-key${slot}`;
}

async function fmpLatencyDailyCap(env: Env): Promise<number> {
  const envx = env as EnvWithWatch;
  const live = (await resolveSecret(env, 'FMP_LATENCY_DAILY_CAP')).value ?? envx.FMP_LATENCY_DAILY_CAP;
  const n = parseInt(live || '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 250) : FMP_LATENCY_DAILY_CAP_PER_KEY;
}

export async function getFmpLatencyUsed(env: Env, slot: FmpLatencyKeySlot, now = new Date()): Promise<number> {
  try {
    const v = await env.CONFIG_KV.get(fmpLatencyDayKey(slot, now));
    const n = v ? parseInt(v, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export async function addFmpLatencyUsed(
  env: Env,
  slot: FmpLatencyKeySlot,
  n: number,
  now = new Date(),
): Promise<number> {
  const used = await getFmpLatencyUsed(env, slot, now);
  const next = Math.max(0, used + Math.floor(n));
  try {
    await env.CONFIG_KV.put(fmpLatencyDayKey(slot, now), String(next), { expirationTtl: 172800 });
  } catch {
    /* best effort */
  }
  return next;
}

function fmpHttp429DayKey(slot: FmpLatencyKeySlot, now = new Date()): string {
  return `fmp-latency:http429:key${slot}:` + now.toISOString().slice(0, 10);
}

/**
 * Mark a free-tier key unusable for the rest of the UTC day.
 * Used for FMP 429 (bandwidth cap) and for 401/403 (unauthorized / wrong plan)
 * so the other key keeps winning selection instead of the dead one.
 */
export type FmpSlotDaySkipCause = '429' | 'unauthorized';

export async function markFmpSlotHttp429(
  env: Env,
  slot: FmpLatencyKeySlot,
  now = new Date(),
  cause: FmpSlotDaySkipCause = '429',
): Promise<void> {
  try {
    await env.CONFIG_KV.put(fmpHttp429DayKey(slot, now), cause, { expirationTtl: 172800 });
  } catch {
    /* best effort */
  }
}

export async function readFmpSlotHttp429Cause(
  env: Env,
  slot: FmpLatencyKeySlot,
  now = new Date(),
): Promise<FmpSlotDaySkipCause | null> {
  try {
    const raw = await env.CONFIG_KV.get(fmpHttp429DayKey(slot, now));
    if (raw === '429' || raw === 'unauthorized') return raw;
    return null;
  } catch {
    return null;
  }
}

/** True only for bandwidth-cap (429) day marks — used for self-healing silence, not slot skip. */
export async function isFmpSlotHttp429DayBan(
  env: Env,
  slot: FmpLatencyKeySlot,
  now = new Date(),
): Promise<boolean> {
  return (await readFmpSlotHttp429Cause(env, slot, now)) === '429';
}

export async function isFmpSlotHttp429(
  env: Env,
  slot: FmpLatencyKeySlot,
  now = new Date(),
): Promise<boolean> {
  try {
    return Boolean(await env.CONFIG_KV.get(fmpHttp429DayKey(slot, now)));
  } catch {
    return false;
  }
}

function etHourAndWeekday(now: Date): { hour: number; weekday: string; isWeekend: boolean } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '12');
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  return { hour, weekday, isWeekend };
}

/**
 * PRE-MEASUREMENT band table: hand-picked ET hour ranges, kept only as the
 * fallback for `PROBE_SCHEDULE_ENABLED=0`.
 *
 * Superseded by the measured windows in probeSchedule.ts. It was wrong in a
 * specific and expensive way: it called 08:00-12:00 ET uniformly "peak", but
 * the measurement found 21 of 27 House filing days landing inside a SIX-MINUTE
 * window (09:00-09:06 ET, median 09:02) — so three of those four hours were
 * being probed at burst rate for nothing while the actual burst got the same
 * cadence as 11:45. Retained (rather than deleted) so the kill switch restores
 * a known-good behaviour instead of an untested one.
 */
export function legacyDisclosurePublishYieldBand(
  now: Date = new Date(),
): DisclosurePublishYieldBand {
  const { hour, isWeekend } = etHourAndWeekday(now);
  let band: DisclosurePublishYieldBand;
  if (hour >= 8 && hour < 12) band = 'peak';
  else if (hour >= 12 && hour < 16) band = 'high';
  else if ((hour >= 6 && hour < 8) || (hour >= 16 && hour < 20)) band = 'mid';
  else band = 'low';
  if (isWeekend) {
    if (band === 'peak') return 'high';
    if (band === 'high') return 'mid';
    if (band === 'mid') return 'low';
    return 'low';
  }
  return band;
}

/**
 * Which measured cadence tier the current instant falls in for the metered
 * latency providers. One provider call covers both chambers, so the `provider`
 * profile is the UNION of the House and Senate peaks (09:00-10:00 and
 * 16:00-18:00 ET).
 *
 * Delegates to probeSchedule.ts, which is pure: same instant in, same tier out.
 * `schedule.enabled === false` restores the pre-measurement band table above.
 */
export function disclosurePublishYieldBand(
  now: Date = new Date(),
  schedule: ProbeScheduleConfig = DEFAULT_PROBE_SCHEDULE_CONFIG,
): DisclosurePublishYieldBand {
  if (!schedule.enabled) return legacyDisclosurePublishYieldBand(now);
  return probeTierAt('provider', now, { config: schedule });
}

/**
 * Relative probe-density weight for the current measured window.
 *
 * BUDGET-NEUTRAL BY CONSTRUCTION: probeYieldWeightAt is normalised so its
 * time-average across the day is 1.0, and budgetedProbeIntervalSec computes
 * `interval = (secLeft / runsLeft) / weight`. A mean-1 weight therefore
 * RESHAPES the day's spend without changing the daily total — the property
 * this function has to have, since the provider daily caps are hard.
 */
export function disclosurePublishYieldWeight(
  now: Date = new Date(),
  schedule: ProbeScheduleConfig = DEFAULT_PROBE_SCHEDULE_CONFIG,
): number {
  if (!schedule.enabled) {
    return DISCLOSURE_PUBLISH_YIELD_WEIGHT[legacyDisclosurePublishYieldBand(now)];
  }
  return probeYieldWeightAt('provider', now, { config: schedule });
}

/**
 * @deprecated Prefer disclosurePublishYieldWeight — kept for existing imports/tests.
 * Same ET weight used by all latency sources.
 */
export function fmpLatencyEtHourWeight(
  now: Date = new Date(),
  schedule: ProbeScheduleConfig = DEFAULT_PROBE_SCHEDULE_CONFIG,
): number {
  return disclosurePublishYieldWeight(now, schedule);
}

/**
 * Spread remaining probe runs across the rest of the UTC day, denser in
 * measured high-yield ET windows. Shared by FMP, Unusual Whales, and Quiver.
 *
 * interval ≈ (secLeft / runsLeft) / yieldWeight, clamped to [min, max].
 *
 * The 0.25 weight floor is deliberate and fail-safe: the shipped LOW weight is
 * ~0.22, so overnight is clamped very slightly TOWARD more probing rather than
 * less. The hard remaining-budget check upstream still bounds total spend.
 */
export function budgetedProbeIntervalSec(opts: {
  now: Date;
  remainingRuns: number;
  minIntervalSec: number;
  maxIntervalSec: number;
  schedule?: ProbeScheduleConfig;
}): number {
  const { now, remainingRuns, minIntervalSec, maxIntervalSec } = opts;
  if (remainingRuns < 1) return maxIntervalSec;
  const endUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const secLeft = Math.max(60, Math.floor((endUtc - now.getTime()) / 1000));
  const uniform = secLeft / remainingRuns;
  const weight = Math.max(0.25, disclosurePublishYieldWeight(now, opts.schedule));
  const weighted = uniform / weight;
  // Peak floor can be as low as minIntervalSec; overnight still respects min.
  return Math.max(minIntervalSec, Math.min(maxIntervalSec, Math.round(weighted)));
}

/**
 * Seconds until the next FMP latency probe for a key, given remaining budget
 * for the UTC day. Spreads calls so we do not front-load free-tier quota;
 * peak ET hours run ~3× denser than mid-day baseline.
 */
export function fmpLatencyIntervalSec(
  now: Date,
  remainingCalls: number,
  callsPerRun: number = FMP_LATENCY_CALLS_PER_RUN,
  schedule?: ProbeScheduleConfig,
): number {
  if (remainingCalls < callsPerRun) return FMP_LATENCY_MAX_INTERVAL_SEC;
  const runsLeft = Math.max(1, Math.floor(remainingCalls / callsPerRun));
  return budgetedProbeIntervalSec({
    now,
    remainingRuns: runsLeft,
    minIntervalSec: FMP_LATENCY_MIN_INTERVAL_SEC,
    maxIntervalSec: FMP_LATENCY_MAX_INTERVAL_SEC,
    schedule,
  });
}

/**
 * Live cadence config for the metered providers, read from env.
 *
 * Never throws: probeScheduleConfigFromEnv is total, and a hard failure falls
 * back to the shipped measured table rather than stalling the probe.
 */
export function latencyScheduleConfig(env: Env): ProbeScheduleConfig {
  try {
    return probeScheduleConfigFromEnv(env as unknown as Record<string, string | undefined>);
  } catch {
    return DEFAULT_PROBE_SCHEDULE_CONFIG;
  }
}

function sourceBudgetDayKey(spec: LatencySourceBudgetSpec, now = new Date()): string {
  return `${spec.dayKeyPrefix}:${now.toISOString().slice(0, 10)}`;
}

export async function getLatencySourceUsed(
  env: Env,
  source: LatencyBudgetSourceId,
  now = new Date(),
): Promise<number> {
  const spec = LATENCY_SOURCE_BUDGETS[source];
  try {
    const v = await env.CONFIG_KV.get(sourceBudgetDayKey(spec, now));
    const n = v ? parseInt(v, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export async function addLatencySourceUsed(
  env: Env,
  source: LatencyBudgetSourceId,
  n: number,
  now = new Date(),
): Promise<number> {
  const spec = LATENCY_SOURCE_BUDGETS[source];
  const used = await getLatencySourceUsed(env, source, now);
  const next = Math.max(0, used + Math.floor(n));
  try {
    await env.CONFIG_KV.put(sourceBudgetDayKey(spec, now), String(next), { expirationTtl: 172800 });
  } catch {
    /* best effort */
  }
  return next;
}

export async function latencySourceDailyCap(env: Env, source: LatencyBudgetSourceId): Promise<number> {
  const spec = LATENCY_SOURCE_BUDGETS[source];
  const envx = env as unknown as Record<string, string | undefined>;
  const live = (await resolveSecret(env, spec.envCapKey as keyof Env & string)).value ?? envx[spec.envCapKey];
  const n = parseInt(live || '', 10);
  if (Number.isFinite(n) && n > 0) return Math.min(n, spec.maxDailyCap);
  return spec.defaultDailyCap;
}

export interface LatencySourceProbeSelection {
  source: LatencyBudgetSourceId;
  used: number;
  cap: number;
  remaining: number;
  intervalSec: number;
  callsPerRun: number;
  band: DisclosurePublishYieldBand;
}

/**
 * Why a lane did not spend HTTP this cycle. `daily_cap` and `off_cadence` used
 * to be the same `null`, which made "the schedule is pacing us, correctly"
 * indistinguishable from "we are out of budget" — and both indistinguishable
 * from "the cadence silently broke".
 */
export type LatencySourceSkipReason = 'daily_cap' | 'off_cadence';

export interface LatencySourceProbeDecision {
  source: LatencyBudgetSourceId;
  probe: boolean;
  skip: LatencySourceSkipReason | null;
  /** Present iff `probe` — the same object selectLatencySourceProbe returns. */
  selection: LatencySourceProbeSelection | null;
  band: DisclosurePublishYieldBand;
  intervalSec: number;
  /** Seconds since the last probe of this lane; Infinity when never probed. */
  elapsedSec: number;
  used: number;
  cap: number;
  remaining: number;
}

/**
 * Decide whether UW/QQ/FMP-RapidAPI may spend HTTP this cycle, given remaining
 * daily budget and the measured cadence. force=true bypasses cadence spacing
 * (it still respects the hard daily cap).
 *
 * COMPOSITION: this is the "HOW OFTEN" half. It runs strictly INSIDE the
 * lease-granted branch — runLeasedLatencyProbe() hands runDisclosureLatencyProbe
 * only the providers the server holds a lease on, and this is consulted per
 * provider from there. The two are nested, never side by side: the schedule can
 * only ever decline a lane the lease already granted, and can never authorise a
 * call on its own.
 */
export async function evaluateLatencySourceProbe(
  env: Env,
  source: LatencyBudgetSourceId,
  now: Date = new Date(),
  opts: { force?: boolean; schedule?: ProbeScheduleConfig } = {},
): Promise<LatencySourceProbeDecision> {
  const spec = LATENCY_SOURCE_BUDGETS[source];
  const schedule = opts.schedule ?? latencyScheduleConfig(env);
  const cap = await latencySourceDailyCap(env, source);
  const used = await getLatencySourceUsed(env, source, now);
  const remaining = Math.max(0, cap - used);
  const band = disclosurePublishYieldBand(now, schedule);

  const runsLeft = Math.max(1, Math.floor(Math.max(0, remaining) / spec.callsPerRun));
  const intervalSec = budgetedProbeIntervalSec({
    now,
    remainingRuns: runsLeft,
    minIntervalSec: spec.minIntervalSec,
    maxIntervalSec: spec.maxIntervalSec,
    schedule,
  });

  if (remaining < spec.callsPerRun) {
    return {
      source, probe: false, skip: 'daily_cap', selection: null,
      band, intervalSec, elapsedSec: Infinity, used, cap, remaining,
    };
  }

  let elapsedSec = Infinity;
  if (!opts.force) {
    const last = await getLastPollAt(env, spec.pollSource);
    if (last) {
      elapsedSec = (now.getTime() - last.getTime()) / 1000;
      if (elapsedSec < intervalSec) {
        return {
          source, probe: false, skip: 'off_cadence', selection: null,
          band, intervalSec, elapsedSec, used, cap, remaining,
        };
      }
    }
  }

  return {
    source,
    probe: true,
    skip: null,
    selection: {
      source,
      used,
      cap,
      remaining,
      intervalSec,
      callsPerRun: spec.callsPerRun,
      band,
    },
    band,
    intervalSec,
    elapsedSec,
    used,
    cap,
    remaining,
  };
}

/**
 * Emit one greppable cadence line for a metered provider lane.
 *
 * Deliberately reports the SKIP REASON, not just the fact of a skip: a lane
 * that is pacing correctly through the measured trough and a lane whose cadence
 * has quietly broken both produce "no fetch", and only the tier + interval in
 * this line tells them apart. Throttled in probeCadenceLog.ts.
 */
export function logLatencyLaneCadence(
  source: LatencyBudgetSourceId,
  decision: LatencySourceProbeDecision,
  now: Date,
): void {
  logProbeCadence(
    {
      lane: `provider:${source}`,
      source: 'provider',
      probe: decision.probe,
      tier: decision.band,
      dayType: 'n/a',
      intervalSec: decision.intervalSec,
      elapsedSec: decision.elapsedSec,
      authority: 'schedule',
      reason: decision.probe ? 'due' : (decision.skip ?? 'unknown'),
    },
    now,
  );
}

/**
 * Back-compat wrapper: selection when the lane may spend, null when it may not.
 * Prefer evaluateLatencySourceProbe at call sites that need to log WHY.
 */
export async function selectLatencySourceProbe(
  env: Env,
  source: LatencyBudgetSourceId,
  now: Date = new Date(),
  opts: { force?: boolean; schedule?: ProbeScheduleConfig } = {},
): Promise<LatencySourceProbeSelection | null> {
  return (await evaluateLatencySourceProbe(env, source, now, opts)).selection;
}

export interface FmpLatencyKeySelection {
  apiKey: string;
  slot: FmpLatencyKeySlot;
  /** Resolved env/secret name (may be FMP_API_KEY for slot 2 fallback). */
  secretName: string;
  used: number;
  cap: number;
  remaining: number;
  intervalSec: number;
}

/** Canonical UW secret names (single trial/paid key — no free residual after trial). */
const UW_SECRET_NAMES = ['UNUSUAL_WHALES_API_KEY', 'UNUSUALWHALES_API_KEY'] as const;

/**
 * Resolve the single Unusual Whales API key (canonical or owner alias).
 */
export async function resolveUnusualWhalesKey(env: Env): Promise<{ apiKey: string; secretName: string } | null> {
  const envx = env as unknown as Record<string, string | undefined>;
  for (const secretName of UW_SECRET_NAMES) {
    const value = (await resolveSecret(env, secretName as keyof Env & string)).value ?? envx[secretName];
    const apiKey = value?.trim();
    if (apiKey) return { apiKey, secretName };
  }
  return null;
}

/**
 * Round-robin across equivalent access avenues (paths, keys, hosts) so multi-
 * avenue sources spend **exactly one** avenue per cycle. Prevents doubling
 * free-tier daily quotas when two keys/hosts would return the same answer a
 * minute apart (owner 2026-08).
 *
 * State lives in CONFIG_KV under `avenue-rotate:<family>`. Reusable for any
 * provider family with multiple keys or alternate hosts.
 */
export async function selectRotatedAvenue(
  env: Env,
  family: string,
  candidates: string[],
): Promise<string | null> {
  const list = [...new Set(candidates.map((c) => String(c).trim()).filter(Boolean))];
  if (!list.length) return null;
  if (list.length === 1) return list[0]!;

  const kvKey = `avenue-rotate:${family}`;
  let last: string | null = null;
  try {
    last = (await env.CONFIG_KV.get(kvKey)) ?? null;
  } catch {
    last = null;
  }
  const lastIdx = last ? list.indexOf(last) : -1;
  const next = list[(lastIdx + 1) % list.length]!;
  try {
    await env.CONFIG_KV.put(kvKey, next, { expirationTtl: 7 * 86400 });
  } catch {
    /* best effort — still return next so this cycle uses one avenue */
  }
  return next;
}

/**
 * Resolve free-tier key material for a latency slot.
 * Slot 1 = FMP_LATENCY_API_KEY only.
 * Slot 2 = FMP_LATENCY_API_KEY_2, else FMP_API_KEY when distinct from slot 1
 * (two free accounts → ~2× daily HTTP on stable; no known per-IP limit).
 */
async function resolveFmpLatencyKeyMaterial(
  env: Env,
  slot: FmpLatencyKeySlot,
  primaryKey?: string | null,
): Promise<{ apiKey: string; secretName: string } | null> {
  const envx = env as unknown as Record<string, string | undefined>;
  if (slot === '1') {
    const value =
      (await resolveSecret(env, FMP_LATENCY_KEY_PRIMARY as keyof Env & string)).value ??
      envx[FMP_LATENCY_KEY_PRIMARY];
    const apiKey = value?.trim();
    return apiKey ? { apiKey, secretName: FMP_LATENCY_KEY_PRIMARY } : null;
  }
  for (const secretName of FMP_LATENCY_SLOT2_SECRET_NAMES) {
    const value =
      (await resolveSecret(env, secretName as keyof Env & string)).value ?? envx[secretName];
    const apiKey = value?.trim();
    if (!apiKey) continue;
    // Skip duplicate of slot 1 so one physical key does not get two budgets.
    if (primaryKey && apiKey === primaryKey) continue;
    return { apiKey, secretName };
  }
  return null;
}

/** Key slots with configured material (same resolution as {@link selectFmpLatencyKey}). */
export async function listConfiguredFmpLatencySlots(env: Env): Promise<FmpLatencyKeySlot[]> {
  const slots: FmpLatencyKeySlot[] = [];
  const primary = await resolveFmpLatencyKeyMaterial(env, '1');
  if (primary) slots.push('1');
  const secondary = await resolveFmpLatencyKeyMaterial(env, '2', primary?.apiKey ?? null);
  if (secondary) slots.push('2');
  return slots;
}

/**
 * Pick a configured free-tier latency key that still has budget and whose poll
 * spacing has elapsed. **Alternates** among eligible keys (round-robin) so dual
 * free-tier keys are not drained in lockstep / doubled for the same probe.
 * Slot 2 may resolve from FMP_API_KEY when FMP_LATENCY_API_KEY_2 is unset
 * (owner: both free keys for latency; no known per-IP limit).
 */
export async function selectFmpLatencyKey(
  env: Env,
  now: Date = new Date(),
  opts: { force?: boolean; schedule?: ProbeScheduleConfig; peek?: boolean } = {},
): Promise<FmpLatencyKeySelection | null> {
  const cap = await fmpLatencyDailyCap(env);
  const schedule = opts.schedule ?? latencyScheduleConfig(env);
  const candidates: FmpLatencyKeySelection[] = [];

  const primary = await resolveFmpLatencyKeyMaterial(env, '1');
  const slots: FmpLatencyKeySlot[] = ['1', '2'];
  for (const slot of slots) {
    const material =
      slot === '1' ? primary : await resolveFmpLatencyKeyMaterial(env, '2', primary?.apiKey ?? null);
    if (!material) continue;

    const used = await getFmpLatencyUsed(env, slot, now);
    const remaining = Math.max(0, cap - used);
    if (remaining < FMP_LATENCY_CALLS_PER_RUN) continue;
    // FMP's own bandwidth cap is not our ledger. A 429 key must not keep
    // winning rotation while the other free-tier key still answers 200.
    if (await isFmpSlotHttp429(env, slot, now)) continue;

    const intervalSec = fmpLatencyIntervalSec(now, remaining, FMP_LATENCY_CALLS_PER_RUN, schedule);
    if (!opts.force) {
      const last = await getLastPollAt(env, fmpLatencyPollSource(slot));
      if (last && now.getTime() - last.getTime() < intervalSec * 1000) {
        // Off-cadence for this key, not out of budget. Logged per key slot so
        // "both free keys are pacing" reads differently from "both are spent".
        logProbeCadence(
          {
            lane: `provider:fmp:key${slot}`,
            source: 'provider',
            probe: false,
            tier: disclosurePublishYieldBand(now, schedule),
            dayType: 'n/a',
            intervalSec,
            elapsedSec: (now.getTime() - last.getTime()) / 1000,
            authority: 'schedule',
            reason: 'off-cadence',
          },
          now,
        );
        continue;
      }
    }

    candidates.push({
      apiKey: material.apiKey,
      slot,
      secretName: material.secretName,
      used,
      cap,
      remaining,
      intervalSec,
    });
  }

  if (!candidates.length) return null;
  // Stable order for rotation (slot 1 then 2); round-robin among eligible.
  candidates.sort((a, b) => a.slot.localeCompare(b.slot));
  // peek: path eligibility must not advance the key rotator. The probe
  // itself is the only caller that spends a rotation tick.
  if (opts.peek) return candidates[0]!;
  const pickedSlot = await selectRotatedAvenue(
    env,
    'fmp-key',
    candidates.map((c) => c.slot),
  );
  return candidates.find((c) => c.slot === pickedSlot) ?? candidates[0]!;
}

/**
 * Congress disclosure probes use the stable host only.
 *
 * RapidAPI's FMP product authenticates, but house-latest and senate-latest
 * return 404 (rechecked 2026-09-04; executive-latest is not an OGE feed).
 * Rotating a cycle onto that host would skip a working stable probe. A
 * request that names `fmp_rapidapi` still resolves to `stable` when a
 * free-tier key can spend — RapidAPI does not replace those probes.
 * Returns null when the master switch is off, FMP was not requested, or
 * every free-tier key is capped / marked failed for the UTC day.
 */
export async function selectFmpLatencyPathForCycle(
  env: Env,
  requestedProviderIds: readonly string[],
  opts: { force?: boolean } = {},
): Promise<FmpLatencyPathId | null> {
  if (!(await isFmpProbeEnabled(env))) return null;
  const wantsCongressProbe =
    requestedProviderIds.includes('fmp') || requestedProviderIds.includes('fmp_rapidapi');
  if (!wantsCongressProbe) return null;
  const keySel = await selectFmpLatencyKey(env, new Date(), { force: opts.force, peek: true });
  return keySel ? 'stable' : null;
}

/**
 * Fleet-wide remaining FMP latency HTTP calls: dual free-tier keys + RapidAPI
 * path budget (when marketplace key present). Used for docs/diagnostics and
 * denser spacing when multiple avenues still have quota.
 */
export async function getFmpLatencyFleetRemaining(env: Env, now: Date = new Date()): Promise<{
  freeTierRemaining: number;
  freeTierCap: number;
  freeTierKeysConfigured: number;
  rapidapiRemaining: number | null;
  rapidapiCap: number | null;
  totalRemaining: number;
}> {
  const capPerKey = await fmpLatencyDailyCap(env);
  let freeRemaining = 0;
  let freeCap = 0;
  let keysConfigured = 0;
  const primary = await resolveFmpLatencyKeyMaterial(env, '1');
  for (const slot of ['1', '2'] as const) {
    const material =
      slot === '1' ? primary : await resolveFmpLatencyKeyMaterial(env, '2', primary?.apiKey ?? null);
    if (!material) continue;
    keysConfigured++;
    freeCap += capPerKey;
    const used = await getFmpLatencyUsed(env, slot, now);
    freeRemaining += Math.max(0, capPerKey - used);
  }
  let rapidRemaining: number | null = null;
  let rapidCap: number | null = null;
  if (await resolveFmpRapidApiKey(env)) {
    rapidCap = await latencySourceDailyCap(env, 'fmp_rapidapi');
    const used = await getLatencySourceUsed(env, 'fmp_rapidapi', now);
    rapidRemaining = Math.max(0, rapidCap - used);
  }
  return {
    freeTierRemaining: freeRemaining,
    freeTierCap: freeCap,
    freeTierKeysConfigured: keysConfigured,
    rapidapiRemaining: rapidRemaining,
    rapidapiCap: rapidCap,
    totalRemaining: freeRemaining + (rapidRemaining ?? 0),
  };
}
/**
 * Full default probe list when DISCLOSURE_LATENCY_PROVIDERS is unset.
 * FMP family is listed so statuses register, but probes stay OFF until
 * FMP_LATENCY_PROBE_ENABLED (see isFmpProbeEnabled).
 */
const DIRECT_PROVIDER_IDS: ProviderId[] = ['fmp', 'fmp_rapidapi', 'unusual_whales', 'quiver'];

// Latency scoreboard policy (owner 2026-08):
//   • Race only **live** newly-imported CT trades — never seed/historical backfills.
//   • Match those to FMP / UW / Quiver as hard as possible (minute … multi-week gap OK).
//   • Lead stats measure first-seen delta either way (we can win or lose by a week).
//   • Scoreboard window is rolling 7 days of CT live first_seen; provider match
//     lookback is longer so a provider that listed the trade days earlier still hits.
/** Scoreboard: CT live first_seen in the last 7 days. */
export const LATENCY_SCORE_WINDOW_HOURS = 168;
/**
 * When matching pending CT races, search this far back in provider observations
 * so "they beat us by a week" still joins. Longer than the scoreboard window.
 */
export const LATENCY_PROVIDER_MATCH_LOOKBACK_HOURS = 14 * 24;
/** Keep RECENT_PROVIDER_HOURS as the match lookback (not the score window). */
const RECENT_PROVIDER_HOURS = LATENCY_PROVIDER_MATCH_LOOKBACK_HOURS;
export const LATENCY_MATURITY_GRACE_HOURS = 24;
/** Full "usable" claim requires this many matured provider-observed rows. */
export const LATENCY_MIN_MATURED_ROWS = 15;
/** Preliminary timing shown from this many timed matches. */
export const LATENCY_MIN_PRELIMINARY_MATCHED = 2;
export const LATENCY_MIN_COVERAGE_PCT = 80;
/**
 * Max |first-seen gap| for lead stats. Up to 14 days either direction —
 * minute, day, or week is all a real race. Beyond that is noise.
 */
export const LATENCY_MAX_CONCURRENT_DELTA_HOURS = LATENCY_PROVIDER_MATCH_LOOKBACK_HOURS;
/**
 * If CT first_seen is more than this many days after the official filed_date,
 * treat the import as a historical crawl/backfill (house index re-run, etc.)
 * even when transaction.source is still `primary`.
 */
export const LATENCY_LIVE_FILING_MAX_LAG_DAYS = 7;
/** Allow trade dates to differ by this many days for near-miss fuzzy match. */
export const LATENCY_FUZZY_DATE_SLACK_DAYS = 2;
/**
 * Exact lastName_ticker_date_side hit against CT's full transactions table,
 * including seed / competitor backfill / historical crawls that
 * {@link isLiveRaceImport} refuses to mint as races. Counts as coverage, never
 * as a timed Ahead/Behind race — otherwise a bulk reimport would mint fake
 * "CT was first" wins. See issue #1523 failure mode #2.
 */
export const CORPUS_MATCH_METHOD = 'corpus-hash';
/** Parser-health alarm: this many stored rows before a missing-filer ratio is meaningful. */
export const LATENCY_PARSER_HEALTH_MIN_ROWS = 8;
/** Parser-health alarm: missing-filer share that means the provider parser is broken. */
export const LATENCY_PARSER_HEALTH_MISSING_FILER_RATIO = 0.25;

const BACKFILL_TX_SOURCES = new Set(['seed_dataset', 'competitor_backfill']);

/**
 * True when this CT row is a live discovery/import we want on the scoreboard.
 * Excludes seed/competitor backfills and primary-path historical crawls where
 * we first_seen the filing long after it was filed.
 */
export function isLiveRaceImport(opts: {
  source?: string | null;
  filedDate?: string | null;
  firstSeenAt?: string | null;
  maxLagDays?: number;
}): boolean {
  const src = (opts.source || 'primary').toLowerCase();
  if (BACKFILL_TX_SOURCES.has(src)) return false;
  const filedRaw = opts.filedDate?.trim();
  const seenRaw = opts.firstSeenAt?.trim();
  if (!filedRaw || !seenRaw) return true; // no lag signal — allow primary-like sources
  const filedMs = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(filedRaw) ? `${filedRaw}T00:00:00.000Z` : filedRaw);
  const seenMs = Date.parse(seenRaw);
  if (!Number.isFinite(filedMs) || !Number.isFinite(seenMs)) return true;
  const lagDays = (seenMs - filedMs) / 86_400_000;
  const maxLag = opts.maxLagDays ?? LATENCY_LIVE_FILING_MAX_LAG_DAYS;
  // first_seen long after filed → historical backfill crawl, not live scout/agreement.
  if (lagDays > maxLag) return false;
  return true;
}

const PROVIDERS: ProviderDefinition[] = [
  {
    id: 'fmp',
    label: 'FMP Stable',
    // Slot 2 may also resolve FMP_API_KEY (see resolveFmpLatencyKeyMaterial).
    secretNames: [FMP_LATENCY_KEY_PRIMARY, FMP_LATENCY_KEY_SECONDARY, 'FMP_API_KEY'],
    requiresMembership: true,
    supportsDirectLatest: true,
    timestampKind: 'monitor',
    fmpPathId: 'stable',
    reason:
      'FMP stable host (financialmodelingprep.com) house-latest + senate-latest. Default ON for CT latency when a free-tier key is present; set FMP_LATENCY_PROBE_ENABLED=false to disable. Dual keys (FMP_LATENCY_API_KEY + FMP_LATENCY_API_KEY_2, or FMP_API_KEY as slot-2 fallback) fail over: a 429, daily cap, or 401/403 on one key leaves the other probing. RapidAPI is not a congress disclosure path (those routes 404). No provider first-seen timestamp; monitor first-observed is used.',
    fetchRows: (apiKey, max, fetchImpl, pace, opts) =>
      fetchFmpRows(apiKey, max, fetchImpl, pace, {
        baseUrl: opts?.baseUrl ?? FMP_LATENCY_PATHS[0]!.defaultBaseUrl,
        auth: 'query',
        providerId: 'fmp',
      }),
  },
  {
    id: 'fmp_rapidapi',
    label: 'FMP RapidAPI',
    // Marketplace keys only (ST shared RAPIDAPI_KEY). Never FMP_LATENCY_* free-tier.
    secretNames: ['FMP_RAPIDAPI_KEY', 'RAPIDAPI_KEY'],
    requiresMembership: true,
    supportsDirectLatest: true,
    timestampKind: 'monitor',
    fmpPathId: 'rapidapi',
    reason:
      'Not a congress disclosure probe. RapidAPI FMP house-latest and senate-latest return HTTP 404 (rechecked 2026-09-04); executive-latest is not an OGE feed. Listing rapidapi in FMP_LATENCY_PATHS does not spend marketplace quota on those routes and does not replace the stable dual-key probes. Ticker enrichment stays with Socratic.Trade.',
    fetchRows: (apiKey, max, fetchImpl, pace, opts) =>
      fetchFmpRows(apiKey, max, fetchImpl, pace, {
        baseUrl: opts?.baseUrl ?? FMP_LATENCY_PATHS[1]!.defaultBaseUrl,
        auth: 'rapidapi',
        rapidApiHost: opts?.rapidApiHost ?? FMP_LATENCY_PATHS[1]!.rapidApiHost,
        providerId: 'fmp_rapidapi',
      }),
  },
  {
    id: 'unusual_whales',
    label: 'Unusual Whales',
    secretNames: ['UNUSUAL_WHALES_API_KEY', 'UNUSUALWHALES_API_KEY'],
    requiresMembership: true,
    supportsDirectLatest: true,
    timestampKind: 'monitor',
    reason:
      'Recent Congress trades exposes filed_at_date, but not a provider first-seen timestamp. Single API key (trial/paid).',
    fetchRows: fetchUnusualWhalesRows,
  },
  {
    id: 'quiver',
    label: 'Quiver Quantitative',
    secretNames: ['QUIVER_API_KEY', 'QUIVER_API_TOKEN'],
    requiresMembership: true,
    supportsDirectLatest: true,
    timestampKind: 'provider',
    reason: 'Quiver V2 rows may include Quiver_Upload_Time; otherwise the monitor first-observed time is used.',
    fetchRows: fetchQuiverRows,
  },
  {
    id: 'finnhub',
    label: 'Finnhub',
    secretNames: ['FINNHUB_API_KEY'],
    requiresMembership: true,
    supportsDirectLatest: false,
    timestampKind: 'none',
    reason: 'Finnhub congressional trading is symbol/date-range scoped, not a global latest-disclosure feed.',
  },
  {
    id: 'ainvest',
    label: 'AInvest',
    secretNames: ['AINVEST_API_KEY'],
    requiresMembership: true,
    supportsDirectLatest: false,
    timestampKind: 'none',
    reason: 'AInvest congressional trades require a ticker parameter, so they cannot race all new disclosures directly.',
  },
  {
    id: 'capitol_trades',
    label: 'Capitol Trades',
    secretNames: [],
    requiresMembership: false,
    supportsDirectLatest: false,
    timestampKind: 'none',
    reason: 'No official API found; the public site is protected by a browser checkpoint, so this remains manual/unsupported.',
  },
];

function truthy(v: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((v ?? '').trim());
}

/**
 * Master switch for FMP-family latency probes.
 * Default ON for Congress.Trade (FMP is a first-class CT data path / latency race source).
 * Explicitly disable with FMP_LATENCY_PROBE_ENABLED=false|0|off|no.
 * (Socratic.Trade blocks FMP product use separately — this switch is CT-only.)
 */
export async function isFmpProbeEnabled(env: Env): Promise<boolean> {
  const envx = env as EnvWithWatch;
  const live =
    (await resolveSecret(env, 'FMP_LATENCY_PROBE_ENABLED')).value ?? envx.FMP_LATENCY_PROBE_ENABLED;
  if (live === undefined || live === null || String(live).trim() === '') return true;
  // Explicit falsey
  if (/^(0|false|no|off)$/i.test(String(live).trim())) return false;
  return truthy(String(live));
}

/**
 * Which FMP paths the operator listed. Congress disclosure probes do **not**
 * honor `rapidapi` here: house/senate-latest 404 on that product, so selecting
 * it would skip a stable cycle. `selectFmpLatencyPathForCycle` always returns
 * `stable` when a free-tier key can spend. Empty/invalid config falls back to
 * stable. RapidAPI stays in the registry so status can explain the skip.
 */
export async function enabledFmpPathIds(env: Env): Promise<Set<FmpLatencyPathId>> {
  const envx = env as EnvWithWatch;
  const raw =
    (await resolveSecret(env, 'FMP_LATENCY_PATHS')).value ?? envx.FMP_LATENCY_PATHS ?? 'stable';
  const parts = raw
    .split(/[,\s]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const out = new Set<FmpLatencyPathId>();
  for (const p of parts) {
    if (p === 'stable' || p === 'fmp') out.add('stable');
    if (p === 'rapidapi' || p === 'fmp_rapidapi' || p === 'rapid') out.add('rapidapi');
  }
  if (!out.size) {
    out.add('stable');
  }
  return out;
}

export async function resolveFmpPathRuntime(
  env: Env,
  path: FmpLatencyPathDefinition,
): Promise<{ baseUrl: string; rapidApiHost?: string }> {
  const envx = env as EnvWithWatch;
  if (path.pathId === 'stable') {
    const base =
      (await resolveSecret(env, 'FMP_STABLE_BASE_URL')).value ??
      envx.FMP_STABLE_BASE_URL ??
      path.defaultBaseUrl;
    return { baseUrl: base.replace(/\/+$/, '') };
  }
  const base =
    (await resolveSecret(env, 'FMP_RAPIDAPI_BASE_URL')).value ??
    envx.FMP_RAPIDAPI_BASE_URL ??
    path.defaultBaseUrl;
  const host =
    (await resolveSecret(env, 'FMP_RAPIDAPI_HOST')).value ??
    envx.FMP_RAPIDAPI_HOST ??
    path.rapidApiHost;
  return { baseUrl: base.replace(/\/+$/, ''), rapidApiHost: host };
}

async function enabled(env: EnvWithWatch): Promise<boolean> {
  // wrangler.toml / Deno env may carry a literal fallback; resolveSecret already
  // falls back to env[key] when Infisical has nothing configured for this name.
  // Infisical override wins when set. Production should set the full latency
  // knob set in Infisical (enabled/providers/limit + UW deep-match).
  const watchEnabled =
    (await resolveSecret(env, 'DISCLOSURE_LATENCY_WATCH_ENABLED')).value ?? env.DISCLOSURE_LATENCY_WATCH_ENABLED;
  const legacyEnabled =
    (await resolveSecret(env, 'FMP_DISCLOSURE_WATCH_ENABLED')).value ?? env.FMP_DISCLOSURE_WATCH_ENABLED;
  return truthy(watchEnabled) || truthy(legacyEnabled);
}

async function limit(env: EnvWithWatch): Promise<number> {
  const raw =
    (await resolveSecret(env, 'DISCLOSURE_LATENCY_WATCH_LIMIT')).value ??
    (await resolveSecret(env, 'FMP_DISCLOSURE_WATCH_LIMIT')).value ??
    env.DISCLOSURE_LATENCY_WATCH_LIMIT ??
    env.FMP_DISCLOSURE_WATCH_LIMIT;
  const n = parseInt(raw || '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : DEFAULT_LIMIT;
}

/** How many distinct filed dates the UW deep-match pass may query per probe
 *  run. Unset/invalid -> default 8; explicit "0" disables the pass; clamped
 *  to [0, 25] otherwise so a misconfigured value can't blow up UW call
 *  volume. */
async function uwDeepMatchDatesPerRun(env: EnvWithWatch): Promise<number> {
  const raw =
    (await resolveSecret(env, 'UW_DEEP_MATCH_DATES_PER_RUN')).value ?? env.UW_DEEP_MATCH_DATES_PER_RUN;
  if (raw == null || raw.trim() === '') return UW_DEEP_MATCH_DEFAULT_DATES_PER_RUN;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return UW_DEEP_MATCH_DEFAULT_DATES_PER_RUN;
  return Math.min(Math.max(n, 0), UW_DEEP_MATCH_MAX_DATES_PER_RUN);
}

/** True when `err` reflects an optional table/column that hasn't been migrated yet. */
export function storageMissing(err: unknown): boolean {
  return /no such table|no column named|no such column/i.test(err instanceof Error ? err.message : String(err));
}

function definition(id: ProviderId): ProviderDefinition {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

async function requestedProviderIds(env: EnvWithWatch, opts: { providers?: string[] } = {}): Promise<ProviderId[]> {
  const configured =
    (await resolveSecret(env, 'DISCLOSURE_LATENCY_PROVIDERS')).value ?? env.DISCLOSURE_LATENCY_PROVIDERS;
  const raw = opts.providers?.length ? opts.providers.join(',') : configured || '';
  const parsed = raw
    .split(/[,\s]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean) as ProviderId[];
  const allowed = new Set(PROVIDERS.map((p) => p.id));
  const ids = parsed.filter((id) => allowed.has(id));
  return ids.length ? Array.from(new Set(ids)) : [...DIRECT_PROVIDER_IDS];
}

function normalizeDate(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  return s.slice(0, 10);
}

function normalizeTimestamp(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s || /^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function dateVariants(iso: string | null): string[] {
  if (!iso) return [];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return [iso.toLowerCase()];
  return [iso, `${Number(m[2])}/${Number(m[3])}/${m[1]}`, `${m[2]}/${m[3]}/${m[1]}`].map((s) => s.toLowerCase());
}

function collectPrimitiveText(v: unknown, out: string[] = []): string[] {
  if (v == null) return out;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    out.push(String(v));
    return out;
  }
  if (Array.isArray(v)) {
    for (const item of v) collectPrimitiveText(item, out);
    return out;
  }
  if (typeof v === 'object') {
    for (const item of Object.values(v as Record<string, unknown>)) collectPrimitiveText(item, out);
  }
  return out;
}

function rowText(row: Record<string, unknown>): string {
  return collectPrimitiveText(row).join(' ').toLowerCase();
}

function rowStrings(row: Record<string, unknown>): string[] {
  return collectPrimitiveText(row).filter((v) => typeof v === 'string');
}

function firstUrl(row: Record<string, unknown>): string | null {
  for (const value of rowStrings(row)) {
    if (/^https?:\/\//i.test(value)) return value;
    if (/\/search\/view\/ptr\//i.test(value)) return value;
    if (/ptr-pdfs/i.test(value)) return value;
  }
  return null;
}

function fieldString(row: Record<string, unknown>, names: string[]): string | null {
  const lower = new Map(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
  for (const name of names) {
    const v = lower.get(name.toLowerCase());
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

function simpleHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function providerKeyFromUrl(url: string | null): string | null {
  if (!url) return null;
  const lower = url.toLowerCase();
  const house = /\/ptr-pdfs\/\d{4}\/([^/?#]+?)(?:\.pdf)?(?:[?#].*)?$/i.exec(lower);
  if (house && house[1].length >= 6) return house[1];
  const senate = /\/search\/view\/ptr\/([^/?#]+)/i.exec(lower);
  if (senate && senate[1].length >= 6) return senate[1];
  const path = lower.split(/[?#]/, 1)[0].split('/');
  const last = path.filter(Boolean).slice(-1)[0]?.replace(/\.pdf$/i, '');
  return last && last.length >= 6 ? last : null;
}

function tokensFromDoc(docId: string, sourceUrl: string | null): string[] {
  const out = new Set<string>();
  const docLower = docId.toLowerCase();
  if (docLower.length >= 6) out.add(docLower);
  const urlLower = (sourceUrl ?? '').toLowerCase();
  if (urlLower.length >= 12) out.add(urlLower);
  const key = providerKeyFromUrl(sourceUrl);
  if (key) out.add(key);
  for (const part of docLower.split(/[^a-z0-9]+/)) {
    if (part.length >= 6) out.add(part);
  }
  const house = /^h-\d{4}-(.+)$/i.exec(docId);
  if (house && house[1].length >= 6) out.add(house[1].toLowerCase());
  const senate = /^s-(.+)$/i.exec(docId);
  if (senate && senate[1].length >= 6) out.add(senate[1].toLowerCase());
  return Array.from(out).filter((t) => t.length >= 6);
}


/**
 * Full name of the person a provider row is about.
 *
 * Every provider ships the filer under different keys, and one of them (FMP's
 * `/stable/{house,senate}-latest`) ships no full-name key at all — it splits
 * the person across `firstName` / `lastName` and repeats the display name in
 * `office`. Reading only the full-name keys is how 309 of 309 stored FMP
 * observations ended up with `filer_name = NULL` and a trade hash whose
 * last-name segment was empty (`_PANW_2026-07-31_sell`), which
 * {@link matchDisclosureCandidate} rejects unconditionally — an unmatchable
 * row by construction.
 *
 * Resolution order, most to least trustworthy:
 *   1. `nameKeys` — the provider's declared full-name field.
 *   2. `firstName` + `lastName` — unambiguous structured name parts.
 *   3. `fallbackNameKeys` — display fields that USUALLY hold a person but are
 *      not contractually a name (FMP's `office`), tried last so a provider
 *      that ever repurposes one cannot outrank the structured parts.
 *
 * The result goes through {@link cleanFilerName} — the SAME normalizer the
 * House/Senate extraction path uses on our own side of the race — so both
 * sides strip honorifics, flip "Last, First", and apply the curated
 * legal-name aliases (Rohit -> Ro Khanna) identically. Two sides normalized by
 * two different functions is how a join silently drifts.
 */
export function providerFilerName(
  payload: Record<string, unknown>,
  nameKeys: string[],
  fallbackNameKeys: string[] = [],
): string | null {
  const composed =
    [fieldString(payload, ['firstName', 'first_name']), fieldString(payload, ['lastName', 'last_name'])]
      .filter(Boolean)
      .join(' ') || null;
  const raw =
    fieldString(payload, nameKeys) ??
    composed ??
    (fallbackNameKeys.length ? fieldString(payload, fallbackNameKeys) : null);
  const cleaned = cleanFilerName(raw).trim();
  return cleaned || null;
}

export function extractLastName(name: string | null): string {
  if (!name) return '';
  const clean = name.replace(/\b[A-Za-z]\.\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = clean.split(',')[0].split(' ');
  const ignore = new Set(['jr', 'sr', 'md', 'ii', 'iii', 'iv', 'v', 'rep', 'sen', 'hon', 'dr', 'mr', 'mrs', 'ms', 'senator', 'representative', 'honorable']);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i].toLowerCase().replace(/[^a-z]/g, '');
    if (p && p.length > 1 && !ignore.has(p)) return p;
  }
  return '';
}

/** Normalize CT `P`/`S`/`E` and provider buy/sell/purchase/sale strings. */
export function normalizeTradeSide(type: string | null | undefined): 'buy' | 'sell' | 'exchange' {
  const tyStr = (type || '').toLowerCase().trim();
  if (!tyStr) return 'exchange';
  if (tyStr === 'p' || tyStr === 'b' || tyStr.includes('buy') || tyStr.includes('bought') || tyStr.includes('purchase')) return 'buy';
  if (tyStr === 's' || tyStr.includes('sell') || tyStr.includes('sold') || tyStr.includes('sale')) return 'sell';
  if (tyStr === 'e' || tyStr.includes('exchange')) return 'exchange';
  return 'exchange';
}

export function generateTradeHash(filerName: string | null, ticker: string | null, date: string | null, type: string | null): string {
  const ln = extractLastName(filerName);
  const tk = (ticker || '').toUpperCase().trim().replace(/^\$/, '').replace(/:.*$/, '').replace(/[\.\/]/g, '-');
  const dt = normalizeDate(date) || '';
  const ty = normalizeTradeSide(type);
  return `${ln}_${tk}_${dt}_${ty}`;
}

/**
 * True when a trade hash carries a usable last-name segment.
 *
 * `generateTradeHash(null, 'PANW', ...)` yields `_PANW_2026-07-31_sell`. That
 * string is a valid hash shape but an unmatchable identity:
 * {@link matchDisclosureCandidate} gates every path — exact and fuzzy — on a
 * non-empty last name on BOTH sides, so a hash with an empty leading segment
 * can never pair with anything. Storing such rows silently is what let FMP
 * report `operationalStatus: running` with `matched: 0` for weeks. Callers use
 * this to count and surface them instead of letting a parser regression look
 * like a real 0% match rate.
 */
export function tradeHashHasFiler(hash: string | null | undefined): boolean {
  return Boolean(parseTradeHash(hash).lastName);
}

/** Parse `lastName_ticker_YYYY-MM-DD_side` (ticker/date may be empty). */
export function parseTradeHash(hash: string | null | undefined): {
  lastName: string;
  ticker: string;
  date: string;
  side: string;
} {
  const raw = String(hash ?? '');
  const m = /^([^_]+)_([^_]*)_(\d{4}-\d{2}-\d{2})?_?(buy|sell|exchange)?$/i.exec(raw);
  if (m) {
    return {
      lastName: (m[1] || '').toLowerCase(),
      ticker: (m[2] || '').toUpperCase(),
      date: m[3] || '',
      side: (m[4] || '').toLowerCase(),
    };
  }
  // Fallback: lastName_ticker_date_side with date always YYYY-MM-DD when present.
  const parts = raw.split('_');
  if (parts.length >= 4) {
    const side = parts[parts.length - 1].toLowerCase();
    const date = parts[parts.length - 2];
    const lastName = (parts[0] || '').toLowerCase();
    const ticker = parts.slice(1, -2).join('_').toUpperCase();
    return {
      lastName,
      ticker: /^\d{4}-\d{2}-\d{2}$/.test(date) ? ticker : parts.slice(1, -1).join('_').toUpperCase(),
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
      side: ['buy', 'sell', 'exchange'].includes(side) ? side : '',
    };
  }
  return { lastName: '', ticker: '', date: '', side: '' };
}

/**
 * Prefer a real first-seen stamp when it is still inside the active score
 * window; otherwise use now. Prevents multi-year filing stamps from entering
 * the race as fake "CT was first by months" leads.
 */
export function raceFirstSeenAt(
  txFirstSeen: string | null | undefined,
  nowIso: string,
  windowHours = LATENCY_SCORE_WINDOW_HOURS,
): string {
  if (!txFirstSeen) return nowIso;
  const t = Date.parse(txFirstSeen);
  const n = Date.parse(nowIso);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return nowIso;
  if (n - t > windowHours * 3600_000) return nowIso;
  return txFirstSeen;
}

function chamberFromDocId(docId: string | null | undefined, fallback: Chamber = 'house'): Chamber {
  const id = (docId || '').trim().toUpperCase();
  if (id.startsWith('S-') || id.startsWith('SENATE-')) return 'senate';
  if (id.startsWith('E-') || id.startsWith('EXEC') || id.startsWith('OGE-')) return 'executive';
  if (id.startsWith('H-') || id.startsWith('HOUSE-')) return 'house';
  return fallback;
}

function lastName(name: string | null): string | null {
  if (!name) return null;
  const clean = name.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const comma = clean.indexOf(',');
  const last = comma >= 0 ? clean.slice(0, comma) : clean.split(' ').slice(-1)[0];
  return last && last.length >= 4 ? last.toLowerCase() : null;
}

function normalizeChamber(raw: string | null, fallback: Chamber): Chamber {
  const s = (raw ?? '').toLowerCase();
  if (s.includes('executive') || s.includes('president') || s.includes('whitehouse')) return 'executive';
  if (s.includes('senate') || s.includes('senator')) return 'senate';
  if (s.includes('house') || s.includes('representative') || s.includes('representatives')) return 'house';
  return fallback;
}

function extractRows(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    for (const key of ['data', 'results', 'items']) {
      const value = obj[key];
      if (Array.isArray(value)) {
        return value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const nested = extractRows(value);
        if (nested.length) return nested;
      }
    }
  }
  return [];
}

function rowKeyFromFields(provider: ProviderId, payload: Record<string, unknown>, fields: string[]): string {
  const parts = fields.map((field) => fieldString(payload, [field]) ?? '').filter(Boolean);
  const basis = parts.length ? parts.join('|') : rowText(payload);
  return `${provider}:${simpleHash(basis)}`;
}

export function parseFmpDisclosureRows(
  chamber: Chamber,
  json: unknown,
  providerId: ProviderId = 'fmp',
): FmpDisclosureRow[] {
  return extractRows(json).map((payload) => {
    const sourceUrl = firstUrl(payload);
    const text = rowText(payload);
    const docToken = providerKeyFromUrl(sourceUrl) ?? fieldString(payload, ['docId', 'documentId', 'reportId', 'disclosureId', 'disclosure_id']);
    const providerKey = docToken ? String(docToken).toLowerCase() : simpleHash(text);
    // FMP's /stable/{house,senate}-latest ships no full-name key at all: the
    // person arrives as firstName + lastName, repeated in `office` as a
    // display string ("Tommy Tuberville"). The legacy full-name keys stay in
    // the primary list so an older /api/v4 payload shape still parses.
    const filerName = providerFilerName(
      payload,
      ['representative', 'senator', 'filerName', 'name'],
      ['office'],
    );
    return {
      provider: providerId,
      chamber,
      providerKey,
      tradeHash: generateTradeHash(filerName, fieldString(payload, ['ticker', 'symbol']), fieldString(payload, ['transactionDate', 'txDate']), fieldString(payload, ['type', 'transactionType'])),
      payload,
      sourceUrl,
      filedDate: normalizeDate(fieldString(payload, ['filedDate', 'filingDate', 'disclosureDate', 'reportedDate'])),
      filerName,
      providerPublishedAt: null,
    };
  });
}

export function parseUnusualWhalesDisclosureRows(json: unknown): DisclosureProviderRow[] {
  return extractRows(json).map((payload) => {
    const filedDate = normalizeDate(fieldString(payload, ['filed_at_date', 'filingDate', 'filedDate', 'filed_at', 'filing_date', 'date_filed', 'created_at']));
    const filerName = providerFilerName(payload, ['name', 'reporter']);
    return {
      provider: 'unusual_whales',
      chamber: normalizeChamber(fieldString(payload, ['member_type', 'chamber']), 'house'),
      providerKey: rowKeyFromFields('unusual_whales', payload, [
        'politician_id',
        'filed_at_date',
        'ticker',
        'transaction_date',
        'txn_type',
        'name',
      ]),
      tradeHash: generateTradeHash(filerName, fieldString(payload, ['ticker', 'symbol']), fieldString(payload, ['transaction_date']), fieldString(payload, ['txn_type', 'type'])),
      payload,
      sourceUrl: firstUrl(payload),
      filedDate,
      filerName,
      providerPublishedAt: normalizeTimestamp(fieldString(payload, ['created_at', 'published_at', 'inserted_at', 'updated_at'])),
    };
  });
}

export function parseQuiverDisclosureRows(chamber: Chamber, json: unknown, defaultFilerName?: string): DisclosureProviderRow[] {
  return extractRows(json).map((payload) => {
    const filedDate = normalizeDate(fieldString(payload, ['Filed', 'ReportDate', 'report_date', 'filed_date', 'last_modified', 'DateRecieved', 'date_received', 'Date_Received', 'Report_Date']));
    const filerName =
      providerFilerName(payload, ['Representative', 'Senator', 'Name', 'representative', 'senator', 'name']) ||
      cleanFilerName(defaultFilerName ?? null) ||
      '';
    return {
      provider: 'quiver',
      chamber: normalizeChamber(fieldString(payload, ['Chamber', 'House', 'house']), chamber),
      providerKey: rowKeyFromFields('quiver', payload, [
        'BioGuideID',
        'Representative',
        'Senator',
        'Name',
        'Filed',
        'ReportDate',
        'Ticker',
        'TransactionDate',
        'Date',
        'Traded',
        'Transaction',
      ]),
      tradeHash: generateTradeHash(filerName, fieldString(payload, ['Ticker']), fieldString(payload, ['TransactionDate', 'Date']), fieldString(payload, ['Transaction'])),
      payload,
      sourceUrl: firstUrl(payload),
      filedDate,
      filerName,
      providerPublishedAt: normalizeTimestamp(fieldString(payload, ['Quiver_Upload_Time', 'last_modified', 'created_at'])),
    };
  });
}

/** Absolute day distance between two YYYY-MM-DD strings, or null if unparsable. */
export function tradeDateDayDistance(a: string, b: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
  const ms = Date.parse(`${a}T00:00:00.000Z`) - Date.parse(`${b}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.round(Math.abs(ms) / 86_400_000);
}

export function matchDisclosureCandidate(
  candidate: Pick<CandidateRow, 'trade_hash'>,
  row: DisclosureProviderRow,
): CandidateMatch | null {
  if (candidate.trade_hash && row.tradeHash && candidate.trade_hash === row.tradeHash) {
    return { providerKey: row.providerKey, matchMethod: 'trade-hash' };
  }

  const c = parseTradeHash(candidate.trade_hash);
  const r = parseTradeHash(row.tradeHash);
  const sameLastName =
    c.lastName &&
    r.lastName &&
    (c.lastName === r.lastName ||
      (c.lastName.length >= 4 && r.lastName.length >= 4 && (c.lastName.includes(r.lastName) || r.lastName.includes(c.lastName))));
  if (!sameLastName) return null;
  if (!c.side || !r.side || c.side !== r.side) return null;

  const sameTicker = Boolean(c.ticker && r.ticker && c.ticker === r.ticker);
  const eitherTickerMissing = !c.ticker || !r.ticker;
  const sameDate = Boolean(c.date && r.date && c.date === r.date);
  const eitherDateMissing = !c.date || !r.date;
  const nearDate =
    !!c.date &&
    !!r.date &&
    !sameDate &&
    (tradeDateDayDistance(c.date, r.date) ?? 99) <= LATENCY_FUZZY_DATE_SLACK_DAYS;

  // Same politician + ticker + side; date equal or missing on one side.
  if (sameTicker && (sameDate || eitherDateMissing)) {
    return { providerKey: row.providerKey, matchMethod: 'fuzzy-missing-date' };
  }

  // Same politician + ticker + side; trade dates within slack (providers
  // sometimes use filed/settlement vs transaction date).
  if (sameTicker && nearDate) {
    return { providerKey: row.providerKey, matchMethod: 'fuzzy-near-date' };
  }

  // Same politician + date + side; ticker missing on one side (provider
  // option/trust lines often omit the equity ticker).
  if (sameDate && eitherTickerMissing) {
    return { providerKey: row.providerKey, matchMethod: 'fuzzy-no-ticker' };
  }

  return null;
}

export function matchFmpDisclosureCandidate(
  candidate: Pick<CandidateRow, 'trade_hash'>,
  row: FmpDisclosureRow,
): CandidateMatch | null {
  return matchDisclosureCandidate(candidate, row);
}

async function fetchJson(url: string, headers: Record<string, string>, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await trackedFetch(url, {
    headers: { 'user-agent': 'congress.trade/0.1 (+https://congress.trade)', accept: 'application/json', ...headers },
  }, { service: 'disclosure-latency', operation: 'fetch-provider-latest' }, fetchImpl);
  if (!res.ok) throw new Error(`HTTP_${res.status}:${url.replace(/[?&](apikey|token)=[^&]+/gi, '$1=[redacted]')}`);
  return res.json();
}

export interface FetchFmpRowsOpts {
  baseUrl?: string;
  auth?: 'query' | 'rapidapi';
  rapidApiHost?: string;
  providerId?: ProviderId;
}

/**
 * Fetch house+senate latest disclosures from an FMP path (stable or RapidAPI).
 * Path bases are injectable so alternate hosts can race without code edits.
 *
 * FMP has no OGE/executive-latest feed (stable HTTP 404; RapidAPI 400 is the
 * same gateway rejection as company key-executives, not political 278-T).
 * Rechecked 2026-09-04. Do not add fetchOne('executive') until that 200s.
 */
async function fetchFmpRows(
  apiKey: string,
  max: number,
  fetchImpl: typeof fetch,
  pace: () => Promise<void> = async () => {},
  opts: FetchFmpRowsOpts = {},
): Promise<DisclosureProviderRow[]> {
  const baseUrl = (opts.baseUrl ?? 'https://financialmodelingprep.com/stable').replace(/\/+$/, '');
  const auth = opts.auth ?? 'query';
  const providerId = opts.providerId ?? 'fmp';
  const fetchOne = async (chamber: Chamber) => {
    const fmpLimit = Math.min(max, 25);
    let url = `${baseUrl}/${chamber}-latest?page=0&limit=${fmpLimit}`;
    const headers: Record<string, string> = {};
    if (auth === 'rapidapi') {
      // Socratic.Trade RapidAPI transport: header auth only (never query apikey).
      headers['x-rapidapi-key'] = apiKey;
      if (opts.rapidApiHost) headers['x-rapidapi-host'] = opts.rapidApiHost;
    } else {
      url += '&apikey=' + encodeURIComponent(apiKey);
    }
    try {
      // Latency-only pacer: serializes house+senate; separate from enrichment.
      await pace();
      return parseFmpDisclosureRows(chamber, await fetchJson(url, headers, fetchImpl), providerId);
    } catch (err) {
      const status = /HTTP_(\d+)/.exec((err as Error).message)?.[1];
      if (status) assertFmpTierOk(Number(status));
      if (chamber === 'executive' && status === '404') return [];
      throw err;
    }
  };
  return (await Promise.all([fetchOne('house'), fetchOne('senate')])).flat();
}

function unusualWhalesHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, 'UW-CLIENT-API-ID': '100001' };
}

async function fetchUnusualWhalesRows(apiKey: string, max: number, fetchImpl: typeof fetch): Promise<DisclosureProviderRow[]> {
  const url = `https://api.unusualwhales.com/api/congress/recent-trades?limit=${Math.min(max, 200)}`;
  return parseUnusualWhalesDisclosureRows(await fetchJson(url, unusualWhalesHeaders(apiKey), fetchImpl));
}

/**
 * Deep-match fetch: same recent-trades endpoint and parser as
 * fetchUnusualWhalesRows, anchored to one date via UW's `date` query param
 * instead of just taking the newest ~200 rows. IMPORTANT: UW's `date` param
 * filters by TRANSACTION date, not filed_at_date (verified against the live
 * API), so callers must pass a parsed transaction date from the filing, never
 * the candidate's filed_date. Used by runUnusualWhalesDeepMatch to pull
 * disclosures that have already scrolled outside the normal window. Not a
 * fork of the parsing/matching logic - only the request URL differs.
 */
async function fetchUnusualWhalesRowsForDate(
  apiKey: string,
  fetchImpl: typeof fetch,
  txDate: string,
): Promise<DisclosureProviderRow[]> {
  const url = `https://api.unusualwhales.com/api/congress/recent-trades?limit=200&date=${encodeURIComponent(txDate)}`;
  return parseUnusualWhalesDisclosureRows(await fetchJson(url, unusualWhalesHeaders(apiKey), fetchImpl));
}

async function fetchQuiverRows(apiKey: string, max: number, fetchImpl: typeof fetch): Promise<DisclosureProviderRow[]> {
  const headers = { authorization: `Token ${apiKey}`, 'Accept': 'application/json' };
  const endpoints: Array<{ chamber: Chamber; url: string; defaultFilerName?: string }> = [
    { chamber: 'house', url: 'https://api.quiverquant.com/beta/live/housetrading?options=true' },
    { chamber: 'senate', url: 'https://api.quiverquant.com/beta/live/senatetrading?options=true' },
    { chamber: 'executive', url: 'https://api.quiverquant.com/beta/bulk/trumpstocktrades', defaultFilerName: 'Donald Trump' },
  ];
  const rows: DisclosureProviderRow[] = [];
  const errors: Error[] = [];
  await Promise.all(
    endpoints.map(async ({ chamber, url, defaultFilerName }) => {
      try {
        const json = await fetchJson(url, headers, fetchImpl);
        const sliced = Array.isArray(json) ? json.slice(0, max) : json;
        rows.push(...parseQuiverDisclosureRows(chamber, sliced, defaultFilerName));
      } catch (err) {
        errors.push(err as Error);
      }
    }),
  );
  // A 403/401 on every live endpoint used to become [] and record as success
  // (lastSuccess=now, 0 rows) while last_observed_at stayed days old. Do not
  // swallow a total failure as an empty feed.
  if (errors.length && rows.length === 0) throw errors[0]!;
  return rows;
}


function providerOnlyDocId(row: DisclosureProviderRow): string {
  const key = row.providerKey.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) || simpleHash(rowText(row.payload));
  return `provider-missing-${row.provider}-${row.chamber}-${key}`;
}

/**
 * review_queue payload for a provider-only stub, capped at PAYLOAD_LIMIT.
 * Slicing the whole JSON leaves invalid JSON, which loses provider/providerKey
 * for the official-side reconcile (providerMissingStubClose.ts).  When the
 * payload is over the cap, drop the raw provider payload first so the identity
 * fields stay parseable.  Exported for unit tests.
 */
export function providerStubReviewPayload(
  fields: { payload: unknown } & Record<string, unknown>,
  limit = PAYLOAD_LIMIT,
): string {
  const full = JSON.stringify(fields);
  if (full.length <= limit) return full;
  const compact = JSON.stringify({ ...fields, payload: null, payloadTruncated: true });
  return compact.slice(0, limit);
}

/** Exported for unit tests. */
export async function routeProviderOnlyObservationsToReview(
  env: Env,
  provider: ProviderId,
  rows: DisclosureProviderRow[],
  nowIso: string,
): Promise<void> {
  for (const row of rows) {
    if (row.chamber !== 'house' && row.chamber !== 'senate') continue;
    const docId = providerOnlyDocId(row);
    const closeResult = await closeProviderMissingStubIfOfficialPersisted(env, row, docId, nowIso);
    if (closeResult.officialDocId) continue;

    // Official Senate PTR URL/UUID from the provider feed: enqueue S-{uuid}
    // and skip the synthetic review stub.  House PDF ids stay on the stub path.
    if (await enqueueOfficialSenateFromProviderObservation(env, row, nowIso)) continue;

    if (await findOfficialCounterpartDocIdForObservation(env.DB, row)) continue;

    const exists1 = await get<{ doc_id: string }>(env.DB, `SELECT doc_id FROM filings WHERE doc_id = ? LIMIT 1`, [docId]);
    if (exists1) continue;

    const exists3 = await get<{ doc_id: string }>(
      env.DB,
      `SELECT doc_id FROM trade_latency_candidates WHERE provider = ? AND provider_key = ? AND status = 'matched' LIMIT 1`,
      [provider, row.providerKey]
    );
    if (exists3) continue;

    const payload = providerStubReviewPayload({
      reason: 'provider_discovered_missing_official',
      provider,
      providerKey: row.providerKey,
      providerPublishedAt: row.providerPublishedAt,
      filedDate: row.filedDate,
      filerName: row.filerName,
      sourceUrl: row.sourceUrl,
      payload: row.payload,
    });

    // No notifyReviewQueuePublisher here: a provider-only stub is a synthetic
    // lead that the hourly sweep closes as verified_empty (or rejects as a
    // duplicate once the official filing persists).  It never needs a human,
    // so waking the Publisher with review_queue.entered for it is pure noise.
    await batch(env.DB, [
      [
        `INSERT OR IGNORE INTO filings
           (doc_id, chamber, filer_id, filing_type, filed_date, source_url,
            raw_object_key, ingest_status, doc_kind, extractor, model_version,
            confidence, first_seen_at, source_updated_at, error)
         VALUES (?, ?, NULL, 'P', ?, ?, NULL, 'needs_review', 'unknown', NULL, NULL,
                 NULL, ?, ?, ?)`,
        [
          docId,
          row.chamber,
          row.filedDate,
          row.sourceUrl,
          nowIso,
          row.providerPublishedAt,
          `provider-only:${provider}:${row.providerKey}`,
        ],
      ],
      [
        `INSERT OR IGNORE INTO review_queue (doc_id, reason, payload, created_at, resolved)
         VALUES (?, 'provider_discovered_missing_official', ?, ?, 0)`,
        [docId, payload, nowIso],
      ],
    ]);
  }
}


async function resolveProviderSecret(env: Env, provider: ProviderDefinition): Promise<string | null> {
  for (const name of provider.secretNames) {
    const envx = env as unknown as Record<string, string | undefined>;
    const value = (await resolveSecret(env, name as keyof Env & string)).value ?? envx[name];
    if (value?.trim()) return value.trim();
  }
  return null;
}

async function providerStatus(env: Env, provider: ProviderDefinition): Promise<DisclosureLatencyProviderStatus> {
  const configured = provider.secretNames.length === 0 || Boolean(await resolveProviderSecret(env, provider));
  const fmpProbeOn = isFmpFamilyProvider(provider.id) ? await isFmpProbeEnabled(env) : true;
  const requested = provider.supportsDirectLatest
    ? await requestedProviderIds(env as EnvWithWatch)
    : null;

  let operationalStatus: LatencySourceStatus = 'unknown';
  let reason = provider.reason;
  if (provider.fmpPathId === 'rapidapi') {
    // Grey OFF even when FMP_LATENCY_PATHS lists rapidapi. Those congress
    // routes 404, so this lane must not look "running" or replace stable.
    operationalStatus = 'off';
    reason =
      'OFF: RapidAPI FMP has no house/senate-latest (HTTP 404) and no OGE executive feed (rechecked 2026-09-04). Stable dual-key probes are the congress disclosure lane. Marketplace quota is not spent on these routes.';
  } else if (isFmpFamilyProvider(provider.id) && !fmpProbeOn) {
    // Intentional disable — grey OFF, not red stopped.
    // Stable stays eligible when the probe is on even if FMP_LATENCY_PATHS
    // omitted it (a rapidapi-only list must not silence house/senate).
    operationalStatus = 'off';
    reason = 'OFF: FMP_LATENCY_PROBE_ENABLED is false/off (explicit disable)';
  } else if (requested && !requested.includes(provider.id)) {
    // Filtered out of the probe set — the documented way to retire a
    // provider (e.g. a dropped subscription) without deleting its key or
    // its historical observations. Grey OFF, not red error-by-age.
    operationalStatus = 'off';
    reason = `OFF: "${provider.id}" not in DISCLOSURE_LATENCY_PROVIDERS`;
  } else if (!provider.supportsDirectLatest) {
    operationalStatus = 'stopped';
  } else if (!configured) {
    operationalStatus = 'stopped';
    reason = reason ?? `${provider.secretNames[0] ?? 'secret'} missing`;
  } else {
    operationalStatus = 'running';
    // A configured key is not "running".  FMP/UW/QQ stayed running for 95h
    // of silence because this branch never looked at last_observed_at.
    try {
      const row = await get<{ last_obs: string | null }>(
        env.DB,
        'SELECT MAX(last_observed_at) AS last_obs FROM trade_provider_observations WHERE provider = ?',
        [provider.id],
      );
      const ms = row?.last_obs ? Date.parse(row.last_obs) : NaN;
      if (Number.isFinite(ms)) {
        const ageH = (Date.now() - ms) / 3_600_000;
        if (ageH > 24) {
          let lastOkMs = NaN;
          try {
            const run = await get<{ last_ok: string | null }>(
              env.DB,
              'SELECT MAX(ran_at) AS last_ok FROM provider_probe_runs WHERE provider = ? AND ok = 1',
              [provider.id],
            );
            lastOkMs = run?.last_ok ? Date.parse(run.last_ok) : NaN;
          } catch {
            /* table may not exist yet */
          }
          const lastOkAgeH = Number.isFinite(lastOkMs) ? (Date.now() - lastOkMs) / 3_600_000 : Infinity;
          if (lastOkAgeH <= 24) {
            reason = `${provider.label} last new observation ${Math.round(ageH)}h ago; probes still succeeding (${Math.round(lastOkAgeH)}h)`;
          } else {
            operationalStatus = 'error';
            reason = `${provider.label} last observation ${Math.round(ageH)}h ago (threshold 24h)`;
          }
        }
      }
    } catch {
      /* no DB / table — leave running so config-only callers stay unchanged */
    }
  }

  return {
    id: provider.id,
    label: provider.label,
    configured,
    requiresMembership: provider.requiresMembership,
    supportsDirectLatest: provider.supportsDirectLatest,
    timestampKind: provider.timestampKind,
    operationalStatus,
    pathId: provider.fmpPathId,
    reason,
  };
}

export async function getDisclosureLatencyProviderStatuses(env: Env): Promise<DisclosureLatencyProviderStatus[]> {
  const statuses: DisclosureLatencyProviderStatus[] = [];
  for (const provider of PROVIDERS) statuses.push(await providerStatus(env, provider));
  return statuses;
}

/**
 * Provider ids the current config expects to be producing latency
 * observations: the requested set (DISCLOSURE_LATENCY_PROVIDERS, default all
 * direct providers) minus providers whose switches or keys rule them out.
 * Feeds pipelineHealth's latency_probes check so an intentionally retired
 * provider (dropped subscription, filtered out or key removed) stops paging,
 * while a provider that SHOULD run still pages when it goes quiet.
 *
 * Membership providers (UW/Quiver) are key-gated: removing the key is a
 * deliberate retire, matching how dropped subscriptions are handled.  The
 * FMP family is switch-gated only (FMP_LATENCY_PROBE_ENABLED /
 * FMP_LATENCY_PATHS) — a missing FMP key with the switch still on is a
 * misconfiguration that must page, not a retire.
 *
 * Empty set when the disclosure-latency watch itself is off — callers decide
 * how loud "nothing is expected to run" should be.
 */
/** Config-intended latency providers (before auth-rejection latch). */
export async function configExpectedLatencyProviderIds(env: Env): Promise<Set<string>> {
  const envx = env as EnvWithWatch;
  const out = new Set<string>();
  if (!(await enabled(envx))) return out;
  for (const id of await requestedProviderIds(envx)) {
    const def = definition(id);
    if (!def.supportsDirectLatest) continue;
    if (isFmpFamilyProvider(id)) {
      if (!(await isFmpProbeEnabled(env))) continue;
      if (def.fmpPathId && !(await enabledFmpPathIds(env)).has(def.fmpPathId)) continue;
    } else if (!(await resolveProviderSecret(env, def))) {
      continue;
    }
    out.add(id);
  }
  return out;
}

export async function expectedLatencyProviderIds(env: Env): Promise<Set<string>> {
  const out = await configExpectedLatencyProviderIds(env);
  const { latencyProvidersWithRejectedCredentials } = await import('./scoutHandoff.ts');
  for (const id of await latencyProvidersWithRejectedCredentials(env)) out.delete(id);
  return out;
}


interface TradeLatencyTxContext {
  id: string;
  doc_id: string;
  ticker: string | null;
  tx_date: string | null;
  tx_type: string | null;
  filed_date: string | null;
  first_seen_at: string | null;
  prev_probe_at: string | null;
  chamber: Chamber | null;
  source_url: string | null;
  filer_name: string | null;
  source: string | null;
}

/**
 * Resolve filer name / chamber / source_url for trade-hash candidates.
 * Transaction.owner is self/spouse/joint — never the politician name.
 */
async function loadTradeLatencyTxContexts(
  env: Env,
  transactions: Transaction[],
): Promise<Map<string, TradeLatencyTxContext>> {
  const byId = new Map<string, TradeLatencyTxContext>();
  if (!transactions.length) return byId;
  const ids = Array.from(new Set(transactions.map((tx) => tx.id)));
  for (let i = 0; i < ids.length; i += SQL_IN_CHUNK) {
    const chunk = ids.slice(i, i + SQL_IN_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await all<TradeLatencyTxContext>(
      env.DB,
      `SELECT t.id, t.doc_id, t.ticker, t.tx_date, t.tx_type, t.source AS source,
              COALESCE(t.filed_date, f.filed_date) AS filed_date,
              COALESCE(t.first_seen_at, f.first_seen_at) AS first_seen_at,
              f.prev_probe_at AS prev_probe_at,
              f.chamber AS chamber,
              f.source_url AS source_url,
              fil.full_name AS filer_name
         FROM transactions t
         LEFT JOIN filings f ON f.doc_id = t.doc_id
         LEFT JOIN filers fil ON fil.bioguide_id = COALESCE(t.filer_id, f.filer_id)
        WHERE t.id IN (${placeholders})`,
      chunk,
    );
    for (const row of rows) byId.set(row.id, row);
  }
  return byId;
}

export async function recordTradeLatencyCandidates(
  env: Env,
  transactions: Transaction[],
  nowIso: string,
): Promise<void> {
  if (!transactions.length) return;
  let contexts: Map<string, TradeLatencyTxContext>;
  try {
    contexts = await loadTradeLatencyTxContexts(env, transactions);
  } catch (err) {
    if (!storageMissing(err)) console.warn('trade latency context lookup failed:', (err as Error).message);
    return;
  }

  const updates: Array<[string, SqlParam[]]> = [];
  const mintedHashes = new Set<string>();
  // ct_publish is scheduled inline, right here at mint time — the one moment
  // congress_first_seen_at is actually "now" (raceFirstSeenAt keeps the real
  // stamp for live imports), so the very next per-minute tick can capture it
  // LIVE instead of it aging into a backfill before a row even exists. See
  // latencyPriceSnapshots.ts's module header.
  const ctPublishRows: Array<{
    trade_hash: string;
    ticker: string | null;
    provider: ProviderId;
    congress_first_seen_at: string;
    isOption?: boolean | null;
    assetType?: string | null;
    assetTypeName?: string | null;
    assetName?: string | null;
  }> = [];
  for (const provider of DIRECT_PROVIDER_IDS) {
    for (const tx of transactions) {
      const ctx = contexts.get(tx.id);
      const filerName = ctx?.filer_name || tx.fullName || null;
      if (!filerName) continue;
      const firstSeenRaw = tx.firstSeenAt || ctx?.first_seen_at || nowIso;
      const filedDate = tx.filedDate || ctx?.filed_date || null;
      // Never mint races for seed/competitor backfills or historical crawls.
      if (
        !isLiveRaceImport({
          source: tx.source || ctx?.source,
          filedDate,
          firstSeenAt: firstSeenRaw,
        })
      ) {
        continue;
      }
      const chamber = normalizeChamber(ctx?.chamber ?? null, chamberFromDocId(tx.docId));
      const trade_hash = generateTradeHash(filerName, tx.ticker || ctx?.ticker || null, tx.txDate || ctx?.tx_date || null, tx.txType || ctx?.tx_type || null);
      if (!extractLastName(filerName)) continue;
      // Keep the real first_seen for live imports (no clamp-to-now for recent stamps).
      const firstSeen = raceFirstSeenAt(firstSeenRaw, nowIso, LATENCY_PROVIDER_MATCH_LOOKBACK_HOURS);
      const congressWindowStart = ctx?.prev_probe_at || null;
      mintedHashes.add(trade_hash);
      ctPublishRows.push({
        trade_hash,
        ticker: tx.ticker || ctx?.ticker || null,
        provider,
        congress_first_seen_at: firstSeen,
        isOption: tx.isOption,
        assetType: tx.assetType,
        assetTypeName: tx.assetTypeName ?? null,
        assetName: tx.assetName,
      });
      updates.push([
        `INSERT INTO trade_latency_candidates
           (trade_hash, doc_id, provider, chamber, source_url, filed_date, filer_name, ticker, tx_date, tx_type,
            congress_first_seen_at, congress_window_start, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
         ON CONFLICT(trade_hash, provider) DO UPDATE SET
           doc_id = excluded.doc_id,
           chamber = excluded.chamber,
           source_url = COALESCE(trade_latency_candidates.source_url, excluded.source_url),
           filed_date = COALESCE(trade_latency_candidates.filed_date, excluded.filed_date),
           filer_name = COALESCE(trade_latency_candidates.filer_name, excluded.filer_name),
           ticker = COALESCE(trade_latency_candidates.ticker, excluded.ticker),
           tx_date = COALESCE(trade_latency_candidates.tx_date, excluded.tx_date),
           tx_type = COALESCE(trade_latency_candidates.tx_type, excluded.tx_type),
           congress_first_seen_at = CASE
             WHEN trade_latency_candidates.congress_first_seen_at IS NULL
               OR trade_latency_candidates.congress_first_seen_at = ''
               OR excluded.congress_first_seen_at < trade_latency_candidates.congress_first_seen_at
             THEN excluded.congress_first_seen_at
             ELSE trade_latency_candidates.congress_first_seen_at
           END,
           congress_window_start = COALESCE(trade_latency_candidates.congress_window_start, excluded.congress_window_start),
           updated_at = excluded.updated_at`,
        [
          trade_hash,
          tx.docId,
          provider,
          chamber,
          ctx?.source_url || tx.sourceUrl || null,
          filedDate,
          filerName,
          tx.ticker || ctx?.ticker || null,
          tx.txDate || ctx?.tx_date || null,
          tx.txType || ctx?.tx_type || null,
          firstSeen,
          congressWindowStart,
          nowIso,
          nowIso,
        ],
      ]);
    }
  }
  if (updates.length > 0) {
    try {
      await batch(env.DB, updates);
    } catch (err) {
      if (!storageMissing(err)) console.warn('trade latency candidate write failed:', (err as Error).message);
      return;
    }
    // Best-effort ct_publish snapshot scheduling. scheduleCtPublishSnapshot
    // never throws (its own DB write is internally caught), but this loop is
    // still wrapped so a future change there can never break candidate
    // minting — the one thing this function must never fail to do.
    try {
      for (const row of ctPublishRows) {
        await scheduleCtPublishSnapshot(env, row, nowIso);
      }
    } catch (err) {
      if (!storageMissing(err)) {
        console.warn('trade latency ct_publish snapshot scheduling failed:', (err as Error).message);
      }
    }
    // Immediate match against already-stored provider observations so a live
    // publish that a provider already listed becomes a concurrent race now,
    // rather than waiting for the next cron probe.
    try {
      await matchJustMintedCandidates(env, Array.from(mintedHashes), nowIso);
    } catch (err) {
      if (!storageMissing(err)) {
        console.warn('trade latency immediate match failed:', (err as Error).message);
      }
    }
  }
}

/**
 * After minting candidates from a live publish, try to match each new
 * trade_hash against stored provider observations. Bounded and best-effort —
 * probe still owns the full pending scan.
 */
async function matchJustMintedCandidates(
  env: Env,
  hashes: string[],
  nowIso: string,
): Promise<void> {
  if (!hashes.length) return;

  for (const provider of PROVIDERS.filter((p) => p.supportsDirectLatest)) {
    const obs: ProviderObservationRow[] = [];
    for (let i = 0; i < hashes.length; i += SQL_IN_CHUNK) {
      const chunk = hashes.slice(i, i + SQL_IN_CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = await all<ProviderObservationRow>(
        env.DB,
        `SELECT provider, chamber, provider_key, trade_hash, first_observed_at, last_observed_at,
                provider_published_at, source_url, filed_date, filer_name, payload, prev_probe_at
           FROM trade_provider_observations
          WHERE provider = ? AND trade_hash IN (${placeholders})`,
        [provider.id, ...chunk],
      ).catch((err) => {
        if (storageMissing(err)) return [] as ProviderObservationRow[];
        throw err;
      });
      obs.push(...rows);
    }
    if (!obs.length) continue;

    const candidates = await all<CandidateRow>(
      env.DB,
      `SELECT trade_hash, doc_id, provider, chamber, source_url, filed_date, filer_name, ticker, tx_date, tx_type,
              congress_first_seen_at, attempts
         FROM trade_latency_candidates
        WHERE provider = ? AND status = 'pending'
          AND trade_hash IN (${hashes.map(() => '?').join(', ')})`,
      [provider.id, ...hashes],
    ).catch((err) => {
      if (storageMissing(err)) return [] as CandidateRow[];
      throw err;
    });
    if (!candidates.length) continue;

    const errors: string[] = [];
    await matchAndUpdateCandidates(env, provider, candidates, obs, nowIso, errors);
  }
}

/** Instrument flags the snapshot gate needs. Scan/seed used to drop these. */
function instrumentFieldsFromPersistedTx(row: {
  is_option?: number | boolean | null;
  asset_type?: string | null;
  asset_type_name?: string | null;
  asset_name?: string | null;
}): Pick<Transaction, 'isOption' | 'assetType' | 'assetTypeName' | 'assetName'> {
  return {
    isOption: row.is_option === 1 || row.is_option === true,
    assetType: row.asset_type ?? null,
    assetTypeName: row.asset_type_name ?? null,
    assetName: (row.asset_name || '').trim(),
  };
}

/** Backfill trade-latency candidates from recent persisted transactions. */
export async function backfillTradeLatencyCandidates(
  env: Env,
  opts: { limit?: number; days?: number } = {},
): Promise<{ scanned: number; recorded: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 2000, 1), 10000);
  const days = Math.min(Math.max(opts.days ?? 30, 1), 365);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = await all<{
    id: string;
    doc_id: string;
    ticker: string | null;
    tx_date: string | null;
    tx_type: string | null;
    filed_date: string | null;
    first_seen_at: string | null;
    created_at: string | null;
    full_name: string | null;
    source_url: string | null;
    chamber: string | null;
    source: string | null;
    is_option: number | boolean | null;
    asset_type: string | null;
    asset_type_name: string | null;
    asset_name: string | null;
  }>(
    env.DB,
    `SELECT t.id, t.doc_id, t.ticker, t.tx_date, t.tx_type, t.source AS source,
            COALESCE(t.filed_date, f.filed_date) AS filed_date,
            COALESCE(t.first_seen_at, f.first_seen_at, t.created_at) AS first_seen_at,
            t.created_at AS created_at,
            fil.full_name AS full_name,
            f.source_url AS source_url,
            f.chamber AS chamber,
            t.is_option, t.asset_type, t.asset_type_name, t.asset_name
       FROM transactions t
       LEFT JOIN filings f ON f.doc_id = t.doc_id
       LEFT JOIN filers fil ON fil.bioguide_id = COALESCE(t.filer_id, f.filer_id)
      WHERE t.ticker IS NOT NULL
        AND t.tx_date IS NOT NULL
        AND fil.full_name IS NOT NULL
        AND t.source NOT IN ('seed_dataset', 'competitor_backfill')
        AND t.deprecated_at IS NULL
        AND COALESCE(t.created_at, f.first_seen_at) >= ?
      ORDER BY COALESCE(t.created_at, f.first_seen_at) DESC
      LIMIT ?`,
    [cutoff, limit],
  );
  const nowIso = new Date().toISOString();
  const asTx: Transaction[] = [];
  for (const row of rows) {
    const seen = row.first_seen_at || row.created_at || nowIso;
    const created = row.created_at || nowIso;
    const firstSeenAt = seen > created ? seen : created;
    if (
      !isLiveRaceImport({
        source: row.source,
        filedDate: row.filed_date,
        firstSeenAt,
      })
    ) {
      continue;
    }
    asTx.push({
      id: row.id,
      docId: row.doc_id,
      filerId: null,
      txDate: row.tx_date,
      owner: null,
      ticker: row.ticker,
      txType: (row.tx_type as Transaction['txType']) || 'E',
      amountMin: null,
      amountMax: null,
      capGainsOver200: false,
      rawText: '',
      confidence: 1,
      source: (row.source as Transaction['source']) || 'primary',
      createdAt: nowIso,
      cursorSeq: 0,
      fullName: row.full_name,
      filedDate: row.filed_date,
      firstSeenAt,
      sourceUrl: row.source_url,
      ...instrumentFieldsFromPersistedTx(row),
    });
  }
  await recordTradeLatencyCandidates(env, asTx, nowIso);
  return { scanned: rows.length, recorded: asTx.length };
}


async function upsertProviderRows(env: Env, provider: ProviderId, rows: DisclosureProviderRow[], nowIso: string): Promise<void> {
  // A trade hash with no filer segment can never match anything (see
  // tradeHashHasFiler). We still store the row — losing the observation would
  // also lose the provider's timestamp — but the condition is a PARSER fault
  // and has to be loud. FMP shipped 309 consecutive such rows while reporting
  // operationalStatus 'running' and matched 0, and nothing said a word.
  const missingFiler = rows.filter((row) => !tradeHashHasFiler(row.tradeHash)).length;
  if (missingFiler > 0) {
    console.warn(
      `trade latency: ${provider} produced ${missingFiler}/${rows.length} observations with no filer in the trade hash — these can never match; check the provider's payload field names`,
    );
  }
  // Publication-window lower bound. Read BEFORE this run is recorded, otherwise
  // the current probe becomes its own predecessor and every bracket collapses to
  // zero width — a fictional perfect measurement. See probeRunLog.ts.
  const prevByChamber = new Map<string, string | null>();
  for (const chamber of new Set(rows.map((r) => r.chamber))) {
    prevByChamber.set(chamber, await previousSuccessfulProbeAt(env, provider, chamber, nowIso));
  }

  for (const row of rows) {
    await run(
      env.DB,
      `INSERT INTO trade_provider_observations
         (provider, chamber, provider_key, trade_hash, first_observed_at, last_observed_at,
          prev_probe_at, provider_published_at, source_url, filed_date, filer_name, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, chamber, provider_key, trade_hash) DO UPDATE SET
         last_observed_at=excluded.last_observed_at,
         provider_published_at=COALESCE(trade_provider_observations.provider_published_at, excluded.provider_published_at),
         source_url=COALESCE(trade_provider_observations.source_url, excluded.source_url),
         filed_date=COALESCE(trade_provider_observations.filed_date, excluded.filed_date),
         filer_name=COALESCE(trade_provider_observations.filer_name, excluded.filer_name),
         payload=COALESCE(trade_provider_observations.payload, excluded.payload)`,
      [
        provider,
        row.chamber,
        row.providerKey,
        row.tradeHash,
        nowIso,
        nowIso,
        prevByChamber.get(row.chamber) ?? null,
        row.providerPublishedAt,
        row.sourceUrl,
        row.filedDate,
        row.filerName,
        JSON.stringify(row.payload).slice(0, PAYLOAD_LIMIT),
      ],
    );
  }
}

function deltaSeconds(later: string | null, earlier: string | null): number | null {
  if (!later || !earlier) return null;
  const a = Date.parse(later);
  const b = Date.parse(earlier);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((a - b) / 1000) : null;
}

async function alertMatch(env: Env, provider: ProviderDefinition, candidate: CandidateRow, match: ProviderObservationRow): Promise<void> {
  const deltaSec = deltaSeconds(match.first_observed_at, candidate.congress_first_seen_at);
  const direction =
    deltaSec == null
      ? 'Delta unavailable'
      : deltaSec > 0
        ? `congress.trade observed it ${deltaSec}s before ${provider.label} was first observed by this monitor.`
        : deltaSec < 0
          ? `${provider.label} was already observed ${Math.abs(deltaSec)}s before congress.trade first saw it.`
          : `congress.trade and ${provider.label} were observed in the same second.`;
  const published =
    match.provider_published_at && deltaSeconds(match.provider_published_at, candidate.congress_first_seen_at) != null
      ? `\n${provider.label} provider timestamp: ${match.provider_published_at}`
      : '';
  await notifyAdmin(env, {
    dedupeKey: `disclosure-latency:${provider.id}:${candidate.trade_hash}`,
    throttleSec: 30 * 24 * 60 * 60,
    subject: `Congress.Trade vs ${provider.label} disclosure latency`,
    text:
      `${direction}\n\n` +
      `Doc: ${candidate.trade_hash}\n` +
      `Chamber: ${candidate.chamber}\n` +
      `congress.trade first_seen_at: ${candidate.congress_first_seen_at}\n` +
      `${provider.label} monitor first_observed_at: ${match.first_observed_at}${published}\n` +
      `${provider.label} key: ${match.provider_key}\n` +
      `Source URL: ${candidate.source_url ?? 'n/a'}\n`,
  });
}

async function loadProviderRows(env: Env, provider: ProviderId, now: Date): Promise<ProviderObservationRow[]> {
  const cutoff = new Date(now.getTime() - RECENT_PROVIDER_HOURS * 60 * 60 * 1000).toISOString();
  return all<ProviderObservationRow>(
    env.DB,
    `SELECT provider, chamber, provider_key, first_observed_at, last_observed_at, provider_published_at,
            trade_hash, source_url, filed_date, filer_name, payload, prev_probe_at
       FROM trade_provider_observations
      WHERE provider = ? AND first_observed_at >= ?
      ORDER BY first_observed_at DESC
      LIMIT 1000`,
    [provider, cutoff],
  );
}

/**
 * For recent provider observations that have no race candidate yet, find
 * matching **live** CT transactions and seed candidates. Caps work per probe.
 * Never seeds seed_dataset / competitor_backfill / historical crawls.
 */
async function seedCandidatesFromRecentObservations(
  env: Env,
  provider: ProviderId,
  now: Date,
  nowIso: string,
): Promise<{ seeded: number }> {
  const obs = await loadProviderRows(env, provider, now);
  if (!obs.length) return { seeded: 0 };
  // CT live imports from the scoreboard window (7d of new live first_seen).
  const scoreCutoffMs = now.getTime() - LATENCY_SCORE_WINDOW_HOURS * 3600_000;

  const txs: Transaction[] = [];
  const seen = new Set<string>();
  let examined = 0;
  for (const row of obs) {
    if (examined >= 250) break;
    const parts = parseTradeHash(row.trade_hash);
    if (!parts.lastName || !parts.date) continue;
    examined++;

    // Skip when a candidate already exists for this hash+provider.
    const existing = await get<{ trade_hash: string }>(
      env.DB,
      `SELECT trade_hash FROM trade_latency_candidates
        WHERE provider = ? AND trade_hash = ? LIMIT 1`,
      [provider, row.trade_hash],
    ).catch(() => null);
    if (existing) continue;

    const like = `%${parts.lastName}%`;
    const ticker = parts.ticker || null;
    const rows = await all<{
      id: string;
      doc_id: string;
      ticker: string | null;
      tx_date: string | null;
      tx_type: string | null;
      created_at: string | null;
      first_seen_at: string | null;
      full_name: string | null;
      source_url: string | null;
      chamber: string | null;
      filed_date: string | null;
      source: string | null;
      is_option: number | boolean | null;
      asset_type: string | null;
      asset_type_name: string | null;
      asset_name: string | null;
    }>(
      env.DB,
      `SELECT t.id, t.doc_id, t.ticker, t.tx_date, t.tx_type, t.created_at, t.source AS source,
              COALESCE(t.first_seen_at, f.first_seen_at, t.created_at) AS first_seen_at,
              fil.full_name AS full_name, f.source_url AS source_url,
              f.chamber AS chamber, COALESCE(t.filed_date, f.filed_date) AS filed_date,
              t.is_option, t.asset_type, t.asset_type_name, t.asset_name
         FROM transactions t
         LEFT JOIN filings f ON f.doc_id = t.doc_id
         LEFT JOIN filers fil ON fil.bioguide_id = COALESCE(t.filer_id, f.filer_id)
        WHERE t.deprecated_at IS NULL
          AND t.source NOT IN ('seed_dataset', 'competitor_backfill')
          AND t.tx_date = ?
          AND fil.full_name IS NOT NULL
          AND lower(fil.full_name) LIKE ?
          AND (? IS NULL OR upper(replace(COALESCE(t.ticker,''), '.', '-')) = ?)
        ORDER BY t.created_at DESC
        LIMIT 5`,
      [parts.date, like, ticker, ticker],
    ).catch(() => [] as Array<{
      id: string;
      doc_id: string;
      ticker: string | null;
      tx_date: string | null;
      tx_type: string | null;
      created_at: string | null;
      first_seen_at: string | null;
      full_name: string | null;
      source_url: string | null;
      chamber: string | null;
      filed_date: string | null;
      source: string | null;
      is_option: number | boolean | null;
      asset_type: string | null;
      asset_type_name: string | null;
      asset_name: string | null;
    }>);

    for (const r of rows) {
      if (seen.has(r.id)) continue;
      // Confirm last-name extract matches (LIKE can over-match "Scott").
      if (extractLastName(r.full_name) !== parts.lastName) continue;
      if (parts.side) {
        const side = normalizeTradeSide(r.tx_type);
        if (side !== parts.side) continue;
      }
      const rawSeen = r.first_seen_at || r.created_at;
      const rawMs = rawSeen ? Date.parse(rawSeen) : NaN;
      if (!Number.isFinite(rawMs) || rawMs < scoreCutoffMs) continue;
      if (
        !isLiveRaceImport({
          source: r.source,
          filedDate: r.filed_date,
          firstSeenAt: rawSeen,
        })
      ) {
        continue;
      }
      seen.add(r.id);
      const firstSeen = raceFirstSeenAt(rawSeen, nowIso, LATENCY_PROVIDER_MATCH_LOOKBACK_HOURS);
      txs.push({
        id: r.id,
        docId: r.doc_id,
        filerId: null,
        txDate: r.tx_date,
        owner: null,
        ticker: r.ticker,
        txType: (r.tx_type as Transaction['txType']) || 'E',
        amountMin: null,
        amountMax: null,
        capGainsOver200: false,
        rawText: '',
        confidence: 1,
        source: (r.source as Transaction['source']) || 'primary',
        createdAt: nowIso,
        cursorSeq: 0,
        fullName: r.full_name,
        filedDate: r.filed_date,
        firstSeenAt: firstSeen,
        sourceUrl: r.source_url,
        ...instrumentFieldsFromPersistedTx(r),
      });
    }
  }

  if (txs.length) await recordTradeLatencyCandidates(env, txs, nowIso);
  return { seeded: txs.length };
}

/**
 * Matches a given set of candidates against a given set of already-loaded
 * provider observation rows, applying the same status/attempts/backoff
 * bookkeeping and match alert regardless of which pass (normal window or
 * deep-match) produced the candidate/row sets. This is the single place
 * that owns the match-loop + DB-update shape so the deep-match pass never
 * forks the matching algorithm - it just supplies a different candidate
 * list and provider-row set.
 */
async function matchAndUpdateCandidates(
  env: Env,
  provider: ProviderDefinition,
  candidates: CandidateRow[],
  providerRows: ProviderObservationRow[],
  nowIso: string,
  errors: string[],
): Promise<{ pending: number; matched: number; matchedTradeHashes: string[] }> {
  let matched = 0;
  const matchedTradeHashes: string[] = [];
  const updates: Array<[string, SqlParam[]]> = [];
  const alerts: Array<() => Promise<void>> = [];

  // Index observations by trade_hash for O(1) exact hits. Historical bulk
  // candidate backfills used to starve exact matches when we only scanned the
  // newest 100 pending rows against a linear observation list.
  const byHash = new Map<string, ProviderObservationRow[]>();
  for (const row of providerRows) {
    if (!row.trade_hash) continue;
    const list = byHash.get(row.trade_hash) ?? [];
    list.push(row);
    byHash.set(row.trade_hash, list);
  }

  for (const candidate of candidates) {
    let match: ProviderObservationRow | null = null;
    let method: string | null = null;

    // 1) Exact trade-hash hit — no payload required. Chamber is NOT required:
    // providers often mis-tag house/senate while the trade identity is the same.
    const exactList = byHash.get(candidate.trade_hash) ?? [];
    const exact =
      exactList.find((row) => row.chamber === candidate.chamber) ?? exactList[0] ?? null;
    if (exact) {
      match = exact;
      method = 'trade-hash';
    }

    // 2) Fuzzy fallbacks still need a payload to re-parse the provider row.
    // Prefer same-chamber rows, then any chamber (same trade-hash family).
    if (!match) {
      const ordered = [
        ...providerRows.filter((r) => r.chamber === candidate.chamber),
        ...providerRows.filter((r) => r.chamber !== candidate.chamber),
      ];
      for (const providerRow of ordered) {
        if (!providerRow.payload) continue;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(providerRow.payload) as Record<string, unknown>;
        } catch {
          continue;
        }
        const parsed: DisclosureProviderRow = {
          provider: providerRow.provider,
          chamber: providerRow.chamber,
          providerKey: providerRow.provider_key,
          tradeHash: providerRow.trade_hash,
          payload,
          sourceUrl: providerRow.source_url,
          filedDate: providerRow.filed_date,
          filerName: providerRow.filer_name,
          providerPublishedAt: providerRow.provider_published_at,
        };
        const m = matchDisclosureCandidate(candidate, parsed);
        if (m) {
          match = providerRow;
          method = m.matchMethod;
          break;
        }
      }
    }

    if (match) {
      updates.push([
        `UPDATE trade_latency_candidates
            SET status = 'matched',
                provider_key = ?,
                provider_first_seen_at = ?,
                provider_published_at = ?,
                match_method = ?,
                payload = ?,
                provider_window_start = ?,
                provider_window_end = ?,
                attempts = attempts + 1,
                last_checked_at = ?,
                error = NULL,
                updated_at = ?
          WHERE trade_hash = ? AND provider = ? AND status = 'pending'`,
        [
          match.provider_key,
          match.first_observed_at,
          match.provider_published_at,
          method,
          match.payload,
          match.prev_probe_at ?? null,
          match.first_observed_at,
          nowIso,
          nowIso,
          candidate.trade_hash,
          provider.id,
        ],
      ]);
      matched++;
      matchedTradeHashes.push(candidate.trade_hash);
      const m = match;
      alerts.push(() => alertMatch(env, provider, candidate, m));
    } else {
      updates.push([
        `UPDATE trade_latency_candidates
            SET attempts = attempts + 1, last_checked_at = ?, updated_at = ?, error = ?
          WHERE trade_hash = ? AND provider = ?`,
        [nowIso, nowIso, errors[0] ?? null, candidate.trade_hash, provider.id],
      ]);
    }
  }

  if (updates.length > 0) {
    await batch(env.DB, updates);
  }
  for (const alertFn of alerts) {
    await alertFn();
  }

  return { pending: candidates.length, matched, matchedTradeHashes };
}

/**
 * SQL join: every pending candidate that already has an exact trade_hash
 * observation for the same provider. Chamber is intentionally not required —
 * UW/QQ often mislabel chamber while the hash identity is correct. Prefer
 * same-chamber rows via ORDER BY, then fall back to any chamber.
 * Dedupes to one observation per trade_hash (earliest first_observed_at).
 */
async function loadExactPendingHashMatches(
  env: Env,
  provider: ProviderId,
  limit = 800,
): Promise<Array<CandidateRow & {
  obs_provider_key: string;
  obs_first_observed_at: string;
  obs_provider_published_at: string | null;
  obs_payload: string | null;
  /** Publication-window lower bound for the matched observation — see
   *  probeRunLog.ts. Null for observations recorded before PR #2080 (0089). */
  obs_prev_probe_at: string | null;
}>> {
  return all(
    env.DB,
    `SELECT c.trade_hash, c.doc_id, c.provider, c.chamber, c.source_url, c.filed_date,
            c.filer_name, c.ticker, c.tx_date, c.tx_type, c.congress_first_seen_at, c.attempts,
            o.provider_key AS obs_provider_key,
            o.first_observed_at AS obs_first_observed_at,
            o.provider_published_at AS obs_provider_published_at,
            o.payload AS obs_payload,
            o.prev_probe_at AS obs_prev_probe_at
       FROM trade_latency_candidates c
       JOIN trade_provider_observations o
         ON o.provider = c.provider
        AND o.trade_hash = c.trade_hash
      WHERE c.provider = ?
        AND c.status = 'pending'
        AND c.trade_hash IS NOT NULL
        AND c.trade_hash != ''
      ORDER BY CASE WHEN o.chamber = c.chamber THEN 0 ELSE 1 END,
               o.first_observed_at ASC
      LIMIT ?`,
    [provider, limit],
  );
}

async function applyExactHashMatches(
  env: Env,
  provider: ProviderDefinition,
  nowIso: string,
): Promise<{ matched: number; matchedTradeHashes: string[] }> {
  const rows = await loadExactPendingHashMatches(env, provider.id);
  if (!rows.length) return { matched: 0, matchedTradeHashes: [] };

  const updates: Array<[string, SqlParam[]]> = [];
  const matchedTradeHashes: string[] = [];
  const alerts: Array<() => Promise<void>> = [];
  const seenHash = new Set<string>();

  for (const row of rows) {
    // JOIN can return multiple obs per hash (chamber variants); take first
    // after ORDER BY (same-chamber preferred, earliest obs).
    if (seenHash.has(row.trade_hash)) continue;
    seenHash.add(row.trade_hash);
    updates.push([
      `UPDATE trade_latency_candidates
          SET status = 'matched',
              provider_key = ?,
              provider_first_seen_at = ?,
              provider_published_at = ?,
              match_method = 'trade-hash',
              payload = ?,
              provider_window_start = ?,
              provider_window_end = ?,
              attempts = attempts + 1,
              last_checked_at = ?,
              error = NULL,
              updated_at = ?
        WHERE trade_hash = ? AND provider = ? AND status = 'pending'`,
      [
        row.obs_provider_key,
        row.obs_first_observed_at,
        row.obs_provider_published_at,
        row.obs_payload,
        row.obs_prev_probe_at,
        row.obs_first_observed_at,
        nowIso,
        nowIso,
        row.trade_hash,
        provider.id,
      ],
    ]);
    matchedTradeHashes.push(row.trade_hash);
    const candidate: CandidateRow = {
      trade_hash: row.trade_hash,
      doc_id: row.doc_id,
      provider: row.provider,
      chamber: row.chamber,
      source_url: row.source_url,
      filed_date: row.filed_date,
      filer_name: row.filer_name,
      ticker: row.ticker,
      tx_date: row.tx_date,
      tx_type: row.tx_type,
      congress_first_seen_at: row.congress_first_seen_at,
      attempts: row.attempts,
    };
    const obs: ProviderObservationRow = {
      provider: provider.id,
      chamber: row.chamber,
      provider_key: row.obs_provider_key,
      trade_hash: row.trade_hash,
      first_observed_at: row.obs_first_observed_at,
      last_observed_at: row.obs_first_observed_at,
      provider_published_at: row.obs_provider_published_at,
      source_url: row.source_url,
      filed_date: row.filed_date,
      filer_name: row.filer_name,
      payload: row.obs_payload,
      prev_probe_at: row.obs_prev_probe_at,
    };
    alerts.push(() => alertMatch(env, provider, candidate, obs));
  }

  if (updates.length) await batch(env.DB, updates);
  for (const fn of alerts) await fn();
  return { matched: matchedTradeHashes.length, matchedTradeHashes };
}

async function matchPendingCandidates(
  env: Env,
  provider: ProviderDefinition,
  now: Date,
  nowIso: string,
  errors: string[],
): Promise<{ pending: number; matched: number; examinedTradeHashes: string[]; matchedTradeHashes: string[] }> {
  // Pass A: exact trade-hash SQL join across all pending (live mints only exist
  // for non-backfill imports). No chamber lock — max join density.
  const exact = await applyExactHashMatches(env, provider, nowIso);

  // Pass B: fuzzy match for recent live CT first_seen. Provider obs lookback is
  // longer (14d) so "they listed it a week before us" still matches.
  const scoreCutoff = new Date(now.getTime() - LATENCY_SCORE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const candidates = await all<CandidateRow>(
    env.DB,
    `SELECT trade_hash, doc_id, provider, chamber, source_url, filed_date, filer_name, ticker, tx_date, tx_type,
            congress_first_seen_at, attempts
       FROM trade_latency_candidates
      WHERE provider = ?
        AND status = 'pending'
        AND congress_first_seen_at >= ?
      ORDER BY congress_first_seen_at DESC
      LIMIT 800`,
    [provider.id, scoreCutoff],
  );
  // Drop any residual backfill-shaped candidates (historical crawl lag).
  const liveCandidates = candidates.filter((c) =>
    isLiveRaceImport({
      source: 'primary',
      filedDate: c.filed_date,
      firstSeenAt: c.congress_first_seen_at,
    }),
  );
  const providerRows = await loadProviderRows(env, provider.id, now);
  const fuzzy = await matchAndUpdateCandidates(env, provider, liveCandidates, providerRows, nowIso, errors);

  const matchedTradeHashes = Array.from(new Set([...exact.matchedTradeHashes, ...fuzzy.matchedTradeHashes]));
  const examined = Array.from(new Set([
    ...exact.matchedTradeHashes,
    ...liveCandidates.map((c) => c.trade_hash),
  ]));
  return {
    pending: examined.length,
    matched: matchedTradeHashes.length,
    examinedTradeHashes: examined,
    matchedTradeHashes,
  };
}

/**
 * Multi-pass historical reconciliation across ALL pending candidates in D1.
 * Ensures 100% candidate matching when a competitor observation exists.
 * Passes:
 *   1. Exact SQL JOIN on trade_hash (cross-chamber allowed).
 *   2. Trade hash regeneration (re-applies normalized last name + trade side + ticker).
 *   3. Fuzzy last name + ticker + date-slack match (up to 5 days).
 */
export async function reconcileAllPendingLatencyCandidates(
  env: Env,
  opts: { limitPerProvider?: number } = {},
): Promise<{ examined: number; matched: number; matchedTradeHashes: string[] }> {
  const now = new Date();
  const nowIso = now.toISOString();
  const errors: string[] = [];
  const limit = opts.limitPerProvider ?? 2000;

  let totalExamined = 0;
  let totalMatched = 0;
  const allMatchedHashes: string[] = [];

  for (const provider of PROVIDERS) {
    // 1. Exact SQL join pass across ALL pending rows for this provider
    const exact = await applyExactHashMatches(env, provider, nowIso);

    // 2. Fuzzy pass across all remaining pending rows
    const pendingCandidates = await all<CandidateRow>(
      env.DB,
      `SELECT trade_hash, doc_id, provider, chamber, source_url, filed_date, filer_name, ticker, tx_date, tx_type,
              congress_first_seen_at, attempts
         FROM trade_latency_candidates
        WHERE provider = ?
          AND status = 'pending'
        ORDER BY congress_first_seen_at DESC
        LIMIT ?`,
      [provider.id, limit],
    );

    let fuzzyMatched = 0;
    const fuzzyMatchedHashes: string[] = [];
    if (pendingCandidates.length > 0) {
      const providerRows = await loadProviderRows(env, provider.id, now);
      const fuzzyRes = await matchAndUpdateCandidates(
        env,
        provider,
        pendingCandidates,
        providerRows,
        nowIso,
        errors,
      );
      fuzzyMatched = fuzzyRes.matched;
      fuzzyMatchedHashes.push(...fuzzyRes.matchedTradeHashes);
    }

    const matchedHashes = Array.from(new Set([...exact.matchedTradeHashes, ...fuzzyMatchedHashes]));
    totalExamined += exact.matchedTradeHashes.length + pendingCandidates.length;
    totalMatched += matchedHashes.length;
    allMatchedHashes.push(...matchedHashes);
  }

  return {
    examined: totalExamined,
    matched: totalMatched,
    matchedTradeHashes: Array.from(new Set(allMatchedHashes)),
  };
}

/**
 * Pull the earliest trustworthy CT first-seen for a doc from filings +
 * transactions, then write it onto matched/pending candidates when it is
 * earlier than the stored stamp. Bulk reverse-seed / backfill often stamps
 * congress_first_seen_at = now, which invents multi-day "provider ahead"
 * deltas even when CT actually ingested the filing days earlier.
 *
 * Never rewrites a stamp forward; never writes a stamp older than the score
 * window floor (keeps bulk historical re-imports out of the live race).
 */
export async function healLatencyCandidateFirstSeen(
  env: Env,
  opts: { limit?: number } = {},
): Promise<{ examined: number; healed: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 2000, 1), 10_000);
  const nowIso = new Date().toISOString();
  const scoreCutoff = new Date(Date.now() - LATENCY_SCORE_WINDOW_HOURS * 3600_000).toISOString();

  const rows = await all<{
    trade_hash: string;
    provider: string;
    doc_id: string;
    congress_first_seen_at: string;
    provider_first_seen_at: string | null;
    created_at: string | null;
  }>(
    env.DB,
    `SELECT trade_hash, provider, doc_id, congress_first_seen_at, provider_first_seen_at, created_at
       FROM trade_latency_candidates
      WHERE doc_id IS NOT NULL AND doc_id != ''
      ORDER BY updated_at DESC
      LIMIT ?`,
    [limit],
  ).catch((err) => {
    if (storageMissing(err)) return [];
    throw err;
  });
  if (!rows.length) return { examined: 0, healed: 0 };

  const docIds = Array.from(new Set(rows.map((r) => r.doc_id)));
  const earliestByDoc = new Map<string, string>();
  for (let i = 0; i < docIds.length; i += SQL_IN_CHUNK) {
    const chunk = docIds.slice(i, i + SQL_IN_CHUNK);
    const ph = chunk.map(() => '?').join(', ');
    const filingRows = await all<{ doc_id: string; seen: string | null }>(
      env.DB,
      `SELECT doc_id, first_seen_at AS seen FROM filings WHERE doc_id IN (${ph})`,
      chunk,
    ).catch(() => [] as Array<{ doc_id: string; seen: string | null }>);
    for (const f of filingRows) {
      if (f.seen) {
        const prev = earliestByDoc.get(f.doc_id);
        if (!prev || f.seen < prev) earliestByDoc.set(f.doc_id, f.seen);
      }
    }
    const txRows = await all<{ doc_id: string; seen: string | null }>(
      env.DB,
      `SELECT doc_id, MIN(COALESCE(first_seen_at, created_at)) AS seen
         FROM transactions
        WHERE doc_id IN (${ph}) AND deprecated_at IS NULL
        GROUP BY doc_id`,
      chunk,
    ).catch(() => [] as Array<{ doc_id: string; seen: string | null }>);
    for (const t of txRows) {
      if (t.seen) {
        const prev = earliestByDoc.get(t.doc_id);
        if (!prev || t.seen < prev) earliestByDoc.set(t.doc_id, t.seen);
      }
    }
  }

  const updates: Array<[string, SqlParam[]]> = [];
  let healed = 0;
  for (const row of rows) {
    const raw = earliestByDoc.get(row.doc_id);
    let next: string | null = null;
    if (raw && raw >= scoreCutoff && raw < row.congress_first_seen_at) {
      // Real in-window stamp earlier than bulk reverse-seed "now".
      next = raw;
    } else if (row.provider_first_seen_at && row.congress_first_seen_at) {
      // Prior bug clamped pre-window stamps to the window floor, inventing
      // multi-day CT-ahead leads (provider mid-window, CT at floor). Detect any
      // matched row where CT is "ahead" by >24h but the real filing/tx stamp is
      // pre-window (or missing) and snap CT forward to candidate created_at /
      // now so concurrent timing is not dominated by floor artifacts.
      const ctMs = Date.parse(row.congress_first_seen_at);
      const pMs = Date.parse(row.provider_first_seen_at);
      const ctAheadSec = Number.isFinite(pMs) && Number.isFinite(ctMs) ? (pMs - ctMs) / 1000 : 0;
      const realIsPreWindow = !raw || raw < scoreCutoff;
      if (ctAheadSec > 24 * 3600 && realIsPreWindow) {
        const created =
          row.created_at && Date.parse(row.created_at) >= Date.parse(scoreCutoff)
            ? row.created_at
            : nowIso;
        if (Date.parse(created) > ctMs) next = created;
      }
    }
    if (!next || next === row.congress_first_seen_at) continue;
    updates.push([
      `UPDATE trade_latency_candidates
          SET congress_first_seen_at = ?, updated_at = ?
        WHERE trade_hash = ? AND provider = ?`,
      [next, nowIso, row.trade_hash, row.provider],
    ]);
    healed++;
  }
  if (updates.length) {
    try {
      await batch(env.DB, updates);
    } catch (err) {
      if (!storageMissing(err)) throw err;
      return { examined: rows.length, healed: 0 };
    }
  }
  return { examined: rows.length, healed };
}

/**
 * One-shot density pass: heal first-seen stamps, rematch every provider's
 * pending backlog (exact + fuzzy), and reverse-seed from recent observations.
 * Safe to call from admin after matching repairs land.
 */
export async function rematchAndHealLatencyRaces(
  env: Env,
  now: Date = new Date(),
): Promise<{
  healed: number;
  matched: number;
  seeded: number;
  providers: Array<{ provider: ProviderId; matched: number; seeded: number }>;
}> {
  const nowIso = now.toISOString();
  const heal = await healLatencyCandidateFirstSeen(env, { limit: 5000 });
  let matched = 0;
  let seeded = 0;
  const providers: Array<{ provider: ProviderId; matched: number; seeded: number }> = [];
  for (const provider of PROVIDERS.filter((p) => p.supportsDirectLatest)) {
    const errors: string[] = [];
    const m = await matchPendingCandidates(env, provider, now, nowIso, errors);
    const s = await seedCandidatesFromRecentObservations(env, provider.id, now, nowIso).catch(() => ({
      seeded: 0,
    }));
    // Second match pass after seed.
    const m2 = await matchPendingCandidates(env, provider, now, nowIso, errors);
    const pMatched = m.matched + m2.matched;
    matched += pMatched;
    seeded += s.seeded;
    providers.push({ provider: provider.id, matched: pMatched, seeded: s.seeded });
  }
  // Final heal so newly matched reverse-seeds pick up real filing stamps.
  const heal2 = await healLatencyCandidateFirstSeen(env, { limit: 5000 });
  return {
    healed: heal.healed + heal2.healed,
    matched,
    seeded,
    providers,
  };
}

/**
 * Live (non-deprecated) parsed transaction dates for a set of filings, as a
 * doc_id -> sorted distinct YYYY-MM-DD list. Chunked `IN` lookups keep each
 * statement under D1's bound-parameter cap.
 */
async function loadTransactionDates(env: Env, docIds: string[]): Promise<Map<string, string[]>> {
  const byDoc = new Map<string, string[]>();
  const distinct = Array.from(new Set(docIds));
  for (let i = 0; i < distinct.length; i += SQL_IN_CHUNK) {
    const chunk = distinct.slice(i, i + SQL_IN_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await all<{ doc_id: string; tx_date: string }>(
      env.DB,
      `SELECT DISTINCT doc_id, tx_date
         FROM transactions
        WHERE doc_id IN (${placeholders}) AND tx_date IS NOT NULL AND deprecated_at IS NULL`,
      chunk,
    );
    for (const row of rows) {
      const date = normalizeDate(row.tx_date);
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const list = byDoc.get(row.doc_id) ?? [];
      if (!list.includes(date)) list.push(date);
      byDoc.set(row.doc_id, list);
    }
  }
  for (const list of byDoc.values()) list.sort();
  return byDoc;
}

/**
 * Observation rows for exactly the given provider keys, straight from the DB
 * with NO first_observed_at recency cutoff (unlike loadProviderRows). Used by
 * the deep-match pass so a just-fetched row is always matchable even when its
 * first observation predates the 72h window, and so matching sees the
 * DB-canonical first_observed_at that the upsert preserved for rows this
 * monitor had already observed - provider_first_seen_at must never be
 * inflated to "now" for a row we actually saw earlier.
 */
async function loadObservationRowsByKeys(
  env: Env,
  provider: ProviderId,
  providerKeys: string[],
): Promise<ProviderObservationRow[]> {
  const out: ProviderObservationRow[] = [];
  for (let i = 0; i < providerKeys.length; i += SQL_IN_CHUNK) {
    const chunk = providerKeys.slice(i, i + SQL_IN_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    out.push(
      ...(await all<ProviderObservationRow>(
        env.DB,
        `SELECT provider, chamber, provider_key, trade_hash, first_observed_at, last_observed_at, provider_published_at,
                source_url, filed_date, filer_name, payload, prev_probe_at
           FROM trade_provider_observations
          WHERE provider = ? AND provider_key IN (${placeholders})`,
        [provider, ...chunk],
      )),
    );
  }
  return out;
}

/**
 * Bounded "deep match" pass for Unusual Whales. Its recent-trades feed only
 * exposes the newest ~200 rows, so a pending observation whose filing has
 * already scrolled outside that window can never match on the normal pass -
 * it would sit pending forever even after UW publishes it. This re-queries
 * recent-trades anchored to specific TRANSACTION dates (UW's `date` param
 * filters by transaction date, not filed_at_date) drawn from each stranded
 * filing's live parsed transactions, for up to `UW_DEEP_MATCH_DATES_PER_RUN`
 * distinct dates per run, and reuses matchAndUpdateCandidates for the actual
 * matching - no forked matching logic.
 *
 * Rotation: stranded candidates are visited least-recently-checked first
 * (never-checked NULLs first), so with a backlog larger than the per-run cap
 * successive runs cycle through the whole backlog instead of re-selecting the
 * same dates forever. `attempts` breaks the tie the normal pass leaves when
 * it stamps every pending row with the same last_checked_at in the same run:
 * deep-pass targets accrue an extra attempt, pushing them behind untargeted
 * rows on the next run.
 *
 * Matches found this way still get providerFirstSeenAt from the observation
 * row's DB-canonical first_observed_at (monitor-first-seen), the same honest
 * lower-bound semantics this provider already uses for its normal pass; we
 * never fabricate a provider-published timestamp from a deep-match hit.
 *
 * Only called when the normal pass's fetch already succeeded (freshRows
 * non-empty), so once a trial UW key lapses and the normal fetch starts
 * 401ing, this pass simply never runs - no extra failing calls, no extra
 * noise, silent degradation back to the normal-only behavior.
 */
async function runUnusualWhalesDeepMatch(
  env: Env,
  provider: ProviderDefinition,
  apiKey: string,
  freshRows: DisclosureProviderRow[],
  nowIso: string,
  fetchImpl: typeof fetch,
  opts: { maxDates?: number } = {},
): Promise<{
  pending: number;
  matched: number;
  fetchedRows: number;
  /** Distinct date endpoints actually requested (HTTP count for budget). */
  fetchedDates: number;
  errors: string[];
  examinedTradeHashes: string[];
  matchedTradeHashes: string[];
}> {
  const empty = {
    pending: 0,
    matched: 0,
    fetchedRows: 0,
    fetchedDates: 0,
    errors: [] as string[],
    examinedTradeHashes: [] as string[],
    matchedTradeHashes: [] as string[],
  };
  const envCap = await uwDeepMatchDatesPerRun(env as EnvWithWatch);
  // Also bound by remaining daily HTTP budget (caller passes leftover after base).
  const budgetCap =
    opts.maxDates == null ? envCap : Math.max(0, Math.min(envCap, Math.floor(opts.maxDates)));
  const capPerRun = budgetCap;
  if (capPerRun <= 0) return empty;

  const oldestFreshDate = freshRows
    .map((row) => row.filedDate)
    .filter((d): d is string => !!d)
    .sort()[0];
  if (!oldestFreshDate) return empty;

  // Still-pending UW candidates whose filed_date predates the oldest row on
  // the page we just fetched - provably outside this run's window. Ordered
  // for rotation (see the function doc comment). The EXISTS clause requires
  // at least one live parsed transaction BEFORE the scan cap applies:
  // transactionless candidates (failed/empty extractions) never receive a
  // deep attempt, so without the filter they would keep their rotation rank
  // forever and a least-recently-checked window full of them would
  // permanently starve every eligible candidate ranked behind them.
  const oldPending = await all<CandidateRow>(
    env.DB,
    `SELECT trade_hash, doc_id, provider, chamber, source_url, filed_date, filer_name, ticker, tx_date, tx_type,
            congress_first_seen_at, attempts
       FROM trade_latency_candidates c
      WHERE c.provider = ? AND c.status = 'pending' AND c.filed_date IS NOT NULL AND c.filed_date < ?
        AND EXISTS (SELECT 1 FROM transactions t
                     WHERE t.doc_id = c.doc_id AND t.tx_date IS NOT NULL AND t.deprecated_at IS NULL)
      ORDER BY c.last_checked_at ASC, c.attempts ASC, c.filed_date ASC
      LIMIT ?`,
    [provider.id, oldestFreshDate, UW_DEEP_MATCH_CANDIDATE_LIMIT],
  );
  if (!oldPending.length) return empty;

  // UW's `date` filter selects by transaction date, so the fetch targets are
  // the stranded filings' parsed transaction dates - never their filed_date.
  const txDatesByDoc = await loadTransactionDates(env, oldPending.map((c) => c.doc_id));

  // Walk candidates in rotation order, accumulating distinct transaction
  // dates until the per-run cap is reached. A candidate is targeted when at
  // least one of its transaction dates gets fetched this run (any row from
  // the filing can match it, whichever date page the row appears on).
  const targetDates: string[] = [];
  const targetDateSet = new Set<string>();
  const targetCandidates: CandidateRow[] = [];
  for (const candidate of oldPending) {
    // A filing with no live parsed transactions has no transaction dates to
    // anchor a deep fetch on - and with no rows on any date page it could
    // never row-match - so skip it rather than burn a trial call on a
    // wrong-date page. The candidate query's EXISTS clause already excludes
    // these; this in-loop skip is belt-and-suspenders for transactions
    // deprecated between the two queries.
    const txDates = txDatesByDoc.get(candidate.trade_hash) ?? [];
    if (!txDates.length) continue;
    for (const date of txDates) {
      if (targetDateSet.has(date) || targetDateSet.size >= capPerRun) continue;
      targetDateSet.add(date);
      targetDates.push(date);
    }
    if (txDates.some((date) => targetDateSet.has(date))) targetCandidates.push(candidate);
  }
  if (!targetDates.length) return empty;

  const errors: string[] = [];
  let fetchedRows = 0;
  const fetchedKeys = new Set<string>();
  for (const date of targetDates) {
    try {
      const rows = await fetchUnusualWhalesRowsForDate(apiKey, fetchImpl, date);
      fetchedRows += rows.length;
      await upsertProviderRows(env, provider.id, rows, nowIso);
      for (const row of rows) fetchedKeys.add(row.providerKey);
    } catch (err) {
      // A single date's failure (401/403/429/5xx, e.g. a lapsed trial key)
      // must not abort the rest of the deep-match dates or the outer probe;
      // it flows into the same attempt/error bookkeeping as a normal miss.
      errors.push((err as Error).message);
    }
  }

  // Match against the post-upsert DB rows for exactly the keys the deep
  // fetches returned: no 72h first_observed_at cutoff (a just-fetched row
  // must be matchable even when this monitor first saw it long ago), and the
  // DB-canonical first_observed_at rides along so provider_first_seen_at is
  // never inflated to nowIso for a previously observed row.
  const providerRows = await loadObservationRowsByKeys(env, provider.id, Array.from(fetchedKeys));
  const result = await matchAndUpdateCandidates(env, provider, targetCandidates, providerRows, nowIso, errors);
  await routeProviderOnlyObservationsToReview(
    env,
    provider.id,
    providerRows.map((providerRow) => ({
      provider: providerRow.provider,
      chamber: providerRow.chamber,
      providerKey: providerRow.provider_key,
      tradeHash: providerRow.trade_hash,
      payload: providerRow.payload ? (JSON.parse(providerRow.payload) as Record<string, unknown>) : {},
      sourceUrl: providerRow.source_url,
      filedDate: providerRow.filed_date,
      filerName: providerRow.filer_name,
      providerPublishedAt: providerRow.provider_published_at,
    })),
    nowIso,
  );
  return {
    ...result,
    fetchedRows,
    fetchedDates: targetDates.length,
    errors,
    examinedTradeHashes: targetCandidates.map((c) => c.doc_id),
  };
}

async function runProviderProbe(
  env: Env,
  provider: ProviderDefinition,
  now: Date,
  fetchImpl: typeof fetch,
  max: number,
  opts: {
    force?: boolean;
    /** When set, only this FMP path id may spend HTTP this cycle (rotation). */
    selectedFmpPathId?: FmpLatencyPathId | null;
  } = {},
): Promise<DisclosureLatencyProviderRun> {
  const base = await providerStatus(env, provider);
  const errors: string[] = [];
  if (!provider.supportsDirectLatest || !provider.fetchRows) {
    return { ...base, enabled: false, fetchedRows: 0, pending: 0, matched: 0, errors };
  }
  // Read once per provider run: the schedule is pure, so one config read feeds
  // every cadence question below and an env retune is picked up next tick.
  const schedule = latencyScheduleConfig(env);

  const recordHandoff = async (
    kind: 'success' | 'error' | 'budget_skip' | 'not_configured' | 'disabled',
    detail?: { error?: string | null; fetchedRows?: number },
  ) => {
    // Durable probe-run record for EVERY provider and every terminal outcome —
    // including the ones that found nothing. A probe that looked and saw the
    // filing absent is what establishes the lower bound of the publication
    // window; without it the bracket is unbounded. Only 'success' sets ok=1:
    // a skipped, unconfigured or failed probe never observed the competitor's
    // state, so it cannot bound anything. See probeRunLog.ts.
    await recordProbeRun(env, {
      provider: provider.id,
      chamber: ALL_CHAMBERS,
      ranAt: now.toISOString(),
      ok: kind === 'success',
      rowsSeen: detail?.fetchedRows ?? 0,
      error: detail?.error ?? (kind === 'success' ? null : kind),
    });

    if (!isFmpFamilyProvider(provider.id) && provider.id !== 'unusual_whales' && provider.id !== 'quiver') {
      return;
    }
    try {
      const { recordLatencyProbeOutcome } = await import('./scoutHandoff.ts');
      await recordLatencyProbeOutcome(env, provider.id as 'fmp' | 'fmp_rapidapi' | 'unusual_whales' | 'quiver', {
        source: 'server',
        kind,
        error: detail?.error ?? null,
        fetchedRows: detail?.fetchedRows,
        now,
      });
    } catch {
      /* handoff bookkeeping best-effort */
    }
  };

  const { shouldThrottleAuthRejectedLatencyProbe } = await import('./scoutHandoff.ts');
  const membershipId = provider.id === 'unusual_whales' || provider.id === 'quiver'
    ? provider.id
    : null;
  if (
    membershipId
    && await shouldThrottleAuthRejectedLatencyProbe(env, membershipId, now, { force: opts.force })
  ) {
    return {
      ...base,
      enabled: false,
      operationalStatus: 'stopped',
      reason: `${provider.label} credentials rejected (401/403); next recovery probe after backoff (admin force bypasses)`,
      fetchedRows: 0,
      pending: 0,
      matched: 0,
      errors,
    };
  }

  // FMP family: skip HTTP when explicitly OFF (FMP_LATENCY_PROBE_ENABLED=false)
  // or path filtered out of FMP_LATENCY_PATHS. Default is ON for CT.
  if (isFmpFamilyProvider(provider.id) && base.operationalStatus === 'off') {
    await recordHandoff('disabled');
    return {
      ...base,
      enabled: false,
      fetchedRows: 0,
      pending: 0,
      matched: 0,
      errors,
    };
  }

  // Multi-avenue rotation: only the selected FMP path spends quota this cycle.
  // Other enabled paths stay "running" in status but skip HTTP so dual hosts
  // do not both burn free-tier caps for the same answer minutes apart.
  if (
    isFmpFamilyProvider(provider.id) &&
    provider.fmpPathId &&
    opts.selectedFmpPathId &&
    provider.fmpPathId !== opts.selectedFmpPathId
  ) {
    return {
      ...base,
      enabled: false,
      fetchedRows: 0,
      pending: 0,
      matched: 0,
      errors,
      reason: `rotated: probing FMP path "${opts.selectedFmpPathId}" this cycle (single avenue protects daily quota)`,
    };
  }

  const nowIso = now.toISOString();
  const isFmpFamily = isFmpFamilyProvider(provider.id);
  const isFmpStable = provider.id === 'fmp';
  const isUnusualWhales = provider.id === 'unusual_whales';
  const budgetSourceId: LatencyBudgetSourceId | null =
    provider.id === 'unusual_whales' || provider.id === 'quiver' ? provider.id : null;
  const envx = env as EnvWithWatch;
  let fetchedRows = 0;
  let freshRows: DisclosureProviderRow[] = [];
  let apiKey: string | null = null;
  let fmpSelection: FmpLatencyKeySelection | null = null;
  let sourceBudget: LatencySourceProbeSelection | null = null;
  /** Extra UW deep-match HTTP calls allowed this run after base probe. */
  let uwDeepMatchCallBudget = 0;

  // FMP free-tier keys are latency/scout-only (owner 2026-08): dual keys with
  // independent daily counters + ET-weighted spacing. RapidAPI path uses the
  // marketplace key (FMP_RAPIDAPI_KEY / RAPIDAPI_KEY) with its own budget —
  // never free-tier FMP_LATENCY_* on the RapidAPI host (ST pattern).
  // Never use FMP_API_KEY here and never touch enrichment/prices fmp:calls.
  let capSkipped = false;
  if (isFmpFamily) {
    if (provider.id === 'fmp_rapidapi') {
      apiKey = await resolveFmpRapidApiKey(env);
      if (!apiKey) {
        await recordHandoff('not_configured', {
          error: 'FMP_RAPIDAPI_KEY / RAPIDAPI_KEY missing',
        });
        return {
          ...base,
          configured: false,
          enabled: false,
          operationalStatus: 'stopped',
          fetchedRows: 0,
          pending: 0,
          matched: 0,
          errors,
          reason: 'FMP_RAPIDAPI_KEY / RAPIDAPI_KEY missing (marketplace key required; free-tier FMP_LATENCY_* not valid on RapidAPI)',
        };
      }
      const rapidDecision = await evaluateLatencySourceProbe(env, 'fmp_rapidapi', now, {
        force: opts.force,
        schedule,
      });
      logLatencyLaneCadence('fmp_rapidapi', rapidDecision, now);
      sourceBudget = rapidDecision.selection;
      if (!sourceBudget) {
        capSkipped = true;
        errors.push(
          rapidDecision.skip === 'daily_cap'
            ? 'FMP RapidAPI at daily cap; skipped latest fetch (DB re-match still runs)'
            : `FMP RapidAPI off-cadence (${rapidDecision.band} tier, ${rapidDecision.intervalSec}s interval); skipped latest fetch (DB re-match still runs)`,
        );
        await recordHandoff('budget_skip');
      } else {
        await addLatencySourceUsed(env, 'fmp_rapidapi', sourceBudget.callsPerRun, now);
        await setLastPollAt(env, LATENCY_SOURCE_BUDGETS.fmp_rapidapi.pollSource, now);
      }
    } else {
      fmpSelection = await selectFmpLatencyKey(env, now, { force: opts.force, schedule });
      if (!fmpSelection) {
        const anyKey = await resolveProviderSecret(env, provider);
        if (!anyKey) {
          await recordHandoff('not_configured', {
            error: `${FMP_LATENCY_KEY_PRIMARY} / ${FMP_LATENCY_KEY_SECONDARY} missing`,
          });
          return {
            ...base,
            configured: false,
            enabled: false,
            operationalStatus: 'stopped',
            fetchedRows: 0,
            pending: 0,
            matched: 0,
            errors,
            reason: `${FMP_LATENCY_KEY_PRIMARY} / ${FMP_LATENCY_KEY_SECONDARY} missing`,
          };
        }
        capSkipped = true;
        errors.push(
          'FMP latency keys at daily cap or spacing interval; skipped latest fetch (DB re-match still runs)',
        );
        await recordHandoff('budget_skip');
      } else {
        apiKey = fmpSelection.apiKey;
        // Reserve full house+senate batch on this key's counter before HTTP.
        await addFmpLatencyUsed(env, fmpSelection.slot, FMP_LATENCY_CALLS_PER_RUN, now);
      }
    }
  } else {
    if (isUnusualWhales) {
      const uw = await resolveUnusualWhalesKey(env);
      apiKey = uw?.apiKey ?? null;
    } else {
      apiKey = await resolveProviderSecret(env, provider);
    }
    if (!apiKey) {
      await recordHandoff('not_configured', {
        error: isUnusualWhales
          ? 'UNUSUAL_WHALES_API_KEY / UNUSUALWHALES_API_KEY missing'
          : `${provider.secretNames[0]} missing`,
      });
      return {
        ...base,
        configured: false,
        enabled: false,
        operationalStatus: 'stopped',
        fetchedRows: 0,
        pending: 0,
        matched: 0,
        errors,
        reason: isUnusualWhales
          ? 'UNUSUAL_WHALES_API_KEY / UNUSUALWHALES_API_KEY missing'
          : `${provider.secretNames[0]} missing`,
      };
    }
    // Per-source daily budget + measured-cadence spacing (UW / Quiver).
    if (budgetSourceId) {
      const decision = await evaluateLatencySourceProbe(env, budgetSourceId, now, {
        force: opts.force,
        schedule,
      });
      logLatencyLaneCadence(budgetSourceId, decision, now);
      sourceBudget = decision.selection;
      if (!sourceBudget) {
        capSkipped = true;
        errors.push(
          decision.skip === 'daily_cap'
            ? `${provider.label} at daily cap; skipped latest fetch (DB re-match still runs)`
            : `${provider.label} off-cadence (${decision.band} tier, ${decision.intervalSec}s interval); skipped latest fetch (DB re-match still runs)`,
        );
        await recordHandoff('budget_skip');
      } else {
        await addLatencySourceUsed(env, budgetSourceId, sourceBudget.callsPerRun, now);
        if (isUnusualWhales) {
          uwDeepMatchCallBudget = Math.max(0, sourceBudget.remaining - sourceBudget.callsPerRun);
        }
        await setLastPollAt(env, LATENCY_SOURCE_BUDGETS[budgetSourceId].pollSource, now);
      }
    }
  }

  if (!capSkipped && apiKey) {
    let fmpCallsMade = 0;
    // Dedicated latency pacer — do not share the enrichment getSharedStPeerPacer state
    // with free keys (avoids coupling to enrichment cadence). Simple serial wait.
    let lastFmpCallMs = 0;
    const FMP_LATENCY_MIN_GAP_MS = 350;
    const pace = isFmpFamily
      ? async () => {
          fmpCallsMade++;
          const wait = Math.max(0, lastFmpCallMs + FMP_LATENCY_MIN_GAP_MS - Date.now());
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          lastFmpCallMs = Date.now();
        }
      : undefined;
    try {
      let fetchOpts: FetchFmpRowsOpts | undefined;
      if (isFmpFamily && provider.fmpPathId) {
        const pathDef = FMP_LATENCY_PATHS.find((p) => p.pathId === provider.fmpPathId)!;
        const runtime = await resolveFmpPathRuntime(env, pathDef);
        fetchOpts = {
          baseUrl: runtime.baseUrl,
          auth: pathDef.auth,
          rapidApiHost: runtime.rapidApiHost,
          providerId: provider.id,
        };
      }
      let fetchErr: Error | null = null;
      let currentFetch = fetchImpl;
      let usedResidentialProxy = false;
      // Dual free-tier keys go direct (owner: two keys ≈ 2× daily HTTP).
      // On 429: other key first, then one retry of the current key through
      // the Senate residential proxy (IP diversity). Never wrap every FMP
      // probe in that proxy — that hop is for Clerk/eFD Imperva and silenced
      // observations for ~42h after 2026-09-02.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const rows = await provider.fetchRows(apiKey, max, currentFetch, pace, fetchOpts);
          fetchedRows = rows.length;
          freshRows = rows;
          await upsertProviderRows(env, provider.id, rows, nowIso);
          if (fmpSelection) {
            await setLastPollAt(env, fmpLatencyPollSource(fmpSelection.slot), now);
          }
          await recordHandoff('success', { fetchedRows });
          fetchErr = null;
          break;
        } catch (err) {
          fetchErr = err as Error;
          const msg = fetchErr.message || '';
          // 429 = FMP bandwidth cap. 401/403 = key unauthorized or wrong plan.
          // Either way this key must not silence the other free-tier key.
          const is429 = /FMP_HTTP_429|HTTP_429/.test(msg);
          const isUnauthorized = /FMP_HTTP_(401|403)|HTTP_(401|403)/.test(msg);
          if ((!is429 && !isUnauthorized) || !isFmpStable || !fmpSelection) break;
          await markFmpSlotHttp429(env, fmpSelection.slot, now, is429 ? '429' : 'unauthorized');
          if (attempt === 0) {
            const retry = await selectFmpLatencyKey(env, now, { force: true, schedule });
            if (retry && retry.slot !== fmpSelection.slot) {
              fmpSelection = retry;
              apiKey = retry.apiKey;
              await addFmpLatencyUsed(env, retry.slot, FMP_LATENCY_CALLS_PER_RUN, now);
              continue;
            }
          }
          // A bad key is not an IP block. The residential proxy is only a
          // last try after both free-tier keys are bandwidth-capped (429).
          if (is429 && !usedResidentialProxy) {
            const proxyUrl = resolveResidentialProxyUrl(envx);
            if (proxyUrl) {
              currentFetch = createProxiedFetch(proxyUrl, fetchImpl);
              usedResidentialProxy = true;
              continue;
            }
          }
          break;
        }
      }
      if (fetchErr) {
        errors.push(fetchErr.message);
        await recordHandoff('error', { error: fetchErr.message, fetchedRows: 0 });
      }
    } finally {
      if (fmpSelection) {
        const overReserved = FMP_LATENCY_CALLS_PER_RUN - fmpCallsMade;
        if (overReserved > 0) await addFmpLatencyUsed(env, fmpSelection.slot, -overReserved, now);
      }
    }
  }

  try {
    // Repair bulk-seed first_seen stamps before matching so concurrent races
    // use the real CT ingest time when available.
    await healLatencyCandidateFirstSeen(env, { limit: 1500 }).catch((err) => {
      if (!storageMissing(err)) errors.push(`heal-first-seen: ${(err as Error).message}`);
    });

    // Pull CT rows that overlap recent provider observations into the race
    // table so reverse-direction coverage can grow (provider saw it first).
    await seedCandidatesFromRecentObservations(env, provider.id, now, nowIso).catch((err) => {
      if (!storageMissing(err)) errors.push(`seed-from-obs: ${(err as Error).message}`);
    });

    const matched = await matchPendingCandidates(env, provider, now, nowIso, errors);
    let totalFetchedRows = fetchedRows;
    let totalPending = matched.pending;
    let totalMatched = matched.matched;

    // UW's recent-trades page is capped at ~200 rows, so pending observations
    // older than that window can never match here. Only worth attempting once
    // the normal fetch actually returned rows to anchor a window against -
    // when a lapsed trial key makes that fetch 401 (freshRows stays empty),
    // this is skipped, degrading silently back to the normal-only behavior.
    if (isUnusualWhales && freshRows.length && apiKey && !capSkipped) {
      // Deep-match date queries share the UW daily HTTP budget (remaining after base).
      const deep = await runUnusualWhalesDeepMatch(env, provider, apiKey, freshRows, nowIso, fetchImpl, {
        maxDates: uwDeepMatchCallBudget,
      });
      totalFetchedRows += deep.fetchedRows;
      totalMatched += deep.matched;
      errors.push(...deep.errors);
      if (deep.fetchedDates > 0) {
        await addLatencySourceUsed(env, 'unusual_whales', deep.fetchedDates, now);
      }
      // De-duplicated pending count across both passes: a stranded candidate
      // can appear in the normal pass's newest-100 page AND in the deep
      // pass's target set, and either pass may have just matched it, so
      // summing the two per-pass pending counts would double-count. Count
      // each distinct examined candidate once and subtract everything
      // matched this run.
      const examined = new Set([...matched.examinedTradeHashes, ...deep.examinedTradeHashes]);
      const matchedIds = new Set([...matched.matchedTradeHashes, ...deep.matchedTradeHashes]);
      totalPending = examined.size - matchedIds.size;
    }

    if (freshRows.length) {
      await routeProviderOnlyObservationsToReview(env, provider.id, freshRows, nowIso);
    }

    const operationalStatus: LatencySourceStatus =
      errors.length > 0 ? 'error' : 'running';
    return {
      ...base,
      configured: true,
      enabled: true,
      operationalStatus,
      fetchedRows: totalFetchedRows,
      pending: totalPending,
      matched: totalMatched,
      errors,
    };
  } catch (err) {
    if (storageMissing(err)) {
      return {
        ...base,
        configured: true,
        enabled: true,
        operationalStatus: 'error',
        fetchedRows,
        pending: 0,
        matched: 0,
        errors,
        reason: 'latency tables missing; run /api/admin/migrate',
      };
    }
    throw err;
  }
}

/**
 * Cron may fire every minute. Each source (FMP / UW / QQ) self-throttles via
 * its own daily HTTP budget + 4-level ET yield-weighted interval — no shared
 * global gate that would force them to the same cadence.
 */
/** Max observation rows one probe run will re-hash. */
const OBSERVATION_REHASH_LIMIT = 250;

/**
 * Re-derive the trade hash for stored observations that were parsed before the
 * provider's filer fields were read correctly.
 *
 * These rows are provably dead: their hash has no filer segment, so every
 * branch of {@link matchDisclosureCandidate} rejects them. Re-fetching would
 * fix the hash but would also reset `first_observed_at` to now — destroying the
 * one thing the row exists to record, the moment the provider published. So we
 * re-parse the payload we already stored and rewrite the identity in place.
 *
 * Strictly conservative: only rows whose CURRENT hash lacks a filer and whose
 * RE-PARSED hash has one are touched, so a row that is already matchable is
 * never disturbed and a still-unparsable row is left alone rather than
 * rewritten to a second wrong value. A collision with an existing row (both
 * paths already stored the same trade) resolves by dropping the duplicate.
 */
export async function repairProviderObservationHashes(
  env: Env,
  limitRows = OBSERVATION_REHASH_LIMIT,
): Promise<{ scanned: number; repaired: number; dropped: number; unresolved: number }> {
  const broken = await all<{
    provider: ProviderId;
    chamber: Chamber;
    provider_key: string;
    trade_hash: string;
    payload: string | null;
  }>(
    env.DB,
    `SELECT provider, chamber, provider_key, trade_hash, payload
       FROM trade_provider_observations
      WHERE payload IS NOT NULL AND trade_hash LIKE '\\_%' ESCAPE '\\'
      LIMIT ?`,
    [limitRows],
  ).catch((err) => {
    if (storageMissing(err)) return [];
    throw err;
  });

  let repaired = 0;
  let dropped = 0;
  let unresolved = 0;
  for (const row of broken) {
    if (tradeHashHasFiler(row.trade_hash)) continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload ?? '') as Record<string, unknown>;
    } catch {
      unresolved++;
      continue;
    }
    const [reparsed] = parseProviderRowsForRepair(row.provider, row.chamber, payload);
    if (!reparsed || !tradeHashHasFiler(reparsed.tradeHash)) {
      unresolved++;
      continue;
    }
    try {
      await run(
        env.DB,
        `UPDATE trade_provider_observations
            SET trade_hash = ?, filer_name = COALESCE(filer_name, ?)
          WHERE provider = ? AND chamber = ? AND provider_key = ? AND trade_hash = ?`,
        [
          reparsed.tradeHash,
          reparsed.filerName,
          row.provider,
          row.chamber,
          row.provider_key,
          row.trade_hash,
        ],
      );
      repaired++;
    } catch {
      // Corrected identity already present — drop the unmatchable duplicate.
      await run(
        env.DB,
        `DELETE FROM trade_provider_observations
          WHERE provider = ? AND chamber = ? AND provider_key = ? AND trade_hash = ?`,
        [row.provider, row.chamber, row.provider_key, row.trade_hash],
      ).catch(() => {});
      dropped++;
    }
  }
  return { scanned: broken.length, repaired, dropped, unresolved };
}

/** Re-parse one stored payload with the provider's live parser. */
function parseProviderRowsForRepair(
  provider: ProviderId,
  chamber: Chamber,
  payload: Record<string, unknown>,
): DisclosureProviderRow[] {
  if (isFmpFamilyProvider(provider)) return parseFmpDisclosureRows(chamber, [payload], provider);
  if (provider === 'unusual_whales') return parseUnusualWhalesDisclosureRows([payload]);
  if (provider === 'quiver') return parseQuiverDisclosureRows(chamber, [payload]);
  return [];
}

export async function runDisclosureLatencyProbe(
  env: Env,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
  opts: { force?: boolean; providers?: string[] } = {},
): Promise<DisclosureLatencyProbeResult> {
  const envx = env as EnvWithWatch;
  // Commercial JSON APIs go direct. The residential proxy is for Clerk/eFD/OGE
  // HTML (Imperva). After RESIDENTIAL_PROXY_URL was set for Senate/House
  // scraping (2026-09-02), wrapping FMP in that hop silenced observations
  // ~42h — live house/senate-latest still 200 without the proxy. Dual free
  // keys stay on direct fetch; a 429 may retry one key through the proxy.
  const effectiveFetch = fetchImpl;
  if (!opts.force && !(await enabled(envx))) {
    return {
      enabled: false,
      reason: 'DISCLOSURE_LATENCY_WATCH_ENABLED is not true',
      fetchedRows: 0,
      pending: 0,
      matched: 0,
      errors: [],
      providers: [],
    };
  }

  const runs: DisclosureLatencyProviderRun[] = [];
  const max = await limit(envx);
  const requested = await requestedProviderIds(envx, opts);
  // Free (no HTTP): make already-stored, unmatchable observations matchable
  // again before this run's match pass reads them.
  try {
    const repair = await repairProviderObservationHashes(env);
    if (repair.repaired || repair.dropped) {
      console.warn(
        `trade latency: re-hashed ${repair.repaired} stored observations (${repair.dropped} duplicates dropped, ${repair.unresolved} still unparsable)`,
      );
    }
  } catch (err) {
    if (!storageMissing(err)) {
      console.warn('trade latency observation re-hash failed:', (err as Error).message);
    }
  }
  // Congress disclosures are stable-host only. RapidAPI is recorded as OFF
  // and never fetched. If the request names only fmp_rapidapi, still run the
  // stable probe so that label cannot silence house/senate.
  const selectedFmpPathId = await selectFmpLatencyPathForCycle(env, requested, {
    force: opts.force,
  });
  const probeIds = [...requested];
  if (selectedFmpPathId === 'stable' && !probeIds.includes('fmp')) {
    probeIds.unshift('fmp');
  }
  for (const providerId of probeIds) {
    runs.push(
      await runProviderProbe(env, definition(providerId), now, effectiveFetch, max, {
        force: opts.force,
        selectedFmpPathId,
      }),
    );
  }
  return {
    enabled: true,
    fetchedRows: runs.reduce((sum, r) => sum + r.fetchedRows, 0),
    pending: runs.reduce((sum, r) => sum + r.pending, 0),
    matched: runs.reduce((sum, r) => sum + r.matched, 0),
    errors: runs.flatMap((r) => r.errors.map((err) => `${r.id}: ${err}`)),
    providers: runs,
  };
}

async function tickLatencyPriceSnapshots(env: Env, now: Date, fetchImpl: typeof fetch): Promise<void> {
  try {
    const { runLatencyPriceSnapshotTick } = await import('./latencyPriceSnapshots.ts');
    await runLatencyPriceSnapshotTick(env, now, fetchImpl);
  } catch (err) {
    console.warn('latency price snapshots skipped:', (err as Error).message);
  }
}

/**
 * Residential scout → server: parse provider JSON with the same parsers the
 * server probe uses, upsert observations, and re-match pending races.
 * Used when the server cannot poll a source (IP block, key error, silence).
 */
export async function ingestScoutLatencyPayload(
  env: Env,
  input: {
    provider: ProviderId;
    observedAt?: string;
    /** Raw chamber payloads (preferred — server-side parse keeps keys consistent). */
    chamberJson?: Partial<Record<Chamber, unknown>>;
    /** Pre-parsed rows (optional alternative to chamberJson). */
    rows?: DisclosureProviderRow[];
    /** FMP path identity when provider is fmp / fmp_rapidapi. */
    fmpPathId?: FmpLatencyPathId;
    source?: 'scout' | 'server';
  },
): Promise<{ upserted: number; matched: number; pending: number; errors: string[]; provider: ProviderId }> {
  const providerId = input.provider;
  if (!DIRECT_PROVIDER_IDS.includes(providerId) && !isFmpFamilyProvider(providerId)) {
    throw new Error(`unsupported latency provider: ${providerId}`);
  }
  const nowIso =
    input.observedAt && !Number.isNaN(Date.parse(input.observedAt))
      ? new Date(input.observedAt).toISOString()
      : new Date().toISOString();
  const now = new Date(nowIso);
  const errors: string[] = [];
  let rows: DisclosureProviderRow[] = input.rows ? [...input.rows] : [];

  if (input.chamberJson) {
    for (const chamber of ['house', 'senate', 'executive'] as Chamber[]) {
      const payload = input.chamberJson[chamber];
      if (payload == null) continue;
      try {
        if (isFmpFamilyProvider(providerId) || providerId === 'fmp') {
          const pid: ProviderId =
            input.fmpPathId === 'rapidapi' || providerId === 'fmp_rapidapi' ? 'fmp_rapidapi' : 'fmp';
          rows.push(...parseFmpDisclosureRows(chamber, payload, pid));
        } else if (providerId === 'quiver') {
          rows.push(...parseQuiverDisclosureRows(chamber, payload));
        } else if (providerId === 'unusual_whales') {
          // UW is a single feed; chamberJson.house (or any) is accepted as the full payload.
          rows.push(...parseUnusualWhalesDisclosureRows(payload));
        }
      } catch (err) {
        errors.push(`${chamber}: ${(err as Error).message}`);
      }
    }
  }

  // Dedup by providerKey+tradeHash within this batch.
  const seen = new Set<string>();
  rows = rows.filter((r) => {
    const k = `${r.provider}|${r.chamber}|${r.providerKey}|${r.tradeHash}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (rows.length) {
    const storeProvider = (rows[0]?.provider ?? providerId) as ProviderId;
    await upsertProviderRows(env, storeProvider, rows, nowIso);
  }

  let matched = 0;
  let pending = 0;
  try {
    const provider = definition(
      isFmpFamilyProvider(providerId) && input.fmpPathId === 'rapidapi' ? 'fmp_rapidapi' : providerId,
    );
    const result = await matchPendingCandidates(env, provider, now, nowIso, errors);
    matched = result.matched;
    pending = result.pending;
  } catch (err) {
    if (!storageMissing(err)) errors.push(`match: ${(err as Error).message}`);
  }

  try {
    const { recordLatencyProbeOutcome } = await import('./scoutHandoff.ts');
    await recordLatencyProbeOutcome(env, (rows[0]?.provider ?? providerId) as 'fmp' | 'fmp_rapidapi' | 'unusual_whales' | 'quiver', {
      source: input.source ?? 'scout',
      kind: errors.length && !rows.length ? 'error' : 'success',
      error: errors[0] ?? null,
      fetchedRows: rows.length,
      now,
    });
  } catch {
    /* handoff bookkeeping best-effort */
  }

  await tickLatencyPriceSnapshots(env, now, fetch);
  return { upserted: rows.length, matched, pending, errors, provider: providerId };
}

export async function runFmpDisclosureLatencyProbe(
  env: Env,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
  opts: { force?: boolean } = {},
): Promise<DisclosureLatencyProbeResult> {
  // Request entire FMP family; runDisclosureLatencyProbe rotates to one path.
  return runDisclosureLatencyProbe(env, now, fetchImpl, {
    ...opts,
    providers: [...FMP_FAMILY_PROVIDER_IDS],
  });
}

/** Export registry snapshot for admin/scout consumers (no secrets). */
export function listFmpLatencyPathRegistry(): Array<{
  pathId: FmpLatencyPathId;
  providerId: ProviderId;
  label: string;
  defaultBaseUrl: string;
  auth: 'query' | 'rapidapi';
  defaultStatus: 'off';
}> {
  return FMP_LATENCY_PATHS.map((p) => ({
    pathId: p.pathId,
    providerId: p.providerId,
    label: p.label,
    defaultBaseUrl: p.defaultBaseUrl,
    auth: p.auth,
    defaultStatus: 'off' as const,
  }));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
}

function p90(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)];
}

/** Earliest parseable ISO timestamp among candidates (null if none). */
export function earliestIso(...vals: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = Infinity;
  for (const v of vals) {
    if (!v) continue;
    const ms = Date.parse(v);
    if (!Number.isFinite(ms) || ms >= bestMs) continue;
    bestMs = ms;
    best = v;
  }
  return best;
}

/**
 * Timestamp used for scoreboard lead/lag for a matched race.
 * Provider-kind feeds prefer their own stamp, then fall back to monitor first-seen
 * so missing Quiver_Upload_Time (etc.) does not produce matched=N with empty lead stats.
 */
export function effectiveRaceProviderTime(
  timestampKind: 'provider' | 'monitor' | 'none',
  row: { provider_published_at?: string | null; provider_first_seen_at?: string | null },
): string | null {
  if (timestampKind === 'provider') {
    return row.provider_published_at || row.provider_first_seen_at || null;
  }
  if (timestampKind === 'monitor') {
    return row.provider_first_seen_at || null;
  }
  return null;
}

/**
 * Match strength.
 *
 * A trade identity has four axes: person, ticker, transaction date, side. The
 * latency claim ("congress.trade published this N minutes before <provider>")
 * is only as trustworthy as the pairing behind it, so the two tiers are split
 * by how many of those axes the pairing actually verified:
 *
 *   STRONG — all four axes agree. `trade-hash` is a byte-identical identity;
 *            `fuzzy-near-date` allows only LATENCY_FUZZY_DATE_SLACK_DAYS (2)
 *            of drift on the date axis, which providers introduce by
 *            publishing settlement instead of transaction date.
 *   WEAK   — one axis was never verified. `fuzzy-missing-date` pairs on
 *            person+ticker+side with NO date constraint, so a member who
 *            bought the same ticker twice can pair against the wrong line.
 *            `fuzzy-no-ticker` pairs on person+date+side with the security
 *            unverified, so two different holdings disclosed the same day can
 *            pair with each other.
 *
 * Only STRONG feeds the headline (`matched`, `strongMatched`, `ctCoveragePct`,
 * lead/win timing). WEAK is reported separately so coverage can be honest
 * about rows we believe we paired without pretending they carry the same
 * evidentiary weight. Both tiers count as "not unmatched" — a weakly paired
 * provider row is not a coverage gap, it is a lower-confidence pairing.
 *
 * Before 2026-08-11 all four methods counted as strong, which is why an
 * 89-row `fuzzy-missing-date` bucket on Quiver rode into the public headline.
 */
export type MatchStrength = 'strong' | 'weak' | 'none';

const STRONG_MATCH_METHODS = new Set(['trade-hash', 'fuzzy-near-date', CORPUS_MATCH_METHOD]);

const WEAK_MATCH_METHODS = new Set(['fuzzy-missing-date', 'fuzzy-no-ticker']);

export function matchStrength(method: string | null | undefined): MatchStrength {
  if (!method) return 'none';
  if (STRONG_MATCH_METHODS.has(method)) return 'strong';
  if (WEAK_MATCH_METHODS.has(method)) return 'weak';
  // Unknown method: never promote into the headline.
  return 'weak';
}

function rowMatchStrength(row: { status: string; match_method: string | null }): MatchStrength {
  if (row.status !== 'matched') return 'none';
  return matchStrength(row.match_method);
}

type LatencyCandidateSummaryRow = {
  provider: ProviderId;
  trade_hash: string | null;
  status: string;
  chamber: Chamber;
  provider_key: string | null;
  match_method: string | null;
  congress_first_seen_at: string;
  provider_first_seen_at: string | null;
  provider_published_at: string | null;
  filed_date: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * A confirmed CT <-> provider pairing, used ONLY as the coverage numerator.
 *
 * Coverage used to be counted by intersecting two sets that live on two
 * different clocks: the numerator came from candidate rows filtered by
 * `congress_first_seen_at >= now-168h` (when CT first saw the filing) while the
 * denominator came from observation rows filtered by
 * `first_observed_at >= now-336h` (when the monitor first saw the provider list
 * it). Those two stamps are routinely ~9 days apart, so a genuinely matched
 * pair whose CT side had aged past 168h was dropped from the numerator while
 * its provider side stayed in the denominator. That is how Quiver reported
 * `ctCoveragePct: 0` while holding 51 matched rows, and how
 * `unmatchedProvider` reported exactly 567 of 567.
 *
 * This row type is loaded on the MATCH clock (`updated_at`), which is always
 * at or after the observation it paired with, so every pairing relevant to an
 * in-window observation is present regardless of how old the CT side is.
 */
export interface LatencyCoverageRow {
  provider: ProviderId;
  chamber: Chamber;
  provider_key: string | null;
  trade_hash: string | null;
  match_method: string | null;
}

interface CoverageIndex {
  /** `${chamber}:${provider_key}` for strongly paired observations. */
  strongKeys: Set<string>;
  strongHashes: Set<string>;
  weakKeys: Set<string>;
  weakHashes: Set<string>;
  /** Live-race pairings (not {@link CORPUS_MATCH_METHOD}). */
  raceKeys: Set<string>;
  raceHashes: Set<string>;
  /** Corpus-only pairings — CT has the trade, excluded from the race. */
  corpusKeys: Set<string>;
  corpusHashes: Set<string>;
  /** Canonical CT trade_hash for an observation, by key then by hash. */
  canonicalByKey: Map<string, string>;
  /**
   * Strong pairings this lane holds in the DB, counted as ROWS (not set size).
   * Used only by the contradiction guard: it answers "does congress.trade
   * believe it has ever matched this provider?" independently of whether any
   * of those pairings can be found from the observation side.
   */
  strongPairings: number;
}

/**
 * Build the coverage lookup for one provider lane. FMP-family rows collapse
 * onto the `fmp` lane so a pairing found on either HTTP path counts once.
 */
function buildCoverageIndex(rows: LatencyCoverageRow[], providerId: ProviderId): CoverageIndex {
  const idx: CoverageIndex = {
    strongKeys: new Set(),
    strongHashes: new Set(),
    weakKeys: new Set(),
    weakHashes: new Set(),
    raceKeys: new Set(),
    raceHashes: new Set(),
    corpusKeys: new Set(),
    corpusHashes: new Set(),
    canonicalByKey: new Map(),
    strongPairings: 0,
  };
  for (const row of rows) {
    const lane = isFmpFamilyProvider(row.provider) ? 'fmp' : row.provider;
    const target = isFmpFamilyProvider(providerId) ? 'fmp' : providerId;
    if (lane !== target) continue;
    const strength = matchStrength(row.match_method);
    // No method means no pairing. Never index it — an unpaired row landing in
    // the weak set would make a genuine coverage miss read as a match.
    if (strength === 'none') continue;
    const key = row.provider_key ? `${row.chamber}:${row.provider_key}` : null;
    if (key && row.trade_hash) idx.canonicalByKey.set(key, row.trade_hash);
    const corpus = row.match_method === CORPUS_MATCH_METHOD;
    if (corpus) {
      if (key) idx.corpusKeys.add(key);
      if (row.trade_hash) idx.corpusHashes.add(row.trade_hash);
    } else {
      if (key) idx.raceKeys.add(key);
      if (row.trade_hash) idx.raceHashes.add(row.trade_hash);
    }
    if (strength === 'strong') {
      idx.strongPairings += 1;
      if (key) idx.strongKeys.add(key);
      if (row.trade_hash) idx.strongHashes.add(row.trade_hash);
    } else {
      if (key) idx.weakKeys.add(key);
      if (row.trade_hash) idx.weakHashes.add(row.trade_hash);
    }
  }
  return idx;
}

type ObservationIdentity = { chamber: Chamber; provider_key: string; trade_hash?: string | null };

/**
 * `provider_key` is NOT a trade identity for every provider.
 *
 * Unusual Whales and Quiver derive it from the row's own fields, so it is
 * one key per trade line (193 of 194 and 482 of 485 keys are unique in
 * production). FMP derives it from the PTR document URL, so every line of a
 * filing shares one key — in production 309 FMP observations span just 31
 * keys, and a single key covers 73 separate trades. Crediting an observation
 * as matched because SOME row with the same key matched would inflate that one
 * pairing into 73, which is exactly the kind of unearned number the latency
 * claim must never contain.
 *
 * So a key only carries a pairing when it is unambiguous in the cohort being
 * measured — one observation holds it. Everything else pairs by `trade_hash`,
 * which is a real trade identity.
 */
function unambiguousKeys(observations: readonly ObservationIdentity[]): Set<string> {
  const counts = new Map<string, number>();
  for (const row of observations) {
    const key = `${row.chamber}:${row.provider_key}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [key, n] of counts) if (n === 1) out.add(key);
  return out;
}

function coverageStrength(
  idx: CoverageIndex,
  row: ObservationIdentity,
  keyIsTrustworthy: Set<string>,
): MatchStrength {
  const key = `${row.chamber}:${row.provider_key}`;
  const byKey = keyIsTrustworthy.has(key);
  if ((byKey && idx.strongKeys.has(key)) || (!!row.trade_hash && idx.strongHashes.has(row.trade_hash))) {
    return 'strong';
  }
  if ((byKey && idx.weakKeys.has(key)) || (!!row.trade_hash && idx.weakHashes.has(row.trade_hash))) {
    return 'weak';
  }
  return 'none';
}

function indexHas(set: Set<string>, row: ObservationIdentity, keyIsTrustworthy: Set<string>, kind: 'key' | 'hash'): boolean {
  if (kind === 'hash') return Boolean(row.trade_hash && set.has(row.trade_hash));
  const key = `${row.chamber}:${row.provider_key}`;
  return keyIsTrustworthy.has(key) && set.has(key);
}

function isCorpusOnlyCovered(
  idx: CoverageIndex,
  row: ObservationIdentity,
  keyIsTrustworthy: Set<string>,
): boolean {
  const corpus =
    indexHas(idx.corpusKeys, row, keyIsTrustworthy, 'key') ||
    indexHas(idx.corpusHashes, row, keyIsTrustworthy, 'hash');
  if (!corpus) return false;
  const raced =
    indexHas(idx.raceKeys, row, keyIsTrustworthy, 'key') ||
    indexHas(idx.raceHashes, row, keyIsTrustworthy, 'hash');
  return !raced;
}

export interface CorpusTransactionRow {
  full_name: string | null;
  ticker: string | null;
  tx_date: string | null;
  tx_type: string | null;
}

/**
 * Trade hashes from CT's full corpus — seed, competitor backfill, and
 * historical crawls included. Used only for coverage, never to mint a race.
 */
export function hashesFromCorpusTransactions(rows: readonly CorpusTransactionRow[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    const hash = generateTradeHash(row.full_name, row.ticker, row.tx_date, row.tx_type);
    if (tradeHashHasFiler(hash)) out.add(hash);
  }
  return out;
}

/**
 * Pair provider observations to CT's full corpus by exact trade hash.
 * Does not create race candidates and does not invent fuzzy matches.
 */
export function coverageRowsFromCorpusHashes(
  observations: ReadonlyArray<{
    provider: ProviderId;
    chamber: Chamber;
    provider_key: string;
    trade_hash?: string | null;
  }>,
  corpusHashes: ReadonlySet<string>,
): LatencyCoverageRow[] {
  const out: LatencyCoverageRow[] = [];
  const seen = new Set<string>();
  for (const row of observations) {
    if (!row.trade_hash || !tradeHashHasFiler(row.trade_hash)) continue;
    if (!corpusHashes.has(row.trade_hash)) continue;
    const id = `${row.provider}:${row.chamber}:${row.provider_key}:${row.trade_hash}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      provider: row.provider,
      chamber: row.chamber,
      provider_key: row.provider_key,
      trade_hash: row.trade_hash,
      match_method: CORPUS_MATCH_METHOD,
    });
  }
  return out;
}

/**
 * Prefer a live-race pairing when both exist for the same observation identity.
 * Corpus rows fill only the holes the race matcher never saw.
 */
export function mergeCoveragePreferringRace(
  raceRows: readonly LatencyCoverageRow[],
  corpusRows: readonly LatencyCoverageRow[],
): LatencyCoverageRow[] {
  const seen = new Set<string>();
  const out: LatencyCoverageRow[] = [];
  for (const row of raceRows) {
    const key = `${row.provider}:${row.chamber}:${row.trade_hash ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  for (const row of corpusRows) {
    const key = `${row.provider}:${row.chamber}:${row.trade_hash ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * Collapse FMP stable + RapidAPI candidate rows into one race per trade_hash.
 * Provider first-seen / published = earliest observation across either path.
 */
export function mergeFmpFamilyCandidateRows(
  rows: LatencyCandidateSummaryRow[],
): LatencyCandidateSummaryRow[] {
  const byHash = new Map<string, LatencyCandidateSummaryRow[]>();
  for (const row of rows) {
    if (!isFmpFamilyProvider(row.provider)) continue;
    const key = row.trade_hash || `${row.chamber}:${row.provider_key || row.created_at}`;
    const list = byHash.get(key);
    if (list) list.push(row);
    else byHash.set(key, [row]);
  }
  const out: LatencyCandidateSummaryRow[] = [];
  for (const group of byHash.values()) {
    // Prefer a strong pairing as the identity base, then any pairing at all,
    // so a weak-only FMP path still collapses onto one race row.
    const strong = group.filter((r) => rowMatchStrength(r) === 'strong');
    const matched = strong.length ? strong : group.filter((r) => rowMatchStrength(r) !== 'none');
    const pickFrom = matched.length ? matched : group;
    // Prefer a matched row as the identity base; always take earliest provider stamps.
    const base = pickFrom.reduce((a, b) =>
      (a.congress_first_seen_at || '') <= (b.congress_first_seen_at || '') ? a : b,
    );
    out.push({
      ...base,
      provider: 'fmp',
      provider_first_seen_at: earliestIso(...group.map((r) => r.provider_first_seen_at)),
      provider_published_at: earliestIso(...group.map((r) => r.provider_published_at)),
      status: matched.length ? 'matched' : base.status,
      match_method: matched[0]?.match_method ?? base.match_method,
      // Any path's key is fine for coverage bookkeeping after merge.
      provider_key: matched.find((r) => r.provider_key)?.provider_key ?? base.provider_key,
    });
  }
  return out;
}

/**
 * Collapse FMP-family observations: one row per trade_hash (earliest first_observed).
 */
export function mergeFmpFamilyObservationRows(
  rows: Array<ProviderObservationRow & { trade_hash?: string | null }>,
): Array<ProviderObservationRow & { trade_hash?: string | null }> {
  const byHash = new Map<string, Array<ProviderObservationRow & { trade_hash?: string | null }>>();
  for (const row of rows) {
    if (!isFmpFamilyProvider(row.provider)) continue;
    const key = row.trade_hash || `${row.chamber}:${row.provider_key}`;
    const list = byHash.get(key);
    if (list) list.push(row);
    else byHash.set(key, [row]);
  }
  const out: Array<ProviderObservationRow & { trade_hash?: string | null }> = [];
  for (const group of byHash.values()) {
    const earliest = group.reduce((a, b) =>
      (a.first_observed_at || '') <= (b.first_observed_at || '') ? a : b,
    );
    out.push({
      ...earliest,
      provider: 'fmp',
      first_observed_at: earliestIso(...group.map((r) => r.first_observed_at)) ?? earliest.first_observed_at,
      provider_published_at: earliestIso(...group.map((r) => r.provider_published_at)),
    });
  }
  return out;
}

/** Prefer running > error > stopped > off > unknown for merged FMP status badge. */
export function mergeFmpOperationalStatus(
  statuses: Array<LatencySourceStatus | undefined | null>,
): LatencySourceStatus {
  const set = new Set(statuses.filter(Boolean) as LatencySourceStatus[]);
  if (set.has('running')) return 'running';
  if (set.has('error')) return 'error';
  if (set.has('stopped')) return 'stopped';
  if (set.has('off')) return 'off';
  return 'unknown';
}

/** Public scorecard heading for the merged FMP family lane. */
export const PUBLIC_FMP_LATENCY_LABEL = 'FinancialModelingPrep.com';

/**
 * Public scorecards only show a lane whose probe is currently operating
 * (`running`) and whose coverage join is not known-broken.  error / stopped /
 * off / unknown stay on the admin scoreboard with a Hidden From Public chip.
 */
export function isLatencyComparisonPublic(p: {
  operationalStatus?: LatencySourceStatus | string | null;
  coverageIntegrity?: CoverageIntegrity | string | null;
}): boolean {
  if ((p.operationalStatus ?? 'unknown') !== 'running') return false;
  if (p.coverageIntegrity === 'contradiction') return false;
  return true;
}

function comparisonStatusFromSample(opts: {
  timingN: number;
  sampleOk: boolean;
  coverageOk: boolean;
  parserUnhealthy?: boolean;
}): DisclosureLatencyProviderMetrics['comparisonStatus'] {
  const { timingN, sampleOk, coverageOk, parserUnhealthy } = opts;
  // A broken parser is not a speed result. Never publish Ahead/Behind from it.
  if (parserUnhealthy) return timingN > 0 ? 'limited' : 'insufficient';
  // No timed deltas at all → never claim preliminary/usable (prevents "tie" with n=0).
  if (timingN <= 0) return 'insufficient';
  if (!sampleOk) {
    return timingN >= LATENCY_MIN_PRELIMINARY_MATCHED ? 'preliminary' : 'limited';
  }
  if (coverageOk && timingN >= LATENCY_MIN_PRELIMINARY_MATCHED) return 'usable';
  if (timingN >= LATENCY_MIN_PRELIMINARY_MATCHED) return 'preliminary';
  return 'limited';
}

function computeProviderMetrics(opts: {
  providerId: ProviderId;
  label: string;
  timestampKind: 'provider' | 'monitor' | 'none';
  operationalStatus: LatencySourceStatus;
  mine: LatencyCandidateSummaryRow[];
  observations: Array<{
    provider: string;
    chamber: Chamber;
    provider_key: string;
    trade_hash?: string | null;
    first_observed_at: string;
  }>;
  maturityCutoff: string;
  /**
   * Every confirmed pairing on the MATCH clock. Optional so unit tests can
   * still build metrics from `mine` alone; when omitted we fall back to the
   * in-window candidate rows, which is the old (window-coupled) behaviour.
   */
  coverageRows?: LatencyCoverageRow[];
}): DisclosureLatencyProviderMetrics {
  const {
    providerId,
    label,
    timestampKind,
    operationalStatus,
    mine,
    observations,
    maturityCutoff,
    coverageRows,
  } = opts;
  const maxDeltaSec = LATENCY_MAX_CONCURRENT_DELTA_HOURS * 3600;
  const liveMatched = mine.filter((row) => rowMatchStrength(row) === 'strong');
  const timingMatches = liveMatched.filter((row) => {
    const t = effectiveRaceProviderTime(timestampKind, row);
    if (!t) return false;
    return Math.abs(deltaSeconds(t, row.congress_first_seen_at) ?? 1e12) <= maxDeltaSec;
  });
  // Effective deltas — same stamp cohort as matched (no published-only empty set).
  const effectiveDeltas = timingMatches
    .map((row) =>
      deltaSeconds(effectiveRaceProviderTime(timestampKind, row), row.congress_first_seen_at),
    )
    .filter((v): v is number => v != null);
  const publishedDeltas = timingMatches
    .map((row) => deltaSeconds(row.provider_published_at, row.congress_first_seen_at))
    .filter((v): v is number => v != null);
  // matched ≡ number of timed races with a real delta (never inflate above lead sample).
  const timingN = effectiveDeltas.length;
  const strongMatched = timingN;
  const weakMatched = mine.filter((row) => rowMatchStrength(row) === 'weak').length;

  // Coverage numerator. Derived from `coverageRows` (loaded on the match
  // clock) so a pairing whose CT side aged out of the 7d timing window still
  // counts against the 14d observation denominator it actually belongs to.
  // Falling back to `mine` reproduces the old, window-coupled behaviour and is
  // only used by unit tests that pass no coverage rows.
  const coverageIndex = buildCoverageIndex(
    coverageRows ??
      mine.map((row) => ({
        provider: row.provider,
        chamber: row.chamber,
        provider_key: row.provider_key,
        trade_hash: row.trade_hash,
        match_method: row.status === 'matched' ? row.match_method : null,
      })),
    providerId,
  );
  const trustworthyKeys = unambiguousKeys(observations);
  const obsStrength = (row: ObservationIdentity) =>
    coverageStrength(coverageIndex, row, trustworthyKeys);

  const maturedObservations = observations.filter((row) => row.first_observed_at <= maturityCutoff);
  const maturedCandidates = mine.filter((row) => row.congress_first_seen_at <= maturityCutoff);
  const maturedMatched = maturedObservations.filter((row) => obsStrength(row) === 'strong').length;
  const maturedWeakMatched = maturedObservations.filter((row) => obsStrength(row) === 'weak').length;
  const maturedProviderObserved = maturedObservations.length;
  // Counted independently, never as `maturedProviderObserved - maturedMatched`.
  // The subtraction made "everything is unmatched" an arithmetic identity that
  // could not disagree with a broken numerator.
  const unmatchedProvider = maturedObservations.filter((row) => obsStrength(row) === 'none').length;
  const unmatchedProviderCtExcluded = maturedObservations.filter((row) =>
    isCorpusOnlyCovered(coverageIndex, row, trustworthyKeys),
  ).length;
  const unmatchedProviderCtMissing = unmatchedProvider;
  // Provider rows we stored with no usable filer segment in the trade hash —
  // unmatchable by construction (see tradeHashHasFiler). A non-zero value here
  // is a PARSER fault, not a coverage result.
  const observedRowsMissingFiler = observations.filter(
    (row) => !tradeHashHasFiler(row.trade_hash),
  ).length;
  const parserHealth: ParserHealth =
    observations.length >= LATENCY_PARSER_HEALTH_MIN_ROWS &&
    observedRowsMissingFiler / observations.length >= LATENCY_PARSER_HEALTH_MISSING_FILER_RATIO
      ? 'unhealthy'
      : 'ok';
  const pendingProvider = observations.filter(
    (row) => row.first_observed_at > maturityCutoff && obsStrength(row) === 'none',
  ).length;
  const matchedMaturedCandidates = maturedCandidates.filter(
    (row) => rowMatchStrength(row) === 'strong',
  ).length;
  // CONTRADICTION GUARD.
  //
  // Coverage is a JOIN, and a join has a failure mode a ratio cannot express:
  // when the two sides stop sharing an identity, the numerator collapses to
  // zero and the ratio dutifully reports 0% — a number indistinguishable from
  // the honest finding "the provider saw things we never did". That is exactly
  // what shipped for months: `unmatchedProvider = 567 of 567` while D1 held
  // hundreds of rows with `status='matched'` for those same providers.
  //
  // These two facts cannot both be true. If congress.trade has strong pairings
  // on file for this lane, then at least one matured observation should find
  // one; zero means the lookup is broken (mismatched clocks, a changed hash
  // shape, a lane-id split), not that coverage is genuinely nil. Publishing 0%
  // in that state states a measurement we did not make.
  //
  // So we refuse to publish the ratio and say why. Suppressing it also fails
  // the `coverageOk` gate below, which keeps `comparisonStatus` out of
  // `usable` — a broken join can never be laundered into a public claim.
  //
  // KNOWN BENIGN TRIGGER, accepted deliberately: a lane whose only pairings are
  // newer than `maturityCutoff` (e.g. the hours right after a matcher fix
  // lands) has strong pairings on file and zero matured matches without
  // anything being broken. We still suppress, because the alternative is
  // publishing 0% during precisely the window when 0% is most wrong. `null`
  // says "not yet known"; 0% says "we checked, and the answer is none". Only
  // the first is true here.
  const coverageContradiction =
    maturedProviderObserved > 0 && maturedMatched === 0 && coverageIndex.strongPairings > 0;
  const coverageIntegrity: CoverageIntegrity = coverageContradiction ? 'contradiction' : 'ok';

  const ctCoveragePct =
    coverageContradiction || !maturedProviderObserved
      ? null
      : Math.round((maturedMatched / maturedProviderObserved) * 1000) / 10;
  const providerCoveragePct = maturedCandidates.length
    ? Math.round((matchedMaturedCandidates / maturedCandidates.length) * 1000) / 10
    : null;
  const union = maturedProviderObserved + maturedCandidates.length - maturedMatched;
  const overlapPct =
    coverageContradiction || union <= 0
      ? null
      : Math.round((maturedMatched / union) * 1000) / 10;
  const coverageOk =
    (ctCoveragePct ?? 0) >= LATENCY_MIN_COVERAGE_PCT &&
    (providerCoveragePct ?? 0) >= LATENCY_MIN_COVERAGE_PCT;
  const sampleOk =
    maturedProviderObserved >= LATENCY_MIN_MATURED_ROWS &&
    maturedCandidates.length >= LATENCY_MIN_MATURED_ROWS;

  return {
    provider: providerId,
    label,
    operationalStatus,
    candidates: mine.length,
    matched: timingN,
    strongMatched,
    weakMatched,
    pending: mine.filter((row) => row.status === 'pending').length,
    errored: mine.filter((row) => row.status === 'error').length,
    providerObserved: observations.length,
    maturedProviderObserved,
    unmatchedProvider,
    unmatchedProviderCtMissing,
    unmatchedProviderCtExcluded,
    observedRowsMissingFiler,
    parserHealth,
    pendingProvider,
    maturedCandidates: maturedCandidates.length,
    maturedMatched,
    maturedWeakMatched,
    ctCoveragePct,
    providerCoveragePct,
    overlapPct,
    coverageIntegrity,
    coverageStrongPairingsOnFile: coverageIndex.strongPairings,
    comparisonStatus: comparisonStatusFromSample({
      timingN,
      sampleOk,
      coverageOk,
      parserUnhealthy: parserHealth === 'unhealthy',
    }),
    comparisonBasis: 'matched-overlap-only',
    // "Monitor" fields carry the effective race deltas (provider stamp with fallback).
    ctAheadMonitorCount: effectiveDeltas.filter((d) => d > 0).length,
    providerAheadMonitorCount: effectiveDeltas.filter((d) => d < 0).length,
    tieMonitorCount: effectiveDeltas.filter((d) => d === 0).length,
    avgMonitorDeltaSec: average(effectiveDeltas),
    medianMonitorDeltaSec: median(effectiveDeltas),
    p90MonitorDeltaSec: p90(effectiveDeltas),
    ctAheadPublishedCount: publishedDeltas.filter((d) => d > 0).length,
    providerAheadPublishedCount: publishedDeltas.filter((d) => d < 0).length,
    tiePublishedCount: publishedDeltas.filter((d) => d === 0).length,
    avgProviderPublishedDeltaSec: average(publishedDeltas),
    medianProviderPublishedDeltaSec: median(publishedDeltas),
    timestampKind,
  };
}

/**
 * Realm-of-concern test for one disclosed line. See
 * {@link DisclosureLatencyScope} for the full definition of who is in scope.
 *
 * House and Senate rows pass on the chamber alone — every feed on both sides
 * is already restricted to sitting members, so re-deriving membership here
 * would only add a second, weaker identity resolver next to the one we
 * already trust. Executive rows must resolve to a curated POTUS / VP / cabinet
 * / agency-head filer by full name; a bare last name is deliberately not
 * enough (`resolveExecutiveFilerIdFromName` rejects it), so an executive-lane
 * row we cannot identify fails closed and is excluded rather than counted.
 */
export function isInLatencyScope(row: { chamber: Chamber; filer_name?: string | null }): boolean {
  if (row.chamber === 'house' || row.chamber === 'senate') return true;
  if (row.chamber === 'executive') {
    return Boolean(resolveExecutiveFilerIdFromName(row.filer_name ?? null));
  }
  return false;
}

type ScopeCandidateRow = LatencyCandidateSummaryRow & { filer_name?: string | null };
type ScopeObservationRow = {
  provider: ProviderId;
  chamber: Chamber;
  provider_key: string;
  trade_hash: string | null;
  first_observed_at: string;
  filer_name?: string | null;
};

/**
 * Compute "N of M matched" over the union of both feeds. See
 * {@link DisclosureLatencyScope} for exactly what M and N count and why.
 */
export function computeLatencyScope(opts: {
  candidates: ScopeCandidateRow[];
  observations: ScopeObservationRow[];
  coverageRows: LatencyCoverageRow[];
  windowHours: number;
}): DisclosureLatencyScope {
  const { candidates, observations, coverageRows, windowHours } = opts;

  // One entry per distinct disclosed line.
  type Entry = { ct: boolean; provider: boolean; strength: MatchStrength };
  const lines = new Map<string, Entry>();
  let excludedOutOfScope = 0;
  let excludedMissingFiler = 0;

  const touch = (key: string): Entry => {
    const existing = lines.get(key);
    if (existing) return existing;
    const created: Entry = { ct: false, provider: false, strength: 'none' };
    lines.set(key, created);
    return created;
  };
  const raise = (entry: Entry, next: MatchStrength) => {
    if (next === 'strong') entry.strength = 'strong';
    else if (next === 'weak' && entry.strength !== 'strong') entry.strength = 'weak';
  };

  for (const row of candidates) {
    if (!row.trade_hash) continue;
    if (!tradeHashHasFiler(row.trade_hash)) {
      excludedMissingFiler++;
      continue;
    }
    if (!isInLatencyScope(row)) {
      excludedOutOfScope++;
      continue;
    }
    const entry = touch(`${row.chamber}:${row.trade_hash}`);
    entry.ct = true;
    raise(entry, rowMatchStrength(row));
  }

  // Canonicalise a paired observation onto the candidate hash it paired with,
  // so a provider hash that differs from ours does not read as a second line.
  // Only via a provider_key that identifies ONE observation — FMP's key is a
  // document token shared by every line of a filing (see unambiguousKeys), and
  // folding 73 distinct trades onto one hash would shrink M by 72 lines we
  // genuinely saw.
  const canonical = new Map<string, string>();
  const strengthByKey = new Map<string, MatchStrength>();
  const strengthByHash = new Map<string, MatchStrength>();
  const corpusLineKeys = new Set<string>();
  const observationKeyCounts = new Map<string, number>();
  for (const row of observations) {
    const key = `${row.provider}:${row.chamber}:${row.provider_key}`;
    observationKeyCounts.set(key, (observationKeyCounts.get(key) ?? 0) + 1);
  }
  for (const row of coverageRows) {
    const strength = matchStrength(row.match_method);
    // No method means no pairing — do not canonicalise or credit it.
    if (strength === 'none') continue;
    if (row.provider_key) {
      const key = `${row.provider}:${row.chamber}:${row.provider_key}`;
      if (observationKeyCounts.get(key) === 1) {
        if (row.trade_hash) canonical.set(key, row.trade_hash);
        strengthByKey.set(key, strength);
      }
    }
    if (row.trade_hash) {
      strengthByHash.set(`${row.provider}:${row.trade_hash}`, strength);
      if (row.match_method === CORPUS_MATCH_METHOD) {
        corpusLineKeys.add(`${row.chamber}:${row.trade_hash}`);
      }
    }
  }

  for (const row of observations) {
    const byKey = `${row.provider}:${row.chamber}:${row.provider_key}`;
    const pairedHash = canonical.get(byKey) ?? null;
    const hash = pairedHash ?? row.trade_hash;
    if (!hash) continue;
    if (!tradeHashHasFiler(hash)) {
      excludedMissingFiler++;
      continue;
    }
    if (!isInLatencyScope(row)) {
      excludedOutOfScope++;
      continue;
    }
    const entry = touch(`${row.chamber}:${hash}`);
    entry.provider = true;
    // Corpus-hash means CT has the trade in the full table even though no
    // live-race candidate was minted. Count that as both sides seeing the line.
    if (corpusLineKeys.has(`${row.chamber}:${hash}`)) entry.ct = true;
    const strength =
      strengthByKey.get(byKey) ??
      (row.trade_hash ? strengthByHash.get(`${row.provider}:${row.trade_hash}`) : undefined) ??
      'none';
    raise(entry, strength);
  }

  let matched = 0;
  let matchedIncludingWeak = 0;
  let ctOnly = 0;
  let providerOnly = 0;
  for (const entry of lines.values()) {
    if (entry.strength === 'strong') matched++;
    if (entry.strength !== 'none') matchedIncludingWeak++;
    if (entry.ct && !entry.provider) ctOnly++;
    if (entry.provider && !entry.ct) providerOnly++;
  }
  const total = lines.size;

  return {
    windowHours,
    total,
    matched,
    matchedIncludingWeak,
    ctOnly,
    providerOnly,
    matchedPct: total ? Math.round((matched / total) * 1000) / 10 : null,
    excludedOutOfScope,
    excludedMissingFiler,
  };
}

/**
 * Public scoreboard providers: FMP stable + RapidAPI collapse to one
 * FinancialModelingPrep.com lane using the earliest path observation per trade.
 * Other direct providers pass through.  Callers still filter with
 * {@link isLatencyComparisonPublic} before painting the public grid.
 */
export function buildPublicLatencyProviders(
  pathMetrics: DisclosureLatencyProviderMetrics[],
  candidateRows: LatencyCandidateSummaryRow[],
  observationRows: Array<ProviderObservationRow & { trade_hash?: string | null }>,
  statuses: DisclosureLatencyProviderStatus[],
  maturityCutoff: string,
  coverageRows: LatencyCoverageRow[] = [],
): DisclosureLatencyProviderMetrics[] {
  const liveCandidates = candidateRows.filter((row) =>
    isLiveRaceImport({
      source: 'primary',
      filedDate: row.filed_date,
      firstSeenAt: row.congress_first_seen_at,
    }),
  );
  const fmpCandidates = mergeFmpFamilyCandidateRows(liveCandidates);
  const fmpObservations = mergeFmpFamilyObservationRows(
    observationRows.filter((r) => isFmpFamilyProvider(r.provider)),
  );
  const fmpStatus = mergeFmpOperationalStatus(
    statuses.filter((s) => isFmpFamilyProvider(s.id)).map((s) => s.operationalStatus),
  );
  const fmpMetrics = computeProviderMetrics({
    providerId: 'fmp',
    label: PUBLIC_FMP_LATENCY_LABEL,
    timestampKind: 'monitor',
    operationalStatus: fmpStatus,
    mine: fmpCandidates,
    observations: fmpObservations,
    maturityCutoff,
    coverageRows: coverageRows.length ? coverageRows : undefined,
  });

  const others = PROVIDERS.filter(
    (p) => p.supportsDirectLatest && !isFmpFamilyProvider(p.id),
  ).map((provider) => {
    const existing = pathMetrics.find((m) => m.provider === provider.id);
    if (existing) {
      // Public label: shorten Quiver display name is already fine.
      return existing;
    }
    return computeProviderMetrics({
      providerId: provider.id,
      label: provider.label,
      timestampKind: provider.timestampKind,
      operationalStatus:
        statuses.find((s) => s.id === provider.id)?.operationalStatus ?? 'unknown',
      mine: liveCandidates.filter((r) => r.provider === provider.id),
      observations: observationRows.filter((r) => r.provider === provider.id),
      maturityCutoff,
      coverageRows: coverageRows.length ? coverageRows : undefined,
    });
  });

  return [fmpMetrics, ...others];
}

/**
 * Load exact trade hashes from CT's full transactions table for the dates
 * present on in-window provider observations. Seed / backfill / lag rows are
 * included on purpose — this answers "do we have the trade at all?"
 */
async function loadCorpusTradeHashes(
  env: Env,
  observations: ReadonlyArray<{ trade_hash?: string | null }>,
): Promise<Set<string>> {
  const dates = new Set<string>();
  for (const row of observations) {
    const parsed = parseTradeHash(row.trade_hash);
    if (parsed.date) dates.add(parsed.date);
  }
  if (!dates.size) return new Set();
  const dateList = Array.from(dates).slice(0, 200);
  const placeholders = dateList.map(() => '?').join(', ');
  const rows = await all<CorpusTransactionRow>(
    env.DB,
    `SELECT fil.full_name AS full_name, t.ticker, t.tx_date, t.tx_type
       FROM transactions t
       LEFT JOIN filings f ON f.doc_id = t.doc_id
       LEFT JOIN filers fil ON fil.bioguide_id = COALESCE(t.filer_id, f.filer_id)
      WHERE t.deprecated_at IS NULL
        AND t.tx_date IN (${placeholders})
        AND fil.full_name IS NOT NULL
      LIMIT 8000`,
    dateList,
  ).catch((err) => {
    if (storageMissing(err)) return [];
    throw err;
  });
  return hashesFromCorpusTransactions(rows);
}

export async function getDisclosureLatencySummary(env: Env, now: Date = new Date()): Promise<DisclosureLatencySummary> {
  const scoreCutoff = new Date(now.getTime() - LATENCY_SCORE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const providerLookbackCutoff = new Date(
    now.getTime() - LATENCY_PROVIDER_MATCH_LOOKBACK_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const maturityCutoff = new Date(now.getTime() - LATENCY_MATURITY_GRACE_HOURS * 60 * 60 * 1000).toISOString();
  // Candidate rows over the 14d scope window. The 7d timing cohort is derived
  // from this in memory (see `rows` below) so both the score window and the
  // scope denominator come from one read.
  const windowRows = await all<LatencyCandidateSummaryRow & { filer_name: string | null }>(
    env.DB,
    // Live CT first_seen in the scope window (backfills never minted here).
    `SELECT provider, trade_hash, status, chamber, provider_key, match_method, congress_first_seen_at,
            provider_first_seen_at, provider_published_at, filed_date, filer_name, created_at, updated_at
       FROM trade_latency_candidates
      WHERE congress_first_seen_at >= ?
      ORDER BY CASE WHEN status = 'matched' THEN 0 ELSE 1 END,
               updated_at DESC
      LIMIT 8000`,
    [providerLookbackCutoff],
  ).catch((err) => {
    if (storageMissing(err)) return [];
    throw err;
  });
  // Timing cohort: unchanged 7d meaning for `totals` and every lead statistic.
  const rows = windowRows.filter((row) => row.congress_first_seen_at >= scoreCutoff);

  // Coverage numerator on the MATCH clock, not the CT-first-seen clock.
  // `updated_at` is stamped when a candidate flips to matched (see
  // matchAndUpdateCandidates), and a pairing can never predate the observation
  // it paired with, so every pairing relevant to an in-window observation is in
  // this set no matter how old its CT side is. Bounded by the same 14d window
  // as the observation pull, and matched rows number in the hundreds.
  const coverageRows = await all<LatencyCoverageRow>(
    env.DB,
    `SELECT provider, chamber, provider_key, trade_hash, match_method
       FROM trade_latency_candidates
      WHERE status = 'matched' AND updated_at >= ?
      LIMIT 20000`,
    [providerLookbackCutoff],
  ).catch((err) => {
    if (storageMissing(err)) return [];
    throw err;
  });

  // Provider listings in the 14d match lookback (they can beat us by a week).
  const providerRows = await all<ProviderObservationRow>(
    env.DB,
    `SELECT provider, chamber, provider_key, trade_hash, first_observed_at, last_observed_at,
            provider_published_at, source_url, filed_date, filer_name, payload
       FROM trade_provider_observations
      WHERE first_observed_at >= ?
      ORDER BY first_observed_at DESC
      LIMIT 10000`,
    [providerLookbackCutoff],
  ).catch((err) => {
    if (storageMissing(err)) return [];
    throw err;
  });

  const statuses = await getDisclosureLatencyProviderStatuses(env);
  const corpusHashes = await loadCorpusTradeHashes(env, providerRows);
  const coverageRowsWithCorpus = mergeCoveragePreferringRace(
    coverageRows,
    coverageRowsFromCorpusHashes(providerRows, corpusHashes),
  );
  // Per-path metrics (admin / ops — FMP stable and RapidAPI stay separate).
  const providers = PROVIDERS.filter((p) => p.supportsDirectLatest).map((provider) => {
    const mine = rows.filter(
      (row) =>
        row.provider === provider.id &&
        isLiveRaceImport({
          source: 'primary',
          filedDate: row.filed_date,
          firstSeenAt: row.congress_first_seen_at,
        }),
    );
    const observations = providerRows.filter((row) => row.provider === provider.id);
    const st = statuses.find((s) => s.id === provider.id);
    return computeProviderMetrics({
      providerId: provider.id,
      label: provider.label,
      timestampKind: provider.timestampKind,
      operationalStatus: st?.operationalStatus ?? 'unknown',
      mine,
      observations,
      maturityCutoff,
      coverageRows: coverageRowsWithCorpus,
    });
  });

  // Public scoreboard: one FMP lane (earliest of stable/RapidAPI), no dual listing.
  const publicProviders = buildPublicLatencyProviders(
    providers,
    rows,
    providerRows,
    statuses,
    maturityCutoff,
    coverageRowsWithCorpus,
  );

  // "N of M matched" across the whole realm of concern (both feeds, one 14d
  // window, one row per distinct disclosed line).
  const scope = computeLatencyScope({
    candidates: windowRows.filter((row) =>
      isLiveRaceImport({
        source: 'primary',
        filedDate: row.filed_date,
        firstSeenAt: row.congress_first_seen_at,
      }),
    ),
    observations: providerRows,
    coverageRows: coverageRowsWithCorpus,
    windowHours: LATENCY_PROVIDER_MATCH_LOOKBACK_HOURS,
  });
  const totals = {
    candidates: rows.length,
    matched: providers.reduce((sum, p) => sum + p.matched, 0),
    pending: rows.filter((row) => row.status === 'pending').length,
    errored: rows.filter((row) => row.status === 'error').length,
    providerObserved: providerRows.length,
    maturedProviderObserved: providers.reduce((sum, p) => sum + p.maturedProviderObserved, 0),
    unmatchedProvider: providers.reduce((sum, p) => sum + p.unmatchedProvider, 0),
    unmatchedProviderCtMissing: providers.reduce((sum, p) => sum + p.unmatchedProviderCtMissing, 0),
    unmatchedProviderCtExcluded: providers.reduce((sum, p) => sum + p.unmatchedProviderCtExcluded, 0),
    comparableProviders: PROVIDERS.filter((p) => p.supportsDirectLatest).length,
    configuredComparableProviders: statuses.filter((p) => p.supportsDirectLatest && p.configured).length,
  };
  // Public totals count functioning scoreboard lanes (FMP merged), not dual FMP paths.
  const visiblePublicProviders = publicProviders.filter(isLatencyComparisonPublic);
  const publicTotals = {
    ...totals,
    matched: visiblePublicProviders.reduce((sum, p) => sum + p.matched, 0),
    maturedProviderObserved: visiblePublicProviders.reduce((sum, p) => sum + p.maturedProviderObserved, 0),
    unmatchedProvider: visiblePublicProviders.reduce((sum, p) => sum + p.unmatchedProvider, 0),
    unmatchedProviderCtMissing: visiblePublicProviders.reduce((sum, p) => sum + p.unmatchedProviderCtMissing, 0),
    unmatchedProviderCtExcluded: visiblePublicProviders.reduce((sum, p) => sum + p.unmatchedProviderCtExcluded, 0),
    comparableProviders: visiblePublicProviders.length,
    configuredComparableProviders: statuses.filter(
      (p) =>
        p.supportsDirectLatest &&
        p.configured &&
        // Count FMP family once when any path is configured.
        (!isFmpFamilyProvider(p.id) || p.id === 'fmp'),
    ).length,
  };
  const generatedAt = now.toISOString();
  const meta = {
    windowHours: LATENCY_SCORE_WINDOW_HOURS,
    maxConcurrentDeltaHours: LATENCY_MAX_CONCURRENT_DELTA_HOURS,
  };
  return {
    generatedAt,
    ...meta,
    totals,
    scope,
    providers,
    providerStatuses: statuses,
    publicSummary: {
      generatedAt,
      ...meta,
      totals: publicTotals,
      scope,
      providers: publicProviders.map((p) => ({
        ...p,
        publiclyShown: isLatencyComparisonPublic(p),
      })),
    },
  };
}

export async function recordDisclosureLatencyCandidate(
  env: Env,
  filing: any,
  nowIso: string,
): Promise<void> {
  // Deprecated: Candidates are now tracked at the trade level inside normalizer.ts / backfill/seed.ts
}
