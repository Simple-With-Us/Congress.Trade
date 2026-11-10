import { describe, it, expect } from 'vitest';
import {
  buildConsensusRows,
  type AmountBracket,
  type ConsensusFieldName,
  type ConsensusRun,
} from '../consensus.ts';
import type { ParsedTx } from '../../shared/types.ts';

/** Build a ParsedTx with sensible defaults, overridable per-field. */
function tx(over: Partial<ParsedTx> = {}): ParsedTx {
  return {
    txDate: '2026-01-15',
    owner: 'self',
    assetName: 'Apple Inc',
    ticker: 'AAPL',
    assetType: 'ST',
    txType: 'B',
    amountMin: 15000,
    amountMax: 50000,
    isOption: false,
    capGainsOver200: false,
    rawText: 'row',
    confidence: 0.9,
    ...over,
  } as ParsedTx;
}

function run(model: string, rows: ParsedTx[]): ConsensusRun {
  return { model, rows };
}

describe('buildConsensusRows', () => {
  it('marks a row unanimous when all 3 models agree on every field', () => {
    const runs = [run('m1', [tx()]), run('m2', [tx()]), run('m3', [tx()])];
    const { rows, summary } = buildConsensusRows(runs);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.rowConsensus).toBe('unanimous');
    expect(row.presentIn).toEqual(['m1', 'm2', 'm3']);
    expect(row.missingFrom).toEqual([]);
    for (const field of [
      'txType',
      'transactionDate',
      'owner',
      'assetName',
      'ticker',
      'assetType',
      'assetTypeName',
      'isOption',
      'capGainsOver200',
      'filingStatus',
      'subholding',
      'location',
      'description',
      'supplementalText',
      'amount',
    ] satisfies ConsensusFieldName[]) {
      expect(row.fields[field].unanimous).toBe(true);
      expect(row.fields[field].votes).toBe(3);
      expect(row.fields[field].total).toBe(3);
      expect(row.fields[field].dissenters).toEqual([]);
    }
    expect(row.fields.amount.value).toEqual({ amountMin: 15000, amountMax: 50000 });
    expect(summary.rowsUnanimous).toBe(1);
    expect(summary.rowsMajority).toBe(0);
    expect(summary.rowsContested).toBe(0);
    expect(summary.models).toEqual(['m1', 'm2', 'm3']);
    expect(summary.perFieldAgreementPct.ticker).toBe(100);
  });

  it('picks the 2-of-3 majority value per field and records the dissenter', () => {
    // owner differs on m3; the row key (ticker|date|type) is identical, so the
    // three readings reconcile onto one row and owner is voted 2-1.
    const runs = [
      run('m1', [tx({ owner: 'self' })]),
      run('m2', [tx({ owner: 'self' })]),
      run('m3', [tx({ owner: 'spouse' })]),
    ];
    const { rows, summary } = buildConsensusRows(runs);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.rowConsensus).toBe('majority');
    const owner = row.fields.owner;
    expect(owner.value).toBe('self');
    expect(owner.votes).toBe(2);
    expect(owner.total).toBe(3);
    expect(owner.unanimous).toBe(false);
    expect(owner.dissenters).toEqual([{ model: 'm3', value: 'spouse' }]);
    // Fields everyone agreed on stay unanimous.
    expect(row.fields.assetName.unanimous).toBe(true);
    expect(summary.rowsMajority).toBe(1);
    // One lot per ticker|date|type: owner stays a voted field, and the key
    // stays the historical 3-part form so stored keys still match.
    expect(row.baseRowKey).toBe('AAPL|2026-01-15|B');
  });

  it('keeps same-day lots for different owners as separate rows', () => {
    const spouse = tx({ ticker: 'COO', owner: 'spouse', txDate: '2026-09-11', amountMin: 1001, amountMax: 15000 });
    const dependent = tx({ ticker: 'COO', owner: 'dependent', txDate: '2026-09-11', amountMin: 15001, amountMax: 50000 });
    const { rows } = buildConsensusRows([
      run('m1', [spouse, dependent]),
      run('m2', [dependent, spouse]),
    ]);
    expect(rows.map((row) => row.baseRowKey).sort()).toEqual([
      'COO|2026-09-11|B|DEPENDENT',
      'COO|2026-09-11|B|SPOUSE',
    ]);
    expect(rows.every((row) => row.rowConsensus === 'unanimous')).toBe(true);
    const byOwner = Object.fromEntries(rows.map((row) => [row.fields.owner.value, row.fields.amount.value]));
    expect(byOwner.spouse).toEqual({ amountMin: 1001, amountMax: 15000 });
    expect(byOwner.dependent).toEqual({ amountMin: 15001, amountMax: 50000 });
  });

  it('marks a field contested on a 1-1 tie and nulls the value', () => {
    const runs = [
      run('m1', [tx({ assetName: 'Apple Inc' })]),
      run('m2', [tx({ assetName: 'Microsoft Corp', ticker: 'AAPL' })]),
    ];
    // Same rowKey (ticker AAPL, same date/type) but assetName differs 1-1.
    const { rows } = buildConsensusRows(runs);
    expect(rows).toHaveLength(1);
    const name = rows[0].fields.assetName;
    expect(name.value).toBeNull();
    expect(name.votes).toBe(1);
    expect(name.total).toBe(2);
    expect(name.unanimous).toBe(false);
    // All competing values listed when contested.
    expect(name.dissenters).toEqual([
      { model: 'm1', value: 'Apple Inc.' },
      { model: 'm2', value: 'Microsoft Corp.' },
    ]);
    expect(rows[0].rowConsensus).toBe('contested');
  });

  it('accepts a unique 2-of-5 plurality on assetName', () => {
    const runs = [
      run('m1', [tx({ assetName: 'Treasury Bill 3-Month' })]),
      run('m2', [tx({ assetName: 'Treasury Bill 3-Month' })]),
      run('m3', [tx({ assetName: 'T-Bill 3 mo' })]),
      run('m4', [tx({ assetName: 'US T Bill' })]),
      run('m5', [tx({ assetName: 'Treas Bill' })]),
    ];
    const { rows, summary } = buildConsensusRows(runs);
    expect(rows).toHaveLength(1);
    const name = rows[0].fields.assetName;
    expect(name.value).toBe('Treasury Bill 3-Month');
    expect(name.votes).toBe(2);
    expect(name.total).toBe(5);
    expect(rows[0].rowConsensus).toBe('majority');
    expect(summary.rowsMajority).toBe(1);
  });

  it('collapses a House GS ticker onto the same T-bill row', () => {
    const runs = [
      run('m1', [tx({
        ticker: 'GS',
        assetName: 'Treasury Bill (3-Month, Matures 5/1/2025)',
        assetType: 'GS',
      })]),
      run('m2', [tx({
        ticker: null,
        assetName: 'Treasury Bill (3-Month, Matures 5/1/2025)',
        assetType: 'GS',
      })]),
      run('m3', [tx({
        ticker: null,
        assetName: 'Treasury Bill (3-Month, Matures 5/1/2025)',
        assetType: 'GS',
      })]),
    ];
    const { rows } = buildConsensusRows(runs);
    expect(rows).toHaveLength(1);
    expect(rows[0].rowConsensus).not.toBe('contested');
    expect(rows[0].fields.ticker.value).toBeNull();
    expect(rows[0].presentIn).toHaveLength(3);
  });

  it('marks a field contested on a 2-2 tie', () => {
    const runs = [
      run('m1', [tx({ owner: 'self' })]),
      run('m2', [tx({ owner: 'self' })]),
      run('m3', [tx({ owner: 'spouse' })]),
      run('m4', [tx({ owner: 'spouse' })]),
    ];
    const { rows } = buildConsensusRows(runs);
    const owner = rows[0].fields.owner;
    expect(owner.value).toBeNull();
    expect(owner.votes).toBe(2);
    expect(owner.total).toBe(4);
    expect(rows[0].rowConsensus).toBe('contested');
  });

  it('votes the amount bracket as one unit (never mixing mins and maxes)', () => {
    // 2 models: 15k-50k, 1 model: 50k-100k. Majority bracket = 15k-50k.
    const runs = [
      run('m1', [tx({ amountMin: 15000, amountMax: 50000 })]),
      run('m2', [tx({ amountMin: 15000, amountMax: 50000 })]),
      run('m3', [tx({ amountMin: 50000, amountMax: 100000 })]),
    ];
    const { rows } = buildConsensusRows(runs);
    const amount = rows[0].fields.amount;
    expect(amount.value).toEqual({ amountMin: 15000, amountMax: 50000 });
    expect(amount.votes).toBe(2);
    expect(amount.total).toBe(3);
    expect(amount.dissenters).toEqual([
      { model: 'm3', value: { amountMin: 50000, amountMax: 100000 } },
    ]);
    // The winning bracket keeps min & max paired — the 50000 from m3's MIN never
    // combines with a max from another model.
    const bracket = amount.value as AmountBracket;
    expect(bracket.amountMin).toBe(15000);
    expect(bracket.amountMax).toBe(50000);
  });

  it('never mixes a min from one model with a max from another on a full tie', () => {
    // Cross-mixing would yield 15k-100k or 50k-50k; correct behaviour: contested.
    const runs = [
      run('m1', [tx({ amountMin: 15000, amountMax: 50000 })]),
      run('m2', [tx({ amountMin: 50000, amountMax: 100000 })]),
    ];
    const { rows } = buildConsensusRows(runs);
    const amount = rows[0].fields.amount;
    expect(amount.value).toBeNull();
    expect(amount.dissenters).toEqual([
      { model: 'm1', value: { amountMin: 15000, amountMax: 50000 } },
      { model: 'm2', value: { amountMin: 50000, amountMax: 100000 } },
    ]);
  });

  it('reports presentIn/missingFrom and does not call a partially-seen row unanimous', () => {
    const runs = [
      run('m1', [tx()]),
      run('m2', [tx()]),
      run('m3', []), // m3 missed this row entirely
    ];
    const { rows } = buildConsensusRows(runs);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.presentIn).toEqual(['m1', 'm2']);
    expect(row.missingFrom).toEqual(['m3']);
    // Present in a majority (2 of 3) and fields agree among present -> majority,
    // NOT unanimous (m3 never saw it).
    expect(row.rowConsensus).toBe('majority');
    expect(row.fields.owner.total).toBe(2);
    expect(row.fields.owner.unanimous).toBe(true);
  });

  it('contests a row seen by only a minority of models', () => {
    const runs = [
      run('m1', [tx()]),
      run('m2', []),
      run('m3', []),
    ];
    const { rows } = buildConsensusRows(runs);
    const row = rows[0];
    expect(row.presentIn).toEqual(['m1']);
    expect(row.missingFrom).toEqual(['m2', 'm3']);
    // Only 1 of 3 saw it -> not authoritative -> contested even though its
    // single reading is internally "unanimous".
    expect(row.rowConsensus).toBe('contested');
  });

  it('preserves duplicate lots with the same ticker/date/type/owner as separate occurrences', () => {
    // Two real disclosure lots may share an owner-qualified arbitration key
    // while carrying different brackets/details. Neither may be collapsed.
    const lot1 = tx({ amountMin: 1001, amountMax: 15000, description: 'Lot one' });
    const lot2 = tx({ amountMin: 15001, amountMax: 50000, description: 'Lot two' });
    const runs = [
      run('m1', [lot1, lot2]),
      run('m2', [lot1, lot2]),
    ];
    const { rows } = buildConsensusRows(runs);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.rowKey)).toEqual([
      'AAPL|2026-01-15|B|SELF#1',
      'AAPL|2026-01-15|B|SELF#2',
    ]);
    expect(rows.map((row) => row.baseRowKey)).toEqual([
      'AAPL|2026-01-15|B|SELF',
      'AAPL|2026-01-15|B|SELF',
    ]);
    expect(rows.map((row) => row.occurrence)).toEqual([1, 2]);
    expect(rows[0].fields.amount.value).toEqual({ amountMin: 1001, amountMax: 15000 });
    expect(rows[1].fields.amount.value).toEqual({ amountMin: 15001, amountMax: 50000 });
    expect(rows[0].fields.description.value).toBe('Lot one');
    expect(rows[1].fields.description.value).toBe('Lot two');
    // Occurrence order is not a trustworthy cross-model lot identity. Preserve
    // both rows for review, but never label a duplicate-key group safe to apply.
    expect(rows.every((row) => row.rowConsensus === 'contested')).toBe(true);
  });

  it('fails closed when a majority of models reverse same-key duplicate lots', () => {
    const lot1 = tx({ amountMin: 1001, amountMax: 15000, description: 'Lot one' });
    const lot2 = tx({ amountMin: 15001, amountMax: 50000, description: 'Lot two' });
    const { rows } = buildConsensusRows([
      run('m1', [lot1, lot2]),
      run('m2', [lot2, lot1]),
      run('m3', [lot2, lot1]),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.rowConsensus === 'contested')).toBe(true);
  });

  it('votes option, asset, cap-gains, and structured-detail fields explicitly', () => {
    const majority = tx({
      assetType: 'OP',
      assetTypeName: 'Stock Option',
      isOption: true,
      capGainsOver200: true,
      filingStatus: 'N',
      subholding: 'Brokerage A',
      location: 'Delaware',
      description: 'Call option',
      supplementalText: 'Expires 2027-01-15',
    });
    const runs = [
      run('m1', [majority]),
      run('m2', [majority]),
      run('m3', [tx({ description: 'Equity', supplementalText: null })]),
    ];

    const [row] = buildConsensusRows(runs).rows;
    expect(row.fields.assetType).toMatchObject({ value: 'OP', votes: 2, total: 3 });
    expect(row.fields.assetTypeName).toMatchObject({ value: 'Stock Option', votes: 2, total: 3 });
    expect(row.fields.isOption).toMatchObject({ value: true, votes: 2, total: 3 });
    expect(row.fields.capGainsOver200).toMatchObject({ value: true, votes: 2, total: 3 });
    expect(row.fields.filingStatus.value).toBe('N');
    expect(row.fields.subholding.value).toBe('Brokerage A');
    expect(row.fields.location.value).toBe('Delaware');
    expect(row.fields.description).toMatchObject({ value: 'Call option', votes: 2 });
    expect(row.fields.supplementalText).toMatchObject({ value: 'Expires 2027-01-15', votes: 2 });
    expect(row.rowConsensus).toBe('majority');
  });

  it('does not double-count a duplicate model id into a false majority', () => {
    // Two runs share the id "X" (a misconfigured lineup naming one model twice).
    // "X" is the only reader that saw GOOG; it must not corroborate itself into
    // a majority. The electorate collapses to the DISTINCT ids {X, Y}.
    const runs = [
      run('X', [tx({ ticker: 'AAPL', assetName: 'Apple Inc' })]),
      run('Y', [tx({ ticker: 'AAPL', assetName: 'Apple Inc' })]),
      run('X', [tx({ ticker: 'AAPL', assetName: 'Apple Inc' }), tx({ ticker: 'GOOG', assetName: 'Alphabet' })]),
    ];
    const { rows, summary } = buildConsensusRows(runs);

    expect(summary.models).toEqual(['X', 'Y']); // distinct electorate, not [X, X, Y]
    const goog = rows.find((r) => r.rowKey.startsWith('GOOG|'))!;
    // Seen by ONE distinct model → minority presence → contested, not majority.
    expect(goog.presentIn).toEqual(['X']);
    expect(goog.rowConsensus).toBe('contested');
    expect(goog.fields.ticker.total).toBe(1); // not double-counted to 2
  });

  it('emits rows deterministically sorted by row key', () => {
    // Three distinct row keys fed in a jumbled order; output must be sorted.
    const rowA = tx({ ticker: 'AAAA', assetName: 'Alpha' });
    const rowM = tx({ ticker: 'MMMM', assetName: 'Mid' });
    const rowZ = tx({ ticker: 'ZZZZ', assetName: 'Zeta' });
    const runs = [
      run('m1', [rowZ, rowA, rowM]),
      run('m2', [rowM, rowZ, rowA]),
    ];
    const { rows } = buildConsensusRows(runs);
    const keys = rows.map((r) => r.rowKey);
    expect(keys).toEqual([...keys].sort());
    // The keys are the ticker-led row keys, so alphabetical by ticker prefix.
    expect(keys[0].startsWith('AAAA|')).toBe(true);
    expect(keys[2].startsWith('ZZZZ|')).toBe(true);
  });

  it('handles models that returned zero rows and an empty run list', () => {
    expect(buildConsensusRows([]).rows).toEqual([]);
    expect(buildConsensusRows([]).summary.models).toEqual([]);

    const runs = [run('m1', []), run('m2', [])];
    const { rows, summary } = buildConsensusRows(runs);
    expect(rows).toEqual([]);
    expect(summary.models).toEqual(['m1', 'm2']);
    expect(summary.perFieldAgreementPct.amount).toBe(0);
  });

  it('does not allow null/placeholder amounts to defeat a valid extraction (#2364)', () => {
    const valid = tx({ amountMin: 1001, amountMax: 15000 });
    const nullAmount1 = tx({ amountMin: null, amountMax: null });
    const nullAmount2 = tx({ amountMin: null, amountMax: null });
    const runs = [
      run('m1', [valid]),
      run('m2', [nullAmount1]),
      run('m3', [nullAmount2]),
    ];
    const { rows } = buildConsensusRows(runs);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.fields.amount.value).toEqual({ amountMin: 1001, amountMax: 15000 });
    expect(row.fields.amount.votes).toBe(1);
    expect(row.fields.amount.total).toBe(1);
    expect(row.rowConsensus).toBe('majority');
  });
});
