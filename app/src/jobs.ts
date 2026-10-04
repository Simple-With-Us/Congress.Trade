/**
 * src/jobs.ts
 * OWNER: foundation
 *
 * Once-a-day background jobs, fired from the cron handler. Gated by a KV date
 * stamp so they run on the first cron tick of each UTC day (and not again that
 * day, even though the watcher cron fires every minute). Enrichment and prices
 * read Socratic.Trade; they do not spend FMP. A peer auth / plan / rate-limit
 * failure (SOCRATIC_HTTP_401/402/403/429 or PEER_HTTP_401/402/403/429) emails
 * an admin alert.
 */

import type { Env } from './shared/types.ts';
import { run, all } from './shared/db.ts';
import { runEnrichment } from './enrichment/service.ts';
import { runPriceRefresh } from './prices/service.ts';
import { notifyAdmin } from './alerts/notify.ts';
import { shareWithPeer, type PeerShareInput } from './share/outbound.ts';
import { runFreshnessCheck } from './share/freshness.ts';
import { runPhotoEnrichment, runTickerBackfill } from './admin/routes.ts';
import { runCommitteeSync } from './enrichment/committeeSync.ts';
import { runIdentitySync } from './enrichment/identitySync.ts';
import { runBulkSnapshot } from './export/snapshot.ts';
import { resolveSecrets } from './secrets/infisical.ts';
import { readSetting } from './settings/settingsService.ts';
import { isD1RowBudgetExceeded } from './shared/d1Budget.ts';
import { runR2UsageSummary } from './shared/r2Usage.ts';
import { backfillCurrentPricesFromEod } from './prices/service.ts';
// NOTE: runHouseReconciler (./ingestion/houseReconciler) is intentionally not
// imported here yet -- it is reserved for future scheduled-job wiring. Importing
// it unused would trip noUnusedLocals (enabled in this PR).

/**
 * Per-lane KV date stamps. Two flavors:
 *
 *  - `:lastok:<lane>` (LANE_KEY_PREFIX) — set ONLY after a lane returns
 *    'ran'. Used by the four daily lanes (market-data / snapshot / filer /
 *    retention) so the next same-day firing is a cheap no-op AND so that a
 *    budget-trip or thrown error today still lets the next hourly cron tick
 *    retry. The previous "stamp BEFORE running" design silently parked
 *    failed daily work for 24h — observed in prod 2026-09-20 with the S&P
 *    price series frozen at 2026-08-03 for 46 days because the one FMP
 *    refresh attempt 401/403'd but the day-stamp stuck.
 *
 *  - `:lastdate:<lane>` (SUBCLAIM_KEY_PREFIX) — stamp BEFORE running, for
 *    one-shot sub-features nested inside a lane (currently the R2 usage
 *    digest inside the retention lane). Cross-worker overlap for those
 *    sub-features is already prevented by the parent lane's DB singleton
 *    lock (see deno/cronLanes.ts:runDailyLane), so the cheap-no-op
 *    semantic is what we want.
 *
 * The legacy whole-chain stamp (DAILY_KEY) is kept as a fast-path
 * suppressor for the legacy combined entry point (maybeRunDailyJobs) and
 * for tests; dedicated lane crons ignore it.
 */
const LANE_KEY_PREFIX = 'jobs:daily:lastok:';
const SUBCLAIM_KEY_PREFIX = 'jobs:daily:lastdate:';
const DAILY_KEY = 'jobs:daily:lastdate';

export type DailyLaneStatus = 'ran' | 'stamped' | 'budget';

/**
 * Sub-feature stamp: claim-before-run. Used by the R2-usage digest nested
 * inside the retention lane. Cheap-no-op semantics only; failures inside the
 * sub-feature shouldn't park the parent lane.
 */
async function stampDaily(env: Env, key: string, day: string): Promise<boolean> {
  try {
    const last = await env.CONFIG_KV.get(key);
    if (last === day) return false;
    await env.CONFIG_KV.put(key, day, { expirationTtl: 172800 });
    return true;
  } catch {
    return false; // no KV → skip rather than risk hammering providers
  }
}

/**
 * Top-level daily lane: only mark "done" once the lane has actually
 * finished successfully. Returns true if the lane has NOT yet succeeded
 * today (so the caller should run it).
 */
async function laneHasSucceeded(env: Env, key: string, day: string): Promise<boolean> {
  try {
    const last = await env.CONFIG_KV.get(key);
    return last === day;
  } catch {
    return false; // no KV → pretend nothing has succeeded → retry
  }
}

/**
 * Stamp the lane as successfully completed today. Called by each daily
 * lane ONLY when it returns 'ran'. Best-effort; a KV write failure is
 * non-fatal (next tick will just retry).
 */
async function markLaneOk(env: Env, key: string, day: string): Promise<void> {
  try {
    await env.CONFIG_KV.put(key, day, { expirationTtl: 172800 });
  } catch (err) {
    console.warn(`daily lane ${key} mark-ok failed (will retry next tick):`, (err as Error).message);
  }
}

async function dailyBudgetExceeded(env: Env, stage: string): Promise<boolean> {
  if (!(await isD1RowBudgetExceeded(env))) return false;
  console.warn(`daily jobs stopped before ${stage}: D1 row budget exceeded`);
  return true;
}

// --- Operational-table retention -------------------------------------------
// dead_letter_events / ingest_log / source_attempts are append-only telemetry
// tables with no pruning path, so they grow without bound (3,517 DLQ rows and
// counting in production). Each is deleted in bounded batches — an `id IN
// (SELECT ... LIMIT n)` subquery, because D1/SQLite has no `DELETE ... LIMIT`
// — capped per run so one daily pass can never blow the D1 write/time budget.
// A backlog larger than the per-run cap simply drains over successive days.

interface RetentionPolicy {
  table: string;
  /** ISO-8601 timestamp column the age cutoff compares against. */
  column: string;
  days: number;
  /**
   * Primary-key column for the bounded `<key> IN (SELECT <key> ... LIMIT n)`
   * delete. D1/SQLite has no `DELETE ... LIMIT`, and the outbox tables key on
   * doc_id / tx_id rather than a synthetic `id`. Defaults to 'id'.
   */
  key?: string;
  /**
   * Extra predicate ANDed with the age cutoff. Restricts queue/outbox pruning
   * to TERMINAL rows so in-flight work is never deleted. Written to match the
   * partial-index WHERE clause verbatim: SQLite only uses a partial index when
   * every term of the index WHERE appears as a conjunct in the query WHERE.
   */
  where?: string;
  /** Key in the returned deleted-rows map. Defaults to `table`; set it when
   *  two policies target the same table with different statuses/ages. */
  name?: string;
}

export const RETENTION_POLICIES: readonly RetentionPolicy[] = [
  { table: 'dead_letter_events', column: 'created_at', days: 30 },
  { table: 'ingest_log', column: 'polled_at', days: 90 },
  { table: 'source_attempts', column: 'attempted_at', days: 30 },

  // --- Durable queue / outbox terminal rows -------------------------------
  // These are audit history only. Retention is asymmetric on purpose:
  //  * 'completed' rows are never read again by any code path;
  //  * 'failed' rows ARE the operator recovery surface
  //    (requeueFailedDurableQueue, durableQueue.ts:1162; and
  //    requeueFailedIngestionOutbox, ingestion/outbox.ts:181), so they must
  //    outlive a long weekend plus a deploy cycle.
  // Deleting a completed deno_runtime_queue row cannot resurrect a duplicate:
  // idx_deno_runtime_queue_active_dedupe is partial over
  // status IN ('pending','processing') and already ignores terminal rows.
  { name: 'deno_runtime_queue_completed', table: 'deno_runtime_queue', column: 'updated_at', days: 7, where: "status = 'completed'" },
  { name: 'deno_runtime_queue_failed', table: 'deno_runtime_queue', column: 'updated_at', days: 30, where: "status = 'failed'" },

  // ingestion_outbox: 90d, NOT 7d. queueHandlers.ts:161 calls
  // reconnectDeadLetteredIngestionOutbox with reopenCompleted=true for every
  // non-'filing.new' ingest DLQ, so a COMPLETED row is still the lever that
  // restarts a downstream-stage failure. Re-insert is gated on
  // `filings.ingest_status = 'new'` (outbox.ts:42), so pruning cannot
  // re-trigger ingestion of an already-ingested filing.
  { name: 'ingestion_outbox_completed', table: 'ingestion_outbox', key: 'doc_id', column: 'updated_at', days: 90, where: "status = 'completed'" },

  // delivery_outbox: safe at 90d because the duplicate-webhook guard is the
  // unique idx_deliveries_subscription_tx plus claimDelivery's constraint
  // retry (delivery/webhook.ts:544-553), NOT the outbox row; and `deliveries`
  // rows survive until the 5-year filing sweep.
  { name: 'delivery_outbox_completed', table: 'delivery_outbox', key: 'tx_id', column: 'updated_at', days: 90, where: "status = 'completed'" },
];

/** Total rows one daily sweep may delete across ALL policies. Bounds the
 *  sweep's contribution to the D1 daily write budget no matter how many
 *  policies are configured, so adding a policy can never silently multiply
 *  the sweep's write cost. A backlog above this drains over successive days. */
export const RETENTION_MAX_ROWS_PER_RUN = 40_000;

/** Rows per DELETE statement — small enough to stay comfortably inside D1's
 *  per-query limits even with index maintenance. */
export const RETENTION_DELETE_BATCH = 500;
/** Batches per table per daily run: caps one pass at 10k rows/table. */
export const RETENTION_MAX_BATCHES_PER_TABLE = 20;

/**
 * Delete expired rows from the operational tables above. Best-effort: a
 * failure on one table (e.g. table missing on a fresh preview DB) is logged
 * and does not stop the others. Returns rows deleted per table for tests and
 * log lines.
 */
export async function runRetentionSweep(env: Env, now = new Date()): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  for (const policy of RETENTION_POLICIES) deleted[policy.name ?? policy.table] = 0;

  let runTotal = 0;
  for (const policy of RETENTION_POLICIES) {
    if (runTotal >= RETENTION_MAX_ROWS_PER_RUN) {
      console.warn('retention sweep hit RETENTION_MAX_ROWS_PER_RUN; remaining policies drain tomorrow');
      break;
    }
    const label = policy.name ?? policy.table;
    const key = policy.key ?? 'id';
    const extra = policy.where ? ` AND ${policy.where}` : '';
    const cutoff = new Date(now.getTime() - policy.days * 86_400_000).toISOString();
    let total = 0;
    try {
      for (let batch = 0; batch < RETENTION_MAX_BATCHES_PER_TABLE; batch++) {
        if (runTotal + total >= RETENTION_MAX_ROWS_PER_RUN) break;
        const res = await run(
          env.DB,
          `DELETE FROM ${policy.table} WHERE ${key} IN (SELECT ${key} FROM ${policy.table} WHERE ${policy.column} < ?${extra} LIMIT ?)`,
          [cutoff, RETENTION_DELETE_BATCH],
        );
        const changes = Number(res.meta?.changes ?? 0);
        total += changes;
        if (changes < RETENTION_DELETE_BATCH) break; // backlog drained
      }
    } catch (err) {
      console.warn(`retention sweep failed for ${label}:`, (err as Error).message);
    }
    deleted[label] = total;
    runTotal += total;
  }
  return deleted;
}

/**
 * Delete filings, transactions, and corresponding R2 PDFs that are older than 5 years.
 * We rely on 'filed_date' from filings table.
 *
 * Rows with a NULL filed_date would never satisfy `filed_date < ?` (NULL
 * comparisons are not true), so they accumulated forever; the sweep now falls
 * back to the ingestion date (`first_seen_at`) for those rows — a filing we
 * ingested more than 5 years ago whose source never yielded a filed_date is
 * safe to prune. Delivery bookkeeping rows (deliveries / delivery_outbox) that
 * reference the batch's transactions are deleted alongside them so the sweep
 * does not orphan delivery rows pointing at removed transactions.
 *
 * TWO SAFETY RULES (2026-08-11), both learned the hard way:
 *
 * 1. THE ARCHIVED DOCUMENT IS NEVER DESTROYED BY DEFAULT.
 *    This sweep used to hard-delete the R2 object with no export, no
 *    tombstone, no bucket versioning and no flag — the stored copy is the
 *    ONLY durable artifact in the system (everything else is recomputed from
 *    it), and serving is stored-copy-only, so losing it is unrecoverable: the
 *    filing cannot be re-read, re-extracted or re-reviewed, ever. The DB rows
 *    can be rebuilt from the document; the document cannot be rebuilt from the
 *    rows. Deleting the object is now opt-in via RETENTION_DELETE_RAW_OBJECTS.
 *
 * 2. NEVER PRUNE SOMETHING WE ONLY JUST INGESTED.
 *    The predicate keys on filed_date, so a 2020 PTR discovered by a
 *    historical backfill TODAY was immediately eligible — the backfill lanes
 *    (houseCrawler / senateCrawler / seed) exist precisely to ingest filings
 *    older than the cutoff, so the two lanes fought each other: backfill
 *    ingests, next day's sweep destroys, forever. Rows first seen within
 *    RETENTION_MIN_AGE_DAYS are now protected regardless of filed_date.
 */
export const RETENTION_MIN_AGE_DAYS = 30;

function retentionDeleteRawObjectsEnabled(env: Env): boolean {
  // Infisical knob first (settings snapshot when booted), legacy process env
  // fallback for scripts/tests that run without the Deno boot sequence.
  const raw =
    readSetting(env as unknown as Record<string, string | undefined>, 'RETENTION_DELETE_RAW_OBJECTS') ??
    (typeof Deno !== 'undefined' ? Deno.env.get('RETENTION_DELETE_RAW_OBJECTS') : undefined) ??
    (typeof process !== 'undefined' ? process.env?.RETENTION_DELETE_RAW_OBJECTS : undefined) ??
    '';
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

export async function runFilingRetentionSweep(env: Env, now = new Date()): Promise<number> {
  const fiveYearsAgo = new Date(now.getTime() - 5 * 365 * 86_400_000);
  const cutoff = fiveYearsAgo.toISOString().slice(0, 10); // 'YYYY-MM-DD'
  // Protects freshly-backfilled history from being destroyed by the next run.
  const minAge = new Date(now.getTime() - RETENTION_MIN_AGE_DAYS * 86_400_000).toISOString();
  const deleteRawObjects = retentionDeleteRawObjectsEnabled(env);

  let totalDeleted = 0;
  let rawKept = 0;
  try {
    for (let batch = 0; batch < RETENTION_MAX_BATCHES_PER_TABLE; batch++) {
      const rows = await all<{ doc_id: string; raw_object_key: string | null }>(
        env.DB,
        `SELECT doc_id, raw_object_key FROM filings
          WHERE COALESCE(filed_date, substr(first_seen_at, 1, 10)) < ?
            AND first_seen_at < ?
          LIMIT ?`,
        [cutoff, minAge, RETENTION_DELETE_BATCH]
      );

      if (rows.length === 0) break;

      for (const row of rows) {
        if (!row.raw_object_key) continue;
        if (!deleteRawObjects) {
          // Keep the only durable copy. The DB rows still go, so the sweep
          // still bounds table growth — but the document stays recoverable.
          rawKept++;
          continue;
        }
        try {
          await env.RAW_FILES.delete(row.raw_object_key);
        } catch (e) {
          console.warn(`Failed to delete raw file ${row.raw_object_key} from R2`, e);
        }
      }

      const docIds = rows.map(r => r.doc_id);
      const placeholders = docIds.map(() => '?').join(',');
      
      // Delivery bookkeeping first: deliveries/delivery_outbox reference
      // transactions by tx_id and must not be orphaned when the batch's
      // transactions are removed below.
      await run(
        env.DB,
        `DELETE FROM deliveries WHERE tx_id IN (SELECT id FROM transactions WHERE doc_id IN (${placeholders}))`,
        docIds
      );

      await run(
        env.DB,
        `DELETE FROM delivery_outbox WHERE tx_id IN (SELECT id FROM transactions WHERE doc_id IN (${placeholders}))`,
        docIds
      );

      await run(
        env.DB,
        `DELETE FROM tx_cursor_seq WHERE tx_id IN (SELECT id FROM transactions WHERE doc_id IN (${placeholders}))`,
        docIds
      );
      
      await run(
        env.DB,
        `DELETE FROM transactions WHERE doc_id IN (${placeholders})`,
        docIds
      );
      
      // ingestion_outbox keys on doc_id and is NOT reachable from any of the
      // deletes above; without this it retains a row per pruned filing forever.
      await run(
        env.DB,
        `DELETE FROM ingestion_outbox WHERE doc_id IN (${placeholders})`,
        docIds
      );

      await run(
        env.DB,
        `DELETE FROM filings WHERE doc_id IN (${placeholders})`,
        docIds
      );
      
      totalDeleted += rows.length;
    }
  } catch (err) {
    console.warn('filing retention sweep failed:', (err as Error).message);
  }
  if (rawKept > 0) {
    console.log(
      `retention: pruned ${totalDeleted} filing row(s); kept ${rawKept} archived object(s) ` +
        `(set RETENTION_DELETE_RAW_OBJECTS=1 to delete them too)`,
    );
  }
  return totalDeleted;
}

/**
 * Daily lane 1 — market data: a TIME-SLICED enrichment pass (so a deep
 * backlog can never starve the rest of the lane), then price refresh, peer
 * share, usage telemetry, FMP-tier alert, and the cross-app freshness
 * watchdog. Runs on its own daily cron window (see deno/cronLanes.ts) with a
 * multi-minute deadline, NOT inside the 45s 15-minute tick. Own KV date
 * stamp; once per UTC day. The remaining enrichment backlog drains through
 * the day via the hourly `hourly-enrichment` lane.
 */
export async function maybeRunDailyMarketDataJobs(
  env: Env,
  now = new Date(),
  opts: { signal?: AbortSignal; enrichmentDeadlineMs?: number } = {},
): Promise<DailyLaneStatus> {
  const day = now.toISOString().slice(0, 10);
  const laneKey = LANE_KEY_PREFIX + 'market-data';
  // Stamp-on-success: only the LAST successful run suppresses same-day
  // retries. A budget trip today lets the next hourly cron tick try again.
  // See the LANE_KEY_PREFIX comment block at the top of this file.
  if (await laneHasSucceeded(env, laneKey, day)) return 'stamped';

  // Opt-in D1 spend guard (D1_ROW_BUDGET_ENFORCE): if today's metered D1 rows
  // already exceeded the budget, skip this discretionary daily batch — its big
  // enrichment/price/backfill upserts are the main controllable D1 write spend.
  // Default OFF (alert-only). Do NOT mark the lane as ok here: a budget trip
  // today should let the next hourly cron tick retry (a fresh budget, an
  // operator raise, or a manual /admin/recover-pipeline call can free the
  // same day). See the laneHasSucceeded / markLaneOk docs at LANE_KEY_PREFIX.
  if (await dailyBudgetExceeded(env, 'enrichment')) {
    return 'budget';
  }

  const errors: string[] = [];
  const share: PeerShareInput = {};
  // Resolve pacing + usage-monitor telemetry vars together (Infisical-backed,
  // falling back to the wrangler.toml env var whenever a name isn't set in Infisical)
  // so the whole daily run only pays for one resolveSecrets round trip.
  const secrets = await resolveSecrets(env, [
    'FMP_MAX_PER_MINUTE',
    'EDGAR_MAX_PER_MINUTE',
    'USAGE_MONITOR_ENABLED',
    'USAGE_MONITOR_INGEST_URL',
    'USAGE_MONITOR_INGEST_TOKEN',
    'USAGE_MONITOR_ENVIRONMENT',
    // R2 usage summary + Pushover delivery — folded into this one round trip.
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_R2_ANALYTICS_TOKEN',
    'PUSHOVER_APP_TOKEN',
    'PUSHOVER_USER_KEY',
  ]);
  // Local burst limit for the Socratic profile walk. Not an FMP budget.
  const maxPerMinute = parseInt(secrets.FMP_MAX_PER_MINUTE || '', 10) || undefined;
  // SEC EDGAR has its own fair-access pacer — configurable via
  // EDGAR_MAX_PER_MINUTE, unset = no pacing.
  const edgarMaxPerMinute = parseInt(secrets.EDGAR_MAX_PER_MINUTE || '', 10) || undefined;
  // Enrichment does not spend FMP, so there is no shared day-cap to reserve.

  try {
    // Time-sliced: stop picking up new candidates after enrichmentDeadlineMs
    // (default 4 min) so price refresh + share + freshness ALWAYS run today;
    // the hourly-enrichment lane keeps draining the backlog afterwards.
    const r = await runEnrichment(env, {
      maxPerMinute,
      edgarMaxPerMinute,
      signal: opts.signal,
      deadlineMs: opts.enrichmentDeadlineMs ?? 4 * 60_000,
    });
    errors.push(...r.errors);
    share.refs = r.shareRefs;
  } catch (err) {
    console.warn('daily enrichment failed:', (err as Error).message);
    errors.push('enrichment: ' + (err as Error).message);
  }
  if (await dailyBudgetExceeded(env, 'price refresh')) return 'budget';
  // Local repair first: stamp current_price from existing price_eod so the
  // leaderboard / UI don't stay blank while the peer fetch drains the backlog.
  try {
    const filled = await backfillCurrentPricesFromEod(env);
    if (filled.currentPriceFilled > 0 || filled.latestDateFilled > 0) {
      console.log('current-price backfill from EOD:', JSON.stringify(filled));
    }
  } catch (err) {
    console.warn('current-price backfill failed:', (err as Error).message);
  }
  try {
    const r = await runPriceRefresh(env, { maxPerMinute });
    errors.push(...r.errors);
    share.prices = r.sharePrices;
    share.spx = r.shareSpx;
  } catch (err) {
    console.warn('daily price refresh failed:', (err as Error).message);
    errors.push('prices: ' + (err as Error).message);
  }

  // Return half of the cross-app share: push what WE fetched this run to App B
  // (no-op unless APP_B_IMPORT_URL + APP_B_INGEST_TOKEN are set). Our delta only,
  // so data App B sent us is never echoed back.
  try {
    const res = await shareWithPeer(env, share);
    if (res.sent) console.log('shared to peer:', JSON.stringify(res.counts));
    else if (res.reason && !/not configured|nothing to share/.test(res.reason)) {
      console.warn('peer share failed:', res.reason);
    }
  } catch (err) {
    console.warn('peer share error:', (err as Error).message);
  }

  // Peer auth / plan / rate-limit failures mean ST is not supplying profiles or prices.
  // FMP is not a fallback for either.  Include 429 so a rate-limited peer does not
  // silently burn the whole ticker walk without an operator alert.
  if (errors.some((e) => /(?:SOCRATIC|PEER)_HTTP_(401|402|403|429)/.test(e))) {
    const sample = errors.filter((e) => /(?:SOCRATIC|PEER)_HTTP_(401|402|403|429)/.test(e)).slice(0, 5).join('\n');
    await notifyAdmin(env, {
      dedupeKey: 'socratic-peer-auth',
      subject: 'Congress.Trade ⚠️ Socratic.Trade market data is failing',
      text:
        "Today's enrichment / price refresh hit Socratic.Trade auth, plan, or rate-limit errors.\n" +
        'Profiles, quotes, and EOD prices come from Socratic.Trade.  FMP is latency probes only\n' +
        'and is not used to fill this gap.\n\n' +
        'Sample errors:\n' +
        sample +
        '\n\nCheck APP_B_IMPORT_URL and APP_B_INGEST_TOKEN (and ST rate limits on 429).  The job retries automatically each day;\n' +
        "you'll get at most one of these alerts every 12 hours.",
    });
  }

  // Cross-app freshness watchdog: alert if a donated market-data stream (S&P /
  // prices / fundamentals) has gone stale — i.e. the partner's push or our own
  // refresh quietly stopped. Throttled + best-effort; never blocks the cron.
  try {
    await runFreshnessCheck(env, now);
  } catch (err) {
    console.warn('freshness check failed:', (err as Error).message);
  }
  // Stamp-on-success: the day stamp only suppresses future ticks when the
  // lane actually finished all of enrichment, price refresh, peer share, the
  // FMP tier-failure alert, and the freshness check. If any of those threw
  // hard enough to skip this point, the stamp stays unset and the next
  // hourly cron tick will retry the whole lane.
  await markLaneOk(env, laneKey, day);
  return 'ran';
}

/**
 * Hourly lane — enrichment drain. Time-sliced Socratic.Trade + SEC enrichment
 * with NO daily date stamp. Candidate predicates self-limit the backlog, so
 * firing hourly drains it in ~8-minute slices. Each run's freshly enriched
 * refs are shared back to the peer (delta only). There is no FMP day-cap floor.
 */
export const HOURLY_ENRICHMENT_SLICE_MAX = 1200;
export const HOURLY_ENRICHMENT_SLICE_DEADLINE_MS = 8 * 60_000;

export interface HourlyEnrichmentResult {
  scanned: number;
  enriched: number;
  fmpCalls: number;
  budgetRemaining: number;
  remainingBacklog: boolean;
}

export async function runHourlyEnrichmentSlice(
  env: Env,
  now = new Date(),
  opts: { signal?: AbortSignal; deadlineMs?: number; max?: number } = {},
): Promise<HourlyEnrichmentResult> {
  const day = now.toISOString().slice(0, 10);
  const secrets = await resolveSecrets(env, [
    'FMP_MAX_PER_MINUTE',
    'EDGAR_MAX_PER_MINUTE',
  ]);
  const maxPerMinute = parseInt(secrets.FMP_MAX_PER_MINUTE || '', 10) || undefined;
  const edgarMaxPerMinute = parseInt(secrets.EDGAR_MAX_PER_MINUTE || '', 10) || undefined;
  const max = Math.max(0, Math.min(opts.max ?? HOURLY_ENRICHMENT_SLICE_MAX, HOURLY_ENRICHMENT_SLICE_MAX));
  const empty: HourlyEnrichmentResult = {
    scanned: 0, enriched: 0, fmpCalls: 0, budgetRemaining: 0, remainingBacklog: false,
  };
  if (max <= 0) return empty;

  const r = await runEnrichment(env, {
    maxPerMinute,
    edgarMaxPerMinute,
    max,
    signal: opts.signal,
    deadlineMs: opts.deadlineMs ?? HOURLY_ENRICHMENT_SLICE_DEADLINE_MS,
  });
  // Share this slice's delta (never echoes back what the peer sent us).
  if (r.shareRefs.length > 0) {
    try {
      await shareWithPeer(env, { refs: r.shareRefs });
    } catch (err) {
      console.warn('hourly enrichment peer share failed:', (err as Error).message);
    }
  }
  return {
    scanned: r.scanned,
    enriched: r.enriched,
    fmpCalls: r.fmpCalls,
    budgetRemaining: r.budgetRemaining,
    // Heuristic for observability: a slice that hit its caps probably left
    // backlog for the next hourly window.
    // There is no FMP day-cap on this lane. A full slice is the backlog signal.
    remainingBacklog: r.scanned >= max,
  };
}

/**
 * Daily lane 2 — bulk market-data snapshot to R2 (prices, S&P, securities
 * reference, fundamentals, analyst consensus) for App B to pull. Scheduled
 * AFTER the market-data lane's window so it captures the freshest data
 * written today. Best-effort + bounded; never blocks the cron.
 */
export async function maybeRunDailySnapshotJob(env: Env, now = new Date()): Promise<DailyLaneStatus> {
  const day = now.toISOString().slice(0, 10);
  const laneKey = LANE_KEY_PREFIX + 'snapshot';
  if (await laneHasSucceeded(env, laneKey, day)) return 'stamped';
  if (await dailyBudgetExceeded(env, 'bulk snapshot')) {
    // Don't stamp — next tick retries.
    return 'budget';
  }

  try {
    const manifest = await runBulkSnapshot(env, day, now);
    const rows = Object.values(manifest.tables).reduce((s, t: any) => s + t.rowCount, 0);
    console.log('bulk snapshot written:', day, rows, 'rows');
  } catch (err) {
    console.warn('bulk snapshot failed:', (err as Error).message);
    // Don't stamp on throw — let the next tick retry.
    return 'budget';
  }
  await markLaneOk(env, laneKey, day);
  return 'ran';
}

/**
 * Daily lane 3 — filer data (order matters):
 *   1. identity sync — resolve bioguide + campaign-sign display names +
 *      authoritative party/state/district (feeds steps 2–3)
 *   2. photo enrichment — 450x550 headshots from unitedstates/images
 *   3. committee sync — filers.committees from congress-legislators + House
 *      Clerk MemberData (committee sector conflicts + politician drawer)
 *   4. ticker backfill — name-but-no-ticker row resolution
 *
 * All COALESCE-preserving / idempotent, bounded, and best-effort. Committee
 * sync used to be admin-only and went stale after one-off runs; it is now
 * part of the daily filer lane so new filers pick up memberships automatically.
 */
export async function maybeRunDailyFilerJobs(env: Env, now = new Date()): Promise<DailyLaneStatus> {
  const day = now.toISOString().slice(0, 10);
  const laneKey = LANE_KEY_PREFIX + 'filer';
  if (await laneHasSucceeded(env, laneKey, day)) return 'stamped';
  if (await dailyBudgetExceeded(env, 'identity sync')) return 'budget';

  try {
    const r = await runIdentitySync(env);
    console.log('identity sync:', JSON.stringify({
      scanned: r.filersScanned,
      bioguideResolved: r.bioguideResolved,
      displayNamesSet: r.displayNamesSet,
      unresolved: r.unresolved,
      chambersCorrected: r.chambersCorrected,
      staleResolutionsFixed: r.staleResolutionsFixed,
    }));
  } catch (err) {
    console.warn('identity sync failed:', (err as Error).message);
    // Don't stamp on throw — let the next tick retry.
    return 'budget';
  }

  if (await dailyBudgetExceeded(env, 'photo enrichment')) return 'budget';

  try {
    const r = await runPhotoEnrichment(env);
    console.log('photo enrichment:', JSON.stringify(r));
  } catch (err) {
    console.warn('photo enrichment failed:', (err as Error).message);
  }

  if (await dailyBudgetExceeded(env, 'committee sync')) return 'budget';

  try {
    const r = await runCommitteeSync(env);
    console.log('committee sync:', JSON.stringify(r));
  } catch (err) {
    console.warn('committee sync failed:', (err as Error).message);
  }

  if (await dailyBudgetExceeded(env, 'ticker backfill')) return 'budget';

  try {
    // Cursor-paged: most ticker-less rows are bonds/funds/private assets that never
    // resolve, so an unpaged "lowest 5000 ids" scan would re-read the same rows
    // forever and never reach the rest (board row 16b46688).  The cursor advances
    // through the whole table over successive days, then wraps.
    const cursor = await readTickerBackfillCursor(env);
    const r = await runTickerBackfill(env, TICKER_BACKFILL_BATCH, { afterId: cursor });
    const next = r && r.scanned >= TICKER_BACKFILL_BATCH && r.lastId ? r.lastId : '';
    await writeTickerBackfillCursor(env, next);
    if (r) console.log('ticker backfill:', JSON.stringify({ scanned: r.scanned, resolved: r.resolved, wrapped: next === '' }));
  } catch (err) {
    console.warn('ticker backfill failed:', (err as Error).message);
  }
  // Stamp-on-success for the filer lane. See LANE_KEY_PREFIX block at the
  // top of this file for why this is set ONLY after identity + photos +
  // committees + ticker backfill all reached this point.
  await markLaneOk(env, laneKey, day);
  return 'ran';
}

const TICKER_BACKFILL_BATCH = 5000;
const TICKER_BACKFILL_CURSOR_KEY = 'jobs:ticker-backfill:cursor';

async function readTickerBackfillCursor(env: Env): Promise<string> {
  try {
    return (await env.CONFIG_KV.get(TICKER_BACKFILL_CURSOR_KEY)) ?? '';
  } catch {
    return '';
  }
}

async function writeTickerBackfillCursor(env: Env, cursor: string): Promise<void> {
  try {
    if (cursor) await env.CONFIG_KV.put(TICKER_BACKFILL_CURSOR_KEY, cursor, { expirationTtl: 30 * 86400 });
    else await env.CONFIG_KV.delete(TICKER_BACKFILL_CURSOR_KEY);
  } catch {
    // Best effort: a lost cursor just restarts the sweep from the beginning.
  }
}

/**
 * Daily lane 4 — retention: prune unbounded operational tables
 * (dead_letter_events / ingest_log / source_attempts) in bounded batches,
 * then the 5-year filing retention sweep (filings + transactions + R2 PDFs).
 */
export async function maybeRunDailyRetentionJobs(env: Env, now = new Date()): Promise<DailyLaneStatus> {
  const day = now.toISOString().slice(0, 10);

  // Daily R2 free-tier usage summary → Pushover. Own day-stamp (not retention's)
  // so we can wait until fleet-staggered UTC hour 20 (ST=14, UM=8) without
  // burning the once-per-day retention stamp on an early-hour skip.
  // Deno in prod; Node/vitest in unit tests. Infisical knob first (settings
  // snapshot when booted), legacy process env fallback for scripts/tests.
  const preferHourEnv =
    readSetting(env as unknown as Record<string, string | undefined>, 'R2_USAGE_DIGEST_UTC_HOUR') ??
    (typeof Deno !== 'undefined' ? Deno.env.get('R2_USAGE_DIGEST_UTC_HOUR') : undefined) ??
    (typeof process !== 'undefined' ? process.env?.R2_USAGE_DIGEST_UTC_HOUR : undefined) ??
    '20';
  const preferHourRaw = Number(preferHourEnv);
  const preferHour =
    Number.isFinite(preferHourRaw) && preferHourRaw >= 0 && preferHourRaw <= 23 ? preferHourRaw : 20;
  if (now.getUTCHours() >= preferHour) {
    if (await stampDaily(env, SUBCLAIM_KEY_PREFIX + 'r2-usage', day)) {
      try {
        const r2Secrets = await resolveSecrets(env, [
          'CLOUDFLARE_ACCOUNT_ID',
          'CLOUDFLARE_R2_ANALYTICS_TOKEN',
          'PUSHOVER_APP_TOKEN',
          'PUSHOVER_CT_API_TOKEN',
          'PUSHOVER_USER_KEY',
        ]);
        const r2 = await runR2UsageSummary(env, now, r2Secrets);
        if (!r2.sent && r2.reason && !/not configured/.test(r2.reason)) {
          console.warn('r2 usage summary not sent:', r2.reason);
        }
      } catch (err) {
        console.warn('r2 usage summary failed:', (err as Error).message);
      }
    }
  }

  if (!(await stampDaily(env, SUBCLAIM_KEY_PREFIX + 'retention', day))) return 'stamped';

  if (await dailyBudgetExceeded(env, 'retention sweep')) return 'budget';

  // Prune unbounded operational tables (dead_letter_events / ingest_log /
  // source_attempts). Bounded batches + per-run cap; never blocks the cron.
  try {
    const swept = await runRetentionSweep(env, now);
    const total = Object.values(swept).reduce((s, n) => s + n, 0);
    if (total > 0) console.log('retention sweep deleted rows:', JSON.stringify(swept));
  } catch (err) {
    console.warn('retention sweep failed:', (err as Error).message);
  }

  // 5-Year Data Retention Sweep
  try {
    const deletedFilings = await runFilingRetentionSweep(env, now);
    if (deletedFilings > 0) {
      console.log('5-year filing retention sweep deleted old filings:', deletedFilings);
    }
  } catch (err) {
    console.warn('5-year filing retention sweep failed:', (err as Error).message);
  }
  // Note: retention keeps the stamp-before semantic (SUBCLAIM_KEY_PREFIX)
  // because its work is cheap, idempotent, and only ever shrinks the DB;
  // skipping it on a budget trip is safe and a missed sweep never risks
  // data loss (older rows are deleted on the NEXT successful sweep).
  return 'ran';
}

/**
 * Legacy combined entry point (Workers scheduled path, POST runtime-tick when
 * the internal cron is disabled, and tests). Runs all four daily lanes in
 * chain order, preserving the original semantics: one DAILY_KEY stamp
 * suppresses repeat calls same-day, and a D1-budget trip in any lane ends
 * the whole pass. Dedicated lane crons (deno/cronLanes.ts) call the lane
 * functions directly and ignore DAILY_KEY.
 */
export async function maybeRunDailyJobs(env: Env, now = new Date()): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  if (!(await stampDaily(env, DAILY_KEY, day))) return;
  const lanes = [
    maybeRunDailyMarketDataJobs,
    maybeRunDailySnapshotJob,
    maybeRunDailyFilerJobs,
    maybeRunDailyRetentionJobs,
  ];
  for (const lane of lanes) {
    if ((await lane(env, now)) === 'budget') return;
  }
}
