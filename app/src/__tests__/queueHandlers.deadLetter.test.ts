import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Env, QueueMessage } from '../shared/types.ts';

// recordDeadLetterDurable's own behavior (receipt insert + alerting) is
// covered by delivery/__tests__/deadLetter.test.ts; stub it here so this
// suite is a focused unit test of handleDeadLetterMessage's own
// terminal-stamp wiring, not an integration test of the alerting stack.
const recordDeadLetterDurable = vi.fn(async () => {});
vi.mock('../delivery/deadLetter.ts', () => ({
  recordDeadLetterDurable: (...args: unknown[]) => recordDeadLetterDurable(...args),
}));

import { handleDeadLetterMessage } from '../queueHandlers.ts';

/**
 * Minimal combined in-memory mock covering exactly the two tables
 * handleDeadLetterMessage's ingestion path touches: ingestion_outbox (read
 * by reconnectDeadLetteredIngestionOutbox) and filings (written by the new
 * autonomy terminal-stamp). Mirrors ingestion/__tests__/outbox.test.ts's
 * row-mock technique.
 */
function makeEnv(opts: { deadLetterCycles: number; outboxStatus?: string; filingIngestStatus?: string }) {
  const outboxRow = {
    doc_id: 'doc_1', chamber: 'house' as const, source_url: 'https://example.com/doc.pdf',
    status: opts.outboxStatus ?? 'enqueued', attempts: 3, available_at: '2026-01-01T00:00:00.000Z',
    dead_letter_cycles: opts.deadLetterCycles,
    updated_at: '2026-01-01T00:00:00.000Z',
    last_error: null as string | null,
  };
  const filingRow = {
    doc_id: 'doc_1',
    ingest_status: opts.filingIngestStatus ?? 'fetched',
    error: null as string | null,
  };
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) { this.params = params; return this; },
    async all<T>() {
      if (/FROM ingestion_outbox WHERE doc_id = \?/i.test(sql)) return { results: [outboxRow] as T[] };
      return { results: [] as T[] };
    },
    async first<T>() {
      return null as T | null;
    },
    async run() {
      if (/status = 'failed'/i.test(sql) && /ingestion_outbox/i.test(sql)) {
        outboxRow.status = 'failed';
        outboxRow.last_error = String(this.params[0]);
        return { success: true, meta: { changes: 1 } };
      }
      if (/status = 'pending'/i.test(sql) && /ingestion_outbox/i.test(sql)) {
        outboxRow.status = 'pending';
        outboxRow.dead_letter_cycles += 1;
        return { success: true, meta: { changes: 1 } };
      }
      if (/UPDATE filings\s+SET ingest_status = 'error'/i.test(sql)) {
        const [errorMsg, docId] = this.params as [string, string];
        if (docId === filingRow.doc_id && filingRow.ingest_status !== 'persisted' && filingRow.ingest_status !== 'error') {
          filingRow.ingest_status = 'error';
          filingRow.error = errorMsg;
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      }
      return { success: true, meta: { changes: 0 } };
    },
  });
  const env = {
    DB: { prepare } as unknown as D1Database,
  } as unknown as Env;
  return { env, outboxRow, filingRow };
}

describe('handleDeadLetterMessage: filings terminal-stamp on outbox exhaustion', () => {
  beforeEach(() => {
    recordDeadLetterDurable.mockClear();
  });

  it('stamps filings.ingest_status = error when the outbox dead-letter budget is exhausted', async () => {
    const { env, filingRow } = makeEnv({ deadLetterCycles: 5 });
    const msg: QueueMessage = { type: 'filing.fetched', docId: 'doc_1' } as QueueMessage;

    await handleDeadLetterMessage(env, 'ingest', msg, 8);

    expect(filingRow.ingest_status).toBe('error');
    expect(filingRow.error).toMatch(/autonomy: ingestion outbox dead-letter budget exhausted/);
    expect(filingRow.error).toContain('ingest/filing.fetched');
  });

  it('leaves filings.ingest_status untouched when the outbox still has retry budget', async () => {
    const { env, filingRow } = makeEnv({ deadLetterCycles: 1 });
    const msg: QueueMessage = { type: 'filing.fetched', docId: 'doc_1' } as QueueMessage;

    await handleDeadLetterMessage(env, 'ingest', msg, 8);

    expect(filingRow.ingest_status).toBe('fetched');
    expect(filingRow.error).toBeNull();
  });

  it('never clobbers an already-persisted filing even if its outbox row was dead-lettered', async () => {
    const { env, filingRow } = makeEnv({ deadLetterCycles: 5, filingIngestStatus: 'persisted' });
    const msg: QueueMessage = { type: 'filing.fetched', docId: 'doc_1' } as QueueMessage;

    await handleDeadLetterMessage(env, 'ingest', msg, 8);

    expect(filingRow.ingest_status).toBe('persisted');
  });
});
