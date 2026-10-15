import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/thirdPartyTelemetry.ts', () => ({
  trackedFetch: (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    _descriptor: unknown,
    fetchImpl: typeof fetch = fetch,
  ) => fetchImpl(input, init),
}));
import { SENATE_SEARCH } from '../senateSource.ts';
import { probeSenateEfdLanding } from '../senateEfdHealth.ts';

describe('probeSenateEfdLanding', () => {
  it('records ok when the landing page returns 200', async () => {
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      expect(String(input)).toBe(SENATE_SEARCH);
      return new Response('<html>ok</html>', { status: 200 });
    };
    const rec = await probeSenateEfdLanding(fetchImpl, 1000);
    expect(rec.ok).toBe(true);
    expect(rec.status).toBe(200);
    expect(rec.egress).toBe('direct');
  });

  it('records failure on HTTP 403', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('blocked', { status: 403 });
    const rec = await probeSenateEfdLanding(fetchImpl, 1000);
    expect(rec.ok).toBe(false);
    expect(rec.status).toBe(403);
  });
});
