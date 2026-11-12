import { describe, expect, it, beforeEach } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { runTickerBackfill } from '../routes.ts';
import { clearResolverCache } from '../../extraction/normalizer.ts';

beforeEach(() => {
  clearResolverCache();
});

describe('runTickerBackfill', () => {
  it('retroactively repairs preferred/depositary share rows collapsed to issuer tickers', async () => {
    const updates: Array<{ ticker: string; rowKey: string | null; id: string }> = [];
    const securities = [
      { ticker: 'T', name: 'AT&T Inc.', aliases: '[]' },
      { ticker: 'JPM', name: 'JPMorgan Chase & Co.', aliases: '[]' },
    ];
    const transactions = [
      {
        id: 'tx-jpm',
        ticker: 'JPM',
        asset_name: 'JPMorgan Chase & Co. Depositary Shares, Series GG',
        tx_date: '2026-01-02',
        owner: 'self',
        asset_type: 'ST',
        asset_type_name: 'Stocks (including ADRs)',
        tx_type: 'B',
        amount_min: 1001,
        amount_max: 15000,
        is_option: 0,
        cap_gains_over_200: 0,
        raw_text: '',
        filing_status: null,
        subholding: null,
        location: null,
        description: null,
        supplemental_text: null,
        source: 'primary',
        row_key: 'v1:primary:0:oldjpm',
      },
      {
        id: 'tx-t',
        ticker: 'T',
        asset_name:
          'AT&T Inc. Depositary Shares, each representing a 1/1,000th interest in a share of 5.000% Perpetual Preferred Stock, Series A',
        tx_date: '2026-01-03',
        owner: 'spouse',
        asset_type: 'ST',
        asset_type_name: 'Stocks (including ADRs)',
        tx_type: 'S',
        amount_min: 15001,
        amount_max: 50000,
        is_option: 0,
        cap_gains_over_200: 0,
        raw_text: '',
        filing_status: null,
        subholding: null,
        location: null,
        description: null,
        supplemental_text: null,
        source: 'primary',
        row_key: 'v1:primary:1:oldt',
      },
      { id: 'tx-common', ticker: 'JPM', asset_name: 'JPMorgan Chase & Co. Common Stock' },
    ];

    const env = {
      DB: {
        prepare(sql: string) {
          return {
            _params: [] as unknown[],
            bind(...params: unknown[]) {
              this._params = params;
              return this;
            },
            async all<T>() {
              if (/FROM securities_master/i.test(sql)) return { results: securities as unknown as T[] };
              if (/FROM transactions/i.test(sql)) return { results: transactions as unknown as T[] };
              return { results: [] as T[] };
            },
          };
        },
        async batch(statements: Array<{ _params: unknown[] }>) {
          for (const stmt of statements) {
            updates.push({
              ticker: String(stmt._params[0]),
              rowKey: stmt._params[1] == null ? null : String(stmt._params[1]),
              id: String(stmt._params[2]),
            });
          }
          return statements.map(() => ({ success: true, meta: { changes: 1 } }));
        },
      } as unknown as D1Database,
    } as Env;

    const result = await runTickerBackfill(env, 10);
    expect(result).toEqual({ scanned: 3, resolved: 2 });
    expect(updates.map(({ id, ticker }) => ({ id, ticker }))).toEqual([
      { id: 'tx-jpm', ticker: 'JPM^J' },
      { id: 'tx-t', ticker: 'T^A' },
    ]);
    expect(updates[0].rowKey).toMatch(/^v1:primary:0:/);
    expect(updates[0].rowKey).not.toBe('v1:primary:0:oldjpm');
    expect(updates[1].rowKey).toMatch(/^v1:primary:1:/);
    expect(updates[1].rowKey).not.toBe('v1:primary:1:oldt');
  });
});
