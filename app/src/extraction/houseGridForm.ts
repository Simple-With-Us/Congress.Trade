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
import {
  looksLikeColumnHeaderAsset,
  looksLikeHeaderContaminatedAsset,
  looksLikePtrFormSampleAsset,
  looksLikePtrFormSampleDate,
  looksLikePtrFormSampleRow,
  looksLikeSeeAttachmentPointer,
} from './extractRouting.ts';

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

/**
 * Printed House PTR (filer block on the same page as the grid).
 * Eighteen rules at 150 DPI: owner, asset, purchase, sale, exchange,
 * trade date, notification date, amount brackets A–J. No partial column,
 * no capital-gains column, and no bracket K.
 * Measured on H-2026-9116403 page 1.
 */
export const OFFICIAL_PTR_TEMPLATE: readonly number[] = [
  164, 242, 675, 716, 756, 795, 900, 1005, 1061, 1117, 1172, 1228, 1284, 1340, 1396, 1452, 1508, 1564,
];
/** Template rules that must land on a detected line before this form wins. */
export const OFFICIAL_PTR_MIN_HITS = 16;
/** The printed form is scanned at its own size. A schedule page can line up 16 of these rules near scale 0.92. */
export const OFFICIAL_PTR_MIN_SCALE = 0.96;
export const OFFICIAL_PTR_MAX_SCALE = 1.05;
/**
 * The printed PTR checkbox is a little larger than the schedule glyph at
 * the same column-fit scale. Scoring at the raw fit scale leaves a real
 * sale mark under MARK_SCORE_MIN while the header words stay well below it.
 */
export const OFFICIAL_MARK_SCALE = 1.1;

/** Intervals between the 21 rules. Dates sit in 7 and 8 and are not marks. */
/** Purchase, sale, exchange, capital-gains, partial. Header order on the printed grid. */
export const TYPE_COLUMN = { p: 2, s: 3, e: 4, cg: 5, partial: 6 } as const;
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

export type GridFormKind = 'schedule' | 'official';

export interface ColumnFit {
  templateIndex: number;
  scale: number;
  offset: number;
  /** Predicted rule x positions, length 21. */
  xs: number[];
  inliers: number;
  /**
   * `schedule` is the attached-page grid (partial, capital gains, bracket K).
   * `official` is the printed PTR on the filer page (brackets A–J only).
   */
  kind: GridFormKind;
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

/**
 * Printed checkbox x at {@link X_GLYPH_REFERENCE_SCALE} of the column templates.
 * The mark is a small blocky x, not a pair of corner-to-corner diagonals.
 */
const X_GLYPH = [
  '#....#.',
  '##..##.',
  '######.',
  '.####..',
  '.####..',
  '.####..',
  '.#####.',
  '##..###',
  '#...###',
  '.....#.',
];

/** Fit scale at which {@link X_GLYPH} is already the right pixel size. */
export const X_GLYPH_REFERENCE_SCALE = 0.667;

export function canonicalXTemplate(): GrayImage {
  const height = X_GLYPH.length;
  const width = X_GLYPH[0].length;
  const pixels = new Uint8Array(width * height);
  pixels.fill(255);
  for (let y = 0; y < height; y += 1) {
    const row = X_GLYPH[y];
    for (let x = 0; x < width; x += 1) {
      if (row[x] === '#') pixels[y * width + x] = 0;
    }
  }
  return { width, height, pixels };
}

/** Scale the checkbox x to a page whose column fit returned `fitScale`. */
export function xTemplateForFit(fitScale: number): GrayImage {
  const clamped = Math.min(1.4, Math.max(0.45, fitScale));
  return scaleGray(canonicalXTemplate(), clamped / X_GLYPH_REFERENCE_SCALE);
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

/**
 * Thin vertical rules in [y0, y1).
 * Coverage counts a broken rule. A wide text blob is not a rule.
 * At most 28 candidates go into the column fit, strongest first.
 */
export function detectVerticalLines(image: GrayImage, y0: number, y1: number, minFraction = 0.18): number[] {
  const top = Math.max(0, Math.min(image.height, y0));
  const bot = Math.max(top, Math.min(image.height, y1));
  const band = Math.max(1, bot - top);
  const hits: number[] = [];
  for (let x = 0; x < image.width; x += 1) {
    let dark = 0;
    for (let y = top; y < bot; y += 1) {
      if (image.pixels[y * image.width + x] < 180) dark += 1;
    }
    if (dark > band * minFraction) hits.push(x);
  }
  const groups: number[][] = [];
  for (const x of hits) {
    const last = groups[groups.length - 1];
    if (last && x - last[last.length - 1] <= 6) last.push(x);
    else groups.push([x]);
  }
  const scored: Array<{ coverage: number; center: number }> = [];
  for (const group of groups) {
    if (group.length > 12) continue;
    let dark = 0;
    for (const x of group) {
      for (let y = top; y < bot; y += 1) {
        if (image.pixels[y * image.width + x] < 180) dark += 1;
      }
    }
    const center = Math.round(group.reduce((sum, value) => sum + value, 0) / group.length);
    scored.push({ coverage: dark / (group.length * band), center });
  }
  scored.sort((a, b) => b.coverage - a.coverage);
  return scored.slice(0, 28).map((item) => item.center).sort((a, b) => a - b);
}

/**
 * Scale and shift one printed template onto the detected rules.
 * Same search as the prototype: two detected lines, two template lines,
 * keep the scale in (0.5, 1.4) with the most inliers.
 */
export function fitColumnLines(detected: readonly number[], minScale = 0.5): ColumnFit | null {
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
            if (scale < minScale || scale > 1.4) continue;
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
              best = { templateIndex, scale, offset, xs, inliers, kind: 'schedule' };
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

/**
 * Map the 18 printed-PTR rules onto the 21 schedule slots.
 * Capital gains, partial, and bracket K are not printed, so those slots
 * share a boundary and stay empty.
 */
export function expandOfficialPtrRules(rules: readonly number[]): number[] {
  const rule = (index: number): number => rules[index] ?? rules[rules.length - 1] ?? 0;
  return [
    rule(0), rule(1), rule(2), rule(3), rule(4),
    rule(5), rule(5), rule(5),
    rule(6),
    rule(7), rule(8), rule(9), rule(10), rule(11), rule(12), rule(13), rule(14), rule(15), rule(16),
    rule(17), rule(17),
  ];
}

/**
 * Fit the printed PTR column rules.
 * A hit is a template rule with a detected line within 12px, and both
 * outer rules have to hit. The attached schedule does not clear the hit
 * floor, so this fit does not steal those pages.
 */
export function fitOfficialPtrLines(detected: readonly number[]): ColumnFit | null {
  if (detected.length < 8) return null;
  const template = OFFICIAL_PTR_TEMPLATE;
  let best: { hits: number; err: number; scale: number; offset: number } | null = null;
  for (let i = 0; i < detected.length; i += 1) {
    for (let j = i + 1; j < detected.length; j += 1) {
      for (let a = 0; a < template.length; a += 1) {
        for (let b = a + 1; b < template.length; b += 1) {
          const denom = template[b] - template[a];
          if (denom === 0) continue;
          const scale = (detected[j] - detected[i]) / denom;
          if (scale < OFFICIAL_PTR_MIN_SCALE || scale > OFFICIAL_PTR_MAX_SCALE) continue;
          const offset = detected[i] - scale * template[a];
          let hits = 0;
          let err = 0;
          let first = false;
          let last = false;
          for (let t = 0; t < template.length; t += 1) {
            const predicted = offset + scale * template[t];
            let nearest = Number.POSITIVE_INFINITY;
            for (const x of detected) {
              const distance = Math.abs(x - predicted);
              if (distance < nearest) nearest = distance;
            }
            if (nearest < 12) {
              hits += 1;
              err += nearest;
              if (t === 0) first = true;
              if (t === template.length - 1) last = true;
            }
          }
          if (!first || !last) continue;
          if (!best || hits > best.hits || (hits === best.hits && err < best.err)) {
            best = { hits, err, scale, offset };
          }
        }
      }
    }
  }
  if (!best || best.hits < OFFICIAL_PTR_MIN_HITS) return null;
  const rules = template.map((value) => Math.round(best.offset + best.scale * value));
  return {
    templateIndex: -1,
    scale: best.scale,
    offset: best.offset,
    xs: expandOfficialPtrRules(rules),
    inliers: best.hits,
    kind: 'official',
  };
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
  const typeIndexes = [TYPE_COLUMN.p - 2, TYPE_COLUMN.s - 2, TYPE_COLUMN.e - 2];
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
  let month = Number(match[1]);
  const day = Number(match[2]);
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  // "10" is often read as 16, 20, 30, or 40. Those months cannot exist, so keep the day.
  if (month === 16 || month === 18 || month === 19 || month === 20 || month === 30 || month === 40) month = 10;
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
  // The owner cell is a two-letter code. Tesseract often reads DC as OC or PC.
  const letters = token.replace(/[^A-Z]/g, '');
  if (letters.length < 2 || letters.length > 3) return null;
  // B/C and C/C are the same DC ink when the D's left stroke is faint.
  if (['OC', 'PC', 'DO', 'OD', 'QC', 'CG', 'CD', 'BC', 'CC', 'HC'].includes(letters)) return 'dependent';
  if (['SD', 'SF', 'PS'].includes(letters)) return 'spouse';
  if (['JI', 'IT', 'JF', 'TJ'].includes(letters)) return 'joint';
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

/**
 * Printed owner codes on these grids. Measured from a 150 DPI scan.
 * D/C/S/P are the ink; T/J are the same stroke weight so a joint code
 * can match without a second OCR pass.
 */
const OWNER_GLYPHS: Record<string, readonly string[]> = {
  D: [' ######.', '#######.', '###..###', '###...##', '###...##', '###...##', '###...##', '###...##', '####.##.', '#######.'],
  C: ['.######', '.######', '###....', '##.....', '##.....', '##.....', '##.....', '##.....', '###...#', '.######'],
  S: ['.####.', '#####.', '###...', '##....', '####..', '.###..', '..####', '....##', '...###', '######', '####..'],
  P: ['.####...', '#######.', '###..##.', '###..###', '###..###', '#######.', '#######.', '###.....', '###.....', '###.....'],
  T: ['#######', '...#...', '...#...', '...#...', '...#...', '...#...', '...#...', '...#...', '...#...', '...#...'],
  J: ['..####.', '....##.', '....##.', '....##.', '....##.', '....##.', '....##.', '##..##.', '.#####.', '..###..'],
};

function glyphTemplate(rows: readonly string[]): { width: number; height: number; pixels: Float64Array } {
  const height = rows.length;
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const pixels = new Float64Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = rows[y] ?? '';
    for (let x = 0; x < width; x += 1) pixels[y * width + x] = row[x] === '#' ? 1 : 0;
  }
  return { width, height, pixels };
}

const OWNER_TEMPLATES = Object.fromEntries(
  Object.entries(OWNER_GLYPHS).map(([letter, rows]) => [letter, glyphTemplate(rows)]),
) as Record<string, { width: number; height: number; pixels: Float64Array }>;

function sampleIndex(index: number, outCount: number, inCount: number): number {
  if (outCount <= 1 || inCount <= 1) return 0;
  return Math.min(inCount - 1, Math.floor((index * (inCount - 1)) / (outCount - 1)));
}

function glyphNcc(
  glyph: Uint8Array,
  glyphWidth: number,
  glyphHeight: number,
  template: { width: number; height: number; pixels: Float64Array },
): number {
  if (glyphWidth < 2 || glyphHeight < 4) return -1;
  const { width, height, pixels } = template;
  let tMean = 0;
  for (const value of pixels) tMean += value;
  tMean /= pixels.length;
  let gMean = 0;
  const sampled = new Float64Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sy = sampleIndex(y, height, glyphHeight);
    for (let x = 0; x < width; x += 1) {
      const sx = sampleIndex(x, width, glyphWidth);
      const value = glyph[sy * glyphWidth + sx];
      sampled[y * width + x] = value;
      gMean += value;
    }
  }
  gMean /= sampled.length;
  let num = 0;
  let tEnergy = 0;
  let gEnergy = 0;
  for (let i = 0; i < sampled.length; i += 1) {
    const tv = pixels[i] - tMean;
    const gv = sampled[i] - gMean;
    num += tv * gv;
    tEnergy += tv * tv;
    gEnergy += gv * gv;
  }
  const den = Math.sqrt(tEnergy * gEnergy);
  return den < 1e-6 ? -1 : num / den;
}

function bestOwnerLetter(glyph: Uint8Array, width: number, height: number): { letter: string; score: number; margin: number; runnerUp: string } {
  let best = '';
  let runnerUp = '';
  let score = -2;
  let second = -2;
  for (const [letter, template] of Object.entries(OWNER_TEMPLATES)) {
    const value = glyphNcc(glyph, width, height, template);
    if (value > score) {
      second = score;
      runnerUp = best;
      score = value;
      best = letter;
    } else if (value > second) {
      second = value;
      runnerUp = letter;
    }
  }
  return { letter: best, score, margin: score - second, runnerUp };
}

function trimGlyph(mask: Uint8Array, width: number, height: number): { pixels: Uint8Array; width: number; height: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX) return null;
  const outWidth = maxX - minX + 1;
  const outHeight = maxY - minY + 1;
  const pixels = new Uint8Array(outWidth * outHeight);
  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) pixels[y * outWidth + x] = mask[(minY + y) * width + minX + x];
  }
  return { pixels, width: outWidth, height: outHeight };
}

export type OwnerMatchDetail = {
  pair: string;
  first: number;
  second: number;
  firstMargin: number;
  secondMargin: number;
  width: number;
  height: number;
};

/** DC, SP, or JT from the owner cell. Blank ink stays null. */
export function ownerCodeFromCell(
  image: GrayImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  detail?: OwnerMatchDetail,
): Owner | null {
  const left = Math.max(0, Math.floor(x0) + 4);
  const right = Math.min(image.width, Math.ceil(x1) - 4);
  const top = Math.max(0, Math.floor(y0) + 2);
  const bot = Math.min(image.height, Math.ceil(y1) - 2);
  const width = right - left;
  const height = bot - top;
  if (width < 8 || height < 8) return null;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const src = (top + y) * image.width + left;
    for (let x = 0; x < width; x += 1) mask[y * width + x] = image.pixels[src + x] < 155 ? 1 : 0;
  }
  const colMean = new Float64Array(width);
  const rowMean = new Float64Array(height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = mask[y * width + x];
      colMean[x] += value;
      rowMean[y] += value;
    }
  }
  for (let x = 0; x < width; x += 1) {
    if (colMean[x] / height > 0.55) {
      for (let y = 0; y < height; y += 1) mask[y * width + x] = 0;
    }
  }
  for (let y = 0; y < height; y += 1) {
    if (rowMean[y] / width > 0.7) {
      mask.fill(0, y * width, (y + 1) * width);
    }
  }
  let ink = 0;
  for (const value of mask) ink += value;
  if (ink < 10) return null;
  let glyph = trimGlyph(mask, width, height);
  if (!glyph) return null;
  if (glyph.height > 16) {
    const span = 13;
    let bestStart = 0;
    let bestInk = -1;
    for (let start = 0; start <= glyph.height - span; start += 1) {
      let sum = 0;
      for (let y = start; y < start + span; y += 1) {
        for (let x = 0; x < glyph.width; x += 1) sum += glyph.pixels[y * glyph.width + x];
      }
      if (sum > bestInk) {
        bestInk = sum;
        bestStart = start;
      }
    }
    const sliced = new Uint8Array(glyph.width * span);
    for (let y = 0; y < span; y += 1) {
      sliced.set(glyph.pixels.subarray((bestStart + y) * glyph.width, (bestStart + y + 1) * glyph.width), y * glyph.width);
    }
    glyph = trimGlyph(sliced, glyph.width, span);
    if (!glyph) return null;
  }
  if (glyph.width > 22) {
    const window = 18;
    let bestX = 0;
    let bestInk = -1;
    for (let x = 0; x <= glyph.width - window; x += 1) {
      let sum = 0;
      for (let y = 0; y < glyph.height; y += 1) {
        for (let dx = 0; dx < window; dx += 1) sum += glyph.pixels[y * glyph.width + x + dx];
      }
      if (sum > bestInk) {
        bestInk = sum;
        bestX = x;
      }
    }
    const sliced = new Uint8Array(window * glyph.height);
    for (let y = 0; y < glyph.height; y += 1) {
      sliced.set(glyph.pixels.subarray(y * glyph.width + bestX, y * glyph.width + bestX + window), y * window);
    }
    glyph = trimGlyph(sliced, window, glyph.height);
    if (!glyph) return null;
  }
  if (glyph.width < 8) return null;
  const col = new Uint32Array(glyph.width);
  for (let y = 0; y < glyph.height; y += 1) {
    for (let x = 0; x < glyph.width; x += 1) col[x] += glyph.pixels[y * glyph.width + x];
  }
  const mid0 = Math.floor(glyph.width * 0.25);
  const mid1 = Math.floor(glyph.width * 0.8);
  if (mid1 <= mid0) return null;
  let valley = mid0;
  for (let x = mid0 + 1; x <= mid1; x += 1) if (col[x] < col[valley]) valley = x;
  const leftWidth = Math.max(1, valley);
  const leftPixels = new Uint8Array(leftWidth * glyph.height);
  for (let y = 0; y < glyph.height; y += 1) {
    for (let x = 0; x < leftWidth; x += 1) leftPixels[y * leftWidth + x] = glyph.pixels[y * glyph.width + x];
  }
  const leftGlyph = trimGlyph(leftPixels, leftWidth, glyph.height);
  const rightOffset = valley + 1;
  const rightWidth = glyph.width - rightOffset;
  const rightPixels = new Uint8Array(Math.max(1, rightWidth) * glyph.height);
  if (rightWidth > 0) {
    for (let y = 0; y < glyph.height; y += 1) {
      for (let x = 0; x < rightWidth; x += 1) {
        rightPixels[y * rightWidth + x] = glyph.pixels[y * glyph.width + rightOffset + x];
      }
    }
  }
  const rightGlyph = rightWidth > 0 ? trimGlyph(rightPixels, rightWidth, glyph.height) : null;
  if (!leftGlyph || !rightGlyph) return null;
  if (leftGlyph.pixels.reduce((sum, value) => sum + value, 0) < 4) return null;
  if (rightGlyph.pixels.reduce((sum, value) => sum + value, 0) < 4) return null;
  const first = bestOwnerLetter(leftGlyph.pixels, leftGlyph.width, leftGlyph.height);
  const second = bestOwnerLetter(rightGlyph.pixels, rightGlyph.width, rightGlyph.height);
  const pair = `${first.letter}${second.letter}`;
  if (detail) {
    detail.pair = pair;
    detail.first = first.score;
    detail.second = second.score;
    detail.firstMargin = first.margin;
    detail.secondMargin = second.margin;
    detail.width = glyph.width;
    detail.height = glyph.height;
  }
  const joint = pair === 'JT';
  // DC/SP stay rejected unless both letters clear a modest score. Joint
  // stays strict: a weak JT is usually a broken DC or SP.
  const floor = joint ? 0.62 : 0.3;
  const margin = joint ? 0.12 : 0.02;
  if (first.score < floor || second.score < floor) return null;
  if (first.margin < margin || second.margin < margin) return null;
  if (pair === 'DC') return 'dependent';
  if (pair === 'SP') return 'spouse';
  if (pair === 'JT') return 'joint';
  // There is no DD or CC code. A strong D beside a C that lost to D or C is DC.
  if (pair === 'DD' && first.score >= 0.5 && second.runnerUp === 'C' && second.margin <= 0.2 && second.score >= 0.4) {
    return 'dependent';
  }
  if (pair === 'CC' && second.score >= 0.45 && first.runnerUp === 'D' && first.margin <= 0.2 && first.score >= 0.45) {
    return 'dependent';
  }
  return null;
}

function medianNumber(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 64;
}

/**
 * Column fit for one page.
 * The printed PTR (owner, three type columns, brackets A–J) is tried
 * before the attached-schedule templates. A short table that sits above
 * the usual window is fit again from the top of the page.
 */
export function planHouseGridColumns(image: GrayImage): ColumnFit | null {
  const primaryLines = detectVerticalLines(
    image,
    Math.floor(image.height * 0.28),
    Math.floor(image.height * 0.92),
  );
  const official = fitOfficialPtrLines(primaryLines);
  if (official) return official;
  const primary = fitColumnLines(primaryLines);
  if (primary && primary.inliers >= GRID_MIN_INLIERS) return primary;
  const fallbackLines = detectVerticalLines(
    image,
    Math.floor(image.height * 0.05),
    Math.floor(image.height * 0.72),
    0.15,
  );
  const officialFallback = fitOfficialPtrLines(fallbackLines);
  if (officialFallback) return officialFallback;
  const fallback = fitColumnLines(fallbackLines, 0.42);
  if (fallback && fallback.inliers >= GRID_MIN_INLIERS) return fallback;
  return null;
}

/**
 * Data-row bands from the amount-column rules.
 * A section title is a thick black bar. Thin rules are the row separators.
 * When the single-row pitch is visible, a gap of several pitches is filled
 * back in. Pages with no section bar keep the original one-gap fill so a
 * synthetic grid is unchanged.
 */
export function rowBands(image: GrayImage, xs: readonly number[]): { bands: Array<{ y0: number; y1: number }>; sectionBars: number } {
  const none = { bands: [] as Array<{ y0: number; y1: number }>, sectionBars: 0 };
  if (xs.length < 12) return none;
  const x0 = xs[7];
  const x1 = xs[xs.length - 1];
  const groups: number[][] = [];
  for (let y = 0; y < image.height; y += 1) {
    let dark = 0;
    const row = y * image.width;
    for (let x = x0; x < x1; x += 1) {
      if (image.pixels[row + x] < 200) dark += 1;
    }
    if (dark <= (x1 - x0) * 0.22) continue;
    const last = groups[groups.length - 1];
    if (last && y - last[last.length - 1] <= 3) last.push(y);
    else groups.push([y]);
  }
  const rules: number[] = [];
  const bars: Array<{ top: number; bottom: number }> = [];
  for (const group of groups) {
    if (group.length <= 5) rules.push(Math.round(group.reduce((sum, v) => sum + v, 0) / group.length));
    else if (group.length >= 12) bars.push({ top: group[0], bottom: group[group.length - 1] });
  }
  const barBottoms = bars.map((bar) => bar.bottom);
  if (rules.length < 3 && barBottoms.length === 0) return none;
  const firstBar = barBottoms.length ? Math.min(...barBottoms) : null;
  const dataRules = (firstBar === null ? rules : rules.filter((rule) => rule > firstBar + 4)).sort((a, b) => a - b);
  const rawGaps = dataRules.slice(1).map((rule, index) => rule - dataRules[index]);
  const smallGaps = rawGaps.filter((gap) => gap >= 32 && gap <= 70);
  const canSubdivide = smallGaps.length >= 2 && firstBar !== null;
  const pitch = canSubdivide
    ? medianNumber(smallGaps)
    : medianNumber(rawGaps.filter((gap) => gap >= 24 && gap <= 140));
  const edges = [...dataRules];
  if (canSubdivide && firstBar !== null && dataRules.length > 0) {
    for (let i = 0; i < dataRules.length - 1; i += 1) {
      const gap = dataRules[i + 1] - dataRules[i];
      const slots = pitch > 0 ? Math.round(gap / pitch) : 1;
      if (slots >= 2 && slots <= 8 && Math.abs(gap - slots * pitch) <= pitch * 0.42) {
        for (let k = 1; k < slots; k += 1) edges.push(Math.round(dataRules[i] + (k * gap) / slots));
      }
    }
    const span = dataRules[0] - firstBar;
    const slots = pitch > 0 ? Math.round(span / pitch) : 1;
    if (slots >= 1 && slots <= 6 && Math.abs(span - slots * pitch) <= pitch * 0.45) {
      edges.push(firstBar + 4);
      for (let k = 1; k < slots; k += 1) edges.push(Math.round(firstBar + (k * span) / slots));
    }
  } else {
    if (dataRules.length < 2 && firstBar === null) return none;
    for (let i = 0; i < dataRules.length - 1; i += 1) {
      const gap = dataRules[i + 1] - dataRules[i];
      if (gap > pitch * 1.6 && gap < pitch * 2.5) edges.push(Math.round(dataRules[i] + gap / 2));
    }
    if (firstBar !== null) {
      for (const bottom of barBottoms) {
        const next = edges.filter((edge) => edge > bottom + 8).sort((a, b) => a - b)[0];
        if (next !== undefined && Math.abs(next - bottom - pitch) <= pitch * 0.45) edges.push(bottom + 1);
      }
    }
  }
  // A row rule that touches a trust bar is absorbed into the bar. The row
  // above the bar and the row under it are each one pitch and still have
  // asset ink. Filling only that pitch keeps the bar itself out of the table.
  if (pitch > 0 && bars.length > 0) {
    const assetLeft = (xs[1] ?? 0) + 6;
    const assetRight = (xs[2] ?? assetLeft) - 6;
    const inkedRow = (y0: number, y1: number): boolean => {
      if (assetRight - assetLeft < 8 || y1 - y0 < 8) return false;
      let ink = 0;
      let inkSamples = 0;
      let block = 0;
      let blockSamples = 0;
      for (let y = y0 + 4; y < y1 - 2; y += 1) {
        const row = y * image.width;
        for (let x = assetLeft; x < assetRight; x += 2) {
          inkSamples += 1;
          if (image.pixels[row + x] < 160) ink += 1;
        }
      }
      for (let y = y0; y < y1; y += 2) {
        const row = y * image.width;
        for (let x = x0; x < x1; x += 4) {
          blockSamples += 1;
          if (image.pixels[row + x] < DARK) block += 1;
        }
      }
      if (inkSamples === 0 || ink / inkSamples < 0.035) return false;
      if (blockSamples > 0 && block / blockSamples > 0.45) return false;
      return true;
    };
    for (const bar of bars) {
      const earlier = dataRules.filter((rule) => rule < bar.top);
      const prev = earlier.length > 0 ? earlier[earlier.length - 1] : undefined;
      const next = dataRules.find((rule) => rule > bar.bottom);
      if (prev !== undefined) {
        const gap = bar.top - prev;
        if (gap >= pitch * 0.75 && gap <= pitch * 1.35 && inkedRow(prev, bar.top)) edges.push(bar.top);
      }
      if (next !== undefined) {
        const gap = next - bar.bottom;
        if (gap >= pitch * 0.75 && gap <= pitch * 1.35 && inkedRow(bar.bottom, next)) edges.push(bar.bottom + 1);
      }
    }
  }
  const sorted = [...new Set(edges.filter((edge) => firstBar === null || edge >= firstBar))].sort((a, b) => a - b);
  const bands: Array<{ y0: number; y1: number }> = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const y0 = sorted[i];
    const y1 = sorted[i + 1];
    const height = y1 - y0;
    if (height < pitch * 0.55 || height > pitch * 1.8) continue;
    let dark = 0;
    const sample = Math.max(1, x1 - x0);
    for (let y = y0 + 2; y < y1 - 2; y += 2) {
      const row = y * image.width;
      for (let x = x0; x < x1; x += 4) {
        if (image.pixels[row + x] < DARK) dark += 1;
      }
    }
    const samples = Math.max(1, Math.ceil((y1 - y0) / 2) * Math.ceil(sample / 4));
    if (dark / samples > 0.45) continue;
    bands.push({ y0, y1 });
  }
  if (canSubdivide && bands.length > 0) {
    const assetLeft = (xs[1] ?? 0) + 6;
    const assetRight = (xs[2] ?? assetLeft) - 6;
    let cursor = bands[bands.length - 1].y1;
    for (let extra = 0; extra < 4; extra += 1) {
      const next = Math.round(cursor + pitch);
      if (next > image.height * 0.92 || assetRight - assetLeft < 8) break;
      let ink = 0;
      let inkSamples = 0;
      let block = 0;
      let blockSamples = 0;
      for (let y = cursor + 4; y < next - 2; y += 1) {
        const row = y * image.width;
        for (let x = assetLeft; x < assetRight; x += 2) {
          inkSamples += 1;
          if (image.pixels[row + x] < 160) ink += 1;
        }
      }
      for (let y = cursor; y < next; y += 2) {
        const row = y * image.width;
        for (let x = x0; x < x1; x += 4) {
          blockSamples += 1;
          if (image.pixels[row + x] < DARK) block += 1;
        }
      }
      if (inkSamples === 0 || ink / inkSamples < 0.035) break;
      if (blockSamples > 0 && block / blockSamples > 0.45) break;
      bands.push({ y0: cursor, y1: next });
      cursor = next;
    }
  }
  return { bands, sectionBars: barBottoms.length };
}

/**
 * Row bands for the printed PTR.
 * Amount-column rules at the data pitch are kept. The sample row is shorter
 * than that pitch, and the filer block above the table is a separate run.
 * The longest run is the transaction table. Dollar-range ink in the header
 * is thicker than a rule and is not a trust bar.
 */
export function officialPtrRowBands(
  image: GrayImage,
  xs: readonly number[],
): { bands: Array<{ y0: number; y1: number }>; sectionBars: number } {
  const none = { bands: [] as Array<{ y0: number; y1: number }>, sectionBars: 0 };
  const x0 = Math.max(0, Math.floor(xs[9] ?? 0));
  const x1 = Math.min(image.width, Math.floor(xs[xs.length - 1] ?? 0));
  if (x1 - x0 < 40) return none;
  const groups: number[][] = [];
  for (let y = 0; y < image.height; y += 1) {
    let dark = 0;
    const row = y * image.width;
    for (let x = x0; x < x1; x += 1) {
      if (image.pixels[row + x] < 200) dark += 1;
    }
    if (dark <= (x1 - x0) * 0.22) continue;
    const last = groups[groups.length - 1];
    if (last && y - last[last.length - 1] <= 3) last.push(y);
    else groups.push([y]);
  }
  const rules: number[] = [];
  for (const group of groups) {
    if (group.length <= 8) rules.push(Math.round(group.reduce((sum, value) => sum + value, 0) / group.length));
  }
  if (rules.length < 3) return none;
  const gaps = rules.slice(1).map((rule, index) => rule - rules[index]);
  const pitchGaps = gaps.filter((gap) => gap >= 45 && gap <= 90);
  const pitch = medianNumber(pitchGaps.length >= 3 ? pitchGaps : gaps.filter((gap) => gap >= 24 && gap <= 140));
  if (!(pitch > 0)) return none;
  const candidates: Array<{ y0: number; y1: number }> = [];
  for (let i = 0; i < rules.length - 1; i += 1) {
    const y0 = rules[i];
    const y1 = rules[i + 1];
    const height = y1 - y0;
    if (height < pitch * 0.8 || height > pitch * 1.35) continue;
    let dark = 0;
    const sample = Math.max(1, x1 - x0);
    for (let y = y0 + 2; y < y1 - 2; y += 2) {
      const row = y * image.width;
      for (let x = x0; x < x1; x += 4) {
        if (image.pixels[row + x] < DARK) dark += 1;
      }
    }
    const samples = Math.max(1, Math.ceil((y1 - y0) / 2) * Math.ceil(sample / 4));
    if (dark / samples > 0.45) continue;
    candidates.push({ y0, y1 });
  }
  const runs: Array<Array<{ y0: number; y1: number }>> = [];
  let run: Array<{ y0: number; y1: number }> = [];
  for (const band of candidates) {
    const previous = run[run.length - 1];
    if (previous && band.y0 !== previous.y1) {
      runs.push(run);
      run = [];
    }
    run.push(band);
  }
  if (run.length > 0) runs.push(run);
  runs.sort((left, right) => right.length - left.length || right[0].y0 - left[0].y0);
  return { bands: runs[0] ?? [], sectionBars: 0 };
}

export function layoutHouseGridRows(
  image: GrayImage,
  fit: ColumnFit,
): { bands: Array<{ y0: number; y1: number }>; sectionBars: number } {
  if (fit.kind === 'official') return officialPtrRowBands(image, fit.xs);
  return rowBands(image, fit.xs);
}

/**
 * Schedule cover: no trust bar, and a rule in the top of the page.
 * The printed PTR has that same header rule and is not a cover.
 */
export function shouldSkipHouseGridCover(
  image: GrayImage,
  xs: readonly number[],
  sectionBars: number,
  kind: GridFormKind = 'schedule',
): boolean {
  if (kind === 'official') return false;
  return sectionBars === 0 && hasEarlyHorizontalRule(image, xs);
}

function hasEarlyHorizontalRule(image: GrayImage, xs: readonly number[]): boolean {
  const x0 = Math.max(0, Math.floor(xs[7] ?? 0));
  const x1 = Math.min(image.width, Math.floor(xs[xs.length - 1] ?? 0));
  if (x1 - x0 < 20) return false;
  const limit = Math.floor(image.height * 0.15);
  const span = x1 - x0;
  for (let y = 0; y < limit; y += 1) {
    let dark = 0;
    const row = y * image.width;
    for (let x = x0; x < x1; x += 1) if (image.pixels[row + x] < 200) dark += 1;
    if (dark > span * 0.22) return true;
  }
  return false;
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
    const left = xs[column] + inset;
    const right = xs[column + 1] - inset;
    // Capital gains, partial, and bracket K are not printed on the PTR grid.
    if (right - left < 8) {
      scores.push(0);
      continue;
    }
    const cell = crop(image, left, y0 + 2, right, y1 - 2);
    const score = matchTemplateMax(cell, template);
    scores.push(score);
    if (score >= MARK_SCORE_MIN) marked += 1;
  }
  return { scores, marked };
}

const FORM_WORDS = [
  'CORPORATION', 'INCORPORATED', 'INTERNATIONAL', 'HOLDINGS', 'COMPANIES',
  'PERPETUAL', 'WHOLESALE', 'COMMON', 'COMPANY', 'LIMITED', 'SYSTEMS',
  'INDEX', 'LINKED', 'CLASS', 'STOCK', 'TRUST', 'SHARE',
  'CORP', 'INC', 'LLC', 'PLC', 'CMN', 'LTD', 'FUND', 'LINE', 'HLDG',
  'USD', 'US', 'CO',
].sort((left, right) => right.length - left.length);

// Prefix splits only where a form word is glued onto the next word.
// INC/COM as prefixes cut real names (INCYTE, COMCAST).
const FORM_PREFIXES = new Set(['LLC', 'PLC', 'LINKED']);

const FORM_LEXICON = [
  'SEMICONDUCTOR', 'HOLDINGS', 'INCORPORATED', 'TECHNOLOGY', 'PHARMACEUTICALS',
  'COMMUNICATIONS', 'UNSPONSORED', 'CORPORATION', 'INTERNATIONAL', 'DIAGNOSTICS',
  'WHOLESALE', 'MATERIALS', 'ENTERPRISES', 'INSTRUMENTS', 'LABORATORIES',
];

const FORM_TOKEN_MAP: Record<string, string> = {
  CMIN: 'CMN',
  CIMIN: 'CMN',
  CMMN: 'CMN',
  ICMN: 'CMN',
  CMI: 'CMN',
  CMM: 'CMN',
  CMNN: 'CMN',
  CMA: 'CMN',
  CRN: 'CMN',
  CHN: 'CMN',
  CIN: 'CMN',
  CNN: 'CMN',
  MIN: 'CMN',
  CIMN: 'CMN',
  CHIN: 'CMN',
  CHAN: 'CMN',
  HLDGCO: 'HLDG CO',
  HLOGCO: 'HLDG CO',
  HUDGCO: 'HLDG CO',
  KLDG: 'HLDG',
  USDO: 'USD0',
  AOR: 'ADR',
  PLE: 'PLC',
  PLO: 'PLC',
  HOLOINGS: 'HOLDINGS',
  HOLDNGS: 'HOLDINGS',
  CLASSA: 'CLASS A',
  CLASSB: 'CLASS B',
};

const CO_REMAINDER_DENY = new Set(['COST', 'COCA', 'TACO', 'LOCO', 'ARCO', 'PEPSI', 'DISCO', 'GEICO']);

function editDistanceAtMost1(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length === right.length) {
      i += 1;
      j += 1;
    } else if (left.length > right.length) i += 1;
    else j += 1;
  }
  if (i < left.length || j < right.length) edits += 1;
  return edits <= 1;
}

function correctFormWord(token: string): string {
  if (token.length < 8 || FORM_LEXICON.includes(token)) return token;
  const hits = FORM_LEXICON.filter((word) => editDistanceAtMost1(token, word));
  return hits.length === 1 ? hits[0] : token;
}

function repairIndexToken(token: string): string[] | null {
  if (/^S[QR8]?PS?[O0]{1,3}D?INDEX$/.test(token)) return ['S&P', '500', 'INDEX'];
  if (/^(?:SOO|SOD|S00|5OO)INDE[XK]$/.test(token)) return ['500', 'INDEX'];
  if (/^(?:SOO|S00|5OO)$/.test(token)) return ['500'];
  if (/^(?:SRP|SQP|S8P)$/.test(token)) return ['S&P'];
  return null;
}

/** A long id mixes letters and digits. O in that mix is a zero. */
function repairDigitToken(token: string): string | null {
  const digits = token.replace(/\D/g, '').length;
  const letters = token.replace(/[^A-Z]/g, '').length;
  if (token.length < 8 || digits < 4 || digits <= letters) return null;
  const repaired = token.replace(/O/g, '0');
  return repaired === token ? null : repaired;
}

/** Split a glued form word. Already-spaced tokens stay as written. */
function splitFormToken(token: string): string[] {
  if (/[()]/.test(token)) return [token];
  if (token.includes('/')) {
    return token.split('/').filter(Boolean).flatMap((part) => splitFormToken(part));
  }
  const trimmed = token.replace(/[^A-Za-z0-9&]+/g, '');
  if (!trimmed) return [token];
  const upper = trimmed.toUpperCase();
  const mapped = FORM_TOKEN_MAP[upper];
  if (mapped) return mapped.split(' ');
  const index = repairIndexToken(upper);
  if (index) return index;
  const digitId = repairDigitToken(upper);
  if (digitId) return [digitId];
  if (/^CLASS[ABC]$/.test(upper)) return ['CLASS', upper.slice(5)];
  // CMNCLASSA is the class letter glued on, not a new word.
  for (const key of ['CLASSA', 'CLASSB']) {
    if (!upper.endsWith(key) || upper.length < key.length + 3) continue;
    const head = splitFormToken(upper.slice(0, -key.length));
    return [...head, ...(FORM_TOKEN_MAP[key] ?? key).split(' ')];
  }
  const prefixes: string[] = [];
  const suffixes: string[] = [];
  let rest = upper;
  for (let guard = 0; rest.length >= 3 && guard < 8; guard += 1) {
    let peeled = false;
    for (const word of FORM_WORDS) {
      if (rest === word) {
        prefixes.push(FORM_TOKEN_MAP[word] ?? word);
        rest = '';
        peeled = true;
        break;
      }
      const minRemainder = word === 'LINE' || word === 'FUND' || word === 'US' || word === 'CO' ? 4 : 3;
      const prefixOk = FORM_PREFIXES.has(word) && rest.startsWith(word) && rest.length >= word.length + minRemainder;
      const suffixOk = rest.endsWith(word) && rest.length >= word.length + minRemainder;
      if (!prefixOk && !suffixOk) continue;
      if (suffixOk && CO_REMAINDER_DENY.has(rest.slice(0, -word.length))) continue;
      const piece = FORM_TOKEN_MAP[word] ?? word;
      if (prefixOk) {
        prefixes.push(piece);
        rest = rest.slice(word.length);
      } else {
        suffixes.unshift(piece);
        rest = rest.slice(0, -word.length);
      }
      peeled = true;
      break;
    }
    if (!peeled) break;
  }
  if (rest) prefixes.push(FORM_TOKEN_MAP[rest] ?? correctFormWord(rest));
  const pieces = [...prefixes, ...suffixes];
  if (pieces.length === 1 && pieces[0] === upper) {
    return trimmed === token ? [token] : [upper];
  }
  return pieces;
}

const TICKER_DENY = new Set([
  'INC', 'CMN', 'LLC', 'PLC', 'CORP', 'CO', 'ETF', 'LTD', 'USD', 'USD0', 'ADR',
  'COM', 'FUND', 'CLASS', 'HLDG', 'STOCK', 'TRUST', 'THE', 'AND', 'NEW', 'CL',
  'COMMON', 'SHARES', 'INDEX', 'LINKED', 'COMPANY',
]);

/**
 * A parenthetical ticker stays. A bare ticker is the last token only when
 * two spaces separate it from the asset name, which is how the attached
 * schedule prints the symbol.
 *
 * The printed PTR uses one space. That split still requires the previous
 * word to be a form word (ETF, INC) or to contain a lowercase letter, so an
 * all-caps name such as "US TREASURY NOTE" keeps NOTE.
 */
export function splitBareTicker(text: string, spaces: 1 | 2 = 2): { name: string; ticker: string | null } {
  const paren = text.match(/\(([A-Z]{1,5})\)/);
  if (paren) return { name: text, ticker: paren[1] };
  const wide = text.match(/^(.*\S)[ \t]{2,}([A-Z]{2,5})[ \t]*$/);
  if (wide && !TICKER_DENY.has(wide[2])) return { name: wide[1], ticker: wide[2] };
  if (spaces !== 1) return { name: text, ticker: null };
  const narrow = text.match(/^(.*\S)[ \t]+([A-Z]{2,5})[ \t]*$/);
  if (!narrow || TICKER_DENY.has(narrow[2]) || !officialOneSpaceTicker(narrow[1])) {
    return { name: text, ticker: null };
  }
  return { name: narrow[1], ticker: narrow[2] };
}

function officialOneSpaceTicker(name: string): boolean {
  const previous = name.trim().split(/\s+/).pop() ?? '';
  const letters = previous.replace(/[^A-Za-z]/g, '');
  if (TICKER_DENY.has(letters.toUpperCase())) return true;
  return /[a-z]/.test(previous);
}

export function cleanGridAssetName(text: string): string {
  const tokens = text.replace(/[|`´‘’_]+/g, ' ').split(/\s+/).filter(Boolean);
  const words: string[] = [];
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    for (const piece of splitFormToken(token)) {
      if (piece === 'SA' && words[words.length - 1] === 'CLASS') {
        words.push('A');
        continue;
      }
      if (piece === 'SB' && words[words.length - 1] === 'CLASS') {
        words.push('B');
        continue;
      }
      const previous = words[words.length - 1] ?? '';
      if (piece === 'NC' && /^[A-Z]{4,}$/.test(previous)) {
        words.push('INC');
        continue;
      }
      if ((piece === 'MN' || piece === 'CM' || piece === 'CAN') && /^(CORPORATION|COMPANY|INCORPORATED|HOLDINGS|LIMITED|INC|CORP|PLC|LLC|CO)$/.test(previous)) {
        words.push('CMN');
        continue;
      }
      if (piece === 'SP' && /^(?:500|SOO|SOD|S00)/.test(tokens[tokenIndex + 1]?.toUpperCase() ?? '')) {
        words.push('S&P');
        continue;
      }
      if (words[words.length - 1] === piece) continue;
      if (piece.length === 1 && piece !== '&' && !/^[A-Z]$/.test(piece)) continue;
      words.push(piece);
    }
  }
  return words.join(' ').replace(/\s+/g, ' ').trim();
}

function readingOrder(boxes: readonly HouseGridOcrBox[]): string {
  const sorted = [...boxes].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines: HouseGridOcrBox[][] = [];
  for (const box of sorted) {
    const line = lines[lines.length - 1];
    const cy = (box.y0 + box.y1) / 2;
    const lineY = line ? line.reduce((sum, entry) => sum + (entry.y0 + entry.y1) / 2, 0) / line.length : 0;
    if (!line || Math.abs(cy - lineY) > 8) lines.push([box]);
    else line.push(box);
  }
  return lines
    .map((line) => line.sort((a, b) => a.x0 - b.x0).map((box) => box.text.trim()).filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' ')
    // Keep a two-space gap. That gap is the bare ticker printed after the name.
    .replace(/[ \t]{3,}/g, '  ')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function assetText(boxes: readonly HouseGridOcrBox[], xs: readonly number[]): { text: string; conf: number } {
  const left = (xs[1] ?? 0) - 8;
  const right = (xs[2] ?? 0) - 4;
  const hits = boxes.filter((box) => box.x0 >= left && box.x0 < right && box.text.trim());
  if (hits.length === 0) return { text: '', conf: 0 };
  const conf = hits.reduce((sum, box) => sum + box.conf, 0) / hits.length;
  return { text: readingOrder(hits), conf };
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

/** Header, sample, and attachment lines on the printed PTR. Marks do not keep them. */
function isOfficialGridChrome(asset: string, txDate: string | null): boolean {
  if (looksLikeHeaderContaminatedAsset(asset) || looksLikeColumnHeaderAsset(asset)) return true;
  if (looksLikePtrFormSampleAsset(asset)) return true;
  if (looksLikePtrFormSampleRow({ assetName: asset, rawText: asset, txDate })) return true;
  if (looksLikeSeeAttachmentPointer(asset)) return true;
  if (/provide full name|ticker symbol|full asset name|filer notes|footnote|amount of transaction|type of trans|publicly disclosed/i.test(asset)) return true;
  if (txDate && looksLikePtrFormSampleDate(txDate)) return true;
  return false;
}

function pageRows(page: HouseGridPageInput): {
  detected: boolean;
  transactions: ParsedTx[];
  markedCells: number;
  markCells: number;
} {
  const empty = { detected: false, transactions: [], markedCells: 0, markCells: 0 };
  const fit = planHouseGridColumns(page.image);
  if (!fit || fit.xs.length < 21) return empty;
  const laidOut = layoutHouseGridRows(page.image, fit);
  // The attached schedule's cover prints a sample grid under the filer block
  // and has no trust bar. The printed PTR has that header rule and real rows.
  if (shouldSkipHouseGridCover(page.image, fit.xs, laidOut.sectionBars, fit.kind)) return empty;
  const sized = xTemplateForFit(fit.kind === 'official' ? fit.scale * OFFICIAL_MARK_SCALE : fit.scale);
  const bands = laidOut.bands;
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
    const glyphOwner = ownerCodeFromCell(page.image, fit.xs[0] ?? 0, band.y0, fit.xs[1] ?? 0, band.y1);
    const textOwner = inBand
      .filter((box) => box.x1 <= (fit.xs[1] ?? 0) + 12 && box.conf >= 0.4)
      .map((box) => ownerFromText(box.text))
      .find((owner): owner is Owner => owner !== null) ?? null;
    // Glyph scores never swapped spouse and dependent on the scored filing.
    // Text fills the cells the glyph leaves blank.
    const owner = glyphOwner ?? textOwner;
    const tradeLeft = fit.xs[7] ?? 0;
    const tradeRight = fit.xs[8] ?? tradeLeft;
    const notifRight = fit.xs[9] ?? tradeRight;
    let tradeDate: string | null = null;
    let notifDate: string | null = null;
    for (const box of inBand) {
      const iso = parseLooseDate(box.text);
      if (!iso) continue;
      const cx = (box.x0 + box.x1) / 2;
      // The left date column is the trade. The right column is the notification.
      // A missed trade-date word stays null instead of copying the notification.
      if (cx >= tradeLeft - 8 && cx < tradeRight) {
        if (!tradeDate) tradeDate = iso;
      } else if (cx >= tradeRight && cx <= notifRight + 8) {
        if (!notifDate) notifDate = iso;
      }
    }
    // A "26" read as "25" is a year behind the notification, not a 2025 trade.
    if (tradeDate && notifDate && tradeDate.slice(0, 4) === String(Number(notifDate.slice(0, 4)) - 1)) {
      const snapped = `${notifDate.slice(0, 4)}-${tradeDate.slice(5)}`;
      if (snapped <= notifDate) tradeDate = snapped;
    }
    const hasMark = marks.typeReason !== 'unmarked' || marks.amountReason !== 'unmarked' || marks.capGainsOver200;
    if (!asset.text && !hasMark) continue;
    if (fit.kind === 'official') {
      // The sample row is marked. Header text and that sample never become trades.
      if (isOfficialGridChrome(asset.text, tradeDate)) continue;
      if (marks.typeReason !== 'ok' || !asset.text.trim()) continue;
    } else if ((looksLikeHeaderContaminatedAsset(asset.text) || looksLikeColumnHeaderAsset(asset.text)) && !hasMark) {
      continue;
    }
    const named = splitBareTicker(asset.text, fit.kind === 'official' ? 1 : 2);
    const assetName = cleanGridAssetName(named.name) || named.name;
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
      txDate: tradeDate,
      owner,
      assetName: assetName || asset.text || `(unreadable asset p${pageNum})`,
      ticker: named.ticker,
      assetType: null,
      txType,
      amountMin: marks.amountMin,
      amountMax: marks.amountMax,
      isOption: /^(?:PUT|CALL)\//i.test(asset.text),
      capGainsOver200: marks.capGainsOver200,
      rawText: `${asset.text || '(unreadable)'} | type ${marks.txType ?? 'unmarked'} | amt ${marks.amountLetter ?? 'blank'}`,
      supplementalText: notes.join('; '),
      description: notifDate ? `date notified ${notifDate}` : null,
      confidence: confidenceFor(marks, asset.conf, Boolean(tradeDate), asset.text),
      ...(warnings.length ? { extractionWarnings: warnings } : {}),
    });
  }
  return { detected: true, transactions, markedCells, markCells };
}

/** Read every supplied page. A filing is a grid form when any page fits. */
export function readHouseGridForm(pages: readonly HouseGridPageInput[]): HouseGridRead {
  const transactions: ParsedTx[] = [];
  let gridPages = 0;
  let markedCells = 0;
  let markCells = 0;
  for (const page of pages) {
    const read = pageRows(page);
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
