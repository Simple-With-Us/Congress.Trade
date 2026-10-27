import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { Env } from '../../shared/types.ts';
import {
  attemptOgeLocalOcr,
  DEFAULT_OGE_LOCAL_OCR_CROP,
  gateOgeLocalOcrRows,
  isOgeLocalOcrCandidate,
  maybeRecoverOgeRowsViaLocalOcr,
  OGE_LOCAL_OCR_REASONS,
  ogeLocalOcrAlreadyAttempted,
  ogeLocalOcrIndexesAreContiguous,
  ogeLocalOcrReviewPayload,
  ogeLocalOcrSettings,
  parseOgeLocalOcrCrop,
  parseOgeLocalOcrPage,
  reconcileOgeLocalOcrReads,
  type OgeLocalOcrBackend,
  type OgeLocalOcrPage,
  type OgeLocalOcrReadOptions,
  type OgeLocalOcrReadRow,
  type OgeLocalOcrSettings,
} from '../ogeLocalOcr.ts';

// CT-2448: local tesseract retry before an unreadable 278-T parks.  Every
// test here runs against a fake backend with canned OCR text, so CI never
// needs poppler or tesseract installed.  The one real-binary test at the
// bottom runs only when both binaries are on PATH.

// Headerless table-body text, the shape a cropped OCR read returns: no
// 278-T header, just the numbered rows tesseract saw on the page.
const CLEAN_BODY = [
  '1 Amazon.com, Inc. (AMZN) Sale 06/10/2022 No $1,001 - $15,000',
  '2 SPDR S&P 500 ETF Trust (SPY) Purchase 06/13/2022 No $1,001 - $15,000',
  '3 Invesco QQQ Trust, Series 1 (QQQ) Purchase 06/13/2022 No $15,001 - $50,000',
].join('\n');

const GAP_BODY = [
  '1 Amazon.com, Inc. (AMZN) Sale 06/10/2022 No $1,001 - $15,000',
  '3 Invesco QQQ Trust, Series 1 (QQQ) Purchase 06/13/2022 No $15,001 - $50,000',
].join('\n');

const DATE_DRIFT_BODY = [
  '1 Amazon.com, Inc. (AMZN) Sale 06/10/2022 No $1,001 - $15,000',
  // Same row, one day off: the 600 DPI read misread the date.
  '2 SPDR S&P 500 ETF Trust (SPY) Purchase 06/14/2022 No $1,001 - $15,000',
  '3 Invesco QQQ Trust, Series 1 (QQQ) Purchase 06/13/2022 No $15,001 - $50,000',
].join('\n');

const TYPE_DRIFT_BODY = [
  '1 Amazon.com, Inc. (AMZN) Sale 06/10/2022 No $1,001 - $15,000',
  '2 SPDR S&P 500 ETF Trust (SPY) Sale 06/13/2022 No $1,001 - $15,000',
  '3 Invesco QQQ Trust, Series 1 (QQQ) Purchase 06/13/2022 No $15,001 - $50,000',
].join('\n');

const NON_CANONICAL_BODY = [
  '1 Amazon.com, Inc. (AMZN) Sale 06/10/2022 No $1,001 - $15,000',
  // $1,001 - $50,000 spans two STOCK Act brackets, so the shared amount
  // parser leaves it raw and the gate must refuse it.  (Near-miss pairs
  // like $1,001 - $15,001 snap to a bracket during parsing instead.)
  '2 SPDR S&P 500 ETF Trust (SPY) Purchase 06/13/2022 No $1,001 - $50,000',
  '3 Invesco QQQ Trust, Series 1 (QQQ) Purchase 06/13/2022 No $15,001 - $50,000',
].join('\n');

// Same rows as CLEAN_BODY except the LAST row's date drifted: the surviving
// 1..2 still look contiguous, so only the unreconciled row stops publication.
const TRAILING_DATE_DRIFT_BODY = [
  '1 Amazon.com, Inc. (AMZN) Sale 06/10/2022 No $1,001 - $15,000',
  '2 SPDR S&P 500 ETF Trust (SPY) Purchase 06/13/2022 No $1,001 - $15,000',
  '3 Invesco QQQ Trust, Series 1 (QQQ) Purchase 06/14/2022 No $15,001 - $50,000',
].join('\n');

// Same shape, but the last row fails the gate instead of reconciliation: the
// amount spans two STOCK Act brackets, so rows 1..2 survive while row 3 is
// rejected.  Publishing the survivors would silently drop a transaction.
const TRAILING_NON_CANONICAL_BODY = [
  '1 Amazon.com, Inc. (AMZN) Sale 06/10/2022 No $1,001 - $15,000',
  '2 SPDR S&P 500 ETF Trust (SPY) Purchase 06/13/2022 No $1,001 - $15,000',
  '3 Invesco QQQ Trust, Series 1 (QQQ) Purchase 06/13/2022 No $1,001 - $50,000',
].join('\n');

function testSettings(overrides: Partial<OgeLocalOcrSettings> = {}): OgeLocalOcrSettings {
  return {
    enabled: true,
    maxPages: 40,
    maxSeconds: 420,
    crop: { ...DEFAULT_OGE_LOCAL_OCR_CROP },
    ...overrides,
  };
}

interface FakeBackend extends OgeLocalOcrBackend {
  calls: OgeLocalOcrReadOptions[];
}

/** Canned pages per read, keyed by DPI.  Tests that need crop-sensitive reads use fakeCropBackend. */
function fakeBackend(pagesByDpi: Record<number, OgeLocalOcrPage[]>): FakeBackend {
  const calls: OgeLocalOcrReadOptions[] = [];
  return {
    calls,
    probe: async () => ({ ok: true }),
    readPages: async (_pdf, options) => {
      calls.push(options);
      return pagesByDpi[options.dpi] ?? [];
    },
  };
}

/** Canned pages keyed by `${dpi}:${cropped ? 'crop' : 'full'}` for the crop-fallback tests. */
function fakeCropBackend(pagesByKey: Record<string, OgeLocalOcrPage[]>): FakeBackend {
  const calls: OgeLocalOcrReadOptions[] = [];
  return {
    calls,
    probe: async () => ({ ok: true }),
    readPages: async (_pdf, options) => {
      calls.push(options);
      return pagesByKey[`${options.dpi}:${options.crop ? 'crop' : 'full'}`] ?? [];
    },
  };
}

function page(text: string, pageNo = 1): OgeLocalOcrPage {
  return { page: pageNo, text };
}

function request(bytes: ArrayBuffer | null = new ArrayBuffer(8)) {
  return {
    docId: 'E-2026-donald-j-trump-08-12-2026-278t',
    chamber: 'executive',
    filingType: '278t',
    bytes,
  };
}

describe('attemptOgeLocalOcr', () => {
  it('publishes a clean scan both reads agree on', async () => {
    const backend = fakeBackend({ 400: [page(CLEAN_BODY)], 600: [page(CLEAN_BODY)] });
    const outcome = await attemptOgeLocalOcr(request(), { backend, settings: testSettings() });

    expect(outcome.status).toBe('rows');
    if (outcome.status !== 'rows') throw new Error('expected rows');
    expect(outcome.rows).toHaveLength(3);
    expect(outcome.rows[0]).toMatchObject({
      assetName: 'Amazon.com, Inc.',
      ticker: 'AMZN',
      txType: 'S',
      txDate: '2022-06-10',
      amountMin: 1001,
      amountMax: 15000,
    });
    expect(outcome.rows.map((r) => r.txType)).toEqual(['S', 'B', 'B']);
    // Both DPIs were read; the crop held so no full-page re-read ran.
    expect(backend.calls.map((c) => c.dpi)).toEqual([400, 600]);
    expect(backend.calls.every((c) => c.crop !== null)).toBe(true);
  });

  it('parks when a row number is missing from both reads', async () => {
    const backend = fakeBackend({ 400: [page(GAP_BODY)], 600: [page(GAP_BODY)] });
    const outcome = await attemptOgeLocalOcr(request(), { backend, settings: testSettings() });

    expect(outcome.status).toBe('unreadable');
    if (outcome.status !== 'unreadable') throw new Error('expected park');
    expect(outcome.reason).toContain('row_index_gap');
    const gap = outcome.unreconciled.find((r) => r.reason === OGE_LOCAL_OCR_REASONS.indexGap);
    expect(gap?.index).toBe(2);
  });

  it('parks when the two reads disagree on a date', async () => {
    const backend = fakeBackend({ 400: [page(CLEAN_BODY)], 600: [page(DATE_DRIFT_BODY)] });
    const outcome = await attemptOgeLocalOcr(request(), { backend, settings: testSettings() });

    expect(outcome.status).toBe('unreadable');
    if (outcome.status !== 'unreadable') throw new Error('expected park');
    const drift = outcome.unreconciled.find((r) => r.index === 2);
    expect(drift?.reason).toBe(OGE_LOCAL_OCR_REASONS.dateDisagreement);
    expect(drift?.primary?.date).toBe('2022-06-13');
    expect(drift?.secondary?.date).toBe('2022-06-14');
  });

  it('parks when the two reads disagree on a type', async () => {
    const backend = fakeBackend({ 400: [page(CLEAN_BODY)], 600: [page(TYPE_DRIFT_BODY)] });
    const outcome = await attemptOgeLocalOcr(request(), { backend, settings: testSettings() });

    expect(outcome.status).toBe('unreadable');
    if (outcome.status !== 'unreadable') throw new Error('expected park');
    const drift = outcome.unreconciled.find((r) => r.index === 2);
    expect(drift?.reason).toBe(OGE_LOCAL_OCR_REASONS.typeDisagreement);
  });

  it('parks when an amount is not a canonical STOCK Act bracket', async () => {
    const backend = fakeBackend({ 400: [page(NON_CANONICAL_BODY)], 600: [page(NON_CANONICAL_BODY)] });
    const outcome = await attemptOgeLocalOcr(request(), { backend, settings: testSettings() });

    expect(outcome.status).toBe('unreadable');
    if (outcome.status !== 'unreadable') throw new Error('expected park');
    const bad = outcome.unreconciled.find((r) => r.index === 2);
    expect(bad?.reason).toBe(OGE_LOCAL_OCR_REASONS.nonCanonicalBracket);
  });

  it('parks instead of publishing a truncated set when the trailing row disagrees', async () => {
    const backend = fakeBackend({ 400: [page(CLEAN_BODY)], 600: [page(TRAILING_DATE_DRIFT_BODY)] });
    const outcome = await attemptOgeLocalOcr(request(), { backend, settings: testSettings() });

    // Rows 1..2 reconcile and look contiguous, but row 3 did not: publishing
    // the survivors would silently drop a transaction.
    expect(outcome.status).toBe('unreadable');
    if (outcome.status !== 'unreadable') throw new Error('expected park');
    const drift = outcome.unreconciled.find((r) => r.index === 3);
    expect(drift?.reason).toBe(OGE_LOCAL_OCR_REASONS.dateDisagreement);
  });

  it('parks instead of publishing a truncated set when the trailing row fails the gate', async () => {
    const backend = fakeBackend({
      400: [page(TRAILING_NON_CANONICAL_BODY)],
      600: [page(TRAILING_NON_CANONICAL_BODY)],
    });
    const outcome = await attemptOgeLocalOcr(request(), { backend, settings: testSettings() });

    expect(outcome.status).toBe('unreadable');
    if (outcome.status !== 'unreadable') throw new Error('expected park');
    const bad = outcome.unreconciled.find((r) => r.index === 3);
    expect(bad?.reason).toBe(OGE_LOCAL_OCR_REASONS.nonCanonicalBracket);
  });

  it('fails closed with a clear reason when the binaries are missing', async () => {
    const calls: OgeLocalOcrReadOptions[] = [];
    const backend: OgeLocalOcrBackend = {
      probe: async () => ({ ok: false, reason: 'tesseract_not_available' }),
      readPages: async (_pdf, options) => {
        calls.push(options);
        return [];
      },
    };
    const outcome = await attemptOgeLocalOcr(request(), { backend, settings: testSettings() });

    expect(outcome.status).toBe('unreadable');
    if (outcome.status !== 'unreadable') throw new Error('expected park');
    expect(outcome.reason).toContain('tesseract_not_available');
    expect(outcome.pagesRead).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('falls back to a full-page read when the crop clips the table', async () => {
    const backend = fakeCropBackend({
      // The crop clipped every row; the full page recovers them.
      '400:crop': [],
      '400:full': [page(CLEAN_BODY)],
      '600:crop': [],
      '600:full': [page(CLEAN_BODY)],
    });
    const outcome = await attemptOgeLocalOcr(request(), { backend, settings: testSettings() });

    expect(outcome.status).toBe('rows');
    if (outcome.status !== 'rows') throw new Error('expected rows');
    expect(outcome.rows).toHaveLength(3);
    expect(outcome.cropped).toBe(false);
  });

  it('skips when the filing is not an executive 278-T', async () => {
    const backend = fakeBackend({ 400: [page(CLEAN_BODY)], 600: [page(CLEAN_BODY)] });
    const outcome = await attemptOgeLocalOcr(
      { ...request(), chamber: 'house', docId: 'H-1', filingType: 'P' },
      { backend, settings: testSettings() },
    );
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'not_an_executive_278t' });
    expect(backend.calls).toHaveLength(0);
  });

  it('skips when the pass is switched off', async () => {
    const backend = fakeBackend({ 400: [page(CLEAN_BODY)], 600: [page(CLEAN_BODY)] });
    const outcome = await attemptOgeLocalOcr(
      request(),
      { backend, settings: testSettings({ enabled: false }) },
    );
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'oge_local_ocr_disabled' });
    expect(backend.calls).toHaveLength(0);
  });
});

describe('maybeRecoverOgeRowsViaLocalOcr', () => {
  const filing = { docId: 'E-2026-test-278t', chamber: 'executive', filingType: '278t' };
  const env = {} as Env;

  it('returns null for a text-layer PDF the parser already read', async () => {
    const backend = fakeBackend({ 400: [page(CLEAN_BODY)], 600: [page(CLEAN_BODY)] });
    const outcome = await maybeRecoverOgeRowsViaLocalOcr(env, filing, new ArrayBuffer(8), 'rows', {
      backend,
      settings: testSettings(),
    });
    expect(outcome).toBeNull();
    expect(backend.calls).toHaveLength(0);
  });

  it('returns null for non-unreadable dispositions without touching the binaries', async () => {
    for (const disposition of ['empty', undefined]) {
      const backend = fakeBackend({ 400: [page(CLEAN_BODY)], 600: [page(CLEAN_BODY)] });
      const outcome = await maybeRecoverOgeRowsViaLocalOcr(env, filing, new ArrayBuffer(8), disposition, {
        backend,
        settings: testSettings(),
      });
      expect(outcome).toBeNull();
      expect(backend.calls).toHaveLength(0);
    }
  });

  it('runs the pass for an unreadable executive 278-T', async () => {
    const backend = fakeBackend({ 400: [page(CLEAN_BODY)], 600: [page(CLEAN_BODY)] });
    const outcome = await maybeRecoverOgeRowsViaLocalOcr(env, filing, new ArrayBuffer(8), 'unreadable', {
      backend,
      settings: testSettings(),
    });
    expect(outcome?.status).toBe('rows');
  });
});

describe('reconcileOgeLocalOcrReads', () => {
  it('reports a row seen twice under one index instead of keeping the last', () => {
    const primary = parseOgeLocalOcrPage(1, CLEAN_BODY);
    const doubled = [...primary, { ...primary[1], raw: `${primary[1].raw} (dup)` }];
    const secondary = parseOgeLocalOcrPage(1, CLEAN_BODY);

    const rec = reconcileOgeLocalOcrReads(doubled, secondary);
    expect(rec.rows.map((r) => r.index)).toEqual([1, 3]);
    const dup = rec.unreconciled.find((r) => r.index === 2);
    expect(dup?.reason).toBe(OGE_LOCAL_OCR_REASONS.duplicateIndex);
  });

  it('keeps each read’s unindexed rows in its own slot', () => {
    const primary = parseOgeLocalOcrPage(1, CLEAN_BODY);
    const secondary = parseOgeLocalOcrPage(1, CLEAN_BODY);
    const unindexed: OgeLocalOcrReadRow = { ...primary[0], index: null };

    const rec = reconcileOgeLocalOcrReads([unindexed], secondary);
    const missing = rec.unreconciled.filter((r) => r.reason === OGE_LOCAL_OCR_REASONS.missingIndex);
    expect(missing).toHaveLength(1);
    expect(missing[0].primary).not.toBeNull();
    expect(missing[0].secondary).toBeNull();
  });
});

describe('gateOgeLocalOcrRows', () => {
  it('rejects a row whose type is not B/S/E', () => {
    const rows = parseOgeLocalOcrPage(1, CLEAN_BODY).map((r) =>
      r.index === 2 ? { ...r, type: 'P' as OgeLocalOcrReadRow['type'] } : r,
    );
    const gate = gateOgeLocalOcrRows(rows);
    expect(gate.ok).toBe(false);
    expect(gate.rejected.find((r) => r.index === 2)?.reason).toBe(OGE_LOCAL_OCR_REASONS.invalidType);
  });

  it('rejects a row with no usable date', () => {
    const rows = parseOgeLocalOcrPage(1, CLEAN_BODY).map((r) =>
      r.index === 1 ? { ...r, date: '' } : r,
    );
    const gate = gateOgeLocalOcrRows(rows);
    expect(gate.ok).toBe(false);
    expect(gate.rejected.find((r) => r.index === 1)?.reason).toBe(OGE_LOCAL_OCR_REASONS.invalidDate);
  });
});

describe('ogeLocalOcrIndexesAreContiguous', () => {
  it('accepts 1..N in any page order and rejects gaps, dupes and empties', () => {
    expect(ogeLocalOcrIndexesAreContiguous([1, 2, 3])).toBe(true);
    expect(ogeLocalOcrIndexesAreContiguous([3, 1, 2])).toBe(true);
    expect(ogeLocalOcrIndexesAreContiguous([])).toBe(false);
    expect(ogeLocalOcrIndexesAreContiguous([1, 3])).toBe(false);
    expect(ogeLocalOcrIndexesAreContiguous([2, 3])).toBe(false);
    expect(ogeLocalOcrIndexesAreContiguous([1, 1, 2])).toBe(false);
  });
});

describe('isOgeLocalOcrCandidate', () => {
  it('matches executive 278-T filings by type or doc id', () => {
    expect(isOgeLocalOcrCandidate({ chamber: 'executive', filingType: '278t' })).toBe(true);
    expect(isOgeLocalOcrCandidate({ chamber: 'executive', filingType: 'OGE Form 278-T' })).toBe(true);
    expect(
      isOgeLocalOcrCandidate({ chamber: 'executive', docId: 'E-2026-donald-j-trump-08-12-2026-278t' }),
    ).toBe(true);
    expect(isOgeLocalOcrCandidate({ chamber: 'house', filingType: 'P' })).toBe(false);
    expect(isOgeLocalOcrCandidate({ chamber: 'executive', filingType: '278e' })).toBe(false);
    expect(isOgeLocalOcrCandidate({ chamber: 'executive' })).toBe(false);
  });

  it('falls back to the doc id when the stored filing type is the generic P', () => {
    // The watcher stores every filing — executive 278-Ts included — with
    // filing_type 'P', which says nothing about the OGE form.
    expect(
      isOgeLocalOcrCandidate({
        chamber: 'executive',
        filingType: 'P',
        docId: 'E-2026-donald-j-trump-08-12-2026-278t',
      }),
    ).toBe(true);
    expect(
      isOgeLocalOcrCandidate({ chamber: 'executive', filingType: 'P', docId: 'E-2026-jane-doe-278e' }),
    ).toBe(false);
    expect(isOgeLocalOcrCandidate({ chamber: 'executive', filingType: 'P' })).toBe(false);
  });

  it('lets an explicit annual or termination marker win over the 278-T match', () => {
    // '278-term' contains '278-t' as a prefix; the exclusion must come first
    // (same precedence as executiveDisclosureForm in ogeText.ts).
    expect(isOgeLocalOcrCandidate({ chamber: 'executive', filingType: '278-term' })).toBe(false);
    expect(isOgeLocalOcrCandidate({ chamber: 'executive', filingType: '278e' })).toBe(false);
  });
});

describe('ogeLocalOcrSettings', () => {
  it('defaults on with the Trump-scan crop hint', () => {
    const settings = ogeLocalOcrSettings({} as Env);
    expect(settings.enabled).toBe(true);
    expect(settings.maxPages).toBe(40);
    expect(settings.maxSeconds).toBe(420);
    expect(settings.crop).toEqual({ x0: 380, y0: 380, x1: 3060, y1: 2480 });
  });

  it('reads the Infisical-backed knobs', () => {
    const settings = ogeLocalOcrSettings(
      {
        CT_OGE_LOCAL_OCR: 'off',
        CT_OGE_LOCAL_OCR_MAX_PAGES: '10',
        CT_OGE_LOCAL_OCR_MAX_SECONDS: '60',
        CT_OGE_LOCAL_OCR_CROP: 'full',
      } as unknown as Env,
    );
    expect(settings.enabled).toBe(false);
    expect(settings.maxPages).toBe(10);
    expect(settings.maxSeconds).toBe(60);
    expect(settings.crop).toBeNull();
  });

  it('parses the crop knob and falls back on garbage', () => {
    expect(parseOgeLocalOcrCrop('0,0,100,200')).toEqual({ x0: 0, y0: 0, x1: 100, y1: 200 });
    expect(parseOgeLocalOcrCrop('full')).toBeNull();
    expect(parseOgeLocalOcrCrop(undefined)).toEqual(DEFAULT_OGE_LOCAL_OCR_CROP);
    expect(parseOgeLocalOcrCrop('nope')).toEqual(DEFAULT_OGE_LOCAL_OCR_CROP);
    expect(parseOgeLocalOcrCrop('10,10,5,5')).toEqual(DEFAULT_OGE_LOCAL_OCR_CROP);
  });
});

describe('ogeLocalOcrReviewPayload', () => {
  it('lists the unreconciled rows on a park', async () => {
    const backend = fakeBackend({ 400: [page(CLEAN_BODY)], 600: [page(DATE_DRIFT_BODY)] });
    const outcome = await attemptOgeLocalOcr(request(), { backend, settings: testSettings() });
    if (outcome.status !== 'unreadable') throw new Error('expected park');

    const payload = ogeLocalOcrReviewPayload(outcome) as {
      extractor: string;
      transactionCount: number;
      localOcr: { attempted: boolean; reason: string; unreconciled: Array<{ index: number | null; reason: string }> };
    };
    expect(payload.extractor).toBe('ogeLocalOcr');
    expect(payload.transactionCount).toBe(0);
    expect(payload.localOcr.attempted).toBe(true);
    expect(payload.localOcr.reason).toContain('row_index_gap');
    expect(payload.localOcr.unreconciled.map((r) => [r.index, r.reason])).toContainEqual([
      2,
      OGE_LOCAL_OCR_REASONS.dateDisagreement,
    ]);
  });
});

describe('ogeLocalOcrAlreadyAttempted', () => {
  function envWithPayload(payload: string | null): Env {
    const db = {
      prepare: () => ({
        bind: () => ({ first: async () => (payload === null ? null : { payload }) }),
      }),
    };
    return { DB: db } as unknown as Env;
  }

  it('is true only when the review payload records a local OCR attempt', async () => {
    expect(await ogeLocalOcrAlreadyAttempted(envWithPayload(null), 'E-1')).toBe(false);
    expect(await ogeLocalOcrAlreadyAttempted(envWithPayload('{}'), 'E-1')).toBe(false);
    expect(
      await ogeLocalOcrAlreadyAttempted(
        envWithPayload(JSON.stringify({ localOcr: { attempted: true } })),
        'E-1',
      ),
    ).toBe(true);
    // Recovered rows that landed in review as staged candidates carry the
    // extractor id instead of a localOcr section; that counts too.
    expect(
      await ogeLocalOcrAlreadyAttempted(
        envWithPayload(JSON.stringify({ extractor: 'ogeLocalOcr', transactionCount: 3 })),
        'E-1',
      ),
    ).toBe(true);
    expect(
      await ogeLocalOcrAlreadyAttempted(
        envWithPayload(JSON.stringify({ extractor: 'ogeText', transactionCount: 3 })),
        'E-1',
      ),
    ).toBe(false);
  });

  it('does not treat a skipped pass as an attempt', async () => {
    // A skipped park records localOcr with attempted:false; the agreement lane
    // must still be free to run a real retry on the same filing.
    expect(
      await ogeLocalOcrAlreadyAttempted(
        envWithPayload(JSON.stringify({ localOcr: { attempted: false, reason: 'no_pdf_bytes' } })),
        'E-1',
      ),
    ).toBe(false);
  });
});

// Optional real-binary coverage: renders one synthetic 278-T page with the
// installed poppler and reads it with the installed tesseract, proving the
// toolchain the production image ships actually recovers rows.  Skipped
// wherever the binaries are absent (including CI).
const REAL_BINARIES = (() => {
  try {
    execSync('command -v pdftoppm >/dev/null && command -v tesseract >/dev/null', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(REAL_BINARIES)('local OCR toolchain (real binaries)', () => {
  it('recovers rows from a rendered page at two DPIs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oge-ocr-'));
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const lines = CLEAN_BODY.split('\n');
    lines.forEach((line, i) => {
      page.drawText(line, { x: 40, y: 740 - i * 16, size: 10, font });
    });
    const path = join(dir, 'scan.pdf');
    writeFileSync(path, await pdf.save());

    const texts: string[] = [];
    for (const dpi of [400, 600]) {
      execSync(`pdftoppm -png -r ${dpi} -f 1 -l 1 ${path} ${dir}/p${dpi}`, { stdio: 'pipe' });
      const out = execSync(`tesseract ${dir}/p${dpi}-1.png stdout --psm 4`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as string;
      texts.push(out);
    }

    const [primary, secondary] = texts.map((text, i) => parseOgeLocalOcrPage(i + 1, text));
    expect(primary.map((r) => r.index)).toEqual([1, 2, 3]);
    const rec = reconcileOgeLocalOcrReads(primary, secondary);
    expect(rec.unreconciled).toHaveLength(0);
    expect(gateOgeLocalOcrRows(rec.rows).ok).toBe(true);
  }, 120_000);

  it('OCRs a list file of rendered pages in one invocation (production argv shape)', async () => {
    // readPages passes a pages.txt list file as tesseract's input image and
    // splits the joined output on form feeds.  This pins that contract against
    // the installed binary: the run must exit 0 with one \f-separated part
    // per listed page.  (The tesseract FAQ documents the same list mode.)
    const dir = mkdtempSync(join(tmpdir(), 'oge-ocr-list-'));
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const line of CLEAN_BODY.split('\n')) {
      const page = pdf.addPage([612, 792]);
      page.drawText(line, { x: 40, y: 740, size: 12, font });
    }
    const path = join(dir, 'scan.pdf');
    writeFileSync(path, await pdf.save());

    execSync(`pdftoppm -png -r 400 -f 1 -l 3 ${path} ${dir}/page`, { stdio: 'pipe' });
    const listPath = join(dir, 'pages.txt');
    writeFileSync(listPath, [1, 2, 3].map((n) => join(dir, `page-${n}.png`)).join('\n') + '\n');
    execSync(`tesseract ${listPath} ${dir}/ocr --psm 4`, { stdio: 'pipe' });
    const { readFileSync } = await import('node:fs');
    const parts = readFileSync(join(dir, 'ocr.txt'), 'utf8').split('\f');

    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain('Amazon');
    expect(parts[1]).toContain('SPDR');
    expect(parts[2]).toContain('QQQ');
  }, 120_000);
});
