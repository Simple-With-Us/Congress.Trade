/**
 * src/delivery/retractions.ts
 *
 * The trade.retract signal: a previously published transaction was taken off
 * the feed (admin unpublish, reject, republish retirement, amendment
 * supersede, or any other deprecation).  It is NOT a user alert: no APNs push,
 * and webhook/SSE consumers should drop or hide the row rather than notify.
 *
 * Source of truth: tx_retractions (migration 0108), one row per deprecation,
 * written by trg_transactions_retract.  `seq` is the retraction cursor.
 * When a republish revives the row, revived_at is set and the transaction
 * takes a new cursor_seq, so a poller re-adds it from GET /api/transactions.
 * Revived retractions are never served or delivered again.
 *
 * Delivery: the same trigger enqueues delivery_outbox key 'retract:<seq>'
 * (event_kind 'trade.retract').  The outbox, queue message and deliveries
 * rows carry that key in their tx_id column, so a retract never collides with
 * the transaction's original delivery (keyed by the bare tx id).
 */
import type { Env } from '../shared/types.ts';
import { all, get } from '../shared/db.ts';

export const RETRACT_KEY_PREFIX = 'retract:';
export const RETRACT_EVENT = 'trade.retract' as const;
export const RETRACTIONS_DEFAULT_LIMIT = 500;
export const RETRACTIONS_MAX_LIMIT = 1000;

/** Wire shape for every trade.retract consumer (webhook, SSE, poll). */
export interface TradeRetraction {
  /** Retraction cursor; pass the largest one seen back as `since`. */
  retractSeq: number;
  txId: string;
  docId: string;
  retractedAt: string;
}

interface RetractionRow {
  seq: number;
  tx_id: string;
  doc_id: string;
  retracted_at: string;
  revived_at: string | null;
}

/** Outbox / delivery key for one retraction. */
export function retractKey(seq: number): string {
  return `${RETRACT_KEY_PREFIX}${seq}`;
}

/** Parse 'retract:<seq>'; null for a plain transaction id. */
export function parseRetractKey(key: string): number | null {
  if (!key.startsWith(RETRACT_KEY_PREFIX)) return null;
  const raw = key.slice(RETRACT_KEY_PREFIX.length);
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) return null;
  return Number(raw);
}

function toWire(row: RetractionRow): TradeRetraction {
  return { retractSeq: Number(row.seq), txId: row.tx_id, docId: row.doc_id, retractedAt: row.retracted_at };
}

/** One live (not revived) retraction by seq, or null. */
export async function getLiveRetraction(env: Env, seq: number): Promise<TradeRetraction | null> {
  const row = await get<RetractionRow>(
    env.DB,
    `SELECT seq, tx_id, doc_id, retracted_at, revived_at FROM tx_retractions
      WHERE seq = ? AND revived_at IS NULL`,
    [seq],
  );
  return row ? toWire(row) : null;
}

/**
 * Live retractions with seq > since, oldest first.  `cursor` is the largest
 * seq scanned (or `since` when the page is empty), so a poller feeds it back
 * as the next `since` and never misses or repeats one.
 */
export async function listRetractions(
  env: Env,
  since: number,
  limit = RETRACTIONS_DEFAULT_LIMIT,
): Promise<{ retractions: TradeRetraction[]; cursor: number; hasMore: boolean }> {
  const pageSize = Math.min(Math.max(Math.floor(limit), 1), RETRACTIONS_MAX_LIMIT);
  // Keyset on the INTEGER PRIMARY KEY; revived rows are skipped but still
  // advance the cursor, so a revived-only page is not re-scanned.
  const rows = await all<RetractionRow>(
    env.DB,
    `SELECT seq, tx_id, doc_id, retracted_at, revived_at FROM tx_retractions
      WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
    [Math.max(0, Math.floor(since)), pageSize + 1],
  );
  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const cursor = page.reduce((m, r) => Math.max(m, Number(r.seq)), Math.max(0, Math.floor(since)));
  return {
    retractions: page.filter((r) => r.revived_at === null).map(toWire),
    cursor,
    hasMore,
  };
}

/** Current retraction high-water mark (0 when none). */
export async function readRetractionHighWater(env: Env): Promise<number> {
  const row = await get<{ hwm: number | null }>(env.DB, 'SELECT MAX(seq) AS hwm FROM tx_retractions', []);
  return Number(row?.hwm ?? 0);
}

/** SSE frame.  No `id:` line: Last-Event-ID stays the trade cursor_seq. */
export function formatRetractFrame(r: TradeRetraction): string {
  return `event: ${RETRACT_EVENT}\ndata: ${JSON.stringify({ type: RETRACT_EVENT, ...r })}\n\n`;
}
