/**
 * Senate agreement-wall guard (src/ingestion/fetcher.ts).
 *
 * A sessionless GET of an eFD report URL is transparently redirected to the
 * "prohibition against private use" agreement page, served HTTP 200 text/html.
 * The fetcher must NEVER persist that wall as the filing's raw bytes (it would
 * classify as senate_html and extract zero transactions); instead it refreshes
 * the agreement-accepted session and refetches once, or defers via
 * IngestRetryError.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  establishSenateSession: vi.fn(),
  proxiedFetches: [] as Array<typeof fetch>,
}));

vi.mock('../senateSource', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../senateSource.ts')>();
  return { ...actual, establishSenateSession: mocks.establishSenateSession };
});

// Node has no Deno.createHttpClient, so the real wrapper would return the base
// fetch.  Tag proxied calls (an extra `client` on init, like the real one) and
// keep each wrapper so a test can check which fetch a leg was handed.
vi.mock('../../shared/proxyFetch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/proxyFetch.ts')>();
  return {
    ...actual,
    createProxiedFetch: (proxyUrl?: string, baseFetch: typeof fetch = globalThis.fetch) => {
      if (!proxyUrl) return baseFetch;
      const proxied = ((input: RequestInfo | URL, init?: RequestInit) =>
        baseFetch(input, { ...init, client: { proxyUrl } } as RequestInit)) as typeof fetch;
      mocks.proxiedFetches.push(proxied);
      return proxied;
    },
  };
});

import { fetchFiling, isSenateAgreementWallBytes, IngestRetryError } from '../fetcher.ts';

const WALL_HTML =
  '<!doctype html><html><body><form id="agreement_form" method="post">' +
  '<input type="checkbox" name="prohibition_agreement" value="1">' +
  '<input type="hidden" name="csrfmiddlewaretoken" value="tok"></form></body></html>';

const REPORT_HTML =
  '<!doctype html><html><body><h1>Periodic Transaction Report</h1>' +
  '<table id="filedReports"><tr><td>AAPL</td></tr></table></body></html>';

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function envForSenateFetch() {
  const kv = new Map<string, string>();
  const r2Puts: Array<{ key: string; bytes: Uint8Array; meta: unknown }> = [];
  const dbRuns: Array<{ sql: string; params: unknown[] }> = [];
  const queueSends: unknown[] = [];
  const env = {
    RAW_FILES: {
      put: vi.fn(async (key: string, body: Uint8Array, meta: unknown) => {
        r2Puts.push({ key, bytes: body, meta });
      }),
    },
    CONFIG_KV: {
      async get(key: string, _type?: string) {
        const v = kv.get(key) ?? null;
        if (v !== null && _type === 'json') return JSON.parse(v);
        return v;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
      },
      async delete(key: string) {
        kv.delete(key);
      },
    },
    DB: {
      // Branch on SQL text: the fetcher's own filings lookup vs. the
      // reviewQueueGuard's review_queue.resolved check must return distinct
      // shapes, or the guard misreads the (non-null) filings-row mock as
      // "resolved" and turns every test into a no-op.
      prepare: (sql: string) => ({
        bind: (...params: unknown[]) => ({
          run: async () => {
            dbRuns.push({ sql, params });
          },
          first: async () =>
            /review_queue/i.test(sql)
              ? null
              : {
                  doc_id: 'S-wall-1',
                  chamber: 'senate',
                  source_url: 'https://efdsearch.senate.gov/search/view/ptr/wall-1/',
                  ingest_status: 'new',
                },
        }),
      }),
    },
    INGEST_QUEUE: { send: vi.fn(async (msg: unknown) => queueSends.push(msg)) },
  } as any;
  return { env, kv, r2Puts, dbRuns, queueSends };
}

describe('isSenateAgreementWallBytes', () => {
  it('detects the agreement wall (prohibition_agreement / agreement_form)', () => {
    expect(isSenateAgreementWallBytes(bytes(WALL_HTML))).toBe(true);
    expect(isSenateAgreementWallBytes(bytes('<form id="agreement_form"></form>'))).toBe(true);
  });

  it('does not flag real report HTML or PDF bytes', () => {
    expect(isSenateAgreementWallBytes(bytes(REPORT_HTML))).toBe(false);
    expect(isSenateAgreementWallBytes(bytes('%PDF-1.7 whatever prohibition_agreement'))).toBe(false);
  });
});

describe('fetchFiling senate wall guard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.establishSenateSession.mockReset();
    mocks.proxiedFetches.length = 0;
  });

  it('negotiates the session and refetches through the proxied fetch (both legs, CT-2442)', async () => {
    const { env, r2Puts } = envForSenateFetch();
    mocks.establishSenateSession.mockResolvedValue({ csrfCookie: 'csrf', cookieHeader: 'sessionid=fresh; csrftoken=csrf' });
    const calls: Array<{ method: string; proxied: boolean; cookie: string | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        method: (init?.method ?? 'GET').toUpperCase(),
        proxied: Boolean((init as { client?: unknown } | undefined)?.client),
        cookie: headers['cookie'],
      });
      const body = headers['cookie']?.includes('sessionid=fresh') ? REPORT_HTML : WALL_HTML;
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
    }));

    await fetchFiling(env, 'S-wall-1');

    // The handshake is handed the same proxied fetch as the document GETs.
    expect(mocks.proxiedFetches).toHaveLength(1);
    expect(mocks.establishSenateSession).toHaveBeenCalledTimes(1);
    expect(mocks.establishSenateSession.mock.calls[0][1]).toBe(mocks.proxiedFetches[0]);
    // HEAD, first GET (the wall) and the refetch all left through the proxy.
    expect(calls.map((c) => c.method)).toEqual(['HEAD', 'GET', 'GET']);
    expect(calls.every((c) => c.proxied)).toBe(true);
    expect(calls[2].cookie).toContain('sessionid=fresh');
    expect(new TextDecoder().decode(r2Puts[0].bytes)).toContain('filedReports');
  });

  it('refreshes the session and stores the REAL report when the first response is the wall', async () => {
    const { env, kv, r2Puts, queueSends } = envForSenateFetch();
    mocks.establishSenateSession.mockImplementation(async (opts: { kv?: { put: (k: string, v: string) => Promise<void> } }) => {
      const session = { csrfCookie: 'csrf', cookieHeader: 'sessionid=fresh; csrftoken=csrf' };
      await opts?.kv?.put('senate_efd_session', JSON.stringify(session));
      return session;
    });
    const calls: Array<{ url: string; cookie: string | undefined; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url: String(input), cookie: headers['cookie'], method });
      // Sessionless first hit -> wall; refetch with the fresh cookie -> report.
      const body = headers['cookie']?.includes('sessionid=fresh') ? REPORT_HTML : WALL_HTML;
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
    }));

    await fetchFiling(env, 'S-wall-1');

    expect(mocks.establishSenateSession).toHaveBeenCalledTimes(1);
    const getCalls = calls.filter((c) => c.method === 'GET');
    expect(getCalls).toHaveLength(2);
    expect(getCalls[1].cookie).toContain('sessionid=fresh');
    // The REAL report bytes are persisted — never the wall.
    expect(r2Puts).toHaveLength(1);
    expect(new TextDecoder().decode(r2Puts[0].bytes)).toContain('filedReports');
    expect(kv.get('senate_efd_session')).toContain('sessionid=fresh');
    expect(queueSends).toEqual([{ type: 'filing.fetched', docId: 'S-wall-1' }]);
  });

  it('defers (IngestRetryError) and drops the cached session when the wall persists after refresh', async () => {
    const { env, kv, r2Puts, dbRuns, queueSends } = envForSenateFetch();
    kv.set('senate_efd_session', JSON.stringify({ csrfCookie: 'stale', cookieHeader: 'sessionid=stale' }));
    mocks.establishSenateSession.mockResolvedValue({ csrfCookie: 'csrf', cookieHeader: 'sessionid=fresh' });
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(WALL_HTML, { status: 200, headers: { 'content-type': 'text/html' } }),
    ));

    await expect(fetchFiling(env, 'S-wall-1')).rejects.toBeInstanceOf(IngestRetryError);

    expect(r2Puts).toHaveLength(0);
    expect(queueSends).toHaveLength(0);
    // Cached session dropped so the next attempt renegotiates from scratch.
    expect(kv.has('senate_efd_session')).toBe(false);
    const errorUpdates = dbRuns.filter((r) => /SET ingest_status = 'error'/i.test(r.sql));
    expect(errorUpdates.length).toBeGreaterThan(0);
    expect(String(errorUpdates[0].params[0])).toContain('agreement wall');
  });

  it('leaves non-senate HTML untouched (no wall sniffing for house docs)', async () => {
    const { env, r2Puts } = envForSenateFetch();
    env.DB = {
      prepare: (sql: string) => ({
        bind: () => ({
          run: async () => {},
          first: async () =>
            /review_queue/i.test(sql)
              ? null
              : {
                  doc_id: 'H-2026-1',
                  chamber: 'house',
                  source_url: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/1.pdf',
                  ingest_status: 'new',
                },
        }),
      }),
    };
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(WALL_HTML, { status: 200, headers: { 'content-type': 'text/html' } }),
    ));

    await fetchFiling(env, 'H-2026-1');

    expect(mocks.establishSenateSession).not.toHaveBeenCalled();
    expect(r2Puts).toHaveLength(1);
  });
});
