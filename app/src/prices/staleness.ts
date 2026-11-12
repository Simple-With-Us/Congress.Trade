/**
 * src/prices/staleness.ts
 * OWNER: prices
 *
 * Labels whether a cached current price is fresh enough for excess-return math
 * and customer-facing "current" copy.  Uses the same last-trading-day bar as
 * selectTickersNeedingPrices / price-needs export (Eastern calendar, weekends
 * only — not exchange holidays).
 */

import { lastTradingDay } from './service.ts';

const DAY_MS = 86_400_000;

export interface CurrentPriceStaleness {
  /** True when the price date is missing or older than the freshest expected EOD bar. */
  stale: boolean;
  /** YYYY-MM-DD — newest close we expect to have cached (inclusive). */
  freshThrough: string;
  /** Whole calendar days between the price date and freshThrough when stale; otherwise 0. */
  dataAgeDays: number;
}

/** Newest trading session whose EOD close should be present in the cache. */
export function currentPriceFreshThrough(now = new Date()): string {
  return lastTradingDay(now);
}

export function evaluateCurrentPriceStaleness(
  priceDate: string | null | undefined,
  now = new Date(),
): CurrentPriceStaleness {
  const freshThrough = currentPriceFreshThrough(now);
  const d = typeof priceDate === 'string' && priceDate.length >= 10 ? priceDate.slice(0, 10) : null;
  if (!d) {
    return { stale: true, freshThrough, dataAgeDays: 0 };
  }
  if (d >= freshThrough) {
    return { stale: false, freshThrough, dataAgeDays: 0 };
  }
  const ageMs = Date.parse(`${freshThrough}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`);
  const dataAgeDays = Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / DAY_MS)) : 0;
  return { stale: true, freshThrough, dataAgeDays };
}

export function isCurrentPriceFresh(
  priceDate: string | null | undefined,
  freshThrough: string,
): boolean {
  const d = typeof priceDate === 'string' && priceDate.length >= 10 ? priceDate.slice(0, 10) : null;
  return d != null && d >= freshThrough;
}

/** JSON fields for /market/prices and bundle price legs. */
export function currentPriceStalenessFields(
  priceDate: string | null | undefined,
  now = new Date(),
): CurrentPriceStaleness {
  return evaluateCurrentPriceStaleness(priceDate, now);
}
