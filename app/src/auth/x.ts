/**
 * src/auth/x.ts
 * X (Twitter) OAuth 2.0 with PKCE (Proof Key for Code Exchange).
 *
 * Uses X API v2 (https://api.twitter.com/2/oauth2/token and
 * https://api.twitter.com/2/users/me) for authentication.
 */

import type { Env } from '../shared/types.ts';
import type { XProfile } from './users.ts';
import { resolveSecrets } from '../secrets/infisical.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import { randomToken } from './tokens.ts';

const AUTH_ENDPOINT = 'https://twitter.com/i/oauth2/authorize';
const TOKEN_ENDPOINT = 'https://api.twitter.com/2/oauth2/token';
const USERINFO_ENDPOINT = 'https://api.twitter.com/2/users/me';

/** Generate a PKCE Code Verifier (random string between 43 and 128 characters). */
export function generateCodeVerifier(): string {
  return randomToken(32);
}

/** Generate a PKCE Code Challenge from a Verifier (S256). */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Build the X OAuth 2.0 consent URL for PKCE authorization flow. */
export async function buildXAuthUrl(
  env: Env,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): Promise<string> {
  const { X_OAUTH_CLIENT_ID: clientId } = await resolveSecrets(env, ['X_OAUTH_CLIENT_ID']);
  if (!clientId) throw new Error('X_OAUTH_CLIENT_ID not configured');
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'tweet.read users.read offline.access',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Exchange an authorization code for an access token using PKCE. */
export async function exchangeXCode(
  env: Env,
  code: string,
  redirectUri: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const { X_OAUTH_CLIENT_ID: clientId, X_OAUTH_CLIENT_SECRET: clientSecret } = await resolveSecrets(env, [
    'X_OAUTH_CLIENT_ID',
    'X_OAUTH_CLIENT_SECRET',
  ]);
  if (!clientId || !clientSecret) throw new Error('X OAuth not configured');

  const credentials = btoa(`${clientId}:${clientSecret}`);
  const res = await trackedFetch(
    TOKEN_ENDPOINT,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }).toString(),
    },
    { service: 'oauth', operation: 'exchange-code-x' },
    fetchImpl,
  );

  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) {
    throw new Error(`x token exchange failed: ${body.error_description || body.error || `HTTP ${res.status}`}`);
  }
  return body.access_token;
}

interface XUserResponse {
  data?: {
    id: string;
    name: string;
    username: string;
    profile_image_url?: string;
  };
  errors?: Array<{ message: string }>;
}

/** Fetch the authenticated user's profile from X API v2. */
export async function fetchXProfile(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<XProfile> {
  const url = `${USERINFO_ENDPOINT}?user.fields=profile_image_url`;
  const res = await trackedFetch(
    url,
    {
      headers: { authorization: `Bearer ${accessToken}` },
    },
    { service: 'oauth', operation: 'userinfo-x' },
    fetchImpl,
  );

  const body = (await res.json().catch(() => ({}))) as XUserResponse;
  if (!res.ok || !body.data?.id) {
    const errMsg = body.errors?.[0]?.message || `HTTP ${res.status}`;
    throw new Error(`failed to fetch x user profile: ${errMsg}`);
  }

  return {
    sub: body.data.id,
    name: body.data.name,
    username: body.data.username,
    picture: body.data.profile_image_url ?? null,
  };
}
