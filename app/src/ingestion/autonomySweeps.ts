/**
 * src/ingestion/autonomySweeps.ts
 * OWNER: ingestion agent
 *
 * Periodic, idempotent, bounded self-healing sweeps for the ingestion
 * pipeline (autonomy diagnosis 2026-08-09). Every function here is safe to
 * call repeatedly and concurrently: each is a single bounded SQL statement
 * (or a small batch of them) gated by a WHERE clause that only ever matches
 * rows genuinely stranded, so a no-op run costs one cheap query.
 *
 * Wired hourly via deno/cronLanes.ts (see 'autonomy-sweeps' lane) — no daily
 * KV date-stamp, matching the existing 'hourly-enrichment' lane's pattern:
 * these are cheap, self-limiting (LIMIT-bounded), and safe to run every hour.
 *
 * PRINCIPLES (see task diagnosis): every stuck state gets (a) a bounded
 * automatic retry with backoff [existing per-message retry paths], (b) a
 * VISIBLE terminal dead-letter state [shared/pipelineHealth.ts], and (c) an
 * idempotent self-healing sweep that re-picks up anything stranded [here].
 */

import { extractText, getDocumentProxy } from 'unpdf';
import type { Env } from '../shared/types.ts';
import { all, batch, run } from '../shared/db.ts';
import { checkPipelineHealth } from '../shared/pipelineHealth.ts';
import { sendPushover } from '../shared/pushover.ts';
import { sentryLoggerWarn } from '../shared/sentryRuntime.ts';
import { fetchHouseIndex } from './houseSource.ts';
import {
  maybeRunDeterministicReviewDrain,
  sweepRejectedScannedForLocalVision,
  type DeterministicDrainResult,
  type LocalVisionRequeueResult,
} from '../extraction/deterministicDrain.ts';
import { DESYNCED_INGEST_STATUSES, reconcileResolvedReviewStatus } from './reviewStatusReconcile.ts';
import {
  PROVIDER_ONLY_LEAD_CLEARED_REASON,
  reconcileProviderMissingStubsWithOfficial,
  type ProviderMissingStubReconcileResult,
} from './providerMissingStubClose.ts';
import {
  sweepKnownParkedExecutiveTerminals,
  type ExecutiveTerminalSweepResult,
} from '../extraction/executiveDisposition.ts';

/** Provider-placeholder bookkeeping rows (tradeLatency.ts
 *  routeProviderOnlyObservationsToReview) are working-as-designed synthetic
 *  rows, never fetched by design (raw_object_key IS NULL). Every sweep below
 *  excludes them so a legitimate placeholder never gets swept as "stuck". */
const PROVIDER_MISSING_PREFIX = 'provider-missing-%';

export interface CeilingSweepResult {
  flipped: number;
}

/**
 * Fix 2.4: a filing stuck in 'extraction_pending_local' past a generous 24h
 * ceiling gets force-advanced to 'classified' + a fresh filing.extracted
 * enqueue, independent of its own per-doc delayed filing.local_wait_check
 * message (which can be lost — see queueHandlers.ts's self-reschedule fix —
 * or simply never fire if the local worker never came back). Excludes
 * already review-resolved rows so this can never revive a filing the review
 * process closed out.
 */
export async function sweepExtractionPendingLocalCeiling(
  env: Env,
  now = new Date(),
  opts: { ceilingHours?: number; limit?: number } = {},
): Promise<CeilingSweepResult> {
  const ceilingHours = opts.ceilingHours ?? 24;
  const limit = opts.limit ?? 200;
  const cutoff = new Date(now.getTime() - ceilingHours * 3600_000).toISOString();

  const rows = await all<{ doc_id: string }>(
    env.DB,
    `SELECT f.doc_id FROM filings f
      WHERE f.ingest_status = 'extraction_pending_local'
        AND f.local_wait_expires_at IS NOT NULL
        AND f.local_wait_expires_at < ?
        AND f.doc_id NOT LIKE ?
        AND NOT EXISTS (SELECT 1 FROM review_queue rq WHERE rq.doc_id = f.doc_id AND rq.resolved = 1)
      LIMIT ?`,
    [cutoff, PROVIDER_MISSING_PREFIX, limit],
  );

  let flipped = 0;
  for (const row of rows) {
    const res = await run(
      env.DB,
      `UPDATE filings SET ingest_status = 'classified'
        WHERE doc_id = ? AND ingest_status = 'extraction_pending_local'`,
      [row.doc_id],
    );
    if ((res.meta?.changes ?? 0) > 0) {
      flipped += 1;
      try {
        await env.INGEST_QUEUE.send({ type: 'filing.extracted', docId: row.doc_id });
      } catch (err) {
        console.warn(`autonomySweep: ceiling-flip enqueue failed for ${row.doc_id}:`, (err as Error).message);
      }
    }
  }
  return { flipped };
}

export interface StrandedSweepResult {
  terminalized: number;
}

/** Mid-pipeline statuses that must never sit forever without a terminal
 *  escape hatch. 'needs_review' is deliberately excluded — that state is
 *  already owned by the review queue and has its own resolution paths. */
const STRANDABLE_STATUSES = ['new', 'fetched', 'classified', 'extraction_pending_local'] as const;

/**
 * Fix 1.2 (generalized) + PRINCIPLE (b)/(c): a universal backstop so no
 * filing can sit invisible mid-pipeline forever, regardless of which stage
 * or bug stranded it. Any filing still in a non-terminal status well past
 * every stage-specific retry window (10 days — safely beyond fetcher.ts's
 * own 7-day FETCH_NOT_PUBLISHED_WINDOW_MS) is terminalized to 'error' with a
 * self-documenting message, so it is visible to every "ingest_status='error'"
 * operational query and to pipelineHealth's stranded_filings check.
 * Excludes already review-resolved rows (never revive a closed-out filing)
 * and provider-placeholder rows (working as designed, never fetched).
 */
export async function sweepStrandedFilings(
  env: Env,
  now = new Date(),
  opts: { ceilingDays?: number; limit?: number } = {},
): Promise<StrandedSweepResult> {
  const ceilingDays = opts.ceilingDays ?? 10;
  const limit = opts.limit ?? 200;
  const cutoff = new Date(now.getTime() - ceilingDays * 86_400_000).toISOString();
  const nowIso = now.toISOString();
  const statusPlaceholders = STRANDABLE_STATUSES.map(() => '?').join(',');

  const rows = await all<{ doc_id: string; ingest_status: string }>(
    env.DB,
    `SELECT f.doc_id, f.ingest_status FROM filings f
      WHERE f.ingest_status IN (${statusPlaceholders})
        AND f.first_seen_at IS NOT NULL
        AND f.first_seen_at < ?
        AND f.doc_id NOT LIKE ?
        AND NOT EXISTS (SELECT 1 FROM review_queue rq WHERE rq.doc_id = f.doc_id AND rq.resolved = 1)
      LIMIT ?`,
    [...STRANDABLE_STATUSES, cutoff, PROVIDER_MISSING_PREFIX, limit],
  );

  let terminalized = 0;
  for (const row of rows) {
    const res = await run(
      env.DB,
      `UPDATE filings
          SET ingest_status = 'error',
              error = ?
        WHERE doc_id = ? AND ingest_status = ?`,
      [
        `autonomy-sweep: stranded in '${row.ingest_status}' past ${ceilingDays}d ceiling as of ${nowIso}; terminalized for visibility`,
        row.doc_id,
        row.ingest_status,
      ],
    );
    if ((res.meta?.changes ?? 0) > 0) terminalized += 1;
  }
  return { terminalized };
}

export interface FiledDateBackfillResult {
  updated: number;
  yearsFetched: string[];
}

/**
 * Fix 5.1: House's low-latency live-search detection path structurally
 * omits filed_date (only the daily bulk FD ZIP carries it); watcher.ts's own
 * passive self-heal only fires when the SAME doc is rediscovered by a later
 * scan. This targets the residual directly: for House filings still
 * filed_date-NULL past 72h, fetch the (already-exported, read-only)
 * per-year bulk index and backfill filed_date for any doc_id it resolves —
 * the exact same COALESCE-style UPDATE watcher.ts's passive path uses, so a
 * doc that already got a date some other way is never overwritten. Bounded
 * to at most 2 distinct years per run to avoid hammering the Clerk.
 *
 * Year extraction is `H-(\d{4})-` (houseDocId in houseSource.ts). Live
 * diagnosis for #1577 (2026-08-17) confirmed that regex matches every
 * official House pipeline id; do not loosen it to invent dates for
 * `provider-missing-*` stubs or `not_found` frontier-probe phantoms.
 * Those ids are absent from the Clerk index, so NULL is the honest value.
 * `not_found` is excluded so the hourly sweep does not re-fetch the ZIP
 * for the 2026-07-30 sequential-probe burst (H-2026-20035076..20035975).
 */
export async function sweepFiledDateBackfill(
  env: Env,
  now = new Date(),
  opts: { staleHours?: number; limit?: number; maxYears?: number; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<FiledDateBackfillResult> {
  const staleHours = opts.staleHours ?? 72;
  const limit = opts.limit ?? 300;
  const maxYears = opts.maxYears ?? 1;
  const cutoff = new Date(now.getTime() - staleHours * 3600_000).toISOString();

  const stuck = await all<{ doc_id: string }>(
    env.DB,
    `SELECT doc_id FROM filings
      WHERE chamber = 'house'
        AND filed_date IS NULL
        AND ingest_status != 'error'
        AND ingest_status != 'not_found'
        AND first_seen_at IS NOT NULL
        AND first_seen_at < ?
        AND doc_id NOT LIKE ?
      LIMIT ?`,
    [cutoff, PROVIDER_MISSING_PREFIX, limit],
  );
  if (stuck.length === 0) return { updated: 0, yearsFetched: [] };

  // House pipeline doc ids are "H-{year}-{docId}" (houseDocId in
  // houseSource.ts). Group by year so each year's ZIP is fetched at most once.
  const yearsNeeded = new Set<string>();
  for (const row of stuck) {
    const m = /^H-(\d{4})-/.exec(row.doc_id);
    if (m) yearsNeeded.add(m[1]);
  }
  const years = [...yearsNeeded].slice(0, maxYears);

  const filedDateByDocId = new Map<string, string>();
  for (const year of years) {
    if (opts.signal?.aborted) break;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);
    try {
      const index = await fetchHouseIndex(year, {
        fetchImpl: opts.fetchImpl,
        relayUrl: env.HOUSE_RELAY_URL || env.INGEST_RELAY_URL,
        signal: controller.signal,
      });
      for (const f of index) {
        if (f.filingDate) filedDateByDocId.set(f.pipelineDocId, f.filingDate);
      }
    } catch (err) {
      console.warn(`autonomySweep: filed-date backfill fetch failed for year ${year}:`, (err as Error).message);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  let updated = 0;
  for (const row of stuck) {
    const filedDate = filedDateByDocId.get(row.doc_id);
    if (!filedDate) continue;
    const res = await run(
      env.DB,
      `UPDATE filings SET filed_date = ? WHERE doc_id = ? AND filed_date IS NULL`,
      [filedDate, row.doc_id],
    );
    if ((res.meta?.changes ?? 0) > 0) {
      updated += 1;
      try {
        await run(
          env.DB,
          `UPDATE disclosure_latency_candidates SET filed_date = ? WHERE doc_id = ? AND (filed_date IS NULL OR filed_date = '')`,
          [filedDate, row.doc_id],
        );
      } catch {
        /* optional table, mirrors watcher.ts's own swallow */
      }
    }
  }
  return { updated, yearsFetched: years };
}

// ---------------------------------------------------------------------------
// OGE 'undated' filing date fallback (fix 5.2)
// ---------------------------------------------------------------------------

/**
 * Best-effort printed-date extraction from OGE 278-T body text. OGE PDFs
 * commonly print a "Date of Report" / "Report Date" / "Date Signed" field
 * near a date; when no such label is found, the LAST plausible date in the
 * document is used (executive-filer signature dates are printed last). Pure
 * and unit-testable; never invents a value outside [2015-01-01, now+1day].
 */
export function extractPrintedDateFromText(text: string, now = new Date()): string | null {
  const datePattern = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/g;
  const minMs = Date.parse('2015-01-01T00:00:00Z');
  const maxMs = now.getTime() + 86_400_000;

  const toIso = (mo: string, d: string, y: string): string | null => {
    const month = Number(mo);
    const day = Number(d);
    const year = Number(y);
    if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const ms = Date.parse(`${iso}T00:00:00Z`);
    if (!Number.isFinite(ms) || ms < minMs || ms > maxMs) return null;
    return iso;
  };

  // Prefer a date near an explicit report/signature-date label.
  const labelPattern = /(date\s+of\s+report|report\s+date|date\s+signed|signature\s+date|date\s+filed)\s*[:\-]?\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/gi;
  let labelMatch: RegExpExecArray | null;
  let lastLabeled: string | null = null;
  while ((labelMatch = labelPattern.exec(text)) !== null) {
    const iso = toIso(labelMatch[2], labelMatch[3], labelMatch[4]);
    if (iso) lastLabeled = iso;
  }
  if (lastLabeled) return lastLabeled;

  // Fallback: last plausible bare date anywhere in the text.
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = datePattern.exec(text)) !== null) {
    const iso = toIso(m[1], m[2], m[3]);
    if (iso) last = iso;
  }
  return last;
}

export interface OgeUndatedBackfillResult {
  updated: number;
  attempted: number;
}

/**
 * Fix 5.2: OGE executive filings the index itself never dates (doc_id prefix
 * 'E-undated-') get one opportunistic pass at a printed date parsed straight
 * out of the already-extracted PDF text layer. Deterministic, no LLM calls —
 * text_pdf docs only (scanned_pdf has no text layer to parse; that residual
 * is the pre-existing, tracked needs_llm=true vision gap, out of scope here).
 * Only ever fills a NULL filed_date; never overwrites.
 */
export async function sweepOgeUndatedFilingDates(
  env: Env,
  opts: { limit?: number } = {},
): Promise<OgeUndatedBackfillResult> {
  const limit = opts.limit ?? 25;
  const rows = await all<{ doc_id: string; raw_object_key: string }>(
    env.DB,
    `SELECT doc_id, raw_object_key FROM filings
      WHERE doc_id LIKE 'E-undated-%'
        AND filed_date IS NULL
        AND doc_kind = 'text_pdf'
        AND raw_object_key IS NOT NULL
      LIMIT ?`,
    [limit],
  );
  let updated = 0;
  let attempted = 0;
  for (const row of rows) {
    attempted += 1;
    try {
      const obj = await env.RAW_FILES.get(row.raw_object_key);
      if (!obj) continue;
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const pdf = await getDocumentProxy(bytes);
      const { text } = await extractText(pdf, { mergePages: true });
      if (typeof (pdf as unknown as { destroy?: () => void }).destroy === 'function') {
        (pdf as unknown as { destroy: () => void }).destroy();
      }
      const flat = typeof text === 'string' ? text : (text as string[]).join('\n');
      const filedDate = extractPrintedDateFromText(flat);
      if (!filedDate) continue;
      const res = await run(
        env.DB,
        `UPDATE filings SET filed_date = ? WHERE doc_id = ? AND filed_date IS NULL`,
        [filedDate, row.doc_id],
      );
      if ((res.meta?.changes ?? 0) > 0) updated += 1;
    } catch (err) {
      console.warn(`autonomySweep: OGE undated date parse failed for ${row.doc_id}:`, (err as Error).message);
    }
  }
  return { updated, attempted };
}

export interface ResolvedDesyncSweepResult {
  scanned: number;
  reconciled: number;
}

/**
 * Reconcile filings whose review_queue row says resolved=1 while
 * filings.ingest_status is still non-terminal.
 *
 * WHY THIS EXISTS (the blind spot the #1579 verifier caught): every other
 * safety net here — the classifier/fetcher no-op guard, the ceiling sweep, the
 * stranded sweep, and pipelineHealth's stranded_filings check — deliberately
 * excludes `resolved = 1` rows so a closed-out filing is never revived. That
 * assumes resolved=1 implies a terminal ingest_status. Production disproved it:
 * 562 rows (268 extraction_pending_local + 114 classified + 180 needs_review)
 * are ALL resolved=1 yet frozen at a pre-resolution status, so they were
 * invisible to every sweep AND to the health check built to surface them.
 *
 * This sweep owns exactly that population: it does NOT re-open, re-fetch, or
 * re-extract anything (the review outcome stands) — it only stamps the terminal
 * status from review_queue.resolution_kind / ingestion_decisions.  Provider-
 * missing placeholder rows are excluded.  Idempotent and bounded.
 */
export async function sweepResolvedStatusDesync(
  env: Env,
  now = new Date(),
  opts: { limit?: number } = {},
): Promise<ResolvedDesyncSweepResult> {
  const result = await reconcileResolvedReviewStatus(env, {
    apply: true,
    limit: opts.limit ?? 500,
    now,
  });
  return { scanned: result.scanned, reconciled: result.updated };
}

export interface AutonomySweepResult {
  ceiling: CeilingSweepResult | null;
  stranded: StrandedSweepResult | null;
  resolvedDesync: ResolvedDesyncSweepResult | null;
  /** Provider-only placeholder review rows closed to verified_empty. */
  providerOnlyStubs: ProviderOnlyStubSweepResult | null;
  /** Open or sweep-closed provider-only stubs rejected because the official filing has since persisted. */
  providerStubOfficialReconcile: ProviderMissingStubReconcileResult | null;
  /** Open review rows closed as already-published (orphaned review rows). */
  alreadyPublished: AlreadyPublishedReviewSweepResult | null;
  filedDateBackfill: FiledDateBackfillResult | null;
  ogeUndated: OgeUndatedBackfillResult | null;
  livenessAlarms: LivenessAlarmResult | null;
  /** 2026-09-21: per-source polling heartbeat — pages when a chamber has gone
   *  N hours without ANY source_attempts row (the failure class the liveness
   *  check cannot see, because a tick that never fires is not a tick that
   *  failed). */
  pollingHeartbeat: PollingHeartbeatResult | null;
  /** Empty 278e → verified_empty; refused 278-T → unreadable.  Allowlist only. */
  executiveTerminals: ExecutiveTerminalSweepResult | null;
  errors: string[];
}

export interface LivenessAlarmResult {
  evaluated: number;
  bad: number;
  notified: string[];
  recovered: string[];
}

export interface PollingHeartbeatResult {
  evaluated: number;
  alerted: string[];
  /** Seconds since the last attempt per source — for the health payload. */
  ageBySource: Record<'house' | 'senate' | 'executive', number | null>;
}

export interface LocalVisionHostedFallbackResult {
  enqueued: number;
}

/**
 * local_mac_1 is supplemental.  Docs parked as local_vision_exhausted must
 * fall through to the hosted LLM path once, not sit suppressed forever.
 */
export async function sweepLocalVisionHostedFallback(
  env: Env,
  opts: { limit?: number } = {},
): Promise<LocalVisionHostedFallbackResult> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await all<{ doc_id: string; error: string | null }>(
    env.DB,
    `SELECT f.doc_id, f.error
       FROM filings f
       JOIN review_queue rq ON rq.doc_id = f.doc_id
      WHERE COALESCE(rq.resolved, 0) = 0
        AND (
          COALESCE(rq.reason, '') LIKE '%local_vision_exhausted%'
          OR COALESCE(f.error, '') LIKE '%local_vision_exhausted%'
        )
        AND COALESCE(f.error, '') NOT LIKE '%hosted_fallback_enqueued%'
        AND f.raw_object_key IS NOT NULL
      LIMIT ?`,
    [limit],
  );
  let enqueued = 0;
  for (const row of rows) {
    try {
      await env.INGEST_QUEUE.send({ type: 'filing.extracted', docId: row.doc_id });
      const stamp = `${row.error ? `${row.error}; ` : ''}hosted_fallback_enqueued`;
      await run(
        env.DB,
        `UPDATE filings SET error = ? WHERE doc_id = ?`,
        [stamp.slice(0, 1000), row.doc_id],
      );
      enqueued += 1;
    } catch (err) {
      console.warn('hosted fallback enqueue failed', row.doc_id, (err as Error).message);
    }
  }
  return { enqueued };
}

const LIVENESS_ALARM_CHECK_IDS = new Set([
  'polling_house',
  'polling_senate',
  'polling_executive',
  'latency_probes',
  'senate_relay',
  'autopilot_halt',
  'extraction_provider',
  'extraction_backlog',
  // 2026-09-20: include price_freshness in the alarm set so a stale price
  // cache (>= priceMaxAgeCriticalDays trading days behind) pages the owner.
  // Previously the check only degraded silently — see board 14dac466 /
  // prod observation 2026-09-20 with S&P frozen at 2026-08-03 for 46 days
  // and nobody alerted.
  'price_freshness',
  // 2026-09-21: filing_skips (extract_empty_failure/auto_resolved_empty/doc_quarantined).
  // Owner ask: "big red flag ... anytime a filing is skipped or considered
  // empty or blank or unreadable since that is almost always false and app
  // error." These three outcomes mean the OCR/vision/model pipeline failed;
  // they should always page on the first occurrence.
  'filing_skips',
  // 2026-09-21: FMP latency probe silence = a free-tier key rotation or
  // network outage that has been silent for >3h. Owner ask: FMP latency
  // should be visible everywhere; it is also a hard alarm when silent.
  'fmp_latency',
]);
const LIVENESS_ALARM_KV_PREFIX = 'liveness-alarm:';
const LIVENESS_RENOTIFY_MS = 6 * 3_600_000;

/**
 * 2026-09-21: a critical/stalled price_freshness no longer just pages and
 * waits for an operator. The hourly liveness-alarm sweep ALSO invokes
 * runPriceRefresh inline (bounded, idempotent) so the cache self-heals the
 * moment it crosses the threshold — the same way the S&P freeze in
 * Sep 2026 (frozen for 46 days) gets unstuck without manual intervention.
 *
 * The behavior is opt-in via env (default: ON). To turn it off while keeping
 * the page intact, set `CT_DISABLE_PRICE_AUTO_RECOVER=1`.
 *
 * The auto-recover is bounded to a single attempt per alarm sweep, shares the
 * daily FMP budget via runPriceRefresh's own pacer, and is rate-limited to
 * one attempt per 6h per check (matches the renotify cadence) so a transient
 * FMP outage cannot trigger a run-every-hour loop.
 */
const AUTO_RECOVER_RENOTIFY_MS = LIVENESS_RENOTIFY_MS;

interface AutoRecoverEpisode {
  attemptedAt: string;
  /** True when the last attempt succeeded (caller may want to suppress the
   *  page on the same hour if so). Optional so old KV entries stay parseable. */
  ok?: boolean;
}

async function maybeAutoRecoverPrice(
  env: Env,
  now: Date,
  check: { id: string; status: string; detail: string },
): Promise<{ attempted: boolean; ok: boolean; error?: string } | null> {
  // Env access guarded so vitest (Node) tests don't ReferenceError on Deno.
  const envGet = (k: string): string | undefined => {
    try { return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(k); }
    catch { return undefined; }
  };
  if (envGet('CT_DISABLE_PRICE_AUTO_RECOVER') === '1') return null;
  if (check.id !== 'price_freshness') return null;
  if (check.status !== 'critical' && check.status !== 'stalled') return null;
  const kvKey = `${LIVENESS_ALARM_KV_PREFIX}auto-recover:${check.id}`;
  let prev: AutoRecoverEpisode | null = null;
  try {
    prev = await env.CONFIG_KV.get<AutoRecoverEpisode>(kvKey, 'json');
  } catch {}
  if (prev && Number.isFinite(Date.parse(prev.attemptedAt))
    && now.getTime() - Date.parse(prev.attemptedAt) < AUTO_RECOVER_RENOTIFY_MS) {
    return null; // already tried in the last 6h
  }
  try {
    // Lazy import keeps the liveness-alarm path cheap when auto-recover is
    // disabled or not needed; the price service module pulls in the FMP/
    // Tiingo/Massive clients and the daily FMP pacer.
    const { runPriceRefresh } = await import('../prices/service.ts');
    const r = await runPriceRefresh(env, { maxPerMinute: 3 });
    const ok = r.errors.length === 0;
    await env.CONFIG_KV.put(kvKey, JSON.stringify({ attemptedAt: now.toISOString(), ok } satisfies AutoRecoverEpisode));
    return { attempted: true, ok, error: ok ? undefined : r.errors.slice(0, 3).join('; ') };
  } catch (err) {
    await env.CONFIG_KV.put(kvKey, JSON.stringify({ attemptedAt: now.toISOString(), ok: false } satisfies AutoRecoverEpisode));
    return { attempted: true, ok: false, error: (err as Error).message };
  }
}

interface LivenessAlarmEpisode {
  status: string;
  notifiedAt: string;
}

/**
 * 2026-09-21 — Per-source polling heartbeat watchdog. Companion to
 * sweepLivenessAlarms. The liveness check fires when the LAST poll attempt
 * was a success but old, but it CANNOT fire when the tick never gets to
 * call the watcher in the first place (the 2026-09-20 06:00–13:00 UTC
 * outage class — all three chambers went dark because the cron tick was
 * stuck, not because their last attempt failed). This watchdog reads
 * source_attempts directly: if a chamber has gone >N minutes without ANY
 * attempt, emit a Pushover alarm (priority 1) AND a Sentry breadcrumb so
 * the operator sees the failure class immediately.
 *
 * Thresholds:
 *   weekday (UTC Mon-Fri 12:00–24:00 ET): 240 min (4h) — past the hourly
 *     floor + the FMP retry envelope, so a missed probe is real, not
 *     transient.
 *   weekend (UTC Sat-Sun, plus federal holidays): 480 min (8h) — matches
 *     the documented "Executive follows the same adaptive probeSchedule
 *     as House/Senate (weekday coverage floor 15 min; weekend hourly)"
 *     policy so a weekend pause does not page spuriously.
 *
 * Episode semantics: same one-notification-per-episode as the liveness
 * sweep (6h renotify). Re-notifies only when the heartbeat is still
 * broken; clears the KV key on recovery.
 *
 * Tunable via env:
 *   CT_POLLING_HEARTBEAT_WEEKDAY_MIN (default 240)
 *   CT_POLLING_HEARTBEAT_WEEKEND_MIN (default 480)
 */
const HEARTBEAT_RENOTIFY_MS = LIVENESS_RENOTIFY_MS;
const HEARTBEAT_KV_PREFIX = 'polling-heartbeat:';
const WEEKDAY_UTC_HOURS: ReadonlySet<number> = new Set([
  // 12:00 UTC = 07:00 ET (Mon-Fri market morning) through 24:00 UTC = 19:00 ET.
  // Federal holidays are not modeled here; if a holiday happens to land on
  // a weekday, the operator gets a soft alarm that pages the same way
  // (priority 0 silent-notify path) when the chamber comes back, and they
  // can mark it manually if needed.
  12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
]);

export async function sweepPollingHeartbeat(
  env: Env,
  now = new Date(),
  deps: { push?: typeof sendPushover } = {},
): Promise<PollingHeartbeatResult> {
  const push = deps.push ?? sendPushover;
  const result: PollingHeartbeatResult = { evaluated: 0, alerted: [], ageBySource: { house: null, senate: null, executive: null } };
  const sources: ReadonlyArray<'house' | 'senate' | 'executive'> = ['house', 'senate', 'executive'];

  // Single query: per-source MAX(attempted_at). source_attempts is
  // append-only and small (bounded by retention sweep); an index on
  // (source, attempted_at DESC) would make this trivial, but a single
  // GROUP BY scan on the 24h subset is already cheap.
  let rows: Array<{ source: string; last_attempt: string | null }> = [];
  try {
    rows = await all<{ source: string; last_attempt: string | null }>(
      env.DB,
      `SELECT CASE WHEN lower(source) IN ('oge', 'exec') THEN 'executive' ELSE source END AS source,
              MAX(attempted_at) AS last_attempt
         FROM source_attempts
        WHERE attempted_at >= datetime('now', '-48 hours')
        GROUP BY 1`,
    );
  } catch {}
  const lastBySource = new Map<string, string | null>(rows.map((r) => [r.source, r.last_attempt]));

  const utcHour = now.getUTCHours();
  const isWeekday = now.getUTCDay() >= 1 && now.getUTCDay() <= 5 && WEEKDAY_UTC_HOURS.has(utcHour);
  const maxAgeMinDefault = isWeekday ? 240 : 480;
  // Env access guarded so vitest (Node) tests don't ReferenceError on Deno.
  const envGet = (k: string): string | undefined => {
    try { return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(k); }
    catch { return undefined; }
  };
  const maxAgeMin = (() => {
    const envKey = isWeekday ? 'CT_POLLING_HEARTBEAT_WEEKDAY_MIN' : 'CT_POLLING_HEARTBEAT_WEEKEND_MIN';
    const n = Number.parseInt(envGet(envKey) || '', 10);
    return Number.isFinite(n) && n >= 5 ? Math.min(n, 1440) : maxAgeMinDefault;
  })();

  for (const src of sources) {
    result.evaluated += 1;
    const lastAttempt = lastBySource.get(src);
    if (!lastAttempt) {
      // No attempt recorded at all in the last 48h — definitely stale.
      result.ageBySource[src] = 48 * 3600;
    } else {
      const ageMs = now.getTime() - Date.parse(lastAttempt);
      result.ageBySource[src] = Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 1000)) : null;
    }
    const ageSec = result.ageBySource[src];
    if (ageSec == null) continue;
    if (ageSec < maxAgeMin * 60) continue; // still within heartbeat window

    // Heartbeat is broken. Episode semantics: notify on edge, renotify at
    // most every 6h. Same pattern as sweepLivenessAlarms so the operator
    // sees a consistent cadence.
    const kvKey = `${HEARTBEAT_KV_PREFIX}${src}`;
    let episode: { attemptedAt: string } | null = null;
    try {
      episode = await env.CONFIG_KV.get<{ attemptedAt: string }>(kvKey, 'json');
    } catch {}
    const lastNotifiedMs = episode ? Date.parse(episode.attemptedAt) : NaN;
    const renotifyDue = !Number.isFinite(lastNotifiedMs) || now.getTime() - lastNotifiedMs >= HEARTBEAT_RENOTIFY_MS;
    if (!renotifyDue) continue;

    const hours = (ageSec / 3600).toFixed(1);
    const isWeekendStr = isWeekday ? 'weekday' : 'weekend';
    const title = `CT WATCHDOG: ${src} polling silent for ${hours}h`;
    const message = [
      `${src} chamber has had ZERO source_attempts rows in the last ${hours} hours`,
      `(threshold ${maxAgeMin} min, ${isWeekendStr} window).`,
      `Most likely root cause: Deno cron tick is stuck (force-release via CT_TICK_STUCK_MINUTES=10`,
      `already shipped, board 14dac466 follow-up).`,
      ``,
      `Verify: GET https://congress.trade/api/admin/sources/health`,
    ].join(' ');

    try {
      const delivered = await push(env, {
        title,
        message,
        priority: 1, // wake the phone — silent polling is the same class as a crash
        url: 'https://congress.trade/api/admin/sources/health',
        urlTitle: 'Source health',
      });
      if (delivered.sent) {
        result.alerted.push(src);
        await env.CONFIG_KV.put(kvKey, JSON.stringify({ attemptedAt: now.toISOString() }));
      } else {
        console.error('sweepPollingHeartbeat: alarm NOT delivered for', src, '-', delivered.reason ?? 'unknown reason');
      }
      sentryLoggerWarn('polling.heartbeat_silent', {
        runtime: 'deno',
        source: src,
        ageSec,
        thresholdMin: maxAgeMin,
        weekday: isWeekday,
      });
    } catch (err) {
      console.error('sweepPollingHeartbeat: pushover failed for', src, (err as Error).message);
    }
  }

  // Recovery: any source whose heartbeat came back inside the window clears
  // its episode so a future break sends a fresh edge-notify. Done in one
  // short pass over the KV prefix. (KV doesn't have native prefix listing,
  // but the source list is bounded to 3 keys so we just GET each.)
  for (const src of sources) {
    const ageSec = result.ageBySource[src];
    if (ageSec == null || ageSec >= maxAgeMin * 60) continue;
    const kvKey = `${HEARTBEAT_KV_PREFIX}${src}`;
    let episode: { attemptedAt: string } | null = null;
    try {
      episode = await env.CONFIG_KV.get<{ attemptedAt: string }>(kvKey, 'json');
    } catch {}
    if (!episode) continue;
    try {
      await push(env, {
        title: `CT recovered: ${src} polling resumed`,
        message: `${src} has a fresh source_attempts row (age ${ageSec}s, threshold ${maxAgeMin} min).`,
        priority: 0,
      });
    } catch { /* best-effort */ }
    try { await env.CONFIG_KV.delete(kvKey); } catch {}
  }

  return result;
}

/**
 * Owner directive 2026-08-10: polling can never be silently off for any
 * chamber, and latency monitoring can never be silently off. The
 * polling_house/senate/executive + latency_probes pipelineHealth checks make
 * silence VISIBLE; this sweep makes it LOUD — a Pushover to the owner's
 * phone, not just a row on an admin page nobody is staring at.
 *
 * Episode semantics (matches the fleet's one-notification-per-episode
 * precedent): notify on ok->bad transition, re-notify at most every 6h while
 * still bad, send a recovery note and clear the episode on bad->ok. Episodes
 * live in CONFIG_KV so restarts/redeploys never replay an alarm storm.
 */
export async function sweepLivenessAlarms(
  env: Env,
  now = new Date(),
  deps: {
    checkHealth?: typeof checkPipelineHealth;
    push?: typeof sendPushover;
  } = {},
): Promise<LivenessAlarmResult> {
  const checkHealth = deps.checkHealth ?? checkPipelineHealth;
  const push = deps.push ?? sendPushover;
  const result: LivenessAlarmResult = { evaluated: 0, bad: 0, notified: [], recovered: [] };

  const health = await checkHealth(env, now);
  const nowIso = now.toISOString();
  for (const check of health.checks) {
    if (!LIVENESS_ALARM_CHECK_IDS.has(check.id)) continue;
    result.evaluated += 1;
    const kvKey = `${LIVENESS_ALARM_KV_PREFIX}${check.id}`;
    let episode: LivenessAlarmEpisode | null = null;
    try {
      episode = await env.CONFIG_KV.get<LivenessAlarmEpisode>(kvKey, 'json');
    } catch {}

    const isBad = check.status === 'stalled' || check.status === 'degraded' || check.status === 'critical';
    if (isBad) {
      result.bad += 1;

      // Self-heal path: critical/stalled price_freshness gets an inline
      // runPriceRefresh attempt before we page. See maybeAutoRecoverPrice.
      if (check.status === 'critical' || check.status === 'stalled') {
        try {
          const recovered = await maybeAutoRecoverPrice(env, now, check);
          if (recovered?.attempted) {
            console.log('sweepLivenessAlarms: auto-recover', check.id, recovered.ok ? 'ok' : 'failed', recovered.error ?? '');
          }
        } catch (err) {
          console.error('sweepLivenessAlarms: auto-recover threw', check.id, (err as Error).message);
        }
      }

      const statusChanged = !episode || episode.status !== check.status;
      const lastNotifiedMs = episode ? Date.parse(episode.notifiedAt) : NaN;
      const renotifyDue = !Number.isFinite(lastNotifiedMs)
        || now.getTime() - lastNotifiedMs >= LIVENESS_RENOTIFY_MS;
      if (statusChanged || renotifyDue) {
        // sendPushover NEVER throws — it returns {sent:false, reason} on
        // unconfigured creds / HTTP failure / API rejection. The episode is
        // recorded ONLY on confirmed delivery, so an undelivered alarm
        // retries on the next hourly sweep instead of silently counting as
        // notified — a silently-dead alarm channel would recreate the exact
        // failure class this sweep exists to kill.
        try {
          // Tier mapping: critical → priority 1 (same as stalled) so the
          // phone wakes for a structural break. degraded → priority 0
          // (silent notify, no sound) so a weekend price lag doesn't page.
          const isLoud = check.status === 'stalled' || check.status === 'critical';
          const delivered = await push(env, {
            title: `CT ${isLoud ? 'DOWN' : 'DEGRADED'}: ${check.id.replace(/_/g, ' ')}`,
            message: check.detail,
            priority: isLoud ? 1 : 0,
            url: 'https://congress.trade/api/health',
            urlTitle: 'Pipeline health',
          });
          if (delivered.sent) {
            result.notified.push(check.id);
            await env.CONFIG_KV.put(kvKey, JSON.stringify({ status: check.status, notifiedAt: nowIso }));
          } else {
            console.error('sweepLivenessAlarms: alarm NOT delivered for', check.id, '-', delivered.reason ?? 'unknown reason');
          }
        } catch (err) {
          console.error('sweepLivenessAlarms: pushover failed for', check.id, (err as Error).message);
        }
      }
    } else if (check.status === 'ok' && episode) {
      // bad -> ok: say so once, then clear the episode. 'unknown' (signal
      // collection failed this cycle) deliberately does NOT clear or notify —
      // a DB blip mid-outage must not send a lying "recovered" note and then
      // re-alarm when collection resumes.
      try {
        const delivered = await push(env, {
          title: `CT recovered: ${check.id.replace(/_/g, ' ')}`,
          message: check.detail,
          priority: 0,
        });
        if (delivered.sent) {
          result.recovered.push(check.id);
          await env.CONFIG_KV.delete(kvKey);
        } else {
          console.error('sweepLivenessAlarms: recovery NOT delivered for', check.id, '-', delivered.reason ?? 'unknown reason');
        }
      } catch (err) {
        console.error('sweepLivenessAlarms: recovery pushover failed for', check.id, (err as Error).message);
      }
    }
  }
  return result;
}

export interface ProviderOnlyStubSweepResult {
  cleared: number;
  /** Stub filings moved to verified_empty alongside their review close. */
  filingsUpdated: number;
}

/**
 * Provider-only placeholder review rows (tradeLatency.ts
 * routeProviderOnlyObservationsToReview) are synthetic leads: the filing row
 * has raw_object_key IS NULL because nothing was ever fetched to extract, so
 * such a row can never gain a live transaction. The honest terminal state for
 * one is verified_empty / provider_only_lead_cleared.
 *
 * That close used to live ONLY in the deploy-time migration statement list, so
 * between deploys every new provider-only observation piled up in the admin
 * review queue (and fired the Publisher review_queue.entered webhook) until
 * the next ship re-ran migrations. This sweep applies the exact same terminal
 * state hourly, bounded and idempotent, so the next similar row closes itself.
 *
 * The stub's filing row is moved to verified_empty in the same batch.  Its
 * filings.error is cleared, except the provider-only raw-key marker on a stub
 * whose review payload was truncated to invalid JSON: that marker is the only
 * untruncated raw key the later official-side reconcile can match on.
 * reviewStatusReconcile.ts deliberately skips provider-missing-* docs, so
 * nothing else would ever bring the synthetic filing out of needs_review.
 * The filing step also heals stubs the deploy-time migration closed earlier
 * without touching their filing.
 *
 * The official-counterpart case (an official filing now exists) is left to
 * providerMissingStubClose.ts, which rejects the stub as a duplicate when the
 * provider observation is reprocessed or when the hourly
 * reconcileProviderMissingStubsWithOfficial pass finds a persisted counterpart
 * — this sweep never invents that verdict, and both paths still override this
 * sweep's verified_empty close if the official filing lands later. review_revision is bumped so a concurrent
 * duplicate rejection that read the pre-sweep revision no-ops cleanly.
 * Rows with stored raw bytes or a live transaction are excluded so a real
 * filing that happens to carry this reason is never swept.
 */
export async function sweepProviderOnlyReviewStubs(
  env: Env,
  opts: { limit?: number } = {},
): Promise<ProviderOnlyStubSweepResult> {
  const limit = opts.limit ?? 500;
  const statusPlaceholders = DESYNCED_INGEST_STATUSES.map(() => '?').join(',');
  const results = await batch(env.DB, [
    [
      `UPDATE review_queue
          SET resolved = 1,
              resolution_kind = 'verified_empty',
              resolution_reason = ?,
              resolved_at = CURRENT_TIMESTAMP,
              review_revision = review_revision + 1
        WHERE resolved = 0
          AND reason = 'provider_discovered_missing_official'
          AND doc_id IN (
            SELECT rq.doc_id
              FROM review_queue rq
              LEFT JOIN filings f ON f.doc_id = rq.doc_id
             WHERE rq.resolved = 0
               AND rq.reason = 'provider_discovered_missing_official'
               AND (f.raw_object_key IS NULL OR f.raw_object_key = '')
               AND NOT EXISTS (
                 SELECT 1 FROM transactions t
                  WHERE t.doc_id = rq.doc_id AND t.deprecated_at IS NULL
               )
             ORDER BY rq.created_at ASC
             LIMIT ?
          )`,
      [PROVIDER_ONLY_LEAD_CLEARED_REASON, limit],
    ],
    [
      `UPDATE filings
          SET ingest_status = 'verified_empty',
              -- Keep the provider-only:{provider}:{raw key} marker when the
              -- review payload is truncated (invalid) JSON: it is then the only
              -- untruncated copy of the raw provider key, and the hourly
              -- reconcileProviderMissingStubsWithOfficial needs it for the exact
              -- trade_latency_candidates.provider_key match on hashed keys.
              error = CASE
                        WHEN error LIKE 'provider-only:%'
                          AND EXISTS (
                            SELECT 1 FROM review_queue rqp
                             WHERE rqp.doc_id = filings.doc_id
                               AND rqp.reason = 'provider_discovered_missing_official'
                               AND NOT json_valid(COALESCE(rqp.payload, ''))
                          )
                        THEN error
                        ELSE NULL
                      END
        WHERE doc_id IN (
          SELECT f.doc_id
            FROM filings f
            JOIN review_queue rq ON rq.doc_id = f.doc_id
           WHERE rq.resolved = 1
             AND rq.reason = 'provider_discovered_missing_official'
             AND rq.resolution_kind = 'verified_empty'
             AND rq.resolution_reason = ?
             AND f.ingest_status IN (${statusPlaceholders})
             AND (f.raw_object_key IS NULL OR f.raw_object_key = '')
             AND NOT EXISTS (
               SELECT 1 FROM transactions t
                WHERE t.doc_id = f.doc_id AND t.deprecated_at IS NULL
             )
           LIMIT ?
        )`,
      [PROVIDER_ONLY_LEAD_CLEARED_REASON, ...DESYNCED_INGEST_STATUSES, limit],
    ],
  ]);
  return {
    cleared: results[0]?.meta?.changes ?? 0,
    filingsUpdated: results[1]?.meta?.changes ?? 0,
  };
}

export interface AlreadyPublishedReviewSweepResult {
  cleared: number;
  /** Filings stamped to persisted alongside their review close. */
  filingsUpdated: number;
}

/** Terminal reason written when an open review row is closed as already published. */
export const ALREADY_PUBLISHED_REVIEW_REASON = 'reconciled_published';

/** Transaction sources that count as a live published read. */
const LIVE_PUBLISHED_TX_SOURCES_SQL = `('primary','manual','local_mac','server_cpu')`;

/** Ingestion-decision actions that prove the doc already published. */
const PUBLISH_DECISION_ACTIONS_SQL = `('auto_published','confirmed','manual','agreement_published')`;

/**
 * A review row can outlive the publish it was created for: the publish path
 * records an `auto_published` decision and inserts live transactions, but its
 * `UPDATE review_queue ... WHERE ... review_revision = ?` no-ops when the
 * revision drifted between the read and the write (observed 2026-09-24:
 * H-2026-9116292 auto_published tx:11 on 2026-08-18 yet still pending at
 * review_revision 4; 15 `form_chrome_only,ocr_unusable` scanned_pdf rows total).
 *
 * Such a row can never be honestly re-decided through the admin API: `reject`
 * deprecates the live published transactions, and `confirm` needs edits the
 * empty review payload does not have. This sweep closes it the only honest way
 * — as already published — but ONLY when both independent pieces of evidence
 * exist: a live non-deprecated transaction AND a recorded publish decision for
 * the same doc. A row with no live transaction, an explicit `unpublished:`
 * reopen, an agreement-cascade dispute, or a provider-only placeholder is left
 * untouched, so this never bulk-resolves real work.
 *
 * Bounded, idempotent, safe to run hourly/concurrently; the review_revision
 * bump makes a concurrent admin decision that read the pre-sweep revision
 * no-op cleanly.
 */
export const ALREADY_PUBLISHED_CASCADE_REASON = 'reconciled_published_after_local_mac';

/** Ingest statuses the already-published close may stamp back to persisted. */
const ALREADY_PUBLISHED_FILING_STATUSES = [
  ...DESYNCED_INGEST_STATUSES,
  // Cascade orphans often sit at filings.ingest_status='error' after a prior
  // reject, even though local_mac later published live rows.
  'error',
] as const;

export async function sweepAlreadyPublishedReviewRows(
  env: Env,
  opts: {
    limit?: number;
    /** When true, also close agreement_cascade_unresolved rows that still have
     *  live published txs + a publish decision (local_mac won after cascade). */
    includeAgreementCascade?: boolean;
  } = {},
): Promise<AlreadyPublishedReviewSweepResult> {
  const limit = opts.limit ?? 500;
  const includeAgreementCascade = opts.includeAgreementCascade === true;
  const cascadeClause = includeAgreementCascade
    ? ''
    : `AND COALESCE(rq.reason, '') NOT LIKE '%agreement_cascade%'`;
  const statusPlaceholders = ALREADY_PUBLISHED_FILING_STATUSES.map(() => '?').join(',');
  // When includeAgreementCascade is on, the same UPDATE can close both
  // cascade and non-cascade rows. Stamp the cascade-specific audit reason
  // only on cascade rows so non-cascade closes stay reconciled_published.
  const filingReasons = includeAgreementCascade
    ? [ALREADY_PUBLISHED_REVIEW_REASON, ALREADY_PUBLISHED_CASCADE_REASON]
    : [ALREADY_PUBLISHED_REVIEW_REASON];
  const filingReasonPlaceholders = filingReasons.map(() => '?').join(',');
  const results = await batch(env.DB, [
    [
      `UPDATE review_queue
          SET resolved = 1,
              resolution_kind = 'published',
              resolution_reason = CASE
                WHEN COALESCE(reason, '') LIKE '%agreement_cascade%'
                  THEN ?
                ELSE ?
              END,
              resolved_at = CURRENT_TIMESTAMP,
              review_revision = review_revision + 1
        WHERE resolved = 0
          AND doc_id IN (
            SELECT rq.doc_id
              FROM review_queue rq
             WHERE rq.resolved = 0
               AND COALESCE(rq.reason, '') NOT LIKE '%unpublished%'
               ${cascadeClause}
               AND COALESCE(rq.reason, '') NOT LIKE '%provider_discovered_missing_official%'
               AND EXISTS (
                 SELECT 1 FROM transactions t
                  WHERE t.doc_id = rq.doc_id
                    AND t.deprecated_at IS NULL
                    AND t.source IN ${LIVE_PUBLISHED_TX_SOURCES_SQL}
               )
               AND EXISTS (
                 SELECT 1 FROM ingestion_decisions d
                  WHERE d.doc_id = rq.doc_id
                    AND d.action IN ${PUBLISH_DECISION_ACTIONS_SQL}
               )
             ORDER BY rq.created_at ASC
             LIMIT ?
          )`,
      [ALREADY_PUBLISHED_CASCADE_REASON, ALREADY_PUBLISHED_REVIEW_REASON, limit],
    ],
    [
      `UPDATE filings
          SET ingest_status = 'persisted',
              error = NULL
        WHERE doc_id IN (
          SELECT f.doc_id
            FROM filings f
            JOIN review_queue rq ON rq.doc_id = f.doc_id
           WHERE rq.resolved = 1
             AND rq.resolution_kind = 'published'
             AND rq.resolution_reason IN (${filingReasonPlaceholders})
             AND f.ingest_status IN (${statusPlaceholders})
             AND EXISTS (
               SELECT 1 FROM transactions t
                WHERE t.doc_id = f.doc_id
                  AND t.deprecated_at IS NULL
                  AND t.source IN ${LIVE_PUBLISHED_TX_SOURCES_SQL}
             )
           LIMIT ?
        )`,
      [...filingReasons, ...ALREADY_PUBLISHED_FILING_STATUSES, limit],
    ],
  ]);
  return {
    cleared: results[0]?.meta?.changes ?? 0,
    filingsUpdated: results[1]?.meta?.changes ?? 0,
  };
}

/** Read-only preview of docs the already-published sweep would close. */
export async function listAlreadyPublishedReviewCandidates(
  env: Env,
  opts: { limit?: number; includeAgreementCascade?: boolean } = {},
): Promise<Array<{ docId: string; reason: string | null; liveTxCount: number }>> {
  const limit = opts.limit ?? 500;
  const includeAgreementCascade = opts.includeAgreementCascade === true;
  const cascadeClause = includeAgreementCascade
    ? ''
    : `AND COALESCE(rq.reason, '') NOT LIKE '%agreement_cascade%'`;
  const rows = await all<{ doc_id: string; reason: string | null; live_n: number }>(
    env.DB,
    `SELECT rq.doc_id AS doc_id,
            rq.reason AS reason,
            (SELECT COUNT(*) FROM transactions t
              WHERE t.doc_id = rq.doc_id
                AND t.deprecated_at IS NULL
                AND t.source IN ${LIVE_PUBLISHED_TX_SOURCES_SQL}) AS live_n
       FROM review_queue rq
      WHERE rq.resolved = 0
        AND COALESCE(rq.reason, '') NOT LIKE '%unpublished%'
        ${cascadeClause}
        AND COALESCE(rq.reason, '') NOT LIKE '%provider_discovered_missing_official%'
        AND EXISTS (
          SELECT 1 FROM transactions t
           WHERE t.doc_id = rq.doc_id
             AND t.deprecated_at IS NULL
             AND t.source IN ${LIVE_PUBLISHED_TX_SOURCES_SQL}
        )
        AND EXISTS (
          SELECT 1 FROM ingestion_decisions d
           WHERE d.doc_id = rq.doc_id
             AND d.action IN ${PUBLISH_DECISION_ACTIONS_SQL}
        )
      ORDER BY rq.created_at ASC
      LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({
    docId: r.doc_id,
    reason: r.reason,
    liveTxCount: Number(r.live_n) || 0,
  }));
}

/**
 * Entry point wired hourly from deno/cronLanes.ts. Each sweep is isolated —
 * one failing does not block the others — and every sweep is itself bounded
 * and idempotent, so overlap between two concurrent runs is harmless (a run
 * that finds nothing left to do is a cheap no-op).
 */
export async function runAutonomySweeps(
  env: Env,
  now = new Date(),
  opts: { signal?: AbortSignal } = {},
): Promise<AutonomySweepResult & {
  deterministicDrain: DeterministicDrainResult | null;
  localVisionRequeue: LocalVisionRequeueResult | null;
  hostedFallback: LocalVisionHostedFallbackResult | null;
}> {
  const errors: string[] = [];
  const result: AutonomySweepResult & {
    deterministicDrain: DeterministicDrainResult | null;
    localVisionRequeue: LocalVisionRequeueResult | null;
    hostedFallback: LocalVisionHostedFallbackResult | null;
  } = {
    ceiling: null,
    stranded: null,
    resolvedDesync: null,
    providerOnlyStubs: null,
    providerStubOfficialReconcile: null,
    alreadyPublished: null,
    filedDateBackfill: null,
    ogeUndated: null,
    livenessAlarms: null,
    deterministicDrain: null,
    localVisionRequeue: null,
    hostedFallback: null,
    pollingHeartbeat: null,
    executiveTerminals: null,
    errors,
  };
  const throwIfAborted = () => {
    if (opts.signal?.aborted) throw new Error('autonomy sweeps aborted');
  };

  // A2 first: free deterministic publish must not wait on OR-halted autopilot.
  try {
    throwIfAborted();
    result.deterministicDrain = await maybeRunDeterministicReviewDrain(env, {
      signal: opts.signal,
    });
    try {
      const { maybePublishFromStoredRuns } = await import('../extraction/storedRunPublish.ts');
      await maybePublishFromStoredRuns(env, { signal: opts.signal });
    } catch (storedErr) {
      errors.push(`storedRunPublish: ${(storedErr as Error).message}`);
    }
  } catch (err) {
    errors.push(`deterministicDrain: ${(err as Error).message}`);
  }

  try {
    throwIfAborted();
    result.ceiling = await sweepExtractionPendingLocalCeiling(env, now);
  } catch (err) {
    errors.push(`ceiling: ${(err as Error).message}`);
  }

  try {
    throwIfAborted();
    result.stranded = await sweepStrandedFilings(env, now);
  } catch (err) {
    errors.push(`stranded: ${(err as Error).message}`);
  }

  // Reject stubs whose official filing has persisted since (including ones the
  // provider feed no longer serves) before the verified_empty sweep below, so a
  // stub with a known official counterpart gets the duplicate verdict instead.
  try {
    throwIfAborted();
    result.providerStubOfficialReconcile = await reconcileProviderMissingStubsWithOfficial(env, { now });
  } catch (err) {
    errors.push(`providerStubOfficialReconcile: ${(err as Error).message}`);
  }

  // Close provider-only placeholder stubs before the desync reconcile below,
  // so reconcileResolvedReviewStatus can stamp their synthetic filing's
  // ingest_status to verified_empty in the same run.
  try {
    throwIfAborted();
    result.providerOnlyStubs = await sweepProviderOnlyReviewStubs(env);
  } catch (err) {
    errors.push(`providerOnlyStubs: ${(err as Error).message}`);
  }

  // Close review rows that outlived the publish they were opened for (the
  // publish path's review UPDATE no-ops when review_revision drifted), before
  // the desync reconcile runs. Evidence-gated: live tx + a publish decision.
  try {
    throwIfAborted();
    result.alreadyPublished = await sweepAlreadyPublishedReviewRows(env);
  } catch (err) {
    errors.push(`alreadyPublished: ${(err as Error).message}`);
  }

  try {
    throwIfAborted();
    result.resolvedDesync = await sweepResolvedStatusDesync(env, now);
  } catch (err) {
    errors.push(`resolvedDesync: ${(err as Error).message}`);
  }

  try {
    throwIfAborted();
    result.filedDateBackfill = await sweepFiledDateBackfill(env, now, { signal: opts.signal });
  } catch (err) {
    errors.push(`filedDateBackfill: ${(err as Error).message}`);
  }

  try {
    throwIfAborted();
    result.ogeUndated = await sweepOgeUndatedFilingDates(env);
  } catch (err) {
    errors.push(`ogeUndated: ${(err as Error).message}`);
  }

  // Close the two parked executive rows: empty 278e vs unreadable 278-T.
  // Allowlist, idempotent, no PDF refetch.
  try {
    throwIfAborted();
    result.executiveTerminals = await sweepKnownParkedExecutiveTerminals(env, now);
  } catch (err) {
    errors.push(`executiveTerminals: ${(err as Error).message}`);
  }

  // A5/C8: one-shot local-vision requeue for rejected scanned+raw garbage OCR.
  try {
    throwIfAborted();
    result.localVisionRequeue = await sweepRejectedScannedForLocalVision(env);
  } catch (err) {
    errors.push(`localVisionRequeue: ${(err as Error).message}`);
  }

  try {
    throwIfAborted();
    result.hostedFallback = await sweepLocalVisionHostedFallback(env);
  } catch (err) {
    errors.push(`hostedFallback: ${(err as Error).message}`);
  }

  try {
    throwIfAborted();
    result.livenessAlarms = await sweepLivenessAlarms(env, now);
  } catch (err) {
    errors.push(`livenessAlarms: ${(err as Error).message}`);
  }

  // 2026-09-21: per-source polling heartbeat watchdog. The liveness-alarm
  // sweep fires Pushover when a check is `stalled`/`critical`/`degraded`,
  // but the existing `polling_house/senate/executive` checks only look at
  // whether the LAST poll ATTEMPT was successful — they cannot tell the
  // difference between "a poll just succeeded with 0 new rows" and "no poll
  // has been ATTEMPTED in the last 7 hours". This watchdog watches
  // source_attempts directly: if a chamber has gone 4+ hours (weekday) or
  // 8+ hours (weekend) without ANY attempt, emit a Sentry alarm AND a
  // Pushover so the operator sees the failure class BEFORE the next day.
  // Tunable via CT_POLLING_HEARTBEAT_MAX_AGE_MIN (default: weekday 240 / weekend 480).
  try {
    throwIfAborted();
    result.pollingHeartbeat = await sweepPollingHeartbeat(env, now);
  } catch (err) {
    errors.push(`pollingHeartbeat: ${(err as Error).message}`);
  }

  return result;
}
