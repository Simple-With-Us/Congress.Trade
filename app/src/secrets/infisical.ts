/**
 * Runtime secret resolver backed by Infisical machine identities.
 *
 * Cloudflare Worker secrets should only need to hold the Infisical bootstrap
 * credentials. Provider keys are read from Infisical on demand and cached in
 * isolate memory for a short TTL. Optional KV caching is encrypted only when
 * strong runtime secret material is configured; no resolved secret values are
 * written to D1, R2, logs, or diagnostics.
 */

import type { Env } from '../shared/types.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

export type SourceName = 'app' | 'shared';

export interface SecretMutationOptions {
  /** Abort authentication and mutation HTTP requests as one bounded operation. */
  signal?: AbortSignal;
}

interface SourceConfig {
  name: SourceName;
  projectId?: string;
  clientId?: string;
  clientSecret?: string;
  secretPath: string;
}

interface CacheEntry {
  key: string;
  values: Record<string, string>;
  fetchedAt: number;
  expiresAt: number;
  errors: string[];
  sources: Array<{ name: SourceName; configured: boolean; ok: boolean; count: number; error?: string }>;
}

export interface SecretResolution {
  value?: string;
  source: 'infisical' | 'env' | 'missing';
}

export interface SecretResolverStatus {
  enabled: boolean;
  cacheReady: boolean;
  cacheAgeSeconds: number | null;
  cacheTtlSeconds: number;
  cacheExpiresInSeconds: number | null;
  envFallbackAllowed: boolean;
  lastRefreshAt: string | null;
  errors: string[];
  sources: Array<{ name: SourceName; configured: boolean; ok: boolean; count: number; error?: string }>;
}

const DEFAULT_BASE_URL = 'https://app.infisical.com';
const DEFAULT_ENV = 'prod';
const DEFAULT_TTL_SECONDS = 600;

const cache = new Map<string, CacheEntry>();

function cleanBaseUrl(raw: string | undefined): string {
  return (raw || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function cacheTtlSeconds(env: Env): number {
  const n = Number.parseInt(env.INFISICAL_CACHE_TTL_SECONDS || '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3600) : DEFAULT_TTL_SECONDS;
}

/**
 * prod is the only Infisical environment the fleet reads (owner 2026-10-10:
 * dev and staging are retired).  Unset or blank falls back to prod and
 * "production" is accepted as an alias;  anything else is refused so a stale
 * INFISICAL_ENV can never read, or write to, a retired environment.
 */
function envName(env: Env): string {
  const val = (env.INFISICAL_ENV || '').trim();
  if (!val || val === DEFAULT_ENV || val === 'production') return DEFAULT_ENV;
  throw new Error(
    `INFISICAL_ENV must be "${DEFAULT_ENV}" (dev and staging are retired); got "${val.slice(0, 32)}"`,
  );
}

function envFallbackAllowed(env: Env): boolean {
  return env.INFISICAL_ALLOW_ENV_FALLBACK !== 'false';
}

function strongSecret(value: string | undefined): string | null {
  const clean = value?.trim();
  if (!clean || clean.length < 32) return null;
  if (/^(changeme|password|secret|test|dev)$/i.test(clean)) return null;
  return clean;
}

function kvCacheSecret(env: Env): string | null {
  return (
    strongSecret(env.INFISICAL_APP_CLIENT_SECRET) ??
    strongSecret(env.INFISICAL_SHARED_CLIENT_SECRET) ??
    strongSecret(env.ADMIN_TOKEN)
  );
}

function sourceConfigs(env: Env): SourceConfig[] {
  // The explicit *_PROJECT_ID env wins. When only a machine-identity CLIENT_ID
  // is present (e.g. image-baked identities without the project-id vars), fall
  // back to the statically known project for each source — each source's
  // identity only ever pairs with its own project, so no client-id lookup map
  // is needed (the old KNOWN_PROJECT_IDS literal map was scrubbed, breaking
  // the build with duplicate keys).
  const sharedProj = env.INFISICAL_SHARED_PROJECT_ID;
  const appProj = env.INFISICAL_APP_PROJECT_ID;

  // Coolify historically set INFISICAL_CLIENT_ID/SECRET (no _APP_). Prefer the
  // explicit APP_* names the rest of the codebase documents; fall back to the
  // legacy CLIENT_* pair so a missing rename does not 401 the app project.
  const appClientId = env.INFISICAL_APP_CLIENT_ID || env.INFISICAL_CLIENT_ID;
  const appClientSecret = env.INFISICAL_CLIENT_SECRET || env.INFISICAL_APP_CLIENT_SECRET;

  // Merge order: shared first, then app.  App wins on a name collision, so
  // fleet-wide keys (AGENT_SYNC_TOKEN, AGENT_SYNC_POST_TOKEN) MUST live only
  // in shared-at-ct.  Duplicating them on the ST/CT app projects shadows the
  // shared row and makes rotation a three-project chore.
  return [
    {
      name: 'shared',
      projectId: sharedProj,
      clientId: env.INFISICAL_SHARED_CLIENT_ID,
      clientSecret: env.INFISICAL_SHARED_CLIENT_SECRET,
      secretPath: env.INFISICAL_SHARED_SECRET_PATH || '/',
    },
    {
      name: 'app',
      projectId: appProj,
      clientId: appClientId,
      clientSecret: appClientSecret,
      secretPath: env.INFISICAL_APP_SECRET_PATH || env.INFISICAL_SECRET_PATH || '/',
    },
  ];
}

function sourceConfigured(source: SourceConfig): boolean {
  return Boolean(source.projectId && source.clientId && source.clientSecret);
}

function configuredSources(env: Env): SourceConfig[] {
  return sourceConfigs(env).filter(sourceConfigured);
}

function resolverEnabled(env: Env): boolean {
  return configuredSources(env).length > 0;
}

function cacheKey(env: Env): string {
  return [
    cleanBaseUrl(env.INFISICAL_BASE_URL),
    envName(env),
    env.INFISICAL_SHARED_PROJECT_ID || '',
    env.INFISICAL_SHARED_SECRET_PATH || '/',
    env.INFISICAL_APP_PROJECT_ID || '',
    env.INFISICAL_APP_SECRET_PATH || '/',
  ].join('|');
}

function redactedError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]').slice(0, 300);
}

async function login(
  baseUrl: string,
  source: SourceConfig,
  signal?: AbortSignal,
): Promise<string> {
  const res = await trackedFetch(`${baseUrl}/api/v1/auth/universal-auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: source.clientId, clientSecret: source.clientSecret }),
    signal,
  }, { service: 'secret-management', operation: 'authenticate', dynamicTarget: 'infisical' });
  const body = (await res.json().catch(() => ({}))) as { accessToken?: string; token?: string; message?: string };
  if (!res.ok) throw new Error(`Infisical ${source.name} auth failed: HTTP ${res.status} ${body.message || ''}`.trim());
  const token = body.accessToken || body.token;
  if (!token) throw new Error(`Infisical ${source.name} auth failed: no access token`);
  return token;
}

function secretEntries(payload: unknown): Array<{ key: string; value: string }> {
  const root = payload as {
    secrets?: unknown;
    secret?: unknown;
    data?: { secrets?: unknown; secret?: unknown };
  };
  const raw = root.secrets ?? root.data?.secrets ?? root.secret ?? root.data?.secret ?? [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const shapedKey = obj.secretKey ?? obj.key ?? obj.name;
    const shapedValue = obj.secretValue ?? obj.value;
    if (typeof shapedKey !== 'string' && typeof shapedValue !== 'string') {
      return Object.entries(obj)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([key, value]) => ({ key, value }));
    }
  }
  const arr = Array.isArray(raw) ? raw : [raw];
  const entries: Array<{ key: string; value: string }> = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const key = obj.secretKey ?? obj.key ?? obj.name;
    const value = obj.secretValue ?? obj.value;
    if (typeof key === 'string' && typeof value === 'string') entries.push({ key, value });
  }
  return entries;
}

async function fetchSourceSecrets(
  baseUrl: string,
  infisicalEnv: string,
  source: SourceConfig,
  includeImports = true,
): Promise<Record<string, string>> {
  const token = await login(baseUrl, source);
  const params = new URLSearchParams({
    workspaceId: source.projectId || '',
    environment: infisicalEnv,
    secretPath: source.secretPath || '/',
    include_imports: includeImports ? 'true' : 'false',
    recursive: 'true',
  });
  const res = await trackedFetch(`${baseUrl}/api/v3/secrets/raw?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  }, { service: 'secret-management', operation: 'read-secrets', dynamicTarget: 'infisical' });
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new Error(`Infisical ${source.name} secrets failed: HTTP ${res.status} ${body.message || ''}`.trim());
  return Object.fromEntries(secretEntries(body).map((entry) => [entry.key, entry.value]));
}

function configuredSource(env: Env, sourceName: SourceName): SourceConfig {
  const source = sourceConfigs(env).find((candidate) => candidate.name === sourceName);
  if (!source || !sourceConfigured(source)) {
    throw new Error(`Source ${sourceName} not configured`);
  }
  return source;
}

/** Read only values owned by one Infisical project/path, excluding imports. */
export async function readSourceSecrets(
  env: Env,
  sourceName: SourceName,
): Promise<Record<string, string>> {
  const source = configuredSource(env, sourceName);
  return fetchSourceSecrets(cleanBaseUrl(env.INFISICAL_BASE_URL), envName(env), source, false);
}


async function getCryptoKey(secretString: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyData = await crypto.subtle.digest('SHA-256', enc.encode(secretString));
  return crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptData(text: string, secretString: string): Promise<string> {
  const key = await getCryptoKey(secretString);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(text)
  );
  
  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join('');
  const ciphertextBytes = new Uint8Array(encrypted);
  const ciphertextHex = Array.from(ciphertextBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  
  return `${ivHex}:${ciphertextHex}`;
}

async function decryptData(encryptedStr: string, secretString: string): Promise<string> {
  const [ivHex, ciphertextHex] = encryptedStr.split(':');
  if (!ivHex || !ciphertextHex) throw new Error('Invalid encrypted format');

  const ivPairs = ivHex.match(/.{1,2}/g);
  const ciphertextPairs = ciphertextHex.match(/.{1,2}/g);
  if (!ivPairs || !ciphertextPairs) throw new Error('Invalid encrypted format');
  
  const key = await getCryptoKey(secretString);
  const iv = new Uint8Array(ivPairs.map(byte => parseInt(byte, 16)));
  const ciphertext = new Uint8Array(ciphertextPairs.map(byte => parseInt(byte, 16)));
  
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  
  const dec = new TextDecoder();
  return dec.decode(decrypted);
}

async function invalidateSecretCache(env: Env): Promise<void> {
  const key = cacheKey(env);
  cache.delete(key);
  const kvSecret = kvCacheSecret(env);
  if (env.CONFIG_KV && kvSecret) {
    try {
      await env.CONFIG_KV.delete(`infisical_secrets_cache:${key}`);
    } catch (err) {
      console.warn('infisical: failed to clear KV cache', (err as Error).message);
    }
  }
}

export async function updateSecret(
  env: Env,
  sourceName: SourceName,
  secretKey: string,
  secretValue: string,
  options: SecretMutationOptions = {},
): Promise<void> {
  const source = configuredSource(env, sourceName);
  
  const baseUrl = cleanBaseUrl(env.INFISICAL_BASE_URL);
  const infisicalEnv = envName(env);
  const token = await login(baseUrl, source, options.signal);
  
  const payload = {
    workspaceId: source.projectId,
    environment: infisicalEnv,
    secretPath: source.secretPath || '/',
    secretValue: secretValue,
    type: 'shared'
  };

  let res = await trackedFetch(`${baseUrl}/api/v3/secrets/raw/${secretKey}`, {
    method: 'PATCH',
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal: options.signal,
  }, { service: 'secret-management', operation: 'update-secret', dynamicTarget: 'infisical' });

  if (!res.ok) {
    if (res.status === 404 || res.status === 400) {
      res = await trackedFetch(`${baseUrl}/api/v3/secrets/raw/${secretKey}`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: options.signal,
      }, { service: 'secret-management', operation: 'create-secret', dynamicTarget: 'infisical' });
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { message?: string };
      throw new Error(`Failed to update secret ${secretKey}: ${res.status} ${body.message || ''}`);
    }
  }

  await invalidateSecretCache(env);
}

/** Delete one source-owned override so rollback can restore inherited values. */
export async function deleteSecret(
  env: Env,
  sourceName: SourceName,
  secretKey: string,
  options: SecretMutationOptions = {},
): Promise<void> {
  const source = configuredSource(env, sourceName);
  const baseUrl = cleanBaseUrl(env.INFISICAL_BASE_URL);
  const infisicalEnv = envName(env);
  const token = await login(baseUrl, source, options.signal);
  const res = await trackedFetch(`${baseUrl}/api/v3/secrets/raw/${secretKey}`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      workspaceId: source.projectId,
      environment: infisicalEnv,
      secretPath: source.secretPath || '/',
      type: 'shared',
    }),
    signal: options.signal,
  }, { service: 'secret-management', operation: 'delete-secret', dynamicTarget: 'infisical' });
  if (!res.ok && res.status !== 404) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(`Failed to delete secret ${secretKey}: ${res.status} ${body.message || ''}`.trim());
  }
  await invalidateSecretCache(env);
}

export async function refreshSecrets(env: Env): Promise<SecretResolverStatus> {
  const key = cacheKey(env);
  const ttlMs = cacheTtlSeconds(env) * 1000;
  const now = Date.now();
  const baseUrl = cleanBaseUrl(env.INFISICAL_BASE_URL);
  const infisicalEnv = envName(env);
  const sources = sourceConfigs(env);
  const values: Record<string, string> = {};
  const errors: string[] = [];
  const sourceStatus: CacheEntry['sources'] = [];

  for (const source of sources) {
    if (!sourceConfigured(source)) {
      sourceStatus.push({ name: source.name, configured: false, ok: false, count: 0 });
      continue;
    }
    try {
      const sourceValues = await fetchSourceSecrets(baseUrl, infisicalEnv, source);
      Object.assign(values, sourceValues);
      sourceStatus.push({ name: source.name, configured: true, ok: true, count: Object.keys(sourceValues).length });
    } catch (err) {
      const error = redactedError(err);
      errors.push(error);
      sourceStatus.push({ name: source.name, configured: true, ok: false, count: 0, error });
    }
  }

  const entry: CacheEntry = {
    key,
    values,
    fetchedAt: now,
    expiresAt: now + ttlMs,
    errors,
    sources: sourceStatus,
  };
  cache.set(key, entry);

  const kvSecret = kvCacheSecret(env);
  if (env.CONFIG_KV && kvSecret && errors.length === 0 && Object.keys(values).length > 0) {
    try {
      const kvKey = `infisical_secrets_cache:${key}`;
      const encrypted = await encryptData(JSON.stringify(entry), kvSecret);
      const ttlSec = cacheTtlSeconds(env);
      await env.CONFIG_KV.put(kvKey, encrypted, { expirationTtl: ttlSec });
    } catch (err) {
      console.warn('infisical: failed to encrypt or write to KV cache', (err as Error).message);
    }
  }

  return statusFromEntry(env, entry);
}

async function cacheEntry(env: Env): Promise<CacheEntry | null> {
  if (!resolverEnabled(env)) return null;
  const key = cacheKey(env);
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing;

  const kvSecret = kvCacheSecret(env);
  if (env.CONFIG_KV && kvSecret) {
    try {
      const kvKey = `infisical_secrets_cache:${key}`;
      const encrypted = await env.CONFIG_KV.get(kvKey);
      if (encrypted) {
        const decryptedJson = await decryptData(encrypted, kvSecret);
        const entry = JSON.parse(decryptedJson) as CacheEntry;
        if (entry && entry.expiresAt > Date.now()) {
          cache.set(key, entry);
          return entry;
        }
      }
    } catch (err) {
      console.warn('infisical: failed to read or decrypt KV cache', (err as Error).message);
    }
  }

  await refreshSecrets(env);
  return cache.get(key) ?? null;
}

export async function resolveSecret(env: Env, key: keyof Env & string): Promise<SecretResolution> {
  const entry = await cacheEntry(env);
  const value = entry?.values[key];
  if (value) return { value, source: 'infisical' };
  const envValue = envFallbackAllowed(env) ? env[key] : undefined;
  return typeof envValue === 'string' && envValue.length > 0
    ? { value: envValue, source: 'env' }
    : { source: 'missing' };
}

export async function resolveSecrets<T extends string>(env: Env, keys: T[]): Promise<Record<T, string | undefined>> {
  const entries = await Promise.all(keys.map(async (key) => [key, (await resolveSecret(env, key as keyof Env & string)).value] as const));
  return Object.fromEntries(entries) as Record<T, string | undefined>;
}

function statusFromEntry(env: Env, entry: CacheEntry | null): SecretResolverStatus {
  const now = Date.now();
  return {
    enabled: resolverEnabled(env),
    cacheReady: Boolean(entry && Object.keys(entry.values).length > 0),
    cacheAgeSeconds: entry ? Math.max(0, Math.round((now - entry.fetchedAt) / 1000)) : null,
    cacheTtlSeconds: cacheTtlSeconds(env),
    cacheExpiresInSeconds: entry ? Math.max(0, Math.round((entry.expiresAt - now) / 1000)) : null,
    envFallbackAllowed: envFallbackAllowed(env),
    lastRefreshAt: entry ? new Date(entry.fetchedAt).toISOString() : null,
    errors: entry?.errors ?? [],
    sources: entry?.sources ?? sourceConfigs(env).map((source) => ({
      name: source.name,
      configured: sourceConfigured(source),
      ok: false,
      count: 0,
    })),
  };
}

export function getSecretResolverStatus(env: Env): SecretResolverStatus {
  return statusFromEntry(env, cache.get(cacheKey(env)) ?? null);
}
