/**
 * Choose between the two House PTR text parsers.
 *
 * `parseTailRecords` reads `[TYPE] P/S/E date date $amount`.
 * `parseColumnTailRecords` reads the same run when `[TYPE]` is wrapped after
 * the amount. A longer result is not a better result: on Cisneros
 * H-2026-20035788 the column parser can out-count the tail parser while
 * shifting Subholding Of and the next row's ticker. This module scores each
 * row, keeps a row when the parsers agree, and caps confidence under the
 * publish threshold when they disagree on content.
 */
import type { Env, ParsedTx } from '../shared/types.ts';
import { HOUSE_ASSET_TYPE_NAMES } from '../shared/assetTypes.ts';
import { isValidBracket } from '../shared/brackets.ts';
import { all } from '../shared/db.ts';
import { simplifyCompanyName } from './nameNormalizer.ts';

/**
 * Below `CONFIDENCE_THRESHOLD` (0.95) in the normalizer. `scoreFields` never
 * raises confidence above the extractor base, so a capped row stays in review.
 */
export const HOUSE_PTR_PARSER_HOLD_CONFIDENCE = 0.94;

const NAME_INDEX_TTL_MS = 10 * 60 * 1000;
const OWNERS = new Set(['self', 'spouse', 'joint', 'dependent']);
const DETAIL_LABEL_RE = /\b(?:Filing\s+Status|Subholding\s+Of|Location|Description)\s*:/i;
const TYPE_BRACKET_RE = /\[[A-Z0-9]{2,4}\]/i;
const PAREN_TICKER_RE = /\(([A-Z][A-Z0-9.^/-]{0,9})\)/g;
const TICKER_SKIP_RE = /^(?:PARTIAL|NEW|NONE|N\/A|PURCHASE|SALE|BUY)$/i;

/** Ticker to simplified `securities_ref.company_name`. */
export type HousePtrNameIndex = ReadonlyMap<string, string>;

export type TickerConsistency = 'match' | 'mismatch' | 'unknown';

export interface HousePtrRowScore {
  score: number;
  validType: boolean;
  validAmount: boolean;
  validDate: boolean;
  validOwner: boolean;
  validAssetType: boolean;
  bleed: boolean;
  tickerConsistency: TickerConsistency;
}

export interface HousePtrArbitration {
  rows: ParsedTx[];
  /** Both parsers returned rows and they do not describe the same filing. */
  contested: boolean;
}

interface AlignedSlot {
  tailIndex: number | null;
  columnIndex: number | null;
}

let nameIndexCache: { loadedAt: number; index: Map<string, string> } | null = null;

/** Drop the in-process securities_ref cache (tests). */
export function clearHousePtrSecuritiesRefIndexCache(): void {
  nameIndexCache = null;
}

/**
 * Load ticker to simplified company name from `securities_ref`.
 * An empty index means "no evidence", not "every ticker mismatches".
 */
export async function loadHousePtrSecuritiesRefIndex(env: Env): Promise<HousePtrNameIndex> {
  const now = Date.now();
  if (nameIndexCache && now - nameIndexCache.loadedAt < NAME_INDEX_TTL_MS) {
    return nameIndexCache.index;
  }
  const index = new Map<string, string>();
  try {
    const rows = await all<{ ticker: string; company_name: string | null }>(
      env.DB,
      'SELECT ticker, company_name FROM securities_ref WHERE company_name IS NOT NULL',
    );
    for (const row of rows) {
      const ticker = (row.ticker || '').toUpperCase();
      const simplified = simplifyCompanyName(row.company_name || '');
      if (ticker && simplified) index.set(ticker, simplified);
    }
  } catch {
    index.clear();
  }
  nameIndexCache = { loadedAt: now, index };
  return index;
}

export function scoreHousePtrRow(
  row: ParsedTx,
  index: number,
  rows: readonly ParsedTx[],
  nameIndex?: HousePtrNameIndex,
): HousePtrRowScore {
  const validType = row.txType === 'B' || row.txType === 'S' || row.txType === 'E';
  const validAmount = row.amountMin != null && isValidBracket(row.amountMin, row.amountMax);
  const validDate = isRealIsoDate(row.txDate);
  const validOwner = Boolean(row.owner && OWNERS.has(row.owner));
  const validAssetType = !row.assetType || row.assetType.toUpperCase() in HOUSE_ASSET_TYPE_NAMES;
  const bleed = rowBleeds(row, index, rows);
  const tickerConsistency = tickerAssetConsistency(row, nameIndex);

  let score = 0;
  if (validType) score += 1;
  if (validAmount) score += 1;
  if (validDate) score += 1;
  if (validOwner) score += 1;
  if (row.assetType) {
    if (validAssetType) score += 1;
    else score -= 1;
  }
  if (bleed) score -= 3;
  else score += 3;
  switch (tickerConsistency) {
    case 'match':
      score += 2;
      break;
    case 'mismatch':
      score -= 4;
      break;
    case 'unknown':
      break;
    default: {
      const unexpected: never = tickerConsistency;
      throw new Error(`unexpected ticker consistency ${String(unexpected)}`);
    }
  }

  return {
    score,
    validType,
    validAmount,
    validDate,
    validOwner,
    validAssetType,
    bleed,
    tickerConsistency,
  };
}

export function arbitrateHousePtrParsers(
  tailRows: readonly ParsedTx[],
  columnRows: readonly ParsedTx[],
  nameIndex?: HousePtrNameIndex,
): HousePtrArbitration {
  if (tailRows.length === 0) return { rows: [...columnRows], contested: false };
  if (columnRows.length === 0) return { rows: [...tailRows], contested: false };

  const tailScores = tailRows.map((row, index) => scoreHousePtrRow(row, index, tailRows, nameIndex));
  const columnScores = columnRows.map((row, index) => scoreHousePtrRow(row, index, columnRows, nameIndex));
  const slots = alignHousePtrRows(tailRows, columnRows);

  let contested = false;
  const chosen: ParsedTx[] = [];
  for (const slot of slots) {
    const tail = slot.tailIndex == null ? null : tailRows[slot.tailIndex];
    const column = slot.columnIndex == null ? null : columnRows[slot.columnIndex];
    const tailScore = slot.tailIndex == null ? null : tailScores[slot.tailIndex];
    const columnScore = slot.columnIndex == null ? null : columnScores[slot.columnIndex];
    if (tail && column && tailScore && columnScore) {
      if (!sameTradeContent(tail, column)) contested = true;
      chosen.push(columnScore.score > tailScore.score ? column : tail);
      continue;
    }
    contested = true;
    const only = tail ?? column;
    const onlyScore = tailScore ?? columnScore;
    if (only && onlyScore && isTrustworthy(onlyScore)) chosen.push(only);
  }

  if (chosen.length === 0) {
    const tailTotal = tailScores.reduce((sum, row) => sum + row.score, 0);
    const columnTotal = columnScores.reduce((sum, row) => sum + row.score, 0);
    const fallback = columnTotal > tailTotal ? columnRows : tailRows;
    return { rows: fallback.map((row) => holdRow(row)), contested: true };
  }

  return {
    rows: chosen.map((row) => holdRow(row, contested)),
    contested,
  };
}

function holdRow(row: ParsedTx, contested = true): ParsedTx {
  if (!contested || row.confidence <= HOUSE_PTR_PARSER_HOLD_CONFIDENCE) return row;
  return { ...row, confidence: HOUSE_PTR_PARSER_HOLD_CONFIDENCE };
}

function isTrustworthy(score: HousePtrRowScore): boolean {
  return score.validType
    && score.validAmount
    && score.validDate
    && score.validOwner
    && score.validAssetType
    && !score.bleed
    && score.tickerConsistency !== 'mismatch';
}

function rowBleeds(row: ParsedTx, index: number, rows: readonly ParsedTx[]): boolean {
  const name = row.assetName ?? '';
  const sub = row.subholding ?? '';
  if (DETAIL_LABEL_RE.test(name) || DETAIL_LABEL_RE.test(sub)) return true;
  if (TYPE_BRACKET_RE.test(name) || TYPE_BRACKET_RE.test(sub)) return true;
  if (citedTickers(sub).length > 0) return true;
  const previous = rows[index - 1]?.subholding;
  if (
    previous
    && previous.includes('>')
    && collapse(previous).length >= 12
    && collapse(name).startsWith(collapse(previous))
  ) {
    return true;
  }
  return false;
}

function tickerAssetConsistency(row: ParsedTx, nameIndex?: HousePtrNameIndex): TickerConsistency {
  const ticker = (row.ticker ?? '').trim().toUpperCase();
  const cited = citedTickers(row.assetName ?? '');
  if (ticker && cited.length > 0 && !cited.includes(ticker)) return 'mismatch';
  if (!ticker) return cited.length > 0 ? 'mismatch' : 'unknown';
  const known = nameIndex?.get(ticker);
  if (!known) return 'unknown';
  const simplified = simplifyCompanyName(row.assetName ?? '');
  if (!simplified || simplified === ticker.toLowerCase()) return 'unknown';
  const knownName = simplifyCompanyName(known);
  return namesPlausiblyMatch(simplified, knownName) ? 'match' : 'mismatch';
}

function citedTickers(text: string): string[] {
  const found: string[] = [];
  PAREN_TICKER_RE.lastIndex = 0;
  for (const match of text.matchAll(PAREN_TICKER_RE)) {
    const symbol = (match[1] ?? '').toUpperCase();
    if (!symbol || TICKER_SKIP_RE.test(symbol)) continue;
    found.push(symbol);
  }
  return found;
}

function namesPlausiblyMatch(asset: string, known: string): boolean {
  if (!asset || !known) return true;
  return asset === known || asset.includes(known) || known.includes(asset);
}

function isRealIsoDate(value: string | null): boolean {
  if (!value) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function sameTradeContent(a: ParsedTx, b: ParsedTx): boolean {
  return canonicalAssetName(a) === canonicalAssetName(b)
    && (a.ticker ?? '').toUpperCase() === (b.ticker ?? '').toUpperCase()
    && (a.assetType ?? '').toUpperCase() === (b.assetType ?? '').toUpperCase()
    && a.txType === b.txType
    && (a.txDate ?? '') === (b.txDate ?? '')
    && a.amountMin === b.amountMin
    && a.amountMax === b.amountMax
    && (a.owner ?? '') === (b.owner ?? '')
    && collapse(a.subholding ?? '') === collapse(b.subholding ?? '')
    && collapse(a.filingStatus ?? '') === collapse(b.filingStatus ?? '')
    && collapse(a.description ?? '') === collapse(b.description ?? '')
    && collapse(a.location ?? '') === collapse(b.location ?? '');
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Asset-type bracket left on the name is the same row, not a second asset. */
function canonicalAssetName(row: ParsedTx): string {
  let name = collapse(row.assetName);
  const type = (row.assetType ?? '').toLowerCase();
  if (type && name.endsWith(`[${type}]`)) {
    name = name.slice(0, -(type.length + 2)).trim();
  }
  return name;
}

function alignKey(row: ParsedTx): string {
  return [row.txDate ?? '', row.txType, row.amountMin ?? '', row.amountMax ?? ''].join('|');
}

function pairScore(tail: ParsedTx, column: ParsedTx): number {
  if (alignKey(tail) === alignKey(column)) return 3;
  if (
    (tail.txDate ?? '') === (column.txDate ?? '')
    && tail.amountMin === column.amountMin
    && tail.amountMax === column.amountMax
  ) {
    return 2;
  }
  return 0;
}

/**
 * Order-preserving alignment. A date/amount/type match outranks a gap, so one
 * extra page-split row does not shift every later comparison.
 */
function alignHousePtrRows(tail: readonly ParsedTx[], column: readonly ParsedTx[]): AlignedSlot[] {
  const n = tail.length;
  const m = column.length;
  const gap = -1;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const choice: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i += 1) {
    dp[i][0] = i * gap;
    choice[i][0] = 2;
  }
  for (let j = 1; j <= m; j += 1) {
    dp[0][j] = j * gap;
    choice[0][j] = 3;
  }
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const pair = dp[i - 1][j - 1] + pairScore(tail[i - 1], column[j - 1]);
      const skipTail = dp[i - 1][j] + gap;
      const skipColumn = dp[i][j - 1] + gap;
      if (pair >= skipTail && pair >= skipColumn) {
        dp[i][j] = pair;
        choice[i][j] = 1;
      } else if (skipTail >= skipColumn) {
        dp[i][j] = skipTail;
        choice[i][j] = 2;
      } else {
        dp[i][j] = skipColumn;
        choice[i][j] = 3;
      }
    }
  }

  const slots: AlignedSlot[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const step = choice[i][j];
    if (step === 1) {
      slots.push({ tailIndex: i - 1, columnIndex: j - 1 });
      i -= 1;
      j -= 1;
    } else if (step === 2) {
      slots.push({ tailIndex: i - 1, columnIndex: null });
      i -= 1;
    } else {
      slots.push({ tailIndex: null, columnIndex: j - 1 });
      j -= 1;
    }
  }
  slots.reverse();
  return slots;
}
