/**
 * Local grid-form reader for hand-delivered scanned House PTRs.
 *
 * Those filings print transaction type and amount as columns of boxes.
 * The mark is an x, not text, so a text OCR pass invents rows and then
 * guesses a purchase when no type box is filled. This stage fits the
 * printed column lines, template-matches the x, and OCRs only the asset,
 * owner, and date text. An unmarked or ambiguous type is flagged. It is
 * not stored as a guessed buy, sale, or exchange.
 *
 * CPU only. No vision model and no OpenRouter call.
 */

import type { Owner, ParsedTx, TxType } from '../shared/types.ts';
import { looksLikeColumnHeaderAsset, looksLikeHeaderContaminatedAsset } from './extractRouting.ts';

/** Recorded on filings.extractor when the in-app stage handles the PDF. */
export const HOUSE_GRID_FORM_EXTRACTOR = 'houseGridForm';
/** Recorded when the server_cpu worker handled the PDF with this stage. */
export const SERVER_CPU_GRID_FORM_EXTRACTOR = 'server_cpu_gridform';

/**
 * Column-line templates measured on hand-delivered House PTR scans
 * (prototype fit.py, pages 2, 8, 13, and 22). Twenty-one vertical rules.
 */
export const COLUMN_TEMPLATES: readonly (readonly number[])[] = [
  [217, 328, 865, 959, 1016, 1113, 1212, 1336, 1503, 1677, 1788, 1898, 1992, 2083, 2175, 2285, 2391, 2509, 2739, 2854, 3122],
  [216, 327, 834, 930, 984, 1079, 1171, 1290, 1469, 1655, 1757, 1862, 1956, 2045, 2137, 2245, 2344, 2458, 2679, 2797, 3046],
  [219, 331, 861, 955, 1010, 1105, 1202, 1321, 1481, 1648, 1758, 1859, 1948, 2036, 2125, 2233, 2336, 2453, 2668, 2783, 3033],
  [278, 395, 939, 1037, 1093, 1195, 1300, 1426, 1604, 1777, 1892, 2009, 2104, 2200, 2296, 2405, 2517, 2645, 2771, 2893, 3023],
];

/** Intervals between the 21 rules. Dates sit in 7 and 8 and are not marks. */
export const TYPE_COLUMN = { p: 2, s: 3, partial: 4, e: 5, cg: 6 } as const;
export const DATE_COLUMNS = [7, 8] as const;
export const AMOUNT_COLUMNS: readonly {
  index: number;
  letter: string;
  min: number | null;
  max: number | null;
}[] = [
  { index: 9, letter: 'A', min: 1001, max: 15000 },
  { index: 10, letter: 'B', min: 15001, max: 50000 },
  { index: 11, letter: 'C', min: 50001, max: 100000 },
  { index: 12, letter: 'D', min: 100001, max: 250000 },
  { index: 13, letter: 'E', min: 250001, max: 500000 },
  { index: 14, letter: 'F', min: 500001, max: 1000000 },
  { index: 15, letter: 'G', min: 1000001, max: 5000000 },
  { index: 16, letter: 'H', min: 5000001, max: 25000000 },
  { index: 17, letter: 'I', min: 25000001, max: 50000000 },
  { index: 18, letter: 'J', min: 50000001, max: null },
  // K is printed on these grids and is not a canonical STOCK Act bracket.
  { index: 19, letter: 'K', min: null, max: null },
];

/** NCC at or above this is a mark. Empty checkbox borders stay under it. */
export const MARK_SCORE_MIN = 0.45;
/** Two marks this close are ambiguous. The row is not given the higher one. */
export const MARK_AMBIGUITY_GAP = 0.08;
/** Inliers required before a page is treated as this grid. */
export const GRID_MIN_INLIERS = 14;
/** A clear reading. Below this the row stays for review. */
export const GRID_STRONG_MARK = 0.55;

export interface GrayImage {
  width: number;
  height: number;
  /** Row-major luminance. 0 is black, 255 is white. */
  pixels: Uint8Array;
}

export interface HouseGridOcrBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  text: string;
  /** 0..1 */
  conf: number;
}

export interface HouseGridPageInput {
  image: GrayImage;
  boxes: HouseGridOcrBox[];
  page?: number;
}

export interface ColumnFit {
  templateIndex: number;
  scale: number;
  offset: number;
  /** Predicted rule x positions, length 21. */
  xs: number[];
  inliers: number;
}

export type GridTypeReason = 'ok' | 'unmarked' | 'ambiguous';
export type GridAmountReason = 'ok' | 'unmarked' | 'ambiguous' | 'column_k';

export interface ClassifiedMarks {
  txType: TxType | null;
  partial: boolean;
  capGainsOver200: boolean;
  amountMin: number | null;
  amountMax: number | null;
  amountLetter: string | null;
  typeReason: GridTypeReason;
  amountReason: GridAmountReason;
  typeScore: number;
  amountScore: number;
}

export interface HouseGridRead {
  detected: boolean;
  transactions: ParsedTx[];
  gridPages: number;
  /** Mark cells whose score cleared MARK_SCORE_MIN. */
  markedCells: number;
  /** Mark cells that were scored. */
  markCells: number;
}

/** Injected by the Deno app. Tests pass a fake. Null means the binaries are missing. */
export interface HouseGridFormReader {
  read(bytes: ArrayBuffer): Promise<HouseGridRead | null>;
}

const DATE_RE = /^\D{0,2}(\d{1,2})\s*[/l1I|]\s*(\d{1,2})\s*[/l1I|]\s*(\d{2,4})\D{0,3}$/;
const DARK = 150;

export function canonicalXTemplate(): GrayImage {
  const width = 19;
  const height = 21;
  const pixels = new Uint8Array(width * height);
  pixels.fill(255);
  for (let y = 0; y < height; y += 1) {
    const x1 = Math.round((y / (height - 1)) * (width - 1));
    const x2 = (width - 1) - x1;
    for (const x of [x1, x1 - 1, x2, x2 - 1]) {
      if (x >= 0 && x < width) pixels[y * width + x] = 0;
    }
  }
  return { width, height, pixels };
}

export function scaleGray(src: GrayImage, scale: number): GrayImage {
  const factor = scale > 0 ? scale : 1;
  const width = Math.max(3, Math.round(src.width * factor));
  const height = Math.max(3, Math.round(src.height * factor));
  if (width === src.width && height === src.height) return src;
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / width));
      pixels[y * width + x] = src.pixels[sy * src.width + sx];
    }
  }
  return { width, height, pixels };
}

function clusterPositions(xs: number[], gap: number): number[] {
  const groups: number[][] = [];
  for (const x of xs) {
    const last = groups[groups.length - 1];
    if (last && x - last[last.length - 1] <= gap) last.push(x);
    else groups.push([x]);
  }
  return groups.map((group) => Math.round(group.reduce((sum, v) => sum + v, 0) / group.length));
}

/** Vertical rules in [y0, y1). A column counts when a long dark run covers it. */
export function detectVerticalLines(image: GrayImage, y0: number, y1: number): number[] {
  const top = Math.max(0, Math.min(image.height, y0));
  const bot = Math.max(top, Math.min(image.height, y1));
  const band = Math.max(1, bot - top);
  const minRun = 40;
  const hits: number[] = [];
  for (let x = 0; x < image.width; x += 1) {
    let covered = 0;
    let run = 0;
    for (let y = top; y < bot; y += 1) {
      if (image.pixels[y * image.width + x] < DARK) {
        run += 1;
      } else {
        if (run >= minRun) covered += run;
        run = 0;
      }
    }
    if (run >= minRun) covered += run;
    if (covered > band * 0.35) hits.push(x);
  }
  return clusterPositions(hits, 8);
}

function detectHorizontalLines(image: GrayImage, x0: number, x1: number, y0: number, y1: number): number[] {
  const left = Math.max(0, Math.min(image.width, x0));
  const right = Math.max(left, Math.min(image.width, x1));
  const top = Math.max(0, Math.min(image.height, y0));
  const bot = Math.max(top, Math.min(image.height, y1));
  const span = Math.max(1, right - left);
  const minRun = Math.max(30, Math.floor(span * 0.25));
  const hits: number[] = [];
  for (let y = top; y < bot; y += 1) {
    let covered = 0;
    let run = 0;
    const row = y * image.width;
    for (let x = left; x < right; x += 1) {
      if (image.pixels[row + x] < DARK) {
        run += 1;
      } else {
        if (run >= minRun) covered += run;
        run = 0;
      }
    }
    if (run >= minRun) covered += run;
    if (covered > span * 0.35) hits.push(y);
  }
  return clusterPositions(hits, 3);
}

/**
 * Scale and shift one printed template onto the detected rules.
 * Same search as the prototype: two detected lines, two template lines,
 * keep the scale in (0.5, 1.4) with the most inliers.
 */
export function fitColumnLines(detected: readonly number[]): ColumnFit | null {
  if (detected.length < 4) return null;
  let best: ColumnFit | null = null;
  let bestErr = Number.POSITIVE_INFINITY;
  for (let templateIndex = 0; templateIndex < COLUMN_TEMPLATES.length; templateIndex += 1) {
    const template = COLUMN_TEMPLATES[templateIndex];
    for (let i = 0; i < detected.length; i += 1) {
      for (let j = i + 1; j < detected.length; j += 1) {
        for (let a = 0; a < template.length; a += 1) {
          for (let b = a + 1; b < template.length; b += 1) {
            const denom = template[b] - template[a];
            if (denom === 0) continue;
            const scale = (detected[j] - detected[i]) / denom;
            if (scale < 0.5 || scale > 1.4) continue;
            const offset = detected[i] - scale * template[a];
            let inliers = 0;
            let err = 0;
            for (const x of detected) {
              let nearest = Number.POSITIVE_INFINITY;
              for (const t of template) {
                const distance = Math.abs(x - (offset + scale * t));
                if (distance < nearest) nearest = distance;
              }
              if (nearest < 12) {
                inliers += 1;
                err += nearest;
              }
            }
            const xs = template.map((t) => Math.round(offset + scale * t));
            if (!best || inliers > best.inliers || (inliers === best.inliers && err < bestErr)) {
              best = { templateIndex, scale, offset, xs, inliers };
              bestErr = err;
            }
          }
        }
      }
    }
  }
  if (!best || best.inliers < 8) return null;
  return best;
}

function crop(image: GrayImage, x0: number, y0: number, x1: number, y1: number): GrayImage {
  const left = Math.max(0, Math.min(image.width, Math.floor(x0)));
  const right = Math.max(left, Math.min(image.width, Math.ceil(x1)));
  const top = Math.max(0, Math.min(image.height, Math.floor(y0)));
  const bot = Math.max(top, Math.min(image.height, Math.ceil(y1)));
  const width = Math.max(1, right - left);
  const height = Math.max(1, bot - top);
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const src = (top + y) * image.width + left;
    pixels.set(image.pixels.subarray(src, src + width), y * width);
  }
  return { width, height, pixels };
}

function nccAt(
  cell: GrayImage,
  tmpl: GrayImage,
  originX: number,
  originY: number,
  tMean: number,
  tEnergy: number,
): number {
  let sum = 0;
  const n = tmpl.width * tmpl.height;
  for (let y = 0; y < tmpl.height; y += 1) {
    const row = (originY + y) * cell.width + originX;
    for (let x = 0; x < tmpl.width; x += 1) sum += cell.pixels[row + x];
  }
  const mean = sum / n;
  let num = 0;
  let energy = 0;
  for (let y = 0; y < tmpl.height; y += 1) {
    const row = (originY + y) * cell.width + originX;
    const tRow = y * tmpl.width;
    for (let x = 0; x < tmpl.width; x += 1) {
      const iv = cell.pixels[row + x] - mean;
      const tv = tmpl.pixels[tRow + x] - tMean;
      num += iv * tv;
      energy += iv * iv;
    }
  }
  const den = Math.sqrt(energy * tEnergy);
  if (den < 1e-6) return 0;
  return num / den;
}

/** Peak normalized correlation of tmpl inside cell. 0 when the cell is flat. */
export function matchTemplateMax(cell: GrayImage, tmpl: GrayImage): number {
  if (cell.width < 3 || cell.height < 3) return 0;
  let template = tmpl;
  if (cell.width < tmpl.width || cell.height < tmpl.height) {
    const factor = Math.min(cell.width / tmpl.width, cell.height / tmpl.height) * 0.9;
    if (factor < 0.3) return 0;
    template = scaleGray(tmpl, factor);
  }
  let tSum = 0;
  for (const value of template.pixels) tSum += value;
  const tMean = tSum / template.pixels.length;
  let tEnergy = 0;
  for (const value of template.pixels) {
    const d = value - tMean;
    tEnergy += d * d;
  }
  if (tEnergy < 1e-6) return 0;
  const step = cell.width * cell.height > 8000 ? 2 : 1;
  let best = 0;
  let bestX = 0;
  let bestY = 0;
  for (let y = 0; y <= cell.height - template.height; y += step) {
    for (let x = 0; x <= cell.width - template.width; x += step) {
      const score = nccAt(cell, template, x, y, tMean, tEnergy);
      if (score > best) {
        best = score;
        bestX = x;
        bestY = y;
      }
    }
  }
  if (step === 1) return best;
  const x1 = Math.max(0, bestX - 1);
  const y1 = Math.max(0, bestY - 1);
  const x2 = Math.min(cell.width - template.width, bestX + 1);
  const y2 = Math.min(cell.height - template.height, bestY + 1);
  for (let y = y1; y <= y2; y += 1) {
    for (let x = x1; x <= x2; x += 1) {
      const score = nccAt(cell, template, x, y, tMean, tEnergy);
      if (score > best) best = score;
    }
  }
  return best;
}

function txTypeForColumn(column: number): TxType {
  const kind = column === TYPE_COLUMN.p ? 'P' : column === TYPE_COLUMN.s ? 'S' : column === TYPE_COLUMN.e ? 'E' : null;
  if (kind === null) throw new Error(`unexpected type column ${column}`);
  switch (kind) {
    case 'P':
      return 'B';
    case 'S':
      return 'S';
    case 'E':
      return 'E';
    default: {
      const unexpected: never = kind;
      throw new Error(`unexpected type column ${String(unexpected)}`);
    }
  }
}

function bestMark(
  scores: readonly number[],
  indexes: readonly number[],
): { index: number; score: number; second: number } | null {
  let index = -1;
  let score = 0;
  let second = 0;
  for (const i of indexes) {
    const value = scores[i] ?? 0;
    if (value > score) {
      second = score;
      score = value;
      index = i;
    } else if (value > second) {
      second = value;
    }
  }
  if (index < 0 || score < MARK_SCORE_MIN) return null;
  return { index, score, second };
}

/**
 * Map one row of mark scores (columns 2..19, date slots included) to a type
 * and an amount. A missing or tied type stays null.
 */
export function classifyMarkScores(scores: readonly number[]): ClassifiedMarks {
  const typeIndexes = [0, 1, 3];
  const typeHit = bestMark(scores, typeIndexes);
  const partialScore = scores[TYPE_COLUMN.partial - 2] ?? 0;
  const cgScore = scores[TYPE_COLUMN.cg - 2] ?? 0;
  let txType: TxType | null = null;
  let typeReason: GridTypeReason = 'unmarked';
  let typeScore = 0;
  if (typeHit && typeHit.score - typeHit.second >= MARK_AMBIGUITY_GAP) {
    txType = txTypeForColumn(typeHit.index + 2);
    typeReason = 'ok';
    typeScore = typeHit.score;
  } else if (typeHit) {
    typeReason = 'ambiguous';
    typeScore = typeHit.score;
  }

  const partial = partialScore >= MARK_SCORE_MIN;
  if (partial && txType === 'B') {
    typeReason = 'ambiguous';
    txType = null;
  } else if (partial && txType === 'E') {
    typeReason = 'ambiguous';
    txType = null;
  } else if (partial && txType === null && typeReason === 'unmarked') {
    txType = 'S';
    typeReason = 'ok';
    typeScore = partialScore;
  } else if (partial && txType === 'S') {
    typeScore = Math.max(typeScore, partialScore);
  }

  const amountIndexes = AMOUNT_COLUMNS.map((column) => column.index - 2);
  const amountHit = bestMark(scores, amountIndexes);
  let amountMin: number | null = null;
  let amountMax: number | null = null;
  let amountLetter: string | null = null;
  let amountReason: GridAmountReason = 'unmarked';
  let amountScore = 0;
  if (amountHit && amountHit.score - amountHit.second >= MARK_AMBIGUITY_GAP) {
    const column = AMOUNT_COLUMNS.find((entry) => entry.index - 2 === amountHit.index);
    amountScore = amountHit.score;
    amountLetter = column?.letter ?? null;
    if (column?.letter === 'K') {
      amountReason = 'column_k';
    } else if (column) {
      amountMin = column.min;
      amountMax = column.max;
      amountReason = 'ok';
    }
  } else if (amountHit) {
    amountReason = 'ambiguous';
    amountScore = amountHit.score;
  }

  return {
    txType,
    partial: partial && txType === 'S',
    capGainsOver200: cgScore >= MARK_SCORE_MIN,
    amountMin,
    amountMax,
    amountLetter,
    typeReason,
    amountReason,
    typeScore,
    amountScore,
  };
}

function parseLooseDate(text: string): string | null {
  const match = DATE_RE.exec(text.replace(/\s+/g, ''));
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1990 || year > 2100) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

function ownerFromText(text: string): Owner | null {
  const token = text.toUpperCase().replace(/[^A-Z]/g, ' ');
  if (/\bJT\b/.test(token) || /\bJOINT\b/.test(token)) return 'joint';
  if (/\bSP\b/.test(token) || /\bSPOUSE\b/.test(token)) return 'spouse';
  if (/\bDC\b/.test(token) || /\bDEPENDENT\b/.test(token)) return 'dependent';
  if (/\bSELF\b/.test(token)) return 'self';
  return null;
}

function boxesInRow(
  boxes: readonly HouseGridOcrBox[],
  y0: number,
  y1: number,
): HouseGridOcrBox[] {
  return boxes.filter((box) => {
    const cy = (box.y0 + box.y1) / 2;
    return cy >= y0 && cy <= y1;
  });
}

function rowBands(image: GrayImage, xs: readonly number[]): Array<{ y0: number; y1: number }> {
  const tableLeft = xs[1] ?? 0;
  const tableRight = xs[xs.length - 1] ?? image.width;
  const lines = detectHorizontalLines(image, tableLeft, tableRight, 0, image.height);
  const bands: Array<{ y0: number; y1: number }> = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    const y0 = lines[i];
    const y1 = lines[i + 1];
    if (y1 - y0 < 28) continue;
    if (y1 - y0 > 180) continue;
    bands.push({ y0, y1 });
  }
  return bands;
}

function scoreRowCells(
  image: GrayImage,
  xs: readonly number[],
  y0: number,
  y1: number,
  template: GrayImage,
): { scores: number[]; marked: number } {
  const scores: number[] = [];
  let marked = 0;
  for (let column = 2; column <= 19; column += 1) {
    if (column === 7 || column === 8) {
      scores.push(0);
      continue;
    }
    const inset = 4;
    const cell = crop(image, xs[column] + inset, y0 + 2, xs[column + 1] - inset, y1 - 2);
    const score = matchTemplateMax(cell, template);
    scores.push(score);
    if (score >= MARK_SCORE_MIN) marked += 1;
  }
  return { scores, marked };
}

function assetText(boxes: readonly HouseGridOcrBox[], xs: readonly number[]): { text: string; conf: number } {
  const left = (xs[1] ?? 0) - 8;
  const right = (xs[2] ?? 0) - 4;
  const hits = boxes
    .filter((box) => box.x0 >= left && box.x0 < right && box.text.trim())
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  if (hits.length === 0) return { text: '', conf: 0 };
  const conf = hits.reduce((sum, box) => sum + box.conf, 0) / hits.length;
  return { text: hits.map((box) => box.text.trim()).join(' ').replace(/\s+/g, ' '), conf };
}

function confidenceFor(marks: ClassifiedMarks, assetConf: number, hasDate: boolean, asset: string): number {
  if (marks.typeReason !== 'ok') return 0.35;
  const strong = marks.typeScore >= GRID_STRONG_MARK
    && marks.amountReason === 'ok'
    && marks.amountScore >= GRID_STRONG_MARK
    && hasDate
    && asset.trim().length >= 4
    && assetConf >= 0.45;
  if (strong) return 0.97;
  let score = 0.42;
  score += Math.min(0.2, marks.typeScore * 0.2);
  if (marks.amountReason === 'ok') score += 0.12;
  if (hasDate) score += 0.08;
  if (asset.trim().length >= 4) score += 0.08 * Math.min(1, assetConf);
  return Math.min(0.9, score);
}

function pageRows(page: HouseGridPageInput, template: GrayImage): {
  detected: boolean;
  transactions: ParsedTx[];
  markedCells: number;
  markCells: number;
} {
  const empty = { detected: false, transactions: [], markedCells: 0, markCells: 0 };
  const y0 = Math.floor(page.image.height * 0.12);
  const y1 = Math.floor(page.image.height * 0.96);
  const detectedLines = detectVerticalLines(page.image, y0, y1);
  const fit = fitColumnLines(detectedLines);
  if (!fit || fit.inliers < GRID_MIN_INLIERS || fit.xs.length < 21) return empty;
  const sized = scaleGray(template, Math.min(1.4, Math.max(0.45, fit.scale)));
  const bands = rowBands(page.image, fit.xs);
  const transactions: ParsedTx[] = [];
  let markedCells = 0;
  let markCells = 0;
  const pageNum = page.page ?? 1;
  for (const band of bands) {
    const { scores, marked } = scoreRowCells(page.image, fit.xs, band.y0, band.y1, sized);
    markCells += scores.length;
    markedCells += marked;
    const marks = classifyMarkScores(scores);
    const inBand = boxesInRow(page.boxes, band.y0, band.y1);
    const asset = assetText(inBand, fit.xs);
    const owners = inBand
      .filter((box) => box.x1 <= (fit.xs[1] ?? 0) + 12)
      .map((box) => ownerFromText(box.text))
      .filter((owner): owner is Owner => owner !== null);
    const dates = inBand
      .map((box) => ({ box, iso: parseLooseDate(box.text) }))
      .filter((entry): entry is { box: HouseGridOcrBox; iso: string } => entry.iso !== null)
      .sort((a, b) => a.box.x0 - b.box.x0);
    const chrome = looksLikeHeaderContaminatedAsset(asset.text) || looksLikeColumnHeaderAsset(asset.text);
    const hasMark = marks.typeReason !== 'unmarked' || marks.amountReason !== 'unmarked' || marks.capGainsOver200;
    if (!asset.text && !hasMark) continue;
    if (chrome && !hasMark) continue;
    const tickerMatch = asset.text.match(/\(([A-Z]{1,5})\)/);
    const notes: string[] = [`grid page ${pageNum}`];
    if (marks.partial) notes.push('partial transaction box marked');
    if (marks.typeReason === 'unmarked') notes.push('transaction type was not marked');
    if (marks.typeReason === 'ambiguous') notes.push('transaction type marks were ambiguous');
    if (marks.amountReason === 'unmarked') notes.push('no amount box marked');
    if (marks.amountReason === 'ambiguous') notes.push('amount marks were ambiguous');
    if (marks.amountReason === 'column_k') notes.push('amount column K marked');
    const warnings: NonNullable<ParsedTx['extractionWarnings']> = [];
    if (marks.typeReason !== 'ok' || marks.txType === null) warnings.push('grid_type_unmarked');
    const txType = marks.txType ?? ('' as TxType);
    transactions.push({
      txDate: dates[0]?.iso ?? null,
      owner: owners[0] ?? null,
      assetName: asset.text || `(unreadable asset p${pageNum})`,
      ticker: tickerMatch?.[1] ?? null,
      assetType: null,
      txType,
      amountMin: marks.amountMin,
      amountMax: marks.amountMax,
      isOption: /^(?:PUT|CALL)\//i.test(asset.text),
      capGainsOver200: marks.capGainsOver200,
      rawText: `${asset.text || '(unreadable)'} | type ${marks.txType ?? 'unmarked'} | amt ${marks.amountLetter ?? 'blank'}`,
      supplementalText: notes.join('; '),
      description: dates[1] ? `date notified ${dates[1].iso}` : null,
      confidence: confidenceFor(marks, asset.conf, Boolean(dates[0]), asset.text),
      ...(warnings.length ? { extractionWarnings: warnings } : {}),
    });
  }
  return { detected: true, transactions, markedCells, markCells };
}

/** Read every supplied page. A filing is a grid form when any page fits. */
export function readHouseGridForm(pages: readonly HouseGridPageInput[]): HouseGridRead {
  const template = canonicalXTemplate();
  const transactions: ParsedTx[] = [];
  let gridPages = 0;
  let markedCells = 0;
  let markCells = 0;
  for (const page of pages) {
    const read = pageRows(page, template);
    if (!read.detected) continue;
    gridPages += 1;
    markedCells += read.markedCells;
    markCells += read.markCells;
    transactions.push(...read.transactions);
  }
  return {
    detected: gridPages > 0,
    transactions,
    gridPages,
    markedCells,
    markCells,
  };
}
