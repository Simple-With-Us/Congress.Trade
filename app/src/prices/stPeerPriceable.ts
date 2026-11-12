/**
 * src/prices/stPeerPriceable.ts
 * OWNER: prices
 *
 * Classify disclosed symbols that must not be sent to Socratic.Trade EOD
 * pricing (CT-2478). Municipal issuers, crypto names, confirmed mutual funds,
 * and non-ticker-shaped labels burn upstream quota and never resolve.
 */

import type { Env } from '../shared/types.ts';
import { all, get } from '../shared/db.ts';
import { excludeCompetitorFixtureTransactionSql } from '../shared/competitorFixtures.ts';
import { canonicalizeAssetType } from '../shared/assetTypes.ts';
import { obviousNonEquity, NOT_AN_EQUITY_ERROR } from '../enrichment/service.ts';
import { isTickerShapedSymbol } from '../enrichment/socratic.ts';
import {
  lastTradingDay,
  markTickerPriceUnavailable,
  notCoveredReason,
  PRICE_UNAVAILABLE_NOT_COVERED,
  priceNegativeCacheActiveExclusionSql,
  priceNotCoveredExclusionSql,
  priceUnavailableCutoffIso,
  priceUnavailableFirstRecheckCutoffIso,
} from './service.ts';

export const ST_UNPRICEABLE_CAUSE_GOVERNMENT = 'government or municipal issuer (not a listed equity ticker)';
export const ST_UNPRICEABLE_CAUSE_CRYPTO = 'cryptocurrency (not priced on equity EOD path)';
export const ST_UNPRICEABLE_CAUSE_MUTUAL_FUND = 'mutual fund (not on equity EOD path)';
export const ST_UNPRICEABLE_CAUSE_INVALID_TICKER = 'not a listed equity ticker symbol';

const GOVT_ISSUER_RE =
  /\b(COUNTY OF|CITY OF|STATE OF|BOROUGH OF|TOWN OF|PARISH OF|COMMONWEALTH OF)\b/i;

const CRYPTO_NAME_RE =
  /\b(BITCOIN|ETHEREUM|CRYPTO(CURRENCY)?|DOGECOIN|LITECOIN|SOLANA|CARDANO|RIPPLE)\b/i;

/** Whole-ticker crypto labels filed in the ticker column (not exchange symbols). */
const CRYPTO_TICKER_WORD_RE =
  /^(BITCOIN|ETHEREUM|BTC|ETH|SOL|SOLANA|DOGE|DOGECOIN|LTC|LITECOIN|XRP|RIPPLE|ADA|CARDANO|USDC|USDT)$/i;

export type StUnpriceableCause =
  | 'government'
  | 'crypto'
  | 'mutual_fund'
  | 'invalid_ticker';

export interface StPeerPriceableHints {
  ticker: string;
  assetName?: string | null;
  assetType?: string | null;
  assetTypeName?: string | null;
  assetClass?: string | null;
  isEtf?: number | null;
  enrichmentError?: string | null;
}

export function stUnpriceableCauseText(cause: StUnpriceableCause): string {
  switch (cause) {
    case 'government':
      return ST_UNPRICEABLE_CAUSE_GOVERNMENT;
    case 'crypto':
      return ST_UNPRICEABLE_CAUSE_CRYPTO;
    case 'mutual_fund':
      return ST_UNPRICEABLE_CAUSE_MUTUAL_FUND;
    case 'invalid_ticker':
      return ST_UNPRICEABLE_CAUSE_INVALID_TICKER;
    default: {
      const _exhaustive: never = cause;
      return _exhaustive;
    }
  }
}

function isConfirmedMutualFund(hints: StPeerPriceableHints): boolean {
  const sym = hints.ticker.trim().toUpperCase();
  if (!/^[A-Z]{5}$/.test(sym) || !sym.endsWith('X')) return false;
  if (hints.isEtf === 1) return false;
  const at = (hints.assetType ?? '').trim().toUpperCase();
  if (at === 'MF') return true;
  if (at === 'EF' || at === 'ET') return false;
  const classRaw = (hints.assetClass ?? '').trim().toLowerCase();
  if (classRaw === 'fund' && hints.isEtf !== 1) return true;
  const nameHay = `${hints.assetName ?? ''} ${hints.assetTypeName ?? ''}`.toUpperCase();
  if (/\bMUTUAL FUND\b/.test(nameHay) && !/\bETF\b/.test(nameHay)) return true;
  const canonical = canonicalizeAssetType(hints.assetType, hints.assetTypeName, {
    assetName: hints.assetName,
  });
  if (canonical.category === 'fund' && at !== 'EF' && at !== 'ET' && hints.isEtf !== 1) {
    return /\bMUTUAL\b/.test(nameHay) || at === 'MF';
  }
  return false;
}

function governmentOrMunicipal(hints: StPeerPriceableHints): boolean {
  const hay = [hints.ticker, hints.assetName].map((v) => (v ?? '').trim()).filter(Boolean).join(' ');
  if (!hay) return false;
  const upper = hay.toUpperCase();
  if (GOVT_ISSUER_RE.test(upper)) return true;
  if (/\bMUNICIPAL\b/.test(upper) || /\bTREASURY\b/.test(upper)) return true;
  if (/\bCORPORATE BOND\b/.test(upper)) return true;
  return false;
}

/**
 * Returns a cause when this row must not call ST /api/market/prices, else null.
 * A normal 1–5 letter ticker with no type hints stays eligible (missing profile
 * is not a skip).
 */
export function classifyStUnpriceableSymbol(hints: StPeerPriceableHints): StUnpriceableCause | null {
  const ticker = (hints.ticker ?? '').trim();
  if (!ticker) return 'invalid_ticker';

  if (hints.enrichmentError === NOT_AN_EQUITY_ERROR) {
    return governmentOrMunicipal(hints) ? 'government' : 'invalid_ticker';
  }

  if (governmentOrMunicipal(hints) || obviousNonEquity(ticker, hints.assetName)) {
    return governmentOrMunicipal(hints) ? 'government' : 'invalid_ticker';
  }

  const sym = ticker.toUpperCase();
  if (CRYPTO_TICKER_WORD_RE.test(sym)) return 'crypto';
  const canonical = canonicalizeAssetType(hints.assetType, hints.assetTypeName, {
    assetName: hints.assetName,
  });
  if (canonical.category === 'crypto') return 'crypto';
  const nameHay = `${ticker} ${hints.assetName ?? ''} ${hints.assetTypeName ?? ''}`;
  if (CRYPTO_NAME_RE.test(nameHay)) return 'crypto';
  const at = (hints.assetType ?? '').trim().toUpperCase();
  if (at === 'CT' && CRYPTO_NAME_RE.test(`${ticker} ${hints.assetName ?? ''}`)) return 'crypto';

  if (isConfirmedMutualFund(hints)) return 'mutual_fund';

  if (!isTickerShapedSymbol(ticker)) return 'invalid_ticker';

  return null;
}

export function stUnpriceableStoredReason(now: Date, cause: StUnpriceableCause): string {
  return notCoveredReason(now, stUnpriceableCauseText(cause));
}

/** Mark one ticker stage-4 without calling Socratic.Trade. */
export async function markStUnpriceableSymbol(
  env: Env,
  ticker: string,
  cause: StUnpriceableCause,
  now = new Date(),
): Promise<void> {
  await markTickerPriceUnavailable(env, ticker, stUnpriceableStoredReason(now, cause), {
    checkedAt: now.toISOString(),
    stage: PRICE_UNAVAILABLE_NOT_COVERED,
    force: true,
  });
}

export const ST_UNPRICEABLE_SWEEP_MAX_BATCH = 250;

export interface StUnpriceableSweepResult {
  marked: number;
  scanned: number;
}

function pendingUnpriceableSweepSql(): string {
  return `
  FROM transactions t
  LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
 WHERE t.ticker IS NOT NULL AND TRIM(t.ticker) != ''
   AND t.tx_date IS NOT NULL AND t.tx_date >= '1990-01-01'
   AND t.deprecated_at IS NULL
   AND ${excludeCompetitorFixtureTransactionSql('t')}
   AND (
     sr.latest_price_date IS NULL
     OR sr.latest_price_date < ?
     OR NOT EXISTS (SELECT 1 FROM price_eod pe WHERE pe.ticker = t.ticker)
   )
   AND ${priceNegativeCacheActiveExclusionSql('sr')}
   AND ${priceNotCoveredExclusionSql('sr')}`;
}

/**
 * Scan the pending peer-price set and mark obvious non-equity symbols stage 4
 * before any catch-up run spends ST quota on them.
 */
export async function sweepStUnpriceablePeerPriceTickers(
  env: Env,
  now = new Date(),
  max = ST_UNPRICEABLE_SWEEP_MAX_BATCH,
): Promise<StUnpriceableSweepResult> {
  if (!env.DB || max <= 0) return { marked: 0, scanned: 0 };
  const freshThrough = lastTradingDay(now);
  const firstCutoff = priceUnavailableFirstRecheckCutoffIso(now);
  const unavailableCutoff = priceUnavailableCutoffIso(now);
  const rows = await all<{
    ticker: string;
    asset_name: string | null;
    asset_type: string | null;
    asset_type_name: string | null;
    asset_class: string | null;
    is_etf: number | null;
    enrichment_error: string | null;
  }>(
    env.DB,
    `SELECT t.ticker AS ticker,
            MAX(t.asset_name) AS asset_name,
            MAX(t.asset_type) AS asset_type,
            MAX(t.asset_type_name) AS asset_type_name,
            MAX(sr.asset_class) AS asset_class,
            MAX(sr.is_etf) AS is_etf,
            MAX(sr.enrichment_error) AS enrichment_error
       ${pendingUnpriceableSweepSql()}
     GROUP BY t.ticker
     ORDER BY MAX(t.cursor_seq) ASC
     LIMIT ?`,
    [freshThrough, firstCutoff, unavailableCutoff, max],
  );
  let marked = 0;
  for (const row of rows) {
    const hints: StPeerPriceableHints = {
      ticker: row.ticker,
      assetName: row.asset_name,
      assetType: row.asset_type,
      assetTypeName: row.asset_type_name,
      assetClass: row.asset_class,
      isEtf: row.is_etf,
      enrichmentError: row.enrichment_error,
    };
    const cause = classifyStUnpriceableSymbol(hints);
    if (!cause) continue;
    await markStUnpriceableSymbol(env, row.ticker, cause, now);
    marked++;
  }
  return { marked, scanned: rows.length };
}

/** Load disclosure hints for a single ticker (price refresh fast path). */
export async function readStPeerPriceableHints(
  env: Env,
  ticker: string,
): Promise<StPeerPriceableHints> {
  const row = await get<{
    asset_name: string | null;
    asset_type: string | null;
    asset_type_name: string | null;
    asset_class: string | null;
    is_etf: number | null;
    enrichment_error: string | null;
  }>(
    env.DB,
    `SELECT MAX(t.asset_name) AS asset_name,
            MAX(t.asset_type) AS asset_type,
            MAX(t.asset_type_name) AS asset_type_name,
            MAX(sr.asset_class) AS asset_class,
            MAX(sr.is_etf) AS is_etf,
            MAX(sr.enrichment_error) AS enrichment_error
       FROM transactions t
       LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
      WHERE t.ticker = ?
        AND t.deprecated_at IS NULL
        AND ${excludeCompetitorFixtureTransactionSql('t')}`,
    [ticker],
  );
  return {
    ticker,
    assetName: row?.asset_name ?? null,
    assetType: row?.asset_type ?? null,
    assetTypeName: row?.asset_type_name ?? null,
    assetClass: row?.asset_class ?? null,
    isEtf: row?.is_etf ?? null,
    enrichmentError: row?.enrichment_error ?? null,
  };
}
