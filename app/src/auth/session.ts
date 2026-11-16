/**
 * src/auth/session.ts
 * Opaque, KV-backed end-user sessions + the httpOnly session cookie.
 *
 * A session is a high-entropy random token stored in CONFIG_KV under
 * `sess:<token>` with a 30-day TTL; the token rides in the `ct_session` cookie
 * (HttpOnly, SameSite=Lax, Secure on https). Each request resolves token ->
 * userId (KV) -> fresh User row (D1), so profile/subscription changes are seen
 * immediately and logout is a single KV delete. We reuse CONFIG_KV (prefixed)
 * to avoid a new binding; a dedicated AUTH_KV can be split out later.
 */

import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env, User } from '../shared/types.ts';
import { getUserById } from './users.ts';
import { randomToken } from './tokens.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { isSecureRequest } from '../security/requestProtocol.ts';

export const SESSION_COOKIE = 'ct_session';
const SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 days
const SESSION_PREFIX = 'sess:';
const SESSION_USER_PREFIX = 'sess_user:';

interface SessionData {
  userId: string;
}

function parseTokenList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((token): token is string => typeof token === 'string' && token.length > 0);
  } catch {
    return [];
  }
}

async function indexUserSession(env: Env, userId: string, token: string): Promise<void> {
  const key = SESSION_USER_PREFIX + userId;
  const tokens = parseTokenList(await env.CONFIG_KV.get(key));
  if (!tokens.includes(token)) tokens.push(token);
  await env.CONFIG_KV.put(key, JSON.stringify(tokens), { expirationTtl: SESSION_TTL_SEC });
}

async function unindexUserSession(env: Env, userId: string, token: string): Promise<void> {
  const key = SESSION_USER_PREFIX + userId;
  const tokens = parseTokenList(await env.CONFIG_KV.get(key)).filter((item) => item !== token);
  if (tokens.length === 0) {
    await env.CONFIG_KV.delete(key);
    return;
  }
  await env.CONFIG_KV.put(key, JSON.stringify(tokens), { expirationTtl: SESSION_TTL_SEC });
}

/** Create a session for `userId` and return its opaque token. */
export async function createSession(env: Env, userId: string): Promise<string> {
  const token = randomToken(32);
  const data: SessionData = { userId };
  await env.CONFIG_KV.put(SESSION_PREFIX + token, JSON.stringify(data), {
    expirationTtl: SESSION_TTL_SEC,
  });
  await indexUserSession(env, userId, token);
  return token;
}

// CT-2459: 30s isolate cache for token -> userId ONLY. The User row is
// still fetched fresh on every request (profile/subscription freshness is
// the design goal above); this only skips the KV/SQL round trip that maps
// token to user. Logout in this isolate invalidates immediately via
// destroySession/destroySessionsForUser; a logout in another isolate takes
// effect here within the TTL.
const SESSION_IDENTITY_CACHE_MS = 30_000;
const tokenUserCache = new Map<string, { userId: string; expiresAtMs: number }>();

/** Test hook: drop the identity cache. */
export function resetSessionIdentityCacheForTests(): void {
  tokenUserCache.clear();
}

/** Resolve a session token to its fresh User (or null if missing/expired). */
export async function resolveSession(env: Env, token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const cachedIdentity = tokenUserCache.get(token);
  if (cachedIdentity && cachedIdentity.expiresAtMs > Date.now()) {
    return getUserById(env, cachedIdentity.userId);
  }
  const raw = await env.CONFIG_KV.get(SESSION_PREFIX + token);
  if (!raw) return null;
  let data: SessionData;
  try {
    data = JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
  if (!data.userId) return null;
  if (tokenUserCache.size >= 1_000) tokenUserCache.clear();
  tokenUserCache.set(token, {
    userId: data.userId,
    expiresAtMs: Date.now() + SESSION_IDENTITY_CACHE_MS,
  });
  return getUserById(env, data.userId);
}

export async function destroySession(env: Env, token: string | undefined): Promise<void> {
  if (!token) return;
  tokenUserCache.delete(token);
  const raw = await env.CONFIG_KV.get(SESSION_PREFIX + token);
  await env.CONFIG_KV.delete(SESSION_PREFIX + token);
  if (!raw) return;
  try {
    const data = JSON.parse(raw) as SessionData;
    if (data.userId) await unindexUserSession(env, data.userId, token);
  } catch {
    // Corrupt session payload — the token is already gone.
  }
}

/** Revoke every indexed session for `userId`.  Older tokens minted before the
 * reverse index still become inert once the `users` row is deleted. */
export async function destroySessionsForUser(env: Env, userId: string): Promise<number> {
  if (!env.CONFIG_KV) return 0;
  const key = SESSION_USER_PREFIX + userId;
  const tokens = parseTokenList(await env.CONFIG_KV.get(key));
  for (const token of tokens) tokenUserCache.delete(token);
  await Promise.all(tokens.map((token) => env.CONFIG_KV.delete(SESSION_PREFIX + token)));
  await env.CONFIG_KV.delete(key);
  return tokens.length;
}

/**
 * Legacy Domain= attribute derivation, retained ONLY so logout can evict
 * session cookies issued before the switch to host-only cookies (CT-AUD-007).
 * Cookies are no longer EMITTED with a Domain attribute: a Domain= cookie is
 * sent to every subdomain, so a compromised or hostile sibling host (e.g.
 * evil.congress.trade) would receive the session token.
 */
async function legacyCookieDomain(c: Context<{ Bindings: Env }>): Promise<string | undefined> {
  const configured = (await resolveSecret(c.env, 'APP_BASE_URL')).value?.trim();
  if (!configured) return undefined;
  try {
    const hostname = new URL(configured).hostname;
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.endsWith('.localhost') ||
      hostname.includes(':')
    ) {
      return undefined;
    }
    return hostname;
  } catch {
    return undefined;
  }
}

/**
 * Post-login redirect validation: exact-origin allowlist only (CT-AUD-007).
 * A candidate origin is accepted when it exactly matches the configured
 * APP_BASE_URL origin, or is localhost/127.0.0.1 (local dev). Anything else —
 * including sibling subdomains like https://evil.congress.trade — falls back
 * to the configured base.
 */
export function getSafeRedirectUrl(origin: string | undefined, defaultBase: string): string {
  if (!origin) return defaultBase;
  try {
    const originUrl = new URL(origin);
    const defaultUrl = new URL(defaultBase);

    // iOS app scheme is safe
    if (originUrl.protocol === 'congresstrade:') return origin;

    // Exact match on the configured origin is safe.
    if (originUrl.origin === defaultUrl.origin) return origin;

    // Local dev is safe.
    if (originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1') return origin;

    return defaultBase;
  } catch {
    return defaultBase;
  }
}

/** Host-only session cookie: Domain is deliberately omitted (CT-AUD-007). */
export async function setSessionCookie(c: Context<{ Bindings: Env }>, token: string): Promise<void> {
  // Expire the legacy Domain-scoped cookie first. Browsers process Set-Cookie
  // headers in order; emitting this after the host-only replacement can expire
  // the just-issued cookie on the apex host as well.
  const legacyDomain = await legacyCookieDomain(c);
  if (legacyDomain) deleteCookie(c, SESSION_COOKIE, { path: '/', domain: legacyDomain });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecureRequest(c),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SEC,
  });
}

export async function clearSessionCookie(c: Context<{ Bindings: Env }>): Promise<void> {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  // Also evict any pre-host-only cookie that was issued with Domain=<apex>;
  // it is a distinct cookie in the browser jar and would otherwise linger.
  const legacyDomain = await legacyCookieDomain(c);
  if (legacyDomain) deleteCookie(c, SESSION_COOKIE, { path: '/', domain: legacyDomain });
}

export function getSessionToken(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

/**
 * Every ct_session value present on the request. During the host-only cookie
 * migration a browser can hold two ct_session cookies (the legacy Domain=apex
 * one and the new host-only one); logout must revoke both KV sessions, and
 * Hono's getCookie only surfaces one of them.
 */
function allCookieSessionTokens(c: Context): string[] {
  const header = c.req.header('Cookie');
  if (!header) return [];
  const tokens: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (value) tokens.push(value);
  }
  return tokens;
}

function bearerSessionToken(c: Context): string | undefined {
  const value = c.req.header('Authorization');
  const prefix = 'Bearer ';
  if (!value || !value.startsWith(prefix)) return undefined;
  const token = value.slice(prefix.length).trim();
  return token || undefined;
}

/** Resolve a session from the httpOnly cookie first, then a bearer token.
 * Native clients use the bearer path; browser clients keep the cookie path. */
export function getSessionTokenFromRequest(c: Context): string | undefined {
  return getSessionTokensFromRequest(c)[0];
}

/** Return every distinct session credential presented by the request. Logout
 * uses this to revoke browser cookies (including a duplicate legacy
 * Domain-scoped cookie) and a native bearer token together. */
export function getSessionTokensFromRequest(c: Context): string[] {
  const tokens = [...allCookieSessionTokens(c), bearerSessionToken(c)].filter(
    (token): token is string => Boolean(token),
  );
  return [...new Set(tokens)];
}

/** Resolve the current end user from the request cookie (or null). */
export async function getCurrentUser(c: Context<{ Bindings: Env }>): Promise<User | null> {
  return resolveSession(c.env, getSessionToken(c));
}

/** Resolve the current end user from cookie or Authorization bearer token. */
export async function getCurrentUserFromRequest(c: Context<{ Bindings: Env }>): Promise<User | null> {
  return resolveSession(c.env, getSessionTokenFromRequest(c));
}
