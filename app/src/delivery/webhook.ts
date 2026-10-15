/**
 * src/delivery/webhook.ts
 * OWNER: delivery agent
 *
 * Handles {type:'delivery.dispatch'} for webhook subscriptions: loads matching
 * subscriptions, builds the payload, signs it with WEBHOOK_SIGNING_KEY (and/or
 * the per-subscription secret), POSTs to target_url, and records the attempt in
 * deliveries with retry/backoff semantics.
 *
 * RETRY STRATEGY:
 *   One native Cloudflare Queue retry layer. Durable deliveries rows count only
 *   claimed HTTP attempts; busy lease retries do not consume that budget.
 *
 * IDEMPOTENCY:
 *   deliveries is keyed (subscription_id, tx_id). We CAS-claim a leased sending
 *   row before POSTing, so retries / duplicate
 *   queue messages do not concurrently double-deliver. Recipients should still
 *   dedupe on X-Subscription-Id + X-Tx-Id because no HTTP webhook sender can be
 *   exactly-once if it crashes after POST but before recording success.
 */

import { createCongressEvent } from '@jaywedgeworth22/congress-trading-shared';
import type { Env, Subscription, Transaction } from '../shared/types.ts';
import type { DurableQueueLeaseContext } from '../deno/durableQueue.ts';
import { all, get, run } from '../shared/db.ts';
import { prefixedId } from '../shared/ids.ts';
import { mapSubscription, mapTransaction, type SubscriptionRow, type TransactionRow } from './rows.ts';
import { matchesFiltersWithContext, subscriptionOwnerEntitled, webhookTargetLengthError } from './subscriptions.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { localWebhookTargetsAllowed, validatePublicWebhookTarget } from './webhookTarget.ts';
import { notifyAdmin } from '../alerts/notify.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import { sentryLoggerWarn } from '../shared/sentryRuntime.ts';
import {
  checkTargetCircuit,
  parkDelivery,
  recordTargetFailure,
  recordTargetSuccess,
  targetKeyForUrl,
} from './targetCircuit.ts';
import { webhookSubscriberConsumptionError } from './pushReceipt.ts';

/** Max delivery attempts before we give up (initial try + retries). */
const MAX_ATTEMPTS = 5;
const CLAIM_LEASE_MS = 60_000;
/** Base backoff in seconds; doubled per attempt, then jittered. */
const BASE_BACKOFF_SEC = 5;
/** Cap a single backoff delay (Cloudflare Queues allow up to 12h; keep modest). */
const MAX_BACKOFF_SEC = 900;
/** Stop waiting on a slow receiver before this Worker invocation is pinned. */
export const WEBHOOK_FETCH_TIMEOUT_MS = 10_000;
export const WEBHOOK_SUBSCRIPTION_PAGE_SIZE = 100;
// Workers permits six simultaneous outbound connections. Leave one slot for
// D1/DoH/other work so queued fetches do not burn their 10s timeout budget.
export const WEBHOOK_FANOUT_CONCURRENCY = 5;

/**
 * Wire shape of the delivery message. Extends the frozen union additively with
 * optional retry-routing fields.
 */
interface DispatchMessage {
  type: 'delivery.dispatch';
  txId: string;
  /** Legacy targeted messages remain accepted; new retries use the native queue. */
  subscriptionId?: string;
  /** Keyset cursor for bounded fanout continuation messages. */
  afterSubscriptionId?: string;
}

/** Signals index.queue to use one delayed native Queue retry layer. */
export class DeliveryRetryError extends Error {
  constructor(message: string, readonly delaySeconds: number) {
    super(message);
  }
}

export interface DispatchWebhookResult {
  /** True only after the final non-targeted keyset page has completed. */
  outboxComplete: boolean;
}

export interface WebhookSubscriptionPageResult {
  failures: unknown[];
  lastScannedId: string | null;
  hasMore: boolean;
  visited: number;
}

/** Visit one bounded active-webhook page; continuations handle later pages. */
export async function visitActiveWebhookSubscriptionPage(
  env: Env,
  afterId: string,
  visit: (sub: Subscription) => Promise<void>,
): Promise<WebhookSubscriptionPageResult> {
  const failures: unknown[] = [];
  const rows = await all<SubscriptionRow>(
    env.DB,
    `SELECT id, client_id, delivery, target_url, secret, filters, cursor, active, created_at
       FROM subscriptions
      WHERE active = 1 AND delivery = 'webhook' AND id > ?
      ORDER BY id ASC
      LIMIT ?`,
    [afterId, WEBHOOK_SUBSCRIPTION_PAGE_SIZE + 1],
  );
  const page = rows.slice(0, WEBHOOK_SUBSCRIPTION_PAGE_SIZE);
  for (let i = 0; i < page.length; i += WEBHOOK_FANOUT_CONCURRENCY) {
    const settled = await Promise.allSettled(
      page.slice(i, i + WEBHOOK_FANOUT_CONCURRENCY).map((row) => visit(mapSubscription(row))),
    );
    for (const result of settled) if (result.status === 'rejected') failures.push(result.reason);
  }
  return {
    failures,
    lastScannedId: page.length > 0 ? page[page.length - 1].id : null,
    hasMore: rows.length > WEBHOOK_SUBSCRIPTION_PAGE_SIZE,
    visited: page.length,
  };
}

/**
 * Compute the HMAC-SHA256 signature (lowercase hex) for an outbound webhook
 * body, keyed by the per-subscription secret if given, else the worker-wide
 * WEBHOOK_SIGNING_KEY. Uses WebCrypto (Workers-compatible).
 */
export async function signWebhookPayload(env: Env, body: string, secret?: string): Promise<string> {
  const keyMaterial = secret ?? (await resolveSecret(env, 'WEBHOOK_SIGNING_KEY')).value ?? '';
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(keyMaterial),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(body));
  return toHex(new Uint8Array(sigBuf));
}

/**
 * Signature scheme v1: HMAC-SHA256 over `${timestampSec}.${body}`.
 *
 * The legacy `X-Signature: sha256=<hmac(body)>` covers the body ALONE, so a
 * captured request stays valid forever — a recipient cannot distinguish a
 * replay from a fresh delivery, and cannot bound how long a leaked request is
 * dangerous. Binding a timestamp into the signed material lets the recipient
 * reject anything outside an acceptance window, and the `v1=` label lets the
 * scheme be rotated without breaking existing verifiers.
 *
 * Emitted as `X-CT-Signature: t=<unix-seconds>,v1=<hex>` (the widely-used
 * Stripe-style layout). The legacy header is still sent — see WEBHOOK_HEADERS
 * at the call site — so existing consumers keep working during migration.
 */
export async function signWebhookPayloadV1(
  env: Env,
  timestampSec: number,
  body: string,
  secret?: string,
): Promise<string> {
  return signWebhookPayload(env, `${timestampSec}.${body}`, secret);
}

/** Default acceptance window recipients should enforce, in seconds. */
export const WEBHOOK_SIGNATURE_TOLERANCE_SEC = 300;

/**
 * Reference verifier — the exact check a recipient should perform. Exported so
 * the contract is executable and testable rather than only described in prose.
 */
export async function verifyWebhookSignatureV1(
  env: Env,
  header: string,
  body: string,
  secret: string | undefined,
  nowSec: number,
  toleranceSec = WEBHOOK_SIGNATURE_TOLERANCE_SEC,
): Promise<boolean> {
  const parts = new Map<string, string>();
  for (const piece of header.split(',')) {
    const idx = piece.indexOf('=');
    if (idx > 0) parts.set(piece.slice(0, idx).trim(), piece.slice(idx + 1).trim());
  }
  const t = Number(parts.get('t'));
  const v1 = parts.get('v1');
  if (!v1 || !Number.isFinite(t)) return false;
  // Reject stale AND far-future timestamps; a clock-skewed future value would
  // otherwise extend a captured request's usable life.
  if (Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = await signWebhookPayloadV1(env, t, body, secret);
  return timingSafeEqualHex(expected, v1);
}

/** Constant-time hex compare, so verification cannot be probed byte by byte. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Exponential backoff with full jitter, capped. attempt is 1-based. */
function backoffSeconds(attempt: number): number {
  const expo = BASE_BACKOFF_SEC * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(expo, MAX_BACKOFF_SEC);
  // Full jitter: random in [0, capped]. Keep a small floor so we always wait.
  return Math.max(1, Math.floor(Math.random() * capped));
}

/**
 * Dispatch a persisted transaction to all matching active webhook subscriptions.
 * Legacy targeted messages with subscriptionId remain supported; current
 * native retries preserve the original fan-out body and delivered claims skip.
 */
export async function dispatchWebhook(
  env: Env,
  txIdOrMsg: string | DispatchMessage,
  lease?: DurableQueueLeaseContext,
): Promise<DispatchWebhookResult> {
  await lease?.assertOwned();
  const msg: DispatchMessage =
    typeof txIdOrMsg === 'string' ? { type: 'delivery.dispatch', txId: txIdOrMsg } : txIdOrMsg;

  const txRow = await get<TransactionRow>(
    env.DB,
    'SELECT * FROM transactions WHERE id = ?',
    [msg.txId],
  );
  if (!txRow) {
    // Debug, not warn: this miss path is expected for stale outbox rows and
    // was ~2.3k Datadog warn events/hour.  Real dispatch failures still warn.
    console.debug('dispatchWebhook: transaction not found', msg.txId);
    return { outboxComplete: !msg.subscriptionId };
  }
  // Don't push a retracted (un-published) row, e.g. on a retry after unpublish.
  if ((txRow as { deprecated_at?: string | null }).deprecated_at) {
    return { outboxComplete: !msg.subscriptionId };
  }
  const tx = mapTransaction(txRow);

  // Resolve chamber via the owning filing (Transaction carries no chamber col).
  const chamberRow = await get<{ chamber: string | null }>(
    env.DB,
    'SELECT chamber FROM filings WHERE doc_id = ?',
    [tx.docId],
  );
  const chamber = chamberRow?.chamber ?? null;

  // Resolve sector + market-cap bucket for sector/cap subscription filters.
  const refRow = tx.ticker
    ? await get<{ sector: string | null; market_cap_bucket: string | null }>(
        env.DB,
        'SELECT sector, market_cap_bucket FROM securities_ref WHERE ticker = ?',
        [tx.ticker],
      )
    : null;
  const ctx = {
    chamber,
    sector: refRow?.sector ?? null,
    marketCapBucket: refRow?.market_cap_bucket ?? null,
  };

  // Broadcast the transaction to any live SSE streams exactly once (on the
  // initial fanout message, not on paginated continuations or targeted retries).
  if (!msg.subscriptionId && !msg.afterSubscriptionId && typeof BroadcastChannel !== 'undefined') {
    try {
      const channel = new (BroadcastChannel as any)('congress.trade.live');
      channel.postMessage({
        type: 'NEW_TRANSACTION',
        transaction: tx,
        context: ctx,
      });
      channel.close();
    } catch (err) {
      console.warn('dispatchWebhook: broadcast failed', (err as Error).message);
    }
  }

  const visit = async (sub: Subscription): Promise<void> => {
    if (!sub.targetUrl) return;
    if (!matchesFiltersWithContext(tx, sub.filters, ctx)) return;
    await deliverToSubscription(env, sub, tx, lease);
  };

  // Legacy targeted messages remain bounded to one subscription. Normal fanout
  // keyset-pages every active webhook and never loads/HMACs the whole set.
  let failures: unknown[];
  let page: WebhookSubscriptionPageResult | null = null;
  if (msg.subscriptionId) {
    const subRow = await get<SubscriptionRow>(
      env.DB,
      `SELECT id, client_id, delivery, target_url, secret, filters, cursor, active, created_at
         FROM subscriptions
        WHERE id = ? AND active = 1 AND delivery = 'webhook'`,
      [msg.subscriptionId],
    );
    failures = [];
    if (subRow) {
      try {
        await visit(mapSubscription(subRow));
      } catch (err) {
        failures.push(err);
      }
    }
  } else {
    page = await visitActiveWebhookSubscriptionPage(env, msg.afterSubscriptionId ?? '', visit);
    failures = page.failures;
  }
  if (failures.length > 0) {
    const retryFailures = failures.map((failure) =>
      failure instanceof DeliveryRetryError
        ? failure
        : new DeliveryRetryError((failure as Error)?.message ?? 'webhook delivery failed', BASE_BACKOFF_SEC),
    );
    throw new DeliveryRetryError(
      `${retryFailures.length} webhook delivery target(s) require retry`,
      Math.max(...retryFailures.map((failure) => failure.delaySeconds)),
    );
  }

  // Only advance after the entire page completed. A failed target or failed
  // continuation enqueue retries this same keyset page; durable delivered
  // claims make those replays safe, while the tail can never be skipped.
  if (page?.hasMore && page.lastScannedId) {
    try {
      await lease?.assertOwned();
      await env.DELIVERY_QUEUE.send({
        type: 'delivery.dispatch',
        txId: msg.txId,
        afterSubscriptionId: page.lastScannedId,
      });
    } catch (err) {
      throw new DeliveryRetryError(
        `failed to enqueue webhook fanout continuation: ${(err as Error).message}`,
        BASE_BACKOFF_SEC,
      );
    }
  }
  return {
    outboxComplete: !msg.subscriptionId && !(page?.hasMore ?? false),
  };
}

/**
 * Deliver one transaction to one subscription, recording the attempt and
 * scheduling a backoff retry on failure (up to MAX_ATTEMPTS).
 */
async function deliverToSubscription(
  env: Env,
  sub: Subscription,
  tx: Transaction,
  lease?: DurableQueueLeaseContext,
): Promise<void> {
  await lease?.assertOwned();
  // A queued fanout can outlive a subscriber opt-out. Re-check immediately
  // before claiming/sending so a message selected moments earlier cannot POST
  // after the durable subscription has been disabled or changed to SSE.
  const stillActive = await get<{ id: string }>(
    env.DB,
    `SELECT id FROM subscriptions
      WHERE id = ? AND active = 1 AND delivery = 'webhook'`,
    [sub.id],
  );
  if (!stillActive) return;

  // Entitlement re-check at delivery time (panel HIGH: trial-and-cancel kept
  // premium webhooks flowing forever). A lapsed owner's delivery is skipped —
  // durably marked, never retried — without consuming a delivery attempt. If
  // the owner renews, later transactions flow again (and a re-dispatch of
  // this one can still claim the 'skipped' row).
  if (!(await subscriptionOwnerEntitled(env, sub.clientId))) {
    await markDeliverySkipped(env, sub.id, tx.id);
    return;
  }

  // GOVERNOR 3: per-target circuit breaker. A target that keeps failing (peer
  // outage, dead endpoint, auth rot) opens its circuit; while open — or past
  // its daily failed-attempt cap — this delivery PARKS durably and returns
  // WITHOUT throwing, so the queue never retry-storms the target. Parked rows
  // are re-dispatched by the scheduled flushParkedDeliveries once the circuit
  // probe succeeds. No delivery attempt is consumed by parking.
  const targetKey = targetKeyForUrl(sub.targetUrl);
  if (targetKey) {
    const gate = await checkTargetCircuit(env, targetKey);
    if (!gate.allowed) {
      await parkDelivery(env, sub.id, tx.id, (gate as any).reason);
      return;
    }
  }

  const claim = await claimDelivery(env, sub.id, tx.id);
  if (claim.outcome === 'delivered') return;
  if (claim.outcome === 'busy') {
    throw new DeliveryRetryError(`delivery claim busy for sub=${sub.id} tx=${tx.id}`, claim.delaySeconds);
  }
  const attempt = claim.attempt;

  const deliveredAt = new Date().toISOString();
  // Superset payload: the canonical cross-app contract fields from
  // createCongressEvent (peers key delivery on `type === 'congress.trade'` +
  // `data.trades` + `id` for idempotency) plus the legacy `event`/`transaction`
  // fields, so existing external subscribers keep working while contract-aware
  // consumers (Socratic Trade) ingest it directly.
  const payload = {
    ...createCongressEvent('congress.trade', { trades: [tx] }, { id: `ct-tx-${tx.id}` }),
    event: 'trade.new' as const,
    transaction: tx,
    deliveredAt,
  };
  const body = JSON.stringify(payload);
  try {
    const targetLengthError = webhookTargetLengthError(sub.targetUrl);
    if (targetLengthError) throw new Error(`unsafe webhook target URL: ${targetLengthError}`);
    const targetUrlError = await validatePublicWebhookTarget(sub.targetUrl, {
      allowLocalhost: localWebhookTargetsAllowed(env),
    });
    if (targetUrlError) throw new Error(`unsafe webhook target URL: ${targetUrlError}`);
    const signature = await signWebhookPayload(env, body, sub.secret ?? undefined);
    const signedAtSec = Math.floor(Date.now() / 1000);
    const signatureV1 = await signWebhookPayloadV1(env, signedAtSec, body, sub.secret ?? undefined);
    let timedOut = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, WEBHOOK_FETCH_TIMEOUT_MS);
    let res: Response | undefined;
    try {
      await lease?.assertOwned();
      res = await trackedFetch(sub.targetUrl as string, {
        method: 'POST',
        redirect: 'manual',
        signal: lease
          ? AbortSignal.any([controller.signal, lease.signal])
          : controller.signal,
        headers: {
          'Content-Type': 'application/json',
          // Legacy: HMAC over the body alone, so it never expires. Retained
          // for existing consumers during migration — prefer X-CT-Signature.
          'X-Signature': `sha256=${signature}`,
          // v1: HMAC over `${t}.${body}`. Verify this one and reject anything
          // outside your acceptance window (we suggest
          // WEBHOOK_SIGNATURE_TOLERANCE_SEC) so a captured request expires.
          'X-CT-Signature': `t=${signedAtSec},v1=${signatureV1}`,
          'X-CT-Event': 'transaction.created',
          'X-Tx-Id': tx.id,
          'X-Subscription-Id': sub.id,
          'X-Delivery-Attempt': String(attempt),
        },
        body,
      }, {
        service: 'webhook-delivery',
        operation: 'deliver-subscriber-event',
        dynamicTarget: 'subscriber-webhook',
      });
    } catch (err) {
      if (lease?.signal.aborted) {
        throw lease.signal.reason ?? new Error('durable queue lease lost');
      }
      throw new Error(timedOut ? `timeout after ${WEBHOOK_FETCH_TIMEOUT_MS}ms` : ((err as Error).message ?? 'fetch failed'));
    } finally {
      clearTimeout(timeout);
    }
    if (!res?.ok) throw new Error(`HTTP ${res?.status ?? 'unknown'}`);
    const consumptionError = await webhookSubscriberConsumptionError(res);
    if (consumptionError) {
      throw new Error(consumptionError);
    }
    await lease?.assertOwned();
    await recordDelivery(env, claim.id, claim.token, true, attempt, null);
    // 2xx auto-closes the target circuit (probe success releases the parked backlog).
    if (targetKey) await recordTargetSuccess(env, targetKey);
  } catch (err) {
    if (lease?.signal.aborted) {
      throw lease.signal.reason ?? new Error('durable queue lease lost');
    }
    const lastError = err instanceof Error ? err.message : String(err);
    // Count the failed attempt against the target's circuit + daily cap.
    if (targetKey) await recordTargetFailure(env, targetKey, lastError);
    try {
      await recordDelivery(env, claim.id, claim.token, false, attempt, lastError);
    } catch (recordErr) {
      throw new DeliveryRetryError(
        `failed to persist webhook attempt: ${(recordErr as Error).message}`,
        Math.ceil(CLAIM_LEASE_MS / 1000),
      );
    }
    if (attempt < MAX_ATTEMPTS) throw new DeliveryRetryError(lastError, backoffSeconds(attempt));
    sentryLoggerWarn('webhook-retry', {
      reason: 'terminal',
      attempts: attempt,
    });
    // This is an application-level terminal attempt. Return successfully so
    // Cloudflare does not retry the same attempt another max_retries times.
    // The failed deliveries row is the durable terminal record.
    await alertTerminalDelivery(env, sub.id, tx.id, attempt, lastError);
    return;
  }

  // Advance the subscription cursor after the durable delivered marker. A
  // cursor write failure must not cause a duplicate POST.
  await run(
    env.DB,
    'UPDATE subscriptions SET cursor = ? WHERE id = ? AND cursor < ?',
    [tx.cursorSeq, sub.id, tx.cursorSeq],
  ).catch((err) => console.warn('dispatchWebhook: cursor update failed', (err as Error).message));
}

type DeliveryClaim =
  | { outcome: 'claimed'; id: string; token: string; attempt: number }
  | { outcome: 'busy'; delaySeconds: number }
  | { outcome: 'delivered' };

/**
 * Durably record that a delivery was skipped because the subscription owner's
 * entitlement lapsed. Insert-only: if a deliveries row already exists (e.g. a
 * mid-retry lapse), it is left untouched — the entitlement gate above simply
 * stops further POSTs without consuming attempts.
 */
async function markDeliverySkipped(env: Env, subscriptionId: string, txId: string): Promise<void> {
  await run(
    env.DB,
    `INSERT INTO deliveries (id, subscription_id, tx_id, status, attempts, last_error, updated_at)
     VALUES (?, ?, ?, 'skipped', 0, 'subscription owner entitlement inactive', ?)
     ON CONFLICT (subscription_id, tx_id) DO NOTHING`,
    [prefixedId('dlv'), subscriptionId, txId, new Date().toISOString()],
  ).catch((err) =>
    console.warn('markDeliverySkipped failed', (err as Error).message),
  );
}

async function alertTerminalDelivery(
  env: Env,
  subscriptionId: string,
  txId: string,
  attempt: number,
  error: string,
): Promise<void> {
  await notifyAdmin(env, {
    subject: 'Webhook delivery exhausted retries',
    text: `subscription: ${subscriptionId}\ntransaction: ${txId}\nattempts: ${attempt}\nerror: ${error}`,
    dedupeKey: `webhook-terminal:${subscriptionId}`,
    throttleSec: 3600,
  }).catch(() => {});
}

/**
 * Claim the single deliveries row for this subscription/transaction before
 * sending the webhook. Busy claims carry a retry delay; stale leases are
 * reclaimable and completed/terminal rows return delivered.
 */
async function claimDelivery(
  env: Env,
  subscriptionId: string,
  txId: string,
): Promise<DeliveryClaim> {
  const existing = await get<{ status: string; attempts: number; id: string; updated_at: string | null; lease_until: string | null; claim_token: string | null }>(
    env.DB,
    'SELECT id, status, attempts, updated_at, lease_until, claim_token FROM deliveries WHERE subscription_id = ? AND tx_id = ?',
    [subscriptionId, txId],
  );
  if (existing?.status === 'delivered' || (existing?.status === 'failed' && existing.attempts >= MAX_ATTEMPTS)) {
    return { outcome: 'delivered' };
  }

  const now = new Date();
  const updatedAt = now.toISOString();
  const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString();
  const token = crypto.randomUUID();
  if (existing) {
    if (existing.status === 'sending' && existing.lease_until && existing.lease_until > updatedAt) {
      return {
        outcome: 'busy',
        delaySeconds: Math.max(1, Math.ceil((Date.parse(existing.lease_until) - now.getTime()) / 1000)),
      };
    }
    if (existing.status === 'sending' && existing.attempts >= MAX_ATTEMPTS) {
      // The previous Worker may have crashed before the POST or after a POST
      // whose result was not persisted. Reclaim and replay the same numbered
      // attempt; never silently terminalize it and never create attempt six.
      // Recipients already dedupe by subscription + transaction headers.
      const reclaimed = await run(
        env.DB,
        `UPDATE deliveries
            SET claim_token = ?, lease_until = ?, last_error = NULL, updated_at = ?
          WHERE id = ? AND status = 'sending' AND attempts >= ?
            AND (lease_until IS NULL OR lease_until <= ?) AND claim_token IS ?`,
        [token, leaseUntil, updatedAt, existing.id, MAX_ATTEMPTS, updatedAt, existing.claim_token],
      );
      if ((reclaimed.meta?.changes ?? 1) > 0) {
        return { outcome: 'claimed', id: existing.id, token, attempt: MAX_ATTEMPTS };
      }
      // Another worker changed the claim after our read. Retry later instead of
      // recursively re-reading an unchanged terminal lease.
      return { outcome: 'busy', delaySeconds: 1 };
    }
    const res = await run(
      env.DB,
      `UPDATE deliveries
          SET status = 'sending', attempts = attempts + 1, claim_token = ?,
              lease_until = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND status = ? AND attempts = ? AND updated_at IS ?
          AND status != 'delivered' AND attempts < ?
          AND (status != 'sending' OR lease_until IS NULL OR lease_until <= ?)`,
      [token, leaseUntil, updatedAt, existing.id, existing.status, existing.attempts, existing.updated_at, MAX_ATTEMPTS, updatedAt],
    );
    if ((res.meta?.changes ?? 1) === 0) return { outcome: 'busy', delaySeconds: 1 };
    return { outcome: 'claimed', id: existing.id, token, attempt: existing.attempts + 1 };
  }

  const id = prefixedId('dlv');
  try {
    await run(
      env.DB,
      `INSERT INTO deliveries (
         id, subscription_id, tx_id, status, attempts, last_error, updated_at, claim_token, lease_until
       ) VALUES (?, ?, ?, 'sending', 1, NULL, ?, ?, ?)`,
      [id, subscriptionId, txId, updatedAt, token, leaseUntil],
    );
    return { outcome: 'claimed', id, token, attempt: 1 };
  } catch (err) {
    if (!/unique|constraint/i.test((err as Error).message)) throw err;
    return claimDelivery(env, subscriptionId, txId);
  }
}

/** Update the claimed deliveries row with the final result for this attempt. */
async function recordDelivery(
  env: Env,
  deliveryId: string,
  claimToken: string,
  ok: boolean,
  attempt: number,
  lastError: string | null,
): Promise<void> {
  const status = ok ? 'delivered' : 'failed';
  const updatedAt = new Date().toISOString();
  const result = await run(
    env.DB,
    `UPDATE deliveries
        SET status = ?, attempts = ?, last_error = ?, updated_at = ?,
            claim_token = NULL, lease_until = NULL
      WHERE id = ? AND status = 'sending' AND claim_token = ?`,
    [status, attempt, ok ? null : lastError, updatedAt, deliveryId, claimToken],
  );
  if ((result.meta?.changes ?? 1) === 0) throw new Error('delivery claim was lost before result persistence');
}
