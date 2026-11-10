/**
 * src/delivery/deadLetter.ts
 *
 * Operator visibility for queue messages that exhaust their retry budget.
 * wrangler.toml routes terminal failures to a dead-letter queue
 * (congress-feed-{ingest,delivery}-dlq). The Worker actively consumes both,
 * records each terminal receipt, reopens the owning durable outbox, and alerts
 * operators, so an isolate-level crash cannot strand an `enqueued` handoff.
 *
 * Main-queue logging remains best-effort. The dedicated DLQ consumer uses the
 * strict variant and does not ACK until both receipt and recovery are durable.
 */
import type { Env, QueueMessage } from '../shared/types.ts';
import { run } from '../shared/db.ts';
import { notifyAdmin } from '../alerts/notify.ts';
import { consumeGovernedD1Writes } from '../shared/d1Budget.ts';
import { sentryLoggerWarn } from '../shared/sentryRuntime.ts';

async function insertDeadLetterReceipt(
  env: Env,
  queue: string,
  msg: unknown,
  attempts: number,
  err: unknown,
): Promise<void> {
  const m = (msg && typeof msg === 'object' ? msg : {}) as { type?: string; docId?: string; txId?: string };
  const error = err instanceof Error ? err.message : String(err);

  await run(
    env.DB,
    `INSERT INTO dead_letter_events (queue, msg_type, doc_id, tx_id, attempts, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [queue, m.type ?? null, m.docId ?? null, m.txId ?? null, attempts, error.slice(0, 1000), new Date().toISOString()],
  );
}

async function alertDeadLetter(
  env: Env,
  queue: string,
  msg: unknown,
  attempts: number,
  err: unknown,
): Promise<void> {
  const m = (msg && typeof msg === 'object' ? msg : {}) as { type?: string; docId?: string; txId?: string };
  const error = err instanceof Error ? err.message : String(err);

  try {
    await notifyAdmin(env, {
      subject: `Queue message dead-lettered: ${queue}`,
      text:
        `A ${m.type ?? 'message'} on ${queue} failed ${attempts} attempt(s) and is being dead-lettered.\n\n` +
        `doc_id: ${m.docId ?? '—'}\ntx_id: ${m.txId ?? '—'}\nerror: ${error}`,
      dedupeKey: `dlq:${queue}:${m.type ?? 'msg'}`,
      throttleSec: 3600,
    });
  } catch (e) {
    sentryLoggerWarn('ingest.dead_letter', {
      queue,
      reason: 'alert_failed',
    });
  }
}

/** Best-effort legacy caller; does not change the queue's retry behavior. */
export async function recordDeadLetter(
  env: Env,
  queue: string,
  msg: QueueMessage,
  attempts: number,
  err: unknown,
): Promise<void> {
  // GOVERNOR 2: DLQ receipt inserts are a known storm writer (an outage that
  // dead-letters a whole backlog). This variant is best-effort observability,
  // so past the per-invocation governed-write cap the D1 insert is skipped —
  // the throttled admin alert below still fires.
  if (consumeGovernedD1Writes(env, 'dead-letter', 1) < 1) {
    sentryLoggerWarn('ingest.dead_letter', { queue, reason: 'governor_cap' });
  } else {
    try {
      await insertDeadLetterReceipt(env, queue, msg, attempts, err);
    } catch (e) {
      sentryLoggerWarn('ingest.dead_letter', { queue, reason: 'd1_insert_failed' });
    }
  }
  await alertDeadLetter(env, queue, msg, attempts, err);
}

/**
 * DLQ-consumer variant: the receipt insert is part of durable recovery and
 * therefore rejects on D1 failure. The caller must not ACK until this resolves.
 * Deliberately NOT gated by the write governor: skipping this insert would
 * leave the message un-ACKed and force a redelivery loop — the opposite of
 * storm control. The DLQ consumer's own bounded batch size bounds it instead.
 */
export async function recordDeadLetterDurable(
  env: Env,
  queue: string,
  msg: unknown,
  attempts: number,
  err: unknown,
): Promise<void> {
  await insertDeadLetterReceipt(env, queue, msg, attempts, err);
  await alertDeadLetter(env, queue, msg, attempts, err);
}
