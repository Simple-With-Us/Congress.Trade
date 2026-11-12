import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { rateLimit, clientIp, resetMemoryRateLimitForTests } from '../rateLimit.ts';
import { stampTcpPeer } from '../../security/originLock.ts';
import type { Env } from '../types.ts';

function fakeEnv(): Env {
  const store = new Map<string, string>();
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
  };
  return { CONFIG_KV: kv } as unknown as Env;
}

describe('rateLimit', () => {
  it('allows up to the limit then blocks within the window', async () => {
    const env = fakeEnv();
    let last = await rateLimit(env, 'b', 'id', 3, 60);
    for (let i = 0; i < 2; i++) last = await rateLimit(env, 'b', 'id', 3, 60);
    expect(last.ok).toBe(true);
    const blocked = await rateLimit(env, 'b', 'id', 3, 60);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it('tracks identifiers independently', async () => {
    const env = fakeEnv();
    await rateLimit(env, 'b', 'a', 1, 60);
    expect((await rateLimit(env, 'b', 'z', 1, 60)).ok).toBe(true);
  });

  it('fails open when KV is unavailable', async () => {
    expect((await rateLimit({} as Env, 'b', 'id', 1, 60)).ok).toBe(true);
  });
});

describe('rateLimit auth-bucket same-isolate hardening', () => {
  beforeEach(() => {
    resetMemoryRateLimitForTests();
    // Pin the clock mid-window so a real window boundary can't flip counters
    // between calls within a test.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T00:10:30Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetMemoryRateLimitForTests();
  });

  /** KV that always reads stale (count 0) — the exact read-then-write race. */
  function staleKvEnv(): Env {
    return {
      CONFIG_KV: {
        get: async () => null,
        put: async () => {},
      },
    } as unknown as Env;
  }

  it('blocks a same-isolate burst on magic-ip even when every KV read is stale', async () => {
    const env = staleKvEnv();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => rateLimit(env, 'magic-ip', '1.2.3.4', 3, 600)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    const blocked = results.filter((r) => !r.ok);
    expect(blocked).toHaveLength(2);
    for (const b of blocked) expect(b.retryAfterSec).toBeGreaterThan(0);
  });

  it('tracks magic-email identifiers independently in the memory counter', async () => {
    const env = staleKvEnv();
    expect((await rateLimit(env, 'magic-email', 'a@x.com', 1, 3600)).ok).toBe(true);
    expect((await rateLimit(env, 'magic-email', 'a@x.com', 1, 3600)).ok).toBe(false);
    expect((await rateLimit(env, 'magic-email', 'b@x.com', 1, 3600)).ok).toBe(true);
  });

  it('leaves non-auth buckets on pure KV behavior (fail open on stale reads)', async () => {
    const env = staleKvEnv();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => rateLimit(env, 'dummy-bucket', '1.2.3.4', 3, 60)),
    );
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('fails open on magic-ip when CONFIG_KV is entirely absent, regardless of prior in-memory count', async () => {
    // No CONFIG_KV binding at all. The memory gate must never turn a missing
    // binding into a 429, so every serial request stays fail-open even past
    // the nominal limit.
    const env = {} as Env;
    for (let i = 0; i < 10; i++) {
      expect((await rateLimit(env, 'magic-ip', '1.2.3.4', 1, 600)).ok).toBe(true);
    }
  });

  it('does not latch the memory block on magic-ip during a KV read outage', async () => {
    // Every KV read throws (outage). Serial magic-link retries during the
    // outage must all fail open — the in-memory admit is rolled back on the
    // read failure so the counter never latches at the limit and locks the
    // user out for the rest of the (600s) window.
    const env = {
      CONFIG_KV: {
        get: async () => {
          throw new Error('kv down');
        },
        put: async () => {},
      },
    } as unknown as Env;
    for (let i = 0; i < 10; i++) {
      expect((await rateLimit(env, 'magic-ip', '1.2.3.4', 3, 600)).ok).toBe(true);
    }
  });

  it('does not latch the memory block on magic-ip during a KV write outage', async () => {
    // Reads succeed (always stale 0) but every write throws. Serial retries must
    // stay fail-open — the memory admit is rolled back on the write failure so
    // the counter never latches at the limit.
    const env = {
      CONFIG_KV: {
        get: async () => null,
        put: async () => {
          throw new Error('kv write down');
        },
      },
    } as unknown as Env;
    for (let i = 0; i < 10; i++) {
      expect((await rateLimit(env, 'magic-ip', '1.2.3.4', 3, 600)).ok).toBe(true);
    }
  });
});

const CF_EDGE = '104.16.1.2';

function fromPeer(peer: string, headers: Record<string, string>): Request {
  return stampTcpPeer(new Request('https://x', { headers }), peer);
}

describe('clientIp', () => {
  it('ignores cf-connecting-ip unless the socket peer is Cloudflare', () => {
    const spoofed = new Request('https://x', { headers: { 'cf-connecting-ip': '1.2.3.4' } });
    expect(clientIp(spoofed)).toBe('unknown');
    expect(clientIp(fromPeer(CF_EDGE, { 'cf-connecting-ip': '1.2.3.4' }))).toBe('1.2.3.4');
  });

  it('prefers cf-connecting-ip over client-supplied forwarding headers once the peer is Cloudflare', () => {
    const req = fromPeer(CF_EDGE, {
      'cf-connecting-ip': '1.2.3.4',
      'x-real-ip': '6.6.6.6',
      'x-forwarded-for': '6.6.6.6, 7.7.7.7',
    });
    // A spoofable header must never override the edge-asserted IP, otherwise a
    // client rotating x-forwarded-for values chooses its own rate-limit key.
    expect(clientIp(req)).toBe('1.2.3.4');
  });

  it('uses x-real-ip from a trusted proxy and ignores x-forwarded-for when the peer is not Cloudflare', () => {
    const req = fromPeer('127.0.0.1', {
      'x-real-ip': '9.9.9.9',
      'x-forwarded-for': '6.6.6.6',
      'cf-connecting-ip': '1.2.3.4',
    });
    expect(clientIp(req)).toBe('9.9.9.9');
  });

  it('uses the LAST x-forwarded-for hop when the socket peer is Cloudflare', () => {
    const req = fromPeer(CF_EDGE, {
      'x-forwarded-for': 'spoofed-by-client, 10.0.0.1',
    });
    expect(clientIp(req)).toBe('10.0.0.1');
    const unstamped = new Request('https://x', {
      headers: { 'x-forwarded-for': 'spoofed-by-client, 10.0.0.1' },
    });
    expect(clientIp(unstamped)).toBe('unknown');
  });

  it('ignores empty x-forwarded-for entries', () => {
    const req = fromPeer(CF_EDGE, { 'x-forwarded-for': ' , ,10.0.0.2, ' });
    expect(clientIp(req)).toBe('10.0.0.2');
  });

  it('falls back to "unknown" with no proxy headers', () => {
    expect(clientIp(new Request('https://x'))).toBe('unknown');
  });
});
