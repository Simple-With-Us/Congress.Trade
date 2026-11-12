import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { D1DatabaseShim } from '../shims.ts';
import {
  hasDrainableWork,
  probePendingWork,
  runScheduledTick,
  tickLockErrorShouldFailOpen,
} from '../scheduledTick.ts';
import { withSqliteLockRetry } from '../../shared/db.ts';
import type { DenoCostProfile } from '../costProfile.ts';
import type { DurableQueueHandlers } from '../durableQueue.ts';

vi.mock('../../extraction/agreement.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../extraction/agreement.ts')>();
  return {
    ...actual,
    maybeRunAgreementAutopublish: vi.fn(async () => ({ attempted: 0, enqueued: 0, terminalized: 0 })),
  };
});
vi.mock('../../extraction/autopilot.ts', () => ({
  maybeStartBacklogAutopilot: vi.fn(async () => ({ blocked: 'not_due' as const })),
}));
vi.mock('../../secrets/infisical.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../secrets/infisical.ts')>();
  return {
    ...actual,
    refreshSecrets: vi.fn(async () => ({
      enabled: false,
      cacheReady: false,
      cacheAgeSeconds: null,
      cacheTtlSeconds: 0,
      cacheExpiresInSeconds: null,
      envFallbackAllowed: true,
      lastRefreshAt: null,
      errors: [],
      sources: [],
    })),
  };
});

import { maybeRunAgreementAutopublish } from '../../extraction/agreement.ts';
import { maybeStartBacklogAutopilot } from '../../extraction/autopilot.ts';
import { refreshSecrets } from '../../secrets/infisical.ts';

const FREE: DenoCostProfile = {
  name: 'free',
  cronSchedule: '*/5 * * * *',
  drainLimit: 3,
  drainClaimSize: 1,
  outboxLimit: 20,
  disableInternalCron: false,
  idleShortCircuit: true,
};

async function makeDb() {
  const client = createClient({ url: 'file::memory:' });
  await client.execute(`
    CREATE TABLE deno_runtime_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_name TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      dead_letter_pending INTEGER NOT NULL DEFAULT 0,
      dead_letter_cycles INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      lease_until TEXT,
      lease_token TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE ingestion_outbox (
      doc_id TEXT PRIMARY KEY,
      chamber TEXT,
      source_url TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      dead_letter_cycles INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT
    )
  `);
  await client.execute(`
    CREATE TABLE delivery_outbox (
      tx_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      dead_letter_cycles INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT
    )
  `);
  await client.execute(`
    CREATE TABLE deno_runtime_kv (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      expires_at INTEGER,
      PRIMARY KEY (namespace, key)
    )
  `);
  const db = new D1DatabaseShim(client as never) as unknown as D1Database;
  return { client, db };
}

function emptyHandlers(): DurableQueueHandlers {
  return {
    handleIngestMessage: vi.fn(async () => {}),
    handleDeliveryMessage: vi.fn(async () => true),
    handleDeadLetterMessage: vi.fn(async () => {}),
    handleCorruptDeadLetterMessage: vi.fn(async () => {}),
    isTerminalDeadLetterError: () => false,
    completeIngestionOutbox: vi.fn(async () => {}),
    completeDeliveryOutbox: vi.fn(async () => {}),
  };
}

describe('probePendingWork / hasDrainableWork', () => {
  it('reports no work on empty tables', async () => {
    const { db } = await makeDb();
    const env = { DB: db } as unknown as Env;
    const probe = await probePendingWork(env, new Date('2026-07-25T12:00:00.000Z'));
    expect(probe).toEqual({
      ingestQueue: false,
      deliveryQueue: false,
      ingestionOutbox: false,
      deliveryOutbox: false,
      eligibleReview: false,
    });
    expect(hasDrainableWork(probe)).toBe(false);
  });

  it('detects pending queue and outbox rows', async () => {
    const { client, db } = await makeDb();
    const now = '2026-07-25T12:00:00.000Z';
    await client.execute({
      sql: `INSERT INTO deno_runtime_queue
        (queue_name, payload, status, available_at, created_at, updated_at)
        VALUES ('ingest', '{}', 'pending', ?, ?, ?)`,
      args: [now, now, now],
    });
    await client.execute({
      sql: `INSERT INTO delivery_outbox
        (tx_id, status, available_at, updated_at)
        VALUES ('tx1', 'pending', ?, ?)`,
      args: [now, now],
    });
    const env = { DB: db } as unknown as Env;
    const probe = await probePendingWork(env, new Date(now));
    expect(probe.ingestQueue).toBe(true);
    expect(probe.deliveryOutbox).toBe(true);
    expect(probe.eligibleReview).toBe(false);
    expect(hasDrainableWork(probe)).toBe(true);
  });

  it('treats claimable eligible-due review rows as drainable work', async () => {
    const { client, db } = await makeDb();
    const now = '2026-08-18T23:00:00.000Z';
    await client.execute(`
      CREATE TABLE review_queue (
        doc_id TEXT PRIMARY KEY,
        resolved INTEGER,
        agreement_suppressed_at TEXT,
        agreement_attempts INTEGER,
        agreement_next_attempt_at TEXT,
        agreement_claim_token TEXT,
        agreement_claimed_at TEXT,
        reason TEXT
      )
    `);
    await client.execute(`
      CREATE TABLE filings (
        doc_id TEXT PRIMARY KEY,
        raw_object_key TEXT,
        doc_kind TEXT
      )
    `);
    await client.execute(`
      CREATE TABLE transactions (
        id INTEGER PRIMARY KEY,
        doc_id TEXT,
        source TEXT,
        deprecated_at TEXT
      )
    `);
    await client.execute({
      sql: `INSERT INTO review_queue
        (doc_id, resolved, agreement_suppressed_at, agreement_attempts, reason)
        VALUES ('H-2026-20000001', 0, NULL, 0, 'agreement_cascade_unresolved')`,
      args: [],
    });
    await client.execute({
      sql: `INSERT INTO filings (doc_id, raw_object_key, doc_kind)
        VALUES ('H-2026-20000001', 'raw/H-2026-20000001.pdf', 'ptr_pdf')`,
      args: [],
    });
    const env = { DB: db } as unknown as Env;
    const probe = await probePendingWork(env, new Date(now));
    expect(probe.eligibleReview).toBe(true);
    expect(hasDrainableWork(probe)).toBe(true);
  });

  it('does not treat attempt-capped cascade disagreements as selector-due work', async () => {
    const { client, db } = await makeDb();
    const now = '2026-08-18T23:00:00.000Z';
    await client.execute(`
      CREATE TABLE review_queue (
        doc_id TEXT PRIMARY KEY,
        resolved INTEGER,
        agreement_suppressed_at TEXT,
        agreement_attempts INTEGER,
        agreement_next_attempt_at TEXT,
        agreement_claim_token TEXT,
        agreement_claimed_at TEXT,
        reason TEXT
      )
    `);
    await client.execute(`
      CREATE TABLE filings (
        doc_id TEXT PRIMARY KEY,
        raw_object_key TEXT,
        doc_kind TEXT
      )
    `);
    await client.execute(`
      CREATE TABLE transactions (
        id INTEGER PRIMARY KEY,
        doc_id TEXT,
        source TEXT,
        deprecated_at TEXT
      )
    `);
    await client.execute({
      sql: `INSERT INTO review_queue
        (doc_id, resolved, agreement_suppressed_at, agreement_attempts, reason)
        VALUES ('H-2026-20000002', 0, NULL, 3, 'agreement_cascade_unresolved')`,
      args: [],
    });
    await client.execute({
      sql: `INSERT INTO filings (doc_id, raw_object_key, doc_kind)
        VALUES ('H-2026-20000002', 'raw/H-2026-20000002.pdf', 'ptr_pdf')`,
      args: [],
    });
    const env = { DB: db } as unknown as Env;
    const probe = await probePendingWork(env, new Date(now));
    expect(probe.eligibleReview).toBe(false);
    expect(hasDrainableWork(probe)).toBe(false);
  });
});

function testEnv(db: D1Database, extra: Record<string, unknown> = {}): Env {
  // Stamp daily jobs done so maybeRunDailyJobs is a cheap no-op.
  const day = '2026-07-25';
  return {
    DB: db,
    CONFIG_KV: {
      get: vi.fn(async (key: string) => {
        if (key === 'jobs:daily:lastdate') return day;
        if (key === 'poll_config') {
          return {
            schedule: [
              { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startHourET: 0, endHourET: 24, intervalSec: 3600 },
            ],
            aggressiveMode: false,
            updatedAt: '2026-07-25T00:00:00.000Z',
          };
        }
        // last_poll:* stamps — treat as just polled so watcher skips sources.
        if (key.startsWith('last_poll:')) return new Date('2026-07-25T11:30:00.000Z').toISOString();
        return null;
      }),
      put: vi.fn(async () => {}),
    },
    ...extra,
  } as unknown as Env;
}

describe('runScheduledTick idle short-circuit', () => {
  beforeEach(() => {
    vi.mocked(maybeRunAgreementAutopublish).mockClear();
    vi.mocked(maybeStartBacklogAutopilot).mockClear();
    vi.mocked(refreshSecrets).mockClear();
  });

  it('skips drain path when idleShortCircuit and no pending work', async () => {
    const { db } = await makeDb();
    const handlers = emptyHandlers();
    const result = await runScheduledTick(
      testEnv(db),
      handlers,
      FREE,
      new Date('2026-07-25T12:00:00.000Z'),
    );
    expect(result.skippedDrain).toBe(true);
    expect(result.drained).toBeNull();
    expect(result.ingestionOutbox).toBeNull();
    expect(result.apnsFanout).toEqual({
      skipped: 'not_configured',
      trades: 0,
      reviews: 0,
      delivered: 0,
      retired: 0,
    });
    expect(handlers.handleIngestMessage).not.toHaveBeenCalled();
    // Autonomy lanes still run even when the drain short-circuits.
    expect(refreshSecrets).toHaveBeenCalledOnce();
    expect(maybeRunAgreementAutopublish).toHaveBeenCalledOnce();
    expect(maybeStartBacklogAutopilot).toHaveBeenCalledOnce();
    expect(result.agreementAutopublish).toEqual({ attempted: 0, enqueued: 0, terminalized: 0 });
    expect(result.autopilot).toEqual({ blocked: 'not_due' });
  });

  it('does not skip when idleShortCircuit is off', async () => {
    const { db } = await makeDb();
    const handlers = emptyHandlers();
    const result = await runScheduledTick(
      testEnv(db, {
        INGEST_QUEUE: { send: vi.fn(async () => {}) },
        DELIVERY_QUEUE: { send: vi.fn(async () => {}) },
      }),
      handlers,
      { ...FREE, idleShortCircuit: false },
      new Date('2026-07-25T12:00:00.000Z'),
    );
    expect(result.skippedDrain).toBe(false);
    expect(result.drained).not.toBeNull();
    expect(result.drained?.ingest.claimed).toBe(0);
    expect(maybeRunAgreementAutopublish).toHaveBeenCalledOnce();
    expect(maybeStartBacklogAutopilot).toHaveBeenCalledOnce();
  });

  it('drains after agreement enqueue even when the queue was empty at tick start', async () => {
    const { client, db } = await makeDb();
    const handlers = emptyHandlers();
    const now = '2026-07-25T12:00:00.000Z';
    vi.mocked(maybeRunAgreementAutopublish).mockImplementation(async () => {
      // Simulate the enqueue side-effect of maybeRunAgreementAutopublish with a
      // canonical ingest message (agreement.check also works; filing.fetched is
      // enough to prove the post-enqueue drain probe sees new work).
      await client.execute({
        sql: `INSERT INTO deno_runtime_queue
          (queue_name, payload, status, available_at, created_at, updated_at)
          VALUES ('ingest', ?, 'pending', ?, ?, ?)`,
        args: [JSON.stringify({ type: 'filing.fetched', docId: 'H-1' }), now, now, now],
      });
      return { attempted: 1, enqueued: 1, terminalized: 0 };
    });
    const result = await runScheduledTick(
      testEnv(db, {
        INGEST_QUEUE: { send: vi.fn(async () => {}) },
        DELIVERY_QUEUE: { send: vi.fn(async () => {}) },
      }),
      handlers,
      FREE,
      new Date(now),
    );
    expect(result.skippedDrain).toBe(false);
    expect(result.agreementAutopublish).toEqual({ attempted: 1, enqueued: 1, terminalized: 0 });
    expect(result.drained?.ingest.claimed).toBe(1);
    expect(handlers.handleIngestMessage).toHaveBeenCalledOnce();
  });
});

describe('runScheduledTick singleton + abort', () => {
  beforeEach(() => {
    vi.mocked(maybeRunAgreementAutopublish).mockClear();
    vi.mocked(maybeStartBacklogAutopilot).mockClear();
    vi.mocked(refreshSecrets).mockClear();
  });

  it('skips the tick when another live tick holds the singleton lock', async () => {
    const { client, db } = await makeDb();
    const now = new Date('2026-07-25T12:00:00.000Z');
    await client.execute({
      sql: `INSERT INTO deno_runtime_kv (namespace, key, value, expires_at)
        VALUES ('locks', 'scheduled-tick', 'other-tick', ?)`,
      args: [now.getTime() + 60_000],
    });

    const result = await runScheduledTick(testEnv(db), emptyHandlers(), FREE, now);
    expect(result.skippedOverlap).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.errors).toEqual([]);
    // No lanes ran while the lock was contended.
    expect(refreshSecrets).not.toHaveBeenCalled();
    expect(maybeRunAgreementAutopublish).not.toHaveBeenCalled();
    // The contender's lock is left untouched.
    const rows = await client.execute(
      `SELECT value FROM deno_runtime_kv WHERE namespace = 'locks' AND key = 'scheduled-tick'`,
    );
    expect(rows.rows[0].value).toBe('other-tick');
  });

  it('takes over an expired singleton lock and releases it after the tick', async () => {
    const { client, db } = await makeDb();
    const now = new Date('2026-07-25T12:00:00.000Z');
    await client.execute({
      sql: `INSERT INTO deno_runtime_kv (namespace, key, value, expires_at)
        VALUES ('locks', 'scheduled-tick', 'crashed-tick', ?)`,
      args: [now.getTime() - 1_000],
    });

    const result = await runScheduledTick(testEnv(db), emptyHandlers(), FREE, now);
    expect(result.skippedOverlap).toBe(false);
    expect(refreshSecrets).toHaveBeenCalledOnce();
    const rows = await client.execute(
      `SELECT value FROM deno_runtime_kv WHERE namespace = 'locks' AND key = 'scheduled-tick'`,
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('stops between lanes when the abort signal fires', async () => {
    const { db } = await makeDb();
    const controller = new AbortController();
    controller.abort(new Error('deadline'));
    const result = await runScheduledTick(
      testEnv(db),
      emptyHandlers(),
      FREE,
      new Date('2026-07-25T12:00:00.000Z'),
      { signal: controller.signal },
    );
    expect(result.aborted).toBe(true);
    expect(result.skippedOverlap).toBe(false);
    expect(result.errors).toContain('tick: aborted');
    expect(refreshSecrets).not.toHaveBeenCalled();
    expect(maybeRunAgreementAutopublish).not.toHaveBeenCalled();
  });

  it('does not fail open on a busy, locked, or in-progress singleton lock', () => {
    expect(tickLockErrorShouldFailOpen(new Error('SQLITE_BUSY'))).toBe(false);
    expect(tickLockErrorShouldFailOpen(new Error('database is locked'))).toBe(false);
    expect(tickLockErrorShouldFailOpen(new Error('cannot commit transaction - SQL statements in progress'))).toBe(false);
    expect(tickLockErrorShouldFailOpen(new Error('no such table: deno_runtime_kv'))).toBe(true);
  });

  it('skips the tick when acquiring the singleton lock throws SQLITE_BUSY', async () => {
    const { db } = await makeDb();
    const busy = {
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        return {
          bind(...args: unknown[]) {
            stmt.bind(...args);
            return {
              run: async () => {
                throw new Error('SQLITE_BUSY: database is locked');
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runScheduledTick(
        testEnv(busy),
        emptyHandlers(),
        FREE,
        new Date('2026-07-25T12:00:00.000Z'),
      );
      expect(result.skippedOverlap).toBe(true);
      expect(result.errors).toEqual([
        'tick_singleton_unavailable: SQLITE_BUSY: database is locked',
      ]);
      expect(refreshSecrets).not.toHaveBeenCalled();
      expect(maybeRunAgreementAutopublish).not.toHaveBeenCalled();
      expect(errorSpy.mock.calls.some((args) => String(args[0]).includes('running unguarded'))).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('still runs the tick when the singleton lock table is missing', async () => {
    const { client, db } = await makeDb();
    await client.execute('DROP TABLE deno_runtime_kv');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runScheduledTick(
        testEnv(db),
        emptyHandlers(),
        FREE,
        new Date('2026-07-25T12:00:00.000Z'),
      );
      expect(result.skippedOverlap).toBe(false);
      expect(result.errors.some((entry) => entry.startsWith('tick_singleton_unavailable:') && entry.includes('no such table'))).toBe(true);
      expect(refreshSecrets).toHaveBeenCalledOnce();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('retries a busy write three times and does not retry a missing table', async () => {
    let busyCalls = 0;
    await expect(withSqliteLockRetry(async () => {
      busyCalls += 1;
      throw new Error('SQLITE_BUSY: database is locked');
    })).rejects.toThrow('SQLITE_BUSY');
    expect(busyCalls).toBe(4);

    let missingCalls = 0;
    await expect(withSqliteLockRetry(async () => {
      missingCalls += 1;
      throw new Error('no such table: source_attempts');
    })).rejects.toThrow('no such table');
    expect(missingCalls).toBe(1);
  });
});
