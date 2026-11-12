/**
 * src/delivery/__tests__/subscriptionMemberRoutes.test.ts
 *
 * Board a6058af2, route level: creating or editing a subscription with member
 * NAMES must store resolved filer ids (the only thing matchesFilters can match)
 * or answer with an error that lists the names — on the REST API and on the
 * client command API the web dashboard and the iOS app both use.  Runs against
 * a real migrated SQLite (users, subscriptions, filers, transactions).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildRestRouter } from '../rest.ts';
import { buildClientRouter } from '../../client/routes.ts';
import { createSession } from '../../auth/session.ts';
import { openMigratedD1 } from '../../prices/__tests__/sqliteD1.ts';
import type { Env } from '../../shared/types.ts';

type Opened = Awaited<ReturnType<typeof openMigratedD1>>;

const opened: Array<() => void> = [];
afterEach(() => {
  while (opened.length) opened.pop()!();
});

async function makeEnv(): Promise<{ env: Env; db: Opened['db']; auth: string }> {
  const { db, d1, close } = await openMigratedD1();
  opened.push(close);
  db.exec(`
    INSERT INTO users (id, email, name, email_verified, created_at, subscription_status, plan)
    VALUES ('user_1', 'premium@example.com', 'Premium', 1, '2026-01-01T00:00:00.000Z', 'active', 'monthly');
    INSERT INTO filers (bioguide_id, chamber, full_name, display_name, party)
    VALUES ('P000197', 'house', 'Nancy Pelosi', 'Nancy Pelosi', 'Democrat'),
           ('S000510', 'house', 'Adam Smith', NULL, 'Democrat'),
           ('S001195', 'house', 'Jason Smith', NULL, 'Republican');
    INSERT INTO transactions (id, doc_id, filer_id, tx_date, ticker, asset_name, tx_type, source, amount_min, amount_max, owner, is_option)
    VALUES ('tx-1', 'DOC-1', 'P000197', '2026-09-01', 'AAPL', 'Apple', 'B', 'primary', 1001, 15000, 'self', 0),
           ('tx-2', 'DOC-2', 'S000510', '2026-09-01', 'AAPL', 'Apple', 'B', 'primary', 1001, 15000, 'self', 0),
           ('tx-3', 'DOC-3', 'S001195', '2026-09-01', 'AAPL', 'Apple', 'B', 'primary', 1001, 15000, 'self', 0);
  `);
  const kv = new Map<string, string>();
  const env = {
    DB: d1,
    CONFIG_KV: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => void kv.set(key, value),
      delete: async (key: string) => void kv.delete(key),
    },
    INGEST_QUEUE: { send: async () => {} },
  } as unknown as Env;
  const auth = `Bearer ${await createSession(env, 'user_1')}`;
  return { env, db, auth };
}

function storedFilters(db: Opened['db'], id: string): Record<string, unknown> {
  const row = db.prepare('SELECT filters FROM subscriptions WHERE id = ?').get(id) as { filters: string };
  return JSON.parse(row.filters) as Record<string, unknown>;
}

function subscriptionCount(db: Opened['db']): number {
  return Number((db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get() as { n: number }).n);
}

async function restPost(env: Env, auth: string, filters: unknown) {
  return buildRestRouter().request(
    'http://localhost/subscriptions',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({ delivery: 'sse', filters }),
    },
    env,
  );
}

async function clientCommand(env: Env, auth: string, type: string, payload: unknown, key: string) {
  const res = await buildClientRouter().request(
    'http://localhost/commands',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth, 'idempotency-key': key },
      body: JSON.stringify({ type, payload }),
    },
    env,
  );
  return {
    status: res.status,
    body: (await res.json()) as {
      command: { status: string; error?: string | null; result?: { subscription?: Record<string, unknown> } };
    },
  };
}

describe('REST /subscriptions resolves member names (a6058af2)', () => {
  it('POST stores the resolved filer id, not the typed name', async () => {
    const { env, db, auth } = await makeEnv();
    const res = await restPost(env, auth, { members: ['Nancy Pelosi'] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; filters: { members: string[] } };
    expect(body.filters.members).toEqual(['P000197']);
    expect(storedFilters(db, body.id)).toEqual({ members: ['P000197'] });
  });

  it('POST rejects unrecognized and ambiguous names with a 400 that lists them, persisting nothing', async () => {
    const { env, db, auth } = await makeEnv();
    const unknown = await restPost(env, auth, { members: ['Nancy Pelosii', 'S000510'] });
    expect(unknown.status).toBe(400);
    const unknownBody = (await unknown.json()) as { error: string; unresolvedMembers?: string[] };
    expect(unknownBody.error).toContain('"Nancy Pelosii"');
    expect(unknownBody.unresolvedMembers).toEqual(['Nancy Pelosii']);

    const ambiguous = await restPost(env, auth, { members: ['Smith'] });
    expect(ambiguous.status).toBe(400);
    expect(((await ambiguous.json()) as { error: string }).error).toContain('"Smith" is ambiguous');
    expect(subscriptionCount(db)).toBe(0);
  });

  it('PATCH resolves names on update and rejects unknown ones', async () => {
    const { env, db, auth } = await makeEnv();
    const created = (await (await restPost(env, auth, { tickers: ['AAPL'] })).json()) as {
      id: string;
      secret: string;
    };
    const patch = (filters: unknown) =>
      buildRestRouter().request(
        `http://localhost/subscriptions/${created.id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', 'x-subscription-secret': created.secret },
          body: JSON.stringify({ filters }),
        },
        env,
      );

    const bad = await patch({ members: ['Nobody Here'] });
    expect(bad.status).toBe(400);
    expect(storedFilters(db, created.id)).toEqual({ tickers: ['AAPL'] });

    const good = await patch({ members: ['Jason Smith', 's000510'] });
    expect(good.status).toBe(200);
    expect(storedFilters(db, created.id)).toEqual({ members: ['S001195', 'S000510'] });
  });
});

describe('client commands resolve member names and label them on the list (a6058af2)', () => {
  it('create_subscription stores ids; a failed lookup fails the command with the names listed', async () => {
    const { env, db, auth } = await makeEnv();
    const ok = await clientCommand(
      env,
      auth,
      'create_subscription',
      { delivery: 'sse', filters: { members: ['Pelosi'] } },
      'k1',
    );
    expect(ok.body.command.status).toBe('succeeded');
    const id = ok.body.command.result?.subscription?.id as string;
    expect(storedFilters(db, id)).toEqual({ members: ['P000197'] });

    const bad = await clientCommand(
      env,
      auth,
      'create_subscription',
      { delivery: 'sse', filters: { members: ['Definitely Not A Member'] } },
      'k2',
    );
    expect(bad.body.command.status).toBe('failed');
    expect(bad.body.command.error).toContain('"Definitely Not A Member"');
    expect(subscriptionCount(db)).toBe(1);
  });

  it('update_subscription resolves names and rejects unknown ones', async () => {
    const { env, db, auth } = await makeEnv();
    const created = await clientCommand(env, auth, 'create_subscription', { delivery: 'sse', filters: {} }, 'k1');
    const id = created.body.command.result?.subscription?.id as string;

    const bad = await clientCommand(env, auth, 'update_subscription', { id, filters: { members: ['Zzz'] } }, 'k2');
    expect(bad.body.command.status).toBe('failed');
    expect(bad.body.command.error).toContain('"Zzz"');
    expect(storedFilters(db, id)).toEqual({});

    const ok = await clientCommand(
      env,
      auth,
      'update_subscription',
      { id, filters: { members: ['Nancy Pelosi'] } },
      'k3',
    );
    expect(ok.body.command.status).toBe('succeeded');
    expect(storedFilters(db, id)).toEqual({ members: ['P000197'] });
  });

  it('GET /subscriptions labels ids and flags legacy free-text names that can never match', async () => {
    const { env, db, auth } = await makeEnv();
    // A row created before names were resolved: the raw text was stored as-is.
    db.exec(`
      INSERT INTO subscriptions (id, client_id, delivery, target_url, secret, filters, cursor, active, created_at)
      VALUES ('sub_legacy', 'user:user_1', 'sse', NULL, 'whsec_legacy_secret_value', '{"members":["Nancy Pelosi","S000510"]}', 0, 1, '2026-01-01T00:00:00.000Z'),
             ('sub_plain', 'user:user_1', 'sse', NULL, 'whsec_plain_secret_value', '{"tickers":["AAPL"]}', 0, 1, '2026-01-02T00:00:00.000Z');
    `);
    const res = await buildClientRouter().request(
      'http://localhost/subscriptions',
      { headers: { authorization: auth } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subscriptions: Array<Record<string, unknown>> };
    const legacy = body.subscriptions.find((s) => s.id === 'sub_legacy')!;
    expect(legacy.memberLabels).toEqual({ S000510: 'Adam Smith' });
    expect(legacy.unresolvedMembers).toEqual(['Nancy Pelosi']);
    // Nothing is rewritten by reading.
    expect(storedFilters(db, 'sub_legacy')).toEqual({ members: ['Nancy Pelosi', 'S000510'] });
    const plain = body.subscriptions.find((s) => s.id === 'sub_plain')!;
    expect(plain.memberLabels).toBeUndefined();
    expect(plain.unresolvedMembers).toBeUndefined();
    // No secret ever appears on the list.
    expect(JSON.stringify(body)).not.toContain('whsec_');
  });
});
