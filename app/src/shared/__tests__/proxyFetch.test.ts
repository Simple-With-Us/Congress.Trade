import { describe, expect, it, vi } from 'vitest';
import {
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
