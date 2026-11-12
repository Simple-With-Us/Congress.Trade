import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  APNS_ENDPOINTS,
  APNS_TOKEN_REFRESH_MS,
  apnsConfigured,
  buildApnsPayload,
  getApnsProviderToken,
  invalidateApnsProviderToken,
  loadApnsConfig,
  resolveApnsEnvironment,
  sendApnsPush,
  type ApnsConfig,
  type ApnsHttpRequest,
  type ApnsHttpResponse,
  type ApnsTransport,
} from './apns.ts';

const testKeyPem = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

const testConfig = (): ApnsConfig => ({
  keyId: 'P4US7YTWH4',
  teamId: 'CC8UTF7ATG',
  bundleId: 'trade.congress.ios',
  privateKeyPem: testKeyPem,
});

const hexToken = (seed: string) => Buffer.from(seed.padEnd(32, '0')).toString('hex').slice(0, 64);

beforeEach(() => {
  invalidateApnsProviderToken();
});

describe('loadApnsConfig', () => {
  it('accepts the APNS p8 env slot and defaults the Congress.Trade bundle', () => {
    const config = loadApnsConfig({
      APNS_KEY_ID: 'P4US7YTWH4',
      APNS_TEAM_ID: 'CC8UTF7ATG',
      APNS_P8: testKeyPem,
    });
    expect(apnsConfigured(config)).toBe(true);
    expect(config?.bundleId).toBe('trade.congress.ios');
  });

  it('is unconfigured when any required id is missing', () => {
    expect(
      loadApnsConfig({
        APNS_KEY_ID: '',
        APNS_TEAM_ID: 'CC8UTF7ATG',
        APNS_P8: testKeyPem,
      }),
    ).toBeNull();
  });
});

describe('resolveApnsEnvironment', () => {
  it('maps development tokens to sandbox; TestFlight stays production', () => {
    expect(resolveApnsEnvironment('development')).toBe('sandbox');
    expect(resolveApnsEnvironment('production')).toBe('production');
    expect(resolveApnsEnvironment(null)).toBe('production');
  });
});

describe('provider token', () => {
  it('reuses the jwt inside the refresh window', () => {
    const config = testConfig();
    const t0 = 1_700_000_000_000;
    const first = getApnsProviderToken(config, t0);
    expect(getApnsProviderToken(config, t0 + 19 * 60_000)).toBe(first);
    expect(APNS_TOKEN_REFRESH_MS).toBeLessThan(60 * 60_000);
    expect(getApnsProviderToken(config, t0 + APNS_TOKEN_REFRESH_MS + 1)).not.toBe(first);
  });
});

describe('sendApnsPush', () => {
  it('never opens Apple — transport is required in tests', async () => {
    const calls: ApnsHttpRequest[] = [];
    const transport: ApnsTransport = async (req) => {
      calls.push(req);
      return { status: 200, body: '' } satisfies ApnsHttpResponse;
    };
    const token = hexToken('ct');
    await sendApnsPush(
      {
        deviceToken: token,
        environment: 'production',
        title: 'Review needed',
        body: 'A filing needs review',
        collapseId: 'review-DOC1',
        data: { kind: 'review_needed', docId: 'DOC1' },
      },
      { config: testConfig(), transport },
    );
    expect(calls[0]?.origin).toBe(APNS_ENDPOINTS.production);
    expect(calls[0]?.path).toBe(`/3/device/${token}`);
    expect(calls[0]?.headers['apns-topic']).toBe('trade.congress.ios');
    const payload = JSON.parse(calls[0]!.body) as { aps: { alert: unknown }; kind: string };
    expect(payload.aps.alert).toEqual({ title: 'Review needed', body: 'A filing needs review' });
    expect(payload.kind).toBe('review_needed');
  });

  it('classifies 410 as a dead token and never throws on transport errors', async () => {
    const dead = await sendApnsPush(
      { deviceToken: hexToken('dead'), environment: 'production', title: 't', body: 'b' },
      {
        config: testConfig(),
        transport: async () => ({ status: 410, body: JSON.stringify({ reason: 'Unregistered' }) }),
      },
    );
    expect(dead.disposition).toBe('token_dead');
    const boom = await sendApnsPush(
      { deviceToken: hexToken('boom'), environment: 'sandbox', title: 't', body: 'b' },
      {
        config: testConfig(),
        transport: async () => {
          throw new Error('no socket');
        },
      },
    );
    expect(boom.disposition).toBe('retryable');
    expect(boom.error).toContain('no socket');
  });
});

describe('buildApnsPayload', () => {
  it('keeps the alert inside aps', () => {
    expect(buildApnsPayload({ title: 'T', body: 'B' })).toMatchObject({
      aps: { alert: { title: 'T', body: 'B' } },
    });
  });
});
