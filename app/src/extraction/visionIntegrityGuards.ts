/**
 * Vision ingest integrity guards — CT-2415.
 *
 * Companion to `localVisionDupeGuard.ts` (Guard 1), which collapses a contiguous
 * run of byte-identical rows. That guard catches a row the extractor re-emitted.
 * These two catch the two decoder defects that survive it, both of which let a
 * scanned House PTR publish values nobody actually read.
 *
 * GUARD 2 — `refuseIllegibleBandAmounts`
 *   Scanned PTR amounts are CHECKBOX BANDS. When the band-to-dollar legend is
 *   not machine-legible at the render resolution, `parseAmountRange` does not
 *   fail: it SNAPS the approximate read onto a canonical STOCK Act tier and
 *   reports it with `exact: true`. A snapped bracket is byte-identical to a
 *   printed one, so the caller had no way to tell "$1,000" (legend unreadable,
 *   repaired to 1001-15000) from "$1,001 - $15,000" printed on the form. That is
 *   a plausible wrong number indistinguishable from a correct read, so this
 *   guard refuses it: the amount is dropped and the row carries `no_amount`
 *   downstream, which is the pipeline's existing route for an unread amount.
 *   `toParsedTx` stamps `band_amount_inferred` at the moment the snap happens.
 *
 * GUARD 3 — `rejectConstantColumnReads`
 *   A per-row field identical on every row is a CONSTANT, not a reading. On
 *   H-2026-9116378 the P/S/E type column yielded byte-identical ink at the same
 *   x on every page-1 data row (verified at 600dpi: only column 2 of the type
 *   triple carries ink, x3430-3465; the 20px borders at x3355-3374/3513/3654/3816
 *   were checked for border artifacts). A repeated parsed value is only a
 *   suspicion; retain it and hold the filing for review.
 *
 *   HONEST LIMIT, because it changes how far the guard should be trusted: from
 *   parsed JSON alone a constant VALUE cannot be told apart from a stale CROP,
 *   so legitimate all-Buy, all-Sell and all-Exchange filings also trip this.
 *   Preserve the original field and attach a hard review warning instead of
 *   clearing it: null would be normalized to Buy, corrupting review candidates.
 *   A human must check the source before confirming. Tightening this heuristic
 *   needs ink-level evidence that survives extraction.
 *

 * Neither guard ever collapses or drops a row, so genuinely repeated lots —
 * the same asset, owner and amount on different dates — always survive. That is
 * asserted directly in the tests.
 */
import type { ParsedTx } from '../shared/types.ts';

/**
 * Rows needed before a field being identical is treated as a constant read
 * rather than a coincidence of a two-row filing.
 */
export const MIN_CONSTANT_COLUMN_ROWS = 3;

/** Warning stamped by `toParsedTx` when a bracket was snapped, not printed. */
export const ILLEGIBLE_BAND_WARNING = 'band_amount_inferred';

// ---------------------------------------------------------------------------
// Guard 2 — refuse band-decoded amounts that were inferred, not read
// ---------------------------------------------------------------------------

export interface IllegibleBandAmount {
  /** Position in the submitted row list. */
  rowIndex: number;
  /** The inferred tier that is being refused. */
  amountMin: number;
  amountMax: number | null;
}

export interface IllegibleBandAmountResult {
  /** Rows with refused amounts cleared; input rows are never mutated. */
  rows: ParsedTx[];
  refusals: IllegibleBandAmount[];
}

function hasIllegibleBandWarning(row: ParsedTx): boolean {
  return (row.extractionWarnings ?? []).includes(ILLEGIBLE_BAND_WARNING);
}

/**
 * Rows whose amount bracket was snapped onto a canonical tier instead of
 * matched from the document. Empty when every amount was read verbatim.
 */
export function findIllegibleBandAmounts(rows: readonly ParsedTx[]): IllegibleBandAmount[] {
  const out: IllegibleBandAmount[] = [];
  rows.forEach((row, rowIndex) => {
    if (!hasIllegibleBandWarning(row)) return;
    if (row.amountMin === null || row.amountMin === undefined) return;
    out.push({ rowIndex, amountMin: row.amountMin, amountMax: row.amountMax ?? null });
  });
  return out;
}

/**
 * Drop every inferred band amount, leaving the amount unread rather than wrong.
 *
 * Rows are returned as new objects; the caller's array is untouched. A row with
 * no amount left is handled downstream exactly like one the extractor could
 * never read — flagged `no_amount`, held for review — so a single unread band
 * never publishes a fabricated dollar figure.
 */
export function refuseIllegibleBandAmounts(rows: readonly ParsedTx[]): IllegibleBandAmountResult {
  const refusals = findIllegibleBandAmounts(rows);
  if (refusals.length === 0) return { rows: rows.slice(), refusals };

  const refused = new Set(refusals.map((r) => r.rowIndex));
  return {
    rows: rows.map((row, rowIndex) =>
      refused.has(rowIndex)
        ? { ...row, amountMin: null, amountMax: null }
        : row),
    refusals,
  };
}

// ---------------------------------------------------------------------------
// Guard 3 — reject constant per-row column reads
// ---------------------------------------------------------------------------

/** Columns checked for suspicious repetition. Values are preserved for review. */
export const GUARDED_CONSTANT_COLUMNS = ['txType'] as const;

/** Suspicion, not proof of an incorrect value. Keep the original type for review. */
export const CONSTANT_COLUMN_WARNING = 'suspected_constant_tx_type';

export type GuardedConstantColumn = (typeof GUARDED_CONSTANT_COLUMNS)[number];

export interface ConstantColumnRejection {
  field: GuardedConstantColumn;
  /** The value that was identical on every row. */
  value: string;
  /** Positions of the affected rows in the submitted row list. */
  rowIndexes: number[];
}

export interface ConstantColumnResult {
  rows: ParsedTx[];
  rejections: ConstantColumnRejection[];
}

/**
 * Identity of a disclosure line, for the "rows are genuinely different" test.
 * Two rows that differ only because the extractor repeated one of them share an
 * identity — that is Guard 1's flood, not a constant column read.
 */
function rowIdentity(row: ParsedTx): string {
  return [
    row.txDate ?? '',
    row.owner ?? '',
    row.assetName ?? '',
    row.ticker ?? '',
  ].join('\u0000');
}

function columnValue(row: ParsedTx, field: GuardedConstantColumn): string | null {
  const raw = row[field];
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

/**
 * Find per-row columns whose value is identical on every row of a filing whose
 * rows are otherwise distinct.
 *
 * Requires all of:
 *  - at least MIN_CONSTANT_COLUMN_ROWS rows,
 *  - the field present and non-empty on EVERY row (a field that is merely
 *    missing on some rows is an incomplete read, not a constant),
 *  - one single value across all rows,
 *  - more than one distinct row identity, so a duplicate flood is left to
 *    Guard 1 and genuinely repeated lots are never touched.
 */
export function findConstantColumnReads(
  rows: readonly ParsedTx[],
  fields: readonly GuardedConstantColumn[] = GUARDED_CONSTANT_COLUMNS,
): ConstantColumnRejection[] {
  if (rows.length < MIN_CONSTANT_COLUMN_ROWS) return [];

  const identities = new Set(rows.map(rowIdentity));
  if (identities.size < 2) return [];

  const out: ConstantColumnRejection[] = [];
  for (const field of fields) {
    const values = rows.map((row) => columnValue(row, field));
    if (values.some((v) => v === null)) continue;
    const first = values[0]!;
    if (!values.every((v) => v === first)) continue;
    out.push({
      field,
      value: first,
      rowIndexes: rows.map((_, i) => i),
    });
  }
  return out;
}

/**
 * Mark a suspected constant column for review without changing its value.
 * Identical types can be legitimate. A hard warning holds the filing while the
 * original Sell/Exchange/Buy remains available for source-based confirmation.
 *
 * Rows are returned as new objects; the caller's array is untouched, and no row
 * is ever removed.
 */
export function rejectConstantColumnReads(
  rows: readonly ParsedTx[],
  fields: readonly GuardedConstantColumn[] = GUARDED_CONSTANT_COLUMNS,
): ConstantColumnResult {
  const rejections = findConstantColumnReads(rows, fields);
  if (rejections.length === 0) return { rows: rows.slice(), rejections };

  const byField = new Map<GuardedConstantColumn, Set<number>>();
  for (const rejection of rejections) {
    byField.set(rejection.field, new Set(rejection.rowIndexes));
  }
  return {
    rows: rows.map((row, rowIndex) => {
      let next = row;
      for (const [field, indexes] of byField) {
        if (!indexes.has(rowIndex)) continue;
        if (field === 'txType') {
          next = { ...next, extractionWarnings: [...new Set<NonNullable<ParsedTx["extractionWarnings"]>[number]>([
            ...(next.extractionWarnings ?? []), CONSTANT_COLUMN_WARNING,
          ])] };
        }
      }
      return next;
    }),
    rejections,
  };
}