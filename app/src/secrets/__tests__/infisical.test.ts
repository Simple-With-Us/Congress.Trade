import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import {
  deleteSecret,
  INFISICAL_KV_CACHE_MAX_BYTES,
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

const appClientSecretField = ['INFISICAL', 'APP', 'CLIENT', 'SECRET'].join('_') as keyof Env;
const cacheEncryptionFixture = '01234567890123456789012345678901';

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
  it.each([
    ['numeric accessToken', { accessToken: 42 }],
    ['empty accessToken', { accessToken: '' }],
    ['whitespace token', { token: '   ' }],
    ['non-object response', ['not', 'an', 'object']],
  ])('rejects a malformed login response (%s) without requesting secrets', async (_label, loginBody) => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/v1/auth/universal-auth/login')) return Response.json(loginBody);
      if (url.includes('/api/v3/secrets/raw')) return Response.json({ secrets: [] });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(readSourceSecrets(env(), 'app')).rejects.toThrow('Infisical app auth failed: invalid response');
    expect(fetchMock.mock.calls.some(([url]) => url.includes('/api/v3/secrets/raw'))).toBe(false);
  });

  it('does not echo an Infisical login error body', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/v1/auth/universal-auth/login')) {
        return Response.json({ message: 'untrusted response detail' }, { status: 401 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(readSourceSecrets(env(), 'app')).rejects.toMatchObject({
      message: 'Infisical app auth failed: HTTP 401',
    });
    expect(fetchMock.mock.calls.some(([url]) => url.includes('/api/v3/secrets/raw'))).toBe(false);
  });

  it.each([
    [{ token: 'fallback-token' }, 'fallback-token'],
    [{ accessToken: 'preferred-token', token: 'fallback-token' }, 'preferred-token'],
  ])('accepts the token response shape and keeps accessToken precedence', async (loginBody, expectedToken) => {
    let authorization = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/v1/auth/universal-auth/login')) return Response.json(loginBody);
        if (url.includes('/api/v3/secrets/raw')) {
          authorization = new Headers(init?.headers).get('authorization') ?? '';
          return Response.json({ secrets: [] });
        }
        return new Response('not found', { status: 404 });
      }),
    );

    await expect(readSourceSecrets(env(), 'app')).resolves.toEqual({});
    expect(authorization).toBe(`Bearer ${expectedToken}`);
  });

  // The resolver creates the ciphertext with its real AES-GCM path; the fixture retains it under the pre-v2 key rather than using a captured production blob.
  it('does not reuse a retained unversioned encrypted KV row after a module restart', async () => {
    const rows = new Map<string, string>();
    let seedLegacyRow = true;
    let skipInitialCleanup = true;
    let legacyKey = '';
    const kv = {
      get: vi.fn(async (key: string) => rows.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        if (seedLegacyRow) {
          legacyKey = key.startsWith('infisical_secrets_cache:v2:')
            ? `infisical_secrets_cache:${key.slice('infisical_secrets_cache:v2:'.length)}`
            : key;
          rows.set(legacyKey, value);
          seedLegacyRow = false;
          return;
        }
        rows.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        if (skipInitialCleanup) return;
        rows.delete(key);
      }),
    } as unknown as KVNamespace;
    let secretValue = 'retained-a';
    const appPaths: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/v1/auth/universal-auth/login')) return Response.json({ accessToken: 'fixture-token' });
      if (url.includes('/api/v3/secrets/raw')) {
        appPaths.push(new URL(url).searchParams.get('secretPath') ?? '');
        return Response.json({ secrets: [{ secretKey: 'FMP_API_KEY', secretValue }] });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const e = env({
      INFISICAL_APP_PROJECT_ID: 'app-project-retained-kv',
      [appClientSecretField]: cacheEncryptionFixture,
      INFISICAL_SHARED_PROJECT_ID: '',
      INFISICAL_SHARED_CLIENT_ID: '',
      INFISICAL_SHARED_CLIENT_SECRET: '',
      CONFIG_KV: kv,
    });

    const oldResolver = await import('../infisical.ts');
    await oldResolver.refreshSecrets(e);
    skipInitialCleanup = false;
    kv.delete.mockClear();
    expect(kv.put).toHaveBeenCalledTimes(1);
    expect(rows.has(legacyKey)).toBe(true);
    expect(await oldResolver.resolveSecret(e, 'FMP_API_KEY')).toEqual({ value: 'retained-a', source: 'infisical' });

    secretValue = 'current-b';
    vi.resetModules();
    const newResolver = await import('../infisical.ts');
    expect(await newResolver.resolveSecret(e, 'FMP_API_KEY')).toEqual({ value: 'current-b', source: 'infisical' });
    expect(appPaths).toEqual(['/', '/']);
    expect(rows.has(legacyKey)).toBe(false);
    expect(kv.delete).toHaveBeenCalledTimes(1);
    expect(kv.delete).toHaveBeenCalledWith(legacyKey);
    expect([...rows.keys()].every((key) => key.startsWith('infisical_secrets_cache:v2:'))).toBe(true);
  });

  it('preserves a retained unversioned KV row when refresh fails but never serves it', async () => {
    const rows = new Map<string, string>();
    let seedLegacyRow = true;
    let skipInitialCleanup = true;
    let legacyKey = '';
    const kv = {
      get: vi.fn(async (key: string) => rows.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        if (seedLegacyRow) {
          legacyKey = key.startsWith('infisical_secrets_cache:v2:')
            ? `infisical_secrets_cache:${key.slice('infisical_secrets_cache:v2:'.length)}`
            : key;
          rows.set(legacyKey, value);
          seedLegacyRow = false;
          return;
        }
        rows.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        if (skipInitialCleanup) return;
        rows.delete(key);
      }),
    } as unknown as KVNamespace;
    let failLogin = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/v1/auth/universal-auth/login')) {
        return failLogin
          ? Response.json({ message: 'untrusted response detail' }, { status: 401 })
          : Response.json({ accessToken: 'fixture-token' });
      }
      if (url.includes('/api/v3/secrets/raw')) {
        return Response.json({ secrets: [{ secretKey: 'FMP_API_KEY', secretValue: 'retained-a' }] });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const e = env({
      INFISICAL_APP_PROJECT_ID: 'app-project-retained-kv-failure',
      [appClientSecretField]: cacheEncryptionFixture,
      INFISICAL_SHARED_PROJECT_ID: '',
      INFISICAL_SHARED_CLIENT_ID: '',
      INFISICAL_SHARED_CLIENT_SECRET: '',
      INFISICAL_ALLOW_ENV_FALLBACK: 'false',
      CONFIG_KV: kv,
    });

    const oldResolver = await import('../infisical.ts');
    await oldResolver.refreshSecrets(e);
    skipInitialCleanup = false;
    kv.delete.mockClear();
    expect(kv.put).toHaveBeenCalledTimes(1);
    expect(rows.has(legacyKey)).toBe(true);

    failLogin = true;
    vi.resetModules();
    const newResolver = await import('../infisical.ts');
    expect(await newResolver.resolveSecret(e, 'FMP_API_KEY')).toEqual({ source: 'missing' });
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/api/v1/auth/universal-auth/login'))).toBe(true);
    expect(rows.has(legacyKey)).toBe(true);
    expect(kv.delete).not.toHaveBeenCalled();
  });

  it('preserves and ignores a retained unversioned KV row when the new KV write fails', async () => {
    const rows = new Map<string, string>();
    let seedLegacyRow = true;
    let skipInitialCleanup = true;
    let legacyKey = '';
    const kvGet = vi.fn(async (key: string) => rows.get(key) ?? null);
    const kvPut = vi.fn(async (key: string, value: string) => {
      if (seedLegacyRow) {
        legacyKey = key.startsWith('infisical_secrets_cache:v2:')
          ? `infisical_secrets_cache:${key.slice('infisical_secrets_cache:v2:'.length)}`
          : key;
        rows.set(legacyKey, value);
        seedLegacyRow = false;
        return;
      }
      rows.set(key, value);
    });
    const kvDelete = vi.fn(async (key: string) => {
      if (skipInitialCleanup) return;
      rows.delete(key);
    });
    const kv = { get: kvGet, put: kvPut, delete: kvDelete } as unknown as KVNamespace;
    let secretValue = 'retained-a';
    const appPaths: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/v1/auth/universal-auth/login')) return Response.json({ accessToken: 'fixture-token' });
      if (url.includes('/api/v3/secrets/raw')) {
        appPaths.push(new URL(url).searchParams.get('secretPath') ?? '');
        return Response.json({ secrets: [{ secretKey: 'FMP_API_KEY', secretValue }] });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const e = env({
      INFISICAL_APP_PROJECT_ID: 'app-project-retained-kv-put-failure',
      [appClientSecretField]: cacheEncryptionFixture,
      INFISICAL_SHARED_PROJECT_ID: '',
      INFISICAL_SHARED_CLIENT_ID: '',
      INFISICAL_SHARED_CLIENT_SECRET: '',
      CONFIG_KV: kv,
    });

    const oldResolver = await import('../infisical.ts');
    await oldResolver.refreshSecrets(e);
    skipInitialCleanup = false;
    kvDelete.mockClear();
    expect(rows.has(legacyKey)).toBe(true);

    secretValue = 'current-b';
    kvPut.mockRejectedValueOnce(new Error('fixture KV write failure'));
    vi.resetModules();
    const newResolver = await import('../infisical.ts');
    expect(await newResolver.resolveSecret(e, 'FMP_API_KEY')).toEqual({ value: 'current-b', source: 'infisical' });
    expect(appPaths).toEqual(['/', '/']);
    expect(rows.has(legacyKey)).toBe(true);
    expect(kvDelete).not.toHaveBeenCalled();
  });

  it('skips Infisical network when the in-memory cache is still fresh', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/v1/auth/universal-auth/login')) {
        return Response.json({ accessToken: 'token' });
      }
      if (url.includes('/api/v3/secrets/raw')) {
        return Response.json({ secrets: [{ secretKey: 'FMP_API_KEY', secretValue: 'infisical-fmp' }] });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const e = env({
      INFISICAL_APP_PROJECT_ID: 'app-project-fresh-cache',
      INFISICAL_CACHE_TTL_SECONDS: '600',
    });
    await refreshSecrets(e);
    expect(fetchMock).toHaveBeenCalled();
    const callsAfterFirst = fetchMock.mock.calls.length;

    await refreshSecrets(e);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);

    await refreshSecrets(e, { force: true });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('separates in-memory cache entries by the effective legacy app secret path', async () => {
    const appProject = 'app-project-legacy-path-memory';
    const appPaths: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/v1/auth/universal-auth/login')) {
        return Response.json({ accessToken: 'token' });
      }
      if (url.includes('/api/v3/secrets/raw')) {
        const parsed = new URL(url);
        if (parsed.searchParams.get('workspaceId') === appProject) {
          const path = parsed.searchParams.get('secretPath') ?? '/';
          appPaths.push(path);
          return Response.json({
            secrets: [{ secretKey: 'FMP_API_KEY', secretValue: path === '/legacy-a' ? 'legacy-a-fmp' : 'legacy-b-fmp' }],
          });
        }
        return Response.json({ secrets: [] });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const pathA = env({ INFISICAL_APP_PROJECT_ID: appProject, INFISICAL_SECRET_PATH: '/legacy-a' });
    const pathB = env({ INFISICAL_APP_PROJECT_ID: appProject, INFISICAL_SECRET_PATH: '/legacy-b' });
    await refreshSecrets(pathA);

    expect(await resolveSecret(pathB, 'FMP_API_KEY')).toEqual({ value: 'legacy-b-fmp', source: 'infisical' });
    expect(appPaths).toEqual(['/legacy-a', '/legacy-b']);
  });

  it('isolates encrypted KV cache entries by the effective legacy app secret path across resolver instances', async () => {
    const appProject = 'app-project-legacy-path-kv';
    const appPaths: string[] = [];
    const rows = new Map<string, string>();
    const kv = {
      get: vi.fn(async (key: string) => rows.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        rows.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        rows.delete(key);
      }),
    } as unknown as KVNamespace;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/v1/auth/universal-auth/login')) {
        return Response.json({ accessToken: 'token' });
      }
      if (url.includes('/api/v3/secrets/raw')) {
        const parsed = new URL(url);
        if (parsed.searchParams.get('workspaceId') === appProject) {
          const path = parsed.searchParams.get('secretPath') ?? '/';
          appPaths.push(path);
          return Response.json({
            secrets: [{ secretKey: 'FMP_API_KEY', secretValue: path === '/legacy-a' ? 'legacy-a-fmp' : 'legacy-b-fmp' }],
          });
        }
        return Response.json({ secrets: [] });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const pathA = env({
      INFISICAL_APP_PROJECT_ID: appProject,
      INFISICAL_APP_CLIENT_SECRET: 'fixture-key-'.repeat(4),
      INFISICAL_SECRET_PATH: '/legacy-a',
      CONFIG_KV: kv,
    });
    const pathB = env({
      INFISICAL_APP_PROJECT_ID: appProject,
      INFISICAL_APP_CLIENT_SECRET: 'fixture-key-'.repeat(4),
      INFISICAL_SECRET_PATH: '/legacy-b',
      CONFIG_KV: kv,
    });

    const firstResolver = await import('../infisical.ts');
    await firstResolver.refreshSecrets(pathA);
    expect(rows.size).toBeGreaterThan(0);

    vi.resetModules();
    const secondResolver = await import('../infisical.ts');
    expect(await secondResolver.resolveSecret(pathB, 'FMP_API_KEY')).toEqual({ value: 'legacy-b-fmp', source: 'infisical' });
    expect(appPaths).toEqual(['/legacy-a', '/legacy-b']);
    const callsAfterPathB = fetchMock.mock.calls.length;

    vi.resetModules();
    const restartedResolver = await import('../infisical.ts');
    expect(await restartedResolver.resolveSecret(pathA, 'FMP_API_KEY')).toEqual({ value: 'legacy-a-fmp', source: 'infisical' });
    expect(fetchMock.mock.calls.length).toBe(callsAfterPathB);
  });

  it('prefers the explicit app path and reuses the cache for its legacy alias', async () => {
    const appProject = 'app-project-explicit-path';
    const appPaths: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/v1/auth/universal-auth/login')) {
        return Response.json({ accessToken: 'token' });
      }
      if (url.includes('/api/v3/secrets/raw')) {
        const parsed = new URL(url);
        if (parsed.searchParams.get('workspaceId') === appProject) {
          const path = parsed.searchParams.get('secretPath') ?? '/';
          appPaths.push(path);
          return Response.json({ secrets: [{ secretKey: 'FMP_API_KEY', secretValue: 'preferred-fmp' }] });
        }
        return Response.json({ secrets: [] });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const explicitPath = env({
      INFISICAL_APP_PROJECT_ID: appProject,
      INFISICAL_APP_SECRET_PATH: '/preferred',
      INFISICAL_SECRET_PATH: '/ignored-legacy',
    });
    const legacyAlias = env({
      INFISICAL_APP_PROJECT_ID: appProject,
      INFISICAL_SECRET_PATH: '/preferred',
    });
    await refreshSecrets(explicitPath);

    expect(await resolveSecret(legacyAlias, 'FMP_API_KEY')).toEqual({ value: 'preferred-fmp', source: 'infisical' });
    expect(appPaths).toEqual(['/preferred']);
  });

  it('does not write KV when the encrypted cache blob would exceed the Deno KV limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/v1/auth/universal-auth/login')) return Response.json({ accessToken: 'token' });
        if (url.includes('/api/v3/secrets/raw')) {
          const huge = 'x'.repeat(INFISICAL_KV_CACHE_MAX_BYTES);
          return Response.json({ secrets: [{ secretKey: 'BLOB', secretValue: huge }] });
        }
        return new Response('not found', { status: 404 });
      }),
    );
    const kvPut = vi.fn(async () => {});
    const e = env({
      INFISICAL_APP_PROJECT_ID: 'app-project-kv-limit',
      INFISICAL_APP_CLIENT_SECRET: 'fixture-key-'.repeat(4),
      CONFIG_KV: { get: vi.fn(), put: kvPut, delete: vi.fn() } as unknown as KVNamespace,
    });
    await refreshSecrets(e);
    expect(kvPut).not.toHaveBeenCalled();
  });

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
