/**
 * pdftoppm + tesseract backend for the House grid-form stage.
 *
 * Both binaries already ship in the app image for the OGE local OCR pass.
 * This file is the only place that shells out. Tests never import it.
 */

import {
  planHouseGridColumns,
  readHouseGridForm,
  type GrayImage,
  type HouseGridFormReader,
  type HouseGridOcrBox,
} from './houseGridForm.ts';

const PDFTOPPM = 'pdftoppm';
const TESSERACT = 'tesseract';
const RENDER_DPI = 150;
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
          ['-gray', '-r', String(RENDER_DPI), '-f', '1', '-l', String(MAX_PAGES), pdf, `${dir}/page`],
          180_000,
        );
        if (rendered.code !== 0) return null;
        const names: string[] = [];
        for await (const entry of Deno.readDir(dir)) {
          if (entry.isFile && entry.name.endsWith('.pgm')) names.push(entry.name);
        }
        names.sort();
        const pages = [];
        for (let i = 0; i < names.length; i += 1) {
          const raw = await Deno.readFile(`${dir}/${names[i]}`);
          const image = parsePgm(raw);
          if (!image) continue;
          const plan = planHouseGridColumns(image);
          const boxes: HouseGridOcrBox[] = [];
          if (plan && plan.xs.length >= 10) {
            const strips: Array<{ x0: number; x1: number; scale: number; whitelist: string | null; psm: string }> = [
              { x0: plan.xs[1] + 2, x1: plan.xs[2] - 2, scale: 2, whitelist: null, psm: '6' },
              { x0: plan.xs[7] + 1, x1: plan.xs[8] - 1, scale: 2, whitelist: '0123456789/', psm: '11' },
              { x0: plan.xs[8] + 1, x1: plan.xs[9] - 1, scale: 2, whitelist: '0123456789/', psm: '11' },
            ];
            const recognized = await Promise.all(strips.map(async (strip, stripIndex) => {
              const crop = cropGray(image, strip.x0, 0, strip.x1, image.height, strip.scale);
              const path = `${dir}/strip-${i}-${stripIndex}.pgm`;
              await Deno.writeFile(path, pgmBytes(crop));
              const args = [path, 'stdout', '--psm', strip.psm];
              if (strip.whitelist) args.push('-c', `tessedit_char_whitelist=${strip.whitelist}`);
              args.push('tsv');
              const ocr = await runBinary(TESSERACT, args, 60_000);
              return { strip, crop, ocr };
            }));
            for (const { strip, crop, ocr } of recognized) {
              if (ocr.code !== 0) continue;
              const text = new TextDecoder().decode(ocr.stdout);
              for (const box of parseTesseractTsv(text, crop.width, crop.height)) {
                boxes.push({
                  x0: strip.x0 + box.x0 / strip.scale,
                  x1: strip.x0 + box.x1 / strip.scale,
                  y0: box.y0 / strip.scale,
                  y1: box.y1 / strip.scale,
                  text: box.text,
                  conf: box.conf,
                });
              }
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
