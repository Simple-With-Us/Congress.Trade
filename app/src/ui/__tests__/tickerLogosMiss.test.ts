import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleTickerLogoRequest } from '../tickerLogos';

// A symbol no source can resolve: logo.dev is skipped (no token), the local
// pack has no entry, and the GitHub fallback is mocked to miss.
const MISS_URL = new URL('https://congress.trade/api/logos/ticker?symbol=ZZZZZZZZ');

describe('handleTickerLogoRequest miss path', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a cacheable 204 (not 404) when no logo source resolves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } })),
    );

    const res = await handleTickerLogoRequest(MISS_URL, undefined);

    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    expect(res.headers.get('cache-control') ?? '').toContain('public');
    expect(res.headers.get('cache-control') ?? '').toContain('max-age=');
  });
});
