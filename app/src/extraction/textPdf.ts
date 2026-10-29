/**
 * src/extraction/textPdf.ts
 * OWNER: extraction agent
 *
 * Extractor for machine-readable (text-layer) PDF disclosures (docKind 'text_pdf').
 *
 * House e-filed Periodic Transaction Reports carry a real text layer. After the
 * report header, each holding is rendered as a block such as:
 *
 *   SP  Apple Inc. (AAPL) [ST]
 *       P  06/14/2024  06/20/2024  $1,001 - $15,000
 *
 * The exact whitespace/line-wrapping varies by generator, so we extract the
 * full text via `unpdf.extractText` then reconstruct rows with tolerant
 * heuristics: an owner-code + asset line, followed by (or inline with) a
 * transaction-type code, one or two dates, and an amount bracket.
 */

import { extractText, getDocumentProxy } from 'unpdf';

import type { Extractor, ExtractorInput, ExtractorResult } from '../extractors/types.ts';
import type { Filing, Owner, ParsedTx, TxType } from '../shared/types.ts';
import { HOUSE_ASSET_TYPE_NAMES, houseAssetTypeCodePattern } from '../shared/assetTypes.ts';
import { parseAmountRange } from './amounts.ts';
import { detectOption } from './senateHtml.ts';
import { ptrColumnTailRe, ptrTailRe } from './ptrTails.ts';

export { countHousePtrTails } from './ptrTails.ts';

/** Penalty per missing core field (date / amount / type / asset). */
const MISSING_FIELD_PENALTY = 0.12;

export class TextPdfExtractor implements Extractor {
  readonly name = 'textPdf';

  canHandle(f: Filing): boolean {
    return f.docKind === 'text_pdf';
  }

  async extract(input: ExtractorInput): Promise<ExtractorResult> {
    if (!input.bytes) {
      throw new Error('textPdf: no bytes provided on ExtractorInput');
    }

    const { text, pageCount } = await extractPdfText(input.bytes);
    const rows = parseHousePtrText(text);

    // Document confidence = mean of row confidences (or low if nothing found).
    const docConfidence =
      rows.length > 0
        ? rows.reduce((s, r) => s + r.confidence, 0) / rows.length
        : 0.3;

    // `pageCount` is a complexity signal for cascade tiering (see orchestrator.ts,
    // which persists it onto the filings row). Not part of the ExtractorResult
    // contract, so stash it on a plain object rather than widening that interface;
    // the orchestrator reads it via an optional-property cast.
    const result = {
      transactions: rows,
      confidence: docConfidence,
      raw: text,
      extractor: this.name,
      pageCount,
    };
    return result;
  }
}

// ---------------------------------------------------------------------------
// PDF text extraction
// ---------------------------------------------------------------------------

interface PdfTextExtraction {
  text: string;
  /**
   * Page count read off the parsed PDF's cheap `numPages` getter (no extra
   * parse, no page merge — pdf.js already has the document open for text
   * extraction). Null when unavailable.
   */
  pageCount: number | null;
}

async function extractPdfText(bytes: ArrayBuffer): Promise<PdfTextExtraction> {
  // unpdf accepts a Uint8Array; mergePages joins page text with newlines.
  // Copy the buffer first (bytes.slice(0)): getDocumentProxy/pdf.js transfers and
  // detaches the ArrayBuffer it is handed, so passing `bytes` directly would leave
  // the caller's buffer detached and break the HousePdfExtractor vision fallback,
  // which reuses the same ArrayBuffer after text extraction. Do not remove the copy
  // (regression guard for Sentry CONGRESS-TRADE-2).
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes.slice(0)));
    const { text } = await extractText(pdf, { mergePages: true });
    const pageCount = typeof pdf.numPages === 'number' && Number.isFinite(pdf.numPages) ? pdf.numPages : null;
    // Cleanup the memory to prevent OOM
    if (typeof (pdf as any).destroy === 'function') (pdf as any).destroy();
    else if (typeof (pdf as any).cleanup === 'function') (pdf as any).cleanup();
    return {
      text: typeof text === 'string' ? text : (text as string[]).join('\n'),
      pageCount,
    };
  } catch (err) {
    console.warn('[textPdf] unpdf extraction failed:', err);
    return {
      text: '',
      pageCount: null,
    };
  }
}

// ---------------------------------------------------------------------------
// House PTR text parsing
// ---------------------------------------------------------------------------

const OWNER_CODES: Record<string, Owner> = {
  SP: 'spouse',
  DC: 'dependent',
  JT: 'joint',
  SELF: 'self',
};

// Asset-type bracket codes used by the House template, e.g. [ST] [OP] [GS] [4K].
const HOUSE_ASSET_TYPE_CODE_PATTERN = houseAssetTypeCodePattern();
const ASSET_TYPE_RE = new RegExp(`\\[(${HOUSE_ASSET_TYPE_CODE_PATTERN})\\]`, 'i');
// A date in MM/DD/YYYY.
const DATE_RE = /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/g;
// An amount bracket like "$1,001 - $15,000" or "$50,000,001 +" or "Over $1,000,000".
const AMOUNT_RE = /(?:Over\s+)?\$[\d,]+(?:\s*(?:-|–|—|to)\s*\$?[\d,]+|\s*\+)?/i;
// A transaction-type token (P / S / E / S (partial) ...).
const TXTYPE_RE = /\b(P|S|E)\b|\b(purchase|sale|exchange)\b/i;
const TICKER_PATTERN = String.raw`[A-Z][A-Z0-9.^\/\-]{0,9}`;
// A ticker in parentheses, e.g. "(AAPL)" or "(JPM^J)" or "(BRK/B)".
const TICKER_RE = new RegExp(String.raw`\((${TICKER_PATTERN})\)`);
const TICKER_SKIP_RE = /^(PARTIAL|NEW|NONE|N\/A|PURCHASE|SALE|BUY)$/i;
const HOUSE_TABLE_HEADER_RE =
  /\b(?:Filing ID\s*#?\d+\s+)?ID\s+Owner\s+Asset\s+Transaction\s+Type\s+Date\s+Notification\s+Date\s+Amount(?:\s+Cap\.?\s*Gains(?:\s*>\s*(?:\$?\s*200\??)?)?)?/i;
const HOUSE_TABLE_HEADER_GLOBAL_RE =
  /\b(?:Filing ID\s*#?\d+\s+)?ID\s+Owner\s+Asset\s+Transaction\s+Type\s+Date\s+Notification\s+Date\s+Amount(?:\s+Cap\.?\s*Gains(?:\s*>\s*(?:\$?\s*200\??)?)?)?/gi;
// First-row prefix is the entire document up to the first `[ST] P date $`
// tail. Electronic PTRs omit SP/DC/JT on self rows, so identityFromPrefix
// cannot cut at an owner token and would otherwise name that row after the
// clerk letterhead. normalize() then drops it as form chrome — silent loss
// of the first trade (live: H-2025-20030212 Allegheny County muni).
const HOUSE_PTR_PREAMBLE_RE =
  /(?:Periodic Transaction Report|Clerk of the House of Representatives|Legislative Resource Center|B-?81 Cannon Building|Washington,\s*DC\s*\d+|Status:\s*Member|State\/District:\s*\S+|Filing ID\s*#?\d+)/gi;
const INLINE_RECORD_RE = new RegExp(
  String.raw`\b(?<owner>SP|DC|JT|SELF)\s+(?<asset>[^$]{1,220}?)\s+(?:(?:\((?<parenTicker>${TICKER_PATTERN})\))|(?:NYSE[A-Z]*:\s*(?<exchangeTicker>${TICKER_PATTERN})))?\s*\[(?<assetType>${HOUSE_ASSET_TYPE_CODE_PATTERN})\]\s+(?<txType>P|S|E|purchase|sale|exchange)(?:\s*\([^)]*\))?\s+(?<txDate>\d{1,2}\/\d{1,2}\/\d{2,4})\s+\d{1,2}\/\d{1,2}\/\d{2,4}\s+(?<amount>\$[\d,]+(?:\s*(?:-|–|—|to)\s*\$?[\d,]+|\s*\+)?)`,
  'gi',
);

/**
 * Parse the merged House PTR text into ParsedTx[]. We segment the text into
 * candidate holding blocks, then pull fields from each block.
 */
export function parseHousePtrText(text: string): ParsedTx[] {
  const cleaned = cleanPdfText(text);
  // Electronic PTRs often omit SP/DC/JT on every row after the first. The
  // owner-required INLINE_RECORD_RE then glues those later rows into one
  // rawText (wrong ticker, two $ brackets → invalid_amount). Split on every
  // `[TYPE] P/S/E date date $amount` tail first.
  const tailRows = parseTailRecords(cleaned);
  const columnRows = parseColumnTailRecords(cleaned);
  const completeCount = (rows: ParsedTx[]) =>
    rows.filter((row) =>
      Boolean(row.assetName && row.assetName !== '(unknown)' && row.txDate && row.txType && row.amountMin != null)
    ).length;
  // Prefer the `[TYPE] P/S/E date` tail when it already has a complete lineup.
  // Use the column-order parser only when it recovers more complete rows
  // (EO.Pdf wraps `[ST]` onto the next line after Type/Date/Amount).
  if (tailRows.length > 0 && completeCount(tailRows) >= completeCount(columnRows)) {
    return tailRows;
  }
  if (columnRows.length > 0) return columnRows;

  if (HOUSE_TABLE_HEADER_RE.test(cleaned)) {
    const inlineRows = parseInlineRecords(cleaned);
    if (inlineRows.length > 0) return inlineRows;
  }

  const stripped = stripHouseTableHeaders(cleaned);
  const lines = stripped
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  // Group lines into blocks that each start at an owner code or a ticker line.
  const blocks = groupBlocks(lines);
  const rows: ParsedTx[] = [];
  for (const block of blocks) {
    const tx = blockToParsedTx(block);
    if (tx) rows.push(tx);
  }
  return rows;
}

function cleanPdfText(text: string): string {
  return expandHousePtrLayout(text
    // Some House PDFs expose a text layer with NUL bytes between letters.
    // Remove them before line grouping so "S\0P" is parsed as owner code "SP".
    .replace(/\u0000/g, '')
    .replace(/\u00a0/g, ' '));
}

/** EO.Pdf letter-spacing + wrapped `$100,001 -` / `$250,000` amount columns. */
function expandHousePtrLayout(text: string): string {
  return text
    .replace(/\bF\s+S\s*:\s*/gi, 'Filing Status: ')
    .replace(/\bS\s+O\s*:\s*/gi, 'Subholding Of: ');
}

/**
 * House PTR detail lines — "Filing Status: ...", "Subholding Of: ...",
 * "Location: ...", "Description: ..." — plus the letter-spaced forms the form
 * generator prints ("F S:", "S O:", "L:", "D:").
 *
 * The House form prints a row's detail lines UNDER that row, so in the merged
 * page text they sit after the row's `[ST] P/S/E date $amount` tail and before
 * the next row's asset line. A blank Owner column removes the owner code that
 * used to mark where the next row starts, which glued "Filing Status: New
 * Subholding Of: ..." onto the next row's asset name and shifted every
 * subholding one row down. Split each gap between two tails on the detail
 * lines themselves instead of on owner codes.
 */
const HOUSE_DETAIL_LINE_RE =
  /^\s*(?:Filing\s+Status|Subholding\s+Of|Location|Description|F\s+S|S\s+O|L|D)\s*:/i;

/**
 * A House PTR document collapsed to one line, plus the line bookkeeping the
 * detail-block split needs.
 */
interface HousePtrDoc {
  /** Whole document with every whitespace run collapsed to a single space. */
  text: string;
  /** Non-empty source lines, each whitespace-collapsed. */
  lines: string[];
  /** Offset of the first character of each line inside `text`. */
  lineStart: number[];
  /** Offset just past the last character of each line inside `text`. */
  lineEnd: number[];
  /** Index of the line that owns each character of `text`. */
  lineOf: number[];
}

function collapseHousePtrLines(text: string): HousePtrDoc {
  const lines: string[] = [];
  const lineStart: number[] = [];
  const lineEnd: number[] = [];
  const lineOf: number[] = [];
  let out = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (out) {
      out += ' ';
      // The separator belongs to the line before it, so a gap that opens at a
      // line boundary still resolves to the content of the next line.
      lineOf.push(lines.length - 1);
      lineEnd[lines.length - 1] = out.length;
    }
    lineStart.push(out.length);
    out += line;
    lineEnd.push(out.length);
    for (let i = 0; i < line.length; i += 1) lineOf.push(lines.length);
    lines.push(line);
  }
  return { text: out, lines, lineStart, lineEnd, lineOf };
}

/** Full House detail label anywhere in a string (asset-name sanity check). */
const HOUSE_DETAIL_LABEL_IN_NAME_RE = /\b(?:Filing\s+Status|Subholding\s+Of)\s*:/i;

/** A source line that opens a new holding with an explicit owner code. */
const HOUSE_OWNER_LINE_RE = /^(?:SP|DC|JT|SELF)\s/;

/**
 * End offset (exclusive) of the run of detail lines at the head of
 * `gapStart..gapEnd`. Those lines belong to the row whose tail precedes the
 * gap, so the text after the run is the next row's asset line.
 * Returns `gapStart` when the gap holds no detail line at all, and never
 * returns more than `gapEnd`.
 */
function houseDetailBlockEnd(gapStart: number, gapEnd: number, doc: HousePtrDoc): number {
  if (gapStart >= gapEnd) return gapStart;
  let end = gapStart;
  let li = doc.lineOf[gapStart] ?? 0;
  const lastLine = doc.lineOf[gapEnd - 1] ?? li;
  // A gap can open mid-line (a tail that stopped at "$344" inside
  // "$344.99"); that remainder belongs to the tail, not to a detail line.
  if (gapStart > (doc.lineStart[li] ?? 0)) li += 1;
  for (; li <= lastLine; li += 1) {
    // A line that runs into the next tail carries that row's identity, so it
    // can never be part of this row's detail block.
    if ((doc.lineEnd[li] ?? Infinity) > gapEnd) break;
    if (!HOUSE_DETAIL_LINE_RE.test(doc.lines[li] ?? '')) break;
    end = doc.lineEnd[li] ?? end;
  }
  if (end > gapStart) {
    // A long detail value ("D: ...") can wrap onto unlabeled lines. When the
    // next holding opens with an owner code, every line before that one is
    // still this row's detail block. Blank-owner (self) rows have no such
    // anchor, so their block stays at the last labeled line.
    for (let lj = li; lj <= lastLine; lj += 1) {
      if ((doc.lineStart[lj] ?? Infinity) >= gapEnd) break;
      if (HOUSE_OWNER_LINE_RE.test(doc.lines[lj] ?? '')) {
        end = doc.lineStart[lj] ?? end;
        break;
      }
    }
  }
  return Math.min(end, gapEnd);
}

function joinWrappedAmountRanges(text: string): string {
  return text.replace(
    /(\$[\d,]+)\s*-\s+((?:(?!\$)[\s\S]{0,80}?))(\$[\d,]+)/g,
    '$1 - $3 $2',
  );
}

function stripHouseTableHeaders(text: string): string {
  return text
    .replace(new RegExp(`^.*?${HOUSE_TABLE_HEADER_RE.source}\\s*`, 'i'), '')
    .replace(HOUSE_TABLE_HEADER_GLOBAL_RE, ' ');
}

function stripHousePtrPreamble(prefix: string, stripColumnMarker = true): string {
  let s = stripHouseTableHeaders(prefix).replace(/\s+/g, ' ').trim();
  let cut = 0;
  HOUSE_PTR_PREAMBLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HOUSE_PTR_PREAMBLE_RE.exec(s)) !== null) {
    cut = m.index + m[0].length;
  }
  if (cut > 0) s = s.slice(cut);
  // Leftover column marker from "T ID Owner Asset …" after the header strip.
  // Only a prefix that can still hold the page preamble has one; a row that
  // starts at its own asset line would lose the "T" of "T Rowe Price …".
  if (stripColumnMarker) s = s.replace(/^\s*T\s+/, '').trim();
  // Stop before an owner code or a two-token ALL-CAPS asset (munis). Never
  // run to end-of-string — that ate "JT Abbott … (ABT)" on filer-name lines.
  return s.replace(
    /^Name:\s*Hon\.\s+.+?(?=\s+(?:SP|DC|JT|SELF|Status:|State\/District:)\b|\s+[A-Z]{3,}\s+[A-Z]{2,})/i,
    '',
  ).trim();
}

function calculateRowConfidence(row: {
  owner: Owner | null;
  assetName: string | null;
  ticker: string | null;
  txType: TxType | null;
  txDate: string | null;
  amountMin: number | null;
}): number {
  const hasOwner = Boolean(row.owner);
  // A detail label inside the asset name means the row split failed (e.g. a
  // blank-owner row in a text layer with no line breaks); keep it out of
  // auto-publish instead of shipping a corrupted name.
  const gluedDetail = Boolean(row.assetName && HOUSE_DETAIL_LABEL_IN_NAME_RE.test(row.assetName));
  const hasAsset = !gluedDetail && Boolean((row.assetName && row.assetName !== '(unknown)') || row.ticker);
  const hasTxType = Boolean(row.txType);
  const hasDate = Boolean(row.txDate && /^\d{4}-\d{2}-\d{2}$/.test(row.txDate));
  const hasAmount = row.amountMin !== null;

  // Complete rows auto-publish: CONFIDENCE_THRESHOLD is 0.95. Cap below that
  // forced every clean textPdf extract into review forever.
  if (hasAsset && hasTxType && hasDate && hasAmount) {
    // Owner is often implicit (self) on House digital forms; do not require it.
    return hasOwner ? 1.0 : 0.97;
  }

  let confidence = 0.9;
  if (!hasDate) confidence -= MISSING_FIELD_PENALTY;
  if (!hasAmount) confidence -= MISSING_FIELD_PENALTY;
  if (!hasTxType) confidence -= MISSING_FIELD_PENALTY;
  if (!hasAsset) confidence -= MISSING_FIELD_PENALTY;
  // Incomplete rows stay below the auto-publish threshold.
  return Math.max(0.3, Math.min(0.94, confidence));
}

function parseTailRecords(text: string): ParsedTx[] {
  const doc = collapseHousePtrLines(stripHouseTableHeaders(cleanPdfText(text)));
  const normalized = doc.text;
  const matches = [...normalized.matchAll(ptrTailRe())];
  if (matches.length === 0) return [];

  // Tail i owns [tailStart_i, tailEnd_i). The gap after it holds that row's
  // detail lines followed by the next row's asset line; split the gap on the
  // detail lines so each row keeps its own Filing Status / Subholding Of and
  // its asset name stays free of the previous row's details.
  const count = matches.length;
  const tailStart = matches.map((m) => m.index ?? 0);
  const tailEnd = matches.map((m, i) => (m.index ?? 0) + (matches[i][0]?.length ?? 0));
  const gapStart: number[] = [0];
  for (let i = 1; i <= count; i += 1) gapStart.push(tailEnd[i - 1]);
  const gapEnd: number[] = [...tailStart, normalized.length];
  const detailEnd = gapStart.map((s, j) => houseDetailBlockEnd(s, gapEnd[j], doc));

  const rows: ParsedTx[] = [];
  for (let i = 0; i < count; i += 1) {
    const m = matches[i];
    // Identity: this row's asset line, with any leading detail block removed.
    const identityStart = detailEnd[i] > gapStart[i] ? detailEnd[i] : gapStart[i];
    const prefix = normalized.slice(identityStart, tailStart[i]);
    // Details: this row's own detail block, which the form prints after the
    // row's tail. Rows whose block has no "Subholding Of" line get null.
    const detailsEnd = detailEnd[i + 1] > gapStart[i + 1] ? detailEnd[i + 1] : gapEnd[i + 1];
    const detailsText = normalized.slice(tailEnd[i], detailsEnd);
    const rawText = normalized.slice(identityStart, i + 1 < count ? tailStart[i + 1] : normalized.length);
    const groups = m.groups ?? {};
    // Blank Owner is Self on the House form — not "same as the previous row".
    // Carrying SP/DC/JT forward mis-attributes later unmarked (filer) trades.
    // Only the first row's prefix can still hold the preamble and its "T"
    // column marker; later rows start at their own asset line.
    const identity = identityFromPrefix(prefix, i === 0);
    const assetType = groups.assetType?.toUpperCase() ?? null;
    const txType = parseTxType(groups.txType ?? '') ?? 'B';
    const txDate = toIsoDate(groups.txDate ?? '');
    const { min, max } = parseAmountRange(groups.amount ?? '');
    const details = parseHouseRowDetails(detailsText);
    const confidence = calculateRowConfidence({
      owner: identity.owner,
      assetName: identity.assetName,
      ticker: identity.ticker,
      txType,
      txDate,
      amountMin: min,
    });
    rows.push({
      txDate,
      owner: identity.owner,
      assetName: identity.assetName,
      ticker: identity.ticker,
      assetType,
      assetTypeName: assetType ? HOUSE_ASSET_TYPE_NAMES[assetType] ?? null : null,
      txType,
      amountMin: min,
      amountMax: max,
      isOption: assetType === 'OP' || detectOption(rawText),
      capGainsOver200: parseCapGainsOver200(rawText),
      rawText,
      ...details,
      confidence,
    });
  }
  return rows;
}

function parseColumnTailRecords(text: string): ParsedTx[] {
  const normalized = joinWrappedAmountRanges(
    stripHouseTableHeaders(cleanPdfText(text)).replace(/\s+/g, ' ').trim(),
  );
  const matches = [...normalized.matchAll(ptrColumnTailRe())];
  if (matches.length === 0) return [];

  const rows: ParsedTx[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i];
    const next = matches[i + 1];
    const start = m.index ?? 0;
    const end = next?.index ?? normalized.length;
    const prevEnd = i > 0
      ? (matches[i - 1].index ?? 0) + (matches[i - 1][0].length)
      : 0;
    let prefix = normalized.slice(prevEnd, start);
    if (i > 0) {
      prefix = prefix
        .replace(/^[\s\S]*\b(?:Filing\s+Status|Subholding\s+Of|Location|Description):/i, '')
        .replace(/^[\s\S]*\bD\s*:\s+/i, '')
        .replace(/^[A-Za-z][A-Za-z .,&'/-]{0,40}?\s+(?=[A-Z])/i, '')
        .trim();
    }
    let suffix = normalized.slice(start + m[0].length, end);
    suffix = suffix.replace(/\s+\d{7,}\s+(?:SP|DC|JT|SELF)\b[\s\S]*$/i, '');
    const identitySlice = suffix
      .replace(/\b(?:Filing\s+Status|Subholding\s+Of|Location|Description):[\s\S]*$/i, '')
      .replace(ASSET_TYPE_RE, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const rawText = `${prefix} ${m[0]} ${suffix}`.replace(/\s+/g, ' ').trim();
    const groups = m.groups ?? {};
    const identity = identityFromPrefix(`${prefix} ${identitySlice}`);
    const suffixTicker = normalizeTicker((suffix.match(TICKER_RE) ?? identitySlice.match(TICKER_RE) ?? [])[1] ?? null);
    const typeMatch = suffix.match(ASSET_TYPE_RE) ?? prefix.match(ASSET_TYPE_RE);
    const assetType = typeMatch?.[1]?.toUpperCase() ?? groups.assetType?.toUpperCase() ?? null;
    const txType = parseTxType(groups.txType ?? '') ?? 'B';
    const txDate = toIsoDate(groups.txDate ?? '');
    const { min, max } = parseAmountRange(groups.amount ?? '');
    const details = parseHouseRowDetails(suffix);
    const ticker = identity.ticker ?? suffixTicker;
    const confidence = calculateRowConfidence({
      owner: identity.owner,
      assetName: identity.assetName,
      ticker,
      txType,
      txDate,
      amountMin: min,
    });
    rows.push({
      txDate,
      owner: identity.owner,
      assetName: identity.assetName,
      ticker,
      assetType,
      assetTypeName: assetType ? HOUSE_ASSET_TYPE_NAMES[assetType] ?? null : null,
      txType,
      amountMin: min,
      amountMax: max,
      isOption: assetType === 'OP' || detectOption(rawText),
      capGainsOver200: parseCapGainsOver200(rawText),
      rawText,
      ...details,
      confidence,
    });
  }
  return rows;
}

function identityFromPrefix(
  prefix: string,
  stripColumnMarker = true,
): { owner: Owner | null; ticker: string | null; assetName: string } {
  let s = stripHousePtrPreamble(prefix, stripColumnMarker);
  s = s.replace(/^\d{7,}\s+/, '');
  const ownerMatches = [...s.matchAll(/\b(SP|DC|JT|SELF)\b/gi)];
  const ownerTok = ownerMatches.at(-1);
  const owner = ownerTok
    ? (OWNER_CODES[ownerTok[1].toUpperCase()] ?? 'self')
    : 'self';
  if (ownerTok && ownerTok.index != null) {
    s = s.slice(ownerTok.index + ownerTok[0].length).trim();
  }

  const tickerMatches = [...s.matchAll(new RegExp(TICKER_RE.source, 'g'))]
    .filter((m) => !TICKER_SKIP_RE.test(m[1] ?? ''));
  const tickerMatch = tickerMatches.at(-1);
  let ticker = tickerMatch ? normalizeTicker(tickerMatch[1]) : null;
  let nameSrc = tickerMatch && tickerMatch.index != null
    ? s.slice(0, tickerMatch.index)
    : s;

  nameSrc = nameSrc.replace(/^(?:F\s+)?S:\s+New\b/i, '').trim();
  nameSrc = nameSrc.replace(/^(?:S\s+O|L|D):\s+/i, '');
  nameSrc = nameSrc.replace(
    /^.*\b(?:Account(?:\s*#?\s*\d+)?|Trust\s+\d+|Retirement Account\s+\d+|Investment Fund\s+\d+|Active Assets(?:\s*\(\d+\))?|Brokerage Account(?:\s*#?\s*\d+)?)\s+/i,
    '',
  );

  if (!ticker) {
    const hyphen = nameSrc.match(/\s-\s([A-Z]{2,5})\s*$/);
    if (hyphen) {
      ticker = hyphen[1];
      nameSrc = nameSrc.slice(0, hyphen.index).trim();
    }
  }

  const assetName = cleanAssetNameString(nameSrc) || ticker || '(unknown)';
  return { owner, ticker, assetName };
}

function parseInlineRecords(text: string): ParsedTx[] {
  const normalized = stripHouseTableHeaders(text).replace(/\s+/g, ' ').trim();
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  INLINE_RECORD_RE.lastIndex = 0;
  while ((m = INLINE_RECORD_RE.exec(normalized)) !== null) {
    matches.push(m);
  }

  const rows: ParsedTx[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    m = matches[i];
    const next = matches[i + 1];
    const rawText = normalized.slice(m.index, next ? next.index : undefined).trim();
    const groups = m.groups ?? {};
    const owner = parseOwner(groups.owner ?? '');
    const ticker = normalizeTicker(groups.parenTicker ?? groups.exchangeTicker ?? null);
    const assetType = groups.assetType?.toUpperCase() ?? null;
    const details = parseHouseRowDetails(rawText);
    const assetName = cleanAssetNameString(groups.asset ?? '') || ticker || '(unknown)';
    const txType = parseTxType(groups.txType ?? '') ?? 'B';
    const txDate = toIsoDate(groups.txDate ?? '');
    const { min, max } = parseAmountRange(groups.amount ?? '');

    const confidence = calculateRowConfidence({
      owner,
      assetName,
      ticker,
      txType,
      txDate,
      amountMin: min,
    });

    rows.push({
      txDate,
      owner,
      assetName,
      ticker,
      assetType,
      assetTypeName: assetType ? HOUSE_ASSET_TYPE_NAMES[assetType] ?? null : null,
      txType,
      amountMin: min,
      amountMax: max,
      isOption: assetType === 'OP' || detectOption(rawText),
      capGainsOver200: parseCapGainsOver200(rawText),
      rawText,
      ...details,
      confidence,
    });
  }
  return rows;
}

function cleanAssetNameString(value: string): string {
  return value
    .replace(/^.*(?:\/share|shares)\s+/i, '')
    .replace(HOUSE_TABLE_HEADER_GLOBAL_RE, ' ')
    .replace(/^(?:SP|DC|JT|SELF)\b\s*/i, '')
    .replace(/\b(S|P|E|F)\s+S:\s+New\b.*$/i, '')
    .replace(/\b(S|P|E|F)\s+O:\s+.*$/i, '')
    .replace(/\bD:\s+.*$/i, '')
    .replace(/[\s\-\,]+$|^[\s\-\,]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTicker(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.trim().toUpperCase().replace(/\//g, '.');
  if (
    cleaned === 'N/A' ||
    cleaned === 'NONE' ||
    cleaned === 'N/A.' ||
    cleaned === 'NULL' ||
    /^N\s*\/\s*A$/i.test(cleaned)
  ) {
    return null;
  }
  return cleaned;
}

function blockHasAmount(lines: string[]): boolean {
  return lines.some((l) => AMOUNT_RE.test(l));
}

function blockHasDate(lines: string[]): boolean {
  return lines.some((l) => DATE_RE.test(l));
}

function startsNewHolding(line: string, completedRow: boolean): boolean {
  const ownerStart = /^(SP|DC|JT|SELF)\b/i.test(line);
  if (ownerStart) return true;
  if (completedRow) {
    const hasTicker = TICKER_RE.test(line);
    const hasAssetType = ASSET_TYPE_RE.test(line);
    if (hasTicker && hasAssetType) return true;
  }
  return false;
}

function groupBlocks(lines: string[]): string[][] {
  const cleanedLines = lines
    .map((l) => l.replace(HOUSE_TABLE_HEADER_GLOBAL_RE, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const blocks: string[][] = [];
  let current: string[] = [];

  for (const line of cleanedLines) {
    const completedRow = blockHasAmount(current) && blockHasDate(current);
    if (startsNewHolding(line, completedRow)) {
      if (current.length > 0 && blockHasAmount(current)) {
        blocks.push(current);
      }
      current = [line];
      continue;
    }
    if (current.length > 0) {
      current.push(line);
    } else {
      const hasTicker = TICKER_RE.test(line);
      const hasAssetType = ASSET_TYPE_RE.test(line);
      if (/^(SP|DC|JT|SELF)\b/i.test(line) || (hasTicker && hasAssetType)) {
        current = [line];
      }
    }
  }
  if (current.length > 0 && blockHasAmount(current)) {
    blocks.push(current);
  }
  return blocks.filter((b) => AMOUNT_RE.test(b.join(' ')));
}

function blockToParsedTx(block: string[]): ParsedTx | null {
  const joined = block.join(' ');

  const owner = parseOwner(joined);
  const ticker = parseTicker(joined);
  const assetType = parseAssetType(joined);
  const details = parseHouseRowDetails(joined);
  const assetName = parseAssetName(joined, ticker);
  const txType = parseTxType(joined);
  const dates = parseDates(joined);
  const amountText = (joined.match(AMOUNT_RE) ?? [''])[0];
  const { min, max } = parseAmountRange(amountText);
  const txDate = dates[0] ?? null;

  // Reject blocks that are clearly not a trade (no type AND no amount).
  if (!txType && min === null) return null;

  const confidence = calculateRowConfidence({
    owner,
    assetName,
    ticker,
    txType,
    txDate,
    amountMin: min,
  });

  return {
    txDate,
    owner,
    assetName: assetName || ticker || '(unknown)',
    ticker,
    assetType,
    assetTypeName: assetType ? HOUSE_ASSET_TYPE_NAMES[assetType] ?? null : null,
    txType: txType ?? 'B',
    amountMin: min,
    amountMax: max,
    isOption: detectOption(joined) || assetType === 'OP',
    capGainsOver200: parseCapGainsOver200(joined),
    rawText: joined,
    ...details,
    confidence,
  };
}

function parseHouseRowDetails(text: string): Pick<
  ParsedTx,
  'filingStatus' | 'subholding' | 'location' | 'description' | 'supplementalText'
> {
  const filingStatus = cleanDetailValue(extractDetail(text, /\bFiling\s+Status:\s*/i));
  const subholding = cleanDetailValue(extractDetail(text, /\bSubholding\s+Of:\s*/i));
  const location = cleanDetailValue(extractDetail(text, /\bLocation:\s*/i) ?? extractDetail(text, /\bL:\s*/i));
  const description = cleanDetailValue(extractDetail(text, /\bDescription:\s*/i) ?? extractDetail(text, /\bD:\s*/i));
  const supplementalText = [filingStatus, subholding, location, description].filter(Boolean).join(' | ') || null;
  return { filingStatus, subholding, location, description, supplementalText };
}

function extractDetail(text: string, label: RegExp): string | null {
  const m = label.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const stop = rest.search(
    /\b(?:Filing\s+Status|Subholding\s+Of|Location|Description):|\bCap\.?\s*Gains\b|\b(?:S\s+O|L|D):|\s+(?:SP|DC|JT|SELF)\b|\s+[PSE]\s+\d{1,2}\/\d{1,2}\/\d{2,4}|\bD\s*:/i,
  );
  return stop >= 0 ? rest.slice(0, stop) : rest;
}

function cleanDetailValue(value: string | null): string | null {
  const cleaned = (value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\s+\b(?:P|S|E|F)\s*$/i, '')
    .trim();
  return cleaned || null;
}

function parseCapGainsOver200(text: string): boolean {
  return /\bCap\.?\s*Gains\b.{0,30}(?:checked|true|yes)|(?:☑|✓)\s*$|\bcapGainsOver200\b.{0,10}true/i.test(text);
}

function parseOwner(text: string): Owner | null {
  const m = text.match(/^(SP|DC|JT|SELF)\b/i) ?? text.match(/\b(SP|DC|JT|SELF)\b/i);
  if (m) return OWNER_CODES[m[1].toUpperCase()] ?? null;
  if (/\bspouse\b/i.test(text)) return 'spouse';
  if (/\bjoint\b/i.test(text)) return 'joint';
  if (/\b(child|dependent)\b/i.test(text)) return 'dependent';
  // House PTRs default unmarked holdings to the filer (Self).
  return 'self';
}

function parseTicker(text: string): string | null {
  const m = text.match(TICKER_RE);
  if (!m) return null;
  return normalizeTicker(m[1]);
}

function parseAssetType(text: string): string | null {
  const m = text.match(ASSET_TYPE_RE);
  return m ? m[1].toUpperCase() : null;
}

function parseAssetName(joined: string, ticker: string | null): string {
  let name = joined.replace(/^(SP|DC|JT|SELF)\b\s*/i, '');

  const detailIndex = name.search(/\b(?:Filing Status|Subholding Of|Location|Description):|\b(?:F|S O|L|D):/i);
  if (detailIndex >= 0) {
    name = name.slice(0, detailIndex);
  }

  const assetTypeMatch = ASSET_TYPE_RE.exec(name);
  if (assetTypeMatch) {
    name = name.slice(0, assetTypeMatch.index);
  }

  const tickerMatch = TICKER_RE.exec(name);
  if (tickerMatch) {
    name = name.slice(0, tickerMatch.index);
  }

  name = name.split(/\s+(?:P|S|E)\s+\d{1,2}\/\d{1,2}\/\d{2,4}|\s+\d{1,2}\/\d{1,2}\/\d{2,4}|\s+\$[\d,]/i)[0];

  name = cleanAssetNameString(name);

  if (!name && ticker) return ticker;
  return name;
}

function parseTxType(text: string): TxType | null {
  const m = text.match(TXTYPE_RE);
  if (!m) return null;
  const tok = (m[1] || m[2] || '').toLowerCase();
  if (tok === 'p' || tok === 'b' || tok === 'purchase' || tok === 'buy') return 'B';
  if (tok === 's' || tok === 'sale' || tok === 'sell') return 'S';
  if (tok === 'e' || tok === 'exchange') return 'E';
  return null;
}

function parseDates(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  DATE_RE.lastIndex = 0;
  while ((m = DATE_RE.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 16), m.index).toLowerCase();
    // Bond / note maturity in the asset name ("due 1/31/2028", "DUE 05/01/2053")
    // is not the transaction date. Prod H-2024-20025111 parked as future_tx_date.
    if (/(?:due|matures?|maturity|coupon)\s+$/.test(before)) continue;
    out.push(toIsoDate(m[1]));
  }
  return out;
}

function toIsoDate(mmddyyyy: string): string {
  const m = mmddyyyy.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return mmddyyyy;
  const [, mm, dd, yy] = m;
  const year = yy.length === 2 ? `20${yy}` : yy;
  return `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
