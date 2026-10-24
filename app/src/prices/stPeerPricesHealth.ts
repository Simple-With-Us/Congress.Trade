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
import type { PipelineCheck, PipelineStatus } from '../shared/pipelineHealth.ts';

export interface StPeerPricesMetrics {
  configured: boolean;
  skip: boolean;
  pending: number;
  neverPricedPending: number;
  lastProgressAt: string | null;
  corpusLatestDate: string | null;
  freshThrough: string;
  pendingSample: string[];
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

/** `12.3h ago`, or `never` when there is no parseable timestamp (no `neverh ago`). */
export function progressAgoLabel(lastAt: string | null, now: Date): string {
  const h = hoursSinceIso(lastAt, now);
  return h === 'never' ? 'never' : `${h}h ago`;
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
      corpusLatestDate: null,
      freshThrough: '',
      pendingSample: [],
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
      corpusLatestDate: null,
      freshThrough: pendingParams.freshThrough,
      pendingSample: [],
      stallThresholdHours,
      stalled: false,
      detail: 'ST price stall query failed',
    };
  }

  const corpusLatestDate = await readCorpusLatestPriceDate(env);

  if (pending <= 0) {
    return {
      configured: true,
      skip: false,
      pending,
      neverPricedPending,
      lastProgressAt,
      corpusLatestDate,
      freshThrough: pendingParams.freshThrough,
      pendingSample: [],
      stallThresholdHours,
      stalled: false,
      detail: 'ST price refresh moving (no pending tickers)',
    };
  }

  if (isTailOnlyPeerPriceBacklog(pending, neverPricedPending, corpusLatestDate, now)) {
    return {
      configured: true,
      skip: false,
      pending,
      neverPricedPending,
      lastProgressAt,
      corpusLatestDate,
      freshThrough: pendingParams.freshThrough,
      pendingSample: [],
      stallThresholdHours,
      stalled: false,
      detail:
        `ST price tail backlog only (${pending} pending); corpus EOD current through ${pendingParams.freshThrough}`,
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
      corpusLatestDate,
      freshThrough: pendingParams.freshThrough,
      pendingSample,
      stallThresholdHours,
      stalled: false,
      detail:
        `${pending} ticker(s) pending ST EOD/current prices${sampleSuffix}; ` +
        `price_checked_at progress ${progressAgoLabel(lastProgressAt, now)} on pending set (under ${stallThresholdHours}h threshold)`,
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
    `; no price_checked_at progress on pending tickers in ${hoursSinceIso(lastProgressAt, now)}h (threshold ${stallThresholdHours}h)`;

  return {
    configured: true,
    skip: false,
    pending,
    neverPricedPending,
    lastProgressAt,
    corpusLatestDate,
    freshThrough: pendingParams.freshThrough,
    pendingSample,
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
  }
  // A non-stalled backlog (in progress under the threshold, or the tail-only
  // case with a current corpus) stays ok:  the loud alert treats it as healthy
  // too, and there is almost always some pending ticker, so 'degraded' here
  // would pin pipeline.status off ok.  pending stays in value and detail.

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
      stallThresholdHours: metrics.stallThresholdHours,
      pendingSample: metrics.pendingSample,
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
