import { describe, expect, it } from 'vitest';
import {
  isSenateRelayUnreachable,
  senateRelayAuthHeaders,
  senateRelayHost,
  senateRelayBaseUrl,
} from '../senateRelayHealth.ts';

describe('isSenateRelayUnreachable', () => {
  it('treats Cloudflare origin-down statuses as unreachable', () => {
    expect(isSenateRelayUnreachable(new Response('', { status: 502 }))).toBe(true);
    expect(isSenateRelayUnreachable(new Response('', { status: 503 }))).toBe(true);
    expect(isSenateRelayUnreachable(new Response('', { status: 524 }))).toBe(true);
  });

  it('does not treat mirrored upstream statuses as unreachable (#1610)', () => {
    expect(isSenateRelayUnreachable(new Response('', { status: 404 }))).toBe(false);
    expect(isSenateRelayUnreachable(new Response('', { status: 403 }))).toBe(false);
    expect(isSenateRelayUnreachable(new Response('', { status: 400 }))).toBe(false);
    expect(isSenateRelayUnreachable(new Response('ok', { status: 200 }))).toBe(false);
  });

  it('does not treat 401 as unreachable (misconfigured relay secret)', () => {
    expect(isSenateRelayUnreachable(new Response('', { status: 401 }))).toBe(false);
  });
});

describe('senateRelay URL helpers', () => {
  it('strips a trailing slash and extracts the host', () => {
    expect(senateRelayBaseUrl('https://scout.jays.services/')).toBe('https://scout.jays.services');
    expect(senateRelayHost('https://scout.jays.services/')).toBe('scout.jays.services');
  });

  it('returns undefined/null when unset', () => {
    expect(senateRelayBaseUrl(undefined)).toBeUndefined();
    expect(senateRelayHost('')).toBeNull();
  });
});

describe('senateRelayAuthHeaders', () => {
  it('omits Authorization when the secret is blank', () => {
    expect(senateRelayAuthHeaders(undefined)).toEqual({});
    expect(senateRelayAuthHeaders('  ')).toEqual({});
  });

  it('sends a Bearer token when set', () => {
    expect(senateRelayAuthHeaders('abc')).toEqual({ authorization: 'Bearer abc' });
  });
});
