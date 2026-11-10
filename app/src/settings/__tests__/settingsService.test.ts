import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Env } from '../../shared/types.ts';
import {
  __resetSettingsForTests,
  appSettings,
  initSettings,
  startSettingsRefresh,
  stopSettingsRefresh,
} from '../settingsService.ts';

let projectSeq = 0;

function env(extra: Partial<Env> = {}): Env {
  projectSeq += 1;
  return {
    INFISICAL_BASE_URL: 'https://infisical.test',
    INFISICAL_ENV: 'prod',
    INFISICAL_ALLOW_ENV_FALLBACK: 'false',
    INFISICAL_APP_PROJECT_ID: `app-project-${projectSeq}`,
    INFISICAL_APP_CLIENT_ID: `app-client-${projectSeq}`,
    INFISICAL_APP_CLIENT_SECRET: `app-client-secret-${projectSeq}-long-enough-to-pass`,
    ...extra,
  } as Env;
}

type SecretRow = { secretKey: string; secretValue: string };

interface MockControl {
  rows: SecretRow[];
  failAuth: boolean;
  failUpdate: boolean;
  /** Every request seen by the mock. */
  calls: Array<{ url: string; method: string; body?: string }>;
}

function stubInfisical(control: MockControl): void {
  control.calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      control.calls.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? '') });
      if (url.endsWith('/api/v1/auth/universal-auth/login')) {
        if (control.failAuth) return new Response('auth failed', { status: 401 });
        return Response.json({ accessToken: 'test-token' });
      }
      if (url.includes('/api/v3/secrets/raw?')) {
        return Response.json({ secrets: control.rows });
      }
      if (url.includes('/api/v3/secrets/raw/')) {
        if (control.failUpdate) return new Response('write failed', { status: 500 });
        const key = url.split('/api/v3/secrets/raw/')[1]!.split('?')[0];
        const body = JSON.parse(String(init?.body || '{}')) as { secretValue?: string };
        const idx = control.rows.findIndex((r) => r.secretKey === key);
        if (idx >= 0) control.rows[idx] = { secretKey: key, secretValue: body.secretValue ?? '' };
        else control.rows.push({ secretKey: key, secretValue: body.secretValue ?? '' });
        return Response.json({ ok: true });
      }
      return new Response('not found', { status: 404 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  stopSettingsRefresh();
  __resetSettingsForTests();
});

describe('app settings service (Infisical SOT contract)', () => {
  it('startup load populates the cache', async () => {
    const control: MockControl = {
      rows: [
        { secretKey: 'CT_TICK_DEADLINE_MS', secretValue: '60000' },
        { secretKey: 'CT_DISABLE_INTERNAL_CRON', secretValue: 'false' },
      ],
      failAuth: false,
      failUpdate: false,
      calls: [],
    };
    stubInfisical(control);

    const settings = await initSettings(env());
    expect(settings.getInt('CT_TICK_DEADLINE_MS', 45000)).toBe(60000);
    expect(settings.getBool('CT_DISABLE_INTERNAL_CRON', true)).toBe(false);
    expect(settings.getString('CT_CRON_SCHEDULE', '* * * * *')).toBe('* * * * *');
  });

  it('runtime reads make zero network calls after init', async () => {
    const control: MockControl = {
      rows: [{ secretKey: 'CT_DRAIN_LIMIT', secretValue: '50' }],
      failAuth: false,
      failUpdate: false,
      calls: [],
    };
    stubInfisical(control);

    const settings = await initSettings(env());
    control.calls = [];
    for (let i = 0; i < 25; i += 1) {
      settings.get('CT_DRAIN_LIMIT');
      settings.getInt('CT_DRAIN_LIMIT', 25);
      settings.getBool('CT_DISABLE_INTERNAL_CRON', false);
      settings.getString('CT_CRON_SCHEDULE', 'x');
    }
    expect(control.calls).toHaveLength(0);
  });

  it('write-through updates Infisical before the cache', async () => {
    const control: MockControl = {
      rows: [{ secretKey: 'CT_DRAIN_LIMIT', secretValue: '25' }],
      failAuth: false,
      failUpdate: false,
      calls: [],
    };
    stubInfisical(control);

    const e = env();
    const settings = await initSettings(e);
    expect(settings.getInt('CT_DRAIN_LIMIT', 25)).toBe(25);

    const order: string[] = [];
    const rawFetch = globalThis.fetch as typeof fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (url.includes('/api/v3/secrets/raw/CT_DRAIN_LIMIT') && method === 'PATCH') {
          order.push('infisical-write');
          expect(settings.getInt('CT_DRAIN_LIMIT', 25)).toBe(25); // cache not yet updated
        }
        return rawFetch(url, init);
      }),
    );

    await settings.set(e, 'CT_DRAIN_LIMIT', '60');
    expect(order).toEqual(['infisical-write']);
    expect(control.rows.find((r) => r.secretKey === 'CT_DRAIN_LIMIT')?.secretValue).toBe('60');
    expect(settings.getInt('CT_DRAIN_LIMIT', 25)).toBe(60);
  });

  it('failed refresh keeps the last-known-good snapshot', async () => {
    const control: MockControl = {
      rows: [{ secretKey: 'CT_TICK_DEADLINE_MS', secretValue: '45000' }],
      failAuth: false,
      failUpdate: false,
      calls: [],
    };
    stubInfisical(control);

    const e = env();
    const settings = await initSettings(e);
    expect(settings.getInt('CT_TICK_DEADLINE_MS', 10000)).toBe(45000);

    control.failAuth = true; // every source fails from here on
    await settings.refresh(e);

    expect(settings.getInt('CT_TICK_DEADLINE_MS', 10000)).toBe(45000);
  });

  it('partial refresh failure keeps last-known-good values for keys the failed source held', async () => {
    let failApp = false;
    const appClient = `app-client-${projectSeq + 1}`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/v1/auth/universal-auth/login')) {
          const body = z.object({ clientId: z.string() }).passthrough().parse(JSON.parse(String(init?.body ?? '{}')));
          if (failApp && body.clientId === appClient) return new Response('auth failed', { status: 401 });
          return Response.json({ accessToken: body.clientId === appClient ? 'app-token' : 'shared-token' });
        }
        if (url.includes('/api/v3/secrets/raw?')) {
          const auth = new Headers(init?.headers).get('authorization') ?? '';
          return Response.json({
            secrets: auth.includes('app-token')
              ? [{ secretKey: 'CT_DELIVERY_MODE', secretValue: 'hold' }]
              : [{ secretKey: 'CT_TICK_DEADLINE_MS', secretValue: '45000' }],
          });
        }
        return new Response('not found', { status: 404 });
      }),
    );
    const e = env({
      INFISICAL_SHARED_PROJECT_ID: `shared-project-${projectSeq + 1}`,
      INFISICAL_SHARED_CLIENT_ID: `shared-client-${projectSeq + 1}`,
      INFISICAL_SHARED_CLIENT_SECRET: `shared-client-secret-${projectSeq + 1}-long-enough`,
    } as Partial<Env>);
    const settings = await initSettings(e);
    expect(settings.get('CT_DELIVERY_MODE')).toBe('hold');
    expect(settings.get('CT_TICK_DEADLINE_MS')).toBe('45000');

    failApp = true; // only the app source fails; shared still answers
    const later = Date.now() + 2 * 3600_000; // past the resolver cache TTL
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      await settings.refresh(e);
    } finally {
      clock.mockRestore();
    }
    expect(settings.get('CT_TICK_DEADLINE_MS')).toBe('45000');
    expect(settings.get('CT_DELIVERY_MODE')).toBe('hold');
  });

  it('failed write-through rejects and leaves the cache untouched', async () => {
    const control: MockControl = {
      rows: [{ secretKey: 'CT_DRAIN_LIMIT', secretValue: '25' }],
      failAuth: false,
      failUpdate: false,
      calls: [],
    };
    stubInfisical(control);

    const e = env();
    const settings = await initSettings(e);
    control.failUpdate = true;

    await expect(settings.set(e, 'CT_DRAIN_LIMIT', '60')).rejects.toThrow();
    expect(settings.getInt('CT_DRAIN_LIMIT', 25)).toBe(25);
    expect(control.rows.find((r) => r.secretKey === 'CT_DRAIN_LIMIT')?.secretValue).toBe('25');
  });

  it('rejects unknown setting keys on write', async () => {
    const control: MockControl = { rows: [], failAuth: false, failUpdate: false, calls: [] };
    stubInfisical(control);
    const e = env();
    const settings = await initSettings(e);
    await expect(settings.set(e, 'SOME_USER_PREF', 'x')).rejects.toThrow('Unknown app setting');
  });

  it('throws before init', () => {
    expect(() => appSettings()).toThrow('not initialized');
  });

  it('background refresh keeps last-known-good on failure', async () => {
    const control: MockControl = {
      rows: [{ secretKey: 'CT_TICK_STUCK_MINUTES', secretValue: '10' }],
      failAuth: false,
      failUpdate: false,
      calls: [],
    };
    stubInfisical(control);
    const e = env();
    const settings = await initSettings(e);
    startSettingsRefresh(e, 10);
    await new Promise((r) => setTimeout(r, 50));
    expect(settings.getInt('CT_TICK_STUCK_MINUTES', 5)).toBe(10);
    control.failAuth = true;
    await new Promise((r) => setTimeout(r, 50));
    expect(settings.getInt('CT_TICK_STUCK_MINUTES', 5)).toBe(10);
  }, 10000);
});
