import { describe, expect, it } from 'vitest';
import { buildAdminRouter } from '../routes.ts';
import type { Env, PollConfig } from '../../shared/types.ts';

describe('source health status', () => {
  it('bounds history per source and gives errors precedence over staleness', async () => {
    const sqlSeen: string[] = [];
    const paramsSeen: unknown[][] = [];
    const config: PollConfig = {
      schedule: [{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startHourET: 0, endHourET: 24, intervalSec: 300 }],
      aggressiveMode: false,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const env = {
      ADMIN_OPEN_IN_DEV: 'true',
      CONFIG_KV: {
        async get(key: string) { return key === 'poll_config' ? config : null; },
        async put() {}, async delete() {},
      },
      DB: {
        prepare(sql: string) {
          sqlSeen.push(sql);
          return {
            params: [] as unknown[], bind(...params: unknown[]) {
              this.params = params;
              paramsSeen.push(params);
              return this;
            },
            async first<T>() { return null as T | null; },
            async all<T>() {
              if (/FROM ingest_log/i.test(sql) && /GROUP BY/i.test(sql)) {
                return { results: [
                  { source: 'house', last_polled_at: '2020-01-01T00:00:00.000Z', poll_count: 4, total_new: 2, last_new_at: null },
                  { source: 'senate', last_polled_at: '2020-01-01T00:00:00.000Z', poll_count: 4, total_new: 1, last_new_at: null },
                  { source: 'executive', last_polled_at: '2020-01-01T00:00:00.000Z', poll_count: 4, total_new: 1, last_new_at: null },
                ] as T[] };
              }
              if (/ROW_NUMBER\(\) OVER/i.test(sql)) {
                return { results: [
                  { id: 1, source: 'house', attempted_at: '2020-01-01T00:00:00.000Z', outcome: 'success', new_count: 0, error: null },
                  { id: 2, source: 'senate', attempted_at: '2020-01-01T00:00:00.000Z', outcome: 'failure', new_count: 0, error: 'upstream blocked' },
                ] as T[] };
              }
              return { results: [] as T[] };
            },
          };
        },
      } as unknown as D1Database,
    } as unknown as Env;

    const response = await buildAdminRouter().request('http://localhost/sources/health', {}, env);
    expect(response.status).toBe(200);
    const body = await response.json() as { sources: Array<Record<string, unknown>> };
    const house = body.sources.find((source) => source.source === 'house');
    const senate = body.sources.find((source) => source.source === 'senate');
    const exec = body.sources.find((source) => source.source === 'executive');
    expect(house).toMatchObject({ status: 'stale', stale: true, effectivePollIntervalSec: 300, staleAfterSec: 900 });
    expect(senate).toMatchObject({ status: 'error', stale: true, lastError: 'upstream blocked' });
    expect(exec).toMatchObject({ stale: true, staleAfterSec: 10800 });
    expect(body.sources.filter((source) => source.source === 'executive' || source.source === 'oge')).toHaveLength(1);
    const ingestSql = sqlSeen.find((sql) => /FROM ingest_log/i.test(sql) && /GROUP BY/i.test(sql)) ?? '';
    expect(ingestSql).toMatch(/lower\(source\) IN \('oge', 'exec'\)/);
    const ranked = sqlSeen.find((sql) => /ROW_NUMBER/.test(sql)) ?? '';
    expect(ranked).toMatch(/lower\(source\) IN \('oge', 'exec'\)/);
    expect(ranked).toContain('WHERE rn <= ?');
    expect(paramsSeen.some((params) => params[0] === 'executive')).toBe(true);
  });
});
