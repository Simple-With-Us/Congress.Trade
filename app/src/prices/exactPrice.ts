/**
 * src/prices/exactPrice.ts
 * OWNER: prices
 *
 * Exact-time (minute-level) price lookup for a ticker at an ISO instant.
 * Uses the Socratic.Trade peer's 1-minute bars. Refuses options and event
 * contracts instead of substituting an equity print.
 */

import type { Env } from '../shared/types.ts';
import { resolveSecrets } from '../secrets/infisical.ts';
import {
  fetchPeerIntradayBars,
  nearestBarAtOrAfter,
} from './peerMarketData.ts';
import {
  canCaptureMinutePricing,
  classifyInstrument,
  type InstrumentClass,
  type InstrumentHints,
} from './instrumentCapabilities.ts';

const BACKFILL_TOLERANCE_MIN = 5;

type EnvX = Env & {
  APP_B_IMPORT_URL?: string;
  APP_B_INGEST_TOKEN?: string;
};

async function peerConfig(env: Env): Promise<{ url?: string; token?: string }> {
  const resolved = await resolveSecrets(env, ['APP_B_IMPORT_URL', 'APP_B_INGEST_TOKEN']);
  const envx = env as EnvX;
  return {
    url: resolved.APP_B_IMPORT_URL || envx.APP_B_IMPORT_URL,
    token: resolved.APP_B_INGEST_TOKEN || envx.APP_B_INGEST_TOKEN,
  };
}

export type ExactPriceOk = {
  ok: true;
  ticker: string;
  requestedAt: string;
  barAt: string;
  price: number;
  source: string;
  instrumentClass: InstrumentClass;
};

export type ExactPriceMiss = {
  ok: false;
  reason:
    | 'unsupported_instrument'
    | 'bad_ticker'
    | 'bad_time'
    | 'peer_unconfigured'
    | 'peer_unavailable'
    | 'no_bars';
  message: string;
  instrumentClass?: InstrumentClass;
};

export type ExactPriceResult = ExactPriceOk | ExactPriceMiss;

export async function lookupExactMinutePrice(
  env: Env,
  input: InstrumentHints & { atIso: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ExactPriceResult> {
  const ticker = (input.ticker || '').trim().toUpperCase();
  const instrumentClass = classifyInstrument({ ...input, ticker });
  if (!ticker) {
    return { ok: false, reason: 'bad_ticker', message: 'Ticker is required.', instrumentClass };
  }
  const atMs = Date.parse(input.atIso);
  if (!Number.isFinite(atMs)) {
    return { ok: false, reason: 'bad_time', message: 'at must be a valid ISO-8601 timestamp.', instrumentClass };
  }
  if (!canCaptureMinutePricing({ ...input, ticker })) {
    return {
      ok: false,
      reason: 'unsupported_instrument',
      instrumentClass,
      message:
        instrumentClass === 'option'
          ? 'Options are not priced from equity minute bars.'
          : instrumentClass === 'event_contract'
            ? 'Event contracts are not priced from equity minute bars.'
            : 'This instrument class does not support minute-level pricing.',
    };
  }

  const { url, token } = await peerConfig(env);
  if (!url) {
    return {
      ok: false,
      reason: 'peer_unconfigured',
      instrumentClass,
      message: 'Peer market-data URL is not configured.',
    };
  }

  const startIso = new Date(atMs).toISOString();
  const endIso = new Date(atMs + BACKFILL_TOLERANCE_MIN * 60_000).toISOString();
  const result = await fetchPeerIntradayBars(url, ticker, startIso, endIso, token, fetchImpl);
  if (result.kind === 'unavailable') {
    return {
      ok: false,
      reason: 'peer_unavailable',
      instrumentClass,
      message: 'Peer did not answer the intraday request. Retry later — nothing was fabricated.',
    };
  }
  const bar = nearestBarAtOrAfter(result.bars, startIso, BACKFILL_TOLERANCE_MIN);
  if (!bar) {
    return {
      ok: false,
      reason: 'no_bars',
      instrumentClass,
      message: 'Peer confirmed no 1-minute bar at or within 5 minutes after that instant.',
    };
  }
  return {
    ok: true,
    ticker,
    requestedAt: startIso,
    barAt: bar.t,
    price: bar.c,
    source: 'peer-intraday',
    instrumentClass,
  };
}
