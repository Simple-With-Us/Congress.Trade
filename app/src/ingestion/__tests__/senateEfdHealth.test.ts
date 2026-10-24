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
import type { Env } from '../../shared/types.ts';
import {
  SENATE_EFD_HEALTH_KV_KEY,
  probeSenateEfdLanding,
  readSenateEfdProbe,
  refreshSenateEfdHealth,
  senateEfdProbeDue,
} from '../senateEfdHealth.ts';

describe('probeSenateEfdLanding', () => {
  it('records ok when the landing page returns 200', async () => {
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      expect(String(input)).toBe(SENATE_SEARCH);
      return new Response('<html>ok</html>', { status: 200 });
    };
    const rec = await probeSenateEfdLanding(fetchImpl, 1000);
    expect(rec.ok).toBe(true);
    expect(rec.status).toBe(200);
    expect(rec.egress).toBe('direct');
  });

  it('records failure on HTTP 403', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('blocked', { status: 403 });
    const rec = await probeSenateEfdLanding(fetchImpl, 1000);
    expect(rec.ok).toBe(false);
    expect(rec.status).toBe(403);
  });
});

// CT-2442: the box's direct egress is edge-denied by eFD's Akamai, and the
// watcher used to probe it every minute (~1,440 denied requests a day).
describe('refreshSenateEfdHealth throttle', () => {
  const T0 = new Date('2026-10-23T23:00:00.000Z');
  const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

  function kvEnv() {
    const store = new Map<string, string>();
    const env = {
      CONFIG_KV: {
        async get(key: string, type?: string) {
          const v = store.get(key) ?? null;
          return v !== null && type === 'json' ? JSON.parse(v) : v;
        },
        async put(key: string, value: string) {
          store.set(key, value);
        },
      },
    } as unknown as Env;
    return { env, store };
  }

  it('re-probes a denied landing at most every 30 minutes, reading the cached result', async () => {
    const { env, store } = kvEnv();
    const fetchImpl = vi.fn(async () =>
      new Response('Access Denied', { status: 403, headers: { server: 'AkamaiGHost' } }));

    await refreshSenateEfdHealth(env, T0, fetchImpl as typeof fetch);
    await refreshSenateEfdHealth(env, at(1), fetchImpl as typeof fetch);
    await refreshSenateEfdHealth(env, at(29), fetchImpl as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await readSenateEfdProbe(env)).toMatchObject({ ok: false, status: 403, checkedAt: T0.toISOString() });

    await refreshSenateEfdHealth(env, at(30), fetchImpl as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(store.get(SENATE_EFD_HEALTH_KV_KEY)!).checkedAt).toBe(at(30).toISOString());
  });

  it('refreshes an ok probe every 15 minutes, inside the 20-minute staleness bar', async () => {
    const { env } = kvEnv();
    const fetchImpl = vi.fn(async () => new Response('<html>ok</html>', { status: 200 }));

    await refreshSenateEfdHealth(env, T0, fetchImpl as typeof fetch);
    await refreshSenateEfdHealth(env, at(14), fetchImpl as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await refreshSenateEfdHealth(env, at(15), fetchImpl as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('probes when there is no usable cached record', () => {
    expect(senateEfdProbeDue(null, T0)).toBe(true);
    expect(senateEfdProbeDue({ ok: false, status: 403, checkedAt: 'garbage' }, T0)).toBe(true);
    expect(senateEfdProbeDue({ ok: false, status: 403, checkedAt: at(10).toISOString() }, T0)).toBe(true);
  });
});
