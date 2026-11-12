/**
 * Canonical transaction-type **storage/API codes**: B | S | E
 *   B = Buy, S = Sell, E = Exchange
 *
 * Form text still says Purchase/Sale (STOCK Act / OGE). Every write path
 * must run {@link canonicalizeTxType} so Purchase / P / buy / bought → **B**.
 * Legacy rows may still hold P until the admin migrate UPDATE lands; readers
 * treat P as Buy via dual-read helpers.
 */
import type { TxType } from './types.ts';

/** Human label for a stored code. Unknown/empty → null. */
export function txTypeLabel(code: string | null | undefined): string | null {
  const c = canonicalizeTxType(code);
  if (c === 'B') return 'Buy';
  if (c === 'S') return 'Sell';
  if (c === 'E') return 'Exchange';
  return null;
}

/** Single-letter product code (same as storage after B migration). */
export function txTypeDisplayLetter(code: string | null | undefined): string | null {
  return canonicalizeTxType(code);
}

/**
 * SQL fragment: buy side including legacy P during/after migration.
 * Use for analytics CASE / WHERE on t.tx_type.
 */
export const SQL_TX_TYPE_BUY = `t.tx_type IN ('B', 'P')`;
export const SQL_TX_TYPE_SELL = `t.tx_type = 'S'`;
export const SQL_TX_TYPE_EXCHANGE = `t.tx_type = 'E'`;
export const SQL_TX_TYPE_DIRECTIONAL = `t.tx_type IN ('B', 'P', 'S')`;

/**
 * Map any raw provider/admin/form/transcription label to B|S|E.
 * Purchase / P / buy / B all become **B**. Returns null if empty/unknown.
 */
export function canonicalizeTxType(raw: string | null | undefined): TxType | null {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (!s) return null;

  // Exact single-letter codes — legacy P maps to B.
  if (s === 'b' || s === 'p') return 'B';
  if (s === 's') return 'S';
  if (s === 'e') return 'E';

  if (s.includes('exchange') || s === 'exch') return 'E';

  if (
    s.includes('sale') ||
    s.includes('sell') ||
    s.includes('sold') ||
    s === 's partial' ||
    s === 's full'
  ) {
    return 'S';
  }

  if (s.includes('purchase') || s.includes('buy') || s.includes('bought')) return 'B';

  return null;
}

/** Never null — unknown/empty → Buy (B). Display/export edges only. */
export function canonicalizeTxTypeOrBuy(raw: string | null | undefined): TxType {
  return canonicalizeTxType(raw) ?? 'B';
}

/** @deprecated use {@link canonicalizeTxTypeOrBuy} */
export function canonicalizeTxTypeOrPurchase(raw: string | null | undefined): TxType {
  return canonicalizeTxTypeOrBuy(raw);
}

/** True if code is a buy (including legacy P). */
export function isBuyTxType(code: string | null | undefined): boolean {
  const c = String(code ?? '').toUpperCase();
  return c === 'B' || c === 'P';
}

/** True if code is a valid storage side (B|S|E or legacy P). */
export function isTxTypeCode(code: string | null | undefined): boolean {
  const c = String(code ?? '').toUpperCase();
  return c === 'B' || c === 'S' || c === 'E' || c === 'P';
}
