import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Filing } from '../../shared/types.ts';

// Mock unpdf so the page-count test doesn't need a real PDF fixture — it only
// needs to prove TextPdfExtractor reads pdf.numPages off the same document
// proxy already opened for text extraction (no extra parse, no page merge).
// parseHousePtrText tests below don't touch unpdf, so this mock is inert for them.
const unpdfMocks = vi.hoisted(() => ({
  getDocumentProxy: vi.fn(),
  extractText: vi.fn(),
}));
vi.mock('unpdf', () => ({
  getDocumentProxy: unpdfMocks.getDocumentProxy,
  extractText: unpdfMocks.extractText,
}));

import { looksLikeHeaderContaminatedAsset } from '../extractRouting.ts';
import { countHousePtrTails, parseHousePtrText, TextPdfExtractor } from '../textPdf.ts';

beforeEach(() => {
  vi.clearAllMocks();
});

function textPdfFiling(): Filing {
  return {
    docId: 'H-1',
    chamber: 'house',
    filerId: null,
    filingType: 'P',
    filedDate: null,
    sourceUrl: '',
    rawObjectKey: null,
    ingestStatus: 'classified',
    docKind: 'text_pdf',
    extractor: null,
    modelVersion: null,
    confidence: null,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    sourceUpdatedAt: null,
    error: null,
  };
}

describe('parseHousePtrText', () => {
  it('ignores PTR preamble text and parses the first real holding block', () => {
    const rows = parseHousePtrText(`
      Periodic Transaction Report
      Clerk of the House of Representatives
      This header mentions 2026 but is not a trade.

      SP Apple Inc. (AAPL) [ST]
      S 03/16/2026 04/01/2026 $1,001 - $15,000
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner: 'spouse',
      assetName: 'Apple Inc.',
      ticker: 'AAPL',
      assetType: 'ST',
      txType: 'S',
      txDate: '2026-03-16',
      amountMin: 1001,
      amountMax: 15000,
      confidence: 1.0,
    });
  });

  it('removes NUL bytes before detecting owner and ticker lines', () => {
    const nul = String.fromCharCode(0);
    const rows = parseHousePtrText([
      `P${nul} T${nul} R${nul} Clerk header`,
      `S${nul}P Abbott Laboratories Common Stock (A${nul}B${nul}T) [S${nul}T]`,
      'P 04/16/2026 04/20/2026 $15,001 - $50,000',
    ].join('\n'));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner: 'spouse',
      assetName: 'Abbott Laboratories Common Stock',
      ticker: 'ABT',
      assetType: 'ST',
      txType: 'B',
      amountMin: 15001,
      amountMax: 50000,
      confidence: 1.0,
    });
    expect(rows[0].assetName).not.toContain('Clerk');
  });

  it('parses single-line House text without treating the PTR header as an asset', () => {
    const rows = parseHousePtrText(
      'P T R Clerk of the House of Representatives T ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200? ' +
        'SP Amazon.com, Inc. - Common Stock (AMZN) [ST] S (partial) 03/16/2026 03/16/2026 $1,001 - $15,000 F S: New S O: Putnam Investments D: details with AAPL and QQQ shares ' +
        'DC Apple Inc. - Common Stock (AAPL) [ST] S (partial) 03/16/2026 03/16/2026 $1,001 - $15,000 F S: New',
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      owner: 'spouse',
      assetName: 'Amazon.com, Inc. - Common Stock',
      ticker: 'AMZN',
      assetType: 'ST',
      assetTypeName: 'Stocks (including ADRs)',
      txType: 'S',
      txDate: '2026-03-16',
      amountMin: 1001,
      amountMax: 15000,
      confidence: 1.0,
    });
    expect(rows[1]).toMatchObject({
      owner: 'dependent',
      assetName: 'Apple Inc. - Common Stock',
      ticker: 'AAPL',
      confidence: 1.0,
    });
    expect(rows[0].assetName).not.toContain('Clerk');
  });

  it('handles multi-line asset descriptions that wrap before [ST]', () => {
    const rows = parseHousePtrText(`
      Filer Information
      ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200?
      SP Alphabet Inc. - Class C Capital
      Stock (GOOG) [ST]
      P 06/14/2026 06/20/2026 $1,001 - $15,000
      Filing Status: New
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner: 'spouse',
      assetName: 'Alphabet Inc. - Class C Capital Stock',
      ticker: 'GOOG',
      assetType: 'ST',
      txType: 'B',
      txDate: '2026-06-14',
      amountMin: 1001,
      amountMax: 15000,
      confidence: 1.0,
    });
  });

  it('preserves caret preferred-share tickers and normalizes slash tickers', () => {
    const rows = parseHousePtrText(`
      Periodic Transaction Report
      SP JPMorgan Chase & Co. Depositary Shares, Series GG (JPM^J) [ST]
      P 05/01/2026 05/02/2026 $1,001 - $15,000
      JT Berkshire Hathaway Inc. (BRK/B) [ST]
      S 05/03/2026 05/04/2026 $15,001 - $50,000
    `);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      owner: 'spouse',
      assetName: 'JPMorgan Chase & Co. Depositary Shares, Series GG',
      ticker: 'JPM^J',
      assetType: 'ST',
      txType: 'B',
      txDate: '2026-05-01',
      amountMin: 1001,
      amountMax: 15000,
      confidence: 1.0,
    });
    expect(rows[1]).toMatchObject({
      owner: 'joint',
      assetName: 'Berkshire Hathaway Inc.',
      ticker: 'BRK.B',
      assetType: 'ST',
      txType: 'S',
      txDate: '2026-05-03',
      amountMin: 15001,
      amountMax: 50000,
      confidence: 1.0,
    });
  });

  it('strips truncated single-line House table headers before inline parsing', () => {
    const rows = parseHousePtrText(
      'P T R Clerk of the House of Representatives - Legislative Resource Center - B81 Cannon Building - Washington, DC 20515 ' +
        'F I Name: Hon. Dwight Evans Status: Member State/District: PA03 T ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > ' +
        'DC General Dynamics Corporation (GD) [ST] P 06/10/2026 06/23/2026 $1,001 - $15,000 F S: New',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner: 'dependent',
      assetName: 'General Dynamics Corporation',
      ticker: 'GD',
      assetType: 'ST',
      txType: 'B',
      txDate: '2026-06-10',
      amountMin: 1001,
      amountMax: 15000,
      confidence: 1.0,
    });
    expect(rows[0].assetName).not.toContain('Clerk');
    expect(rows[0].assetName).not.toContain('Transaction Type');
  });

  it('parses Pelosi-style option rows from House PTR text at 1.0 deterministic confidence', () => {
    const rows = parseHousePtrText(
      'Periodic Transaction Report ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200? ' +
        'SP Intel Corporation - Common Stock (INTC) [OP] P 05/29/2026 05/29/2026 $1,000,001 - $5,000,000 F S: New D: Purchased 200 call options with a strike price of $50 and an expiration date of 3/19/27. ' +
        'SP Uber Technologies, Inc. Common Stock (UBER) [OP] P 05/29/2026 05/29/2026 $500,001 - $1,000,000 F S: New D: Purchased 200 call options with a strike price of $50 and an expiration date of 3/19/27.',
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      owner: 'spouse',
      assetName: 'Intel Corporation - Common Stock',
      ticker: 'INTC',
      assetType: 'OP',
      txType: 'B',
      txDate: '2026-05-29',
      amountMin: 1000001,
      amountMax: 5000000,
      isOption: true,
      confidence: 1.0,
    });
    expect(rows[1]).toMatchObject({
      assetName: 'Uber Technologies, Inc. Common Stock',
      ticker: 'UBER',
      amountMin: 500001,
      amountMax: 1000000,
      isOption: true,
      confidence: 1.0,
    });
  });

  it('anchors inline House rows at owner codes instead of the PTR header', () => {
    const rows = parseHousePtrText(
      'P T R Clerk of the House of Representatives T ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200? ' +
        'SP Austin TX ARPT SYS TRAN [GS] P 05/05/2026 05/31/2026 $50,001 - $100,000 F S: New ' +
        'SP Bonita CA UNI SCH [GS] P 05/05/2026 05/31/2026 $50,001 - $100,000 F S: New ' +
        'SP East Bay CA Muni Util [GS] P 05/06/2026 05/31/2026 $250,001 - Filing ID #20034784 ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200? $500,000 F S: New ' +
        'SP EEMA O&M Services Group [OL] P 05/15/2026 05/31/2026 $250,001 - $500,000 F S: New S O: Kent Street Group LLC L: Elverson, PA, US D: Water/Wastewater O&M ' +
        'SP Energy Northwest WA PWR UTIL [GS] P 05/20/2026 05/31/2026 $500,001 - $1,000,000 F S: New',
    );

    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      owner: 'spouse',
      assetName: 'Austin TX ARPT SYS TRAN',
      assetType: 'GS',
      txType: 'B',
      txDate: '2026-05-05',
      amountMin: 50001,
      amountMax: 100000,
      confidence: 1.0,
    });
    expect(rows[2]).toMatchObject({
      assetName: 'East Bay CA Muni Util',
      amountMin: 250001,
      amountMax: 500000,
      confidence: 1.0,
    });
    expect(rows[3]).toMatchObject({
      assetName: 'EEMA O&M Services Group',
      assetType: 'OL',
      confidence: 1.0,
    });
    expect(rows[0].assetName).not.toContain('Clerk');
    expect(rows[3].assetName).not.toContain('Kent Street Group');
  });

  it('parses digit-prefixed House asset-type codes in inline text', () => {
    const rows = parseHousePtrText(
      'Periodic Transaction Report ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200? ' +
        'SELF 401K Retirement Plan [4K] P 05/01/2026 05/02/2026 $1,001 - $15,000 F S: New ' +
        'SP 529 College Savings Account [5C] P 05/03/2026 05/04/2026 $15,001 - $50,000 F S: New ' +
        'DC 529 Growth Portfolio [5F] S 05/05/2026 05/06/2026 $1,001 - $15,000 F S: New ' +
        'JT State Prepaid Tuition Plan [5P] P 05/07/2026 05/08/2026 $1,001 - $15,000 F S: New',
    );

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.assetType)).toEqual(['4K', '5C', '5F', '5P']);
    expect(rows.map((row) => row.assetTypeName)).toEqual([
      '401K and Other Non-Federal Retirement Accounts',
      '529 College Savings Plan',
      '529 Portfolio',
      '529 Prepaid Tuition Plan',
    ]);
    expect(rows.every((row) => row.ticker === null)).toBe(true);
    expect(rows.every((row) => row.confidence === 1.0)).toBe(true);
  });

  it('parses digit-prefixed House asset-type codes in multiline blocks', () => {
    const rows = parseHousePtrText(`
      Filer Information
      SP 529 Prepaid Tuition [5P]
      P 05/07/2026 05/08/2026 $1,001 - $15,000
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner: 'spouse',
      assetName: '529 Prepaid Tuition',
      ticker: null,
      assetType: '5P',
      assetTypeName: '529 Prepaid Tuition Plan',
      txType: 'B',
      amountMin: 1001,
      amountMax: 15000,
      confidence: 1.0,
    });
  });

  it('preserves row-specific House PTR detail text and checked capital gains flags', () => {
    const rows = parseHousePtrText(`
      Filer Information
      Name: Hon. Josh Gottheimer
      ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200?
      JT Abbott Laboratories Common Stock (ABT) [ST]
      S (partial) 05/27/2026 06/02/2026 $1,001 - $15,000
      Filing Status: New
      Subholding Of: Morgan Stanley - Select UMA Account # 1
      Location: US
      Description: Common Stock
      Cap. Gains > $200? checked
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner: 'joint',
      ticker: 'ABT',
      assetType: 'ST',
      assetTypeName: 'Stocks (including ADRs)',
      filingStatus: 'New',
      subholding: 'Morgan Stanley - Select UMA Account # 1',
      location: 'US',
      description: 'Common Stock',
      supplementalText:
        'New | Morgan Stanley - Select UMA Account # 1 | US | Common Stock',
      capGainsOver200: true,
      confidence: 1.0,
    });
    expect(rows[0].supplementalText).not.toContain('Hon. Josh');
  });

  it('parses EO.Pdf column layout with wrapped amount and trailing [CS]/[GS] (Cohen H-2026-20035235)', () => {
    const rows = parseHousePtrText(`
      Filing ID #20035235
      Clerk of the House of Representatives • Legislative Resource Center • B81 Cannon Building
      Name: Hon. Steve Cohen
      Status: Member
      State/District: TN09
      ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200?
      JPMorgan Chase BK N A INSTL CTF            P                 08/05/2026 08/11/2026             $100,001 -
      DEP ACT/365 4.200% Mat                                                                         $250,000
      8/11/2027 [CS]
      F      S      : New
      S            O : Stephens Advantage Account
      D           : Corporate Bond
      U.S. Tres Bill Int. Rate 0.00% Mat         P                 08/06/2026 08/11/2026             $100,001 -
      8/5/2027 [GS]                                                                                  $250,000
      F      S      : New
      S            O : Stephens Advantage Account
    `);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      owner: 'self',
      assetType: 'CS',
      txType: 'B',
      txDate: '2026-08-05',
      amountMin: 100001,
      amountMax: 250000,
      filingStatus: 'New',
      subholding: 'Stephens Advantage Account',
    });
    expect(rows[0].assetName).toMatch(/JPMorgan Chase/i);
    expect(rows[1]).toMatchObject({
      owner: 'self',
      txType: 'B',
      txDate: '2026-08-06',
      amountMin: 100001,
      amountMax: 250000,
    });
    expect(rows[1].assetName).toMatch(/Tres Bill/i);
    expect(rows[1].assetName).not.toBe('(unknown)');
    expect(rows[1].assetType === 'GS' || /Tres Bill/i.test(rows[1].assetName)).toBe(true);
  });

  it('parses electronic PTR rows with a leading line id, JT owner, and [ST] after the amount (Hern H-2026-20035196)', () => {
    const rows = parseHousePtrText(`
      Filing ID #20035196
      Name: Hon. Kevin Hern
      Status: Member
      State/District: OK01
      ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200?
      2000166537 JT              Organon & Co. Common Stock              S                 08/05/2026 08/05/2026                $1,001 - $15,000
                                 (OGN) [ST]
                                 F      S      : Amended
                                 S            O : Hern Family Revocable Trust
      2000166538 JT              Versant Media Group, Inc. - Class       S                 08/05/2026 08/05/2026                $1,001 - $15,000
                                 A Common Stock (VSNT) [ST]
                                 F      S      : Deleted
                                 S            O : Hern Family Foundation
    `);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      owner: 'joint',
      ticker: 'OGN',
      assetType: 'ST',
      txType: 'S',
      txDate: '2026-08-05',
      amountMin: 1001,
      amountMax: 15000,
      filingStatus: 'Amended',
    });
    expect(rows[0].assetName).toMatch(/Organon/i);
    expect(rows[1]).toMatchObject({
      owner: 'joint',
      ticker: 'VSNT',
      assetType: 'ST',
      txType: 'S',
      txDate: '2026-08-05',
      amountMin: 1001,
      amountMax: 15000,
      filingStatus: 'Deleted',
    });
    expect(rows[1].assetName).toMatch(/Versant/i);
  });

  it('runs deterministic textPdf extraction with zero LLM calls', async () => {
    unpdfMocks.getDocumentProxy.mockResolvedValue({ numPages: 1 });
    unpdfMocks.extractText.mockResolvedValue({
      text: `
        Periodic Transaction Report
        SP Apple Inc. (AAPL) [ST]
        P 06/14/2026 06/20/2026 $1,001 - $15,000
      `,
    });

    const extractor = new TextPdfExtractor();
    const result = await extractor.extract({
      filing: textPdfFiling(),
      bytes: new ArrayBuffer(16),
    });

    expect(result.confidence).toBe(1.0);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].confidence).toBe(1.0);
    expect(result.extractor).toBe('textPdf');
  });

  it('does not name the first ownerless self row after the clerk letterhead', () => {
    // Live H-2025-20030212: Owner column is blank (Self) on every row, so
    // identityFromPrefix cannot cut the first prefix at SP/DC/JT. Without a
    // preamble strip the Allegheny muni is named after "Clerk of the House"
    // and normalize() drops it as form chrome.
    const rows = parseHousePtrText(
      'P T R Clerk of the House of Representatives Legislative Resource Center B81 Cannon Building Washington, DC 20515 ' +
        'Name: Hon. Rob Bresnahan Status: Member State/District: PA08 T ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200? ' +
        'ALLEGHENY CNTY PA HOSP DEV AUTH REF-UNIV PITTSBURGH MED CNTR [GS] S 03/27/2025 03/27/2025 $100,001 - $250,000 F S: New S O: JP Morgan Brokerage Account #4 ' +
        'Amazon.com, Inc. - Common Stock (AMZN) [ST] S 04/03/2025 04/03/2025 $1,001 - $15,000 F S: New',
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]).toMatchObject({
      assetName: expect.stringMatching(/ALLEGHENY/i),
      ticker: null,
      assetType: 'GS',
      txDate: '2025-03-27',
      owner: 'self',
    });
    expect(rows[0].assetName).not.toMatch(/Clerk|Periodic Transaction Report|Hon\.|Bresnahan/i);
    expect(looksLikeHeaderContaminatedAsset(rows[0].assetName)).toBe(false);
    expect(rows.some((r) => r.ticker === 'AMZN')).toBe(true);
  });

  it('treats a later row with no owner code as self, not the prior SP/DC/JT', () => {
    const rows = parseHousePtrText(
      'SP Apple Inc. (AAPL) [ST] P 06/14/2026 06/20/2026 $1,001 - $15,000 ' +
        'Microsoft Corporation (MSFT) [ST] P 06/15/2026 06/21/2026 $15,001 - $50,000 ' +
        'DC Tesla, Inc. (TSLA) [ST] S 06/16/2026 06/22/2026 $1,001 - $15,000 ' +
        'NVIDIA Corporation (NVDA) [ST] P 06/17/2026 06/23/2026 $1,001 - $15,000',
    );
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => [r.ticker, r.owner])).toEqual([
      ['AAPL', 'spouse'],
      ['MSFT', 'self'],
      ['TSLA', 'dependent'],
      ['NVDA', 'self'],
    ]);
  });

  it('splits later self-owned rows that omit SP/DC/JT so a muni does not inherit AMZN', () => {
    const rows = parseHousePtrText(
      'ALLEGHENY CNTY PA HOSP DEV AUTH REF-UNIV PITTSBURGH MED CNTR [GS] S 03/27/2025 03/27/2025 $100,001 - $250,000 F S: New S O: JP Morgan Brokerage Account #4 Amazon.com, Inc. - Common Stock (AMZN) [ST] S 04/03/2025 04/03/2025 $1,001 - $15,000 F S: New S O: JP Morgan Brokerage Account #2 Broadcom Inc. - Common Stock (AVGO) [ST] S 04/03/2025 04/03/2025 $1,001 - $15,000',
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0]).toMatchObject({
      assetName: expect.stringMatching(/ALLEGHENY/i),
      ticker: null,
      assetType: 'GS',
      txDate: '2025-03-27',
      amountMin: 100001,
      amountMax: 250000,
    });
    expect(rows.some((r) => r.ticker === 'AMZN' && r.assetType === 'ST')).toBe(true);
    expect(rows.some((r) => r.ticker === 'AVGO' && r.assetType === 'ST')).toBe(true);
    expect(rows[0].ticker).not.toBe('AMZN');
  });

  it('does not treat a bond due-date as the transaction date', () => {
    const rows = parseHousePtrText(
      'SP U.S. Treasury Note due 1/31/2028 [GS] P 04/23/2024 04/23/2024 Over $1,000,000 F S: New',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      assetName: expect.stringMatching(/Treasury Note/i),
      ticker: null,
      assetType: 'GS',
      txType: 'B',
      txDate: '2024-04-23',
    });
    expect(rows[0].txDate).not.toBe('2028-01-31');
    expect(rows[0].amountMin).toBeGreaterThanOrEqual(1000001);
  });

  it('splits three TNA lots glued without owner prefixes', () => {
    const rows = parseHousePtrText(
      'Direxion Daily Small Cap Bull 3X ETF - TNA [OT] P 02/24/2025 03/10/2025 $50,001 - $100,000 F S: New L: US D: EFT Direxion Daily Small Cap Bull 3X ETF - TNA [OT] P 02/25/2025 03/10/2025 $15,001 - $50,000 F S: New L: US D: EFT Direxion Daily Small Cap Bull 3X ETF - TNA [OT] P 02/26/2025 03/10/2025 $50,001 - $100,000',
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.txDate)).toEqual(['2025-02-24', '2025-02-25', '2025-02-26']);
    expect(rows.every((r) => r.assetType === 'OT')).toBe(true);
  });

  it('counts PTR tails so drain can refuse a glued stored payload', () => {
    const glued =
      'ALLEGHENY CNTY PA HOSP [GS] S 03/27/2025 03/27/2025 $100,001 - $250,000 Amazon.com, Inc. (AMZN) [ST] S 04/03/2025 04/03/2025 $1,001 - $15,000';
    expect(countHousePtrTails(glued)).toBe(2);
    expect(countHousePtrTails('SP Apple Inc. (AAPL) [ST] P 06/14/2026 06/20/2026 $1,001 - $15,000')).toBe(1);
  });
});

describe('TextPdfExtractor page count', () => {
  it('surfaces pdf.numPages from the already-open document proxy (no extra parse)', async () => {
    unpdfMocks.getDocumentProxy.mockResolvedValue({ numPages: 3 });
    unpdfMocks.extractText.mockResolvedValue({
      text: 'SP Apple Inc. (AAPL) [ST]\nP 06/14/2024 06/20/2024 $1,001 - $15,000',
    });

    const extractor = new TextPdfExtractor();
    const result = (await extractor.extract({
      filing: textPdfFiling(),
      bytes: new ArrayBuffer(8),
    })) as { pageCount?: number | null };

    expect(result.pageCount).toBe(3);

    expect(unpdfMocks.getDocumentProxy).toHaveBeenCalledTimes(1);
  });

  it('leaves page count null when the parser does not cheaply expose numPages', async () => {
    unpdfMocks.getDocumentProxy.mockResolvedValue({});
    unpdfMocks.extractText.mockResolvedValue({ text: '' });

    const extractor = new TextPdfExtractor();
    const result = (await extractor.extract({
      filing: textPdfFiling(),
      bytes: new ArrayBuffer(8),
    })) as { pageCount?: number | null };

    expect(result.pageCount).toBeNull();
  });

  it('fail-softs when unpdf throws XRefEntryException (CONGRESS-TRADE-1C)', async () => {
    unpdfMocks.getDocumentProxy.mockRejectedValue(
      Object.assign(new Error('Bad (uncompressed) XRef entry: 13R'), {
        name: 'XRefEntryException',
      }),
    );

    const extractor = new TextPdfExtractor();
    const result = await extractor.extract({
      filing: textPdfFiling(),
      bytes: new ArrayBuffer(8),
    });

    expect(result.transactions).toEqual([]);
    expect(result.raw).toBe('');
    expect((result as { pageCount?: number | null }).pageCount).toBeNull();
  });

  it('does not detach the caller-supplied ArrayBuffer (regression guard for Sentry CONGRESS-TRADE-2)', async () => {
    unpdfMocks.getDocumentProxy.mockImplementation(async (view: Uint8Array) => {
      structuredClone(view.buffer, { transfer: [view.buffer] });
      return { numPages: 1 };
    });
    unpdfMocks.extractText.mockResolvedValue({ text: '' });

    const bytes = new ArrayBuffer(8);
    const extractor = new TextPdfExtractor();
    await extractor.extract({ filing: textPdfFiling(), bytes });

    expect(bytes.byteLength).toBe(8);
    expect(() => new Uint8Array(bytes)).not.toThrow();
  });
});
