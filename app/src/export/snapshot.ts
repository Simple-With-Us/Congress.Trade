/**
 * src/export/snapshot.ts
 * OWNER: export
 *
 * Daily bulk snapshot writer: dumps the market-data tables App B bootstraps from
 * (prices, S&P, securities reference, fundamentals, analyst consensus) to R2 as
 * NDJSON — one JSON object per line — under a date- AND run-partitioned key
 * prefix, plus a manifest written LAST so a partially-written run is invisible to
 * readers.
 *
 * Why NDJSON: every column value survives unchanged with no CSV quoting ceremony,
 * the keys are self-describing, and App B can stream-parse line by line without
 * loading the whole file. Parquet is not viable in the Workers runtime (no native
 * encoder, and a WASM one would blow the Worker size budget).
 *
 * Why paged + multipart: a single `SELECT *` on price_eod can exceed D1's result
 * cap and the whole file can exceed Worker memory, so each table is paged in
 * bounded chunks and streamed to R2 via multipart upload (small tables fall back
 * to a single PUT). Memory stays bounded to ~one part + one page.
 *
 * Why run-scoped keys: each run writes its table files under a unique
 * `bulk/{date}/runs/{runId}/` prefix and only then publishes the manifest at the
 * stable `bulk/{date}/manifest.json`. The manifest's `objectKey`s point at that
 * run's files, and downloads resolve through the manifest — so a same-day rerun
 * (e.g. an inline back-fill racing the cron) can never leave the published
 * manifest pointing at a half-rewritten file.
 *
 * Retention: this file used to say orphaned run prefixes were "negligible R2
 * cost". That was wrong at steady state — one full run is ~0.28 GiB, nothing
 * ever deleted them, and by 2026-08 `bulk/` was the largest thing in
 * `congress-trade-bucket` and the reason the account kept approaching R2's
 * 10 GB free tier. {@link pruneBulkSnapshots} now runs after each successful
 * publish and reclaims two things: run prefixes superseded within a date, and
 * whole dates past the retention window. Deletes are age-gated, bounded, and
 * best-effort — a prune failure must never fail the snapshot that produced it.
 *
 * The congressional-trade corpus (transactions/filings/filers) is deliberately
 * NOT exported here — it is already served by the cursor-paged /api/transactions
 * feed; duplicating it would create a second source of truth. Likewise insider /
 * short-volume streams flow App B → App A, so echoing them back is out of scope.
 */

import type { Env } from '../shared/types.ts';
import { all, type SqlParam } from '../shared/db.ts';
import type { SnapshotManifest, SnapshotTableInfo } from '@jaywedgeworth22/congress-trading-shared';

/**
 * Tables included in the snapshot. `keyCols` is each table's unique key in sort
 * order — used BOTH as the stable ORDER BY and as the keyset cursor, so paging
 * survives concurrent inserts: an import / price-refresh landing mid-dump can't
 * shift an OFFSET and make a row repeat or be skipped. Each keyCols tuple is
 * unique per row (the tables' primary keys), so the cursor never stalls on ties.
 */
export const SNAPSHOT_TABLES = [
  { name: 'price_eod', keyCols: ['ticker', 'date'] },
  { name: 'spx_eod', keyCols: ['date'] },
  { name: 'securities_ref', keyCols: ['ticker'] },
  { name: 'fundamentals_eod', keyCols: ['ticker', 'date'] },
  { name: 'analyst_consensus', keyCols: ['ticker', 'date'] },
] as const;

export type SnapshotTableName = (typeof SNAPSHOT_TABLES)[number]['name'];

/** Documented column set per table (mirrors the migrations). Self-describing in
 *  the NDJSON itself; surfaced in the manifest so App B can map without guessing. */
export const SNAPSHOT_SCHEMA: Record<SnapshotTableName, string[]> = {
  price_eod: ['ticker', 'date', 'close', 'volume'],
  spx_eod: ['date', 'close'],
  securities_ref: [
    'ticker', 'company_name', 'sector', 'industry', 'asset_class', 'is_etf', 'is_adr',
    'country', 'state_hq', 'state_of_incorp', 'exchange', 'exchange_short', 'currency',
    'market_cap', 'market_cap_bucket', 'shares_outstanding', 'ipo_date', 'cik', 'sic_code',
    'sic_description', 'source', 'enriched_at', 'enrichment_error', 'current_price',
    'current_price_date',
  ],
  fundamentals_eod: [
    'ticker', 'date', 'pe_ratio', 'eps', 'beta', 'dividend_yield', 'week52_high',
    'week52_low', 'fcf_yield', 'debt_to_equity', 'eps_growth', 'source', 'updated_at',
  ],
  analyst_consensus: [
    'ticker', 'date', 'rating', 'target_mean', 'target_high', 'target_low', 'target_median',
    'analyst_count', 'strong_buy', 'buy', 'hold', 'sell', 'strong_sell', 'source', 'updated_at',
  ],
};



const PAGE = 10_000;
// Fixed multipart part size. R2 requires EVERY part except the last to be the
// same size, so we cut the byte stream into exact PART_SIZE chunks rather than
// flushing whatever a page happened to accumulate. 8 MiB clears R2's 5 MiB
// minimum with headroom and keeps the part count low for big tables.
const PART_SIZE = 8 * 1024 * 1024;

const encoder = new TextEncoder();

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Copy bytes into a fresh ArrayBuffer — R2's binding body type wants ArrayBuffer
 *  (not a view over a possibly-Shared buffer), and this also pins exact length. */
function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
}

/** R2 object key for one table's NDJSON dump within a run. */
export function snapshotObjectKey(date: string, runId: string, table: string): string {
  return `bulk/${date}/runs/${runId}/${table}.ndjson`;
}

/** R2 object key for the (stable, run-independent) snapshot manifest on a date. */
export function manifestObjectKey(date: string): string {
  return `bulk/${date}/manifest.json`;
}

/**
 * Build the keyset WHERE predicate + binds for "key tuple strictly after the
 * cursor", e.g. for [ticker, date]: `(ticker > ?) OR (ticker = ? AND date > ?)`.
 * Returns null clause for the first page (no cursor).
 */
function keysetAfter(keyCols: readonly string[], cursor: SqlParam[] | null): { clause: string; params: SqlParam[] } {
  if (!cursor) return { clause: '', params: [] };
  const cols = keyCols.join(', ');
  const placeholders = cursor.map(() => '?').join(', ');
  return { clause: `WHERE (${cols}) > (${placeholders}) `, params: [...cursor] };
}

/**
 * Page one table out of D1 and stream it to R2 as NDJSON. Uses KEYSET pagination
 * (cursor on the table's unique key) rather than OFFSET, so a concurrent insert
 * between pages can't shift the window and duplicate/skip a row — the dump is a
 * forward key-ordered scan. Cuts the UTF-8 byte stream into fixed PART_SIZE
 * multipart parts (R2 requires equal-sized non-final parts); the remainder is the
 * final part; tables under one part use a single PUT. On any failure mid-upload
 * the multipart upload is aborted so no orphaned parts linger. Returns the row
 * count written.
 *
 * Consistency model: each row reflects its state at the instant its KEY was read,
 * not a single global point in time — the Workers D1 binding has no read-snapshot
 * spanning the many paged `all()` calls. Keyset already removes the severe
 * OFFSET-shift duplicate/skip bug; a row whose key sorts after the cursor and is
 * inserted before that page is reached can still appear, and a late backfill below
 * the cursor can be missed. For DAILY EOD bootstrap data that smear is immaterial
 * and self-heals on the next day's snapshot. Stronger point-in-time isolation
 * would need the D1 Sessions (bookmark) API or a staged table copy — deferred
 * until a consumer needs it.
 */
async function writeTableNdjson(
  env: Env,
  key: string,
  table: string,
  keyCols: readonly string[],
): Promise<number> {
  let rowCount = 0;
  let carry: Uint8Array = new Uint8Array(0); // bytes not yet flushed as a part
  let cursor: SqlParam[] | null = null; // last emitted row's key values
  let mpu: R2MultipartUpload | null = null;
  const parts: R2UploadedPart[] = [];
  const orderBy = keyCols.map((c) => `${c} ASC`).join(', ');

  try {
    for (;;) {
      // table / keyCols come from the SNAPSHOT_TABLES closed set, never user input.
      const ks = keysetAfter(keyCols, cursor);
      const rows = await all<Record<string, unknown>>(
        env.DB,
        `SELECT * FROM ${table} ${ks.clause}ORDER BY ${orderBy} LIMIT ${PAGE}`,
        ks.params,
      );
      if (rows.length === 0) break;
      let chunk = '';
      for (const row of rows) chunk += JSON.stringify(row) + '\n';
      rowCount += rows.length;
      carry = concatBytes(carry, encoder.encode(chunk));
      const last = rows[rows.length - 1];
      cursor = keyCols.map((c) => last[c] as SqlParam);
      // Flush as many full, equal-sized parts as the carry now holds.
      while (carry.length >= PART_SIZE) {
        mpu ??= await env.RAW_FILES.createMultipartUpload(key);
        parts.push(await mpu.uploadPart(parts.length + 1, toArrayBuffer(carry.subarray(0, PART_SIZE))));
        carry = carry.slice(PART_SIZE);
      }
      if (rows.length < PAGE) break;
    }

    if (mpu) {
      // Final part carries the remainder (< PART_SIZE; the only part allowed to differ).
      if (carry.length > 0) parts.push(await mpu.uploadPart(parts.length + 1, toArrayBuffer(carry)));
      await mpu.complete(parts);
    } else {
      // Small (or empty) table — a single PUT, no multipart ceremony.
      await env.RAW_FILES.put(key, toArrayBuffer(carry));
    }
  } catch (err) {
    // Don't leave a dangling multipart upload (+ its parts) behind on failure.
    if (mpu) await mpu.abort().catch(() => {});
    throw err;
  }
  return rowCount;
}

/**
 * Write the full daily snapshot (all tables under a unique run prefix + the
 * stable manifest) to R2 and return the manifest. The manifest is written LAST
 * and points at this run's files, so a partial or racing run never corrupts the
 * published manifest. `runId` is injectable for deterministic tests.
 */
export async function runBulkSnapshot(
  env: Env,
  date: string,
  now = new Date(),
  runId: string = crypto.randomUUID(),
): Promise<SnapshotManifest> {
  const tables: Record<string, SnapshotTableInfo> = {};
  for (const spec of SNAPSHOT_TABLES) {
    const key = snapshotObjectKey(date, runId, spec.name);
    const rowCount = await writeTableNdjson(env, key, spec.name, spec.keyCols);
    tables[spec.name] = { objectKey: key, rowCount };
  }
  const manifest: SnapshotManifest = {
    generatedAt: now.toISOString(),
    snapshotDate: date,
    runId,
    format: 'ndjson',
    tables,
    schema: SNAPSHOT_SCHEMA,
  };
  await env.RAW_FILES.put(manifestObjectKey(date), JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
  });

  // Housekeeping runs only AFTER the manifest is published, so the run it is
  // told to keep is the one readers can actually reach. Wrapped because a
  // prune problem must never fail an export that already succeeded.
  try {
    const pruned = await pruneBulkSnapshots(env, {
      today: date,
      keepRunId: runId,
      keepRunDate: date,
      now,
    });
    if (pruned.deleted > 0 || pruned.failed > 0 || pruned.truncated) {
      console.log(
        `bulk snapshot prune: scanned=${pruned.scanned} deleted=${pruned.deleted}` +
          ` failed=${pruned.failed}${pruned.truncated ? ' (capped; more next run)' : ''}`,
      );
    }
  } catch (err) {
    console.warn('bulk snapshot prune: unexpected failure:', (err as Error).message);
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Retention / prune
// ---------------------------------------------------------------------------

/** Keep whole snapshot dates for this many days back, including today. */
export const DEFAULT_KEEP_DAYS = 14;
/**
 * A superseded run is only deleted once it is this old. A consumer that read
 * the previous manifest moments before a rerun published may still be streaming
 * that run's files; the grace window lets those downloads finish rather than
 * 404 mid-transfer.
 */
export const DEFAULT_GRACE_MINUTES = 60;
/**
 * Ceiling on deletes per invocation. Each delete is a Class A operation and CT
 * shares R2's 1M/month free allowance with ingestion, so a first run against a
 * large backlog spreads over several days instead of spiking the meter.
 */
export const DEFAULT_MAX_DELETES = 500;
/** Ceiling on list pages per invocation (1,000 keys each; also Class A). */
const MAX_LIST_PAGES = 20;

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** One listed object, narrowed to the fields the selectors need. */
export interface BulkListedObject {
  key: string;
  uploaded?: Date | string | null;
}

/**
 * Parse a run-scoped object key into its date and run id.
 *
 * Deliberately strict: the candidate keys come from a ListObjects response,
 * i.e. from outside this process. Without an exact-shape allowlist a malformed
 * or hostile listing could steer DELETE at objects this job does not own —
 * `raw/` filing PDFs and the `weekly/` DB archive live in the same bucket.
 */
export function parseRunObjectKey(key: string): { date: string; runId: string } | null {
  const match = /^bulk\/(\d{4}-\d{2}-\d{2})\/runs\/([A-Za-z0-9-]{1,64})\/[A-Za-z0-9_-]{1,64}\.ndjson$/.exec(key);
  if (!match) return null;
  return { date: match[1], runId: match[2] };
}

/** Parse any key this module owns (run file or manifest) into its date. */
export function parseBulkObjectDate(key: string): string | null {
  const run = parseRunObjectKey(key);
  if (run) return run.date;
  const manifest = /^bulk\/(\d{4}-\d{2}-\d{2})\/manifest\.json$/.exec(key);
  return manifest ? manifest[1] : null;
}

/** `YYYY-MM-DD` this many days before `date` (UTC, no clock read). */
export function shiftUtcDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function uploadedMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Which listed keys this prune may delete.
 *
 * Two independent rules, both restricted to keys matching the shapes above:
 *   1. superseded runs — a run file on a RETAINED date whose run id is not the
 *      one the current manifest points at, older than the grace window;
 *   2. expired dates — every owned key on a date older than the keep window.
 *
 * Never returns: the live run's files, the manifest of a retained date, today's
 * or a future date's keys, or anything that does not parse as an owned key.
 * Pure so the retention rules are testable without an R2 round trip.
 */
export function selectPruneTargets(
  objects: readonly BulkListedObject[],
  opts: {
    today: string;
    keepRunId: string | null;
    keepRunDate: string | null;
    keepDays: number;
    graceMinutes: number;
    nowMs: number;
    maxDeletes: number;
  },
): string[] {
  const { today, keepRunId, keepRunDate, keepDays, graceMinutes, nowMs, maxDeletes } = opts;
  if (!DATE_SHAPE.test(today) || keepDays < 1 || maxDeletes < 1) return [];
  const oldestKept = shiftUtcDate(today, -(keepDays - 1));
  const graceMs = Math.max(0, graceMinutes) * 60_000;
  const targets: string[] = [];

  for (const object of objects) {
    const date = parseBulkObjectDate(object.key);
    if (!date) continue; // not ours — raw/, weekly/, historical-dumps/, _ops/
    if (date > today) continue; // clock skew; never touch the future

    if (date < oldestKept) {
      targets.push(object.key); // expired date: manifest and runs both go
      continue;
    }

    // Retained date — only superseded run files are eligible.
    const run = parseRunObjectKey(object.key);
    if (!run) continue; // a retained date's manifest always stays
    if (keepRunId && run.date === keepRunDate && run.runId === keepRunId) continue;
    const age = uploadedMs(object.uploaded);
    // No usable timestamp means we cannot prove the grace window elapsed.
    if (age === null || nowMs - age < graceMs) continue;
    targets.push(object.key);
  }

  // Oldest first, so a capped run always makes progress on the worst backlog.
  targets.sort();
  return targets.slice(0, maxDeletes);
}

function positiveIntFromEnv(env: Env, name: string, fallback: number): number {
  const raw = (env as unknown as Record<string, unknown>)[name];
  const value = Number(typeof raw === 'string' || typeof raw === 'number' ? raw : NaN);
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

export interface BulkPruneResult {
  scanned: number;
  deleted: number;
  failed: number;
  truncated: boolean;
  skipped?: 'disabled' | 'unsupported';
}

/**
 * Delete superseded runs and expired dates under `bulk/`.
 *
 * Best-effort by contract: every failure path returns a result instead of
 * throwing, because the caller has already published a good manifest and a
 * housekeeping problem must not turn a successful export into a failed one.
 * Set `BULK_SNAPSHOT_PRUNE_DISABLED=1` to park it without a deploy.
 */
export async function pruneBulkSnapshots(
  env: Env,
  opts: {
    today: string;
    keepRunId?: string | null;
    keepRunDate?: string | null;
    now?: Date;
  },
): Promise<BulkPruneResult> {
  const empty: BulkPruneResult = { scanned: 0, deleted: 0, failed: 0, truncated: false };
  const flag = (env as unknown as Record<string, unknown>).BULK_SNAPSHOT_PRUNE_DISABLED;
  if (flag === '1' || flag === 'true' || flag === true) {
    return { ...empty, skipped: 'disabled' };
  }
  // Workers always has list(); a Deno build older than the S3 shim's list()
  // does not. Degrade quietly rather than throwing inside the export lane.
  if (typeof (env.RAW_FILES as { list?: unknown })?.list !== 'function') {
    return { ...empty, skipped: 'unsupported' };
  }

  const keepDays = positiveIntFromEnv(env, 'BULK_SNAPSHOT_KEEP_DAYS', DEFAULT_KEEP_DAYS);
  const graceMinutes = positiveIntFromEnv(env, 'BULK_SNAPSHOT_PRUNE_GRACE_MINUTES', DEFAULT_GRACE_MINUTES);
  const maxDeletes = positiveIntFromEnv(env, 'BULK_SNAPSHOT_MAX_DELETES', DEFAULT_MAX_DELETES);
  const nowMs = (opts.now ?? new Date()).getTime();

  const objects: BulkListedObject[] = [];
  let cursor: string | undefined;
  let truncated = false;
  try {
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = await env.RAW_FILES.list({ prefix: 'bulk/', cursor });
      for (const object of result.objects) {
        objects.push({ key: object.key, uploaded: (object as { uploaded?: Date }).uploaded });
      }
      if (!result.truncated) break;
      cursor = (result as { cursor?: string }).cursor;
      if (!cursor) break;
      if (page === MAX_LIST_PAGES - 1) truncated = true;
    }
  } catch (err) {
    console.warn('bulk snapshot prune: listing failed:', (err as Error).message);
    return { ...empty, scanned: objects.length };
  }

  const targets = selectPruneTargets(objects, {
    today: opts.today,
    keepRunId: opts.keepRunId ?? null,
    keepRunDate: opts.keepRunDate ?? null,
    keepDays,
    graceMinutes,
    nowMs,
    maxDeletes,
  });

  let deleted = 0;
  let failed = 0;
  for (const key of targets) {
    try {
      await env.RAW_FILES.delete(key);
      deleted++;
    } catch (err) {
      failed++;
      console.warn(`bulk snapshot prune: delete failed for ${key}:`, (err as Error).message);
    }
  }
  return { scanned: objects.length, deleted, failed, truncated: truncated || targets.length >= maxDeletes };
}

/** Read a previously-written manifest from R2, or null if absent. */
export async function readManifest(env: Env, date: string): Promise<SnapshotManifest | null> {
  const obj = await env.RAW_FILES.get(manifestObjectKey(date));
  if (!obj) return null;
  try {
    return (await obj.json()) as SnapshotManifest;
  } catch {
    return null;
  }
}
