import { describe, expect, it } from 'vitest';
import type { Filing, ParsedTx } from '../../shared/types.ts';
import {
  OPENROUTER_FILES_HOLD_USD,
  TYPED_PTR_CHEAP_PATH_USD_CEILING,
  allowOpenRouterFiles,
  classifyHouseExtractRoute,
  evaluateExtractQuality,
  isJunkAgreementRow,
  dropJunkAgreementRows,
  isPlaceholderAgreementAsset,
  isHouseElectronicDocId,
  isHousePaperScanDocId,
  looksLikePlausibleTradeTable,
  looksLikeHeaderContaminatedAsset,
  dropPtrFormSampleParsedRows,
  looksLikePtrFormSampleAsset,
  looksLikePtrFormSampleRow,
  looksLikeSeeAttachmentPointer,
  looksLikeNothingToReport,
  looksLikeOgePart7ExplicitNone,
  isDeletedFilingStatus,
  shouldEnqueueAgreement,
  shouldSkipAgreementForReviewReason,
} from '../extractRouting.ts';

const filing = (over: Partial<Filing> = {}): Filing => ({
  docId: 'H-2025-20030634',
  chamber: 'house',
  filerId: 'F1',
  filingType: 'P',
  filedDate: '2026-06-24',
  sourceUrl: 'https://example.test/doc.pdf',
  rawObjectKey: 'raw/doc.pdf',
  ingestStatus: 'classified',
  docKind: 'scanned_pdf',
  extractor: null,
  modelVersion: null,
  confidence: null,
  firstSeenAt: '2026-06-24T00:00:00.000Z',
  sourceUpdatedAt: null,
  error: null,
  ...over,
});

const tx = (over: Partial<ParsedTx> = {}): ParsedTx => ({
  txDate: '2026-01-02',
  owner: 'self',
  assetName: 'Apple Inc',
  ticker: 'AAPL',
  assetType: 'ST',
  txType: 'B',
  amountMin: 1001,
  amountMax: 15000,
  isOption: false,
  capGainsOver200: false,
  rawText: '',
  confidence: 0.7,
  ...over,
});

describe('House DocID routing', () => {
  it('treats 20xxxxxx House IDs as electronic and 822/911 as paper scans', () => {
    expect(isHouseElectronicDocId('H-2025-20030634')).toBe(true);
    expect(isHouseElectronicDocId('H-2024-20025111')).toBe(true);
    expect(isHouseElectronicDocId('H-2025-8221302')).toBe(false);
    expect(isHouseElectronicDocId('H-2025-9115662')).toBe(false);
    expect(isHousePaperScanDocId('H-2025-8221302')).toBe(true);
    expect(isHousePaperScanDocId('H-2025-9115662')).toBe(true);
    expect(isHousePaperScanDocId('H-2025-20030634')).toBe(false);
  });
});

describe('classifyHouseExtractRoute / allowOpenRouterFiles', () => {
  it('forbids OpenRouter Files on electronic House PTRs even when doc_kind is scanned_pdf', () => {
    const electronic = filing({ docId: 'H-2025-20030634', docKind: 'scanned_pdf' });
    expect(classifyHouseExtractRoute(electronic)).toEqual({ kind: 'electronic', allowFiles: false });
    expect(allowOpenRouterFiles(electronic)).toBe(false);
  });

  it('forbids Files on text_pdf and typed doc_class', () => {
    expect(allowOpenRouterFiles(filing({ docId: 'H-2025-1', docKind: 'text_pdf' }))).toBe(false);
    expect(allowOpenRouterFiles(filing({
      docId: 'H-2025-8221302',
      docKind: 'scanned_pdf',
      ...{ docClass: 'typed' },
    } as Filing))).toBe(false);
  });

  it('allows Files only for real paper/scan DocIDs or scan classes', () => {
    expect(allowOpenRouterFiles(filing({ docId: 'H-2025-8221302', docKind: 'scanned_pdf' }))).toBe(true);
    expect(allowOpenRouterFiles(filing({ docId: 'H-2025-9115662', docKind: 'scanned_pdf' }))).toBe(true);
    expect(allowOpenRouterFiles(filing({
      docId: 'H-2024-8220192',
      docKind: 'scanned_pdf',
      ...{ docClass: 'hard_scan' },
    } as Filing))).toBe(true);
  });
});

const BONDI_PART7_NONE = [
  'OGE Form 278e (January 2019)',
  'U.S. Office of Government Ethics',
  '1. Filer\'s Positions Held Outside United States Government',
  'None',
  '6. Other Assets and Income',
  'None',
  '7. Transactions',
  'None',
  '8. Liabilities',
  'None',
  '9. Gifts and Travel Reimbursements',
  'None',
].join('\n');

const TRUMP_278T_GARBLED_ZERO_ROWS = [
  'Periodic Transaction Report',
  '# DESCRIPTION TYPE DATE NOTIFICATION RECEIVED OVER 30 DAYS AGO AMOUNT',
  '1 SPOR SERIES TRUST HIGH YlELD BONO ETF ourchoeo 1/20/2028 no',
  '2 Amazon.com Inc AMZN Sale 06/10/2022 No 1001 15000',
].join('\n');

describe('looksLikeOgePart7ExplicitNone', () => {
  it('accepts a Bondi-like 278e whose Part 7 Transactions body is None', () => {
    expect(looksLikeOgePart7ExplicitNone(BONDI_PART7_NONE)).toBe(true);
    expect(looksLikeOgePart7ExplicitNone(
      '6. Other Assets and Income None 7. Transactions None 8. Liabilities None',
    )).toBe(true);
    expect(looksLikeOgePart7ExplicitNone('Part 7. Transactions\nN/A\n8. Liabilities\nNone')).toBe(true);
    expect(looksLikeOgePart7ExplicitNone('7. Transactions\nNo transactions\n8. Liabilities\nNone')).toBe(true);
  });

  it('rejects zero rows without a Part 7 None marker', () => {
    expect(looksLikeOgePart7ExplicitNone('Part 7. Transactions None. See attachment. 8. Liabilities')).toBe(false);
    expect(looksLikeOgePart7ExplicitNone('7. Transactions None See Attached Schedule 8. Liabilities')).toBe(false);
    expect(looksLikeOgePart7ExplicitNone(TRUMP_278T_GARBLED_ZERO_ROWS)).toBe(false);
    expect(looksLikeOgePart7ExplicitNone('')).toBe(false);
    expect(looksLikeOgePart7ExplicitNone(null)).toBe(false);
    expect(looksLikeOgePart7ExplicitNone('None')).toBe(false);
    expect(looksLikeOgePart7ExplicitNone('Nothing to report')).toBe(false);
    expect(looksLikeOgePart7ExplicitNone([
      '7. Transactions',
      '8. Liabilities',
      'None',
    ].join('\n'))).toBe(false);
    expect(looksLikeOgePart7ExplicitNone([
      '2. Filer\'s Employment Assets & Income',
      'None',
      '7. Transactions',
      '1 Amazon.com, Inc. (AMZN) Sale 06/10/2022 No $1,001 - $15,000',
      '8. Liabilities',
      'None',
    ].join('\n'))).toBe(false);
  });
});

describe('evaluateExtractQuality — hard-stops', () => {
  it('treats the printed PTR Example Mega Corp sample as form chrome', () => {
    expect(looksLikePtrFormSampleAsset('Example Mega Corp Common Stock')).toBe(true);
    expect(looksLikePtrFormSampleAsset('Exemplje Mega Corp.')).toBe(true);
    expect(looksLikePtrFormSampleAsset('Exempl Mfg Corp Common Stock')).toBe(true);
    expect(looksLikePtrFormSampleAsset('Exempl Mfg Corp.')).toBe(true);
    expect(looksLikePtrFormSampleAsset('Example Mfg. Corp.')).toBe(true);
    expect(looksLikePtrFormSampleAsset('Example Meg Corp.')).toBe(true);
    expect(looksLikePtrFormSampleAsset('Ex Mpi Meg Corp.')).toBe(true);
    expect(looksLikePtrFormSampleAsset('Apple Inc.')).toBe(false);
    expect(looksLikePtrFormSampleAsset('Mega Corp Holdings Inc.')).toBe(false);
    expect(looksLikeHeaderContaminatedAsset('Exemplje Mega Corp Common Stock')).toBe(true);
    expect(looksLikeNothingToReport('Nothing to report for July 2026')).toBe(true);
    expect(looksLikeNothingToReport('Nothlng to report for July 2026')).toBe(true);
    expect(looksLikeNothingToReport('No transactions to report')).toBe(true);
    expect(looksLikeNothingToReport('Example Mega Corp Common Stock')).toBe(false);
    expect(isDeletedFilingStatus('Deleted')).toBe(true);
    expect(isDeletedFilingStatus('New')).toBe(false);
  });

  it('treats Senate PTR IBM/Microsoft printed examples as form chrome, not live trades', () => {
    expect(looksLikePtrFormSampleAsset('IBM Corp. (stock) NYSE')).toBe(true);
    expect(looksLikePtrFormSampleAsset('(DC) Microsoft (stock) NASDAQ/OTC')).toBe(true);
    expect(looksLikePtrFormSampleAsset('Microsoft (stock) NASDAQ/OTC')).toBe(true);
    expect(looksLikeHeaderContaminatedAsset('IBM Corp. (stock) NYSE')).toBe(true);
    expect(looksLikePtrFormSampleAsset('International Business Machines')).toBe(false);
    expect(looksLikePtrFormSampleAsset('Microsoft Corporation')).toBe(false);
    expect(looksLikePtrFormSampleAsset('MSFT')).toBe(false);
    expect(looksLikeSeeAttachmentPointer('See Attachment')).toBe(true);
    expect(looksLikeSeeAttachmentPointer('John Boozman IRA See Attachment')).toBe(true);
    expect(looksLikeSeeAttachmentPointer('ELCM2 LLC')).toBe(false);

    // Row-level detection (e.g. Blumenthal template row OCR)
    expect(looksLikePtrFormSampleRow({
      assetName: 'Microsoft',
      rawText: '(DC) Microsoft (stock) NASDAQ/OTC 2/27/1X EXAMPLE',
      amountRange: 'EXAMPLE',
      txDate: '2027-01-17',
    })).toBe(true);
    expect(looksLikePtrFormSampleRow({
      assetName: 'Microsoft',
      rawText: 'Microsoft 2/27/1X',
      amountRange: '$1,001 - $15,000',
      txDate: '2027-02-27',
    })).toBe(true);
    expect(looksLikePtrFormSampleRow({
      assetName: '(DC) Microsoft',
      rawText: '(DC) Microsoft',
      amountRange: 'EXAMPLE',
      txDate: '2026-01-01',
    })).toBe(true);

    // Real live trades must NOT be treated as sample rows
    expect(looksLikePtrFormSampleRow({
      assetName: 'Microsoft Corporation',
      rawText: 'Microsoft Corporation common stock purchase',
      amountRange: '$1,001 - $15,000',
      txDate: '2026-03-15',
    })).toBe(false);
    expect(looksLikePtrFormSampleRow({
      assetName: 'MSFT',
      rawText: 'MSFT buy',
      amountRange: '$15,001 - $50,000',
      txDate: '2026-05-10',
    })).toBe(false);

    expect(looksLikePtrFormSampleRow({
      assetName: 'Exempl Mfg Corp',
      rawText: 'Exempl Mfg Corp P 8/14/12',
      amountRange: '$1,001 - $15,000',
      txDate: '2020-01-15',
    })).toBe(true);

    expect(looksLikePtrFormSampleRow({
      assetName: 'Example Meg Corp.',
      rawText: 'Example Meg Corp P',
      amountRange: '$1,001 - $15,000',
      txDate: '2020-05-02',
    })).toBe(true);

    expect(looksLikePtrFormSampleRow({
      assetName: 'Mega Corp',
      rawText: 'Mega Corp P 8/14/12',
      amountRange: '$1,001 - $15,000',
      txDate: '2020-05-02',
    })).toBe(true);

    expect(looksLikePtrFormSampleRow({
      assetName: 'Mega Corp',
      rawText: 'Mega Corp purchase',
      amountRange: '$15,001 - $50,000',
      txDate: '2026-05-10',
    })).toBe(false);
  });

  it('CT-2407 / H-2026-9116355 — drops House printed-sample rows before publish', () => {
    expect(looksLikePtrFormSampleAsset('Exempl Mfg Corp.')).toBe(true);
    expect(looksLikePtrFormSampleAsset('Ex Mpi Meg Corp.')).toBe(true);

    expect(looksLikePtrFormSampleRow({
      assetName: 'Mega Corp.',
      rawText: 'Mega Corp.',
      txDate: '2020-05-02',
    })).toBe(true);

    expect(looksLikePtrFormSampleRow({
      assetName: 'Mega Corp Holdings',
      rawText: 'Mega Corp Holdings common stock',
      txDate: '2026-05-10',
    })).toBe(false);

    const extracted = [
      tx({
        assetName: 'Exempl Mfg Corp.',
        rawText: 'Exempl Mfg Corp Common Stock',
        ticker: null,
        txDate: '2026-02-05',
      }),
      tx({
        assetName: 'Ex Mpi Meg Corp.',
        rawText: 'Ex Mpi Meg Corp.',
        ticker: null,
        txDate: '2026-07-30',
      }),
      tx({
        assetName: 'Mega Corp.',
        rawText: 'Mega Corp.',
        ticker: null,
        txDate: '2020-05-02',
      }),
      tx({
        assetName: 'Mega Corp Holdings',
        rawText: 'Mega Corp Holdings purchase',
        ticker: null,
        txDate: '2026-05-10',
      }),
    ];

    const kept = dropPtrFormSampleParsedRows(extracted);
    expect(kept).toHaveLength(1);
    expect(kept[0].assetName).toBe('Mega Corp Holdings');
  });

  it('hard-stops letterhead-as-asset (Clerk / B81 Cannon)', () => {
    const junk = [
      tx({
        assetName: 'Clerk of the House of Representatives',
        ticker: null,
        txDate: null,
        amountMin: 5_000_001,
        amountMax: 25_000_000,
        txType: 'S',
        confidence: 0.2,
      }),
      tx({
        assetName: 'B81 Cannon Building',
        ticker: null,
        txDate: null,
        amountMin: 5_000_001,
        amountMax: 25_000_000,
        txType: 'S',
        confidence: 0.18,
      }),
    ];
    expect(evaluateExtractQuality(junk)).toEqual({ ok: false, reason: 'letterhead_as_asset' });
  });

  it('hard-stops column-header-as-asset', () => {
    const junk = [
      tx({ assetName: 'Transaction Type', ticker: null, txDate: null }),
      tx({ assetName: 'Notification Date', ticker: null, txDate: null }),
      tx({ assetName: 'Amount', ticker: null, txDate: null }),
    ];
    expect(evaluateExtractQuality(junk)).toEqual({ ok: false, reason: 'column_header_as_asset' });
  });

  it('hard-stops row-limit garbage', () => {
    const rows = Array.from({ length: 201 }, (_, i) => tx({ ticker: `T${i}` }));
    expect(evaluateExtractQuality(rows)).toEqual({ ok: false, reason: 'extraction_row_limit' });
  });

  it('hard-stops majority missing tx date + malformed amount', () => {
    const junk = [
      tx({ txDate: null, amountMin: null, amountMax: null, assetName: '???', ticker: null }),
      tx({ txDate: null, amountMin: null, amountMax: null, assetName: '###', ticker: null }),
      tx({ txDate: null, amountMin: null, amountMax: null, assetName: '---', ticker: null }),
    ];
    expect(evaluateExtractQuality(junk)).toEqual({
      ok: false,
      reason: 'missing_tx_date_malformed_amount',
    });
  });

  it('lets a plausible trade table through', () => {
    expect(evaluateExtractQuality([tx()])).toEqual({ ok: true });
    expect(evaluateExtractQuality([])).toEqual({ ok: true });
  });

  it('does not hard-stop on exactly 50% placeholder junk (strict majority)', () => {
    const mixed = [
      tx({ assetName: '........................................', ticker: null }),
      tx({ assetName: 'Apple Inc', ticker: 'AAPL' }),
    ];
    expect(evaluateExtractQuality(mixed)).toEqual({ ok: true });
  });

  it('does not hard-stop on exactly 50% null-amount junk (strict majority)', () => {
    const mixed = [
      tx({ amountMin: null, amountMax: null, assetName: 'Apple Inc' }),
      tx({ amountMin: 1001, amountMax: 15000, assetName: 'Microsoft' }),
    ];
    expect(evaluateExtractQuality(mixed)).toEqual({ ok: true });
  });

  it('hard-stops majority placeholder assets', () => {
    const junk = [
      tx({ assetName: '........................................', ticker: null }),
      tx({ assetName: 'Unparsed Historical Filing', ticker: null }),
      tx({ assetName: '......s', ticker: null }),
    ];
    expect(evaluateExtractQuality(junk)).toEqual({ ok: false, reason: 'placeholder_asset' });
    expect(isPlaceholderAgreementAsset('........................................')).toBe(true);
  });

  it('hard-stops majority null-amount rows even when dates are present', () => {
    const junk = [
      tx({ amountMin: null, amountMax: null, assetName: 'Apple Inc' }),
      tx({ amountMin: null, amountMax: null, assetName: 'Microsoft' }),
      tx({ amountMin: null, amountMax: null, assetName: 'Nvidia' }),
    ];
    expect(evaluateExtractQuality(junk)).toEqual({ ok: false, reason: 'null_amount' });
  });

  it('drops placeholder and null-amount rows so they cannot vote', () => {
    const rows = [
      tx(),
      tx({ assetName: '......s', ticker: null, confidence: 0.99 }),
      tx({ amountMin: null, amountMax: null, assetName: 'Ghost Co', confidence: 0.99 }),
    ];
    expect(isJunkAgreementRow(rows[1])).toBe(true);
    expect(isJunkAgreementRow(rows[2])).toBe(true);
    expect(dropJunkAgreementRows(rows)).toEqual([rows[0]]);
  });
});

describe('agreement hard-stop', () => {
  it('does not enqueue the trio on an already-failed letterhead read', () => {
    const electronic = filing({ docId: 'H-2025-20030634', docKind: 'scanned_pdf' });
    expect(shouldEnqueueAgreement({
      filing: electronic,
      extractor: 'openRouterVision',
      quality: { ok: false, reason: 'letterhead_as_asset' },
      reviewReason: 'form_chrome_only,letterhead_as_asset',
    })).toBe(false);
    expect(shouldSkipAgreementForReviewReason('form_chrome_only,extract_empty_failure')).toBe(true);
    expect(shouldSkipAgreementForReviewReason('placeholder_asset')).toBe(true);
    expect(shouldSkipAgreementForReviewReason('null_amount')).toBe(true);
    expect(shouldSkipAgreementForReviewReason('agreement_cascade_unresolved')).toBe(false);
  });

  it('does not enqueue agreement for electronic / typed House PTRs', () => {
    expect(shouldEnqueueAgreement({
      filing: filing({ docId: 'H-2025-20030634', docKind: 'text_pdf' }),
      extractor: 'openRouterText',
      quality: { ok: true },
    })).toBe(false);
  });

  it('allows agreement only for a plausible real-scan read', () => {
    expect(shouldEnqueueAgreement({
      filing: filing({ docId: 'H-2025-8221302', docKind: 'scanned_pdf' }),
      extractor: 'openRouterVision',
      quality: { ok: true },
    })).toBe(true);
  });
});

describe('looksLikePlausibleTradeTable', () => {
  it('requires trade tokens, not letterhead-only chrome', () => {
    expect(looksLikePlausibleTradeTable('Clerk of the House')).toBe(false);
    expect(looksLikePlausibleTradeTable(
      'SP  Apple Inc. (AAPL) [ST]\nP  06/14/2024  06/20/2024  $1,001 - $15,000',
    )).toBe(true);
  });
});

describe('typed PTR cost envelope', () => {
  it('keeps the cheap path far below the Files prepaid hold', () => {
    expect(TYPED_PTR_CHEAP_PATH_USD_CEILING).toBeLessThan(OPENROUTER_FILES_HOLD_USD);
    expect(TYPED_PTR_CHEAP_PATH_USD_CEILING / OPENROUTER_FILES_HOLD_USD).toBeLessThan(0.05);
  });
});
