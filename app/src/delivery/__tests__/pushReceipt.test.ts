import { describe, expect, it } from 'vitest';
import {
  congressPushReceiptFailureReason,
  parseCongressPushReceipt,
  readWebhookPushReceipt,
} from '../pushReceipt.ts';

describe('pushReceipt', () => {
  it('accepts v1 receipts with consumed=true', () => {
    const parsed = parseCongressPushReceipt({
      receiptVersion: 1,
      delivered: true,
      consumed: true,
      ok: true,
      applied: 1,
      eventId: 'evt-1',
    });
    expect(parsed.ok).toBe(true);
    expect(congressPushReceiptFailureReason(parsed)).toBeNull();
  });

  it('fails closed when consumed=false', () => {
    const parsed = parseCongressPushReceipt({
      receiptVersion: 1,
      delivered: true,
      consumed: false,
      ok: false,
      applied: 0,
      reason: 'invalid-event',
    });
    expect(congressPushReceiptFailureReason(parsed)).toMatch(/invalid-event/);
  });

  it('upgrades legacy ok/applied bodies', () => {
    const parsed = parseCongressPushReceipt({ ok: true, applied: 2, type: 'congress.trade' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected parse');
    expect(parsed.receipt.consumed).toBe(true);
  });

  it('reads JSON receipts from fetch responses', async () => {
    const response = new Response(
      JSON.stringify({
        receiptVersion: 1,
        delivered: true,
        consumed: true,
        ok: true,
        applied: 0,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const parsed = await readWebhookPushReceipt(response);
    expect(parsed.ok).toBe(true);
  });
});
