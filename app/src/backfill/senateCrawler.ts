/**
 * Bounded historical Senate PTR discovery.
 *
 * Senate eFD exposes only a CSRF/session-gated DataTables search, not a bulk
 * archive. This crawler deliberately reuses fetchSenatePtrFilings so its
 * browser headers, tracked fetches, agreement handshake, and cached session
 * stay identical to the live watcher. Historical ranges are searched one UTC
 * month at a time. A full 2,500-row response is treated as source saturation
 * and recursively bisected until each sub-range is below the DataTables cap.
 */

import type { Env } from "../shared/types.ts";
import {
  fetchSenatePtrFilings,
  type FetchSenatePtrFilingsOptions,
  type SenateFiling,
} from "../ingestion/senateSource.ts";
import {
  type DiscoveredFiling,
  enqueueFilingNew,
  insertFilingIfNew,
  senateFilerId,
} from "../ingestion/watcher.ts";

const SECOND_MS = 1_000;
const SENATE_PAGE_SIZE = 100;
const SENATE_MAX_PAGES = 25;
export const SENATE_SEARCH_RESULT_CAP = SENATE_PAGE_SIZE * SENATE_MAX_PAGES;
export const SENATE_BACKFILL_DEFAULT_MAX_FILINGS = 500;
export const SENATE_BACKFILL_HARD_MAX_FILINGS = 5_000;
export const SENATE_BACKFILL_DEFAULT_MAX_SOURCE_QUERIES = 50;
export const SENATE_BACKFILL_HARD_MAX_SOURCE_QUERIES = 500;

type SenateRangeFetcher = (
  opts: FetchSenatePtrFilingsOptions,
) => Promise<SenateFiling[]>;

export interface SenateBackfillOptions {
  /** Inclusive lower submitted-date bound. YYYY-MM-DD values start at 00:00:00 UTC. */
  fromDate: string | Date;
  /** Inclusive upper submitted-date bound. YYYY-MM-DD values end at 23:59:59 UTC. */
  toDate: string | Date;
  /** Maximum genuinely-new filing rows accepted in this invocation. */
  maxFilings?: number;
  /** Absolute network-query budget, including recursively split ranges. */
  maxSourceQueries?: number;
  /** Search and count only; never touch D1 or the ingestion queue. */
  dryRun?: boolean;
  /** Test seam. Production uses the tracked, session-aware eFD helper. */
  fetchFilingsImpl?: SenateRangeFetcher;
}

export interface SenateBackfillMonthCounts {
  rangesQueried: number;
  sourceRows: number;
  discovered: number;
  inserted: number;
  enqueued: number;
}

export interface SenateBackfillResult {
  fromDate: string;
  toDate: string;
  maxFilings: number;
  maxSourceQueries: number;
  dryRun: boolean;
  /** Network queries, including capped parents that were subsequently split. */
  rangesQueried: number;
  /** Capped ranges recursively split into two smaller ranges. */
  rangesSplit: number;
  /** Rows returned across every source query, including discarded capped parents. */
  sourceRows: number;
  /** Unique, in-bounds filings after recursive search and pipelineDocId de-duplication. */
  discovered: number;
  /** Repeated pipelineDocIds returned by authoritative leaf searches. */
  duplicates: number;
  /** Parseable source rows outside the explicit requested date bounds. */
  outOfRange: number;
  /** Genuinely-new filings rows, each paired with a durable ingestion_outbox row. */
  inserted: number;
  /** Existing filings rejected by INSERT OR IGNORE. */
  alreadyPresent: number;
  /** New rows immediately sent to INGEST_QUEUE. */
  enqueued: number;
  /** New rows durably retained in ingestion_outbox after immediate send did not complete. */
  outboxPending: number;
  dryRunSkipped: number;
  skippedForLimit: number;
  /** Filings left for a later invocation after the D1 write governor deferred. */
  unprocessed: number;
  /** Unsplittable source ranges that still returned the 2,500-row cap. */
  saturatedRanges: number;
  sourceLimitReached: boolean;
  /** Inclusive cursor for an idempotent continuation, or null when complete. */
  nextFromDate: string | null;
  byMonth: Record<string, SenateBackfillMonthCounts>;
  errors: string[];
}

interface DateRange {
  start: Date;
  end: Date;
  month: string;
}

function parseBoundary(
  value: string | Date,
  endOfDay: boolean,
  label: string,
): Date {
  let parsed: Date;
  if (value instanceof Date) {
    parsed = new Date(value.getTime());
  } else {
    const raw = value.trim();
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (dateOnly) {
      const suffix = endOfDay ? "T23:59:59.000Z" : "T00:00:00.000Z";
      parsed = new Date(`${raw}${suffix}`);
      if (parsed.toISOString().slice(0, 10) !== raw) {
        throw new Error(`${label} is not a valid calendar date: ${raw}`);
      }
    } else {
      parsed = new Date(raw);
    }
  }

  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${label} is not a valid date`);
  }
  parsed.setUTCMilliseconds(0);
  return parsed;
}

function boundedMaxFilings(raw: number | undefined): number {
  const value = raw ?? SENATE_BACKFILL_DEFAULT_MAX_FILINGS;
  if (
    !Number.isInteger(value) || value < 0 ||
    value > SENATE_BACKFILL_HARD_MAX_FILINGS
  ) {
    throw new Error(
      `maxFilings must be an integer between 0 and ${SENATE_BACKFILL_HARD_MAX_FILINGS}`,
    );
  }
  return value;
}

function boundedMaxSourceQueries(raw: number | undefined): number {
  const value = raw ?? SENATE_BACKFILL_DEFAULT_MAX_SOURCE_QUERIES;
  if (
    !Number.isInteger(value) || value < 1 ||
    value > SENATE_BACKFILL_HARD_MAX_SOURCE_QUERIES
  ) {
    throw new Error(
      `maxSourceQueries must be an integer between 1 and ${SENATE_BACKFILL_HARD_MAX_SOURCE_QUERIES}`,
    );
  }
  return value;
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function emptyMonthCounts(): SenateBackfillMonthCounts {
  return {
    rangesQueried: 0,
    sourceRows: 0,
    discovered: 0,
    inserted: 0,
    enqueued: 0,
  };
}

function monthlyRanges(from: Date, to: Date): DateRange[] {
  const out: DateRange[] = [];
  let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));

  while (cursor.getTime() <= to.getTime()) {
    const nextMonth = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1),
    );
    const start = new Date(Math.max(cursor.getTime(), from.getTime()));
    const end = new Date(
      Math.min(nextMonth.getTime() - SECOND_MS, to.getTime()),
    );
    if (start.getTime() <= end.getTime()) {
      out.push({ start, end, month: monthKey(start) });
    }
    cursor = nextMonth;
  }

  return out;
}

function bisect(range: DateRange): [DateRange, DateRange] | null {
  const spanSeconds = Math.floor(
    (range.end.getTime() - range.start.getTime()) / SECOND_MS,
  );
  if (spanSeconds < 1) return null;
  const leftEnd = new Date(
    range.start.getTime() + Math.floor(spanSeconds / 2) * SECOND_MS,
  );
  const rightStart = new Date(leftEnd.getTime() + SECOND_MS);
  if (rightStart.getTime() > range.end.getTime()) return null;
  return [
    { start: range.start, end: leftEnd, month: range.month },
    { start: rightStart, end: range.end, month: range.month },
  ];
}

function rangeLabel(range: DateRange): string {
  return `${range.start.toISOString()}..${range.end.toISOString()}`;
}

function filingDateMs(raw: string): number | null {
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (!us) return null;
  const month = Number(us[1]);
  const day = Number(us[2]);
  const year = Number(us[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return date.getTime();
}

function requestedDayBounds(from: Date, to: Date): [number, number] {
  return [
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
    Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()),
  ];
}

function discoveryFrom(filing: SenateFiling): DiscoveredFiling {
  const filerName = filing.fullName ||
    [filing.first, filing.last].filter(Boolean).join(" ").trim() || null;
  return {
    docId: filing.pipelineDocId,
    chamber: "senate",
    sourceUrl: filing.sourceUrl,
    filedDate: filing.filedDate,
    filerId: senateFilerId(filerName),
    filerName,
  };
}

/**
 * Search one explicit Senate eFD history range and hand only genuinely-new PTRs
 * to the canonical filings + ingestion_outbox pipeline.
 */
export async function runSenateBackfill(
  env: Env,
  opts: SenateBackfillOptions,
): Promise<SenateBackfillResult> {
  const from = parseBoundary(opts.fromDate, false, "fromDate");
  const to = parseBoundary(opts.toDate, true, "toDate");
  if (from.getTime() > to.getTime()) {
    throw new Error("fromDate must be before or equal to toDate");
  }

  const maxFilings = boundedMaxFilings(opts.maxFilings);
  const maxSourceQueries = boundedMaxSourceQueries(opts.maxSourceQueries);
  const dryRun = opts.dryRun ?? false;
  const fetchFilings = opts.fetchFilingsImpl ?? fetchSenatePtrFilings;
  const result: SenateBackfillResult = {
    fromDate: from.toISOString(),
    toDate: to.toISOString(),
    maxFilings,
    maxSourceQueries,
    dryRun,
    rangesQueried: 0,
    rangesSplit: 0,
    sourceRows: 0,
    discovered: 0,
    duplicates: 0,
    outOfRange: 0,
    inserted: 0,
    alreadyPresent: 0,
    enqueued: 0,
    outboxPending: 0,
    dryRunSkipped: 0,
    skippedForLimit: 0,
    unprocessed: 0,
    saturatedRanges: 0,
    sourceLimitReached: false,
    nextFromDate: null,
    byMonth: {},
    errors: [],
  };
  if (maxFilings === 0) {
    result.nextFromDate = from.toISOString().slice(0, 10);
    return result;
  }

  const collectRange = async (range: DateRange): Promise<SenateFiling[]> => {
    if (result.rangesQueried >= maxSourceQueries) {
      result.sourceLimitReached = true;
      result.nextFromDate ??= range.start.toISOString().slice(0, 10);
      return [];
    }
    const month = result.byMonth[range.month] ??= emptyMonthCounts();
    result.rangesQueried += 1;
    month.rangesQueried += 1;

    let rows: SenateFiling[];
    try {
      rows = await fetchFilings({
        since: range.start,
        now: range.end,
        maxPages: SENATE_MAX_PAGES,
        pageSize: SENATE_PAGE_SIZE,
        kv: env.CONFIG_KV,
        relayUrl: env.SENATE_RELAY_URL,
        relaySecret: env.SENATE_RELAY_SECRET,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`${rangeLabel(range)}: ${message}`);
      return [];
    }

    result.sourceRows += rows.length;
    month.sourceRows += rows.length;
    if (rows.length < SENATE_SEARCH_RESULT_CAP) return rows;

    const halves = bisect(range);
    if (!halves) {
      result.saturatedRanges += 1;
      result.errors.push(
        `${
          rangeLabel(range)
        }: Senate eFD result remained capped at ${SENATE_SEARCH_RESULT_CAP} rows and cannot be split below one second`,
      );
      return rows;
    }

    result.rangesSplit += 1;
    const left = await collectRange(halves[0]);
    const right = await collectRange(halves[1]);
    return [...left, ...right];
  };

  const unique = new Set<string>();
  const [fromDay, toDay] = requestedDayBounds(from, to);
  const nowIso = new Date().toISOString();
  let stop = false;
  for (const range of monthlyRanges(from, to)) {
    const rows = await collectRange(range);
    for (let index = 0; index < rows.length; index++) {
      const filing = rows[index];
      const filedAt = filingDateMs(filing.filedDate);
      if (filedAt !== null && (filedAt < fromDay || filedAt > toDay)) {
        result.outOfRange += 1;
        continue;
      }
      if (unique.has(filing.pipelineDocId)) {
        result.duplicates += 1;
        continue;
      }
      unique.add(filing.pipelineDocId);
      result.discovered += 1;
      result.byMonth[range.month].discovered += 1;

      if (dryRun) {
        result.dryRunSkipped += 1;
        if (result.dryRunSkipped >= maxFilings) {
          result.skippedForLimit += rows.length - index - 1;
          result.nextFromDate = range.start.toISOString().slice(0, 10);
          stop = true;
          break;
        }
        continue;
      }

      const discovered = discoveryFrom(filing);
      const insertResult = await insertFilingIfNew(env, discovered, nowIso);
      if (insertResult === "deferred") {
        result.unprocessed = rows.length - index;
        result.nextFromDate = range.start.toISOString().slice(0, 10);
        result.errors.push(
          `D1 write governor deferred at ${discovered.docId}; rerun the idempotent backfill to continue`,
        );
        stop = true;
        break;
      }
      if (insertResult === "duplicate") {
        result.alreadyPresent += 1;
        continue;
      }

      result.inserted += 1;
      result.byMonth[range.month].inserted += 1;
      try {
        const sent = await enqueueFilingNew(env, discovered);
        if (sent) {
          result.enqueued += 1;
          result.byMonth[range.month].enqueued += 1;
        } else {
          result.outboxPending += 1;
        }
      } catch (err) {
        result.outboxPending += 1;
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(
          `${discovered.docId}: immediate ingestion enqueue failed: ${message}`,
        );
      }

      if (result.inserted >= maxFilings) {
        result.skippedForLimit += rows.length - index - 1;
        result.nextFromDate = range.start.toISOString().slice(0, 10);
        stop = true;
        break;
      }
    }
    if (stop || result.sourceLimitReached) break;
  }

  return result;
}
