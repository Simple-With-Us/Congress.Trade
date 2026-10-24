import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/thirdPartyTelemetry.ts', () => ({
  trackedFetch: (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    _descriptor: unknown,
    fetchImpl: typeof fetch = fetch,
  ) => fetchImpl(input, init),
}));
import { establishSenateSession, SENATE_SEARCH } from '../senateSource.ts';
import {
  probeSenateEfdThroughProxy,
  refreshSenateEfdProxyProbe,
  SENATE_EFD_PROXY_PROBE_INTERVAL_MS,
  SenateEfdResponseBodySchema,
} from '../residentialProxyHealth.ts';
import { readSenateEfdProbe, SENATE_EFD_HEALTH_KV_KEY } from '../senateEfdHealth.ts';
import {
  nextSenateEdgeBackoff,
  SENATE_EDGE_BACKOFF_KV_KEY,
  SENATE_EDGE_BACKOFF_INITIAL_MS,
} from '../senateEdgeDeny.ts';
import type { Env } from '../../shared/types.ts';

const PROXY = 'http://10.99.0.2:8888';
const AKAMAI_403 = `<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>\n<H1>Access Denied</H1>\n`
  + `You don't have permission to access "http://efdsearch.senate.gov/search/home/" on this server.<P>\n`
  + `Reference #18.6a2e3e17.1761300000.1a2b3c4d\n<P>https://errors.edgesuite.net/18.6a2e3e17.1761300000.1a2b3c4d</P>\n</BODY></HTML>`;
const LANDING = `<form><input type="hidden" name="csrfmiddlewaretoken" value="csrf-hidden"></form>`;

function efdFetch(agree: () => Response, calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === SENATE_SEARCH) {
      return new Response(LANDING, { status: 200, headers: { 'set-cookie': 'csrftoken=csrf-cookie; Path=/' } });
    }
    if (url.endsWith('/search/home/')) return agree();
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;
}

function memEnv(): { env: Env; kv: Map<string, string> } {
  const kv = new Map<string, string>();
  const CONFIG_KV = {
    async get(key: string, type?: string) {
      const v = kv.get(key);
      if (v == null) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      kv.set(key, value);
    },
  };
  return { env: { CONFIG_KV } as unknown as Env, kv };
}

describe('probeSenateEfdThroughProxy (CT-2416)', () => {
  it('is ok when the landing GET has a token and the agreement POST returns 302', async () => {
    const calls: string[] = [];
    const rec = await probeSenateEfdThroughProxy(PROXY, efdFetch(() => new Response('', { status: 302 }), calls), 1000);
    expect(rec).toMatchObject({ ok: true, state: 'ok', status: 302, egress: 'proxy', dialed: true });
    expect(calls).toEqual([`GET ${SENATE_SEARCH}`, 'POST https://efdsearch.senate.gov/search/home/']);
  });

  it('is blocked when the agreement POST returns the Akamai Access Denied page', async () => {
    const rec = await probeSenateEfdThroughProxy(PROXY, efdFetch(() => new Response(AKAMAI_403, { status: 403 })), 1000);
    expect(rec).toMatchObject({ ok: false, state: 'blocked', status: 403, step: 'POST /search/home/' });
  });

  it('is blocked when the landing GET itself is an Akamai 403', async () => {
    const fetchImpl = (async () => new Response(AKAMAI_403, { status: 403 })) as typeof fetch;
    const rec = await probeSenateEfdThroughProxy(PROXY, fetchImpl, 1000);
    expect(rec).toMatchObject({ state: 'blocked', step: 'GET /search/' });
  });

  it('is blocked on a 403 the Akamai edge sent (Server: AkamaiGHost), whatever the body', async () => {
    // The same classifier as ingestion (classifySenateHttpFailure), so the
    // probe and the watcher's backoff never disagree about an edge deny.
    const rec = await probeSenateEfdThroughProxy(
      PROXY,
      efdFetch(() => new Response('', { status: 403, headers: { server: 'AkamaiGHost' } })),
      1000,
    );
    expect(rec).toMatchObject({ state: 'blocked', status: 403, step: 'POST /search/home/' });
    expect(rec.error).toContain('server=AkamaiGHost');
  });

  it('is degraded (not blocked) for a non-Akamai 403', async () => {
    const rec = await probeSenateEfdThroughProxy(PROXY, efdFetch(() => new Response('Forbidden', { status: 403 })), 1000);
    expect(rec).toMatchObject({ state: 'degraded', status: 403 });
  });

  it('is degraded (not blocked) for an origin 403 (Server: gunicorn, a CSRF failure)', async () => {
    const rec = await probeSenateEfdThroughProxy(
      PROXY,
      efdFetch(() => new Response('<h1>Forbidden (403)</h1>', { status: 403, headers: { server: 'gunicorn' } })),
      1000,
    );
    expect(rec).toMatchObject({ state: 'degraded', status: 403, error: 'HTTP 403 (server=gunicorn)' });
  });

  it('judges the agreement POST the way establishSenateSession does', async () => {
    const wall = '<form id="agreement_form"><input type="checkbox" name="prohibition_agreement" value="1"></form>';
    const refused = await probeSenateEfdThroughProxy(PROXY, efdFetch(() => new Response(wall, { status: 200 })), 1000);
    expect(refused).toMatchObject({ ok: false, state: 'degraded', status: 200, error: 'eFD still shows the agreement form' });

    const accepted = await probeSenateEfdThroughProxy(
      PROXY, efdFetch(() => new Response('<table id="filedReports"></table>', { status: 200 })), 1000,
    );
    expect(accepted).toMatchObject({ ok: true, state: 'ok', status: 200 });

    const redirected = await probeSenateEfdThroughProxy(PROXY, efdFetch(() => new Response('', { status: 303 })), 1000);
    expect(redirected).toMatchObject({ ok: true, state: 'ok', status: 303 });
  });

  it('is degraded when the landing page has no csrf token', async () => {
    const fetchImpl = (async () => new Response('<html></html>', { status: 200 })) as typeof fetch;
    const rec = await probeSenateEfdThroughProxy(PROXY, fetchImpl, 1000);
    expect(rec).toMatchObject({ state: 'degraded', error: 'eFD landing has no csrf token' });
  });

  it('is degraded on a relay/transport error', async () => {
    const fetchImpl = (async () => {
      throw new Error('Connection refused');
    }) as typeof fetch;
    const rec = await probeSenateEfdThroughProxy(PROXY, fetchImpl, 1000);
    expect(rec.state).toBe('degraded');
    expect(rec.error).toContain('Connection refused');
  });
});

describe('refreshSenateEfdProxyProbe', () => {
  const now = new Date('2026-10-23T23:00:00.000Z');

  it('records degraded without dialing eFD when the proxy is down', async () => {
    const { env } = memEnv();
    const fetchImpl = vi.fn();
    await refreshSenateEfdProxyProbe(env, now, { proxyUrl: PROXY, proxyReachable: false }, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readSenateEfdProbe(env)).toMatchObject({ state: 'degraded', error: 'residential proxy down', dialed: false });
  });

  it('dials eFD at most once per 30 minutes', async () => {
    // Each dial is one agreement POST, the request eFD's edge refuses for
    // automated clients (CT-2442), so the interval never drops below 30m.
    expect(SENATE_EFD_PROXY_PROBE_INTERVAL_MS).toBeGreaterThanOrEqual(30 * 60_000);
    const { env, kv } = memEnv();
    const calls: string[] = [];
    const fetchImpl = efdFetch(() => new Response('Service Unavailable', { status: 503 }), calls);
    await refreshSenateEfdProxyProbe(env, now, { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(kv.get(SENATE_EFD_HEALTH_KV_KEY)!).state).toBe('degraded');

    for (const min of [5, 15, 29]) {
      await refreshSenateEfdProxyProbe(
        env, new Date(now.getTime() + min * 60_000), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl,
      );
    }
    expect(calls).toHaveLength(2);

    await refreshSenateEfdProxyProbe(
      env, new Date(now.getTime() + SENATE_EFD_PROXY_PROBE_INTERVAL_MS), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl,
    );
    expect(calls).toHaveLength(4);
  });

  it('dials on relay recovery when eFD has never been dialed', async () => {
    const { env } = memEnv();
    const calls: string[] = [];
    const fetchImpl = efdFetch(() => new Response('', { status: 302 }), calls);
    await refreshSenateEfdProxyProbe(env, now, { proxyUrl: PROXY, proxyReachable: false }, fetchImpl);
    await refreshSenateEfdProxyProbe(env, new Date(now.getTime() + 60_000), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    expect(calls).toHaveLength(2);
    expect(await readSenateEfdProbe(env)).toMatchObject({ state: 'ok', lastDialedAt: new Date(now.getTime() + 60_000).toISOString() });
  });

  it('a relay flap does not reset the 30-minute throttle', async () => {
    const { env } = memEnv();
    const calls: string[] = [];
    const fetchImpl = efdFetch(() => new Response('', { status: 302 }), calls);
    const at = (min: number) => new Date(now.getTime() + min * 60_000);
    await refreshSenateEfdProxyProbe(env, at(0), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    expect(calls).toHaveLength(2);
    await refreshSenateEfdProxyProbe(env, at(2), { proxyUrl: PROXY, proxyReachable: false }, fetchImpl);
    expect(await readSenateEfdProbe(env)).toMatchObject({ state: 'degraded', lastDialedAt: at(0).toISOString() });
    await refreshSenateEfdProxyProbe(env, at(4), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    await refreshSenateEfdProxyProbe(env, at(29), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    expect(calls).toHaveLength(2);
    await refreshSenateEfdProxyProbe(env, at(30), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    expect(calls).toHaveLength(4);
  });

  it('an Akamai block keeps the same 30-minute interval (no separate probe backoff)', async () => {
    const { env } = memEnv();
    const calls: string[] = [];
    const fetchImpl = efdFetch(() => new Response(AKAMAI_403, { status: 403 }), calls);
    const at = (min: number) => new Date(now.getTime() + min * 60_000);
    await refreshSenateEfdProxyProbe(env, at(0), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    expect(calls).toHaveLength(2);
    expect(await readSenateEfdProbe(env)).toMatchObject({ state: 'blocked' });
    await refreshSenateEfdProxyProbe(env, at(15), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    await refreshSenateEfdProxyProbe(env, at(29), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    expect(calls).toHaveLength(2);
    await refreshSenateEfdProxyProbe(env, at(30), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    expect(calls).toHaveLength(4);
  });

  it('does not dial eFD while the watcher\'s edge-deny backoff is active, then resumes', async () => {
    const { env, kv } = memEnv();
    const calls: string[] = [];
    const fetchImpl = efdFetch(() => new Response('', { status: 302 }), calls);
    const at = (min: number) => new Date(now.getTime() + min * 60_000);
    // The watcher was edge-denied at `now`: a 60-minute window.
    const backoff = nextSenateEdgeBackoff(null, now, 'senate POST /search/home/ -> HTTP 403 (server=AkamaiGHost) [edge_denied]');
    kv.set(SENATE_EDGE_BACKOFF_KV_KEY, JSON.stringify(backoff));

    for (const min of [0, 30, 59]) {
      await refreshSenateEfdProxyProbe(env, at(min), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    }
    expect(calls).toEqual([]);
    // Nothing dialed, so nothing recorded: pipelineHealth reads the backoff itself.
    expect(kv.has(SENATE_EFD_HEALTH_KV_KEY)).toBe(false);

    await refreshSenateEfdProxyProbe(
      env, at(SENATE_EDGE_BACKOFF_INITIAL_MS / 60_000), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl,
    );
    expect(calls).toHaveLength(2);
    expect(await readSenateEfdProbe(env)).toMatchObject({ state: 'ok', dialed: true });
  });

  it('still records a relay outage during the backoff (no eFD dial)', async () => {
    const { env, kv } = memEnv();
    const fetchImpl = vi.fn();
    kv.set(SENATE_EDGE_BACKOFF_KV_KEY, JSON.stringify(nextSenateEdgeBackoff(null, now, 'edge denied')));
    await refreshSenateEfdProxyProbe(env, now, { proxyUrl: PROXY, proxyReachable: false }, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readSenateEfdProbe(env)).toMatchObject({ state: 'degraded', error: 'residential proxy down', dialed: false });
  });

  it('a transport error still counts against the 30-minute throttle', async () => {
    const { env } = memEnv();
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      throw new Error('connection reset by peer');
    }) as typeof fetch;
    const at = (min: number) => new Date(now.getTime() + min * 60_000);
    await refreshSenateEfdProxyProbe(env, at(0), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    expect(calls).toHaveLength(1);
    expect(await readSenateEfdProbe(env)).toMatchObject({
      state: 'degraded', status: null, dialed: true, lastDialedAt: at(0).toISOString(),
    });
    await refreshSenateEfdProxyProbe(env, at(1), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    await refreshSenateEfdProxyProbe(env, at(29), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    expect(calls).toHaveLength(1);
    await refreshSenateEfdProxyProbe(env, at(30), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    expect(calls).toHaveLength(2);
  });

  it('a relay-down tick never downgrades a stored Akamai block', async () => {
    const { env } = memEnv();
    const fetchImpl = efdFetch(() => new Response(AKAMAI_403, { status: 403 }));
    await refreshSenateEfdProxyProbe(env, now, { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    const blocked = await readSenateEfdProbe(env);
    expect(blocked).toMatchObject({ state: 'blocked', status: 403, step: 'POST /search/home/' });
    await refreshSenateEfdProxyProbe(env, new Date(now.getTime() + 60_000), { proxyUrl: PROXY, proxyReachable: false }, fetchImpl);
    await refreshSenateEfdProxyProbe(env, new Date(now.getTime() + 120_000), { proxyUrl: undefined, proxyReachable: false }, fetchImpl);
    expect(await readSenateEfdProbe(env)).toEqual(blocked);
  });
});

describe('readSenateEfdProbe trust boundary (Kody review, PR #2846)', () => {
  const good = {
    ok: true,
    status: 302,
    checkedAt: '2026-10-23T23:00:00.000Z',
    egress: 'proxy',
    error: null,
    state: 'ok',
    step: 'POST /search/home/',
    dialed: true,
    lastDialedAt: '2026-10-23T23:00:00.000Z',
  };

  it('validates the cached record with a zod schema and reads a malformed one as no record', async () => {
    const { env, kv } = memEnv();
    kv.set(SENATE_EFD_HEALTH_KV_KEY, JSON.stringify(good));
    expect(await readSenateEfdProbe(env)).toEqual(good);

    for (const bad of [
      { ...good, ok: 'yes' },
      { ...good, checkedAt: 7 },
      { ...good, state: 'weird' },
      { ...good, dialed: 'true' },
      { ...good, error: { html: '<b>x</b>' } },
      { ...good, lastDialedAt: 0 },
      [good],
      'text',
    ]) {
      kv.set(SENATE_EFD_HEALTH_KV_KEY, JSON.stringify(bad));
      expect(await readSenateEfdProbe(env), JSON.stringify(bad)).toBeNull();
    }
  });

  it('still reads a legacy direct-GET record and drops unknown fields', async () => {
    const { env, kv } = memEnv();
    kv.set(SENATE_EFD_HEALTH_KV_KEY, JSON.stringify({
      ok: false, status: 403, checkedAt: '2026-10-15T12:00:00.000Z', egress: 'direct', error: 'HTTP 403', injected: '<script>',
    }));
    const rec = await readSenateEfdProbe(env);
    expect(rec).toEqual({ ok: false, status: 403, checkedAt: '2026-10-15T12:00:00.000Z', egress: 'direct', error: 'HTTP 403' });
    expect(rec).not.toHaveProperty('injected');
  });
});

describe('eFD probe hardening (Kody review, PR #2850)', () => {
  it('never persists proxy credentials from a transport error', async () => {
    const { env, kv } = memEnv();
    (env as unknown as Record<string, string>).RESIDENTIAL_PROXY_USERNAME = 'proxyuser';
    (env as unknown as Record<string, string>).RESIDENTIAL_PROXY_PASSWORD = 's3cr3t-pass';
    const fetchImpl = (async () => {
      throw new TypeError('error sending request for url (http://proxyuser:s3cr3t-pass@10.99.0.2:8888/): tunnel failed for proxyuser s3cr3t-pass');
    }) as typeof fetch;
    await refreshSenateEfdProxyProbe(env, new Date('2026-10-23T23:00:00.000Z'), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    const raw = kv.get(SENATE_EFD_HEALTH_KV_KEY)!;
    expect(raw).not.toContain('s3cr3t-pass');
    expect(raw).not.toContain('proxyuser');
    expect(JSON.parse(raw).error).toContain('relay/transport error');
  });

  it('scrubs the configured proxy URL itself from a transport error', async () => {
    // The probe uses senateEdgeDeny's one scrub (sanitizeEfdTransportError,
    // tested in senateEdgeDeny.test.ts) with the env binding's proxy values.
    const { env, kv } = memEnv();
    const proxyUrl = 'http://10.77.0.9:8888';
    (env as unknown as Record<string, string>).RESIDENTIAL_PROXY_URL = proxyUrl;
    const fetchImpl = (async () => {
      throw new TypeError(`tunnel to ${proxyUrl} failed`);
    }) as typeof fetch;
    await refreshSenateEfdProxyProbe(env, new Date('2026-10-23T23:00:00.000Z'), { proxyUrl, proxyReachable: true }, fetchImpl);
    const rec = JSON.parse(kv.get(SENATE_EFD_HEALTH_KV_KEY)!);
    expect(rec.error).toBe('relay/transport error: tunnel to [redacted] failed');
  });

  it('gives each request its own timeout budget', async () => {
    const slow = (ms: number, res: () => Response) => new Promise<Response>((r) => setTimeout(() => r(res()), ms));
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input) === SENATE_SEARCH) {
        return slow(150, () => new Response(LANDING, { status: 200, headers: { 'set-cookie': 'csrftoken=c; Path=/' } }));
      }
      return slow(150, () => new Response('', { status: 302 }));
    }) as typeof fetch;
    // 150ms + 150ms would blow one shared 200ms budget; per-step it passes.
    const rec = await probeSenateEfdThroughProxy(PROXY, fetchImpl, 200);
    expect(rec).toMatchObject({ ok: true, state: 'ok' });
  });

  it('reports a per-step timeout distinctly from a relay failure', async () => {
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_r, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as typeof fetch;
    const rec = await probeSenateEfdThroughProxy(PROXY, fetchImpl, 50);
    expect(rec).toMatchObject({ state: 'degraded', status: null, step: 'GET /search/', error: 'relay/transport timeout after 50ms' });
  });

  it('sends the same headers as the real establishSenateSession handshake', async () => {
    const capture = () => {
      const seen: Array<{ method: string; headers: Record<string, string> }> = [];
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = { ...(init?.headers as Record<string, string>) };
        delete headers.cookie;
        seen.push({ method: init?.method ?? 'GET', headers });
        if (String(input) === SENATE_SEARCH) {
          return new Response(LANDING, { status: 200, headers: { 'set-cookie': 'csrftoken=c; Path=/' } });
        }
        return new Response('', { status: 302 });
      }) as typeof fetch;
      return { seen, fetchImpl };
    };
    const real = capture();
    await establishSenateSession({ politeDelayMs: 0 }, real.fetchImpl);
    const probe = capture();
    // Probe goes through createProxiedFetch; compare what reaches fetchImpl.
    await probeSenateEfdThroughProxy(PROXY, probe.fetchImpl, 1000);
    expect(probe.seen.map((r) => r.method)).toEqual(['GET', 'POST']);
    expect(probe.seen).toEqual(real.seen.slice(0, 2));
  });

  it('eFD response bodies pass a zod trust-boundary schema', () => {
    expect(SenateEfdResponseBodySchema.parse(AKAMAI_403)).toBe(AKAMAI_403);
    expect(SenateEfdResponseBodySchema.parse(undefined)).toBe('');
    expect(SenateEfdResponseBodySchema.parse('x'.repeat(600 * 1024))).toHaveLength(512 * 1024);
  });
});
