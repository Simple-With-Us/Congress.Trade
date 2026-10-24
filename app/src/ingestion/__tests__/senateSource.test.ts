import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Node has no Deno.createHttpClient, so the real createProxiedFetch hands back
// the base fetch and a test could not tell the two egresses apart.  Tag
// proxied calls the way the real wrapper does: an extra `client` on init.
// getDenoHttpClient gives a client for every proxy URL except NO_CLIENT_PROXY,
// which stands for a proxy whose client cannot be created.
const { NO_CLIENT_PROXY } = vi.hoisted(() => ({ NO_CLIENT_PROXY: 'http://no-client.test:8888' }));
vi.mock('../../shared/proxyFetch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/proxyFetch.ts')>();
  return {
    ...actual,
    getDenoHttpClient: (proxyUrl?: string) =>
      proxyUrl?.trim() && proxyUrl.trim() !== NO_CLIENT_PROXY ? { proxyUrl } : undefined,
    createProxiedFetch: (proxyUrl?: string, baseFetch: typeof fetch = globalThis.fetch) =>
      proxyUrl && proxyUrl.trim() !== NO_CLIENT_PROXY
        ? ((input: RequestInfo | URL, init?: RequestInit) =>
            baseFetch(input, { ...init, client: { proxyUrl } } as RequestInit)) as typeof fetch
        : baseFetch,
  };
});

import {
  parseCsrfMiddlewareToken,
  parseReportLink,
  parseSenateRows,
  formatSenateDate,
  CookieJar,
  fetchSenatePtrFilings,
  establishSenateSession,
  looksLikeSenateAgreementWall,
  SENATE_SESSION_KV_KEY,
} from '../senateSource.ts';
import {
  SenateHttpError,
  SenateProxyEgressError,
  classifySenateHttpFailure,
  isSenateEdgeDeniedError,
  looksLikeAkamaiAccessDenied,
} from '../senateEdgeDeny.ts';

/** Akamai's deny page as eFD's edge served it on 2026-10-23 (CT-2442). */
const AKAMAI_ACCESS_DENIED = '<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>\n<H1>Access Denied</H1>\n \n'
  + 'You don\'t have permission to access "http&#58;&#47;&#47;efdsearch&#46;senate&#46;gov&#47;search&#47;home&#47;" on this server.<P>\n'
  + 'Reference&#32;&#35;18&#46;c825c017&#46;1792794395&#46;4605aee3\n'
  + '<P>https&#58;&#47;&#47;errors&#46;edgesuite&#46;net&#47;18&#46;c825c017&#46;1792794395&#46;4605aee3</P>\n</BODY>\n</HTML>\n';

function akamaiDenied(): Response {
  return new Response(AKAMAI_ACCESS_DENIED, {
    status: 403,
    headers: { server: 'AkamaiGHost', 'content-type': 'text/html' },
  });
}

const LANDING_HTML = '<form><input type="hidden" name="csrfmiddlewaretoken" value="csrf-hidden"></form>';

describe('parseCsrfMiddlewareToken', () => {
  it('extracts the hidden token (value after name)', () => {
    const html = `<form><input type="hidden" name="csrfmiddlewaretoken" value="ABC123token"></form>`;
    expect(parseCsrfMiddlewareToken(html)).toBe('ABC123token');
  });
  it('extracts the token when value precedes name', () => {
    const html = `<input value="XYZ789" name='csrfmiddlewaretoken' />`;
    expect(parseCsrfMiddlewareToken(html)).toBe('XYZ789');
  });
  it('returns empty string when absent', () => {
    expect(parseCsrfMiddlewareToken('<form></form>')).toBe('');
  });
});

describe('parseReportLink', () => {
  it('parses path + trailing-slash id from an anchor', () => {
    const cell = `<a href="/search/view/ptr/0f8b12cd/" target="_blank">Smith, Jane</a>`;
    expect(parseReportLink(cell)).toEqual({
      reportPath: '/search/view/ptr/0f8b12cd/',
      reportId: '0f8b12cd',
    });
  });
  it('parses single-quoted href without trailing slash', () => {
    const cell = `<a href='/search/view/paper/abcd'>X</a>`;
    expect(parseReportLink(cell)).toEqual({
      reportPath: '/search/view/paper/abcd',
      reportId: 'abcd',
    });
  });
  it('returns null when there is no href', () => {
    expect(parseReportLink('Smith, Jane')).toBeNull();
  });
});

describe('parseSenateRows', () => {
  it('maps DataTables rows into SenateFiling, stripping tags for fullName', () => {
    const rows: string[][] = [
      [
        'Jane',
        'Smith',
        `<a href="/search/view/ptr/0f8b12cd/">Smith, Jane</a>`,
        'Periodic Transaction Report',
        '01/15/2024',
      ],
      // unparseable link -> skipped
      ['No', 'Link', 'plain text', 'PTR', '02/01/2024'],
      // short row -> skipped
      ['too', 'short'],
    ];
    const out = parseSenateRows(rows);
    expect(out).toHaveLength(1);
    const f = out[0];
    expect(f.reportId).toBe('0f8b12cd');
    expect(f.pipelineDocId).toBe('S-0f8b12cd');
    expect(f.fullName).toBe('Jane Smith');
    expect(f.first).toBe('Jane');
    expect(f.last).toBe('Smith');
    expect(f.filedDate).toBe('01/15/2024');
    expect(f.sourceUrl).toBe('https://efdsearch.senate.gov/search/view/ptr/0f8b12cd/');
  });

  it('locates the anchor by content when eFD shifts columns (inserted office col)', () => {
    // The live eFD response now returns 6 columns with the anchor at index 3:
    // [first, last, office, anchorHtml, filingType, filedDate]. The old index-2
    // parse yielded 0 rows; the content-based parse must still map it.
    const rows: string[][] = [
      [
        'John R',
        'Curtis',
        'Curtis, John R. (Senator)',
        `<a href="/search/view/ptr/96d0794e/" target="_blank">Curtis, John R. (Senator)</a>`,
        'Periodic Transaction Report',
        '06/30/2026',
      ],
    ];
    const out = parseSenateRows(rows);
    expect(out).toHaveLength(1);
    const f = out[0];
    expect(f.reportId).toBe('96d0794e');
    expect(f.pipelineDocId).toBe('S-96d0794e');
    expect(f.first).toBe('John R');
    expect(f.last).toBe('Curtis');
    expect(f.fullName).toBe('Curtis, John R. (Senator)');
    expect(f.filedDate).toBe('06/30/2026');
    expect(f.filingTypeLabel).toBe('Periodic Transaction Report');
    expect(f.sourceUrl).toBe('https://efdsearch.senate.gov/search/view/ptr/96d0794e/');
  });
});

describe('formatSenateDate', () => {
  it('formats MM/DD/YYYY HH:MM:SS in UTC', () => {
    const d = new Date(Date.UTC(2024, 0, 5, 9, 8, 7)); // 2024-01-05T09:08:07Z
    expect(formatSenateDate(d)).toBe('01/05/2024 09:08:07');
  });
});

describe('CookieJar', () => {
  it('absorbs name=value pairs and serializes a Cookie header', () => {
    const jar = new CookieJar();
    jar.absorbString('csrftoken=tok123; Path=/; HttpOnly');
    jar.absorbString('sessionid=sess456; Path=/; Secure');
    expect(jar.get('csrftoken')).toBe('tok123');
    expect(jar.get('sessionid')).toBe('sess456');
    const header = jar.header();
    expect(header).toContain('csrftoken=tok123');
    expect(header).toContain('sessionid=sess456');
  });
  it('overwrites an existing cookie on re-set', () => {
    const jar = new CookieJar();
    jar.absorbString('csrftoken=old');
    jar.absorbString('csrftoken=new; Path=/');
    expect(jar.get('csrftoken')).toBe('new');
  });
});

describe('looksLikeSenateAgreementWall', () => {
  it('recognizes the agreement/landing wall by its form signature', () => {
    expect(
      looksLikeSenateAgreementWall(
        '<form id="agreement_form"><input name="prohibition_agreement" value="1"></form>',
      ),
    ).toBe(true);
    expect(looksLikeSenateAgreementWall('... name="prohibition_agreement" ...')).toBe(true);
    expect(looksLikeSenateAgreementWall("<form id='agreement_form'>")).toBe(true);
  });

  it('does not flag real report pages', () => {
    expect(
      looksLikeSenateAgreementWall('<table id="filedReports"><tr><td>AAPL</td></tr></table>'),
    ).toBe(false);
    expect(looksLikeSenateAgreementWall('<html><body>Periodic Transaction Report</body></html>')).toBe(false);
  });
});

describe('establishSenateSession', () => {
  it('negotiates the agreement handshake and caches the session in KV', async () => {
    const kvPuts: Array<[string, string]> = [];
    const kv = {
      async put(key: string, value: string) {
        kvPuts.push([key, value]);
      },
    };
    const posted: string[] = [];
    const fetchImpl = async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/search/')) {
        return new Response(
          `<form><input type="hidden" name="csrfmiddlewaretoken" value="csrf-hidden"></form>`,
          { headers: { 'set-cookie': 'csrftoken=csrf-cookie; Path=/' } },
        );
      }
      if (url.endsWith('/search/home/')) {
        posted.push(String(init?.body ?? ''));
        return new Response('', { status: 302, headers: { 'set-cookie': 'sessionid=sess; Path=/' } });
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const session = await establishSenateSession({ kv, politeDelayMs: 0 }, fetchImpl as typeof fetch);

    expect(session.csrfCookie).toBe('csrf-cookie');
    expect(session.cookieHeader).toContain('csrftoken=csrf-cookie');
    expect(session.cookieHeader).toContain('sessionid=sess');
    // Accepts the prohibition agreement with the hidden middleware token.
    expect(posted[0]).toContain('prohibition_agreement=1');
    expect(posted[0]).toContain('csrfmiddlewaretoken=csrf-hidden');
    expect(kvPuts).toHaveLength(1);
    expect(kvPuts[0][0]).toBe(SENATE_SESSION_KV_KEY);
    expect(JSON.parse(kvPuts[0][1])).toEqual(session);
  });
});

describe('fetchSenatePtrFilings', () => {
  function senateRow(id: string): string[] {
    return [
      'Jane',
      'Smith',
      `<a href="/search/view/ptr/${id}/">Smith, Jane</a>`,
      'Periodic Transaction Report',
      '06/30/2026',
    ];
  }

  it('paginates beyond the first DataTables page and stops at recordsFiltered', async () => {
    const starts: string[] = [];
    const lengths: string[] = [];
    const fetchImpl = async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/search/')) {
        return new Response(
          `<form><input type="hidden" name="csrfmiddlewaretoken" value="csrf-hidden"></form>`,
          { headers: { 'set-cookie': 'csrftoken=csrf-cookie; Path=/' } },
        );
      }
      if (url.endsWith('/search/home/')) {
        return new Response('', { status: 302, headers: { 'set-cookie': 'sessionid=sess; Path=/' } });
      }
      if (url.endsWith('/search/report/data/')) {
        const body = new URLSearchParams(String(init?.body ?? ''));
        starts.push(body.get('start') ?? '');
        lengths.push(body.get('length') ?? '');
        const start = Number(body.get('start') ?? '0');
        const data = start === 0 ? [senateRow('a'), senateRow('b')] : [senateRow('c')];
        return new Response(JSON.stringify({ data, recordsFiltered: 3 }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const out = await fetchSenatePtrFilings(
      {
        since: new Date('2026-06-30T00:00:00.000Z'),
        now: new Date('2026-06-30T23:59:59.000Z'),
        pageSize: 2,
        maxPages: 5,
        politeDelayMs: 0,
      },
      fetchImpl,
    );

    expect(starts).toEqual(['0', '2']);
    expect(lengths).toEqual(['2', '2']);
    expect(out.map((f) => f.pipelineDocId)).toEqual(['S-a', 'S-b', 'S-c']);
  });

  // The Mac scout relay (`https://scout.jays.services`) is retired as of
  // 2026-09-09 (board `ba810d46`). `relayUrl` / `relaySecret` survive as
  // @deprecated options so old callers still type-check, but both are ignored
  // at runtime: the search goes straight to the eFD, with the residential IP
  // supplied by the Mango HTTP CONNECT proxy.
  function directEfdFetch(urls: string[], docId = 'direct-1') {
    return async (
      input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/search/')) {
        return new Response(
          `<form><input type="hidden" name="csrfmiddlewaretoken" value="csrf-hidden"></form>`,
          { headers: { 'set-cookie': 'csrftoken=csrf-cookie; Path=/' } },
        );
      }
      if (url.endsWith('/search/home/')) {
        return new Response('', { status: 302, headers: { 'set-cookie': 'sessionid=sess; Path=/' } });
      }
      if (url.endsWith('/search/report/data/')) {
        return new Response(JSON.stringify({ data: [senateRow(docId)], recordsFiltered: 1 }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
  }

  it('ignores a stale relayUrl and searches the eFD directly', async () => {
    const urls: string[] = [];
    const out = await fetchSenatePtrFilings(
      {
        relayUrl: 'https://scout.jays.services',
        since: new Date('2026-06-30T00:00:00.000Z'),
        now: new Date('2026-06-30T23:59:59.000Z'),
        politeDelayMs: 0,
      },
      directEfdFetch(urls),
    );

    expect(urls.some((u) => u.endsWith('/fetch-ptr'))).toBe(false);
    expect(urls.some((u) => u.endsWith('/search/report/data/'))).toBe(true);
    expect(out.map((f) => f.pipelineDocId)).toEqual(['S-direct-1']);
  });

  it('never sends the retired relay bearer to the eFD', async () => {
    // relaySecret is a fleet credential scoped to the relay. Now that requests
    // land on senate.gov, it must not ride along on any of them.
    const auths: Array<string | null> = [];
    const fetchImpl = async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      auths.push(new Headers(init?.headers).get('authorization'));
      return directEfdFetch([])(input, init);
    };

    await fetchSenatePtrFilings(
      {
        relayUrl: 'https://scout.jays.services',
        relaySecret: 'relay-test-secret',
        since: new Date('2026-06-30T00:00:00.000Z'),
        now: new Date('2026-06-30T23:59:59.000Z'),
        politeDelayMs: 0,
      },
      fetchImpl,
    );

    expect(auths.length).toBeGreaterThan(0);
    expect(auths.every((a) => a === null)).toBe(true);
  });

  it('warns that a configured relayUrl is being ignored', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fetchSenatePtrFilings(
      {
        relayUrl: 'https://scout.jays.services',
        since: new Date('2026-06-30T00:00:00.000Z'),
        now: new Date('2026-06-30T23:59:59.000Z'),
        politeDelayMs: 0,
      },
      directEfdFetch([]),
    );

    expect(
      warn.mock.calls.some(([msg]) => /scout.jays.services/.test(String(msg)) && /retired/.test(String(msg))),
    ).toBe(true);
    warn.mockRestore();
  });

  it('surfaces a direct eFD 404 rather than a relay error', async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: 'not found' }), { status: 404 });

    await expect(
      fetchSenatePtrFilings({ relayUrl: 'https://scout.jays.services', politeDelayMs: 0 }, fetchImpl),
    ).rejects.toThrow(/senate GET \/search\/ -> HTTP 404/);
  });
});

// CT-2442: since 2026-10-23 eFD's Akamai edge refuses the agreement POST and
// the data POST for automated clients.  These tests pin how the flow reports
// that, and that it never makes the situation worse.  All requests are mocks.
describe('Senate eFD edge deny (CT-2442)', () => {
  type Call = { url: string; method: string; egress: 'proxy' | 'direct'; cookie: string | null };

  function recordCall(calls: Call[], input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Call {
    const call: Call = {
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      egress: (init as { client?: unknown } | undefined)?.client ? 'proxy' : 'direct',
      cookie: new Headers(init?.headers).get('cookie'),
    };
    calls.push(call);
    return call;
  }

  function memoryKv(seed: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(seed));
    return {
      store,
      get: vi.fn(async (key: string, type?: string) => {
        const v = store.get(key) ?? null;
        return v !== null && type === 'json' ? JSON.parse(v) : v;
      }),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
    };
  }

  function okData(): Response {
    return new Response(JSON.stringify({
      data: [['Jane', 'Smith', '<a href="/search/view/ptr/edge-1/">Smith, Jane</a>', 'Periodic Transaction Report', '10/23/2026']],
      recordsFiltered: 1,
    }), { headers: { 'content-type': 'application/json' } });
  }

  const searchWindow = {
    since: new Date('2026-10-16T00:00:00.000Z'),
    now: new Date('2026-10-23T23:00:00.000Z'),
    politeDelayMs: 0,
  };

  beforeEach(() => {
    // Direct-only cases must not pick a proxy up from the runner's env.
    for (const key of ['RESIDENTIAL_PROXY_URL', 'SENATE_PROXY_URL', 'HTTPS_PROXY', 'HTTP_PROXY', 'RESIDENTIAL_PROXY_HOST']) {
      vi.stubEnv(key, '');
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('classification', () => {
    it('classifies a 403 from AkamaiGHost, or with Akamai\'s Access Denied page, as edge_denied', () => {
      expect(classifySenateHttpFailure(403, 'AkamaiGHost')).toBe('edge_denied');
      expect(classifySenateHttpFailure(403, null, AKAMAI_ACCESS_DENIED)).toBe('edge_denied');
      expect(looksLikeAkamaiAccessDenied(AKAMAI_ACCESS_DENIED)).toBe(true);
    });

    it('keeps an origin 403 and non-403 answers generic', () => {
      expect(classifySenateHttpFailure(403, 'gunicorn', '<h1>Forbidden (403)</h1><p>CSRF verification failed.</p>')).toBe('http');
      expect(classifySenateHttpFailure(503, 'AkamaiGHost', AKAMAI_ACCESS_DENIED)).toBe('http');
      expect(classifySenateHttpFailure(200, 'gunicorn')).toBe('http');
    });

    it('puts the Server header and the class into the message', () => {
      const edge = new SenateHttpError('POST /search/home/', 403, 'AkamaiGHost', { body: AKAMAI_ACCESS_DENIED });
      expect(edge.message).toBe('senate POST /search/home/ -> HTTP 403 (server=AkamaiGHost) [edge_denied]');
      expect(isSenateEdgeDeniedError(edge)).toBe(true);

      const origin = new SenateHttpError('POST report/data/', 403, 'gunicorn');
      expect(origin.message).toBe('senate POST report/data/ -> HTTP 403 (server=gunicorn)');
      expect(isSenateEdgeDeniedError(origin)).toBe(false);

      expect(new SenateHttpError('GET /search/', 404, null).message).toBe('senate GET /search/ -> HTTP 404 (server=unknown)');
      expect(isSenateEdgeDeniedError(new Error('senate POST /search/home/ -> HTTP 403'))).toBe(false);
    });
  });

  describe('establishSenateSession agreement check', () => {
    function handshake(agree: () => Response) {
      const calls: Call[] = [];
      const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const call = recordCall(calls, input, init);
        if (call.url.endsWith('/search/')) {
          return new Response(LANDING_HTML, {
            headers: { 'set-cookie': 'csrftoken=csrf-cookie; Path=/', server: 'gunicorn' },
          });
        }
        if (call.url.endsWith('/search/home/')) return agree();
        throw new Error(`unexpected URL: ${call.url}`);
      };
      return { calls, fetchImpl: fetchImpl as typeof fetch };
    }

    it('throws on an Akamai 403 agreement refusal and never caches the refused jar', async () => {
      const kv = memoryKv();
      const { fetchImpl } = handshake(akamaiDenied);

      const err = await establishSenateSession({ kv, politeDelayMs: 0 }, fetchImpl).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SenateHttpError);
      expect((err as Error).message).toBe('senate POST /search/home/ -> HTTP 403 (server=AkamaiGHost) [edge_denied]');
      expect(isSenateEdgeDeniedError(err)).toBe(true);
      expect(kv.put).not.toHaveBeenCalled();
    });

    it('accepts the normal 302 and caches that session', async () => {
      const kv = memoryKv();
      const { fetchImpl } = handshake(() =>
        new Response('', { status: 302, headers: { location: '/search/', 'set-cookie': 'sessionid=sess; Path=/' } }));

      const session = await establishSenateSession({ kv, politeDelayMs: 0 }, fetchImpl);

      expect(session.cookieHeader).toContain('sessionid=sess');
      expect(kv.put).toHaveBeenCalledTimes(1);
      expect(kv.put.mock.calls[0][0]).toBe(SENATE_SESSION_KV_KEY);
    });

    it('accepts a 200 only when the agreement form is gone', async () => {
      const kv = memoryKv();
      const { fetchImpl } = handshake(() =>
        new Response('<html><table id="filedReports"></table></html>', {
          status: 200,
          headers: { 'set-cookie': 'sessionid=sess; Path=/', server: 'gunicorn' },
        }));

      const session = await establishSenateSession({ kv, politeDelayMs: 0 }, fetchImpl);

      expect(session.cookieHeader).toContain('sessionid=sess');
      expect(kv.put).toHaveBeenCalledTimes(1);
    });

    it('rejects a 200 that still shows the agreement form (form far past the first 4 KB)', async () => {
      const kv = memoryKv();
      const wall = `<html><head>${'<meta name="pad">'.repeat(600)}</head><body>`
        + '<form id="agreement_form"><input type="checkbox" name="prohibition_agreement" value="1"></form></body></html>';
      const { fetchImpl } = handshake(() =>
        new Response(wall, { status: 200, headers: { server: 'gunicorn', 'content-type': 'text/html' } }));

      await expect(establishSenateSession({ kv, politeDelayMs: 0 }, fetchImpl)).rejects.toThrow(
        'senate POST /search/home/ -> HTTP 200 still shows the agreement form (server=gunicorn)',
      );
      expect(kv.put).not.toHaveBeenCalled();
    });

    it('fails closed on a 200 whose body cannot be read, and caches nothing', async () => {
      const kv = memoryKv();
      const { fetchImpl } = handshake(() =>
        new Response(new ReadableStream({ start(c) { c.error(new TypeError('connection reset')); } }), {
          status: 200,
          headers: { 'set-cookie': 'sessionid=sess; Path=/', server: 'gunicorn' },
        }));

      const err = await establishSenateSession({ kv, politeDelayMs: 0 }, fetchImpl).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SenateHttpError);
      expect((err as Error).message).toBe('senate POST /search/home/ -> HTTP 200 body unreadable (connection reset) (server=gunicorn)');
      expect(kv.put).not.toHaveBeenCalled();
    });

    it('fails closed on an agreement 200 page too long to check, without reading it all', async () => {
      const kv = memoryKv();
      let pulled = 0;
      let cancelled = false;
      const chunk = new TextEncoder().encode('<div>'.repeat(16 * 1024));
      const page = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          if (pulled > 100) controller.close();
          else controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      }, { highWaterMark: 0 });
      const { fetchImpl } = handshake(() =>
        new Response(page, { status: 200, headers: { 'set-cookie': 'sessionid=sess; Path=/', server: 'gunicorn' } }));

      const err = await establishSenateSession({ kv, politeDelayMs: 0 }, fetchImpl).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SenateHttpError);
      expect((err as Error).message).toBe(
        'senate POST /search/home/ -> HTTP 200 page longer than 262144 chars, not checked (server=gunicorn)',
      );
      expect(kv.put).not.toHaveBeenCalled();
      // 8 MB on offer, 80 KB per chunk: stops just past 256 KB.
      expect(pulled).toBeLessThanOrEqual(5);
      expect(cancelled).toBe(true);
    });

    it('still finds the agreement form deep inside a long page (past the first 4 KB, inside 256 KB)', async () => {
      const kv = memoryKv();
      const wall = `<html><head>${'<meta name="pad">'.repeat(8_000)}</head><body>`
        + '<form id="agreement_form"><input type="checkbox" name="prohibition_agreement" value="1"></form></body></html>';
      const { fetchImpl } = handshake(() =>
        new Response(wall, { status: 200, headers: { server: 'gunicorn', 'content-type': 'text/html' } }));

      await expect(establishSenateSession({ kv, politeDelayMs: 0 }, fetchImpl)).rejects.toThrow(
        'senate POST /search/home/ -> HTTP 200 still shows the agreement form (server=gunicorn)',
      );
      expect(kv.put).not.toHaveBeenCalled();
    });

    it('names the Server header on a refused landing GET', async () => {
      const fetchImpl = (async () => new Response('busy', { status: 503, headers: { server: 'gunicorn' } })) as typeof fetch;
      await expect(establishSenateSession({ politeDelayMs: 0 }, fetchImpl)).rejects.toThrow(
        'senate GET /search/ -> HTTP 503 (server=gunicorn)',
      );
    });
  });

  describe('egress order', () => {
    const PROXY = 'http://proxy.test:8888';

    function efd(calls: Call[], route: (call: Call) => Response | Promise<Response> | undefined) {
      return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const call = recordCall(calls, input, init);
        const routed = await route(call);
        if (routed) return routed;
        if (call.url.endsWith('/search/')) {
          return new Response(LANDING_HTML, { headers: { 'set-cookie': 'csrftoken=csrf-cookie; Path=/' } });
        }
        if (call.url.endsWith('/search/home/')) {
          return new Response('', { status: 302, headers: { 'set-cookie': 'sessionid=sess; Path=/' } });
        }
        if (call.url.endsWith('/search/report/data/')) return okData();
        throw new Error(`unexpected URL: ${call.url}`);
      }) as typeof fetch;
    }

    function connectRefused(): never {
      throw new TypeError(
        'error sending request for url (https://efdsearch.senate.gov/search/): client error (Connect): '
          + 'tcp connect error: Connection refused (os error 111)',
      );
    }

    it('goes through the configured proxy first and never dials direct when the proxy works', async () => {
      const calls: Call[] = [];
      const out = await fetchSenatePtrFilings({ ...searchWindow, proxyUrl: PROXY }, efd(calls, () => undefined));

      expect(out.map((f) => f.pipelineDocId)).toEqual(['S-edge-1']);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((c) => c.egress === 'proxy')).toBe(true);
    });

    it('does not retry direct when the proxy gets an HTTP answer (the edge deny)', async () => {
      const calls: Call[] = [];
      const fetchImpl = efd(calls, (c) => (c.url.endsWith('/search/home/') ? akamaiDenied() : undefined));

      const err = await fetchSenatePtrFilings({ ...searchWindow, proxyUrl: PROXY }, fetchImpl).catch((e: unknown) => e);

      expect(isSenateEdgeDeniedError(err)).toBe(true);
      expect(calls.map((c) => `${c.egress} ${c.method} ${new URL(c.url).pathname}`)).toEqual([
        'proxy GET /search/',
        'proxy POST /search/home/',
      ]);
    });

    it('falls back to direct when the proxy leg fails at the network level', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const calls: Call[] = [];
      const fetchImpl = efd(calls, (c) => (c.egress === 'proxy' ? connectRefused() : undefined));

      const out = await fetchSenatePtrFilings({ ...searchWindow, proxyUrl: PROXY }, fetchImpl);

      expect(out.map((f) => f.pipelineDocId)).toEqual(['S-edge-1']);
      expect(calls[0].egress).toBe('proxy');
      expect(calls.slice(1).length).toBeGreaterThan(0);
      expect(calls.slice(1).every((c) => c.egress === 'direct')).toBe(true);
      expect(warn.mock.calls.some(([msg]) => /proxy unreachable; the direct fallback reached eFD/.test(String(msg)))).toBe(true);
    });

    it('scrubs proxy URL userinfo and env proxy secrets from the proxy-unreachable warning', async () => {
      const proxyUrl = 'http://scrub-user:scrub-pass@10.2.3.4:8888';
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubEnv('RESIDENTIAL_PROXY_PASSWORD', 'scrub-pass');
      const calls: Call[] = [];
      const fetchImpl = efd(calls, (c) => {
        if (c.egress === 'proxy') {
          throw new TypeError('proxy tunnel failed (password scrub-pass in message)');
        }
        return undefined;
      });

      await fetchSenatePtrFilings({ ...searchWindow, proxyUrl }, fetchImpl);

      expect(warn.mock.calls.some(([msg, detail]) =>
        /proxy unreachable; the direct fallback reached eFD/.test(String(msg))
        && !/scrub-user|scrub-pass/.test(String(detail)))).toBe(true);
      warn.mockRestore();
      vi.unstubAllEnvs();
    });

    it('scrubs proxy URL userinfo and env proxy secrets from SenateProxyEgressError', async () => {
      const proxyUrl = 'http://scrub-user:scrub-pass@10.2.3.4:8888';
      vi.stubEnv('RESIDENTIAL_PROXY_PASSWORD', 'scrub-pass');
      const calls: Call[] = [];
      const fetchImpl = efd(calls, (c) => {
        if (c.egress === 'proxy') {
          throw new TypeError('proxy tunnel failed (password scrub-pass in message)');
        }
        if (c.egress === 'direct' && c.url.endsWith('/search/')) return akamaiDenied();
        return undefined;
      });

      const err = await fetchSenatePtrFilings({ ...searchWindow, proxyUrl }, fetchImpl).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SenateProxyEgressError);
      expect((err as Error).message).not.toMatch(/scrub-user|scrub-pass/);
      vi.unstubAllEnvs();
    });

    /** A black-holed proxy: no answer, ever, until the request's signal aborts. */
    function hangUntilAborted(signal: AbortSignal | null | undefined): Promise<Response> {
      return new Promise((_resolve, reject) => {
        if (!signal) return;
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }

    it('falls back to direct when a hung proxy gives no answer before its first-answer deadline', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const calls: Call[] = [];
      const direct = efd(calls, () => undefined);
      const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (!(init as { client?: unknown } | undefined)?.client) return direct(input, init);
        recordCall(calls, input, init);
        return hangUntilAborted(init?.signal);
      }) as typeof fetch;
      // pollSenate's 7 s source budget, still running when the proxy deadline fires.
      const budget = new AbortController();

      const out = await fetchSenatePtrFilings(
        { ...searchWindow, proxyUrl: PROXY, proxyFirstAnswerTimeoutMs: 20, signal: budget.signal },
        fetchImpl,
      );

      expect(out.map((f) => f.pipelineDocId)).toEqual(['S-edge-1']);
      expect(calls.map((c) => c.egress)).toEqual(['proxy', 'direct', 'direct', 'direct']);
      expect(warn.mock.calls.some(([msg, detail]) =>
        /proxy unreachable; the direct fallback reached eFD/.test(String(msg))
        && /senate proxy gave no HTTP answer within 20ms/.test(String(detail)))).toBe(true);
    });

    it('falls back to direct when the proxy answers the landing GET and then black-holes the agreement POST', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const calls: Call[] = [];
      const answers = efd(calls, () => undefined);
      const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const proxied = Boolean((init as { client?: unknown } | undefined)?.client);
        if (proxied && String(input).endsWith('/search/home/')) {
          recordCall(calls, input, init);
          return hangUntilAborted(init?.signal);
        }
        return answers(input, init);
      }) as typeof fetch;
      const budget = new AbortController();

      const out = await fetchSenatePtrFilings(
        { ...searchWindow, proxyUrl: PROXY, proxyFirstAnswerTimeoutMs: 20, signal: budget.signal },
        fetchImpl,
      );

      expect(out.map((f) => f.pipelineDocId)).toEqual(['S-edge-1']);
      expect(calls.map((c) => `${c.egress} ${c.method} ${new URL(c.url).pathname}`)).toEqual([
        'proxy GET /search/',
        'proxy POST /search/home/',
        'direct GET /search/',
        'direct POST /search/home/',
        'direct POST /search/report/data/',
      ]);
      expect(warn.mock.calls.some(([msg, detail]) =>
        /proxy unreachable; the direct fallback reached eFD/.test(String(msg))
        && /senate proxy gave no HTTP answer within 20ms/.test(String(detail)))).toBe(true);
    });

    it('bounds the data POST through the proxy too', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const calls: Call[] = [];
      const answers = efd(calls, () => undefined);
      const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const proxied = Boolean((init as { client?: unknown } | undefined)?.client);
        if (proxied && String(input).endsWith('/search/report/data/')) {
          recordCall(calls, input, init);
          return hangUntilAborted(init?.signal);
        }
        return answers(input, init);
      }) as typeof fetch;

      const out = await fetchSenatePtrFilings({ ...searchWindow, proxyUrl: PROXY, proxyFirstAnswerTimeoutMs: 20 }, fetchImpl);

      expect(out.map((f) => f.pipelineDocId)).toEqual(['S-edge-1']);
      expect(calls.map((c) => c.egress)).toEqual(['proxy', 'proxy', 'proxy', 'direct', 'direct', 'direct']);
    });

    it('keeps a proxy whose every answer beats the deadline, however long the whole leg takes', async () => {
      const calls: Call[] = [];
      const answers = efd(calls, () => undefined);
      const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        // 25 ms per answer under a 60 ms deadline: the leg takes longer than
        // one deadline, but no single request does.
        await new Promise((resolve) => setTimeout(resolve, 25));
        return answers(input, init);
      }) as typeof fetch;

      const out = await fetchSenatePtrFilings({ ...searchWindow, proxyUrl: PROXY, proxyFirstAnswerTimeoutMs: 60 }, fetchImpl);

      expect(out.map((f) => f.pipelineDocId)).toEqual(['S-edge-1']);
      expect(calls.map((c) => `${c.egress} ${c.method} ${new URL(c.url).pathname}`)).toEqual([
        'proxy GET /search/',
        'proxy POST /search/home/',
        'proxy POST /search/report/data/',
      ]);
    });

    it('never cuts a proxied body read short: the deadline covers only the wait for headers', async () => {
      const calls: Call[] = [];
      const answers = efd(calls, () => undefined);
      const bytes = new TextEncoder().encode(JSON.stringify({
        data: [['Jane', 'Smith', '<a href="/search/view/ptr/slow-1/">Smith, Jane</a>', 'Periodic Transaction Report', '10/23/2026']],
        recordsFiltered: 1,
      }));
      const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (!String(input).endsWith('/search/report/data/')) return answers(input, init);
        recordCall(calls, input, init);
        // Headers at once, the JSON body 80 ms later, past the 20 ms deadline.
        // Like a real fetch, an abort of the request signal fails the body.
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const timer = setTimeout(() => {
              controller.enqueue(bytes);
              controller.close();
            }, 80);
            signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              controller.error(signal.reason);
            }, { once: true });
          },
        });
        return new Response(body, { headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      const out = await fetchSenatePtrFilings({ ...searchWindow, proxyUrl: PROXY, proxyFirstAnswerTimeoutMs: 20 }, fetchImpl);

      expect(out.map((f) => f.pipelineDocId)).toEqual(['S-slow-1']);
      expect(calls.every((c) => c.egress === 'proxy')).toBe(true);
    });

    it('runs direct only, with the shared KV session, when no proxy client can be created', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const kv = memoryKv({ [SENATE_SESSION_KV_KEY]: JSON.stringify({ csrfCookie: 'c', cookieHeader: 'csrftoken=c; sessionid=shared' }) });
      const calls: Call[] = [];
      const answers = efd(calls, () => undefined);
      // Every answer takes 50 ms, past the 20 ms proxy answer deadline, and a
      // request aborts as a real fetch would.
      const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 50);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(init.signal!.reason);
          }, { once: true });
        });
        return answers(input, init);
      }) as typeof fetch;
      const opts = { ...searchWindow, proxyUrl: NO_CLIENT_PROXY, proxyFirstAnswerTimeoutMs: 20, kv };

      const first = await fetchSenatePtrFilings(opts, fetchImpl);
      await fetchSenatePtrFilings(opts, fetchImpl);

      expect(first.map((f) => f.pipelineDocId)).toEqual(['S-edge-1']);
      // Not a "proxy" leg on the base fetch, which would get the proxy's answer
      // deadline and then a second, sessionless direct try: direct only,
      // reusing the shared session as a direct-only egress does.
      expect(calls.map((c) => `${c.egress} ${c.method} ${new URL(c.url).pathname}`)).toEqual([
        'direct POST /search/report/data/',
        'direct POST /search/report/data/',
      ]);
      expect(calls.every((c) => (c.cookie ?? '').includes('sessionid=shared'))).toBe(true);
      // Logged once, without the proxy URL.
      const lines = warn.mock.calls.filter(([msg]) => /proxy HTTP client could not be created/.test(String(msg)));
      expect(lines).toHaveLength(1);
      expect(lines[0].join(' ')).not.toContain('no-client.test');
    });

    it('scrubs a decoded proxy password from the warning using the proxy URL alone (no env)', async () => {
      // Production resolves the proxy URL from Infisical into the env binding,
      // so the process env has no username or password to match.
      const proxyUrl = 'http://scrub-user:p%40ss-w0rd@10.2.3.4:8888';
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const calls: Call[] = [];
      const fetchImpl = efd(calls, (c) => {
        if (c.egress === 'proxy') throw new TypeError('proxy auth failed for scrub-user with p@ss-w0rd');
        return undefined;
      });

      await fetchSenatePtrFilings({ ...searchWindow, proxyUrl }, fetchImpl);

      const line = warn.mock.calls.find(([msg]) => /proxy unreachable; the direct fallback reached eFD/.test(String(msg)));
      expect(line).toBeDefined();
      expect(String(line![1])).toBe('proxy auth failed for [redacted] with [redacted]');
    });

    it('reads only the start of a large error body and cancels the rest', async () => {
      let pulled = 0;
      let cancelled = false;
      const chunk = new TextEncoder().encode(`${'x'.repeat(64 * 1024)}`);
      const big = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          if (pulled > 64) controller.close();
          else controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      }, { highWaterMark: 0 });
      const calls: Call[] = [];
      const fetchImpl = efd(calls, (c) => (c.url.endsWith('/search/report/data/')
        ? new Response(big, { status: 403, headers: { server: 'AkamaiGHost', 'content-type': 'text/html' } })
        : undefined));

      const err = await fetchSenatePtrFilings(searchWindow, fetchImpl).catch((e: unknown) => e);

      expect(isSenateEdgeDeniedError(err)).toBe(true);
      // 4 MB on offer; one 64 KB chunk covers the 4,096-char snippet.
      expect(pulled).toBeLessThanOrEqual(2);
      expect(cancelled).toBe(true);
    });

    it('does not fall back when the source budget itself runs out on the proxy leg', async () => {
      const calls: Call[] = [];
      const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        recordCall(calls, input, init);
        return hangUntilAborted(init?.signal);
      }) as typeof fetch;
      const budget = new AbortController();
      setTimeout(() => budget.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), 10);

      const err = await fetchSenatePtrFilings(
        { ...searchWindow, proxyUrl: PROXY, proxyFirstAnswerTimeoutMs: 1_000, signal: budget.signal },
        fetchImpl,
      ).catch((e: unknown) => e);

      expect((err as Error).name).toBe('TimeoutError');
      expect(calls.map((c) => c.egress)).toEqual(['proxy']);
    });

    it('does not fall back on a TypeError from the leg\'s own code once the proxy answered', async () => {
      const calls: Call[] = [];
      const fetchImpl = efd(calls, (c) => {
        if (!c.url.endsWith('/search/report/data/')) return undefined;
        // An answer came back; reading it fails in our code, not in the proxy.
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => { throw new TypeError("Cannot read properties of undefined (reading 'data')"); },
        } as unknown as Response;
      });

      const err = await fetchSenatePtrFilings({ ...searchWindow, proxyUrl: PROXY }, fetchImpl).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(TypeError);
      expect(err).not.toBeInstanceOf(SenateProxyEgressError);
      expect(calls.every((c) => c.egress === 'proxy')).toBe(true);
    });

    it('a direct fallback failure never touches the proxy-made KV session and names the proxy outage', async () => {
      const proxySession = JSON.stringify({ csrfCookie: 'proxy-csrf', cookieHeader: 'csrftoken=proxy-csrf; sessionid=proxy-made' });
      const kv = memoryKv({ [SENATE_SESSION_KV_KEY]: proxySession });
      const calls: Call[] = [];
      const fetchImpl = efd(calls, (c) => {
        if (c.egress === 'proxy') connectRefused();
        // The box egress: Akamai's SERVE_403 even for GET.
        return akamaiDenied();
      });

      const err = await fetchSenatePtrFilings({ ...searchWindow, proxyUrl: PROXY, kv }, fetchImpl).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SenateProxyEgressError);
      expect((err as Error).message).toMatch(
        /^senate proxy egress unreachable \(error sending request.*Connection refused.*\); direct fallback failed: senate GET \/search\/ -> HTTP 403 \(server=AkamaiGHost\)$/,
      );
      // A proxy outage is not an eFD edge deny: no long backoff for it.
      expect(isSenateEdgeDeniedError(err)).toBe(false);
      expect(kv.delete).not.toHaveBeenCalled();
      expect(kv.put).not.toHaveBeenCalled();
      expect(kv.store.get(SENATE_SESSION_KV_KEY)).toBe(proxySession);
      const direct = calls.filter((c) => c.egress === 'direct');
      expect(direct.length).toBeGreaterThan(0);
      expect(direct.every((c) => !(c.cookie ?? '').includes('sessionid=proxy-made'))).toBe(true);
    });

    it('an edge deny on the data POST keeps the cached session and does not re-handshake or retry', async () => {
      const cached = JSON.stringify({ csrfCookie: 'c', cookieHeader: 'csrftoken=c; sessionid=s' });
      const kv = memoryKv({ [SENATE_SESSION_KV_KEY]: cached });
      const calls: Call[] = [];
      const fetchImpl = efd(calls, (c) => (c.url.endsWith('/search/report/data/') ? akamaiDenied() : undefined));

      const err = await fetchSenatePtrFilings({ ...searchWindow, kv }, fetchImpl).catch((e: unknown) => e);

      expect((err as Error).message).toBe('senate POST report/data/ -> HTTP 403 (server=AkamaiGHost) [edge_denied]');
      expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/search/report/data/']);
      expect(kv.delete).not.toHaveBeenCalled();
      expect(kv.store.get(SENATE_SESSION_KV_KEY)).toBe(cached);
    });

    it('still re-negotiates a cached session the origin rejects (not an edge deny)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const kv = memoryKv({ [SENATE_SESSION_KV_KEY]: JSON.stringify({ csrfCookie: 'old', cookieHeader: 'sessionid=old' }) });
      const calls: Call[] = [];
      let dataPosts = 0;
      const fetchImpl = efd(calls, (c) => {
        if (!c.url.endsWith('/search/report/data/')) return undefined;
        dataPosts += 1;
        return dataPosts === 1
          ? new Response('<h1>Forbidden (403)</h1>', { status: 403, headers: { server: 'gunicorn', 'content-type': 'text/html' } })
          : okData();
      });

      const out = await fetchSenatePtrFilings({ ...searchWindow, kv }, fetchImpl);

      expect(out.map((f) => f.pipelineDocId)).toEqual(['S-edge-1']);
      expect(kv.delete).toHaveBeenCalledWith(SENATE_SESSION_KV_KEY);
      expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
        '/search/report/data/', '/search/', '/search/home/', '/search/report/data/',
      ]);
      expect(warn.mock.calls.some(([msg]) => /cached session invalid \(HTTP 403 text\/html, server=gunicorn\)/.test(String(msg)))).toBe(true);
    });
  });

  // CT-2416 (#2850): the same edge deny told apart by its page alone, for an
  // edge answer whose Server header is missing or rewritten.  Folded into the
  // one classifier (classifySenateHttpFailure) and the watcher's one backoff.
  describe('Akamai deny page without a Server header', () => {
    const AKAMAI_403 = `<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>\n<H1>Access Denied</H1>\n`
      + `You don't have permission to access "http://efdsearch.senate.gov/search/report/data/" on this server.<P>\n`
      + `Reference #18.6a2e3e17.1761300000.1a2b3c4d\n<P>https://errors.edgesuite.net/18.6a2e3e17.1761300000.1a2b3c4d</P>\n</BODY></HTML>`;
    const now = new Date('2026-10-23T23:00:00.000Z');

    function efdPaths(opts: { agree?: () => Response; data?: () => Response }, calls: string[]) {
      return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
        const url = String(input);
        calls.push(`${init?.method ?? 'GET'} ${url.replace('https://efdsearch.senate.gov', '')}`);
        if (url.endsWith('/search/')) {
          return new Response(`<input type="hidden" name="csrfmiddlewaretoken" value="t">`, {
            headers: { 'set-cookie': 'csrftoken=c; Path=/' },
          });
        }
        if (url.endsWith('/search/home/')) return opts.agree ? opts.agree() : new Response('', { status: 302 });
        if (url.endsWith('/search/report/data/')) {
          return opts.data
            ? opts.data()
            : new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`unexpected URL ${url}`);
      };
    }

    it('recognises the Akamai Access Denied page but not a plain 403', () => {
      expect(looksLikeAkamaiAccessDenied(AKAMAI_403)).toBe(true);
      expect(looksLikeAkamaiAccessDenied('<title>Access Denied</title>')).toBe(true);
      expect(looksLikeAkamaiAccessDenied('Forbidden')).toBe(false);
      expect(looksLikeAkamaiAccessDenied('')).toBe(false);
    });

    it('classifies a refused agreement POST as edge_denied from the page alone, and caches nothing', async () => {
      const calls: string[] = [];
      const kv = memoryKv();
      const fetchImpl = efdPaths({ agree: () => new Response(AKAMAI_403, { status: 403 }) }, calls);

      const err = await establishSenateSession({ kv, politeDelayMs: 0 }, fetchImpl as typeof fetch).catch((e: unknown) => e);

      expect(isSenateEdgeDeniedError(err)).toBe(true);
      expect((err as Error).message).toBe('senate POST /search/home/ -> HTTP 403 (server=unknown) [edge_denied]');
      expect(kv.put).not.toHaveBeenCalled();
    });

    it('does not redo the handshake when a cached session hits the deny page, and writes no backoff of its own', async () => {
      const calls: string[] = [];
      const kv = memoryKv({ [SENATE_SESSION_KV_KEY]: JSON.stringify({ csrfCookie: 'c', cookieHeader: 'sessionid=s' }) });
      const fetchImpl = efdPaths({ data: () => new Response(AKAMAI_403, { status: 403 }) }, calls);

      const err = await fetchSenatePtrFilings({ kv, now, politeDelayMs: 0 }, fetchImpl).catch((e: unknown) => e);

      expect(isSenateEdgeDeniedError(err)).toBe(true);
      expect((err as Error).message).toBe('senate POST report/data/ -> HTTP 403 (server=unknown) [edge_denied]');
      // One data POST: no landing GET / agreement POST retry, no direct-egress retries.
      expect(calls).toEqual(['POST /search/report/data/']);
      // The source keeps no backoff state: runWatcher owns the one backoff
      // (CONFIG_KV senate_edge_deny:backoff), and the cached session stays.
      expect(kv.put).not.toHaveBeenCalled();
      expect(kv.delete).not.toHaveBeenCalled();
    });

    it('still retries a generic (non-Akamai) 403 with a fresh handshake', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const calls: string[] = [];
      const kv = memoryKv({ [SENATE_SESSION_KV_KEY]: JSON.stringify({ csrfCookie: 'c', cookieHeader: 'sessionid=s' }) });
      let n = 0;
      const fetchImpl = efdPaths({
        data: () => (n++ === 0
          ? new Response('Forbidden', { status: 403 })
          : new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } })),
      }, calls);

      await fetchSenatePtrFilings({ kv, now, politeDelayMs: 0 }, fetchImpl);

      expect(calls).toEqual(['POST /search/report/data/', 'GET /search/', 'POST /search/home/', 'POST /search/report/data/']);
    });
  });
});
