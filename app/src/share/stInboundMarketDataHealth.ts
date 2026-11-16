/**
 * ST → CT donated/pushed market-data stream health (POST /api/admin/securities/import).
 * Complements the st_peer_prices pull lane: when peer pull is still advancing,
 * a quiet push path is degraded, not pipeline.stalled.
 */

import type { Env } from '../shared/types.ts';
import { get } from '../shared/db.ts';
import { hasConfiguredKeyedEnrichmentProvider } from '../enrichment/service.ts';
import {
  evaluateFreshness,
  FRESHNESS_LATEST_SQL,
  scaledFreshnessMaxAgeDays,
  type FreshnessSnapshot,
  type FreshnessStream,
  type StaleStream,
} from './freshness.ts';
import {
  collectStPeerPricesMetrics,
  type StPeerPricesMetrics,
} from '../prices/stPeerPricesHealth.ts';
import type { PipelineCheck, PipelineStatus } from '../shared/pipelineHealth.ts';
import { readPipelineStallHours, stallWindowMs } from '../ingestion/pipelineStallConfig.ts';

export interface PeerImportReceiptSummary {
  lastReceivedAt: string | null;
  lastOkAt: string | null;
  lastFailedAt: string | null;
}

export interface StInboundMarketDataMetrics {
  configured: boolean;
  skip: boolean;
  staleStreams: StaleStream[];
  /** Stale streams that still matter for paging when peer pull is healthy. */
  stalePushStreams: FreshnessStream[];
  peerPull: Pick<StPeerPricesMetrics, 'configured' | 'skip' | 'stalled' | 'detail' | 'lastProgressAt'>;
  receipts: PeerImportReceiptSummary | null;
  status: PipelineStatus;
  /** Loud pipeline.stalled alerts fire only when this is true. */
  stalled: boolean;
  detail: string;
}

async function loadFreshnessSnapshot(env: Env): Promise<FreshnessSnapshot | null> {
  try {
    const row = await get<{
      spx_latest: string | null;
      price_latest: string | null;
      fundamentals_latest: string | null;
      insider_latest: string | null;
      short_volume_latest: string | null;
      analyst_latest: string | null;
    }>(env.DB, FRESHNESS_LATEST_SQL);
    return {
      spxLatestDate: row?.spx_latest ?? null,
      priceLatestDate: row?.price_latest ?? null,
      fundamentalsLatest: row?.fundamentals_latest ?? null,
      insiderLatestDate: row?.insider_latest ?? null,
      shortVolumeLatestDate: row?.short_volume_latest ?? null,
      analystLatest: row?.analyst_latest ?? null,
    };
  } catch {
    return null;
  }
}

export async function readPeerImportReceiptSummary(env: Env): Promise<PeerImportReceiptSummary | null> {
  try {
    const row = await get<{
      last_received_at: string | null;
      last_ok_at: string | null;
      last_failed_at: string | null;
    }>(
      env.DB,
      `SELECT
         (SELECT MAX(received_at) FROM peer_import_receipts) AS last_received_at,
         (SELECT MAX(received_at) FROM peer_import_receipts WHERE ok = 1) AS last_ok_at,
         (SELECT MAX(received_at) FROM peer_import_receipts WHERE ok = 0) AS last_failed_at`,
    );
    if (!row) return null;
    return {
      lastReceivedAt: row.last_received_at ?? null,
      lastOkAt: row.last_ok_at ?? null,
      lastFailedAt: row.last_failed_at ?? null,
    };
  } catch {
    return null;
  }
}

function staleStreamDetail(stale: StaleStream[]): string {
  return stale
    .map((s) => `${s.stream} last ${s.latest} (${s.ageDays}d ago)`)
    .join('; ');
}

function receiptHint(receipts: PeerImportReceiptSummary | null): string {
  if (!receipts) return '';
  const parts: string[] = [];
  if (receipts.lastOkAt) parts.push(`last ok push ${receipts.lastOkAt}`);
  if (receipts.lastFailedAt && receipts.lastFailedAt !== receipts.lastOkAt) {
    parts.push(`last failed push ${receipts.lastFailedAt}`);
  }
  if (!receipts.lastReceivedAt) {
    parts.push('no peer_import_receipts yet (check INGEST_TOKEN on ST sender)');
  } else if (!receipts.lastOkAt) {
    parts.push(`pushes seen but none ok (last attempt ${receipts.lastReceivedAt})`);
  }
  return parts.length ? `; ${parts.join('; ')}` : '';
}

/**
 * Streams that only reflect the ST push when peer pull is still healthy.
 * A stale `prices` row here usually means the push lane went quiet after
 * CT-838 peer-primary pricing, not that coverage is gone.
 */
export function pushOnlyStreamsWhenPeerPullFresh(stale: StaleStream[]): FreshnessStream[] {
  return stale
    .map((s) => s.stream)
    .filter((stream) => stream !== 'prices');
}

export function decideStInboundStatus(input: {
  staleStreams: StaleStream[];
  stalePushStreams: FreshnessStream[];
  peerPullStalled: boolean;
  peerPullConfigured: boolean;
  receipts: PeerImportReceiptSummary | null;
}): { status: PipelineStatus; stalled: boolean; detail: string } {
  if (input.staleStreams.length === 0) {
    return { status: 'ok', stalled: false, detail: 'inbound market-data streams fresh' };
  }

  const pushStaleDetail = `Stale Socratic.Trade donated streams: ${staleStreamDetail(input.staleStreams)}`;
  const receiptSuffix = receiptHint(input.receipts);

  if (input.stalePushStreams.length === 0) {
    const onlyPrices = input.staleStreams.every((s) => s.stream === 'prices');
    const detail =
      onlyPrices
        ? `ST push prices stream quiet but st_peer_prices pull still covers EOD` +
          receiptSuffix
        : pushStaleDetail + receiptSuffix;
    return { status: 'ok', stalled: false, detail };
  }

  if (input.peerPullConfigured && !input.peerPullStalled) {
    return {
      status: 'degraded',
      stalled: false,
      detail:
        `${pushStaleDetail}; cause: ST push lane stale while st_peer_prices pull ` +
        `still advancing (check ST congress-share / INGEST_TOKEN)${receiptSuffix}`,
    };
  }

  return {
    status: 'stalled',
    stalled: true,
    detail:
      `${pushStaleDetail}; cause: both ST push and st_peer_prices pull are stale` +
      receiptSuffix,
  };
}

export async function collectStInboundMarketDataMetrics(
  env: Env,
  now: Date,
  stallThresholdHours?: number,
): Promise<StInboundMarketDataMetrics> {
  const hours = stallThresholdHours ?? readPipelineStallHours(env, 'st_inbound_market_data');
  const thresholdMs = stallWindowMs(hours);
  const configured = await hasConfiguredKeyedEnrichmentProvider(env);
  if (!configured) {
    return {
      configured: false,
      skip: true,
      staleStreams: [],
      stalePushStreams: [],
      peerPull: { configured: false, skip: true, stalled: false, detail: '', lastProgressAt: null },
      receipts: null,
      status: 'ok',
      stalled: false,
      detail: 'ST inbound streams not configured',
    };
  }

  const snapshot = await loadFreshnessSnapshot(env);
  if (!snapshot) {
    return {
      configured: true,
      skip: true,
      staleStreams: [],
      stalePushStreams: [],
      peerPull: { configured: true, skip: true, stalled: false, detail: '', lastProgressAt: null },
      receipts: null,
      status: 'unknown',
      stalled: false,
      detail: 'freshness snapshot unavailable',
    };
  }

  const maxAge = scaledFreshnessMaxAgeDays(thresholdMs);
  const staleStreams = evaluateFreshness(snapshot, now.getTime(), maxAge);
  const peerMetrics = await collectStPeerPricesMetrics(env, now, hours);
  const receipts = await readPeerImportReceiptSummary(env);
  const stalePushStreams = pushOnlyStreamsWhenPeerPullFresh(staleStreams);
  const peerPullStalled = !peerMetrics.skip && peerMetrics.stalled;
  const decided = decideStInboundStatus({
    staleStreams,
    stalePushStreams,
    peerPullStalled,
    peerPullConfigured: peerMetrics.configured && !peerMetrics.skip,
    receipts,
  });

  return {
    configured: true,
    skip: false,
    staleStreams,
    stalePushStreams,
    peerPull: {
      configured: peerMetrics.configured,
      skip: peerMetrics.skip,
      stalled: peerMetrics.stalled,
      detail: peerMetrics.detail,
      lastProgressAt: peerMetrics.lastProgressAt,
    },
    receipts,
    status: decided.status,
    stalled: decided.stalled,
    detail: decided.detail,
  };
}

export function stInboundMarketDataMetricsToCheck(metrics: StInboundMarketDataMetrics): PipelineCheck {
  let status: PipelineStatus = metrics.status;
  if (metrics.skip) {
    status = metrics.configured ? 'unknown' : 'ok';
  }
  return {
    id: 'st_inbound_market_data',
    status,
    detail: metrics.detail,
    value: {
      staleStreams: metrics.staleStreams,
      stalePushStreams: metrics.stalePushStreams,
      peerPullStalled: metrics.peerPull.stalled,
      peerPullLastProgressAt: metrics.peerPull.lastProgressAt,
      lastOkPushAt: metrics.receipts?.lastOkAt ?? null,
      lastPushAttemptAt: metrics.receipts?.lastReceivedAt ?? null,
    },
  };
}

/** Adapter for pipeline loud alerts (stall detector). */
export async function evaluateStInboundMarketDataStall(
  env: Env,
  now: Date,
  thresholdMs: number,
): Promise<{ stalled: boolean; detail: string; skip?: boolean }> {
  const stallThresholdHours = Math.max(1, Math.round(thresholdMs / 3_600_000));
  const metrics = await collectStInboundMarketDataMetrics(env, now, stallThresholdHours);
  if (!metrics.configured) {
    return { stalled: false, detail: metrics.detail, skip: true };
  }
  if (metrics.skip) {
    return { stalled: false, detail: metrics.detail, skip: true };
  }
  return { stalled: metrics.stalled, detail: metrics.detail };
}
