// End-to-end coverage of the "someone became Premium" Pushover notification
// through the real Stripe webhook route, over a real (node:sqlite)
// database — so the idempotency ledger (premium_activation_notices) and the
// totals aggregate query in premiumActivationAlert.ts run for real.  Only the
// outbound Pushover HTTP call is stubbed, at sendPushover's fetch parameter
// boundary (routes.ts / commands.ts always call it with the default fetch,
// so we stub globalThis.fetch instead of mocking a module).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBillingRouter } from '../routes.ts';
import type { Env } from '../../shared/types.ts';

interface SqliteRunResult {
  changes: number | bigint;
}
interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
  run(...params: unknown[]): SqliteRunResult;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

let openDatabase: SqliteDatabase | null = null;

async function sqliteDatabase(): Promise<SqliteDatabase> {
  const moduleName = 'node:sqlite';
  const sqlite = (await import(moduleName)) as SqliteModule;
  const db = new sqlite.DatabaseSync(':memory:');
  openDatabase = db;
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, picture TEXT,
      google_sub TEXT, email_verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, last_login_at TEXT,
      stripe_customer_id TEXT, stripe_subscription_id TEXT, subscription_status TEXT,
      plan TEXT, current_period_end TEXT, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, trial_end TEXT
    );
    CREATE TABLE stripe_webhook_events (
      event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, received_at TEXT NOT NULL,
      processed_at TEXT, claim_token TEXT, claim_expires_at TEXT
    );
    CREATE TABLE stripe_subscription_event_state (
      subscription_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL,
      last_event_created INTEGER NOT NULL, last_event_priority INTEGER NOT NULL,
      last_event_id TEXT NOT NULL, last_event_type TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE apple_subscriptions (
      original_transaction_id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      status TEXT NOT NULL, expires_date TEXT
    );
    CREATE TABLE premium_activation_notices (
      activation_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, notified_at TEXT NOT NULL
    );
  `);
  return db;
}

function d1Database(db: SqliteDatabase): Env['DB'] {
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    return {
      bind(...values: unknown[]) {
        params = values;
        return this;
      },
      async first<T>() {
        return (db.prepare(sql).get(...params) ?? null) as T | null;
      },
      async run() {
        const result = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(result.changes) } } as unknown;
      },
      async all<T>() {
        return { results: db.prepare(sql).all(...params) as T[] };
      },
    };
  };
  return { prepare } as unknown as Env['DB'];
}

const WEBHOOK_SECRET = 'whsec_test';

async function fakeEnv(): Promise<Env & { __db: SqliteDatabase }> {
  const db = await sqliteDatabase();
  return {
    DB: d1Database(db),
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_PRICE_MONTHLY: 'price_m',
    STRIPE_PRICE_ANNUAL: 'price_a',
    __db: db,
  } as unknown as Env & { __db: SqliteDatabase };
}

function seedUser(db: SqliteDatabase, id = 'u1', email = 'subscriber@example.com'): void {
  // stripe_customer_id must match the webhook payload's `customer` ('cus_1')
  // so applySubscription's getUserByStripeCustomerId lookup resolves a user.
  db.exec(
    `INSERT INTO users (id, email, email_verified, created_at, stripe_customer_id)
     VALUES ('${id}', '${email}', 1, '2026-01-01T00:00:00.000Z', 'cus_1')`,
  );
}

async function sign(secret: string, ts: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function postWebhook(env: Env, event: Record<string, unknown>): Promise<Response> {
  const app = buildBillingRouter();
  const body = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const header = `t=${ts},v1=${await sign(WEBHOOK_SECRET, ts, body)}`;
  return app.request(
    'http://localhost/webhook',
    { method: 'POST', body, headers: { 'stripe-signature': header, 'content-type': 'application/json' } },
    env,
  );
}

function subscriptionCreatedEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evt_created_1',
    created: 1_000,
    type: 'customer.subscription.created',
    data: {
      object: {
        id: 'sub_new_1',
        status: 'trialing',
        customer: 'cus_1',
        items: { data: [{ price: { id: 'price_m' } }] },
        trial_end: 2_000_000_000,
        ...over,
      },
    },
  };
}

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
  vi.unstubAllGlobals();
});

describe('Stripe webhook -> premium activation Pushover notification', () => {
  it('sends exactly one Pushover message on a new subscription.created activation, stating source/plan/trial + totals', async () => {
    const env = await fakeEnv();
    seedUser(env.__db, 'u1', 'subscriber@example.com');
    const fetchSpy = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('api.pushover.net')) {
        return new Response(JSON.stringify({ status: 1 }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchSpy);
    // No PUSHOVER_APP_TOKEN/PUSHOVER_USER_KEY on env -> sendPushover's own
    // Infisical resolution runs (env fallback disabled without an env value),
    // so also set the tokens directly on env for a realistic "configured" run.
    (env as unknown as Record<string, string>).PUSHOVER_APP_TOKEN = 'app-token';
    (env as unknown as Record<string, string>).PUSHOVER_USER_KEY = 'user-key';

    const res = await postWebhook(env, subscriptionCreatedEvent());
    expect(res.status).toBe(200);

    const pushoverCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes('api.pushover.net'));
    expect(pushoverCalls).toHaveLength(1);
    const [, init] = pushoverCalls[0] as [string, RequestInit];
    const params = new URLSearchParams(init.body as string);
    expect(params.get('message')).toContain('subscriber@example.com');
    expect(params.get('message')).toContain('Stripe');
    expect(params.get('message')).toContain('monthly');
    expect(params.get('message')).toContain('trial');
    expect(params.get('message')).toContain('Premium accounts: 1 total, 1 on trial');
    // No secrets in the notification body.
    expect(params.get('message')).not.toContain(WEBHOOK_SECRET);
  });

  it('does not send a second Pushover message when the same webhook event is redelivered', async () => {
    const env = await fakeEnv();
    seedUser(env.__db);
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ status: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    (env as unknown as Record<string, string>).PUSHOVER_APP_TOKEN = 'app-token';
    (env as unknown as Record<string, string>).PUSHOVER_USER_KEY = 'user-key';

    const event = subscriptionCreatedEvent();
    const first = await postWebhook(env, event);
    const second = await postWebhook(env, event);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('api.pushover.net'))).toHaveLength(1);
  });

  it('does not notify on customer.subscription.updated (renewal / trial-conversion on the same subscription)', async () => {
    const env = await fakeEnv();
    seedUser(env.__db);
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ status: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    (env as unknown as Record<string, string>).PUSHOVER_APP_TOKEN = 'app-token';
    (env as unknown as Record<string, string>).PUSHOVER_USER_KEY = 'user-key';

    // First, the genuine activation (created).
    await postWebhook(env, subscriptionCreatedEvent());
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('api.pushover.net'))).toHaveLength(1);

    // Then the trial converts to paid on the SAME subscription id -> updated event.
    const res = await postWebhook(env, {
      id: 'evt_updated_1',
      created: 2_000,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_new_1', status: 'active', customer: 'cus_1',
          items: { data: [{ price: { id: 'price_m' } }] },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('api.pushover.net'))).toHaveLength(1);
    expect(env.__db.prepare('SELECT subscription_status, plan FROM users WHERE id = ?').get('u1')).toMatchObject({
      subscription_status: 'active',
      plan: 'monthly',
    });
  });

  it('a Pushover delivery failure never fails the webhook response', async () => {
    const env = await fakeEnv();
    seedUser(env.__db);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('pushover unreachable'); }));
    (env as unknown as Record<string, string>).PUSHOVER_APP_TOKEN = 'app-token';
    (env as unknown as Record<string, string>).PUSHOVER_USER_KEY = 'user-key';

    const res = await postWebhook(env, subscriptionCreatedEvent());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    // The subscription write still landed despite the Pushover failure.
    expect(env.__db.prepare('SELECT subscription_status FROM users WHERE id = ?').get('u1')).toMatchObject({
      subscription_status: 'trialing',
    });
  });

  it('a missing Pushover configuration never fails the webhook response', async () => {
    const env = await fakeEnv();
    seedUser(env.__db);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    // Deliberately no PUSHOVER_APP_TOKEN / PUSHOVER_USER_KEY on env.

    const res = await postWebhook(env, subscriptionCreatedEvent());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not notify when the subscription is created but not yet active/trialing (e.g. incomplete)', async () => {
    const env = await fakeEnv();
    seedUser(env.__db);
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ status: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    (env as unknown as Record<string, string>).PUSHOVER_APP_TOKEN = 'app-token';
    (env as unknown as Record<string, string>).PUSHOVER_USER_KEY = 'user-key';

    const res = await postWebhook(env, subscriptionCreatedEvent({ status: 'incomplete', trial_end: null }));
    expect(res.status).toBe(200);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('api.pushover.net'))).toHaveLength(0);
  });
});
