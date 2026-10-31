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
import { createProxiedFetch, getDenoHttpClient, resolveResidentialProxyUrl } from '../shared/proxyFetch.ts';
import {
  SenateHttpError,
  SenateProxyEgressError,
  isSenateEdgeDeniedError,
  logSafeHeaderToken,
  sanitizeEfdTransportError,
  senateEfdTransportScrubSecrets,
} from './senateEdgeDeny.ts';

/** Backoff between direct Senate eFD attempts when direct is the only egress. */
/** Keep direct retry waits under pollSenate's 7s abort when direct is the proxy's fallback. */
export const SENATE_EFD_DIRECT_BACKOFF_MS = [0, 1_000, 2_000];
export const SENATE_EFD_DIRECT_BACKOFF_WITH_PROXY_MS = [0, 1_000];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? '');
}

function isRetryableSenateTransportError(err: unknown): boolean {
  // An edge deny is persistent: retrying it only asks the edge again.
  if (isSenateEdgeDeniedError(err)) return false;
  const message = errorMessage(err);
  if (/HTTP 403/.test(message)) return true;
  if (/HTTP 502|HTTP 503|HTTP 504/.test(message)) return true;
  if (/abort/i.test(message)) return false;
  if (/fetch failed|network|ECONNREFUSED|ETIMEDOUT|timed out/i.test(message)) return true;
  return false;
}

/**
 * How long each request of the proxy leg may wait for its HTTP answer (the
 * response headers) before the proxy counts as unreachable.  A black-holed
 * proxy (WireGuard peer down, SYNs dropped) never refuses the connection, so
 * without this deadline it would spend pollSenate's whole 7 s budget and the
 * direct fallback would never run.  Every request gets its own deadline, so a
 * proxy that answers the landing GET and then black-holes the agreement POST
 * is caught too.  The deadline covers only the wait for headers: a proxy that
 * answers each request in time keeps the rest of the budget, however long the
 * whole leg takes.  (The name predates the per-request deadline.)
 */
export const SENATE_PROXY_FIRST_ANSWER_TIMEOUT_MS = 3_000;

/** True for a fetch rejection that is a network failure: no HTTP answer came back. */
function isNetworkLevelFetchError(err: unknown): boolean {
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return false;
  return err instanceof TypeError
    || /fetch failed|network|connect|ECONN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|timed out|tunnel|proxy|os error/i.test(errorMessage(err));
}

/**
 * The proxy leg's fetch, wrapped so the leg can tell "the proxy never
 * answered" from everything else.  Only a rejection of this fetch call itself
 * counts, never a parse or code fault elsewhere in the leg.  Each request's
 * own answer deadline turns a hung proxy into such a rejection, at whichever
 * request it hangs.
 */
function guardProxyLeg(proxyFetch: typeof fetch, answerTimeoutMs: number) {
  const rejections = new WeakSet<object>();
  const deadlineRejections = new WeakSet<object>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException(
      `senate proxy gave no HTTP answer within ${answerTimeoutMs}ms`,
      'TimeoutError',
    )), answerTimeoutMs);
    timers.add(timer);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
    try {
      // Cleared below once the headers are in, so reading the body is never
      // cut short by this deadline.
      return await proxyFetch(input, { ...init, signal });
    } catch (err) {
      if (err !== null && typeof err === 'object') {
        rejections.add(err);
        if (deadline.signal.aborted) deadlineRejections.add(err);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      timers.delete(timer);
    }
  }) as typeof fetch;
  return {
    fetchImpl,
    /** True when `err` means the proxy never answered and the budget still has time for direct. */
    unreachable(err: unknown, budget?: AbortSignal): boolean {
      // The source budget's own abort is not the proxy's fault, and leaves
      // no time for direct anyway.
      if (budget?.aborted) return false;
      if (err === null || typeof err !== 'object' || !rejections.has(err)) return false;
      return deadlineRejections.has(err) || isNetworkLevelFetchError(err);
    },
    dispose(): void {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

/** Proxy URLs whose HTTP client could not be created, each logged once. */
const senateProxyClientUnavailable = new Set<string>();

/**
 * The proxied fetch for `proxyUrl`, or undefined when no proxy client can be
 * created for it.  createProxiedFetch then quietly hands back the base fetch
 * (no Deno.createHttpClient, or it threw), and a leg run on that would be
 * datacenter egress labeled `proxy`: it would read and write the proxy's
 * shared KV session and get the proxy's answer deadline.  The call runs
 * direct only instead, as if no proxy were configured.
 */
function senateProxyFetch(proxyUrl: string, baseFetch: typeof fetch): typeof fetch | undefined {
  if (!getDenoHttpClient(proxyUrl)) {
    if (!senateProxyClientUnavailable.has(proxyUrl)) {
      senateProxyClientUnavailable.add(proxyUrl);
      console.warn(
        'senateSource: the residential proxy HTTP client could not be created; '
          + 'Senate eFD requests go out direct only until it can',
      );
    }
    return undefined;
  }
  senateProxyClientUnavailable.delete(proxyUrl);
  return createProxiedFetch(proxyUrl, baseFetch);
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

/** Which leg `withSenateEfdEgress` is running. */
export interface SenateEfdEgressLeg {
  egress: 'direct' | 'proxy';
  /** True on a direct leg that only stands in for an unreachable proxy. */
  fallback: boolean;
}

/**
 * Run `run` through the operator-configured residential proxy first.  Direct
 * datacenter egress is only a fallback for when the proxy never answers: a
 * fetch is refused or reset, or a request gets no HTTP answer within
 * SENATE_PROXY_FIRST_ANSWER_TIMEOUT_MS (a black-holed proxy), so a Mango
 * outage still falls back (CT-2361 / #2748).  An HTTP answer through the
 * proxy, an edge deny included, is the result: it is never retried direct,
 * because the box's own egress has been edge-denied even for GET (Akamai
 * SERVE_403) since at least 2026-10-16 (CT-2442).  A fault elsewhere in the
 * leg (a parse or code error) and the source budget's own abort do not fall
 * back either.  Without a usable explicit proxy (none configured, or no
 * proxy client can be created for it), direct is the only egress and keeps
 * its short backoff for transient answers.  The Mango default is never used
 * implicitly.
 *
 * The direct fallback shares the source budget (`opts.signal`) with the proxy
 * leg on purpose: the watcher bounds each source at
 * WATCHER_SOURCE_IO_BUDGET_MS, and a fresh budget would let one source take
 * two.  A proxy request gives up within the answer deadline, which leaves the
 * fallback the rest.
 */
export async function withSenateEfdEgress<T>(
  opts: FetchSenatePtrFilingsOptions,
  baseFetch: typeof fetch,
  run: (fetchImpl: typeof fetch, leg: SenateEfdEgressLeg) => Promise<T>,
): Promise<T> {
  const explicitProxy = resolveExplicitSenateProxyUrl(opts);
  const transportScrubSecrets = senateEfdTransportScrubSecrets(explicitProxy);
  const proxied = explicitProxy ? senateProxyFetch(explicitProxy, baseFetch) : undefined;
  let proxyErr: unknown = null;
  if (proxied) {
    const leg = guardProxyLeg(
      proxied,
      boundedPositiveInt(opts.proxyFirstAnswerTimeoutMs, SENATE_PROXY_FIRST_ANSWER_TIMEOUT_MS, SENATE_PROXY_FIRST_ANSWER_TIMEOUT_MS),
    );
    try {
      return await run(leg.fetchImpl, { egress: 'proxy', fallback: false });
    } catch (err) {
      if (!leg.unreachable(err, opts.signal)) throw err;
      proxyErr = err;
    } finally {
      leg.dispose();
    }
  }

  const backoff = proxied ? SENATE_EFD_DIRECT_BACKOFF_WITH_PROXY_MS : SENATE_EFD_DIRECT_BACKOFF_MS;
  for (let attempt = 0; attempt < backoff.length; attempt++) {
    const waitMs = backoff[attempt] ?? 0;
    if (waitMs > 0) await delay(waitMs, opts.signal);
    try {
      const out = await run(baseFetch, { egress: 'direct', fallback: Boolean(proxied) });
      if (proxyErr) {
        console.warn(
          'senateSource: residential proxy unreachable; the direct fallback reached eFD:',
          sanitizeEfdTransportError(proxyErr, transportScrubSecrets),
        );
      }
      return out;
    } catch (err) {
      if (attempt + 1 < backoff.length && isRetryableSenateTransportError(err)) continue;
      // Name the proxy outage first: it is the failure to act on, and the
      // direct leg's own answer (usually an edge deny) is only the fallback.
      // Its [edge_denied] tag is left off: the whole failure is not one.
      if (proxyErr && !opts.signal?.aborted) {
        throw new SenateProxyEgressError(proxyErr, err, transportScrubSecrets);
      }
      throw err;
    }
  }
  throw new Error('senate egress failed');
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


/** One row from the Mac eFD fetcher's output file (~/efd-fetcher/out/*.json). */
export interface EfdFetcherRow {
  first_name?: string | null;
  last_name?: string | null;
  filer?: string | null;
  report_title?: string | null;
  report_url?: string | null;
  date_received?: string | null;
  is_paper?: boolean;
  /** The original DataTables row, when the fetcher preserved it. */
  raw?: string[];
}

function fetcherRowText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Convert one Mac eFD fetcher row into a SenateFiling, or null when the row
 * does not carry a usable official eFD report link and filed date.  When the
 * fetcher preserved the original DataTables row, parseSenateRows is the
 * primary path so intake filings are parsed identically to polled filings.
 * The extracted fields are the fallback for rows without a usable raw row.
 * A report URL on any host other than efdsearch.senate.gov is rejected: the
 * pipeline fetches sourceUrl server-side, so intake must never become a way
 * to point it at an arbitrary URL.
 */
export function senateFilingFromFetcherRow(row: EfdFetcherRow): SenateFiling | null {
  if (!row || typeof row !== 'object') return null;
  if (Array.isArray(row.raw)) {
    const parsed = parseSenateRows([row.raw])[0];
    if (parsed && parsed.sourceUrl.startsWith(`${SENATE_BASE}/search/view/`)) return parsed;
  }
  const reportUrl = fetcherRowText(row.report_url);
  if (!reportUrl) return null;
  let reportPath = '';
  if (reportUrl.startsWith('/')) {
    reportPath = reportUrl.split(/[?#]/, 1)[0];
  } else {
    try {
      const url = new URL(reportUrl);
      if (url.origin !== SENATE_BASE) return null;
      reportPath = url.pathname;
    } catch {
      return null;
    }
  }
  if (!/^\/search\/view\/(?:ptr|paper)\//i.test(reportPath)) return null;
  const segments = reportPath.split('/').filter((s) => s.length > 0);
  const reportId = segments[segments.length - 1] ?? '';
  if (!reportId) return null;
  const filedDate = fetcherRowText(row.date_received);
  if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(filedDate)) return null;
  const first = fetcherRowText(row.first_name);
  const last = fetcherRowText(row.last_name);
  const fullName = fetcherRowText(row.filer) || `${first} ${last}`.trim();
  if (!fullName) return null;
  return {
    reportId,
    first,
    last,
    fullName,
    filingTypeLabel: fetcherRowText(row.report_title),
    filedDate,
    reportPath,
    sourceUrl: `${SENATE_BASE}${reportPath}`,
    pipelineDocId: `S-${reportId}`,
  };
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
  /** Injectable for tests; capped at SENATE_PROXY_FIRST_ANSWER_TIMEOUT_MS. */
  proxyFirstAnswerTimeoutMs?: number;
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

/** The response's Server header (AkamaiGHost for the edge, gunicorn for the origin). */
function senateServer(res: Response): string | null {
  return res.headers.get('server');
}

/**
 * Read at most `maxChars` characters of a response body and cancel the rest,
 * so a large page is never buffered whole.  `truncated` is true when the
 * body went on past the limit.  A read error rejects, as `res.text()` does.
 */
async function readSenateBodyPrefix(
  res: Response,
  maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { text: text + decoder.decode(), truncated: false };
      text += decoder.decode(value, { stream: true });
      if (text.length > maxChars) {
        await reader.cancel().catch(() => {});
        return { text: text.slice(0, maxChars), truncated: true };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * The start of an error response body, enough to recognize Akamai's deny page
 * (~400 bytes).  Fail-soft: it only enriches an error that is thrown anyway.
 */
async function readSenateBodySnippet(res: Response, maxChars = 4096): Promise<string> {
  try {
    return (await readSenateBodyPrefix(res, maxChars)).text;
  } catch {
    return '';
  }
}

/**
 * How much of a 200 answer to the agreement POST is read to look for the
 * agreement form, which sits past byte 5,000 of eFD's landing page.  A page
 * longer than this fails closed.
 */
const SENATE_AGREEMENT_PAGE_MAX_CHARS = 256 * 1024;

/**
 * Run the eFD landing + agreement-acceptance handshake and return a usable
 * session (cookie header + CSRF token). When `kv` is provided the session is
 * cached for 24 hours under SENATE_SESSION_KV_KEY so the discovery poll and the
 * filing fetcher share one session instead of re-negotiating (or, worse,
 * fetching report pages sessionless and receiving the agreement wall).
 *
 * Throws SenateHttpError when eFD does not accept the agreement, and then
 * writes nothing to KV: a refused cookie jar cached for 24 hours would be
 * replayed by every poll and every document fetch.
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
  if (!landing.ok) {
    throw new SenateHttpError('GET /search/', landing.status, senateServer(landing), {
      body: await readSenateBodySnippet(landing),
    });
  }
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
  // A normal acceptance answers with a redirect (302).  A 200 counts only
  // when the page no longer carries the agreement form.  Anything else is a
  // refusal (since 2026-10-23 the Akamai edge answers this POST with 403
  // "Access Denied", CT-2442), and a refused jar must never reach KV.
  if (agree.status >= 300 && agree.status < 400) {
    await agree.body?.cancel().catch(() => {});
  } else if (agree.status === 200) {
    // The form sits past byte 5,000 of eFD's landing page, so up to
    // SENATE_AGREEMENT_PAGE_MAX_CHARS is read, never the whole body.  An
    // unreadable body is no proof of acceptance, and neither is a page too
    // long to check: fail closed.
    let page: { text: string; truncated: boolean };
    try {
      page = await readSenateBodyPrefix(agree, SENATE_AGREEMENT_PAGE_MAX_CHARS);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      throw new SenateHttpError('POST /search/home/', agree.status, senateServer(agree), {
        detail: `body unreadable (${errorMessage(err)})`,
      });
    }
    if (looksLikeSenateAgreementWall(page.text)) {
      throw new SenateHttpError('POST /search/home/', agree.status, senateServer(agree), {
        detail: 'still shows the agreement form',
      });
    }
    if (page.truncated) {
      throw new SenateHttpError('POST /search/home/', agree.status, senateServer(agree), {
        detail: `page longer than ${SENATE_AGREEMENT_PAGE_MAX_CHARS} chars, not checked`,
      });
    }
  } else {
    throw new SenateHttpError('POST /search/home/', agree.status, senateServer(agree), {
      body: await readSenateBodySnippet(agree),
    });
  }
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

  return await withSenateEfdEgress(opts, fetchImpl, async (effectiveFetch, leg) => {
  // The shared KV session belongs to the primary egress.  A direct leg that
  // is only the proxy's fallback never reads, writes or deletes it: the
  // proxy made it, the fetcher replays it through the same proxy, and a
  // direct failure must not wipe it (CT-2442).
  const sessionKv = leg.fallback ? undefined : opts.kv;
  let session: SenateSession | null = null;

  if (sessionKv) {
    try {
      const cached = await sessionKv.get(SENATE_SESSION_KV_KEY, 'json');
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
      session = await establishSenateSession({ kv: sessionKv, politeDelayMs, signal: opts.signal }, effectiveFetch);
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
        const server = senateServer(data);
        const failure = data.ok
          ? null
          : new SenateHttpError('POST report/data/', data.status, server, { body: await readSenateBodySnippet(data) });
        // An edge deny is not a session problem.  Re-negotiating would only
        // send the edge another agreement POST, so it surfaces as is.
        if (useCached && !handshakeDone && !isSenateEdgeDeniedError(failure)) {
          console.warn(
            `watcher: senate cached session invalid (HTTP ${data.status} ${logSafeHeaderToken(contentType)}, server=${logSafeHeaderToken(server)}), retrying handshake`,
          );
          if (sessionKv) {
            await sessionKv.delete(SENATE_SESSION_KV_KEY).catch(() => {});
          }
          pageError = true;
          break;
        }
        if (failure) throw failure;
        throw new Error(`senate POST report/data/ -> unexpected content-type ${logSafeHeaderToken(contentType)} (server=${logSafeHeaderToken(server)})`);
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
