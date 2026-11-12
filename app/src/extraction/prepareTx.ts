/**
 * Cheap, I/O-free cleanup applied to every extracted row before agreement,
 * consensus, or stored-run publish. Does not invent tickers or amounts.
 */
import type { ParsedTx } from '../shared/types.ts';
import {
  assetTypeLooksLikeTxType,
  tickerIsMisfiledHouseTypeCode,
} from '../shared/assetTypes.ts';
import { cleanAssetString } from './nameNormalizer.ts';

export function prepareExtractedTx(tx: ParsedTx): ParsedTx {
  const ticker = tx.ticker?.trim() || null;
  const assetTypeRaw = tx.assetType?.trim() || null;
  const misfiled = tickerIsMisfiledHouseTypeCode(ticker, assetTypeRaw, tx.assetName);
  const nextTicker = misfiled ? null : ticker;
  const nextType = assetTypeLooksLikeTxType(assetTypeRaw)
    ? (misfiled ? (ticker ?? '').trim().toUpperCase() || null : null)
    : (assetTypeRaw || (misfiled ? (ticker ?? '').trim().toUpperCase() : null));
  const cleaned = cleanAssetString(tx.assetName, nextTicker);
  return {
    ...tx,
    ticker: nextTicker,
    assetType: nextType,
    assetName: cleaned || tx.assetName,
  };
}

export function prepareExtractedRows(rows: ParsedTx[]): ParsedTx[] {
  return rows.map(prepareExtractedTx);
}
