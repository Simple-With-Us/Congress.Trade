/**
 * src/ingestion/reviewQueueNotify.ts
 *
 * Wake Grok Bot Publisher (GB) and BotFleet Publisher (BF) when a doc enters
 * human review or when a pipeline stall / recovery event fires.  Fail-closed:
 * REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL and REVIEW_QUEUE_PUBLISHER_WEBHOOK_SECRET
 * must be configured; optional REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL_GB fans the
 * same signed payload to GB with optional REVIEW_QUEUE_PUBLISHER_WEBHOOK_AUTH_GB
 * on GB targets only.  Targets are SSRF-checked before every POST.
 *
 * FAIL-SOFT BY CONTRACT: callers invoke this after the review transition has
 * committed.  A missing config, DNS failure, or HTTP error is logged and
 * swallowed — never surfaced to the extraction/admin path.
 */

import type { Env } from '../shared/types.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { validatePublicWebhookTarget } from '../delivery/webhookTarget.ts';
import { signWebhookPayloadV1 } from '../delivery/webhook.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

const PUBLISHER_WEBHOOK_TIMEOUT_MS = 12_000;

/** Sentinel doc id for pipeline-wide stall webhooks (no review_queue row). */
export const PIPELINE_STALL_SENTINEL_DOC_ID = '__pipeline_stall__';

export type PublisherWebhookEvent =
  | 'review_queue.entered'
  | 'pipeline.stalled'
  | 'pipeline.stall_recovered';

export interface ReviewQueueNotifyInput {
  /** Required for review_queue.entered; null or omitted for pipeline stall events. */
  docId?: string | null;
  reason?: string | null;
  /** ISO timestamp for the transition; defaults to now. */
  at?: string;
  /** Distinguish a fresh insert from a reopen (resolved → pending). */
  kind?: 'insert' | 'reopen';
  event?: PublisherWebhookEvent;
  /** Pipeline id for stall / recovery events (e.g. house_fetch_success). */
  pipeline?: string | null;
}

interface PublisherWebhookTarget {
  url: string;
  /** Full `Authorization` header value (includes `Bearer ` prefix); GB targets only. */
  authorization?: string;
}

interface ReviewQueuePublisherConfig {
  targets: PublisherWebhookTarget[];
  secret: string;
}

function splitWebhookUrls(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[\n,;]+/)
    .map((u) => u.trim())
    .filter(Boolean);
}

async function loadPublisherConfig(env: Env): Promise<ReviewQueuePublisherConfig | null> {
  const [urlRes, gbUrlRes, secretRes, gbAuthRes] = await Promise.all([
    resolveSecret(env, 'REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL'),
    resolveSecret(env, 'REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL_GB'),
    resolveSecret(env, 'REVIEW_QUEUE_PUBLISHER_WEBHOOK_SECRET'),
    resolveSecret(env, 'REVIEW_QUEUE_PUBLISHER_WEBHOOK_AUTH_GB'),
  ]);
  const secret = secretRes.value?.trim();
  if (!secret) return null;

  const bfUrls = new Set<string>();
  for (const u of splitWebhookUrls(urlRes.value)) bfUrls.add(u);

  const gbUrls = new Set<string>();
  for (const u of splitWebhookUrls(gbUrlRes.value)) gbUrls.add(u);
  for (const u of splitWebhookUrls(env.REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL_GB)) gbUrls.add(u);

  const gbAuth = gbAuthRes.value?.trim() || env.REVIEW_QUEUE_PUBLISHER_WEBHOOK_AUTH_GB?.trim() || undefined;

  const allUrls = new Set<string>([...bfUrls, ...gbUrls]);
  if (allUrls.size === 0) return null;

  const targets: PublisherWebhookTarget[] = [...allUrls].map((url) => {
    const authorization = gbAuth && gbUrls.has(url) && !bfUrls.has(url) ? gbAuth : undefined;
    return { url, authorization };
  });
  return { targets, secret };
}

/**
 * Publisher targets are BotFleet capability URLs (`https://HOST/hooks/ID/SECRET`), so the
 * URL itself is a credential.  Never log it raw: keep the host and `/hooks/ID/***` only,
 * and drop userinfo, query and fragment.
 */
export function redactWebhookUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const hooks = /^\/hooks\/([^/]+)\/.+/.exec(u.pathname);
    const path = hooks ? `/hooks/${hooks[1]}/***` : u.pathname.length > 1 ? '/***' : '';
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return '[invalid-webhook-url]';
  }
}

/** Redact the target URL (and its secret path segment) from an error message before logging. */
export function redactWebhookError(message: string, rawUrl: string): string {
  const redacted = redactWebhookUrl(rawUrl);
  // needle -> replacement.  Whole-URL forms become the redacted URL; bare fragments become `***`.
  const replacements = new Map<string, string>([[rawUrl, redacted]]);
  try {
    const u = new URL(rawUrl);
    replacements.set(u.href, redacted);
    if (u.pathname.length > 1) replacements.set(u.pathname + u.search, '***');
    for (const seg of u.pathname.split('/')) {
      if (seg.length >= 8) replacements.set(seg, '***');
    }
    if (u.search.length > 1) replacements.set(u.search.slice(1), '***');
    if (u.password) replacements.set(u.password, '***');
  } catch {
    // unparseable: only the raw string is known
  }
  const needles = [...replacements.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  if (needles.length === 0) return message;
  // One pass over the original text, so a replacement is never re-scanned by a later needle.
  const pattern = new RegExp(
    needles.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'g',
  );
  return message.replace(pattern, (m) => replacements.get(m) ?? '***');
}

async function postSignedPublisherWebhook(
  env: Env,
  cfg: ReviewQueuePublisherConfig,
  body: string,
  signedAtSec: number,
  deps: { fetchImpl?: typeof fetch },
  logLabel: string,
): Promise<void> {
  const signature = await signWebhookPayloadV1(env, signedAtSec, body, cfg.secret);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const allowLocalhost = env.USAGE_MONITOR_ENVIRONMENT?.toLowerCase() === 'local'
    || env.ADMIN_OPEN_IN_DEV === 'true';

  for (const target of cfg.targets) {
    const { url } = target;
    const targetError = await validatePublicWebhookTarget(url, {
      allowLocalhost,
      fetchImpl: deps.fetchImpl,
    });
    if (targetError) {
      console.warn(
        `review_queue notify: blocked target (${logLabel} → ${redactWebhookUrl(url)}) —`,
        redactWebhookError(targetError, url),
      );
      continue;
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-ct-signature': `t=${signedAtSec},v1=${signature}`,
    };
    if (target.authorization) {
      headers.authorization = target.authorization;
    }
    try {
      const reqAbort = new AbortController();
      const timeoutId = setTimeout(
        () => reqAbort.abort(new Error(`publisher webhook timeout after ${PUBLISHER_WEBHOOK_TIMEOUT_MS}ms`)),
        PUBLISHER_WEBHOOK_TIMEOUT_MS,
      );
      let response: Response;
      try {
        response = await trackedFetch(
          url,
          {
            method: 'POST',
            headers,
            body,
            signal: reqAbort.signal,
          },
          { service: 'review-queue-notify', operation: 'publisher-webhook' },
          fetchImpl,
        );
      } finally {
        clearTimeout(timeoutId);
      }
      if (!response.ok) {
        console.warn(
          `review_queue notify: publisher returned HTTP ${response.status} for ${logLabel} → ${redactWebhookUrl(url)}`,
        );
      }
    } catch (err) {
      console.warn(
        `review_queue notify failed (${logLabel} → ${redactWebhookUrl(url)}):`,
        redactWebhookError((err as Error).message, url),
      );
    }
  }
}

/**
 * POST a small signed webhook so Publisher / BF-Publisher (and optional GB) wake immediately.
 * No-op when URL/secret are unset or every target fails SSRF validation.
 */
export async function notifyReviewQueuePublisher(
  env: Env,
  input: ReviewQueueNotifyInput,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const event: PublisherWebhookEvent = input.event ?? 'review_queue.entered';
  const docIdRaw = input.docId?.trim();
  const docId = docIdRaw || null;

  if (event === 'review_queue.entered' && !docId) return;

  try {
    const cfg = await loadPublisherConfig(env);
    if (!cfg) return;

    const at = input.at ?? new Date().toISOString();
    const pipeline = input.pipeline?.trim() || null;
    const body = JSON.stringify({
      event,
      docId,
      pipeline,
      reason: input.reason ?? null,
      kind: input.kind ?? 'insert',
      at,
    });
    const signedAtSec = Math.floor(Date.parse(at) / 1000) || Math.floor(Date.now() / 1000);
    const logLabel = docId ?? pipeline ?? event;
    await postSignedPublisherWebhook(env, cfg, body, signedAtSec, deps, logLabel);
  } catch (err) {
    console.warn('review_queue notify failed:', (err as Error).message);
  }
}

/** Pipeline stall / recovery: both publishers, null docId, distinct event type. */
export async function notifyPipelineStallPublisher(
  env: Env,
  input: {
    pipeline: string;
    detail: string;
    recovered?: boolean;
    at?: string;
    wakeDocId?: string | null;
  },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const pipeline = input.pipeline?.trim();
  if (!pipeline) return;
  const event: PublisherWebhookEvent = input.recovered
    ? 'pipeline.stall_recovered'
    : 'pipeline.stalled';
  const wakeDocId = input.wakeDocId?.trim();
  const docId = wakeDocId || null;
  const reason = input.recovered
    ? `pipeline_stall_recovered:${pipeline}: ${input.detail}`.slice(0, 500)
    : `pipeline_stalled:${pipeline}: ${input.detail}`.slice(0, 500);

  await notifyReviewQueuePublisher(
    env,
    {
      event,
      docId,
      pipeline,
      reason,
      kind: 'insert',
      at: input.at,
    },
    deps,
  );
}
