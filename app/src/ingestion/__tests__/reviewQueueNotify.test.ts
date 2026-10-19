import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import {
  notifyPipelineStallPublisher,
  notifyReviewQueuePublisher,
  redactWebhookError,
  redactWebhookUrl,
} from '../reviewQueueNotify.ts';

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

  it('sends Authorization on GB webhook when REVIEW_QUEUE_PUBLISHER_WEBHOOK_AUTH_GB is set', async () => {
    const headersByUrl = new Map<string, Record<string, string>>();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('dns-query')) {
        const type = url.includes('type=AAAA') ? DNS_AAAA : DNS_A;
        return new Response(type, { status: 200 });
      }
      headersByUrl.set(url, init?.headers as Record<string, string>);
      return new Response('ok', { status: 202 });
    });

    await notifyReviewQueuePublisher(envWith({
      REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL: 'https://bf.example/hook',
      REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL_GB: 'https://gb.example/hook',
      REVIEW_QUEUE_PUBLISHER_WEBHOOK_AUTH_GB: 'Bearer gb-publisher-token',
    }), { docId: 'H-42' }, { fetchImpl });

    expect(headersByUrl.get('https://gb.example/hook')?.authorization).toBe('Bearer gb-publisher-token');
    expect(headersByUrl.get('https://gb.example/hook')?.['x-ct-signature']).toMatch(/^t=\d+,v1=/);
    expect(headersByUrl.get('https://bf.example/hook')?.authorization).toBeUndefined();
    expect(headersByUrl.get('https://bf.example/hook')?.['x-ct-signature']).toMatch(/^t=\d+,v1=/);
  });

  it('omits Authorization on GB webhook when REVIEW_QUEUE_PUBLISHER_WEBHOOK_AUTH_GB is unset', async () => {
    let postedHeaders: Record<string, string> | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('dns-query')) {
        const type = url.includes('type=AAAA') ? DNS_AAAA : DNS_A;
        return new Response(type, { status: 200 });
      }
      if (url === 'https://gb.example/hook') {
        postedHeaders = init?.headers as Record<string, string>;
      }
      return new Response('ok', { status: 202 });
    });

    await notifyReviewQueuePublisher(envWith({
      REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL: 'https://bf.example/hook',
      REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL_GB: 'https://gb.example/hook',
    }), { docId: 'H-42' }, { fetchImpl });

    expect(postedHeaders?.authorization).toBeUndefined();
    expect(postedHeaders?.['x-ct-signature']).toMatch(/^t=\d+,v1=/);
  });

  it('does not send Authorization on a URL configured for both BF and GB', async () => {
    const headersByUrl = new Map<string, Record<string, string>>();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('dns-query')) {
        const type = url.includes('type=AAAA') ? DNS_AAAA : DNS_A;
        return new Response(type, { status: 200 });
      }
      headersByUrl.set(url, init?.headers as Record<string, string>);
      return new Response('ok', { status: 202 });
    });

    await notifyReviewQueuePublisher(envWith({
      REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL: 'https://shared.example/hook',
      REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL_GB: 'https://shared.example/hook',
      REVIEW_QUEUE_PUBLISHER_WEBHOOK_AUTH_GB: 'Bearer gb-publisher-token',
    }), { docId: 'H-42' }, { fetchImpl });

    expect(headersByUrl.get('https://shared.example/hook')?.authorization).toBeUndefined();
    expect(headersByUrl.get('https://shared.example/hook')?.['x-ct-signature']).toMatch(/^t=\d+,v1=/);
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

  it('fans out the same signed payload to BF and GB publisher webhook URLs', async () => {
    const postedUrls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('dns-query')) {
        const type = url.includes('type=AAAA') ? DNS_AAAA : DNS_A;
        return new Response(type, { status: 200 });
      }
      postedUrls.push(url);
      return new Response('ok', { status: 202 });
    });

    await notifyReviewQueuePublisher(envWith({
      REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL: 'https://bf-publisher.example/hook',
      REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL_GB: 'https://gb-publisher.example/hook',
    }), {
      docId: 'H-2026-9116355',
      reason: 'needs_hand_check:mac_vision',
      kind: 'insert',
      at: '2026-10-12T09:28:00.000Z',
    }, { fetchImpl });

    expect(postedUrls).toContain('https://bf-publisher.example/hook');
    expect(postedUrls).toContain('https://gb-publisher.example/hook');
    expect(postedUrls.length).toBe(2);
  });
});

describe('webhook URL redaction (CT-2432)', () => {
  // Built at run time so the fake secret never appears as a literal in source.
  const fakeSecret = ['s', 'k', Math.random().toString(36).slice(2), 'Z9x8Y7w6V5'].join('');
  const secretUrl = `https://bf.example/hooks/abc123/${fakeSecret}`;

  it('redactWebhookUrl keeps host and hook id but never the secret segment', () => {
    const out = redactWebhookUrl(`${secretUrl}?token=${fakeSecret}`);
    expect(out).toBe('https://bf.example/hooks/abc123/***');
    expect(out).not.toContain(fakeSecret);
    expect(redactWebhookUrl('not a url')).toBe('[invalid-webhook-url]');
  });

  it('redactWebhookError scrubs the URL and secret from an error message', () => {
    const out = redactWebhookError(`fetch to ${secretUrl} failed: /hooks/abc123/${fakeSecret}`, secretUrl);
    expect(out).not.toContain(fakeSecret);
  });

  async function runAndCollectLogs(fetchImpl: typeof fetch): Promise<string> {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await notifyReviewQueuePublisher(
        envWith({ REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL: secretUrl }),
        { docId: 'H-1' },
        { fetchImpl },
      );
      return warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    } finally {
      warn.mockRestore();
    }
  }

  it('does not log the secret when the publisher answers with an HTTP error', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('dns-query')) {
        return new Response(String(input).includes('type=AAAA') ? DNS_AAAA : DNS_A, { status: 200 });
      }
      return new Response('boom', { status: 500 });
    }) as unknown as typeof fetch;
    const logs = await runAndCollectLogs(fetchImpl);
    expect(logs).toContain('HTTP 500');
    expect(logs).toContain('https://bf.example/hooks/abc123/***');
    expect(logs).not.toContain(fakeSecret);
  });

  it('does not log the secret when the fetch throws an error that echoes the URL', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('dns-query')) {
        return new Response(String(input).includes('type=AAAA') ? DNS_AAAA : DNS_A, { status: 200 });
      }
      throw new Error(`connect failed for ${String(input)}`);
    }) as unknown as typeof fetch;
    const logs = await runAndCollectLogs(fetchImpl);
    expect(logs).toContain('notify failed');
    expect(logs).not.toContain(fakeSecret);
  });
});
