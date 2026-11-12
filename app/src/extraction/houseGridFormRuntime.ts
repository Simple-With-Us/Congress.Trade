/**
 * pdftoppm + tesseract backend for the House grid-form stage.
 *
 * Both binaries already ship in the app image for the OGE local OCR pass.
 * This file is the only place that shells out. Tests never import it.
 */

import {
  layoutHouseGridRows,
  planHouseGridColumns,
  readHouseGridForm,
  shouldSkipHouseGridCover,
  type GrayImage,
  type HouseGridFormReader,
  type HouseGridOcrBox,
} from './houseGridForm.ts';

const PDFTOPPM = 'pdftoppm';
const TESSERACT = 'tesseract';
const RENDER_DPI = 150;
// Text cells are rendered at twice the mark image so a 10px glyph is a real
// sample, not a nearest-neighbor blow-up of the 150 DPI page.
const TEXT_DPI = 300;
const MAX_PAGES = 40;

interface CommandOutput {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}

async function runBinary(cmd: string, args: string[], timeoutMs: number): Promise<CommandOutput> {
  if (typeof Deno === 'undefined') {
    return { code: -1, stdout: new Uint8Array(), stderr: 'deno runtime unavailable' };
  }
  try {
    const command = new Deno.Command(cmd, {
      args,
      stdout: 'piped',
      stderr: 'piped',
      stdin: 'null',
      // LSTM OpenMP inside each tesseract process. Eight of those on a small
      // machine spend their time fighting over cores instead of reading cells.
      env: cmd === TESSERACT ? { OMP_THREAD_LIMIT: '1', OMP_NUM_THREADS: '1' } : undefined,
    });
    const child = command.spawn();
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already exited
      }
    }, timeoutMs);
    try {
      const { code, stdout, stderr } = await child.output();
      return { code, stdout, stderr: new TextDecoder().decode(stderr) };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { code: -1, stdout: new Uint8Array(), stderr: (err as Error).message };
  }
}

/** Parse a binary P5 PGM. Returns null when the header is not the form we render. */
export function parsePgm(bytes: Uint8Array): GrayImage | null {
  let index = 0;
  function nextToken(): string | null {
    while (index < bytes.length) {
      const byte = bytes[index];
      if (byte === 35) {
        while (index < bytes.length && bytes[index] !== 10) index += 1;
        continue;
      }
      if (byte === 32 || byte === 10 || byte === 13 || byte === 9) {
        index += 1;
        continue;
      }
      const start = index;
      while (index < bytes.length) {
        const value = bytes[index];
        if (value === 32 || value === 10 || value === 13 || value === 9) break;
        index += 1;
      }
      return new TextDecoder().decode(bytes.subarray(start, index));
    }
    return null;
  }
  if (nextToken() !== 'P5') return null;
  const width = Number(nextToken());
  const height = Number(nextToken());
  const maxval = Number(nextToken());
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  if (bytes[index] === 10 || bytes[index] === 32) index += 1;
  const count = width * height;
  if (maxval === 255) {
    if (bytes.length < index + count) return null;
    return { width, height, pixels: bytes.subarray(index, index + count) };
  }
  if (maxval > 255 && maxval <= 65535) {
    if (bytes.length < index + count * 2) return null;
    const pixels = new Uint8Array(count);
    for (let i = 0; i < count; i += 1) {
      const value = (bytes[index + i * 2] << 8) | bytes[index + i * 2 + 1];
      pixels[i] = Math.round((value / maxval) * 255);
    }
    return { width, height, pixels };
  }
  return null;
}

function cropGray(image: GrayImage, x0: number, y0: number, x1: number, y1: number, scale = 1): GrayImage {
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const right = Math.max(left + 1, Math.min(image.width, Math.ceil(x1)));
  const bot = Math.max(top + 1, Math.min(image.height, Math.ceil(y1)));
  const srcWidth = right - left;
  const srcHeight = bot - top;
  const factor = scale > 1 ? Math.round(scale) : 1;
  const width = srcWidth * factor;
  const height = srcHeight * factor;
  const pixels = new Uint8Array(width * height);
  pixels.fill(255);
  for (let y = 0; y < srcHeight; y += 1) {
    const src = (top + y) * image.width + left;
    for (let x = 0; x < srcWidth; x += 1) {
      const value = image.pixels[src + x];
      for (let dy = 0; dy < factor; dy += 1) {
        const row = (y * factor + dy) * width + x * factor;
        for (let dx = 0; dx < factor; dx += 1) pixels[row + dx] = value;
      }
    }
  }
  return { width, height, pixels };
}

function padGray(image: GrayImage, pad: number): GrayImage {
  const width = image.width + pad * 2;
  const height = image.height + pad * 2;
  const pixels = new Uint8Array(width * height);
  pixels.fill(255);
  for (let y = 0; y < image.height; y += 1) {
    pixels.set(image.pixels.subarray(y * image.width, (y + 1) * image.width), (y + pad) * width + pad);
  }
  return { width, height, pixels };
}

function pgmBytes(image: GrayImage): Uint8Array {
  const header = new TextEncoder().encode(`P5\n${image.width} ${image.height}\n255\n`);
  const bytes = new Uint8Array(header.length + image.pixels.length);
  bytes.set(header, 0);
  bytes.set(image.pixels, header.length);
  return bytes;
}

/** Group tesseract TSV words into line boxes with conf in 0..1. */
export function parseTesseractTsv(tsv: string, width: number, height: number): HouseGridOcrBox[] {
  const lines = tsv.split(/\r?\n/);
  const boxes: HouseGridOcrBox[] = [];
  for (const line of lines) {
    if (!line || line.startsWith('level\t')) continue;
    const parts = line.split('\t');
    if (parts.length < 12) continue;
    const text = parts.slice(11).join('\t').trim();
    if (!text) continue;
    const conf = Number(parts[10]);
    const left = Number(parts[6]);
    const top = Number(parts[7]);
    const boxWidth = Number(parts[8]);
    const boxHeight = Number(parts[9]);
    if (![conf, left, top, boxWidth, boxHeight].every(Number.isFinite)) continue;
    if (boxWidth <= 0 || boxHeight <= 0) continue;
    boxes.push({
      x0: Math.max(0, left),
      y0: Math.max(0, top),
      x1: Math.min(width, left + boxWidth),
      y1: Math.min(height, top + boxHeight),
      text,
      conf: Math.max(0, Math.min(1, (conf >= 0 ? conf : 0) / 100)),
    });
  }
  return boxes;
}

async function binariesReady(): Promise<boolean> {
  const poppler = await runBinary(PDFTOPPM, ['-v'], 15_000);
  const tesseract = await runBinary(TESSERACT, ['--version'], 15_000);
  return poppler.code === 0 || poppler.stderr.toLowerCase().includes('poppler')
    ? tesseract.code === 0
    : false;
}

// The text page is already 300 DPI. A second nearest-neighbor scale turns
// the first letter into a blob and makes Tesseract drop the date.
const CELL_SCALE = 1;
const CELL_PAD = 8;

/**
 * Asset text sits between the vertical rules. The fitted column line is
 * often a few pixels into the first letter, so a fixed inset clips it.
 * Returns bounds in the same pixel space as `image`.
 */
function spanBetweenRules(
  image: GrayImage,
  searchLeft: number,
  searchRight: number,
  anchorLeft: number,
  anchorRight: number,
  top: number,
  bottom: number,
  inset: number,
): { x0: number; x1: number } | null {
  const left = Math.max(0, Math.floor(searchLeft));
  const right = Math.min(image.width - 1, Math.ceil(searchRight));
  const y0 = Math.max(0, Math.floor(top));
  const y1 = Math.min(image.height, Math.ceil(bottom));
  const height = y1 - y0;
  if (height < 8 || right - left < 16) return null;
  const rules: number[] = [];
  for (let x = left; x <= right; x += 1) {
    let dark = 0;
    for (let y = y0; y < y1; y += 1) {
      if (image.pixels[y * image.width + x] < 150) dark += 1;
    }
    if (dark / height > 0.55) rules.push(x);
  }
  const slop = Math.max(8, inset * 2);
  const leftRules = rules.filter((x) => x <= anchorLeft + slop);
  const rightRules = rules.filter((x) => x >= anchorRight - slop);
  if (leftRules.length === 0 || rightRules.length === 0) return null;
  const x0 = leftRules[leftRules.length - 1] + inset;
  const x1 = rightRules[0] - inset;
  if (x1 - x0 < 20) return null;
  return { x0, x1 };
}

function joinCellWords(words: readonly HouseGridOcrBox[]): string {
  const lines: HouseGridOcrBox[][] = [];
  for (const word of words) {
    const line = lines[lines.length - 1];
    const cy = (word.y0 + word.y1) / 2;
    const lineY = line ? line.reduce((sum, entry) => sum + (entry.y0 + entry.y1) / 2, 0) / line.length : 0;
    if (!line || Math.abs(cy - lineY) > 12) lines.push([word]);
    else line.push(word);
  }
  return lines.map((line) => {
    const ordered = [...line].sort((a, b) => a.x0 - b.x0);
    let text = '';
    for (let i = 0; i < ordered.length; i += 1) {
      if (i > 0) {
        const gap = ordered[i].x0 - ordered[i - 1].x1;
        const height = Math.max(8, ordered[i].y1 - ordered[i].y0);
        text += gap > height * 0.85 ? '  ' : ' ';
      }
      text += ordered[i].text.trim();
    }
    return text.trim();
  }).filter(Boolean).join(' ').trim();
}

async function recognizeCell(
  hi: GrayImage,
  factor: number,
  low: { x0: number; y0: number; x1: number; y1: number },
  psm: string,
  whitelist: string | null,
  path: string,
): Promise<HouseGridOcrBox | null> {
  const hx0 = low.x0 * factor;
  const hy0 = low.y0 * factor;
  const hx1 = low.x1 * factor;
  const hy1 = low.y1 * factor;
  if (hx1 - hx0 < 8 || hy1 - hy0 < 8) return null;
  const padded = padGray(cropGray(hi, hx0, hy0, hx1, hy1, CELL_SCALE), CELL_PAD);
  if (typeof Deno === 'undefined') return null;
  await Deno.writeFile(path, pgmBytes(padded));
  const args = [path, 'stdout', '--psm', psm];
  if (whitelist) args.push('-c', `tessedit_char_whitelist=${whitelist}`);
  args.push('tsv');
  const ocr = await runBinary(TESSERACT, args, 30_000);
  if (ocr.code !== 0) return null;
  const words = parseTesseractTsv(new TextDecoder().decode(ocr.stdout), padded.width, padded.height)
    .filter((box) => {
      const cx = (box.x0 + box.x1) / 2;
      const cy = (box.y0 + box.y1) / 2;
      return cx >= CELL_PAD && cy >= CELL_PAD && cx < padded.width - CELL_PAD && cy < padded.height - CELL_PAD;
    });
  const text = joinCellWords(words);
  if (!text) return null;
  const conf = words.reduce((sum, word) => sum + word.conf, 0) / words.length;
  return {
    x0: low.x0 + 1,
    y0: low.y0 + 2,
    x1: Math.max(low.x0 + 2, low.x1 - 1),
    y1: Math.max(low.y0 + 3, low.y1 - 2),
    text,
    conf,
  };
}

async function runPool<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      results[index] = await jobs[index]();
    }
  }
  const workers = Math.min(limit, jobs.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

export function createDenoHouseGridReader(): HouseGridFormReader {
  return {
    async read(bytes: ArrayBuffer): Promise<ReturnType<typeof readHouseGridForm> | null> {
      if (typeof Deno === 'undefined') return null;
      if (!(await binariesReady())) return null;
      const dir = await Deno.makeTempDir({ prefix: 'house-grid-' });
      try {
        const pdf = `${dir}/filing.pdf`;
        await Deno.writeFile(pdf, new Uint8Array(bytes));
        const rendered = await runBinary(
          PDFTOPPM,
          ['-gray', '-r', String(RENDER_DPI), '-f', '1', '-l', String(MAX_PAGES), pdf, `${dir}/mark`],
          180_000,
        );
        const renderedText = await runBinary(
          PDFTOPPM,
          ['-gray', '-r', String(TEXT_DPI), '-f', '1', '-l', String(MAX_PAGES), pdf, `${dir}/text`],
          180_000,
        );
        if (rendered.code !== 0 || renderedText.code !== 0) return null;
        const names: string[] = [];
        for await (const entry of Deno.readDir(dir)) {
          if (entry.isFile && entry.name.startsWith('mark-') && entry.name.endsWith('.pgm')) names.push(entry.name);
        }
        names.sort();
        const pages = [];
        for (let i = 0; i < names.length; i += 1) {
          const raw = await Deno.readFile(`${dir}/${names[i]}`);
          const image = parsePgm(raw);
          if (!image) continue;
          const textName = names[i].replace(/^mark-/, 'text-');
          const hi = parsePgm(await Deno.readFile(`${dir}/${textName}`));
          const plan = planHouseGridColumns(image);
          const boxes: HouseGridOcrBox[] = [];
          if (hi && plan && plan.xs.length >= 10) {
            const factor = hi.width / image.width;
            const laidOut = layoutHouseGridRows(image, plan);
            if (shouldSkipHouseGridCover(image, plan.xs, laidOut.sectionBars, plan.kind)) {
              pages.push({ image, boxes, page: i + 1 });
              continue;
            }
            const bands = laidOut.bands;
            const jobs: Array<() => Promise<HouseGridOcrBox | null>> = [];
            let jobId = 0;
            const ruleInset = Math.round(4 * factor);
            // The fitted line is the rule. A 2px inset still includes it, and
            // Tesseract then reads JT as "ost" and 11 as 41. The printed PTR
            // needs one more pixel. The schedule crop stays where it scored.
            const textInset = plan.kind === 'official' ? 4 : 2;
            const yInset = plan.kind === 'official' ? 4 : 3;
            for (const band of bands) {
              // The row rules sit on the band edges. Leaving them in the cell
              // makes a one-line date read as empty.
              const y0 = band.y0 + yInset;
              const y1 = band.y1 - yInset;
              const asset = spanBetweenRules(
                hi,
                (plan.xs[1] - 14) * factor,
                (plan.xs[2] + 6) * factor,
                plan.xs[1] * factor,
                plan.xs[2] * factor,
                y0 * factor,
                y1 * factor,
                ruleInset,
              );
              const cells: Array<{ x0: number; x1: number; psm: string; whitelist: string | null }> = [
                { x0: plan.xs[0] + textInset, x1: plan.xs[1] - 2, psm: '7', whitelist: null },
                {
                  x0: asset ? asset.x0 / factor : plan.xs[1] + 4,
                  x1: asset ? asset.x1 / factor : plan.xs[2] - 3,
                  psm: '6',
                  whitelist: null,
                },
                { x0: plan.xs[7] + textInset, x1: plan.xs[8] - 2, psm: '7', whitelist: '0123456789/' },
                { x0: plan.xs[8] + textInset, x1: plan.xs[9] - 2, psm: '7', whitelist: '0123456789/' },
              ];
              for (const cell of cells) {
                const id = jobId;
                jobId += 1;
                const low = { x0: cell.x0, y0, x1: cell.x1, y1 };
                jobs.push(() => recognizeCell(hi, factor, low, cell.psm, cell.whitelist, `${dir}/cell-${i}-${id}.pgm`));
              }
            }
            for (const box of await runPool(jobs, 8)) {
              if (box) boxes.push(box);
            }
          }
          pages.push({ image, boxes, page: i + 1 });
        }
        if (pages.length === 0) return null;
        return readHouseGridForm(pages);
      } catch (err) {
        console.warn('house grid form: local render failed', (err as Error).message);
        return null;
      } finally {
        try {
          await Deno.remove(dir, { recursive: true });
        } catch {
          // temp dir is best-effort
        }
      }
    },
  };
}
