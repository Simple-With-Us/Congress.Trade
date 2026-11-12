import { describe, it, expect, vi, afterEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { Env } from '../../shared/types.ts';
import {
  computeDocClassSignals,
  decideDocClass,
  ensureDocClass,
  type DocClassSignals,
} from '../docClassifier.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// pdf-lib's `.save()` always Flate-compresses page content streams (there is
// no SaveOptions toggle for it), which hides the BT..Tj text-show operators
// from the raw byte-prefix sniff that computeDocClassSignals (and the
// pre-existing src/ingestion/classifier.ts heuristic it mirrors) relies on.
// A hand-written, uncompressed-but-still-pdf-lib-loadable PDF exercises the
// deterministic tier the same way src/ingestion/__tests__/classifier.test.ts
// already does for classifyPdfBytes, without pdf-lib silently deflating the
// text layer out of the sniff window.
async function typedPdf(): Promise<ArrayBuffer> {
  const content = 'BT /F1 12 Tf 20 200 Td (Periodic Transaction Report AAPL P) Tj ET';
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length ${content.length} >>
stream
${content}
endstream
endobj
trailer
<< /Size 6 /Root 1 0 R >>
%%EOF`;
  return toArrayBuffer(new TextEncoder().encode(pdf));
}

async function blankPdf(): Promise<ArrayBuffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 400]);
  return toArrayBuffer(await pdf.save());
}

const signals = (over: Partial<DocClassSignals>): DocClassSignals => ({
  byteLength: 500 * 1024,
  pdfLoadable: true,
  claimsPdf: true,
  pageCount: 5,
  hasTextLayer: false,
  hasImages: true,
  docKind: 'scanned_pdf',
  ...over,
});

describe('decideDocClass — deterministic tier', () => {
  it('classifies corrupt: empty bytes or an unloadable claimed PDF', () => {
    expect(decideDocClass(signals({ byteLength: 0 }))).toBe('corrupt');
    expect(decideDocClass(signals({ pdfLoadable: false }))).toBe('corrupt');
  });

  it('classifies typed: text layer, text_pdf docKind, or eFD HTML', () => {
    expect(decideDocClass(signals({ hasTextLayer: true }))).toBe('typed');
    expect(decideDocClass(signals({ docKind: 'text_pdf' }))).toBe('typed');
    expect(decideDocClass(signals({ claimsPdf: false, docKind: 'senate_html' }))).toBe('typed');
  });

  it('classifies House electronic DocIDs as typed even when stored as scanned_pdf', () => {
    expect(decideDocClass(signals({
      docId: 'H-2025-20030634',
      hasTextLayer: false,
      hasImages: true,
      docKind: 'scanned_pdf',
    }))).toBe('typed');
  });

  it('classifies empty: zero pages, or no text/images with tiny bytes-per-page', () => {
    expect(decideDocClass(signals({ pageCount: 0 }))).toBe('empty');
    expect(decideDocClass(signals({
      byteLength: 4 * 1024, pageCount: 1, hasImages: false,
    }))).toBe('empty');
  });

  it('classifies clean vs hard scans by pages / size / image density', () => {
    // 5 pages at ~100KB/page: an ordinary legible scan.
    expect(decideDocClass(signals({ byteLength: 500 * 1024, pageCount: 5 }))).toBe('clean_scan');
    // Over the page threshold, the total-size threshold, or very dense pages.
    expect(decideDocClass(signals({ pageCount: 15, byteLength: 1024 * 1024 }))).toBe('hard_scan');
    expect(decideDocClass(signals({ byteLength: 3 * 1024 * 1024, pageCount: 4 }))).toBe('hard_scan');
    expect(decideDocClass(signals({ byteLength: 700 * 1024, pageCount: 1 }))).toBe('hard_scan');
  });

  it('abstains (null) on the ambiguous density band → model tier', () => {
    // 400KB/page: between the clean (300KB) and hard (600KB) cutoffs.
    expect(decideDocClass(signals({ byteLength: 800 * 1024, pageCount: 2 }))).toBeNull();
  });
});

describe('computeDocClassSignals', () => {
  it('detects a real text-layer PDF as typed end-to-end', async () => {
    const bytes = await typedPdf();
    const computed = await computeDocClassSignals(bytes);
    expect(computed.claimsPdf).toBe(true);
    expect(computed.pdfLoadable).toBe(true);
    expect(computed.pageCount).toBe(1);
    expect(computed.hasTextLayer).toBe(true);
    expect(decideDocClass(computed)).toBe('typed');
  });

  it('treats an embedded /Font (compressed text layer) as a text layer', async () => {
    const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
trailer
<< /Size 5 /Root 1 0 R >>
%%EOF`;
    const computed = await computeDocClassSignals(toArrayBuffer(new TextEncoder().encode(pdf)));
    expect(computed.hasTextLayer).toBe(true);
  });

  it('detects a blank one-page PDF as empty end-to-end', async () => {
    const bytes = await blankPdf();
    const computed = await computeDocClassSignals(bytes);
    expect(computed.hasTextLayer).toBe(false);
    expect(computed.hasImages).toBe(false);
    expect(decideDocClass(computed)).toBe('empty');
  });

  it('detects garbage bytes as corrupt end-to-end', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7 this is not really a pdf at all');
    const computed = await computeDocClassSignals(toArrayBuffer(bytes));
    expect(computed.claimsPdf).toBe(true);
    expect(computed.pdfLoadable).toBe(false);
    expect(decideDocClass(computed)).toBe('corrupt');
  });
});

describe('ensureDocClass', () => {
  interface DbState {
    persisted: string | null;
    stored: unknown[][];
    docClassRow: { doc_class: string | null; doc_kind: string | null } | null;
  }

  function dbEnv(state: DbState, envVars: Record<string, unknown> = {}): Env {
    return {
      ...envVars,
      DB: {
        prepare(sql: string) {
          return {
            params: [] as unknown[],
            bind(...p: unknown[]) { this.params = p; return this; },
            async first() {
              if (/SELECT doc_class, doc_kind FROM filings/i.test(sql)) return state.docClassRow;
              return null;
            },
            async run() {
              if (/UPDATE filings SET doc_class = \?/i.test(sql)) {
                state.persisted = String(this.params[0]);
                state.stored.push(this.params);
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      },
    } as unknown as Env;
  }

  it('short-circuits on an already-persisted class (no re-classification)', async () => {
    const state: DbState = {
      persisted: null, stored: [], docClassRow: { doc_class: 'clean_scan', doc_kind: 'scanned_pdf' },
    };
    const result = await ensureDocClass(dbEnv(state), 'H-1', await blankPdf());
    expect(result).toEqual({ docClass: 'clean_scan', source: 'persisted' });
    expect(state.persisted).toBeNull();
  });

  it('persists a deterministic classification without any model call', async () => {
    const state: DbState = { persisted: null, stored: [], docClassRow: null };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await ensureDocClass(dbEnv(state), 'H-1', await typedPdf());
    expect(result).toEqual({ docClass: 'typed', source: 'deterministic' });
    expect(state.persisted).toBe('typed');
    expect(fetchSpy).not.toHaveBeenCalled(); // deterministic tier is free
  });

  // Ambiguous density band: 2 pages at 400KB/page, images, no text layer.
  const ambiguousSignals = async (): Promise<DocClassSignals> => signals({
    byteLength: 800 * 1024, pageCount: 2,
  });

  it('uses ONE enum-constrained model call only for ambiguous docs', async () => {
    const state: DbState = { persisted: null, stored: [], docClassRow: null };
    const fetchSpy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('openrouter.ai');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe('google/gemini-3.5-flash-lite');
      expect(JSON.stringify(body.plugins)).toContain('cloudflare-ai');
      expect(JSON.stringify(body.response_format)).toContain('"enum"');
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"doc_class":"hard_scan"}' } }] }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchSpy);
    const env = dbEnv(state, { OPENROUTER_API_KEY: 'test-key' });
    const result = await ensureDocClass(
      env, 'H-1', await blankPdf(), undefined, { computeSignals: ambiguousSignals },
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ docClass: 'hard_scan', source: 'model' });
    expect(state.persisted).toBe('hard_scan');
  });

  it('propagates lease cancellation through the model tier without persisting a fallback', async () => {
    const state: DbState = { persisted: null, stored: [], docClassRow: null };
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      controller.abort(new Error('lease lost during classification'));
      throw controller.signal.reason;
    }));
    const env = dbEnv(state, { OPENROUTER_API_KEY: 'test-key' });

    await expect(ensureDocClass(
      env,
      'H-abort',
      await blankPdf(),
      undefined,
      { computeSignals: ambiguousSignals, signal: controller.signal },
    )).rejects.toThrow('lease lost during classification');
    expect(state.persisted).toBeNull();
  });

  it('falls back to hard_scan (safest: full trio) when the model tier fails', async () => {
    const state: DbState = { persisted: null, stored: [], docClassRow: null };
    vi.stubGlobal('fetch', vi.fn(async () => (
      { ok: false, status: 500, text: async () => 'boom' }
    ) as unknown as Response));
    const env = dbEnv(state, { OPENROUTER_API_KEY: 'test-key' });
    const result = await ensureDocClass(
      env, 'H-1', await blankPdf(), undefined, { computeSignals: ambiguousSignals },
    );
    expect(result.docClass).toBe('hard_scan');
    expect(result.source).toBe('fallback');
  });

  it('skips the model tier when DOC_CLASSIFIER_ENABLED=false', async () => {
    const state: DbState = { persisted: null, stored: [], docClassRow: null };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const env = dbEnv(state, { DOC_CLASSIFIER_ENABLED: 'false', OPENROUTER_API_KEY: 'test-key' });
    const result = await ensureDocClass(
      env, 'H-1', await blankPdf(), undefined, { computeSignals: ambiguousSignals },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ docClass: 'hard_scan', source: 'fallback' });
  });
});
