/**
 * src/share/outbound.ts
 * OWNER: foundation
 *
 * The return half of the cross-app data share. App B pushes the prices/refs it
 * fetched into congress.trade's /securities/import; this pushes the prices/refs
 * *we* fetched back to App B's equivalent endpoint, so the two apps act as one
 * shared cache and neither double-fetches.
 *
 * No-loop guarantee: we only send what THIS run fetched (the deltas returned by
 * runPriceRefresh / runEnrichment). Because our refresh is gap-fill + staleness-
 * gated, anything App B keeps fresh is never re-fetched here, so it never ends up
 * in our delta — an import we received from App B is never echoed back.
 *
 * Env-gated: a no-op unless BOTH APP_B_IMPORT_URL and APP_B_INGEST_TOKEN are set.
 */

import {
  SharePayloadSchema,
  type PriceClose,
  type PriceSeries,
  type SecurityRefInput,
  type TradeEventRow,
} from '@jaywedgeworth22/congress-trading-shared';
import type { SecurityRef } from '../enrichment/types.ts';
import { resolveSecrets } from '../secrets/infisical.ts';
import type { Env } from '../shared/types.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import {
  checkTargetCircuit,
  recordTargetFailure,
  recordTargetSuccess,
  targetKeyForUrl,
} from '../delivery/targetCircuit.ts';
import { notifyAdmin } from '../alerts/notify.ts';
import { sentryLoggerWarn } from '../shared/sentryRuntime.ts';
import {
  interpretPeerPushReceipt,
  PEER_PUSH_ID_HEADER,
  type PeerPushAcks,
  type PeerPushHealth,
} from './peerPushReceipt.ts';

type PeerEnv = Env & { APP_B_IMPORT_URL?: string; APP_B_INGEST_TOKEN?: string };

export interface PeerShareInput {
  refs?: SecurityRef[];
  prices?: PriceSeries[];
  spx?: PriceClose[];
  trades?: TradeEventRow[];
}

export interface PeerShareResult {
  sent: boolean;
  reason?: string;
  status?: number;
  counts?: { refs: number; prices: number; spx: number; trades: number };
  pushId?: string;
  health?: PeerPushHealth;
  acks?: PeerPushAcks;
}

/** The REF fields App B's /securities/import consumes (mirrors its REF_KEYS). */
function toImportRef(r: SecurityRef): SecurityRefInput {
  return {
    ticker: r.ticker,
    companyName: r.companyName,
    sector: r.sector,
    industry: r.industry,
    assetClass: r.assetClass,
    isEtf: r.isEtf,
    isAdr: r.isAdr,
    country: r.country,
    stateHq: r.stateHq,
    stateOfIncorp: r.stateOfIncorp,
    exchange: r.exchange,
    exchangeShort: r.exchangeShort,
    currency: r.currency,
    marketCap: r.marketCap,
    sharesOutstanding: r.sharesOutstanding,
    ipoDate: r.ipoDate,
    cik: r.cik,
    sicCode: r.sicCode,
    sicDescription: r.sicDescription,
  };
}

/**
 * POST our freshly-fetched delta to App B's import endpoint. Returns a structured
 * result (never throws) so the daily job can log it without aborting.
 */
export async function shareWithPeer(
  env: Env,
  input: PeerShareInput,
  fetchImpl: typeof fetch = fetch,
): Promise<PeerShareResult> {
  const runtimeSecrets = await resolveSecrets(env, ['APP_B_IMPORT_URL', 'APP_B_INGEST_TOKEN']);
  const { APP_B_IMPORT_URL: url, APP_B_INGEST_TOKEN: token } = { ...(env as PeerEnv), ...runtimeSecrets };
  if (!url || !token) return { sent: false, reason: 'peer not configured' };

  const refs = input.refs ?? [];
  const prices = input.prices ?? [];
  const spx = input.spx ?? [];
  const trades = input.trades ?? [];
  if (refs.length === 0 && prices.length === 0 && spx.length === 0 && trades.length === 0) {
    return { sent: false, reason: 'nothing to share' };
  }

  const payload = {
    refs: refs.map(toImportRef),
    prices,
    spx: spx.map((c) => ({ date: c.date, close: c.close })),
    trades,
    origin: 'app-a',
  };
  const parsed = SharePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { sent: false, reason: 'invalid shared payload: ' + parsed.error.issues[0]?.message };
  }
  // Added after the shared schema parse.  SharePayloadSchema strips unknown keys,
  // and the peer's local schema is what keeps pushId.
  const pushId = crypto.randomUUID();
  const body = JSON.stringify({ ...parsed.data, pushId });

  // GOVERNOR 3: the peer app is an outbound target like any other — a peer
  // outage opens its circuit and this daily push quietly skips (the data is a
  // shared-cache optimization, never required), instead of hammering a dead
  // peer endpoint.
  const targetKey = targetKeyForUrl(url, 'peer-app');
  if (targetKey) {
    const gate = await checkTargetCircuit(env, targetKey);
    if (!gate.allowed) {
      return { sent: false, reason: `peer target circuit ${(gate as any).reason}` };
    }
  }

  try {
    const res = await trackedFetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        [PEER_PUSH_ID_HEADER]: pushId,
      },
      body,
    }, { service: 'peer-data-share', operation: 'push-market-data', dynamicTarget: 'peer-app' }, fetchImpl);
    const counts = { refs: refs.length, prices: prices.length, spx: spx.length, trades: trades.length };
    if (!res.ok) {
      if (targetKey) await recordTargetFailure(env, targetKey, `HTTP ${res.status}`);
      return { sent: false, reason: 'peer import failed: HTTP ' + res.status, status: res.status, counts, pushId };
    }
    if (targetKey) await recordTargetSuccess(env, targetKey);
    const rawText = await res.text();
    let parsedBody: unknown;
    try {
      parsedBody = rawText ? JSON.parse(rawText) : undefined;
    } catch {
      parsedBody = undefined;
    }
    const receipt = interpretPeerPushReceipt(parsedBody, pushId);
    if (receipt.health !== 'ok') {
      await alertMissingPeerPushAcks(env, pushId, receipt.health);
      return {
        sent: false,
        reason: 'peer import receipt ' + receipt.health,
        status: res.status,
        counts,
        pushId,
        health: receipt.health,
        acks: receipt.acks,
      };
    }
    return { sent: true, status: res.status, counts, pushId, health: 'ok', acks: receipt.acks };
  } catch (e) {
    if (targetKey) await recordTargetFailure(env, targetKey, (e as Error).message ?? 'fetch failed');
    return { sent: false, reason: 'peer import error: ' + (e as Error).message, pushId };
  }
}

/** Page when a 2xx peer body has no delivered or consumed ack.  Email is throttled. */
async function alertMissingPeerPushAcks(env: Env, pushId: string, health: PeerPushHealth): Promise<void> {
  sentryLoggerWarn('peer.push.missing_ack', { pushId, health });
  await notifyAdmin(env, {
    subject: 'Congress.Trade peer push is missing an ack',
    text:
      'A push to Socratic-Trade returned HTTP success without a complete receipt.  ' +
      `pushId=${pushId} health=${health}.  ` +
      'Expected x-push-id echoed as pushId, plus acks.delivered and acks.consumed.',
    dedupeKey: 'peer-push-missing-ack',
  });
}
