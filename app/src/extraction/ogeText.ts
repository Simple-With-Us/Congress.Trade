/**
 * src/extraction/ogeText.ts
 * OWNER: extraction agent
 *
 * Extractor for the dedicated OGE Form 278-T "Periodic Transaction Report"
 * PDF filed by executive-branch personnel (docKind 'text_pdf', chamber
 * 'executive'). Purely deterministic text-layer parsing — no network calls,
 * no model calls.
 *
 * The 278-T renders its transactions as a single flat table with columns:
 *   # | DESCRIPTION | TYPE | DATE | NOTIFICATION RECEIVED OVER 30 DAYS AGO | AMOUNT
 * e.g. one logical row reads:
 *
 *   1 Amazon.com, Inc. (AMZN) Sale 06/10/2022 No $1,001 - $15,000
 *
 * IMPORTANT: unpdf's mergePages text-layout heuristic (pdf.js's line-break
 * insertion, driven by Y-coordinate deltas between text items) is NOT
 * guaranteed to insert a newline between rows — verified in production
 * (Cloudflare Workers runtime) that an entire multi-page 278-T comes back as
 * ONE line with no `\n` at all, while the same PDF parsed locally under
 * Node.js does insert per-row newlines. Parsing therefore does NOT split on
 * `\n` and match per line (that silently found 0 rows in production while
 * finding 3/3 in local Node testing — a real incident, not a hypothetical).
 * Instead the whole merged text is whitespace-normalized to single spaces
 * (folding away import '\n'/'\r' too) and scanned with a GLOBAL regex, the
 * same technique textPdf.ts's parseInlineRecords() uses for the same reason.
 * `\s+` matches a real newline just as well as a run of spaces, so this
 * approach is correct under EITHER text-layout behavior.
 *
 * This is a DIFFERENT layout from the House PTR text_pdf format that
 * textPdf.ts targets (House rows carry an owner code + a bracketed asset-type
 * code; OGE 278-T rows have neither). Routing an executive filing through the
 * House-tuned parser silently yields zero rows — OgePdfExtractor claims
 * chamber==='executive' text_pdf and scanned_pdf filings ahead of the generic
 * TextPdfExtractor in buildExtractorPipeline() and runs this parser first.
 * True scans that yield zero rows then take a fail-soft OpenRouter vision
 * path; this class itself still only claims text_pdf.
 *
 * SCOPE: the dedicated 278-T "Periodic Transaction Report" form only. The
 * broader OGE 278e annual/termination disclosure (a much larger multi-section
 * form whose own Part 7 "Transactions" table uses a harder-to-bound layout
 * interleaved with unrelated numbered lists — positions held, agreements,
 * assets) is intentionally NOT row-parsed: ROW_RE requires the full
 * type+date+notification+amount suffix to immediately follow the description,
 * so 278e prose fails to match and yields zero rows, never a wrong parse.
 * A Part 7 body that is only None / N/A / No transactions is an honest empty
 * (looksLikeOgePart7ExplicitNone → verified_empty).  A 278e with no 278-T
 * table and no other successful read is the same close even without the
 * word None.  A refused or unreadable 278-T (index/coverage gate, or a
 * periodic report with no readable rows) is not that empty.  Callers must
 * not treat a refusal as "nothing to report".
 */

import { extractText, getDocumentProxy } from 'unpdf';

import type { Extractor, ExtractorInput, ExtractorResult } from '../extractors/types.ts';
import type { Filing, ParsedTx, TxType } from '../shared/types.ts';
import { OCR_AMOUNT_TOKEN_SRC, parseAmountRange } from './amounts.ts';
import { isValidCalendarDateYMD } from './ocrSanity.ts';
import { looksLikeOgePart7ExplicitNone } from './extractRouting.ts';
import { detectOption } from './senateHtml.ts';

/** Penalty applied when a matched row is missing a core field. */
const INCOMPLETE_ROW_CONFIDENCE = 0.6;
/** Confidence for a fully-populated row (mirrors textPdf.ts's House-form
 *  "owner is implicit" treatment: the 278-T has no per-row owner column). */
const COMPLETE_ROW_CONFIDENCE = 0.97;

const TICKER_PATTERN = String.raw`[A-Z][A-Z0-9.^\/\-]{0,9}`;
const TICKER_SUFFIX_RE = new RegExp(String.raw`\((${TICKER_PATTERN})\)\s*$`);

// The table header always appears immediately before the first transaction
// row (verified against real production text). Anchoring the scan to start
// AFTER it is the primary defense against false-positive row-number matches
// in the surrounding boilerplate (legal prose is full of "<digit> <word>"
// sequences — e.g. "5 U.S.C. app. section 101 et seq." — that would
// otherwise be indistinguishable from a real row's leading "# ").
const TABLE_HEADER_RE = /#\s*[\.,:;]?\s*DESCRIPTION\s+TYPE\s+DATE\s+NOTIFICATION\s+RECEIVED\s+OVER\s+30\s+DAYS\s+AGO\s+AMOUNT/i;

// The row number is up to FIVE digits: a large executive 278-T (Trump's runs past
// row 3600) numbers its rows into the thousands, and the old `\d{1,3}` could not
// anchor them at all (board row 3d31c7b9).
// One flat transaction row, scanned globally over the (whitespace-normalized,
// header-anchored) document text rather than split by line — see the module
// comment for why "split by line" doesn't work here. The leading
// `(?<![\d,.])` stops the row-number token from matching inside a dollar
// amount (e.g. the "001" in "$1,001"): such a match is always preceded by a
// digit or comma, which this excludes. The description is capped at 200
// chars (`.{1,200}?`, still non-greedy) rather than unbounded `.+?` as a
// second layer of defense — a genuine 278-T description is a short "Company
// Name (TICK)" string, so an accidental match that ran past the header
// anchor (e.g. scanning without TABLE_HEADER_RE found) fails fast instead of
// swallowing hundreds of characters of prose to reach a later real row.
const OCR_AMOUNT = `(?:${OCR_AMOUNT_TOKEN_SRC})`;
const ROW_RE = new RegExp(
  String.raw`(?<![\d,.])\d{1,5}[\.,:;]?\s+(.{1,200}?)\s+(Purchase|Sale|Exchange)\s+(\d{1,2}/\d{1,2}/\d{2,4})\s+(?:Yes|No)\s+(\$` +
    OCR_AMOUNT +
    String.raw`(?:\s*(?:-|–|—|−|•|·|to|\.(?=\s*\$))\s*\$?` +
    OCR_AMOUNT +
    String.raw`|\s*\+)?)`,
  'gi',
);

const TX_TYPE_MAP: Record<string, TxType> = {
  purchase: 'B',
  sale: 'S',
  exchange: 'E',
};

/**
 * Coherence floor for the matched rows' leading "#" tokens.
 *
 * On a clean text layer, ROW_RE's row anchor is the table's own sequential,
 * unique "#" column (1, 2, 3, …). On a scanned-then-OCR'd 278-T the type word
 * is garbled on most rows ("salo", "lourchaso", "ourchase"), so ROW_RE only
 * matches the minority of rows whose type survived — and its leading `\d{1,5}`
 * then latches onto whatever bare number precedes that surviving word: bond
 * maturity years ("2028"), dollar fragments ("15000"), page numbers. The
 * resulting sequence jumps around and repeats heavily. Those rows are
 * mis-merged guesses (a description swallowed from the previous physical row),
 * not transactions. Producing zero rows instead parks the filing for an honest
 * human/vision read rather than publishing wrong data — the same "blocked, not
 * a wrong parse" contract this module already documents for garbled OCR.
 */
const MIN_ROWS_FOR_SEQUENCE_CHECK = 8;
const MIN_DISTINCT_INDEX_RATIO = 0.7;
const MAX_NON_INCREASING_STEP_RATIO = 0.3;
/**
 * The matched indices must also COVER their own span. A clean 278-T parse
 * matches every physical row, so the distinct indices are the contiguous
 * range 1..N (coverage ≈ 1). A garbled parse that only matched a minority of
 * rows while latching onto stray numbers yields a huge max/little overlap
 * (the Trump filing: 333 matches, span 0..15000, coverage 0.02). Refusing an
 * incomplete parse is the same "blocked, not a wrong parse" contract: a
 * partial transcript would silently drop real transactions.
 */
const MIN_INDEX_SPAN_COVERAGE = 0.8;

/**
 * Doc-id shape for the two executive disclosure forms this parser sees.
 * `278term` (and its hyphenated / spaced spellings) plus `278e` must win over
 * `278t`: a termination id contains the letters "278t" as a prefix of
 * "278term", and a hyphenated "278-term" would otherwise match "278-t".
 */
export function executiveDisclosureForm(docId: string): '278e' | '278t' | 'unknown' {
  const id = docId.toLowerCase();
  if (
    id.includes('278term') || id.includes('278-term') || id.includes('278 term')
    || id.includes('278e') || id.includes('278-e')
  ) return '278e';
  if (id.includes('278t') || id.includes('278-t')) return '278t';
  return 'unknown';
}

export type OgeTextClassification =
  | { disposition: 'rows'; rows: ParsedTx[] }
  | { disposition: 'empty'; rows: ParsedTx[] }
  | {
      disposition: 'unreadable';
      rows: ParsedTx[];
      reason: 'index_incoherent' | 'unreadable_278t';
      /**
       * Diagnostics only; never gates publishing. How many transaction rows the
       * refusal is standing in front of, when the row-index column could still be
       * counted. See detectOgeRowAnchors().
       */
      detectedRowAnchors?: number;
      detectedRowMaxIndex?: number;
    }
  /** Zero rows, but nothing shows Part 7 is empty (blank, garbled, or unsupported layout). */
  | { disposition: 'unconfirmed'; rows: ParsedTx[] };

/**
 * Count the row-index column of a 278-T without trusting the Type word.
 *
 * ROW_RE anchors a row on `<index> <description> Purchase|Sale <date> ...`, so on
 * a scanned-then-OCR'd 278-T — where the Type word survives on only a minority of
 * rows ("salo", "lourchaso") — it matches few rows and the sequence gate refuses.
 * The refusal is correct: the resulting rows would carry OCR-mangled dates, and
 * publishing those is worse than parking. But it leaves a readable 500+ row file
 * labelled exactly like a corrupt one, with nothing telling an operator how many
 * transactions are actually at stake or that the remedy is an image read.
 *
 * The row INDEX column is the one field OCR preserves on these documents: it
 * prints contiguously 1..N in its own leading column. Counting those anchors is
 * therefore a reliable size estimate, and it needs no date, type, or amount.
 *
 * Scope: line-anchored rows only (newline-separated layout, the form this repo's
 * fixtures use). A pdf.js `mergePages` read that flattens the document to one
 * line yields no anchors and returns zero — a diagnostic miss, never a behaviour
 * change. Callers must treat every field here as informational.
 */
export function detectOgeRowAnchors(text: string): { anchors: number; maxIndex: number | null } {
  if (!text) return { anchors: 0, maxIndex: null };
  let anchors = 0;
  let maxIndex: number | null = null;
  const re = /^[ \t]*(\d{1,5})[ \t]{2,}\S/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // A 278-T never numbers rows past the thousands; anything larger is a
    // dollar figure, a year, or a page number caught by the leading-digits rule.
    const n = Number(m[1]);
    if (n < 1 || n > 5000) continue;
    anchors += 1;
    if (maxIndex === null || n > maxIndex) maxIndex = n;
  }
  return { anchors, maxIndex };
}

/**
 * True when the matched rows' leading "#" tokens look like a real table index:
 * essentially unique, strictly increasing (allowing a few OCR skips/dupes),
 * and covering their span.  Filings with fewer than eight rows are always
 * treated as coherent.
 */
export function isOgeRowSequenceCoherent(indexes: readonly number[]): boolean {
  const n = indexes.length;
  if (n < MIN_ROWS_FOR_SEQUENCE_CHECK) return true;
  const distinct = new Set(indexes).size;
  if (distinct / n < MIN_DISTINCT_INDEX_RATIO) return false;
  let min = indexes[0];
  let max = indexes[0];
  let nonIncreasing = 0;
  for (let i = 0; i < n; i += 1) {
    const v = indexes[i];
    if (v < min) min = v;
    if (v > max) max = v;
    if (i > 0 && v <= indexes[i - 1]) nonIncreasing += 1;
  }
  const span = max - min + 1;
  if (span > 0 && distinct / span < MIN_INDEX_SPAN_COVERAGE) return false;
  return nonIncreasing / (n - 1) <= MAX_NON_INCREASING_STEP_RATIO;
}

export class OgeTextExtractor implements Extractor {
  readonly name = 'ogeText';

  /** Claims executive-branch text_pdf filings ahead of the House-tuned parser. */
  canHandle(f: Filing): boolean {
    return f.chamber === 'executive' && f.docKind === 'text_pdf';
  }

  async extract(input: ExtractorInput): Promise<ExtractorResult> {
    if (!input.bytes) {
      throw new Error('ogeText: no bytes provided on ExtractorInput');
    }
    const { text, pageCount } = await extractPdfText(input.bytes);
    const classified = classifyOgeTransactionText(text, input.filing.docId);
    const rows = classified.rows;
    // 'unconfirmed' carries no disposition: callers keep the fail-closed path.
    const parseDisposition = classified.disposition === 'unconfirmed' ? undefined : classified.disposition;
    const confidence =
      rows.length > 0 ? rows.reduce((s, r) => s + r.confidence, 0) / rows.length : 0.3;
    const result = {
      transactions: rows,
      confidence,
      raw: text,
      extractor: this.name,
      pageCount,
      parseDisposition,
    };
    return result;
  }
}

/** Text layer only. Failures return false so a bare zero-row extract is not closed. */
export async function pdfBytesLookLikeOgePart7ExplicitNone(bytes: ArrayBuffer): Promise<boolean> {
  try {
    const { text } = await extractPdfText(bytes.slice(0));
    return looksLikeOgePart7ExplicitNone(text);
  } catch {
    return false;
  }
}

async function extractPdfText(
  bytes: ArrayBuffer,
): Promise<{ text: string; pageCount: number | null }> {
  // Copy the buffer first: getDocumentProxy/pdf.js transfers and detaches the
  // ArrayBuffer it is handed (same regression guard as textPdf.ts's
  // extractPdfText — see its comment referencing Sentry CONGRESS-TRADE-2).
  const pdf = await getDocumentProxy(new Uint8Array(bytes.slice(0)));
  const { text } = await extractText(pdf, { mergePages: true });
  const pageCount =
    typeof pdf.numPages === 'number' && Number.isFinite(pdf.numPages) ? pdf.numPages : null;
  if (typeof (pdf as any).destroy === 'function') (pdf as any).destroy();
  else if (typeof (pdf as any).cleanup === 'function') (pdf as any).cleanup();
  return {
    text: typeof text === 'string' ? text : (text as string[]).join('\n'),
    pageCount,
  };
}

/**
 * Parse the merged text and say whether zero rows means "no transactions"
 * or "this read is not usable".
 *
 * A zero-row `278e` is empty only with positive evidence: a Part 7
 * Transactions section that is present, bounded by the next part, and holds
 * no transaction-looking content (Bondi-style Part 7).  Otherwise it is
 * `unconfirmed` and stays on the fail-closed path.  A `278t` that matches
 * nothing, or any parse the index/coverage gate refuses, is unreadable — the
 * same zero-row array must not take the empty path.
 */
export function classifyOgeTransactionText(text: string, docId = ''): OgeTextClassification {
  const scanned = scanOgeTransactionRows(text);
  const anchors = detectOgeRowAnchors(text);
  const anchorFields = {
    detectedRowAnchors: anchors.anchors,
    detectedRowMaxIndex: anchors.maxIndex,
  };
  if (scanned.refused) {
    return {
      disposition: 'unreadable',
      rows: [],
      reason: 'index_incoherent',
      ...anchorFields,
    };
  }
  if (scanned.rows.length > 0) return { disposition: 'rows', rows: scanned.rows };
  const form = executiveDisclosureForm(docId);
  if (form === '278t' || (form !== '278e' && scanned.has278tTable)) {
    return { disposition: 'unreadable', rows: [], reason: 'unreadable_278t', ...anchorFields };
  }
  if (ogePart7SectionLooksEmpty(text)) return { disposition: 'empty', rows: [] };
  return { disposition: 'unconfirmed', rows: [] };
}

const PART7_HEADING_RE = /(?:^|\s)(?:part\s*7[.:\s]+transactions?|(?<!\d)7[.]\s*transactions?)\b/i;
const PART7_HEADING_GLOBAL_RE = new RegExp(PART7_HEADING_RE.source, 'gi');
// The numbered alternative requires the Part 8 title: a bare "8. <word>"
// also matches row 8 of a Part 7 table ("8. Apple Inc Purchase ..."), which
// would end the section early and make the rows before it vanish from the
// body guards.
const PART7_END_RE = /(?:^|\s)(?:part\s*8\b|(?<!\d)8[.]\s*liabilities\b|summary\s+of\s+contents)/i;
/** The real section boundary: the Part 8 heading, not front/back-matter boilerplate. */
const PART7_REAL_END_RE = /(?:^|\s)(?:part\s*8\b|(?<!\d)8[.]\s*liabilities\b)/i;
/** Table evidence used both for the empty-section body guard and the boilerplate-end guard. */
const PART7_TABLE_EVIDENCE_RE = /#|\b(?:description|type|date|amount|notification)\b/i;
/**
 * Row evidence in text after a Summary of Contents marker: dates, dollar
 * amounts, or transaction words mean rows follow the marker even when the
 * table header glyphs were lost. Bare digits are deliberately excluded -
 * contents entries themselves carry part numbers.
 */
const PART7_TAIL_ROW_EVIDENCE_RE = /\d{1,2}\/\d{1,2}\/\d{2,4}|\$\s*\d|\b(?:purchase|sale|exchange)\b/i;
/** One short table-of-contents entry: "6. Agreements" / "Part 6 Agreements". */
const PART7_TOC_ENTRY_RE = /(?:part\s*\d{1,2}\b|(?<!\d)\d{1,2}[.])\s*[A-Za-z]/i;
const PART7_TOC_ENTRY_GLOBAL_RE = new RegExp(PART7_TOC_ENTRY_RE.source, 'gi');
/**
 * A none-marker between two part entries is a real (empty) section body, not
 * contents-run packing.  Mirrors the explicit-none vocabulary in
 * looksLikeOgePart7ExplicitNone.
 */
const PART7_SECTION_BODY_RE = /(?:^|\s)(?:none|n\/a|no\s+transactions?(?:\s+to\s+report)?)\b/i;
/**
 * How far around a Part 7 heading to look for neighbouring contents entries.
 * TOC lines sit right next to each other; a real Part 7 heading follows the
 * whole Part 6 body and its Part 8 successor heads a real section, so real
 * headings never have part entries on BOTH sides within this window.
 */
const PART7_TOC_ENTRY_WINDOW = 120;
/**
 * How much text may sit between the previous contents entry and a heading
 * for the heading to still count as packed inside the contents run.  TOC
 * lines sit right next to each other (a few characters, or a page number);
 * a real Part 7 heading follows the whole earlier body.
 */
const PART7_TOC_PACKED_GAP = 40;

/**
 * Positive evidence that an OGE 278e Part 7 (Transactions) section has no
 * rows: an explicit None marker, or a Part 7 heading whose body up to the
 * next part holds no table header, row number, type word, date, or dollar
 * amount.  A blank or garbled text layer, a header-only table, or a Part 7 we
 * cannot see the end of, is not evidence.
 */
export function ogePart7SectionLooksEmpty(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = text
    .replace(/\u0000/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  if (looksLikeOgePart7ExplicitNone(normalized)) return true;
  // Walk EVERY Part 7 heading, not just the first. A table of contents
  // carries the same words ("7. Transactions 8. Liabilities"), and a
  // first-match search stops there: bounded by the next TOC entry the
  // "section" looks empty, so a filing whose real Part 7 sits further down -
  // trades included - would close verified_empty. Same fail-closed class as
  // the header-only guard below: a TOC stub is not positive evidence of an
  // empty section, so skip headings inside a contents run (another part
  // entry just before AND just after) and keep scanning for the real one.
  let sawPositivelyEmptySection = false;
  PART7_HEADING_GLOBAL_RE.lastIndex = 0;
  let heading: RegExpExecArray | null;
  while ((heading = PART7_HEADING_GLOBAL_RE.exec(normalized)) !== null) {
    const rest = normalized.slice(heading.index + heading[0].length);
    const end = PART7_END_RE.exec(rest);
    // A Part 7 whose end we cannot see is not evidence; a later heading may
    // still be readable.
    if (!end) continue;
    // "Summary of Contents" is boilerplate that flattened extraction can drop
    // BETWEEN the Part 7 heading and its table (the production 278-T fixture
    // reads "... Endnotes Summary of Contents The 278-T ... # DESCRIPTION ...
    // 1 Amazon ..."). Ending the section there makes the heading-to-marker
    // gap look like a positively empty section while rows follow. When table
    // evidence sits between the marker and the real Part 8 boundary, the
    // marker is not the section end: treat the end as unseen and move on.
    if (/summary\s+of\s+contents/i.test(end[0])) {
      const tail = rest.slice(end.index + end[0].length);
      const realEnd = PART7_REAL_END_RE.exec(tail);
      const window = realEnd ? tail.slice(0, realEnd.index) : tail;
      if (PART7_TABLE_EVIDENCE_RE.test(window) || PART7_TAIL_ROW_EVIDENCE_RE.test(window)) continue;
    }
    const before = normalized.slice(
      Math.max(0, heading.index - PART7_TOC_ENTRY_WINDOW),
      heading.index,
    );
    const after = rest.slice(
      end.index + end[0].length,
      end.index + end[0].length + PART7_TOC_ENTRY_WINDOW,
    );
    // Skip headings inside a contents run: another part entry just before
    // AND just after, with no section body between the entries.  A
    // none-marker between entries is a real empty body ("Part 6. Agreements
    // None Part 7. Transactions Part 8. Liabilities None ..."), so a
    // short-but-real Part 7 must not be filtered out as a contents entry.
    const entriesBefore = [...before.matchAll(PART7_TOC_ENTRY_GLOBAL_RE)];
    const entryAfter = PART7_TOC_ENTRY_RE.exec(after);
    // A contents prefix can also be TRUNCATED at the boundary: the text ends
    // at "8. Liabilities", so the Part 7 contents line has entries before it
    // but none after, the both-sides filter does not fire, and the empty
    // prefix reads as a positively empty section - closing the 278e without
    // the real Part 7 ever being read.  With part entries before it and no
    // text at all after the boundary, the line is a contents stub either
    // way: skip it and keep scanning for the real heading.
    if (entriesBefore.length > 0) {
      if (!entryAfter) {
        // `part 8` ends the boundary match before its title, so a truncated
        // prefix can leave ". Liabilities" dangling after the boundary.
        const tail = after.replace(/^[.:]?\s*liabilities\b/i, '').trim();
        // Nothing readable follows the boundary.  Skip the heading only
        // when it is still packed against the previous contents entry: a
        // real Part 7 that is positively empty up to a truncated Part 8
        // boundary follows the whole earlier body, not a contents run, and
        // must still close.
        if (tail === '') {
          const lastBefore = entriesBefore[entriesBefore.length - 1];
          const betweenBefore = before.slice(lastBefore.index + lastBefore[0].length);
          if (betweenBefore.trim().length <= PART7_TOC_PACKED_GAP) continue;
        }
      } else {
        const lastBefore = entriesBefore[entriesBefore.length - 1];
        const betweenBefore = before.slice(lastBefore.index + lastBefore[0].length);
        const betweenAfter = after.slice(0, entryAfter.index);
        if (!PART7_SECTION_BODY_RE.test(betweenBefore) && !PART7_SECTION_BODY_RE.test(betweenAfter)) {
          continue;
        }
      }
    }
    const body = rest.slice(0, end.index);
    // A table header (or its `#` row-number column) with no rows under it is a
    // read that lost the row glyphs, not an empty section.  Real empty 278e
    // Part 7s print no table at all, or say None (handled above).
    if (/#|\b(?:description|type|date|amount|notification)\b/i.test(body)) return false;
    // "See Attachment" means the rows live on an attached schedule; the
    // section is not empty and the attachment is not in this text layer.
    if (/\battach(?:ed|ments?)\b/i.test(body)) return false;
    // Any digit (row number, date, amount) means content we could not parse.
    if (/\d/.test(body)) return false;
    if (/\b(?:purchase|sale|exchange)\b/i.test(body)) return false;
    if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(body)) return false;
    if (/\$\s*\d/.test(body)) return false;
    // Leftover alphabetic content — asset names with no digits, #, header
    // words, "attach", or purchase/sale/exchange ("Apple Inc Microsoft
    // Corporation") — is a read we could not parse, not positive evidence of
    // an empty section.  A real empty Part 7 prints nothing between the
    // headings, so any leftover alphabetic body stays unconfirmed.
    if (/[a-z]/i.test(body)) return false;
    sawPositivelyEmptySection = true;
  }
  return sawPositivelyEmptySection;
}

/** Parse the merged 278-T text into ParsedTx[]. Pure / unit-testable. */
export function parseOgeTransactionRows(text: string): ParsedTx[] {
  return classifyOgeTransactionText(text).rows;
}

interface OgeTextScan {
  rows: ParsedTx[];
  refused: boolean;
  /** True when the 278-T transactions table header is present. */
  has278tTable: boolean;
}

function scanOgeTransactionRows(text: string): OgeTextScan {
  // Fold NUL bytes, non-breaking spaces, and every run of whitespace
  // (including real newlines, when the runtime's pdf.js DOES emit them) down
  // to single spaces, so the same global scan below is correct regardless of
  // whether rows arrived newline-separated or all on one line.
  const normalized = text
    .replace(/\u0000/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return { rows: [], refused: false, has278tTable: false };

  // Prefer scanning only after the table header (see TABLE_HEADER_RE above);
  // fall back to the whole text if the header wasn't found (a format variant
  // this module hasn't seen), relying on ROW_RE's own length cap + required
  // suffix as the safety net in that case.
  const headerMatch = TABLE_HEADER_RE.exec(normalized);
  const searchText = headerMatch
    ? normalized.slice(headerMatch.index + headerMatch[0].length)
    : normalized;

  const rows: ParsedTx[] = [];
  const rowIndexes: number[] = [];
  ROW_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROW_RE.exec(searchText)) !== null) {
    const amountSpan = amountPrefixLength(m[4]);
    if (amountSpan < m[4].length) {
      const extra = m[4].length - amountSpan;
      m[0] = m[0].slice(0, m[0].length - extra);
      m[4] = m[4].slice(0, amountSpan);
      ROW_RE.lastIndex -= extra;
    }
    const [matchText, descriptionRaw, typeWord, dateRaw, amountRaw] = m;
    const indexMatch = /^(\d{1,5})/.exec(matchText);
    if (indexMatch) rowIndexes.push(Number(indexMatch[1]));
    const description = descriptionRaw.trim();
    const tickerMatch = TICKER_SUFFIX_RE.exec(description);
    const ticker = tickerMatch ? normalizeTicker(tickerMatch[1]) : null;
    const assetName = (ticker ? description.replace(TICKER_SUFFIX_RE, '') : description).trim() || '(unknown)';
    const txType = TX_TYPE_MAP[typeWord.toLowerCase()] ?? 'B';
    const txDate = toIsoDate(dateRaw);
    const { min, max } = parseAmountRange(amountRaw);
    const hasDate = /^\d{4}-\d{2}-\d{2}$/.test(txDate);
    const hasAmount = min !== null;
    // ROW_RE requires description+type+date+amount to all be present for any
    // match, so every row here already has the four core fields; the only
    // thing that can still be "incomplete" is a date/amount that matched the
    // regex shape but failed to parse cleanly (e.g. an out-of-range date).
    const confidence = hasDate && hasAmount ? COMPLETE_ROW_CONFIDENCE : INCOMPLETE_ROW_CONFIDENCE;

    rows.push({
      txDate: hasDate ? txDate : null,
      owner: null, // 278-T has no per-row owner column (unlike House SP/DC/JT codes)
      assetName,
      ticker,
      assetType: null,
      assetTypeName: null,
      txType,
      amountMin: min,
      amountMax: max,
      isOption: detectOption(matchText),
      capGainsOver200: false,
      rawText: matchText.trim(),
      confidence,
    });
    // Avoid an infinite loop on a zero-length match (shouldn't happen given
    // ROW_RE always consumes at least the row-number + suffix, but a global
    // regex with a zero-width overall match would otherwise stall exec()).
    if (m.index === ROW_RE.lastIndex) ROW_RE.lastIndex += 1;
  }
  // Refuse a garbled-OCR parse: if the matched "#" tokens are not a plausible
  // unique/increasing table index, ROW_RE was latching onto years/amounts and
  // the rows are mis-merged guesses.  Callers must keep this distinct from
  // a section that simply had no rows.
  if (!isOgeRowSequenceCoherent(rowIndexes)) {
    return { rows: [], refused: true, has278tTable: Boolean(headerMatch) };
  }
  return { rows, refused: false, has278tTable: Boolean(headerMatch) };
}

/** Text-layer classification for one stored executive PDF. */
export async function classifyExecutivePdfBytes(
  bytes: ArrayBuffer,
  docId = '',
): Promise<OgeTextClassification> {
  const { text } = await extractPdfText(bytes);
  return classifyOgeTransactionText(text, docId);
}

/**
 * A flattened 278-T line runs the next row number into the amount
 * (`$50 000 126 QUALCOMM`). Drop that trailing row index when the bracket
 * stays the same without it. Do not peel a real thousand group (`$1 000 001`).
 */
function amountPrefixLength(captured: string): number {
  const full = parseAmountRange(captured);
  if (full.min === null) return captured.length;
  let end = captured.length;
  while (/\s\d{1,5}$/.test(captured.slice(0, end))) {
    const trimmed = captured.slice(0, end).replace(/\s\d{1,5}$/, '');
    const again = parseAmountRange(trimmed);
    if (again.min !== full.min || (again.max ?? null) !== (full.max ?? null)) break;
    end = trimmed.length;
  }
  return end;
}

function normalizeTicker(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.trim().toUpperCase().replace(/\//g, '.');
  if (cleaned === 'N/A' || cleaned === 'NONE' || cleaned === 'NULL') return null;
  return cleaned;
}

function toIsoDate(mmddyyyy: string): string {
  const m = mmddyyyy.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return mmddyyyy;
  const [, mm, dd, yy] = m;
  const year = yy.length === 2 ? `20${yy}` : yy;
  const iso = `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  // A shape match is not a real date ("13/01/2026", "02/30/2026").  Return
  // blank so the row is flagged incomplete and held, never published.
  return isValidCalendarDateYMD(iso) ? iso : '';
}
