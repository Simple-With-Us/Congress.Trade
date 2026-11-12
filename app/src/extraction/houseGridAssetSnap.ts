/**
 * Post-OCR snap of House grid-form asset names onto known securities.
 *
 * The grid reader keeps the OCR string when the letters already match a
 * securities_ref / securities_master / curated issuer name. A unique near
 * miss replaces only the misread token, lowers that row's confidence, and
 * fills a missing ticker only when the same match is strong and unambiguous.
 * Linked notes, hybrids, and option lines do not receive an equity ticker.
 */

import type { Env } from '../shared/types.ts';
import { all } from '../shared/db.ts';
import { OCR_KNOWN_ISSUERS } from './ocrSanity.ts';
import type { HouseGridRead } from './houseGridForm.ts';

/** Subtracted from row confidence when the asset name string changes. */
export const HOUSE_GRID_ASSET_SNAP_CONFIDENCE_DROP = 0.03;

export interface HouseGridSecurityRef {
  ticker: string | null;
  name: string;
}

export interface HouseGridSecurityCatalog {
  entries: readonly HouseGridSecurityRef[];
}

interface Piece {
  glue: string;
  display: string[];
}

interface Group {
  core: Piece[];
  tickers: Set<string>;
}

interface ScoredGroup {
  ratio: number;
  distance: number;
  key: string;
  group: Group;
}

type AlignStep =
  | { kind: 'eq'; i: number; j: number }
  | { kind: 'sub'; i: number; j: number }
  | { kind: 'split'; i: number; j: number }
  | { kind: 'join'; i: number; j: number }
  | { kind: 'drop'; i: number; j: number }
  | { kind: 'keep'; i: number; j: number };

const SHARE = new Set([
  'CMN', 'COM', 'COMMON', 'STOCK', 'SHARES', 'SHARE', 'CLASS', 'ADR', 'ADS', 'USD', 'USD0',
]);
const NOTE = new Set([
  'LINKED', 'INDEX', 'INDICES', 'BASKET', 'ISIN', 'HYBRID', 'PERPETUAL',
  'CALL', 'PUT', 'FLEX', 'EURO', 'EXP', 'OPTION', 'OPTIONS',
]);
const LEGAL = new Set([
  'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED', 'PLC', 'LLC',
]);
const LEGAL_EQ: Readonly<Record<string, string>> = {
  CORP: 'CORPORATION',
  CORPORATION: 'CORP',
  INC: 'INCORPORATED',
  INCORPORATED: 'INC',
  CO: 'COMPANY',
  COMPANY: 'CO',
  LTD: 'LIMITED',
  LIMITED: 'LTD',
};
const NON_EQUITY = /LINKED|HYBRID|PERPETUAL|ISIN|CALL\/|PUT\/|OPTION/i;
const OPTION_LINE = /^(?:PUT|CALL)\//i;
const INF = 50;
const CATALOG_TTL_MS = 10 * 60 * 1000;

let catalogCache: { at: number; catalog: HouseGridSecurityCatalog } | null = null;

/** Drop the process-local securities catalog (tests). */
export function clearHouseGridSecurityCatalogCache(): void {
  catalogCache = null;
}

function piecesOf(value: string): Piece[] {
  const words = value.toUpperCase().match(/[A-Z0-9&']+/g) ?? [];
  return words.map((word) => {
    const display = word.match(/[A-Z0-9]+/g) ?? [word];
    return { glue: display.join(''), display };
  });
}

function isTail(glue: string, previous: string): boolean {
  return SHARE.has(glue)
    || NOTE.has(glue)
    || /^\d+$/.test(glue)
    || (previous === 'CLASS' && (glue === 'A' || glue === 'B' || glue === 'C'));
}

function partition(parts: readonly Piece[]): { core: Piece[]; tail: Piece[] } {
  const core: Piece[] = [];
  const tail: Piece[] = [];
  let previous = '';
  for (const part of parts) {
    if (isTail(part.glue, previous)) tail.push(part);
    else core.push(part);
    previous = part.glue;
  }
  return { core, tail };
}

function matchKey(core: readonly Piece[]): string {
  let key = '';
  for (const part of core) {
    if (LEGAL.has(part.glue) || part.glue === 'THE' || part.glue === 'AND') continue;
    key += part.glue;
  }
  return key;
}

function levenshtein(left: string, right: string, cap: number): number {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > cap) return cap + 1;
  let prev = new Array<number>(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) prev[j] = j;
  for (let i = 0; i < left.length; i += 1) {
    const curr = new Array<number>(right.length + 1);
    curr[0] = i + 1;
    let rowMin = curr[0];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i] === right[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > cap) return cap + 1;
    prev = curr;
  }
  return prev[right.length];
}

function tokensEqual(left: string, right: string): boolean {
  return left === right || LEGAL_EQ[left] === right;
}

function buildGroups(catalog: HouseGridSecurityCatalog): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const entry of catalog.entries) {
    const name = entry.name?.trim();
    if (!name) continue;
    const { core } = partition(piecesOf(name));
    const key = matchKey(core);
    if (key.length < 5) continue;
    let group = groups.get(key);
    if (!group) {
      group = { core, tickers: new Set() };
      groups.set(key, group);
    }
    const ticker = entry.ticker?.trim().toUpperCase();
    if (ticker) group.tickers.add(ticker);
  }
  return groups;
}

function bestGroup(
  core: readonly Piece[],
  groups: Map<string, Group>,
): { best: ScoredGroup; second: ScoredGroup | null; key: string } | null {
  const key = matchKey(core);
  if (key.length < 5) return null;
  let best: ScoredGroup | null = null;
  let second: ScoredGroup | null = null;
  for (const [candidateKey, group] of groups) {
    if (Math.abs(candidateKey.length - key.length) > 3) continue;
    const distance = levenshtein(key, candidateKey, 3);
    if (distance > 2) continue;
    const ratio = 1 - distance / Math.max(key.length, candidateKey.length);
    const scored: ScoredGroup = { ratio, distance, key: candidateKey, group };
    if (!best || scored.ratio > best.ratio || (scored.ratio === best.ratio && scored.distance < best.distance)) {
      if (best && best.key !== candidateKey) second = best;
      best = scored;
    } else if (candidateKey !== best.key && (!second || scored.ratio > second.ratio)) {
      second = scored;
    }
  }
  if (!best) return null;
  return { best, second, key };
}

function alignCores(ocr: readonly Piece[], catalog: readonly Piece[]): string[] | null {
  const rows = ocr.length;
  const cols = catalog.length;
  const dp: number[][] = [];
  const bt: Array<Array<AlignStep | null>> = [];
  for (let i = 0; i <= rows; i += 1) {
    dp.push(new Array<number>(cols + 1).fill(INF));
    bt.push(new Array<AlignStep | null>(cols + 1).fill(null));
  }
  dp[0][0] = 0;
  for (let i = 0; i <= rows; i += 1) {
    for (let j = 0; j <= cols; j += 1) {
      if (dp[i][j] >= INF) continue;
      if (i < rows && j < cols && tokensEqual(ocr[i].glue, catalog[j].glue)) {
        if (dp[i][j] < dp[i + 1][j + 1]) {
          dp[i + 1][j + 1] = dp[i][j];
          bt[i + 1][j + 1] = { kind: 'eq', i, j };
        }
      }
      if (i < rows && j < cols && !tokensEqual(ocr[i].glue, catalog[j].glue)) {
        const distance = levenshtein(ocr[i].glue, catalog[j].glue, 2);
        const editable = distance === 1
          || (distance === 2 && Math.min(ocr[i].glue.length, catalog[j].glue.length) >= 6);
        if (editable && !LEGAL.has(ocr[i].glue) && !LEGAL.has(catalog[j].glue)) {
          const cost = dp[i][j] + distance;
          if (cost < dp[i + 1][j + 1]) {
            dp[i + 1][j + 1] = cost;
            bt[i + 1][j + 1] = { kind: 'sub', i, j };
          }
        }
      }
      if (i < rows && j + 1 < cols && ocr[i].glue === catalog[j].glue + catalog[j + 1].glue) {
        if (dp[i][j] < dp[i + 1][j + 2]) {
          dp[i + 1][j + 2] = dp[i][j];
          bt[i + 1][j + 2] = { kind: 'split', i, j };
        }
      }
      if (i + 1 < rows && j < cols && !LEGAL.has(ocr[i].glue) && !LEGAL.has(ocr[i + 1].glue)) {
        const joined = ocr[i].glue + ocr[i + 1].glue;
        const distance = levenshtein(joined, catalog[j].glue, 1);
        if (distance <= 1) {
          const cost = dp[i][j] + distance;
          if (cost < dp[i + 2][j + 1]) {
            dp[i + 2][j + 1] = cost;
            bt[i + 2][j + 1] = { kind: 'join', i, j };
          }
        }
      }
      if (i === rows && j < cols && LEGAL.has(catalog[j].glue) && dp[i][j] < dp[i][j + 1]) {
        dp[i][j + 1] = dp[i][j];
        bt[i][j + 1] = { kind: 'drop', i, j };
      }
      if (j === cols && i < rows && LEGAL.has(ocr[i].glue) && dp[i][j] < dp[i + 1][j]) {
        dp[i + 1][j] = dp[i][j];
        bt[i + 1][j] = { kind: 'keep', i, j };
      }
    }
  }
  if (dp[rows][cols] <= 0 || dp[rows][cols] >= INF) return null;
  const steps: AlignStep[] = [];
  let i = rows;
  let j = cols;
  while (i > 0 || j > 0) {
    const step = bt[i][j];
    if (!step) return null;
    steps.push(step);
    if (step.kind === 'split') {
      i = step.i;
      j = step.j;
    } else if (step.kind === 'join') {
      i = step.i;
      j = step.j;
    } else {
      i = step.i;
      j = step.j;
    }
  }
  steps.reverse();
  const display: string[] = [];
  for (const step of steps) {
    switch (step.kind) {
      case 'eq':
      case 'keep':
        display.push(...ocr[step.i].display);
        break;
      case 'sub':
        display.push(...catalog[step.j].display);
        break;
      case 'split':
        display.push(...catalog[step.j].display, ...catalog[step.j + 1].display);
        break;
      case 'join':
        display.push(...catalog[step.j].display);
        break;
      case 'drop':
        break;
      default: {
        const neverStep: never = step;
        throw new Error(`unhandled snap step ${JSON.stringify(neverStep)}`);
      }
    }
  }
  return display;
}

function originalDisplay(name: string): string {
  return piecesOf(name).flatMap((part) => part.display).join(' ');
}

export interface HouseGridAssetSnapInput {
  assetName: string;
  ticker: string | null;
  confidence: number;
  supplementalText?: string | null;
}

export interface HouseGridAssetSnapResult {
  assetName: string;
  ticker: string | null;
  confidence: number;
  supplementalText?: string | null;
  /** True when the stored asset name changed. */
  snapped: boolean;
}

function unchanged(input: HouseGridAssetSnapInput): HouseGridAssetSnapResult {
  return {
    assetName: input.assetName,
    ticker: input.ticker,
    confidence: input.confidence,
    supplementalText: input.supplementalText,
    snapped: false,
  };
}

/**
 * Snap one OCR asset line. A letter-identical catalog hit keeps the OCR
 * text. A unique one- or two-edit hit rewrites the misread token and
 * lowers confidence. An existing ticker is never replaced.
 */
export function snapHouseGridAsset(
  input: HouseGridAssetSnapInput,
  groups: Map<string, Group>,
): HouseGridAssetSnapResult {
  if (OPTION_LINE.test(input.assetName)) return unchanged(input);
  const { core, tail } = partition(piecesOf(input.assetName));
  const found = bestGroup(core, groups);
  if (!found) return unchanged(input);
  const { best, second, key } = found;
  const margin = second ? best.ratio - second.ratio : 1;
  const existing = input.ticker?.trim().toUpperCase() || null;
  if (best.distance === 0) {
    let ticker = existing;
    if (
      !ticker
      && best.group.tickers.size === 1
      && margin >= 0.05
      && !NON_EQUITY.test(input.assetName)
    ) {
      ticker = [...best.group.tickers][0];
    }
    return { ...unchanged(input), ticker };
  }
  const shorter = Math.min(key.length, best.key.length);
  // A five-character key is one letter of the whole name (ratio 0.80). A
  // two-edit runner-up is only 0.20 behind, which still clears 0.12. Zoetis
  // is that length and is unique, so the short-key case needs a wider margin.
  const oneEditMargin = shorter <= 5 ? 0.25 : 0.12;
  const oneEdit = best.distance === 1 && shorter >= 5 && best.ratio >= 0.8 && margin >= oneEditMargin;
  const twoEdit = best.distance === 2 && shorter >= 8 && best.ratio >= 0.9 && margin >= 0.08;
  if (!oneEdit && !twoEdit) return unchanged(input);
  if (existing && best.group.tickers.size > 0 && !best.group.tickers.has(existing)) {
    return unchanged(input);
  }
  const display = alignCores(core, best.group.core);
  if (!display) return unchanged(input);
  for (const part of tail) display.push(...part.display);
  const assetName = display.join(' ');
  if (assetName === originalDisplay(input.assetName)) return unchanged(input);
  let ticker = existing;
  if (
    !ticker
    && best.distance <= 1
    && margin >= (key.length <= 5 ? 0.25 : 0.08)
    && best.group.tickers.size === 1
    && key.length >= 5
    && !NON_EQUITY.test(input.assetName)
  ) {
    ticker = [...best.group.tickers][0];
  }
  const note = 'asset name snapped';
  const supplementalText = input.supplementalText
    ? `${input.supplementalText}; ${note}`
    : note;
  return {
    assetName,
    ticker,
    confidence: Math.min(input.confidence, Math.max(0, input.confidence - HOUSE_GRID_ASSET_SNAP_CONFIDENCE_DROP)),
    supplementalText,
    snapped: true,
  };
}

const groupCache = new WeakMap<HouseGridSecurityCatalog, Map<string, Group>>();

function groupsFor(catalog: HouseGridSecurityCatalog): Map<string, Group> {
  let groups = groupCache.get(catalog);
  if (!groups) {
    groups = buildGroups(catalog);
    groupCache.set(catalog, groups);
  }
  return groups;
}

/** Snap every row. Rows that are not rewritten keep their confidence. */
export function snapHouseGridAssets<T extends HouseGridAssetSnapInput>(
  rows: readonly T[],
  catalog: HouseGridSecurityCatalog,
): T[] {
  const groups = groupsFor(catalog);
  return rows.map((row) => {
    const snapped = snapHouseGridAsset(row, groups);
    if (
      !snapped.snapped
      && snapped.ticker === (row.ticker?.trim().toUpperCase() || null)
      && snapped.assetName === row.assetName
    ) {
      return row;
    }
    return {
      ...row,
      assetName: snapped.assetName,
      ticker: snapped.ticker,
      confidence: snapped.confidence,
      supplementalText: snapped.supplementalText,
    };
  });
}

/** Apply the snap to a finished grid read. Column marks are unchanged. */
export function snapHouseGridRead(
  read: HouseGridRead,
  catalog: HouseGridSecurityCatalog,
): HouseGridRead {
  return { ...read, transactions: snapHouseGridAssets(read.transactions, catalog) };
}

function parseAliases(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * securities_ref company names, securities_master names and aliases, and the
 * curated issuer list. An empty catalog leaves every OCR line unchanged.
 */
function isMissingTable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes('no such table');
}

export async function loadHouseGridSecurityCatalog(env: Env): Promise<HouseGridSecurityCatalog> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.catalog;
  const entries: HouseGridSecurityRef[] = [];
  let cacheable = true;
  try {
    const refs = await all<{ ticker: string | null; company_name: string | null }>(
      env.DB,
      `SELECT ticker, company_name FROM securities_ref
        WHERE company_name IS NOT NULL AND trim(company_name) != ''`,
    );
    for (const row of refs) entries.push({ ticker: row.ticker, name: row.company_name ?? '' });
  } catch (err) {
    // A missing ref table is stable. A lock or other failure must be retried.
    if (!isMissingTable(err)) cacheable = false;
  }
  try {
    const masters = await all<{ ticker: string | null; name: string | null; aliases: string | null }>(
      env.DB,
      'SELECT ticker, name, aliases FROM securities_master',
    );
    for (const row of masters) {
      if (row.name?.trim()) entries.push({ ticker: row.ticker, name: row.name });
      for (const alias of parseAliases(row.aliases)) {
        entries.push({ ticker: row.ticker, name: alias });
      }
    }
  } catch (err) {
    if (!isMissingTable(err)) cacheable = false;
  }
  for (const name of OCR_KNOWN_ISSUERS) entries.push({ ticker: null, name });
  const catalog = { entries };
  if (cacheable) catalogCache = { at: now, catalog };
  return catalog;
}
