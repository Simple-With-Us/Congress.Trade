import { describe, it, expect, vi, beforeEach } from 'vitest';
import { preclassifyDocKind } from '../watcher.ts';
import { S3BucketShim, D1DatabaseShim } from '../../deno/shims.ts';
import { ensureBusyTimeout } from '../../shared/db.ts';
import { sendPushover } from '../../shared/pushover.ts';
import { OpenRouterVisionExtractor } from '../../extraction/openRouterVision.ts';
import {
  clearCronTickOverrun,
  recordCronTickOverrun,
  tickOutcomeShouldRecord,
} from '../../shared/cronDeadlineSignal.ts';
import type { Env } from '../../shared/types.ts';

describe('R3: Pipeline Robustification', () => {
  describe('1. Discovery Doc-Kind Pre-Classification', () => {
    it('pre-classifies senate_html based on URL pattern / content-type', () => {
      expect(preclassifyDocKind('https://efdsearch.senate.gov/search/view/ptr/123/', 'senate', 'text/html')).toBe('senate_html');
      expect(preclassifyDocKind('https://example.com/doc.html', 'senate')).toBe('senate_html');
    });

    it('pre-classifies scanned_pdf based on paper/scanned markers', () => {
      expect(preclassifyDocKind('https://example.com/scanned_paper_doc.pdf', 'house', 'application/pdf')).toBe('scanned_pdf');
      expect(preclassifyDocKind('https://example.com/paper.pdf', 'house')).toBe('scanned_pdf');
    });

    it('pre-classifies text_pdf for standard House PTRs or pdf links', () => {
      expect(preclassifyDocKind('https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2024/20024115.pdf', 'house')).toBe('text_pdf');
      expect(preclassifyDocKind('https://example.com/doc.pdf', 'house', 'application/pdf')).toBe('text_pdf');
    });

    it('falls back to unknown for ambiguous non-matching URLs', () => {
      expect(preclassifyDocKind('https://example.com/unknown_resource', null, 'text/plain')).toBe('unknown');
    });
  });

  describe('2. SQLite Write-Lock Discipline', () => {
    it('executes PRAGMA busy_timeout = 10000 on database connection', async () => {
      const runFn = vi.fn(async () => ({ success: true }));
      const prepareFn = vi.fn(() => ({ run: runFn }));
      const mockDb = { prepare: prepareFn } as unknown as D1Database;

      await ensureBusyTimeout(mockDb);

      expect(prepareFn).toHaveBeenCalledWith('PRAGMA busy_timeout = 10000;');
      expect(runFn).toHaveBeenCalled();
    });

    it('delegates D1DatabaseShim.batch to libsql write-mode without nested BEGIN', async () => {
      // libsql batch(stmts, "write") already opens a transaction; an extra
      // BEGIN IMMEDIATE inside it causes SQLITE_ERROR nested-transaction failures
      // in production (review confirm/reject, watcher, cron lanes).
      const mockClient = {
        batch: vi.fn(async (stmts: unknown[]) => {
          return stmts.map(() => ({ rows: [], rowsAffected: 1 }));
        }),
      };
      const shim = new D1DatabaseShim(mockClient as any);
      const stmt1 = shim.prepare('INSERT INTO test VALUES (1)');
      const stmt2 = shim.prepare('UPDATE test SET val = 2');

      const results = await shim.batch([stmt1, stmt2]);

      expect(results).toHaveLength(2);
      expect(mockClient.batch).toHaveBeenCalledTimes(1);
      const [calledStmts, mode] = mockClient.batch.mock.calls[0] as [Array<{ sql: string }>, string];
      expect(mode).toBe('write');
      expect(calledStmts.map((s) => s.sql)).toEqual([
        'INSERT INTO test VALUES (1)',
        'UPDATE test SET val = 2',
      ]);
      // Must NOT wrap with BEGIN/COMMIT — that nests inside libsql's write txn.
      expect(calledStmts.some((s) => /^BEGIN/i.test(s.sql))).toBe(false);
      expect(calledStmts.some((s) => /^COMMIT/i.test(s.sql))).toBe(false);
    });
  });

  describe('3. R2 Post-Write Verification', () => {
    it('issues a HeadObjectCommand check immediately after PutObjectCommand in S3BucketShim.put()', async () => {
      const sendFn = vi.fn(async () => ({}));
      const mockS3 = { send: sendFn };
      const bucket = new S3BucketShim(mockS3 as any, 'test-bucket');

      await bucket.put('raw/test-doc', new Uint8Array([1, 2, 3]), {
        httpMetadata: { contentType: 'application/pdf' },
      });

      expect(sendFn).toHaveBeenCalledTimes(2);
      const firstCommand = sendFn.mock.calls[0][0];
      const secondCommand = sendFn.mock.calls[1][0];

      expect(firstCommand.constructor.name).toBe('PutObjectCommand');
      expect(secondCommand.constructor.name).toBe('HeadObjectCommand');
      expect(secondCommand.input).toEqual({
        Bucket: 'test-bucket',
        Key: 'raw/test-doc',
      });
    });
  });

  describe('4. OpenRouter Budget Failover & Pushover Alerts', () => {
    it('catches HTTP 402 budget error, triggers Pushover alert, and attempts failover to backup key', async () => {
      const mockFetch = vi.fn(async (url: string, opts: any) => {
        const auth = opts?.headers?.Authorization || '';
        if (url.includes('pushover')) {
          return new Response(JSON.stringify({ status: 1 }), { status: 200 });
        }
        if (auth.includes('primary-key')) {
          return new Response(JSON.stringify({ error: { message: 'Out of credits' } }), { status: 402, statusText: 'Payment Required' });
        }
        if (auth.includes('backup-key')) {
          return new Response(
            JSON.stringify({
              id: 'gen-123',
              choices: [{ message: { content: '[]' } }],
              usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      });

      const env = {
        OPENROUTER_API_KEY: 'primary-key',
        OPENROUTER_BACKUP_API_KEY: 'backup-key',
        PUSHOVER_APP_TOKEN: 'push-app',
        PUSHOVER_USER_KEY: 'push-user',
      } as any;

      const extractor = new OpenRouterVisionExtractor(env, 'openai/gpt-4o-mini', 'OPENROUTER_API_KEY');

      // Intercept global fetch
      const origFetch = globalThis.fetch;
      globalThis.fetch = mockFetch as any;

      try {
        const result = await extractor.extract({
          filing: { docId: 'doc-123', chamber: 'house', sourceUrl: 'https://example.com/test.pdf' },
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
        });

        expect(result.transactions).toEqual([]);
        // Verify Pushover notification was sent
        const pushoverCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('pushover'));
        expect(pushoverCalls.length).toBeGreaterThan(0);

        // Verify backup key was used
        const backupCalls = mockFetch.mock.calls.filter(
          ([url, opts]) => String(url).includes('openrouter') && (opts?.headers?.Authorization || '').includes('backup-key'),
        );
        expect(backupCalls).toHaveLength(1);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  describe('5. Cron deadline loud-fail and recovery', () => {
    function kvEnv() {
      const store = new Map<string, string>();
      const env = {
        CONFIG_KV: {
          get: async (key: string) => {
            const raw = store.get(key);
            return raw ? JSON.parse(raw) : null;
          },
          put: async (key: string, value: string) => {
            store.set(key, value);
          },
          delete: async (key: string) => {
            store.delete(key);
          },
        },
      } as unknown as Env;
      return { env, store };
    }

    it('records a deadline abort and a SQLITE_BUSY skip, and ignores a plain overlap', () => {
      expect(tickOutcomeShouldRecord({
        aborted: true,
        skippedOverlap: false,
        errors: ['tick: aborted'],
      })).toBe('tick: aborted');
      expect(tickOutcomeShouldRecord({
        aborted: false,
        skippedOverlap: true,
        errors: ['tick_singleton_unavailable: SQLITE_BUSY: database is locked'],
      })).toContain('SQLITE_BUSY');
      expect(tickOutcomeShouldRecord({
        aborted: false,
        skippedOverlap: true,
        errors: [],
      })).toBeNull();
    });

    it('keeps one episode across a racing double record, then clears on a finished tick', async () => {
      const { env, store } = kvEnv();
      const now = new Date('2026-10-05T18:00:00.000Z');
      const first = await recordCronTickOverrun(env, {
        deadlineMs: 45000,
        reason: 'Deno cron tick exceeded 45000ms deadline',
        now,
      });
      const second = await recordCronTickOverrun(env, {
        deadlineMs: 45000,
        reason: 'Deno cron tick exceeded 45000ms deadline',
        now: new Date(now.getTime() + 1000),
      });
      expect(first?.count).toBe(1);
      expect(second?.count).toBe(1);
      expect(store.size).toBe(1);

      const later = await recordCronTickOverrun(env, {
        deadlineMs: 45000,
        reason: 'SQLITE_BUSY: database is locked',
        now: new Date(now.getTime() + 120_000),
      });
      expect(later?.count).toBe(2);
      expect(later?.reason).toContain('SQLITE_BUSY');

      await clearCronTickOverrun(env);
      expect(store.size).toBe(0);
    });
  });
});
