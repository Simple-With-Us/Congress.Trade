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
  sanitizeEfdTransportError,
  SENATE_EFD_BLOCKED_PROBE_INTERVAL_MS,
  SENATE_EFD_PROXY_PROBE_INTERVAL_MS,
  SenateEfdResponseBodySchema,
} from '../residentialProxyHealth.ts';
import { readSenateEfdProbe, SENATE_EFD_HEALTH_KV_KEY } from '../senateEfdHealth.ts';
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

  it('is degraded (not blocked) for a non-Akamai 403', async () => {
    const rec = await probeSenateEfdThroughProxy(PROXY, efdFetch(() => new Response('Forbidden', { status: 403 })), 1000);
    expect(rec).toMatchObject({ state: 'degraded', status: 403 });
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

  it('dials eFD at most once per 15 minutes', async () => {
    const { env, kv } = memEnv();
    const calls: string[] = [];
    const fetchImpl = efdFetch(() => new Response('Service Unavailable', { status: 503 }), calls);
    await refreshSenateEfdProxyProbe(env, now, { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(kv.get(SENATE_EFD_HEALTH_KV_KEY)!).state).toBe('degraded');

    await refreshSenateEfdProxyProbe(
      env, new Date(now.getTime() + 5 * 60_000), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl,
    );
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

  it('a relay flap does not reset the 15-minute throttle', async () => {
    const { env } = memEnv();
    const calls: string[] = [];
    const fetchImpl = efdFetch(() => new Response('', { status: 302 }), calls);
    const at = (min: number) => new Date(now.getTime() + min * 60_000);
    await refreshSenateEfdProxyProbe(env, at(0), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    expect(calls).toHaveLength(2);
    await refreshSenateEfdProxyProbe(env, at(2), { proxyUrl: PROXY, proxyReachable: false }, fetchImpl);
    expect(await readSenateEfdProbe(env)).toMatchObject({ state: 'degraded', lastDialedAt: at(0).toISOString() });
    await refreshSenateEfdProxyProbe(env, at(4), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    expect(calls).toHaveLength(2);
    await refreshSenateEfdProxyProbe(env, at(15), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    expect(calls).toHaveLength(4);
  });

  it('backs off 30 minutes (not 15) after an Akamai block', async () => {
    const { env } = memEnv();
    const calls: string[] = [];
    const fetchImpl = efdFetch(() => new Response(AKAMAI_403, { status: 403 }), calls);
    const at = (min: number) => new Date(now.getTime() + min * 60_000);
    await refreshSenateEfdProxyProbe(env, at(0), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    expect(calls).toHaveLength(2);
    await refreshSenateEfdProxyProbe(env, at(15), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    await refreshSenateEfdProxyProbe(env, at(29), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    expect(calls).toHaveLength(2);
    await refreshSenateEfdProxyProbe(
      env, at(SENATE_EFD_BLOCKED_PROBE_INTERVAL_MS / 60_000), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl,
    );
    expect(calls).toHaveLength(4);
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

  it('sanitizeEfdTransportError strips URL userinfo and bounds the length', () => {
    const out = sanitizeEfdTransportError(new Error(`connect http://u:p%40ss@host:1/ ${'x'.repeat(500)}`));
    expect(out).toContain('http://[redacted]@host:1/');
    expect(out).not.toContain('p%40ss');
    expect(out.length).toBeLessThanOrEqual(200);
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
