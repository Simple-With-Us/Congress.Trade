import type { Env, QueueMessage } from './shared/types.ts';
import type { DurableQueueLeaseContext } from './deno/durableQueue.ts';
import { get, run } from './shared/db.ts';
import { fetchFiling } from './ingestion/fetcher.ts';
import { classifyFiling } from './ingestion/classifier.ts';
import { extractAndNormalize } from './extraction/orchestrator.ts';
import { dispatchWebhook } from './delivery/webhook.ts';
import { recordDeadLetterDurable } from './delivery/deadLetter.ts';
import { handleAgreementCheck } from './extraction/agreement.ts';
import { handleAutopilotTick, markAutopilotRunHalted } from './extraction/autopilot.ts';
import {
  isUsageTelemetryCircuitOpen,
  deliverUsageTelemetryEvent,
} from './shared/thirdPartyTelemetry.ts';
import { persistUsageTelemetryFallback } from './shared/thirdPartyTelemetry.ts';
import { gateQueuedDelivery, reconnectDeadLetteredOutbox } from './delivery/outbox.ts';
import { readDeliveryMode } from './delivery/deliveryMode.ts';
import { reconnectDeadLetteredIngestionOutbox } from './ingestion/outbox.ts';
import { executeQueuedCommand } from './client/commands.ts';
import { updateCommandStatus } from './client/state.ts';
import { sentryLoggerWarn } from './shared/sentryRuntime.ts';

export async function handleIngestMessage(
  env: Env,
  msg: QueueMessage,
  queueAttempt = 1,
  lease?: DurableQueueLeaseContext,
): Promise<void> {
  await lease?.assertOwned();
  switch (msg.type) {
    case 'filing.new':
      if (lease) await fetchFiling(env, msg.docId, queueAttempt, lease);
      else await fetchFiling(env, msg.docId, queueAttempt);
      return;
    case 'filing.fetched':
      if (lease) await classifyFiling(env, msg.docId, lease);
      else await classifyFiling(env, msg.docId);
      return;
    case 'filing.extracted':
      if (lease) await extractAndNormalize(env, msg.docId, lease);
      else await extractAndNormalize(env, msg.docId);
      return;
    case 'filing.local_wait_check':
      if (lease) await handleLocalWaitCheck(env, msg.docId, lease);
      else await handleLocalWaitCheck(env, msg.docId);
      return;
    case 'tx.persisted':
      await env.DELIVERY_QUEUE.send({ type: 'delivery.dispatch', txId: msg.txId });
      return;
    case 'command.execute':
      await executeQueuedCommand(env, msg.commandId, msg.userId);
      return;
    case 'agreement.check':
      if (lease) {
        await handleAgreementCheck(
          env,
          msg.docId,
          msg.rawObjectKey,
          msg.escalationTier,
          msg.claimToken,
          lease.signal,
        );
      } else {
        await handleAgreementCheck(
          env,
          msg.docId,
          msg.rawObjectKey,
          msg.escalationTier,
          msg.claimToken,
        );
      }
      return;
    case 'autopilot.tick':
      if (lease) {
        await handleAutopilotTick(env, msg.runId, { signal: lease.signal });
      } else {
        await handleAutopilotTick(env, msg.runId);
      }
      return;
    case 'usage.telemetry':
      if (await isUsageTelemetryCircuitOpen(env)) {
        await persistUsageTelemetryFallback(env, msg.event, { throwOnFailure: true });
        return;
      }
      if (lease) await deliverUsageTelemetryEvent(env, msg.event, lease.signal);
      else await deliverUsageTelemetryEvent(env, msg.event);
      return;
    default:
      console.warn('INGEST_QUEUE: unexpected message type', (msg as { type?: string }).type);
  }
}

export async function handleDeliveryMessage(
  env: Env,
  msg: QueueMessage,
  lease?: DurableQueueLeaseContext,
): Promise<boolean> {
  await lease?.assertOwned();
  switch (msg.type) {
    case 'delivery.dispatch': {
      // Subscriber alert pause (CT_DELIVERY_MODE) for messages queued before
      // the switch or by another producer.  Returning false acks the message
      // without completing the outbox row (gateQueuedDelivery re-opens or
      // suppresses it).  Throws if settings never booted, so it retries.
      const mode = readDeliveryMode();
      if (mode !== 'deliver') {
        if (!msg.subscriptionId) await gateQueuedDelivery(env, msg.txId, mode);
        return false;
      }
      const result = lease
        ? await dispatchWebhook(env, msg, lease)
        : await dispatchWebhook(env, msg);
      return result.outboxComplete;
    }
    default:
      console.warn('DELIVERY_QUEUE: unexpected message type', (msg as { type?: string }).type);
      return false;
  }
}

/** Authoritative terminal recovery path for queue dead letters (single source
 * of truth — index.ts re-exports this so the Workers and Deno paths cannot
 * diverge again). */
export async function handleDeadLetterMessage(
  env: Env,
  queue: string,
  msg: QueueMessage,
  attempts: number,
  lease?: DurableQueueLeaseContext,
): Promise<void> {
  await lease?.assertOwned();
  const recoveryError = new Error(`consumer retry budget exhausted; received by ${queue}`);
  if (msg.type === 'usage.telemetry') {
    // The ingest DLQ has a much larger retry budget (up to 100 retries), which
    // is exactly the amplification surface a dead receiver hit during the
    // incident this circuit breaker guards against. Respect it here too:
    // while open, persist to the R2 outbox and stop, instead of continuing to
    // attempt the exact same idempotent event on every DLQ redelivery.
    if (await isUsageTelemetryCircuitOpen(env)) {
      await persistUsageTelemetryFallback(env, msg.event, { throwOnFailure: true });
      return;
    }
    if (lease) await deliverUsageTelemetryEvent(env, msg.event, lease.signal);
    else await deliverUsageTelemetryEvent(env, msg.event);
    return;
  }
  await recordDeadLetterDurable(env, queue, msg, attempts, recoveryError);

  if (msg.type === 'autopilot.tick') {
    // A dead-lettered autopilot slice means the run's consumer kept failing:
    // surface it as a halt requiring acknowledgment, never silently drop it.
    await markAutopilotRunHalted(env, msg.runId, 'tick_dead_lettered');
    return;
  }

  if (queue.includes('delivery')) {
    if (msg.type !== 'delivery.dispatch') throw new Error('delivery DLQ message has no transaction identity');
    // Re-open the outbox row with bounded backoff cycles instead of marking
    // it completed — completing here permanently abandons the webhook.
    const recovered = await reconnectDeadLetteredOutbox(env, msg.txId, recoveryError.message);
    if (recovered.status === 'missing') {
      sentryLoggerWarn('ingest.dead_letter', {
        queue: 'delivery',
        reason: 'outbox_missing',
      });
    }
    return;
  }

  if (msg.type === 'command.execute') {
    // Retry budget exhausted: terminalize the command row so clients
    // polling GET /commands/:id see a failure instead of a stuck status.
    await updateCommandStatus(env, msg.userId, msg.commandId, 'failed', {
      error: recoveryError.message,
    });
    return;
  }

  if (!('docId' in msg) || !msg.docId) throw new Error('ingest DLQ message has no filing identity');
  const recovered = await reconnectDeadLetteredIngestionOutbox(
    env,
    msg.docId,
    recoveryError.message,
    new Date(),
    { reopenCompleted: msg.type !== 'filing.new' },
  );
  if (recovered.status === 'missing') {
    sentryLoggerWarn('ingest.dead_letter', {
      queue: 'ingest',
      reason: 'outbox_missing',
    });
  }
  if (recovered.status === 'failed') {
    // VISIBLE TERMINAL STATE (autonomy diagnosis 2026-08-09, principle b):
    // reconnectDeadLetteredIngestionOutbox exhausted its bounded dead-letter
    // cycle budget and permanently gave up on this doc_id's outbox delivery
    // — but that call only touches ingestion_outbox, never filings. Left
    // alone, filings.ingest_status stays whatever mid-pipeline value it had
    // (e.g. 'new'), so the filing looks silently stuck forever even though
    // nothing will ever retry it again. Stamp it terminal here so it is both
    // visible (pipelineHealth's ingestion_dead_letter check already counts
    // ingestion_outbox status='failed'; this makes the *filing* itself
    // equally visible) and excluded from every "why is this still pending"
    // query. Never clobbers an already-terminal/resolved row.
    try {
      await run(
        env.DB,
        `UPDATE filings
            SET ingest_status = 'error',
                error = ?
          WHERE doc_id = ?
            AND ingest_status NOT IN ('persisted', 'error')`,
        [`autonomy: ingestion outbox dead-letter budget exhausted (${queue}/${msg.type}): ${recoveryError.message}`.slice(0, 1000), msg.docId],
      );
    } catch (err) {
      console.error(`failed to terminalize filing ${msg.docId} after outbox dead-letter:`, err);
    }
  }
}

export async function handleCorruptDeadLetterMessage(
  env: Env,
  queue: string,
  msg: unknown,
  attempts: number,
  error: string,
  lease?: DurableQueueLeaseContext,
): Promise<void> {
  await lease?.assertOwned();
  await recordDeadLetterDurable(
    env,
    queue,
    msg,
    attempts,
    new Error(`invalid durable queue payload: ${error}`),
  );
}

export async function handleLocalWaitCheck(
  env: Env,
  docId: string,
  lease?: DurableQueueLeaseContext,
): Promise<void> {
  await lease?.assertOwned();
  const row = await get<{ ingest_status: string; local_wait_expires_at: string | null }>(
    env.DB,
    `SELECT ingest_status, local_wait_expires_at FROM filings WHERE doc_id = ?`,
    [docId],
  );
  if (!row) return;

  if (row.ingest_status === 'extraction_pending_local') {
    const expiresMs = row.local_wait_expires_at ? new Date(row.local_wait_expires_at).getTime() : NaN;
    const isExpired = !row.local_wait_expires_at || Number.isNaN(expiresMs) || expiresMs <= Date.now();
    if (isExpired) {
      await lease?.assertOwned();
      await run(
        env.DB,
        `UPDATE filings
            SET ingest_status = 'classified'
          WHERE doc_id = ? AND ingest_status = 'extraction_pending_local'`,
        [docId],
      );
      await lease?.assertOwned();
      await env.INGEST_QUEUE.send({ type: 'filing.extracted', docId });
    } else {
      // LOST-WAKEUP FIX (autonomy diagnosis 2026-08-09): this check fired
      // early — classifyFiling's own delayed message landed before
      // local_wait_expires_at, because a later re-classification pushed the
      // expiry out further. Without this branch the message silently no-ops
      // here and NOTHING is ever scheduled again: the filing is stranded in
      // extraction_pending_local until the periodic ceiling sweep
      // (autonomySweeps.ts, 24h backstop) eventually rescues it. Re-enqueue a
      // follow-up check for the remaining wait instead, so the fast path
      // (local vision worker finishing on time) keeps working within
      // seconds of the real expiry rather than hours later.  The wait
      // window itself is now `LOCAL_VISION_WAIT_MINUTES` (2 min per
      // 2026-09-04 owner rule — was 15).
      const remainingMs = expiresMs - Date.now();
      const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
      await lease?.assertOwned();
      await env.INGEST_QUEUE.send(
        { type: 'filing.local_wait_check', docId },
        { delaySeconds: remainingSeconds },
      );
    }
  }
}
