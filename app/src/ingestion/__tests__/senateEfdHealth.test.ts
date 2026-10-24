import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/thirdPartyTelemetry.ts', () => ({
  trackedFetch: (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    _descriptor: unknown,
    fetchImpl: typeof fetch = fetch,
  ) => fetchImpl(input, init),
}));
import { SENATE_SEARCH } from '../senateSource.ts';
import {
  probeSenateEfdThroughProxy,
  refreshSenateEfdProxyProbe,
  SENATE_EFD_PROXY_PROBE_INTERVAL_MS,
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
    const fetchImpl = efdFetch(() => new Response(AKAMAI_403, { status: 403 }), calls);
    await refreshSenateEfdProxyProbe(env, now, { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(kv.get(SENATE_EFD_HEALTH_KV_KEY)!).state).toBe('blocked');

    await refreshSenateEfdProxyProbe(
      env, new Date(now.getTime() + 5 * 60_000), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl,
    );
    expect(calls).toHaveLength(2);

    await refreshSenateEfdProxyProbe(
      env, new Date(now.getTime() + SENATE_EFD_PROXY_PROBE_INTERVAL_MS), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl,
    );
    expect(calls).toHaveLength(4);
  });

  it('re-dials right away after a relay-down record (no eFD hop was spent)', async () => {
    const { env } = memEnv();
    const calls: string[] = [];
    const fetchImpl = efdFetch(() => new Response('', { status: 302 }), calls);
    await refreshSenateEfdProxyProbe(env, now, { proxyUrl: PROXY, proxyReachable: false }, fetchImpl);
    await refreshSenateEfdProxyProbe(env, new Date(now.getTime() + 60_000), { proxyUrl: PROXY, proxyReachable: true }, fetchImpl);
    expect(calls).toHaveLength(2);
    expect(await readSenateEfdProbe(env)).toMatchObject({ state: 'ok' });
  });
});
