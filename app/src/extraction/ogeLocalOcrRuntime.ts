/**
 * src/extraction/ogeLocalOcrRuntime.ts
 *
 * The poppler/tesseract shell-out behind the local OGE 278-T OCR retry
 * (see ogeLocalOcr.ts for the contract).
 *
 * Both binaries ship in the app image (app/Dockerfile installs poppler-utils
 * and tesseract-ocr + tesseract-ocr-data-eng) and Deno runs with
 * `--allow-run=pdftoppm,tesseract`.  When they are missing the
 * backend reports it through probe() and the pass fails closed — the filing
 * parks exactly as it did before.
 *
 * The tests never touch this file: they inject a fake backend, so CI does
 * not depend on the binaries being installed.
 */

import type {
  OgeLocalOcrBackend,
  OgeLocalOcrPage,
  OgeLocalOcrProbe,
  OgeLocalOcrReadOptions,
} from './ogeLocalOcr.ts';

const PDFTOPPM = 'pdftoppm';
const TESSERACT = 'tesseract';

/** Default per-invocation timeout.  A 34-page read at 600 DPI takes minutes. */
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;
/** Render timeout — poppler is fast, but a huge page can still stall. */
const DEFAULT_RENDER_TIMEOUT_MS = 3 * 60_000;
/** Probe timeout — these must answer immediately or they are not installed. */
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

interface CommandOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a binary and capture its output.  Never throws. */
async function runBinary(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandOutput> {
  if (typeof Deno === 'undefined') {
    return { code: -1, stdout: '', stderr: 'deno runtime unavailable' };
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
      const decoder = new TextDecoder();
      return { code, stdout: decoder.decode(stdout), stderr: decoder.decode(stderr) };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { code: -1, stdout: '', stderr: (err as Error).message };
  }
}

export interface OgeLocalOcrRuntimeOptions {
  /** Timeout for the tesseract invocation. */
  commandTimeoutMs?: number;
  /** Timeout for the pdftoppm invocation. */
  renderTimeoutMs?: number;
  /** Timeout for the probe invocations. */
  probeTimeoutMs?: number;
}

/**
 * The production backend: renders with pdftoppm, OCRs with tesseract.
 *
 * The crop rectangle is expressed in 300-DPI pixel units of the RENDERED page
 * and scaled to the read DPI.  pdftoppm renders with the page's /Rotate
 * applied, so the crop lands on the table body of the page as it displays.
 */
export function createDenoLocalOcrBackend(
  options: OgeLocalOcrRuntimeOptions = {},
): OgeLocalOcrBackend {
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const renderTimeoutMs = options.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  let probeCache: OgeLocalOcrProbe | null = null;

  return {
    async probe(): Promise<OgeLocalOcrProbe> {
      if (probeCache) return probeCache;
      const pdftoppm = await runBinary(PDFTOPPM, ['-v'], probeTimeoutMs);
      if (pdftoppm.code !== 0) {
        probeCache = { ok: false, reason: 'pdftoppm_not_available' };
        return probeCache;
      }
      const tesseract = await runBinary(TESSERACT, ['--version'], probeTimeoutMs);
      if (tesseract.code !== 0) {
        probeCache = { ok: false, reason: 'tesseract_not_available' };
        return probeCache;
      }
      // The English traineddata ships in its own package on Alpine
      // (tesseract-ocr-data-eng).  Without it tesseract exits 0 but prints
      // "Failed loading language 'eng'" and returns no text, which would look
      // like a clean scan with zero rows.  Fail closed instead.
      const langs = await runBinary(TESSERACT, ['--list-langs'], probeTimeoutMs);
      if (langs.code === 0 && !/\beng\b/.test(langs.stdout)) {
        probeCache = { ok: false, reason: 'tesseract_english_data_missing' };
        return probeCache;
      }
      probeCache = {
        ok: true,
        pdftoppm: (pdftoppm.stderr || pdftoppm.stdout).trim().split('\n')[0],
        tesseract: (tesseract.stdout || tesseract.stderr).trim().split('\n')[0],
      };
      return probeCache;
    },

    async readPages(
      pdf: ArrayBuffer,
      readOptions: OgeLocalOcrReadOptions,
    ): Promise<OgeLocalOcrPage[]> {
      if (typeof Deno === 'undefined') return [];
      const timeoutMs = readOptions.timeoutMs ?? commandTimeoutMs;
      const renderTimeout = Math.min(renderTimeoutMs, timeoutMs);
      let dir: string | null = null;
      try {
        dir = await Deno.makeTempDir({ prefix: 'oge_ocr_' });
        const pdfPath = `${dir}/scan.pdf`;
        await Deno.writeFile(pdfPath, new Uint8Array(pdf));

        const prefix = `${dir}/page`;
        const args: string[] = ['-png', '-r', String(readOptions.dpi)];
        const crop = readOptions.crop;
        if (crop) {
          const scale = readOptions.dpi / 300;
          const x = Math.round(crop.x0 * scale);
          const y = Math.round(crop.y0 * scale);
          const w = Math.round(crop.x1 * scale) - x;
          const h = Math.round(crop.y1 * scale) - y;
          // pdftoppm clamps a crop that runs past the page edge, so an
          // oversized rectangle is harmless — an empty one is not.
          if (w > 0 && h > 0) args.push('-x', String(x), '-y', String(y), '-W', String(w), '-H', String(h));
        }
        args.push('-l', String(readOptions.maxPages), pdfPath, prefix);
        const render = await runBinary(PDFTOPPM, args, renderTimeout);
        if (render.code !== 0) {
          console.warn('oge local ocr: pdftoppm failed', render.stderr.slice(0, 400));
          return [];
        }

        const rendered: Array<{ page: number; path: string }> = [];
        for await (const entry of Deno.readDir(dir)) {
          if (!entry.isFile) continue;
          const match = /^page-(\d+)\.png$/.exec(entry.name);
          if (!match) continue;
          rendered.push({ page: Number(match[1]), path: `${dir}/${entry.name}` });
        }
        rendered.sort((a, b) => a.page - b.page);

        const wanted = readOptions.pages
          ? rendered.filter((r) => readOptions.pages?.includes(r.page))
          : rendered;
        if (wanted.length === 0) return [];

        // tesseract's list mode reads a file of image paths and OCRs them in
        // one process, which avoids paying the model load per page.
        const listPath = `${dir}/pages.txt`;
        await Deno.writeTextFile(listPath, `${wanted.map((r) => r.path).join('\n')}\n`);
        const outBase = `${dir}/ocr`;
        const ocr = await runBinary(
          TESSERACT,
          [listPath, outBase, '--psm', '4'],
          timeoutMs,
        );
        if (ocr.code !== 0) {
          console.warn('oge local ocr: tesseract failed', ocr.stderr.slice(0, 400));
          return [];
        }

        let raw: string;
        try {
          raw = await Deno.readTextFile(`${outBase}.txt`);
        } catch {
          return [];
        }
        // Tesseract separates the pages of a list-mode run with a form feed.
        const parts = raw.split('\f');
        const pages: OgeLocalOcrPage[] = [];
        for (let i = 0; i < wanted.length; i += 1) {
          pages.push({ page: wanted[i].page, text: parts[i] ?? '' });
        }
        return pages;
      } catch (err) {
        console.warn('oge local ocr: read failed', (err as Error).message);
        return [];
      } finally {
        if (dir) {
          try {
            await Deno.remove(dir, { recursive: true });
          } catch {
            // best effort cleanup
          }
        }
      }
    },
  };
}

let singleton: OgeLocalOcrBackend | null = null;

/** The shared backend instance (the probe result is cached per instance). */
export function denoLocalOcrBackend(): OgeLocalOcrBackend {
  if (!singleton) singleton = createDenoLocalOcrBackend();
  return singleton;
}
