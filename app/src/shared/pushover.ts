/**
 * src/shared/pushover.ts
 *
 * Minimal Pushover delivery for operational notifications (daily summaries,
 * alerts that should reach the owner's phone without email latency).
 * https://pushover.net/api
 *
 * Config (Infisical-backed, env fallback):
 *   PUSHOVER_APP_TOKEN  application API token
 *   PUSHOVER_USER_KEY   recipient user/group key
 *
 * Mirrors alerts/notify.ts semantics: missing config or any transport error is
 * a logged/returned no-op, never a throw — callers in cron lanes don't care.
 */

import type { Env } from './types.ts';
import { resolveSecrets } from '../secrets/infisical.ts';

const PUSHOVER_API = 'https://api.pushover.net/1/messages.json';

export interface PushoverResult {
  sent: boolean;
  /** Why it didn't send (unset config, HTTP error, API error). */
  reason?: string;
}

export interface PushoverMessage {
  title: string;
  message: string;
  /** -2..2; default 0. Use 1 for over-threshold warnings. */
  priority?: number;
  url?: string;
  urlTitle?: string;
}

/**
 * Send one Pushover message. `creds` may be supplied by a caller that already
 * resolved secrets (avoids a second resolveSecrets round trip); otherwise they
 * are resolved here from Infisical/env.
 */
/**
 * Hard ceiling on how long a Pushover delivery may hold up its caller.
 *
 * This helper is awaited from money paths - the Stripe webhook handler and the
 * Apple redeem command - where the notification is explicitly fail-soft. Without
 * a bound, a Pushover connection that STALLS rather than fails never settles, so
 * catching rejections does not help: the webhook response and the client command
 * are delayed indefinitely by a notification nobody is waiting on. Stripe retries
 * a webhook it considers timed out, which turns a notification hiccup into
 * duplicate event processing.
 */
export const PUSHOVER_TIMEOUT_MS = 5_000;

export async function sendPushover(
  env: Env,
  msg: PushoverMessage,
  creds?: { appToken?: string; userKey?: string },
  fetchFn: typeof fetch = fetch,
): Promise<PushoverResult> {
  let appToken = creds?.appToken;
  let userKey = creds?.userKey;
  if (!appToken?.trim() || !userKey?.trim()) {
    try {
      const secrets = await resolveSecrets(env, [
        'PUSHOVER_CT_API_TOKEN',
        'PUSHOVER_APP_TOKEN',
        'PUSHOVER_USER_KEY',
      ]);
      appToken = appToken?.trim()
        ? appToken
        : secrets.PUSHOVER_CT_API_TOKEN?.trim() || secrets.PUSHOVER_APP_TOKEN;
      userKey = userKey?.trim() ? userKey : secrets.PUSHOVER_USER_KEY;
    } catch {
      /* resolution failure is indistinguishable from unconfigured — no-op */
    }
  }
  if (!appToken?.trim() || !userKey?.trim()) {
    return { sent: false, reason: 'PUSHOVER_CT_API_TOKEN / PUSHOVER_APP_TOKEN / PUSHOVER_USER_KEY not configured' };
  }

  const form = new URLSearchParams({
    token: appToken.trim(),
    user: userKey.trim(),
    title: msg.title,
    message: msg.message,
  });
  if (msg.priority != null) form.set('priority', String(msg.priority));
  if (msg.url) form.set('url', msg.url);
  if (msg.urlTitle) form.set('url_title', msg.urlTitle);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSHOVER_TIMEOUT_MS);
  try {
    const res = await fetchFn(PUSHOVER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: controller.signal,
    });
    if (!res.ok) return { sent: false, reason: `pushover HTTP ${res.status}` };
    const body = (await res.json().catch(() => null)) as { status?: number; errors?: string[] } | null;
    if (body && body.status !== 1) {
      return { sent: false, reason: `pushover API: ${(body.errors ?? ['unknown']).join(', ')}` };
    }
    return { sent: true };
  } catch (err) {
    if (controller.signal.aborted) {
      return { sent: false, reason: `pushover timed out after ${PUSHOVER_TIMEOUT_MS}ms` };
    }
    return { sent: false, reason: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
