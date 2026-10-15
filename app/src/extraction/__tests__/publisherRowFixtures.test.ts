import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildMajorityRows } from '../agreement.ts';
import type { CandidateDocResult } from '../bakeoff.ts';
import { dropPtrFormSampleParsedRows } from '../extractRouting.ts';
import type { ParsedTx } from '../../shared/types.ts';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../__fixtures__');

function tx(over: Partial<ParsedTx> = {}): ParsedTx {
  return {
    txDate: '2026-09-11',
    owner: 'self',
    assetName: 'Cooper Companies, Inc.',
    ticker: 'COO',
    assetType: 'ST',
    txType: 'B',
    amountMin: 1001,
    amountMax: 15000,
    isOption: false,
    capGainsOver200: false,
    rawText: '',
    confidence: 0.9,
    ...over,
  };
}

function read(rows: ParsedTx[], docId: string): CandidateDocResult {
  return {
    provider: 'openai',
    model: 'gpt-5.6-terra',
    docId,
    ok: true,
    latencyMs: 0,
    rowCount: rows.length,
    rowKeys: [],
    avgConfidence: rows.length ? 0.9 : 0,
    rows,
  } as CandidateDocResult;
}

describe('publisher row fixtures', () => {
  it('H-2026-9116355: drops Exempl Mfg Corp. sample so only live rows remain', () => {
    const raw = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'H-2026-9116355-parsed-rows.json'), 'utf8'),
    ) as ParsedTx[];
    const filtered = dropPtrFormSampleParsedRows(raw);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.ticker).toBe('VTI');
    expect(filtered.some((r) => /exempl/i.test(r.assetName ?? ''))).toBe(false);
  });

  it('H-2026-9116376: buildMajorityRows publishes spouse and dependent COO lots same day', () => {
    const rows = [
      tx({ owner: 'dependent', amountMin: 1001, amountMax: 15000 }),
      tx({ owner: 'spouse', amountMin: 15001, amountMax: 50000 }),
    ];
    const reads = [
      read(rows, 'H-2026-9116376'),
      read(rows, 'H-2026-9116376'),
    ];
    const built = buildMajorityRows(reads, 2, true);
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.reason);
    expect(built.rows).toHaveLength(2);
    expect(built.rows.map((r) => r.owner).sort()).toEqual(['dependent', 'spouse']);
  });
});
