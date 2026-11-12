/**
 * Which disclosure types Socratic.Trade EOD can price vs Congress.Trade tickers
 * that only exist as unsupported instruments (CT-2482).
 */

import type { Env } from '../shared/types.ts';
import { all, get } from '../shared/db.ts';
import { excludeCompetitorFixtureTransactionSql } from '../shared/competitorFixtures.ts';
import {
  canonicalAssetTypeCategorySql,
  canonicalizeAssetType,
  HOUSE_ASSET_TYPE_NAMES,
  type CanonicalAssetType,
} from '../shared/assetTypes.ts';
import {
  capabilityForInstrument,
  type InstrumentHints,
} from './instrumentCapabilities.ts';

function truthyOptionFlag(value: boolean | number | null | undefined): boolean {
  return value === true || value === 1;
}

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
  return tickerPriceInstrumentHintsFromRow(sym, row);
}

/** Newest trade hints for every symbol in `tickers` (one D1 round trip). */
export async function readTickerPriceInstrumentHintsBatch(
  env: Env,
  tickers: string[],
): Promise<Map<string, TickerPriceInstrumentHints>> {
  const out = new Map<string, TickerPriceInstrumentHints>();
  const syms = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
  if (syms.length === 0) return out;
  const placeholders = syms.map(() => '?').join(', ');
  const rows = await all<{
    ticker: string;
    asset_type: string | null;
    asset_type_name: string | null;
    asset_name: string | null;
    is_option: number | null;
    tx_date: string;
    id: string;
  }>(
    env.DB,
    `SELECT t.ticker AS ticker, t.asset_type, t.asset_type_name, t.asset_name, t.is_option,
            t.tx_date, t.id
       FROM transactions t
      WHERE t.ticker IN (${placeholders}) AND ${TRADE_FILTER}
      ORDER BY t.ticker ASC, t.tx_date DESC, t.id DESC`,
    syms,
  );
  for (const row of rows) {
    if (out.has(row.ticker)) continue;
    out.set(row.ticker, tickerPriceInstrumentHintsFromRow(row.ticker, row));
  }
  return out;
}

/** True when EOD capability is off for this instrument class (options, etc.). */
export function instrumentClassExcludesPeerEod(hints: InstrumentHints): boolean {
  return capabilityForInstrument(hints).eodPricing !== true;
}

export function tickerPriceInstrumentHintsFromRow(
  sym: string,
  row: {
    asset_type: string | null;
    asset_type_name: string | null;
    asset_name: string | null;
    is_option: number | null;
  },
): TickerPriceInstrumentHints {
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

/**
 * Whether a single disclosure row can use ST peer EOD.  House PTR codes use
 * the allowlist; free-text labels canonicalize through capability (so
 * "Cryptocurrency" stays priceable while MF/OP stay out).
 */
export function disclosureTradeSupportsPeerEod(hints: TickerPriceInstrumentHints): boolean {
  if (truthyOptionFlag(hints.isOption)) return false;
  if (hints.canonical?.category === 'option') return false;

  const canonical = hints.canonical ?? canonicalizeAssetType(
    hints.disclosureAssetType,
    hints.assetTypeName,
    {
      isOption: truthyOptionFlag(hints.isOption),
      assetName: hints.assetName,
    },
  );
  if (canonical.source === 'house_code' && canonical.code) {
    return PEER_EOD_DISCLOSURE_ASSET_TYPES.has(canonical.code);
  }
  const rawCode = (hints.disclosureAssetType ?? '').trim().toUpperCase();
  if (rawCode && HOUSE_ASSET_TYPE_NAMES[rawCode]) {
    return PEER_EOD_DISCLOSURE_ASSET_TYPES.has(rawCode);
  }
  return capabilityForInstrument(hints).eodPricing === true;
}

/**
 * Disclosure-only: a ticker whose trades never use a listed-equity asset code
 * cannot be priced from ST EOD (mutual funds, options, private stock, …).
 */
export function disclosureExcludesPeerEod(hints: TickerPriceInstrumentHints): boolean {
  return !disclosureTradeSupportsPeerEod(hints);
}

/** SQL predicate on a transactions alias: this trade row supports ST EOD. */
export function disclosureTradeSupportsPeerEodSql(tradeAlias: string): string {
  const supported = [...PEER_EOD_DISCLOSURE_ASSET_TYPES].map((c) => `'${c}'`).join(', ');
  const category = canonicalAssetTypeCategorySql(
    `${tradeAlias}.asset_type`,
    `${tradeAlias}.asset_type_name`,
    `${tradeAlias}.is_option`,
  );
  return `(
    UPPER(COALESCE(NULLIF(TRIM(${tradeAlias}.asset_type), ''), '${DEFAULT_DISCLOSURE_ASSET_TYPE}')) IN (${supported})
    OR (
      ${category} IN ('public_equity', 'crypto')
      AND COALESCE(${tradeAlias}.is_option, 0) = 0
    )
  )`;
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
  const tradeRow = await get<{ n: number }>(
    env.DB,
    `SELECT COUNT(*) AS n FROM transactions t
      WHERE t.ticker = ? AND ${TRADE_FILTER}`,
    [sym],
  );
  if (Number(tradeRow?.n ?? 0) === 0) return false;
  const supportedRow = await get<{ n: number }>(
    env.DB,
    `SELECT COUNT(*) AS n FROM transactions t
      WHERE t.ticker = ? AND ${TRADE_FILTER}
        AND ${disclosureTradeSupportsPeerEodSql('t')}`,
    [sym],
  );
  return Number(supportedRow?.n ?? 0) === 0;
}

/** EXISTS filter: no dated trade uses a peer-EOD disclosure asset code. */
export function disclosureUnsupportedPendingSql(): string {
  return `NOT EXISTS (
     SELECT 1 FROM transactions t2
      WHERE t2.ticker = t.ticker
        AND t2.tx_date IS NOT NULL AND t2.tx_date >= '1990-01-01'
        AND t2.deprecated_at IS NULL
        AND ${excludeCompetitorFixtureTransactionSql('t2')}
        AND ${disclosureTradeSupportsPeerEodSql('t2')}
   )`;
}
