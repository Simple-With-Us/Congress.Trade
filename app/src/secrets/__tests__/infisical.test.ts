import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import {
  deleteSecret,
  readSourceSecrets,
  refreshSecrets,
  resolveSecret,
  updateSecret,
} from '../infisical.ts';

function env(extra: Partial<Env> = {}): Env {
  return {
    INFISICAL_BASE_URL: 'https://infisical.test',
    INFISICAL_ENV: 'prod',
    INFISICAL_APP_PROJECT_ID: 'app-project',
    INFISICAL_APP_CLIENT_ID: 'app-client',
    INFISICAL_APP_CLIENT_SECRET: 'app-secret',
    INFISICAL_SHARED_PROJECT_ID: 'shared-project',
    INFISICAL_SHARED_CLIENT_ID: 'shared-client',
    INFISICAL_SHARED_CLIENT_SECRET: 'shared-secret',
    ...extra,
  } as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Infisical environment selection is prod-only', () => {
  function stubInfisical(seenEnvironments: string[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/v1/auth/universal-auth/login')) return Response.json({ accessToken: 'token' });
        if (url.includes('/api/v3/secrets/raw')) {
          seenEnvironments.push(new URL(url).searchParams.get('environment') ?? '');
          return Response.json({ secrets: [] });
        }
        return new Response('not found', { status: 404 });
      }),
    );
  }

  it.each([
    ['unset', undefined],
    ['blank', '   '],
    ['prod', 'prod'],
    ['the production alias', 'production'],
  ])('reads the prod environment when INFISICAL_ENV is %s', async (_label, value) => {
    const seen: string[] = [];
    stubInfisical(seen);
    const e = env({ INFISICAL_APP_PROJECT_ID: `app-project-env-${_label}` });
    if (value === undefined) delete (e as { INFISICAL_ENV?: string }).INFISICAL_ENV;
    else e.INFISICAL_ENV = value;
    await refreshSecrets(e);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(['prod']));
  });

  it.each(['dev', 'development', 'staging', 'stage', 'preview'])(
    'refuses INFISICAL_ENV=%s before any network call',
    async (value) => {
      const seen: string[] = [];
      stubInfisical(seen);
      const e = env({ INFISICAL_ENV: value, INFISICAL_APP_PROJECT_ID: `app-project-refused-${value}` });
      await expect(refreshSecrets(e)).rejects.toThrow(/INFISICAL_ENV must be "prod"/);
      await expect(resolveSecret(e, 'FMP_API_KEY')).rejects.toThrow(/INFISICAL_ENV must be "prod"/);
      await expect(updateSecret(e, 'app', 'FMP_API_KEY', 'v')).rejects.toThrow(/INFISICAL_ENV must be "prod"/);
      await expect(deleteSecret(e, 'app', 'FMP_API_KEY')).rejects.toThrow(/INFISICAL_ENV must be "prod"/);
      await expect(readSourceSecrets(e, 'app')).rejects.toThrow(/INFISICAL_ENV must be "prod"/);
      expect(seen).toEqual([]);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    },
  );
});

describe('Infisical runtime secret resolver', () => {
  it('merges shared then app secrets, with app overriding shared', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/v1/auth/universal-auth/login')) {
          const body = JSON.parse(String(init?.body || '{}')) as { clientId?: string };
          return Response.json({ accessToken: body.clientId === 'shared-client' ? 'shared-token' : 'app-token' });
        }
        if (url.includes('/api/v3/secrets/raw')) {
          const u = new URL(url);
          const workspaceId = u.searchParams.get('workspaceId');
          return Response.json({
            secrets:
              workspaceId === 'shared-project'
                ? [
                    { secretKey: 'FMP_API_KEY', secretValue: 'shared-fmp' },
                    { secretKey: 'MASSIVE_API_KEY', secretValue: 'shared-massive' },
                  ]
                : [{ secretKey: 'FMP_API_KEY', secretValue: 'app-fmp' }],
          });
        }
        return new Response('not found', { status: 404 });
      }),
    );

    const e = env({ INFISICAL_APP_PROJECT_ID: 'app-project-a' });
    await refreshSecrets(e);
    expect(await resolveSecret(e, 'FMP_API_KEY')).toEqual({ value: 'app-fmp', source: 'infisical' });
    expect(await resolveSecret(e, 'MASSIVE_API_KEY')).toEqual({ value: 'shared-massive', source: 'infisical' });
  });

  it('falls back to env during migration when Infisical does not provide a key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/v1/auth/universal-auth/login')) return Response.json({ accessToken: 'token' });
        if (url.includes('/api/v3/secrets/raw')) return Response.json({ secrets: [] });
        return new Response('not found', { status: 404 });
      }),
    );

    const e = env({ INFISICAL_APP_PROJECT_ID: 'app-project-b', FMP_API_KEY: 'env-fmp' });
    expect(await resolveSecret(e, 'FMP_API_KEY')).toEqual({ value: 'env-fmp', source: 'env' });
  });

  it('can disable env fallback after cutover', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/v1/auth/universal-auth/login')) return Response.json({ accessToken: 'token' });
        if (url.includes('/api/v3/secrets/raw')) return Response.json({ secrets: [] });
        return new Response('not found', { status: 404 });
      }),
    );

    const e = env({
      INFISICAL_APP_PROJECT_ID: 'app-project-c',
      INFISICAL_ALLOW_ENV_FALLBACK: 'false',
      FMP_API_KEY: 'env-fmp',
    });
    expect(await resolveSecret(e, 'FMP_API_KEY')).toEqual({ source: 'missing' });
  });

  it('does not use the KV cache without strong encryption secret material', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/v1/auth/universal-auth/login')) return Response.json({ accessToken: 'token' });
        if (url.includes('/api/v3/secrets/raw')) {
          return Response.json({ secrets: [{ secretKey: 'FMP_API_KEY', secretValue: 'infisical-fmp' }] });
        }
        return new Response('not found', { status: 404 });
      }),
    );
    const kv = {
      get: vi.fn(async () => {
        throw new Error('should not read weakly encrypted KV cache');
      }),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };

    const e = env({
      INFISICAL_APP_PROJECT_ID: 'app-project-weak-kv',
      INFISICAL_APP_CLIENT_SECRET: 'short-secret',
      INFISICAL_SHARED_CLIENT_SECRET: 'short-shared',
      ADMIN_TOKEN: 'short-admin',
      CONFIG_KV: kv as unknown as KVNamespace,
    });

    expect(await resolveSecret(e, 'FMP_API_KEY')).toEqual({ value: 'infisical-fmp', source: 'infisical' });
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('updates a secret using PATCH, falling back to POST if not found', async () => {
    let patchCalled = false;
    let postCalled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/v1/auth/universal-auth/login')) return Response.json({ accessToken: 'token' });
        
        if (url.includes('/api/v3/secrets/raw/TEST_KEY')) {
          if (init?.method === 'PATCH') {
            patchCalled = true;
            return new Response('not found', { status: 404 });
          }
          if (init?.method === 'POST') {
            postCalled = true;
            return Response.json({ secret: { secretKey: 'TEST_KEY', secretValue: 'new-val' } });
          }
        }
        return new Response('not found', { status: 404 });
      }),
    );

    const e = env({ INFISICAL_APP_PROJECT_ID: 'app-project' });
    await updateSecret(e, 'app', 'TEST_KEY', 'new-val');
    
    expect(patchCalled).toBe(true);
    expect(postCalled).toBe(true);
  });

  it('threads one abort signal through Infisical authentication and mutation', async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        signals.push(init?.signal);
        if (url.endsWith('/api/v1/auth/universal-auth/login')) {
          return Response.json({ accessToken: 'token' });
        }
        if (url.includes('/api/v3/secrets/raw/TEST_KEY')) {
          return Response.json({ secret: { secretKey: 'TEST_KEY' } });
        }
        return new Response('not found', { status: 404 });
      }),
    );
    const controller = new AbortController();

    await updateSecret(
      env({ INFISICAL_APP_PROJECT_ID: 'app-project-signal' }),
      'app',
      'TEST_KEY',
      'new-val',
      { signal: controller.signal },
    );

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal === controller.signal)).toBe(true);
  });

  it('reads source-owned values without imports and can delete an override', async () => {
    let listUrl = '';
    let deleteBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/v1/auth/universal-auth/login')) {
          return Response.json({ accessToken: 'token' });
        }
        if (url.includes('/api/v3/secrets/raw?')) {
          listUrl = url;
          return Response.json({
            secrets: [{ secretKey: 'AGREEMENT_HOUSE_MODEL_A', secretValue: 'openai:gpt-4o' }],
          });
        }
        if (url.endsWith('/api/v3/secrets/raw/AGREEMENT_HOUSE_MODEL_A') && init?.method === 'DELETE') {
          deleteBody = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
          return Response.json({ secret: { secretKey: 'AGREEMENT_HOUSE_MODEL_A' } });
        }
        return new Response('not found', { status: 404 });
      }),
    );

    const e = env({ INFISICAL_APP_PROJECT_ID: 'app-project-raw-state' });
    expect(await readSourceSecrets(e, 'app')).toEqual({
      AGREEMENT_HOUSE_MODEL_A: 'openai:gpt-4o',
    });
    expect(new URL(listUrl).searchParams.get('include_imports')).toBe('false');

    await deleteSecret(e, 'app', 'AGREEMENT_HOUSE_MODEL_A');
    expect(deleteBody).toMatchObject({
      workspaceId: 'app-project-raw-state',
      environment: 'prod',
      secretPath: '/',
      type: 'shared',
    });
  });
});
