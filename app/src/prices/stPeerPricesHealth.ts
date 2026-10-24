/**
 * Socratic.Trade → Congress.Trade peer price lane health (EOD/current refresh).
 * Shared by `/api/health` (`st_peer_prices` check) and pipeline loud stall alerts.
 */

import type { Env } from '../shared/types.ts';
import { all, get } from '../shared/db.ts';
import { hasConfiguredKeyedEnrichmentProvider } from '../enrichment/service.ts';
import {
  isTailOnlyPeerPriceBacklog,
  readCorpusLatestPriceDate,
  stPeerPriceNeverPricedPendingFromSql,
  stPeerPricePendingBindParams,
  stPeerPricePendingBindsForSubqueries,
  stPeerPricePendingFromSql,
} from './peerPricePending.ts';
import { stNotCoveredTickersFromSql } from './notCovered.ts';
import type { PipelineCheck, PipelineStatus } from '../shared/pipelineHealth.ts';

export interface StPeerPricesMetrics {
  configured: boolean;
  skip: boolean;
  pending: number;
  neverPricedPending: number;
  lastProgressAt: string | null;
  lastAnyPriceCheckedAt: string | null;
  corpusLatestDate: string | null;
  freshThrough: string;
  pendingSample: string[];
  /** Stage-4 tickers (ST cannot price them): visible, but never stall/degrade on their own. */
  notCovered: number;
  notCoveredSample: string[];
  stallThresholdHours: number;
  stalled: boolean;
  detail: string;
}

function pendingPriceProgressIdle(lastAt: string | null, now: Date, thresholdMs: number): boolean {
  const lastMs = lastAt ? Date.parse(lastAt) : NaN;
  if (!Number.isFinite(lastMs)) return false;
  return now.getTime() - lastMs >= thresholdMs;
}

export function hoursSinceIso(lastAt: string | null, now: Date): string {
  const lastMs = lastAt ? Date.parse(lastAt) : NaN;
  if (!Number.isFinite(lastMs)) return 'never';
  return ((now.getTime() - lastMs) / 3_600_000).toFixed(1);
}

async function readLastAnyPriceCheckedAt(env: Env): Promise<string | null> {
  try {
    const row = await get<{ at: string | null }>(
      env.DB,
      `SELECT MAX(price_checked_at) AS at FROM securities_ref WHERE price_checked_at IS NOT NULL`,
    );
    return row?.at ?? null;
  } catch {
    return null;
  }
}

/**
 * Evaluate ST peer price transfer freshness. When `stallThresholdHours` is set,
 * `stalled` follows the same rules as the hourly `st_peer_prices` loud alert.
 */
export async function collectStPeerPricesMetrics(
  env: Env,
  now: Date,
  stallThresholdHours: number,
): Promise<StPeerPricesMetrics> {
  const configured = await hasConfiguredKeyedEnrichmentProvider(env);
  if (!configured) {
    return {
      configured: false,
      skip: true,
      pending: 0,
      neverPricedPending: 0,
      lastProgressAt: null,
      lastAnyPriceCheckedAt: null,
      corpusLatestDate: null,
      freshThrough: '',
      pendingSample: [],
      notCovered: 0,
      notCoveredSample: [],
      stallThresholdHours,
      stalled: false,
      detail: 'ST peer prices not configured',
    };
  }

  const pendingParams = stPeerPricePendingBindParams(now);
  const pendingFrom = stPeerPricePendingFromSql();
  const neverPricedFrom = stPeerPriceNeverPricedPendingFromSql();
  const countAndProgressBinds = stPeerPricePendingBindsForSubqueries(pendingParams, 3);
  const thresholdMs = stallThresholdHours * 3_600_000;

  let pending = 0;
  let neverPricedPending = 0;
  let lastProgressAt: string | null = null;
  let pendingSample: string[] = [];
  try {
    const row = await get<{ n: number; never_n: number; last_at: string | null }>(
      env.DB,
      `SELECT
         (SELECT COUNT(DISTINCT t.ticker) ${pendingFrom}) AS n,
         (SELECT COUNT(DISTINCT t.ticker) ${neverPricedFrom}) AS never_n,
         (SELECT MAX(sr.price_checked_at) ${pendingFrom}) AS last_at`,
      countAndProgressBinds,
    );
    pending = Number(row?.n ?? 0);
    neverPricedPending = Number(row?.never_n ?? 0);
    lastProgressAt = row?.last_at ?? null;
  } catch {
    return {
      configured: true,
      skip: true,
      pending: 0,
      neverPricedPending: 0,
      lastProgressAt: null,
      lastAnyPriceCheckedAt: null,
      corpusLatestDate: null,
      freshThrough: pendingParams.freshThrough,
      pendingSample: [],
      notCovered: 0,
      notCoveredSample: [],
      stallThresholdHours,
      stalled: false,
      detail: 'ST price stall query failed',
    };
  }

  const corpusLatestDate = await readCorpusLatestPriceDate(env);
  const lastAnyPriceCheckedAt = await readLastAnyPriceCheckedAt(env);

  // Visibility-only: stage-4 tickers ST cannot price. Best-effort — a failure
  // here must not fail the whole check, and the count never affects status.
  let notCovered = 0;
  let notCoveredSample: string[] = [];
  try {
    const ncRow = await get<{ n: number }>(
      env.DB,
      `SELECT COUNT(*) AS n ${stNotCoveredTickersFromSql()}`,
    );
    notCovered = Number(ncRow?.n ?? 0);
    if (notCovered > 0) {
      const names = await all<{ ticker: string }>(
        env.DB,
        `SELECT sr.ticker AS ticker ${stNotCoveredTickersFromSql()}
         ORDER BY sr.ticker ASC
         LIMIT 10`,
      );
      notCoveredSample = names.map((r) => r.ticker);
    }
  } catch {
    /* optional */
  }
  const notCoveredSuffix = notCovered > 0 ? `; ${notCovered} not covered by ST` : '';

  if (pending <= 0) {
    return {
      configured: true,
      skip: false,
      pending,
      neverPricedPending,
      lastProgressAt,
      lastAnyPriceCheckedAt,
      corpusLatestDate,
      freshThrough: pendingParams.freshThrough,
      pendingSample: [],
      notCovered,
      notCoveredSample,
      stallThresholdHours,
      stalled: false,
      detail: 'ST price refresh moving (no pending tickers)' + notCoveredSuffix,
    };
  }

  if (isTailOnlyPeerPriceBacklog(pending, neverPricedPending, corpusLatestDate, now)) {
    return {
      configured: true,
      skip: false,
      pending,
      neverPricedPending,
      lastProgressAt,
      lastAnyPriceCheckedAt,
      corpusLatestDate,
      freshThrough: pendingParams.freshThrough,
      pendingSample: [],
      notCovered,
      notCoveredSample,
      stallThresholdHours,
      stalled: false,
      detail:
        `ST price tail backlog only (${pending} pending); corpus EOD current through ${pendingParams.freshThrough}` +
        notCoveredSuffix,
    };
  }

  if (!pendingPriceProgressIdle(lastProgressAt, now, thresholdMs)) {
    try {
      const names = await all<{ ticker: string }>(
        env.DB,
        `SELECT DISTINCT t.ticker AS ticker ${pendingFrom}
         ORDER BY t.ticker ASC
         LIMIT 10`,
        stPeerPricePendingBindsForSubqueries(pendingParams, 1),
      );
      pendingSample = names.map((r) => r.ticker);
    } catch {
      /* optional */
    }
    const sampleSuffix = pendingSample.length ? `; pending sample: ${pendingSample.join(', ')}` : '';
    return {
      configured: true,
      skip: false,
      pending,
      neverPricedPending,
      lastProgressAt,
      lastAnyPriceCheckedAt,
      corpusLatestDate,
      freshThrough: pendingParams.freshThrough,
      pendingSample,
      notCovered,
      notCoveredSample,
      stallThresholdHours,
      stalled: false,
      detail:
        `${pending} ticker(s) pending ST EOD/current prices${sampleSuffix}; ` +
        `price_checked_at progress ${hoursSinceIso(lastProgressAt, now)}h ago on pending set (under ${stallThresholdHours}h threshold)` +
        notCoveredSuffix,
    };
  }

  try {
    const names = await all<{ ticker: string }>(
      env.DB,
      `SELECT DISTINCT t.ticker AS ticker ${pendingFrom}
       ORDER BY t.ticker ASC
       LIMIT 10`,
      stPeerPricePendingBindsForSubqueries(pendingParams, 1),
    );
    pendingSample = names.map((r) => r.ticker);
  } catch {
    /* optional */
  }
  const sampleSuffix = pendingSample.length ? `; pending sample: ${pendingSample.join(', ')}` : '';
  const detail =
    `${pending} ticker(s) still need EOD/current prices from Socratic.Trade` +
    sampleSuffix +
    `; no price_checked_at progress on pending tickers in ${hoursSinceIso(lastProgressAt, now)}h (threshold ${stallThresholdHours}h)` +
    notCoveredSuffix;

  return {
    configured: true,
    skip: false,
    pending,
    neverPricedPending,
    lastProgressAt,
    lastAnyPriceCheckedAt,
    corpusLatestDate,
    freshThrough: pendingParams.freshThrough,
    pendingSample,
    notCovered,
    notCoveredSample,
    stallThresholdHours,
    stalled: true,
    detail,
  };
}

export function stPeerPricesMetricsToCheck(metrics: StPeerPricesMetrics): PipelineCheck {
  let status: PipelineStatus = 'ok';
  if (!metrics.configured || metrics.skip) {
    status = metrics.configured && metrics.detail.includes('failed') ? 'unknown' : 'ok';
  } else if (metrics.stalled) {
    status = 'stalled';
  } else if (metrics.pending > 0) {
    status = 'degraded';
  }

  return {
    id: 'st_peer_prices',
    status,
    detail: metrics.detail,
    value: {
      pending: metrics.pending,
      neverPricedPending: metrics.neverPricedPending,
      freshThrough: metrics.freshThrough,
      corpusLatestDate: metrics.corpusLatestDate,
      lastProgressAt: metrics.lastProgressAt,
      lastAnyPriceCheckedAt: metrics.lastAnyPriceCheckedAt,
      stallThresholdHours: metrics.stallThresholdHours,
      pendingSample: metrics.pendingSample,
      notCovered: metrics.notCovered,
      notCoveredSample: metrics.notCoveredSample,
    },
  };
}

/** Thin adapter for pipeline loud alerts (stall detector). */
export async function evaluateStPeerPricesStall(
  env: Env,
  now: Date,
  thresholdMs: number,
): Promise<{ stalled: boolean; detail: string; skip?: boolean }> {
  const stallThresholdHours = Math.max(1, Math.round(thresholdMs / 3_600_000));
  const metrics = await collectStPeerPricesMetrics(env, now, stallThresholdHours);
  if (!metrics.configured) {
    return { stalled: false, detail: metrics.detail, skip: true };
  }
  if (metrics.skip) {
    return { stalled: false, detail: metrics.detail, skip: true };
  }
  return { stalled: metrics.stalled, detail: metrics.detail };
}
