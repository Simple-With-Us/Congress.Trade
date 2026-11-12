import { describe, expect, it } from 'vitest';
import { buildAdminRouter } from '../routes.ts';
import { signWebhookPayload } from '../../delivery/webhook.ts';
import type { Env } from '../../shared/types.ts';
import type { SubscriptionRow } from '../../delivery/rows.ts';

function makeEnv(seed: SubscriptionRow[], envOverrides: Record<string, string> = {}) {
  const rows = new Map(seed.map((row) => [row.id, { ...row }]));
  // Mirrors the corrected quota query: only active rows count.
  const quotaCounts = (clientId: unknown) => {
    const active = Array.from(rows.values()).filter(
      (row) => row.client_id === clientId && row.active === 1,
    );
    return { total: active.length, active: active.length };
  };
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    async first<T>() {
      if (/COUNT\(\*\) AS total/i.test(sql)) return quotaCounts(this.params[0]) as T;
      if (/FROM subscriptions WHERE id = \?/i.test(sql)) {
        return (rows.get(String(this.params[0])) ?? null) as T | null;
      }
      return null as T | null;
    },
    async all<T>() {
      // The `first` db helper reads results[0] from .all(); serve the quota
      // aggregate here too so it keeps its {total, active} shape.
      if (/COUNT\(\*\) AS total/i.test(sql)) return { results: [quotaCounts(this.params[0])] as T[] };
      if (/FROM subscriptions/i.test(sql)) return { results: Array.from(rows.values()) as T[] };
      return { results: [] as T[] };
    },
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async run() {
      if (/INSERT INTO subscriptions/i.test(sql)) {
        const [id, clientId, delivery, targetUrl, secret, filters, cursor, active, createdAt] = this.params;
        rows.set(String(id), {
          id: String(id), client_id: String(clientId), delivery: String(delivery),
          target_url: targetUrl == null ? null : String(targetUrl),
          secret: secret == null ? null : String(secret), filters: String(filters),
          cursor: Number(cursor), active: active ? 1 : 0, created_at: String(createdAt),
        });
      } else if (/UPDATE subscriptions SET secret = \? WHERE id = \?/i.test(sql)) {
        const row = rows.get(String(this.params[1]));
        if (row) row.secret = String(this.params[0]);
      } else if (/UPDATE subscriptions SET active = \? WHERE id = \?/i.test(sql)) {
        const row = rows.get(String(this.params[1]));
        if (row) row.active = this.params[0] ? 1 : 0;
      }
      return { success: true, meta: { changes: 1 } };
    },
  });

  return {
    env: {
      DB: { prepare } as unknown as D1Database,
      CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
      ADMIN_OPEN_IN_DEV: 'true',
      ...envOverrides,
    } as unknown as Env,
    rows,
  };
}

describe('admin subscription routes', () => {
  it('redacts subscription secrets from the admin list', async () => {
    const app = buildAdminRouter();
    const { env } = makeEnv([
      {
        id: 'sub_1',
        client_id: 'client_1',
        delivery: 'sse',
        target_url: null,
        secret: 'whsec_super_secret',
        filters: '{}',
        cursor: 0,
        active: 1,
        created_at: '2026-06-30T00:00:00.000Z',
      },
    ]);

    const res = await app.request('http://localhost/subscriptions', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subscriptions: Array<{ hasSecret: boolean; secret?: string }>;
    };
    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0].hasSecret).toBe(true);
    expect(body.subscriptions[0].secret).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('whsec_super_secret');
  });

  it('provisions an explicit operator client id and returns the generated secret once', async () => {
    const app = buildAdminRouter();
    const { env, rows } = makeEnv([]);
    const res = await app.request('http://localhost/subscriptions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'integration:socratic-trade', delivery: 'sse', filters: { tickers: ['aapl'] } }),
    }, env);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; clientId: string; secret: string; streamUrl: string };
    expect(body).toMatchObject({ clientId: 'integration:socratic-trade' });
    expect(body.secret).toMatch(/^whsec_/);
    expect(body.streamUrl).toContain(`/api/stream?subscription=${encodeURIComponent(body.id)}`);
    expect(rows.get(body.id)).toMatchObject({
      client_id: 'integration:socratic-trade', filters: JSON.stringify({ tickers: ['AAPL'] }),
    });
  });

  it('rejects an unbounded operator client id', async () => {
    const app = buildAdminRouter();
    const { env } = makeEnv([]);
    const res = await app.request('http://localhost/subscriptions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'x'.repeat(129), delivery: 'sse', filters: {} }),
    }, env);
    expect(res.status).toBe(400);
  });

  it('rejects oversized operator secrets and target URLs', async () => {
    const app = buildAdminRouter();
    const { env } = makeEnv([]);
    const secret = await app.request('http://localhost/subscriptions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'integration:test', delivery: 'sse', filters: {}, secret: 's'.repeat(257) }),
    }, env);
    expect(secret.status).toBe(400);
    const target = await app.request('http://localhost/subscriptions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'integration:test', delivery: 'webhook', filters: {}, targetUrl: `https://example.com/${'x'.repeat(2049)}` }),
    }, env);
    expect(target.status).toBe(400);
  });
});

const OLD_SECRET = 'whsec_original_incident_secret_0123456789';

function seedWebhookSub(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: 'sub_lifecycle',
    client_id: 'integration:socratic-trade',
    delivery: 'webhook',
    target_url: 'https://example.com/hook',
    secret: OLD_SECRET,
    filters: '{}',
    cursor: 0,
    active: 1,
    created_at: '2026-06-30T00:00:00.000Z',
    ...overrides,
  };
}

describe('POST /subscriptions/:id/rotate-secret', () => {
  it('auto-generates and returns the new secret exactly once when none is supplied', async () => {
    const app = buildAdminRouter();
    const { env, rows } = makeEnv([seedWebhookSub()]);
    const res = await app.request('http://localhost/subscriptions/sub_lifecycle/rotate-secret', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; secretSet: boolean; secret?: string; hasSecret: boolean };
    expect(body.ok).toBe(true);
    expect(body.secretSet).toBe(true);
    expect(body.hasSecret).toBe(true);
    expect(body.secret).toMatch(/^whsec_/);
    expect(body.secret).not.toBe(OLD_SECRET);
    // Persisted secret matches the shown-once value.
    expect(rows.get('sub_lifecycle')?.secret).toBe(body.secret);
  });

  it('accepts a caller-supplied secret with zero secret exposure (never echoed)', async () => {
    const app = buildAdminRouter();
    const { env, rows } = makeEnv([seedWebhookSub()]);
    const supplied = 'incident_rotation_secret_0123456789abcdef';
    const res = await app.request('http://localhost/subscriptions/sub_lifecycle/rotate-secret', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: supplied }),
    }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, secretSet: true, hasSecret: true });
    expect(body.secret).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(supplied);
    expect(JSON.stringify(body)).not.toContain(OLD_SECRET);
    expect(rows.get('sub_lifecycle')?.secret).toBe(supplied);
  });

  it.each([
    ['too short', 's'.repeat(31)],
    ['too long', 's'.repeat(257)],
    ['embedded whitespace', `secret with spaces ${'s'.repeat(20)}`],
    ['not a string', 123],
  ])('rejects an invalid caller-supplied secret (%s)', async (_label, secret) => {
    const app = buildAdminRouter();
    const { env, rows } = makeEnv([seedWebhookSub()]);
    const res = await app.request('http://localhost/subscriptions/sub_lifecycle/rotate-secret', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret }),
    }, env);
    expect(res.status).toBe(400);
    expect(rows.get('sub_lifecycle')?.secret).toBe(OLD_SECRET);
  });

  it('changes signing behavior: deliveries signed after rotate verify against the new secret only', async () => {
    const app = buildAdminRouter();
    const { env, rows } = makeEnv([seedWebhookSub()]);
    const payload = JSON.stringify({ event: 'trade.new', transaction: { id: 'tx_1' } });
    const beforeRotate = await signWebhookPayload(env, payload, rows.get('sub_lifecycle')?.secret ?? undefined);

    const res = await app.request('http://localhost/subscriptions/sub_lifecycle/rotate-secret', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }, env);
    const { secret: rotatedSecret } = (await res.json()) as { secret: string };

    // Delivery signs with the durable subscription secret (what webhook.ts reads).
    const afterRotate = await signWebhookPayload(env, payload, rows.get('sub_lifecycle')?.secret ?? undefined);
    // Verifies against the shown-once rotated secret the operator now holds...
    expect(afterRotate).toBe(await signWebhookPayload(env, payload, rotatedSecret));
    // ...and fails verification against the old (compromised) secret.
    expect(afterRotate).not.toBe(beforeRotate);
    expect(afterRotate).not.toBe(await signWebhookPayload(env, payload, OLD_SECRET));
  });

  it('returns 404 for an unknown subscription id', async () => {
    const app = buildAdminRouter();
    const { env } = makeEnv([]);
    const res = await app.request('http://localhost/subscriptions/sub_missing/rotate-secret', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }, env);
    expect(res.status).toBe(404);
  });

  it('requires admin auth', async () => {
    const app = buildAdminRouter();
    const { env } = makeEnv([seedWebhookSub()], { ADMIN_TOKEN: 'admin-secret' });
    const anonymous = await app.request('http://localhost/subscriptions/sub_lifecycle/rotate-secret', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }, env);
    expect(anonymous.status).toBe(401);
    const wrongToken = await app.request('http://localhost/subscriptions/sub_lifecycle/rotate-secret', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: '{}',
    }, env);
    expect(wrongToken.status).toBe(401);
    const authed = await app.request('http://localhost/subscriptions/sub_lifecycle/rotate-secret', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer admin-secret' },
      body: '{}',
    }, env);
    expect(authed.status).toBe(200);
  });
});

describe('POST /subscriptions/:id/deactivate', () => {
  it('deactivates, is idempotent, and never leaks the secret', async () => {
    const app = buildAdminRouter();
    const { env, rows } = makeEnv([seedWebhookSub()]);
    const res = await app.request('http://localhost/subscriptions/sub_lifecycle/deactivate', {
      method: 'POST',
    }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; active: boolean; secret?: string };
    expect(body.ok).toBe(true);
    expect(body.active).toBe(false);
    expect(body.secret).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(OLD_SECRET);
    expect(rows.get('sub_lifecycle')?.active).toBe(0);

    const repeat = await app.request('http://localhost/subscriptions/sub_lifecycle/deactivate', {
      method: 'POST',
    }, env);
    expect(repeat.status).toBe(200);
    expect(((await repeat.json()) as { active: boolean }).active).toBe(false);
  });

  it('frees the creation quota: a client with max active rows can create again after deactivating', async () => {
    const app = buildAdminRouter();
    const clientId = 'integration:quota-bound';
    const seed = Array.from({ length: 2 }, (_, i) =>
      seedWebhookSub({ id: `sub_q_${i}`, client_id: clientId, secret: `whsec_seed_secret_${i}` }));
    const { env } = makeEnv(seed);

    const blocked = await app.request('http://localhost/subscriptions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId, delivery: 'sse', filters: {} }),
    }, env);
    expect(blocked.status).toBe(409);

    const freed = await app.request('http://localhost/subscriptions/sub_q_0/deactivate', { method: 'POST' }, env);
    expect(freed.status).toBe(200);

    const created = await app.request('http://localhost/subscriptions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId, delivery: 'sse', filters: {} }),
    }, env);
    expect(created.status).toBe(201);
  });

  it('returns 404 for an unknown subscription id', async () => {
    const app = buildAdminRouter();
    const { env } = makeEnv([]);
    const res = await app.request('http://localhost/subscriptions/sub_missing/deactivate', {
      method: 'POST',
    }, env);
    expect(res.status).toBe(404);
  });

  it('requires admin auth', async () => {
    const app = buildAdminRouter();
    const { env } = makeEnv([seedWebhookSub()], { ADMIN_TOKEN: 'admin-secret' });
    const anonymous = await app.request('http://localhost/subscriptions/sub_lifecycle/deactivate', {
      method: 'POST',
    }, env);
    expect(anonymous.status).toBe(401);
    const authed = await app.request('http://localhost/subscriptions/sub_lifecycle/deactivate', {
      method: 'POST', headers: { authorization: 'Bearer admin-secret' },
    }, env);
    expect(authed.status).toBe(200);
  });
});
