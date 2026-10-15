/**
 * App B (Socratic Trade) webhook consumption receipts for App A outbound pushes.
 * Mirrors congress-trading-shared pushReceipt.ts (ST-3846).
 */

import { z } from 'zod';

export const CONGRESS_PUSH_RECEIPT_VERSION = 1;

const nonNegativeInt = z.number().int().nonnegative();

export const CongressPushReceiptEventSchema = z
  .object({
    ok: z.boolean(),
    consumed: z.boolean(),
    type: z.string().trim().min(1).optional(),
    eventId: z.string().trim().min(1).optional(),
    applied: nonNegativeInt,
    duplicate: z.boolean().optional(),
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

export type CongressPushReceiptEvent = z.infer<typeof CongressPushReceiptEventSchema>;

export const CongressPushReceiptSchema = z
  .object({
    receiptVersion: z.literal(CONGRESS_PUSH_RECEIPT_VERSION),
    delivered: z.literal(true),
    consumed: z.boolean(),
    ok: z.boolean(),
    type: z.string().trim().min(1).optional(),
    eventId: z.string().trim().min(1).optional(),
    applied: nonNegativeInt,
    duplicate: z.boolean().optional(),
    reason: z.string().trim().min(1).optional(),
    count: nonNegativeInt.optional(),
    results: z.array(CongressPushReceiptEventSchema).optional(),
  })
  .strict();

export type CongressPushReceipt = z.infer<typeof CongressPushReceiptSchema>;

export interface CongressPushApplyLike {
  ok: boolean;
  type?: string;
  applied: number;
  reason?: string;
  duplicate?: boolean;
}

const CongressPushApplyLikeSchema = z
  .object({
    ok: z.boolean(),
    applied: nonNegativeInt,
    type: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1).optional(),
    duplicate: z.boolean().optional(),
  })
  .strict();

const LegacyCongressPushReceiptEnvelopeSchema = z
  .object({
    ok: z.boolean().optional(),
    applied: nonNegativeInt.optional(),
    type: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1).optional(),
    duplicate: z.boolean().optional(),
    results: z.array(CongressPushApplyLikeSchema).optional(),
  })
  .strict();

function eventConsumed(result: CongressPushApplyLike): boolean {
  return result.ok === true;
}

function buildReceiptEvent(result: CongressPushApplyLike, eventId?: string): CongressPushReceiptEvent {
  const consumed = eventConsumed(result);
  return CongressPushReceiptEventSchema.parse({
    ok: result.ok,
    consumed,
    type: result.type,
    eventId,
    applied: result.applied,
    duplicate: result.duplicate,
    reason: result.reason,
  });
}

function buildReceipt(result: CongressPushApplyLike, eventId?: string): CongressPushReceipt {
  const event = buildReceiptEvent(result, eventId);
  return CongressPushReceiptSchema.parse({
    receiptVersion: CONGRESS_PUSH_RECEIPT_VERSION,
    delivered: true,
    consumed: event.consumed,
    ok: event.ok,
    type: event.type,
    eventId: event.eventId,
    applied: event.applied,
    duplicate: event.duplicate,
    reason: event.reason,
  });
}

function buildBatchReceipt(results: CongressPushApplyLike[]): CongressPushReceipt {
  const lines = results.map((result) => buildReceiptEvent(result));
  const consumed = lines.every((line) => line.consumed);
  const ok = lines.every((line) => line.ok);
  const applied = lines.reduce((sum, line) => sum + line.applied, 0);
  return CongressPushReceiptSchema.parse({
    receiptVersion: CONGRESS_PUSH_RECEIPT_VERSION,
    delivered: true,
    consumed,
    ok,
    applied,
    count: lines.length,
    results: lines,
  });
}

export type ParseCongressPushReceiptResult =
  | { ok: true; receipt: CongressPushReceipt }
  | { ok: false; reason: string };

/** JSON body that is not a v1 receipt or legacy ok/applied shape (generic third-party webhook). */
export const PUSH_RECEIPT_UNRECOGNIZED_SHAPE_REASON =
  'push response missing receiptVersion and legacy ok/applied fields';

export function parseCongressPushReceipt(payload: unknown): ParseCongressPushReceiptResult {
  const versioned = CongressPushReceiptSchema.safeParse(payload);
  if (versioned.success) {
    return { ok: true, receipt: versioned.data };
  }

  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'push response body was empty or unparseable' };
  }

  const legacyEnvelope = LegacyCongressPushReceiptEnvelopeSchema.safeParse(payload);
  if (!legacyEnvelope.success) {
    return { ok: false, reason: PUSH_RECEIPT_UNRECOGNIZED_SHAPE_REASON };
  }
  const legacy = legacyEnvelope.data;
  if (legacy.results) {
    return { ok: true, receipt: buildBatchReceipt(legacy.results) };
  }

  if (typeof legacy.ok !== 'boolean' || typeof legacy.applied !== 'number') {
    return { ok: false, reason: PUSH_RECEIPT_UNRECOGNIZED_SHAPE_REASON };
  }

  return {
    ok: true,
    receipt: buildReceipt({
      ok: legacy.ok,
      applied: legacy.applied,
      type: legacy.type,
      reason: legacy.reason,
      duplicate: legacy.duplicate,
    }),
  };
}

export function congressPushReceiptFailureReason(parsed: ParseCongressPushReceiptResult): string | null {
  if (parsed.ok === false) return parsed.reason;
  if (parsed.receipt.consumed) return null;
  const firstBad = parsed.receipt.results?.find((line) => !line.consumed);
  if (firstBad?.reason) return `consumption failed: ${firstBad.reason}`;
  if (parsed.receipt.reason) return `consumption failed: ${parsed.receipt.reason}`;
  return 'consumption failed: ok=false';
}

/** Max bytes to read from App B's webhook response body when validating consumption. */
export const WEBHOOK_PUSH_RECEIPT_MAX_BYTES = 32_768;

export async function readWebhookPushReceipt(response: Response): Promise<ParseCongressPushReceiptResult> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return { ok: false, reason: 'push response missing JSON content-type' };
  }
  const text = await response.text();
  if (text.length > WEBHOOK_PUSH_RECEIPT_MAX_BYTES) {
    return { ok: false, reason: 'push response body too large' };
  }
  if (!text.trim()) {
    return { ok: false, reason: 'push response body was empty or unparseable' };
  }
  try {
    return parseCongressPushReceipt(JSON.parse(text));
  } catch {
    return { ok: false, reason: 'push response body was not valid JSON' };
  }
}

/**
 * Subscriber webhook delivery: validate consumption only when the receiver returns
 * a recognized App B receipt or legacy ok/applied JSON.  Plain 2xx, non-JSON, empty
 * JSON, and generic JSON ({ "status": "ok" }) stay successful deliveries.
 */
export async function webhookSubscriberConsumptionError(response: Response): Promise<string | null> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const text = await response.text();
  if (text.length > WEBHOOK_PUSH_RECEIPT_MAX_BYTES) {
    return 'push response body too large';
  }
  if (!text.trim()) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return 'push response body was not valid JSON';
  }
  const parsed = parseCongressPushReceipt(payload);
  if (parsed.ok === false) {
    if (parsed.reason === PUSH_RECEIPT_UNRECOGNIZED_SHAPE_REASON) {
      return null;
    }
    return parsed.reason;
  }
  return congressPushReceiptFailureReason(parsed);
}
