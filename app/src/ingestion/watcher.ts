/**
 * src/ingestion/watcher.ts
 * OWNER: ingestion agent
 *
 * Cron entrypoint logic. Runs every minute; decides via decideSourcePoll (which
 * consults the measured cadence in probeSchedule.ts, falling back to the legacy
 * poll_config windows) whether to actually poll House, Senate, and Executive
 * (OGE) disclosure indexes. For each NEW filing,
 * inserts a 'new' filings row (INSERT OR IGNORE) and enqueues a
 * {type:'filing.new'} INGEST_QUEUE message. Records cadence in ingest_log and
 * updates last-poll via setLastPollAt after successful source polls.
 *
 * Each source is wrapped in its own try/catch: one source failing (network,
 * parse, anti-bot) must NOT block the other, and the failure is logged.
 */

import type { Chamber, Env } from '../shared/types.ts';
import { all, batch, get, isSqliteLockBusy, run, withSqliteLockRetry } from '../shared/db.ts';
import { sameFilerIdentity } from '../shared/filerIdentityMatch.ts';
import {
  getConfig,
  getLastAttemptAt,
  getLastPollAt,
  setLastAttemptAt,
  setLastPollAt,
  shouldPollNow,
} from '../shared/config.ts';
import type { PollConfig } from '../shared/types.ts';
import {
  DEFAULT_PROBE_SCHEDULE_CONFIG,
  probeScheduleConfigFromEnv,
  shouldProbeNow,
  type DayType,
  type ProbeScheduleConfig,
  type ProbeTier,
} from './probeSchedule.ts';
import { logProbeCadence, type ProbeCadenceAuthority } from './probeCadenceLog.ts';
import { fetchHouseIndex, pollHouseLiveSearch } from './houseSource.ts';
import { fetchSenatePtrFilings } from './senateSource.ts';
import { refreshSenateRelayHealth } from './senateRelayHealth.ts';
import { recordDisclosureLatencyCandidate, storageMissing } from './tradeLatency.ts';
import { enqueueIngestionOutboxNow, ingestionOutboxInsertForDoc } from './outbox.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { pollOgeExecutive } from './ogeSource.ts';
import { consumeGovernedD1Writes } from '../shared/d1Budget.ts';
import { cleanFilerName } from '../extraction/nameNormalizer.ts';

/** Env shape (read defensively — Env is the frozen foundation contract). */
type EnvWithFlags = Env & { HOUSE_LIVE_SEARCH_ENABLED?: string };

/** Live House search is on unless explicitly disabled (fail-soft, and
 *  Infisical-tunable so it can be toggled without a redeploy). */
async function houseLiveSearchEnabled(env: Env): Promise<boolean> {
  try {
    const live = (await resolveSecret(env, 'HOUSE_LIVE_SEARCH_ENABLED')).value;
    return (live ?? (env as EnvWithFlags).HOUSE_LIVE_SEARCH_ENABLED) !== 'false';
  } catch {
    return (env as EnvWithFlags).HOUSE_LIVE_SEARCH_ENABLED !== 'false';
  }
}

/**
 * Resolve an integer tunable (Infisical first, env var fallback — resolveSecret
 * already implements that ordering) clamped to [min, max]. Fail-soft: any
 * resolution error falls back to the env var, then the default. Never throws —
 * a secrets outage must not change polling behavior beyond using defaults.
 */
async function tunableInt(
  env: Env,
  key: keyof Env & string,
  fallback: number,
  min: number,
  max: number,
): Promise<number> {
  let raw: string | undefined;
  try {
    raw = (await resolveSecret(env, key)).value;
  } catch {
    const envValue = env[key];
    raw = typeof envValue === 'string' ? envValue : undefined;
  }
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** One row to (maybe) insert + enqueue. */
export interface DiscoveredFiling {
  docId: string;
  chamber: Chamber;
  sourceUrl: string;
  /** Official filing/report date when the source index provides it. */
  filedDate?: string | null;
  filerId?: string | null;
  filerName?: string | null;
  state?: string | null;
  district?: string | null;
  /** Curated party/portrait metadata (executive filers only — the House/Senate
   *  indexes carry neither; those columns are enriched out-of-band). */
  party?: string | null;
  photoUrl?: string | null;
  docKind?: string | null;
}

export function preclassifyDocKind(
  sourceUrl: string,
  chamber?: Chamber | string | null,
  contentType?: string | null,
): string {
  const url = (sourceUrl || '').toLowerCase();
  const cType = (contentType || '').toLowerCase();

  if (
    chamber === 'senate' &&
    (url.includes('/search/view/') || url.endsWith('.html') || cType.includes('text/html'))
  ) {
    return 'senate_html';
  }
  if (url.includes('scanned') || url.includes('paper') || cType.includes('scanned')) {
    return 'scanned_pdf';
  }
  if (
    url.endsWith('.pdf') ||
    url.includes('/ptr-pdfs/') ||
    url.includes('pdf') ||
    cType.includes('application/pdf') ||
    chamber === 'house'
  ) {
    return 'text_pdf';
  }
  return 'unknown';
}

function normalizeFilingDate(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  return s.slice(0, 10);
}

function slugPart(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function houseFilerId(first: string, last: string, stateDst: string): string | null {
  // Run through cleanFilerName so curated aliases (Rohit→Ro Khanna) mint the
  // durable house slug (house-ca17-ro-khanna) instead of a legal-name fork.
  const cleaned = cleanFilerName([first, last].filter(Boolean).join(' '));
  const name = slugPart(cleaned || [first, last].filter(Boolean).join(' '));
  if (!name) return null;
  const district = slugPart(stateDst || 'house');
  return `house-${district}-${name}`;
}

/**
 * Mint a stable synthetic filer id for a Senate PTR. The Senate feed (unlike the
 * House index) carries no district code, so we key on the disclosed name only.
 * Returns null when no name is available, leaving filer_id NULL rather than
 * minting a meaningless id.
 *
 * Mirrors houseFilerId so insertFilingIfNew writes the `filers` row and
 * back-fills filer_id on filings + transactions. Previously pollSenate set only
 * filerName (never filerId), so insertFilingIfNew's `if (f.filerId && f.filerName)`
 * guard skipped the filers row and every Senate trade surfaced with no member
 * attribution in the feed/API/SSE/exports.
 */
export function senateFilerId(fullName: string | null): string | null {
  // Same alias pass as house so legal-name variants collapse to one slug.
  const name = slugPart(cleanFilerName(fullName ?? '') || fullName || '');
  return name ? `senate-${name}` : null;
}

function splitStateDistrict(stateDst: string): { state: string | null; district: string | null } {
  const m = /^([A-Z]{2})(\d{1,2})$/i.exec((stateDst || '').trim());
  if (!m) return { state: null, district: null };
  return { state: m[1].toUpperCase(), district: String(Number(m[2])) };
}

function houseDiscovery(f: { pipelineDocId: string; sourceUrl: string; filingDate: string; first: string; last: string; stateDst: string }): DiscoveredFiling {
  const sd = splitStateDistrict(f.stateDst);
  const fullName = cleanFilerName([f.first, f.last].filter(Boolean).join(' ')) || null;
  return {
    docId: f.pipelineDocId,
    chamber: 'house',
    sourceUrl: f.sourceUrl,
    filedDate: f.filingDate,
    filerId: houseFilerId(f.first, f.last, f.stateDst),
    filerName: fullName,
    state: sd.state,
    district: sd.district,
  };
}

/**
 * INSERT OR IGNORE one discovered filing as a 'new' row. Returns `inserted`
 * iff the row was GENUINELY new — D1's `meta.changes` > 0 means a row was
 * actually written (we'd never seen this doc_id), with no read-back race.
 * `deferred` means the D1 write governor denied this invocation, so callers
 * must not treat the filing as an already-seen duplicate.
 *
 * This is the single source of truth for the filings-row write, shared by the
 * cron watcher (below) and the historical House backfill crawler
 * (src/backfill/houseCrawler.ts) so the INSERT column list never drifts.
 */
export type InsertFilingResult = 'inserted' | 'duplicate' | 'deferred';

/**
 * Best-effort match-time canonicalization: when a newly discovered filing's
 * synthetic filer_id (houseFilerId/senateFilerId) hasn't been seen before,
 * check whether it's a fresh middle-initial/punctuation/suffix fork of an
 * already-known filer — same chamber + state, see
 * shared/filerIdentityMatch.ts — and reuse that filer's id instead of
 * minting a brand-new `filers` row. This is what stops a NEW fork (e.g.
 * "Michael T. McCaul" landing after "Michael McCaul" is already on file)
 * from ever being created going forward. Any fork that already exists in the
 * DB is fixed by the repeatable backfill in admin/filerIdentityDedupe.ts
 * (POST /api/admin/dedupe-filer-identities).
 *
 * Two cheap, indexed lookups short-circuit the common case (an id already
 * recorded as a merge alias, or an id that's already a live filers row)
 * before the pricier chamber+state scan, which only runs for a genuinely
 * first-ever sighting of a synthetic id — rare (a new member, or a name-
 * format variance), not the steady-state poll of already-known filers.
 * `state` is frequently unknown for a brand-new Senate filer (the Senate
 * source carries no state code; photo enrichment fills it in later) — this
 * fails closed and returns the input id unchanged rather than guessing.
 */
async function resolveIngestFilerId(
  env: Env,
  filerId: string,
  fullName: string,
  chamber: Chamber,
  state: string | null | undefined,
): Promise<string> {
  const merge = await get<{ canonical_filer_id: string }>(
    env.DB,
    'SELECT canonical_filer_id FROM filer_identity_merges WHERE alias_filer_id = ?',
    [filerId],
  );
  if (merge?.canonical_filer_id) return merge.canonical_filer_id;

  const existing = await get<{ bioguide_id: string }>(
    env.DB,
    'SELECT bioguide_id FROM filers WHERE bioguide_id = ?',
    [filerId],
  );
  if (existing) return filerId;

  if (!state) return filerId;
  const candidates = await all<{ bioguide_id: string; full_name: string | null }>(
    env.DB,
    'SELECT bioguide_id, full_name FROM filers WHERE chamber = ? AND state = ? AND merged_into IS NULL',
    [chamber, state],
  );
  for (const c of candidates) {
    if (sameFilerIdentity({ fullName, chamber, state }, { fullName: c.full_name, chamber, state })) {
      return c.bioguide_id;
    }
  }
  return filerId;
}

export async function getPreviousSuccessfulSourceAttemptAt(
  env: Env,
  source: 'house' | 'senate' | 'executive',
  beforeIso: string,
): Promise<string | null> {
  try {
    const row = await get<{ attempted_at: string }>(
      env.DB,
      `SELECT attempted_at FROM source_attempts
        WHERE source = ? AND outcome = 'success' AND attempted_at < ?
        ORDER BY attempted_at DESC LIMIT 1`,
      [source, beforeIso],
    );
    return row?.attempted_at ?? null;
  } catch {
    return null;
  }
}

export async function insertFilingIfNew(
  env: Env,
  f: DiscoveredFiling,
  nowIso: string,
  opts?: { prevProbeAt?: string | null; probeIntervalSec?: number | null },
): Promise<InsertFilingResult> {
  // GOVERNOR 2: discovery upserts are a known storm writer (a source that
  // suddenly returns thousands of "new" rows, or a crawler loop). Past the
  // per-invocation governed-write cap this discovery is DEFERRED, not written:
  // the doc is rediscovered on the next poll, so nothing is lost — the storm
  // just degrades to bounded batches per invocation.
  if (consumeGovernedD1Writes(env, 'ingestion-discovery', 1) < 1) {
    console.warn('insertFilingIfNew deferred: D1 write governor cap reached', f.docId);
    return 'deferred';
  }
  const filerName = cleanFilerName(f.filerName) || null;
  const filerId = f.filerId && filerName
    ? await resolveIngestFilerId(env, f.filerId, filerName, f.chamber, f.state ?? null)
    : f.filerId ?? null;
  if (filerId && filerName) {
    if (f.party || f.photoUrl) {
      // Sources that curate party/portrait metadata (the OGE executive index)
      // upsert it so pre-existing filer rows — created before the metadata was
      // curated — pick the fields up on the next poll, not just new rows.
      await run(
        env.DB,
        `INSERT INTO filers (bioguide_id, chamber, full_name, party, state, district, committees, photo_url)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(bioguide_id) DO UPDATE SET
           party = COALESCE(excluded.party, party),
           photo_url = COALESCE(excluded.photo_url, photo_url)
         WHERE (excluded.party IS NOT NULL AND (filers.party IS NULL OR filers.party != excluded.party))
            OR (excluded.photo_url IS NOT NULL AND (filers.photo_url IS NULL OR filers.photo_url != excluded.photo_url))`,
        [filerId, f.chamber, filerName, f.party ?? null, f.state ?? null, f.district ?? null, f.photoUrl ?? null],
      );
    } else {
      await run(
        env.DB,
        `INSERT OR IGNORE INTO filers (bioguide_id, chamber, full_name, party, state, district, committees)
         VALUES (?, ?, ?, NULL, ?, ?, NULL)`,
        [filerId, f.chamber, filerName, f.state ?? null, f.district ?? null],
      );
    }
  }
  const filedDate = normalizeFilingDate(f.filedDate);
  const docKind = f.docKind ?? preclassifyDocKind(f.sourceUrl, f.chamber);
  const [res] = await batch(env.DB, [
    [
      `INSERT OR IGNORE INTO filings
       (doc_id, chamber, filer_id, filing_type, filed_date, source_url,
        raw_object_key, ingest_status, doc_kind, extractor, model_version,
        confidence, first_seen_at, source_updated_at, error, prev_probe_at, probe_interval_sec)
     VALUES (?, ?, ?, 'P', ?, ?, NULL, 'new', ?, NULL, NULL,
             NULL, ?, NULL, NULL, ?, ?)`,
      [f.docId, f.chamber, filerId ?? null, filedDate, f.sourceUrl, docKind, nowIso, opts?.prevProbeAt ?? null, opts?.probeIntervalSec ?? null],
    ],
    ingestionOutboxInsertForDoc(f.docId, nowIso),
  ]);
  // FMP history recovery deliberately uses the canonical Senate report id so
  // analytics can attribute rows to a real filing.  Do not let that
  // low-fidelity placeholder block the official source when it later becomes
  // reachable: atomically reopen only the narrowly-tagged provider seed.  The
  // outbox statement above has already created the durable fetch hand-off.
  let upgradedProviderSeed = false;
  let upgradedNotFound = false;
  if ((res.meta?.changes ?? 0) === 0) {
    const [existingRow] = await all<{ doc_id: string; ingest_status: string; extractor: string | null }>(
      env.DB,
      `SELECT doc_id, ingest_status, extractor FROM filings
        WHERE doc_id = ?
          AND raw_object_key IS NULL
        LIMIT 1`,
      [f.docId],
    );
    if (existingRow && existingRow.ingest_status === 'provider_seeded' && existingRow.extractor === 'fmp-senate-latest') {
      const upgrade = await run(
        env.DB,
        `UPDATE filings
          SET chamber = ?,
              filer_id = COALESCE(?, filer_id),
              filed_date = COALESCE(?, filed_date),
              source_url = ?,
              raw_object_key = NULL,
              ingest_status = 'new',
              doc_kind = 'unknown',
              extractor = NULL,
              model_version = NULL,
              confidence = NULL,
              first_seen_at = ?,
              prev_probe_at = COALESCE(?, prev_probe_at),
              probe_interval_sec = COALESCE(?, probe_interval_sec),
              source_updated_at = NULL,
              error = NULL
        WHERE doc_id = ?
          AND ingest_status = 'provider_seeded'
          AND extractor = 'fmp-senate-latest'
          AND raw_object_key IS NULL`,
        [
          f.chamber,
          filerId ?? null,
          filedDate,
          f.sourceUrl,
          nowIso,
          opts?.prevProbeAt ?? null,
          opts?.probeIntervalSec ?? null,
          f.docId,
        ],
      );
      upgradedProviderSeed = (upgrade.meta?.changes ?? 0) > 0;
    } else if (existingRow && (existingRow.ingest_status === 'not_found' || existingRow.ingest_status === 'failed')) {
      // Unblock official filings that collided with prior frontier-probe phantoms
      // (observed 2026-07-30 sequential burst H-2026-20035076..20035975, e.g.
      // Cisneros H-2026-20035190, Taylor H-2026-20035146 / H-2026-20035392).
      const upgrade = await run(
        env.DB,
        `UPDATE filings
          SET chamber = ?,
              filer_id = COALESCE(?, filer_id),
              filed_date = COALESCE(?, filed_date),
              source_url = ?,
              raw_object_key = NULL,
              ingest_status = 'new',
              doc_kind = ?,
              extractor = NULL,
              model_version = NULL,
              confidence = NULL,
              first_seen_at = ?,
              prev_probe_at = COALESCE(?, prev_probe_at),
              probe_interval_sec = COALESCE(?, probe_interval_sec),
              source_updated_at = NULL,
              error = NULL
        WHERE doc_id = ?
          AND ingest_status IN ('not_found', 'failed')
          AND raw_object_key IS NULL`,
        [
          f.chamber,
          filerId ?? null,
          filedDate,
          f.sourceUrl,
          docKind,
          nowIso,
          opts?.prevProbeAt ?? null,
          opts?.probeIntervalSec ?? null,
          f.docId,
        ],
      );
      if ((upgrade.meta?.changes ?? 0) > 0) {
        upgradedNotFound = true;
        // Re-arm ingestion_outbox so the fetcher picks it up
        await run(
          env.DB,
          `INSERT INTO ingestion_outbox
             (doc_id, chamber, source_url, status, attempts, available_at, last_error, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', 0, ?, NULL, ?, ?)
           ON CONFLICT(doc_id) DO UPDATE SET
             chamber = excluded.chamber,
             source_url = excluded.source_url,
             status = 'pending',
             attempts = 0,
             available_at = excluded.available_at,
             last_error = NULL,
             updated_at = excluded.updated_at`,
          [f.docId, f.chamber, f.sourceUrl, nowIso, nowIso, nowIso],
        );
        await enqueueIngestionOutboxNow(env, f.docId);
      }
    }
  }
  // Backfill filed_date when a later, richer discovery of the same doc supplies
  // one. A House PTR first seen via the intraday live search carries no
  // FilingDate (the live-search HTML omits it -> filed_date NULL); the daily bulk
  // ZIP later surfaces the same doc WITH a date, so COALESCE it in then instead
  // of leaving the row permanently dateless.
  if (filedDate) {
    await run(env.DB, 'UPDATE filings SET filed_date = ? WHERE doc_id = ? AND filed_date IS NULL', [
      filedDate,
      f.docId,
    ]);
    // Same backfill on the latency candidate row: recordDisclosureLatencyCandidate
    // only runs for genuinely-new discoveries (see persistAndEnqueue), so a
    // duplicate discovery that finally supplies a filed_date (e.g. the bulk ZIP
    // confirming a live-search-only doc) would otherwise leave
    // disclosure_latency_candidates.filed_date permanently NULL, breaking the
    // FMP matcher's filer/date fallback for that filing. disclosure_latency_candidates
    // is an optional table (migration 0021); swallow a missing-table error the
    // same way recordDisclosureLatencyCandidate does rather than aborting the
    // whole discovery on a deployment where it hasn't been applied yet.
    try {
      await run(
        env.DB,
        'UPDATE disclosure_latency_candidates SET filed_date = ? WHERE doc_id = ? AND (filed_date IS NULL OR filed_date = "")',
        [filedDate, f.docId],
      );
    } catch (err) {
      if (!storageMissing(err)) throw err;
    }
  }
  if (filerId) {
    await run(env.DB, 'UPDATE filings SET filer_id = ? WHERE doc_id = ? AND filer_id IS NULL', [
      filerId,
      f.docId,
    ]);
    await run(env.DB, 'UPDATE transactions SET filer_id = ? WHERE doc_id = ? AND filer_id IS NULL', [
      filerId,
      f.docId,
    ]);
  }
  return (res.meta?.changes ?? 0) > 0 || upgradedProviderSeed || upgradedNotFound ? 'inserted' : 'duplicate';
}

/** Enqueue the canonical filing.new INGEST_QUEUE message for a discovered filing. */
export async function enqueueFilingNew(env: Env, f: DiscoveredFiling): Promise<boolean> {
  return enqueueIngestionOutboxNow(env, f.docId);
}

/**
 * Insert discovered filings with INSERT OR IGNORE and enqueue a filing.new
 * message for each GENUINELY-new row. Returns the count of new filings.
 */
async function persistAndEnqueue(
  env: Env,
  filings: DiscoveredFiling[],
  nowIso: string,
  opts: { maxNew?: number; prevProbeAt?: string | null; probeIntervalSec?: number | null } = {},
): Promise<number> {
  let newCount = 0;
  for (const f of filings) {
    if (opts.maxNew !== undefined && newCount >= opts.maxNew) break;
    const insertResult = await insertFilingIfNew(env, f, nowIso, {
      prevProbeAt: opts.prevProbeAt,
      probeIntervalSec: opts.probeIntervalSec,
    });
    if (insertResult === 'inserted') {
      await recordDisclosureLatencyCandidate(env, f, nowIso);
      await enqueueFilingNew(env, f);
      newCount += 1;
    }
  }
  return newCount;
}

/** Write one ingest_log row recording the cadence + yield of a poll. */
async function logPoll(
  env: Env,
  source: string,
  polledAtIso: string,
  newCount: number,
  firstSeenAtIso: string,
): Promise<void> {
  await run(
    env.DB,
    `INSERT INTO ingest_log (source, polled_at, new_count, first_seen_at)
       VALUES (?, ?, ?, ?)`,
    [source, polledAtIso, newCount, firstSeenAtIso],
  );
}

export type SourceAttemptOutcome = 'success' | 'failure';

async function recordSourceAttempt(
  env: Env,
  source: 'house' | 'senate' | 'executive',
  attemptedAt: string,
  outcome: SourceAttemptOutcome,
  newCount: number,
  error: string | null,
): Promise<void> {
  try {
    await withSqliteLockRetry(() => run(
      env.DB,
      `INSERT INTO source_attempts (source, attempted_at, outcome, new_count, error)
       VALUES (?, ?, ?, ?, ?)`,
      [source, attemptedAt, outcome, newCount, error?.slice(0, 1000) ?? null],
    ));
  } catch (err) {
    // Deploys briefly run new code before /api/admin/migrate.  Do not convert a
    // source success/failure into a different result solely because the new
    // observability table is not present yet.  A missing table is one warn and
    // no retry.  A busy database is retried, then logged, and still does not
    // fail the poll.
    if (isSqliteLockBusy(err)) {
      console.error('watcher: failed to record source attempt:', source, (err as Error).message);
      return;
    }
    console.warn('watcher: failed to record source attempt:', source, (err as Error).message);
  }
}

/**
 * A source failure is "transient" when it reflects a recoverable upstream or
 * platform condition rather than a bug: anti-bot blocks (403), rate limits
 * (429), and transient D1/Workers platform limits. These recur on a normal
 * cadence (e.g. the Senate efdsearch 403), so logging them at `error` floods
 * observability and buries genuine errors. We log them at `warn` instead; the
 * daily bulk/backfill path keeps history complete regardless.
 */
export function isTransientSourceError(message: string): boolean {
  return (
    /HTTP 403\b/.test(message) ||
    /HTTP 429\b/.test(message) ||
    /Network connection lost/i.test(message) ||
    /D1 DB is overloaded/i.test(message) ||
    /Too many API requests by single Worker invocation/i.test(message) ||
    /object to be reset/i.test(message)
  );
}

/** Record a source-level failure without presenting it as a successful poll. */
async function recordSourceError(env: Env, source: 'house' | 'senate' | 'executive', nowIso: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  if (isTransientSourceError(message)) {
    console.warn(`watcher: ${source} source degraded (transient, bulk path still authoritative):`, message);
  } else {
    console.error(`watcher: ${source} source failed:`, message);
  }
  await recordSourceAttempt(env, source, nowIso, 'failure', 0, message);
}

/** Days into January during which the previous year's House index is ALSO
 *  polled (tunable via HOUSE_PRIOR_YEAR_OVERLAP_DAYS; 0 disables). */
const DEFAULT_HOUSE_PRIOR_YEAR_OVERLAP_DAYS = 14;
/** How often, at most, the prior-year ZIP is fetched during the overlap window
 *  (the regular poll cadence is 5 min; one prior-year fetch/hour is plenty and
 *  polite to the Clerk host). */
const HOUSE_PRIOR_YEAR_FETCH_INTERVAL_MS = 3600_000;
const HOUSE_PRIOR_YEAR_KV_KEY = 'house_prior_year:last_fetch_at';

/** KV counter + escalation threshold for consecutive live-search failures.
 *  The overlay fails SOFT by design (bulk index still authoritative), but a
 *  persistent failure silently degrades House discovery from intraday to
 *  daily — production data showed every filing landing only in the ~13:00 UTC
 *  bulk-XML window. Escalate to console.error (Sentry-visible) once per
 *  sustained outage window instead of warn-spam that nobody sees. */
const HOUSE_LIVE_SEARCH_FAILS_KV_KEY = 'house_live_search:consecutive_failures';
const HOUSE_LIVE_SEARCH_ESCALATE_EVERY = 12;

/**
 * True when `now` (in ET, the Clerk's clock) falls within the first
 * `overlapDays` days of January — the window where filings submitted in late
 * December can still be appearing in the PRIOR year's index after we've rolled
 * to polling the new year. Exported for tests.
 */
export function inHousePriorYearWindow(now: Date, overlapDays: number): boolean {
  if (overlapDays <= 0) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  const lookup = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? NaN);
  return lookup('month') === 1 && lookup('day') <= overlapDays;
}

/**
 * Poll the House yearly bulk index, diff against D1, enqueue new PTRs.
 * Throws on any failure (caught by the per-source guard in runWatcher).
 */
async function pollHouse(env: Env, now: Date, signal?: AbortSignal): Promise<number> {
  const nowIso = now.toISOString();
  const year = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric' }).format(now),
  );
  const houseRelayUrl = env.HOUSE_RELAY_URL || env.INGEST_RELAY_URL;
  const all = await fetchHouseIndex(year, { relayUrl: houseRelayUrl, signal });
  const ptrs = all.filter((f) => f.isPtr);

  const byDoc = new Map<string, DiscoveredFiling>();
  for (const f of ptrs) {
    byDoc.set(f.pipelineDocId, houseDiscovery(f));
  }

  // YEAR-BOUNDARY GAP: for the first N days of a new ET year, also sweep the
  // PRIOR year's index (hourly, not every poll). A PTR filed Dec 30 can enter
  // the {YEAR-1}FD index days later — after we've switched to polling {YEAR} —
  // and would otherwise never be discovered. Fail-soft: a prior-year fetch
  // problem must not fail the current-year poll.
  const overlapDays = await tunableInt(
    env,
    'HOUSE_PRIOR_YEAR_OVERLAP_DAYS',
    DEFAULT_HOUSE_PRIOR_YEAR_OVERLAP_DAYS,
    0,
    31,
  );
  if (inHousePriorYearWindow(now, overlapDays)) {
    try {
      const lastIso = env.CONFIG_KV ? await env.CONFIG_KV.get(HOUSE_PRIOR_YEAR_KV_KEY) : null;
      const lastMs = lastIso ? Date.parse(lastIso) : NaN;
      if (!Number.isFinite(lastMs) || now.getTime() - lastMs >= HOUSE_PRIOR_YEAR_FETCH_INTERVAL_MS) {
        const prior = (await fetchHouseIndex(year - 1, { relayUrl: houseRelayUrl, signal })).filter((f) => f.isPtr);
        for (const f of prior) {
          if (!byDoc.has(f.pipelineDocId)) byDoc.set(f.pipelineDocId, houseDiscovery(f));
        }
        if (env.CONFIG_KV) await env.CONFIG_KV.put(HOUSE_PRIOR_YEAR_KV_KEY, nowIso);
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn('watcher: house prior-year index poll failed (current year unaffected):', (err as Error).message);
    }
  }

  // Intraday overlay: catch same-day PTRs that the daily XML hasn't picked up
  // yet. Fail-soft — a flaky/anti-bot live endpoint must never break the stable
  // bulk path. INSERT OR IGNORE de-dupes the overlap with the bulk rows above.
  if (await houseLiveSearchEnabled(env)) {
    let liveErr: Error | null = null;
    try {
      const live = await pollHouseLiveSearch(year, fetch, { env, signal });
      for (const f of live) {
        if (!byDoc.has(f.pipelineDocId)) {
          byDoc.set(f.pipelineDocId, houseDiscovery(f));
        }
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      liveErr = err as Error;
    }
    // Consecutive-failure counter — fully isolated in its own try/catch. A KV
    // blip here must never (a) fall into the poll's failure path and record a
    // live-search *success* as a failure, nor (b) escape and abort the
    // authoritative bulk persist/enqueue below. The observability overlay is
    // strictly best-effort; the bulk path is not.
    let fails = liveErr ? 1 : 0;
    try {
      if (env.CONFIG_KV) {
        if (!liveErr) {
          const prevFails = parseInt((await env.CONFIG_KV.get(HOUSE_LIVE_SEARCH_FAILS_KV_KEY)) ?? '0', 10) || 0;
          if (prevFails !== 0) await env.CONFIG_KV.put(HOUSE_LIVE_SEARCH_FAILS_KV_KEY, '0');
        } else {
          fails = (parseInt((await env.CONFIG_KV.get(HOUSE_LIVE_SEARCH_FAILS_KV_KEY)) ?? '0', 10) || 0) + 1;
          await env.CONFIG_KV.put(HOUSE_LIVE_SEARCH_FAILS_KV_KEY, String(fails));
        }
      }
    } catch (counterErr) {
      console.warn(
        'watcher: house live-search failure-counter update failed (ignored):',
        (counterErr as Error).message,
      );
    }
    if (liveErr) {
      if (fails % HOUSE_LIVE_SEARCH_ESCALATE_EVERY === 0) {
        console.error(
          `watcher: house live search has failed ${fails} consecutive polls — intraday House discovery is degraded to the daily bulk index:`,
          liveErr.message,
        );
      } else {
        console.warn('watcher: house live search failed (bulk index still used):', liveErr.message);
      }
    }
  }

  const discovered: DiscoveredFiling[] = Array.from(byDoc.values());
  const prevAttemptAt = await getPreviousSuccessfulSourceAttemptAt(env, 'house', nowIso);
  const probeIntervalSec = prevAttemptAt
    ? Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(prevAttemptAt)) / 1000))
    : null;
  const newCount = await persistAndEnqueue(env, discovered, nowIso, { prevProbeAt: prevAttemptAt, probeIntervalSec });
  await logPoll(env, 'house', nowIso, newCount, nowIso);
  await setLastPollAt(env, 'house', now);
  await recordSourceAttempt(env, 'house', nowIso, 'success', newCount, null);
  return newCount;
}

/** Default / max lookback windows for the Senate submitted-date filter.
 *  Tunable via SENATE_LOOKBACK_DAYS / SENATE_MAX_LOOKBACK_DAYS. */
const DEFAULT_SENATE_LOOKBACK_DAYS = 7;
const DEFAULT_SENATE_MAX_LOOKBACK_DAYS = 30;
/** Hard ceiling on the tunable max so a typo'd knob can't request years of
 *  DataTables pages in a single cron tick. */
const SENATE_LOOKBACK_HARD_CAP_DAYS = 365;
const SENATE_DEEP_SWEEP_KV_KEY = 'senate_deep_sweep:lastdate';

/**
 * Effective lookback (days) for a Senate discovery poll.
 *
 * The base window (default 7d) only works while polling is healthy. Two
 * recovery mechanisms widen it, both bounded by maxDays:
 *   - GAP CATCH-UP: when the last SUCCESSFUL senate poll is older than the
 *     base window (an anti-bot 403 stretch, a deploy break, a parser
 *     regression), the window covers the whole outage + 1 day of margin.
 *     Previously a >7-day outage meant every filing submitted before the
 *     recovery was PERMANENTLY missed — there was no sweep that ever looked
 *     back further.
 *   - DAILY DEEP SWEEP: once per UTC day the poll uses the full maxDays
 *     window regardless of health, so slow-listed/backdated submissions and
 *     any silent same-window misses self-heal within a day.
 * Exported for tests.
 */
export function computeSenateLookbackDays(
  now: Date,
  lastSuccessAt: Date | null,
  baseDays: number,
  maxDays: number,
  deepSweepDue: boolean,
): number {
  const max = Math.max(baseDays, maxDays);
  if (deepSweepDue || !lastSuccessAt) return max;
  const gapDays = Math.ceil((now.getTime() - lastSuccessAt.getTime()) / 86_400_000) + 1;
  return Math.min(max, Math.max(baseDays, gapDays));
}

/**
 * Poll the Senate efdsearch DataTables API, diff against D1, enqueue new PTRs.
 * Throws on any failure (caught by the per-source guard in runWatcher).
 */
async function pollSenate(env: Env, now: Date, signal?: AbortSignal): Promise<number> {
  const nowIso = now.toISOString();
  const baseDays = await tunableInt(
    env,
    'SENATE_LOOKBACK_DAYS',
    DEFAULT_SENATE_LOOKBACK_DAYS,
    1,
    SENATE_LOOKBACK_HARD_CAP_DAYS,
  );
  const maxDays = await tunableInt(
    env,
    'SENATE_MAX_LOOKBACK_DAYS',
    DEFAULT_SENATE_MAX_LOOKBACK_DAYS,
    baseDays,
    SENATE_LOOKBACK_HARD_CAP_DAYS,
  );
  const today = nowIso.slice(0, 10);
  let deepSweepDue = false;
  if (env.CONFIG_KV) {
    try {
      deepSweepDue = (await env.CONFIG_KV.get(SENATE_DEEP_SWEEP_KV_KEY)) !== today;
    } catch {
      /* KV read failure -> stay on the regular window */
    }
  }
  const lastSuccessAt = await getLastPollAt(env, 'senate');
  const lookbackDays = computeSenateLookbackDays(now, lastSuccessAt, baseDays, maxDays, deepSweepDue);
  const since = new Date(now.getTime() - lookbackDays * 86_400_000);
  const filings = await fetchSenatePtrFilings({
    now,
    since,
    kv: env.CONFIG_KV,
    relayUrl: env.SENATE_RELAY_URL,
    relaySecret: env.SENATE_RELAY_SECRET,
    proxyUrl: env.RESIDENTIAL_PROXY_URL || env.SENATE_PROXY_URL,
    signal,
  });
  const discovered: DiscoveredFiling[] = filings.map((f) => {
    const filerName = cleanFilerName(f.fullName || [f.first, f.last].filter(Boolean).join(' ').trim()) || null;
    return {
      docId: f.pipelineDocId,
      chamber: 'senate' as const,
      sourceUrl: f.sourceUrl,
      filedDate: f.filedDate,
      filerId: senateFilerId(filerName),
      filerName,
    };
  });
  const prevAttemptAt = await getPreviousSuccessfulSourceAttemptAt(env, 'senate', nowIso);
  const probeIntervalSec = prevAttemptAt
    ? Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(prevAttemptAt)) / 1000))
    : null;
  const newCount = await persistAndEnqueue(env, discovered, nowIso, { prevProbeAt: prevAttemptAt, probeIntervalSec });
  await logPoll(env, 'senate', nowIso, newCount, nowIso);
  await setLastPollAt(env, 'senate', now);
  await recordSourceAttempt(env, 'senate', nowIso, 'success', newCount, null);
  // Stamp the deep sweep ONLY after a fully successful poll: a 403 day must
  // not consume the day's widened window.
  if (deepSweepDue && env.CONFIG_KV) {
    try {
      await env.CONFIG_KV.put(SENATE_DEEP_SWEEP_KV_KEY, today, { expirationTtl: 172800 });
    } catch {
      /* best-effort; worst case tomorrow's first poll widens again */
    }
  }
  return newCount;
}

/**
 * Called from scheduled() on every cron tick. Internally gates on shouldPollNow
 * per source, then polls + enqueues new filings. Never throws: a failing source
 * is logged and recorded, leaving the other source unaffected.
 */
export interface WatcherResult {
  house: SourceAttemptOutcome | 'skipped';
  senate: SourceAttemptOutcome | 'skipped';
  executive: SourceAttemptOutcome | 'skipped';
  /** Why House/Senate polled or skipped this tick — which tier, which window,
   *  which authority. `'skipped'` on its own cannot distinguish "correctly
   *  off-peak" from "the cadence quietly stopped", which is the whole point.
   *  Optional so existing structural consumers of WatcherResult are unaffected. */
  houseCadence?: SourcePollDecision;
  senateCadence?: SourcePollDecision;
  executiveCadence?: SourcePollDecision;
}

/**
 * Poll the OGE President/VP index for new executive 278-T filings. Cadence is
 * decided by decideSourcePoll (same adaptive probeSchedule as House/Senate).
 * Returns the count of genuinely-new filings, or null when disabled/not due.
 */
export async function pollExecutive(
  env: Env,
  now: Date,
  opts: { force?: boolean; maxFilings?: number; dryRun?: boolean; signal?: AbortSignal } = {},
): Promise<number | null> {
  const nowIso = now.toISOString();
  const filings = await pollOgeExecutive(env, now, fetch, opts);
  if (filings === null) return null;
  const maxFilings = Math.min(Math.max(Math.floor(opts.maxFilings ?? 100), 1), 500);
  if (opts.dryRun) return Math.min(filings.length, maxFilings);
  const prevAttemptAt = await getPreviousSuccessfulSourceAttemptAt(env, 'executive', nowIso);
  const probeIntervalSec = prevAttemptAt
    ? Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(prevAttemptAt)) / 1000))
    : null;
  const newCount = await persistAndEnqueue(env, filings, nowIso, { maxNew: maxFilings, prevProbeAt: prevAttemptAt, probeIntervalSec });
  await setLastPollAt(env, 'oge', now);
  await logPoll(env, 'oge', nowIso, newCount, nowIso);
  // Liveness receipt (owner 2026-08-10: polling must never be silently off
  // for any chamber). Executive historically wrote only the KV checkpoint,
  // leaving no durable per-attempt record — which is exactly how a 5-day
  // OGE polling outage went unnoticed. Fail-soft: a receipt failure must
  // never fail the poll that just succeeded.
  try {
    await recordSourceAttempt(env, 'executive', nowIso, 'success', newCount, null);
  } catch (err) {
    console.warn('watcher: failed to record executive source attempt:', (err as Error).message);
  }
  return newCount;
}

/**
 * The composed poll decision for one direct source. PURE — no I/O, no clock
 * read, no env read. Every input is passed in; the caller owns the reads.
 *
 * COMPOSITION (see probeSchedule.ts header and app/docs/probe-schedule.md):
 * probeSchedule decides HOW OFTEN. There is no lease on House/Senate — the
 * lease covers only the metered latency providers — so here the schedule is
 * the sole authority, and the legacy poll_config windows are the fallback.
 *
 * Two paths, never both:
 *   • SCHEDULE  — the measured windows own the cadence. This is the default.
 *   • POLL-WINDOW — the legacy fixed-interval poll_config path, used when the
 *     schedule is switched off (PROBE_SCHEDULE_ENABLED=0) or when the owner
 *     has explicitly asked for aggressiveMode.
 *
 * WHY aggressiveMode FALLS BACK rather than being ignored: it is an owner-
 * facing "poll as hard as you can" switch. Under the measured schedule the
 * 08:55-09:40 peak already runs at 60s — five times faster than aggressive
 * mode's 180s — but the 12:00-20:00 window would drop from 180s to ~10min,
 * so honouring the switch means honouring the legacy path wholesale. The
 * decision reports which authority ran, and the caller logs it, so this is
 * never a silent downgrade.
 */
export interface SourcePollDecision {
  readonly poll: boolean;
  readonly authority: ProbeCadenceAuthority;
  readonly tier: ProbeTier | 'none';
  readonly dayType: DayType | 'n/a';
  readonly intervalSec: number;
  readonly elapsedSec: number;
  readonly reason: string;
}

export function decideSourcePoll(args: {
  source: 'house' | 'senate' | 'executive';
  now: Date;
  cfg: PollConfig;
  lastPollAt: Date | null;
  schedule?: ProbeScheduleConfig;
}): SourcePollDecision {
  const schedule = args.schedule ?? DEFAULT_PROBE_SCHEDULE_CONFIG;
  const legacy = (reason: string): SourcePollDecision => {
    const poll = shouldPollNow(args.now, args.cfg, args.lastPollAt);
    return {
      poll,
      authority: 'poll-window',
      tier: 'none',
      dayType: 'n/a',
      intervalSec: 0,
      elapsedSec: args.lastPollAt
        ? (args.now.getTime() - args.lastPollAt.getTime()) / 1000
        : Infinity,
      reason: poll ? `${reason}:due` : `${reason}:not-due`,
    };
  };

  // Kill switch first: a disabled schedule must restore the OLD behaviour, not
  // stop polling. shouldProbeNow() reports `disabled` with probe=false, and
  // treating that as "do not poll" would silently halt ingestion the moment
  // someone set PROBE_SCHEDULE_ENABLED=0.
  if (!schedule.enabled) return legacy('schedule-disabled');
  if (args.cfg.aggressiveMode) return legacy('aggressive-mode');

  const decision = shouldProbeNow({
    source: args.source,
    now: args.now,
    lastProbeAt: args.lastPollAt,
    config: schedule,
  });
  return {
    poll: decision.probe,
    authority: 'schedule',
    tier: decision.tier,
    dayType: decision.dayType,
    intervalSec: decision.intervalSec,
    elapsedSec: decision.elapsedSec,
    reason: decision.reason,
  };
}

/**
 * Build the live schedule config from env. Never throws — every unparseable
 * value falls back to the shipped table (see probeScheduleConfigFromEnv), so a
 * fat-fingered retune degrades to the measured default instead of stalling
 * ingestion.
 */
function scheduleConfigFor(env: Env): ProbeScheduleConfig {
  try {
    return probeScheduleConfigFromEnv(env as unknown as Record<string, string | undefined>);
  } catch {
    return DEFAULT_PROBE_SCHEDULE_CONFIG;
  }
}

function throwIfWatcherAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error(
    signal.reason instanceof Error ? signal.reason.message : 'watcher aborted',
  );
  error.name = 'AbortError';
  throw error;
}

export async function runWatcher(
  env: Env,
  now: Date = new Date(),
  options: { signal?: AbortSignal } = {},
): Promise<WatcherResult> {
  throwIfWatcherAborted(options.signal);
  const cfg = await getConfig(env);
  const schedule = scheduleConfigFor(env);
  const result: WatcherResult = { house: 'skipped', senate: 'skipped', executive: 'skipped' };

  // HOUSE -----------------------------------------------------------------
  try {
    throwIfWatcherAborted(options.signal);
    const lastHouse = await getLastPollAt(env, 'house');
    const houseDecision = decideSourcePoll({
      source: 'house',
      now,
      cfg,
      lastPollAt: lastHouse,
      schedule,
    });
    logProbeCadence(
      {
        lane: 'house',
        source: 'house',
        probe: houseDecision.poll,
        tier: houseDecision.tier,
        dayType: houseDecision.dayType,
        intervalSec: houseDecision.intervalSec,
        elapsedSec: houseDecision.elapsedSec,
        authority: houseDecision.authority,
        reason: houseDecision.reason,
      },
      now,
    );
    result.houseCadence = houseDecision;
    if (houseDecision.poll) {
      const lastAttempt = await getLastAttemptAt(env, 'house');
      const elapsedSec = lastAttempt ? (now.getTime() - lastAttempt.getTime()) / 1000 : Infinity;
      const lastAttemptFailed = lastAttempt && (!lastHouse || lastHouse.getTime() < lastAttempt.getTime());
      if (lastAttemptFailed && elapsedSec < 600) {
        // Skip this poll tick to respect failure backoff
      } else {
        await setLastAttemptAt(env, 'house', now);
        await pollHouse(env, now, options.signal);
        result.house = 'success';
      }
    }
  } catch (err) {
    if (options.signal?.aborted) throwIfWatcherAborted(options.signal);
    if (err instanceof Error && err.name === 'AbortError') throw err;
    await recordSourceError(env, 'house', now.toISOString(), err);
    result.house = 'failure';
  }

  // SENATE ----------------------------------------------------------------
  try {
    throwIfWatcherAborted(options.signal);
    const lastSenate = await getLastPollAt(env, 'senate');
    const senateDecision = decideSourcePoll({
      source: 'senate',
      now,
      cfg,
      lastPollAt: lastSenate,
      schedule,
    });
    logProbeCadence(
      {
        lane: 'senate',
        source: 'senate',
        probe: senateDecision.poll,
        tier: senateDecision.tier,
        dayType: senateDecision.dayType,
        intervalSec: senateDecision.intervalSec,
        elapsedSec: senateDecision.elapsedSec,
        authority: senateDecision.authority,
        reason: senateDecision.reason,
      },
      now,
    );
    result.senateCadence = senateDecision;
    if (senateDecision.poll) {
      const lastAttempt = await getLastAttemptAt(env, 'senate');
      const elapsedSec = lastAttempt ? (now.getTime() - lastAttempt.getTime()) / 1000 : Infinity;
      const lastAttemptFailed = lastAttempt && (!lastSenate || lastSenate.getTime() < lastAttempt.getTime());
      if (lastAttemptFailed && elapsedSec < 600) {
        // Skip this poll tick to respect failure backoff
      } else {
        await setLastAttemptAt(env, 'senate', now);
        await pollSenate(env, now, options.signal);
        result.senate = 'success';
      }
    }
  } catch (err) {
    if (options.signal?.aborted) throwIfWatcherAborted(options.signal);
    if (err instanceof Error && err.name === 'AbortError') throw err;
    await recordSourceError(env, 'senate', now.toISOString(), err);
    result.senate = 'failure';
  }

  // EXECUTIVE (OGE 278-T) ---------------------------------------------------
  // Same decideSourcePoll + last_attempt failure skip as House/Senate.
  // Fail-soft: an OGE outage must never affect House/Senate polling above.
  // Server-first: direct extapps2.oge.gov, then Mac/scout relay if direct fails.
  try {
    throwIfWatcherAborted(options.signal);
    const lastExec = await getLastPollAt(env, 'oge');
    const execDecision = decideSourcePoll({
      source: 'executive',
      now,
      cfg,
      lastPollAt: lastExec,
      schedule,
    });
    logProbeCadence(
      {
        lane: 'executive',
        source: 'executive',
        probe: execDecision.poll,
        tier: execDecision.tier,
        dayType: execDecision.dayType,
        intervalSec: execDecision.intervalSec,
        elapsedSec: execDecision.elapsedSec,
        authority: execDecision.authority,
        reason: execDecision.reason,
      },
      now,
    );
    result.executiveCadence = execDecision;
    if (execDecision.poll) {
      const lastAttempt = await getLastAttemptAt(env, 'oge');
      const elapsedSec = lastAttempt ? (now.getTime() - lastAttempt.getTime()) / 1000 : Infinity;
      const lastAttemptFailed = lastAttempt && (!lastExec || lastExec.getTime() < lastAttempt.getTime());
      // Match House/Senate last_attempt skip. Do not invent a 10-minute
      // backoff shorter than the current success interval (weekday floor is
      // 15 min). House/Senate keep their own hardcoded 600.
      const failureBackoffSec = Math.max(600, execDecision.intervalSec);
      if (lastAttemptFailed && elapsedSec < failureBackoffSec) {
        // Skip this poll tick to respect failure backoff
      } else {
        await setLastAttemptAt(env, 'oge', now);
        const polled = await pollExecutive(env, now, { signal: options.signal });
        if (polled !== null) result.executive = 'success';
      }
    }
  } catch (err) {
    if (options.signal?.aborted) throwIfWatcherAborted(options.signal);
    if (err instanceof Error && err.name === 'AbortError') throw err;
    console.warn('watcher: executive (OGE) source failed:', (err as Error).message);
    // Durable failure receipt so the polling_executive liveness check sees
    // "attempts running, successes stale" instead of silence.
    await recordSourceError(env, 'executive', now.toISOString(), err);
    result.executive = 'failure';
  }

  // Cheap GET /health against the named Senate tunnel.  Fail-soft: a probe
  // error must never fail the watcher tick.  Writes CONFIG_KV so pipelineHealth
  // can surface a dead Mac without adding an outbound hop to /api/health.
  try {
    await refreshSenateRelayHealth(env, now);
  } catch (err) {
    console.warn('watcher: senate relay health probe failed:', (err as Error).message);
  }
  return result;
}
