/**
 * CT_DELIVERY_MODE (subscriber alert pause): deliver | hold | suppress across
 * the outbox flush, the queued-message consumer gate, APNs fan-out, the SSE
 * backlog drain, the parked-retry flush, the admin settings route, and the
 * delivery_mode health check.  GB-Publisher.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Hono } from 'hono';
import type { Env, QueueMessage, Subscription } from '../../shared/types.ts';
import { openMigratedD1, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import { __resetSettingsForTests, initSettings, stopSettingsRefresh } from '../../settings/settingsService.ts';
import {
  __setDeliveryModeForTests,
  DeliveryModeUnavailableError,
  evaluateDeliveryModeCheck,
  collectDeliveryModeCheck,
  readDeliveryMode,
  readDeliveryModeDetail,
  recordDeliveryModeChange,
  type DeliveryMode,
} from '../deliveryMode.ts';
import { completeDeliveryOutbox, flushDeliveryOutbox, reconnectDeadLetteredOutbox } from '../outbox.ts';
import { handleDeliveryMessage } from '../../queueHandlers.ts';
import { fanOutApnsProductEvents } from '../apnsFanout.ts';
import { drainSseBacklog } from '../sse.ts';
import { flushParkedDeliveries } from '../targetCircuit.ts';
import { buildAdminRouter } from '../../admin/routes.ts';

const NOW = new Date('2026-10-25T12:00:00.000Z');

let sqlite: SqliteDatabase;
let close: () => void;
let env: Env;
let send: ReturnType<typeof vi.fn>;

function outboxRow(txId: string, status = 'pending', availableAt = '2026-10-25T11:00:00.000Z'): void {
  sqlite
    .prepare(
      `INSERT INTO delivery_outbox (tx_id, status, attempts, available_at, last_error, created_at, updated_at)
       VALUES (?, ?, 0, ?, NULL, ?, ?)`,
    )
    .run(txId, status, availableAt, availableAt, availableAt);
}

const OutboxStatus = z.object({ status: z.string(), last_error: z.string().nullable() });

function statusOf(txId: string): z.infer<typeof OutboxStatus> {
  return OutboxStatus.parse(sqlite.prepare('SELECT status, last_error FROM delivery_outbox WHERE tx_id = ?').get(txId));
}

/**
 * The exact message the outbox producer puts on DELIVERY_QUEUE for this row:
 * flush it in deliver mode with a capturing queue, so the consumer tests feed
 * handleDeliveryMessage the producer's real envelope, not a hand-written one.
 */
async function producedDispatch(txId: string): Promise<QueueMessage> {
  const captured: QueueMessage[] = [];
  const producerEnv = { ...env, DELIVERY_QUEUE: { send: async (m: QueueMessage) => void captured.push(m) } } as unknown as Env;
  pin('deliver');
  await flushDeliveryOutbox(producerEnv, { now: NOW, txIds: [txId] });
  expect(captured).toHaveLength(1);
  expect(statusOf(txId).status).toBe('enqueued');
  return captured[0]!;
}

/**
 * Pin the wall clock to NOW for tests whose rows carry fixed timestamps.  The
 * SSE drain drops trades older than DELIVERY_FRESH_WINDOW_DAYS against
 * Date.now(), so without this the fixtures age out a week after they were
 * written.  Only Date is faked; timers and promises run normally.
 */
function pinClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
}

beforeEach(async () => {
  // Every fixture here is dated around NOW.  The SSE drain judges delivery
  // freshness against the wall clock (DELIVERY_FRESH_WINDOW_DAYS), so without
  // pinning Date the SSE tests start failing once real time is more than a
  // week past NOW.  Only Date is faked; timers and microtasks stay real.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const opened = await openMigratedD1();
  sqlite = opened.db;
  close = opened.close;
  send = vi.fn(async () => undefined);
  env = { DB: opened.d1, DELIVERY_QUEUE: { send } } as unknown as Env;
});

afterEach(() => {
  // Restore the real clock first so a throwing close() cannot leak fake Date.
  vi.useRealTimers();
  close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  stopSettingsRefresh();
  __resetSettingsForTests();
});

function pin(mode: DeliveryMode): void {
  __setDeliveryModeForTests(mode);
}

describe('readDeliveryMode (Infisical snapshot, no env fallback)', () => {
  function stubInfisical(rows: Array<{ secretKey: string; secretValue: string }>): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/v1/auth/universal-auth/login')) return Response.json({ accessToken: 'test-token' });
        if (url.includes('/api/v3/secrets/raw?')) return Response.json({ secrets: rows });
        return new Response('not found', { status: 404 });
      }),
    );
  }
  let seq = 0;
  function infisicalEnv(extra: Record<string, string> = {}): Env {
    seq += 1;
    return {
      INFISICAL_BASE_URL: 'https://infisical.test',
      INFISICAL_ENV: 'prod',
      INFISICAL_ALLOW_ENV_FALLBACK: 'false',
      INFISICAL_APP_PROJECT_ID: `dm-project-${seq}`,
      INFISICAL_APP_CLIENT_ID: `dm-client-${seq}`,
      INFISICAL_APP_CLIENT_SECRET: `dm-client-secret-${seq}-long-enough-to-pass`,
      ...extra,
    } as unknown as Env;
  }

  beforeEach(() => __setDeliveryModeForTests(null));

  it('throws (fails closed) when the settings snapshot never booted', async () => {
    expect(() => readDeliveryMode()).toThrow(DeliveryModeUnavailableError);
    outboxRow('tx_a');
    await expect(flushDeliveryOutbox(env, { now: NOW })).rejects.toThrow(DeliveryModeUnavailableError);
    expect(send).not.toHaveBeenCalled();
    expect(statusOf('tx_a').status).toBe('pending');
    const check = await collectDeliveryModeCheck(env, NOW);
    expect(check.status).toBe('critical');
  });

  it('defaults to deliver when the Infisical key is unset', async () => {
    stubInfisical([]);
    await initSettings(infisicalEnv());
    expect(readDeliveryModeDetail()).toEqual({ mode: 'deliver', raw: undefined, invalid: false });
  });

  it('reads the mode from Infisical, not process env', async () => {
    stubInfisical([{ secretKey: 'CT_DELIVERY_MODE', secretValue: 'suppress' }]);
    await initSettings(infisicalEnv({ CT_DELIVERY_MODE: 'deliver' }));
    expect(readDeliveryMode()).toBe('suppress');
  });

  it('fails safe to hold on an unrecognized value and flags it', async () => {
    stubInfisical([{ secretKey: 'CT_DELIVERY_MODE', secretValue: 'paused' }]);
    await initSettings(infisicalEnv());
    expect(readDeliveryModeDetail()).toEqual({ mode: 'hold', raw: 'paused', invalid: true });
    const check = await collectDeliveryModeCheck(env, NOW);
    expect(check.status).toBe('critical');
    expect(check.detail).toMatch(/invalid value/);
  });
});

describe('mode deliver (default)', () => {
  it('dispatches pending outbox rows exactly as before', async () => {
    pin('deliver');
    outboxRow('tx_a');
    expect(await flushDeliveryOutbox(env, { now: NOW })).toEqual({ claimed: 1, enqueued: 1, failed: 0 });
    expect(send).toHaveBeenCalledWith({ type: 'delivery.dispatch', txId: 'tx_a' });
    expect(statusOf('tx_a').status).toBe('enqueued');
  });
});

describe('mode hold', () => {
  it('writes nothing to the queue and keeps rows pending until switched back', async () => {
    pin('hold');
    outboxRow('tx_a');
    outboxRow('tx_b');
    expect(await flushDeliveryOutbox(env, { now: NOW })).toEqual({ claimed: 0, enqueued: 0, failed: 0, mode: 'hold' });
    expect(send).not.toHaveBeenCalled();
    expect(statusOf('tx_a').status).toBe('pending');

    pin('deliver');
    expect(await flushDeliveryOutbox(env, { now: NOW })).toEqual({ claimed: 2, enqueued: 2, failed: 0 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('resumes in bounded batches (burst guard: the per-flush limit)', async () => {
    pin('hold');
    for (let i = 0; i < 5; i += 1) outboxRow(`tx_${i}`);
    await flushDeliveryOutbox(env, { now: NOW, limit: 2 });
    pin('deliver');
    expect((await flushDeliveryOutbox(env, { now: NOW, limit: 2 })).enqueued).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('re-opens an already-queued message as pending instead of sending it', async () => {
    outboxRow('tx_q');
    const msg = await producedDispatch('tx_q');
    pin('hold');
    expect(await handleDeliveryMessage(env, msg)).toBe(false);
    expect(statusOf('tx_q')).toEqual({ status: 'pending', last_error: 'held by CT_DELIVERY_MODE=hold' });
  });

  it('leaves targeted parked retries parked and releases none', async () => {
    outboxRow('tx_p', 'completed');
    pin('hold');
    // Targeted parked retry: the shape flushParkedDeliveries sends
    // (targetCircuit.ts), typed against the shared QueueMessage contract.
    const parked = { type: 'delivery.dispatch', txId: 'tx_p', subscriptionId: 'sub_1' } satisfies QueueMessage;
    expect(await handleDeliveryMessage(env, parked)).toBe(false);
    expect(statusOf('tx_p').status).toBe('completed');
    expect((await flushParkedDeliveries(env, { now: NOW })).released).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('pauses APNs fan-out without touching config or the cursor', async () => {
    pin('hold');
    const loadConfig = vi.fn(async () => null);
    const writeState = vi.fn(async () => undefined);
    expect(await fanOutApnsProductEvents(env, { now: NOW, loadConfig, writeState })).toEqual({
      skipped: 'delivery_hold',
      trades: 0,
      reviews: 0,
      delivered: 0,
      retired: 0,
    });
    expect(loadConfig).not.toHaveBeenCalled();
    expect(writeState).not.toHaveBeenCalled();
  });

  it('pauses the SSE backlog drain without advancing the cursor', async () => {
    pinClock();
    sqlite.exec(`INSERT INTO transactions (id, doc_id, created_at) VALUES ('tx_s1', 'doc_s', '2026-10-25T11:00:00Z')`);
    const seq = z.object({ cursor_seq: z.number() })
      .parse(sqlite.prepare(`SELECT cursor_seq FROM transactions WHERE id = 'tx_s1'`).get()).cursor_seq;
    const sent: string[] = [];
    const sub = { id: 'sub_sse', filters: {} } as unknown as Subscription;
    pin('hold');
    expect(await drainSseBacklog(env, sub, seq - 1, async (chunk) => void sent.push(chunk))).toBe(seq - 1);
    expect(sent).toHaveLength(0);
    pin('deliver');
    expect(await drainSseBacklog(env, sub, seq - 1, async (chunk) => void sent.push(chunk))).toBe(seq);
    expect(sent).toHaveLength(1);
  });
});

describe('mode suppress', () => {
  it('marks every pending row suppressed (never sent) with the audit reason', async () => {
    const audit = await recordDeliveryModeChange(env, {
      mode: 'suppress',
      previousMode: 'deliver',
      actor: 'jay@example.com',
      reason: 'Trump 278-T republish',
      now: NOW,
    });
    pin('suppress');
    outboxRow('tx_a');
    outboxRow('tx_b', 'pending', '2026-10-25T13:00:00.000Z'); // still in retry backoff
    outboxRow('tx_done', 'completed');
    expect(await flushDeliveryOutbox(env, { now: NOW })).toEqual({
      claimed: 0,
      enqueued: 0,
      failed: 0,
      mode: 'suppress',
      suppressed: 2,
    });
    expect(send).not.toHaveBeenCalled();
    expect(statusOf('tx_a').status).toBe('suppressed');
    expect(statusOf('tx_a').last_error).toContain(audit.id);
    expect(statusOf('tx_a').last_error).toContain('Trump 278-T republish');
    expect(statusOf('tx_b').status).toBe('suppressed');
    expect(statusOf('tx_done').status).toBe('completed');

    // Switching back never resurrects suppressed rows.
    pin('deliver');
    expect(await flushDeliveryOutbox(env, { now: NOW })).toEqual({ claimed: 0, enqueued: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('suppresses an already-queued message and a late dead letter cannot re-open it', async () => {
    outboxRow('tx_q');
    const msg = await producedDispatch('tx_q');
    pin('suppress');
    expect(await handleDeliveryMessage(env, msg)).toBe(false);
    expect(statusOf('tx_q').status).toBe('suppressed');
    expect(statusOf('tx_q').last_error).toMatch(/no audit row/);
    pin('deliver');
    expect((await reconnectDeadLetteredOutbox(env, 'tx_q', 'late DLQ', NOW)).status).toBe('completed');
    expect(statusOf('tx_q').status).toBe('suppressed');
  });

  it('the suppress flush also marks enqueued rows, and the consumer acks them unsent after resume', async () => {
    outboxRow('tx_q');
    const msg = await producedDispatch('tx_q');
    pin('suppress');
    expect((await flushDeliveryOutbox(env, { now: NOW })).suppressed).toBe(1);
    expect(statusOf('tx_q').status).toBe('suppressed');
    // Delivery resumes before the queued message is consumed.
    pin('deliver');
    const fetchSpy = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchSpy);
    expect(await handleDeliveryMessage(env, msg)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(statusOf('tx_q').status).toBe('suppressed');
    // A late completion can never flip a suppressed row to completed.
    await completeDeliveryOutbox(env, 'tx_q', NOW);
    expect(statusOf('tx_q').status).toBe('suppressed');
  });

  it('SSE pauses during suppress, then skips suppressed rows after resume', async () => {
    pinClock();
    sqlite.exec(`
      INSERT INTO transactions (id, doc_id, created_at) VALUES ('tx_s1', 'doc_s', '2026-10-25T11:00:00Z');
      INSERT INTO transactions (id, doc_id, created_at) VALUES ('tx_s2', 'doc_s', '2026-10-25T11:00:01Z');
    `);
    const seqs = z.array(z.object({ id: z.string(), cursor_seq: z.number() }))
      .parse(sqlite.prepare(`SELECT id, cursor_seq FROM transactions ORDER BY cursor_seq`).all());
    outboxRow('tx_s1', 'suppressed');
    outboxRow('tx_s2', 'completed');
    const sent: string[] = [];
    const sub = { id: 'sub_sse', filters: {} } as unknown as Subscription;
    const start = seqs[0]!.cursor_seq - 1;
    // Suppress: nothing streams and the cursor holds, so rows the next flush
    // has not marked yet cannot leak.
    pin('suppress');
    expect(await drainSseBacklog(env, sub, start, async (chunk) => void sent.push(chunk))).toBe(start);
    expect(sent).toHaveLength(0);
    pin('deliver');
    const hwm = await drainSseBacklog(env, sub, start, async (chunk) => void sent.push(chunk));
    expect(hwm).toBe(seqs[1]!.cursor_seq);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('tx_s2');
    expect(sent[0]).not.toContain('tx_s1');
  });

  it('pauses APNs fan-out', async () => {
    pin('suppress');
    expect((await fanOutApnsProductEvents(env, { now: NOW, loadConfig: async () => null })).skipped).toBe(
      'delivery_suppress',
    );
  });
});

describe('delivery_mode health check', () => {
  const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
  const audit = (mode: string, minutesAgo: number) => ({
    id: 'dma_1',
    mode,
    previousMode: 'deliver',
    actor: 'jay@example.com',
    reason: 'republish',
    createdAt: at(minutesAgo),
  });

  it('is ok while delivering', () => {
    expect(evaluateDeliveryModeCheck({ mode: 'deliver', raw: undefined, invalid: false }, null, NOW).status).toBe('ok');
  });

  it('is degraded (visible, not paging) before the warn window', () => {
    const check = evaluateDeliveryModeCheck({ mode: 'hold', raw: 'hold', invalid: false }, audit('hold', 59), NOW);
    expect(check.status).toBe('degraded');
    expect(check.detail).toContain('HELD for 59m');
    // Public /api/health: no actor, reason or audit id.
    expect(check.detail).not.toContain('jay@example.com');
    expect(check.detail).not.toContain('republish');
    expect(check.value).toEqual({ mode: 'hold', invalid: false, since: at(59), minutes: 59, warnMinutes: 60 });
  });

  it('turns critical (loud pipeline alert) at 60 minutes', () => {
    const check = evaluateDeliveryModeCheck(
      { mode: 'suppress', raw: 'suppress', invalid: false },
      audit('suppress', 60),
      NOW,
    );
    expect(check.status).toBe('critical');
    expect(check.detail).toMatch(/over 60m/);
  });

  it('is critical at once when the mode was set without an audit row', () => {
    expect(
      evaluateDeliveryModeCheck({ mode: 'hold', raw: 'hold', invalid: false }, audit('suppress', 1), NOW).status,
    ).toBe('critical');
    expect(evaluateDeliveryModeCheck({ mode: 'hold', raw: 'hold', invalid: false }, null, NOW).status).toBe('critical');
  });

  it('reads the latest audit row from the database', async () => {
    await recordDeliveryModeChange(env, { mode: 'hold', previousMode: 'deliver', actor: 'a', now: new Date(at(10)) });
    pin('hold');
    const check = await collectDeliveryModeCheck(env, NOW);
    expect(check.status).toBe('degraded');
    expect(check.value).toMatchObject({ mode: 'hold', minutes: 10 });
    expect(check.value).not.toHaveProperty('actor');
  });
});

describe('PUT /api/admin/settings CT_DELIVERY_MODE', () => {
  type Row = { secretKey: string; secretValue: string };
  let rows: Row[];
  let dropWrites = false;
  let seq = 100;
  let adminEnv: Env;

  beforeEach(async () => {
    __setDeliveryModeForTests(null);
    dropWrites = false;
    rows = [{ secretKey: 'ADMIN_TOKEN', secretValue: 'admin-secret-value-long-enough-0123456789' }];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/v1/auth/universal-auth/login')) return Response.json({ accessToken: 'test-token' });
        if (url.includes('/api/v3/secrets/raw?')) return Response.json({ secrets: rows });
        if (url.includes('/api/v3/secrets/raw/')) {
          const key = z.string().min(1).parse(url.split('/api/v3/secrets/raw/')[1]?.split('?')[0]);
          const body = z.object({ secretValue: z.string().optional() }).passthrough()
            .parse(JSON.parse(String(init?.body || '{}')));
          if (dropWrites) return Response.json({ ok: true });
          const idx = rows.findIndex((r) => r.secretKey === key);
          if (idx >= 0) rows[idx] = { secretKey: key, secretValue: body.secretValue ?? '' };
          else rows.push({ secretKey: key, secretValue: body.secretValue ?? '' });
          return Response.json({ ok: true });
        }
        return new Response('not found', { status: 404 });
      }),
    );
    seq += 1;
    adminEnv = {
      ...env,
      INFISICAL_BASE_URL: 'https://infisical.test',
      INFISICAL_ENV: 'prod',
      INFISICAL_ALLOW_ENV_FALLBACK: 'false',
      INFISICAL_APP_PROJECT_ID: `dm-admin-${seq}`,
      INFISICAL_APP_CLIENT_ID: `dm-admin-client-${seq}`,
      INFISICAL_APP_CLIENT_SECRET: `dm-admin-client-secret-${seq}-long-enough`,
    } as unknown as Env;
    await initSettings(adminEnv);
  });

  async function put(body: Record<string, unknown>): Promise<Response> {
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/admin', buildAdminRouter());
    return app.request(
      '/api/admin/settings',
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer admin-secret-value-long-enough-0123456789',
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'jay@example.com',
        },
        body: JSON.stringify(body),
      },
      adminEnv,
    );
  }

  it('writes Infisical, audits who/when/from/to/why, and switches the live mode', async () => {
    const res = await put({ key: 'CT_DELIVERY_MODE', value: 'Suppress', reason: 'bulk Trump republish' });
    expect(res.status).toBe(200);
    const json = z.object({ ok: z.boolean(), value: z.string(), previousMode: z.string(), audit: z.object({ id: z.string() }) })
      .passthrough().parse(await res.json());
    expect(json).toMatchObject({ ok: true, value: 'suppress', previousMode: 'deliver' });
    expect(rows.find((r) => r.secretKey === 'CT_DELIVERY_MODE')?.secretValue).toBe('suppress');
    expect(readDeliveryMode()).toBe('suppress');
    const audit = z.array(z.record(z.string(), z.unknown())).parse(sqlite.prepare('SELECT * FROM delivery_mode_audit').all());
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      id: json.audit.id,
      mode: 'suppress',
      previous_mode: 'deliver',
      // Bearer ADMIN_TOKEN caller: the Cf-Access email header is client
      // supplied, so it is recorded only as an unverified claim.
      actor: 'admin-token (unverified claim: jay@example.com)',
      reason: 'bulk Trump republish',
    });
  });

  it('never copies the free-form reason into logs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect((await put({ key: 'CT_DELIVERY_MODE', value: 'hold', reason: 'private operator note 7Q' })).status).toBe(200);
      const logged = warn.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
      expect(logged).toContain('delivery_mode.changed deliver -> hold');
      expect(logged).not.toContain('private operator note 7Q');
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects a body with unexpected properties or a non-string value (zod, strict)', async () => {
    expect((await put({ key: 'CT_DELIVERY_MODE', value: 'hold', reason: 'x', actor: 'someone' })).status).toBe(400);
    expect((await put({ key: 'CT_DELIVERY_MODE', value: 'hold', reason: 7 })).status).toBe(400);
    expect(rows.some((r) => r.secretKey === 'CT_DELIVERY_MODE')).toBe(false);
    expect(readDeliveryMode()).toBe('deliver');
  });

  it('returns 502 and audits nothing when the live snapshot does not show the saved mode', async () => {
    // Infisical accepts the write but the refreshed list does not carry it.
    dropWrites = true;
    const res = await put({ key: 'CT_DELIVERY_MODE', value: 'hold', reason: 'check' });
    expect(res.status).toBe(502);
    expect(z.object({ liveMode: z.string() }).passthrough().parse(await res.json()).liveMode).toBe('deliver');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM delivery_mode_audit').get()).toEqual({ n: 0 });
  });

  it('rejects unknown modes and a pause without a reason, changing nothing', async () => {
    expect((await put({ key: 'CT_DELIVERY_MODE', value: 'off', reason: 'x' })).status).toBe(400);
    expect((await put({ key: 'CT_DELIVERY_MODE', value: 'hold' })).status).toBe(400);
    expect(rows.some((r) => r.secretKey === 'CT_DELIVERY_MODE')).toBe(false);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM delivery_mode_audit').get()).toEqual({ n: 0 });
    expect(readDeliveryMode()).toBe('deliver');
  });

  it('switching back to deliver needs no reason and is audited', async () => {
    await put({ key: 'CT_DELIVERY_MODE', value: 'hold', reason: 'check' });
    const res = await put({ key: 'CT_DELIVERY_MODE', value: 'deliver' });
    expect(res.status).toBe(200);
    expect(readDeliveryMode()).toBe('deliver');
    const modes = sqlite.prepare('SELECT mode, previous_mode FROM delivery_mode_audit ORDER BY rowid').all();
    expect(modes).toEqual([
      { mode: 'hold', previous_mode: 'deliver' },
      { mode: 'deliver', previous_mode: 'hold' },
    ]);
  });
});
