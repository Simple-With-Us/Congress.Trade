import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../shared/types.ts';
import { clientIp } from '../../shared/rateLimit.ts';
import {
  ORIGIN_SECRET_HEADER,
  TCP_PEER_HEADER,
  inspectOrigin,
  isCloudflareIp,
  originLockMiddleware,
  stampTcpPeer,
} from '../originLock.ts';

const CF_EDGE = '104.16.1.2';
const VISITOR = '203.0.113.9';
const ATTACKER = '198.51.100.10';
const PROXY = '172.18.0.3';
const SECRET = 'origin-lock-test-secret';

function request(
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Request {
  return new Request(`http://app.local${path}`, { method, headers });
}

function peer(req: Request, ip: string): Request {
  return stampTcpPeer(req, ip);
}

describe('cloudflare published ranges', () => {
  it('matches a current edge address and rejects documentation and resolver addresses', () => {
    expect(isCloudflareIp(CF_EDGE)).toBe(true);
    expect(isCloudflareIp('104.16.0.0')).toBe(true);
    expect(isCloudflareIp('104.23.255.255')).toBe(true);
    expect(isCloudflareIp('104.15.255.255')).toBe(false);
    expect(isCloudflareIp('104.28.0.1')).toBe(false);
    expect(isCloudflareIp('8.8.8.8')).toBe(false);
    expect(isCloudflareIp('203.0.113.1')).toBe(false);
    expect(isCloudflareIp('2606:4700::1')).toBe(true);
    expect(isCloudflareIp('2400:cb00::1')).toBe(true);
    expect(isCloudflareIp('2001:db8::1')).toBe(false);
    expect(isCloudflareIp('::ffff:104.16.1.2')).toBe(true);
  });
});

describe('stampTcpPeer', () => {
  it('replaces a client-supplied peer header with the socket address', () => {
    const stamped = stampTcpPeer(
      request('/api/transactions', { [TCP_PEER_HEADER]: CF_EDGE }),
      PROXY,
    );
    expect(stamped.headers.get(TCP_PEER_HEADER)).toBe(PROXY);
  });

  it('drops the header when the socket address is missing', () => {
    const stamped = stampTcpPeer(
      request('/api/transactions', { [TCP_PEER_HEADER]: CF_EDGE }),
      undefined,
    );
    expect(stamped.headers.get(TCP_PEER_HEADER)).toBeNull();
  });
});

describe('inspectOrigin', () => {
  const enabled = { enabled: true, secret: '', extraProxies: [], aopHeader: '', aopValue: 'SUCCESS' };

  it('allows every peer when the flag is off', () => {
    const decision = inspectOrigin(peer(request('/api/transactions'), ATTACKER), {
      ...enabled,
      enabled: false,
    });
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe('disabled');
  });

  it('rejects a direct public peer when the flag is on', () => {
    const decision = inspectOrigin(
      peer(request('/api/transactions', { 'cf-connecting-ip': VISITOR }), ATTACKER),
      enabled,
    );
    expect(decision.allow).toBe(false);
    expect(decision.viaCloudflare).toBe(false);
    expect(decision.clientIp).toBe(ATTACKER);
  });

  it('allows a socket peer that is itself a Cloudflare edge', () => {
    const decision = inspectOrigin(
      peer(request('/api/transactions', { 'cf-connecting-ip': VISITOR }), CF_EDGE),
      enabled,
    );
    expect(decision.allow).toBe(true);
    expect(decision.viaCloudflare).toBe(true);
    expect(decision.reason).toBe('cloudflare_peer');
    expect(decision.clientIp).toBe(VISITOR);
  });

  it('allows a trusted proxy only when the proxy-asserted peer is Cloudflare', () => {
    const allowed = inspectOrigin(
      peer(request('/api/transactions', {
        'x-real-ip': CF_EDGE,
        'cf-connecting-ip': VISITOR,
        'x-forwarded-for': `${ATTACKER}, ${VISITOR}`,
      }), PROXY),
      enabled,
    );
    expect(allowed.allow).toBe(true);
    expect(allowed.reason).toBe('cloudflare_via_proxy');
    expect(allowed.clientIp).toBe(VISITOR);

    const spoofed = inspectOrigin(
      peer(request('/api/transactions', {
        'x-real-ip': ATTACKER,
        'cf-connecting-ip': VISITOR,
        'x-forwarded-for': `${VISITOR}, ${CF_EDGE}`,
      }), PROXY),
      enabled,
    );
    expect(spoofed.allow).toBe(false);
    expect(spoofed.clientIp).toBe(ATTACKER);
  });

  it('uses the rightmost forwarded hop as the proxy peer when x-real-ip is absent', () => {
    const decision = inspectOrigin(
      peer(request('/api/transactions', {
        'x-forwarded-for': `${ATTACKER}, ${CF_EDGE}`,
        'cf-connecting-ip': VISITOR,
      }), '127.0.0.1'),
      enabled,
    );
    expect(decision.allow).toBe(true);
    expect(decision.clientIp).toBe(VISITOR);
  });

  it('allows a matching origin secret from a non-Cloudflare peer', () => {
    const decision = inspectOrigin(
      peer(request('/api/transactions', {
        [ORIGIN_SECRET_HEADER]: SECRET,
        'cf-connecting-ip': VISITOR,
      }), ATTACKER),
      { ...enabled, secret: SECRET },
    );
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe('shared_secret');
    expect(decision.viaCloudflare).toBe(true);
    expect(decision.clientIp).toBe(VISITOR);
  });

  it('rejects a wrong or empty origin secret', () => {
    const wrong = inspectOrigin(
      peer(request('/api/transactions', { [ORIGIN_SECRET_HEADER]: 'nope' }), ATTACKER),
      { ...enabled, secret: SECRET },
    );
    expect(wrong.allow).toBe(false);
    const blank = inspectOrigin(
      peer(request('/api/transactions', { [ORIGIN_SECRET_HEADER]: '' }), ATTACKER),
      { ...enabled, secret: '' },
    );
    expect(blank.allow).toBe(false);
  });

  it('honors an authenticated-origin-pull header only from a trusted proxy', () => {
    const config = { ...enabled, aopHeader: 'x-ct-origin-mtls', aopValue: 'SUCCESS' };
    const fromProxy = inspectOrigin(
      peer(request('/api/transactions', {
        'x-ct-origin-mtls': 'SUCCESS',
        'x-real-ip': ATTACKER,
        'cf-connecting-ip': VISITOR,
      }), PROXY),
      config,
    );
    expect(fromProxy.allow).toBe(true);
    expect(fromProxy.reason).toBe('authenticated_origin_pull');
    expect(fromProxy.clientIp).toBe(VISITOR);

    const direct = inspectOrigin(
      peer(request('/api/transactions', {
        'x-ct-origin-mtls': 'SUCCESS',
        'cf-connecting-ip': VISITOR,
      }), ATTACKER),
      config,
    );
    expect(direct.allow).toBe(false);
    expect(direct.clientIp).toBe(ATTACKER);
  });

  it('exempts loopback and docker-network health probes and not public ones', () => {
    for (const path of ['/health', '/api/health', '/health/', '/api/health/?ready=1']) {
      const decision = inspectOrigin(peer(request(path), path.includes('api') ? '127.0.0.1' : PROXY), enabled);
      expect(decision.allow).toBe(true);
      expect(decision.reason).toBe('health');
    }
    const head = inspectOrigin(peer(request('/health', {}, 'HEAD'), '::1'), enabled);
    expect(head.allow).toBe(true);
    const publicHealth = inspectOrigin(peer(request('/api/health'), ATTACKER), enabled);
    expect(publicHealth.allow).toBe(false);
    const post = inspectOrigin(peer(request('/health', {}, 'POST'), '127.0.0.1'), enabled);
    expect(post.allow).toBe(false);
    const mac = inspectOrigin(peer(request('/api/health/mac'), '127.0.0.1'), enabled);
    expect(mac.allow).toBe(false);
    const unstamped = inspectOrigin(request('/api/health'), enabled);
    expect(unstamped.allow).toBe(false);
  });

  it('accepts an operator-supplied trusted proxy CIDR', () => {
    const decision = inspectOrigin(
      peer(request('/api/transactions', {
        'x-real-ip': CF_EDGE,
        'cf-connecting-ip': VISITOR,
      }), '203.0.113.50'),
      { ...enabled, extraProxies: ['203.0.113.50/32'] },
    );
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe('cloudflare_via_proxy');
  });
});

describe('clientIp header trust', () => {
  it('ignores cf-connecting-ip and x-forwarded-for when no socket peer is stamped', () => {
    const req = request('/api/transactions', {
      'cf-connecting-ip': VISITOR,
      'x-real-ip': ATTACKER,
      'x-forwarded-for': `1.1.1.1, ${CF_EDGE}`,
    });
    expect(clientIp(req)).toBe('unknown');
  });

  it('uses cf-connecting-ip only after the socket peer is Cloudflare', () => {
    const req = peer(request('/api/transactions', {
      'cf-connecting-ip': VISITOR,
      'x-forwarded-for': `${ATTACKER}, 9.9.9.9`,
    }), CF_EDGE);
    expect(clientIp(req)).toBe(VISITOR);
  });

  it('uses the last forwarded visitor hop when Cloudflare did not send cf-connecting-ip', () => {
    const req = peer(request('/api/transactions', {
      'x-forwarded-for': `spoofed-by-client, ${VISITOR}`,
    }), CF_EDGE);
    expect(clientIp(req)).toBe(VISITOR);
  });

  it('keys a direct non-cloudflare peer on the socket address', () => {
    const req = peer(request('/api/transactions', {
      'cf-connecting-ip': VISITOR,
      'x-real-ip': '9.9.9.9',
      'x-forwarded-for': '1.1.1.1, 10.0.0.1',
    }), ATTACKER);
    expect(clientIp(req)).toBe(ATTACKER);
  });

  it('keys a trusted proxy that is not Cloudflare on x-real-ip, not the spoofed edge headers', () => {
    const req = peer(request('/api/transactions', {
      'x-real-ip': ATTACKER,
      'cf-connecting-ip': VISITOR,
      'x-forwarded-for': `${VISITOR}, ${CF_EDGE}`,
    }), PROXY);
    expect(clientIp(req)).toBe(ATTACKER);
  });
});

describe('originLockMiddleware', () => {
  function app(): Hono<{ Bindings: Env }> {
    const hono = new Hono<{ Bindings: Env }>();
    hono.use('*', originLockMiddleware);
    hono.all('*', (c) => c.json({ ok: true, ip: clientIp(c.req.raw, c.env) }));
    return hono;
  }

  it('stays open when the flag is unset', async () => {
    const res = await app().request(
      peer(request('/api/transactions', { 'cf-connecting-ip': VISITOR }), ATTACKER),
      undefined,
      {} as Env,
    );
    expect(res.status).toBe(200);
  });

  it('returns 403 for a direct origin hit and 200 for a Cloudflare peer when enabled', async () => {
    const env = { ORIGIN_LOCK_ENABLED: 'true' } as Env;
    const denied = await app().request(
      peer(request('/api/transactions', { 'cf-connecting-ip': VISITOR }), ATTACKER),
      undefined,
      env,
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get('cache-control')).toBe('no-store');
    const body = await denied.json() as { error: string };
    expect(body.error).toBe('direct origin access is not allowed');
    expect(JSON.stringify(body)).not.toContain(SECRET);

    const allowed = await app().request(
      peer(request('/api/transactions', { 'cf-connecting-ip': VISITOR }), CF_EDGE),
      undefined,
      env,
    );
    expect(allowed.status).toBe(200);
    const allowedBody = await allowed.json() as { ip: string };
    expect(allowedBody.ip).toBe(VISITOR);
  });

  it('keeps a loopback health probe working while the flag is on', async () => {
    const env = { ORIGIN_LOCK_ENABLED: 'true' } as Env;
    const res = await app().request(peer(request('/api/health'), '127.0.0.1'), undefined, env);
    expect(res.status).toBe(200);
  });

  it('accepts the shared secret from the environment', async () => {
    const env = { ORIGIN_LOCK_ENABLED: 'on', ORIGIN_LOCK_SECRET: SECRET } as Env;
    const res = await app().request(
      peer(request('/api/transactions', { [ORIGIN_SECRET_HEADER]: SECRET, 'cf-connecting-ip': VISITOR }), ATTACKER),
      undefined,
      env,
    );
    expect(res.status).toBe(200);
  });
});

describe('production wiring', () => {
  it('mounts the middleware and stamps the socket peer before the app sees the request', () => {
    const indexSrc = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
    const mainSrc = readFileSync(new URL('../../deno/main.ts', import.meta.url), 'utf8');
    expect(indexSrc).toContain('originLockMiddleware');
    expect(mainSrc).toContain('stampTcpPeer');
  });
});
