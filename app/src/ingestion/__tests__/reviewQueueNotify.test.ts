import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { notifyPipelineStallPublisher, notifyReviewQueuePublisher } from '../reviewQueueNotify.ts';

const DNS_A = JSON.stringify({
  Status: 0,
  Answer: [{ type: 1, data: '93.184.216.34' }],
});
const DNS_AAAA = JSON.stringify({ Status: 0, Answer: [] });

function envWith(overrides: Partial<Env> = {}): Env {
  return {
    REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL: 'https://publisher.example/hook',
    REVIEW_QUEUE_PUBLISHER_WEBHOOK_SECRET: 'notify-secret',
    ...overrides,
  } as Env;
}

describe('notifyReviewQueuePublisher', () => {
  it('no-ops when URL or secret is missing', async () => {
    const fetchImpl = vi.fn();
    await notifyReviewQueuePublisher(envWith({ REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL: '' }), {
      docId: 'H-1',
    }, { fetchImpl });
    await notifyReviewQueuePublisher(envWith({ REVIEW_QUEUE_PUBLISHER_WEBHOOK_SECRET: '' }), {
      docId: 'H-1',
    }, { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks private webhook targets (SSRF fail-closed)', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('dns-query')) {
        return new Response(JSON.stringify({
          Status: 0,
          Answer: [{ type: 1, data: '127.0.0.1' }],
        }), { status: 200 });
      }
      return new Response('nope', { status: 500 });
    });
    await notifyReviewQueuePublisher(envWith({
      REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL: 'https://evil.example/hook',
    }), { docId: 'H-1' }, { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalledWith(
      'https://evil.example/hook',
      expect.anything(),
    );
  });

  it('fans out to primary and GB webhook URLs with the same signature', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('dns-query')) {
        const type = url.includes('type=AAAA') ? DNS_AAAA : DNS_A;
        return new Response(type, { status: 200 });
      }
      urls.push(url);
      return new Response('ok', { status: 202 });
    });

    await notifyReviewQueuePublisher(envWith({
      REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL: 'https://bf.example/hook',
      REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL_GB: 'https://gb.example/hook',
    }), { docId: 'H-42' }, { fetchImpl });

    expect(urls.sort()).toEqual(['https://bf.example/hook', 'https://gb.example/hook']);
  });

  it('POSTs pipeline.stalled with null docId', async () => {
    let postedBody = '';
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('dns-query')) {
        const type = url.includes('type=AAAA') ? DNS_AAAA : DNS_A;
        return new Response(type, { status: 200 });
      }
      postedBody = String(init?.body ?? '');
      return new Response('ok', { status: 202 });
    });

    await notifyPipelineStallPublisher(envWith(), {
      pipeline: 'senate_fetch_success',
      detail: 'stale senate',
      at: '2026-10-12T12:00:00.000Z',
    }, { fetchImpl });

    expect(postedBody).toContain('"event":"pipeline.stalled"');
    expect(postedBody).toContain('"docId":null');
    expect(postedBody).toContain('"pipeline":"senate_fetch_success"');
  });

  it('POSTs a signed payload to a validated public target', async () => {
    let postedBody = '';
    let postedSig = '';
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('dns-query')) {
        const type = url.includes('type=AAAA') ? DNS_AAAA : DNS_A;
        return new Response(type, { status: 200 });
      }
      postedBody = String(init?.body ?? '');
      postedSig = String((init?.headers as Record<string, string>)['x-ct-signature'] ?? '');
      return new Response('ok', { status: 202 });
    });

    await notifyReviewQueuePublisher(envWith(), {
      docId: 'H-42',
      reason: 'low_confidence',
      kind: 'insert',
      at: '2026-08-25T12:00:00.000Z',
    }, { fetchImpl });

    expect(postedBody).toContain('"docId":"H-42"');
    expect(postedBody).toContain('"event":"review_queue.entered"');
    expect(postedSig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://publisher.example/hook',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
