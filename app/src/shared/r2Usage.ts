/**
 * src/shared/r2Usage.ts
 *
 * Daily R2 free-tier usage summary. Reads the account's Cloudflare GraphQL
 * analytics (r2StorageAdaptiveGroups + r2OperationsAdaptiveGroups) for the
 * current UTC month, computes each dimension's % of the free tier plus its
 * pace (projected month-end at the current burn rate), and hands a compact
 * human-readable message to a delivery channel (Pushover — see
 * shared/pushover.ts). Runs from the daily-jobs cron lane.
 *
 * Free tier (per billing month): 10 GB storage, 1M Class A (mutating)
 * operations, 10M Class B (read) operations, zero egress fees.
 * Docs: https://developers.cloudflare.com/r2/pricing/
 *
 * Config (Infisical-backed, env fallback — resolved per run):
 *   CLOUDFLARE_ACCOUNT_ID          account tag for the GraphQL viewer query
 *   CLOUDFLARE_R2_ANALYTICS_TOKEN  scoped API token (Account Analytics Read +
 *                                  Workers R2 Storage Read on this account)
 *   PUSHOVER_APP_TOKEN / PUSHOVER_USER_KEY  (delivery; see pushover.ts)
 *
 * Everything FAILS OPEN: missing config or any fetch/parse error results in a
 * logged skip, never a thrown error into the cron lane.
 */

import type { Env } from './types.ts';
import { resolveSecrets } from '../secrets/infisical.ts';
import { sendPushover } from './pushover.ts';

/** R2 free-tier allowances per billing month. */
export const R2_FREE_TIER = {
  storageBytes: 10 * 1024 * 1024 * 1024, // 10 GiB
  classAOps: 1_000_000,
  classBOps: 10_000_000,
} as const;

/**
 * Class A operations "tend to mutate state" (per Cloudflare R2 pricing docs).
 * Anything not listed here and not a recognized read is counted separately as
 * `other` so an unclassified action never silently inflates either bucket.
 */
const CLASS_A_ACTIONS = new Set([
  'ListBuckets',
  'PutBucket',
  'DeleteBucket',
  'PutBucketCors',
  'DeleteBucketCors',
  'GetBucketCors', // billed Class A per R2 docs (bucket-config reads are A)
  'PutBucketLifecycle',
  'DeleteBucketLifecycle',
  'PutBucketEncryption',
  'DeleteBucketEncryption',
  'PutBucketPolicy',
  'DeleteBucketPolicy',
  'PutObject',
  'CopyObject',
  'DeleteObject',
  'DeleteObjects',
  'CreateMultipartUpload',
  'UploadPart',
  'UploadPartCopy',
  'CompleteMultipartUpload',
  'AbortMultipartUpload',
  'ListMultipartUploads',
  'ListParts',
  'PutObjectLegalHold',
  'PutObjectRetention',
  'PutObjectTagging',
  'DeleteObjectTagging',
  'PutObjectAcl',
]);

/** Class B operations "tend to read existing state". */
const CLASS_B_ACTIONS = new Set([
  'GetObject',
  'HeadObject',
  'HeadBucket',
  'ListObjects',
  'ListObjectsV2',
  'GetBucketLocation',
  'GetBucketLifecycle',
  'GetBucketEncryption',
  'GetBucketPolicy',
  'GetObjectTagging',
  'GetObjectAcl',
  'GetObjectLegalHold',
  'GetObjectRetention',
]);

export interface R2OpsCount {
  actionType: string;
  requests: number;
}

export interface R2StoragePoint {
  /** Present when the source query groups by bucket; absent = account-wide set. */
  bucketName?: string;
  datetime: string;
  payloadSize: number;
  metadataSize: number;
  objectCount: number;
}

export interface R2UsageSummary {
  /** Latest stored bytes (payload + metadata), account-wide. */
  storageBytes: number;
  objectCount: number;
  /** Stored bytes at the closest sample ~7 days ago, null when unavailable. */
  storageBytesWeekAgo: number | null;
  classAOps: number;
  classBOps: number;
  otherOps: number;
  /** UTC month progress in [0,1] at `now`. */
  monthElapsed: number;
  daysInMonth: number;
  dayOfMonth: number;
}

/** Split raw per-actionType counts into Class A / Class B / other. */
export function classifyOps(ops: R2OpsCount[]): { classA: number; classB: number; other: number } {
  let classA = 0;
  let classB = 0;
  let other = 0;
  for (const { actionType, requests } of ops) {
    if (CLASS_A_ACTIONS.has(actionType)) classA += requests;
    else if (CLASS_B_ACTIONS.has(actionType)) classB += requests;
    else other += requests;
  }
  return { classA, classB, other };
}

function daysInUtcMonth(now: Date): number {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * Fold storage samples + op counts into a summary. Storage samples arrive as
 * (bucket, datetime) rows with max{} values; the account total for a day is
 * the SUM across buckets of the latest sample per bucket, so multi-bucket
 * accounts stay correct. `storageBytesWeekAgo` uses the per-bucket sample
 * closest to (now - 7d).
 */
export function buildSummary(storage: R2StoragePoint[], ops: R2OpsCount[], now: Date): R2UsageSummary {
  const sorted = [...storage].sort((a, b) => a.datetime.localeCompare(b.datetime));
  const latestPerBucket = new Map<string, R2StoragePoint>();
  const weekAgoPerBucket = new Map<string, R2StoragePoint>();
  const weekAgoTarget = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  // Bucket identity isn't carried in R2StoragePoint (callers may strip it);
  // treat the whole set as one bucket when no bucket key is available.
  for (const point of sorted) {
    const bucket = point.bucketName ?? '_all';
    latestPerBucket.set(bucket, point);
    const t = Date.parse(point.datetime);
    if (Number.isFinite(t) && t <= weekAgoTarget) weekAgoPerBucket.set(bucket, point);
  }
  let storageBytes = 0;
  let objectCount = 0;
  for (const p of latestPerBucket.values()) {
    storageBytes += (p.payloadSize || 0) + (p.metadataSize || 0);
    objectCount += p.objectCount || 0;
  }
  let storageBytesWeekAgo: number | null = 0;
  for (const p of weekAgoPerBucket.values()) {
    storageBytesWeekAgo += (p.payloadSize || 0) + (p.metadataSize || 0);
  }
  if (weekAgoPerBucket.size === 0) storageBytesWeekAgo = null;

  const { classA, classB, other } = classifyOps(ops);
  const dim = daysInUtcMonth(now);
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const monthElapsed = Math.min(1, Math.max(0, (now.getTime() - monthStart) / (monthEnd - monthStart)));

  return {
    storageBytes,
    objectCount,
    storageBytesWeekAgo,
    classAOps: classA,
    classBOps: classB,
    otherOps: other,
    monthElapsed,
    daysInMonth: dim,
    dayOfMonth: now.getUTCDate(),
  };
}

function pct(used: number, limit: number): number {
  return limit > 0 ? (used / limit) * 100 : 0;
}

function fmtPct(used: number, limit: number): string {
  const p = pct(used, limit);
  return p >= 10 ? p.toFixed(1) : p.toFixed(2);
}

function fmtBytes(n: number): string {
  const gib = n / (1024 * 1024 * 1024);
  if (gib >= 0.1) return `${gib.toFixed(2)} GB`;
  const mib = n / (1024 * 1024);
  return `${mib.toFixed(1)} MB`;
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * One pace line: current % of the free tier plus the projected month-end % at
 * the current burn rate. Pace is only meaningful once the month has some
 * elapsed time; before 3% elapsed we report the raw MTD number only.
 */
function paceLine(label: string, used: number, limit: number, monthElapsed: number): string {
  const current = fmtPct(used, limit);
  if (monthElapsed < 0.03) return `${label}: ${fmtCount(used)} (${current}% of free tier)`;
  const projected = fmtPct(used / monthElapsed, limit);
  return `${label}: ${fmtCount(used)} (${current}% MTD, pace → ${projected}% at month-end)`;
}

/** This process's product identity for Pushover footers. */
export const R2_SENDER_APP_LABEL = 'Congress.Trade';

/**
 * Append `(sent from APP)` only when messaging under another product's Pushover
 * logo (subject ≠ this runner). Same-product messages omit the footer.
 *
 * @param subjectIsSelf true when the free-tier subject matches this host (CT).
 */
export function appendSentFromFooter(
  body: string,
  opts?: { subjectIsSelf?: boolean; senderLabel?: string },
): string {
  const trimmed = body.replace(/\s+$/u, '');
  const subjectIsSelf = opts?.subjectIsSelf ?? true;
  if (subjectIsSelf) return trimmed;
  const senderLabel = opts?.senderLabel ?? R2_SENDER_APP_LABEL;
  const footer = `(sent from ${senderLabel})`;
  if (trimmed.endsWith(footer)) return trimmed;
  return `${trimmed}\n${footer}`;
}

/**
 * Prefer the SUBJECT product's Pushover app token (CT for own free tier).
 * When messaging about another fleet free tier, pass that product's token env.
 */
export function resolveCongressPushoverAppToken(
  secrets: { PUSHOVER_APP_TOKEN?: string; PUSHOVER_CT_API_TOKEN?: string },
): string {
  return (
    secrets.PUSHOVER_CT_API_TOKEN?.trim() ||
    secrets.PUSHOVER_APP_TOKEN?.trim() ||
    ''
  );
}

/**
 * Own backup reminder: three independent layers, coarsest last.
 *
 * 1. Continuous Litestream replication to B2, rebuilt 2026-08-12 as an
 *    in-container replica (app/litestream.yml -> jays-congress-trade-eu,
 *    prefix `congress-trade/`) after the Oracle->Hetzner migration dropped
 *    the old host-level systemd unit that targeted R2. ~5m RPO.
 * 2. The fleet cron's 6h full-DB snapshots, already running, written to the
 *    SAME bucket under the disjoint prefix `hetzner/`. Litestream is layered
 *    on top of these, not a replacement — the full snapshots stay as the
 *    coarse, self-contained restore artifact that needs no LTX replay.
 * 3. Hetzner volume snapshots, the ~24h floor.
 *
 * B2 has no free-tier kill switch (unlike the `raw/` filing-PDF object store,
 * which still lives on R2), so `killEngaged` does not apply to this backup
 * path; the parameter is kept for call-site compatibility and always reports
 * the steady-state line.
 */
export function formatOwnBackupRegimenLine(killEngaged = false): string {
  void killEngaged;
  return 'Backup: litestream→B2 continuous (15m sync · 24h/168h snapshots) + 6h full-DB snapshots (fleet cron) + Hetzner ~24h volume floor.';
}

/** Compact message body for the Pushover notification. */
export function formatUsageMessage(s: R2UsageSummary, now: Date): string {
  const lines: string[] = [];
  const storagePct = fmtPct(s.storageBytes, R2_FREE_TIER.storageBytes);
  let storageLine =
    `Storage: ${fmtBytes(s.storageBytes)} / ${fmtBytes(R2_FREE_TIER.storageBytes)} (${storagePct}%)` +
    ` · ${fmtCount(s.objectCount)} objects`;
  if (s.storageBytesWeekAgo != null) {
    const delta = s.storageBytes - s.storageBytesWeekAgo;
    const sign = delta >= 0 ? '+' : '−';
    storageLine += ` · ${sign}${fmtBytes(Math.abs(delta))} vs 7d ago`;
    // Storage pace: project the 7-day growth rate to month-end.
    if (delta > 0 && s.daysInMonth > s.dayOfMonth) {
      const dailyGrowth = delta / 7;
      const projected = s.storageBytes + dailyGrowth * (s.daysInMonth - s.dayOfMonth);
      storageLine += ` → ${fmtPct(projected, R2_FREE_TIER.storageBytes)}% at month-end`;
    }
  }
  lines.push(storageLine);
  lines.push(paceLine('Class A ops', s.classAOps, R2_FREE_TIER.classAOps, s.monthElapsed));
  lines.push(paceLine('Class B ops', s.classBOps, R2_FREE_TIER.classBOps, s.monthElapsed));
  if (s.otherOps > 0) lines.push(`Unclassified ops: ${fmtCount(s.otherOps)} (not in A/B map)`);

  const worst = Math.max(
    pct(s.storageBytes, R2_FREE_TIER.storageBytes),
    pct(s.classAOps / Math.max(s.monthElapsed, 0.03), R2_FREE_TIER.classAOps),
    pct(s.classBOps / Math.max(s.monthElapsed, 0.03), R2_FREE_TIER.classBOps),
  );
  const status = worst >= 80 ? '⚠️ OVER 80% — action needed' : worst >= 50 ? 'Heads-up: >50% projected' : 'OK — well within free tier';
  lines.push(`Status: ${status}`);
  lines.push(formatOwnBackupRegimenLine(false));
  // Own free tier under CT logo — no sent-from footer (only peers would stamp one).
  return appendSentFromFooter(lines.join('\n'), { subjectIsSelf: true });
}

interface GraphqlResponse {
  data?: {
    viewer?: {
      accounts?: Array<{
        storage?: Array<{
          dimensions?: { bucketName?: string; datetime?: string };
          max?: { payloadSize?: number; metadataSize?: number; objectCount?: number };
        }>;
        ops?: Array<{
          dimensions?: { actionType?: string; bucketName?: string };
          sum?: { requests?: number };
        }>;
      }>;
    };
  };
  errors?: Array<{ message?: string }>;
}

const R2_USAGE_QUERY = `query ($acct: String!, $since: Time!) {
  viewer { accounts(filter: {accountTag: $acct}) {
    storage: r2StorageAdaptiveGroups(limit: 1000, filter: {datetime_geq: $since}) {
      dimensions { bucketName datetime }
      max { payloadSize metadataSize objectCount }
    }
    ops: r2OperationsAdaptiveGroups(limit: 1000, filter: {datetime_geq: $since}) {
      dimensions { actionType bucketName }
      sum { requests }
    }
  } }
}`;

/** Fetch this month's raw analytics. Exported for tests (fetch injectable). */
export async function fetchR2Usage(
  accountId: string,
  token: string,
  now: Date,
  fetchFn: typeof fetch = fetch,
): Promise<{ storage: R2StoragePoint[]; ops: R2OpsCount[] }> {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const res = await fetchFn('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: R2_USAGE_QUERY, variables: { acct: accountId, since } }),
  });
  if (!res.ok) throw new Error(`cloudflare graphql HTTP ${res.status}`);
  const body = (await res.json()) as GraphqlResponse;
  if (body.errors?.length) throw new Error(`cloudflare graphql: ${body.errors[0]?.message ?? 'unknown error'}`);
  const acct = body.data?.viewer?.accounts?.[0];
  if (!acct) throw new Error('cloudflare graphql: account not visible to token');

  const storage: R2StoragePoint[] = (acct.storage ?? []).map((g) => ({
    bucketName: g.dimensions?.bucketName,
    datetime: g.dimensions?.datetime ?? '',
    payloadSize: g.max?.payloadSize ?? 0,
    metadataSize: g.max?.metadataSize ?? 0,
    objectCount: g.max?.objectCount ?? 0,
  }));
  const ops: R2OpsCount[] = (acct.ops ?? []).map((g) => ({
    actionType: g.dimensions?.actionType ?? 'Unknown',
    requests: g.sum?.requests ?? 0,
  }));
  return { storage, ops };
}

export interface R2UsageRunResult {
  sent: boolean;
  reason?: string;
  summary?: R2UsageSummary;
}

type R2UsageSecretKeys =
  | 'CLOUDFLARE_ACCOUNT_ID'
  | 'CLOUDFLARE_R2_ANALYTICS_TOKEN'
  | 'PUSHOVER_APP_TOKEN'
  | 'PUSHOVER_CT_API_TOKEN'
  | 'PUSHOVER_USER_KEY';

const R2_USAGE_SECRET_KEYS: R2UsageSecretKeys[] = [
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_R2_ANALYTICS_TOKEN',
  'PUSHOVER_APP_TOKEN',
  'PUSHOVER_CT_API_TOKEN',
  'PUSHOVER_USER_KEY',
];

/**
 * Daily cron lane: compute the summary and push it. No-ops (with a reason)
 * when the Cloudflare analytics token/account or Pushover credentials are not
 * configured. Never throws.
 *
 * `prefetched` lets the caller (maybeRunDailyJobs) pass secrets from its one
 * per-run resolveSecrets round trip; when omitted they are resolved here so
 * the function stays self-contained for ad-hoc/admin invocation.
 */
export async function runR2UsageSummary(
  env: Env,
  now = new Date(),
  prefetched?: Partial<Record<R2UsageSecretKeys, string | undefined>>,
): Promise<R2UsageRunResult> {
  try {
    const secrets = prefetched ?? (await resolveSecrets(env, R2_USAGE_SECRET_KEYS));
    const accountId = secrets.CLOUDFLARE_ACCOUNT_ID?.trim();
    const token = secrets.CLOUDFLARE_R2_ANALYTICS_TOKEN?.trim();
    if (!accountId || !token) {
      return { sent: false, reason: 'CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_R2_ANALYTICS_TOKEN not configured' };
    }

    const { storage, ops } = await fetchR2Usage(accountId, token, now);
    const summary = buildSummary(storage, ops, now);
    const message = formatUsageMessage(summary, now);
    const dateLabel = now.toISOString().slice(0, 10);
    // Subject free tier is Congress.Trade → CT Pushover app token (logo).
    const appToken = resolveCongressPushoverAppToken(secrets);

    const delivered = await sendPushover(env, {
      title: `Congress.Trade R2 usage — ${dateLabel}`,
      message,
    }, {
      appToken,
      userKey: secrets.PUSHOVER_USER_KEY,
    });
    if (!delivered.sent) return { sent: false, reason: delivered.reason, summary };
    console.log('r2 usage summary pushed:', dateLabel);
    return { sent: true, summary };
  } catch (err) {
    console.warn('r2 usage summary failed:', (err as Error).message);
    return { sent: false, reason: (err as Error).message };
  }
}
