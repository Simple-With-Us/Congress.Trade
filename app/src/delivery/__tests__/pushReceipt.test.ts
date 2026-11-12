import { describe, expect, it } from 'vitest';
import {
  congressPushReceiptFailureReason,
  parseCongressPushReceipt,
  readWebhookPushReceipt,
  releaseSubscriberWebhookResponseBody,
  webhookSubscriberConsumptionError,
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

  it('fails closed on legacy ok:false even with extra envelope keys', () => {
    const parsed = parseCongressPushReceipt({
      ok: false,
      applied: 0,
      reason: 'invalid-event',
      traceId: 'extra-field',
    });
    expect(parsed.ok).toBe(true);
    expect(congressPushReceiptFailureReason(parsed)).toMatch(/invalid-event/);
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

  it('webhookSubscriberConsumptionError ignores plain 2xx non-JSON bodies', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { status: 200, headers: { 'content-type': 'text/plain' } });
    expect(await webhookSubscriberConsumptionError(response)).toBeNull();
    expect(cancelled).toBe(true);
  });

  it('releaseSubscriberWebhookResponseBody cancels unread bodies', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { status: 503 });
    await releaseSubscriberWebhookResponseBody(response);
    expect(cancelled).toBe(true);
  });

  it('webhookSubscriberConsumptionError ignores generic JSON without receipt fields', async () => {
    const response = new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    expect(await webhookSubscriberConsumptionError(response)).toBeNull();
  });

  it('fails closed on a legacy batch whose results carry extra keys', () => {
    const parsed = parseCongressPushReceipt({
      results: [{ ok: false, applied: 0, reason: 'invalid-event', traceId: 'extra-field' }],
    });
    expect(parsed.ok).toBe(true);
    expect(congressPushReceiptFailureReason(parsed)).toMatch(/invalid-event/);
  });

  it('does not mark an empty legacy batch consumed or ok', () => {
    const parsed = parseCongressPushReceipt({ results: [] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected parse');
    expect(parsed.receipt.consumed).toBe(false);
    expect(parsed.receipt.ok).toBe(false);
    expect(congressPushReceiptFailureReason(parsed)).not.toBeNull();
  });

  it('fails on a v1 receipt with consumed=true but ok=false', () => {
    const parsed = parseCongressPushReceipt({
      receiptVersion: 1,
      delivered: true,
      consumed: true,
      ok: false,
      applied: 0,
    });
    expect(parsed.ok).toBe(true);
    expect(congressPushReceiptFailureReason(parsed)).toMatch(/ok=false/);
  });

  it('never falls back to legacy parsing for a receiptVersion body', () => {
    const parsed = parseCongressPushReceipt({
      receiptVersion: 1,
      delivered: true,
      consumed: true,
      ok: true,
      applied: 1,
      unexpected: 'extra-field',
    });
    expect(parsed.ok).toBe(false);
  });

  it('webhookSubscriberConsumptionError ignores oversize generic JSON bodies', async () => {
    const response = new Response(
      JSON.stringify({ status: 'ok', padding: 'x'.repeat(40_000) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    expect(await webhookSubscriberConsumptionError(response)).toBeNull();
  });

  it('webhookSubscriberConsumptionError ignores invalid and primitive JSON bodies', async () => {
    const invalid = new Response('not json{', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    expect(await webhookSubscriberConsumptionError(invalid)).toBeNull();
    const primitive = new Response('42', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    expect(await webhookSubscriberConsumptionError(primitive)).toBeNull();
  });

  it('webhookSubscriberConsumptionError fails on v1 consumed=false', async () => {
    const response = new Response(
      JSON.stringify({
        receiptVersion: 1,
        delivered: true,
        consumed: false,
        ok: false,
        applied: 0,
        reason: 'invalid-event',
      }),
      { status: 200,
        headers: { 'content-type': 'application/json' } },
    );
    expect(await webhookSubscriberConsumptionError(response)).toMatch(/invalid-event/);
  });
});
