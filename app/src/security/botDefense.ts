/**
 * src/security/botDefense.ts
 * OWNER: security
 *
 * In-Worker anti-scraping guard for the PUBLIC data surface (/api/*). The site
 * itself stays fully public for humans; this module makes bulk automated
 * extraction expensive without gating any page or endpoint behind sign-in.
 *
 * Layers (all governed by the SCRAPE_GUARD_ENABLED switch, Infisical-tunable
 * so it can be killed live without a redeploy):
 *   1. User-agent blocklist — scraping libraries, headless browsers, and the
 *      AI/LLM crawlers already disallowed by robots.txt get 403 on data APIs.
 *      Empty/missing user agents are refused too: every legitimate consumer
 *      (browsers, EventSource, iOS URLSession/CFNetwork) sends one.
 *   2. Per-IP request budget across all public data endpoints — generous for
 *      humans driving the dashboard, throttling for scripted walkers.
 *   3. Per-IP daily ROW budget on the corpus pagers (/api/transactions and
 *      /api/client/v1/feed) — the actual asset is rows, so the budget counts
 *      rows served, not requests. Incremental dashboard polls return few or
 *      zero new rows and cost almost nothing; an offset/cursor walk of the
 *      whole corpus at 500 rows/page exhausts the budget quickly.
 *
 * Deliberately NOT gated: token-gated surfaces that fail closed on their own
 * (/api/admin, /api/ingest, /api/export), health checks, the SSE stream (has
 * its own per-subscription + per-IP limits), and ticker logo images.
 *
 * Like shared/rateLimit.ts, every check fails OPEN on KV errors — a KV blip
 * must never take down the public site. This blunts casual and mid-effort
 * scraping; a determined adversary with rotating IPs is a Cloudflare WAF/Bot
 * Management problem, not something Worker code can solve.
 */

import type { MiddlewareHandler } from 'hono';
import type { Env } from '../shared/types.ts';
import { rateLimit, clientIp } from '../shared/rateLimit.ts';
import { resolveSecret } from '../secrets/infisical.ts';

/** Requests per IP per window across all guarded public data endpoints. */
export const PUBLIC_API_LIMIT = 300;
export const PUBLIC_API_WINDOW_SEC = 300;

/** Feed rows a single IP may pull per UTC day across the corpus pagers. */
export const DAILY_ROW_BUDGET = 3_000;
const ROW_BUDGET_WINDOW_SEC = 86_400;
const ROW_BUDGET_BUCKET = 'tx-rows';

/**
 * Deepest offset the public transactions pager serves. The dashboard pager
 * mirrors this exact value (see MAX_PUBLIC_FEED_OFFSET in src/ui/dashboardHtml.ts,
 * interpolated from this constant). Full-history access is the free CSV export
 * or the token-gated bulk snapshot.
 */
export const MAX_PUBLIC_TX_OFFSET = 2_000;

/**
 * Path prefixes exempt from the guard. Admin/ingest/export enforce their own
 * bearer tokens and legitimately receive non-browser user agents (the
 * residential scout, sibling-app integrations, ops scripts). Health stays open
 * for uptime monitors; logos are cheap cache-friendly images; the SSE stream
 * carries its own per-subscription and per-IP limits in delivery/sse.ts.
 * Webhooks are Apple/Stripe-style server-to-server callbacks: they carry no
 * browser-shaped user agent and are authenticated by signature verification
 * (JWS chain / HMAC), not by looking human.
 */
const EXEMPT_PREFIXES = ['/api/admin', '/api/ingest', '/api/export', '/api/health', '/api/stream', '/api/logos', '/api/photos', '/api/webhooks'];

/**
 * Paths under an EXEMPT_PREFIXES prefix that are NOT token-gated and must
 * stay inside the guard. /api/export/transactions.csv is Premium-gated and
 * returns the full matching set per call, so exempting it hands a
 * scraper the whole corpus in one unauthenticated GET — around the UA
 * blocklist AND both budgets.
 */
const EXEMPT_OVERRIDES = ['/api/export/transactions.csv'];

/**
 * Automation fingerprints refused on public data endpoints. Two families:
 * HTTP/scraping tooling (curl, wget, python-*, Scrapy, Go, Java HTTP stacks,
 * node-fetch/axios, headless browsers) and the AI/LLM crawlers robots.txt
 * already disallows — this enforces that policy instead of trusting it.
 * Kept deliberately narrow: real browsers, EventSource, and mobile app
 * networking stacks (CFNetwork/URLSession, future clients) never match.
 */
const BLOCKED_UA_PATTERNS: Array<[RegExp, string]> = [
  [/curl\//i, 'curl'],
  [/\bwget\b/i, 'wget'],
  [/python-requests|python-urllib|python-httpx|\baiohttp\b|\bhttpx\b|python\/\d/i, 'python-http'],
  [/\bscrapy\b/i, 'scrapy'],
  [/go-http-client/i, 'go-http'],
  [/node-fetch|\bundici\b|axios\//i, 'node-http'],
  [/apache-httpclient|\blibwww\b|winhttp|lwp::|\bcurb\b|rest-client/i, 'http-library'],
  [/headlesschrome|phantomjs|slimerjs|electron\/|puppeteer|playwright|selenium/i, 'headless-browser'],
  [/gptbot|chatgpt-user|oai-searchbot|claudebot|anthropic-ai|claude-web|ccbot|google-extended|applebot-extended|perplexitybot|perplexity-user|bytespider|amazonbot|meta-externalagent|facebookbot|diffbot|imagesiftbot|omgili|youbot|cohere-ai|cohere-training|timpibot|velenpublicwebcrawler/i, 'ai-crawler'],
];

/** Returns a short block label when the UA is automation, else null. */
export function blockedUserAgent(userAgent: string | null): string | null {
  const ua = (userAgent ?? '').trim();
  if (!ua) return 'missing-user-agent';
  for (const [pattern, label] of BLOCKED_UA_PATTERNS) {
    if (pattern.test(ua)) return label;
  }
  return null;
}

function truthy(v: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((v ?? '').trim());
}

/**
 * Live on/off switch. Reads SCRAPE_GUARD_ENABLED through the secret resolver
 * (in-memory cached; Infisical can flip it without a redeploy) with the
 * wrangler.toml var as fallback. Unset => guard off, so tests and local dev
 * are unaffected unless they opt in — mirroring DISCLOSURE_LATENCY_WATCH_ENABLED.
 */
// CT-2459: 60s isolate cache for the guard flag. It was resolved up to 3x
// per public request (middleware + checkRowBudget + spendRowBudget), each
// resolution potentially a KV read + AES-GCM decrypt on the single
// connection. The upstream secret cache already allows 600s staleness, so
// 60s here changes no operator-visible flip latency in practice.
const SCRAPE_GUARD_CACHE_MS = 60_000;
// Keyed by the CONFIG_KV/DB binding identity (per-process singletons in
// prod; per-test fakes in suites) so one env's flag never leaks into
// another's. The no-binding fallback slot also pins the env fallback
// string it was resolved under.
const scrapeGuardCaches = new WeakMap<object, { value: boolean; atMs: number }>();
let scrapeGuardFallback: { value: boolean; atMs: number; envFallback: string | undefined } | null = null;

export async function scrapeGuardEnabled(env: Env): Promise<boolean> {
  const nowMs = Date.now();
  const binding = ((env as KvEnv).CONFIG_KV ?? (env as { DB?: unknown }).DB) as object | undefined;
  if (binding && (typeof binding === 'object' || typeof binding === 'function')) {
    const hit = scrapeGuardCaches.get(binding);
    if (hit && nowMs - hit.atMs < SCRAPE_GUARD_CACHE_MS) return hit.value;
  } else if (
    scrapeGuardFallback &&
    scrapeGuardFallback.envFallback === env.SCRAPE_GUARD_ENABLED &&
    nowMs - scrapeGuardFallback.atMs < SCRAPE_GUARD_CACHE_MS
  ) {
    return scrapeGuardFallback.value;
  }
  let value: boolean;
  try {
    const live = (await resolveSecret(env, 'SCRAPE_GUARD_ENABLED')).value ?? env.SCRAPE_GUARD_ENABLED;
    value = truthy(live);
  } catch {
    value = truthy(env.SCRAPE_GUARD_ENABLED);
  }
  if (binding && (typeof binding === 'object' || typeof binding === 'function')) {
    scrapeGuardCaches.set(binding, { value, atMs: nowMs });
  } else {
    scrapeGuardFallback = { value, atMs: nowMs, envFallback: env.SCRAPE_GUARD_ENABLED };
  }
  return value;
}

/** Test hook: drop the cached guard flag + identifier hashes. */
export function resetBotDefenseCachesForTests(): void {
  scrapeGuardFallback = null;
  identifierHashes.clear();
}

type KvEnv = Env & { CONFIG_KV?: KVNamespace };

// CT-2459: checkRowBudget + spendRowBudget each hashed the same IP per
// request; memoize per isolate (bounded).
const identifierHashes = new Map<string, string>();
async function hashIdentifier(identifier: string): Promise<string> {
  const hit = identifierHashes.get(identifier);
  if (hit) return hit;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identifier));
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
  if (identifierHashes.size >= 1_000) identifierHashes.clear();
  identifierHashes.set(identifier, hash);
  return hash;
}

function rowBudgetWindow(nowSec: number): { windowStart: number; retryAfterSec: number } {
  const windowStart = nowSec - (nowSec % ROW_BUDGET_WINDOW_SEC);
  return { windowStart, retryAfterSec: windowStart + ROW_BUDGET_WINDOW_SEC - nowSec };
}

export interface RowBudgetResult {
  ok: boolean;
  retryAfterSec: number;
}

/**
 * True while `ip` still has daily row budget. Read-only (the spend happens
 * after the handler knows how many rows it served). Fails open on KV errors.
 */
export async function checkRowBudget(env: Env, ip: string): Promise<RowBudgetResult> {
  const kv = (env as KvEnv).CONFIG_KV;
  if (!kv || !(await scrapeGuardEnabled(env))) return { ok: true, retryAfterSec: 0 };
  const { windowStart, retryAfterSec } = rowBudgetWindow(Math.floor(Date.now() / 1000));
  try {
    const key = `rl:${ROW_BUDGET_BUCKET}:${await hashIdentifier(ip)}:${windowStart}`;
    const spent = parseInt((await kv.get(key)) ?? '0', 10) || 0;
    return spent >= DAILY_ROW_BUDGET ? { ok: false, retryAfterSec } : { ok: true, retryAfterSec: 0 };
  } catch {
    return { ok: true, retryAfterSec: 0 };
  }
}

/**
 * Record `rows` served to `ip` against today's budget. Zero-row responses
 * (the common incremental-poll case) skip the KV write entirely.
 */
export async function spendRowBudget(env: Env, ip: string, rows: number): Promise<void> {
  const kv = (env as KvEnv).CONFIG_KV;
  if (!kv || rows <= 0 || !(await scrapeGuardEnabled(env))) return;
  const { windowStart } = rowBudgetWindow(Math.floor(Date.now() / 1000));
  try {
    const key = `rl:${ROW_BUDGET_BUCKET}:${await hashIdentifier(ip)}:${windowStart}`;
    const spent = parseInt((await kv.get(key)) ?? '0', 10) || 0;
    await kv.put(key, String(spent + rows), { expirationTtl: ROW_BUDGET_WINDOW_SEC + 60 });
  } catch {
    /* best-effort accounting; fail open */
  }
}

/**
 * Guard middleware for the public data API. Mount on `/api/*` BEFORE the
 * feature routers. Always stamps `X-Robots-Tag: noindex` on API responses
 * (JSON is never a search result) regardless of the enable switch; the
 * blocking layers run only when SCRAPE_GUARD_ENABLED is truthy.
 */
export const publicApiGuard: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const exempt = !EXEMPT_OVERRIDES.includes(path) && EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

  if (!exempt && (await scrapeGuardEnabled(c.env))) {
    const blocked = blockedUserAgent(c.req.header('user-agent') ?? null);
    if (blocked) {
      return c.json(
        {
          error: 'automated access is not available on this endpoint',
          reason: blocked,
          hint: 'Programmatic delivery is available to Premium accounts via signed webhooks and SSE; bulk data via the export API.',
        },
        403,
        { 'X-Robots-Tag': 'noindex' },
      );
    }
    const rl = await rateLimit(c.env, 'pub-api', clientIp(c.req.raw, c.env), PUBLIC_API_LIMIT, PUBLIC_API_WINDOW_SEC);
    if (!rl.ok) {
      return c.json({ error: 'too many requests' }, 429, {
        'Retry-After': String(rl.retryAfterSec),
        'X-Robots-Tag': 'noindex',
      });
    }
  }

  await next();
  c.header('X-Robots-Tag', 'noindex');
};
