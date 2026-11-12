import { applyMemberNameAlias } from '../shared/memberIdentity.ts';
import { houseAssetTypeCodePattern } from '../shared/assetTypes.ts';

export function isJunkAssetString(s: string | null | undefined): boolean {
  if (!s) return true;
  const str = String(s).trim();
  if (!str) return true;
  const lower = str.toLowerCase();
  if (
    lower.includes('unparsed historical filing') ||
    lower.includes('this filing was disclosed via scanned pdf') ||
    lower.includes('use link in ptr_link column to view the pdf') ||
    lower.includes('pdf disclosed filing')
  ) {
    return true;
  }
  const stripped = str.replace(/[\.\s\-\_\:\;\,\?\!\[\]\(\)]/g, '');
  if (stripped.length === 0) return true;
  if (/^[\.\_\-\s\]\)]+[a-z]?$/i.test(str)) return true;
  if (/[\.\_\-]{2,}/.test(str) && stripped.length <= 2) return true;
  return false;
}

export function cleanAssetString(name: string | null | undefined, ticker?: string | null): string {
  if (!name || isJunkAssetString(name)) return '';
  let str = name.trim();

  // Strip leading/trailing dot-leaders, brackets, and orphan OCR trailing noise (e.g. "ARCC ..", ".....]", "....k")
  str = str.replace(/(?:\s*[\.]{2,}[a-z0-9\]\)]*|\s*\]+)$/i, '');
  str = str.replace(/^[.\s\]\)\-]+/, '');
  str = str.replace(/\s*\.{2,}\s*/g, ' ');

  // If the name is produced as exactly the ticker, return the uppercase ticker
  if (ticker && str.toLowerCase() === ticker.trim().toLowerCase()) {
    return ticker.toUpperCase();
  }

  // Strip state of incorporation suffix (e.g. "/DE/", "/DE", "/CA") only if it matches a US state code
  const STATES = new Set([
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"
  ]);
  str = str.replace(/\/([a-zA-Z]{2})(?:\/|\b)/g, (match, code) => {
    if (STATES.has(code.toUpperCase())) {
      return " ";
    }
    return match;
  });
  str = str.replace(/\s{2,}/g, " ").trim();

  // 1. Remove trailing stock exchanges in parentheses (e.g. "(NYSE)", "(NASDAQ: AAPL)")
  str = str.replace(/\s*\([A-Z]+(?:\s*:\s*[A-Z]+)?\)\s*$/i, '');

  // 2. Remove trailing slash
  str = str.replace(/\/\s*$/g, '');

  // 3. Title case if the string is primarily ALL CAPS.
  const upperCount = (str.match(/[A-Z]/g) || []).length;
  const lowerCount = (str.match(/[a-z]/g) || []).length;
  
  if (upperCount > 0 && upperCount > lowerCount * 2) {
    let wordIndex = 0;
    str = str.replace(/[A-Za-z0-9]+/g, (txt) => {
      const isFirstWord = wordIndex++ === 0;
      const upper = txt.toUpperCase();
      if (upper === 'INC') return 'Inc.';
      if (upper === 'COM') return 'com';
      if (upper === 'CO') return 'Co.';
      if (upper === 'LTD') return 'Ltd.';
      if (upper === 'CORP') return 'Corp.';
      if (['THE', 'AND', 'FOR', 'OF', 'IN', 'ON', 'AT', 'TO'].includes(upper)) {
        return isFirstWord ? txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase() : txt.toLowerCase();
      }
      
      // Keep acronyms (e.g., IBM, CBS, LLC, ETF, USA) uppercase if 3 chars or fewer without vowels
      if (txt.length <= 3 && txt.toUpperCase() === txt && !/[AEIOU]/i.test(txt)) {
        return txt;
      }
      return txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase();
    });
    // The expansions above append a period ("INC" -> "Inc."), but the word
    // matcher is [A-Za-z0-9]+ and so never consumed one the source already had.
    // "ECOLAB Inc." came out as "Ecolab Inc..". Scoped to exactly the
    // abbreviations this branch rewrites so no other punctuation is touched.
    str = str.replace(/\b(Inc|Co|Ltd|Corp)\.\.+/g, '$1.');
  }

  // 4. Entity normalizations (case-insensitive)
  str = str.replace(/(?:\s*(?:-)?\s*Common Stock\b)/ig, '');
  str = str.replace(/\bAmazon\s+Com\s+Inc\.?\b/gi, 'Amazon.com, Inc.');
  str = str.replace(/\bAmazon\.com\s+Inc\.?\b/gi, 'Amazon.com, Inc.');
  str = str.replace(/\bMeta\s+Platforms\s+Inc\.?\b/gi, 'Meta Platforms, Inc.');
  str = str.replace(/\bINC(?:\.|\b)/gi, 'Inc.');
  str = str.replace(/\bL\.?L\.?C(?:\.|\b)/gi, 'LLC');
  str = str.replace(/\bL\.?P(?:\.|\b)/gi, 'LP');
  str = str.replace(/\bCORP(?:\.|\b)/gi, 'Corp.');
  str = str.replace(/\bCO(?:\.|\b)(?=\s|$)/gi, 'Co.'); // Only match "Co." at end of string or before space
  str = str.replace(/\bLTD(?:\.|\b)/gi, 'Ltd.');

  // Clean up any double spaces or spaces before punctuation
  str = str.replace(/\s+([.,])/g, '$1');
  str = str.replace(/\s{2,}/g, ' ');

  return str.trim();
}

// ---------------------------------------------------------------------------
// Asset name <-> cleaning-note split
// ---------------------------------------------------------------------------

/**
 * An asset name with the disclosure-form scaffolding lifted out of it. `note`
 * is an internal `transactions.cleaning_note` fragment (plain-English, no
 * terminal punctuation) surfaced as the web "Notes" column via
 * `plainCleaningNote`; null when nothing was moved.
 */
export interface AssetNameDetail {
  name: string;
  note: string | null;
}

/**
 * Trailing bracket scaffolding: House asset-type codes ("[GS]", "[ST]", "[4K]")
 * and numeric footnote markers ("[1]", "[1][2]"). Both are form artifacts, not
 * part of the security's name — the type code is already stored in
 * `asset_type`, and the footnote marker points at a page the feed never shows.
 *
 * Anchored at the END and repeatable so mid-string bracketed content survives
 * untouched: "Lisa Family Investments LP [15294% Interest]" is real disclosed
 * detail and matches neither alternative.
 *
 * Reuses `houseAssetTypeCodePattern()` rather than restating the code list, so
 * a new House code only has to be added in shared/assetTypes.ts.
 */
const TRAILING_BRACKET_JUNK_RE = new RegExp(
  String.raw`(?:\s*\[(?:${houseAssetTypeCodePattern()}|\d{1,3})\])+\s*$`,
  'i',
);

/**
 * The rigid Senate eFD suffix, e.g.
 * "… Revenue Bond Rate/Coupon: 5.0% Matures: 05/01/2026". Only the literal
 * "Rate/Coupon:" lead-in matches — an INLINE rate/date ("King Cnty Wash Ltd.
 * 4.00% 12/1/32") is genuinely part of a muni's name and is deliberately left
 * alone.
 */
const COUPON_SUFFIX_RE = /\s*Rate\s*\/\s*Coupon\s*:\s*(\S+?)\s*(?:Matures\s*:\s*(\S+)\s*)?$/i;

/** MM/DD/YY(YY), YYYY-MM-DD, or "Jun 15, 2030" / "March 15, 2085". */
const MATURITY_DATE = String.raw`(?:\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})`;
const COUPON_RATE = String.raw`\d{1,2}(?:\.\d{1,3})?\s*%`;

/**
 * The other rigid maturity suffix House/Senate sources emit, in the three
 * orders actually observed in production:
 *   "… JR Oblig 4.00% Due Jun 15, 2030"   (rate then Due-date)
 *   "US TREASURY DUE 08/15/2030 0.625%"   (Due-date then rate)
 *   "… Go Utx Due 08/15/31"               (Due-date alone)
 * The literal word "Due" immediately followed by a date is what makes this
 * safe; a bare inline "4.00% 12/1/32" is NOT matched (see COUPON_SUFFIX_RE).
 */
const DUE_SUFFIX_RES: readonly RegExp[] = [
  new RegExp(String.raw`\s*(${COUPON_RATE})\s*Due\s+(${MATURITY_DATE})\s*$`, 'i'),
  new RegExp(String.raw`\s*Due\s+(${MATURITY_DATE})\s+(${COUPON_RATE})\s*$`, 'i'),
  new RegExp(String.raw`\s*Due\s+(${MATURITY_DATE})\s*$`, 'i'),
];

/** "<security A> (Exchanged) <security B>[ (Received)]" — one PTR row, two legs. */
const EXCHANGE_RE = /^(.*?)\s*\(\s*Exchanged\s*\)\s*(.*)$/i;

function trimWhitespace(value: string): string {
  // WHITESPACE ONLY. A previous dry run stripped trailing punctuation too and
  // silently rewrote 790 ordinary company names ("Adobe Inc." -> "Adobe Inc",
  // "AT&T Inc." -> "AT&T Inc"). Never widen this character class.
  return value.replace(/^\s+|\s+$/g, '');
}

function normalizeRate(rate: string): string {
  const trimmed = trimWhitespace(rate).replace(/\s+/g, '');
  return /%$/.test(trimmed) ? trimmed : `${trimmed}%`;
}

/**
 * Split disclosure-form scaffolding out of a raw asset name, returning the
 * name a reader wants plus an audit note carrying what was moved.
 *
 * Order matters: brackets are stripped first (they sit outside everything
 * else), then the maturity suffix (it trails the exchange leg on combined
 * rows), then the exchange split. `cleanAssetString` runs LAST — running it
 * first would eat the closing bracket of "[GS]" via its trailing-`]` OCR rule
 * and leave "US Treasury Bill [GS".
 */
export function splitAssetNameDetail(
  name: string | null | undefined,
  ticker?: string | null,
): AssetNameDetail {
  if (!name || isJunkAssetString(name)) {
    return { name: cleanAssetString(name, ticker), note: null };
  }

  let str = trimWhitespace(String(name));
  const notes: string[] = [];

  // 1. Trailing form scaffolding. Stripped silently: the House code duplicates
  //    asset_type and a footnote marker carries no information we can show.
  str = trimWhitespace(str.replace(TRAILING_BRACKET_JUNK_RE, ''));

  // 2. Rigid maturity/coupon suffix -> note.
  let rate: string | null = null;
  let matures: string | null = null;
  const coupon = COUPON_SUFFIX_RE.exec(str);
  if (coupon) {
    rate = coupon[1] ?? null;
    matures = coupon[2] ?? null;
    str = trimWhitespace(str.slice(0, coupon.index));
  } else {
    for (const [index, re] of DUE_SUFFIX_RES.entries()) {
      const due = re.exec(str);
      if (!due) continue;
      if (index === 0) {
        rate = due[1];
        matures = due[2];
      } else if (index === 1) {
        matures = due[1];
        rate = due[2];
      } else {
        matures = due[1];
      }
      str = trimWhitespace(str.slice(0, due.index));
      break;
    }
  }

  // A suffix-only string ("Rate/Coupon: 5.0% Matures: …" with no issuer) has no
  // name left to keep; leave the row exactly as it was rather than blanking it.
  if (!str) return { name: cleanAssetString(name, ticker), note: null };

  // 3. Exchange legs. The PTR row discloses ONE asset; the leading leg is that
  //    asset. The trailing leg is real disclosed text, so it goes to the note
  //    rather than being dropped — and never becomes a second row or ticker.
  const exchange = EXCHANGE_RE.exec(str);
  if (exchange && trimWhitespace(exchange[1])) {
    const received = trimWhitespace(exchange[2]).replace(/\s*\(\s*Received\s*\)\s*$/i, '');
    str = trimWhitespace(exchange[1]);
    notes.push(received ? `exchanged for ${trimWhitespace(received)}` : 'disclosed as an exchange');
  }

  if (rate && matures) notes.push(`coupon ${normalizeRate(rate)}, matures ${matures}`);
  else if (rate) notes.push(`coupon ${normalizeRate(rate)}`);
  else if (matures) notes.push(`matures ${matures}`);

  const cleaned = cleanAssetString(str, ticker);
  // Never trade a usable name for a note: if the shared cleaner rejects what is
  // left, fall back to the original row untouched.
  if (!cleaned) return { name: cleanAssetString(name, ticker), note: null };

  return { name: cleaned, note: notes.length ? notes.join('; ') : null };
}

export function cleanFilerName(name: string | null | undefined): string {
  if (!name) return '';
  let str = name.trim();

  // Strip standalone honorifics and professional titles wherever a source
  // embedded them in the member's name (for example, "Richard Dean Dr
  // McCormick" or "Neal Patrick MD, Facs Dunn"). Do not match substrings in
  // ordinary names such as Drake or Senatorial.
  str = str.replace(
    /(?:,\s*)?\b(?:DR|HON|MR|MRS|MS|REP|SEN|MD|FACS|PH\.?D\.?)\b(?:,\s*)?/gi,
    ' ',
  );
  
  // Strip "(Senator)" or ", Senator"
  str = str.replace(/\s*\(Senator\)\s*/gi, ' ');
  str = str.replace(/,\s*Senator\b/gi, ' ');

  // If it's formatted as "Last, First" (e.g. "Boozman, John" or "McCormick, David H.")
  if (/^[A-Za-z\-]+,\s*[A-Za-z\s.\-]+$/.test(str)) {
    const parts = str.split(',');
    str = parts[1].trim() + ' ' + parts[0].trim();
  }

  // Title case if the string is primarily ALL CAPS.
  const upperCount = (str.match(/[A-Z]/g) || []).length;
  const lowerCount = (str.match(/[a-z]/g) || []).length;
  if (upperCount > 0 && upperCount > lowerCount * 2) {
    str = str.toLowerCase().replace(/(^|\s|-|\.)\w/g, (c) => c.toUpperCase());
  }

  // Clean up any trailing commas, spaces, or stray periods
  str = str.replace(/[,\s.]+$/, '');
  str = str.replace(/\s{2,}/g, ' ');

  // Curated legal → preferred renames (e.g. Rohit Khanna → Ro Khanna).
  // Applied last so "Khanna, Rohit" is already flipped to "Rohit Khanna".
  str = applyMemberNameAlias(str.trim());

  return str.trim();
}

export function simplifyCompanyName(name: string): string {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/[^\w\s]/g, '') // remove punctuation
    .replace(/\b(inc|corp|corporation|llc|plc|ltd|company|co)\b/g, '') // remove common suffixes
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fund/ETF descriptor tokens with no issuer identity (stripped for ticker↔name checks). */
const FUND_DESCRIPTOR_STOP = new Set([
  'etf',
  'fund',
  'index',
  'shares',
  'share',
  'trust',
  'admiral',
  'investor',
  'institutional',
  'portfolio',
  'portfolios',
  'receipt',
  'receipts',
  'depository',
  'registered',
  'open',
  'end',
  'mutual',
  'exchange',
  'traded',
  'advisor',
  'advisors',
  'ultra',
  'pro',
  'ultrapro',
  'ultrashort',
  'class',
  'series',
  'select',
  'cmn',
  'lp',
  'llp',
]);

function stripFundDescriptorTokens(simplified: string): string {
  if (!simplified) return '';
  return simplified
    .split(/\s+/)
    .filter((token) => token && !FUND_DESCRIPTOR_STOP.has(token))
    .join(' ');
}

/**
 * True when two simplified company names plausibly refer to the same security.
 * Tolerates ETF/fund wording differences (Index/Fund/ETF/Shares, etc.) while
 * still rejecting unrelated issuers (e.g. AAPL ticker with "Microsoft Corp").
 */
export function namesPlausiblyMatch(a: string, b: string): boolean {
  if (!a || !b) return true;

  const as = stripFundDescriptorTokens(a);
  const bs = stripFundDescriptorTokens(b);
  if (!as || !bs) return true;

  if (as === bs || as.includes(bs) || bs.includes(as)) return true;

  const at = as.split(/\s+/).filter(Boolean);
  const bt = bs.split(/\s+/).filter(Boolean);
  const [shorter, longer] = at.length <= bt.length ? [at, bt] : [bt, at];
  if (shorter.length === 0) return true;

  const longerSet = new Set(longer);
  if (!shorter.every((token) => longerSet.has(token))) return false;

  const significant = shorter.filter((token) => token.length >= 3);
  return significant.length >= 2 || (significant.length === 1 && shorter.length === 1);
}
