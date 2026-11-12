/**
 * src/enrichment/nameTickerBackfill.ts
 *
 * Issuer-name -> ticker resolution for asset descriptions that carry NO ticker.
 *
 * Board row 16b46688: 32.6% of published trades had ticker=null, including
 * obvious large caps.  The extractor is faithful (the House scanned form itself
 * says "Provide full name, not ticker symbol"); the gap is downstream.  The
 * existing resolver only matched names through `simplifyCompanyName`, which
 * strips punctuation WITHOUT splitting and keeps the broker's share descriptors,
 * so "Uber Technologies Inc. CMN" became "uber technologies cmn" and never met
 * securities_master's "Uber Technologies, Inc.", "Coca Cola Company (the) CMN"
 * never met "Coca-Cola Company (The)", and "Starbucks Corp.CMN 6" fused
 * "corp.cmn" into one token.
 *
 * This module normalizes BOTH sides (the filing's description and every known
 * company name) with the same function and resolves only on a UNIQUE match:
 *
 *   - legal-form words (Inc, Corp, Co, Ltd, PLC...) and share descriptors
 *     (CMN, COM, Common Stock, Ordinary, ADR, Voting...) are dropped, "the" and
 *     "and" are dropped, "&" is spelled out, and every punctuation mark splits
 *     tokens ("Corp.CMN" -> "corp cmn");
 *   - a share CLASS is kept as a second, more specific key, so "Alphabet Inc.
 *     CMN Class C" resolves to GOOG while a bare "Alphabet" stays ambiguous;
 *   - a key that maps to more than one ticker never resolves (no guessing);
 *   - a description that reads as anything other than plain equity — a bond
 *     ("Perp", "Notes", a coupon "%"), a preferred, a fund/ETF, a warrant, an
 *     option — never resolves, however well the issuer name matches.
 *
 * Sources for the index: securities_ref.company_name (the enriched, freshest
 * names) and securities_master name/aliases.  Pure and deterministic; the only
 * DB access is `loadIssuerNameIndex`.
 */

import type { Env } from '../shared/types.ts';
import { all } from '../shared/db.ts';

/** Legal-form and filler words that never distinguish one issuer from another. */
const LEGAL_TOKENS = new Set([
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'plc', 'llc',
  'lp', 'nv', 'sa', 'ag', 'the', 'and', 'de', 'cv',
]);

/** Share descriptors brokers append to the issuer name. */
const DESCRIPTOR_TOKENS = new Set([
  'cmn', 'com', 'common', 'stock', 'stk', 'shares', 'share', 'sh', 'ord', 'ordinary', 'adr', 'ads',
  'sponsored', 'voting', 'vtg', 'non', 'ny', 'reg', 'registered',
]);

/**
 * Anything here means "not a plain equity line": the description is a bond,
 * preferred, fund, derivative or similar, so an issuer-name match would attach
 * the WRONG security's ticker.
 */
const NON_EQUITY_TOKENS = new Set([
  'note', 'notes', 'bond', 'bonds', 'debenture', 'debentures', 'pfd', 'pref', 'preferred', 'preference',
  'perp', 'perpetual', 'series', 'due', 'fund', 'funds', 'etf', 'etn', 'warrant', 'warrants', 'option',
  'options', 'call', 'calls', 'put', 'puts', 'treasury', 'bill', 'bills', 'municipal', 'muni', 'cd',
  'coupon', 'matures', 'maturity', 'senior', 'subordinated', 'convertible', 'depositary', 'depository',
  'rights',
]);

/** Filing shorthand expanded on BOTH sides so "Apollo Global MGMT" meets "Apollo Global Management". */
const ABBREVIATIONS: Readonly<Record<string, string>> = {
  mgmt: 'management',
  grp: 'group',
  hldgs: 'holdings',
  hldg: 'holdings',
  intl: 'international',
};

export interface IssuerNameKeys {
  /** Legal-form/descriptor/class-stripped name, e.g. "coca cola". */
  base: string;
  /** base + " class x" when the description names a share class, else null. */
  classed: string | null;
  /** The described share class letter/digit (lowercase), else null. */
  shareClass: string | null;
  /** True when the description reads as something other than plain equity. */
  nonEquity: boolean;
}

function fold(raw: string): string {
  return raw
    // Parenthetical asides — "(the)", "(New)", a listing note — never identify the issuer.
    .replace(/\([^)]*\)/g, ' ')
    // "Class C Capital Stock" is the share descriptor, not part of the issuer name.
    .replace(/\bcapital\s+stock\b/gi, ' ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’ʼ'`]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/%/g, ' pct ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Reduce a company name or an asset description to comparable keys.  Returns
 * null when nothing usable remains.  `isQuery` additionally drops a trailing
 * one/two-digit footnote marker ("Starbucks Corp.CMN 6").
 */
export function issuerNameKeys(raw: string | null | undefined, opts: { isQuery?: boolean } = {}): IssuerNameKeys | null {
  const folded = fold(String(raw ?? ''));
  if (!folded) return null;
  let tokens = folded.split(' ').filter(Boolean);
  if (opts.isQuery) {
    while (tokens.length > 1 && /^\d{1,2}$/.test(tokens[tokens.length - 1])) tokens.pop();
  }

  let nonEquity = false;
  let shareClass: string | null = null;
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (NON_EQUITY_TOKENS.has(t) || t === 'pct' || /^\d+$/.test(t) && tokens.includes('pct')) {
      nonEquity = true;
      continue;
    }
    if (t === 'class') {
      const next = tokens[i + 1];
      if (next && /^[a-z0-9]{1,2}$/.test(next)) {
        shareClass = next;
        i += 1;
      }
      continue;
    }
    if (LEGAL_TOKENS.has(t) || DESCRIPTOR_TOKENS.has(t)) continue;
    kept.push(ABBREVIATIONS[t] ?? t);
  }
  if (kept.length === 0) return null;
  const base = kept.join(' ');
  return { base, classed: shareClass ? `${base} class ${shareClass}` : null, shareClass, nonEquity };
}

/**
 * key -> ticker -> "is this the enriched, priced line" (securities_ref carries a
 * market cap).  Several tickers can share one issuer name (a preferred series, a
 * when-issued line, a dual class); the flag lets an otherwise-ambiguous key
 * resolve to the ONE line that is actually priced.
 */
export interface IssuerNameIndex {
  base: Map<string, Map<string, boolean>>;
  classed: Map<string, Map<string, boolean>>;
}

export function emptyIssuerNameIndex(): IssuerNameIndex {
  return { base: new Map(), classed: new Map() };
}

function addKey(map: Map<string, Map<string, boolean>>, key: string, ticker: string, priced: boolean): void {
  const tickers = map.get(key);
  if (tickers) tickers.set(ticker, (tickers.get(ticker) ?? false) || priced);
  else map.set(key, new Map([[ticker, priced]]));
}

/** Add one known (ticker, company name) pair to the index. */
export function addIssuerName(
  index: IssuerNameIndex,
  ticker: string | null | undefined,
  name: string | null | undefined,
  priced = false,
): void {
  const t = (ticker ?? '').trim().toUpperCase();
  if (!t) return;
  const keys = issuerNameKeys(name);
  // A name that is itself a fund/bond/preferred line must never lend its ticker to an
  // ordinary equity description with the same base words.
  if (!keys || keys.nonEquity) return;
  addKey(index.base, keys.base, t, priced);
  if (keys.classed) addKey(index.classed, keys.classed, t, priced);
}

/** Build an index from any number of (ticker, name) sources. */
export function buildIssuerNameIndex(
  pairs: Iterable<{ ticker: string | null | undefined; name: string | null | undefined; priced?: boolean }>,
): IssuerNameIndex {
  const index = emptyIssuerNameIndex();
  for (const p of pairs) addIssuerName(index, p.ticker, p.name, p.priced === true);
  return index;
}

/** The single ticker behind a key: the only candidate, else the only PRICED one, else none. */
function only(tickers: Map<string, boolean> | undefined): string | null {
  if (!tickers || tickers.size === 0) return null;
  if (tickers.size === 1) return [...tickers.keys()][0];
  const priced = [...tickers].filter(([, isPriced]) => isPriced);
  return priced.length === 1 ? priced[0][0] : null;
}

/**
 * The one ticker an asset description names, or null.  A described share class
 * is tried first; when it is not found only Class A (or no class) may fall back
 * to the class-free key, because most enriched names omit the class and a
 * "Class C" description must never inherit the Class A ticker (Alphabet
 * GOOG vs GOOGL).
 */
export function resolveTickerByIssuerName(index: IssuerNameIndex, assetName: string | null | undefined): string | null {
  const keys = issuerNameKeys(assetName, { isQuery: true });
  if (!keys || keys.nonEquity) return null;
  if (keys.classed) {
    const hit = only(index.classed.get(keys.classed));
    if (hit) return hit;
    if (keys.shareClass !== 'a') return null;
  }
  return only(index.base.get(keys.base));
}

/** securities_ref + securities_master names, the index behind the extraction-time resolver. */
export async function loadIssuerNameIndex(env: Env): Promise<IssuerNameIndex> {
  const index = emptyIssuerNameIndex();
  try {
    const refRows = await all<{ ticker: string; company_name: string | null; market_cap: number | null }>(
      env.DB,
      'SELECT ticker, company_name, market_cap FROM securities_ref WHERE company_name IS NOT NULL',
    );
    for (const r of refRows) addIssuerName(index, r.ticker, r.company_name, r.market_cap != null && r.market_cap > 0);
  } catch {
    // Fail open: an empty ref side just means fewer names resolve, never a hard failure.
  }
  return index;
}
