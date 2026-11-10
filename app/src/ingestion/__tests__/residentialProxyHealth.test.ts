import { describe, expect, it, vi } from 'vitest';
import {
  probeResidentialProxyHealth,
  RESIDENTIAL_PROXY_PROBE_TARGET_URL,
} from '../residentialProxyHealth.ts';

describe('probeResidentialProxyHealth', () => {
  it('returns unconfigured when no proxy URL is given', async () => {
    const result = await probeResidentialProxyHealth(undefined);
    expect(result.configured).toBe(false);
    expect(result.reachable).toBe(false);
  });

  it('tunnels a GET to the probe target through the proxy (never GET {proxy}/health)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('<html>OK</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );

    const proxyUrl = 'http://100.113.106.39:3128';
    const result = await probeResidentialProxyHealth(proxyUrl, mockFetch);
    expect(result.configured).toBe(true);
    expect(result.reachable).toBe(true);
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const requestedUrl = String(mockFetch.mock.calls[0][0]);
    expect(requestedUrl).toBe(RESIDENTIAL_PROXY_PROBE_TARGET_URL);
    expect(requestedUrl).not.toContain('/health');
    expect(requestedUrl).not.toContain(proxyUrl);
  });

  it('treats any HTTP status from the tunneled request as reachable (proxy spoke)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('Bad Gateway', { status: 502 }),
    );

    const result = await probeResidentialProxyHealth('http://100.113.106.39:3128', mockFetch);
    expect(result.configured).toBe(true);
    expect(result.reachable).toBe(true);
    expect(result.status).toBe(502);
  });

  it('handles network error / timeout gracefully', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const result = await probeResidentialProxyHealth('http://100.113.106.39:3128', mockFetch);
    expect(result.configured).toBe(true);
    expect(result.reachable).toBe(false);
    expect(result.error).toContain('Connection refused');
  });
});
