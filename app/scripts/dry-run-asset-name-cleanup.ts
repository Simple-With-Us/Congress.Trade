/**
 * scripts/dry-run-asset-name-cleanup.ts
 *
 * READ-ONLY dry run for the asset-name cleanup in
 * src/extraction/nameNormalizer.ts (`splitAssetNameDetail`). Reports what a
 * backfill WOULD change — rows affected, before/after/note samples, and a
 * count of everything a human should eyeball — and writes NOTHING.
 *
 * HARD BOUNDARY: this script issues SELECTs only. `assertReadOnly` refuses any
 * other statement before it leaves the process, and there is deliberately no
 * write path here at all. The owner reviews the report before any backfill is
 * written, and the backfill is a separate, explicitly-requested step.
 *
 * Usage (from app/) — note the DELIBERATE absence of --allow-write, which makes
 * the process incapable of touching the filesystem at all:
 *   CT_ADMIN_TOKEN_FILE=<0600 file holding the token, from Infisical CT_ADMIN_TOKEN> \
 *     deno run --allow-net --allow-env --allow-read \
 *     scripts/dry-run-asset-name-cleanup.ts [options]
 *
 * Options:
 *   --base <url>        API origin (default https://congress.trade).  Non-HTTPS
 *                       origins are refused except loopback dev targets, so
 *                       the token never goes to a plaintext or typo'd host.
 *   --candidates-only   Only fetch rows whose text can possibly match, instead
 *                       of every live row. Faster, but cannot prove the
 *                       no-op set — use the default full scan for sign-off.
 *   --page <n>          Rows per request (default 1000).
 *   --samples <n>       Sample triples to print per change kind (default 8).
 *   --json <path>       Also write the full machine-readable report here. This
 *                       is the ONLY option that needs a write grant; add
 *                       --allow-write=<path> (scoped to that one file) if you
 *                       want it. Leave both off for a provably read-only run.
 *
 * Auth: CT_ADMIN_TOKEN, or CT_ADMIN_TOKEN_FILE pointing at a file containing
 * it. The token is never printed.
 */

import { cleanAssetString, splitAssetNameDetail } from '../src/extraction/nameNormalizer.ts';

interface Row {
  id: string;
  asset_name: string | null;
  ticker: string | null;
  cleaning_note: string | null;
}

interface Change {
  id: string;
  ticker: string | null;
  before: string;
  after: string;
  note: string | null;
  existingNote: string | null;
  kind: ChangeKind;
  ambiguous: string[];
}

/**
 * `cleaner-only` is the important one: the stored name would move even without
 * this change, purely because the pre-existing cleanAssetString normalizations
 * were never replayed over historical rows. Those are NOT what this dry run is
 * proposing, and they are exactly where the 790-false-positive regression lived
 * last time — so they are counted apart from the split's own work.
 */
type ChangeKind = 'bracket' | 'maturity' | 'exchange' | 'mixed' | 'cleaner-only';

// ---------------------------------------------------------------------------
// Read-only guard
// ---------------------------------------------------------------------------

/**
 * Refuse anything that is not a single SELECT. Cheap, but it is the difference
 * between "a reporting script" and "a script that could be edited into a
 * production write by accident".
 */
export function assertReadOnly(sql: string): string {
  const normalized = sql.trim().replace(/\s+/g, ' ');
  if (!/^SELECT\b/i.test(normalized)) {
    throw new Error(`dry run is read-only; refusing non-SELECT statement: ${normalized.slice(0, 60)}…`);
  }
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|PRAGMA|VACUUM)\b/i.test(normalized)) {
    throw new Error('dry run is read-only; refusing statement containing a write keyword');
  }
  if (normalized.includes(';')) {
    throw new Error('dry run is read-only; refusing multi-statement SQL');
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function arg(name: string, fallback?: string): string | undefined {
  const index = Deno.args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return Deno.args[index + 1] ?? fallback;
}

export function flag(name: string): boolean {
  return Deno.args.includes(`--${name}`);
}

/** Browser User-Agent: the edge serves a managed challenge to unrecognised agents. */
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * The admin token must never travel to a plaintext or unexpected origin: a
 * typo'd --base would otherwise receive the bearer token.  HTTPS everywhere,
 * with plain HTTP allowed only for loopback dev targets.  Call it before the
 * token is read, so a refused base never even loads the credential.
 */
export function assertSafeBase(base: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`refusing admin requests against malformed base '${base}'`);
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error(`refusing admin requests against non-HTTPS base '${base}' (https or localhost only)`);
  }
  return base;
}

export async function adminToken(): Promise<string> {
  const inline = Deno.env.get('CT_ADMIN_TOKEN')?.trim();
  if (inline) return inline;
  const path = Deno.env.get('CT_ADMIN_TOKEN_FILE')?.trim();
  if (path) {
    const expanded = path.startsWith('~/') ? `${Deno.env.get('HOME')}${path.slice(1)}` : path;
    const contents = (await Deno.readTextFile(expanded)).trim();
    // Accept either a bare token or a KEY=value line, so the same secrets file
    // the fleet already uses works without reformatting.
    const match = /^(?:export\s+)?CT_ADMIN_TOKEN=(.*)$/m.exec(contents);
    const value = (match ? match[1] : contents).trim().replace(/^["']|["']$/g, '');
    if (value) return value;
  }
  throw new Error('set CT_ADMIN_TOKEN or CT_ADMIN_TOKEN_FILE (never pass the token on the command line)');
}

async function query<T>(base: string, token: string, sql: string): Promise<T[]> {
  const body = JSON.stringify({ query: assertReadOnly(sql) });
  let lastError = '';
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const res = await fetch(`${base}/api/admin/debug-sql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': BROWSER_UA,
      },
      body,
    });
    const text = await res.text();
    if (res.ok) {
      const parsed = JSON.parse(text) as { ok?: boolean; results?: T[]; error?: string };
      if (parsed.ok === false) throw new Error(`query failed: ${parsed.error}`);
      return parsed.results ?? [];
    }
    lastError = `HTTP ${res.status}: ${text.slice(0, 160)}`;
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
  throw new Error(lastError);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const BRACKET_TAIL = /\[[^\]]*\]\s*$/;
const INLINE_RATE_DATE = /\d{1,2}(?:\.\d{1,3})?\s*%\s*\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}\/\d{1,2}\/\d{2,4}\s*\d{1,2}(?:\.\d{1,3})?\s*%/;
const STRAY_PUNCTUATION = /['"`],|,\s*$|['"`]\s*$/;

function classify(before: string, after: string, note: string | null, cleanerOnly: boolean): ChangeKind {
  if (cleanerOnly) return 'cleaner-only';
  const kinds: ChangeKind[] = [];
  if (BRACKET_TAIL.test(before) && !BRACKET_TAIL.test(after)) kinds.push('bracket');
  if (note && /coupon |matures /.test(note)) kinds.push('maturity');
  if (note && /exchange/.test(note)) kinds.push('exchange');
  if (kinds.length === 0) return 'bracket';
  return kinds.length > 1 ? 'mixed' : kinds[0];
}

/**
 * Everything a human should look at before a backfill runs. These are NOT
 * failures — they are rows where the mechanical answer is defensible but not
 * obviously right, so they get counted and sampled separately.
 */
function ambiguityReasons(row: Row, before: string, after: string, note: string | null): string[] {
  const reasons: string[] = [];
  if (row.cleaning_note) reasons.push('row already carries a cleaning_note (backfill must merge, not overwrite)');
  // The normalizer writes '(unknown)' when a filing discloses no name at all,
  // and cleanAssetString's trailing-"(XYZ)" exchange-suffix rule eats it whole.
  // Harmless live (the placeholder is applied after cleaning), but a backfill
  // replaying the cleaner over stored rows would blank the column.
  if (/^\(unknown\)$/i.test(before.trim())) {
    reasons.push("would blank the '(unknown)' placeholder — EXCLUDE from any backfill");
  }
  if (INLINE_RATE_DATE.test(after)) reasons.push('inline rate/date residue left in the name (known limit)');
  if (BRACKET_TAIL.test(after)) reasons.push('a bracketed tail survives');
  if (note === 'disclosed as an exchange') reasons.push('exchange with no counterparty text captured');
  if (STRAY_PUNCTUATION.test(after)) reasons.push('stray quote/comma artifact left at the end');
  if (after === '') reasons.push('cleaning empties the name entirely');
  else if (after.length < 3) reasons.push('resulting name is shorter than 3 characters');
  if (before.length > 0 && after.length / before.length < 0.4) {
    reasons.push('name lost more than 60% of its characters');
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const CANDIDATE_PREDICATE =
  "(asset_name LIKE '%[%]%' OR asset_name LIKE '%Rate/Coupon%' OR asset_name LIKE '%Matures%' " +
  "OR asset_name LIKE '%(Exchanged)%' OR asset_name LIKE '% due %')";

async function main(): Promise<void> {
  const base = (arg('base', 'https://congress.trade') as string).replace(/\/+$/, '');
  const pageSize = Math.max(100, Math.min(5000, Number(arg('page', '1000'))));
  const sampleCount = Math.max(1, Number(arg('samples', '8')));
  const candidatesOnly = flag('candidates-only');
  const jsonPath = arg('json');
  assertSafeBase(base);
  const token = await adminToken();

  const where =
    "deprecated_at IS NULL AND asset_name IS NOT NULL AND asset_name <> ''" +
    (candidatesOnly ? ` AND ${CANDIDATE_PREDICATE}` : '');

  const totals = await query<{ n: number }>(base, token, `SELECT COUNT(*) AS n FROM transactions WHERE ${where}`);
  const rowCount = Number(totals[0]?.n ?? 0);
  console.log(`scope: ${rowCount} live rows${candidatesOnly ? ' (candidate-filtered)' : ' (full scan)'}`);
  console.log('mode:  READ-ONLY — this script writes nothing\n');

  const changes: Change[] = [];
  const distinctBefore = new Set<string>();
  let scanned = 0;

  for (let offset = 0; offset < rowCount; offset += pageSize) {
    const rows = await query<Row>(
      base,
      token,
      `SELECT id, asset_name, ticker, cleaning_note FROM transactions WHERE ${where} ` +
        `ORDER BY id LIMIT ${pageSize} OFFSET ${offset}`,
    );
    if (rows.length === 0) break;
    scanned += rows.length;
    for (const row of rows) {
      const before = row.asset_name ?? '';
      const result = splitAssetNameDetail(before, row.ticker);
      if (result.name === before && result.note === null) continue;
      // Attribute the delta: anything cleanAssetString alone would already have
      // done is a replay of existing behaviour, not this change's doing.
      const cleanerOnly = result.note === null && result.name === cleanAssetString(before, row.ticker);
      distinctBefore.add(before);
      changes.push({
        id: row.id,
        ticker: row.ticker,
        before,
        after: result.name,
        note: result.note,
        existingNote: row.cleaning_note,
        kind: classify(before, result.name, result.note, cleanerOnly),
        ambiguous: ambiguityReasons(row, before, result.name, result.note),
      });
    }
    if (offset % (pageSize * 10) === 0) {
      console.error(`  … scanned ${scanned}/${rowCount}`);
    }
  }

  const byKind = new Map<ChangeKind, Change[]>();
  for (const change of changes) {
    const bucket = byKind.get(change.kind) ?? [];
    bucket.push(change);
    byKind.set(change.kind, bucket);
  }
  const ambiguous = changes.filter((c) => c.ambiguous.length > 0);
  const notesAdded = changes.filter((c) => c.note !== null);
  const wouldOverwrite = changes.filter((c) => c.note !== null && c.existingNote);

  const cleanerOnly = byKind.get('cleaner-only') ?? [];
  const splitOwned = changes.length - cleanerOnly.length;

  console.log('=== WOULD CHANGE ===');
  console.log(`rows affected:        ${changes.length} of ${scanned} scanned (${pct(changes.length, scanned)})`);
  console.log(`  from this change:   ${splitOwned}`);
  console.log(`  cleanAssetString replay (pre-existing rules, not this change): ${cleanerOnly.length}`);
  console.log(`distinct names:       ${distinctBefore.size}`);
  console.log(`rows gaining a note:  ${notesAdded.length}`);
  console.log(`notes to merge:       ${wouldOverwrite.length} (row already has a cleaning_note)`);
  console.log(`AMBIGUOUS — review:   ${ambiguous.length}`);
  console.log('');
  for (const [kind, bucket] of [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${kind.padEnd(10)} ${bucket.length}`);
  }

  for (const [kind, bucket] of [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n=== SAMPLES — ${kind} (${bucket.length} rows) ===`);
    for (const change of bucket.slice(0, sampleCount)) {
      console.log(`  before: ${change.before}`);
      console.log(`  after:  ${change.after}`);
      console.log(`  note:   ${change.note ?? '(none)'}`);
      console.log('');
    }
  }

  if (ambiguous.length > 0) {
    console.log(`\n=== AMBIGUOUS — needs a human (${ambiguous.length} rows) ===`);
    const reasonCounts = new Map<string, number>();
    for (const change of ambiguous) {
      for (const reason of change.ambiguous) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
    for (const [reason, count] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(5)}  ${reason}`);
    }
    console.log('');
    for (const change of ambiguous.slice(0, sampleCount)) {
      console.log(`  before: ${change.before}`);
      console.log(`  after:  ${change.after}`);
      console.log(`  note:   ${change.note ?? '(none)'}`);
      console.log(`  why:    ${change.ambiguous.join(' | ')}`);
      console.log('');
    }
  }

  if (jsonPath) {
    await Deno.writeTextFile(
      jsonPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          mode: 'dry-run-read-only',
          scanned,
          affected: changes.length,
          distinctNames: distinctBefore.size,
          ambiguous: ambiguous.length,
          changes,
        },
        null,
        2,
      ),
    );
    console.log(`full report written to ${jsonPath}`);
  }

  console.log('\nNothing was written. Review the samples above before any backfill.');
}

function pct(part: number, whole: number): string {
  if (!whole) return '0%';
  return `${((100 * part) / whole).toFixed(2)}%`;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`dry run failed: ${(error as Error).message}`);
    Deno.exit(1);
  });
}
