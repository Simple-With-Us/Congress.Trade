/**
 * Duplicate-span guard for POST /ingest-local-vision.
 *
 * `transactionRowKey` builds `v1:<source>:<rowIndex>:<fnv1a32(payload)>`, so two
 * rows carrying the SAME fourth segment are byte-identical once normalized --
 * including `rawText`, which is part of the fingerprint. Two genuinely distinct
 * disclosure lines on separate rows of a table cannot normalize to the same
 * fingerprint, so a long run of one hash is the extractor re-emitting a row, not
 * a filing disclosing the same thing many times.
 *
 * The row index exists precisely to keep legitimate repeated disclosures
 * distinct (see transactionRowKey's doc comment), so this guard does NOT collapse
 * every repeat. It collapses only a CONTIGUOUS run longer than
 * DUPLICATE_RUN_THRESHOLD, and it leaves short and non-adjacent repeats alone.
 *
 * Why this exists: H-2026-9116378 (McCaul PTR) was accepted with 286 rows of
 * which 251 were the same row at contiguous rowIndex 35..285 with no gap -- one
 * real trade fanned out over 251 keys. Nothing in the ingest path collapsed it,
 * so the flood sat in the review payload ready to publish on any confirm.
 */
import { transactionRowKey } from './normalizer.ts';
import type { ParsedTx, TxSource } from '../shared/types.ts';

/**
 * Runs of this length or longer collapse to their first row. Set above any
 * plausible genuine repeat (same security, same day, same bracket, adjacent
 * lines) and far below the 251 seen in the wild.
 */
export const DUPLICATE_RUN_THRESHOLD = 3;

export interface DuplicateSpanRun {
  /** Fourth rowKey segment shared by the whole run. */
  contentHash: string;
  /** How many rows carried it. */
  count: number;
  /** Inclusive rowIndex bounds of the contiguous run. */
  firstIndex: number;
  lastIndex: number;
  /** Distinct rows remaining after the run collapses to one. */
  collapsed: number;
}

function contentHashOf(row: ParsedTx, source: TxSource, index: number): string {
  const rowKey = transactionRowKey(source, index, row);
  const hash = rowKey.split(':').pop() ?? '';
  return hash;
}

/** Longest contiguous run of one content hash, or null when there is none. */
export function findDuplicateSpanRun(
  rows: readonly ParsedTx[],
  source: TxSource,
): DuplicateSpanRun | null {
  if (rows.length < 2) return null;
  let best: DuplicateSpanRun | null = null;
  let runHash = contentHashOf(rows[0]!, source, 0);
  let runStart = 0;

  const closeRun = (endIndex: number) => {
    const count = endIndex - runStart + 1;
    if (count > 1 && (!best || count > best.count)) {
      best = { contentHash: runHash, count, firstIndex: runStart, lastIndex: endIndex, collapsed: count - 1 };
    }
  };

  for (let i = 1; i < rows.length; i += 1) {
    const hash = contentHashOf(rows[i]!, source, i);
    if (hash !== runHash) {
      closeRun(i - 1);
      runHash = hash;
      runStart = i;
    }
  }
  closeRun(rows.length - 1);
  return best;
}

export interface CollapsedDuplicateSpans {
  rows: ParsedTx[];
  /** Every collapsed run, largest first, for the submit response + review note. */
  runs: DuplicateSpanRun[];
  /** Rows removed across all runs. */
  removed: number;
}

/**
 * Drop contiguous duplicate runs longer than `threshold`, keeping the first row of
 * each. Returns the input untouched when nothing qualifies.
 */
export function collapseDuplicateSpans(
  rows: readonly ParsedTx[],
  source: TxSource,
  threshold: number = DUPLICATE_RUN_THRESHOLD,
): CollapsedDuplicateSpans {
  if (rows.length < 2) return { rows: [...rows], runs: [], removed: 0 };

  const runs: DuplicateSpanRun[] = [];
  const kept: ParsedTx[] = [];
  let runHash = contentHashOf(rows[0]!, source, 0);
  let runStart = 0;

  const closeRun = (endIndex: number) => {
    const count = endIndex - runStart + 1;
    if (count > threshold) {
      // Over threshold: keep the first row, drop the rest of the run.
      kept.push(rows[runStart]!);
      runs.push({
        contentHash: runHash,
        count,
        firstIndex: runStart,
        lastIndex: endIndex,
        collapsed: count - 1,
      });
    } else {
      // At or under threshold: a filing may legitimately disclose the same trade
      // on adjacent lines, so every row survives.
      for (let k = runStart; k <= endIndex; k += 1) kept.push(rows[k]!);
    }
  };

  for (let i = 1; i < rows.length; i += 1) {
    const hash = contentHashOf(rows[i]!, source, i);
    if (hash !== runHash) {
      closeRun(i - 1);
      runHash = hash;
      runStart = i;
    }
  }
  closeRun(rows.length - 1);

  return {
    rows: kept,
    runs: runs.sort((a, b) => b.count - a.count),
    removed: runs.reduce((n, r) => n + r.collapsed, 0),
  };
}