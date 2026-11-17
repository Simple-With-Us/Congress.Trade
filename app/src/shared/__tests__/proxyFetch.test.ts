import { describe, expect, it, vi } from 'vitest';
import {
  createDirectFirstFetch,
  createProxiedFetch,
  DEFAULT_RESIDENTIAL_PROXY_URL,
  getDenoHttpClient,
  resolveResidentialProxyUrl,
} from '../proxyFetch.ts';

describe('proxyFetch', () => {
  it('returns baseFetch when no proxyUrl is provided', () => {
    const mockFetch = vi.fn() as unknown as typeof fetch;
    const fetcher = createProxiedFetch(undefined, mockFetch);
    expect(fetcher).toBe(mockFetch);
  });

  it('returns baseFetch when empty string is provided', () => {
    const mockFetch = vi.fn() as unknown as typeof fetch;
    const fetcher = createProxiedFetch('   ', mockFetch);
    expect(fetcher).toBe(mockFetch);
  });

  it('resolves proxy URL from various environment formats', () => {
    expect(
      resolveResidentialProxyUrl({ RESIDENTIAL_PROXY_URL: 'http://100.113.106.39:3128' }),
    ).toBe('http://100.113.106.39:3128');

    expect(
      resolveResidentialProxyUrl({ SENATE_PROXY_URL: 'http://100.113.106.39:8080' }),
    ).toBe('http://100.113.106.39:8080');

    expect(
      resolveResidentialProxyUrl({
        RESIDENTIAL_PROXY_URL: 'http://100.113.106.39:3128',
        SENATE_PROXY_URL: 'http://other:8080',
      }),
    ).toBe('http://100.113.106.39:3128');
    expect(
      resolveResidentialProxyUrl({
        RESIDENTIAL_PROXY_HOST: 'proxy.internal',
        RESIDENTIAL_PROXY_PORT: '8888',
        RESIDENTIAL_PROXY_USERNAME: 'user1',
        RESIDENTIAL_PROXY_PASSWORD: 'pass word',
      }),
    ).toBe('http://user1:pass%20word@proxy.internal:8888');

    expect(
      resolveResidentialProxyUrl({
        RESIDENTIAL_PROXY_HOST: 'proxy.internal',
        RESIDENTIAL_PROXY_PORT: 8080,
      }),
    ).toBe('http://proxy.internal:8080');
  });

  it('returns the Mango default if no proxy url or host is set', () => {
    // The Mango HTTP CONNECT proxy on the WireGuard mesh is the only
    // residential-IP bounce in the fleet since the Mac residential-proxy
    // retired (board `ab688ea5`).  Falling back to it keeps the FMP
    // latency probe + Senate/House scrapers from running datacentred
    // when an env was missed at deploy time.
    expect(resolveResidentialProxyUrl({})).toBe(DEFAULT_RESIDENTIAL_PROXY_URL);
    expect(resolveResidentialProxyUrl({ RESIDENTIAL_PROXY_PORT: '8888' })).toBe(DEFAULT_RESIDENTIAL_PROXY_URL);
  });

  it('refuses direct egress in a Deno runtime when the proxy client cannot be created', async () => {
    const url = 'http://proxy-egress-guard.internal:8888';
    vi.stubGlobal('Deno', {
      createHttpClient: () => {
        throw new Error('client boom');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mockFetch = vi.fn().mockResolvedValue(new Response('direct', { status: 200 }));
    try {
      const fetcher = createProxiedFetch(url, mockFetch as unknown as typeof fetch);
      await expect(fetcher('http://example.com/')).rejects.toThrow(/refusing to fall back to direct egress/);
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  describe('createDirectFirstFetch', () => {
    const stubDenoClient = () =>
      vi.stubGlobal('Deno', { createHttpClient: () => ({ fakeClient: true }) });

    it('returns baseFetch when no proxyUrl is provided', () => {
      const mockFetch = vi.fn() as unknown as typeof fetch;
      expect(createDirectFirstFetch(undefined, mockFetch)).toBe(mockFetch);
      expect(createDirectFirstFetch('   ', mockFetch)).toBe(mockFetch);
    });

    it('returns the direct response without touching the proxy when direct succeeds', async () => {
      stubDenoClient();
      try {
        const mockFetch = vi.fn().mockResolvedValue(new Response('direct', { status: 200 }));
        const fetcher = createDirectFirstFetch(
          'http://proxy-direct-first-ok.internal:8888',
          mockFetch as unknown as typeof fetch,
        );
        const res = await fetcher('http://example.com/doc.pdf');
        expect(res.status).toBe(200);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch.mock.calls[0][1]?.client).toBeUndefined();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('retries via the residential proxy when the direct attempt never gets a response', async () => {
      stubDenoClient();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const mockFetch = vi.fn().mockImplementation((_input: unknown, init?: RequestInit & { client?: unknown }) => {
          if (init?.client) return Promise.resolve(new Response('via proxy', { status: 200 }));
          return Promise.reject(new Error('connect ECONNREFUSED 203.0.113.7:443'));
        });
        const fetcher = createDirectFirstFetch(
          'http://proxy-direct-first-fallback.internal:8888',
          mockFetch as unknown as typeof fetch,
        );
        const res = await fetcher('http://example.com/doc.pdf');
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('via proxy');
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch.mock.calls[1][1]?.client).toEqual({ fakeClient: true });
      } finally {
        warn.mockRestore();
        vi.unstubAllGlobals();
      }
    });

    it('never retries an aborted request via the proxy', async () => {
      stubDenoClient();
      try {
        const controller = new AbortController();
        controller.abort();
        const mockFetch = vi.fn().mockRejectedValue(new Error('The operation was aborted'));
        const fetcher = createDirectFirstFetch(
          'http://proxy-direct-first-abort.internal:8888',
          mockFetch as unknown as typeof fetch,
        );
        await expect(
          fetcher('http://example.com/doc.pdf', { signal: controller.signal }),
        ).rejects.toThrow(/aborted/);
        expect(mockFetch).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('returns an HTTP error response as-is instead of retrying via the proxy', async () => {
      stubDenoClient();
      try {
        const mockFetch = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
        const fetcher = createDirectFirstFetch(
          'http://proxy-direct-first-status.internal:8888',
          mockFetch as unknown as typeof fetch,
        );
        const res = await fetcher('http://example.com/doc.pdf');
        expect(res.status).toBe(500);
        expect(mockFetch).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  it('never logs proxy credentials when the Deno client cannot be created (CT-2442)', () => {
    const url = 'http://user1:s3cretpw@proxy-redact-test.internal:8888';
    vi.stubGlobal('Deno', {
      createHttpClient: () => {
        throw new Error(`invalid proxy url ${url}`);
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(getDenoHttpClient(url)).toBeUndefined();
      const logged = warn.mock.calls.flat().join(' ');
      expect(logged).toContain('proxy-redact-test.internal');
      expect(logged).not.toContain('s3cretpw');
      expect(logged).not.toContain('user1');
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
