import { describe, expect, it } from 'vitest';
import {
  buildRestRouter,
  documentPdfGateWantsJson,
  documentPdfUpgradePayload,
} from '../rest.ts';
import { issueDeviceEntitlementToken } from '../../billing/deviceEntitlement.ts';
import type { Env } from '../../shared/types.ts';

const TEST_DEVICE_ENTITLEMENT_SECRET = 'test-device-entitlement-secret';

describe('documentPdfGateWantsJson', () => {
  it('is true for Bearer and for Accept: application/pdf', () => {
    expect(documentPdfGateWantsJson({ authorization: 'Bearer abc' })).toBe(true);
    expect(documentPdfGateWantsJson({ accept: 'application/pdf' })).toBe(true);
    expect(documentPdfGateWantsJson({
      authorization: 'Bearer abc',
      accept: 'application/pdf',
    })).toBe(true);
  });

  it('is false for a browser HTML navigation without Bearer', () => {
    expect(documentPdfGateWantsJson({
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    })).toBe(false);
    expect(documentPdfGateWantsJson({})).toBe(false);
  });
});

interface AnonSubOpts {
  originalTransactionId: string;
  status: 'active' | 'expired' | 'revoked' | 'grace_period' | 'billing_retry';
  expiresDate?: string | null;
}

function pdfEnv(
  opts: {
    plan?: 'premium' | 'free';
    stored?: boolean;
    anonSub?: AnonSubOpts | null;
    rawType?: string;
    rawBody?: string | Uint8Array;
  } = {},
): Env {
  const stored = opts.stored !== false;
  const rawType = opts.rawType || 'application/pdf';
  const rawBody = opts.rawBody || new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  return {
    APPLE_DEVICE_ENTITLEMENT_SECRET: TEST_DEVICE_ENTITLEMENT_SECRET,
    CONFIG_KV: {
      get: async (key: string) => {
        if (key === 'sess:free-token') return JSON.stringify({ userId: 'user_free' });
        if (key === 'sess:premium-token') return JSON.stringify({ userId: 'user_premium' });
        return null;
      },
      put: async () => {},
      delete: async () => {},
    },
    DB: {
      prepare: (sql: string) => ({
        params: [] as unknown[],
        bind(...params: unknown[]) {
          this.params = params;
          return this;
        },
        async first() {
          if (/FROM filings WHERE doc_id/i.test(sql)) {
            if (!stored) return null;
            return {
              raw_object_key: 'raw/doc.pdf',
              source_url: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034784.pdf',
            };
          }
          if (/SELECT \* FROM users WHERE id = \?/i.test(sql)) {
            const id = String(this.params[0] ?? '');
            const isPremium = id === 'user_premium' || opts.plan === 'premium';
            const isFree = id === 'user_free' || opts.plan === 'free';
            if (!isPremium && !isFree) return null;
            return {
              id,
              email: `${id}@example.com`,
              name: 'User',
              picture: null,
              google_sub: null,
              email_verified: 1,
              created_at: '2026-01-01T00:00:00.000Z',
              last_login_at: null,
              subscription_status: isPremium ? 'active' : 'canceled',
              plan: isPremium ? 'monthly' : null,
            };
          }
          if (/FROM apple_subscriptions/i.test(sql)) {
            const { anonSub } = opts;
            if (!anonSub || String(this.params[0] ?? '') !== anonSub.originalTransactionId) return null;
            return {
              original_transaction_id: anonSub.originalTransactionId,
              user_id: null,
              product_id: 'trade.congress.premium.monthly',
              plan: 'monthly',
              status: anonSub.status,
              environment: 'Production',
              latest_transaction_id: anonSub.originalTransactionId,
              purchase_date: '2026-01-01T00:00:00.000Z',
              expires_date: anonSub.expiresDate === undefined ? '2099-01-01T00:00:00.000Z' : anonSub.expiresDate,
              auto_renew_status: 1,
              auto_renew_product_id: null,
              revoked_at: null,
              revocation_reason: null,
              last_notification_type: null,
              last_notification_subtype: null,
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
            };
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return {};
        },
      }),
    },
    RAW_FILES: {
      get: async (key: string) => {
        if (key !== 'raw/doc.pdf') return null;
        return {
          body: typeof rawBody === 'string' ? new TextEncoder().encode(rawBody) : rawBody,
          httpMetadata: { contentType: rawType },
        };
      },
    },
  } as unknown as Env;
}

describe('GET /documents/:docId/pdf (APPSTORECOMPLIANCE-01/02)', () => {
  const upgrade = documentPdfUpgradePayload();

  it('returns 402 JSON for a Bearer free session, not a 302 to /pricing', async () => {
    const app = buildRestRouter();
    const res = await app.request(
      'http://localhost/documents/H-2026-1/pdf',
      { headers: { authorization: 'Bearer free-token' } },
      pdfEnv({ plan: 'free' }),
    );
    expect(res.status).toBe(402);
    expect(res.headers.get('location')).toBeNull();
    const body = (await res.json()) as typeof upgrade;
    expect(body).toEqual(upgrade);
  });

  it('returns 402 JSON when Accept is application/pdf and the user is not premium', async () => {
    const app = buildRestRouter();
    const res = await app.request(
      'http://localhost/documents/H-2026-1/pdf',
      { headers: { accept: 'application/pdf' } },
      pdfEnv(),
    );
    expect(res.status).toBe(402);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.json()).toEqual(upgrade);
  });

  it('returns 402 JSON for a browser HTML navigation without Bearer (no Stripe redirect)', async () => {
    const app = buildRestRouter();
    const res = await app.request(
      'http://localhost/documents/H-2026-1/pdf',
      { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } },
      pdfEnv(),
    );
    expect(res.status).toBe(402);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.json()).toEqual(documentPdfUpgradePayload());
  });

  it('serves the stored PDF for Premium and never redirects to the government source', async () => {
    const app = buildRestRouter();
    const res = await app.request(
      'http://localhost/documents/H-2026-1/pdf',
      { headers: { authorization: 'Bearer premium-token', accept: 'application/pdf' } },
      pdfEnv({ plan: 'premium' }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-congress-trade-source')).toBe('stored-raw');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes)).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it('does not leak the public government URL as a redirect when storage is empty', async () => {
    const app = buildRestRouter();
    const res = await app.request(
      'http://localhost/documents/H-2026-1/pdf',
      { headers: { authorization: 'Bearer premium-token', accept: 'application/pdf' } },
      pdfEnv({ plan: 'premium', stored: false }),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/not fetched|not found/i);
  });
});

describe('GET /documents/:docId/pdf — anonymous device entitlement (Guideline 5.1.1(v))', () => {
  const anonSub: AnonSubOpts = { originalTransactionId: 'otxn-anon-1', status: 'active' };

  it('serves the PDF to a signed-out device carrying a valid device entitlement token', async () => {
    const env = pdfEnv({ anonSub });
    const token = await issueDeviceEntitlementToken(env, anonSub.originalTransactionId, '2099-01-01T00:00:00.000Z');
    expect(token).toBeTruthy();
    const app = buildRestRouter();
    const res = await app.request(
      'http://localhost/documents/H-2026-1/pdf',
      { headers: { accept: 'application/pdf', 'X-Apple-Device-Entitlement': token! } },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
  });

  it('refuses a device token whose ledger row was revoked after the token was issued', async () => {
    const revoked: AnonSubOpts = { ...anonSub, originalTransactionId: 'otxn-anon-revoked', status: 'revoked' };
    const env = pdfEnv({ anonSub: revoked });
    const token = await issueDeviceEntitlementToken(env, revoked.originalTransactionId, '2099-01-01T00:00:00.000Z');
    const app = buildRestRouter();
    const res = await app.request(
      'http://localhost/documents/H-2026-1/pdf',
      { headers: { accept: 'application/pdf', 'X-Apple-Device-Entitlement': token! } },
      env,
    );
    expect(res.status).toBe(402);
  });

  it('refuses a tampered device entitlement token', async () => {
    const env = pdfEnv({ anonSub });
    const token = await issueDeviceEntitlementToken(env, anonSub.originalTransactionId, '2099-01-01T00:00:00.000Z');
    const tampered = token!.slice(0, -1) + (token!.endsWith('a') ? 'b' : 'a');
    const app = buildRestRouter();
    const res = await app.request(
      'http://localhost/documents/H-2026-1/pdf',
      { headers: { accept: 'application/pdf', 'X-Apple-Device-Entitlement': tampered } },
      env,
    );
    expect(res.status).toBe(402);
  });

  it('refuses a device token for a transaction with no ledger row at all', async () => {
    const env = pdfEnv({ anonSub: null });
    const token = await issueDeviceEntitlementToken(env, 'otxn-never-redeemed', '2099-01-01T00:00:00.000Z');
    const app = buildRestRouter();
    const res = await app.request(
      'http://localhost/documents/H-2026-1/pdf',
      { headers: { accept: 'application/pdf', 'X-Apple-Device-Entitlement': token! } },
      env,
    );
    expect(res.status).toBe(402);
  });

  it('a present-but-free SESSION takes priority over a valid device token (never OR the two)', async () => {
    const env = pdfEnv({ plan: 'free', anonSub });
    const token = await issueDeviceEntitlementToken(env, anonSub.originalTransactionId, '2099-01-01T00:00:00.000Z');
    const app = buildRestRouter();
    const res = await app.request(
      'http://localhost/documents/H-2026-1/pdf',
      {
        headers: {
          accept: 'application/pdf',
          authorization: 'Bearer free-token',
          'X-Apple-Device-Entitlement': token!,
        },
      },
      env,
    );
    expect(res.status).toBe(402);
  });

  it('serves Senate paper viewer HTML enhanced as clean multi-page reader with CSP sandbox', async () => {
    const paperHtml = `<!DOCTYPE HTML><html><body>Page 1 of 2<img class="filingImage" src="https://efd-media-public.senate.gov/media/2026/test.gif" /></body></html>`;
    const env = pdfEnv({
      plan: 'premium',
      rawType: 'text/html',
      rawBody: paperHtml,
    });
    const app = buildRestRouter();
    const res = await app.request(
      'http://localhost/documents/S-test-paper/pdf',
      { headers: { authorization: 'Bearer premium-token' } },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
    const body = await res.text();
    expect(body).toContain('Senate Paper Disclosure');
    expect(body).toContain('https://efd-media-public.senate.gov/media/2026/test.gif');
    expect(body).not.toContain('<script');
  });
});
