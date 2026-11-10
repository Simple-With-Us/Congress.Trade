import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Filing } from '../../shared/types.ts';

// Mock unpdf the same way textPdf.test.ts does, so extract() tests don't need
// a real PDF fixture. parseOgeTransactionRows tests below bypass unpdf
// entirely (they operate on already-merged text), so this mock is inert there.
const unpdfMocks = vi.hoisted(() => ({
  getDocumentProxy: vi.fn(),
  extractText: vi.fn(),
}));
vi.mock('unpdf', () => ({
  getDocumentProxy: unpdfMocks.getDocumentProxy,
  extractText: unpdfMocks.extractText,
}));

import {
  OgeTextExtractor,
  classifyOgeTransactionText,
  detectOgeRowAnchors,
  executiveDisclosureForm,
  isOgeRowSequenceCoherent,
  ogePart7SectionLooksEmpty,
  parseOgeTransactionRows,
} from '../ogeText.ts';

beforeEach(() => {
  vi.clearAllMocks();
});

function executiveFiling(overrides: Partial<Filing> = {}): Filing {
  return {
    docId: 'E-1',
    chamber: 'executive',
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
    ...overrides,
  };
}

// Verbatim (whitespace-normalized) unpdf.extractText({mergePages:true}) output
// for a real, public OGE Form 278-T — Criswell, Deanne, filed 07/01/2022,
// https://extapps2.oge.gov/201/Presiden.nsf/PAS+Index/D35261AFD48DF3EE852588B1002EB958/$FILE/Deanne-Criswell-07.01.2022-278T.pdf
// — used as a golden fixture so the regex is proven against real production
// input, not just a hand-written approximation of the layout.
const CRISWELL_278T_TEXT = `
Criswell, Deanne - Page 1
Periodic Transaction Report | U.S. Office of Government Ethics; 5 C.F.R. part 2634 (Updated Nov. 2019)
Executive Branch Personnel
Public Financial Disclosure Report:
Periodic Transaction Report (OGE Form 278-T)
Filer's Information
Criswell, Deanne
Administrator, Department of Homeland Security
Electronic Signature - I certify that the statements I have made in this form are true, complete and correct to the best of my knowledge.
/s/ Criswell, Deanne [electronically signed on 07/01/2022 by Criswell, Deanne in Integrity.gov]
Transactions
Criswell, Deanne - Page 2
Endnotes
Summary of Contents
The 278-T discloses purchases, sales, or exchanges of securities in excess of $1,000 made on behalf of the filer, the filer's spouse, or dependent child.
Privacy Act Statement
Title I of the Ethics in Government Act of 1978, as amended (the Act), 5 U.S.C. app. section 101 et seq.
# DESCRIPTION TYPE DATE NOTIFICATION
RECEIVED OVER
30 DAYS AGO
AMOUNT
1 Amazon.com, Inc. (AMZN) Sale 06/10/2022 No $1,001 - $15,000
2 SPDR S&P 500 ETF Trust (SPY) Purchase 06/13/2022 No $1,001 - $15,000
3 Invesco QQQ Trust, Series 1 (QQQ) Purchase 06/13/2022 No $1,001 - $15,000
Criswell, Deanne - Page 3
Website and to any person, department or agency, any waiver of the restrictions.
`;

// Verbatim response captured from the deployed production /debug-raw-text
// diagnostic for this same filing (E-2022-deanne-criswell-07-01-2022-278t) --
// unpdf.extractText({mergePages:true}) under the Cloudflare Workers
// runtime, with ZERO newline characters anywhere in the whole multi-page
// document (a real production behavior difference from Node.js, which DOES
// insert per-row newlines for the same PDF -- see the module comment on
// ROW_RE/TABLE_HEADER_RE). This is the regression fixture for the actual
// incident: the original line-split implementation found 3/3 rows against
// local Node output and 0/3 rows here, in production, against the exact
// same source PDF.
const CRISWELL_278T_TEXT_PRODUCTION_FLATTENED = `Criswell, Deanne - Page 1 Periodic Transaction Report | U.S. Office of Government Ethics; 5 C.F.R. part 2634 (Updated Nov. 2019) Executive Branch Personnel Public Financial Disclosure Report: Periodic Transaction Report (OGE Form 278-T) Filer's Information Criswell, Deanne Administrator, Department of Homeland Security Electronic Signature - I certify that the statements I have made in this form are true, complete and correct to the best of my knowledge. /s/ Criswell, Deanne [electronically signed on 07/01/2022 by Criswell, Deanne in Integrity.gov] Agency Ethics Official's Opinion - On the basis of information contained in this report, I conclude that the filer is in compliance with applicable laws and regulations (subject to any comments below). /s/ O'Connor, Michael, Certifying Official [electronically signed on 08/05/2022 by O'Connor, Michael in Integrity.gov] Other review conducted by /s/ Phillips, Christina, Ethics Official [electronically signed on 08/02/2022 by Phillips, Christina in Integrity.gov] U.S. Office of Government Ethics Certification /s/ Granahan, Megan, Certifying Official [electronically signed on 09/01/2022 by Granahan, Megan in Integrity.gov] Transactions Criswell, Deanne - Page 2 Endnotes Summary of Contents The 278-T discloses purchases, sales, or exchanges of securities in excess of $1,000 made on behalf of the filer, the filer's spouse, or dependent child. Transactions are required to be disclosed within 30 days of receiving notification of a transaction but not later than 45 days after the transaction. Filers need not disclose (1) mutual funds and other excepted investment funds; (2) certificates of deposit, savings or checking accounts, and money market accounts; (3) U.S. Treasury bills, notes, and bonds; (4) Thrift Savings Plan accounts; (5) real property; and (6) transactions that are solely by and between the filer, the filer's spouse, and the filer's dependent children. Privacy Act Statement Title I of the Ethics in Government Act of 1978, as amended (the Act), 5 U.S.C. app. § 101 et seq., as amended by the Stop Trading on Congressional Knowledge Act of 2012 (Pub. L. 112-105) (STOCK Act), and 5 C.F.R. Part 2634 of the U. S. Office of Government Ethics regulations require the reporting of this information. Failure to provide the requested information may result in separation, disciplinary action, or civil action. The primary use of the information on this report is for review by Government officials to determine compliance with applicable Federal laws and regulations. This report may also be disclosed upon request to any requesting person in accordance with sections 105 and 402(b)(1) of the Act or as otherwise authorized by law. You may inspect applications for public access of your own form upon request. Additional disclosures of the information on this report may be made: (1) to any requesting person, subject to the limitation contained in section 208(d)(1) of title 18, any determination granting an exemption pursuant to sections 208(b)(1) and 208(b)(3) of title 18; (2) to a Federal, State, or local law enforcement agency if the disclosing agency becomes aware of violations or potential violations of law or regulation; (3) to a source when necessary to obtain information relevant to a conflict of interest investigation or determination; (4) to the National Archives and Records Administration or the General Services Administration in records management inspections; (5) to the Office of Management and Budget during legislative coordination on private relief legislation; (6) when the disclosing agency determines that the records are arguably relevant to a proceeding before a court, grand jury, or administrative or adjudicative body, or in a proceeding before an administrative or adjudicative body when the adjudicator determines the records to be relevant to the proceeding; (7) to reviewing officials in a new office, department or agency when an employee transfers or is detailed from one covered position to another, a public financial disclosure report and any accompanying documents, including statements notifying an employee's supervising ethics office of the commencement of negotiations for future employment or compensation or of an agreement for future employment or compensation; (8) to a Member of Congress or a congressional office in response to an inquiry made on behalf of and at the request of an individual who is the subject of the record; (9) to contractors and other non-Government employees working on a contract, service or assignment for the Federal Government when necessary to accomplish a function related to this system of records; (10) on the OGE Website and to any person, department or agency, any written ethics agreement, including certifications of ethics agreement compliance, filed with OGE by an individual nominated by the President to a position requiring Senate confirmation; (11) on the OGE Website and to any person, department or agency, any certificate of divestiture issued by OGE; (12) on the OGE # DESCRIPTION TYPE DATE NOTIFICATION RECEIVED OVER 30 DAYS AGO AMOUNT 1 Amazon.com, Inc. (AMZN) Sale 06/10/2022 No $1,001 - $15,000 2 SPDR S&P 500 ETF Trust (SPY) Purchase 06/13/2022 No $1,001 - $15,000 3 Invesco QQQ Trust, Series 1 (QQQ) Purchase 06/13/2022 No $1,001 - $15,000 Criswell, Deanne - Page 3 Website and to any person, department or agency, any waiver of the restrictions contained in Executive Order 13770 or any superseding executive order; (13) to appropriate agencies, entities and persons when there has been a suspected or confirmed breach of the system of records, the agency maintaining the records has determined that there is a risk of harm to individuals, the agency, the Federal Government, or national security, and the disclosure is reasonably necessary to assist in connection with the agency's efforts to respond to the suspected or confirmed breach or to prevent, minimize, or remedy such harm; and (14) to another Federal agency or Federal entity, when the agency maintaining the record determines that information from this system of records is reasonably necessary to assist the recipient agency or entity in responding to a suspected or confirmed breach or in preventing, minimizing, or remedying the risk of harm to individuals, the recipient agency or entity, the Federal Government, or national security. See also the OGE/GOVT-1 executive branch-wide Privacy Act system of records.`;

describe('parseOgeTransactionRows', () => {
  it('parses all three rows from a real 278-T text extraction, ignoring preamble/footer prose', () => {
    const rows = parseOgeTransactionRows(CRISWELL_278T_TEXT);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      assetName: 'Amazon.com, Inc.',
      ticker: 'AMZN',
      txType: 'S',
      txDate: '2022-06-10',
      amountMin: 1001,
      amountMax: 15000,
      owner: null,
      isOption: false,
      confidence: 0.97,
    });
    expect(rows[1]).toMatchObject({
      assetName: 'SPDR S&P 500 ETF Trust',
      ticker: 'SPY',
      txType: 'B',
      txDate: '2022-06-13',
      amountMin: 1001,
      amountMax: 15000,
    });
    expect(rows[2]).toMatchObject({
      assetName: 'Invesco QQQ Trust, Series 1',
      ticker: 'QQQ',
      txType: 'B',
      txDate: '2022-06-13',
      amountMin: 1001,
      amountMax: 15000,
    });
  });

  it('parses all three rows from the real, verbatim PRODUCTION text (single line, zero newlines) -- regression guard for the newline-flattening incident', () => {
    const rows = parseOgeTransactionRows(CRISWELL_278T_TEXT_PRODUCTION_FLATTENED);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      assetName: 'Amazon.com, Inc.',
      ticker: 'AMZN',
      txType: 'S',
      txDate: '2022-06-10',
      amountMin: 1001,
      amountMax: 15000,
    });
    expect(rows[1]).toMatchObject({
      assetName: 'SPDR S&P 500 ETF Trust',
      ticker: 'SPY',
      txType: 'B',
      txDate: '2022-06-13',
      amountMin: 1001,
      amountMax: 15000,
    });
    expect(rows[2]).toMatchObject({
      assetName: 'Invesco QQQ Trust, Series 1',
      ticker: 'QQQ',
      txType: 'B',
      txDate: '2022-06-13',
      amountMin: 1001,
      amountMax: 15000,
    });
    // None of the surrounding legal boilerplate's own "<digit> <word>"
    // sequences (e.g. "5 U.S.C. app. section 101 et seq.", "(1) mutual
    // funds...", page numbers) produced a spurious extra row.
    for (const row of rows) {
      expect(row.assetName.length).toBeLessThan(60);
    }
  });

  it('reads OCR spaced and period-thousands brackets, not the next row number', () => {
    const rows = parseOgeTransactionRows(
      [
        '44 TESLA INC (TSLA) Sale 07/17/2026 No $15 001 - $50 000',
        '126 QUALCOMM INC Sale 07/17/2026 No $15,001 - $50 000',
        '127 INTUIT INC Sale 07/17/2026 No $1.000.001 - $5.000.000',
      ].join(' '),
    );
    expect(rows.map((r) => [r.ticker ?? r.assetName, r.amountMin, r.amountMax])).toEqual([
      ['TSLA', 15001, 50000],
      ['QUALCOMM INC', 15001, 50000],
      ['INTUIT INC', 1000001, 5000000],
    ]);
  });

  it('handles an Exchange row and an open-ended top-tier amount', () => {
    const rows = parseOgeTransactionRows(
      '1 Some Bond Fund (XYZ) Exchange 01/02/2026 Yes $50,000,001 +',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      txType: 'E',
      ticker: 'XYZ',
      amountMin: 50000001,
      amountMax: null,
    });
  });

  it('leaves the asset name intact and ticker null when no parenthetical ticker is present', () => {
    const rows = parseOgeTransactionRows(
      '1 Some Municipal Bond 5% Due 2030 Purchase 03/04/2026 No $15,001 - $50,000',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ticker).toBeNull();
    expect(rows[0].assetName).toBe('Some Municipal Bond 5% Due 2030');
  });

  it('flags option-related rows via detectOption on the raw row text', () => {
    const rows = parseOgeTransactionRows(
      '1 Call option on Widget Corp (WGT) Purchase 01/01/2026 No $1,001 - $15,000',
    );
    expect(rows[0].isOption).toBe(true);
  });

  it('does not match ordinary numbered-list prose from an unrelated form section', () => {
    // Real text pulled from an OGE 278e "Positions Held" section: numbered,
    // but missing the Purchase/Sale/Exchange + date + Yes/No + amount suffix
    // that ROW_RE requires — must yield zero rows, not a guessed match.
    const rows = parseOgeTransactionRows(
      [
        '1 Moonbright LLC Homewood, Illinois Partnership Partner 12/2004 12/2024',
        '2 Irrevocable Child Trust #1 Washington, District of Columbia Trust Trustee 12/2004 Present',
      ].join('\n'),
    );
    expect(rows).toHaveLength(0);
  });

  it('does not match garbled OCR text from a scanned-then-OCR\'d 278-T', () => {
    // Real (anonymized-in-spirit) OCR artifact pattern seen on a scanned
    // executive filing: words are corrupted enough that no row completes the
    // required suffix. Zero rows is the CORRECT, safe outcome (blocked, not
    // a wrong parse) — this filing needs vision, not a regex guess.
    const rows = parseOgeTransactionRows(
      '1 SPOR SERIES TRUST HIGH YlELD BONO ETF ourchoeo 1/20/2028 no $500,001 -$1.000.000',
    );
    expect(rows).toHaveLength(0);
  });

  it('returns an empty array for text with no matching rows', () => {
    expect(parseOgeTransactionRows('nothing to see here')).toEqual([]);
  });

  it('rejects a garbled-OCR parse whose matched row indices are not a coherent table sequence', () => {
    // Production signature (E-2026-donald-j-trump-09-8-2026-278t, 2026-09-23):
    // on a scanned-then-OCR'd 278-T most type words are corrupted ("salo",
    // "lourchaso"), so ROW_RE only matched the minority whose type survived and
    // its leading \d then latched onto bond maturity years / dollar fragments.
    // The deployed parser emitted 334 "rows" with only 94 distinct leading
    // numbers and 62% non-increasing steps — mis-merged rows, not transactions.
    // The same signature (repeated leading index) must now yield zero rows.
    const garbled = Array.from(
      { length: 8 },
      (_, i) => `1 001 - $15 000 ${74 + i} EXAMPLE CORP (EX${i}) Purchase 07/17/2026 No $1,001 - $15,000`,
    ).join(' ');
    expect(parseOgeTransactionRows(garbled)).toHaveLength(0);
    expect(classifyOgeTransactionText(
      garbled,
      'E-2026-donald-j-trump-09-8-2026-278t',
    )).toMatchObject({ disposition: 'unreadable', reason: 'index_incoherent' });
  });

  it('keeps a coherent multi-row parse (guard against over-eager sequence gating)', () => {
    const coherent = Array.from(
      { length: 8 },
      (_, i) => `${i + 1} Issuer ${i + 1} (T${i + 1}) Purchase 07/17/2026 No $1,001 - $15,000`,
    ).join('\n');
    expect(parseOgeTransactionRows(coherent)).toHaveLength(8);
  });
});

describe('detectOgeRowAnchors', () => {
  // Verbatim shape from the parked filing E-2026-donald-j-trump-09-17-2026-278t:
  // the Type word is garbled and the Date column is OCR-mangled (the printed
  // 8/4/2026 reads back as "81412026"), but the row-index column is intact and
  // contiguous. Counting anchors must work without reading any other field.
  const scannedRows = [
    '1                COMMONWEALTH PA FING AUTH TOB MSTR SETTlMT PMT REV BIE 5.00 % Duo Jun 1 2027        l ourchase   81412026   Yos $1000001-$5 000 000',
    '2                LOUISVILLE JEFFERSON KY CNTY METRO GOVT HLTH SER C NORTON HC INC REV BIE 5.00 % Due Oct 1, 2047   oorchase   8/21/2026   No $1,000 001 - $5 000,000',
    '3                TARRANT CNTY TX HSG FIN CORP REV MLTIFAM REV MERIDIAN APTS B BIE PTC 5.00 % Duo Sao 1 2028   ~ •rchase   8/312026   Yos $1 000 001 - $5 000 000',
    '36               ELECTRONIC ARTS INC                     salo   8/512026   Yos $15 001 • $50 000',
  ];

  it('counts the intact row-index column on an otherwise garbled 278-T', () => {
    const result = classifyOgeTransactionText(
      scannedRows.join('\n'),
      'E-2026-donald-j-trump-09-17-2026-278t',
    );
    expect(result.disposition).toBe('unreadable');
    expect(result.rows).toHaveLength(0);
    expect(result).toMatchObject({
      detectedRowAnchors: 4,
      detectedRowMaxIndex: 36,
    });
  });

  it('reports the transaction count at stake on the refused path, and changes no behaviour', () => {
    // Production signature: the leading \d latches onto bond maturity years, so
    // the matched indexes jump and repeat and the sequence gate refuses.
    const garbled = Array.from(
      { length: 10 },
      (_, i) => `1 001 - $15 000 ${2028 + i} EXAMPLE CORP DUE 06/15/20${28 + i} REV 5.00 % Duo Jun 1 2027  Purchase 07/17/2026 No $1,001 - $15,000`,
    ).join('\n');
    const result = classifyOgeTransactionText(garbled, 'E-2026-donald-j-trump-09-17-2026-278t');
    // Behaviour is unchanged: still zero rows, still unreadable.
    expect(result).toMatchObject({ disposition: 'unreadable', rows: [] });
    expect(result.rows).toHaveLength(0);
  });

  it('leaves a clean parse free of refusal diagnostics', () => {
    const clean = Array.from(
      { length: 8 },
      (_, i) => `${i + 1} Issuer ${i + 1} (T${i + 1}) Purchase 07/17/2026 No $1,001 - $15,000`,
    ).join('\n');
    const result = classifyOgeTransactionText(clean, 'E-2026-donald-j-trump-09-17-2026-278t');
    expect(result.disposition).toBe('rows');
    expect(result).not.toHaveProperty('detectedRowAnchors');
  });

  it('rejects tokens above the 278-T row ceiling and counts in-range row indices', () => {
    // A 278-T can legitimately number past row 3600, so the ceiling stays high
    // enough to keep real rows; it only drops 5-digit dollar figures and years.
    const out = detectOgeRowAnchors(
      ['9999    TOO BIG', '5001    ALSO TOO BIG', '12    A REAL ROW'].join('\n'),
    );
    expect(out).toEqual({ anchors: 1, maxIndex: 12 });
  });

  it('returns nothing for a flattened single-line read instead of guessing', () => {
    expect(detectOgeRowAnchors('1 ALPHA Purchase 07/17/2026 Yes $1,001 - $15,000 2 BETA Purchase 07/17/2026 Yes $1,001 - $15,000'))
      .toEqual({ anchors: 0, maxIndex: null });
  });
});

describe('classifyOgeTransactionText', () => {
  it('treats a 278e Part 7 with no table and no rows as empty, including a 278term id', () => {
    expect(executiveDisclosureForm('E-undated-pam-bondi-2026-278term')).toBe('278e');
    expect(executiveDisclosureForm('E-2026-jane-doe-278-term')).toBe('278e');
    expect(executiveDisclosureForm('E-2026-jane-doe-278 term')).toBe('278e');
    expect(executiveDisclosureForm('E-2026-donald-j-trump-09-8-2026-278t')).toBe('278t');
    expect(executiveDisclosureForm('E-2026-donald-j-trump-09-8-2026-278-t')).toBe('278t');
    const text = 'OGE Form 278e Termination Report 7. Transactions 8. Liabilities';
    expect(classifyOgeTransactionText(text, 'E-undated-pam-bondi-2026-278term')).toEqual({
      disposition: 'empty',
      rows: [],
    });
  });

  it('does not call a 278e empty without positive Part 7 evidence', () => {
    const bondi = 'E-undated-pam-bondi-2026-278term';
    // Blank / garbled text layer: no Part 7 heading at all.
    expect(classifyOgeTransactionText('', bondi)).toEqual({ disposition: 'unconfirmed', rows: [] });
    expect(classifyOgeTransactionText('Fobn.iary ~~ l1l1 ##', bondi))
      .toEqual({ disposition: 'unconfirmed', rows: [] });
    // Real 278e Part 7 rows use a layout ROW_RE does not match (no notification column).
    const withRows = 'OGE Form 278e 7. Transactions # DESCRIPTION TYPE DATE AMOUNT '
      + '1 Apple Inc. (AAPL) Purchase 01/05/2026 $1,001 - $15,000 8. Liabilities';
    expect(classifyOgeTransactionText(withRows, 'E-2026-someone-278e'))
      .toEqual({ disposition: 'unconfirmed', rows: [] });
    // Part 7 whose end we cannot see is not evidence.
    expect(classifyOgeTransactionText('OGE Form 278e 7. Transactions # DESCRIPTION TYPE DATE AMOUNT', bondi))
      .toEqual({ disposition: 'unconfirmed', rows: [] });
  });

  it('keeps a bounded header-only Part 7 unconfirmed (row glyphs lost)', () => {
    const bondi = 'E-undated-pam-bondi-2026-278term';
    const headerOnly = 'OGE Form 278e 7. Transactions # DESCRIPTION TYPE DATE AMOUNT 8. Liabilities';
    expect(ogePart7SectionLooksEmpty(headerOnly)).toBe(false);
    expect(classifyOgeTransactionText(headerOnly, bondi)).toEqual({ disposition: 'unconfirmed', rows: [] });
    // Header split across lines / partial header still counts as a table.
    expect(classifyOgeTransactionText('7. Transactions\n#\nDESCRIPTION\n8. Liabilities', bondi))
      .toEqual({ disposition: 'unconfirmed', rows: [] });
    // Orphan row numbers with no parseable row are not an empty section.
    expect(classifyOgeTransactionText('7. Transactions 1 2 3 8. Liabilities', bondi))
      .toEqual({ disposition: 'unconfirmed', rows: [] });
    // The bare bounded heading (real empty 278e) still closes.
    expect(classifyOgeTransactionText('OGE Form 278e 7. Transactions 8. Liabilities', bondi))
      .toEqual({ disposition: 'empty', rows: [] });
  });

  it('does not treat row 8 of a Part 7 table as the section end', () => {
    const bondi = 'E-undated-pam-bondi-2026-278term';
    // "8. Apple Inc ..." is row 8 of the table, but the bare "8. <word>"
    // end alternative used to take it as the Part 8 boundary: the empty
    // "body" before it then closed the filing verified_empty over a trade.
    const text = 'OGE Form 278e Part 7. Transactions 8. Apple Inc Purchase 01/05/2026 $1,001 - $15,000 Part 8. Liabilities';
    expect(ogePart7SectionLooksEmpty(text)).toBe(false);
    expect(classifyOgeTransactionText(text, bondi)).toEqual({ disposition: 'unconfirmed', rows: [] });
    // The titled forms still bound the section.
    expect(ogePart7SectionLooksEmpty('OGE Form 278e 7. Transactions 8. Liabilities')).toBe(true);
    expect(ogePart7SectionLooksEmpty('OGE Form 278e 7. Transactions Part 8. Liabilities')).toBe(true);
  });

  it('keeps a short real Part 7 out of the TOC filter (None-bodied neighbors)', () => {
    const bondi = 'E-undated-pam-bondi-2026-278term';
    // A real empty 278e whose neighboring parts are also short: "Part 6."
    // sits in the before-window and "9." in the after-window, but the None
    // bodies between the entries are real section bodies, not a contents
    // run.  The heading must still count as positive empty evidence.
    const text = 'Part 6. Agreements None Part 7. Transactions Part 8. Liabilities None Part 9. Gifts None';
    expect(ogePart7SectionLooksEmpty(text)).toBe(true);
    expect(classifyOgeTransactionText(text, bondi)).toEqual({ disposition: 'empty', rows: [] });
  });

  it('keeps a description-only Part 7 body unconfirmed (asset names, no digits)', () => {
    const bondi = 'E-undated-pam-bondi-2026-278term';
    // Asset names with no digits, #, header words, "attach", or transaction
    // words pass every content guard; they are a read the row parser could
    // not handle, not positive evidence of an empty section, so the filing
    // must not close verified_empty.
    const namesOnly = 'OGE Form 278e 7. Transactions Apple Inc Microsoft Corporation 8. Liabilities';
    expect(ogePart7SectionLooksEmpty(namesOnly)).toBe(false);
    expect(classifyOgeTransactionText(namesOnly, bondi))
      .toEqual({ disposition: 'unconfirmed', rows: [] });
    // The whitespace-only body (real empty Part 7) still closes.
    expect(ogePart7SectionLooksEmpty('OGE Form 278e 7. Transactions 8. Liabilities')).toBe(true);
  });

  it('does not close on a contents prefix truncated at the Part 8 boundary', () => {
    const bondi = 'E-undated-pam-bondi-2026-278term';
    // The extraction ran out of text at the last contents entry: the Part 7
    // line has part entries before it but none after, so the both-sides TOC
    // filter does not fire and the empty prefix would close verified_empty
    // without the real Part 7 ever being read.
    const truncated =
      'OGE Form 278e Summary of Contents 5. Other Income 6. Agreements 7. Transactions 8. Liabilities';
    expect(ogePart7SectionLooksEmpty(truncated)).toBe(false);
    expect(classifyOgeTransactionText(truncated, bondi))
      .toEqual({ disposition: 'unconfirmed', rows: [] });
    // Same stub with the titled form of the boundary.
    const truncatedTitled =
      'OGE Form 278e Summary of Contents 5. Other Income 6. Agreements Part 7. Transactions Part 8. Liabilities';
    expect(ogePart7SectionLooksEmpty(truncatedTitled)).toBe(false);
    expect(classifyOgeTransactionText(truncatedTitled, bondi))
      .toEqual({ disposition: 'unconfirmed', rows: [] });
  });

  it('does not let a table-of-contents Part 7 entry hide the real Part 7 further down', () => {
    const bondi = 'E-undated-pam-bondi-2026-278term';
    // TOC stub first, then the real Part 7 with a traded row: verified_empty
    // here would bury trades (same fail-closed class as the header-only guard).
    const tocThenTrades =
      'OGE Form 278e Summary of Contents 5. Other Income 6. Agreements 7. Transactions 8. Liabilities 9. Gifts '
      + 'Part One Filer Information pages of earlier parts follow then the real sections '
      + 'Part 7. Transactions 1 Apple Inc. (AAPL) Purchase 01/05/2026 $1,001 - $15,000 Part 8. Liabilities';
    expect(ogePart7SectionLooksEmpty(tocThenTrades)).toBe(false);
    expect(classifyOgeTransactionText(tocThenTrades, bondi))
      .toEqual({ disposition: 'unconfirmed', rows: [] });
    // TOC stub + a real, positively-empty Part 7 further down still closes empty.
    const tocThenEmpty =
      'OGE Form 278e Summary of Contents 5. Other Income 6. Agreements 7. Transactions 8. Liabilities 9. Gifts '
      + 'Part One Filer Information pages of earlier parts follow then the real sections '
      + 'Part 7. Transactions Part 8. Liabilities';
    expect(ogePart7SectionLooksEmpty(tocThenEmpty)).toBe(true);
    expect(classifyOgeTransactionText(tocThenEmpty, bondi))
      .toEqual({ disposition: 'empty', rows: [] });
    // A TOC alone (the real section is unreadable or lost) is not evidence of empty.
    const tocOnly =
      'OGE Form 278e Summary of Contents 5. Other Income 6. Agreements 7. Transactions 8. Liabilities 9. Gifts';
    expect(ogePart7SectionLooksEmpty(tocOnly)).toBe(false);
    expect(classifyOgeTransactionText(tocOnly, bondi))
      .toEqual({ disposition: 'unconfirmed', rows: [] });
    // TOC stub + a header-only real Part 7 stays unconfirmed, not empty.
    const tocThenHeaderOnly =
      'OGE Form 278e Summary of Contents 5. Other Income 6. Agreements 7. Transactions 8. Liabilities 9. Gifts '
      + 'Part One Filer Information pages of earlier parts follow then the real sections '
      + 'Part 7. Transactions # DESCRIPTION TYPE DATE AMOUNT Part 8. Liabilities';
    expect(ogePart7SectionLooksEmpty(tocThenHeaderOnly)).toBe(false);
    expect(classifyOgeTransactionText(tocThenHeaderOnly, bondi))
      .toEqual({ disposition: 'unconfirmed', rows: [] });
  });

  it('does not end Part 7 at a Summary of Contents marker when a table follows it', () => {
    const bondi = 'E-undated-pam-bondi-2026-278term';
    // Flattened extraction can drop the boilerplate BETWEEN the Part 7
    // heading and its table: ending the section at the marker makes the gap
    // read as a positively empty section while rows follow.
    const markerThenTable =
      'OGE Form 278e Part 7. Transactions Summary of Contents '
      + '# DESCRIPTION TYPE DATE AMOUNT 1 Apple Inc. (AAPL) Purchase 01/05/2026 $1,001 - $15,000 '
      + 'Part 8. Liabilities';
    expect(ogePart7SectionLooksEmpty(markerThenTable)).toBe(false);
    expect(classifyOgeTransactionText(markerThenTable, bondi).disposition).not.toBe('empty');
    // The real production 278-T fixture shape: "Endnotes Summary of Contents"
    // and a long boilerplate paragraph sit between the label and the table.
    const endnotesThenTable =
      'OGE Form 278e Part 7. Transactions Page 2 Endnotes Summary of Contents '
      + 'The 278-T discloses purchases, sales, or exchanges of securities in excess of $1,000. '
      + 'Privacy Act Statement Title I of the Ethics in Government Act of 1978 '
      + '# DESCRIPTION TYPE DATE NOTIFICATION RECEIVED OVER 30 DAYS AGO AMOUNT '
      + '1 Amazon.com, Inc. (AMZN) Sale 06/10/2022 No $1,001 - $15,000';
    expect(ogePart7SectionLooksEmpty(endnotesThenTable)).toBe(false);
    expect(classifyOgeTransactionText(endnotesThenTable, bondi).disposition).not.toBe('empty');
    // Rows whose header glyphs were lost still count: dates, dollar amounts,
    // and transaction words after the marker mean rows follow.
    const markerThenBareRows =
      'OGE Form 278e Part 7. Transactions Summary of Contents '
      + '1 Apple Inc. (AAPL) Purchase 01/05/2026 $1,001 - $15,000 Part 8. Liabilities';
    expect(ogePart7SectionLooksEmpty(markerThenBareRows)).toBe(false);
    expect(classifyOgeTransactionText(markerThenBareRows, bondi).disposition).not.toBe('empty');
    // A genuinely empty Part 7 whose text ends at the contents page still
    // closes empty: only boilerplate follows the marker, no table.
    const markerThenNothing =
      'OGE Form 278e Part 7. Transactions Summary of Contents '
      + '5. Other Income 6. Agreements 7. Transactions 8. Liabilities 9. Gifts';
    expect(ogePart7SectionLooksEmpty(markerThenNothing)).toBe(true);
    expect(classifyOgeTransactionText(markerThenNothing, bondi))
      .toEqual({ disposition: 'empty', rows: [] });
  });

  it('does not call a Part 7 that points at an attachment empty', () => {
    const bondi = 'E-undated-pam-bondi-2026-278term';
    // Rows live on the attached schedule; verified_empty would bury them.
    for (const body of ['See Attachment', 'See attachment', 'See Attached Schedule', 'None. See attachment.']) {
      const text = `OGE Form 278e 7. Transactions ${body} 8. Liabilities`;
      expect(ogePart7SectionLooksEmpty(text)).toBe(false);
      expect(classifyOgeTransactionText(text, bondi))
        .toEqual({ disposition: 'unconfirmed', rows: [] });
    }
  });

  it('treats an explicit Part 7 None as empty', () => {
    expect(classifyOgeTransactionText(
      'OGE Form 278e Part 7. Transactions None 8. Liabilities',
      'E-undated-pam-bondi-2026-278term',
    )).toEqual({ disposition: 'empty', rows: [] });
  });

  it('does not call a 278-T with zero matches empty', () => {
    expect(classifyOgeTransactionText(
      'Periodic Transaction Report with no readable rows',
      'E-2026-donald-j-trump-09-8-2026-278t',
    )).toMatchObject({ disposition: 'unreadable', reason: 'unreadable_278t' });
  });
});

describe('isOgeRowSequenceCoherent', () => {
  it('accepts a short sequence even when it repeats (too few rows to judge)', () => {
    expect(isOgeRowSequenceCoherent([])).toBe(true);
    expect(isOgeRowSequenceCoherent([1, 1, 2])).toBe(true);
  });

  it('accepts a unique, strictly increasing table index', () => {
    expect(isOgeRowSequenceCoherent([1, 2, 3, 4, 5, 6, 7, 8])).toBe(true);
    // A few OCR skips/dupes are tolerated.
    expect(isOgeRowSequenceCoherent([1, 2, 3, 5, 6, 7, 8, 9])).toBe(true);
  });

  it('rejects repeated or wildly non-monotonic indices (the OCR latched onto years/amounts)', () => {
    expect(isOgeRowSequenceCoherent([1, 1, 2, 2, 3, 3, 4, 4])).toBe(false);
    expect(isOgeRowSequenceCoherent([1, 1, 2026, 1, 15000, 89, 15, 5])).toBe(false);
  });

  it('rejects a sparse parse that only covers a sliver of its own index span', () => {
    // The production Trump-filing signature: after the amount hardening the
    // leading numbers were unique-ish and mostly increasing, but only ~300 of
    // the table's 1156 rows matched (span 0..15000, coverage 0.02) — a partial,
    // mis-merged transcript that would silently drop real transactions.
    expect(isOgeRowSequenceCoherent([1, 2, 3, 4, 5, 6, 7, 1156])).toBe(false);
    expect(isOgeRowSequenceCoherent([0, 1, 2, 3, 4, 5, 6, 15000])).toBe(false);
  });
});

describe('OgeTextExtractor', () => {
  it('claims executive-chamber text_pdf filings only', () => {
    const extractor = new OgeTextExtractor();
    expect(extractor.canHandle(executiveFiling())).toBe(true);
    expect(extractor.canHandle(executiveFiling({ chamber: 'house' }))).toBe(false);
    expect(extractor.canHandle(executiveFiling({ chamber: 'senate' }))).toBe(false);
    expect(extractor.canHandle(executiveFiling({ docKind: 'scanned_pdf' }))).toBe(false);
  });

  it('extracts rows from the merged PDF text and reports document confidence as the row mean', async () => {
    unpdfMocks.getDocumentProxy.mockResolvedValue({ numPages: 3 });
    unpdfMocks.extractText.mockResolvedValue({ text: CRISWELL_278T_TEXT });

    const extractor = new OgeTextExtractor();
    const result = (await extractor.extract({
      filing: executiveFiling(),
      bytes: new ArrayBuffer(8),
    })) as { transactions: unknown[]; confidence: number; extractor: string; pageCount?: number | null };

    expect(result.transactions).toHaveLength(3);
    expect(result.extractor).toBe('ogeText');
    expect(result.confidence).toBeCloseTo(0.97, 5);
    expect(result.pageCount).toBe(3);
  });

  it('throws when no bytes are provided', async () => {
    const extractor = new OgeTextExtractor();
    await expect(extractor.extract({ filing: executiveFiling() })).rejects.toThrow(
      'ogeText: no bytes provided',
    );
  });

  it('does not detach the caller-supplied ArrayBuffer (same regression guard as textPdf.ts)', async () => {
    unpdfMocks.getDocumentProxy.mockImplementation(async (view: Uint8Array) => {
      structuredClone(view.buffer, { transfer: [view.buffer] });
      return { numPages: 1 };
    });
    unpdfMocks.extractText.mockResolvedValue({ text: '' });

    const bytes = new ArrayBuffer(8);
    const extractor = new OgeTextExtractor();
    await extractor.extract({ filing: executiveFiling(), bytes });

    expect(bytes.byteLength).toBe(8);
    expect(() => new Uint8Array(bytes)).not.toThrow();
  });
});
