/**
 * Staggered daily lane crons (Deno runtime).
 *
 * Background: the once-a-day job chain (FMP enrichment, price refresh, bulk
 * R2 snapshot, photo enrichment, ticker backfill, retention sweeps) used to
 * run inside the 15-minute scheduled tick, which carried a 45s deadline left
 * over from retired Deno Deploy free-tier constraints. Provider-paced network
 * lanes routinely blew that deadline, and because the whole chain shared one
 * KV date stamp, every lane after the abort silently never ran that day —
 * most visibly photo enrichment (bioguide/photo fill) and the bulk R2 snapshot.
 *
 * On Coolify / Hetzner there is no 45s platform limit, so each daily lane
 * now gets its OWN hourly cron window (first run of the UTC day wins; the
 * lane's KV date stamp makes later same-day firings cheap no-ops) and its own
 * multi-minute deadline. Windows are staggered so lanes never compete, and
 * ordered so the snapshot lane runs after the market-data lane it snapshots.
 * Minutes avoid :00/:30 per fleet scheduling policy.  Production health tick
 * is the Coolify paid profile (`* * * * *`).
 */

import type { Env } from '../shared/types.ts';
import {
  maybeRunDailyMarketDataJobs,
  maybeRunPeerPriceCatchUp,
  maybeRunDailySnapshotJob,
  maybeRunDailyFilerJobs,
  maybeRunDailyRetentionJobs,
  runHourlyEnrichmentSlice,
  HOURLY_ENRICHMENT_SLICE_DEADLINE_MS,
} from '../jobs.ts';
import { runAutonomySweeps } from '../ingestion/autonomySweeps.ts';
import { runDisclosureLatencyProbe } from '../ingestion/tradeLatency.ts';
import { runLeasedLatencyProbe } from '../ingestion/scoutHandoff.ts';
import { acquireDenoCronSingleton, type TickSingletonLock } from './scheduledTick.ts';
import { withThirdPartyTelemetry } from '../shared/thirdPartyTelemetry.ts';
import { captureException } from '#sentry';


export interface DailyLaneCron {
  /** Lane identifier; also the singleton-lock key suffix and log tag. */
  name: string;
  /** Crontab expression (UTC). Hourly; date-stamped lanes gate once/day. */
  schedule: string;
  run: (env: Env, now: Date, signal?: AbortSignal) => Promise<unknown>;
}

export const DAILY_LANE_CRONS: readonly DailyLaneCron[] = [
  // Market data first: time-sliced enrichment + price refresh write the day's
  // fresh rows. The 4-minute enrichment slice inside this lane can never
  // starve price refresh; the backlog drains via the hourly lane below.
  {
    name: 'daily-market-data',
    schedule: '7 * * * *',
    run: (env, now, signal) => maybeRunDailyMarketDataJobs(env, now, { signal }),
  },
  // Peer-price catch-up (CT-2445) on its OWN lane, decoupled from the
  // market-data lane's daily stamp. The catch-up used to be reachable only
  // from that lane's stamped fast path, so a backlog the full lane could not
  // clear inside its deadline (which leaves the day unstamped) also kept the
  // bounded drain from ever engaging. This lane gets its own singleton lock
  // and deadline via runDailyLane; the catch-up's KV gate (55-minute spacing,
  // per-session bounds) makes a tick with nothing due a cheap no-op, and the
  // stamped fast path still calls the same function.
  {
    name: 'peer-price-catchup',
    schedule: '17 * * * *',
    run: (env, now, signal) => maybeRunPeerPriceCatchUp(env, now, { signal }),
  },
  // Snapshot after market data so it captures today's freshest data.
  { name: 'daily-snapshot', schedule: '22 * * * *', run: maybeRunDailySnapshotJob },
  // Filer data (photos/bioguide + ticker backfill).
  { name: 'daily-filer', schedule: '37 * * * *', run: maybeRunDailyFilerJobs },
  // Hourly enrichment drain: time-sliced, no daily stamp — the daily FMP cap
  // self-limits spend; empty backlog turns runs into cheap no-ops.
  {
    name: 'hourly-enrichment',
    schedule: '47 * * * *',
    run: (env, now, signal) =>
      runHourlyEnrichmentSlice(env, now, {
        signal,
        deadlineMs: HOURLY_ENRICHMENT_SLICE_DEADLINE_MS,
      }),
  },
  // Autonomy sweeps (ceiling-flip stuck extraction_pending_local, terminalize
  // ancient stranded filings, House filed_date backfill, OGE undated-date
  // fallback): cheap, LIMIT-bounded, no daily stamp — matches
  // hourly-enrichment's every-hour cadence per autonomySweeps.ts's own
  // idempotency guarantees.
  {
    name: 'autonomy-sweeps',
    schedule: '42 * * * *',
    run: (env, now, signal) => runAutonomySweeps(env, now, { signal }),
  },
  // Retention sweeps last, clear of every write-heavy lane.
  { name: 'daily-retention', schedule: '53 * * * *', run: maybeRunDailyRetentionJobs },
];

function makeDeadlineFetch(parentSignal?: AbortSignal) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const reqAbort = new AbortController();
    const timeoutId = setTimeout(() => reqAbort.abort(new Error('upstream fetch timeout')), 15000);
    const signals: AbortSignal[] = [reqAbort.signal];
    if (parentSignal) signals.push(parentSignal);
    if (init?.signal) signals.push(init.signal);
    try {
      return await fetch(input, { ...init, signal: AbortSignal.any(signals) });
    } finally {
      clearTimeout(timeoutId);
    }
  };
}

/** Sub-minute latency lanes moved off the main tick (CONGRESS-TRADE-1B). */
export const FREQUENT_LANE_CRONS: readonly DailyLaneCron[] = [
  {
    name: 'latency-probe',
    schedule: '*/3 * * * *',
    run: (env, now, signal) =>
      runLeasedLatencyProbe(
        env,
        (providers) =>
          runDisclosureLatencyProbe(env, now, makeDeadlineFetch(signal), { providers }),
        now,
      ),
  },
  {
    name: 'latency-price-snapshots',
    schedule: '*/5 * * * *',
    run: async (env, now, signal) => {
      const { runLatencyPriceSnapshotTick } = await import('../ingestion/latencyPriceSnapshots.ts');
      return runLatencyPriceSnapshotTick(env, now, makeDeadlineFetch(signal), signal);
    },
  },
];

export const FREQUENT_LANE_DEFAULT_DEADLINE_MS = 2 * 60_000;

/** Per-lane deadline. The tick's 45s was a Deno Deploy free-tier constraint;
 *  on Coolify / Hetzner a lane may take minutes (provider pacing). */
export const DAILY_LANE_DEFAULT_DEADLINE_MS = 10 * 60_000;

function parseDeadlineMs(raw: string | undefined): number {
  const n = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(n) || n < 10_000) return DAILY_LANE_DEFAULT_DEADLINE_MS;
  return Math.min(n, 30 * 60_000);
}

/** Env override (CT_ prefix; leftover DENO_* alias for local tests). */
export function resolveDailyLaneDeadlineMs(
  env: Record<string, string | undefined> | { get?: (k: string) => string | undefined } = {},
): number {
  const read = (key: string): string | undefined =>
    typeof (env as { get?: (k: string) => string | undefined }).get === 'function'
      ? (env as { get: (k: string) => string | undefined }).get(key) ?? undefined
      : (env as Record<string, string | undefined>)[key];
  return parseDeadlineMs(read('CT_DAILY_LANE_DEADLINE_MS') ?? read('DENO_DAILY_LANE_DEADLINE_MS'));
}

/** How long the runner holds a lane singleton after abort while the lane
 *  promise is still unsettled (zombie fence, CT-2459). */
export const ZOMBIE_GRACE_MS = 30_000;

let zombieLaneCount = 0;
/** Process-lifetime count of lanes that outlived their abort (CT-2459). */
export function getZombieLaneCount(): number {
  return zombieLaneCount;
}

export interface DailyLaneRunResult {
  /** Lane's own return value, or a runner outcome marker. */
  status: unknown;
  durationMs: number;
}

/**
 * Run one daily lane with overlap guard, DB-backed cross-isolate singleton,
 * and an abort deadline that is THREADED INTO the lane (lanes check the
 * signal at slice boundaries and stop starting new work). Exported for
 * tests; the cron closures below delegate here.
 *
 * CT-2459: fail-CLOSED on lock-table errors. Every lane here writes, and
 * running unguarded on a KV/DB hiccup allowed duplicate concurrent lanes
 * on the single SQLite connection; lanes refire hourly, so skipping one
 * firing is cheap insurance. (The minute tick's watcher keeps its own
 * fail-open rule in scheduledTick.ts.)
 * CT-2459: on deadline abort the singleton is held until the lane's inner
 * promise actually settles (bounded grace), instead of releasing the lock
 * while a zombie lane may still be writing.
 */
export async function runDailyLane(
  lane: DailyLaneCron,
  env: Env,
  now = new Date(),
  deadlineMs = DAILY_LANE_DEFAULT_DEADLINE_MS,
): Promise<DailyLaneRunResult> {
  const started = Date.now();
  let lock: TickSingletonLock | null = null;
  try {
    lock = await acquireDenoCronSingleton(env, lane.name, now, deadlineMs + 30_000);
  } catch (err) {
    // Fail closed (CT-2459): never run a write lane unguarded.
    console.error(`daily lane ${lane.name}: singleton lock unavailable; skipping firing:`, (err as Error).message);
    return { status: 'skipped-lock-unavailable', durationMs: Date.now() - started };
  }
  if (!lock) {
    return { status: 'skipped-overlap', durationMs: Date.now() - started };
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`daily lane ${lane.name} exceeded ${deadlineMs}ms deadline`)), deadlineMs);
  const inner = withThirdPartyTelemetry(env, () => lane.run(env, now, abort.signal));
  // Observe settlement without ever leaving a floating rejection behind.
  let innerSettled = false;
  const innerDone = inner.then(
    () => { innerSettled = true; },
    () => { innerSettled = true; },
  );
  try {
    const status = await Promise.race([
      inner,
      new Promise<never>((_, reject) => {
        abort.signal.addEventListener('abort', () => reject(abort.signal.reason));
      }),
    ]);
    return { status, durationMs: Date.now() - started };
  } catch (err) {
    if (abort.signal.aborted) {
      console.warn(`daily lane ${lane.name} aborted at deadline:`, (err as Error).message);
      return { status: 'aborted', durationMs: Date.now() - started };
    }
    console.error(`daily lane ${lane.name} caught error:`, err);
    captureException(err, { tags: { cron: lane.name } });
    return { status: 'error', durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    if (abort.signal.aborted && !innerSettled) {
      // Zombie fence (CT-2459): the lane ignored the abort and may still be
      // writing. Hold the singleton until it settles, bounded by a grace
      // window scaled to the lane deadline; past that, count it and let
      // the lock TTL be the backstop.
      zombieLaneCount += 1;
      const graceMs = Math.min(ZOMBIE_GRACE_MS, Math.max(deadlineMs, 1_000));
      console.error(
        `daily lane ${lane.name}: still running ${Date.now() - started}ms after abort (zombie #${zombieLaneCount}); holding singleton up to ${graceMs}ms`,
      );
      await Promise.race([
        innerDone,
        new Promise((resolve) => setTimeout(resolve, graceMs)),
      ]);
    }
    if (lock) {
      try {
        await lock.release();
      } catch (err) {
        console.warn(`daily lane ${lane.name}: singleton release failed:`, (err as Error).message);
      }
    }
  }
}

/**
 * Register every daily lane as its own Deno.cron entry. In-isolate in-flight
 * guards cover Deno.cron not waiting for slow previous invocations; the
 * DB singleton inside runDailyLane covers any cross-isolate overlap.
 */
export function registerDailyLaneCrons(
  buildEnv: () => Env,
  deadlineMs = DAILY_LANE_DEFAULT_DEADLINE_MS,
): void {
  const inFlight = new Set<string>();
  for (const lane of DAILY_LANE_CRONS) {
    // Deno.cron names allow only alphanumerics, whitespace, hyphens, underscores.
    Deno.cron(`daily-lane ${lane.name}`, lane.schedule, async () => {
      if (inFlight.has(lane.name)) {
        console.warn(`daily lane ${lane.name} skipped: previous run still in flight`);
        return;
      }
      inFlight.add(lane.name);
      try {
        const result = await runDailyLane(lane, buildEnv(), new Date(), deadlineMs);
        const status =
          typeof result.status === 'string' ? result.status : JSON.stringify(result.status);
        if (status !== 'stamped') {
          console.log(`daily lane ${lane.name} ${status} in ${result.durationMs}ms`);
        }
      } finally {
        inFlight.delete(lane.name);
      }
    });
  }
  console.log(
    `Daily lane crons registered: ${DAILY_LANE_CRONS.map((l) => `${l.name}="${l.schedule}"`).join(' ')} deadlineMs=${deadlineMs}`,
  );
}

/**
 * These lanes run every 3-5 minutes and return tick result objects, not
 * 'stamped', so logging every non-'stamped' result wrote a (stringified)
 * line per run.  Only runner outcome markers (skipped-overlap, aborted,
 * error) are worth a line; a normal completion stays quiet.
 */
export function frequentLaneLogLine(name: string, result: DailyLaneRunResult): string | null {
  if (typeof result.status !== 'string' || result.status === 'stamped') return null;
  return `frequent lane ${name} ${result.status} in ${result.durationMs}ms`;
}

/**
 * Register sub-minute latency lane crons (probe every 3m, price snapshots every 5m).
 * Mirrors registerDailyLaneCrons: in-flight guard + DB singleton via runDailyLane.
 */
export function registerFrequentLaneCrons(
  buildEnv: () => Env,
  deadlineMs = FREQUENT_LANE_DEFAULT_DEADLINE_MS,
): void {
  const inFlight = new Set<string>();
  for (const lane of FREQUENT_LANE_CRONS) {
    Deno.cron(`frequent-lane ${lane.name}`, lane.schedule, async () => {
      if (inFlight.has(lane.name)) {
        console.warn(`frequent lane ${lane.name} skipped: previous run still in flight`);
        return;
      }
      inFlight.add(lane.name);
      try {
        const result = await runDailyLane(lane, buildEnv(), new Date(), deadlineMs);
        const line = frequentLaneLogLine(lane.name, result);
        if (line) console.log(line);
      } finally {
        inFlight.delete(lane.name);
      }
    });
  }
  console.log(
    `Frequent lane crons registered: ${FREQUENT_LANE_CRONS.map((l) => `${l.name}="${l.schedule}"`).join(' ')} deadlineMs=${deadlineMs}`,
  );
}
