/**
 * Which disclosure types Socratic.Trade EOD can price vs Congress.Trade tickers
 * that only exist as unsupported instruments (CT-2482).
 */

import type { Env } from '../shared/types.ts';
import { all, get } from '../shared/db.ts';
import { excludeCompetitorFixtureTransactionSql } from '../shared/competitorFixtures.ts';
import {
  canonicalizeAssetType,
  type CanonicalAssetType,
} from '../shared/assetTypes.ts';
import {
  capabilityForInstrument,
  type InstrumentHints,
} from './instrumentCapabilities.ts';

/** House / Senate codes whose trades may use ST peer EOD (common listed instruments). */
export const PEER_EOD_DISCLOSURE_ASSET_TYPES = new Set([
  'ST',
  'EF',
  'ET',
  'CT',
  'RE',
  'RF',
  'RN',
  'RS',
  'SA',
]);

export const NOT_COVERED_CAUSE_DISCLOSURE_TYPE = 'disclosure instrument not priced by ST';

/** Default disclosure when PTR rows omit asset_type — treated as listed equity. */
export const DEFAULT_DISCLOSURE_ASSET_TYPE = 'ST';

export const DISCLOSURE_NOT_COVERED_SWEEP_MAX = 100;

export interface TickerPriceInstrumentHints extends InstrumentHints {
  /** Representative House/Senate asset_type on a dated trade, if any. */
  disclosureAssetType: string | null;
  canonical: CanonicalAssetType | null;
}

const TRADE_FILTER = `t.tx_date IS NOT NULL AND t.tx_date >= '1990-01-01'
        AND t.deprecated_at IS NULL
        AND ${excludeCompetitorFixtureTransactionSql('t')}`;

/** One representative trade row for classification (newest dated trade). */
export async function readTickerPriceInstrumentHints(
  env: Env,
  ticker: string,
): Promise<TickerPriceInstrumentHints | null> {
  const sym = ticker.trim().toUpperCase();
  if (!sym) return null;
  const row = await get<{
    asset_type: string | null;
    asset_type_name: string | null;
    asset_name: string | null;
    is_option: number | null;
  }>(
    env.DB,
    `SELECT t.asset_type, t.asset_type_name, t.asset_name, t.is_option
       FROM transactions t
      WHERE t.ticker = ? AND ${TRADE_FILTER}
      ORDER BY t.tx_date DESC, t.id DESC
      LIMIT 1`,
    [sym],
  );
  if (!row) return null;
  const disclosureAssetType = row.asset_type?.trim() || null;
  const hints: InstrumentHints = {
    ticker: sym,
    assetType: disclosureAssetType,
    assetTypeName: row.asset_type_name,
    assetName: row.asset_name,
    isOption: row.is_option,
  };
  const canonical = canonicalizeAssetType(disclosureAssetType, row.asset_type_name, {
    isOption: row.is_option === 1,
    assetName: row.asset_name,
  });
  return { ...hints, disclosureAssetType, canonical };
}

/** True when EOD capability is off for this instrument class (options, etc.). */
export function instrumentClassExcludesPeerEod(hints: InstrumentHints): boolean {
  return capabilityForInstrument(hints).eodPricing !== true;
}

/**
 * Disclosure-only: a ticker whose trades never use a listed-equity asset code
 * cannot be priced from ST EOD (mutual funds, options, private stock, …).
 */
export function disclosureExcludesPeerEod(hints: TickerPriceInstrumentHints): boolean {
  if (hints.isOption === true || hints.isOption === 1) return true;
  if (hints.canonical?.category === 'option') return true;
  const code = (hints.disclosureAssetType ?? DEFAULT_DISCLOSURE_ASSET_TYPE).toUpperCase();
  return !PEER_EOD_DISCLOSURE_ASSET_TYPES.has(code);
}

/** Mark on a confirmed-empty ST response when disclosure already rules out EOD. */
export function notCoveredCauseForDisclosure(hints: TickerPriceInstrumentHints): string {
  const label = hints.canonical?.label ?? hints.disclosureAssetType ?? 'unknown';
  return `${NOT_COVERED_CAUSE_DISCLOSURE_TYPE} (${label})`;
}

/**
 * Whether every dated trade on this ticker uses unsupported disclosure types.
 * Missing asset_type counts as ST (listed equity).
 */
export async function tickerHasOnlyUnsupportedDisclosureTrades(
  env: Env,
  ticker: string,
): Promise<boolean> {
  const sym = ticker.trim().toUpperCase();
  if (!sym) return false;
  const rows = await all<{ asset_type: string | null }>(
    env.DB,
    `SELECT DISTINCT COALESCE(NULLIF(TRIM(t.asset_type), ''), ?) AS asset_type
       FROM transactions t
      WHERE t.ticker = ? AND ${TRADE_FILTER}`,
    [DEFAULT_DISCLOSURE_ASSET_TYPE, sym],
  );
  if (rows.length === 0) return false;
  return rows.every((r) => !PEER_EOD_DISCLOSURE_ASSET_TYPES.has(r.asset_type.toUpperCase()));
}

/** EXISTS filter: no dated trade uses a peer-EOD disclosure asset code. */
export function disclosureUnsupportedPendingSql(): string {
  const supported = [...PEER_EOD_DISCLOSURE_ASSET_TYPES].map((c) => `'${c}'`).join(', ');
  return `NOT EXISTS (
     SELECT 1 FROM transactions t2
      WHERE t2.ticker = t.ticker
        AND t2.tx_date IS NOT NULL AND t2.tx_date >= '1990-01-01'
        AND t2.deprecated_at IS NULL
        AND ${excludeCompetitorFixtureTransactionSql('t2')}
        AND UPPER(COALESCE(NULLIF(TRIM(t2.asset_type), ''), '${DEFAULT_DISCLOSURE_ASSET_TYPE}')) IN (${supported})
   )`;
}
