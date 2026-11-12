import { describe, it, expect } from 'vitest';
import {
  generateCodeVerifier,
  generateCodeChallenge,
  buildXAuthUrl,
  exchangeXCode,
  fetchXProfile,
} from '../x.ts';
import type { Env } from '../../shared/types.ts';

const env = {
  X_OAUTH_CLIENT_ID: 'x_cid',
  X_OAUTH_CLIENT_SECRET: 'x_secret',
} as unknown as Env;

describe('generateCodeVerifier and generateCodeChallenge', () => {
  it('generates a valid verifier and challenge pair', async () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    const challenge = await generateCodeChallenge(verifier);
    expect(challenge).not.toBe(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('buildXAuthUrl', () => {
  it('includes client_id, redirect_uri, scope, state, code_challenge, code_challenge_method', async () => {
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    const url = new URL(await buildXAuthUrl(env, 'https://app/auth/x/callback', 'st8', challenge));
    expect(url.origin + url.pathname).toBe('https://twitter.com/i/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('x_cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app/auth/x/callback');
    expect(url.searchParams.get('scope')).toBe('tweet.read users.read offline.access');
    expect(url.searchParams.get('state')).toBe('st8');
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('throws when the client id is missing', async () => {
    await expect(buildXAuthUrl({} as unknown as Env, 'x', 's', 'c')).rejects.toThrow();
  });
});

describe('exchangeXCode', () => {
  it('returns the access token on success', async () => {
    const fetchImpl = (async (url: string, init: RequestInit) => {
      expect(init.headers).toHaveProperty('authorization');
      expect((init.headers as Record<string, string>)['authorization']).toMatch(/^Basic /);
      return new Response(JSON.stringify({ access_token: 'X_AT' }), { status: 200 });
    }) as unknown as typeof fetch;

    expect(await exchangeXCode(env, 'code', 'https://app/auth/x/callback', 'verifier', fetchImpl)).toBe('X_AT');
  });

  it('throws on an error response', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad code' }), {
        status: 400,
      })) as unknown as typeof fetch;

    await expect(exchangeXCode(env, 'code', 'https://app/auth/x/callback', 'verifier', fetchImpl)).rejects.toThrow(
      /Bad code/,
    );
  });
});

describe('fetchXProfile', () => {
  it('maps X API v2 user data to XProfile', async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toContain('user.fields=profile_image_url');
      return new Response(
        JSON.stringify({
          data: {
            id: '12345',
            name: 'Trader Joe',
            username: 'traderjoe',
            profile_image_url: 'https://pbs.twimg.com/avatar.jpg',
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    expect(await fetchXProfile('X_AT', fetchImpl)).toEqual({
      sub: '12345',
      name: 'Trader Joe',
      username: 'traderjoe',
      picture: 'https://pbs.twimg.com/avatar.jpg',
    });
  });

  it('throws when profile data id is missing', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ errors: [{ message: 'User not found' }] }), {
        status: 404,
      })) as unknown as typeof fetch;

    await expect(fetchXProfile('X_AT', fetchImpl)).rejects.toThrow(/User not found/);
  });
});
