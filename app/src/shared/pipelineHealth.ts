/**
 * src/shared/pipelineHealth.ts
 * Deep health and data freshness inspection for congress.trade pipeline components.
 * Evaluates queue backlog age, provider failure rates, review queue accumulation,
 * autopilot halts, and transaction data freshness.
 */

import type { Env } from './types.ts';
import { all, get } from './db.ts';
import { getLastPollAt } from './config.ts';
import {
  countReviewQueueBuckets,
  formatReviewQueueHealthDetail,
  type ReviewQueueHealthCounts,
} from '../extraction/reviewQueueHealth.ts';
import { describeAutopilotHaltReason } from '../extraction/providerHealth.ts';
import { ogeWatchEnabled } from '../ingestion/ogeSource.ts';
import { readResidentialProxyProbe } from '../ingestion/residentialProxyHealth.ts';
import { readSenateRelayProbe } from '../ingestion/senateRelayHealth.ts';
import { resolveResidentialProxyUrl } from './proxyFetch.ts';
import { expectedLatencyProviderIds } from '../ingestion/tradeLatency.ts';
import { z } from 'zod';
import {
  allocateProbes,
  dayTypeFor,
  etClock,
  probeScheduleConfigFromEnv,
  DEFAULT_PROBE_SCHEDULE_CONFIG,
  type ProbeScheduleConfig,
} from '../ingestion/probeSchedule.ts';

export type PipelineStatus = 'ok' | 'degraded' | 'critical' | 'stalled' | 'unknown';

export interface PipelineCheck {
  id: string;
  status: PipelineStatus;
  detail: string;
  /**
   * 2026-09-21: structured payload for checks that need more than a scalar.
   * `price_freshness` uses the worstBehind/legs shape; `filing_skips` and
   * `fmp_latency` use structured objects too. Plain scalars (number /
   * string / null) are still permitted for the simple checks.
   */
  value?:
    | number
    | string
    | null
    | { worstBehind: number; legs: Record<string, { date: string | null; behind: number | null }> }
    | {
        total: number;
        byAction: Partial<Record<'extract_empty_failure' | 'auto_resolved_empty' | 'doc_quarantined', number>>;
        threshold: number;
      }
    | {
        observationCount24h: number | null;
        lastObservationAt: string | null;
        lastObservationAgeSec: number | null;
        http429s24h: number | null;
        byProvider: Record<string, { count: number; lastLatencyMs: number | null; lastAt: string | null }> | null;
      }
    | Record<string, unknown>;
}

export interface PipelineHealth {
  status: PipelineStatus;
  checks: PipelineCheck[];
  /** Disjoint unresolved review-queue buckets.  Absent when uncollected. */
  reviewQueue?: ReviewQueueHealthCounts | null;
  /** 2026-09-21: extended signals surfaced to admin/dashboard. */
  signals?: {
    filingSkips24h: number | null;
    filingSkipsByAction24h: PipelineSignals['filingSkipsByAction24h'];
    fmpLatency: PipelineSignals['fmpLatency'];
    priceEodLatestDate: string | null;
    spxEodLatestDate: string | null;
  };
}

export interface PipelineSignals {
  outboxPending: number | null;
  outboxOldestAt: string | null;
  outboxFailed: number | null;
  /**
   * Failed outbox rows updated within 24h that are not parked (`parked:%`).
   * Used for detail only — active failures degrade regardless of age.
   */
  outboxFailedFresh?: number | null;
  /**
   * Failed outbox rows that are not explicitly parked.  Any non-zero count
   * degrades health (board f6be69f466af — age alone must not clear failures).
   */
  outboxFailedActive?: number | null;
  /** ALL unresolved review_queue rows (eligible + suppressed + terminal). */
  reviewBacklog: number | null;
  reviewEligible: number | null;
  reviewSuppressed: number | null;
  reviewTerminal: number | null;
  extractionAttempts24h: number | null;
  extractionOk24h: number | null;
  /**
   * 2026-09-21: count of filings in the last 24h whose extract produced zero
   * usable transactions (`extract_empty_failure`, `auto_resolved_empty`,
   * `doc_quarantined`). These outcomes are almost-always an app error
   * (corrupt parse, OCR failure, model dead-letter) — not a real "this
   * filing was blank". A non-zero count is the loud red flag the admin
   * surface and Pushover liveness alarm look for. Tunable via env
   * CT_FILING_SKIP_THRESHOLD_24H (default 0 — page on the first one).
   */
  filingSkips24h: number | null;
  /** 2026-09-21: per-provider breakdown of recent skips (admin + dashboard). */
  filingSkipsByAction24h: Record<'extract_empty_failure' | 'auto_resolved_empty' | 'doc_quarantined', number> | null;
  /**
   * 2026-09-21: FMP-family latency summary for both admin and user surfaces.
   * The user-facing dashboard renders `lastObservationAgeSec` + `observationCount24h`
   * so a free-tier key outage shows up immediately instead of only on the
   * health endpoint. 429 hit-rate is exposed as `http429s24h` so a key
   * rotation problem is visible before FMP starts returning 401/403.
   */
  fmpLatency: {
    observationCount24h: number | null;
    lastObservationAt: string | null;
    lastObservationAgeSec: number | null;
    http429s24h: number | null;
    /** Per-provider last-observation age (seconds) when trade_provider_observations is reachable. */
    byProvider: Record<string, { lastObservationAt: string | null; ageSec: number | null; count24h: number | null }> | null;
  } | null;
  lastExtractionSuccessAt: string | null;
  /**
   * Submission receipts from the Mac/server local-vision workers in 24h
   * (ingestion_decisions.source='local_mac').  These workers publish scans
   * without writing extraction_runs, so a healthy local drain used to read
   * as "no extraction attempts" (stalled) to the health check.
   */
  localWorkerActivity24h: number | null;
  autopilotHaltReason: string | null;
  latestTxCreatedAt: string | null;
  /**
   * review_queue rows with resolved=1 but no recorded resolution_kind (the
   * 2026-08-09 production bug: 738 filings resolved with zero live
   * transactions and no reason recorded anywhere on the row). See migration
   * 0082 and autopilot.ts resolveEmptyDoc.
   */
  dishonestResolutionCount: number | null;
  /**
   * filings.ingest_status='needs_review' with no open (resolved=0)
   * review_queue row — the queue/filing desync that made the review UI
   * report "all done" while filings sat unreviewed (180 filings in the same
   * production incident).
   */
  orphanedNeedsReviewCount: number | null;
  /**
   * Filings sitting in a non-terminal ingest_status well past every
   * stage-specific retry window (autonomySweeps.ts's stranded-sweep
   * threshold), i.e. rows the periodic sweep is *about* to terminalize on
   * its next run but hasn't yet. Never null when collected — a query error
   * fails open to 0 rather than surfacing as 'unknown', since an operator
   * would otherwise see a permanent 'unknown' between hourly sweeps.
   * Excludes provider-missing-% placeholder rows (working as designed) and
   * anything already review-resolved.
   */
  strandedFilings: number | null;
  /**
   * Per-chamber polling liveness (owner directive 2026-08-10: polling can
   * never be silently off for any chamber). lastSuccessAt/lastAttemptAt come
   * from source_attempts (executive also max'd with the KV last_poll:oge
   * checkpoint so the check works for history recorded before executive
   * wrote source_attempts rows). configDisabled reflects the chamber's
   * enable gate (currently only executive has one: OGE_WATCH_ENABLED).
   */
  pollSources: Array<{
    source: 'house' | 'senate' | 'executive';
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    configDisabled: boolean;
  }> | null;
  /**
   * Latency-probe liveness (same directive): newest observation per provider
   * from trade_provider_observations. Empty array = probes have never
   * recorded anything (loud), null = uncollected.
   *
   * `expected` marks providers the current config intends to probe
   * (DISCLOSURE_LATENCY_PROVIDERS ∩ watch/FMP switches ∩ membership keys —
   * see expectedLatencyProviderIds). expected=false rows are retired: shown
   * in details, never paged. Absent = expected, so signal builders that
   * predate the flag keep the old always-page behavior. lastObservedAt null
   * = expected but never observed (just-enabled provider) — counts silent.
   */
  latencyProviders: Array<{ provider: string; lastObservedAt: string | null; expected?: boolean }> | null;
  /**
   * Named-tunnel Senate relay liveness (issue #1604).  configured reflects
   * SENATE_RELAY_URL; probe is the last GET /health written by the watcher
   * or GET /api/health/senate-relay.  Missing probe is unknown, not silent.
   */
  senateRelay: {
    configured: boolean;
    probe: {
      ok: boolean;
      status: number | null;
      checkedAt: string;
      host?: string;
    } | null;
  } | null;
  /** True when a residential proxy is configured (retires the legacy scout relay). */
  residentialProxyConfigured?: boolean;
  /** Residential proxy GET /health probe (CONFIG_KV), when explicitly configured. */
  residentialProxy?: {
    configured: boolean;
    probe: {
      ok: boolean;
      status: number | null;
      checkedAt: string;
      host?: string;
    } | null;
  } | null;
  /**
   * Newest daily price bar we hold for any ticker (MAX securities_ref.latest_price_date,
   * an indexed column — price_eod itself is 1.4M rows).  Absent = the signal builder
   * predates this check (skipped); null = collection failed or no prices at all (unknown).
   */
  priceEodLatestDate?: string | null;
  /** Newest S&P 500 daily bar (MAX spx_eod.date).  Same absent/null semantics. */
  spxEodLatestDate?: string | null;
}

export interface PipelineThresholds {
  outboxAgeMinutes: number; // default 90
  /** Unused: any unresolved review item is unhealthy (Jay 2026-08-17). */
  reviewBacklogWarn: number;
  txAgeHours: number; // default 96 (weekend/recess slack)
  strandedFilingsWarn: number; // default 1 (any is worth a look; sweep clears them hourly)
  /** Max hours since last successful poll before a chamber is stalled. */
  pollSuccessMaxAgeHours: { house: number; senate: number; executive: number };
  /**
   * Optional override of the shipped 0.75h weekday / 1.5h weekend session cap.
   * `pollMaxAgeHours` also widens the cap to honor a *legally slower* coverage
   * floor (e.g. PROBE_SCHEDULE_MAX_INTERVAL_SEC=3600) by one missed slot
   * (1.5x the longest allocated gap), so a slower but still legal poll is not
   * permanently stalled. `pollSuccessMaxAgeHours[src]` therefore binds only
   * when it is itself at least one missed slot long; a per-source ceiling
   * shorter than the missed-slot extension does not cap below the missed slot.
   * Both fields default to the shipped constants when omitted, so existing
   * callers do not change.
   */
  weekdayPollMaxAgeHours?: number;
  weekendPollMaxAgeHours?: number;
  /** Max hours since the newest provider latency observation, system-wide. */
  latencyObservationMaxAgeHours: number;
  /** Hours of silence before an individual recently-active provider is flagged. */
  latencyProviderSilenceHours: number;
  /** Max minutes since the last Senate-relay /health probe before the check goes stale. */
  senateRelayProbeMaxAgeMinutes: number;
  /** Max trading days the newest price/S&P bar may lag before price_freshness degrades (default 3). */
  priceMaxAgeTradingDays?: number;
  /**
   * Critical / phone-page tier for price_freshness. Newest bar more than this
   * many trading days behind escalates from degraded → critical (Pushover
   * priority 1 via the liveness-alarm sweep). Default 14. Tuned so a long
   * weekend or 1-week outage degrades but doesn't page, while a structural
   * break (lost FMP key, expired plan, disabled lane) does.
   */
  priceMaxAgeCriticalDays?: number;
  /**
   * Stalled tier for price_freshness. Newest bar more than this many trading
   * days behind escalates critical → stalled. Default 30 — at this point the
   * price refresh lane is structurally broken, not just stuck on a single
   * provider 4xx.
   */
  priceMaxAgeStalledDays?: number;
}

export const DEFAULT_PIPELINE_THRESHOLDS: PipelineThresholds = {
  outboxAgeMinutes: 90,
  reviewBacklogWarn: 25,
  txAgeHours: 96,
  strandedFilingsWarn: 1,
  // House/Senate poll on the minutely watcher cadence, so 6h of no success was
  // already generous — ~240 consecutive failed cycles. The 2026-08-11 Senate
  // outage showed 6h is still too slow for a source that publishes daily: the
  // owner learned of it from a phone alert a day in. 3h is ~120 failed cycles,
  // still far past any transient blip, and halves the worst-case blind window.
  // Safe against quiet days: liveness records a *poll* success, not a filing —
  // a poll that returns zero rows still counts (see recordProbeOutcome, where
  // kind:'success' is independent of fetchedRows).
  // Executive follows the same adaptive probeSchedule as House/Senate
  // (weekday coverage floor 15 min; weekend hourly). last_poll advances on
  // empty success, so a working poller never looks stale. The 26h window is
  // slack for a disabled/broken executive path, not the poll interval.
  // Config ceiling. evaluatePipelineSignals also caps these by session:
  // 45 minutes on a weekday (the poll floor is at most 30 minutes) and 90
  // minutes on a weekend (the weekend budget is hourly). A 3 hour / 26 hour
  // ceiling hid a multi-hour SQLITE_BUSY wedge.
  pollSuccessMaxAgeHours: { house: 3, senate: 3, executive: 26 },
  latencyObservationMaxAgeHours: 24,
  latencyProviderSilenceHours: 48,
  senateRelayProbeMaxAgeMinutes: 20,
  priceMaxAgeTradingDays: 3,
  // Critical: a week+ stale price cache is worth waking the owner up for —
  // the daily market-data lane has now failed on TWO consecutive attempts
  // (one stamp-on-success, one stamp-before). At that point the fix is a
  // provider key rotation, not a "wait and see".
  priceMaxAgeCriticalDays: 14,
  // Stalled: a month+ stale cache is the prod 2026-09-20 baseline.
  priceMaxAgeStalledDays: 30,
};

/**
 * Weekdays strictly between `latestIso` (a YYYY-MM-DD bar date) and today (UTC).
 * Today itself is excluded because today's bar does not exist until after the
 * close, so a Friday bar read on Monday is 0 trading days behind and read on
 * Tuesday is 1.  Holidays are not modelled (a holiday adds at most one day of
 * slack, well inside the threshold).  Returns null for an unparseable date.
 */
export function tradingDaysBehind(latestIso: string, nowMs: number): number | null {
  const latest = Date.parse(`${latestIso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(latest)) return null;
  const today = Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate(),
  );
  let count = 0;
  for (let d = latest + 86_400_000; d < today; d += 86_400_000) {
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) count += 1;
  }
  return count;
}

const STATUS_WEIGHT: Record<PipelineStatus, number> = {
  ok: 0,
  unknown: 1,
  degraded: 2,
  critical: 3,
  stalled: 4,
};

function worstStatus(a: PipelineStatus, b: PipelineStatus): PipelineStatus {
  return STATUS_WEIGHT[a] >= STATUS_WEIGHT[b] ? a : b;
}

/**
 * Session caps for the polling liveness check.
 *
 * At the SHIPPED probe-schedule floors (30 min weekday / 60 min weekend globally,
 * 15 min weekday for executive via its profile floor), 45 minutes is one missed
 * slot on a weekday and 90 minutes is one missed slot on a weekend. A legally
 * SLOWER coverage floor (e.g. PROBE_SCHEDULE_MAX_INTERVAL_SEC=3600 on a weekday)
 * widens the cap to 1.5x the longest allocated gap so a healthy, slower poll is
 * not falsely stalled — without ever reopening the 3h/26h per-source ceilings
 * that hid the multi-hour SQLITE_BUSY wedge this PR exists to close.
 */
const DEFAULT_WEEKDAY_POLL_MAX_AGE_HOURS = 0.75;
const DEFAULT_WEEKEND_POLL_MAX_AGE_HOURS = 1.5;

const Http429NonNegFiniteNumber = z.number().refine(
  (n) => Number.isFinite(n) && n >= 0,
  'must be a finite nonnegative number',
);

/**
 * Shape of an `fmp-latency:http429:` KV value (boundary data — validated, not
 * asserted).  markFmpSlotHttp429 stores the raw flag text "1"; a parsed
 * number is a valid marker (JSON.parse of "1" yields the number 1, not a
 * string).  The legacy writer shape `{count: n}` is also accepted.  Anything
 * else is rejected by the reader.  Numeric inputs normalize to `{count: n}`
 * so the reader can read a single field.
 */
export const Http429ValueSchema = z.union([
  Http429NonNegFiniteNumber.transform((n) => ({ count: n })),
  z.string(),
  z.object({ count: Http429NonNegFiniteNumber }).strict(),
]);

/**
 * Resolve the longest legal gap (in hours) for `src` and the ET day type that
 * `etClock(new Date(nowMs))` reports, via the same allocateProbes() the
 * scheduler uses. Returns the *shipped* floor when allocation is at-or-tighter
 * than it, so the default schedule produces the original 0.5h / 1h gaps.
 */
function longestGapHours(
  src: 'house' | 'senate' | 'executive',
  nowMs: number,
  schedule: ProbeScheduleConfig,
): { longestGapHours: number; dayType: 'weekday' | 'weekend' } {
  const dayType = dayTypeFor(etClock(new Date(nowMs)).dayOfWeekET);
  const profile = schedule.profiles[src];
  const allocation = allocateProbes(profile, dayType, schedule);
  return { longestGapHours: allocation.troughIntervalSec / 3600, dayType };
}

/**
 * Effective max-age (hours) below which a chamber's last successful poll is
 * still considered live. The shipped session caps are 0.75h weekday / 1.5h
 * weekend; `pollSuccessMaxAgeHours[src]` is the absolute ceiling the operator
 * can raise; and a legally slower coverage floor (e.g.
 * PROBE_SCHEDULE_MAX_INTERVAL_SEC=3600) widens the cap to 1.5x the longest
 * allocated gap so a healthy slower poll is not falsely stalled — without
 * ever restoring the 3h/26h ceilings this PR exists to close.
 */
function pollMaxAgeHours(
  src: 'house' | 'senate' | 'executive',
  nowMs: number,
  configured: PipelineThresholds,
  schedule: ProbeScheduleConfig = DEFAULT_PROBE_SCHEDULE_CONFIG,
): number {
  const { longestGapHours: gapHours, dayType } = longestGapHours(src, nowMs, schedule);
  const sessionCap = dayType === 'weekend'
    ? (configured.weekendPollMaxAgeHours ?? DEFAULT_WEEKEND_POLL_MAX_AGE_HOURS)
    : (configured.weekdayPollMaxAgeHours ?? DEFAULT_WEEKDAY_POLL_MAX_AGE_HOURS);
  const missedSlotHours = gapHours * 1.5;
  const configuredCeiling = configured.pollSuccessMaxAgeHours[src];
  const sessionOrMissed = Math.max(sessionCap, missedSlotHours);
  // Monotonic in configuredCeiling: honor a tighter operator ceiling and widen
  // for a legally slower schedule, but never below one missed slot (see
  // PipelineThresholds doc).
  return Math.max(missedSlotHours, Math.min(configuredCeiling, sessionOrMissed));
}

/**
 * Pure, clock-injected evaluator for pipeline signals.
 *
 * `schedule` is optional: omitting it behaves as DEFAULT_PROBE_SCHEDULE_CONFIG
 * (the shipped 30/60-minute coverage floors + 15-minute executive weekday
 * floor), which is what tests that don't care about a probe retune want. The
 * production call passes `probeScheduleConfigFromEnv(env)` so a retuned
 * coverage floor widens the poll cap to one missed slot instead of falsely
 * stalling a healthy slower poll.
 */
export function evaluatePipelineSignals(
  s: PipelineSignals,
  nowMs: number,
  t = DEFAULT_PIPELINE_THRESHOLDS,
  schedule: ProbeScheduleConfig = DEFAULT_PROBE_SCHEDULE_CONFIG,
): PipelineHealth {
  const checks: PipelineCheck[] = [];
  let overall: PipelineStatus = 'ok';

  // 1. Ingestion backlog age
  if (s.outboxPending === null) {
    checks.push({ id: 'ingestion_backlog', status: 'unknown', detail: 'Outbox pending status uncollected', value: null });
  } else if (s.outboxPending > 0) {
    if (s.outboxOldestAt === null) {
      checks.push({ id: 'ingestion_backlog', status: 'unknown', detail: 'Outbox pending timestamp uncollected', value: s.outboxPending });
    } else {
      const oldestMs = Date.parse(s.outboxOldestAt);
      const ageMinutes = !isNaN(oldestMs) ? (nowMs - oldestMs) / (60 * 1000) : 0;
      if (ageMinutes > t.outboxAgeMinutes) {
        checks.push({
          id: 'ingestion_backlog',
          status: 'stalled',
          detail: `${s.outboxPending} outbox items pending, oldest ${Math.round(ageMinutes)}m old (limit ${t.outboxAgeMinutes}m)`,
          value: s.outboxPending,
        });
      } else {
        checks.push({
          id: 'ingestion_backlog',
          status: 'ok',
          detail: `${s.outboxPending} outbox items pending (${Math.round(ageMinutes)}m old)`,
          value: s.outboxPending,
        });
      }
    }
  } else {
    checks.push({ id: 'ingestion_backlog', status: 'ok', detail: 'Outbox backlog clear', value: 0 });
  }

  // 2. Ingestion dead letter.  Parked rows (`parked:`) are intentionally
  // triaged; every other failed row degrades until requeued or parked.
  // Fresh (24h) is surfaced in detail so a new stall is obvious beside a
  // saturated DLQ (#2182) without going green merely because rows are old.
  if (s.outboxFailed === null) {
    checks.push({ id: 'ingestion_dead_letter', status: 'unknown', detail: 'Outbox failure count uncollected', value: null });
  } else {
    const parked = Math.max(0, s.outboxFailed - (s.outboxFailedActive ?? s.outboxFailed));
    const active = s.outboxFailedActive ?? Math.max(0, s.outboxFailed - parked);
    const fresh = s.outboxFailedFresh ?? 0;
    if (active > 0) {
      checks.push({
        id: 'ingestion_dead_letter',
        status: 'degraded',
        detail: `${active} active failed outbox item(s)` +
          (fresh > 0 ? ` (${fresh} fresh in 24h` + (parked > 0 ? `; ${parked} parked)` : ')') : parked > 0 ? ` (${parked} parked)` : ''),
        value: active,
      });
    } else if (s.outboxFailed > 0) {
      checks.push({
        id: 'ingestion_dead_letter',
        status: 'ok',
        detail: `${s.outboxFailed} parked dead-letter item(s)`,
        value: 0,
      });
    } else {
      checks.push({ id: 'ingestion_dead_letter', status: 'ok', detail: 'No failed outbox items', value: 0 });
    }
  }

  // 3. Extraction provider success rate
  if (s.extractionAttempts24h === null || s.extractionOk24h === null) {
    checks.push({ id: 'extraction_provider', status: 'unknown', detail: 'Extraction run telemetry uncollected', value: null });
  } else if (s.extractionAttempts24h > 0) {
    const okRate = s.extractionOk24h / s.extractionAttempts24h;
    if (s.extractionOk24h === 0) {
      checks.push({
        id: 'extraction_provider',
        status: 'stalled',
        detail: `0/${s.extractionAttempts24h} extraction attempts succeeded in last 24h`,
        value: s.extractionAttempts24h,
      });
    } else if (okRate < 0.5) {
      checks.push({
        id: 'extraction_provider',
        status: 'degraded',
        detail: `Low extraction success rate: ${s.extractionOk24h}/${s.extractionAttempts24h} (${Math.round(okRate * 100)}%) in 24h`,
        value: s.extractionAttempts24h,
      });
    } else {
      checks.push({
        id: 'extraction_provider',
        status: 'ok',
        detail: `Extraction success rate ${s.extractionOk24h}/${s.extractionAttempts24h} in 24h`,
        value: s.extractionAttempts24h,
      });
    }
  } else {
    const halted = Boolean(s.autopilotHaltReason);
    const backlog = s.reviewBacklog ?? 0;
    const localActive = (s.localWorkerActivity24h ?? 0) > 0;
    if (halted || (backlog > 0 && !localActive)) {
      checks.push({
        id: 'extraction_provider',
        status: 'stalled',
        detail: halted
          ? `No extraction attempts in 24h while autopilot is halted (${s.autopilotHaltReason})`
          : `No extraction attempts in 24h while review backlog is ${backlog}`,
        value: 0,
      });
    } else if (localActive && backlog > 0) {
      // The Mac/server local-vision workers publish scans without writing
      // extraction_runs; a busy local drain with backlog is activity, not a
      // stall — but still degraded while provider extractors stay idle.
      checks.push({
        id: 'extraction_provider',
        status: 'degraded',
        detail: `No provider extraction runs in 24h; local vision worker active (${s.localWorkerActivity24h} submissions) while review backlog is ${backlog}`,
        value: s.localWorkerActivity24h ?? 0,
      });
    } else if (localActive) {
      // Local workers cleared the backlog; provider idle is healthy.
      checks.push({
        id: 'extraction_provider',
        status: 'ok',
        detail: `No provider extraction runs in 24h; local vision worker active (${s.localWorkerActivity24h} submissions) and review backlog clear`,
        value: s.localWorkerActivity24h ?? 0,
      });
    } else {
      const weekdayEt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short',
      }).format(new Date(nowMs));
      const isWeekend = weekdayEt === 'Sat' || weekdayEt === 'Sun';
      checks.push({
        id: 'extraction_provider',
        status: 'ok',
        detail: isWeekend
          ? 'No extraction attempts in 24h (expected on weekend)'
          : 'No extraction attempts in 24h',
        value: 0
      });
    }
  }

  // 4. Filing skips (extract_empty_failure / auto_resolved_empty / doc_quarantined).
  // Owner 2026-09-21 ask: "big red flag ... anytime a filing is skipped or
  // considered empty or blank or unreadable since that is almost always
  // false and app error." These three outcomes are the "almost always an
  // app error" set: real blank filings are vanishingly rare (the docs are
  // PDFs from official sources). Default threshold is 0 (page on the first
  // occurrence); tunable via CT_FILING_SKIP_THRESHOLD_24H for owners who
  // want a small noise floor.
  // Env access is guarded so vitest (Node) tests don't ReferenceError on Deno.
  const envGet = (k: string): string | undefined => {
    try { return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(k); }
    catch { return undefined; }
  };
  if (s.filingSkips24h != null) {
    const threshold = (() => {
      const n = Number.parseInt(envGet('CT_FILING_SKIP_THRESHOLD_24H') || '', 10);
      return Number.isFinite(n) && n >= 0 ? Math.min(n, 100) : 0;
    })();
    if (s.filingSkips24h > threshold) {
      const byAction: Partial<Record<'extract_empty_failure' | 'auto_resolved_empty' | 'doc_quarantined', number>> =
        s.filingSkipsByAction24h ?? {};
      const breakdown = Object.entries(byAction)
        .filter(([, v]) => typeof v === 'number' && v > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || 'unknown';
      checks.push({
        id: 'filing_skips',
        status: 'critical',
        detail: `${s.filingSkips24h} filing(s) extract-produced-empty/blank/unreadable in last 24h (threshold ${threshold}; ${breakdown}). Almost always an app error — investigate the underlying OCR/vision/model failure.`,
        value: { total: s.filingSkips24h, byAction, threshold },
      });
    } else {
      checks.push({
        id: 'filing_skips',
        status: 'ok',
        detail: `${s.filingSkips24h} filing skips in 24h (threshold ${threshold})`,
        value: { total: s.filingSkips24h, byAction: s.filingSkipsByAction24h, threshold },
      });
    }
  } else {
    checks.push({ id: 'filing_skips', status: 'unknown', detail: 'Filing skip telemetry uncollected', value: null });
  }

  // 5. FMP latency (admin + user-visible).
  // Owner 2026-09-21 ask: FMP latency data should be shown for admin AND
  // users. This surfaces trade_provider_observations summary + 24h HTTP
  // 429 count so a free-tier key rotation problem is visible BEFORE FMP
  // starts returning 401/403 (which would silently stall the price refresh
  // lane — the 2026-09-20 outage class).
  if (s.fmpLatency != null) {
    const ageSec = s.fmpLatency.lastObservationAgeSec;
    const count = s.fmpLatency.observationCount24h;
    const f429 = s.fmpLatency.http429s24h;
    const probeExpected = (() => {
      const on = envGet('FMP_LATENCY_PROBE_ENABLED');
      return on !== 'false' && on !== '0';
    })();
    const isCritical = probeExpected && (ageSec == null || ageSec > 3 * 3600 || (count ?? 0) === 0);
    const isDegraded = !isCritical && (ageSec == null || ageSec > 3600 || (f429 ?? 0) > 5);
    const tier: PipelineStatus = isCritical ? 'critical' : isDegraded ? 'degraded' : 'ok';
    const detail = isCritical
      ? `FMP latency probe silent for ${ageSec != null ? Math.round(ageSec / 60) + ' min' : 'no observation in 48h'} (${count ?? 0} obs/24h). Observations are not committing.  Check SQLITE_BUSY / WAL checkpoint before rotating FMP_LATENCY_API_KEY.`
      : isDegraded
        ? `FMP latency probe lagging (last age ${ageSec != null ? Math.round(ageSec / 60) + ' min' : 'unknown'}, ${f429 ?? 0} HTTP 429s in 24h).`
        : `FMP latency probe live (last observation ${ageSec != null ? Math.round(ageSec / 60) + ' min ago' : 'unknown'}, ${count ?? 0} obs in 24h, ${f429 ?? 0} 429s).`;
    checks.push({
      id: 'fmp_latency',
      status: tier,
      detail,
      value: {
        observationCount24h: count,
        lastObservationAt: s.fmpLatency.lastObservationAt,
        lastObservationAgeSec: ageSec,
        http429s24h: f429,
        byProvider: s.fmpLatency.byProvider,
      },
    });
  } else {
    checks.push({ id: 'fmp_latency', status: 'unknown', detail: 'FMP latency telemetry uncollected', value: null });
  }

  // 6. Review queue backlog — ANY unresolved human-review item is unhealthy.
  if (s.reviewBacklog === null) {
    checks.push({ id: 'extraction_backlog', status: 'unknown', detail: 'Review backlog uncollected', value: null });
  } else if (s.reviewBacklog > 0) {
    const counts: ReviewQueueHealthCounts = {
      unresolved: s.reviewBacklog,
      eligible: s.reviewEligible ?? 0,
      suppressed: s.reviewSuppressed ?? 0,
      terminal: s.reviewTerminal ?? 0,
    };
    const eligible = s.reviewEligible ?? 0;
    checks.push({
      id: 'extraction_backlog',
      status: eligible > 0 ? 'stalled' : 'degraded',
      detail: formatReviewQueueHealthDetail(counts),
      value: s.reviewBacklog,
    });
  } else {
    checks.push({
      id: 'extraction_backlog',
      status: 'ok',
      detail: 'No unresolved human-review items',
      value: 0,
    });
  }

  // 5. Autopilot halt
  if (s.autopilotHaltReason !== null) {
    checks.push({
      id: 'autopilot_halt',
      status: 'stalled',
      detail: `Autopilot runs halted: ${s.autopilotHaltReason}`,
      value: 1,
    });
  } else {
    checks.push({ id: 'autopilot_halt', status: 'ok', detail: 'Autopilot unhalted', value: 0 });
  }

  // 6. Data freshness
  if (s.latestTxCreatedAt === null) {
    checks.push({ id: 'data_freshness', status: 'unknown', detail: 'Latest transaction timestamp uncollected', value: null });
  } else {
    const latestMs = Date.parse(s.latestTxCreatedAt);
    const ageHours = !isNaN(latestMs) ? (nowMs - latestMs) / (3600 * 1000) : 0;
    if (ageHours > t.txAgeHours) {
      checks.push({
        id: 'data_freshness',
        status: 'degraded',
        detail: `Latest transaction is ${Math.round(ageHours)}h old (threshold ${t.txAgeHours}h)`,
        value: Math.round(ageHours),
      });
    } else {
      checks.push({
        id: 'data_freshness',
        status: 'ok',
        detail: `Data fresh: latest transaction ${Math.round(ageHours)}h ago`,
        value: Math.round(ageHours),
      });
    }
  }

  // 7. Review-queue resolution honesty (queue/filing consistency). Catches
  // both directions of the 2026-08-09 production bug: resolved=1 rows with
  // no recorded resolution reason (silently "done" with nothing to show for
  // it), and needs_review filings with no open queue row (the review UI
  // reporting "all done" while filings sat unreviewed). See migration 0082.
  if (s.dishonestResolutionCount === null || s.orphanedNeedsReviewCount === null) {
    checks.push({
      id: 'review_resolution_integrity',
      status: 'unknown',
      detail: 'Review-queue resolution integrity uncollected',
      value: null,
    });
  } else if (s.dishonestResolutionCount > 0 || s.orphanedNeedsReviewCount > 0) {
    checks.push({
      id: 'review_resolution_integrity',
      status: 'degraded',
      detail: `${s.dishonestResolutionCount} review item(s) resolved with no recorded resolution reason; `
        + `${s.orphanedNeedsReviewCount} filing(s) marked needs_review with no open review-queue row`,
      value: s.dishonestResolutionCount + s.orphanedNeedsReviewCount,
    });
  } else {
    checks.push({
      id: 'review_resolution_integrity',
      status: 'ok',
      detail: 'Review-queue resolutions and filing status are consistent',
      value: 0,
    });
  }

  // 8. Stranded filings (autonomy sweep backstop visibility). A count here
  // means the hourly autonomy-sweeps lane (cronLanes.ts) has, at most, one
  // more hour to run before terminalizing these rows itself — this check
  // exists so an operator (or an alert) sees the backlog immediately rather
  // than only after the sweep already fired, and so a sweep that is itself
  // failing (e.g. a bug, or the lane silently not registered) is caught
  // before rows go stale for days.
  if (s.strandedFilings === null) {
    checks.push({ id: 'stranded_filings', status: 'unknown', detail: 'Stranded-filing count uncollected', value: null });
  } else if (s.strandedFilings >= t.strandedFilingsWarn) {
    checks.push({
      id: 'stranded_filings',
      status: 'degraded',
      detail: `${s.strandedFilings} filing(s) stranded mid-pipeline past the autonomy sweep's retry window`,
      value: s.strandedFilings,
    });
  } else {
    checks.push({ id: 'stranded_filings', status: 'ok', detail: 'No stranded filings', value: 0 });
  }

  // 9-11. Per-chamber polling liveness (owner directive 2026-08-10: polling
  // must NEVER be silently off for any chamber). Born from two real silent
  // outages found the same night: OGE_WATCH_ENABLED sat unset for 5 days
  // (executive polling dead, nothing said so anywhere) and the senate poll
  // 403'd on every cron tick for days behind a console.warn nobody reads.
  // Three distinct loud states per chamber:
  //   - config-disabled  -> stalled ("disabled by config" — a deliberate
  //     gate is still an outage until someone turns it back on)
  //   - attempts fresh but successes stale -> stalled ("polling FAILING" —
  //     the senate-403 class: the watcher runs, the source never lands)
  //   - attempts stale/absent -> stalled ("polling NOT RUNNING" — cron dead,
  //     gate stuck, or the source was never wired to record attempts)
  if (s.pollSources === null) {
    checks.push({ id: 'polling_liveness', status: 'unknown', detail: 'Poll liveness uncollected', value: null });
  } else {
    for (const src of ['house', 'senate', 'executive'] as const) {
      const id = `polling_${src}`;
      const st = s.pollSources.find((p) => p.source === src);
      const maxAgeH = pollMaxAgeHours(src, nowMs, t, schedule);
      if (!st) {
        checks.push({ id, status: 'stalled', detail: `${src} polling NOT RUNNING — no liveness record at all`, value: null });
        continue;
      }
      if (st.configDisabled) {
        checks.push({
          id,
          status: 'stalled',
          detail: `${src} polling DISABLED by config — must never be silent; re-enable or acknowledge loudly`,
          value: null,
        });
        continue;
      }
      const successMs = st.lastSuccessAt ? Date.parse(st.lastSuccessAt) : NaN;
      const attemptMs = st.lastAttemptAt ? Date.parse(st.lastAttemptAt) : NaN;
      const successAgeH = Number.isFinite(successMs) ? (nowMs - successMs) / 3_600_000 : Infinity;
      const attemptAgeH = Number.isFinite(attemptMs) ? (nowMs - attemptMs) / 3_600_000 : Infinity;
      if (successAgeH <= maxAgeH) {
        checks.push({
          id,
          status: 'ok',
          detail: `${src} polling live: last success ${successAgeH < 1 ? Math.round(successAgeH * 60) + 'm' : Math.round(successAgeH) + 'h'} ago`,
          value: Math.round(successAgeH * 10) / 10,
        });
      } else if (attemptAgeH <= maxAgeH) {
        checks.push({
          id,
          status: 'stalled',
          detail: `${src} polling FAILING: attempts are running (last ${Math.round(attemptAgeH)}h ago) but no success in `
            + `${successAgeH === Infinity ? 'ever' : Math.round(successAgeH) + 'h'} (threshold ${maxAgeH}h)`,
          value: successAgeH === Infinity ? null : Math.round(successAgeH),
        });
      } else {
        checks.push({
          id,
          status: 'stalled',
          detail: `${src} polling NOT RUNNING: no attempt in `
            + `${attemptAgeH === Infinity ? 'ever' : Math.round(attemptAgeH) + 'h'} (threshold ${maxAgeH}h)`,
          value: attemptAgeH === Infinity ? null : Math.round(attemptAgeH),
        });
      }
    }
  }

  // 12. Latency-monitoring liveness (same owner directive): the provider
  // latency probes (Quiver/UW/FMP observations that feed the latency
  // scorecard) must never go silently dark. Whole-system silence is stalled;
  // an expected provider gone quiet past the silence threshold is degraded
  // with the provider named. Providers retired in config (expected=false —
  // dropped subscription, DISCLOSURE_LATENCY_PROVIDERS filter, switch off)
  // are listed for context but never page: age alone kept paging retired
  // Quiver/UW for 17 days of UptimeRobot DOWN (2026-08).
  if (s.latencyProviders === null) {
    checks.push({ id: 'latency_probes', status: 'unknown', detail: 'Latency-probe liveness uncollected', value: null });
  } else {
    const expected = s.latencyProviders.filter((p) => p.expected !== false);
    const retired = s.latencyProviders.filter((p) => p.expected === false);
    const retiredNote = retired.length
      ? `; retired in config (not paged): ${retired.map((p) => p.provider).join(', ')}`
      : '';
    if (expected.length === 0) {
      checks.push({
        id: 'latency_probes',
        status: 'stalled',
        detail: s.latencyProviders.length === 0
          ? 'Latency monitoring NOT RUNNING — zero provider observations recorded, ever'
          : `Latency monitoring NOT RUNNING — no provider is enabled in config${retiredNote}`,
        value: null,
      });
    } else {
      let newestMs = -Infinity;
      const silent: string[] = [];
      for (const p of expected) {
        const ms = p.lastObservedAt === null ? NaN : Date.parse(p.lastObservedAt);
        if (!Number.isFinite(ms)) {
          silent.push(`${p.provider} (never observed)`);
          continue;
        }
        if (ms > newestMs) newestMs = ms;
        if ((nowMs - ms) / 3_600_000 > t.latencyProviderSilenceHours) {
          silent.push(`${p.provider} (${Math.round((nowMs - ms) / 3_600_000)}h)`);
        }
      }
      const newestAgeH = newestMs === -Infinity ? Infinity : (nowMs - newestMs) / 3_600_000;
      if (newestAgeH > t.latencyObservationMaxAgeHours) {
        checks.push({
          id: 'latency_probes',
          status: 'stalled',
          detail: `Latency monitoring SILENT: newest expected-provider observation is `
            + `${newestAgeH === Infinity ? 'missing' : Math.round(newestAgeH) + 'h'} old (threshold ${t.latencyObservationMaxAgeHours}h)${retiredNote}`,
          value: newestAgeH === Infinity ? null : Math.round(newestAgeH),
        });
      } else if (silent.length > 0) {
        checks.push({
          id: 'latency_probes',
          status: 'degraded',
          detail: `Latency provider(s) gone quiet: ${silent.join(', ')} (silence threshold ${t.latencyProviderSilenceHours}h)${retiredNote}`,
          value: silent.length,
        });
      } else {
        checks.push({
          id: 'latency_probes',
          status: 'ok',
          detail: `Latency probes live: newest observation ${newestAgeH < 1 ? Math.round(newestAgeH * 60) + 'm' : Math.round(newestAgeH) + 'h'} ago across ${expected.length} provider(s)${retiredNote}`,
          value: expected.length,
        });
      }
    }
  }

  // 13. Senate egress: residential proxy (preferred) or named Senate relay (#1604).
  if (s.residentialProxyConfigured) {
    const rp = s.residentialProxy;
    if (rp == null) {
      checks.push({ id: 'senate_relay', status: 'unknown', detail: 'Residential proxy liveness uncollected', value: null });
    } else if (!rp.configured) {
      checks.push({
        id: 'senate_relay',
        status: 'degraded',
        detail: 'Residential proxy env missing despite configured signal — Senate/House egress may use datacenter IP',
        value: null,
      });
    } else if (!rp.probe) {
      checks.push({
        id: 'senate_relay',
        status: 'unknown',
        detail: 'Residential proxy configured but not yet probed',
        value: null,
      });
    } else {
      const probe = rp.probe;
      const checkedMs = Date.parse(probe.checkedAt);
      const ageMin = Number.isFinite(checkedMs) ? (nowMs - checkedMs) / 60_000 : Infinity;
      const host = probe.host ?? 'residential-proxy';
      if (!probe.ok) {
        checks.push({
          id: 'senate_relay',
          status: 'stalled',
          detail: `Residential proxy DOWN at ${host}`
            + `${probe.status != null ? ` (HTTP ${probe.status})` : ''}`
            + ' — Senate/House fetches may fail Imperva checks until the proxy is back.',
          value: probe.status,
        });
      } else if (ageMin > t.senateRelayProbeMaxAgeMinutes) {
        checks.push({
          id: 'senate_relay',
          status: 'degraded',
          detail: `Residential proxy probe stale: last ok ${Math.round(ageMin)}m ago at ${host} (threshold ${t.senateRelayProbeMaxAgeMinutes}m)`,
          value: Math.round(ageMin),
        });
      } else {
        checks.push({
          id: 'senate_relay',
          status: 'ok',
          detail: `Residential proxy live at ${host}: probed ${ageMin < 1 ? Math.round(ageMin * 60) + 's' : Math.round(ageMin) + 'm'} ago`,
          value: Math.round(ageMin * 10) / 10,
        });
      }
    }
  } else if (s.senateRelay == null) {
    checks.push({ id: 'senate_relay', status: 'unknown', detail: 'Senate relay liveness uncollected', value: null });
  } else if (!s.senateRelay.configured) {
    checks.push({
      id: 'senate_relay',
      status: 'degraded',
      detail:
        'SENATE_RELAY_URL unset — Senate search/docs use the box egress.  Imperva has 403\'d that datacenter path before; keep a residential always-on host if it returns.',
      value: null,
    });
  } else if (!s.senateRelay.probe) {
    checks.push({
      id: 'senate_relay',
      status: 'unknown',
      detail: 'Senate relay configured but not yet probed',
      value: null,
    });
  } else {
    const probe = s.senateRelay.probe;
    const checkedMs = Date.parse(probe.checkedAt);
    const ageMin = Number.isFinite(checkedMs) ? (nowMs - checkedMs) / 60_000 : Infinity;
    const host = probe.host ?? 'senate-relay';
    if (!probe.ok) {
      checks.push({
        id: 'senate_relay',
        status: 'stalled',
        detail: `Senate relay DOWN at ${host}`
          + `${probe.status != null ? ` (HTTP ${probe.status})` : ''}`
          + ` — Mac origin / named tunnel is unreachable.  Search/docs fall back to direct eFD.`,
        value: probe.status,
      });
    } else if (ageMin > t.senateRelayProbeMaxAgeMinutes) {
      checks.push({
        id: 'senate_relay',
        status: 'degraded',
        detail: `Senate relay probe stale: last ok ${Math.round(ageMin)}m ago at ${host} (threshold ${t.senateRelayProbeMaxAgeMinutes}m)`,
        value: Math.round(ageMin),
      });
    } else {
      checks.push({
        id: 'senate_relay',
        status: 'ok',
        detail: `Senate relay live at ${host}: probed ${ageMin < 1 ? Math.round(ageMin * 60) + 's' : Math.round(ageMin) + 'm'} ago`,
        value: Math.round(ageMin * 10) / 10,
      });
    }
  }

  // Price / S&P cache freshness (board row 6c05e09b). Every "excess vs S&P" figure
  // is current_price against the latest S&P close, so a stalled price cache turns
  // into confidently wrong performance numbers with nothing alerting: prod sat
  // frozen at 2026-08-03 (S&P) / 2026-07-24 (NVDA) for 46 days. 2026-09-20 fix:
  // add a CRITICAL tier beyond a second threshold so the staleness actually
  // pages (via the liveness-alarm sweep), and report the per-leg date so the
  // detail is immediately actionable without a second SQL query.
  //
  // Tier table (trading days behind the latest known bar):
  //   behind <= priceMaxAgeTradingDays (default 3) → ok
  //   behind >  priceMaxAgeTradingDays            → degraded (site still serves,
  //                                                 but excess-vs-S&P numbers are
  //                                                 stale — weekend/recess grace)
  //   behind >  priceMaxAgeCriticalDays (default 14) → critical (a week+ stale;
  //                                                 Pushover via liveness-alarm
  //                                                 sweep; recovery via
  //                                                 POST /admin/recover-pipeline)
  //   behind >  priceMaxAgeStalledDays (default 30) → stalled (a month+ stale
  //                                                 means the price refresh
  //                                                 lane is structurally broken)
  if (s.priceEodLatestDate !== undefined || s.spxEodLatestDate !== undefined) {
    const maxDays = t.priceMaxAgeTradingDays ?? 3;
    const criticalDays = t.priceMaxAgeCriticalDays ?? 14;
    const stalledDays = t.priceMaxAgeStalledDays ?? 30;
    const legs: Array<{ label: string; date: string | null | undefined }> = [
      { label: 'price cache', date: s.priceEodLatestDate },
      { label: 'S&P 500 series', date: s.spxEodLatestDate },
    ];
    const known = legs.filter((l) => l.date !== undefined);
    const stale: string[] = [];
    const legAges: number[] = [];
    let worstBehind = 0;
    let anyUnknown = false;
    for (const l of known) {
      if (l.date === null || l.date === undefined) {
        anyUnknown = true;
        continue;
      }
      const behind = tradingDaysBehind(l.date, nowMs);
      if (behind === null) {
        anyUnknown = true;
        continue;
      }
      legAges.push(behind);
      worstBehind = Math.max(worstBehind, behind);
      if (behind > maxDays) stale.push(`${l.label} newest bar ${l.date.slice(0, 10)} (${behind} trading days behind)`);
    }
    if (stale.length > 0) {
      const tier: 'degraded' | 'critical' | 'stalled' =
        worstBehind > stalledDays ? 'stalled'
          : worstBehind > criticalDays ? 'critical'
          : 'degraded';
      const tierNote =
        tier === 'stalled'
          ? `>${stalledDays}d behind — price refresh lane is structurally broken; recover via POST /admin/recover-pipeline`
          : tier === 'critical'
          ? `>${criticalDays}d behind — Pushover alarm fired; recover via POST /admin/recover-pipeline`
          : `>${maxDays}d threshold; excess-vs-S&P and current prices are stale`;
      checks.push({
        id: 'price_freshness',
        status: tier,
        detail: `${stale.join('; ')}; ${tierNote}`,
        value: { worstBehind, legs: Object.fromEntries(legs.map((l, i) => [l.label, { date: l.date, behind: legAges[i] ?? null }])) },
      });
    } else if (anyUnknown) {
      checks.push({ id: 'price_freshness', status: 'unknown', detail: 'Price cache freshness uncollected', value: null });
    } else {
      checks.push({
        id: 'price_freshness',
        status: 'ok',
        detail: `Price and S&P series within ${maxDays} trading days (worst ${worstBehind})`,
        value: { worstBehind, legs: Object.fromEntries(legs.map((l, i) => [l.label, { date: l.date, behind: legAges[i] ?? null }])) },
      });
    }
  }

  for (const c of checks) {
    overall = worstStatus(overall, c.status);
  }

  // 2026-09-21: surface the new signals alongside the existing checks so
  // admin / dashboard can render them without re-querying. The structured
  // shape matches PipelineSignals so the field set stays consistent.
  return {
    status: overall,
    checks,
    signals: {
      filingSkips24h: s.filingSkips24h,
      filingSkipsByAction24h: s.filingSkipsByAction24h,
      fmpLatency: s.fmpLatency,
      priceEodLatestDate: s.priceEodLatestDate,
      spxEodLatestDate: s.spxEodLatestDate,
    },
  };
}

/**
 * Collect signals from DB and evaluate health.
 */
export async function checkPipelineHealth(env: Env, now = new Date()): Promise<PipelineHealth> {
  const nowMs = now.getTime();
  const iso24hAgo = new Date(nowMs - 24 * 3600 * 1000).toISOString();
  // 2026-10-04: read the live probe schedule from env so a legally slower
  // coverage floor widens the poll cap to 1.5x the longest allocated gap
  // (one missed slot) instead of falsely stalling a healthy slower poll.
  // The default schedule (30/60-minute floors) keeps the shipped 0.75/1.5h
  // caps, so unset env is a strict no-op vs the previous behavior.
  // Env does not declare the probe-schedule keys.  Same cast as watcher.ts.
  const schedule = probeScheduleConfigFromEnv(env as unknown as Record<string, string | undefined>);

  let outboxPending: number | null = null;
  let outboxOldestAt: string | null = null;
  let outboxFailed: number | null = null;
  let outboxFailedFresh: number | null = null;
  let outboxFailedActive: number | null = null;
  let reviewBacklog: number | null = null;
  let reviewEligible: number | null = null;
  let reviewSuppressed: number | null = null;
  let reviewTerminal: number | null = null;
  let reviewQueue: ReviewQueueHealthCounts | null = null;
  let extractionAttempts24h: number | null = null;
  let extractionOk24h: number | null = null;
  let lastExtractionSuccessAt: string | null = null;
  let localWorkerActivity24h: number | null = null;
  let autopilotHaltReason: string | null = null;
  let latestTxCreatedAt: string | null = null;
  let dishonestResolutionCount: number | null = null;
  let orphanedNeedsReviewCount: number | null = null;
  let strandedFilings: number | null = null;
  let priceEodLatestDate: string | null = null;
  let spxEodLatestDate: string | null = null;
  // 2026-09-21: filing-skips signal (extract_empty_failure / auto_resolved_empty / doc_quarantined).
  let filingSkips24h: number | null = null;
  let filingSkipsByAction24h: PipelineSignals['filingSkipsByAction24h'] = null;
  // 2026-09-21: FMP-family latency surface for admin + user dashboards.
  let fmpLatency: PipelineSignals['fmpLatency'] = null;

  try {
    // securities_ref.latest_price_date is indexed (migration 0043); scanning price_eod (1.4M rows) for MAX(date) is not.
    const res = await get<{ d: string | null }>(env.DB, 'SELECT MAX(latest_price_date) AS d FROM securities_ref');
    priceEodLatestDate = res?.d ?? null;
  } catch {}

  try {
    const res = await get<{ d: string | null }>(env.DB, 'SELECT MAX(date) AS d FROM spx_eod');
    spxEodLatestDate = res?.d ?? null;
  } catch {}

  // 2026-09-21: filing skips in last 24h. Almost always app error (corrupt
  // parse, OCR failure, vision model dead-letter). Real blank filings are
  // vanishingly rare — the docs are PDFs from official sources.
  try {
    const res = await get<{ extract_empty_failure: number | null; auto_resolved_empty: number | null; doc_quarantined: number | null }>(
      env.DB,
      `SELECT
         SUM(CASE WHEN action = 'extract_empty_failure' THEN 1 ELSE 0 END) AS extract_empty_failure,
         SUM(CASE WHEN action = 'auto_resolved_empty'   THEN 1 ELSE 0 END) AS auto_resolved_empty,
         SUM(CASE WHEN action = 'doc_quarantined'       THEN 1 ELSE 0 END) AS doc_quarantined
       FROM ingestion_decisions
       WHERE created_at >= ?`,
      [iso24hAgo],
    );
    const ee = Number(res?.extract_empty_failure ?? 0);
    const ar = Number(res?.auto_resolved_empty ?? 0);
    const dq = Number(res?.doc_quarantined ?? 0);
    filingSkips24h = ee + ar + dq;
    filingSkipsByAction24h = {
      extract_empty_failure: ee,
      auto_resolved_empty: ar,
      doc_quarantined: dq,
    };
  } catch {}

  // 2026-09-21: FMP-family latency. Two parts: trade_provider_observations
  // gives us the per-provider last-observation age (the latency scoreboard
  // data); fmp-latency:http429:keyN KV keys count 24h 429s. Both are cheap.
  try {
    const provRows = await all<{
      provider: string;
      last_observed_at: string | null;
      count24h: number | null;
    }>(
      env.DB,
      `SELECT provider,
              MAX(last_observed_at) AS last_observed_at,
              SUM(CASE WHEN last_observed_at >= ? THEN 1 ELSE 0 END) AS count24h
         FROM trade_provider_observations
        WHERE last_observed_at IS NOT NULL AND last_observed_at >= ?
        GROUP BY provider`,
      [iso24hAgo, new Date(nowMs - 48 * 3600 * 1000).toISOString()],
    );
    let lastObservationAt: string | null = null;
    let observationCount24h = 0;
    const byProvider: NonNullable<PipelineSignals['fmpLatency']>['byProvider'] = {};
    for (const r of provRows) {
      const ageMs = r.last_observed_at ? nowMs - Date.parse(r.last_observed_at) : null;
      byProvider[r.provider] = {
        lastObservationAt: r.last_observed_at,
        ageSec: ageMs != null && Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 1000)) : null,
        count24h: r.count24h != null ? Number(r.count24h) : null,
      };
      if (r.last_observed_at && (!lastObservationAt || Date.parse(r.last_observed_at) > Date.parse(lastObservationAt))) {
        lastObservationAt = r.last_observed_at;
      }
      observationCount24h += r.count24h != null ? Number(r.count24h) : 0;
    }
    const lastAgeMs = lastObservationAt ? nowMs - Date.parse(lastObservationAt) : null;
    fmpLatency = {
      observationCount24h,
      lastObservationAt,
      lastObservationAgeSec: lastAgeMs != null && Number.isFinite(lastAgeMs) ? Math.max(0, Math.round(lastAgeMs / 1000)) : null,
      http429s24h: null, // populated below from KV
      byProvider,
    };
  } catch {}

  // 2026-09-21: count 24h 429s across both FMP latency slots. Cheaper to read
  // than to maintain a separate counter on every probe — keys auto-expire
  // after 48h anyway (see tradeLatency.ts:644-686 for the key shape).
  try {
    const kvList = await env.CONFIG_KV.list({ prefix: 'fmp-latency:http429:key' });
    let total = 0;
    for (const k of kvList.keys) {
      // Read as text first: markFmpSlotHttp429 stores the raw flag "1", and a
      // 'json' read of that flag returns the number 1 (no throw), whose .count
      // is undefined — the old catch fallback was unreachable and the counter
      // silently summed 0 for every key.
      let raw: string | null = null;
      try {
        raw = await env.CONFIG_KV.get(k.name);
      } catch {
        raw = null;
      }
      if (raw == null) continue;
      let value: unknown = raw;
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
      const parsed = Http429ValueSchema.safeParse(value);
      if (!parsed.success) continue; // malformed value: reject, don't coerce
      const v = parsed.data;
      const n = typeof v === 'string' ? Number(v) : v.count;
      if (Number.isFinite(n) && n > 0) total += n;
    }
    if (fmpLatency) fmpLatency.http429s24h = total;
  } catch {}

  try {
    const res = await get<{ n: number; oldest: string | null }>(
      env.DB,
      "SELECT COUNT(*) AS n, MIN(available_at) AS oldest FROM ingestion_outbox WHERE status IN ('pending', 'sending')",
    );
    if (res) {
      outboxPending = Number(res.n ?? 0);
      outboxOldestAt = res.oldest ?? null;
    }
  } catch {}

  try {
    const res = await get<{ n: number; fresh: number; active: number }>(
      env.DB,
      `SELECT COUNT(*) AS n,
              SUM(CASE
                    WHEN COALESCE(last_error, '') LIKE 'parked:%' THEN 0
                    ELSE 1
                  END) AS active,
              SUM(CASE
                    WHEN COALESCE(last_error, '') LIKE 'parked:%' THEN 0
                    WHEN updated_at IS NOT NULL AND updated_at >= ? THEN 1
                    ELSE 0
                  END) AS fresh
         FROM ingestion_outbox WHERE status = 'failed'`,
      [iso24hAgo],
    );
    if (res) {
      outboxFailed = Number(res.n ?? 0);
      outboxFailedActive = Number(res.active ?? 0);
      outboxFailedFresh = Number(res.fresh ?? 0);
    }
  } catch {}

  try {
    const res = await get<{ attempts: number; ok_count: number; last_success: string | null }>(
      env.DB,
      'SELECT COUNT(*) AS attempts, SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok_count, MAX(CASE WHEN ok = 1 THEN created_at END) AS last_success FROM extraction_runs WHERE created_at >= ?',
      [iso24hAgo],
    );
    if (res) {
      extractionAttempts24h = Number(res.attempts ?? 0);
      extractionOk24h = Number(res.ok_count ?? 0);
      lastExtractionSuccessAt = res.last_success ?? null;
    }
  } catch {}

  try {
    const res = await get<{ n: number }>(
      env.DB,
      `SELECT COUNT(*) AS n FROM ingestion_decisions
        WHERE source = 'local_mac' AND created_at >= ?`,
      [iso24hAgo],
    );
    if (res) localWorkerActivity24h = Number(res.n ?? 0);
  } catch {}

  try {
    reviewQueue = await countReviewQueueBuckets(env);
    if (reviewQueue) {
      reviewBacklog = reviewQueue.unresolved;
      reviewEligible = reviewQueue.eligible;
      reviewSuppressed = reviewQueue.suppressed;
      reviewTerminal = reviewQueue.terminal;
    }
  } catch {}

  try {
    const res = await get<{ halt_reason: string; sample_errors: string | null }>(
      env.DB,
      "SELECT halt_reason, sample_errors FROM autopilot_runs WHERE status = 'halted' ORDER BY started_at DESC LIMIT 1",
    );
    autopilotHaltReason = describeAutopilotHaltReason(
      res?.halt_reason ?? null,
      res?.sample_errors ?? null,
    );
  } catch {}

  try {
    const res = await get<{ created_at: string }>(
      env.DB,
      'SELECT created_at FROM transactions WHERE cursor_seq = (SELECT MAX(cursor_seq) FROM transactions)',
    );
    latestTxCreatedAt = res?.created_at ?? null;
  } catch {}

  try {
    const res = await get<{ n: number }>(
      env.DB,
      "SELECT COUNT(*) AS n FROM review_queue WHERE resolved = 1 AND resolution_kind IS NULL",
    );
    if (res) dishonestResolutionCount = Number(res.n ?? 0);
  } catch {}

  try {
    const res = await get<{ n: number }>(
      env.DB,
      `SELECT COUNT(*) AS n
         FROM filings f
        WHERE f.ingest_status = 'needs_review'
          AND f.doc_id NOT LIKE 'provider-missing-%'
          AND NOT EXISTS (
            SELECT 1 FROM review_queue rq WHERE rq.doc_id = f.doc_id AND rq.resolved = 0
          )`,
    );
    if (res) orphanedNeedsReviewCount = Number(res.n ?? 0);
  } catch {}

  try {
    // Mirrors autonomySweeps.ts's own eligibility windows (24h ceiling for
    // extraction_pending_local, 10d ceiling for any other mid-pipeline
    // status) — a non-zero count here means the hourly autonomy-sweeps lane
    // has work queued for its next pass. Excludes provider-missing-%
    // placeholders. Review-resolved rows are counted SEPARATELY below
    // (resolvedStatusDesync) rather than excluded outright: excluding them here
    // is what hid the 562-row production desync from this very check.
    const ceilingCutoff = new Date(nowMs - 24 * 3600_000).toISOString();
    const strandedCutoff = new Date(nowMs - 10 * 86_400_000).toISOString();
    const res = await get<{ n: number }>(
      env.DB,
      `SELECT COUNT(*) AS n FROM filings f
        WHERE f.doc_id NOT LIKE 'provider-missing-%'
          AND NOT EXISTS (SELECT 1 FROM review_queue rq WHERE rq.doc_id = f.doc_id AND rq.resolved = 1)
          AND (
            (f.ingest_status = 'extraction_pending_local' AND f.local_wait_expires_at IS NOT NULL AND f.local_wait_expires_at < ?)
            OR (f.ingest_status IN ('new', 'fetched', 'classified', 'extraction_pending_local') AND f.first_seen_at IS NOT NULL AND f.first_seen_at < ?)
          )`,
      [ceilingCutoff, strandedCutoff],
    );
    strandedFilings = Number(res?.n ?? 0);

    // The blind-spot counterpart: filings whose review is resolved but whose
    // ingest_status never got its terminal stamp. These are excluded from
    // every sweep's WHERE clause by design, so without this they are invisible
    // (production had 562 such rows while this check reported healthy).
    const desync = await get<{ n: number }>(
      env.DB,
      `SELECT COUNT(*) AS n FROM filings f
        WHERE f.ingest_status IN ('new','fetched','classified','extraction_pending_local','needs_review')
          AND f.doc_id NOT LIKE 'provider-missing-%'
          AND EXISTS (SELECT 1 FROM review_queue rq WHERE rq.doc_id = f.doc_id AND rq.resolved = 1)`,
    );
    strandedFilings += Number(desync?.n ?? 0);
  } catch {}

  // Poll liveness: last attempt/success per chamber from source_attempts.
  // Executive additionally max'es with the KV last_poll:oge checkpoint
  // (pollExecutive's own success marker, populated long before executive
  // started writing source_attempts rows) and reads its enable gate — a
  // disabled chamber must be LOUD, never a silent skip.
  let pollSources: PipelineSignals['pollSources'] = null;
  try {
    const rows = await all<{ source: string; last_success: string | null; last_attempt: string | null }>(
      env.DB,
      `SELECT source,
              MAX(CASE WHEN outcome = 'success' THEN attempted_at END) AS last_success,
              MAX(attempted_at) AS last_attempt
         FROM source_attempts
        WHERE source IN ('house', 'senate', 'executive')
        GROUP BY source`,
    );
    const bySource = new Map(rows.map((r) => [r.source, r]));
    let ogeDisabled = false;
    let ogeLastPollIso: string | null = null;
    try {
      ogeDisabled = !(await ogeWatchEnabled(env));
    } catch {}
    try {
      const d = await getLastPollAt(env, 'oge');
      ogeLastPollIso = d ? d.toISOString() : null;
    } catch {}
    pollSources = (['house', 'senate', 'executive'] as const).map((source) => {
      const row = bySource.get(source);
      let lastSuccessAt = row?.last_success ?? null;
      let lastAttemptAt = row?.last_attempt ?? null;
      if (source === 'executive' && ogeLastPollIso) {
        if (!lastSuccessAt || ogeLastPollIso > lastSuccessAt) lastSuccessAt = ogeLastPollIso;
        if (!lastAttemptAt || ogeLastPollIso > lastAttemptAt) lastAttemptAt = ogeLastPollIso;
      }
      return {
        source,
        lastSuccessAt,
        lastAttemptAt,
        configDisabled: source === 'executive' ? ogeDisabled : false,
      };
    });
  } catch {}

  let latencyProviders: PipelineSignals['latencyProviders'] = null;
  try {
    const rows = await all<{ provider: string; last_observed: string }>(
      env.DB,
      'SELECT provider, MAX(last_observed_at) AS last_observed FROM trade_provider_observations GROUP BY provider',
    );
    // Config-expected set; null when the resolver itself fails, which leaves
    // every observed row expected (fails open to the old always-page shape).
    let expectedIds: Set<string> | null = null;
    try {
      expectedIds = await expectedLatencyProviderIds(env);
    } catch {}
    const collected: NonNullable<PipelineSignals['latencyProviders']> = rows
      .filter((r) => r.provider && r.last_observed)
      .map((r) => ({
        provider: r.provider,
        lastObservedAt: r.last_observed,
        expected: expectedIds === null ? true : expectedIds.has(r.provider),
      }));
    if (expectedIds) {
      for (const id of expectedIds) {
        if (!collected.some((p) => p.provider === id)) {
          collected.push({ provider: id, lastObservedAt: null, expected: true });
        }
      }
    }
    latencyProviders = collected;
  } catch {}

  let senateRelay: PipelineSignals['senateRelay'] = {
    configured: Boolean(env.SENATE_RELAY_URL?.trim()),
    probe: null,
  };
  try {
    senateRelay = {
      configured: Boolean(env.SENATE_RELAY_URL?.trim()),
      probe: await readSenateRelayProbe(env),
    };
  } catch {
    senateRelay = null;
  }

  // `allowDefault: false` so this stays a real signal.  It sits beside
  // `senateRelay.configured`, which is an explicit-env check; resolving with
  // the Mango fallback would pin it to true forever and hide a missed
  // `RESIDENTIAL_PROXY_URL` in Coolify.
  const residentialProxyConfigured = Boolean(
    resolveResidentialProxyUrl(env, { allowDefault: false }),
  );

  let residentialProxy: PipelineSignals['residentialProxy'] = {
    configured: residentialProxyConfigured,
    probe: null,
  };
  if (residentialProxyConfigured) {
    try {
      residentialProxy = {
        configured: true,
        probe: await readResidentialProxyProbe(env),
      };
    } catch {
      residentialProxy = null;
    }
  }

  const signals: PipelineSignals = {
    outboxPending,
    outboxOldestAt,
    outboxFailed,
    outboxFailedFresh,
    outboxFailedActive,
    reviewBacklog,
    reviewEligible,
    reviewSuppressed,
    reviewTerminal,
    extractionAttempts24h,
    extractionOk24h,
    lastExtractionSuccessAt,
    localWorkerActivity24h,
    autopilotHaltReason,
    latestTxCreatedAt,
    dishonestResolutionCount,
    orphanedNeedsReviewCount,
    strandedFilings,
    pollSources,
    latencyProviders,
    senateRelay,
    residentialProxyConfigured,
    residentialProxy,
    priceEodLatestDate,
    spxEodLatestDate,
    filingSkips24h,
    filingSkipsByAction24h,
    fmpLatency,
  };

  const evaluated = evaluatePipelineSignals(signals, nowMs, DEFAULT_PIPELINE_THRESHOLDS, schedule);
  return { ...evaluated, reviewQueue };
}
