/**
 * src/ingestion/senateEdgeDeny.ts
 * OWNER: ingestion agent
 *
 * Senate eFD edge-deny classification and the polling backoff it drives
 * (CT-2442).
 *
 * efdsearch.senate.gov sits behind Akamai.  Since about 6:04 AM on
 * 2026-10-23 the edge answers the agreement POST (/search/home/) and the data
 * POST with 403 "Access Denied" (Server: AkamaiGHost) for automated clients on
 * every network, while GETs still reach the origin (Server: gunicorn).  The
 * box's own datacenter egress has been edge-denied even for GET (SERVE_403)
 * since at least 2026-10-16.  No client change restores that, and we do not
 * try to get past it.  What this module does is make the failure honest and
 * polite:
 *
 *   - SenateHttpError carries the response status and Server header, and
 *     classifies an edge deny as `edge_denied`, apart from an origin 403.
 *   - The watcher backs Senate polling off for 60 minutes after an edge deny,
 *     doubling up to 6 hours, and resets on the next success.  The state lives
 *     in CONFIG_KV beside last_poll:senate and last_attempt:senate, so a
 *     restart does not reset it.
 */

import type { Env } from '../shared/types.ts';

/** `edge_denied` is persistent (long backoff); `http` is any other answer. */
export type SenateHttpFailureClass = 'edge_denied' | 'http';

/**
 * Akamai's own deny page: an "Access Denied" title plus an
 * errors.edgesuite.net reference (entity-encoded in the live page).
 */
export function looksLikeAkamaiAccessDenied(html: string): boolean {
  return /<title>\s*Access Denied\s*<\/title>/i.test(html)
    || /errors(?:\.|&#46;)edgesuite(?:\.|&#46;)net/i.test(html);
}

/**
 * An edge deny is an HTTP 403 sent by the Akamai edge itself (Server:
 * AkamaiGHost) or carrying Akamai's "Access Denied" page.  A 403 from the
 * origin (Server: gunicorn, a CSRF or session problem) stays generic.
 */
export function classifySenateHttpFailure(
  status: number,
  server: string | null | undefined,
  body = '',
): SenateHttpFailureClass {
  if (status !== 403) return 'http';
  if (/akamaighost/i.test(server ?? '') || looksLikeAkamaiAccessDenied(body)) return 'edge_denied';
  return 'http';
}

function formatSenateHttpError(
  step: string,
  status: number,
  server: string | null,
  opts: { body?: string; detail?: string },
): string {
  const failureClass = classifySenateHttpFailure(status, server, opts.body ?? '');
  return `senate ${step} -> HTTP ${status}${opts.detail ? ` ${opts.detail}` : ''} (server=${server || 'unknown'})`
    + (failureClass === 'edge_denied' ? ' [edge_denied]' : '');
}

/**
 * A Senate eFD HTTP answer the flow could not use, with the Server header that
 * sent it, e.g. `senate POST /search/home/ -> HTTP 403 (server=AkamaiGHost)
 * [edge_denied]`.  The message keeps the `HTTP <status>` text that existing
 * classifiers (isTransientSourceError, the egress retry) key on.
 */
export class SenateHttpError extends Error {
  readonly failureClass: SenateHttpFailureClass;

  constructor(
    readonly step: string,
    readonly status: number,
    readonly server: string | null,
    opts: { body?: string; detail?: string } = {},
  ) {
    super(formatSenateHttpError(step, status, server, opts));
    this.name = 'SenateHttpError';
    this.failureClass = classifySenateHttpFailure(status, server, opts.body ?? '');
  }
}

export function isSenateEdgeDeniedError(err: unknown): err is SenateHttpError {
  return err instanceof SenateHttpError && err.failureClass === 'edge_denied';
}

/** Strip URL userinfo and configured proxy secrets before logging or persisting transport errors. */
export function sanitizeEfdTransportError(err: unknown, secrets: Array<string | undefined> = []): string {
  const raw = typeof err === 'string'
    ? err
    : err instanceof Error
      ? err.message
      : String(err ?? 'unknown');
  let out = raw.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1[redacted]@');
  for (const secret of secrets) {
    if (secret && secret.length >= 3) out = out.split(secret).join('[redacted]');
  }
  return out.slice(0, 200);
}

/** Proxy URL and credential env values to scrub from Senate eFD transport errors. */
export function senateEfdTransportScrubSecrets(proxyUrl?: string): string[] {
  const penv = typeof process !== 'undefined' ? process.env : undefined;
  const secrets: string[] = [];
  const url = proxyUrl?.trim();
  if (url && url.length >= 3) secrets.push(url);
  for (const v of [
    penv?.RESIDENTIAL_PROXY_URL,
    penv?.SENATE_PROXY_URL,
    penv?.RESIDENTIAL_PROXY_USERNAME,
    penv?.RESIDENTIAL_PROXY_PASSWORD,
  ]) {
    const t = v?.trim();
    if (t && t.length >= 3) secrets.push(t);
  }
  return secrets;
}

/**
 * The residential proxy gave no answer and the direct fallback failed too.
 * That is an egress fault to act on (the Mango peer), not an eFD edge deny,
 * even when the direct leg's own answer was Akamai's 403, so it is neither
 * backed off nor logged as transient.
 */
export class SenateProxyEgressError extends Error {
  constructor(
    proxyCause: unknown,
    directCause: unknown,
    secrets: Array<string | undefined> = [],
  ) {
    const proxy = sanitizeEfdTransportError(proxyCause, secrets);
    const direct = sanitizeEfdTransportError(directCause, secrets).replace(/ \[edge_denied\]$/, '');
    super(`senate proxy egress unreachable (${proxy}); direct fallback failed: ${direct}`);
    this.name = 'SenateProxyEgressError';
  }
}

// ---------------------------------------------------------------------------
// Polling backoff after an edge deny.
// ---------------------------------------------------------------------------

/** CONFIG_KV key for the backoff, next to the watcher's last_poll / last_attempt keys. */
export const SENATE_EDGE_BACKOFF_KV_KEY = 'senate_edge_deny:backoff';
/** First window after an edge deny. */
export const SENATE_EDGE_BACKOFF_INITIAL_MS = 60 * 60_000;
/** Longest window; each further deny doubles the previous one up to this. */
export const SENATE_EDGE_BACKOFF_MAX_MS = 6 * 60 * 60_000;
/**
 * Slack past `until` during which a missing senate attempt is still explained
 * by the backoff.  The watcher ticks every minute, so the first attempt after
 * the window lands within a minute or two; past this, silence is real again.
 */
export const SENATE_EDGE_BACKOFF_GRACE_MS = 30 * 60_000;
/** Outlives the longest window many times over; refreshed on every deny. */
const SENATE_EDGE_BACKOFF_TTL_SECONDS = 2 * 86_400;

export interface SenateEdgeBackoffState {
  /** Edge denies in a row since the last successful senate poll. */
  consecutive: number;
  firstDeniedAt: string;
  lastDeniedAt: string;
  /** Length of the current window. */
  windowMs: number;
  /** No senate poll attempt before this instant. */
  until: string;
  /** The deny, as written to source_attempts. */
  reason: string;
}

/** Pure: the backoff after one more edge deny at `now`. */
export function nextSenateEdgeBackoff(
  prev: SenateEdgeBackoffState | null,
  now: Date,
  reason: string,
): SenateEdgeBackoffState {
  const prior = prev && Number.isFinite(prev.consecutive) && prev.consecutive > 0
    ? Math.floor(prev.consecutive)
    : 0;
  const consecutive = prior + 1;
  const windowMs = Math.min(
    SENATE_EDGE_BACKOFF_MAX_MS,
    SENATE_EDGE_BACKOFF_INITIAL_MS * 2 ** Math.min(consecutive - 1, 16),
  );
  const nowIso = now.toISOString();
  return {
    consecutive,
    firstDeniedAt: prior > 0 && prev?.firstDeniedAt ? prev.firstDeniedAt : nowIso,
    lastDeniedAt: nowIso,
    windowMs,
    until: new Date(now.getTime() + windowMs).toISOString(),
    reason: reason.slice(0, 300),
  };
}

/** True while `now` is inside the window (plus `graceMs`). */
export function isSenateEdgeBackoffActive(
  state: SenateEdgeBackoffState,
  now: Date,
  graceMs = 0,
): boolean {
  const untilMs = Date.parse(state.until);
  return Number.isFinite(untilMs) && now.getTime() < untilMs + graceMs;
}

/** Fail-soft read: a missing, malformed or unreadable key is no backoff. */
export async function readSenateEdgeBackoff(env: Env): Promise<SenateEdgeBackoffState | null> {
  if (!env.CONFIG_KV) return null;
  try {
    const raw: unknown = await env.CONFIG_KV.get(SENATE_EDGE_BACKOFF_KV_KEY);
    if (!raw) return null;
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return null;
    const s = parsed as Partial<SenateEdgeBackoffState>;
    if (typeof s.until !== 'string' || !Number.isFinite(Date.parse(s.until))) return null;
    if (typeof s.consecutive !== 'number' || typeof s.windowMs !== 'number') return null;
    const lastDeniedAt = typeof s.lastDeniedAt === 'string' ? s.lastDeniedAt : s.until;
    return {
      consecutive: s.consecutive,
      firstDeniedAt: typeof s.firstDeniedAt === 'string' ? s.firstDeniedAt : lastDeniedAt,
      lastDeniedAt,
      windowMs: s.windowMs,
      until: s.until,
      reason: typeof s.reason === 'string' ? s.reason : 'edge denied',
    };
  } catch {
    return null;
  }
}

/** Persist the backoff.  Returns false (and warns) when it could not be saved. */
export async function writeSenateEdgeBackoff(env: Env, state: SenateEdgeBackoffState): Promise<boolean> {
  if (!env.CONFIG_KV) return false;
  try {
    await env.CONFIG_KV.put(SENATE_EDGE_BACKOFF_KV_KEY, JSON.stringify(state), {
      expirationTtl: SENATE_EDGE_BACKOFF_TTL_SECONDS,
    });
    return true;
  } catch (err) {
    console.warn('watcher: failed to save the senate edge-deny backoff:', (err as Error).message);
    return false;
  }
}

/**
 * Reset after a successful poll.  Best-effort: a key left behind is already
 * past its window, so it blocks nothing; it only makes a later episode start
 * from a longer window.
 */
export async function clearSenateEdgeBackoff(env: Env): Promise<void> {
  if (!env.CONFIG_KV) return;
  try {
    await env.CONFIG_KV.delete(SENATE_EDGE_BACKOFF_KV_KEY);
  } catch (err) {
    console.warn('watcher: failed to clear the senate edge-deny backoff:', (err as Error).message);
  }
}
