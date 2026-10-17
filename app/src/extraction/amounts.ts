/**
 * src/extraction/amounts.ts
 * OWNER: extraction agent
 *
 * Amount-range parsing shared by the HTML / text-PDF extractors and the
 * normalizer. STOCK Act PTRs disclose value as a bracket string such as
 * "$1,001 - $15,000" or "$50,000,001 +", or as an exact dollar amount under
 * $1,001 (e.g. "$456.00") which snaps onto the product $0–$1,000 tier. This
 * converts such strings to a numeric [min, max] pair and snaps it onto the
 * canonical bracket set in src/shared/brackets.ts when possible.
 */

import { matchBracket, nearestBracket, STOCK_ACT_BRACKETS } from '../shared/brackets.ts';
import type { AmountBracket } from '../shared/brackets.ts';

/**
 * Horizontal spaces OCR inserts inside a thousand group. Newlines stay out so
 * a flattened row break is not treated as a grouping space by itself; callers
 * that already collapsed whitespace to ` ` still match the ASCII space.
 */
const HS = String.raw`[ \u00A0\u2007\u2009\u202F]`;

/**
 * One dollar amount without the leading `$`.
 * Spaced thousands (`15 001`, `1 000 001`), period-thousands (`15.001`,
 * `1.000.001`), comma thousands, or a real 1–2 digit decimal (`456.00`).
 * At most two thousand-groups: STOCK Act tops out at $50,000,001, and a
 * third spaced group on a flattened 278-T is the next row number.
 */
export const OCR_AMOUNT_TOKEN_SRC =
  String.raw`\d{1,3}(?:` +
  HS +
  String.raw`*[.,]` +
  HS +
  String.raw`*\d{3}(?!\d)|` +
  HS +
  String.raw`+\d{3}(?!\d)){1,2}(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?`;

const RANGE_SEP = String.raw`(?:-|–|—|−|•|·|to|through|\.(?=\s*\$))`;

export interface AmountRange {
  /** Lower bound in whole USD, or null when unparseable. */
  min: number | null;
  /** Upper bound in whole USD; null for the open-ended top tier OR unparseable. */
  max: number | null;
  /** True when [min,max] is exactly a canonical STOCK Act bracket. */
  exact: boolean;
  /**
   * True when the bracket was INFERRED by snapping an approximate read onto a
   * canonical bracket, rather than matching one the document actually printed.
   *
   * `exact` alone cannot carry this: a snapped bracket is byte-identical to a
   * printed one, so callers had no way to tell "$1,000" (a checkbox band read
   * with its legend illegible, repaired to 1001-15000) from "$1,001 - $15,000"
   * printed on the form. That is a plausible wrong number indistinguishable
   * from a correct read, which is what CT-2415 Guard 2 refuses. Absent means
   * the bracket was matched verbatim (or the amount is unparseable).
   */
  snapped?: boolean;
}

/**
 * Collapse OCR thousand-grouping in one amount token.
 * Spaces between digit groups, and periods that introduce a group of exactly
 * 3 digits, are separators. A trailing period plus 1–2 digits stays a decimal
 * (`$456.00` → `456.00`, not `45600`).
 */
export function normalizeOcrAmountToken(token: string): string | null {
  let t = token.replace(/[^\d.,\s\u00A0\u2007\u2009\u202F]/g, '').trim();
  if (!t) return null;
  t = t.replace(/[ \u00A0\u2007\u2009\u202F]*([.,])[ \u00A0\u2007\u2009\u202F]*/g, '$1');
  t = t.replace(/[ \u00A0\u2007\u2009\u202F]+/g, ' ');

  const cents = t.match(/^(\d{1,3}(?:[ ,.]\d{3})*|\d+)\.(\d{1,2})$/);
  if (cents) {
    return `${cents[1].replace(/[ ,.]/g, '')}.${cents[2]}`;
  }
  if (/^\d{1,3}(?:[ ,.]\d{3})+$/.test(t)) {
    return t.replace(/[ ,.]/g, '');
  }
  if (/^\d[\d,]*$/.test(t)) return t.replace(/,/g, '');

  const cleaned = t.replace(/[^\d.]/g, '');
  if (!cleaned || !/^\d+(\.\d+)?$/.test(cleaned)) return null;
  return cleaned;
}

/** Parse a single dollar token like "$1,001" / "15 001" / "$15.001" / "$456.00". */
function parseDollar(token: string): number | null {
  const cleaned = normalizeOcrAmountToken(token);
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Parse a STOCK Act amount-range string into a numeric [min,max] pair.
 *
 * Handles:
 *   "$1,001 - $15,000"          -> { min:1001,  max:15000 }
 *   "$1,001 to $15,000"         -> { min:1001,  max:15000 }
 *   "$1,001–$15,000" (en dash)  -> { min:1001,  max:15000 }
 *   "$50,000,001 +"             -> { min:50000001, max:null } (open top tier)
 *   "Over $50,000,000"          -> snaps to open top tier
 *   ""/garbage                  -> { min:null, max:null }
 */
export function parseAmountRange(raw: string): AmountRange {
  const text = (raw || '').trim();
  if (!text) return { min: null, max: null, exact: false };

  // Prefer dollar-amount range tokens embedded in freeform OCR / PTR raw lines.
  // Full-line split-on-hyphen is unsafe: dates like "12/1/27" and CUSIPs produce
  // false "exact" brackets and false invalid_amount flags downstream.
  const embedded = extractEmbeddedDollarRanges(text);
  if (embedded) return embedded;

  // Open-ended top tier: "$50,000,001 +" / "$50,000,000+" / "Over $X".
  if (/\+\s*$/.test(text) || /\bover\b/i.test(text) || /\bgreater than\b/i.test(text)) {
    const nums = [...text.matchAll(new RegExp(OCR_AMOUNT_TOKEN_SRC, 'g'))]
      .map((m) => parseDollar(m[0]))
      .filter(isNum);
    const lo = nums.length ? Math.min(...nums) : null;
    if (lo !== null) {
      const snapped = snapToBracket(lo, null);
      return {
        min: snapped?.min ?? lo,
        max: snapped?.max ?? null,
        exact: snapped !== null,
        snapped: snapped !== null,
      };
    }
  }

  // Split on the range separator (hyphen, en/em dash, or the word "to") only for
  // short, amount-shaped strings (not multi-field PTR raw lines).
  if (text.length <= 64 && /\$|^\d/.test(text)) {
    const parts = text
      .split(/\s*(?:-|–|—|−|•|·|to|through)\s*/i)
      .map((p) => p.trim())
      .filter(Boolean);

    if (parts.length >= 2) {
      const lo = parseDollar(parts[0]);
      const hi = parseDollar(parts[parts.length - 1]);
      if (lo !== null && hi !== null) {
        const exactB = matchBracket(lo, hi);
        if (exactB) return { min: exactB.min, max: exactB.max, exact: true };
        const snapped = snapToBracket(lo, hi);
        if (snapped) return { min: snapped.min, max: snapped.max, exact: true, snapped: true };
        return { min: lo, max: hi, exact: false };
      }
    }
  }

  // Single value present — try to find the bracket whose min matches.
  // The whole string must look like an amount.  Stripping digits out of
  // "BDT Capital Partners Fund 4 LP" / "Oswego Ill Go BDS 2016" used to
  // yield exact $4 / $2016 and false invalid_amount against a real bracket
  // (prod H-2025-8221302, 2026-08-21).
  const looksLikeAmount = new RegExp(
    `^\\$?\\s*(?:${OCR_AMOUNT_TOKEN_SRC})\\s*$`,
  ).test(text);
  const single = looksLikeAmount ? parseDollar(text) : null;
  if (single !== null && text.length <= 32) {
    const byMin = STOCK_ACT_BRACKETS.find((b: AmountBracket) => b.min === single);
    if (byMin) return { min: byMin.min, max: byMin.max, exact: true };
    const snapped = snapToBracket(single, single);
    if (snapped) return { min: snapped.min, max: snapped.max, exact: true, snapped: true };
    return { min: single, max: null, exact: false };
  }

  return { min: null, max: null, exact: false };
}

/**
 * Find `$1,001 - $15,000` (or open top-tier) style tokens inside a longer line.
 * Returns the last exact canonical match when several appear (PTR rows put the
 * amount near the end after dates / asset text).
 */
function extractEmbeddedDollarRanges(text: string): AmountRange | null {
  // Open top tier with a dollar sign nearby. Separators may be a comma, a
  // period, or an OCR space (`$50 000 001 +`, `$50.000.001 +`).
  const openSep = `${HS}*[.,]${HS}*|${HS}+`;
  const open = text.match(
    new RegExp(
      String.raw`\$\s*50(?:` +
        openSep +
        String.raw`)000(?:` +
        openSep +
        String.raw`)001(?!\d)\s*\+?|over\s+\$?\s*50(?:` +
        openSep +
        String.raw`)000(?:` +
        openSep +
        String.raw`)000(?!\d)`,
      'i',
    ),
  );
  if (open) {
    return { min: 50000001, max: null, exact: true };
  }

  const re = new RegExp(
    String.raw`\$\s*(${OCR_AMOUNT_TOKEN_SRC})\s*${RANGE_SEP}\s*\$?\s*(${OCR_AMOUNT_TOKEN_SRC})`,
    'gi',
  );
  let lastExact: AmountRange | null = null;
  let lastAny: AmountRange | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const los = tokenValues(m[1]);
    const his = tokenValues(m[2]);
    if (!los.length || !his.length) continue;
    const exact = exactPair(los, his);
    if (exact) {
      lastExact = exact;
      continue;
    }
    const lo = los[0];
    const hi = his[0];
    const snapped = snapToBracket(lo, hi);
    if (snapped) {
      lastAny = { min: snapped.min, max: snapped.max, exact: true, snapped: true };
    } else {
      lastAny = { min: lo, max: hi, exact: false };
    }
  }
  return lastExact ?? lastAny;
}

/** Snap an approximate [lo,hi] onto the nearest canonical bracket. */
function snapToBracket(lo: number, hi: number | null): AmountBracket | null {
  // Prefer a bracket whose bounds nearly equal the parsed values.
  for (const b of STOCK_ACT_BRACKETS) {
    const bMax = b.max ?? Number.POSITIVE_INFINITY;
    const hiVal = hi ?? bMax;
    if (Math.abs(b.min - lo) <= 1 && (b.max === null ? hi === null : Math.abs(bMax - hiVal) <= 1)) {
      return b;
    }
  }
  return nearestBracket(lo, hi);
}

function isNum(n: number | null): n is number {
  return n !== null && Number.isFinite(n);
}

/**
 * Full token, then the same token with one trailing 3-digit group removed.
 * A flattened 278-T line puts the next row number (`126`) right after
 * `$50 000`, which is the same shape as a real `$1 000 001`. exactPair
 * keeps the reading that is a STOCK Act bracket, preferring the longer one.
 *
 * The shortened reading is only offered when the trailing group is split off
 * by horizontal whitespace after a digit. A comma or period before the last
 * group is thousands punctuation, not a row break: `$15,000,999` is a
 * corrupted amount and must not collapse to `$15,000`.
 */
function tokenValues(token: string): number[] {
  const values: number[] = [];
  const full = parseDollar(token);
  if (full !== null) values.push(full);
  const shorter = token.match(/^(.*?\d)[ \u00A0\u2007\u2009\u202F]+\d{3}$/);
  if (shorter) {
    const trimmed = parseDollar(shorter[1]);
    if (trimmed !== null && trimmed !== full) values.push(trimmed);
  }
  return values;
}

function exactPair(los: number[], his: number[]): AmountRange | null {
  for (const lo of los) {
    for (const hi of his) {
      const exactB = matchBracket(lo, hi);
      if (exactB) return { min: exactB.min, max: exactB.max, exact: true };
    }
  }
  return null;
}
