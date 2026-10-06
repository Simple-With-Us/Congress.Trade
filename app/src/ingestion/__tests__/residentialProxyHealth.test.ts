import { describe, expect, it, vi } from 'vitest';
import {
  probeResidentialProxyHealth,
  RESIDENTIAL_PROXY_CONNECT_PROBE_URL,
} from '../residentialProxyHealth.ts';

describe('probeResidentialProxyHealth', () => {
  it('returns unconfigured when no proxy URL is given', async () => {
    const result = await probeResidentialProxyHealth(undefined);
    expect(result.configured).toBe(false);
    expect(result.reachable).toBe(false);
  });

  it('returns reachable true when proxy responds with 200 JSON on /health (Mac daemon)', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) {
        return new Response(
          JSON.stringify({ ok: true, service: 'residential-proxy', uptime: 42 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await probeResidentialProxyHealth('http://100.113.106.39:3128', mockFetch);
    expect(result.configured).toBe(true);
    expect(result.reachable).toBe(true);
    expect(result.service).toBe('residential-proxy');
    expect(result.uptime).toBe(42);
    expect(result.status).toBe(200);
    expect(result.method).toBe('daemon-health');
  });

  it('falls back to CONNECT egress when /health is not a JSON daemon (tinyproxy)', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) {
        return new Response('Access denied', { status: 403 });
      }
      if (url === RESIDENTIAL_PROXY_CONNECT_PROBE_URL) {
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await probeResidentialProxyHealth('http://10.99.0.2:8888', mockFetch);
    expect(result.configured).toBe(true);
    expect(result.reachable).toBe(true);
    expect(result.method).toBe('connect');
    expect(result.status).toBe(200);
  });

  it('returns reachable false when CONNECT egress fails', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) {
        return new Response('nope', { status: 502 });
      }
      if (url === RESIDENTIAL_PROXY_CONNECT_PROBE_URL) {
        throw new Error('Connection refused');
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await probeResidentialProxyHealth('http://10.99.0.2:8888', mockFetch);
    expect(result.configured).toBe(true);
    expect(result.reachable).toBe(false);
    expect(result.method).toBe('connect');
    expect(result.error).toContain('Connection refused');
  });

  it('treats any CONNECT HTTP status as a live tunnel when /health is absent', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) {
        return new Response('Bad Gateway', { status: 502 });
      }
      if (url === RESIDENTIAL_PROXY_CONNECT_PROBE_URL) {
        return new Response(null, { status: 502 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await probeResidentialProxyHealth('http://10.99.0.2:8888', mockFetch);
    expect(result.configured).toBe(true);
    expect(result.reachable).toBe(true);
    expect(result.method).toBe('connect');
    expect(result.status).toBe(502);
  });
});
