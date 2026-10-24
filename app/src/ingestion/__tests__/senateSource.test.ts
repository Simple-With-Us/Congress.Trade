import { describe, it, expect, vi } from 'vitest';
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
  SENATE_AKAMAI_BLOCK_KV_KEY,
  SenateAkamaiBlockError,
  looksLikeAkamaiAccessDenied,
} from '../senateSource.ts';

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

// CT-2416: efdsearch.senate.gov fronts POSTs with Akamai Bot Manager.
describe('Akamai anti-bot block', () => {
  const AKAMAI_403 = `<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>\n<H1>Access Denied</H1>\n`
    + `You don't have permission to access "http://efdsearch.senate.gov/search/report/data/" on this server.<P>\n`
    + `Reference #18.6a2e3e17.1761300000.1a2b3c4d\n<P>https://errors.edgesuite.net/18.6a2e3e17.1761300000.1a2b3c4d</P>\n</BODY></HTML>`;
  const now = new Date('2026-10-23T23:00:00.000Z');

  function memKv(seed: Record<string, string> = {}) {
    const m = new Map<string, string>(Object.entries(seed));
    return {
      m,
      async get(key: string, type?: string) {
        const v = m.get(key);
        if (v == null) return null;
        return type === 'json' ? JSON.parse(v) : v;
      },
      async put(key: string, value: string) {
        m.set(key, value);
      },
      async delete(key: string) {
        m.delete(key);
      },
    };
  }

  function efd(opts: { agree?: () => Response; data?: () => Response }, calls: string[]) {
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

  it('throws the distinct Akamai error when the agreement POST is refused', async () => {
    const calls: string[] = [];
    const fetchImpl = efd({ agree: () => new Response(AKAMAI_403, { status: 403 }) }, calls);
    await expect(establishSenateSession({ politeDelayMs: 0 }, fetchImpl as typeof fetch)).rejects.toThrow(
      'senate eFD anti-bot block (Akamai): POST /search/home/ -> HTTP 403',
    );
  });

  it('does not redo the handshake when a cached session hits an Akamai 403, and backs off', async () => {
    const calls: string[] = [];
    const kv = memKv({ [SENATE_SESSION_KV_KEY]: JSON.stringify({ csrfCookie: 'c', cookieHeader: 'sessionid=s' }) });
    const fetchImpl = efd({ data: () => new Response(AKAMAI_403, { status: 403 }) }, calls);
    const err = await fetchSenatePtrFilings({ kv, now, politeDelayMs: 0 }, fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(SenateAkamaiBlockError);
    expect((err as SenateAkamaiBlockError).cached).toBe(false);
    expect(String((err as Error).message)).toContain('senate eFD anti-bot block (Akamai)');
    // One data POST, no landing GET / agreement POST retry, no direct-egress backoff retries.
    expect(calls).toEqual(['POST /search/report/data/']);
    const block = JSON.parse(kv.m.get(SENATE_AKAMAI_BLOCK_KV_KEY)!);
    expect(block.step).toBe('POST report/data/');
    expect(Date.parse(block.until)).toBe(now.getTime() + 30 * 60_000);

    // Next tick inside the backoff window: no eFD traffic at all.
    calls.length = 0;
    const again = await fetchSenatePtrFilings(
      { kv, now: new Date(now.getTime() + 5 * 60_000), politeDelayMs: 0 },
      fetchImpl,
    ).catch((e) => e);
    expect(again).toBeInstanceOf(SenateAkamaiBlockError);
    expect((again as SenateAkamaiBlockError).cached).toBe(true);
    expect(calls).toEqual([]);
  });

  it('dials eFD again once the backoff expires', async () => {
    const calls: string[] = [];
    const kv = memKv({
      [SENATE_AKAMAI_BLOCK_KV_KEY]: JSON.stringify({ until: new Date(now.getTime() - 1).toISOString(), step: 'x' }),
    });
    const out = await fetchSenatePtrFilings({ kv, now, politeDelayMs: 0 }, efd({}, calls));
    expect(out).toEqual([]);
    expect(calls).toContain('POST /search/report/data/');
  });

  it('still retries a generic (non-Akamai) 403 with a fresh handshake', async () => {
    const calls: string[] = [];
    const kv = memKv({ [SENATE_SESSION_KV_KEY]: JSON.stringify({ csrfCookie: 'c', cookieHeader: 'sessionid=s' }) });
    let n = 0;
    const fetchImpl = efd({
      data: () => (n++ === 0
        ? new Response('Forbidden', { status: 403 })
        : new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } })),
    }, calls);
    await fetchSenatePtrFilings({ kv, now, politeDelayMs: 0 }, fetchImpl);
    expect(calls).toEqual(['POST /search/report/data/', 'GET /search/', 'POST /search/home/', 'POST /search/report/data/']);
    expect(kv.m.has(SENATE_AKAMAI_BLOCK_KV_KEY)).toBe(false);
  });
});
