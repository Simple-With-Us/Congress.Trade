/**
 * src/delivery/rest.ts
 * OWNER: delivery agent
 *
 * Read-only REST API over transactions + subscription CRUD. Exposes a Hono
 * router mounted under /api by index.ts. Supports cursor pagination via
 * ?since=<cursor_seq>, a rolling trade-date window via ?from=/?to=
 * (YYYY-MM-DD), and filtering by ticker / member / chamber / type.
 *
 * Routes (all relative to /api):
 *   GET   /health/senate-relay  live probe of the named Senate tunnel origin (#1604)
 *   GET   /transactions      cursor-paged transaction feed (reconciliation backstop)
 *   GET   /feed.xml          RSS 2.0 feed of recent trades (same filters as /transactions)
 *   GET   /stream            SSE live stream (?since= or Last-Event-ID resume)
 *   GET   /filings/:docId    single filing (+ its transactions) for the dashboard
 *   GET   /members           distinct filers seen in transactions
 *   GET   /assets            distinct tickers seen in transactions (Assets directory)
 *   POST  /subscriptions     create a subscription; returns its secret once
 *   GET   /subscriptions     disabled publicly; use /api/admin/subscriptions
 *   GET   /subscriptions/:id fetch one subscription with its secret
 *   PATCH /subscriptions/:id update a subscription with its secret
 */

import { Hono, type Context } from 'hono';
import { MAX_REFS_BATCH } from '@jaywedgeworth22/congress-trading-shared';
import type { Chamber, Env, Owner, Subscription, TxType } from '../shared/types.ts';
import { all, first, get } from '../shared/db.ts';
import { asStockActStatus } from '../shared/stockAct.ts';
import { cached } from '../shared/kvCache.ts';
import { readBuildInfo } from '../shared/buildInfo.ts';
import { datadogPublicStatus } from '../shared/datadogRuntime.ts';
import { getDatadogInitInput } from '../shared/datadog.ts';
import { checkPipelineHealth, type PipelineHealth } from '../shared/pipelineHealth.ts';
import { probeSenateRelay } from '../ingestion/senateRelayHealth.ts';
import { providerHealthDiagnostics } from '../extraction/providerHealth.ts';
import { enhanceSenateHtmlDocument } from '../extraction/senatePaperMedia.ts';
import { inspectLlmSpend } from '../shared/llmSpend.ts';
import {
  asAssetCategories,
  asTxSource,
  buildTransactionsQuery,
  buildTransactionsCountQuery,
  buildTransactionsTodayFilingsQuery,
  buildTransactionsExportQuery,
  mapFiling,
  mapTransaction,
  mapFeedTransaction,
  readCursorHighWater,
  resolveMemberFilerId,
  toPublicFiling,
  type FilingRow,
  type TransactionRow,
  type FeedTransactionRow,
  type TxQueryParams,
} from './rows.ts';
import { getCurrentUserFromRequest } from '../auth/session.ts';
import { isPremiumUserAsync } from '../billing/entitlement.ts';
import { getUserById } from '../auth/users.ts';
import { getAppleSubscription, appleStatusGrantsAccess } from '../billing/appleSubscriptions.ts';
import { verifyDeviceEntitlementToken } from '../billing/deviceEntitlement.ts';
import { cleanFilerName } from '../extraction/nameNormalizer.ts';
import { currentPriceStalenessFields } from '../prices/staleness.ts';

/**
 * `__member_name` is a raw join alias (COALESCE(display_name, full_name) at
 * the SQL level, see buildTransactionsQuery) that never passes through
 * cleanFilerName — unlike `mapFeedTransaction`'s `fullName`, which does. Only
 * reach for this as a fallback when `tx.fullName` is missing (e.g. filer join
 * gap); never prefer the raw value over the cleaned one.
 */
function cleanMemberNameFallback(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return cleanFilerName(raw) || raw;
}
import { formatPartyLabel } from '../shared/partyLabel.ts';
import { executiveTitleFor } from '../shared/executiveTitles.ts';
import {
  createSubscription,
  getSubscription,
  updateSubscription,
  validateAndResolveSubscriptionFilters,
  assertSubscriptionQuota,
  SubscriptionQuotaError,
  subscriptionSecretError,
  webhookTargetLengthError,
} from './subscriptions.ts';
import { openSseStream } from './sse.ts';
import { handleTickerLogoRequest } from '../ui/tickerLogos.ts';
import { readLogoPolicyOverlay } from '../ui/tickerLogoPolicy.ts';
import { handleMemberPhotoRequest } from '../enrichment/memberPhotoPack.ts';
import { getSecretResolverStatus, resolveSecret } from '../secrets/infisical.ts';
import { constantTimeEqual } from '../auth/tokens.ts';
import { localWebhookTargetsAllowed, validatePublicWebhookTarget } from './webhookTarget.ts';
import { rateLimit, clientIp } from '../shared/rateLimit.ts';
import { checkRowBudget, spendRowBudget, MAX_PUBLIC_TX_OFFSET } from '../security/botDefense.ts';
import { checkReadiness, type ReadinessResult } from '../shared/readiness.ts';
import { costProfilePublicSummary, resolveDenoCostProfile } from '../deno/costProfile.ts';
import { readLocalLitestreamAge } from '../shared/litestreamAge.ts';
import { readR2WeeklyArchiveStatus } from '../shared/r2WeeklyArchive.ts';

function parseIntOrUndef(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolve the SSE resume cursor. An explicit `?since=` wins (manual override for
 * tooling/curl); otherwise we honor the standard EventSource `Last-Event-ID`
 * header, which clients resend automatically on reconnect. Each `trade.new`
 * event is emitted with `id: <cursorSeq>`, so the header value is the last
 * cursor the client saw — replaying cursor_seq > that value resumes gap-free.
 * Returns undefined when neither is a finite number (openSseStream starts at
 * the durable high-water mark for a live tail with no history replay).
 */
export function resolveResumeCursor(
  sinceParam: string | undefined,
  lastEventId: string | undefined,
): number | undefined {
  return parseIntOrUndef(sinceParam) ?? parseIntOrUndef(lastEventId);
}

type RestContext = Context<{ Bindings: Env }>;

/**
 * In-isolate readiness cache for GET /health. The readiness probe runs ~50
 * schema-introspection queries (shared/readiness.ts REQUIRED_PROBES); paying
 * that per uptime-monitor hit is pure waste when the schema changes at most
 * once per deploy. 60 s is fresh enough for a deploy gate and a stale-ok
 * verdict still self-corrects on the next expiry. A static /health (no DB)
 * exists in index.ts for monitors that only need liveness.
 */
const READINESS_CACHE_TTL_MS = 60_000;
let readinessCache: { at: number; result: ReadinessResult } | null = null;
let pipelineCache: { at: number; result: PipelineHealth } | null = null;

/**
 * Edge-cache policies for public, read-only GETs. These endpoints carry no
 * Cache-Control today, so CDNs/browser shared caches cannot help even where
 * the payload is already KV-cached server-side (e.g. /members). s-maxage
 * targets shared caches only; stale-while-revalidate lets an edge serve the
 * stale copy while revalidating instead of stampeding the origin.
 * PUBLIC_FEED_CACHE is short because the live feed shifts with each ingest;
 * PUBLIC_STABLE_CACHE suits daily-grain data (members roster, market EOD,
 * filing detail).
 */
const PUBLIC_FEED_CACHE = 'public, s-maxage=15, stale-while-revalidate=45';
const PUBLIC_STABLE_CACHE = 'public, s-maxage=300, stale-while-revalidate=600';

/**
 * Explicit CORS policy: only these public, read-only GET paths are cross-origin
 * readable. Auth'd surfaces (subscriptions, SSE stream), mutations, and admin
 * routes must never carry Access-Control-Allow-Origin. (Paths here are relative
 * to the router mount point, /api.)
 */
function isPublicReadPath(path: string): boolean {
  return path === '/transactions'
    || path === '/members'
    || path === '/health'
    || path === '/feed.xml'
    || path === '/export/transactions.csv'
    || path === '/logos/ticker'
    || path.startsWith('/market/')
    || path.startsWith('/filings/')
    || path.startsWith('/documents/');
}

interface PublicSubscription extends Omit<Subscription, 'secret'> {
  hasSecret: boolean;
  /** Returned only once, on creation or explicit secret rotation. */
  secret?: string;
  /** Browser EventSource helper for SSE subscriptions. Contains the one-time
   *  secret in the query string — clients that can set headers should discard
   *  it and open /api/stream with `Authorization: Bearer <secret>` instead
   *  (the token-in-URL form leaks into browser history and proxy logs). */
  streamUrl?: string;
}

/** 400 body for a rejected filter set; lists unresolved member names so clients can highlight them. */
export function subscriptionFilterErrorBody(result: { error?: string; unresolvedMembers?: string[] }): {
  error: string;
  unresolvedMembers?: string[];
} {
  return {
    error: result.error ?? 'invalid filters',
    ...(result.unresolvedMembers?.length ? { unresolvedMembers: result.unresolvedMembers } : {}),
  };
}

function toPublicSubscription(
  sub: Subscription,
  opts: { includeSecret?: boolean; basePath?: string } = {},
): PublicSubscription {
  const { secret, ...rest } = sub;
  const out: PublicSubscription = {
    ...rest,
    hasSecret: Boolean(secret),
  };
  if (opts.includeSecret && secret) {
    out.secret = secret;
    if (sub.delivery === 'sse') {
      const path = opts.basePath ?? '/api/stream';
      out.streamUrl = `${path}?subscription=${encodeURIComponent(sub.id)}&token=${encodeURIComponent(secret)}`;
    }
  }
  return out;
}

interface MembersRosterRow {
  filer_id: string;
  full_name: string | null;
  chamber: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
  tx_count: number;
  photo_url: string | null;
}

/**
 * GET /members' query. Deliberately the SAME shape as the original (join
 * `filers` onto `transactions`, then GROUP BY filer_id) — an aggregate-first
 * subquery rewrite was tried and measured ~2x SLOWER locally (SQLite
 * materializes the derived table via a co-routine + its own temp b-tree
 * instead of using idx_tx_filer's natural group order). What actually
 * mattered for issue #1454 was excluding deprecated_at rows for correctness
 * (every other live read already does — buildTxFilters) without regressing
 * the query the planner already had a good, index-covering plan for.
 *
 * Naively adding `AND deprecated_at IS NULL` to the old WHERE clause gives
 * the planner a second candidate index (idx_tx_deprecated_at, migration
 * 0013) that a stats-less planner prefers over the covering idx_tx_filer —
 * and that choice needs a per-row table fetch for every live (~95%) row,
 * measured ~5x SLOWER than the pre-fix baseline. idx_tx_filer_live
 * (migration 0079) is a partial covering index built for exactly this
 * filter; INDEXED BY forces the planner onto it instead of guessing.
 *
 * INDEXED BY hard-fails if the index doesn't exist, which is possible for a
 * narrow window on this app's own deploy path — scripts/ship.sh confirms the
 * new Worker code is live BEFORE calling POST /api/admin/migrate, so a
 * request could land after the code deploys but before the migration runs.
 * Fall back to the un-hinted query (still correct, just possibly using
 * whatever plan the stats-less planner picks) rather than 500ing the People
 * tab for that window.
 */
import { memberNameMatchKey } from '../shared/filerIdentityMatch.ts';

/**
 * GET /members' query — returns distinct filers with transaction counts.
 * Uses COALESCE(f.merged_into, f.bioguide_id, t.filer_id) to map tombstoned
 * aliases to their canonical filer, and folds duplicate name keys so the
 * directory never shows two rows for the same politician.
 */
async function queryMembersRoster(db: D1Database): Promise<{ members: unknown[]; count: number }> {
  const baseSql = `SELECT COALESCE(f.merged_into, t.filer_id) AS filer_id,
                COALESCE(cf.display_name, cf.full_name, f.display_name, f.full_name) AS full_name,
                COALESCE(cf.chamber, f.chamber)   AS chamber,
                COALESCE(cf.party, f.party)     AS party,
                COALESCE(cf.state, f.state)     AS state,
                COALESCE(cf.district, f.district) AS district,
                COALESCE(cf.photo_url, f.photo_url) AS photo_url,
                COUNT(*)    AS tx_count
           FROM transactions t %INDEX_HINT%
           LEFT JOIN filers f ON f.bioguide_id = t.filer_id
           LEFT JOIN filers cf ON cf.bioguide_id = f.merged_into
          WHERE t.filer_id IS NOT NULL AND t.deprecated_at IS NULL
          GROUP BY COALESCE(f.merged_into, t.filer_id)
          ORDER BY tx_count DESC`;
  let rows: MembersRosterRow[];
  try {
    rows = await all<MembersRosterRow>(db, baseSql.replace('%INDEX_HINT%', 'INDEXED BY idx_tx_filer_live'));
  } catch {
    rows = await all<MembersRosterRow>(db, baseSql.replace('%INDEX_HINT%', ''));
  }
  const members = rows.map((row) => ({
    filerId: row.filer_id,
    fullName: row.full_name ? (cleanFilerName(row.full_name) || row.full_name) : null,
    chamber: row.chamber,
    party: formatPartyLabel(row.party) ?? row.party,
    state: row.state,
    district: row.district,
    txCount: row.tx_count,
    photoUrl: row.photo_url ?? null,
    title: executiveTitleFor(row.filer_id, row.chamber),
  }));
  return { members, count: members.length };
}

interface AssetsRosterRow {
  ticker: string;
  company_name: string | null;
  asset_class: string | null;
  tx_count: number;
  member_count: number;
}

/**
 * GET /assets' query — the ticker-side analogue of {@link queryMembersRoster}
 * above: every ticker that actually appears in the transaction feed, LEFT
 * JOINed to `securities_ref` (the enrichment reference table populated
 * out-of-band — see admin/migrations.ts INTERMEDIATE_SCHEMA_STATEMENTS and
 * analytics/sql.ts ANALYTICS_FROM_JOINS_REF for the same join elsewhere) for
 * a company name and asset class where enrichment has run for that ticker.
 * LEFT, not INNER, so un-enriched tickers still appear in the directory
 * (name/assetClass simply come back null) rather than vanishing.
 */
async function queryAssetsRoster(db: D1Database): Promise<{ assets: unknown[]; count: number }> {
  const rows = await all<AssetsRosterRow>(
    db,
    `SELECT t.ticker AS ticker,
            sr.company_name AS company_name,
            sr.asset_class  AS asset_class,
            COUNT(*) AS tx_count,
            COUNT(DISTINCT t.filer_id) AS member_count
       FROM transactions t
       LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
      WHERE t.ticker IS NOT NULL AND t.ticker <> '' AND t.deprecated_at IS NULL
      GROUP BY t.ticker
      ORDER BY tx_count DESC`,
  );
  const assets = rows.map((row) => ({
    ticker: row.ticker,
    name: row.company_name || null,
    assetClass: row.asset_class || null,
    txCount: row.tx_count,
    memberCount: row.member_count,
  }));
  return { assets, count: assets.length };
}

function bearerToken(value: string | undefined): string | null {
  const prefix = 'Bearer ';
  if (!value || !value.startsWith(prefix)) return null;
  const token = value.slice(prefix.length).trim();
  return token || null;
}

function subscriptionSecretFromRequest(c: RestContext, allowQueryToken = false): string | null {
  return (
    bearerToken(c.req.header('Authorization')) ??
    c.req.header('X-Subscription-Secret') ??
    (allowQueryToken ? c.req.query('token') ?? null : null)
  );
}

async function isAuthorizedForSubscription(
  c: RestContext,
  sub: Subscription,
  allowQueryToken = false,
): Promise<boolean> {
  const provided = subscriptionSecretFromRequest(c, allowQueryToken);
  return Boolean(sub.secret && provided && (await constantTimeEqual(provided, sub.secret)));
}

function asChamber(v: string | undefined): Chamber | undefined {
  return v === 'house' || v === 'senate' || v === 'executive' ? v : undefined;
}

/** CSV multi-chamber selection; undefined = default congressional view
 *  (executive rows excluded — see TxQueryParams.chambers). */
function asChambers(v: string | undefined): Chamber[] | undefined {
  if (!v || !v.trim()) return undefined;
  const parsed = Array.from(
    new Set(v.split(',').map((part) => asChamber(part.trim())).filter((c): c is Chamber => !!c)),
  ).sort();
  return parsed.length ? parsed : undefined;
}

function asPartyBucket(v: string): 'D' | 'R' | 'O' | undefined {
  const c = v.trim().charAt(0).toUpperCase();
  return c === 'D' ? 'D' : c === 'R' ? 'R' : c === 'O' || c === 'I' ? 'O' : undefined;
}

/** CSV multi-party-bucket selection (e.g. "D,R"); undefined = no party filter
 *  (all parties, including unknown — see TxQueryParams.partyBuckets). Same
 *  bucketing (first-letter, I folded into O) as the analytics `?party=`
 *  filter, just multi-select instead of single-value. */
function asPartyBuckets(v: string | undefined): Array<'D' | 'R' | 'O'> | undefined {
  if (!v || !v.trim()) return undefined;
  const parsed = Array.from(
    new Set(
      v
        .split(',')
        .map((part) => asPartyBucket(part))
        .filter((c): c is 'D' | 'R' | 'O' => !!c),
    ),
  ).sort();
  return parsed.length ? parsed : undefined;
}

function asTxType(v: string | undefined): TxType | undefined {
  // Canonical storage B|S|E; legacy P (Purchase) → B.
  if (v === 'P' || v === 'p' || v === 'B' || v === 'b') return 'B';
  return v === 'S' || v === 'E' ? v : undefined;
}

/** CSV multi-type selection (e.g. "B,S"); undefined = no type filter. */
function asTxTypes(v: string | undefined): TxType[] | undefined {
  if (!v || !v.trim()) return undefined;
  const parsed = Array.from(
    new Set(v.split(',').map((part) => asTxType(part.trim())).filter((t): t is TxType => !!t)),
  ).sort();
  return parsed.length ? parsed : undefined;
}

/** Closed enum for the public `?owner=` feed filter (canonical insert-time set). */
function asOwner(v: string | undefined): Owner | undefined {
  return v === 'self' || v === 'spouse' || v === 'joint' || v === 'dependent' ? v : undefined;
}

/** `YYYY-MM-DD` for `days` ago (UTC), for the freemium recency gate. */
function isoDateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Escape a text node/attribute value for XML output (RSS feed). */
export function xmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Whitelist the sort direction; anything other than 'desc' falls back to asc. */
function asOrder(v: string | undefined): 'asc' | 'desc' | undefined {
  return v === 'desc' ? 'desc' : v === 'asc' ? 'asc' : undefined;
}

function asTxSort(v: string | undefined): TxQueryParams['sort'] {
  return v === 'published' ? 'published' : v === 'cursor' ? 'cursor' : v === 'tx_date' ? 'tx_date' : undefined;
}

/** Parse the shared ticker/member/type/chamber filters from the query string. */
function filtersFromQuery(q: Record<string, string>): TxQueryParams {
  const types = asTxTypes(q.type);
  return {
    ticker: q.ticker || undefined,
    member: q.member || undefined,
    memberName: q.memberName || undefined,
    chambers: asChambers(q.chamber),
    partyBuckets: asPartyBuckets(q.party),
    // Instrument-class dropdown; see TxQueryParams.assetCategories. Included
    // here so Premium CSV export and the RSS feed honor the same selection
    // the JSON feed does.
    assetCategories: asAssetCategories(q.assetClass ?? q.assetCategory),
    type: types?.length === 1 ? types[0] : asTxType(q.type),
    types: types && types.length > 1 ? types : undefined,
    stockAct: asStockActStatus(q.stockAct),
    owner: asOwner(q.owner),
    txDateMin: q.from || q.txDateMin || undefined,
    txDateMax: q.to || q.txDateMax || undefined,
    source: asTxSource(q.source),
  };
}

/**
 * CSV-escape a single cell (RFC 4180: wrap in quotes, double embedded quotes),
 * neutralizing spreadsheet formula injection (CT-AUD-008): Excel/Sheets treat
 * cells starting with = + - @ (or tab/CR) as formulas, so a hostile member/
 * asset/ticker string like "=HYPERLINK(...)" would execute on open. String
 * cells starting with such a character are prefixed with a single quote (the
 * standard mitigation). Numeric cells (amount_min/amount_max/confidence are
 * numbers) and purely numeric negative strings keep their exact formatting.
 */
export function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  const neutralized =
    typeof value === 'string' && /^[=+\-@\t\r]/.test(s) && !/^-\d+(\.\d+)?$/.test(s)
      ? `'${s}`
      : s;
  return /[",\r\n]/.test(neutralized) ? `"${neutralized.replace(/"/g, '""')}"` : neutralized;
}

export function buildRestRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  // CORS: stamp Access-Control-Allow-Origin on public, read-only GET responses
  // only (see isPublicReadPath). Vary: Origin keeps shared caches correct if
  // the policy ever becomes origin-aware. Simple GETs need no preflight, so no
  // OPTIONS handler is required for this policy.
  r.use('*', async (c, next) => {
    await next();
    // The router is mounted under /api in production but bare in tests.
    const path = new URL(c.req.url).pathname.replace(/^\/api(?=\/|$)/, '');
    if (c.req.method === 'GET' && isPublicReadPath(path)) {
      c.res.headers.set('Access-Control-Allow-Origin', '*');
      c.res.headers.append('Vary', 'Origin');
    }
  });

  // --- GET /health --------------------------------------------------------
  // Deployment readiness: D1 must be reachable and the required schema current.
  // Also reports the active cost profile (public, no secrets) so free-tier
  // ops can confirm CT_COST_PROFILE without an admin token.
  r.get('/health', async (c) => {
    const now = Date.now();
    if (!readinessCache || now - readinessCache.at >= READINESS_CACHE_TTL_MS) {
      readinessCache = { at: now, result: await checkReadiness(c.env.DB) };
    }
    if (!pipelineCache || now - pipelineCache.at >= READINESS_CACHE_TTL_MS) {
      pipelineCache = { at: now, result: await checkPipelineHealth(c.env) };
    }
    const readiness = readinessCache.result;
    const pipeline = pipelineCache.result;
    const envx = c.env as Env & Record<string, string | undefined>;
    const costProfile = costProfilePublicSummary(resolveDenoCostProfile(envx));
    // `build` identifies the running revision so a deploy can be *verified*
    // rather than assumed — ship.sh does not deploy, Coolify does, and that
    // webhook has silently not fired before. See src/shared/buildInfo.ts.
    const build = readBuildInfo(envx);
    const storage = await readLocalLitestreamAge();
    const r2Weekly = await readR2WeeklyArchiveStatus();
    // Public-safe Infisical view: source names, counts, errors.  Never values.
    // Shared-project keys (AGENT_SYNC_*) live only in shared-at-ct; app
    // projects must not duplicate them (app merge would shadow shared).
    const secrets = getSecretResolverStatus(c.env);
    return c.json(
      {
        ...readiness,
        status: readiness.ok ? pipeline.status : 'down',
        pipeline,
        costProfile,
        build,
        // Usage Monitor fleet backup reads checks.storage.litestreamAgeSeconds
        // and checks.storage.r2Weekly.
        checks: {
          storage: { ...storage, r2Weekly },
          datadog: datadogPublicStatus({
            ...(getDatadogInitInput() ?? {}),
            ...envx,
          }),
          secrets: {
            enabled: secrets.enabled,
            cacheReady: secrets.cacheReady,
            errors: secrets.errors,
            sources: secrets.sources.map((source) => ({
              name: source.name,
              configured: source.configured,
              ok: source.ok,
              count: source.count,
            })),
          },
        },
        time: new Date().toISOString(),
      },
      readiness.ok ? 200 : 503,
    );
  });

  // --- GET /health/deep ----------------------------------------------------
  // Deep pipeline diagnostics: probes queue backlogs, provider health counters,
  // LLM spend ceilings, and autopilot status without caching KV inspect calls.
  r.get('/health/deep', async (c) => {
    const pipeline = await checkPipelineHealth(c.env);
    const providers = await providerHealthDiagnostics(c.env);
    const spend = await inspectLlmSpend(c.env);
    return c.json(
      {
        status: pipeline.status,
        pipeline,
        providers,
        llmSpend: spend,
        time: new Date().toISOString(),
      },
      pipeline.status === 'stalled' ? 503 : 200,
    );
  });

  // --- GET /health/polling --------------------------------------------------
  // Owner directive (2026-08-10): per-chamber polling liveness can never be
  // silently off — see pipelineHealth.ts's polling_house/polling_senate/
  // polling_executive checks. Scoped, public, unauthenticated: exists purely
  // so one UptimeRobot HTTP monitor can page the owner on it directly (the
  // free plan caps at 10 monitors, which is why all three chambers aggregate
  // behind a single monitor instead of one each).
  r.get('/health/polling', async (c) => {
    const pipeline = await checkPipelineHealth(c.env);
    const checks = pipeline.checks.filter(
      (ch) => ch.id === 'polling_house' || ch.id === 'polling_senate' || ch.id === 'polling_executive',
    );
    // Only 'stalled' pages. 'unknown' and 'degraded' stay 200 so a transient
    // collection blip doesn't flap the pager — the polling_* checks don't
    // emit 'degraded' today anyway (each chamber is binary live/not-live).
    const ok = !checks.some((ch) => ch.status === 'stalled');
    c.header('Cache-Control', 'no-store');
    return c.json({ ok, checks }, ok ? 200 : 503);
  });

  // --- GET /health/latency ---------------------------------------------------
  // Same 2026-08-10 owner directive, for the latency-probe side: "monitor
  // that ALL latency providers are being probed" — a single quiet provider
  // must page. Scoped, public, unauthenticated, and the second (of two) of
  // the UptimeRobot monitors this pair of endpoints exists for.
  r.get('/health/latency', async (c) => {
    const check = (await checkPipelineHealth(c.env)).checks.find((ch) => ch.id === 'latency_probes') ?? null;
    // Pages on 'stalled' OR 'degraded': latency_probes already reserves
    // 'degraded' for a specific provider having gone silent rather than a
    // query hiccup, so both states are a real outage worth paging on.
    // 'unknown' (uncollected) stays 200.
    const ok = check === null || (check.status !== 'stalled' && check.status !== 'degraded');
    c.header('Cache-Control', 'no-store');
    return c.json({ ok, check }, ok ? 200 : 503);
  });

  // --- GET /health/senate-relay --------------------------------------------
  // Issue #1604: the named tunnel hostname is permanent; the Mac origin is
  // not.  Live-probes GET {SENATE_RELAY_URL}/health (5s budget) so a sleeping
  // laptop pages in minutes.  Does not call checkPipelineHealth — that path
  // is already the uptime-monitor target and must not grow an outbound hop.
  r.get('/health/senate-relay', async (c) => {
    const check = await probeSenateRelay(c.env);
    c.header('Cache-Control', 'no-store');
    return c.json(check, check.ok ? 200 : 503);
  });

  // --- GET /transactions --------------------------------------------------
  // Reconciliation backstop: rows with cursor_seq > since, ASC, plus the max
  // cursor in the page so clients can poll forward deterministically.
  //
  // Rolling-window pulls: pass ?from=YYYY-MM-DD (and optionally ?to=) to bound
  // the trade date. A consumer fetching the last N days passes from=today-Nd so
  // the server drops out-of-window rows up front — without it, a bounded pager
  // would have to page through all historical rows (oldest first) to reach
  // recent trades. `txDateMin`/`txDateMax` are accepted as aliases of from/to.
  //
  // Ordering: defaults to oldest-first (cursor_seq ASC) so a consumer can sync
  // incrementally by feeding the returned `cursor` back as the next `since`.
  // Pass ?order=desc for a newest-first "latest trades" snapshot ordered by
  // COALESCE(first_seen_at, filed_date, tx_date) — not ingest cursor, so a
  // historical backfill cannot occupy page 1 (#2180). Pair with ?from= to
  // bound the window. DESC is a snapshot, not a resumable forward pager;
  // incremental-sync consumers should keep the asc default. `sort=cursor`
  // restores ingest-newest if a caller wants it.
  r.get('/transactions', async (c) => {
    const q = c.req.query();
    // The live feed is fully public — it's the site's SEO/discovery hook. The
    // freemium boundary is premium-only *full-history export* (see
    // /export/transactions.csv), not hiding feed rows or public analytics.
    // (Earlier this gated the
    // feed to a short recent window for logged-out visitors, which emptied the page
    // on datasets without recent filings.)
    const params: TxQueryParams = {
      since: parseIntOrUndef(q.since),
      offset: parseIntOrUndef(q.offset),
      ticker: q.ticker || undefined,
      member: q.member || undefined,
      memberName: q.memberName || undefined,
      chambers: asChambers(q.chamber),
      partyBuckets: asPartyBuckets(q.party),
      assetCategories: asAssetCategories(q.assetClass ?? q.assetCategory),
      type: asTxType(q.type),
      stockAct: asStockActStatus(q.stockAct),
      owner: asOwner(q.owner),
      minAmount: parseIntOrUndef(q.minAmount),
      txDateMin: q.from || q.txDateMin || undefined,
      txDateMax: q.to || q.txDateMax || undefined,
      order: asOrder(q.order),
      sort: asTxSort(q.sort),
      limit: parseIntOrUndef(q.limit),
    };
    // Anti-scrape guards (src/security/botDefense.ts). The pager stays public
    // for humans; depth + daily row budgets make walking the whole corpus via
    // offset/since the job of Premium CSV export (authenticated) instead.
    // The depth cap is unconditional (it bounds D1 OFFSET cost in
    // every environment); only the daily row budget no-ops unless SCRAPE_GUARD_ENABLED.
    if ((params.offset ?? 0) > MAX_PUBLIC_TX_OFFSET) {
      return c.json(
        {
          error: `offset beyond ${MAX_PUBLIC_TX_OFFSET} is not available on the public feed`,
          hint: 'Premium CSV export: GET /api/export/transactions.csv (authenticated Premium session).',
        },
        400,
      );
    }
    const ip = clientIp(c.req.raw);
    const budget = await checkRowBudget(c.env, ip);
    if (!budget.ok) {
      return c.json(
        { error: 'daily feed row budget reached', hint: 'Premium CSV export available at GET /api/export/transactions.csv.' },
        429,
        { 'Retry-After': String(budget.retryAfterSec) },
      );
    }
    // A free-text memberName would force the un-indexed full-corpus LIKE path
    // (canNestTransactionKeyset bails on it). Resolve the name to a filer_id
    // first so the feed takes the indexed keyset path; an unresolved name keeps
    // the legacy LIKE fallback (seed rows whose filer_id has no filers entry).
    if (params.memberName && !params.member) {
      const resolvedFilerId = await resolveMemberFilerId(c.env, params.memberName);
      if (resolvedFilerId) {
        params.member = resolvedFilerId;
        params.memberName = undefined;
      }
    }
    const built = buildTransactionsQuery(params);
    // The query SELECTs the resolved chamber + politician name + party
    // alongside the feed columns via `__chamber` / `__member_name` / `__party`
    // (see buildTransactionsQuery). mapFeedTransaction maps the filer/filing
    // columns (fullName, state, photoUrl, dates); we then attach the resolved
    // `chamber` / `memberName` / `party`, which aren't part of the base
    // Transaction type on webhook/normalizer paths.
    const rows = await all<
      FeedTransactionRow & { __chamber?: string | null; __member_name?: string | null; __party?: string | null }
    >(c.env.DB, built.sql, built.params);
    const transactions = rows.map((row) => ({
      ...mapFeedTransaction(row),
      chamber: (row.__chamber as Chamber | null) ?? null,
      memberName: row.__member_name ?? null,
      party: row.__party ?? null,
    }));
    const maxCursor = transactions.reduce(
      (m, t) => (t.cursorSeq > m ? t.cursorSeq : m),
      params.since ?? 0,
    );
    // Zero-delta incremental poll: a `?since=` cursor with no new rows is the
    // dashboard's steady state (its fetchUpdates() bails out on an empty
    // delta before ever reading `total`/`filingsImportedToday`), so skip the
    // COUNT(*) and today-filings aggregates entirely rather than paying a
    // full live-row read every ~poll interval for numbers nobody reads. Both fields are omitted (not falsely reported as 0) so a
    // reconciliation consumer that DOES want a fresh total on every poll can
    // tell "not computed this round" apart from "actually zero".
    // `since > 0` (not merely present): the dashboard sends since=0 on its
    // FIRST/only page load, including every filtered query. Treating that as a
    // steady-state poll omitted `total` whenever a filter legitimately matched
    // zero rows, so the UI kept showing the previous (stale, unfiltered) count
    // instead of 0. Only a real cursor poll skips the COUNT.
    const isIncrementalNoOp =
      params.since !== undefined && params.since > 0 && transactions.length === 0;
    let effectiveCursor = maxCursor;
    if (isIncrementalNoOp) {
      const hwm = await readCursorHighWater(c.env);
      if (effectiveCursor > 1_000_000_000_000 || (hwm > 0 && effectiveCursor > hwm)) {
        effectiveCursor = hwm;
      }
    }
    let total: number | undefined;
    let filingsImportedToday: number | undefined;
    if (!isIncrementalNoOp) {
      // Total = ALL rows matching the same ticker/member/type/chamber filters,
      // ignoring the cursor backstop (so the UI can show "showing X of N").
      const countQuery = buildTransactionsCountQuery(params);
      const countRow = await first<{ total: number }>(c.env.DB, countQuery.sql, countQuery.params);
      total = countRow?.total ?? transactions.length;
      const today = new Date().toISOString().slice(0, 10);
      const todayQuery = buildTransactionsTodayFilingsQuery(params, today);
      const todayRow = await first<{ total: number }>(c.env.DB, todayQuery.sql, todayQuery.params);
      filingsImportedToday = todayRow?.total ?? 0;
    }
    // Count served rows against the caller's daily budget. Incremental polls
    // (the dashboard's steady state) return zero rows and skip the KV write.
    await spendRowBudget(c.env, ip, transactions.length);
    c.header('Cache-Control', PUBLIC_FEED_CACHE);
    return c.json({
      transactions,
      cursor: effectiveCursor,
      count: transactions.length,
      total,
      filingsImportedToday,
      limit: built.limit,
      offset: built.offset,
    });
  });

  // --- GET /export/transactions.csv ---------------------------------------
  // Premium full-history CSV download. Honors the same ticker/member/
  // type/chamber/date filters as the feed. getCurrentUserFromRequest accepts
  // session cookie and bearer so web + native clients share one gate.
  r.get('/export/transactions.csv', async (c) => {
    const user = await getCurrentUserFromRequest(c);
    // Signed in: unchanged Premium-session gate. Signed out (Guideline
    // 5.1.1(v)): fall back to a device entitlement token from the anonymous
    // Apple redeem route, instead of demanding sign-in before this feature —
    // which is not account-based — can be used at all.
    const premium = user
      ? await isPremiumUserAsync(c.env, user)
      : await hasAnonymousDeviceEntitlement(c);
    if (!premium) {
      // Always 402 "Premium required", never 401 "sign in required" — CSV
      // export is not account-based, so the fix is subscribing, not signing
      // in (though signing in remains available and optional).
      return c.json(
        { error: 'CSV export requires a Premium account', upgradeRequired: true, feature: 'export' },
        402,
      );
    }
    // Cap per IP so a premium account can't be scripted into unbounded read/CPU cost.
    // Fails open if KV down.
    const exRl = await rateLimit(c.env, 'export-ip', clientIp(c.req.raw), 30, 600);
    if (!exRl.ok) {
      return c.json({ error: 'too many export requests' }, 429, {
        'Retry-After': String(exRl.retryAfterSec),
      });
    }
    // Premium product rule: full match set, no product row cap. Free users are
    // already blocked above. Abuse/cost control = auth + per-IP rate limit
    // (not a silent incomplete file).
    const filters = filtersFromQuery(c.req.query());
    const built = buildTransactionsExportQuery(filters);
    const rows = await all<
      FeedTransactionRow & { __chamber?: string | null; __member_name?: string | null }
    >(c.env.DB, built.sql, built.params);

    const header = [
      'filed_at',
      'tx_date',
      'member',
      'chamber',
      'ticker',
      'asset',
      'type',
      'amount_min',
      'amount_max',
      'owner',
      'source',
      'confidence',
      'doc_id',
    ];
    const lines = [header.join(',')];
    for (const row of rows) {
      const t = mapFeedTransaction(row);
      lines.push(
        [
          t.createdAt,
          t.txDate ?? '',
          t.fullName ?? cleanMemberNameFallback(row.__member_name) ?? t.filerId ?? '',
          (row.__chamber as string | null) ?? '',
          t.ticker ?? '',
          t.assetName ?? '',
          t.txType,
          t.amountMin ?? '',
          t.amountMax ?? '',
          t.owner ?? '',
          t.source,
          t.confidence,
          t.docId,
        ]
          .map(csvCell)
          .join(','),
      );
    }
    const csv = lines.join('\r\n');
    const day = isoDateDaysAgo(0);
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="congress-trades-${day}.csv"`,
        'X-Export-Row-Count': String(rows.length),
        'X-Export-Complete': 'true',
        'Access-Control-Expose-Headers':
          'X-Export-Row-Count, X-Export-Complete, Content-Disposition',
      },
    });
  });

  // --- GET /feed.xml ------------------------------------------------------
  // RSS 2.0 over the same transactions query builder as /transactions: the
  // most recent trades as items so IFTTT/Zapier/news readers can subscribe.
  // Honors the same ticker/member/memberName/chamber/type filters as the JSON
  // feed (e.g. /api/feed.xml?ticker=AAPL&chamber=senate).
  r.get('/feed.xml', async (c) => {
    const params: TxQueryParams = { ...filtersFromQuery(c.req.query()), order: 'desc', limit: 50 };
    if (params.memberName && !params.member) {
      const resolvedFilerId = await resolveMemberFilerId(c.env, params.memberName);
      if (resolvedFilerId) {
        params.member = resolvedFilerId;
        params.memberName = undefined;
      }
    }
    const built = buildTransactionsQuery(params);
    const rows = await all<
      FeedTransactionRow & { __chamber?: string | null; __member_name?: string | null }
    >(c.env.DB, built.sql, built.params);
    const origin = new URL(c.req.url).origin;

    const items = rows.map((row) => {
      const tx = mapFeedTransaction(row);
      const who = tx.fullName ?? cleanMemberNameFallback(row.__member_name) ?? tx.filerId ?? 'Unknown filer';
      const side = (tx.txType === 'B' || String(tx.txType) === 'P') ? 'bought' : tx.txType === 'S' ? 'sold' : 'traded';
      const what = tx.ticker ?? tx.assetName;
      const title = `${who} ${side} ${what}`;
      const link = tx.sourceUrl ?? `${origin}/api/filings/${encodeURIComponent(tx.docId)}`;
      const pubSource = tx.firstSeenAt ?? tx.createdAt;
      const pubDate = pubSource ? new Date(pubSource).toUTCString() : '';
      const description = [
        tx.txDate ? `Trade date: ${tx.txDate}` : '',
        tx.filedDate ? `Filed: ${tx.filedDate}` : '',
        tx.assetName ? `Asset: ${tx.assetName}` : '',
        tx.amountMin != null || tx.amountMax != null
          ? `Amount: ${tx.amountMin ?? '?'}–${tx.amountMax ?? '?'}`
          : '',
      ].filter(Boolean).join(' · ');
      return '    <item>\n'
        + `      <title>${xmlEscape(title)}</title>\n`
        + `      <link>${xmlEscape(link)}</link>\n`
        + `      <guid isPermaLink="false">${xmlEscape(tx.id)}</guid>\n`
        + (pubDate ? `      <pubDate>${pubDate}</pubDate>\n` : '')
        + `      <description>${xmlEscape(description)}</description>\n`
        + '    </item>';
    });

    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<rss version="2.0">\n  <channel>\n'
      + '    <title>Congress.Trade — Recent Trades</title>\n'
      + `    <link>${xmlEscape(origin)}</link>\n`
      + '    <description>The most recent House, Senate, and Executive Branch stock trades.</description>\n'
      + items.join('\n')
      + '\n  </channel>\n</rss>\n';
    return new Response(xml, {
      headers: {
        'content-type': 'application/rss+xml; charset=utf-8',
        'cache-control': PUBLIC_FEED_CACHE,
      },
    });
  });

  // --- GET /stream --------------------------------------------------------
  // SSE live stream. With no ?since= and no Last-Event-ID, the stream attaches
  // at the current cursor high-water mark (live tail only). Resume / catch-up
  // uses ?since=<cursor_seq> or the Last-Event-ID header (each trade event
  // carries id:<cursorSeq>); replay is gap-free from the transactions table.
  //
  // Token transport: prefer `Authorization: Bearer <secret>` (or
  // X-Subscription-Secret) so the secret stays out of URLs (browser history,
  // proxy logs, Referer). The ?token= query form remains only for native
  // browser EventSource, which cannot set headers.
  r.get('/stream', async (c) => {
    const subscription = c.req.query('subscription');
    if (!subscription) {
      return c.json(
        {
          error: 'missing ?subscription=',
          hint: 'SSE is per Premium subscription. Pass ?subscription=<id> and Authorization: Bearer <secret> (or ?token= for native EventSource).',
        },
        400,
      );
    }
    const since = resolveResumeCursor(c.req.query('since'), c.req.header('Last-Event-ID'));
    const token = subscriptionSecretFromRequest(c, true) ?? undefined;
    return openSseStream(c.env, subscription, since, token, clientIp(c.req.raw));
  });

  // --- GET /logos/ticker --------------------------------------------------
  // Cached company-logo proxy (see ui/tickerLogos.ts). Reachable at
  // /api/logos/ticker?symbol=AAPL, matching the dashboard's <img> src.
  r.get('/logos/ticker', async (c) => {
    // Coolify historically injected LOGO_DEV_TOKEN; code/docs use LOGODEV_PUBLISHABLE_KEY.
    // Accept either so logo.dev is not silently skipped.
    const primary = (await resolveSecret(c.env, 'LOGODEV_PUBLISHABLE_KEY')).value;
    const alias = primary
      ? undefined
      : (await resolveSecret(c.env, 'LOGO_DEV_TOKEN')).value
        ?? (typeof c.env.LOGO_DEV_TOKEN === 'string' ? c.env.LOGO_DEV_TOKEN : undefined);
    const overlay = await readLogoPolicyOverlay(c.env);
    return handleTickerLogoRequest(new URL(c.req.url), primary ?? alias, overlay);
  });

  // --- GET /photos/member -------------------------------------------------
  // Head-focused member portrait (see enrichment/memberPhotoPack.ts). Answers
  // from the committed face pack first; a bioguide key we have no packed face
  // for falls through to the upstream public-domain CDN.
  r.get('/photos/member', async (c) => handleMemberPhotoRequest(new URL(c.req.url)));

  // --- GET /filings/:docId ------------------------------------------------
  // Detail endpoint on the same public corpus as /transactions: applies the
  // same per-IP daily row budget (a filing detail can carry many transaction
  // rows), hides retracted rows (`deprecated_at IS NULL`, same as the feed),
  // and never hands back internal fields — see toPublicFiling.
  r.get('/filings/:docId', async (c) => {
    const requestedId = c.req.param('docId');
    let filingRow = await get<FilingRow>(
      c.env.DB,
      'SELECT * FROM filings WHERE doc_id = ?',
      [requestedId],
    );
    // Drawer / deep-link may pass a transaction id.  Look that row up
    // directly.  The old self-join used `t2.source = "primary"` — libsql
    // treats double quotes as identifiers (DQS off), so a missing filing
    // threw instead of 404.  Live: GET /api/filings/H-2025-8220711,
    // H-2025-8220192, and any unknown docId (140ms 500).
    if (!filingRow) {
      let matched: { doc_id: string } | null = null;
      try {
        matched = await get<{ doc_id: string }>(
          c.env.DB,
          'SELECT doc_id FROM transactions WHERE id = ? LIMIT 1',
          [requestedId],
        );
      } catch {
        matched = null;
      }
      if (matched?.doc_id) {
        filingRow = await get<FilingRow>(
          c.env.DB,
          'SELECT * FROM filings WHERE doc_id = ?',
          [matched.doc_id],
        );
      }
    }
    if (!filingRow) return c.json({ error: 'filing not found' }, 404);
    const docId = filingRow.doc_id;

    const ip = clientIp(c.req.raw);
    const budget = await checkRowBudget(c.env, ip);
    if (!budget.ok) {
      return c.json(
        { error: 'daily feed row budget reached', hint: 'Use the Premium CSV export for bulk access.' },
        429,
        { 'Retry-After': String(budget.retryAfterSec) },
      );
    }

    const txRows = await all<TransactionRow>(
      c.env.DB,
      'SELECT * FROM transactions WHERE doc_id = ? AND deprecated_at IS NULL ORDER BY cursor_seq ASC',
      [docId],
    );
    await spendRowBudget(c.env, ip, txRows.length);
    c.header('Cache-Control', PUBLIC_STABLE_CACHE);
    return c.json({
      filing: toPublicFiling(mapFiling(filingRow)),
      transactions: txRows.map(mapTransaction),
    });
  });

  // --- GET /documents/:docId/pdf ------------------------------------------
  // Serves the raw PDF (if we fetched it) directly from R2, bypassing rate
  // limits/walls on original sources.
  r.get('/documents/:docId/pdf', serveDocumentPdf);
  r.get('/api/documents/:docId/pdf', serveDocumentPdf);

  // --- Market cache reads (cross-app sharing, reverse direction) ----------
  // App A is the always-on system of record; these public, read-only endpoints
  // let a sibling app reuse the FMP-derived data App A has already pulled
  // (cache-aside) instead of spending its own FMP quota. Shapes mirror the
  // POST /api/admin/securities/import payload, so the two apps are symmetric.

  // Daily-grain public reads: let shared/edge caches absorb repeat traffic.
  r.use('/market/*', async (c, next) => {
    await next();
    if (c.req.method === 'GET' && c.res.status === 200) {
      c.res.headers.set('Cache-Control', PUBLIC_STABLE_CACHE);
    }
  });

  // All series reads below are bounded: `?limit=` (default DEFAULT_MARKET_LIMIT,
  // hard cap MAX_MARKET_LIMIT) returns the LATEST N rows inside the from/to
  // window, re-sorted ascending for charting. Pass a tighter ?from= for older
  // history instead of raising the cap.

  // GET /market/ref/:ticker -> the cached securities_ref row (or 404).
  r.get('/market/ref/:ticker', async (c) => {
    const ticker = c.req.param('ticker').toUpperCase();
    const row = await get<SecurityRefRow>(
      c.env.DB,
      'SELECT * FROM securities_ref WHERE ticker = ?',
      [ticker],
    );
    if (!row) return c.json({ error: 'ticker not found' }, 404);
    return c.json({ ref: mapSecurityRef(row) });
  });

  // GET /market/refs?tickers=AAPL,MSFT,... -> cached refs for many tickers.
  r.get('/market/refs', async (c) => {
    const tickers = (c.req.query('tickers') || '')
      .split(',')
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, MAX_REFS_BATCH);
    if (tickers.length === 0) return c.json({ refs: [] });
    const placeholders = tickers.map(() => '?').join(',');
    const rows = await all<SecurityRefRow>(
      c.env.DB,
      `SELECT * FROM securities_ref WHERE ticker IN (${placeholders})`,
      tickers,
    );
    return c.json({ refs: rows.map(mapSecurityRef) });
  });

  // GET /market/prices/:ticker?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=N
  //   -> { ticker, closes:[{date,close}], currentPrice, currentPriceDate }.
  r.get('/market/prices/:ticker', async (c) => {
    const ticker = c.req.param('ticker').toUpperCase();
    const { sql, params } = priceRangeQuery(
      'price_eod',
      ticker,
      c.req.query('from'),
      c.req.query('to'),
      marketLimit(c.req.query('limit')),
    );
    const closes = await all<{ date: string; close: number; volume?: number | null }>(c.env.DB, sql, params);
    const ref = await get<{ current_price: number | null; current_price_date: string | null }>(
      c.env.DB,
      'SELECT current_price, current_price_date FROM securities_ref WHERE ticker = ?',
      [ticker],
    );
    const staleness = currentPriceStalenessFields(ref?.current_price_date ?? null);
    return c.json({
      ticker,
      closes,
      currentPrice: ref?.current_price ?? null,
      currentPriceDate: ref?.current_price_date ?? null,
      stale: staleness.stale,
      freshThrough: staleness.freshThrough,
      dataAgeDays: staleness.dataAgeDays,
    });
  });

  // GET /market/insider/:ticker?from=&to=&limit= -> insider (Form 4) daily aggregates.
  r.get('/market/insider/:ticker', async (c) => {
    const ticker = c.req.param('ticker').toUpperCase();
    const where = ['ticker = ?'];
    const params: (string | number)[] = [ticker];
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (from) { where.push('date >= ?'); params.push(from.slice(0, 10)); }
    if (to) { where.push('date <= ?'); params.push(to.slice(0, 10)); }
    const limit = marketLimit(c.req.query('limit'));
    const rows = await all<{
      date: string; sentiment: number | null; buy_filings: number | null;
      sell_filings: number | null; buy_shares: number | null; sell_shares: number | null;
      owners: string | null;
    }>(
      c.env.DB,
      `SELECT date, sentiment, buy_filings, sell_filings, buy_shares, sell_shares, owners
         FROM (SELECT date, sentiment, buy_filings, sell_filings, buy_shares, sell_shares, owners
                 FROM insider_eod WHERE ${where.join(' AND ')} ORDER BY date DESC LIMIT ${limit})
        ORDER BY date ASC`,
      params,
    );
    return c.json({
      ticker,
      rows: rows.map((r2) => ({
        date: r2.date,
        sentiment: r2.sentiment,
        buyFilings: r2.buy_filings,
        sellFilings: r2.sell_filings,
        buyShares: r2.buy_shares,
        sellShares: r2.sell_shares,
        owners: r2.owners ? (safeParse(r2.owners) ?? []) : [],
      })),
    });
  });

  // GET /market/fundamentals/:ticker?from=&to=&limit= -> cached fundamentals (P/E, EPS,
  // beta, 52w, FCF yield, debt/equity, EPS growth, dividend yield). Lets a sibling
  // app read back the fundamentals it (or our enrichment) already stored instead of
  // re-paying a provider — see docs/fmp-data-sharing.md.
  r.get('/market/fundamentals/:ticker', async (c) => {
    const ticker = c.req.param('ticker').toUpperCase();
    const where = ['ticker = ?'];
    const params: (string | number)[] = [ticker];
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (from) { where.push('date >= ?'); params.push(from.slice(0, 10)); }
    if (to) { where.push('date <= ?'); params.push(to.slice(0, 10)); }
    const limit = marketLimit(c.req.query('limit'));
    const rows = await all<{
      date: string; pe_ratio: number | null; eps: number | null; beta: number | null;
      dividend_yield: number | null; week52_high: number | null; week52_low: number | null;
      fcf_yield: number | null; debt_to_equity: number | null; eps_growth: number | null;
      source: string | null; updated_at: string;
    }>(
      c.env.DB,
      `SELECT date, pe_ratio, eps, beta, dividend_yield, week52_high, week52_low,
              fcf_yield, debt_to_equity, eps_growth, source, updated_at
         FROM (SELECT date, pe_ratio, eps, beta, dividend_yield, week52_high, week52_low,
                      fcf_yield, debt_to_equity, eps_growth, source, updated_at
                 FROM fundamentals_eod WHERE ${where.join(' AND ')} ORDER BY date DESC LIMIT ${limit})
        ORDER BY date ASC`,
      params,
    );
    return c.json({
      ticker,
      rows: rows.map((r2) => ({
        date: r2.date, peRatio: r2.pe_ratio, eps: r2.eps, beta: r2.beta,
        dividendYield: r2.dividend_yield, week52High: r2.week52_high, week52Low: r2.week52_low,
        fcfYield: r2.fcf_yield, debtToEquity: r2.debt_to_equity, epsGrowth: r2.eps_growth,
        source: r2.source, updatedAt: r2.updated_at,
      })),
    });
  });

  // GET /market/analyst/:ticker?from=&to=&limit= -> cached analyst consensus + targets.
  r.get('/market/analyst/:ticker', async (c) => {
    const ticker = c.req.param('ticker').toUpperCase();
    const where = ['ticker = ?'];
    const params: (string | number)[] = [ticker];
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (from) { where.push('date >= ?'); params.push(from.slice(0, 10)); }
    if (to) { where.push('date <= ?'); params.push(to.slice(0, 10)); }
    const limit = marketLimit(c.req.query('limit'));
    const rows = await all<{
      date: string; rating: string | null; target_mean: number | null; target_high: number | null;
      target_low: number | null; target_median: number | null; analyst_count: number | null;
      strong_buy: number | null; buy: number | null; hold: number | null; sell: number | null;
      strong_sell: number | null; source: string | null; updated_at: string;
    }>(
      c.env.DB,
      `SELECT date, rating, target_mean, target_high, target_low, target_median, analyst_count,
              strong_buy, buy, hold, sell, strong_sell, source, updated_at
         FROM (SELECT date, rating, target_mean, target_high, target_low, target_median, analyst_count,
                      strong_buy, buy, hold, sell, strong_sell, source, updated_at
                 FROM analyst_consensus WHERE ${where.join(' AND ')} ORDER BY date DESC LIMIT ${limit})
        ORDER BY date ASC`,
      params,
    );
    return c.json({
      ticker,
      rows: rows.map((r2) => ({
        date: r2.date, rating: r2.rating, targetMean: r2.target_mean, targetHigh: r2.target_high,
        targetLow: r2.target_low, targetMedian: r2.target_median, analystCount: r2.analyst_count,
        strongBuy: r2.strong_buy, buy: r2.buy, hold: r2.hold, sell: r2.sell, strongSell: r2.strong_sell,
        source: r2.source, updatedAt: r2.updated_at,
      })),
    });
  });

  // GET /market/short-volume/:ticker?from=&to=&limit= -> FINRA short-volume daily.
  r.get('/market/short-volume/:ticker', async (c) => {
    const ticker = c.req.param('ticker').toUpperCase();
    const where = ['ticker = ?'];
    const params: (string | number)[] = [ticker];
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (from) { where.push('date >= ?'); params.push(from.slice(0, 10)); }
    if (to) { where.push('date <= ?'); params.push(to.slice(0, 10)); }
    const limit = marketLimit(c.req.query('limit'));
    const rows = await all<{ date: string; short_volume_ratio: number | null; elevated: number }>(
      c.env.DB,
      `SELECT date, short_volume_ratio, elevated
         FROM (SELECT date, short_volume_ratio, elevated FROM short_volume_eod
                WHERE ${where.join(' AND ')} ORDER BY date DESC LIMIT ${limit})
        ORDER BY date ASC`,
      params,
    );
    return c.json({
      ticker,
      rows: rows.map((r2) => ({ date: r2.date, ratio: r2.short_volume_ratio, elevated: r2.elevated === 1 })),
    });
  });

  // GET /market/spx?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=N -> S&P 500 cached closes.
  r.get('/market/spx', async (c) => {
    const { sql, params } = priceRangeQuery(
      'spx_eod',
      null,
      c.req.query('from'),
      c.req.query('to'),
      marketLimit(c.req.query('limit')),
    );
    const closes = await all<{ date: string; close: number }>(c.env.DB, sql, params);
    return c.json({ closes });
  });

  // GET /market/bundle/:ticker?from=&to=&limit= -> ref + prices + spx in one call.
  r.get('/market/bundle/:ticker', async (c) => {
    const ticker = c.req.param('ticker').toUpperCase();
    const from = c.req.query('from');
    const to = c.req.query('to');
    const limit = marketLimit(c.req.query('limit'));
    const refRow = await get<SecurityRefRow>(c.env.DB, 'SELECT * FROM securities_ref WHERE ticker = ?', [ticker]);
    const pq = priceRangeQuery('price_eod', ticker, from, to, limit);
    const closes = await all<{ date: string; close: number; volume?: number | null }>(c.env.DB, pq.sql, pq.params);
    const sq = priceRangeQuery('spx_eod', null, from, to, limit);
    const spx = await all<{ date: string; close: number }>(c.env.DB, sq.sql, sq.params);
    const staleness = currentPriceStalenessFields(refRow?.current_price_date ?? null);
    return c.json({
      ticker,
      ref: refRow ? mapSecurityRef(refRow) : null,
      prices: {
        ticker,
        closes,
        currentPrice: refRow?.current_price ?? null,
        currentPriceDate: refRow?.current_price_date ?? null,
        stale: staleness.stale,
        freshThrough: staleness.freshThrough,
        dataAgeDays: staleness.dataAgeDays,
      },
      spx,
    });
  });

  // --- GET /members -------------------------------------------------------
  // Filers that actually appear in the transaction feed, joined to filer meta.
  r.get('/members', async (c) => {
    // The per-filer counts are a full-corpus GROUP BY over transactions — not
    // indexable away, and expensive to recompute on every members page load
    // (issue #1454, ~6s cold). Cache the whole roster (no params → a single
    // key); it only shifts with the daily ingest bursts, so a 30-min TTL is
    // invisible to users and cuts a full scan per hit down to one per window.
    const payload = await cached(c.env, 'members:roster', 1800, () => queryMembersRoster(c.env.DB));
    c.header('Cache-Control', PUBLIC_STABLE_CACHE);
    return c.json(payload);
  });

  // --- GET /assets ---------------------------------------------------------
  // Tickers that actually appear in the transaction feed, joined to
  // securities_ref for company name / asset class. The ticker-side analogue
  // of GET /members above — same full-corpus-GROUP-BY cost, same fix: cache
  // the whole roster (no params → a single key) for 30 minutes.
  r.get('/assets', async (c) => {
    const payload = await cached(c.env, 'assets:roster', 1800, () => queryAssetsRoster(c.env.DB));
    c.header('Cache-Control', PUBLIC_STABLE_CACHE);
    return c.json(payload);
  });

  // --- POST /subscriptions ------------------------------------------------
  r.post('/subscriptions', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const delivery = body.delivery;
    if (delivery !== 'webhook' && delivery !== 'sse') {
      return c.json({ error: "delivery must be 'webhook' or 'sse'" }, 400);
    }
    const user = await getCurrentUserFromRequest(c);
    if (!user) return c.json({ error: 'authentication required for durable subscriptions' }, 401);
    if (!(await isPremiumUserAsync(c.env, user))) {
      return c.json({ error: `${delivery === 'webhook' ? 'Webhook' : 'SSE'} delivery requires a Premium account`, upgradeRequired: true, feature: 'alerts' }, 402);
    }
    const clientId = `user:${user.id}`;
    const subRl = await rateLimit(c.env, 'sub-create-user', clientId, 10, 3600);
    if (!subRl.ok) return c.json({ error: 'too many subscription requests' }, 429, { 'Retry-After': String(subRl.retryAfterSec) });

    const targetUrl =
      typeof body.targetUrl === 'string' && body.targetUrl.length > 0 ? body.targetUrl : null;
    const targetLengthError = webhookTargetLengthError(targetUrl);
    if (targetLengthError) return c.json({ error: targetLengthError }, 400);
    if (delivery === 'webhook') {
      const targetUrlError = await validatePublicWebhookTarget(targetUrl, {
        allowLocalhost: localWebhookTargetsAllowed(c.env, c.req.url),
      });
      if (targetUrlError) return c.json({ error: targetUrlError }, 400);
    }

    const validatedFilters = await validateAndResolveSubscriptionFilters(c.env, body.filters);
    if (!validatedFilters.ok) return c.json(subscriptionFilterErrorBody(validatedFilters), 400);
    const secretError = subscriptionSecretError(body.secret);
    if (secretError) return c.json({ error: secretError }, 400);
    const secret = typeof body.secret === 'string' ? body.secret : undefined;

    try {
      await assertSubscriptionQuota(c.env, clientId, { creating: true });
      const sub = await createSubscription(c.env, {
        clientId,
        delivery,
        targetUrl,
        secret: secret ?? null,
        filters: validatedFilters.filters,
      });
      return c.json(toPublicSubscription(sub, { includeSecret: true }), 201);
    } catch (err) {
      if (err instanceof SubscriptionQuotaError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  // --- GET /subscriptions -------------------------------------------------
  // 403 (not 401): the route is forbidden for everyone, not an auth challenge
  // — no credential would make public listing succeed.
  r.get('/subscriptions', async (c) => {
    return c.json(
      { error: 'public subscription listing is disabled; use /api/admin/subscriptions' },
      403,
    );
  });

  // --- GET /subscriptions/:id ---------------------------------------------
  r.get('/subscriptions/:id', async (c) => {
    const sub = await getSubscription(c.env, c.req.param('id'));
    if (!sub) return c.json({ error: 'subscription not found' }, 404);
    if (!(await isAuthorizedForSubscription(c, sub))) {
      return c.json({ error: 'subscription secret required' }, 401);
    }
    return c.json(toPublicSubscription(sub));
  });

  // --- PATCH /subscriptions/:id -------------------------------------------
  r.patch('/subscriptions/:id', async (c) => {
    const id = c.req.param('id');
    const existing = await getSubscription(c.env, id);
    if (!existing) return c.json({ error: 'subscription not found' }, 404);
    if (!(await isAuthorizedForSubscription(c, existing))) {
      return c.json({ error: 'subscription secret required' }, 401);
    }
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    // The premium gate is anchored to the subscription OWNER, never the
    // request's session (any premium cookie must not unlock someone else's
    // subscription). User-owned rows store clientId as `user:<id>`; admin
    // operator-provisioned integration ids are intentionally ungated.
    const isContinuingOrChangingDelivery = body.filters !== undefined || body.targetUrl !== undefined || body.active === true;
    if (isContinuingOrChangingDelivery && existing.clientId?.startsWith('user:')) {
      const ownerUser = await getUserById(c.env, existing.clientId.slice('user:'.length));
      if (!ownerUser || !(await isPremiumUserAsync(c.env, ownerUser))) {
        return c.json({ error: 'subscription management requires a Premium account', upgradeRequired: true, feature: 'alerts' }, 402);
      }
    }

    const patch: Parameters<typeof updateSubscription>[2] = {};
    if (body.filters !== undefined) {
      const validatedFilters = await validateAndResolveSubscriptionFilters(c.env, body.filters);
      if (!validatedFilters.ok) return c.json(subscriptionFilterErrorBody(validatedFilters), 400);
      patch.filters = validatedFilters.filters;
    }
    if (typeof body.targetUrl === 'string' || body.targetUrl === null) {
      patch.targetUrl = body.targetUrl as string | null;
      const targetLengthError = webhookTargetLengthError(patch.targetUrl);
      if (targetLengthError) return c.json({ error: targetLengthError }, 400);
      if (existing.delivery === 'webhook') {
        const targetUrlError = await validatePublicWebhookTarget(patch.targetUrl, {
          allowLocalhost: localWebhookTargetsAllowed(c.env, c.req.url),
        });
        if (targetUrlError) return c.json({ error: targetUrlError }, 400);
      }
    }
    if (body.secret !== undefined && body.secret !== null && typeof body.secret !== 'string') {
      return c.json({ error: 'secret must be a string' }, 400);
    }
    if (typeof body.secret === 'string') {
      const secretError = subscriptionSecretError(body.secret);
      if (secretError) return c.json({ error: secretError }, 400);
      patch.secret = body.secret;
    } else if (body.secret === null) {
      return c.json({ error: 'secret cannot be cleared' }, 400);
    }
    if (typeof body.active === 'boolean') {
      if (body.active && !existing.active) {
        try {
          await assertSubscriptionQuota(c.env, existing.clientId, { activating: true });
        } catch (err) {
          if (err instanceof SubscriptionQuotaError) return c.json({ error: err.message }, 409);
          throw err;
        }
      }
      patch.active = body.active;
    }
    if (typeof body.cursor === 'number') {
      patch.cursor = body.cursor;
    }

    try {
      const updated = await updateSubscription(c.env, id, patch);
      return c.json(toPublicSubscription(updated, { includeSecret: patch.secret !== undefined }));
    } catch (err) {
      if (err instanceof SubscriptionQuotaError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  return r;
}

/**
 * App Store 3.1.1: native clients send Bearer and/or Accept: application/pdf.
 * Those must get 402 JSON, never a 302 to /pricing (Safari would open Stripe).
 * Browser HTML navigations without Bearer still 302 to the web paywall.
 */
export function documentPdfGateWantsJson(headers: {
  authorization?: string | null;
  accept?: string | null;
}): boolean {
  const auth = headers.authorization ?? '';
  if (/^bearer\s+\S+/i.test(auth)) return true;
  const accept = (headers.accept ?? '').toLowerCase();
  return accept.includes('application/pdf');
}

export function documentPdfUpgradePayload(): {
  error: string;
  upgradeRequired: true;
  feature: 'pdf';
} {
  return {
    error: 'Archived filing PDF requires a Premium account',
    upgradeRequired: true,
    feature: 'pdf',
  };
}

/**
 * Second, account-free entitlement path for a signed-out device that
 * anonymously redeemed an Apple purchase (Guideline 5.1.1(v) —
 * `client/entitlements.ts` `POST /api/client/v1/entitlements/apple/redeem`).
 * Verifies the HMAC token, then re-checks the LIVE ledger row (not just the
 * token's own signature) so a refund/revoke applied after the token was
 * issued still takes effect the moment it reaches `apple_subscriptions` —
 * the token's own expiry (<=24h) is only the outer bound for how long a
 * webhook delivery can lag behind, not the sole check.
 */
async function hasAnonymousDeviceEntitlement(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const token = c.req.header('X-Apple-Device-Entitlement');
  if (!token) return false;
  const claim = await verifyDeviceEntitlementToken(c.env, token);
  if (!claim) return false;
  const sub = await getAppleSubscription(c.env, claim.originalTransactionId);
  if (!sub || !appleStatusGrantsAccess(sub.status)) return false;
  if (sub.expiresDate && new Date(sub.expiresDate).getTime() <= Date.now()) return false;
  return true;
}

export async function serveDocumentPdf(c: Context<{ Bindings: Env }>) {
  const user = await getCurrentUserFromRequest(c);
  // Session wins when present; a signed-out device falls back to its own
  // Apple entitlement token — never the other way around, and never OR'd
  // with a session that simply isn't Premium (that stays gated).
  const premium = user ? await isPremiumUserAsync(c.env, user) : await hasAnonymousDeviceEntitlement(c);
  if (!premium) {
    return c.json(documentPdfUpgradePayload(), 402);
  }

  const docId = c.req.param('docId');
  const filingRow = await get<FilingRow>(
    c.env.DB,
    'SELECT raw_object_key, source_url FROM filings WHERE doc_id = ?',
    [docId],
  );

  // STORED COPY ONLY (2026-08-10): never 302 to Clerk/eFD/OGE. Redirecting
  // browsers (and any intermediate crawlers) at primary sources burns IP
  // reputation and can serve a different document than the one we extracted.
  // If we have not stored the bytes yet, 404 honestly.
  if (!filingRow || !filingRow.raw_object_key) {
    return c.json({ error: 'document not found or not fetched' }, 404);
  }
  const obj = await c.env.RAW_FILES.get(filingRow.raw_object_key);
  if (!obj) {
    return c.json({ error: 'document not found in storage' }, 404);
  }

  const contentType = obj.httpMetadata?.contentType || 'application/pdf';
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-disposition': 'inline',
    'cache-control': 'public, max-age=86400, immutable',
    'x-content-type-options': 'nosniff',
    'x-congress-trade-source': 'stored-raw',
  };
  // Stored senate filings are text/html authored by a third party (eFD).
  // Serving them inline from our origin must never execute their markup in
  // our origin context: CSP sandbox (no allow-scripts, no allow-same-origin)
  // still renders the static document read-only. We enhance Senate HTML
  // (extracting paper scans into a clean multi-page reader or injecting table CSS)
  // so it renders legibly and reliably under sandbox CSP. PDFs stream as-is.
  if (contentType.toLowerCase().includes('html')) {
    headers['content-security-policy'] = 'sandbox';
    const rawText = typeof (obj as any).text === 'function'
      ? await (obj as any).text()
      : await new Response(obj.body).text();
    const enhanced = enhanceSenateHtmlDocument(rawText, docId, filingRow.source_url);
    return new Response(enhanced, { headers });
  }
  return new Response(obj.body, { headers });
}

// --- Market cache read helpers (cross-app sharing) ------------------------

/** Valid MktCapBucket values — shared-schema parity enforced at delivery. */
const VALID_MKT_CAP_BUCKETS = new Set(['mega', 'large', 'mid', 'small', 'micro', 'nano']);

interface SecurityRefRow {
  ticker: string;
  company_name: string | null;
  sector: string | null;
  industry: string | null;
  asset_class: string | null;
  is_etf: number | null;
  is_adr: number | null;
  country: string | null;
  state_hq: string | null;
  state_of_incorp: string | null;
  exchange: string | null;
  exchange_short: string | null;
  currency: string | null;
  market_cap: number | null;
  market_cap_bucket: string | null;
  ipo_date: string | null;
  cik: string | null;
  sic_code: string | null;
  sic_description: string | null;
  source: string | null;
  enriched_at: string | null;
  current_price: number | null;
  current_price_date: string | null;
}

/** Map a securities_ref row to the camelCase shape the import API accepts. */
export function mapSecurityRef(row: SecurityRefRow) {
  // Guard: clamp marketCapBucket to the shared 6-value enum so one bad row
  // does not throw the entire getRefs batch (up to MAX_REFS_BATCH items).
  const bucket = row.market_cap_bucket;
  const safeBucket = bucket && VALID_MKT_CAP_BUCKETS.has(bucket) ? bucket : null;

  // Guard: currentPriceDate must be YYYY-MM-DD (IsoDateSchema shape).
  const priceDate = row.current_price_date;
  const safePriceDate = priceDate && /^\d{4}-\d{2}-\d{2}$/.test(priceDate) ? priceDate : null;

  return {
    ticker: row.ticker,
    companyName: row.company_name,
    sector: row.sector,
    industry: row.industry,
    assetClass: row.asset_class,
    isEtf: row.is_etf === 1,
    isAdr: row.is_adr === 1,
    country: row.country,
    stateHq: row.state_hq,
    stateOfIncorp: row.state_of_incorp,
    exchange: row.exchange,
    exchangeShort: row.exchange_short,
    currency: row.currency,
    marketCap: row.market_cap,
    marketCapBucket: safeBucket,
    ipoDate: row.ipo_date,
    cik: row.cik,
    sicCode: row.sic_code,
    sicDescription: row.sic_description,
    source: row.source,
    enrichedAt: row.enriched_at,
    currentPrice: row.current_price,
    currentPriceDate: safePriceDate,
  };
}

/** Default and hard-cap row limits for /market/* series reads (`?limit=`). */
export const DEFAULT_MARKET_LIMIT = 1000;
export const MAX_MARKET_LIMIT = 5000;

/**
 * Clamp the /market/* `?limit=` param to a safe integer. The result is
 * interpolated into SQL (D1/SQLite has no bound-parameter LIMIT), so it must
 * never be fractional, non-finite, or above the hard cap.
 */
export function marketLimit(value: string | undefined): number {
  let n = Number.isFinite(Number(value)) && value !== undefined && value !== ''
    ? Math.floor(Number(value))
    : DEFAULT_MARKET_LIMIT;
  if (n <= 0) n = DEFAULT_MARKET_LIMIT;
  return Math.min(n, MAX_MARKET_LIMIT);
}

/**
 * Build an ascending close-series query for price_eod (needs a ticker) or
 * spx_eod (no ticker), with optional inclusive from/to date bounds. Bounded by
 * `limit`: the LATEST `limit` rows inside the window are returned, re-sorted
 * ascending for charting (pass a tighter `from` for older history).
 */
export function priceRangeQuery(
  table: 'price_eod' | 'spx_eod',
  ticker: string | null,
  from?: string,
  to?: string,
  limit: number = DEFAULT_MARKET_LIMIT,
): { sql: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (table === 'price_eod' && ticker) {
    where.push('ticker = ?');
    params.push(ticker);
  }
  if (from) {
    where.push('date >= ?');
    params.push(from.slice(0, 10));
  }
  if (to) {
    where.push('date <= ?');
    params.push(to.slice(0, 10));
  }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  // price_eod carries a daily volume column; spx_eod does not.
  const cols = table === 'price_eod' ? 'date, close, volume' : 'date, close';
  const n = marketLimit(String(limit));
  return {
    sql: `SELECT ${cols} FROM (SELECT ${cols} FROM ${table}${clause} ORDER BY date DESC LIMIT ${n}) ORDER BY date ASC`,
    params,
  };
}

/** JSON.parse that returns null instead of throwing. */
function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
