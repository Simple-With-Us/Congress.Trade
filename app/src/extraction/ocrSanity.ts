/**
 * src/extraction/ocrSanity.ts
 *
 * Shared OCR-garbage guards for every transactions write boundary.  The Sep 17
 * Trump 278-T landed 517 hand-confirmed rows with OCR typos baked into
 * asset_name ("Uber Technolo1des Inc.", "SETTlMT", "Unsec\\iRED", embedded
 * "07/lS/2031"), because no boundary validated names or dates for OCR damage.
 *
 * Three pure, I/O-free checks live here so the admin review path, the machine
 * extraction path (scoreFields/buildTransaction, shared by normalize() and
 * the agreement cascade), and the OGE text extractor all enforce the same
 * contract:
 *   1. validateTxDate: strict real-calendar YYYY-MM-DD plus a sane range.
 *   2. normalizeEmbeddedOcrDates: date-like tokens inside descriptions are
 *      fixed only when exactly one interpretation is valid, else held.
 *   3. normalizeOcrAssetName: conservative name fixes (stray backslashes,
 *      lowercase l in all-caps words, "Duo" before a maturity date, rate
 *      letters, known-issuer fuzzy matches), else held for review.
 *
 * A fix is applied only when confident.  Anything else is reported through
 * hold reasons, never silently saved.  Legit names ("3M Co", "S&P 500",
 * CUSIPs, "Series 2021A", rates like "5.25%") must pass through untouched.
 */

/** How far back a trade date may sit relative to the filing date. */
export const OCR_TX_DATE_LOOKBACK_DAYS = 730;
/** Absolute floor when no filing date is known (STOCK Act era). */
export const OCR_TX_DATE_ABSOLUTE_FLOOR = '1990-01-01';

// ---------------------------------------------------------------------------
// Strict calendar dates.
// ---------------------------------------------------------------------------

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

/** Strict YYYY-MM-DD shape plus a real calendar date, leap years included. */
export function isValidCalendarDateYMD(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  return true;
}

function addDaysYMD(iso: string, delta: number): string {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const shifted = new Date(Date.UTC(year, month - 1, day + delta));
  return shifted.toISOString().slice(0, 10);
}

export type TxDateRejectCode =
  | 'bad_tx_date'
  | 'future_tx_date'
  | 'tx_date_too_old';

export type TxDateCheck =
  | { ok: true; iso: string }
  | { ok: false; code: TxDateRejectCode; message: string };

/**
 * Validate one transaction date.  Rejects impossible dates, future dates, and
 * dates older than the filing date minus the lookback (or the absolute floor
 * when no filing date is known).  String comparison is safe: all values are
 * zero-padded ISO.  A trade AFTER the filing date is deliberately NOT
 * rejected here: the repo's tested rule publishes after-filed trades with a
 * soft penalty (signature-stamp skew plus amendment fixtures), so the upper
 * bound stays soft in scoreFields and open on the admin path.
 */
export function validateTxDate(
  txDate: string | null | undefined,
  opts: { filedDate?: string | null; today?: string } = {},
): TxDateCheck {
  const raw = (txDate ?? '').trim();
  if (!isValidCalendarDateYMD(raw)) {
    return {
      ok: false,
      code: 'bad_tx_date',
      message: `must be a real calendar date in YYYY-MM-DD format (got '${raw || '(blank)'}')`,
    };
  }
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  if (raw > today) {
    return {
      ok: false,
      code: 'future_tx_date',
      message: `must not be in the future (got '${raw}')`,
    };
  }
  const filed = (opts.filedDate ?? '').trim();
  if (filed && isValidCalendarDateYMD(filed)) {
    if (raw < addDaysYMD(filed, -OCR_TX_DATE_LOOKBACK_DAYS)) {
      return {
        ok: false,
        code: 'tx_date_too_old',
        message: `is more than 2 years before the filing date '${filed}'`,
      };
    }
  } else if (raw < OCR_TX_DATE_ABSOLUTE_FLOOR) {
    return {
      ok: false,
      code: 'tx_date_too_old',
      message: `is implausibly old (before '${OCR_TX_DATE_ABSOLUTE_FLOOR}')`,
    };
  }
  return { ok: true, iso: raw };
}

// ---------------------------------------------------------------------------
// Dates embedded in asset descriptions.
// ---------------------------------------------------------------------------

/** Single-character OCR confusions, applied ONLY inside date-like tokens. */
const OCR_DATE_CHAR_FIXES: Record<string, string> = {
  l: '1',
  I: '1',
  '|': '1',
  S: '5',
  O: '0',
  o: '0',
  B: '8',
};

function applyDateCharFixes(token: string): string {
  return token.replace(/[lI|SOoB]/g, (ch) => OCR_DATE_CHAR_FIXES[ch] ?? ch);
}

function isRealMonthDayYear(month: number, day: number, year: number): boolean {
  if (!Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(year)) return false;
  if (year < 1900 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

interface DateCandidate {
  month: number;
  day: number;
  year: number;
  fixed: string;
}

/**
 * Try to read one date-like token ("07/lS/2031", "8/1012026", "02/30/2026").
 * Returns the fix only when EXACTLY ONE interpretation yields a real calendar
 * date; ambiguity ("11/112026" could be 11/1 or 1/11 with a glued slash) and
 * impossibility ("02/30/2026", month 13) both return null so the caller holds
 * the row instead of guessing.
 */
export function fixOcrDateToken(token: string): { iso: string; fixed: string } | null {
  const trimmed = token.trim();
  if (!trimmed || trimmed.length > 12) return null;
  const candidates: DateCandidate[] = [];
  const slashCount = (trimmed.match(/\//g) ?? []).length;

  // Interpretation 1: direct M/D/Y with confusable characters mapped.
  if (slashCount === 2) {
    const parts = trimmed.split('/');
    if (parts.length === 3) {
      const [rawM, rawD, rawY] = parts;
      const m = applyDateCharFixes(rawM);
      const d = applyDateCharFixes(rawD);
      const y = applyDateCharFixes(rawY);
      if (/^\d{1,2}$/.test(m) && /^\d{1,2}$/.test(d) && (/^\d{4}$/.test(y) || /^\d{2}$/.test(y))) {
        const year = y.length === 2 ? 2000 + Number(y) : Number(y);
        const month = Number(m);
        const day = Number(d);
        if (isRealMonthDayYear(month, day, year)) {
          candidates.push({ month, day, year, fixed: `${m}/${d}/${y}` });
        }
      }
    }
  }

  // Interpretation 2: a "/" misread as "1" ("8/1012026" -> "8/10/2026").
  if (slashCount === 1) {
    const glued = /^(\d{1,2})\/(\d{1,2})1(\d{4})$/.exec(trimmed);
    if (glued) {
      const month = Number(glued[1]);
      const day = Number(glued[2]);
      const year = Number(glued[3]);
      if (isRealMonthDayYear(month, day, year)) {
        candidates.push({ month, day, year, fixed: `${glued[1]}/${glued[2]}/${glued[3]}` });
      }
    }
    // Interpretation 3: a missing slash ("8/102026" -> "8/10/2026").
    const missing = /^(\d{1,2})\/(\d{2})(\d{4})$/.exec(trimmed);
    if (missing) {
      const month = Number(missing[1]);
      const day = Number(missing[2]);
      const year = Number(missing[3]);
      if (isRealMonthDayYear(month, day, year)) {
        candidates.push({ month, day, year, fixed: `${missing[1]}/${missing[2]}/${missing[3]}` });
      }
    }
    // Interpretation 4: a missing FIRST slash ("717/2026" -> "7/17/2026").
    const missingFirst = /^(\d{3,4})\/(\d{4})$/.exec(trimmed);
    if (missingFirst) {
      const head = missingFirst[1];
      const year = Number(missingFirst[2]);
      const splits: Array<[string, string]> = head.length === 3
        ? [[head.slice(0, 1), head.slice(1)]]
        : [[head.slice(0, 1), head.slice(1, 3)], [head.slice(0, 2), head.slice(2)]];
      for (const [ms, ds] of splits) {
        const month = Number(ms);
        const day = Number(ds);
        if (isRealMonthDayYear(month, day, year)) {
          candidates.push({ month, day, year, fixed: `${ms}/${ds}/${missingFirst[2]}` });
        }
      }
    }
    // Interpretation 5: month/year ("08/2030"), confusables mapped.  A clean
    // MM/YYYY is a complete reading, not garble, so it must validate (and
    // therefore never hold).  The iso pins day 01 as a month-precision
    // placeholder; only `fixed` is ever written back into the name.
    const monthYear = /^([\dlI|SOoB]{1,2})\/([\dlI|SOoB]{4})$/.exec(trimmed);
    if (monthYear) {
      const m = applyDateCharFixes(monthYear[1]);
      const y = applyDateCharFixes(monthYear[2]);
      if (/^\d{1,2}$/.test(m) && /^\d{4}$/.test(y)) {
        const month = Number(m);
        const year = Number(y);
        if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12) {
          candidates.push({ month, day: 1, year, fixed: `${m}/${y}` });
        }
      }
    }
  }

  // Deduplicate identical readings, then require uniqueness.
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const key = `${c.month}/${c.day}/${c.year}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length !== 1) return null;
  const winner = unique[0];
  const iso = `${String(winner.year).padStart(4, '0')}-${String(winner.month).padStart(2, '0')}-${String(winner.day).padStart(2, '0')}`;
  return { iso, fixed: winner.fixed };
}

/** Two slashes (M/D/Y shape) or one slash with a glued digit run. */
const DATE_SHAPED_TOKEN_RE = /^\S{1,4}\/\S{1,8}\/\S{2,5}$|^\d{1,3}\/\d{4,8}$/;

const MONTH_NAMES = new Set([
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april',
  'may', 'jun', 'june', 'jul', 'july', 'aug', 'august', 'sep', 'sept',
  'september', 'oct', 'october', 'nov', 'november', 'dec', 'december',
]);

/** "Due <Mon> <D> <YYYY>" window, tolerating the OCR "Duo" spelling. */
const DUE_MONTH_WINDOW_RE = /\b[Dd][Uu][Ooe]\s+([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/g;

export interface EmbeddedDatesResult {
  text: string;
  changed: boolean;
  notes: string[];
  holdReasons: string[];
}

/**
 * Normalize date-like tokens inside a description.  Clean dates pass through
 * untouched; a token with exactly one valid reading is fixed; a date-shaped
 * token with no valid reading (impossible date, unmapped garble) holds the
 * row.  Non-date tokens ("DB 8/E", "5.00 %", CUSIPs) are never touched.
 */
export function normalizeEmbeddedOcrDates(input: string): EmbeddedDatesResult {
  const notes: string[] = [];
  const holdReasons: string[] = [];
  if (!input) return { text: input, changed: false, notes, holdReasons };
  let text = input;

  const tokens = input.match(/[^\s,;()"]*\/[^\s,;()"]*/g) ?? [];
  const seenTokens = new Set<string>();
  for (const rawToken of tokens) {
    const token = rawToken.replace(/^[("']+|[)"'.%]+$/g, '');
    if (!token || seenTokens.has(token)) continue;
    seenTokens.add(token);
    if (!DATE_SHAPED_TOKEN_RE.test(token)) continue;
    const fix = fixOcrDateToken(token);
    if (fix && fix.fixed !== token) {
      text = text.split(token).join(fix.fixed);
      notes.push(`fixed embedded date '${token}' to '${fix.fixed}'`);
    } else if (!fix) {
      holdReasons.push(`unreadable embedded date '${token}'`);
    }
  }

  DUE_MONTH_WINDOW_RE.lastIndex = 0;
  let window: RegExpExecArray | null;
  const seenMonths = new Set<string>();
  while ((window = DUE_MONTH_WINDOW_RE.exec(input)) !== null) {
    const word = window[1];
    const key = word.toLowerCase();
    if (MONTH_NAMES.has(key) || seenMonths.has(key)) continue;
    seenMonths.add(key);
    const day = Number(window[2]);
    const year = Number(window[3]);
    if (day >= 1 && day <= 31 && year >= 1900 && year <= 2100) {
      holdReasons.push(`unreadable month '${word}' in maturity date`);
    }
  }
  return { text, changed: text !== input, notes, holdReasons };
}

// ---------------------------------------------------------------------------
// Asset-name OCR normalization.
// ---------------------------------------------------------------------------

/**
 * Curated canonical issuer names for whole-name fuzzy matching.  The machine
 * path additionally consults securities_ref names (via nameIndex values) for
 * word-level evidence; the admin path is synchronous and uses this list only.
 * Every entry must be a full canonical name WITH its suffix, since a match
 * replaces the whole stored string.
 */
export const OCR_KNOWN_ISSUERS: readonly string[] = [
  'Uber Technologies Inc.',
  'L3Harris Technologies Inc.',
  'Amazon.com, Inc.',
  'StepStone Group Inc.',
  'Blackstone Mortgage Trust Inc.',
  'Apple Inc.',
  'Microsoft Corporation',
  'NVIDIA Corporation',
  'Alphabet Inc.',
  'Meta Platforms Inc.',
  'Tesla Inc.',
  'Berkshire Hathaway Inc.',
  'Eli Lilly and Company',
  'JPMorgan Chase & Co.',
  'Visa Inc.',
  'Exxon Mobil Corporation',
  'Johnson & Johnson',
  'UnitedHealth Group Incorporated',
  'Mastercard Incorporated',
  'Procter & Gamble Company',
  'Home Depot Inc.',
  'Costco Wholesale Corporation',
  'Broadcom Inc.',
  'Netflix Inc.',
  'Salesforce Inc.',
  'American Express Company',
  'Bank of America Corporation',
  'Coca-Cola Company',
  'Walmart Inc.',
  'Chevron Corporation',
  'Oracle Corporation',
  'Cisco Systems Inc.',
  'Wells Fargo & Company',
  'Morgan Stanley',
  'Goldman Sachs Group Inc.',
  '3M Company',
  'Intel Corporation',
  'Pfizer Inc.',
  'Merck & Co. Inc.',
  'Adobe Inc.',
  'Advanced Micro Devices Inc.',
  'QUALCOMM Incorporated',
  'Texas Instruments Incorporated',
  'Honeywell International Inc.',
  'Boeing Company',
  'Lockheed Martin Corporation',
  'General Electric Company',
  'Ford Motor Company',
  'General Motors Company',
  'Blackstone Inc.',
];

/** Legit alphanumeric company tokens that must never count as digit garble. */
const KNOWN_ALNUM_WORDS = new Set([
  'l3harris',
  'b2gold',
  'e2open',
  'o2micro',
  '3m',
  '8x8',
]);

function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Levenshtein distance with an early exit above `cap`. */
function levenshteinCapped(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  if (a === b) return 0;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > cap) return cap + 1;
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length];
}

export interface IssuerMatch {
  canonical: string;
  distance: number;
}

/**
 * Match a whole garbled name against the curated issuer list.  Returns a hit
 * only when the best candidate is within distance 2 AND strictly unique, so a
 * name sitting between two known issuers is held rather than guessed.
 */
export function matchKnownIssuer(name: string): IssuerMatch | null {
  const norm = normalizeForCompare(name);
  if (norm.length < 4) return null;
  let best: { canonical: string; distance: number } | null = null;
  let secondBest = Number.POSITIVE_INFINITY;
  for (const candidate of OCR_KNOWN_ISSUERS) {
    const distance = levenshteinCapped(norm, normalizeForCompare(candidate), 2);
    if (distance > 2) continue;
    if (!best || distance < best.distance) {
      if (best) secondBest = Math.min(secondBest, best.distance);
      best = { canonical: candidate, distance };
    } else if (distance < secondBest) {
      secondBest = distance;
    }
  }
  if (!best || best.distance > 2 || secondBest <= best.distance) return null;
  return best;
}

/** Long words from the curated list, for word-level fuzzy repair. */
const KNOWN_WORDS: ReadonlySet<string> = (() => {
  const words = new Set<string>();
  for (const issuer of OCR_KNOWN_ISSUERS) {
    for (const word of normalizeForCompare(issuer).split(' ')) {
      if (word.length >= 6) words.add(word);
    }
  }
  return words;
})();

/**
 * Merged word pools, memoized per extras set.  The machine path passes the
 * same securities_ref-derived set for every row of a filing, so without this
 * each garbled row would rebuild a ~10k-entry set on the hot ingest path.
 */
const mergedPoolCache = new WeakMap<ReadonlySet<string>, ReadonlySet<string>>();

function wordPoolFor(extra: ReadonlySet<string> | undefined): ReadonlySet<string> {
  if (!extra) return KNOWN_WORDS;
  let merged = mergedPoolCache.get(extra);
  if (!merged) {
    merged = new Set([...KNOWN_WORDS, ...extra]);
    mergedPoolCache.set(extra, merged);
  }
  return merged;
}

/**
 * Derive matchable words from extra known names (securities_ref company
 * names in the machine path).  Callers with many rows derive this ONCE and
 * pass the set down, so per-row work stays proportional to the row.
 */
export function issuerWords(names: Iterable<string>): Set<string> {
  const words = new Set<string>();
  for (const name of names) {
    for (const word of normalizeForCompare(name).split(' ')) {
      if (word.length >= 4) words.add(word);
    }
  }
  return words;
}

/** CUSIP (9-char) and ISIN (12-char) shapes are never digit garble. */
function looksLikeSecurityId(word: string): boolean {
  if (/^[A-Z0-9]{9}$/.test(word) && /[A-Z]/.test(word) && /\d/.test(word)) return true;
  return /^[A-Z]{2}[A-Z0-9]{10}$/.test(word);
}

/**
 * Words that look like OCR digit garble: start with a letter, at least 6
 * alphanumerics, a digit with a letter after it.  Short tokens ("3M", "500",
 * "2021A", "5.25%"), leading-digit tokens, CUSIPs, and allowlisted company
 * tokens never trigger.
 */
function digitGarbleWords(name: string): string[] {
  const hits: string[] = [];
  for (const word of name.split(/[^A-Za-z0-9]+/)) {
    if (!/^[A-Za-z][A-Za-z0-9]{5,}$/.test(word)) continue;
    if (!/\d/.test(word) || !/[0-9][A-Za-z]/.test(word)) continue;
    if (KNOWN_ALNUM_WORDS.has(word.toLowerCase())) continue;
    if (looksLikeSecurityId(word)) continue;
    hits.push(word);
  }
  return hits;
}

/** Lowercase l inside an otherwise all-caps word ("SETTlMT", "BLACKSlONE"). */
const CAPS_L_WORD_RE = /\b(?=[A-Z0-9l]*l)(?=(?:[A-Z0-9]*[A-Z]){2,})[A-Z0-9l]{4,}\b/;
const CAPS_L_WORD_GLOBAL_RE = new RegExp(CAPS_L_WORD_RE.source, 'g');

function capsLWords(name: string): string[] {
  return name.match(CAPS_L_WORD_GLOBAL_RE) ?? [];
}

/** Characters no legit asset name contains.  Colons inside known "Label:" tokens are exempt. */
const KNOWN_LABEL_TOKEN_RE = /\b(?:Rate\/Coupon|Matures|CUSIP|ISIN)\s*:/gi;
const SUSPICIOUS_CHAR_RE = /[<>|~^*`{};:"]|::/;

function suspiciousChars(name: string): string[] {
  const stripped = name.replace(KNOWN_LABEL_TOKEN_RE, '');
  const hits: string[] = [];
  const seen = new Set<string>();
  const matches = stripped.match(new RegExp(SUSPICIOUS_CHAR_RE.source, 'g')) ?? [];
  for (const ch of matches) {
    if (seen.has(ch)) continue;
    seen.add(ch);
    hits.push(ch);
  }
  return hits;
}

function hasStrayBackslash(name: string): boolean {
  return /(?<=\w)\\(?=\w)/.test(name);
}

/** Human-readable trigger descriptions for hold messages. */
export function ocrTriggers(name: string, extraKnownWords?: ReadonlySet<string>): string[] {
  const triggers: string[] = [];
  if (!name || !name.trim()) return triggers;
  if (hasStrayBackslash(name)) triggers.push('stray backslash inside a word');
  for (const word of capsLWords(name)) {
    triggers.push(`lowercase l in all-caps word '${word}'`);
  }
  for (const word of digitGarbleWords(name)) {
    // An exact known word is evidence the token is real, not garbled.
    if (KNOWN_WORDS.has(word.toLowerCase())) continue;
    if (extraKnownWords?.has(word.toLowerCase())) continue;
    triggers.push(`mid-word digit in '${word}'`);
  }
  for (const ch of suspiciousChars(name)) {
    triggers.push(`suspicious character '${ch}'`);
  }
  return triggers;
}

/**
 * "Duo <word> <day> <year>" is always a misread "Due" maturity, even when the
 * month word itself is garbled ("Duo Sao 1 2028") — the month hold still fires
 * separately, so widening this can only improve the partial fix.
 */
const DUO_BEFORE_DATE_RE = /\b(Duo|DUO|duo)(?=\s+[A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/g;

/** A letter where a rate digit belongs ("0S.350%" -> "05.350%"). */
const RATE_LETTER_RE = /\b(\d)([SsOo])(\.\d+%?)/g;

const BACKSLASH_BETWEEN_WORD_CHARS_RE = /(?<=\w)\\(?=\w)/g;

function matchWordCase(template: string, word: string): string {
  if (template === template.toUpperCase()) return word.toUpperCase();
  return word.slice(0, 1).toUpperCase() + word.slice(1);
}

export interface OcrNameResult {
  name: string;
  changed: boolean;
  notes: string[];
  nameHolds: string[];
  dateHolds: string[];
}

export interface OcrNameOptions {
  /**
   * Extra known words (derived once from securities_ref company names in the
   * machine path via issuerWords).  Used for word-level evidence only, never
   * whole-name replacement, because reference names may be simplified.
   */
  extraKnownWords?: ReadonlySet<string>;
}

/**
 * Normalize one asset name conservatively.  Whole-name issuer matches replace
 * the string; character rules fix backslashes, caps-l, "Duo", and rate
 * letters; word-level repair fixes single garbled long words.  Remaining
 * triggers become holds.  Returns the input unchanged when nothing applies.
 */
export function normalizeOcrAssetName(input: string, opts: OcrNameOptions = {}): OcrNameResult {
  const notes: string[] = [];
  const nameHolds: string[] = [];
  const dateHolds: string[] = [];
  if (!input || !input.trim()) {
    return { name: input, changed: false, notes, nameHolds, dateHolds };
  }
  let text = input;

  // 1. Embedded dates first, so later word rules see the repaired tokens.
  const dates = normalizeEmbeddedOcrDates(text);
  text = dates.text;
  notes.push(...dates.notes);
  dateHolds.push(...dates.holdReasons);

  // 2. Whole-name fuzzy match, gated on an OCR trigger being present.
  const triggers = ocrTriggers(text, opts.extraKnownWords);
  if (triggers.length > 0) {
    const hit = matchKnownIssuer(text);
    if (hit && hit.distance > 0) {
      notes.push(`matched known issuer '${hit.canonical}'`);
      return { name: hit.canonical, changed: true, notes, nameHolds, dateHolds };
    }
  }

  // 3. Character-level fixes.
  DUO_BEFORE_DATE_RE.lastIndex = 0;
  const duoFixed = text.replace(DUO_BEFORE_DATE_RE, (_m, word: string) => {
    if (word === 'DUO') return 'DUE';
    if (word === 'duo') return 'due';
    return 'Due';
  });
  if (duoFixed !== text) {
    notes.push("fixed OCR 'Duo' to 'Due' before a maturity date");
    text = duoFixed;
  }
  RATE_LETTER_RE.lastIndex = 0;
  const rateFixed = text.replace(RATE_LETTER_RE, (_m, lead: string, letter: string, rest: string) => {
    const digit = letter.toLowerCase() === 's' ? '5' : '0';
    return `${lead}${digit}${rest}`;
  });
  if (rateFixed !== text) {
    notes.push('fixed OCR letter in coupon rate');
    text = rateFixed;
  }
  const touchedByBackslash = new Set<string>();
  if (hasStrayBackslash(text)) {
    const before = text;
    text = text.replace(BACKSLASH_BETWEEN_WORD_CHARS_RE, '');
    if (text !== before) {
      notes.push('removed stray backslash inside a word');
      for (const word of text.split(/[^A-Za-z0-9]+/)) {
        if (word.length >= 4 && /[a-z][A-Z]/.test(word)) touchedByBackslash.add(word);
      }
    }
  }
  CAPS_L_WORD_GLOBAL_RE.lastIndex = 0;
  const capsFixed = text.replace(CAPS_L_WORD_GLOBAL_RE, (word) => word.replace(/l/g, 'L'));
  const touchedByCapsFix = new Set<string>();
  if (capsFixed !== text) {
    notes.push('uppercased stray lowercase l in all-caps word');
    for (const word of capsFixed.split(/[^A-Za-z0-9]+/)) {
      if (word.length >= 4 && /^[A-Z0-9]+$/.test(word)) touchedByCapsFix.add(word);
    }
    text = capsFixed;
  }

  // 4. Word-level repair for still-triggering (or just-touched) long words.
  const triggeredWords = new Set(digitGarbleWords(text).map((w) => w.toLowerCase()));
  const candidates = new Set<string>();
  for (const word of text.split(/[^A-Za-z0-9]+/)) {
    if (word.length < 6) continue;
    const lower = word.toLowerCase();
    if (triggeredWords.has(lower) || touchedByCapsFix.has(word)) candidates.add(word);
  }
  const wordPool: ReadonlySet<string> = candidates.size > 0
    ? wordPoolFor(opts.extraKnownWords)
    : KNOWN_WORDS;
  for (const word of candidates) {
    const lower = word.toLowerCase();
    if (wordPool.has(lower)) continue;
    let best: { word: string; distance: number } | null = null;
    let secondBest = Number.POSITIVE_INFINITY;
    for (const known of wordPool) {
      const distance = levenshteinCapped(lower, known, 2);
      if (distance === 0 || distance > 2) continue;
      if (!best || distance < best.distance) {
        if (best) secondBest = Math.min(secondBest, best.distance);
        best = { word: known, distance };
      } else if (distance < secondBest) {
        secondBest = distance;
      }
    }
    if (best && secondBest > best.distance) {
      const replacement = matchWordCase(word, best.word);
      text = text.replace(word, replacement);
      notes.push(`matched known word '${replacement}'`);
      touchedByCapsFix.delete(word);
    }
  }

  // 5. Anything still triggering is held, never silently saved.  A caps fix
  // that left a clean all-caps token (e.g. SETTLMT) no longer triggers, so
  // only genuinely unresolved garble lands here.
  for (const trigger of ocrTriggers(text, opts.extraKnownWords)) {
    nameHolds.push(trigger);
  }
  for (const word of touchedByBackslash) {
    if (text.includes(word)) {
      nameHolds.push(`unreadable word '${word}' after backslash removal`);
    }
  }
  return { name: text, changed: text !== input, notes, nameHolds, dateHolds };
}
