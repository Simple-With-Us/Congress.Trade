/**
 * src/ingestion/ogeSource.ts
 * OWNER: ingestion
 *
 * Executive-branch disclosure source: polls the OGE "President and Vice
 * President Index" Domino view for new Periodic Transaction Reports (OGE Form
 * 278-T) and maps them onto the same DiscoveredFiling shape the House/Senate
 * watchers produce, so the existing fetch -> classify -> extract -> review
 * pipeline ingests them unchanged. The filings are scanned PDFs (poor embedded
 * OCR), so they classify as `scanned_pdf` and flow through the vision
 * extractor + review queue exactly like scanned House PTRs.
 *
 * Design notes:
 *  - The index view lists direct `$FILE/<name>.pdf` links; new filings are
 *    detected by diffing doc ids (INSERT OR IGNORE in the shared watcher path).
 *  - Only known executive filers are ingested (currently the President).
 *    Additional filers (VP, cabinet) are one FILERS entry away.
 *  - Cadence is the same adaptive probeSchedule / decideSourcePoll path as
 *    House and Senate.  There is no measured OGE arrival-hour sample in-repo,
 *    so the executive profile is a flat weekday window at a 15-minute
 *    coverage floor (never 6 hours) and a 60s politeness floor.  Weekend is
 *    hourly like House.  Do not invent peak weights.  The watcher is
 *    fail-soft: an OGE outage must never affect House/Senate polling.
 *    Filings can still land weeks after the trades (STOCK Act 45-day clock,
 *    often exceeded with late fees) — that is filing latency, not a reason
 *    to poll slowly.
 *  - Fetch: server-first.  Direct extapps2.oge.gov, then Mac/scout
 *    POST /fetch-oge if OGE_RELAY_URL or INGEST_RELAY_URL is set and
 *    direct fails.  The server can reach OGE.  Senate is the exception
 *    that stays relay-first (Imperva 403s the box).
 *  - EIGA §105(c) restricts certain uses of these reports; congress.trade
 *    disseminates them to the general public in the site's existing
 *    educational framing, mirroring its House/Senate STOCK Act posture.
 */

import type { Env } from '../shared/types.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import type { DiscoveredFiling } from './watcher.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import { CURATED_EXECUTIVES } from '../shared/executiveIdentity.ts';

/** President/VP index (small) — always polled. */
export const OGE_PRESIDENT_INDEX_URL =
  'https://extapps2.oge.gov/201/Presiden.nsf/President%20and%20Vice%20President%20Index?OpenView&ExpandView&Count=500';

/**
 * Broader PAS (Presidentially Appointed, Senate-confirmed) 278-T collection —
 * cabinet secretaries and other PAS officials (Bessent, McMahon, Lutnick, …).
 * Without this index only President/VP PDFs land; competitor injects filled the
 * gap with orphan Unknown rows and no hosted filings.
 */
export const OGE_PAS_INDEX_URL =
  'https://extapps2.oge.gov/201/Presiden.nsf/PAS+Index?OpenView&ExpandView&Count=2000';

/** Default multi-index poll list (comma-separated for Infisical overrides). */
export const OGE_DEFAULT_INDEX_URL = `${OGE_PRESIDENT_INDEX_URL},${OGE_PAS_INDEX_URL}`;

const OGE_ORIGIN = 'https://extapps2.oge.gov';

/** Known executive filers we pin to stable EXEC-* ids (filename match).
 *  party/photoUrl are curated (the OGE index carries neither). */
interface ExecutiveFiler {
  pattern: RegExp;
  filerId: string;
  fullName: string;
  party: 'R' | 'D' | null;
  photoUrl: string | null;
}
const COMMONS_THUMB = 'https://upload.wikimedia.org/wikipedia/commons/thumb';
const EXECUTIVE_FILERS: ExecutiveFiler[] = [
  ...CURATED_EXECUTIVES.map((e) => ({
    pattern: e.filenamePattern,
    filerId: e.filerId,
    fullName: e.fullName,
    party: e.party,
    photoUrl: e.photoUrl,
  })),
  // Historical presidents/VPs not in the PAS-focused curated list.
  {
    pattern: /pence/i,
    filerId: 'EXEC-MRP',
    fullName: 'Michael R. Pence',
    party: 'R',
    photoUrl: `${COMMONS_THUMB}/b/b9/Mike_Pence_official_Vice_Presidential_portrait.jpg/500px-Mike_Pence_official_Vice_Presidential_portrait.jpg`,
  },
  {
    pattern: /obama/i,
    filerId: 'EXEC-BHO',
    fullName: 'Barack H. Obama',
    party: 'D',
    photoUrl: `${COMMONS_THUMB}/8/8d/President_Barack_Obama.jpg/500px-President_Barack_Obama.jpg`,
  },
];

/** True for Periodic Transaction Reports; annual 278/278e forms are skipped
 *  for now (holdings snapshots, not transactions). */
function is278T(filename: string): boolean {
  return /278[\s-]?T/i.test(filename) && !/annual/i.test(filename);
}

/**
 * Best-effort filing date from the PDF filename (e.g. "10.17.2025",
 * "05.08.2026", "1.14.2026", "4-20-2026"). The per-transaction dates come from
 * extraction; this only seeds `filings.filed_date` for ordering.
 */
export function ogeFiledDateFromName(filename: string): string | null {
  // Both 4-digit ("10.17.2025") and 2-digit ("9.3.25") years appear in real
  // OGE filenames; 2-digit years are 20xx (the corpus starts in 2017).
  const m = /(\d{1,2})[.\-](\d{1,2})[.\-](\d{4}|\d{2})(?!\d)/.exec(filename);
  if (!m) return null;
  const [, mo, d, y] = m;
  const year = y.length === 4 ? y : `20${y}`;
  return `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** Stable, URL-safe doc id: E-<year>-<filename-slug>. */
export function ogeDocId(filename: string): string {
  const filed = ogeFiledDateFromName(filename);
  const year = filed ? filed.slice(0, 4) : 'undated';
  const slug = filename
    .replace(/\.pdf$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `E-${year}-${slug}`;
}

/**
 * Dynamic fallback for Executive filers not listed in EXECUTIVE_FILERS.
 * Parses filer name from 278-T PDF filename and mints a stable synthetic ID.
 */
export function parseDynamicExecutiveFiler(filename: string): {
  filerId: string;
  fullName: string;
  party: null;
  photoUrl: null;
} | null {
  let clean = filename
    .replace(/\.pdf$/i, '')
    .replace(/278[\s-]?T/gi, '')
    .replace(/(\d{1,2})[.\-](\d{1,2})[.\-](\d{4}|\d{2})/g, '')
    .replace(/\(\d+\)/g, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (clean.includes(',')) {
    const parts = clean.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 2) {
      clean = `${parts[1]} ${parts[0]}`;
    }
  }

  if (!clean || clean.length < 2) return null;

  const slug = clean
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug) return null;

  return {
    filerId: `EXEC-${slug.toUpperCase()}`,
    fullName: clean,
    party: null,
    photoUrl: null,
  };
}

/**
 * Parse the OGE index view HTML into DiscoveredFilings for known and dynamic
 * executive filers' 278-T reports. Pure so it can be unit-tested against a fixture.
 */
export function parseOgeIndex(html: string): DiscoveredFiling[] {
  const out: DiscoveredFiling[] = [];
  const seen = new Set<string>();
  // Domino renders hrefs (SINGLE-quoted in the live view, so accept either
  // quote) like: /201/Presiden.nsf/<view>/<UNID>/$FILE/<name>.pdf — with raw
  // spaces in the filename. Amended reports appear as distinct files and are
  // ingested as distinct filings (review resolves any duplication).
  const re = /href=["'](\/201\/[^"']*\$FILE\/([^"']+?\.pdf))["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const path = m[1];
    let filename = m[2];
    try {
      if (filename.includes('%')) filename = decodeURIComponent(filename);
    } catch {
      /* keep the raw name — a stray % must not kill the whole poll */
    }
    filename = filename.trim();
    if (!is278T(filename)) continue;
    const knownFiler = EXECUTIVE_FILERS.find((f) => f.pattern.test(filename));
    const filer = knownFiler
      ? { filerId: knownFiler.filerId, fullName: knownFiler.fullName, party: knownFiler.party, photoUrl: knownFiler.photoUrl }
      : parseDynamicExecutiveFiler(filename);

    if (!filer) continue;
    const docId = ogeDocId(filename);
    if (seen.has(docId)) continue;
    seen.add(docId);
    out.push({
      docId,
      chamber: 'executive',
      // Encode ONLY the spaces: the path from Domino is otherwise URL-ready,
      // and double-encoding %28/%29 etc. breaks the download.
      sourceUrl: OGE_ORIGIN + path.replace(/ /g, '%20'),
      filedDate: ogeFiledDateFromName(filename),
      filerId: filer.filerId,
      filerName: filer.fullName,
      party: filer.party,
      photoUrl: filer.photoUrl,
    });
  }
  return out;
}

function truthy(v: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((v ?? '').trim());
}

export async function ogeWatchEnabled(env: Env): Promise<boolean> {
  try {
    const live = (await resolveSecret(env, 'OGE_WATCH_ENABLED')).value;
    return truthy(live ?? env.OGE_WATCH_ENABLED);
  } catch {
    return truthy(env.OGE_WATCH_ENABLED);
  }
}

async function indexUrls(env: Env): Promise<string[]> {
  try {
    const raw = (await resolveSecret(env, 'OGE_INDEX_URLS')).value ||
      (await resolveSecret(env, 'OGE_INDEX_URL')).value ||
      env.OGE_INDEX_URLS ||
      env.OGE_INDEX_URL ||
      OGE_DEFAULT_INDEX_URL;
    return raw.split(',').map((u) => u.trim()).filter(Boolean);
  } catch {
    const raw = env.OGE_INDEX_URLS || env.OGE_INDEX_URL || OGE_DEFAULT_INDEX_URL;
    return raw.split(',').map((u) => u.trim()).filter(Boolean);
  }
}

/** Fetch + parse the OGE index(es). Throws on HTTP failure (caller guards). */
export async function fetchOgeExecutiveFilings(
  env: Env,
  fetchImpl: typeof fetch = fetch,
  opts: { signal?: AbortSignal } = {},
): Promise<DiscoveredFiling[]> {
  const urls = await indexUrls(env);
  const allFilings: DiscoveredFiling[] = [];
  const seenDocIds = new Set<string>();
  const relayUrl = env.OGE_RELAY_URL || env.INGEST_RELAY_URL;

  for (const url of urls) {
    let htmlText: string | null = null;
    let directError: Error | null = null;

    try {
      const res = await trackedFetch(url, {
        headers: {
          'user-agent': 'congress.trade/0.1 (+https://congress.trade)',
          accept: 'text/html',
        },
        signal: opts.signal,
      }, { service: 'filing-discovery', operation: 'fetch-executive-index', dynamicTarget: 'filing-source' }, fetchImpl);
      if (res.ok) {
        htmlText = await res.text();
      } else {
        directError = new Error(`OGE index HTTP ${res.status}`);
      }
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      directError = err instanceof Error ? err : new Error(String(err));
    }

    if (htmlText == null && relayUrl) {
      const relayRes = await trackedFetch(`${relayUrl.replace(/\/$/, '')}/fetch-oge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, responseType: 'text' }),
        signal: opts.signal,
      }, { service: 'filing-discovery', operation: 'fetch-executive-index-relay' }, fetchImpl);
      if (relayRes.ok) {
        const json = (await relayRes.json()) as { body?: string };
        if (json.body) htmlText = json.body;
      }
      if (htmlText == null) {
        throw directError ?? new Error(`OGE relay HTTP ${relayRes.status}`);
      }
    }

    if (htmlText == null) {
      throw directError ?? new Error('OGE index fetch failed');
    }

    const filings = parseOgeIndex(htmlText);
    for (const f of filings) {
      if (!seenDocIds.has(f.docId)) {
        seenDocIds.add(f.docId);
        allFilings.push(f);
      }
    }
  }

  return allFilings;
}

/**
 * Fetch the OGE indexes when the watcher is enabled (or force). Cadence is
 * NOT decided here — runWatcher calls decideSourcePoll first, same as
 * House/Senate. A leftover Infisical OGE_POLL_INTERVAL_SEC=21600 is unused
 * and cannot re-impose a 6h gate.
 */
export async function pollOgeExecutive(
  env: Env,
  _now: Date,
  fetchImpl: typeof fetch = fetch,
  opts: { force?: boolean; signal?: AbortSignal } = {},
): Promise<DiscoveredFiling[] | null> {
  if (!(await ogeWatchEnabled(env)) && !opts.force) return null;
  // Checkpoint is written by the caller (pollExecutive) only after
  // persistence succeeds, matching the House/Senate ordering — a failed
  // persist must not advance last_poll:oge and skip the next cycles.
  return fetchOgeExecutiveFilings(env, fetchImpl, { signal: opts.signal });
}
