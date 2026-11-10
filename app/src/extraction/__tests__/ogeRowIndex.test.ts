/**
 * Board row 3d31c7b9 — OGE 278-T asset names carry the "#" column.  Names below
 * are verbatim from the live Trump feed (/api/client/v1/feed?memberName=Trump,
 * 2026-09-18) and the board row's evidence.
 */
import { describe, expect, it } from 'vitest';
import {
  ogeRowIndexVerdict,
  stripLeadingRowIndex,
  stripOgeRowIndexes,
} from '../ogeRowIndex.ts';
import { parseOgeTransactionRows } from '../ogeText.ts';
import { looksLikeHeaderContaminatedAsset } from '../extractRouting.ts';
import { recomputeTransactions, clearResolverCache, clearNameIndexCache } from '../normalizer.ts';
import { openMigratedD1 } from '../../prices/__tests__/sqliteD1.ts';
import type { Env, Filing, ParsedTx } from '../../shared/types.ts';

const TRUMP_NAMES = [
  '3641 Microsoft Corp. Com',
  '3639 Mota Plalfonns, Inc.',
  '3608 Nvidia Corp.',
  '3536 Apollo Global MGMT Inc. Com',
  '1146 Jpmorgan Chase & Co. Perp NN 6.8750% (',
  '1123 the Mosaic Co.',
  '1120 Tempus Al Inc. Class Class A I',
  '1117 Snowflake Inc. Class A l',
  '1087 Intercontinental Exchang',
];

describe('ogeRowIndexVerdict / stripOgeRowIndexes', () => {
  it('strips the "#" column when most of the filing carries it (up to four digits)', () => {
    const rows = TRUMP_NAMES.map((assetName) => ({ assetName }));
    expect(ogeRowIndexVerdict(TRUMP_NAMES).strip).toBe(true);
    expect(stripOgeRowIndexes(rows).map((r) => r.assetName)).toEqual([
      'Microsoft Corp. Com',
      'Mota Plalfonns, Inc.',
      'Nvidia Corp.',
      'Apollo Global MGMT Inc. Com',
      'Jpmorgan Chase & Co. Perp NN 6.8750% (',
      'the Mosaic Co.',
      'Tempus Al Inc. Class Class A I',
      'Snowflake Inc. Class A l',
      'Intercontinental Exchang',
    ]);
  });

  it('removes exactly one token: a row-numbered "360 DigiTech" keeps its own leading number', () => {
    const rows = [
      { assetName: '412 360 DigiTech Inc.' },
      { assetName: '413 Microsoft Corp.' },
      { assetName: '414 Nvidia Corp.' },
    ];
    expect(stripOgeRowIndexes(rows).map((r) => r.assetName)).toEqual([
      '360 DigiTech Inc.',
      'Microsoft Corp.',
      'Nvidia Corp.',
    ]);
  });

  it('leaves a filing alone when only a minority of rows start with a number (a real "3M Company" or "360 DigiTech" stays intact)', () => {
    const rows = [
      { assetName: '360 DigiTech Inc.' },
      { assetName: 'Microsoft Corp.' },
      { assetName: 'Nvidia Corp.' },
      { assetName: 'Apple Inc.' },
    ];
    expect(ogeRowIndexVerdict(rows.map((r) => r.assetName)).strip).toBe(false);
    expect(stripOgeRowIndexes(rows).map((r) => r.assetName)).toEqual(rows.map((r) => r.assetName));
    // "3M" has no whitespace after the digit, so it never matches even inside a numbered filing.
    expect(stripLeadingRowIndex('3M Company')).toBe('3M Company');
  });

  it('handles a tiny filing only when every row has a small index', () => {
    expect(ogeRowIndexVerdict(['1 Amazon.com, Inc.']).strip).toBe(true);
    expect(ogeRowIndexVerdict(['360 DigiTech Inc.']).strip).toBe(false);
    expect(ogeRowIndexVerdict(['1 Amazon.com, Inc.', 'Apple Inc.']).strip).toBe(false);
  });

  it('accepts "1.", "1)" and "1" separators and never mutates its input', () => {
    const rows = [{ assetName: '1. Apple Inc.' }, { assetName: '2) Amazon.com Inc.' }, { assetName: '3 Nvidia Corp.' }];
    const before = JSON.stringify(rows);
    expect(stripOgeRowIndexes(rows).map((r) => r.assetName)).toEqual(['Apple Inc.', 'Amazon.com Inc.', 'Nvidia Corp.']);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe('text-layer parser: rows numbered past 999', () => {
  it('anchors a four-digit row number (the old \\d{1,3} could not match rows past 999)', () => {
    const text = [
      '# DESCRIPTION TYPE DATE NOTIFICATION RECEIVED OVER 30 DAYS AGO AMOUNT',
      '1146 Microsoft Corp. (MSFT) Sale 06/10/2025 No $1,001 - $15,000',
      '1147 Nvidia Corp. (NVDA) Purchase 06/11/2025 No $15,001 - $50,000',
      '3641 Apple Inc. (AAPL) Sale 06/12/2025 No $1,001 - $15,000',
    ].join(' ');
    const rows = parseOgeTransactionRows(text);
    expect(rows.map((r) => r.ticker)).toEqual(['MSFT', 'NVDA', 'AAPL']);
    expect(rows.map((r) => r.assetName)).toEqual(['Microsoft Corp.', 'Nvidia Corp.', 'Apple Inc.']);
  });
});

describe('footnote boilerplate rows', () => {
  it('drops the OCR variants of "Your Broker Acted As Agent" as form chrome', () => {
    expect(looksLikeHeaderContaminatedAsset('Tion Your Brokor Acted As Annnt')).toBe(true);
    expect(looksLikeHeaderContaminatedAsset('Your Broker Acted As Agent')).toBe(true);
    // A genuine name is unaffected, including one containing "acted".
    expect(looksLikeHeaderContaminatedAsset('Microsoft Corp.')).toBe(false);
    expect(looksLikeHeaderContaminatedAsset('Reacted Pharmaceuticals Inc.')).toBe(false);
  });
});

describe('golden: the Trump 278-T through recomputeTransactions (in-memory D1)', () => {
  function filing(over: Partial<Filing> = {}): Filing {
    return {
      docId: 'E-2026-donald-j-trump-278t',
      chamber: 'executive',
      filerId: 'EXEC-DJT',
      filingType: 'P',
      filedDate: '2026-08-15',
      sourceUrl: '',
      rawObjectKey: null,
      ingestStatus: 'classified',
      docKind: 'scanned_pdf',
      extractor: null,
      modelVersion: null,
      confidence: null,
      firstSeenAt: '2026-08-15T00:00:00.000Z',
      sourceUpdatedAt: null,
      error: null,
      ...over,
    };
  }
  function parsed(assetName: string): ParsedTx {
    return {
      txDate: '2026-08-10',
      owner: null,
      assetName,
      ticker: null,
      assetType: null,
      assetTypeName: null,
      txType: 'S',
      amountMin: 1001,
      amountMax: 15000,
      isOption: false,
      capGainsOver200: false,
      rawText: `1 ${assetName} Sale 08/10/2026 No $1,001 - $15,000`,
      confidence: 0.9,
    } as ParsedTx;
  }

  it('cleans the names and resolves tickers once the row number is gone; a non-executive filing is untouched', async () => {
    const { d1, close } = await openMigratedD1();
    try {
      clearResolverCache();
      clearNameIndexCache();
      for (const [ticker, name] of [
        ['MSFT', 'Microsoft Corporation'],
        ['NVDA', 'NVIDIA Corporation'],
        ['MOS', 'Mosaic Company (The)'],
        ['APO', 'Apollo Global Management, Inc.'],
      ]) {
        await d1.prepare('INSERT INTO securities_ref (ticker, company_name, market_cap) VALUES (?, ?, 1000000)').bind(ticker, name).run();
      }
      const env = { DB: d1 } as unknown as Env;
      const rows = ['3641 Microsoft Corp. Com', '3608 Nvidia Corp.', '1123 the Mosaic Co.', '3536 Apollo Global MGMT Inc. Com'].map(parsed);

      const exec = await recomputeTransactions(env, filing(), rows);
      expect(exec.map((f) => f.tx.assetName)).toEqual([
        'Microsoft Corp. Com',
        'Nvidia Corp.',
        'the Mosaic Co.',
        'Apollo Global MGMT Inc. Com',
      ]);
      expect(exec.map((f) => f.tx.ticker)).toEqual(['MSFT', 'NVDA', 'MOS', 'APO']);

      // The identical rows on a House filing keep their names: the strip is executive-only.
      clearResolverCache();
      const house = await recomputeTransactions(env, filing({ docId: 'H-2026-1', chamber: 'house' }), rows);
      expect(house[0].tx.assetName).toBe('3641 Microsoft Corp. Com');
      expect(house[0].tx.ticker).toBeNull();
    } finally {
      close();
    }
  });
});
