import { describe, expect, it, vi } from 'vitest';
import type { Env } from './types.ts';
import { PUSHOVER_TIMEOUT_MS, sendPushover } from './pushover.ts';

const env = {} as Env;

describe('sendPushover', () => {
  it('no-ops when credentials are missing', async () => {
    const fetchFn = vi.fn();
    const r = await sendPushover(env, { title: 't', message: 'm' }, { appToken: '', userKey: undefined }, fetchFn as unknown as typeof fetch);
    expect(r.sent).toBe(false);
    expect(r.reason).toContain('not configured');
    // Falls back to resolving secrets (env has no Infisical here) — still no fetch.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('posts form-encoded token/user/title/message', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ status: 1 }), { status: 200 }));
    const r = await sendPushover(
      env,
      { title: 'R2 usage', message: 'line1\nline2', priority: 1 },
      { appToken: 'app-token', userKey: 'user-key' },
      fetchFn as unknown as typeof fetch,
    );
    expect(r).toEqual({ sent: true });
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.pushover.net/1/messages.json');
    expect(init.method).toBe('POST');
    const params = new URLSearchParams(init.body as string);
    expect(params.get('token')).toBe('app-token');
    expect(params.get('user')).toBe('user-key');
    expect(params.get('title')).toBe('R2 usage');
    expect(params.get('message')).toBe('line1\nline2');
    expect(params.get('priority')).toBe('1');
  });

  it('reports HTTP failure', async () => {
    const fetchFn = vi.fn(async () => new Response('bad', { status: 400 }));
    const r = await sendPushover(env, { title: 't', message: 'm' }, { appToken: 'a', userKey: 'u' }, fetchFn as unknown as typeof fetch);
    expect(r.sent).toBe(false);
    expect(r.reason).toContain('HTTP 400');
  });

  it('reports Pushover API errors', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ status: 0, errors: ['user key is invalid'] }), { status: 200 }));
    const r = await sendPushover(env, { title: 't', message: 'm' }, { appToken: 'a', userKey: 'u' }, fetchFn as unknown as typeof fetch);
    expect(r.sent).toBe(false);
    expect(r.reason).toContain('user key is invalid');
  });

  it('never throws on network errors', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('socket hangup'); });
    const r = await sendPushover(env, { title: 't', message: 'm' }, { appToken: 'a', userKey: 'u' }, fetchFn as unknown as typeof fetch);
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('socket hangup');
  });

  it('passes an abort signal so a STALLED connection cannot hang the caller', async () => {
    // The failure this guards is not a rejection - it is a request that never
    // settles. sendPushover is awaited from the Stripe webhook handler and the
    // Apple redeem command, so an unbounded fetch delays the webhook response
    // indefinitely and Stripe retries an event it thinks timed out. Catching
    // rejected requests does nothing for a socket that simply hangs.
    let seenSignal: AbortSignal | undefined;
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return new Response(JSON.stringify({ status: 1 }), { status: 200 });
    });
    const r = await sendPushover(env, { title: 't', message: 'm' }, { appToken: 'a', userKey: 'u' }, fetchFn as unknown as typeof fetch);
    expect(r.sent).toBe(true);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(PUSHOVER_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('aborts and reports a timeout when the connection never settles', async () => {
    // The real hazard: a fetch that neither resolves nor rejects. Fake timers let
    // us hold the request open and advance past PUSHOVER_TIMEOUT_MS, proving the
    // caller is released rather than hanging forever.
    vi.useFakeTimers();
    try {
      const fetchFn = (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('The operation was aborted.'));
          });
        });

      const pending = sendPushover(
        env,
        { title: 't', message: 'm' },
        { appToken: 'a', userKey: 'u' },
        fetchFn as unknown as typeof fetch,
      );
      await vi.advanceTimersByTimeAsync(PUSHOVER_TIMEOUT_MS + 1);
      const r = await pending;

      expect(r.sent).toBe(false);
      expect(r.reason).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });
});
