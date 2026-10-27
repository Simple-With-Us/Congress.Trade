/**
 * src/extraction/ogeLocalOcr.ts
 *
 * CT-2448 — local (no-network, no-model) OCR retry for OGE 278-T filings
 * whose stored PDF has no usable text layer.
 *
 * The OGE path used to park such a filing as `oge_text_unreadable` and wait
 * for a human.  Trump 2026-08-12 (E-2026-donald-j-trump-08-12-2026-278t) was
 * recovered by hand from 34 scanned pages with local tesseract, so the same
 * pass belongs in the pipeline.
 *
 * Contract (see docs/rollouts/2026-10-26-local-ocr-278t-retry.md):
 *   1. Render each page at 400 DPI with pdftoppm, crop to the table body,
 *      and OCR it with tesseract --psm 4.
 *   2. Read every page a second time at 600 DPI.
 *   3. Keep a row only when BOTH reads agree on type, date and amount.
 *   4. Publish only when the kept row numbers run 1..N with no gaps, every
 *      amount maps to a canonical STOCK Act bracket, and every type is B/S/E.
 *      Otherwise park exactly as today, listing the unreconciled rows.
 *
 * Style note: comments in this change use a real NBSP plus a normal space
 * between sentences, which deno's no-irregular-whitespace rule forbids, so
 * deno.json excludes that rule (it had zero violations on main).
 *
 * No vision model, no paid API: the pass shells out to the poppler and
 * tesseract binaries that ship in the app image.  When they are missing the
 * pass fails closed (the filing parks as before) with an explicit reason.
 */

import { matchBracket } from '../shared/brackets.ts';
import { get } from '../shared/db.ts';
import { readSetting } from '../settings/settingsService.ts';
import { scanOgeRows, type OgeScannedRow } from './ogeText.ts';
import { denoLocalOcrBackend } from './ogeLocalOcrRuntime.ts';
import type { Env, ParsedTx, TxType } from '../shared/types.ts';

/** Extractor id recorded on a filing the local OCR pass recovered. */
export const OGE_LOCAL_OCR_EXTRACTOR = 'ogeLocalOcr';

/** First read.  The crop hint was measured on the Trump scan at this DPI. */
export const OGE_LOCAL_OCR_DPI_PRIMARY = 400;
/** Second read.  A row survives only when both reads agree. */
export const OGE_LOCAL_OCR_DPI_SECONDARY = 600;

/**
 * The table-body crop, in 300-DPI pixel units of the RENDERED page.
 *
 * The numbers came from the Trump 278-T scan and are a starting hint, not
 * gospel: they were re-verified against a real OGE 278-T (A4 portrait with
 * /Rotate 90, so the rendered page is landscape A4 — 3509x2480 px at 300
 * DPI) and the crop is applied to the post-rotation render, which is the
 * only reading under which the numbers fit the page.
 *
 * They are still document-specific: on that A4 filing the hint clipped both
 * the "#" column and the AMOUNT column, so the pass falls back to an
 * uncropped read when the cropped read does not yield a coherent table.  The
 * rect is overridable through CT_OGE_LOCAL_OCR_CROP so production can be
 * corrected without a deploy.
 */
export const DEFAULT_OGE_LOCAL_OCR_CROP: OgeLocalOcrCrop = { x0: 380, y0: 380, x1: 3060, y1: 2480 };

/** A crop rectangle in 300-DPI pixel units of the rendered page. */
export interface OgeLocalOcrCrop {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// ---------------------------------------------------------------------------
// Settings (Infisical-backed; see INFISICAL.md)
// ---------------------------------------------------------------------------

export const OGE_LOCAL_OCR_ENABLED_KEY = 'CT_OGE_LOCAL_OCR';
export const OGE_LOCAL_OCR_MAX_PAGES_KEY = 'CT_OGE_LOCAL_OCR_MAX_PAGES';
export const OGE_LOCAL_OCR_MAX_SECONDS_KEY = 'CT_OGE_LOCAL_OCR_MAX_SECONDS';
export const OGE_LOCAL_OCR_CROP_KEY = 'CT_OGE_LOCAL_OCR_CROP';

/** Default page budget: the Trump scan (the motivating filing) has 34 pages. */
export const DEFAULT_OGE_LOCAL_OCR_MAX_PAGES = 40;
/**
 * Default wall-clock budget.  The pass runs inside a durable-queue lease
 * (10 min default), so it must fail closed well before the lease expires.
 */
export const DEFAULT_OGE_LOCAL_OCR_MAX_SECONDS = 420;

export interface OgeLocalOcrSettings {
  /** Master switch.  When off the pass is skipped and the filing parks as today. */
  enabled: boolean;
  /** Max pages rendered per filing. */
  maxPages: number;
  /** Wall-clock budget for the whole filing, in seconds. */
  maxSeconds: number;
  /** Table-body crop, or null to read the whole page. */
  crop: OgeLocalOcrCrop | null;
}

/** Parse the crop knob: "x0,y0,x1,y1" in 300-DPI px, or "full" for no crop. */
export function parseOgeLocalOcrCrop(raw: string | undefined | null): OgeLocalOcrCrop | null {
  if (raw === undefined || raw === null) return { ...DEFAULT_OGE_LOCAL_OCR_CROP };
  const value = raw.trim().toLowerCase();
  if (!value) return { ...DEFAULT_OGE_LOCAL_OCR_CROP };
  if (value === 'full' || value === 'none' || value === 'off') return null;
  const parts = value.split(',').map((p) => Number.parseInt(p.trim(), 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return { ...DEFAULT_OGE_LOCAL_OCR_CROP };
  }
  const [x0, y0, x1, y1] = parts;
  if (x1 <= x0 || y1 <= y0) return { ...DEFAULT_OGE_LOCAL_OCR_CROP };
  return { x0, y0, x1, y1 };
}

/** Read the OCR knobs from the Infisical-backed settings snapshot. */
export function ogeLocalOcrSettings(env: Env): OgeLocalOcrSettings {
  const fallback = env as unknown as Record<string, string | undefined>;
  const enabledRaw = readSetting(fallback, OGE_LOCAL_OCR_ENABLED_KEY);
  const enabled = enabledRaw === undefined || enabledRaw === ''
    ? true
    : ['1', 'true', 'yes', 'on'].includes(enabledRaw.trim().toLowerCase());
  const maxPagesRaw = readSetting(fallback, OGE_LOCAL_OCR_MAX_PAGES_KEY);
  const maxPages = maxPagesRaw ? Number.parseInt(maxPagesRaw, 10) : DEFAULT_OGE_LOCAL_OCR_MAX_PAGES;
  const maxSecondsRaw = readSetting(fallback, OGE_LOCAL_OCR_MAX_SECONDS_KEY);
  const maxSeconds = maxSecondsRaw
    ? Number.parseInt(maxSecondsRaw, 10)
    : DEFAULT_OGE_LOCAL_OCR_MAX_SECONDS;
  return {
    enabled,
    maxPages: Number.isFinite(maxPages) && maxPages > 0 ? maxPages : DEFAULT_OGE_LOCAL_OCR_MAX_PAGES,
    maxSeconds: Number.isFinite(maxSeconds) && maxSeconds > 0
      ? maxSeconds
      : DEFAULT_OGE_LOCAL_OCR_MAX_SECONDS,
    crop: parseOgeLocalOcrCrop(readSetting(fallback, OGE_LOCAL_OCR_CROP_KEY)),
  };
}

// ---------------------------------------------------------------------------
// Backend seam (the poppler/tesseract shell-out lives in ogeLocalOcrRuntime.ts)
// ---------------------------------------------------------------------------

/** One rendered + OCR'd page. */
export interface OgeLocalOcrPage {
  /** 1-based page number. */
  page: number;
  /** The OCR text of that page. */
  text: string;
}

/** Result of probing for the required binaries. */
export interface OgeLocalOcrProbe {
  ok: boolean;
  /** Why the pass cannot run (missing binary, probe failure, ...). */
  reason?: string;
  /** Versions reported by the binaries, for the run log. */
  pdftoppm?: string;
  tesseract?: string;
}

export interface OgeLocalOcrReadOptions {
  /** Render DPI. */
  dpi: number;
  /** Crop in 300-DPI px units, or null to read the whole page. */
  crop: OgeLocalOcrCrop | null;
  /** 1-based pages to read.  All pages when omitted. */
  pages?: number[];
  /** Hard cap on the number of pages rendered. */
  maxPages: number;
  /** Wall-clock budget for this read, in milliseconds. */
  timeoutMs?: number;
}

/**
 * The poppler/tesseract seam.  Tests inject a fake so CI never needs the
 * binaries; production uses the Deno backend.
 */
export interface OgeLocalOcrBackend {
  /** Check that pdftoppm and tesseract exist and run. */
  probe(): Promise<OgeLocalOcrProbe>;
  /** Render + OCR the requested pages. */
  readPages(pdf: ArrayBuffer, options: OgeLocalOcrReadOptions): Promise<OgeLocalOcrPage[]>;
}

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

/** A row as a single read saw it. */
export interface OgeLocalOcrReadRow {
  index: number | null;
  page: number;
  type: TxType;
  typeRaw: string;
  date: string;
  amountMin: number | null;
  amountMax: number | null;
  amountRaw: string;
  notification: string | null;
  raw: string;
  /** The parsed transaction (asset name, ticker, ...). */
  tx: ParsedTx;
}

/** A row that did not make it into the published set, with the reason why. */
export interface OgeLocalOcrUnreconciledRow {
  /** The "#" column value when both reads saw it. */
  index: number | null;
  /** The page the row was read from. */
  page: number | null;
  /** Why the row was dropped. */
  reason: string;
  /** What the 400 DPI read saw. */
  primary: OgeLocalOcrReadRow | null;
  /** What the 600 DPI read saw. */
  secondary: OgeLocalOcrReadRow | null;
}

/** Reasons a row can be dropped. */
export const OGE_LOCAL_OCR_REASONS = {
  missingInSecondary: 'missing_in_secondary_read',
  missingInPrimary: 'missing_in_primary_read',
  typeDisagreement: 'type_disagreement',
  dateDisagreement: 'date_disagreement',
  amountDisagreement: 'amount_disagreement',
  missingIndex: 'missing_row_index',
  duplicateIndex: 'duplicate_row_index',
  invalidType: 'invalid_type',
  invalidDate: 'invalid_date',
  invalidAmount: 'invalid_amount',
  nonCanonicalBracket: 'non_canonical_bracket',
  indexGap: 'index_gap',
} as const;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Turn one page of OCR text into rows.
 *
 * The row pattern is the 278-T one the text-layer parser already uses
 * (ogeText.ts) so both paths agree on what a row is: "#", description, type,
 * date, notification flag, amount.  A row whose leading "#" was not captured
 * is kept (with index null) so the caller can report it instead of silently
 * dropping it.
 */
export function parseOgeLocalOcrPage(page: number, text: string): OgeLocalOcrReadRow[] {
  const scanned = scanOgeRows(text);
  return scanned.rows.map((row) => toReadRow(page, row));
}

function toReadRow(page: number, row: OgeScannedRow): OgeLocalOcrReadRow {
  return {
    index: row.index,
    page,
    type: row.tx.txType,
    typeRaw: row.typeWord,
    date: row.tx.txDate ?? '',
    amountMin: row.tx.amountMin,
    amountMax: row.tx.amountMax,
    amountRaw: row.amountRaw,
    notification: row.notification,
    raw: row.rawText,
    tx: row.tx,
  };
}

/** True when the row has a usable type (B/S/E) and a real calendar date. */
export function ogeLocalOcrRowTypeIsValid(row: OgeLocalOcrReadRow): boolean {
  return row.type === 'B' || row.type === 'S' || row.type === 'E';
}

export function ogeLocalOcrRowDateIsValid(row: OgeLocalOcrReadRow): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(row.date);
}

/** True when the row's amount maps onto a canonical STOCK Act bracket. */
export function ogeLocalOcrRowBracketIsCanonical(row: OgeLocalOcrReadRow): boolean {
  if (row.amountMin === null) return false;
  return matchBracket(row.amountMin, row.amountMax) !== null;
}

/**
 * True when the row indexes run 1..N with no gaps.
 *
 * The index list must be unique and strictly increasing from 1 — a duplicated
 * or out-of-order index means the read merged or repeated a row, which is
 * exactly what must not be published.
 */
export function ogeLocalOcrIndexesAreContiguous(indexes: readonly number[]): boolean {
  if (indexes.length === 0) return false;
  const sorted = [...indexes].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i] !== i + 1) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface OgeLocalOcrReconciliation {
  /** Rows both reads agreed on. */
  rows: OgeLocalOcrReadRow[];
  /** Rows that did not reconcile, with the reason. */
  unreconciled: OgeLocalOcrUnreconciledRow[];
}

function sameAmount(a: OgeLocalOcrReadRow, b: OgeLocalOcrReadRow): boolean {
  return a.amountMin === b.amountMin && a.amountMax === b.amountMax;
}

/**
 * Keep only the rows both reads agree on.
 *
 * A row survives when the 400 DPI and the 600 DPI reads agree on the type,
 * the date and the amount.  Everything else is reported as unreconciled so
 * the park payload can list it.
 */
export function reconcileOgeLocalOcrReads(
  primary: readonly OgeLocalOcrReadRow[],
  secondary: readonly OgeLocalOcrReadRow[],
): OgeLocalOcrReconciliation {
  const rows: OgeLocalOcrReadRow[] = [];
  const unreconciled: OgeLocalOcrUnreconciledRow[] = [];
  // Group each read by row index.  An index seen twice in one read means the
  // read merged or repeated a row, so every row under that index is reported
  // instead of letting a Map silently keep the last one.
  const groupByIndex = (read: readonly OgeLocalOcrReadRow[]): Map<number, OgeLocalOcrReadRow[]> => {
    const grouped = new Map<number, OgeLocalOcrReadRow[]>();
    for (const row of read) {
      if (row.index === null) continue;
      const group = grouped.get(row.index);
      if (group) group.push(row);
      else grouped.set(row.index, [row]);
    }
    return grouped;
  };
  const primaryByIndex = groupByIndex(primary);
  const secondaryByIndex = groupByIndex(secondary);
  const indexes = [...new Set([...primaryByIndex.keys(), ...secondaryByIndex.keys()])].sort((a, b) => a - b);

  for (const index of indexes) {
    const pGroup = primaryByIndex.get(index) ?? [];
    const sGroup = secondaryByIndex.get(index) ?? [];
    if (pGroup.length > 1 || sGroup.length > 1) {
      unreconciled.push({
        index,
        page: (pGroup[0] ?? sGroup[0])?.page ?? null,
        reason: OGE_LOCAL_OCR_REASONS.duplicateIndex,
        primary: pGroup[0] ?? null,
        secondary: sGroup[0] ?? null,
      });
      continue;
    }
    const p = pGroup[0] ?? null;
    const s = sGroup[0] ?? null;
    if (!p || !s) {
      unreconciled.push({
        index,
        page: (p ?? s)?.page ?? null,
        reason: p ? OGE_LOCAL_OCR_REASONS.missingInSecondary : OGE_LOCAL_OCR_REASONS.missingInPrimary,
        primary: p,
        secondary: s,
      });
      continue;
    }
    if (p.type !== s.type) {
      unreconciled.push({
        index,
        page: p.page,
        reason: OGE_LOCAL_OCR_REASONS.typeDisagreement,
        primary: p,
        secondary: s,
      });
      continue;
    }
    if (p.date !== s.date) {
      unreconciled.push({
        index,
        page: p.page,
        reason: OGE_LOCAL_OCR_REASONS.dateDisagreement,
        primary: p,
        secondary: s,
      });
      continue;
    }
    if (!sameAmount(p, s)) {
      unreconciled.push({
        index,
        page: p.page,
        reason: OGE_LOCAL_OCR_REASONS.amountDisagreement,
        primary: p,
        secondary: s,
      });
      continue;
    }
    rows.push(p);
  }

  // A row whose "#" was never captured cannot be matched across reads.  It is
  // reported in its own read's slot rather than dropped, so the park payload
  // shows which read saw an unmatchable row.
  for (const row of primary) {
    if (row.index !== null) continue;
    unreconciled.push({
      index: null,
      page: row.page,
      reason: OGE_LOCAL_OCR_REASONS.missingIndex,
      primary: row,
      secondary: null,
    });
  }
  for (const row of secondary) {
    if (row.index !== null) continue;
    unreconciled.push({
      index: null,
      page: row.page,
      reason: OGE_LOCAL_OCR_REASONS.missingIndex,
      primary: null,
      secondary: row,
    });
  }

  return { rows, unreconciled };
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export interface OgeLocalOcrGate {
  ok: boolean;
  /** Why the set is not publishable. */
  reason?: string;
  /** The rows that survive the gate. */
  rows: OgeLocalOcrReadRow[];
  /** Rows dropped by the gate (invalid type/date/amount/bracket). */
  rejected: OgeLocalOcrUnreconciledRow[];
}

/**
 * The publication gate.
 *
 * A set is publishable only when every row is well formed (type B/S/E, real
 * date, canonical STOCK Act bracket) and the row numbers run 1..N with no
 * gaps.  Anything else parks the filing exactly as it does today.
 */
export function gateOgeLocalOcrRows(rows: readonly OgeLocalOcrReadRow[]): OgeLocalOcrGate {
  const rejected: OgeLocalOcrUnreconciledRow[] = [];
  const kept: OgeLocalOcrReadRow[] = [];
  for (const row of rows) {
    if (row.index === null) {
      rejected.push({
        index: null,
        page: row.page,
        reason: OGE_LOCAL_OCR_REASONS.missingIndex,
        primary: row,
        secondary: null,
      });
      continue;
    }
    if (!ogeLocalOcrRowTypeIsValid(row)) {
      rejected.push({
        index: row.index,
        page: row.page,
        reason: OGE_LOCAL_OCR_REASONS.invalidType,
        primary: row,
        secondary: null,
      });
      continue;
    }
    if (!ogeLocalOcrRowDateIsValid(row)) {
      rejected.push({
        index: row.index,
        page: row.page,
        reason: OGE_LOCAL_OCR_REASONS.invalidDate,
        primary: row,
        secondary: null,
      });
      continue;
    }
    if (row.amountMin === null) {
      rejected.push({
        index: row.index,
        page: row.page,
        reason: OGE_LOCAL_OCR_REASONS.invalidAmount,
        primary: row,
        secondary: null,
      });
      continue;
    }
    if (!ogeLocalOcrRowBracketIsCanonical(row)) {
      rejected.push({
        index: row.index,
        page: row.page,
        reason: OGE_LOCAL_OCR_REASONS.nonCanonicalBracket,
        primary: row,
        secondary: null,
      });
      continue;
    }
    kept.push(row);
  }

  if (kept.length === 0) {
    return { ok: false, reason: 'no_valid_rows', rows: [], rejected };
  }
  const indexes = kept.map((r) => r.index as number);
  if (!ogeLocalOcrIndexesAreContiguous(indexes)) {
    const missing: number[] = [];
    const present = new Set(indexes);
    const max = Math.max(...indexes);
    for (let i = 1; i <= max; i += 1) {
      if (!present.has(i)) missing.push(i);
    }
    for (const index of missing) {
      rejected.push({
        index,
        page: null,
        reason: OGE_LOCAL_OCR_REASONS.indexGap,
        primary: null,
        secondary: null,
      });
    }
    return { ok: false, reason: 'row_index_gap', rows: [], rejected };
  }
  return { ok: true, rows: kept, rejected };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface OgeLocalOcrRequest {
  docId: string;
  chamber: string;
  filingType: string | null;
  /** The stored PDF bytes. */
  bytes: ArrayBuffer | null;
}

export interface OgeLocalOcrDeps {
  backend?: OgeLocalOcrBackend;
  settings?: OgeLocalOcrSettings;
  now?: () => number;
}

export interface OgeLocalOcrSuccess {
  status: 'rows';
  /** The recovered rows, ready for normalize(). */
  rows: ParsedTx[];
  /** The page count that was rendered. */
  pages: number;
  /** True when the table-body crop was used for the whole document. */
  cropped: boolean;
  /** How many pages the pass rendered. */
  pagesRead: number;
}

export interface OgeLocalOcrPark {
  status: 'unreadable';
  /** Why the pass could not publish. */
  reason: string;
  /** How many pages the pass rendered. */
  pagesRead: number;
  /** True when the table-body crop was used. */
  cropped: boolean;
  /** The rows that did not reconcile, for the park payload. */
  unreconciled: OgeLocalOcrUnreconciledRow[];
}

export interface OgeLocalOcrSkip {
  status: 'skipped';
  /** Why the pass did not run (not a 278-T, disabled, no bytes, ...). */
  reason: string;
  pagesRead: number;
  unreconciled: OgeLocalOcrUnreconciledRow[];
}

export type OgeLocalOcrOutcome = OgeLocalOcrSuccess | OgeLocalOcrPark | OgeLocalOcrSkip;

/** True when the filing is an executive 278-T (the only form this pass reads). */
export function isOgeLocalOcrCandidate(filing: {
  chamber?: string | null;
  filingType?: string | null;
  docId?: string | null;
}): boolean {
  const chamber = (filing.chamber ?? '').trim().toLowerCase();
  if (chamber !== 'executive') return false;
  const filingType = (filing.filingType ?? '').trim().toLowerCase();
  // Annual and termination markers win over the 278-T match: '278-term'
  // contains '278-t' as a prefix (same precedence as executiveDisclosureForm
  // in ogeText.ts).
  if (
    filingType.includes('278term') || filingType.includes('278-term')
    || filingType.includes('278 term')
  ) return false;
  if (filingType.includes('278e') || filingType.includes('278-e')) return false;
  if (filingType === '278t' || filingType.includes('278-t')) return true;
  // Otherwise the doc id decides.  The watcher stores every filing —
  // executive 278-Ts included — with the generic filing_type 'P', which says
  // nothing about the OGE form, so a truthy but uninformative type must not
  // rule the filing out.  Executive 278-T ids end in '-278t':
  // E-2026-donald-j-trump-08-12-2026-278t.
  const docId = (filing.docId ?? '').trim().toLowerCase();
  return docId.endsWith('-278t');
}

function skip(reason: string): OgeLocalOcrSkip {
  return { status: 'skipped', reason, pagesRead: 0, unreconciled: [] };
}

/**
 * Run the local OCR pass for one filing.
 *
 * Returns `rows` only when the whole filing reconciled and passed the gate.
 * Any other outcome is a `park`: the caller parks the filing exactly as it
 * does today and puts `unreconciled` in the review payload.
 */
export async function attemptOgeLocalOcr(
  request: OgeLocalOcrRequest,
  deps: OgeLocalOcrDeps = {},
): Promise<OgeLocalOcrOutcome> {
  const settings = deps.settings ?? {
    enabled: true,
    maxPages: DEFAULT_OGE_LOCAL_OCR_MAX_PAGES,
    maxSeconds: DEFAULT_OGE_LOCAL_OCR_MAX_SECONDS,
    crop: { ...DEFAULT_OGE_LOCAL_OCR_CROP },
  };
  const now = deps.now ?? (() => Date.now());
  if (!settings.enabled) return skip('oge_local_ocr_disabled');
  if (!isOgeLocalOcrCandidate(request)) return skip('not_an_executive_278t');
  if (!request.bytes) return skip('no_pdf_bytes');

  const backend = deps.backend;
  if (!backend) return skip('no_backend');

  const probe = await backend.probe();
  if (!probe.ok) {
    // Fail closed: without the binaries the pass cannot run, so the filing
    // parks as it does today.  The reason is explicit so the park payload
    // says why no local attempt was made.
    return {
      status: 'unreadable',
      reason: `oge_local_ocr_unavailable: ${probe.reason ?? 'binaries_missing'}`,
      pagesRead: 0,
      cropped: false,
      unreconciled: [],
    };
  }

  const deadline = now() + settings.maxSeconds * 1000;
  const crop = settings.crop;
  const remaining = (): number => Math.max(1_000, deadline - now());

  // Read 1: the table-body crop at 400 DPI.
  const primaryCropped = await backend.readPages(request.bytes, {
    dpi: OGE_LOCAL_OCR_DPI_PRIMARY,
    crop,
    maxPages: settings.maxPages,
    timeoutMs: remaining(),
  });
  if (now() > deadline) {
    return {
      status: 'unreadable',
      reason: 'oge_local_ocr_budget_exhausted',
      pagesRead: primaryCropped.length,
      cropped: crop !== null,
      unreconciled: [],
    };
  }

  const primaryCroppedRows = primaryCropped.flatMap((p) => parseOgeLocalOcrPage(p.page, p.text));
  const croppedGate = gateOgeLocalOcrRows(primaryCroppedRows);

  // The crop hint is document-specific.  When the cropped read does not
  // produce a coherent table the crop does not fit this document (it clipped
  // the "#" or AMOUNT column), so re-read the pages uncropped before giving
  // up.  Verified against a real A4 278-T: the hint clipped both columns
  // there while the uncropped read recovered every row.
  let primaryPages = primaryCropped;
  let primaryRows = primaryCroppedRows;
  let cropped = crop !== null;
  if (crop !== null && !croppedGate.ok && now() <= deadline) {
    const uncropped = await backend.readPages(request.bytes, {
      dpi: OGE_LOCAL_OCR_DPI_PRIMARY,
      crop: null,
      maxPages: settings.maxPages,
      timeoutMs: remaining(),
    });
    const uncroppedRows = uncropped.flatMap((p) => parseOgeLocalOcrPage(p.page, p.text));
    const uncroppedGate = gateOgeLocalOcrRows(uncroppedRows);
    // Prefer the read that passed the gate.  When neither passed, keep the
    // read that found more rows: the unreconciled listing the park payload
    // carries is more useful when it starts from more evidence.
    if (uncroppedGate.ok || uncroppedRows.length > primaryRows.length) {
      primaryPages = uncropped;
      primaryRows = uncroppedRows;
      cropped = false;
    }
  }

  if (now() > deadline) {
    return {
      status: 'unreadable',
      reason: 'oge_local_ocr_budget_exhausted',
      pagesRead: primaryPages.length,
      cropped,
      unreconciled: [],
    };
  }

  // Read 2: the same crop at 600 DPI.  A row survives only when both reads
  // agree on type, date and amount.
  const secondaryPages = await backend.readPages(request.bytes, {
    dpi: OGE_LOCAL_OCR_DPI_SECONDARY,
    crop: cropped ? crop : null,
    maxPages: settings.maxPages,
    timeoutMs: remaining(),
  });
  const secondaryRows = secondaryPages.flatMap((p) => parseOgeLocalOcrPage(p.page, p.text));

  const reconciliation = reconcileOgeLocalOcrReads(primaryRows, secondaryRows);
  const gate = gateOgeLocalOcrRows(reconciliation.rows);
  const unreconciled = [...reconciliation.unreconciled, ...gate.rejected];
  const pagesRead = Math.max(primaryPages.length, secondaryPages.length);

  // A dropped trailing row leaves the survivors 1..N-1, which still look
  // contiguous — so the gate alone cannot tell a complete read from a
  // truncated one.  Any unreconciled or rejected row parks the filing.
  if (!gate.ok || unreconciled.length > 0) {
    return {
      status: 'unreadable',
      reason: `oge_local_ocr_${gate.reason ?? 'not_reconciled'}`,
      pagesRead,
      cropped,
      unreconciled,
    };
  }
  return {
    status: 'rows',
    rows: gate.rows.map((row) => row.tx),
    pages: pagesRead,
    cropped,
    pagesRead,
  };
}

/**
 * The park payload for a filing the local OCR pass could not reconcile.
 * Mirrors the review_queue payload shape the rest of the pipeline writes.
 */export function ogeLocalOcrReviewPayload(
  outcome: OgeLocalOcrOutcome,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    extractor: OGE_LOCAL_OCR_EXTRACTOR,
    transactionCount: outcome.status === 'rows' ? outcome.rows.length : 0,
    truncated: false,
  };
  if (outcome.status === 'skipped') {
    return { ...base, localOcr: { attempted: false, reason: outcome.reason }, ...extra };
  }
  if (outcome.status === 'rows') {
    return {
      ...base,
      localOcr: {
        attempted: true,
        reason: 'reconciled',
        pagesRead: outcome.pagesRead,
        cropped: outcome.cropped,
        unreconciled: [],
      },
      ...extra,
    };
  }
  return {
    ...base,
    localOcr: {
      attempted: true,
      reason: outcome.reason,
      pagesRead: outcome.pagesRead,
      cropped: outcome.cropped,
      unreconciled: outcome.unreconciled.slice(0, 200).map((row) => ({
        index: row.index,
        page: row.page,
        reason: row.reason,
        primary: row.primary
          ? {
            type: row.primary.type,
            date: row.primary.date,
            amountMin: row.primary.amountMin,
            amountMax: row.primary.amountMax,
            raw: row.primary.raw,
          }
          : null,
        secondary: row.secondary
          ? {
            type: row.secondary.type,
            date: row.secondary.date,
            amountMin: row.secondary.amountMin,
            amountMax: row.secondary.amountMax,
            raw: row.secondary.raw,
          }
          : null,
      })),
    },
    ...extra,
  };
}

/**
 * Run the local OCR pass when the deterministic OGE read refused the filing.
 *
 * Returns null when the pass does not apply (the filing has a text layer the
 * deterministic parser already read, it is not an executive 278-T, or the
 * feature is switched off).  Otherwise it returns the outcome, including the
 * `skipped` shape for "not applicable" cases the caller should not treat as
 * a failure.
 */
export async function maybeRecoverOgeRowsViaLocalOcr(
  env: Env,
  filing: {
    docId: string;
    chamber: string;
    filingType?: string | null;
  },
  bytes: ArrayBuffer | null,
  parseDisposition: string | undefined,
  deps: OgeLocalOcrDeps = {},
): Promise<OgeLocalOcrOutcome | null> {
  if (parseDisposition !== 'unreadable') return null;
  if (!isOgeLocalOcrCandidate(filing)) return null;
  const settings = deps.settings ?? ogeLocalOcrSettings(env);
  if (!settings.enabled) return null;
  const backend = deps.backend ?? defaultBackend();
  const outcome = await attemptOgeLocalOcr(
    {
      docId: filing.docId,
      chamber: filing.chamber,
      filingType: filing.filingType ?? null,
      bytes,
    },
    { ...deps, settings, backend },
  );
  return outcome;
}

/**
 * True when a local OCR attempt is already recorded on the filing's review
 * row: a park payload carries a `localOcr` section, while recovered rows
 * that landed in review as staged candidates carry the extractor id.  The agreement lane must not spend a second multi-minute OCR pass on
 * a filing the extraction pass already tried.
 */
export async function ogeLocalOcrAlreadyAttempted(env: Env, docId: string): Promise<boolean> {
  try {
    const row = await get<{ payload: string | null }>(
      env.DB,
      'SELECT payload FROM review_queue WHERE doc_id = ? LIMIT 1',
      [docId],
    );
    if (!row?.payload) return false;
    const parsed = JSON.parse(row.payload) as { localOcr?: unknown; extractor?: unknown };
    // A skipped pass records localOcr with attempted:false — that is not an
    // attempt, and the agreement lane must still be free to run a real retry.
    const localOcr = parsed?.localOcr as { attempted?: unknown } | null | undefined;
    const attempted = typeof localOcr === 'object' && localOcr !== null && localOcr.attempted === true;
    return attempted || parsed?.extractor === OGE_LOCAL_OCR_EXTRACTOR;
  } catch {
    // A read failure must not block the park; treat it as "not attempted".
    return false;
  }
}

/**
 * The production backend.  The runtime module only touches Deno APIs inside
 * functions, so importing it is safe under Node (the vitest suite) too.
 */
let defaultBackendCache: OgeLocalOcrBackend | null = null;
function defaultBackend(): OgeLocalOcrBackend {
  if (!defaultBackendCache) defaultBackendCache = denoLocalOcrBackend();
  return defaultBackendCache;
}
