/**
 * src/ingestion/senateSource.ts
 * OWNER: ingestion agent
 *
 * Senate eFD (efdsearch.senate.gov) source.
 *
 * The Senate has no bulk file; it exposes a CSRF-protected, agreement-gated
 * DataTables search. The flow we implement (all cookies carried in a small jar):
 *
 *   1. GET  https://efdsearch.senate.gov/search/
 *        -> sets a `csrftoken` cookie AND embeds a hidden
 *           <input name="csrfmiddlewaretoken" value="…"> in the landing page.
 *
 *   2. POST https://efdsearch.senate.gov/search/home/
 *        body: prohibition_agreement=1 & csrfmiddlewaretoken=<token>
 *        (accepts the "prohibition against private use" agreement; the server
 *         records acceptance against the session cookie). Cookies are preserved.
 *
 *   3. POST https://efdsearch.senate.gov/search/report/data/
 *        A DataTables server-side request. JSON-ish form body:
 *          draw, start, length, search[value],
 *          report_types=[11]            (11 == Periodic Transaction Report),
 *          filer_types=[],              (all filer types),
 *          submitted_start_date / submitted_end_date  (MM/DD/YYYY HH:MM:SS),
 *          first_name, last_name
 *        Headers: X-CSRFToken: <csrftoken cookie>, Referer: …/search/,
 *                 X-Requested-With: XMLHttpRequest.
 *        -> JSON { data: rows[] } where each row is:
 *             [ firstName, lastName, "<a href='/search/view/ptr/<id>/'>Name</a>",
 *               filingTypeLabel, "MM/DD/YYYY" ]
 *
 * We parse the anchor href in column index 2 to recover the report path and the
 * report id, build sourceUrl, and compute pipeline docId `S-{reportId}`.
 */

import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import * as cheerio from 'cheerio';
import { isSenateRelayUnreachable, senateRelayAuthHeaders } from './senateRelayHealth.ts';
import { createProxiedFetch, resolveResidentialProxyUrl } from '../shared/proxyFetch.ts';

/** Backoff between direct Senate eFD attempts before optional explicit proxy. */
/** Keep direct retry waits under pollSenate's 7s abort when a proxy fallback exists. */
export const SENATE_EFD_DIRECT_BACKOFF_MS = [0, 1_000, 2_000];
export const SENATE_EFD_DIRECT_BACKOFF_WITH_PROXY_MS = [0, 1_000];

function isRetryableSenateTransportError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (/HTTP 403/.test(message)) return true;
  if (/HTTP 502|HTTP 503|HTTP 504/.test(message)) return true;
  if (/abort/i.test(message)) return false;
  if (/fetch failed|network|ECONNREFUSED|ETIMEDOUT|timed out/i.test(message)) return true;
  return false;
}

function resolveExplicitSenateProxyUrl(opts: FetchSenatePtrFilingsOptions): string | undefined {
  const trimmed = opts.proxyUrl?.trim();
  if (trimmed) return trimmed;
  const env = typeof process !== 'undefined'
    ? {
        RESIDENTIAL_PROXY_URL: process.env?.RESIDENTIAL_PROXY_URL,
        SENATE_PROXY_URL: process.env?.SENATE_PROXY_URL,
      }
    : undefined;
  return resolveResidentialProxyUrl(env, { allowDefault: false });
}

/**
 * Run `run` with direct datacenter egress first (with backoff), then an
 * operator-configured residential proxy when direct keeps failing.  The Mango
 * default is never used implicitly — a dead mesh proxy must not block Senate
 * discovery when direct (or backoff) works.
 */
export async function withSenateEfdEgress<T>(
  opts: FetchSenatePtrFilingsOptions,
  baseFetch: typeof fetch,
  run: (fetchImpl: typeof fetch, egress: 'direct' | 'proxy') => Promise<T>,
): Promise<T> {
  const explicitProxy = resolveExplicitSenateProxyUrl(opts);
  const strategies: Array<{ egress: 'direct' | 'proxy'; fetch: typeof fetch }> = [
    { egress: 'direct', fetch: baseFetch },
  ];
  if (explicitProxy) {
    strategies.push({
      egress: 'proxy',
      fetch: createProxiedFetch(explicitProxy, baseFetch),
    });
  }

  let lastErr: unknown;
  for (let i = 0; i < strategies.length; i++) {
    const { egress, fetch: fetchImpl } = strategies[i];
    const directBackoff = explicitProxy
      ? SENATE_EFD_DIRECT_BACKOFF_WITH_PROXY_MS
      : SENATE_EFD_DIRECT_BACKOFF_MS;
    const attempts = egress === 'direct' ? directBackoff.length : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const waitMs = egress === 'direct' ? directBackoff[attempt] ?? 0 : 0;
      if (waitMs > 0) await delay(waitMs, opts.signal);
      try {
        return await run(fetchImpl, egress);
      } catch (err) {
        lastErr = err;
        const retryable = isRetryableSenateTransportError(err);
        const moreDirect = egress === 'direct' && attempt + 1 < attempts;
        if (retryable && (moreDirect || i + 1 < strategies.length)) continue;
        throw err;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'senate egress failed'));
}

const SENATE_BASE = 'https://efdsearch.senate.gov';
export const SENATE_SEARCH = `${SENATE_BASE}/search/`;
const SENATE_HOME = `${SENATE_BASE}/search/home/`;
const SENATE_DATA = `${SENATE_BASE}/search/report/data/`;

/** PTR report type code in the efdsearch DataTables API. */
export const SENATE_PTR_REPORT_TYPE = 11;

/** A single PTR row discovered via the Senate search. */
export interface SenateFiling {
  /** efd report id parsed from the anchor href. */
  reportId: string;
  first: string;
  last: string;
  fullName: string;
  filingTypeLabel: string;
  /** Filing date as displayed, "MM/DD/YYYY". */
  filedDate: string;
  /** Relative report path, e.g. "/search/view/ptr/abcdef.../". */
  reportPath: string;
  /** Absolute report url. */
  sourceUrl: string;
  /** Canonical pipeline doc id: `S-{reportId}`. */
  pipelineDocId: string;
}

// ---------------------------------------------------------------------------
// Cookie jar (minimal — name=value pairs from Set-Cookie, no attributes).
// ---------------------------------------------------------------------------

export class CookieJar {
  private jar = new Map<string, string>();

  /** Ingest one or more Set-Cookie header values from a response. */
  absorb(res: Response): void {
    // Workers exposes combined Set-Cookie via getSetCookie() when available.
    const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
    let cookies: string[] = [];
    if (typeof anyHeaders.getSetCookie === 'function') {
      cookies = anyHeaders.getSetCookie();
    } else {
      const raw = res.headers.get('set-cookie');
      if (raw) cookies = [raw];
    }
    for (const c of cookies) this.absorbString(c);
  }

  /** Parse a single Set-Cookie string ("name=value; Path=/; HttpOnly"). */
  absorbString(setCookie: string): void {
    const first = setCookie.split(';', 1)[0];
    const eq = first.indexOf('=');
    if (eq <= 0) return;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name) this.jar.set(name, value);
  }

  get(name: string): string | undefined {
    return this.jar.get(name);
  }

  /** Serialize as a Cookie request header. */
  header(): string {
    return Array.from(this.jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
}

/** Polite small delay between Senate requests. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Pure parsers (unit-testable, no network).
// ---------------------------------------------------------------------------

/**
 * True when an HTML body is the eFD "prohibition against private use"
 * agreement/landing wall rather than an actual filing/report page.
 *
 * Any request to /search/view/... without an agreement-accepted session cookie
 * is redirected (followed transparently by fetch) to this wall, which the
 * server returns with HTTP 200 + text/html — indistinguishable from a real
 * electronic-report page by status/content-type alone. Persisting it as the
 * filing's raw bytes silently poisons the pipeline: it classifies as
 * senate_html and extracts zero transactions. Signature verified against the
 * live page: the wall embeds the `prohibition_agreement` form field (and an
 * `agreement_form` element); real report pages contain neither.
 */
export function looksLikeSenateAgreementWall(html: string): boolean {
  return /prohibition_agreement/i.test(html) || /id=["']agreement_form["']/i.test(html);
}

/**
 * Extract the hidden csrfmiddlewaretoken from the landing page HTML.
 * Returns '' if not found.
 */
export function parseCsrfMiddlewareToken(html: string): string {
  const $ = cheerio.load(html);
  const token = $('input[name="csrfmiddlewaretoken"]').val();
  return typeof token === 'string' ? token : '';
}

/**
 * Parse the report path + id out of a DataTables anchor cell, e.g.
 *   "<a href='/search/view/ptr/0f8b.../' target='_blank'>Smith, Jane</a>"
 * Returns { reportPath, reportId } or null if no parseable href.
 */
export function parseReportLink(cellHtml: string): { reportPath: string; reportId: string } | null {
  const $ = cheerio.load(cellHtml);
  const href = $('a').attr('href');
  if (!href) return null;
  const reportPath = href;
  // id is the last non-empty path segment (handles trailing slash).
  const segments = reportPath.split('/').filter((s) => s.length > 0);
  const reportId = segments[segments.length - 1] ?? '';
  if (!reportId) return null;
  return { reportPath, reportId };
}

/**
 * Map a DataTables `data` array (rows of string columns) into SenateFiling[].
 *
 * eFD's column order is NOT stable: it inserted an "office" display column, which
 * shifted the report anchor from index 2 to index 3 (and the type/date columns
 * with it). Hardcoding index 2 (as this did) silently parsed ZERO rows once that
 * change shipped — the likely cause of "0 Senate filings ever." So we now locate
 * each field by CONTENT, not position: the anchor is whichever cell contains a
 * /search/view/{ptr,paper}/ link, the filed date is the MM/DD/YYYY cell, etc.
 * Rows whose link can't be parsed are skipped.
 */
export function parseSenateRows(rows: string[][]): SenateFiling[] {
  const out: SenateFiling[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const cells = row.map((c) => (typeof c === 'string' ? c : ''));
    const textCells = cells.map((c) => cheerio.load(c).text().trim());
    const linkCell = cells.find((c) => /\/search\/view\/(?:ptr|paper)\//i.test(c)) ?? '';
    const parsed = parseReportLink(linkCell);
    if (!parsed) continue;
    const first = textCells[0] ?? '';
    const last = textCells[1] ?? '';
    const nameText = textCells.find((c) => /\(Senator\)/i.test(c)) ?? '';
    const fullName = nameText || `${first} ${last}`.trim();
    const filedDate = textCells.find((c) => /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(c)) ?? '';
    const filingTypeLabel = textCells.find((c) => /report/i.test(c)) ?? '';
    out.push({
      reportId: parsed.reportId,
      first,
      last,
      fullName,
      filingTypeLabel,
      filedDate,
      reportPath: parsed.reportPath,
      sourceUrl: parsed.reportPath.startsWith('http')
        ? parsed.reportPath
        : `${SENATE_BASE}${parsed.reportPath}`,
      pipelineDocId: `S-${parsed.reportId}`,
    });
  }
  return out;
}

/** Format a Date as the "MM/DD/YYYY HH:MM:SS" string efdsearch expects. */
export function formatSenateDate(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}/${d.getUTCFullYear()} ${p2(
    d.getUTCHours(),
  )}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}

// ---------------------------------------------------------------------------
// Network flow.
// ---------------------------------------------------------------------------

// efdsearch.senate.gov fronts its search with an anti-bot layer that returns
// HTTP 403 to obvious non-browser clients. A bare custom UA
// ("congress-feed/0.1 …") was reliably blocked, so we present a realistic
// modern-browser header set. These are static, public request headers (no
// credentials); the daily bulk/backfill path remains the source of truth if the
// live search is still refused.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const POLITE_DELAY_MS = 750;
const SENATE_PAGE_SIZE = 100;
const SENATE_MAX_PAGES = 25;

/** Browser-like base headers shared across the efdsearch request flow (and
 *  reused by the House live-search overlay, which sits behind a similar
 *  anti-bot layer on the Clerk host). */
export const BROWSER_HEADERS: Record<string, string> = {
  'user-agent': UA,
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="124", "Not:A-Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
};

export interface FetchSenatePtrFilingsOptions {
  since?: Date;
  now?: Date;
  /** Test/ops escape hatch; production stays bounded by SENATE_MAX_PAGES. */
  maxPages?: number;
  /** DataTables page length. Capped at the source's 100-row page size. */
  pageSize?: number;
  /** Injectable for tests so pagination does not sleep. */
  politeDelayMs?: number;
  /** KV namespace for caching the Senate eFD session (Strategy B) */
  kv?: any;
  /**
   * @deprecated Mac scout relay URL (e.g. https://scout.jays.services) — the
   * Mac scout was retired 2026-09-09 (board `ba810d46`).  Kept as a typed
   * option only so historical callers continue to type-check; the value
   * is **ignored** at runtime.  Server now fetches directly from the
   * Senate eFD, with residential-IP bounce via the GL.iNet Mango HTTP
   * CONNECT proxy at `http://10.99.0.2:8888`.
   */
  relayUrl?: string;
  /**
   * @deprecated Companion bearer for the (retired) Mac scout relay.  See
   * `relayUrl` — also ignored.
   */
  relaySecret?: string;
  /** Optional proxy URL for routing Senate requests. */
  proxyUrl?: string;
  /** Cancels active source I/O when the enclosing watcher tick reaches its deadline. */
  signal?: AbortSignal;
}

/** KV key holding the cached, agreement-accepted eFD session. Shared with the
 *  fetcher (which reuses the session cookie to download report pages). */
export const SENATE_SESSION_KV_KEY = 'senate_efd_session';

/** An agreement-accepted eFD session: cookies + the CSRF token to send back. */
export interface SenateSession {
  csrfCookie: string;
  cookieHeader: string;
}

/**
 * Run the eFD landing + agreement-acceptance handshake and return a usable
 * session (cookie header + CSRF token). When `kv` is provided the session is
 * cached for 24 hours under SENATE_SESSION_KV_KEY so the discovery poll and the
 * filing fetcher share one session instead of re-negotiating (or, worse,
 * fetching report pages sessionless and receiving the agreement wall).
 */
export async function establishSenateSession(
  opts: { kv?: any; politeDelayMs?: number; signal?: AbortSignal } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<SenateSession> {
  const politeDelayMs = boundedNonNegativeInt(opts.politeDelayMs, POLITE_DELAY_MS);
  const jar = new CookieJar();
  // 1) GET landing page -> csrftoken cookie + hidden middleware token.
  const landing = await trackedFetch(SENATE_SEARCH, {
    headers: {
      ...BROWSER_HEADERS,
      accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
    },
    signal: opts.signal,
  }, { service: 'filing-discovery', operation: 'open-senate-search-session' }, fetchImpl);
  if (!landing.ok) throw new Error(`senate GET /search/ -> HTTP ${landing.status}`);
  jar.absorb(landing);
  const landingHtml = await landing.text();
  const middlewareToken = parseCsrfMiddlewareToken(landingHtml);
  if (!middlewareToken) throw new Error('senate: csrfmiddlewaretoken not found on landing page');

  await delay(politeDelayMs, opts.signal);

  // 2) POST agreement acceptance (carry cookies).
  const agreeBody = new URLSearchParams({
    prohibition_agreement: '1',
    csrfmiddlewaretoken: middlewareToken,
  });
  const agree = await trackedFetch(SENATE_HOME, {
    method: 'POST',
    headers: {
      ...BROWSER_HEADERS,
      'content-type': 'application/x-www-form-urlencoded',
      cookie: jar.header(),
      referer: SENATE_SEARCH,
      origin: SENATE_BASE,
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
    },
    body: agreeBody.toString(),
    redirect: 'manual',
    signal: opts.signal,
  }, { service: 'filing-discovery', operation: 'accept-senate-search-terms' }, fetchImpl);
  // 200 or 302 are both fine; we only care that cookies are refreshed.
  jar.absorb(agree);
  await delay(politeDelayMs, opts.signal);

  const csrfCookie = jar.get('csrftoken') ?? middlewareToken;
  const cookieHeader = jar.header();

  if (opts.kv) {
    try {
      // Cache session for 24 hours.
      await opts.kv.put(SENATE_SESSION_KV_KEY, JSON.stringify({ csrfCookie, cookieHeader }), { expirationTtl: 86400 });
    } catch (err) {
      console.warn('watcher: Failed to write senate session to KV:', err);
    }
  }
  return { csrfCookie, cookieHeader };
}

function boundedPositiveInt(raw: number | undefined, fallback: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(Math.floor(raw), 1), max);
}

function boundedNonNegativeInt(raw: number | undefined, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.max(Math.floor(raw), 0);
}

function parseDataTablesCount(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * Run the full efdsearch flow and return discovered PTR filings submitted within
 * the [since, now] window. `since` defaults to 7 days ago.
 *
 * `fetchImpl` is injectable for tests; defaults to global fetch.
 */
export async function fetchSenatePtrFilings(
  opts: FetchSenatePtrFilingsOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<SenateFiling[]> {
  const now = opts.now ?? new Date();
  const since = opts.since ?? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const pageSize = boundedPositiveInt(opts.pageSize, SENATE_PAGE_SIZE, SENATE_PAGE_SIZE);
  const maxPages = boundedPositiveInt(opts.maxPages, SENATE_MAX_PAGES, SENATE_MAX_PAGES);
  const politeDelayMs = boundedNonNegativeInt(opts.politeDelayMs, POLITE_DELAY_MS);

  // Owner 2026-09-09: the Mac scout relay (`https://scout.jays.services`)
  // is retired (board `ba810d46`).  The Senate relay fallback at the
  // bottom of this function used to point there; it is now a no-op.
  // The server fetches directly from the Senate eFD, bouncing through
  // the Mango HTTP CONNECT proxy at `http://10.99.0.2:8888` for the
  // residential IP.  If a misconfigured deployment still has
  // `SENATE_RELAY_URL` set, we warn and ignore it rather than try a
  // dead endpoint.
  const relayUrl = opts.relayUrl ?? (typeof process !== 'undefined' ? process.env?.SENATE_RELAY_URL : undefined);
  if (relayUrl) {
    console.warn(
      `senateSource: SENATE_RELAY_URL=${relayUrl} is configured but the Mac scout relay has been retired (2026-09-09). ` +
      'Ignoring and fetching directly from the Senate eFD via the Mango residential proxy.',
    );
  }

  return await withSenateEfdEgress(opts, fetchImpl, async (effectiveFetch, _egress) => {
  let session: SenateSession | null = null;

  if (opts.kv) {
    try {
      const cached = await opts.kv.get(SENATE_SESSION_KV_KEY, 'json');
      if (cached) session = cached as SenateSession;
    } catch (err) {
      console.warn('watcher: Failed to read senate session from KV:', err);
    }
  }

  let rows: string[][] = [];
  let expectedTotal: number | null = null;
  const useCached = !!session;
  let handshakeDone = false;

  while (true) {
    if (!session && !handshakeDone) {
      session = await establishSenateSession({ kv: opts.kv, politeDelayMs, signal: opts.signal }, effectiveFetch);
      handshakeDone = true;
    }
    if (!session) break;

    let pageError = false;
    for (let page = 0; page < maxPages; page++) {
      const dataBody = new URLSearchParams();
      dataBody.set('draw', String(page + 1));
      dataBody.set('start', String(page * pageSize));
      dataBody.set('length', String(pageSize));
      dataBody.set('search[value]', '');
      dataBody.set('search[regex]', 'false');
      // DataTables column ordering: sort by filing date (col 4) descending.
      dataBody.set('order[0][column]', '4');
      dataBody.set('order[0][dir]', 'desc');
      dataBody.set('report_types', '[11]'); // PTR
      dataBody.set('filer_types', '[]');
      dataBody.set('submitted_start_date', formatSenateDate(since));
      dataBody.set('submitted_end_date', formatSenateDate(now));
      dataBody.set('first_name', '');
      dataBody.set('last_name', '');

      const data = await trackedFetch(SENATE_DATA, {
        method: 'POST',
        headers: {
          ...BROWSER_HEADERS,
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          cookie: session.cookieHeader,
          referer: SENATE_SEARCH,
          origin: SENATE_BASE,
          'x-csrftoken': session.csrfCookie,
          'x-requested-with': 'XMLHttpRequest',
          accept: 'application/json,text/javascript,*/*; q=0.01',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
        },
        body: dataBody.toString(),
        signal: opts.signal,
      }, { service: 'filing-discovery', operation: 'search-senate-filings' }, effectiveFetch);

      const contentType = data.headers.get('content-type') || '';
      if (!data.ok || !contentType.includes('application/json')) {
        if (useCached && !handshakeDone) {
          console.warn(`watcher: senate cached session invalid (HTTP ${data.status} ${contentType}), retrying handshake`);
          if (opts.kv) {
            await opts.kv.delete(SENATE_SESSION_KV_KEY).catch(() => {});
          }
          pageError = true;
          break;
        }
        if (!data.ok) throw new Error(`senate POST report/data/ -> HTTP ${data.status}`);
        throw new Error(`senate POST report/data/ -> unexpected content-type ${contentType}`);
      }

      const json = (await data.json()) as { data?: unknown; recordsFiltered?: unknown };
      const pageRows = Array.isArray(json.data) ? (json.data as string[][]) : [];
      rows.push(...pageRows);
      expectedTotal = parseDataTablesCount(json.recordsFiltered) ?? expectedTotal;

      if (pageRows.length < pageSize) break;
      if (expectedTotal !== null && rows.length >= expectedTotal) break;
      if (page + 1 < maxPages) await delay(politeDelayMs, opts.signal);
    }

    if (pageError) {
      session = null;
      rows = [];
      expectedTotal = null;
      continue;
    }
    
    break;
  }

  return parseSenateRows(rows);
  });
}
// Senate Scraper Hardening applied
