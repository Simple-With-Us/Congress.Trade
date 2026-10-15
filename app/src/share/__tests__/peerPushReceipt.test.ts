import { describe, expect, it } from 'vitest';
import { interpretPeerPushReceipt } from '../peerPushReceipt.ts';

const at = '2026-10-15T12:00:00.000Z';
const pushId = '11111111-1111-1111-1111-111111111111';

describe('interpretPeerPushReceipt', () => {
  it('accepts a receipt that echoes the push id and both acks', () => {
    const receipt = interpretPeerPushReceipt(
      {
        ok: true,
        pushId,
        acks: {
          delivered: { at, ok: true },
          consumed: { at, ok: true },
        },
      },
      pushId,
    );
    expect(receipt.health).toBe('ok');
    expect(receipt.pushId).toBe(pushId);
  });

  it('reports a missing consumed ack when only delivered is present', () => {
    const receipt = interpretPeerPushReceipt(
      { ok: true, pushId, acks: { delivered: { at, ok: true }, consumed: null } },
      pushId,
    );
    expect(receipt.health).toBe('missing-consumed-ack');
  });

  it('reports a missing push id when the body echoes a different id', () => {
    const receipt = interpretPeerPushReceipt(
      {
        ok: true,
        pushId: 'someone-else',
        acks: {
          delivered: { at, ok: true },
          consumed: { at, ok: true },
        },
      },
      pushId,
    );
    expect(receipt.health).toBe('missing-push-id');
  });

  it('treats a bare ok body as a missing delivered ack', () => {
    expect(interpretPeerPushReceipt({ ok: true }, pushId).health).toBe('missing-delivered-ack');
    expect(interpretPeerPushReceipt(undefined, pushId).health).toBe('missing-delivered-ack');
  });
});
