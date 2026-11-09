/**
 * pdftoppm + tesseract backend for the House grid-form stage.
 *
 * Both binaries already ship in the app image for the OGE local OCR pass.
 * This file is the only place that shells out. Tests never import it.
 */

import {
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
          const ocr = await runBinary(TESSERACT, [`${dir}/${names[i]}`, 'stdout', 'tsv'], 120_000);
          const text = new TextDecoder().decode(ocr.stdout);
          const boxes = ocr.code === 0 ? parseTesseractTsv(text, image.width, image.height) : [];
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
