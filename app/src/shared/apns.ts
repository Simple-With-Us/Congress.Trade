/**
 * Apple Push Notification service client (HTTP/2).
 *
 * WHY NOT fetch: APNs requires HTTP/2. Tests inject a transport and never open
 * a socket to Apple. Production uses node:http2 (Deno/Node). Missing credentials
 * return null so callers fail soft.
 *
 * Secrets (Infisical/env, never logged):
 *   key id, team id, bundle id (the APNs topic),
 *   plus the .p8 material via the APNS p8 env var, or the private-key / private-key-b64 env vars.
 */

import { createPrivateKey, sign } from 'node:crypto';
import http2 from 'node:http2';

export const APNS_ENDPOINTS = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
} as const;

export const APNS_TOKEN_REFRESH_MS = 50 * 60_000;
export const APNS_COLLAPSE_ID_MAX = 64;
export const DEFAULT_APNS_BUNDLE_ID = 'trade.congress.ios';

export type ApnsEnvSource = Record<string, string | undefined>;

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  bundleId: string;
  privateKeyPem: string;
}

export type ApnsEnvironment = keyof typeof APNS_ENDPOINTS;

export interface ApnsHttpRequest {
  origin: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface ApnsHttpResponse {
  status: number;
  body: string;
}

export type ApnsTransport = (request: ApnsHttpRequest, timeoutMs: number) => Promise<ApnsHttpResponse>;

export type ApnsDisposition = 'delivered' | 'token_dead' | 'auth_error' | 'retryable' | 'permanent';

export interface ApnsSendResult {
  ok: boolean;
  disposition: ApnsDisposition;
  status?: number;
  reason?: string;
  error?: string;
}

export interface ApnsAlert {
  title: string;
  body: string;
  collapseId?: string;
  data?: Record<string, unknown>;
}

export interface ApnsSendInput extends ApnsAlert {
  deviceToken: string;
  environment: ApnsEnvironment;
}

export interface ApnsSendDeps {
  config: ApnsConfig;
  transport?: ApnsTransport;
  timeoutMs?: number;
  nowMs?: number;
}

function looksLikePem(value: string): boolean {
  return value.includes('BEGIN') && value.includes('PRIVATE KEY');
}

export function decodeApnsPrivateKeyPem(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const unescaped = trimmed.includes('\\n') ? trimmed.replace(/\\n/g, '\n') : trimmed;
  if (looksLikePem(unescaped)) return unescaped;
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    if (looksLikePem(decoded)) return decoded;
  } catch {
    return null;
  }
  return null;
}

export function loadApnsConfig(env: ApnsEnvSource): ApnsConfig | null {
  const keyId = (env.APNS_KEY_ID ?? '').trim();
  const teamId = (env.APNS_TEAM_ID ?? '').trim();
  const bundleId = (env.APNS_BUNDLE_ID ?? DEFAULT_APNS_BUNDLE_ID).trim();
  const rawKey = (env.APNS_P8 ?? env.APNS_PRIVATE_KEY ?? env.APNS_PRIVATE_KEY_B64 ?? '').trim();
  if (!keyId || !teamId || !bundleId || !rawKey) return null;
  const privateKeyPem = decodeApnsPrivateKeyPem(rawKey);
  if (!privateKeyPem) return null;
  return { keyId, teamId, bundleId, privateKeyPem };
}

export function apnsConfigured(config: ApnsConfig | null | undefined): config is ApnsConfig {
  return !!config && !!config.keyId && !!config.teamId && !!config.bundleId && !!config.privateKeyPem;
}

export function resolveApnsEnvironment(value: string | null | undefined): ApnsEnvironment {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'sandbox' || normalized === 'development' || normalized === 'debug') {
    return 'sandbox';
  }
  return 'production';
}

type CachedProviderToken = { jwt: string; issuedAtMs: number };
const providerTokenCache = new Map<string, CachedProviderToken>();

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function providerTokenCacheKey(config: ApnsConfig): string {
  return `${config.teamId}:${config.keyId}`;
}

export function getApnsProviderToken(config: ApnsConfig, nowMs: number = Date.now()): string {
  const cacheKey = providerTokenCacheKey(config);
  const cached = providerTokenCache.get(cacheKey);
  if (cached && nowMs - cached.issuedAtMs < APNS_TOKEN_REFRESH_MS) return cached.jwt;

  const iat = Math.floor(nowMs / 1000);
  const header = base64Url(JSON.stringify({ alg: 'ES256', kid: config.keyId }));
  const claims = base64Url(JSON.stringify({ iss: config.teamId, iat }));
  const signingInput = `${header}.${claims}`;
  const key = createPrivateKey({ key: config.privateKeyPem, format: 'pem' });
  const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  const jwt = `${signingInput}.${base64Url(signature)}`;
  providerTokenCache.set(cacheKey, { jwt, issuedAtMs: nowMs });
  return jwt;
}

export function invalidateApnsProviderToken(config?: ApnsConfig): void {
  if (config) providerTokenCache.delete(providerTokenCacheKey(config));
  else providerTokenCache.clear();
}

export const httpTwoApnsTransport: ApnsTransport = (request, timeoutMs) =>
  new Promise<ApnsHttpResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const session = http2.connect(request.origin);
    const cleanup = () => {
      try {
        session.close();
      } catch {
        /* already closing */
      }
    };
    session.on('error', (error) =>
      finish(() => {
        cleanup();
        reject(error);
      }),
    );

    const stream = session.request({
      ':method': 'POST',
      ':path': request.path,
      ...request.headers,
    });
    stream.setEncoding('utf8');
    stream.setTimeout(timeoutMs, () => {
      finish(() => {
        try {
          stream.close(http2.constants.NGHTTP2_CANCEL);
        } catch {
          /* already closed */
        }
        cleanup();
        reject(new Error(`APNs request timed out after ${timeoutMs}ms`));
      });
    });

    let status = 0;
    let body = '';
    stream.on('response', (headers) => {
      status = Number(headers[':status'] ?? 0);
    });
    stream.on('data', (chunk: string) => {
      body += chunk;
    });
    stream.on('error', (error) =>
      finish(() => {
        cleanup();
        reject(error);
      }),
    );
    stream.on('end', () =>
      finish(() => {
        cleanup();
        resolve({ status, body });
      }),
    );
    stream.end(request.body);
  });

function classify(status: number, reason: string | undefined): ApnsDisposition {
  if (status === 200) return 'delivered';
  if (status === 410) return 'token_dead';
  if (status === 400 && reason === 'BadDeviceToken') return 'token_dead';
  if (status === 403 || status === 401) return 'auth_error';
  if (status === 429 || status >= 500) return 'retryable';
  return 'permanent';
}

function parseReason(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === 'string' ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
}

export function buildApnsPayload(alert: ApnsAlert): Record<string, unknown> {
  return {
    aps: {
      alert: { title: alert.title, body: alert.body },
      sound: 'default',
      'interruption-level': 'active',
    },
    ...(alert.data ?? {}),
  };
}

export async function sendApnsPush(input: ApnsSendInput, deps: ApnsSendDeps): Promise<ApnsSendResult> {
  const transport = deps.transport ?? httpTwoApnsTransport;
  const timeoutMs = deps.timeoutMs ?? 5000;
  const origin = APNS_ENDPOINTS[input.environment];

  let jwt: string;
  try {
    jwt = getApnsProviderToken(deps.config, deps.nowMs ?? Date.now());
  } catch (error) {
    return {
      ok: false,
      disposition: 'auth_error',
      error: `APNs provider token could not be signed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const headers: Record<string, string> = {
    authorization: `bearer ${jwt}`,
    'apns-topic': deps.config.bundleId,
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'content-type': 'application/json',
  };
  if (input.collapseId) {
    headers['apns-collapse-id'] = input.collapseId.slice(0, APNS_COLLAPSE_ID_MAX);
  }

  let response: ApnsHttpResponse;
  try {
    response = await transport(
      {
        origin,
        path: `/3/device/${input.deviceToken}`,
        headers,
        body: JSON.stringify(buildApnsPayload(input)),
      },
      timeoutMs,
    );
  } catch (error) {
    return {
      ok: false,
      disposition: 'retryable',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const reason = parseReason(response.body);
  const disposition = classify(response.status, reason);
  if (disposition === 'auth_error' && reason === 'ExpiredProviderToken') {
    invalidateApnsProviderToken(deps.config);
  }
  return {
    ok: disposition === 'delivered',
    disposition,
    status: response.status,
    ...(reason ? { reason } : {}),
    ...(disposition === 'delivered' ? {} : { error: `APNs HTTP ${response.status}${reason ? `: ${reason}` : ''}` }),
  };
}
