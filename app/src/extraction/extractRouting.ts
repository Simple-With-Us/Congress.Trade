/**
 * Cheap-first extract routing + hard-stop quality gates.
 *
 * OpenRouter Files attaches a $0.50 prepaid hold to the key daily limit
 * (production is $2/day). Electronic / typed House PTRs must never take that
 * path. Files / expensive vision is only for documents classified as real
 * scans. After any cheap read, letterhead / column-header / row-limit /
 * missing-date+malformed-amount junk hard-stops before more model spend
 * (including the agreement trio).
 *
 * Cost target for a typed House PTR: local unpdf + optional Flash-Lite text
 * call (tokens only, typically well under $0.01) — not a $0.50 Files hold.
 */

import type { Filing, ParsedTx } from '../shared/types.ts';
import { sentryLoggerWarn } from '../shared/sentryRuntime.ts';
import { isJunkAssetString } from './nameNormalizer.ts';

/**
 * Printed House PTR example row after letters-only squash.
 * Optional "ex" plus up to 10 letters of OCR junk (Example, Exempl, Ex Mpi),
 * then mega / meg / mfg / manufactur…, then corp, then optional commonstock.
 * Both ends are anchored so "Mega Corp Holdings Inc" and "Exxon Mobil Corp"
 * stay live trades.  A spelling list loses the next OCR reading.
 */
const HOUSE_SAMPLE_SQUASHED_RE =
  /^(?:ex[a-z]{0,10})?(?:manufactur[a-z]{0,8}|mfg|mega|meg)corp(?:commonstock)?$/;

/** Exact printed example dates.  Not every day in 2012 or 2020. */
const HOUSE_SAMPLE_ISO_DATES = new Set(['2012-08-14', '2020-02-05', '2020-05-02']);

function squashPtrAssetLetters(text: string): string {
  return text.toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * Printed House sample dates only: 8/14/12, and the two ISO readings of the
 * later form's 02/05/20 grid (2020-02-05 and 2020-05-02).  A year match is
 * not a sample.  Callers must not drop a row on this date alone.
 */
export function looksLikePtrFormSampleDate(txDate: string | null | undefined): boolean {
  if (!txDate?.trim()) return false;
  const iso = txDate.trim();
  if (HOUSE_SAMPLE_ISO_DATES.has(iso)) return true;
  return /\b(?:8\/14\/12|08\/14\/2012|0?2\/0?5\/20|0?5\/0?2\/20)\b/.test(txDate);
}

/**
 * Owner codes, a trailing asset class, and a short parenthetical ticker sit
 * outside the printed name.  They are removed before the anchored signature
 * so "SP Example Meg Corp [ST]" still matches, while "Mega Corp Holdings Inc"
 * still does not.
 */
function stripHouseSampleAffixes(text: string): string {
  let value = text.trim();
  for (let i = 0; i < 2; i++) {
    const next = value.replace(/^(?:(?:\((?:sp|dc|jt|self)\))|(?:(?:sp|dc|jt|self)\b))[\s:.-]*/i, '');
    if (next === value) break;
    value = next.trim();
  }
  value = value.replace(/\s*[\[(]\s*(?:st|cs|stock|common\s*stock)\s*[\])]\s*$/i, '').trim();
  value = value.replace(/\s*\([A-Za-z]{1,5}\)\s*$/g, '').trim();
  return value;
}

export function looksLikeHousePrintedExampleAsset(text: string | null | undefined): boolean {
  if (!text?.trim()) return false;
  return HOUSE_SAMPLE_SQUASHED_RE.test(squashPtrAssetLetters(stripHouseSampleAffixes(text)));
}

/** Asset text from a raw OCR line that also carries a tx code and a date. */
function housePrintedExampleCandidate(text: string): string {
  const cut = text.split(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\$\s*\d/)[0] ?? text;
  return cut.replace(/\s+\b(?:P|S|E|purchase|sale|exchange)\b\s*$/i, '').trim();
}

/** Drop printed PTR form sample rows in every extraction path before normalize/publish. */
export function dropPtrFormSampleParsedRows(parsed: ParsedTx[]): ParsedTx[] {
  return parsed.filter((p) =>
    !looksLikePtrFormSampleAsset(p.assetName)
    && !looksLikePtrFormSampleRow(p)
  );
}

/**
 * Publish-path drop.  One Sentry log per filing when a printed sample is
 * removed, so the drop is observable without a per-row issue.
 */
export function dropPtrFormSamplesForPublish(docId: string, parsed: ParsedTx[]): ParsedTx[] {
  const kept = dropPtrFormSampleParsedRows(parsed);
  const dropped = parsed.length - kept.length;
  if (dropped > 0) {
    const assets = parsed
      .filter((row) => !kept.includes(row))
      .map((row) => (row.assetName || row.rawText || '').trim())
      .filter(Boolean)
      .slice(0, 6)
      .join('; ')
      .slice(0, 240);
    sentryLoggerWarn('ptr.form_sample_dropped', {
      docId,
      dropped,
      assets,
    });
  }
  return kept;
}

/** Same publish cap the normalizer uses; duplicated to avoid an import cycle. */
export const EXTRACT_ROW_LIMIT = 200;

export type HouseExtractKind = 'electronic' | 'scanned' | 'unknown';

export interface HouseExtractRoute {
  kind: HouseExtractKind;
  /** True only when OpenRouter Files / expensive vision is allowed. */
  allowFiles: boolean;
}

export interface ExtractQuality {
  ok: boolean;
  /** Stable reason token when ok is false. */
  reason?: string;
}

const HOUSE_DOC_ID_RE = /^H-(\d{4})-(\d+)$/i;

/**
 * House electronic FD system DocIDs are 8-digit values in the 20xxxxxx range
 * (live review corpus: H-2025-200xxxxx). Paper/scan batches use 7-digit
 * 822xxxx / 911xxxx series.
 */
export function housePtrNumericId(docId: string): string | null {
  const match = HOUSE_DOC_ID_RE.exec(docId.trim());
  return match?.[2] ?? null;
}

export function isHouseElectronicDocId(docId: string): boolean {
  const numeric = housePtrNumericId(docId);
  return numeric != null && numeric.length >= 8 && numeric.startsWith('20');
}

export function isHousePaperScanDocId(docId: string): boolean {
  const numeric = housePtrNumericId(docId);
  return numeric != null && /^(822|911)/.test(numeric);
}

export function filingDocClass(filing: Filing): string | null {
  const extra = filing as Filing & { docClass?: string | null };
  const value = extra.docClass;
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

/**
 * Decide whether this House filing may use OpenRouter Files / paid vision.
 * Electronic DocIDs, typed/text_pdf, and empty/corrupt classes never do.
 */
export function classifyHouseExtractRoute(filing: Filing): HouseExtractRoute {
  const docClass = filingDocClass(filing);
  const docKind = (filing.docKind || '').trim().toLowerCase();

  if (isHouseElectronicDocId(filing.docId) || docKind === 'text_pdf' || docClass === 'typed') {
    return { kind: 'electronic', allowFiles: false };
  }
  if (docKind === 'senate_html' || docClass === 'empty' || docClass === 'corrupt') {
    return { kind: 'electronic', allowFiles: false };
  }
  if (isHousePaperScanDocId(filing.docId) || docClass === 'clean_scan' || docClass === 'hard_scan') {
    return { kind: 'scanned', allowFiles: true };
  }
  if (docKind === 'scanned_pdf') {
    return { kind: 'scanned', allowFiles: true };
  }
  return { kind: 'unknown', allowFiles: false };
}

export function allowOpenRouterFiles(filing: Filing): boolean {
  return classifyHouseExtractRoute(filing).allowFiles;
}

/**
 * True when extracted PDF/HTML text looks like a real trade table, not
 * letterhead. Used to decide whether a cheap text-model call is worth it.
 */
export function looksLikePlausibleTradeTable(text: string): boolean {
  const body = (text || '').trim();
  if (body.length < 40) return false;
  if (looksLikeHeaderContaminatedAsset(body.slice(0, 240))) {
    // Letterhead in the first lines is normal on a PTR; still require trade tokens.
  }
  const dates = body.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g)?.length ?? 0;
  const amounts = body.match(/\$[\d,]+/g)?.length ?? 0;
  const owners = body.match(/\b(?:SP|DC|JT|SELF)\b/g)?.length ?? 0;
  const tickers = body.match(/\([A-Z][A-Z0-9.^\/\-]{0,9}\)/g)?.length ?? 0;
  const txCodes = body.match(/\b(?:P|S|E)\b|\bpurchase\b|\bsale\b/gi)?.length ?? 0;
  return (dates >= 1 && amounts >= 1 && (owners >= 1 || tickers >= 1 || txCodes >= 1));
}

/**
 * True when the "asset name" is PTR form chrome (letterhead / column headers),
 * not a tradeable security.  The OGE 278-T footnote "... Your Broker Acted As
 * Agent" leaks in as a row when a scanned page is OCR'd ("Tion Your Brokor
 * Acted As Annnt"); the `bro..r acted as` clause matches its OCR variants.
 */
export function looksLikeHeaderContaminatedAsset(assetName: string | null): boolean {
  if (!assetName) return false;
  return /(?:\bClerk of the House of Representatives\b|\bLegislative Resource Center\b|\bB-?81 Cannon Building\b|\bCannon Building\b|\bID Owner Asset Transaction Type\b|\bTransaction Type Date Notification Date Amount\b|\bPeriodic Transaction Report\b|Name:\s*Hon\.|Status:\s*Member|State\/District:|\bMember of the U\.?S\.?\s+House\b|\bOfficer or Employee\b|\bOffice Telephone\b|\bEmploying Off(?:ice)?\b|\bunreadable asset\b|HOUSE OF\s+REP|\bCfficar\b|\bDiotict\b|Use oSucem|I certify that|Signature of Reporting|\bFULL ASSET NAME\b|\bpro\w{0,4}\s+(?:\w{1,2}\s+)?full\b.{0,30}?(?:symb|ymbol|ticker)|\bif you answered\b|\bfiled in error\b|\bpreviously and erroneously filed\b|\bplease contact\b|\bChief of Staff\b|\bServing the .+ Valley\b|\bbro[a-z]{1,4}r\s+acted\s+as\b)/i.test(
    assetName,
  ) || looksLikePtrFormSampleAsset(assetName);
}

/**
 * Printed PTR sample rows.  House: the example Mega / Meg / Mfg Corp line
 * (OCR reads Exempl, Ex Mpi, Mega Corp, Example Meg Corp).  Senate paper:
 * "IBM Corp. (stock) NYSE" dated 2/1/1X and "(DC) Microsoft (stock) NASDAQ/OTC"
 * dated 2/27/1X, with amount columns that spell EXAMPLE.  Those are form
 * instructions, never live trades.  A real IBM or Microsoft lot will not use
 * that exact printed wording.  A real Mega Corp holding with any extra word
 * ("Holdings", "Inc") is kept.
 */
export function looksLikePtrFormSampleAsset(assetName: string | null): boolean {
  if (!assetName) return false;
  const clean = assetName.trim();
  if (looksLikeHousePrintedExampleAsset(clean)) return true;
  if (/ibm\s+corp\.?\s*(?:\(\s*stock\s*\))?\s*nyse/i.test(clean)) return true;
  if (/^(?:\(dc\)\s*)?microsoft\s*(?:\(\s*stock\s*\))?\s*nasdaq\s*\/\s*otc/i.test(clean)) return true;
  return false;
}

/**
 * Checks if an extracted transaction row matches the printed sample rows
 * found on House or Senate PTR forms (e.g. Example Mega Corp or Senate Form 278-T
 * IBM / Microsoft sample rows). Matches on asset name, raw OCR text, placeholder
 * date years (e.g. 1X OCR'd as 2027), or "EXAMPLE" amount ranges.
 */
export function looksLikePtrFormSampleRow(row: {
  assetName?: string | null;
  rawText?: string | null;
  amountRange?: string | null;
  txDate?: string | null;
  amountMin?: number | null;
  amountMax?: number | null;
}): boolean {
  const asset = (row.assetName || '').trim();
  const raw = (row.rawText || '').trim();
  const amount = (row.amountRange || '').trim();
  const date = (row.txDate || '').trim();

  if (looksLikePtrFormSampleAsset(asset)) return true;
  if (looksLikePtrFormSampleAsset(raw)) return true;
  // Raw lines keep a tx code and a date after the printed name.  The name
  // signature still has to match.  looksLikePtrFormSampleDate is not a drop
  // by itself: 2012 and 2020 are real trading years.
  if (raw && looksLikeHousePrintedExampleAsset(housePrintedExampleCandidate(raw))) return true;

  // Amount column spells EXAMPLE or raw text has EXAMPLE with sample tickers/assets
  if (/\bexample\b/i.test(amount) || /\bexample\b/i.test(raw)) {
    if (/microsoft|ibm|mega\s+corp/i.test(asset) || /microsoft|ibm|mega\s+corp/i.test(raw)) {
      return true;
    }
  }

  // Senate form 278-T printed sample dates: 2/1/1X or 2/27/1X
  if (/(?:2\/1\/1[xX0-9]|2\/27\/1[xX0-9])/i.test(raw)) {
    if (/microsoft|ibm/i.test(asset) || /microsoft|ibm/i.test(raw)) {
      return true;
    }
  }

  // Raw text contains template exchange pairings with Microsoft or IBM
  if (/(?:nasdaq\s*\/\s*otc|nyse)/i.test(raw)) {
    if (/\bmicrosoft\b|\bibm\b/i.test(raw) && /\(stock\)/i.test(raw)) {
      return true;
    }
  }

  // If asset is precisely "Microsoft" or "IBM" and extracted date is in a future year (from 1X OCR artifact)
  const currentYear = new Date().getFullYear();
  if (/^(?:\(dc\)\s*)?(?:microsoft|ibm(?:\s+corp\.?)?)$/i.test(asset)) {
    if (date) {
      const parsedYear = parseInt(date.slice(0, 4), 10);
      if (!isNaN(parsedYear) && parsedYear > currentYear) {
        return true;
      }
    }
    if (/\bexample\b/i.test(raw)) {
      return true;
    }
  }

  return false;
}

/** Handwritten "See Attachment" on a Senate paper PTR is a pointer, not a trade. */
export function looksLikeSeeAttachmentPointer(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\bsee\s+attach(?:ment|ments)\b/i.test(text);
}

export function looksLikeNothingToReport(text: string | null | undefined): boolean {
  if (!text) return false;
  return /nothing\s+to\s+report/i.test(text)
    || /nothlng\s+to\s+report/i.test(text)
    || /nothlng\s+to\s+rcport/i.test(text)
    || /no\s+transactions?\s+to\s+report/i.test(text)
    || /no\s+trades?\s+to\s+report/i.test(text)
    || /\bnothing\s*2\s*report\b/i.test(text)
    || /\bno\s+ptr\s+activity\b/i.test(text)
    || /\bnothing\s+to\s+disclose\b/i.test(text);
}

/**
 * OGE 278e Part 7 whose immediate body is only None / N/A / No transactions.
 * Kept off looksLikeNothingToReport so a bare zero-row OCR read (no this
 * section) still parks for review instead of closing verified_empty.
 */
export function looksLikeOgePart7ExplicitNone(text: string | null | undefined): boolean {
  if (!text) return false;
  // Part 7 / "7. Transactions" whose immediate body is only None / N/A / No transactions.
  // Allow same-line OCR collapses ("… None 7. Transactions None 8. …") and
  // require a word boundary so "None of the above" does not count.
  const none = /(?:^|[\n\s])(?:part\s*7[.:\s]+transactions?|(?<!\d)7[.]\s*transactions?)\s+(?:none|n\/a|no\s+transactions?(?:\s+to\s+report)?)\b(?!\s+of\b)/i.exec(text);
  if (!none) return false;
  // Every empty-resolution path calls this check, so the attachment veto
  // lives here: "None. See attachment." still points at rows on an attached
  // schedule. Scoped to the section tail so form boilerplate cannot veto an
  // honest empty.
  const rest = text.slice(none.index + none[0].length);
  // Same row-8 false-end guard as ogeText's PART7_END_RE: the numbered
  // alternative requires the Liabilities title, so a Part 7 table row 8
  // cannot shrink the attachment-veto tail.
  const end = /(?:^|\s)(?:part\s*8\b|(?<!\d)8[.]\s*liabilities\b|summary\s+of\s+contents)/i.exec(rest);
  const tail = end ? rest.slice(0, end.index) : rest.slice(0, 80);
  return !/\battach(?:ed|ments?)\b/i.test(tail);
}

export function isDeletedFilingStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && /\bdeleted\b/i.test(status.trim());
}

export function looksLikeColumnHeaderAsset(assetName: string | null): boolean {
  if (!assetName) return false;
  const trimmed = assetName.trim();
  if (!trimmed) return false;
  return /^(?:id|owner|asset(?:\s+name)?|ticker|transaction\s+type|type|date|notification(?:\s+date)?|amount(?:\s+range)?|cap(?:ital)?\s+gains)$/i.test(
    trimmed,
  ) || /^(?:ID\s+Owner|Asset\s+Transaction|Notification Date|Amount of Transaction)$/i.test(trimmed);
}

function isMalformedAmount(tx: ParsedTx): boolean {
  return tx.amountMin == null && tx.amountMax == null;
}

/** Placeholder / form-chrome / empty asset names must not win agreement votes. */
export function isPlaceholderAgreementAsset(assetName: string | null | undefined): boolean {
  if (looksLikeHeaderContaminatedAsset(assetName ?? null)) return true;
  if (looksLikeColumnHeaderAsset(assetName ?? null)) return true;
  return isJunkAssetString(assetName);
}

export function isNullAmountRow(tx: ParsedTx): boolean {
  return isMalformedAmount(tx);
}

/**
 * Row-level agreement junk: placeholder assets or missing brackets.
 * These rows cannot beat a coherent sibling in majority / confidence picks.
 */
export function isJunkAgreementRow(tx: ParsedTx): boolean {
  return isPlaceholderAgreementAsset(tx.assetName) || isNullAmountRow(tx);
}

export function dropJunkAgreementRows(rows: readonly ParsedTx[]): ParsedTx[] {
  return rows.filter((tx) => !isJunkAgreementRow(tx));
}

function majority(count: number, total: number): boolean {
  return total > 0 && count * 2 > total;
}

/**
 * Hard-stop before more model spend. Empty extracts are not junk — they are
 * just empty. Letterhead-as-asset, column headers, row-limit floods,
 * majority missing-date + malformed-amount, placeholder assets, and
 * null-amount reads are junk.
 */
export function evaluateExtractQuality(transactions: readonly ParsedTx[]): ExtractQuality {
  const rows = transactions ?? [];
  if (rows.length === 0) return { ok: true };

  const letterhead = rows.filter((tx) => looksLikeHeaderContaminatedAsset(tx.assetName));
  if (letterhead.length > 0 && letterhead.length >= Math.max(1, rows.length * 0.4)) {
    return { ok: false, reason: 'letterhead_as_asset' };
  }

  const headers = rows.filter((tx) => looksLikeColumnHeaderAsset(tx.assetName));
  if (headers.length > 0 && headers.length >= Math.max(1, rows.length * 0.4)) {
    return { ok: false, reason: 'column_header_as_asset' };
  }

  if (rows.length > EXTRACT_ROW_LIMIT) {
    return { ok: false, reason: 'extraction_row_limit' };
  }

  const broken = rows.filter((tx) => !tx.txDate && isMalformedAmount(tx));
  if (rows.length >= 3 && broken.length / rows.length >= 0.6) {
    return { ok: false, reason: 'missing_tx_date_malformed_amount' };
  }

  const meanConf = rows.reduce((sum, tx) => sum + (Number.isFinite(tx.confidence) ? tx.confidence : 0), 0)
    / rows.length;
  if (
    meanConf > 0
    && meanConf <= 0.25
    && (letterhead.length > 0 || broken.length >= Math.ceil(rows.length * 0.5))
  ) {
    return { ok: false, reason: 'low_confidence_junk' };
  }

  const placeholders = rows.filter((tx) => isPlaceholderAgreementAsset(tx.assetName));
  if (majority(placeholders.length, rows.length)) {
    return { ok: false, reason: 'placeholder_asset' };
  }

  const nullAmounts = rows.filter((tx) => isNullAmountRow(tx));
  if (majority(nullAmounts.length, rows.length)) {
    return { ok: false, reason: 'null_amount' };
  }

  return { ok: true };
}

const AGREEMENT_HARD_STOP_RE =
  /form_chrome|letterhead_as_asset|column_header_as_asset|ocr_unusable|extraction_row_limit|missing_tx_date_malformed_amount|low_confidence_junk|letterhead|placeholder_asset|null_amount/i;

/** Review-queue reasons that must never spend the agreement trio. */
export function shouldSkipAgreementForReviewReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return AGREEMENT_HARD_STOP_RE.test(reason);
}

export function shouldEnqueueAgreement(input: {
  filing: Filing;
  extractor?: string | null;
  quality: ExtractQuality;
  reviewReason?: string | null;
}): boolean {
  if (!input.quality.ok) return false;
  if (shouldSkipAgreementForReviewReason(input.reviewReason)) return false;
  const route = classifyHouseExtractRoute(input.filing);
  if (route.kind === 'electronic' || !route.allowFiles) return false;
  return true;
}

/** Estimated Files prepaid hold in USD (OpenRouter key-limit, not wallet). */
export const OPENROUTER_FILES_HOLD_USD = 0.5;

/**
 * Typed PTR cost envelope used in tests / PR receipts. Local unpdf is $0;
 * a Flash-Lite text completion is tokens only.
 */
export const TYPED_PTR_CHEAP_PATH_USD_CEILING = 0.02;
