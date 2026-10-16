import { describe, expect, it } from 'vitest';
import {
  DUPLICATE_RUN_THRESHOLD,
  collapseDuplicateSpans,
  findDuplicateSpanRun,
} from '../localVisionDupeGuard.ts';
import type { ParsedTx } from '../../shared/types.ts';

function tx(over: Partial<ParsedTx> = {}): ParsedTx {
  return {
    txDate: '2026-08-27',
    owner: 'spouse',
    assetName: 'Mays Allocate 2025 LP',
    ticker: null,
    assetType: null,
    assetTypeName: null,
    txType: 'B',
    amountMin: 1000,
    amountMax: 15000,
    isOption: false,
    capGainsOver200: false,
    rawText: 'Mays Allocate 2025 LP',
    confidence: 0.97,
    ...over,
  };
}

/** n rows that all normalize to the same fingerprint. */
function flood(n: number): ParsedTx[] {
  return Array.from({ length: n }, () => tx());
}

/** n rows that each normalize to their own fingerprint. */
function distinct(n: number): ParsedTx[] {
  return Array.from({ length: n }, (_, i) => tx({ assetName: `Asset ${i}`, rawText: `Asset ${i}` }));
}

describe('findDuplicateSpanRun', () => {
  it('returns null for an empty or single-row set', () => {
    expect(findDuplicateSpanRun([], 'local_mac')).toBeNull();
    expect(findDuplicateSpanRun([tx()], 'local_mac')).toBeNull();
  });

  it('finds the contiguous run and reports its bounds', () => {
    const rows = [...distinct(3), ...flood(5)];
    const run = findDuplicateSpanRun(rows, 'local_mac');
    expect(run).not.toBeNull();
    expect(run!.count).toBe(5);
    expect(run!.firstIndex).toBe(3);
    expect(run!.lastIndex).toBe(7);
    expect(run!.collapsed).toBe(4);
  });

  it('reports null when repeats exist but are not adjacent', () => {
    // same asset at rows 0 and 2, separated by a different one
    const rows = [tx({ assetName: 'A', rawText: 'A' }), tx({ assetName: 'B', rawText: 'B' }), tx({ assetName: 'A', rawText: 'A' })];
    expect(findDuplicateSpanRun(rows, 'local_mac')).toBeNull();
  });
});

describe('collapseDuplicateSpans', () => {
  it('collapses a long contiguous flood to a single row', () => {
    const result = collapseDuplicateSpans(flood(251), 'local_mac');
    expect(result.rows).toHaveLength(1);
    expect(result.removed).toBe(250);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]!.count).toBe(251);
  });

  it('reproduces H-2026-9116378: 286 rows in, 36 kept, 250 duplicates dropped', () => {
    // Faithful to the real payload: 35 distinct content hashes, of which one
    // (3696f757) covers 251 contiguous rows and another covers a pair.
    // 33 singles + 1 pair + 251 flood = 286 rows, 35 distinct hashes.
    const singles = distinct(33);
    const pair = [tx({ assetName: 'Pair A', rawText: 'Pair A' }), tx({ assetName: 'Pair A', rawText: 'Pair A' })];
    const rows = [...singles, ...pair, ...flood(251)];
    expect(rows).toHaveLength(286);

    const result = collapseDuplicateSpans(rows, 'local_mac');
    // 33 singles + BOTH pair rows + 1 from the flood. The pair is under the
    // threshold, so it survives on purpose -- an adjacent repeat may be genuine.
    expect(result.rows).toHaveLength(36);
    expect(result.removed).toBe(250);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]!.count).toBe(251);
    // every distinct row survives untouched
    expect(result.rows.slice(0, 33).map((r) => r.assetName)).toEqual(singles.map((r) => r.assetName));
  });

  it('keeps short adjacent repeats -- a filing may disclose the same trade twice', () => {
    const rows = [...distinct(2), ...flood(DUPLICATE_RUN_THRESHOLD)];
    const result = collapseDuplicateSpans(rows, 'local_mac');
    expect(result.rows).toHaveLength(5);
    expect(result.removed).toBe(0);
    expect(result.runs).toEqual([]);
  });

  it('leaves non-adjacent repeats alone', () => {
    const rows = [tx({ assetName: 'A', rawText: 'A' }), tx({ assetName: 'B', rawText: 'B' }), tx({ assetName: 'A', rawText: 'A' })];
    const result = collapseDuplicateSpans(rows, 'local_mac');
    expect(result.rows).toHaveLength(3);
    expect(result.removed).toBe(0);
  });

  it('passes a fully distinct set through untouched', () => {
    const rows = distinct(40);
    const result = collapseDuplicateSpans(rows, 'local_mac');
    expect(result.rows).toHaveLength(40);
    expect(result.removed).toBe(0);
  });

  it('collapses only the qualifying runs when several exist', () => {
    const rows = [...flood(9), ...distinct(4), ...flood(6)];
    const result = collapseDuplicateSpans(rows, 'local_mac');
    expect(result.rows).toHaveLength(6); // 1 + 4 + 1
    expect(result.removed).toBe(13); // 8 + 5
    expect(result.runs).toHaveLength(2);
    expect(result.runs[0]!.count).toBe(9);
  });

  it('handles empty and single-row sets', () => {
    expect(collapseDuplicateSpans([], 'local_mac')).toEqual({ rows: [], runs: [], removed: 0 });
    const one = collapseDuplicateSpans([tx()], 'local_mac');
    expect(one.rows).toHaveLength(1);
    expect(one.removed).toBe(0);
  });

  it('keys on content, so a changed amount breaks the run', () => {
    const rows = [...flood(10), tx({ amountMin: 250001, amountMax: 1000000 })];
    const result = collapseDuplicateSpans(rows, 'local_mac');
    // 10 identical -> 1, plus the changed row kept
    expect(result.rows).toHaveLength(2);
    expect(result.removed).toBe(9);
  });
});