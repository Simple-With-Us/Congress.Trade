/**
 * Post-extraction sanity guard for vision / OCR row sets (CT-2509).
 *
 * Catches decoder collapse patterns such as Fleischmann H-2026-9116403, where
 * local Mac vision returned every row as owner self, type Sale, and ticker null
 * while the source listed distinct joint trades across recognizable ETF names.
 *
 * A hit routes the filing to review_queue with reason `vision_degenerate` and
 * must not auto-publish. Thresholds are conservative: a single trade, two rows,
 * or a genuinely uniform multi-row filing with resolved tickers must not trip.
 */
import type { ParsedTx } from '../shared/types.ts';
import { isPlaceholderTicker } from './tickerNormalize.ts';

export const VISION_DEGENERATE_REASON = 'vision_degenerate';

/** Fewer rows than this never qualify as a degenerate multi-line extract. */
export const MIN_VISION_DEGENERATE_ROWS = 3;

/** Uniformity checks need at least this many distinct asset names. */
export const MIN_DISTINCT_ASSETS_FOR_DEGENERATE = 2;

const LISTED_SECURITY_NAME_RE =
  /\b(?:ETF|ETN|ETFs?|Tr\b|Trust|SPDR|iShares|Vanguard|Select Sector|Ser Tr|Index|Inc\.?|Corp\.?|Corporation|Common Stock|Class [A-Z])\b/i;

const PAREN_TICKER_RE = /\(([A-Z]{1,5})\)\s*$/;

export interface VisionDegenerateSignal {
  code:
    | 'uniform_owner_and_tx_type'
    | 'all_tickers_null_recognizable_names'
    | 'constant_date_and_amount';
  detail?: string;
}

export interface VisionDegenerateAssessment {
  degenerate: boolean;
  signals: VisionDegenerateSignal[];
  rowCount: number;
  distinctAssets: number;
}

export function mergeVisionDegenerateReason(base: string | null | undefined): string {
  const trimmed = (base ?? '').trim();
  if (!trimmed) return VISION_DEGENERATE_REASON;
  if (trimmed.split(',').includes(VISION_DEGENERATE_REASON)) return trimmed;
  return `${VISION_DEGENERATE_REASON},${trimmed}`;
}

export function assetNameSuggestsListedSecurity(name: string | null | undefined): boolean {
  const value = (name ?? '').trim();
  if (value.length < 4) return false;
  if (LISTED_SECURITY_NAME_RE.test(value)) return true;
  if (PAREN_TICKER_RE.test(value)) return true;
  return false;
}

function normalizedOwner(row: ParsedTx): string | null {
  const raw = row.owner;
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase();
  return s === '' ? null : s;
}

function rowTickerMissing(row: ParsedTx): boolean {
  const t = (row.ticker ?? '').trim();
  if (t === '') return true;
  return isPlaceholderTicker(t);
}

function amountKey(row: ParsedTx): string {
  return `${row.amountMin ?? ''}:${row.amountMax ?? ''}`;
}

function distinctAssetCount(rows: readonly ParsedTx[]): number {
  const keys = new Set<string>();
  for (const row of rows) {
    const name = (row.assetName ?? '').trim().toLowerCase();
    if (name) keys.add(name);
  }
  return keys.size;
}

/**
 * Pure assessment of a vision/OCR row list. Callers on local_mac / server_cpu
 * and other vision paths should run this after duplicate-span collapse and
 * other integrity guards, immediately before normalize().
 */
export function assessVisionDegenerate(rows: readonly ParsedTx[]): VisionDegenerateAssessment {
  const signals: VisionDegenerateSignal[] = [];
  const usable = rows.filter((r) => (r.assetName ?? '').trim().length > 0);
  const rowCount = usable.length;
  const distinctAssets = distinctAssetCount(usable);

  if (rowCount < MIN_VISION_DEGENERATE_ROWS || distinctAssets < MIN_DISTINCT_ASSETS_FOR_DEGENERATE) {
    return { degenerate: false, signals, rowCount, distinctAssets };
  }

  const owners = usable.map(normalizedOwner);
  const types = usable.map((r) => String(r.txType ?? '').trim().toUpperCase());
  const ownersPresent = owners.every((o) => o !== null);
  const typesPresent = types.every((t) => t.length > 0);
  const uniformOwner = ownersPresent && owners.every((o) => o === owners[0]);
  const uniformType = typesPresent && types.every((t) => t === types[0]);

  if (uniformOwner && uniformType) {
    signals.push({
      code: 'uniform_owner_and_tx_type',
      detail: `${owners[0]}/${types[0]}`,
    });
  }

  const recognizableCount = usable.filter((r) => assetNameSuggestsListedSecurity(r.assetName)).length;
  const allTickersMissing = usable.every(rowTickerMissing);
  if (allTickersMissing && recognizableCount >= MIN_VISION_DEGENERATE_ROWS) {
    signals.push({
      code: 'all_tickers_null_recognizable_names',
      detail: `${recognizableCount}/${rowCount}`,
    });
  }

  const dates = usable.map((r) => (r.txDate ?? '').trim());
  const datesPresent = dates.every((d) => d.length > 0);
  const uniformDate = datesPresent && dates.every((d) => d === dates[0]);
  const amountKeys = usable.map(amountKey);
  const uniformAmount = amountKeys.every((k) => k === amountKeys[0]) && amountKeys[0] !== '';

  if (rowCount >= 4 && uniformDate && uniformAmount) {
    signals.push({
      code: 'constant_date_and_amount',
      detail: dates[0],
    });
  }

  const hasUniformOwnerType = signals.some((s) => s.code === 'uniform_owner_and_tx_type');
  const hasNullTickersOnRecognizable = signals.some((s) => s.code === 'all_tickers_null_recognizable_names');

  // Require the paired collapse signature (uniform owner+type AND missing
  // tickers on names that plainly denote funds/equities). Constant date/amount
  // alone is normal on real multi-line PTR grids (see H-2026-9116403 hand rows).
  const degenerate = hasUniformOwnerType && hasNullTickersOnRecognizable;

  return { degenerate, signals, rowCount, distinctAssets };
}
