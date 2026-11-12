/**
 * src/auth/routes.ts
 * End-user authentication router (mounted at /auth).
 *
 *   GET  /auth/me               -> { user: {id,email,name,picture} | null }
 *   POST /auth/logout           -> destroy session + clear cookie
 *   POST /auth/account/delete   -> delete the signed-in account + PII, then sign out
 *   GET  /auth/google/start     -> redirect to Google consent screen
 *   GET  /auth/google/callback  -> verify state, exchange code, create session
 *   POST /auth/magic/request    -> { email } : email a single-use sign-in link
 *   GET  /auth/magic/verify     -> consume token, create session, redirect home
 *   GET  /auth/apple/start      -> redirect to Apple (website SIWA)
 *   POST /auth/apple/callback   -> exchange code, create session, redirect home
 *   POST /auth/apple            -> { identityToken, nonce?, fullName? } : verify
 *                                   the native Sign in with Apple JWS, create session
 *
 * Sessions are opaque KV tokens (see session.ts). This router owns identity
 * only; subscription/paywall gating is layered on separately.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { isSecureRequest } from '../security/requestProtocol.ts';
import type { Env, User } from '../shared/types.ts';
import {
  getCurrentUserFromRequest,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  getSessionTokensFromRequest,
  getSafeRedirectUrl,
} from './session.ts';
import { buildGoogleAuthUrl, exchangeGoogleCode, fetchGoogleProfile } from './google.ts';
import { upsertUserFromGoogle, upsertUserByEmail, upsertUserFromApple, upsertUserFromX, linkXSubToUser } from './users.ts';
import { deleteUserAccount } from './deleteAccount.ts';
import { issueMagicToken, consumeMagicToken, magicLinkEmail } from './magic.ts';
import { sendEmail } from './email.ts';
import { constantTimeEqual, randomToken } from './tokens.ts';
import { resolveEntitlementAsync } from '../billing/entitlement.ts';
import { billingCapabilitiesAsync } from '../billing/stripe.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { isAdminSessionEmail, adminRuntimeConfig } from '../admin/identity.ts';
import { verifyAccessJwt, certsUrl } from '../admin/access.ts';
import { rateLimit, clientIp } from '../shared/rateLimit.ts';
import {
  verifyAppleIdentityToken,
  appleEmailIsVerified,
  AppleIdentityVerificationError,
} from './appleIdentity.ts';
import { loadAppleWebConfig, buildAppleAuthUrl, exchangeAppleCode } from './appleWeb.ts';
import {
  buildXAuthUrl,
  exchangeXCode,
  fetchXProfile,
  generateCodeVerifier,
  generateCodeChallenge,
} from './x.ts';

const OAUTH_STATE_COOKIE = 'ct_oauth_state';
const OAUTH_VERIFIER_COOKIE = 'ct_oauth_code_verifier';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Public-facing origin for redirects + links (APP_BASE_URL, else request origin). */
async function baseUrl(c: Context<{ Bindings: Env }>): Promise<string> {
  const host = c.req.header('X-Forwarded-Host') || c.req.header('Host') || new URL(c.req.url).host;
  const proto = c.req.header('X-Forwarded-Proto') || new URL(c.req.url).protocol.replace(':', '');
  const requestOrigin = `${proto}://${host}`;

  const cleanHost = host.split(':')[0].toLowerCase();
  if (cleanHost === 'localhost' || cleanHost === '127.0.0.1' || cleanHost.endsWith('.local')) {
    return requestOrigin;
  }

  const configured = (await resolveSecret(c.env, 'APP_BASE_URL')).value?.trim();
  if (configured) return configured.replace(/\/$/, '');
  return requestOrigin;
}

/** Trim the User down to what the browser is allowed to see. */
function publicUser(u: User): { id: string; email: string; name: string | null; picture: string | null } {
  return { id: u.id, email: u.email, name: u.name, picture: u.picture };
}

export function buildAuthRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  // --- GET /auth/me -------------------------------------------------------
  // One bootstrap call for the client: identity + derived access level.
  r.get('/me', async (c) => {
    const user = await getCurrentUserFromRequest(c);
    let adminAllowed = user ? await isAdminSessionEmail(c.env, user.email) : false;

    // Check Cloudflare Access JWT assertion if present (when requesting via admin.congress.trade)
    const accessJwt = c.req.header('Cf-Access-Jwt-Assertion');
    if (!adminAllowed && accessJwt) {
      const cfg = await adminRuntimeConfig(c.env);
      if (cfg.accessAud && cfg.accessTeamDomain && cfg.allow.size > 0) {
        const res = await verifyAccessJwt(accessJwt, {
          aud: cfg.accessAud,
          allow: cfg.allow,
          jwksUrl: certsUrl(cfg.accessTeamDomain),
        });
        if (res.ok) {
          adminAllowed = true;
        }
      }
    }

    const appleEnabled = (await resolveSecret(c.env, 'APPLE_SIGNIN_ENABLED')).value === 'true';
    const appleWeb = appleEnabled && Boolean(await loadAppleWebConfig(c.env));
    const xWeb = Boolean((await resolveSecret(c.env, 'X_OAUTH_CLIENT_ID')).value);

    return c.json({
      user: user ? publicUser(user) : null,
      entitlement: await resolveEntitlementAsync(c.env, user),
      admin: { allowed: adminAllowed },
      auth: { appleWeb, xWeb },
      billing: {
        ...(await billingCapabilitiesAsync(c.env)),
        hasCustomer: Boolean(user?.stripeCustomerId),
      },
    });
  });

  // --- GET /auth/apple/status ----------------------------------------------
  // Public, no side effects.  The login sheet uses this so a dead Apple
  // button is not shown when web SIWA is missing Services ID / key.
  r.get('/apple/status', async (c) => {
    const enabled = (await resolveSecret(c.env, 'APPLE_SIGNIN_ENABLED')).value === 'true';
    const web = enabled && Boolean(await loadAppleWebConfig(c.env));
    return c.json({ enabled, web });
  });

  // --- GET /auth/x/status --------------------------------------------------
  r.get('/x/status', async (c) => {
    const configured = Boolean((await resolveSecret(c.env, 'X_OAUTH_CLIENT_ID')).value);
    return c.json({ enabled: configured, configured });
  });

  // --- POST /auth/logout --------------------------------------------------
  r.post('/logout', async (c) => {
    await Promise.all(getSessionTokensFromRequest(c).map((token) => destroySession(c.env, token)));
    await clearSessionCookie(c);
    return c.json({ ok: true });
  });

  // --- POST /auth/account/delete ------------------------------------------
  // Guideline 5.1.1(v) / Privacy §6.  Same deletion as the delete_account
  // client command; this route also clears the request cookies.
  r.post('/account/delete', async (c) => {
    const user = await getCurrentUserFromRequest(c);
    if (!user) return c.json({ error: 'sign in required' }, 401);
    const limited = await rateLimit(c.env, 'account-delete', user.id, 5, 3600);
    if (!limited.ok) return c.json({ error: 'too many account deletion requests' }, 429);
    const result = await deleteUserAccount(c.env, user);
    await Promise.all(getSessionTokensFromRequest(c).map((token) => destroySession(c.env, token)));
    await clearSessionCookie(c);
    return c.json({ ok: true, ...result });
  });

  // --- GET /auth/google/start ---------------------------------------------
  r.get('/google/start', async (c) => {
    if (!(await resolveSecret(c.env, 'GOOGLE_OAUTH_CLIENT_ID')).value) {
      const accept = c.req.header('Accept') || '';
      if (accept.includes('text/html')) {
        return c.redirect('/?auth_error=google_not_configured');
      }
      return c.json({ error: 'google login not configured' }, 503);
    }
    const base = await baseUrl(c);
    const reqHost = c.req.header('X-Forwarded-Host') || c.req.header('Host') || new URL(c.req.url).host;
    const reqProto = c.req.header('X-Forwarded-Proto') || new URL(c.req.url).protocol.replace(':', '');
    const publicReqOrigin = `${reqProto}://${reqHost}`;
    const callbackBase = new URL(base);
    // State is host-only, so canonicalize the start request before issuing it
    // when a user arrived on a non-apex alias. This keeps the state cookie and
    // the fixed, documented Google callback host aligned.
    if (publicReqOrigin !== callbackBase.origin) {
      const redirectTarget = new URL(c.req.url);
      redirectTarget.protocol = callbackBase.protocol;
      redirectTarget.host = callbackBase.host;
      return c.redirect(redirectTarget.toString());
    }
    const state = randomToken(16);

    // Save the initiator's origin so we can redirect back to it on callback
    const clientParam = new URL(c.req.url).searchParams.get('client');
    const referer = c.req.header('Referer');
    // publicReqOrigin, not the socket URL: behind the proxy the socket origin
    // is http://congress.trade, which would round-trip the user to plaintext.
    let requestOrigin = publicReqOrigin;
    if (clientParam === 'ios') {
      requestOrigin = 'congresstrade://auth';
    } else if (referer) {
      try {
        requestOrigin = new URL(referer).origin;
      } catch {}
    }
    const isSecure = isSecureRequest(c);
    // Host-only cookies: Domain is deliberately omitted (CT-AUD-007).
    setCookie(c, 'ct_auth_origin', requestOrigin, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
      prefix: isSecure ? 'host' : undefined,
    });

    setCookie(c, OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
      prefix: isSecure ? 'host' : undefined,
    });
    const url = await buildGoogleAuthUrl(c.env, `${base}/auth/google/callback`, state);
    return c.redirect(url);
  });

  // --- GET /auth/google/callback ------------------------------------------
  r.get('/google/callback', async (c) => {
    const url = new URL(c.req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const cookieState = getCookie(c, OAUTH_STATE_COOKIE, 'host') ?? getCookie(c, OAUTH_STATE_COOKIE);
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/', prefix: 'host' });
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/' });

    const authOrigin = getCookie(c, 'ct_auth_origin', 'host') ?? getCookie(c, 'ct_auth_origin');
    deleteCookie(c, 'ct_auth_origin', { path: '/', prefix: 'host' });
    deleteCookie(c, 'ct_auth_origin', { path: '/' });

    const base = await baseUrl(c);
    const targetOrigin = getSafeRedirectUrl(authOrigin, base);

    if (!code || !state || !cookieState || !(await constantTimeEqual(state, cookieState))) {
      return c.redirect(`${targetOrigin}/?login=error`);
    }
    try {
      const redirectUri = `${base}/auth/google/callback`;
      const accessToken = await exchangeGoogleCode(c.env, code, redirectUri);
      const profile = await fetchGoogleProfile(accessToken);
      // Account-takeover guard: never match-or-create an account by an email
      // Google has not verified (upsertUserFromGoogle enforces this too).
      if (!profile.emailVerified) {
        console.warn('google callback rejected: unverified email');
        return c.redirect(`${targetOrigin}/?login=unverified`);
      }
      const user = await upsertUserFromGoogle(c.env, profile);
      const sessionToken = await createSession(c.env, user.id);
      await setSessionCookie(c, sessionToken);
      if (targetOrigin.startsWith('congresstrade://')) {
        return c.redirect(`${targetOrigin}?token=${encodeURIComponent(sessionToken)}`);
      }
      return c.redirect(`${targetOrigin}/?login=ok`);
    } catch (err) {
      console.error('google callback failed:', (err as Error).message);
      return c.redirect(`${targetOrigin}/?login=error`);
    }
  });

  // --- POST /auth/magic/request -------------------------------------------
  // Always returns ok:true (no account enumeration); `sent` flags delivery.
  r.post('/magic/request', async (c) => {
    let body: { email?: unknown };
    try {
      body = (await c.req.json()) as { email?: unknown };
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) return c.json({ error: 'valid email required' }, 400);
    // Throttle to stop magic-link email-bombing: per-IP burst cap (10/10min)
    // checked first and short-circuited so an already-throttled IP can't keep
    // spending a victim email's separate 5/hr quota while never itself getting
    // a magic link sent. Fails open if KV is unavailable.
    const ip = clientIp(c.req.raw, c.env);
    const ipRl = await rateLimit(c.env, 'magic-ip', ip, 10, 600);
    if (!ipRl.ok) {
      return c.json({ error: 'too many requests, please try again later' }, 429, {
        'Retry-After': String(ipRl.retryAfterSec),
      });
    }
    const emailRl = await rateLimit(c.env, 'magic-email', email, 5, 3600);
    if (!emailRl.ok) {
      return c.json({ error: 'too many requests, please try again later' }, 429, {
        'Retry-After': String(emailRl.retryAfterSec),
      });
    }
    try {
      const token = await issueMagicToken(c.env, email);
      const clientParam = new URL(c.req.url).searchParams.get('client');
      const referer = c.req.header('Referer');
      let requestOrigin = new URL(c.req.url).origin;
      if (clientParam === 'ios') {
        requestOrigin = 'congresstrade://auth';
      } else if (referer) {
        try {
          requestOrigin = new URL(referer).origin;
        } catch {}
      }
      const verifyUrl = `${await baseUrl(c)}/auth/magic/verify?token=${encodeURIComponent(token)}&origin=${encodeURIComponent(requestOrigin)}`;
      const mail = magicLinkEmail(verifyUrl);
      await sendEmail(c.env, { to: email, subject: mail.subject, html: mail.html, text: mail.text });
    } catch (err) {
      console.error('magic request failed:', (err as Error).message);
      return c.json({ ok: true, sent: false });
    }
    return c.json({ ok: true, sent: true });
  });

  // --- GET /auth/magic/verify ---------------------------------------------
  r.get('/magic/verify', async (c) => {
    const token = new URL(c.req.url).searchParams.get('token') ?? '';
    const originParam = new URL(c.req.url).searchParams.get('origin') ?? '';
    const email = token ? await consumeMagicToken(c.env, token) : null;

    const base = await baseUrl(c);
    const targetOrigin = getSafeRedirectUrl(originParam || undefined, base);

    if (!email) return c.redirect(`${targetOrigin}/?login=expired`);
    const user = await upsertUserByEmail(c.env, email);
    const sessionToken = await createSession(c.env, user.id);
    await setSessionCookie(c, sessionToken);
    if (targetOrigin.startsWith('congresstrade://')) {
      return c.redirect(`${targetOrigin}?token=${encodeURIComponent(sessionToken)}`);
    }
    return c.redirect(`${targetOrigin}/?login=ok`);
  });

  // --- GET /auth/apple/start ----------------------------------------------
  // Website Sign in with Apple. The login modal used to 404 here.
  r.get('/apple/start', async (c) => {
    const enabled = (await resolveSecret(c.env, 'APPLE_SIGNIN_ENABLED')).value === 'true';
    if (!enabled) {
      const accept = c.req.header('Accept') || '';
      if (accept.includes('text/html')) return c.redirect('/?auth_error=apple_not_configured');
      return c.json({ error: 'Sign in with Apple is not enabled' }, 503);
    }
    const cfg = await loadAppleWebConfig(c.env);
    if (!cfg) {
      const accept = c.req.header('Accept') || '';
      if (accept.includes('text/html')) return c.redirect('/?auth_error=apple_web_not_configured');
      return c.json({ error: 'Sign in with Apple web is not configured' }, 503);
    }

    const base = await baseUrl(c);
    const reqHost = c.req.header('X-Forwarded-Host') || c.req.header('Host') || new URL(c.req.url).host;
    const reqProto = c.req.header('X-Forwarded-Proto') || new URL(c.req.url).protocol.replace(':', '');
    const publicReqOrigin = `${reqProto}://${reqHost}`;
    const callbackBase = new URL(base);
    if (publicReqOrigin !== callbackBase.origin) {
      const redirectTarget = new URL(c.req.url);
      redirectTarget.protocol = callbackBase.protocol;
      redirectTarget.host = callbackBase.host;
      return c.redirect(redirectTarget.toString());
    }

    const state = randomToken(16);
    const referer = c.req.header('Referer');
    let requestOrigin = publicReqOrigin;
    if (referer) {
      try {
        requestOrigin = new URL(referer).origin;
      } catch {
        /* keep request origin */
      }
    }
    const isSecure = isSecureRequest(c);
    setCookie(c, 'ct_auth_origin', requestOrigin, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
      prefix: isSecure ? 'host' : undefined,
    });
    setCookie(c, OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
      prefix: isSecure ? 'host' : undefined,
    });
    return c.redirect(buildAppleAuthUrl(cfg, `${base}/auth/apple/callback`, state));
  });

  async function finishAppleWebCallback(c: Context<{ Bindings: Env }>, code: string | null, state: string | null) {
    const cookieState = getCookie(c, OAUTH_STATE_COOKIE, 'host') ?? getCookie(c, OAUTH_STATE_COOKIE);
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/', prefix: 'host' });
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/' });
    const authOrigin = getCookie(c, 'ct_auth_origin', 'host') ?? getCookie(c, 'ct_auth_origin');
    deleteCookie(c, 'ct_auth_origin', { path: '/', prefix: 'host' });
    deleteCookie(c, 'ct_auth_origin', { path: '/' });
    const base = await baseUrl(c);
    const targetOrigin = getSafeRedirectUrl(authOrigin, base);
    if (!code || !state || !cookieState || !(await constantTimeEqual(state, cookieState))) {
      return c.redirect(`${targetOrigin}/?login=error`);
    }
    const cfg = await loadAppleWebConfig(c.env);
    if (!cfg) return c.redirect(`${targetOrigin}/?auth_error=apple_web_not_configured`);
    try {
      const idToken = await exchangeAppleCode(cfg, code, `${base}/auth/apple/callback`);
      const claims = await verifyAppleIdentityToken(idToken, { bundleId: cfg.servicesId });
      const user = await upsertUserFromApple(c.env, {
        sub: claims.sub as string,
        email: claims.email ?? null,
        emailVerified: appleEmailIsVerified(claims),
        name: null,
      });
      const sessionToken = await createSession(c.env, user.id);
      await setSessionCookie(c, sessionToken);
      return c.redirect(`${targetOrigin}/?login=ok`);
    } catch (err) {
      console.error('apple web callback failed:', (err as Error).message);
      return c.redirect(`${targetOrigin}/?login=error`);
    }
  }

  r.get('/apple/callback', async (c) => {
    const url = new URL(c.req.url);
    return finishAppleWebCallback(c, url.searchParams.get('code'), url.searchParams.get('state'));
  });

  r.post('/apple/callback', async (c) => {
    const body = await c.req.parseBody();
    const code = typeof body.code === 'string' ? body.code : null;
    const state = typeof body.state === 'string' ? body.state : null;
    return finishAppleWebCallback(c, code, state);
  });

  // --- POST /auth/apple -----------------------------------------------------
  // Native "Sign in with Apple" (ASAuthorizationAppleIDProvider). The client
  // verifies nothing itself — it forwards the identityToken JWS as-is; this
  // route does the full RS256-against-Apple's-JWKS verification
  // (appleIdentity.ts) before ever trusting a claim in it.
  r.post('/apple', async (c) => {
    const enabled = (await resolveSecret(c.env, 'APPLE_SIGNIN_ENABLED')).value === 'true';
    if (!enabled) return c.json({ error: 'Sign in with Apple is not enabled' }, 503);

    const ip = clientIp(c.req.raw, c.env);
    const ipRl = await rateLimit(c.env, 'apple-signin-ip', ip, 20, 600);
    if (!ipRl.ok) {
      return c.json({ error: 'too many requests, please try again later' }, 429, {
        'Retry-After': String(ipRl.retryAfterSec),
      });
    }

    let body: { identityToken?: unknown; nonce?: unknown; fullName?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const identityToken = typeof body.identityToken === 'string' ? body.identityToken : '';
    if (!identityToken) return c.json({ error: 'identityToken required' }, 400);
    const nonce = typeof body.nonce === 'string' && body.nonce ? body.nonce : undefined;
    const fullName = typeof body.fullName === 'string' && body.fullName.trim() ? body.fullName.trim().slice(0, 200) : null;

    const bundleId = (await resolveSecret(c.env, 'APPLE_BUNDLE_ID')).value?.trim() || 'trade.congress.ios';

    let claims;
    try {
      claims = await verifyAppleIdentityToken(identityToken, { bundleId, nonce });
    } catch (err) {
      const message = err instanceof AppleIdentityVerificationError ? err.message : 'invalid Apple identity token';
      console.warn('apple sign-in rejected:', message);
      return c.json({ error: message }, 401);
    }

    const user = await upsertUserFromApple(c.env, {
      sub: claims.sub as string,
      email: claims.email ?? null,
      emailVerified: appleEmailIsVerified(claims),
      name: fullName,
    });
    const sessionToken = await createSession(c.env, user.id);
    await setSessionCookie(c, sessionToken);
    return c.json({
      ok: true,
      token: sessionToken,
      user: publicUser(user),
      entitlement: await resolveEntitlementAsync(c.env, user),
    });
  });

  // --- GET /auth/x/start --------------------------------------------------
  r.get('/x/start', async (c) => {
    if (!(await resolveSecret(c.env, 'X_OAUTH_CLIENT_ID')).value) {
      const accept = c.req.header('Accept') || '';
      if (accept.includes('text/html')) {
        return c.redirect('/?auth_error=x_not_configured');
      }
      return c.json({ error: 'x login not configured' }, 503);
    }
    const base = await baseUrl(c);
    const reqHost = c.req.header('X-Forwarded-Host') || c.req.header('Host') || new URL(c.req.url).host;
    const reqProto = c.req.header('X-Forwarded-Proto') || new URL(c.req.url).protocol.replace(':', '');
    const publicReqOrigin = `${reqProto}://${reqHost}`;
    const callbackBase = new URL(base);

    if (publicReqOrigin !== callbackBase.origin) {
      const redirectTarget = new URL(c.req.url);
      redirectTarget.protocol = callbackBase.protocol;
      redirectTarget.host = callbackBase.host;
      return c.redirect(redirectTarget.toString());
    }

    const state = randomToken(16);
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);

    const clientParam = new URL(c.req.url).searchParams.get('client');
    const referer = c.req.header('Referer');
    let requestOrigin = publicReqOrigin;
    if (clientParam === 'ios') {
      requestOrigin = 'congresstrade://auth';
    } else if (referer) {
      try {
        requestOrigin = new URL(referer).origin;
      } catch {}
    }
    const isSecure = isSecureRequest(c);

    setCookie(c, 'ct_auth_origin', requestOrigin, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
      prefix: isSecure ? 'host' : undefined,
    });

    setCookie(c, OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
      prefix: isSecure ? 'host' : undefined,
    });

    setCookie(c, OAUTH_VERIFIER_COOKIE, verifier, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
      prefix: isSecure ? 'host' : undefined,
    });

    const url = await buildXAuthUrl(c.env, `${base}/auth/x/callback`, state, challenge);
    return c.redirect(url);
  });

  // --- GET /auth/x/callback -----------------------------------------------
  r.get('/x/callback', async (c) => {
    const url = new URL(c.req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    const cookieState = getCookie(c, OAUTH_STATE_COOKIE, 'host') ?? getCookie(c, OAUTH_STATE_COOKIE);
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/', prefix: 'host' });
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/' });

    const cookieVerifier = getCookie(c, OAUTH_VERIFIER_COOKIE, 'host') ?? getCookie(c, OAUTH_VERIFIER_COOKIE);
    deleteCookie(c, OAUTH_VERIFIER_COOKIE, { path: '/', prefix: 'host' });
    deleteCookie(c, OAUTH_VERIFIER_COOKIE, { path: '/' });

    const authOrigin = getCookie(c, 'ct_auth_origin', 'host') ?? getCookie(c, 'ct_auth_origin');
    deleteCookie(c, 'ct_auth_origin', { path: '/', prefix: 'host' });
    deleteCookie(c, 'ct_auth_origin', { path: '/' });

    const base = await baseUrl(c);
    const targetOrigin = getSafeRedirectUrl(authOrigin, base);

    if (!code || !state || !cookieState || !cookieVerifier || !(await constantTimeEqual(state, cookieState))) {
      return c.redirect(`${targetOrigin}/?login=error`);
    }

    try {
      const redirectUri = `${base}/auth/x/callback`;
      const accessToken = await exchangeXCode(c.env, code, redirectUri, cookieVerifier);
      const profile = await fetchXProfile(accessToken);

      const currentUser = await getCurrentUserFromRequest(c);
      let user: User;
      if (currentUser) {
        user = await linkXSubToUser(c.env, currentUser.id, profile.sub);
      } else {
        user = await upsertUserFromX(c.env, profile);
      }

      const sessionToken = await createSession(c.env, user.id);
      await setSessionCookie(c, sessionToken);
      if (targetOrigin.startsWith('congresstrade://')) {
        return c.redirect(`${targetOrigin}?token=${encodeURIComponent(sessionToken)}`);
      }
      return c.redirect(`${targetOrigin}/?login=ok`);
    } catch (err) {
      console.error('x callback failed:', (err as Error).message);
      return c.redirect(`${targetOrigin}/?login=error`);
    }
  });

  return r;
}
