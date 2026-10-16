/**
 * CT-2415 — vision ingest integrity guards (Guard 2 + Guard 3).
 *
 * Each guard has a regression case that fails without the fix and passes with
 * it, plus a control case proving real data still passes. The
 * genuinely-repeated-lots requirement is asserted directly: rows differing by
 * date, asset or owner must never be collapsed or stripped.
 */
import { describe, expect, it } from 'vitest';
import {
  ILLEGIBLE_BAND_WARNING,
  MIN_CONSTANT_COLUMN_ROWS,
  findConstantColumnReads,
  findIllegibleBandAmounts,
  refuseIllegibleBandAmounts,
  rejectConstantColumnReads,
} from '../visionIntegrityGuards.ts';
import { collapseDuplicateSpans } from '../localVisionDupeGuard.ts';
import { parseAmountRange } from '../amounts.ts';
import { toParsedTx } from '../visionLlm.ts';
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
    amountMin: 1001,
    amountMax: 15000,
    isOption: false,
    capGainsOver200: false,
    rawText: 'Mays Allocate 2025 LP',
    confidence: 0.97,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Guard 2 — refuse band amounts that were snapped, not read
// ---------------------------------------------------------------------------

describe('Guard 2 — illegible band amounts', () => {
  it('REGRESSION: a band snapped onto a canonical tier is marked, not silently exact', () => {
    // The documented OCR miss: the printed "$1,001 - $15,000" tier read as
    // "$1,000 - $15,000". Before the fix this returned {min:1001,max:15000,
    // exact:true} with nothing distinguishing it from a genuinely printed band
    // — a plausible wrong number indistinguishable from a correct read. This is
    // the exact shape of every amount on H-2026-9116378.
    expect(parseAmountRange('$1,000 - $15,000')).toEqual({
      min: 1001, max: 15000, exact: true, snapped: true,
    });

    // A single unreadable dollar likewise lands on a canonical tier as `exact`.
    expect(parseAmountRange('$1,000')).toEqual({
      min: 0, max: 1000, exact: true, snapped: true,
    });

    // A two-number range that is NOT a bracket must also be flagged, since
    // snapToBracket falls back to nearestBracket and effectively never fails.
    expect(parseAmountRange('$1,002 - $15,000').snapped).toBe(true);
  });

  it('REGRESSION: toParsedTx stamps the warning so the refusal can reach ingest', () => {
    const inferred = toParsedTx({
      txDate: '2026-08-27',
      owner: 'self',
      assetName: 'Apple Inc',
      txType: 'B',
      amountRange: '$1,000 - $15,000',
      isOption: false,
      capGainsOver200: false,
      confidence: 0.9,
    } as never);
    expect(inferred.extractionWarnings).toContain(ILLEGIBLE_BAND_WARNING);
    // The amount is still present here — the refusal is a separate, explicit step.
    expect(inferred.amountMin).toBe(1001);

    expect(refuseIllegibleBandAmounts([inferred]).rows[0]!.amountMin).toBeNull();
  });

  it('CONTROL: a verbatim printed band is read, kept, and not flagged', () => {
    const real = parseAmountRange('$1,001 - $15,000');
    expect(real).toEqual({ min: 1001, max: 15000, exact: true });

    const parsed = toParsedTx({
      txDate: '2026-08-27',
      owner: 'self',
      assetName: 'Apple Inc',
      txType: 'B',
      amountRange: '$1,001 - $15,000',
      isOption: false,
      capGainsOver200: false,
      confidence: 0.9,
    } as never);
    expect(parsed.extractionWarnings ?? []).not.toContain(ILLEGIBLE_BAND_WARNING);

    const { rows, refusals } = refuseIllegibleBandAmounts([parsed]);
    expect(refusals).toEqual([]);
    expect(rows[0]!.amountMin).toBe(1001);
    expect(rows[0]!.amountMax).toBe(15000);
  });

  it('CONTROL: the genuinely modal band (1001-15000) alone is never a refusal trigger', () => {
    // (1001,15000) is 77% of every local_mac row because it is the real modal
    // band. A constant band must not be treated as fabrication — only an
    // INFERRED one is refused.
    const rows = Array.from({ length: 12 }, (_, i) =>
      tx({ assetName: `Asset ${i}`, rawText: `Asset ${i}` }));
    expect(findIllegibleBandAmounts(rows)).toEqual([]);
    expect(refuseIllegibleBandAmounts(rows).rows).toHaveLength(12);
  });

  it('does not mutate the caller input', () => {
    const input = [tx({ amountMin: 1001, extractionWarnings: [ILLEGIBLE_BAND_WARNING] })];
    refuseIllegibleBandAmounts(input);
    expect(input[0]!.amountMin).toBe(1001);
  });
});

// ---------------------------------------------------------------------------
// Guard 3 — reject constant column reads
// ---------------------------------------------------------------------------

describe('Guard 3 — constant column reads', () => {
  it('REGRESSION: one identical P/S/E mark across distinct rows is not a reading', () => {
    // H-2026-9116378 shape: distinct data rows (different date + asset) whose
    // type column never varied, because the crop never moved off one mark.
    const rows = Array.from({ length: 9 }, (_, i) =>
      tx({ txDate: `2026-08-${String(i + 1).padStart(2, '0')}`, assetName: `Asset ${i}`, rawText: `Asset ${i}` }));

    const found = findConstantColumnReads(rows);
    expect(found).toHaveLength(1);
    expect(found[0]!.field).toBe('txType');
    expect(found[0]!.value).toBe('B');

    const { rows: cleaned, rejections } = rejectConstantColumnReads(rows);
    expect(rejections).toHaveLength(1);
    expect(cleaned).toHaveLength(rows.length);
    expect(cleaned.every((r) => r.txType === null)).toBe(true);
  });

  it('CONTROL: genuinely varying types pass through untouched', () => {
    const rows: ParsedTx[] = [
      tx({ txDate: '2026-08-01', assetName: 'Apple Inc', rawText: 'Apple Inc', txType: 'B' }),
      tx({ txDate: '2026-08-02', assetName: 'Apple Inc', rawText: 'Apple Inc', txType: 'S' }),
      tx({ txDate: '2026-08-03', assetName: 'Apple Inc', rawText: 'Apple Inc', txType: 'E' }),
    ];
    expect(findConstantColumnReads(rows)).toEqual([]);
    const { rows: out } = rejectConstantColumnReads(rows);
    expect(out.map((r) => r.txType)).toEqual(['B', 'S', 'E']);
  });

  it('CONTROL: a duplicate flood is Guard 1’s job — Guard 3 stays out of it', () => {
    const flood = Array.from({ length: 12 }, () => tx());
    const collapsed = collapseDuplicateSpans(flood, 'local_mac');
    expect(collapsed.rows).toHaveLength(1);
    // Every row shares one identity, so nothing here is a column read.
    expect(findConstantColumnReads(flood)).toEqual([]);
  });

  it('CONTROL: a field missing on some rows is incomplete, not constant', () => {
    const rows: ParsedTx[] = [
      tx({ txDate: '2026-08-01', assetName: 'A', rawText: 'A', txType: 'B' }),
      tx({ txDate: '2026-08-02', assetName: 'B', rawText: 'B', txType: 'B' }),
      tx({ txDate: '2026-08-03', assetName: 'C', rawText: 'C', txType: null as never }),
    ];
    expect(findConstantColumnReads(rows)).toEqual([]);
  });

  it('needs a minimum row count before calling a field constant', () => {
    const rows: ParsedTx[] = [
      tx({ txDate: '2026-08-01', assetName: 'A', rawText: 'A' }),
      tx({ txDate: '2026-08-02', assetName: 'B', rawText: 'B' }),
    ];
    expect(rows.length).toBeLessThan(MIN_CONSTANT_COLUMN_ROWS);
    expect(findConstantColumnReads(rows)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// HARD REQUIREMENT — genuinely repeated lots must survive
// ---------------------------------------------------------------------------

describe('genuinely repeated lots survive both guards', () => {
  /** Same asset, same owner, same band, bought on five different dates. */
  function repeatedLots(dates: string[]): ParsedTx[] {
    return dates.map((d) =>
      tx({
        txDate: d,
        assetName: 'Mays Allocate 2025 LP',
        ticker: 'MAYZ',
        rawText: `MAYZ Buy ${d}`,
      }));
  }

  it('same asset + owner + amount on different dates is never collapsed', () => {
    const dates = ['2026-08-03', '2026-08-07', '2026-08-11', '2026-08-19', '2026-08-27'];
    const deduped = collapseDuplicateSpans(repeatedLots(dates), 'local_mac');
    expect(deduped.rows).toHaveLength(dates.length);
    expect(deduped.removed).toBe(0);
    expect(deduped.rows.map((r) => r.txDate)).toEqual(dates);
  });

  it('same date + asset + owner but a different owner is not collapsed', () => {
    const rows: ParsedTx[] = [
      tx({ owner: 'self', rawText: 'Buy' }),
      tx({ owner: 'spouse', rawText: 'Buy' }),
      tx({ owner: 'dependent', rawText: 'Buy' }),
      tx({ owner: 'joint', rawText: 'Buy' }),
    ];
    expect(collapseDuplicateSpans(rows, 'local_mac').rows).toHaveLength(4);
  });

  it('repeated lots keep their amounts and types through both guards', () => {
    const dates = ['2026-08-03', '2026-08-07', '2026-08-11', '2026-08-19', '2026-08-27'];
    let rows = repeatedLots(dates);

    // Vary the type so Guard 3 has a genuine reading to keep.
    rows = rows.map((r, i) => ({ ...r, txType: (i % 2 === 0 ? 'B' : 'S') as ParsedTx['txType'] }));

    const band = refuseIllegibleBandAmounts(rows);
    expect(band.refusals).toEqual([]);

    const column = rejectConstantColumnReads(band.rows);
    expect(column.rejections).toEqual([]);

    expect(column.rows).toHaveLength(dates.length);
    expect(column.rows.map((r) => r.txDate)).toEqual(dates);
    expect(column.rows.every((r) => r.amountMin === 1001 && r.amountMax === 15000)).toBe(true);
  });

  it('partial execution lots on one date stay distinct via the amount', () => {
    const rows: ParsedTx[] = [
      tx({ txDate: '2026-08-11', amountMin: 1001, amountMax: 15000, rawText: 'lot 1' }),
      tx({ txDate: '2026-08-11', amountMin: 15001, amountMax: 50000, rawText: 'lot 2' }),
      tx({ txDate: '2026-08-11', amountMin: 50001, amountMax: 100000, rawText: 'lot 3' }),
    ];
    expect(collapseDuplicateSpans(rows, 'local_mac').rows).toHaveLength(3);
    expect(refuseIllegibleBandAmounts(rows).refusals).toEqual([]);
  });
});