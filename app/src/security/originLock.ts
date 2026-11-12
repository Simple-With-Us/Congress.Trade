/**
 * Request-level origin lock (CT-1337).
 *
 * Production Deno listens on loopback / the docker bridge. Traefik is the TCP
 * peer, and Cloudflare is the peer Traefik accepted. A client who can reach
 * Traefik directly can otherwise spoof CF-Connecting-IP and X-Forwarded-For
 * and skip the edge. This module allows a request when one of these is true:
 *
 *   - the socket peer is in Cloudflare's published ranges, or
 *   - the socket peer is a trusted proxy (loopback, RFC1918, or an operator
 *     CIDR) and that proxy's asserted client (X-Real-IP, else the rightmost
 *     X-Forwarded-For hop) is in those ranges, or
 *   - the shared origin secret header matches ORIGIN_LOCK_SECRET, or
 *   - a trusted proxy asserts Authenticated Origin Pulls via the configured
 *     header (the proxy must set it only after verifying Cloudflare's client
 *     certificate, and must strip any client-supplied copy).
 *
 * GET/HEAD /health and /api/health from a loopback or private peer stay open
 * so the in-container Docker wget and Traefik's docker-network probe keep
 * working. A missing socket peer is not a health exemption. The gate is off
 * unless ORIGIN_LOCK_ENABLED is truthy, so a merge does not change traffic.
 *
 * Deno.serve must call stampTcpPeer before the app reads the request. The
 * header is overwritten from the socket address; a client-supplied value does
 * not survive that call.
 */

import type { MiddlewareHandler } from 'hono';
import type { Env } from '../shared/types.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { cloudflareCidrs } from './cloudflareRanges.ts';
import { formatIp, ipInAnyCidr, parseIp, type ParsedIp } from './ip.ts';

export const TCP_PEER_HEADER = 'x-ct-tcp-peer';
export const ORIGIN_SECRET_HEADER = 'x-ct-origin-secret';
/** Set only by the retired Workers entry when `request.cf` is present. */
export const EDGE_RUNTIME_HEADER = 'x-ct-edge-runtime';

const DEFAULT_TRUSTED_PROXY_CIDRS = [
  '127.0.0.0/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
  'fe80::/10',
] as const;

export interface OriginLockEnv {
  ORIGIN_LOCK_ENABLED?: string;
  ORIGIN_LOCK_SECRET?: string;
  ORIGIN_LOCK_TRUSTED_PROXIES?: string;
  ORIGIN_LOCK_AOP_HEADER?: string;
  ORIGIN_LOCK_AOP_VALUE?: string;
}

export interface OriginLockConfig {
  enabled: boolean;
  secret: string;
  extraProxies: readonly string[];
  aopHeader: string;
  aopValue: string;
}

export type OriginLockReason =
  | 'disabled'
  | 'health'
  | 'cloudflare_peer'
  | 'cloudflare_via_proxy'
  | 'shared_secret'
  | 'authenticated_origin_pull'
  | 'rejected';

export interface OriginInspection {
  allow: boolean;
  viaCloudflare: boolean;
  reason: OriginLockReason;
  clientIp: string;
}

type ViaReason = Exclude<OriginLockReason, 'disabled' | 'health' | 'rejected'>;

const viaCloudflareByRequest = new WeakMap<Request, boolean>();

export function isCloudflareIp(raw: string | null | undefined): boolean {
  const ip = parseIp(raw);
  return ip !== null && ipInAnyCidr(ip, cloudflareCidrs());
}

export function stampTcpPeer(req: Request, peer: string | null | undefined): Request {
  const headers = new Headers(req.headers);
  headers.delete(TCP_PEER_HEADER);
  headers.delete(EDGE_RUNTIME_HEADER);
  const parsed = parseIp(peer);
  if (parsed) headers.set(TCP_PEER_HEADER, formatIp(parsed));
  return new Request(req, { headers });
}

/**
 * Retired Workers/preview entry. There is no TCP peer. Drop a client-supplied
 * peer or edge header. When the runtime attached `request.cf`, the isolate is
 * on Cloudflare, so mark the request and let `CF-Connecting-IP` identify the
 * visitor. Without `request.cf` the headers stay untrusted.
 */
export function stampWorkersEdge(req: Request): Request {
  const stripped = stampTcpPeer(req, undefined);
  const cf = (req as Request & { cf?: unknown }).cf;
  if (!cf || typeof cf !== 'object') return stripped;
  const headers = new Headers(stripped.headers);
  headers.set(EDGE_RUNTIME_HEADER, 'cloudflare');
  return new Request(stripped, { headers });
}

export function configFromEnv(env?: OriginLockEnv): OriginLockConfig {
  const aopValue = (env?.ORIGIN_LOCK_AOP_VALUE ?? '').trim();
  return {
    enabled: truthy(env?.ORIGIN_LOCK_ENABLED),
    secret: (env?.ORIGIN_LOCK_SECRET ?? '').trim(),
    extraProxies: splitList(env?.ORIGIN_LOCK_TRUSTED_PROXIES),
    aopHeader: (env?.ORIGIN_LOCK_AOP_HEADER ?? '').trim().toLowerCase(),
    aopValue: aopValue || 'SUCCESS',
  };
}

export function inspectOrigin(req: Request, config: OriginLockConfig): OriginInspection {
  const peer = readPeer(req);
  const via = classifyVia(req, peer, config);
  const clientIp = selectClientIp(req, peer, via !== null, config);
  if (!config.enabled) {
    return { allow: true, viaCloudflare: via !== null, reason: 'disabled', clientIp };
  }
  if (isHealthExemption(req, peer, config)) {
    return { allow: true, viaCloudflare: false, reason: 'health', clientIp };
  }
  if (via) {
    return { allow: true, viaCloudflare: true, reason: via, clientIp };
  }
  return { allow: false, viaCloudflare: false, reason: 'rejected', clientIp };
}

export function clientIpFromOrigin(req: Request, env?: OriginLockEnv): string {
  const config = configFromEnv(env);
  const remembered = viaCloudflareByRequest.get(req);
  if (remembered === undefined) return inspectOrigin(req, config).clientIp;
  return selectClientIp(req, readPeer(req), remembered, config);
}

export function rememberViaCloudflare(req: Request, via: boolean): void {
  viaCloudflareByRequest.set(req, via);
}

export const originLockMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const config = await loadConfig(c.env);
  const decision = inspectOrigin(c.req.raw, config);
  rememberViaCloudflare(c.req.raw, decision.viaCloudflare);
  if (decision.allow) {
    await next();
    return;
  }
  console.warn(
    `origin lock rejected ${c.req.method} ${pathname(c.req.raw)} reason=${decision.reason} peer=${readPeerText(c.req.raw) ?? 'none'}`,
  );
  return c.json({ error: 'direct origin access is not allowed' }, 403, {
    'cache-control': 'no-store',
  });
};

async function loadConfig(env: Env): Promise<OriginLockConfig> {
  const [enabled, secret, proxies, aopHeader, aopValue] = await Promise.all([
    resolveSecret(env, 'ORIGIN_LOCK_ENABLED'),
    resolveSecret(env, 'ORIGIN_LOCK_SECRET'),
    resolveSecret(env, 'ORIGIN_LOCK_TRUSTED_PROXIES'),
    resolveSecret(env, 'ORIGIN_LOCK_AOP_HEADER'),
    resolveSecret(env, 'ORIGIN_LOCK_AOP_VALUE'),
  ]);
  return configFromEnv({
    ORIGIN_LOCK_ENABLED: enabled.value,
    ORIGIN_LOCK_SECRET: secret.value,
    ORIGIN_LOCK_TRUSTED_PROXIES: proxies.value,
    ORIGIN_LOCK_AOP_HEADER: aopHeader.value,
    ORIGIN_LOCK_AOP_VALUE: aopValue.value,
  });
}

function classifyVia(req: Request, peer: ParsedIp | null, config: OriginLockConfig): ViaReason | null {
  if (req.headers.get(EDGE_RUNTIME_HEADER) === 'cloudflare') return 'cloudflare_peer';
  if (peer && isCloudflareParsed(peer)) return 'cloudflare_peer';
  const asserted = proxyAsserted(req, peer, config);
  if (asserted && isCloudflareParsed(asserted)) return 'cloudflare_via_proxy';
  if (secretsMatch(config.secret, req.headers.get(ORIGIN_SECRET_HEADER) ?? '')) return 'shared_secret';
  if (originPullAsserted(req, peer, config)) return 'authenticated_origin_pull';
  return null;
}

function selectClientIp(req: Request, peer: ParsedIp | null, via: boolean, config: OriginLockConfig): string {
  if (via) {
    const cf = headerIp(req, 'cf-connecting-ip');
    if (cf) return formatIp(cf);
    const visitor = visitorFromForwarded(req);
    if (visitor) return formatIp(visitor);
    return 'unknown';
  }
  if (peer && isTrustedProxy(peer, config)) {
    // Same proxy-asserted address as the Cloudflare check: X-Real-IP, else the
    // rightmost X-Forwarded-For hop. The client-supplied prefix is not used.
    const asserted = proxyAsserted(req, peer, config);
    return asserted ? formatIp(asserted) : 'unknown';
  }
  return peer ? formatIp(peer) : 'unknown';
}

function isHealthExemption(req: Request, peer: ParsedIp | null, config: OriginLockConfig): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const path = pathname(req);
  if (path !== '/health' && path !== '/api/health') return false;
  return peer !== null && isTrustedProxy(peer, config);
}

function proxyAsserted(req: Request, peer: ParsedIp | null, config: OriginLockConfig): ParsedIp | null {
  if (!peer || !isTrustedProxy(peer, config)) return null;
  return headerIp(req, 'x-real-ip') ?? rightmost(forwardedIps(req));
}

function originPullAsserted(req: Request, peer: ParsedIp | null, config: OriginLockConfig): boolean {
  if (!config.aopHeader || !peer) return false;
  if (!isTrustedProxy(peer, config) && !isCloudflareParsed(peer)) return false;
  return (req.headers.get(config.aopHeader) ?? '').trim() === config.aopValue;
}

function visitorFromForwarded(req: Request): ParsedIp | null {
  const hops = forwardedIps(req);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    if (!hop || isCloudflareParsed(hop)) continue;
    return hop;
  }
  return null;
}

function forwardedIps(req: Request): ParsedIp[] {
  const raw = req.headers.get('x-forwarded-for') ?? '';
  const hops: ParsedIp[] = [];
  for (const part of raw.split(',')) {
    const ip = parseIp(part);
    if (ip) hops.push(ip);
  }
  return hops;
}

function headerIp(req: Request, name: string): ParsedIp | null {
  return parseIp(req.headers.get(name));
}

function readPeer(req: Request): ParsedIp | null {
  return parseIp(req.headers.get(TCP_PEER_HEADER));
}

function readPeerText(req: Request): string | null {
  const peer = readPeer(req);
  return peer ? formatIp(peer) : null;
}

function isCloudflareParsed(ip: ParsedIp): boolean {
  return ipInAnyCidr(ip, cloudflareCidrs());
}

function isTrustedProxy(ip: ParsedIp, config: OriginLockConfig): boolean {
  return ipInAnyCidr(ip, DEFAULT_TRUSTED_PROXY_CIDRS) || ipInAnyCidr(ip, config.extraProxies);
}

function rightmost(hops: readonly ParsedIp[]): ParsedIp | null {
  return hops.length > 0 ? hops[hops.length - 1] : null;
}

function pathname(req: Request): string {
  try {
    let path = new URL(req.url).pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return path;
  } catch {
    return '/';
  }
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(/[\s,]+/).map((part) => part.trim()).filter((part) => part.length > 0);
}

function truthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? '').trim());
}

function secretsMatch(expected: string, provided: string): boolean {
  if (!expected) return false;
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(provided.trim());
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
