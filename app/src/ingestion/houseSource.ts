/**
 * src/ingestion/houseSource.ts
 * OWNER: ingestion agent
 *
 * House Clerk financial-disclosure source.
 *
 * BULK INDEX (implemented here, the daily-cadence path):
 *   The Clerk publishes a per-year ZIP of all financial disclosures at
 *     https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{YEAR}FD.ZIP
 *   The ZIP contains a single index file `{YEAR}FD.xml` listing every filing for
 *   the year (one <Member> element each). This XML is regenerated roughly DAILY,
 *   so polling the ZIP and diffing against what we've already seen is the primary
 *   change-detection mechanism. We unzip with fflate (unzipSync) entirely in
 *   memory (Workers-compatible, no node:zlib) and hand-parse the XML — the schema
 *   is flat and regular, so a dependency-free regex/scan parser is robust and
 *   avoids pulling in fast-xml-parser.
 *
 * LIVE SEARCH (optional overlay, disabled by default unless HOUSE_LIVE_SEARCH_ENABLED=true):
 *   The interactive UI at https://disclosures-clerk.house.gov/FinancialDisclosure
 *   posts to /FinancialDisclosure/ViewMemberSearchResult, which returns a single
 *   server-rendered Razor HTML table for the requested FilingYear (client-side
 *   DataTables paginates the DOM in the browser; the server ignores draw/start/length).
 *   Verified against production Clerk responses and PDF Last-Modified timestamps
 *   (2026-10-16): ViewMemberSearchResult refreshes on the exact same once-daily
 *   ~09:00 ET (13:00 UTC EDT) batch cycle as {YEAR}FD.ZIP and omits FilingDate,
 *   so pollHouseLiveSearch() is disabled by default to avoid redundant 207 KB HTML
 *   fetches inside the 7s watcher I/O budget.
 *
 * FETCH ORDER: server-first.  Direct Clerk host, then Mac/scout
 * POST /fetch-house if HOUSE_RELAY_URL or INGEST_RELAY_URL is set and
 * direct fails.  Not Mac-only.  Senate eFD is the exception (relay-first).
 */

import { unzipSync } from 'fflate';
import { BROWSER_HEADERS, CookieJar, delay } from './senateSource.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import { resolveSecret } from '../secrets/infisical.ts';

/** A single filing row parsed out of the House yearly index XML. */
export interface HouseFiling {
  /** Document id (the Clerk's DocID, e.g. "20012345"). */
  docId: string;
  /** Filing type code; 'P' === Periodic Transaction Report (PTR). */
  filingType: string;
  /** Disclosure year (the {YEAR} of the index, also a <Year> element). */
  year: string;
  first: string;
  last: string;
  /** State + district string, e.g. "CA01" (StateDst element). */
  stateDst: string;
  /** Filing/report date as published by the House index, usually M/D/YYYY. */
  filingDate: string;
  /** True when this is a PTR (filingType 'P'). */
  isPtr: boolean;
  /** Canonical pipeline doc id: `H-{year}-{DocID}`. */
  pipelineDocId: string;
  /** Direct PDF url for the PTR. */
  sourceUrl: string;
}

const HOUSE_BULK_BASE = 'https://disclosures-clerk.house.gov/public_disc/financial-pdfs';
const HOUSE_PTR_PDF_BASE = 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs';

/** Build the yearly bulk ZIP url for a given disclosure year. */
export function houseBulkZipUrl(year: number | string): string {
  return `${HOUSE_BULK_BASE}/${year}FD.ZIP`;
}

/** Build the direct PTR PDF url for a House filing. */
export function housePtrPdfUrl(year: number | string, docId: string): string {
  return `${HOUSE_PTR_PDF_BASE}/${year}/${docId}.pdf`;
}

/** Compute the canonical pipeline doc id for a House filing. */
export function houseDocId(year: number | string, docId: string): string {
  return `H-${year}-${docId}`;
}

/**
 * Decode the text content of a single XML element (handles the small set of
 * entities the Clerk emits). Trims surrounding whitespace.
 */
function decodeXmlText(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

/**
 * Pull the inner text of the FIRST occurrence of <tag>…</tag> within a chunk of
 * XML, or '' if absent. The House index uses simple, non-nested leaf elements.
 */
function tagText(chunk: string, tag: string): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(chunk);
  return m ? decodeXmlText(m[1]) : '';
}

/**
 * Parse the House yearly index XML into HouseFiling[].
 *
 * The document looks like:
 *   <FinancialDisclosure>
 *     <Member>
 *       <Prefix/><Last>Smith</Last><First>Jane</First><Suffix/>
 *       <FilingType>P</FilingType><StateDst>CA01</StateDst>
 *       <Year>2024</Year><FilingDate>1/2/2024</FilingDate><DocID>20012345</DocID>
 *     </Member>
 *     …
 *   </FinancialDisclosure>
 *
 * Pure function (no network) so it is unit-testable with inline fixtures.
 * `defaultYear` is used when a <Member> omits <Year> (it normally doesn't).
 */
export function parseHouseIndexXml(xml: string, defaultYear: string): HouseFiling[] {
  const out: HouseFiling[] = [];
  const memberRe = /<Member>([\s\S]*?)<\/Member>/gi;
  let m: RegExpExecArray | null;
  while ((m = memberRe.exec(xml)) !== null) {
    const chunk = m[1];
    const docId = tagText(chunk, 'DocID');
    if (!docId) continue; // index rows without a DocID are not fetchable
    const filingType = tagText(chunk, 'FilingType');
    const year = tagText(chunk, 'Year') || defaultYear;
    const first = tagText(chunk, 'First');
    const last = tagText(chunk, 'Last');
    const stateDst = tagText(chunk, 'StateDst');
    const filingDate = tagText(chunk, 'FilingDate');
    const isPtr = filingType.toUpperCase() === 'P';
    out.push({
      docId,
      filingType,
      year,
      first,
      last,
      stateDst,
      filingDate,
      isPtr,
      pipelineDocId: houseDocId(year, docId),
      sourceUrl: housePtrPdfUrl(year, docId),
    });
  }
  return out;
}

/**
 * Fetch the yearly ZIP, unzip it in-memory, locate `{YEAR}FD.xml`, and parse it.
 * Returns the full list of filings in the index (caller diffs against D1).
 */
export async function fetchHouseIndex(
  year: number | string,
  opts: { relayUrl?: string; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<HouseFiling[]> {
  const url = houseBulkZipUrl(year);
  const relayUrl = opts.relayUrl ?? (typeof process !== 'undefined' ? process.env?.HOUSE_RELAY_URL || process.env?.INGEST_RELAY_URL : undefined);

  let zipBytes: Uint8Array | null = null;
  let directError: Error | null = null;

  try {
    const res = await trackedFetch(url, {
      headers: {
        // A plain UA avoids occasional WAF challenges on the Clerk host.
        'user-agent': 'congress-feed/0.1 (+https://congress.trade)',
        accept: 'application/zip,application/octet-stream,*/*',
      },
      signal: opts.signal,
    }, { service: 'filing-discovery', operation: 'fetch-house-bulk-index' }, opts.fetchImpl);
    if (res.ok) {
      zipBytes = new Uint8Array(await res.arrayBuffer());
    } else {
      directError = new Error(`house bulk zip ${url} -> HTTP ${res.status}`);
    }
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    directError = err instanceof Error ? err : new Error(String(err));
  }

  if (!zipBytes && relayUrl) {
    const relayRes = await trackedFetch(`${relayUrl.replace(/\/$/, '')}/fetch-house`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, responseType: 'bytes' }),
      signal: opts.signal,
    }, { service: 'filing-discovery', operation: 'fetch-house-bulk-index-relay' }, opts.fetchImpl);
    if (relayRes.ok) {
      zipBytes = new Uint8Array(await relayRes.arrayBuffer());
    } else {
      throw directError ?? new Error(`house bulk zip ${url} -> HTTP ${relayRes.status}`);
    }
  }

  if (!zipBytes) {
    throw directError ?? new Error(`house bulk zip ${url} -> fetch failed`);
  }

  const files = unzipSync(zipBytes);

  // The index file is `{YEAR}FD.xml`; fall back to the first *.xml entry.
  const wantName = `${year}FD.xml`;
  let xmlBytes: Uint8Array | undefined =
    files[wantName] ??
    files[wantName.toUpperCase()] ??
    files[wantName.toLowerCase()];
  if (!xmlBytes) {
    const xmlKey = Object.keys(files).find((k) => k.toLowerCase().endsWith('.xml'));
    if (xmlKey) xmlBytes = files[xmlKey];
  }
  if (!xmlBytes) {
    throw new Error(`house bulk zip ${url} contained no XML index (entries: ${Object.keys(files).join(',')})`);
  }
  const xml = new TextDecoder('utf-8').decode(xmlBytes);
  return parseHouseIndexXml(xml, String(year));
}

// ---------------------------------------------------------------------------
// INTRADAY live search.
//
// The yearly XML index refreshes ~once a day, so a PTR filed at 10am may not
// appear in the ZIP until the next overnight rebuild. The interactive UI at
// https://disclosures-clerk.house.gov/FinancialDisclosure is backed by a search
// endpoint (POST to FinancialDisclosure/ViewMemberSearchResult) that surfaces
// filings INTRADAY. We POST a year/last-name/filing-type body and parse the PTR
// PDF links out of the returned HTML table. The result is merged with the bulk
// index by the watcher; because persistence is INSERT OR IGNORE on docId, the
// overlap between the two sources de-dupes for free.
//
// The endpoint is undocumented and lightly anti-bot-protected, so callers run
// this fail-soft: any error leaves the stable bulk-XML diff as the source of
// truth. The HTML parser below is pure + unit-testable.
// ---------------------------------------------------------------------------

const HOUSE_FD_BASE = 'https://disclosures-clerk.house.gov/FinancialDisclosure';
const HOUSE_SEARCH_RESULT = `${HOUSE_FD_BASE}/ViewMemberSearchResult`;
const HOUSE_POLITE_DELAY_MS = 500;

/** Strip HTML tags + collapse whitespace to recover a cell's visible text. */
function stripHtml(s: string): string {
  return decodeXmlText(s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
}

/**
 * Split a House-style "Last, First" (or "First Last") display name into parts.
 * The live search shows "Last, Hon.. First M." in the member column, so we strip
 * a leading honorific ("Hon", "Mr", "Mrs", "Ms", "Dr", with stray dots) off the
 * given-name half.
 */
function stripHonorific(s: string): string {
  return s.replace(/^(hon|mr|mrs|ms|dr|rep|sen)\.*\s+/i, '').trim();
}

function splitMemberName(name: string): { first: string; last: string } {
  const clean = name.replace(/\s+/g, ' ').trim();
  if (!clean) return { first: '', last: '' };
  const comma = clean.indexOf(',');
  if (comma >= 0) {
    return {
      last: clean.slice(0, comma).trim(),
      first: stripHonorific(clean.slice(comma + 1).trim()),
    };
  }
  // No comma: treat the last whitespace-separated token as the surname.
  const parts = stripHonorific(clean).split(' ');
  if (parts.length === 1) return { first: '', last: parts[0] };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

const PTR_PDF_HREF_RE =
  /href=["']([^"']*\/ptr-pdfs\/(\d{4})\/(\d+)\.pdf)["']/i;
const OFFICE_CELL_RE = /data-label=["']Office["'][^>]*>([\s\S]*?)<\/td>/i;
const ROW_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const TD_RE = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
const ANCHOR_PTR_RE =
  /<a\b[^>]*href=["'][^"']*\/ptr-pdfs\/\d{4}\/\d+\.pdf["'][^>]*>([\s\S]*?)<\/a>/i;

/**
 * Parse the House live-search result HTML into HouseFiling[]. Only rows that
 * link to a PTR PDF (`/public_disc/ptr-pdfs/{year}/{docId}.pdf`) are returned;
 * the filer name is taken from the linking anchor's text when meaningful, else
 * the first table cell. Pure + unit-testable.
 */
export function parseHouseSearchHtml(html: string, defaultYear: string): HouseFiling[] {
  const out: HouseFiling[] = [];
  const seen = new Set<string>();
  let row: RegExpExecArray | null;
  ROW_RE.lastIndex = 0;
  while ((row = ROW_RE.exec(html)) !== null) {
    const chunk = row[1];
    const link = PTR_PDF_HREF_RE.exec(chunk);
    if (!link) continue; // not a PTR row
    const href = link[1];
    const year = link[2] || defaultYear;
    const docId = link[3];
    if (seen.has(docId)) continue;
    seen.add(docId);

    // Prefer the anchor's own text as the filer name; fall back to the first
    // non-empty cell (the anchor text is sometimes a generic "View"/"PDF").
    let name = '';
    const anchor = ANCHOR_PTR_RE.exec(chunk);
    if (anchor) {
      const t = stripHtml(anchor[1]);
      if (t && !/^(view|pdf|ptr|report|download)\b/i.test(t)) name = t;
    }
    if (!name) {
      TD_RE.lastIndex = 0;
      let cell: RegExpExecArray | null;
      while ((cell = TD_RE.exec(chunk)) !== null) {
        const t = stripHtml(cell[1]);
        if (t && !/^(view|pdf|ptr|report|download)\b/i.test(t)) {
          name = t;
          break;
        }
      }
    }

    // The results table carries an "Office" cell (e.g. "AL04") = StateDst.
    const office = OFFICE_CELL_RE.exec(chunk);
    const stateDst = office ? stripHtml(office[1]) : '';

    const { first, last } = splitMemberName(name);
    out.push({
      docId,
      filingType: 'P',
      year,
      first,
      last,
      stateDst,
      filingDate: '',
      isPtr: true,
      pipelineDocId: houseDocId(year, docId),
      sourceUrl: href.startsWith('http')
        ? href
        : `https://disclosures-clerk.house.gov${href.startsWith('/') ? '' : '/'}${href}`,
    });
  }
  return out;
}

/** Build the POST body for the House live member search. */
export function buildHouseSearchBody(year: number | string): URLSearchParams {
  const body = new URLSearchParams();
  // Empty name => all members; FilingYear scopes to the requested year.  The
  // Clerk's ViewMemberSearchResult Razor view only reads LastName, FilingYear,
  // State, and District, and returns the entire year's HTML table in one response
  // (client-side DataTables paginates the rendered DOM in the browser).
  body.set('LastName', '');
  body.set('FilingYear', String(year));
  body.set('State', '');
  body.set('District', '');
  return body;
}

/**
 * Poll the House live member search for same-day PTRs.  Mirrors fetchHouseIndex's
 * HouseFiling[] shape so the watcher can treat both sources uniformly.
 *
 * Establishes a session cookie via a GET to the search page, then POSTs the
 * form.  Throws on transport/HTTP failure so the watcher's per-source guard can
 * fail soft (the bulk XML diff remains authoritative).
 */
export interface PollHouseLiveSearchOptions {
  /** Optional residential proxy URL for routing House Clerk live search requests. */
  proxyUrl?: string;
  /** Optional residential proxy URL (alias). */
  residentialProxyUrl?: string;
  /** Custom delay in ms between retries (defaults to HOUSE_POLITE_DELAY_MS, 0 for tests). */
  delayMs?: number;
  /** Env object for secret resolution. */
  env?: any;
  /** Cancels active source I/O when the enclosing watcher tick reaches its deadline. */
  signal?: AbortSignal;
}

/** Public zero-config proxy relay fallbacks used when no custom proxy secret is provided. */
export const PUBLIC_RESIDENTIAL_PROXY_RELAYS = [
  'https://api.allorigins.win/raw?url=',
  'https://proxy.cors.sh/',
];

/**
 * Poll the House live member search for same-day PTRs.  Mirrors fetchHouseIndex's
 * HouseFiling[] shape so the watcher can treat both sources uniformly.
 *
 * Establishes a session cookie via a GET to the search page, then POSTs the
 * form once (ViewMemberSearchResult returns all rows for the requested year in
 * a single unpaginated HTML table).  Retries up to 3 times per poll tick with
 * rotated User-Agents and zero-config public proxy fallbacks when direct fetch
 * fails.  Does NOT lock out or disable subsequent ticks if a single poll tick fails.
 */
export async function pollHouseLiveSearch(
  year: number | string,
  fetchImpl: typeof fetch = fetch,
  opts: PollHouseLiveSearchOptions = {},
): Promise<HouseFiling[]> {
  let lastError: Error | null = null;
  const maxAttempts = 3;

  // Resolve custom residential proxy URL from options, Infisical, or environment
  let customProxyUrl = opts.proxyUrl || opts.residentialProxyUrl;
  if (!customProxyUrl && opts.env) {
    try {
      const p1 = (await resolveSecret(opts.env, 'HOUSE_PROXY_URL' as any)).value;
      const p2 = (await resolveSecret(opts.env, 'RESIDENTIAL_PROXY_URL' as any)).value;
      customProxyUrl = p1 || p2 || opts.env.HOUSE_PROXY_URL || opts.env.RESIDENTIAL_PROXY_URL;
    } catch {
      customProxyUrl = opts.env.HOUSE_PROXY_URL || opts.env.RESIDENTIAL_PROXY_URL;
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const jar = new CookieJar();

      // On attempt 2 or 3, if no custom proxy is set, use zero-config public proxy fallback
      let effectiveProxyUrl = customProxyUrl;
      if (!effectiveProxyUrl && attempt > 1) {
        effectiveProxyUrl = PUBLIC_RESIDENTIAL_PROXY_RELAYS[(attempt - 2) % PUBLIC_RESIDENTIAL_PROXY_RELAYS.length];
      }

      // Rotate user-agent slightly on retry attempts if blocked
      const userAgent = attempt === 1
        ? BROWSER_HEADERS['user-agent']
        : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

      const customHeaders: Record<string, string> = {
        ...BROWSER_HEADERS,
        'user-agent': userAgent,
        accept: 'text/html,*/*',
      };

      // 1) GET landing page
      const landingTargetUrl = effectiveProxyUrl && effectiveProxyUrl.startsWith('http') && effectiveProxyUrl.includes('url=')
        ? `${effectiveProxyUrl}${encodeURIComponent(`${HOUSE_FD_BASE}/ViewSearch`)}`
        : `${HOUSE_FD_BASE}/ViewSearch`;

      const landing = await trackedFetch(landingTargetUrl, {
        headers: customHeaders,
        signal: opts.signal,
      }, { service: 'filing-discovery', operation: 'open-house-search-session' }, fetchImpl);
      if (landing.ok) jar.absorb(landing);

      const baseDelay = opts.delayMs ?? HOUSE_POLITE_DELAY_MS;
      if (baseDelay > 0) {
        await delay(baseDelay * attempt, opts.signal);
      }

      // 2) POST search form (returns all rows for FilingYear in a single HTML response)
      const postHeaders: Record<string, string> = {
        ...BROWSER_HEADERS,
        'user-agent': userAgent,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html,application/xhtml+xml,*/*',
        referer: `${HOUSE_FD_BASE}/ViewSearch`,
        origin: 'https://disclosures-clerk.house.gov',
        'x-requested-with': 'XMLHttpRequest',
        ...(jar.header() ? { cookie: jar.header() } : {}),
      };

      const postTargetUrl = effectiveProxyUrl && effectiveProxyUrl.startsWith('http') && effectiveProxyUrl.includes('url=')
        ? `${effectiveProxyUrl}${encodeURIComponent(HOUSE_SEARCH_RESULT)}`
        : HOUSE_SEARCH_RESULT;

      const res = await trackedFetch(postTargetUrl, {
        method: 'POST',
        headers: postHeaders,
        body: buildHouseSearchBody(year).toString(),
        signal: opts.signal,
      }, { service: 'filing-discovery', operation: 'search-house-filings' }, fetchImpl);

      if (!res.ok) {
        throw new Error(`house live search -> HTTP ${res.status}`);
      }

      const html = await res.text();
      return parseHouseSearchHtml(html, String(year));
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      lastError = err as Error;
      if (attempt < maxAttempts) {
        const baseDelay = opts.delayMs ?? 1000;
        if (baseDelay > 0) {
          await delay(baseDelay * attempt, opts.signal);
        }
      }
    }
  }

  throw lastError ?? new Error('house live search failed after retries');
}
