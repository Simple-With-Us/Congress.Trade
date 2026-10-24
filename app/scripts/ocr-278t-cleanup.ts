/**
 * scripts/ocr-278t-cleanup.ts
 *
 * CT-2441 dry run + apply for the OCR-garbled asset names on executive 278-T
 * filings (first: E-2026-donald-j-trump-09-17-2026-278t, 517 hand-confirmed
 * rows).  Every row runs through the SAME shared normalizer the write
 * boundaries now enforce (src/extraction/ocrSanity.ts), so the dry run shows
 * what the guards would do for the displayed names.
 *
 * Modes:
 *   dry run (default, no auth) — fetch the PUBLIC filing API for --doc,
 *     print counts plus before->after samples and held rows.  Writes nothing.
 *     The public API serves display-transformed names, so a preview row can
 *     classify differently from the stored row --apply reads; the report
 *     states this source every run, and --apply re-reads stored values.
 *   --apply (admin token) — loop the sanctioned
 *     POST /api/admin/clean-asset-names endpoint until done.  That endpoint
 *     reads live stored values (the public API serves display-transformed
 *     names, so a dry run alone cannot write safely), applies confident fixes
 *     with a cleaning_note audit fragment, and leaves held rows untouched.
 *     Requires --doc, or --all-rows for a full-table sweep.
 *
 * Usage (from app/):
 *   deno run --allow-net --allow-env --allow-read \
 *     scripts/ocr-278t-cleanup.ts [--doc <id>] [--samples <n>] [--json <path>]
 *   CT_ADMIN_TOKEN_FILE=<0600 file holding the token> \
 *     deno run --allow-net --allow-env --allow-read \
 *     scripts/ocr-278t-cleanup.ts --doc <id> --apply
 *
 * Options:
 *   --doc <id>     Filing to cover (repeatable; default the Sep 17 Trump 278-T).
 *   --base <url>   API origin (default https://congress.trade).  --apply
 *                  refuses non-HTTPS origins except loopback dev targets.
 *   --samples <n>  Rows to print per section (default all; pass <n> to cap).
 *   --json <path>  Also write the full machine-readable report here (needs
 *                  --allow-write=<path>).
 *   --apply        Write via POST /api/admin/clean-asset-names (admin token).
 *   --all-rows     --apply without --doc: sweep the whole table.  Refused
 *                  without this flag so a missing --doc cannot widen scope.
 *   --page <n>     Rows per apply request (default 500).
 *
 * Auth for --apply: CT_ADMIN_TOKEN, or CT_ADMIN_TOKEN_FILE pointing at a file
 * containing it.  The token is never printed.  Never run --apply against prod
 * except via the Deployer-owned step after merge.
 */

import { normalizeOcrAssetName } from '../src/extraction/ocrSanity.ts';
import { adminToken, arg, assertSafeBase, BROWSER_UA, flag } from './dry-run-asset-name-cleanup.ts';

const DEFAULT_DOC = 'E-2026-donald-j-trump-09-17-2026-278t';

interface FilingTx {
  id: string;
  assetName: string;
  ticker: string | null;
  txDate: string | null;
  source: string;
}

interface RowResult {
  id: string;
  before: string;
  after: string;
  notes: string[];
  holds: string[];
}

function docArgs(): string[] {
  const docs: string[] = [];
  for (let i = 0; i < Deno.args.length; i += 1) {
    if (Deno.args[i] === '--doc' && Deno.args[i + 1]) docs.push(Deno.args[i + 1]);
  }
  return docs.length > 0 ? docs : [DEFAULT_DOC];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function fetchDocTransactions(base: string, docId: string): Promise<FilingTx[]> {
  const res = await fetch(`${base}/api/filings/${encodeURIComponent(docId)}`, {
    headers: { 'User-Agent': BROWSER_UA },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET /api/filings/${docId}: HTTP ${res.status}: ${text.slice(0, 160)}`);
  // Runtime-shape the response instead of asserting it: a drifted API must
  // degrade to skipped rows, never crash the normalizer on a non-string.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`GET /api/filings/${docId}: response is not JSON`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.transactions)) {
    throw new Error(`GET /api/filings/${docId}: response has no transactions array`);
  }
  const rows: FilingTx[] = [];
  let skipped = 0;
  for (const entry of parsed.transactions) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.assetName !== 'string') {
      skipped += 1;
      continue;
    }
    rows.push({
      id: entry.id,
      assetName: entry.assetName,
      ticker: typeof entry.ticker === 'string' ? entry.ticker : null,
      txDate: typeof entry.txDate === 'string' ? entry.txDate : null,
      source: typeof entry.source === 'string' ? entry.source : '',
    });
  }
  if (skipped > 0) console.error(`warning: skipped ${skipped} malformed rows in ${docId}`);
  return rows;
}

function assess(rows: FilingTx[]): { changed: RowResult[]; held: RowResult[]; clean: number } {
  const changed: RowResult[] = [];
  const held: RowResult[] = [];
  let clean = 0;
  for (const row of rows) {
    const before = row.assetName ?? '';
    const ocr = normalizeOcrAssetName(before);
    const holds = [...ocr.dateHolds, ...ocr.nameHolds];
    if (holds.length > 0) {
      held.push({ id: row.id, before, after: ocr.name, notes: ocr.notes, holds });
    } else if (ocr.changed) {
      changed.push({ id: row.id, before, after: ocr.name, notes: ocr.notes, holds });
    } else {
      clean += 1;
    }
  }
  return { changed, held, clean };
}

async function dryRun(base: string, docs: string[], samples: number, jsonPath: string | undefined): Promise<void> {
  let scanned = 0;
  let clean = 0;
  const changed: RowResult[] = [];
  const held: RowResult[] = [];
  for (const docId of docs) {
    const rows = await fetchDocTransactions(base, docId);
    console.log(`doc ${docId}: ${rows.length} rows`);
    const result = assess(rows);
    scanned += rows.length;
    clean += result.clean;
    changed.push(...result.changed);
    held.push(...result.held);
  }
  console.log(`\nscanned:  ${scanned} rows (${docs.length} filing${docs.length === 1 ? '' : 's'})`);
  console.log('mode:     READ-ONLY — this script writes nothing');
  console.log('source:   public display API (display-transformed names; --apply re-reads stored values)\n');
  console.log('=== WOULD CHANGE ===');
  console.log(`rows changed:       ${changed.length}`);
  console.log(`rows held:          ${held.length}`);
  console.log(`rows clean:         ${clean}`);
  console.log(`\n=== CHANGED — before -> after (${Math.min(samples, changed.length)} of ${changed.length}) ===`);
  for (const row of changed.slice(0, samples)) {
    console.log(`  before: ${row.before}`);
    console.log(`  after:  ${row.after}`);
    console.log(`  notes:  ${row.notes.join('; ') || '(none)'}`);
    console.log('');
  }
  if (held.length > 0) {
    console.log(`\n=== HELD FOR REVIEW (${held.length} rows) ===`);
    for (const row of held.slice(0, samples)) {
      console.log(`  before: ${row.before}`);
      console.log(`  after:  ${row.after}`);
      console.log(`  why:    ${row.holds.join(' | ')}`);
      console.log('');
    }
  }
  if (jsonPath) {
    await Deno.writeTextFile(
      jsonPath,
      JSON.stringify(
        { generatedAt: new Date().toISOString(), mode: 'dry-run-read-only', scanned, clean, changed, held },
        null,
        2,
      ),
    );
    console.log(`full report written to ${jsonPath}`);
  }
  console.log('\nNothing was written. Feed rows through POST /api/admin/clean-asset-names to apply.');
}

interface ApplyPage {
  ok?: boolean;
  cleaned?: number;
  ocrCleaned?: number;
  processed?: number;
  nextOffset?: number;
  done?: boolean;
  held?: number;
  heldSample?: Array<{ id: string; before: string; reasons: string[] }>;
  error?: string;
}

function parseApplyPage(text: string): ApplyPage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('apply response is not JSON');
  }
  if (!isRecord(parsed)) throw new Error('apply response is not an object');
  const numberOrUndefined = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  return {
    ok: parsed.ok === true,
    cleaned: numberOrUndefined(parsed.cleaned),
    ocrCleaned: numberOrUndefined(parsed.ocrCleaned),
    processed: numberOrUndefined(parsed.processed),
    nextOffset: numberOrUndefined(parsed.nextOffset),
    done: parsed.done === true,
    held: numberOrUndefined(parsed.held),
    error: typeof parsed.error === 'string' ? parsed.error : undefined,
  };
}

async function applyPage(
  base: string,
  token: string,
  opts: { docId: string | null; limit: number; offset: number },
): Promise<ApplyPage> {
  const params = new URLSearchParams({
    limit: String(opts.limit),
    offset: String(opts.offset),
  });
  if (opts.docId) params.set('docId', opts.docId);
  let lastError = '';
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const res = await fetch(`${base}/api/admin/clean-asset-names?${params}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': BROWSER_UA },
    });
    const text = await res.text();
    if (res.ok) return parseApplyPage(text);
    lastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
  throw new Error(lastError);
}

async function apply(base: string, docs: string[], allRows: boolean, pageSize: number): Promise<void> {
  // Shared origin guard (same one the dry-run script's debug-sql path uses).
  assertSafeBase(base);
  const token = await adminToken();
  const targets = allRows ? [null] : docs;
  if (!allRows && docs.length === 0) throw new Error('--apply needs --doc <id> or --all-rows');
  let totalCleaned = 0;
  let totalOcr = 0;
  let totalHeld = 0;
  for (const docId of targets) {
    console.log(docId ? `applying doc ${docId}` : 'applying full-table sweep');
    let offset = 0;
    for (;;) {
      const page = await applyPage(base, token, { docId, limit: pageSize, offset });
      if (page.ok !== true) throw new Error(`apply failed: ${page.error ?? 'unknown error'}`);
      totalCleaned += page.cleaned ?? 0;
      totalOcr += page.ocrCleaned ?? 0;
      totalHeld += page.held ?? 0;
      console.log(
        `  offset ${offset}: cleaned ${page.cleaned ?? 0} (ocr ${page.ocrCleaned ?? 0}), ` +
          `held ${page.held ?? 0}, done=${page.done === true}`,
      );
      if (page.done === true) break;
      offset = page.nextOffset ?? offset + pageSize;
      if ((page.processed ?? 0) === 0) break;
    }
  }
  console.log(`\napplied: cleaned ${totalCleaned} rows (${totalOcr} OCR fixes), held ${totalHeld} rows.`);
}

async function main(): Promise<void> {
  const base = (arg('base', 'https://congress.trade') as string).replace(/\/+$/, '');
  const samplesArg = arg('samples');
  // Non-numeric input must fall back to the defaults: Math.max/min propagate
  // NaN, which would print a "(NaN of N)" header with zero rows and send
  // limit=NaN to the server (same Number.isFinite pattern as the
  // /clean-asset-names paging params).
  const parsedSamples = samplesArg === undefined ? Number.NaN : Number(samplesArg);
  const samples = samplesArg === undefined || !Number.isFinite(parsedSamples)
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Math.floor(parsedSamples));
  const parsedPage = Number(arg('page', '500'));
  const pageSize = Number.isFinite(parsedPage)
    ? Math.max(100, Math.min(2000, Math.floor(parsedPage)))
    : 500;
  const jsonPath = arg('json');
  if (flag('apply')) {
    // Unlike the dry run, --apply never falls back to the default doc: the
    // scope must be explicit on every write invocation.
    const explicitDocs: string[] = [];
    for (let i = 0; i < Deno.args.length; i += 1) {
      if (Deno.args[i] === '--doc' && Deno.args[i + 1]) explicitDocs.push(Deno.args[i + 1]);
    }
    const allRows = flag('all-rows');
    if (!allRows && explicitDocs.length === 0) {
      throw new Error('--apply needs an explicit --doc <id> or --all-rows');
    }
    await apply(base, allRows ? [] : explicitDocs, allRows, pageSize);
    return;
  }
  await dryRun(base, docArgs(), samples, jsonPath);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`ocr cleanup failed: ${(error as Error).message}`);
    Deno.exit(1);
  });
}
