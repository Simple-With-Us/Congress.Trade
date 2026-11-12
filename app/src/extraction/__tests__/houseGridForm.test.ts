import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasHardFailureFlags, scoreFields } from '../normalizer.ts';
import { shouldEnqueueAgreement } from '../extractRouting.ts';
import type { Filing, ParsedTx } from '../../shared/types.ts';
import { HousePdfExtractor, type Extractor, type ExtractorResult } from '../../extractors/types.ts';
import {
  AMOUNT_COLUMNS,
  COLUMN_TEMPLATES,
  MARK_SCORE_MIN,
  TYPE_COLUMN,
  classifyMarkScores,
  fitColumnLines,
  cleanGridAssetName,
  ownerCodeFromCell,
  readOwnerCell,
  splitBareTicker,
  readHouseGridForm,
  xTemplateForFit,
  type GrayImage,
  type HouseGridOcrBox,
} from '../houseGridForm.ts';
import { parsePgm, parseTesseractTsv } from '../houseGridFormRuntime.ts';

function blank(width: number, height: number): GrayImage {
  const pixels = new Uint8Array(width * height);
  pixels.fill(255);
  return { width, height, pixels };
}

function vline(image: GrayImage, x: number, y0: number, y1: number): void {
  const xi = Math.round(x);
  for (let y = y0; y < y1; y += 1) {
    if (xi < 0 || xi >= image.width || y < 0 || y >= image.height) continue;
    image.pixels[y * image.width + xi] = 0;
    if (xi + 1 < image.width) image.pixels[y * image.width + xi + 1] = 0;
  }
}

function hline(image: GrayImage, y: number, x0: number, x1: number): void {
  const yi = Math.round(y);
  if (yi < 0 || yi >= image.height) return;
  for (let x = x0; x < x1; x += 1) image.pixels[yi * image.width + x] = 0;
}

function rect(image: GrayImage, x0: number, y0: number, x1: number, y1: number): void {
  hline(image, y0, x0, x1);
  hline(image, y1, x0, x1);
  vline(image, x0, y0, y1);
  vline(image, x1, y0, y1);
}

function stamp(image: GrayImage, glyph: GrayImage, cx: number, cy: number): void {
  const x0 = Math.round(cx - glyph.width / 2);
  const y0 = Math.round(cy - glyph.height / 2);
  for (let y = 0; y < glyph.height; y += 1) {
    for (let x = 0; x < glyph.width; x += 1) {
      const value = glyph.pixels[y * glyph.width + x];
      const dx = x0 + x;
      const dy = y0 + y;
      if (dx < 0 || dy < 0 || dx >= image.width || dy >= image.height) continue;
      if (value < 128) image.pixels[dy * image.width + dx] = 0;
    }
  }
}

interface DrawnRow {
  y0: number;
  y1: number;
  owner: string;
  asset: string;
  txDate: string;
  notifDate: string;
  marks: number[];
}

function drawGrid(scale: number, offset: number, rows: DrawnRow[]): {
  image: GrayImage;
  boxes: HouseGridOcrBox[];
  xs: number[];
} {
  const xs = COLUMN_TEMPLATES[0].map((value) => Math.round(offset + scale * value));
  const width = xs[xs.length - 1] + 30;
  const height = 900;
  const image = blank(width, height);
  const glyph = xTemplateForFit(scale);
  for (const x of xs) vline(image, x, 160, 780);
  const rules = [200, ...rows.flatMap((row) => [row.y0, row.y1]), 760];
  const unique = [...new Set(rules)].sort((a, b) => a - b);
  for (const y of unique) hline(image, y, xs[0], xs[xs.length - 1]);
  const boxes: HouseGridOcrBox[] = [];
  for (const row of rows) {
    for (let column = 2; column <= 19; column += 1) {
      if (column === 7 || column === 8) continue;
      const x0 = xs[column] + 6;
      const x1 = xs[column + 1] - 6;
      const y0 = row.y0 + 8;
      const y1 = row.y1 - 8;
      if (x1 - x0 > 8 && y1 - y0 > 8) rect(image, x0, y0, x1, y1);
    }
    for (const column of row.marks) {
      const cx = (xs[column] + xs[column + 1]) / 2;
      const cy = (row.y0 + row.y1) / 2;
      stamp(image, glyph, cx, cy);
    }
    boxes.push(
      { x0: xs[0] + 4, y0: row.y0 + 20, x1: xs[1] - 4, y1: row.y0 + 40, text: row.owner, conf: 0.95 },
      { x0: xs[1] + 8, y0: row.y0 + 16, x1: xs[2] - 20, y1: row.y0 + 40, text: row.asset, conf: 0.92 },
      { x0: xs[7] + 4, y0: row.y0 + 18, x1: xs[8] - 4, y1: row.y0 + 42, text: row.txDate, conf: 0.9 },
      { x0: xs[8] + 4, y0: row.y0 + 18, x1: xs[9] - 4, y1: row.y0 + 42, text: row.notifDate, conf: 0.9 },
    );
  }
  return { image, boxes, xs };
}

const ROWS: DrawnRow[] = [
  { y0: 220, y1: 300, owner: 'SP', asset: 'APPLE INC (AAPL)', txDate: '10/12/26', notifDate: '11/02/26', marks: [TYPE_COLUMN.p, 9] },
  { y0: 300, y1: 380, owner: 'JT', asset: 'GRAPHIC PACKAGING HLDG CO', txDate: '10/13/26', notifDate: '11/02/26', marks: [TYPE_COLUMN.s, TYPE_COLUMN.partial, 11] },
  { y0: 380, y1: 460, owner: 'DC', asset: 'PUT/XSP @ 715', txDate: '10/14/26', notifDate: '11/02/26', marks: [TYPE_COLUMN.e, TYPE_COLUMN.cg, 18] },
  { y0: 460, y1: 540, owner: 'SP', asset: 'WELLS FARGO FINANCE LLC', txDate: '10/15/26', notifDate: '11/02/26', marks: [10] },
  { y0: 540, y1: 620, owner: 'SP', asset: 'INTEL CORP', txDate: '10/16/26', notifDate: '11/02/26', marks: [TYPE_COLUMN.p, TYPE_COLUMN.s, 9] },
  { y0: 620, y1: 700, owner: 'SP', asset: 'EXXON MOBIL CORP', txDate: '10/17/26', notifDate: '11/02/26', marks: [] },
];

function filing(over: Partial<Filing> = {}): Filing {
  return {
    docId: 'H-2026-9116399',
    chamber: 'house',
    filerId: 'house-ca17-ro-khanna',
    filingType: 'P',
    filedDate: '2026-11-02',
    sourceUrl: 'https://example.test/khanna.pdf',
    rawObjectKey: 'raw/khanna.pdf',
    ingestStatus: 'classified',
    docKind: 'scanned_pdf',
    extractor: null,
    modelVersion: null,
    confidence: null,
    firstSeenAt: '2026-11-02T00:00:00.000Z',
    sourceUpdatedAt: null,
    error: null,
    ...over,
  };
}

function result(transactions: ParsedTx[], extractor = 'vision'): ExtractorResult {
  return { transactions, confidence: 0.5, raw: '', extractor };
}

describe('fitColumnLines', () => {
  it('recovers a shifted and scaled template', () => {
    const scale = 0.72;
    const offset = 40;
    const detected = COLUMN_TEMPLATES[0].map((value) => Math.round(offset + scale * value));
    const fit = fitColumnLines(detected);
    expect(fit).not.toBeNull();
    expect(fit!.inliers).toBe(detected.length);
    expect(fit!.scale).toBeGreaterThan(0.68);
    expect(fit!.scale).toBeLessThan(0.76);
    const maxDelta = Math.max(...fit!.xs.map((x, i) => Math.abs(x - detected[i])));
    expect(maxDelta).toBeLessThanOrEqual(2);
  });
});

describe('classifyMarkScores', () => {
  it('does not guess a type when no type column clears the mark threshold', () => {
    const scores = new Array(18).fill(0.05);
    scores[10 - 2] = 0.8;
    const marks = classifyMarkScores(scores);
    expect(marks.txType).toBeNull();
    expect(marks.typeReason).toBe('unmarked');
    expect(marks.amountLetter).toBe('B');
  });

  it('does not pick a winner when two type marks are tied', () => {
    const scores = new Array(18).fill(0.04);
    scores[TYPE_COLUMN.p - 2] = 0.8;
    scores[TYPE_COLUMN.s - 2] = 0.77;
    const marks = classifyMarkScores(scores);
    expect(marks.txType).toBeNull();
    expect(marks.typeReason).toBe('ambiguous');
  });

  it('reads a partial sale as S and keeps column K off the canonical brackets', () => {
    const scores = new Array(18).fill(0.02);
    scores[TYPE_COLUMN.partial - 2] = 0.9;
    scores[19 - 2] = 0.88;
    const marks = classifyMarkScores(scores);
    expect(marks.txType).toBe('S');
    expect(marks.partial).toBe(true);
    expect(marks.amountReason).toBe('column_k');
    expect(marks.amountMin).toBeNull();
  });
});

describe('unmarked grid rows in the normalizer', () => {
  it('flags the row and does not store a guessed buy', () => {
    const scored = scoreFields(
      0.8,
      {
        ticker: null,
        assetName: 'WELLS FARGO FINANCE LLC',
        amountMin: 15001,
        amountMax: 50000,
        txType: '',
        txDate: '2026-10-15',
        gridTypeUnmarked: true,
      },
      '2026-11-02',
      () => null,
    );
    expect(scored.flags).toContain('grid_type_unmarked');
    expect(scored.txType).toBe('');
    expect(scored.txType).not.toBe('B');
    expect(hasHardFailureFlags([{ flags: scored.flags }])).toBe(true);
  });

  it('does not enqueue OpenRouter agreement for the grid-form extractor', () => {
    expect(shouldEnqueueAgreement({
      filing: filing(),
      extractor: 'houseGridForm',
      quality: { ok: true },
    })).toBe(false);
    expect(shouldEnqueueAgreement({
      filing: filing(),
      extractor: 'server_cpu_gridform',
      quality: { ok: true },
    })).toBe(false);
  });
});

describe('synthetic hand-delivered grid page', () => {
  const drawn = drawGrid(0.72, 40, ROWS);
  const read = readHouseGridForm([{ image: drawn.image, boxes: drawn.boxes, page: 2 }]);

  it('detects the form and classifies every row without inventing a type', () => {
    expect(read.detected).toBe(true);
    expect(read.gridPages).toBe(1);
    expect(read.transactions).toHaveLength(ROWS.length);

    const [purchase, partialSale, exchange, unmarked, ambiguous, emptyBoxes] = read.transactions;
    expect(purchase).toMatchObject({
      assetName: 'APPLE INC (AAPL)',
      ticker: 'AAPL',
      owner: 'spouse',
      txType: 'B',
      txDate: '2026-10-12',
      amountMin: 1001,
      amountMax: 15000,
    });
    expect(purchase.confidence).toBeGreaterThanOrEqual(0.95);
    expect(purchase.extractionWarnings ?? []).not.toContain('grid_type_unmarked');

    expect(partialSale).toMatchObject({
      owner: 'joint',
      txType: 'S',
      txDate: '2026-10-13',
      amountMin: 50001,
      amountMax: 100000,
    });
    expect(partialSale.supplementalText).toContain('partial transaction box marked');

    expect(exchange).toMatchObject({
      owner: 'dependent',
      txType: 'E',
      isOption: true,
      capGainsOver200: true,
      amountMin: 50000001,
      amountMax: null,
    });

    for (const row of [unmarked, ambiguous, emptyBoxes]) {
      expect(row.txType).toBe('');
      expect(row.txType).not.toBe('B');
      expect(row.extractionWarnings).toContain('grid_type_unmarked');
      expect(row.confidence).toBeLessThan(0.5);
    }
    expect(unmarked.assetName).toBe('WELLS FARGO FINANCE LLC');
    expect(ambiguous.supplementalText).toContain('ambiguous');
    expect(emptyBoxes.assetName).toBe('EXXON MOBIL CORP');
  });

  it('measures mark accuracy on the fixture', () => {
    const typed = read.transactions.slice(0, 3);
    const held = read.transactions.slice(3);
    const typeHits = typed.filter((row, index) => {
      const expected = index === 0 ? 'B' : index === 1 ? 'S' : 'E';
      return row.txType === expected;
    }).length;
    const holdHits = held.filter((row) => row.extractionWarnings?.includes('grid_type_unmarked') && row.txType === '').length;
    const amountHits = [0, 1, 2].filter((index) => {
      const row = read.transactions[index];
      const letterIndex = ROWS[index].marks.find((column) => column >= 9);
      const expected = AMOUNT_COLUMNS.find((column) => column.index === letterIndex);
      return row.amountMin === (expected?.min ?? null) && row.amountMax === (expected?.max ?? null);
    }).length;
    // 3 typed rows + 3 correctly refused rows, and the 3 amount buckets on the typed rows.
    expect(typeHits).toBe(3);
    expect(holdHits).toBe(3);
    expect(amountHits).toBe(3);
    const classified = typeHits + holdHits;
    expect(classified / read.transactions.length).toBe(1);
    expect(MARK_SCORE_MIN).toBeGreaterThan(0);
  });
});

describe('HousePdfExtractor grid stage', () => {
  it('uses the local grid read and does not call paid vision when the form is detected', async () => {
    let visionCalls = 0;
    const vision: Extractor = {
      name: 'vision',
      canHandle: () => true,
      extract: async () => {
        visionCalls += 1;
        return result([tx({ ticker: 'MSFT' })]);
      },
    };
    const text: Extractor = {
      name: 'textPdf',
      canHandle: () => true,
      extract: async () => result([], 'textPdf'),
    };
    const gridTx = tx({
      assetName: 'APPLE INC (AAPL)',
      ticker: 'AAPL',
      txType: 'B',
      confidence: 0.97,
    });
    const house = new HousePdfExtractor(text, vision, undefined, {
      read: async () => ({
        detected: true,
        transactions: [gridTx],
        gridPages: 1,
        markedCells: 2,
        markCells: 16,
      }),
    });
    const out = await house.extract({
      filing: filing(),
      bytes: new Uint8Array([1, 2, 3]).buffer,
    });
    expect(visionCalls).toBe(0);
    expect(out.extractor).toBe('houseGridForm');
    expect(out.transactions[0]?.ticker).toBe('AAPL');
  });

  it('falls through to vision when the page is not a grid form', async () => {
    let visionCalls = 0;
    const vision: Extractor = {
      name: 'vision',
      canHandle: () => true,
      extract: async () => {
        visionCalls += 1;
        return result([tx({ ticker: 'INTC' })]);
      },
    };
    const house = new HousePdfExtractor(
      { name: 'textPdf', canHandle: () => true, extract: async () => result([], 'textPdf') },
      vision,
      undefined,
      { read: async () => ({ detected: false, transactions: [], gridPages: 0, markedCells: 0, markCells: 0 }) },
    );
    const out = await house.extract({
      filing: filing(),
      bytes: new Uint8Array([1]).buffer,
    });
    expect(visionCalls).toBe(1);
    expect(out.transactions[0]?.ticker).toBe('INTC');
  });
});

describe('grid row, owner, and date corrections', () => {
  it('leaves the trade date empty when only the notification column has a date', () => {
    const rows: DrawnRow[] = [
      { y0: 220, y1: 300, owner: 'SP', asset: 'APPLE INC (AAPL)', txDate: '', notifDate: '11/02/26', marks: [TYPE_COLUMN.p, 9] },
    ];
    const drawn = drawGrid(0.72, 40, rows);
    const read = readHouseGridForm([{ image: drawn.image, boxes: drawn.boxes, page: 4 }]);
    expect(read.transactions).toHaveLength(1);
    expect(read.transactions[0]?.txDate).toBeNull();
    expect(read.transactions[0]?.description).toContain('2026-11-02');
    expect(read.transactions[0]?.confidence).toBeLessThan(0.95);
  });

  it('does not read the cover sample grid as trades', () => {
    const drawn = drawGrid(0.72, 40, ROWS.slice(0, 1));
    hline(drawn.image, 40, drawn.xs[7], drawn.xs[drawn.xs.length - 1]);
    const covered = readHouseGridForm([{ image: drawn.image, boxes: drawn.boxes, page: 1 }]);
    expect(covered.transactions).toHaveLength(0);
    const plain = drawGrid(0.72, 40, ROWS.slice(0, 1));
    const open = readHouseGridForm([{ image: plain.image, boxes: plain.boxes, page: 2 }]);
    expect(open.transactions).toHaveLength(1);
  });

  it('reads an impossible OCR month 20 as October', () => {
    const rows: DrawnRow[] = [
      { y0: 220, y1: 300, owner: 'DC', asset: 'INTEL CORP', txDate: '20/13/26', notifDate: '11/02/26', marks: [TYPE_COLUMN.s, 10] },
    ];
    const drawn = drawGrid(0.72, 40, rows);
    const read = readHouseGridForm([{ image: drawn.image, boxes: drawn.boxes, page: 6 }]);
    expect(read.transactions[0]?.txDate).toBe('2026-10-13');
  });

  it('splits glued form words without rewriting a clean name', () => {
    expect(cleanGridAssetName('APPLE INC (AAPL)')).toBe('APPLE INC (AAPL)');
    expect(cleanGridAssetName('COSTCO WHOLESALE CORPORATION CMN')).toBe('COSTCO WHOLESALE CORPORATION CMN');
    expect(cleanGridAssetName('WALMARTINC CMN')).toBe('WALMART INC CMN');
    expect(cleanGridAssetName('EATONCORPPLCCMN')).toBe('EATON CORP PLC CMN');
    expect(cleanGridAssetName('WELLS FARGO FINANCE LLCLINKED TO SQPSODINDEX')).toBe('WELLS FARGO FINANCE LLC LINKED TO S&P 500 INDEX');
    expect(cleanGridAssetName('ACCENTURE PLECMN CLASSA')).toBe('ACCENTURE PLC CMN CLASS A');
    expect(cleanGridAssetName('CARVANACO CMN CLASS A')).toBe('CARVANA CO CMN CLASS A');
    expect(cleanGridAssetName('PEPSICO INC CMN')).toBe('PEPSICO INC CMN');
    expect(cleanGridAssetName('ON SEMICONOUCTOR CORPORATION CMN')).toBe('ON SEMICONDUCTOR CORPORATION CMN');
    expect(cleanGridAssetName('NETFLIX INC CAN')).toBe('NETFLIX INC CMN');
    expect(cleanGridAssetName('AGILENT TECHNOLOGIES NC CMN')).toBe('AGILENT TECHNOLOGIES INC CMN');
    expect(cleanGridAssetName('INTEL CORP COM USDO 001')).toBe('INTEL CORP COM USD0 001');
    expect(cleanGridAssetName('UNSPONSORED AOR')).toBe('UNSPONSORED ADR');
    expect(cleanGridAssetName('CARVANA CO CMNCLASSA')).toBe('CARVANA CO CMN CLASS A');
    expect(cleanGridAssetName('AGILENT TECHNOLOGIES [NC CMN')).toBe('AGILENT TECHNOLOGIES INC CMN');
    expect(cleanGridAssetName('CARRIER GLOBAL CORPORATION C©MIN')).toBe('CARRIER GLOBAL CORPORATION CMN');
    expect(cleanGridAssetName('COOPER COSINC/THECMN')).toBe('COOPER COS INC THE CMN');
    expect(cleanGridAssetName('GRAPHIC PACKAGING KLDG CO CMN')).toBe('GRAPHIC PACKAGING HLDG CO CMN');
    expect(cleanGridAssetName('ROYAL CARIBBEAN GROUP ISIN LROOO8862868')).toBe('ROYAL CARIBBEAN GROUP ISIN LR0008862868');
    expect(cleanGridAssetName('SP 500 SP FUND')).toBe('S&P 500 SP FUND');
    expect(cleanGridAssetName('SP FUND SP 500')).toBe('SP FUND S&P 500');
  });

  it('keeps a parenthetical ticker and a bare ticker written after two spaces', () => {
    expect(splitBareTicker('APPLE INC (AAPL)')).toEqual({ name: 'APPLE INC (AAPL)', ticker: 'AAPL' });
    expect(splitBareTicker('SPDR SER TR S&P 400 MID CAP ETF  SPMD')).toEqual({
      name: 'SPDR SER TR S&P 400 MID CAP ETF',
      ticker: 'SPMD',
    });
    expect(splitBareTicker('SELECT SECTOR SPDR ENERGY SEL SEC ETF XLE').ticker).toBeNull();
    const rows: DrawnRow[] = [
      { y0: 220, y1: 300, owner: 'JT', asset: 'ISHARES TR 10 20 YR TREAS BD ETF  TLH', txDate: '10/22/26', notifDate: '11/01/26', marks: [TYPE_COLUMN.p, 9] },
      { y0: 300, y1: 380, owner: 'JT', asset: '', txDate: '', notifDate: '', marks: [] },
      { y0: 380, y1: 460, owner: 'JT', asset: '', txDate: '', notifDate: '', marks: [] },
      { y0: 460, y1: 540, owner: 'JT', asset: '', txDate: '', notifDate: '', marks: [] },
    ];
    const drawn = drawGrid(0.72, 40, rows);
    const read = readHouseGridForm([{ image: drawn.image, boxes: drawn.boxes, page: 2 }]);
    expect(read.transactions).toHaveLength(1);
    expect(read.transactions[0]).toMatchObject({
      owner: 'joint',
      ticker: 'TLH',
      txType: 'B',
      txDate: '2026-10-22',
      amountMin: 1001,
      amountMax: 15000,
    });
    expect(read.transactions[0]?.assetName).not.toMatch(/TLH/);
  });

  it('reads an impossible OCR month 40 as October', () => {
    const rows: DrawnRow[] = [
      { y0: 220, y1: 300, owner: 'JT', asset: 'SELECT SECTOR SPDR ENERGY  XLE', txDate: '40/22/26', notifDate: '11/01/26', marks: [TYPE_COLUMN.s, 9] },
    ];
    const drawn = drawGrid(0.72, 40, rows);
    const read = readHouseGridForm([{ image: drawn.image, boxes: drawn.boxes, page: 2 }]);
    expect(read.transactions[0]?.txDate).toBe('2026-10-22');
    expect(read.transactions[0]?.ticker).toBe('XLE');
    expect(read.transactions[0]?.owner).toBe('joint');
  });

  it('maps a blank owner cell to self (Khanna-style empty SP/DC/JT)', () => {
    const rows: DrawnRow[] = [
      { y0: 220, y1: 300, owner: '', asset: 'ISHARES TR RUS 1000 ETF IWB', txDate: '10/22/26', notifDate: '11/01/26', marks: [TYPE_COLUMN.p, 9] },
    ];
    const drawn = drawGrid(0.72, 40, rows);
    const read = readHouseGridForm([{ image: drawn.image, boxes: drawn.boxes, page: 2 }]);
    expect(read.transactions).toHaveLength(1);
    expect(read.transactions[0]?.owner).toBe('self');
    expect(read.transactions[0]?.extractionWarnings ?? []).not.toContain('owner_unread');
  });

  it('flags owner_unread when the cell has ink but no confident code', () => {
    const rows: DrawnRow[] = [
      { y0: 220, y1: 300, owner: '', asset: 'VANGUARD TOTAL STOCK MKT ETF VTI', txDate: '10/22/26', notifDate: '11/01/26', marks: [TYPE_COLUMN.p, 9] },
    ];
    const drawn = drawGrid(0.72, 40, rows);
  const xs = drawn.xs;
    const ownerLeft = (xs[0] ?? 0) + 8;
    const ownerRight = (xs[1] ?? 0) - 8;
    for (let y = rows[0].y0 + 12; y < rows[0].y1 - 8; y += 3) {
      for (let x = ownerLeft; x < ownerRight; x += 5) {
        drawn.image.pixels[y * drawn.image.width + x] = 0;
        drawn.image.pixels[y * drawn.image.width + x + 1] = 0;
      }
    }
    expect(readOwnerCell(drawn.image, xs[0] ?? 0, rows[0].y0, xs[1] ?? 0, rows[0].y1)).toEqual({ kind: 'unread' });
    const read = readHouseGridForm([{ image: drawn.image, boxes: drawn.boxes, page: 2 }]);
    expect(read.transactions[0]?.owner).toBeNull();
    expect(read.transactions[0]?.extractionWarnings).toContain('owner_unread');
    expect(read.transactions[0]?.confidence ?? 1).toBeLessThan(0.95);
  });

  it('reads a stamped DC owner cell when the text box is missing', () => {
    const image = blank(80, 40);
    const glyphs = [
      { x: 16, rows: [' ######.', '#######.', '###..###', '###...##', '###...##', '###...##', '###...##', '###...##', '####.##.', '#######.'] },
      { x: 26, rows: ['.######', '.######', '###....', '##.....', '##.....', '##.....', '##.....', '##.....', '###...#', '.######'] },
    ];
    for (const glyph of glyphs) {
      for (let y = 0; y < glyph.rows.length; y += 1) {
        for (let x = 0; x < glyph.rows[y].length; x += 1) {
          if (glyph.rows[y][x] === '#') image.pixels[(10 + y) * image.width + glyph.x + x] = 0;
        }
      }
    }
    expect(ownerCodeFromCell(image, 0, 0, 80, 40)).toBe('dependent');
  });
});

describe('Fleischmann H-2026-9116403 hand rows', () => {
  const rows = JSON.parse(readFileSync(new URL('../__fixtures__/H-2026-9116403-hand-rows.json', import.meta.url), 'utf8')) as Array<{
    page: number;
    assetName: string;
    ticker: string;
    txType: string;
    owner: string;
    txDate: string;
    notificationDate: string;
    amountMin: number;
    amountMax: number;
  }>;

  it('locks the seven hand-checked rows and leaves page 2 blanks out', () => {
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((row) => row.owner))).toEqual(new Set(['joint']));
    expect(new Set(rows.map((row) => row.txDate))).toEqual(new Set(['2026-10-22']));
    expect(new Set(rows.map((row) => row.notificationDate))).toEqual(new Set(['2026-11-01']));
    expect(rows.every((row) => row.amountMin === 1001 && row.amountMax === 15000)).toBe(true);
    expect(rows.filter((row) => row.page === 1).map((row) => row.ticker)).toEqual(['TLH', 'IEUR', 'SPYG', 'XAR', 'SPTI']);
    expect(rows.filter((row) => row.page === 2).map((row) => `${row.txType}:${row.ticker}`)).toEqual(['B:SPMD', 'S:XLE']);
    expect(rows.map((row) => row.txType).join('')).toBe('BSSBSBS');
  });
});

describe('grid OCR parsers', () => {
  it('parses a PGM and a tesseract TSV line', () => {
    const header = new TextEncoder().encode('P5\n2 2\n255\n');
    const pixels = Uint8Array.from([0, 255, 255, 0]);
    const bytes = new Uint8Array(header.length + pixels.length);
    bytes.set(header, 0);
    bytes.set(pixels, header.length);
    const image = parsePgm(bytes);
    expect(image).toMatchObject({ width: 2, height: 2 });
    expect(Array.from(image!.pixels)).toEqual([0, 255, 255, 0]);

    const boxes = parseTesseractTsv(
      [
        'level\tpage\tblock\tpar\tline\tword\tleft\ttop\twidth\theight\tconf\ttext',
        '5\t1\t1\t1\t1\t1\t10\t20\t30\t12\t90\t10/12/26',
      ].join('\n'),
      100,
      100,
    );
    expect(boxes).toEqual([{ x0: 10, y0: 20, x1: 40, y1: 32, text: '10/12/26', conf: 0.9 }]);
  });
});

function tx(over: Partial<ParsedTx> = {}): ParsedTx {
  return {
    txDate: '2026-10-12',
    owner: 'spouse',
    assetName: 'Apple Inc',
    ticker: 'AAPL',
    assetType: 'ST',
    txType: 'B',
    amountMin: 1001,
    amountMax: 15000,
    isOption: false,
    capGainsOver200: false,
    rawText: 'APPLE INC',
    confidence: 0.9,
    ...over,
  };
}
