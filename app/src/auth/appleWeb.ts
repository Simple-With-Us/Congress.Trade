/**
 * src/auth/appleWeb.ts
 * Sign in with Apple for the website (Authorization Code). The iOS app uses
 * POST /auth/apple with a native identity token; the web button hits
 * GET /auth/apple/start, which used to 404.
 *
 * Needs a Services ID (APPLE_SERVICES_ID) plus the same team/key/.p8 used to
 * mint the client_secret JWT. When those are missing, start redirects with
 * auth_error=apple_web_not_configured instead of 404.
 */

import type { Env } from '../shared/types.ts';
import { resolveSecrets } from '../secrets/infisical.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

const AUTH_ENDPOINT = 'https://appleid.apple.com/auth/authorize';
const TOKEN_ENDPOINT = 'https://appleid.apple.com/auth/token';

export interface AppleWebConfig {
  servicesId: string;
  teamId: string;
  keyId: string;
  p8: string;
}

export async function loadAppleWebConfig(env: Env): Promise<AppleWebConfig | null> {
  const secrets = await resolveSecrets(env, [
    'APPLE_SERVICES_ID',
    'APPLE_TEAM_ID',
    'APPLE_KEY_ID',
    'APPLE_P8',
    'APPLE_PRIVATE_KEY',
  ]);
  const servicesId = secrets.APPLE_SERVICES_ID?.trim();
  const teamId = secrets.APPLE_TEAM_ID?.trim();
  const keyId = secrets.APPLE_KEY_ID?.trim();
  const p8 = (secrets.APPLE_P8 || secrets.APPLE_PRIVATE_KEY || '').trim();
  if (!servicesId || !teamId || !keyId || !p8) return null;
  return { servicesId, teamId, keyId, p8 };
}

function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  let bin = '';
  for (const b of raw) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function importP8(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

export async function appleClientSecret(cfg: AppleWebConfig, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = { alg: 'ES256', kid: cfg.keyId };
  const payload = {
    iss: cfg.teamId,
    iat: nowSec,
    exp: nowSec + 15777000,
    aud: 'https://appleid.apple.com',
    sub: cfg.servicesId,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = await importP8(cfg.p8);
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new TextEncoder().encode(signingInput),
    ),
  );
  return `${signingInput}.${b64url(sig)}`;
}

export function buildAppleAuthUrl(cfg: AppleWebConfig, redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    client_id: cfg.servicesId,
    redirect_uri: redirectUri,
    response_type: 'code',
    response_mode: 'form_post',
    scope: 'name email',
    state,
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

export async function exchangeAppleCode(
  cfg: AppleWebConfig,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const clientSecret = await appleClientSecret(cfg);
  const res = await trackedFetch(
    TOKEN_ENDPOINT,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: cfg.servicesId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    },
    { service: 'oauth', operation: 'apple-exchange-code' },
    fetchImpl,
  );
  const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!res.ok || !body.id_token) {
    throw new Error(`apple token exchange failed: ${body.error || `HTTP ${res.status}`}`);
  }
  return body.id_token;
}
