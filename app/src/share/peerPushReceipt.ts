/**
 * src/share/peerPushReceipt.ts
 * OWNER: foundation
 *
 * Receipt contract for a Congress.Trade -> Socratic-Trade share push.
 * Keep the health names in lockstep with Socratic-Trade
 * `src/lib/peer-push-receipt.ts`.
 */

export const PEER_PUSH_ID_HEADER = 'x-push-id';

export const PEER_PUSH_HEALTH = [
  'ok',
  'missing-push-id',
  'missing-delivered-ack',
  'missing-consumed-ack',
] as const;

export type PeerPushHealth = (typeof PEER_PUSH_HEALTH)[number];

export interface PeerPushAck {
  at: string;
  ok: boolean;
  reason?: string;
}

export interface PeerPushAcks {
  delivered: PeerPushAck | null;
  consumed: PeerPushAck | null;
}

function isAck(value: unknown): value is PeerPushAck {
  if (!value || typeof value !== 'object') return false;
  const ack = value as { at?: unknown; ok?: unknown };
  return typeof ack.at === 'string' && ack.at.length > 0 && typeof ack.ok === 'boolean';
}

/**
 * Read the peer's receipt.  A 2xx body that omits an ack is a missing ack,
 * not a successful push.  Delivered is required before consumed.  The push
 * id we sent must come back, or the receipt is `missing-push-id` once both
 * acks are present.
 */
export function interpretPeerPushReceipt(
  body: unknown,
  sentPushId: string,
): { health: PeerPushHealth; pushId: string | null; acks: PeerPushAcks } {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const acksRaw = record.acks && typeof record.acks === 'object' ? (record.acks as Record<string, unknown>) : {};
  const delivered = isAck(acksRaw.delivered) ? acksRaw.delivered : null;
  const consumed = isAck(acksRaw.consumed) ? acksRaw.consumed : null;
  const echoed = typeof record.pushId === 'string' && record.pushId === sentPushId ? record.pushId : null;
  if (!delivered) return { health: 'missing-delivered-ack', pushId: echoed, acks: { delivered, consumed } };
  if (!consumed) return { health: 'missing-consumed-ack', pushId: echoed, acks: { delivered, consumed } };
  if (!echoed) return { health: 'missing-push-id', pushId: null, acks: { delivered, consumed } };
  return { health: 'ok', pushId: echoed, acks: { delivered, consumed } };
}
