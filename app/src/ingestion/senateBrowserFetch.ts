/**
 * src/ingestion/senateBrowserFetch.ts
 * OWNER: ingestion agent
 *
 * Opt-in browser transport for the Senate eFD flow (CT-2442).
 *
 * senateSource.ts speaks plain HTTP, and the eFD edge (Akamai) has denied
 * that client class at the agreement POST since 2026-10-23: the discriminator
 * is the client automation signal, not the network, the IP, or the header
 * set.  This module provides a `fetch`-shaped transport that runs the same
 * three eFD requests inside a real Chromium page, so the existing session,
 * agreement, and DataTables logic in senateSource.ts is unchanged:
 *
 *   GET  /search/             -> page.goto(); the response is the page HTML.
 *   POST /search/home/        -> the agreement is accepted the way a user
 *                                accepts it, by checking #agree_statement.
 *                                eFD swaps the page in place (the title
 *                                becomes "eFD: Find Reports"; the URL stays
 *                                /search/home/), so the response is the
 *                                post-agreement page HTML with status 200.
 *                                If the edge refuses, the agreement form is
 *                                still on the page and senateSource's wall
 *                                check fails the session closed, as with HTTP.
 *   POST /search/report/data/ -> an in-page fetch() from the search page, so
 *                                the request carries the browser's own
 *                                cookies, TLS stack, and client signals.
 *
 * Any other request also goes through the in-page fetch.
 *
 * Options:
 *   hideAutomation — launch Chromium with
 *     --disable-blink-features=AutomationControlled, so navigator.webdriver
 *     reads false.  Owner decision, 2026-10-30; the same option is live in
 *     the Mac efd-fetcher, which fetched its first PTR rows with it.
 *   headless — default true.  The verified passes against the eFD edge were
 *     headed (Mac) or a managed browser, so headless is unverified there.
 *   proxyUrl — handed to Chromium as its proxy server; the browser owns its
 *     egress, so senateSource's egress legs do not apply on this transport.
 *
 * The playwright package is loaded dynamically: the default HTTP path never
 * touches it, and enabling this transport is an ops step (install playwright
 * and a Chromium build in the deployment image, then set the env flags
 * documented on FetchSenatePtrFilingsOptions in senateSource.ts).
 */

import { SENATE_HOME, SENATE_SEARCH } from './senateSource.ts';

/** The slice of the Playwright API this module uses, declared structurally
 *  so type-checking does not require the playwright package to be installed. */
interface PwLocator {
  count(): Promise<number>;
  check(opts?: { timeout?: number }): Promise<void>;
}
interface PwPage {
  goto(url: string, opts?: { timeout?: number }): Promise<{ status(): number } | null>;
  content(): Promise<string>;
  locator(selector: string): PwLocator;
  waitForFunction(fn: string, arg?: unknown, opts?: { timeout?: number }): Promise<unknown>;
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
}
interface PwBrowser {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwChromium {
  launch(opts: {
    headless?: boolean;
    args?: string[];
    proxy?: { server: string };
  }): Promise<PwBrowser>;
}

export interface SenateBrowserFetchOptions {
  /** Launch Chromium with --disable-blink-features=AutomationControlled. */
  hideAutomation?: boolean;
  /** Launch Chromium headless. Default true; see the module note. */
  headless?: boolean;
  /** Proxy server URL for the browser's own egress (e.g. the Mango). */
  proxyUrl?: string;
  /** Navigation / agreement wait budget. Default 30s. */
  timeoutMs?: number;
}

export interface SenateBrowserFetchHandle {
  fetchImpl: typeof fetch;
  close(): Promise<void>;
}

interface InPageFetchResult {
  status: number;
  headers: Record<string, string>;
  text: string;
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((v, k) => { out[k] = v; });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) out[k] = v;
    return out;
  }
  return { ...(headers as Record<string, string>) };
}

export async function createSenateBrowserFetch(
  opts: SenateBrowserFetchOptions = {},
): Promise<SenateBrowserFetchHandle> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const specifier: string = 'playwright';
  let pw: { chromium?: PwChromium };
  try {
    pw = (await import(specifier)) as { chromium?: PwChromium };
  } catch (err) {
    throw new Error(
      'senateBrowserFetch: the "playwright" package could not be loaded. ' +
      'Install playwright and a Chromium build in the deployment image before ' +
      `enabling SENATE_EFD_BROWSER_FETCH. (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!pw.chromium) {
    throw new Error('senateBrowserFetch: playwright loaded without a chromium launcher');
  }

  const browser = await pw.chromium.launch({
    headless: opts.headless ?? true,
    args: opts.hideAutomation ? ['--disable-blink-features=AutomationControlled'] : [],
    proxy: opts.proxyUrl ? { server: opts.proxyUrl } : undefined,
  });
  const page = await browser.newPage();

  // Establish the eFD origin so in-page fetch() runs same-origin and the
  // browser cookie jar applies. senateSource's own landing GET below repeats
  // this navigation and reads the fresh page HTML.
  await page.goto(SENATE_SEARCH, { timeout: timeoutMs });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();

    if (method === 'GET' && url === SENATE_SEARCH) {
      const res = await page.goto(url, { timeout: timeoutMs });
      const html = await page.content();
      return new Response(html, {
        status: res?.status() ?? 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    if (method === 'POST' && url === SENATE_HOME) {
      // Accept the agreement like a user: check the box and let eFD swap the
      // page in place. A refusal leaves the agreement form on the page, and
      // senateSource's agreement-wall check on this 200 body fails closed.
      const box = page.locator('#agree_statement');
      if (await box.count()) {
        await box.check({ timeout: timeoutMs });
        await page
          .waitForFunction("() => document.title.includes('Find Reports')", undefined, { timeout: timeoutMs })
          .catch(() => {});
      }
      const html = await page.content();
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    const result = (await page.evaluate(
      async ([u, m, h, b]: [string, string, Record<string, string>, string | null]) => {
        const r = await fetch(u, {
          method: m,
          headers: h,
          body: b ?? undefined,
          credentials: 'include',
        });
        const headers: Record<string, string> = {};
        r.headers.forEach((v: string, k: string) => { headers[k] = v; });
        return { status: r.status, headers, text: await r.text() };
      },
      [url, method, headersToRecord(init?.headers), typeof init?.body === 'string' ? init.body : null],
    )) as InPageFetchResult;
    return new Response(result.text, { status: result.status, headers: result.headers });
  }) as typeof fetch;

  return {
    fetchImpl,
    close: async () => { await browser.close().catch(() => {}); },
  };
}
