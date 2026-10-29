/**
 * Regression: House PTR subholding / filing-status carryover between rows.
 *
 * Review-queue rows H-2026-20035563 (Pete Sessions, 32 rows) and
 * H-2026-20035715 (Max Miller, 2 rows) landed on 2026-10-28 with
 * ocr_name_hold / ticker_asset_mismatch / low_confidence because the text
 * extractor glued each row's trailing detail lines onto the front of the
 * next row's asset name and shifted every subholding one row down.
 *
 * A blank Owner column means "filer" (self), not "no row here", so the
 * owner code is not a usable row boundary.  The House form prints each
 * holding's detail lines ("Filing Status: New", "Subholding Of: Trust One")
 * on their own lines under the holding; those line breaks are the row
 * boundary the extractor has to use.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseHousePtrText } from '../textPdf.ts';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../__fixtures__');

interface ExpectedRow {
  assetName: string;
  ticker: string | null;
  assetType: string;
  txDate: string;
  txType: string;
  owner: string;
  amountMin: number;
  amountMax: number;
  filingStatus: string | null;
  subholding: string | null;
  description?: string | null;
}

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

function expectedRows(name: string): ExpectedRow[] {
  return JSON.parse(fixture(name)) as ExpectedRow[];
}

/** Detail labels must never survive into an asset name. */
const DETAIL_FRAGMENT_RE = /Filing Status|Subholding Of|Location:|Description:/i;

const CASES: { docId: string; text: string; rows: string }[] = [
  {
    docId: 'H-2026-20035563',
    text: 'H-2026-20035563-text-layer.txt',
    rows: 'H-2026-20035563-parsed-rows.json',
  },
  {
    docId: 'H-2026-20035715',
    text: 'H-2026-20035715-text-layer.txt',
    rows: 'H-2026-20035715-parsed-rows.json',
  },
  {
    // Kevin Hern OK01, 2026-10-29: blank-owner IRA row between two JT rows.
    docId: 'H-2026-20035710',
    text: 'H-2026-20035710-text-layer.txt',
    rows: 'H-2026-20035710-parsed-rows.json',
  },
];

describe('textPdf House PTR row segmentation', () => {
  for (const c of CASES) {
    describe(c.docId, () => {
      const rows = parseHousePtrText(fixture(c.text));
      const expected = expectedRows(c.rows);

      it('extracts one row per holding', () => {
        expect(rows).toHaveLength(expected.length);
      });

      it('keeps every field on the row that owns it', () => {
        for (const want of expected) {
          const got = rows.find((r) => r.txDate === want.txDate && r.ticker === want.ticker);
          expect(got, `row ${want.ticker ?? want.assetName} @ ${want.txDate}`).toBeDefined();
          expect(got).toMatchObject({
            owner: want.owner,
            assetName: want.assetName,
            ticker: want.ticker,
            assetType: want.assetType,
            txDate: want.txDate,
            txType: want.txType,
            amountMin: want.amountMin,
            amountMax: want.amountMax,
            filingStatus: want.filingStatus,
            subholding: want.subholding,
            description: want.description ?? null,
          });
        }
      });

      it('never glues a detail label into an asset name', () => {
        for (const row of rows) {
          expect(row.assetName, row.assetName).not.toMatch(DETAIL_FRAGMENT_RE);
        }
      });

      it('never carries the next row asset text into a subholding', () => {
        for (const row of rows) {
          expect(row.subholding ?? '', row.assetName).not.toMatch(DETAIL_FRAGMENT_RE);
        }
      });
    });
  }

  it('leaves a blank-owner row without a Subholding Of line subholding-null', () => {
    // H-2026-20035563: the 10/27 Amazon.com row is the filer's own holding
    // and prints only "Filing Status: New".
    const rows = parseHousePtrText(fixture('H-2026-20035563-text-layer.txt'));
    const amazon = rows.find((r) => r.ticker === 'AMZN' && r.txDate === '2026-10-27');
    expect(amazon).toMatchObject({ owner: 'self', subholding: null });
    expect(amazon?.assetName).toBe('Amazon.com, Inc. - Common Stock');
  });

  it('keeps a detail block that continues past a repeated page header', () => {
    // H-2026-20035563: Mastercard's Filing Status / Subholding Of lines are
    // printed after the page-2 table header.
    const rows = parseHousePtrText(fixture('H-2026-20035563-text-layer.txt'));
    const mastercard = rows.find((r) => r.ticker === 'MA');
    expect(mastercard).toMatchObject({
      owner: 'spouse',
      assetName: 'Mastercard Incorporated Common Stock',
      filingStatus: 'New',
      subholding: 'Trust One',
    });
  });

  it('keeps the asset name that shares its line with the transaction type', () => {
    // H-2026-20035715: "S (partial)" shares the Mercato Partners line, so the
    // name used to be lost entirely.
    const rows = parseHousePtrText(fixture('H-2026-20035715-text-layer.txt'));
    expect(rows.map((r) => r.assetName)).toEqual([
      'AIX Ventures Fund II, LP (GLAS Funds, LP)',
      'Mercato Partners Traverse IV QP, LP (GLAS Funds, LP)',
    ]);
    expect(rows.every((r) => r.subholding === '2012 Trust')).toBe(true);
  });

  describe('synthetic House text layers', () => {
    const HEADER = [
      'P T R',
      'Clerk of the House of Representatives • Legislative Resource Center • B81 Cannon Building • Washington, DC 20515',
      'F I',
      'Name: Hon. Test Member',
      'Status: Member',
      'State/District: TX01',
      'T',
      'ID Owner Asset Transaction',
      'Type',
      'Date Notification',
      'Date',
      'Amount Cap.',
      'Gains >',
      '$200?',
    ];
    const doc = (...lines: string[]) => [...HEADER, ...lines].join('\n');

    it('keeps the leading "T" of a blank-owner asset after the first row', () => {
      const rows = parseHousePtrText(doc(
        'SP Apple Inc. - Common Stock (AAPL) [ST]',
        'S 10/02/2026 10/05/2026 $1,001 - $15,000',
        'F S: New',
        'T Rowe Price Group, Inc. (TROW) [ST]',
        'P 10/03/2026 10/05/2026 $1,001 - $15,000',
        'F S: New',
      ));
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ owner: 'self', ticker: 'TROW', assetName: 'T Rowe Price Group, Inc.' });
    });

    it('still drops the "T" column marker before a blank-owner first row', () => {
      const rows = parseHousePtrText(doc(
        'Apple Inc. - Common Stock (AAPL) [ST]',
        'S 10/02/2026 10/05/2026 $1,001 - $15,000',
      ));
      expect(rows[0]).toMatchObject({ owner: 'self', ticker: 'AAPL', assetName: 'Apple Inc. - Common Stock' });
    });

    it('keeps a wrapped description on its own row when the next row has an owner code', () => {
      const rows = parseHousePtrText(doc(
        'SP Apple Inc. - Common Stock (AAPL) [ST]',
        'S 10/02/2026 10/05/2026 $1,001 - $15,000',
        'F S: New',
        'D: Rebalanced by the trustee after the',
        'annual review',
        'SP NVIDIA Corporation - Common Stock (NVDA) [ST]',
        'P 10/03/2026 10/05/2026 $1,001 - $15,000',
        'F S: New',
      ));
      expect(rows).toHaveLength(2);
      expect(rows[0].description).toBe('Rebalanced by the trustee after the annual review');
      expect(rows[1]).toMatchObject({ owner: 'spouse', ticker: 'NVDA', assetName: 'NVIDIA Corporation - Common Stock', description: null });
    });

    it('never lets a detail block reach into the next row tail line', () => {
      // "D:" opens the line that also carries the next row's [ST] tail.  That
      // line is the next row's identity, not this row's description.
      const rows = parseHousePtrText(doc(
        'SP Apple Inc. - Common Stock (AAPL) [ST]',
        'S 10/02/2026 10/05/2026 $1,001 - $15,000',
        'F S: New',
        'D: Dell Technologies Inc. (DELL) [ST] P 10/03/2026 10/05/2026 $1,001 - $15,000',
      ));
      expect(rows).toHaveLength(2);
      expect(rows[0].description).toBeNull();
      expect(rows[1]).toMatchObject({ ticker: 'DELL', assetName: 'Dell Technologies Inc.' });
    });

    it('keeps a row with a glued detail label out of auto-publish', () => {
      // No line breaks: a blank-owner row cannot be split from the previous
      // row's free-text Subholding Of value, so it must go to review.
      const rows = parseHousePtrText(
        doc().replace(/\n/g, ' ') +
          ' SP Apple Inc. - Common Stock (AAPL) [ST] S 10/02/2026 10/05/2026 $1,001 - $15,000' +
          ' Filing Status: New Subholding Of: ET IRA Home Depot, Inc. (HD) [ST] S 10/22/2026 10/22/2026 $1,001 - $15,000',
      );
      const hd = rows.find((r) => r.ticker === 'HD');
      expect(hd?.assetName).toMatch(/Subholding Of/);
      expect(hd?.confidence ?? 1).toBeLessThan(0.95);
    });
  });
});
