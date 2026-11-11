/**
 * Time since the peer-price drain last made real progress (CT-2469).
 * Distinct from MAX(price_checked_at) over the pending set, which tracks the
 * newest check among rows still pending and misfires while a large backlog
 * drains.
 */

import type { Env } from '../shared/types.ts';

export const PRICE_DRAIN_LAST_PROGRESS_KEY = 'jobs:market-data:price-drain-last-progress-at';
const PRICE_DRAIN_LAST_PROGRESS_TTL_S = 14 * 86_400;

/** Persist the ISO timestamp when the drain shrank pending or priced tickers. */
export async function recordPeerPriceDrainProgress(env: Env, at: Date | string): Promise<void> {
  if (!env.CONFIG_KV) return;
  const iso = typeof at === 'string' ? at : at.toISOString();
  if (!Number.isFinite(Date.parse(iso))) return;
  try {
    await env.CONFIG_KV.put(PRICE_DRAIN_LAST_PROGRESS_KEY, iso, {
      expirationTtl: PRICE_DRAIN_LAST_PROGRESS_TTL_S,
    });
  } catch {
    /* best-effort */
  }
}

export async function readPeerPriceDrainLastProgressAt(env: Env): Promise<string | null> {
  if (!env.CONFIG_KV) return null;
  try {
    const raw = await env.CONFIG_KV.get(PRICE_DRAIN_LAST_PROGRESS_KEY);
    if (!raw) return null;
    return Number.isFinite(Date.parse(raw)) ? raw : null;
  } catch {
    return null;
  }
}

export function peerPriceDrainMadeProgress(run: {
  pendingBefore: number;
  pendingAfter: number | null;
  tickersPriced?: number;
}): boolean {
  if (run.pendingAfter !== null && run.pendingAfter < run.pendingBefore) return true;
  return (run.tickersPriced ?? 0) > 0;
}
