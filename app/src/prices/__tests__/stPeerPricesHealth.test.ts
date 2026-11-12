import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import {
  collectStPeerPricesMetrics,
  stPeerPricesMetricsToCheck,
} from '../stPeerPricesHealth.ts';

vi.mock('../../enrichment/service.ts', () => ({
  hasConfiguredKeyedEnrichmentProvider: vi.fn(async () => true),
}));

vi.mock('../../shared/db.ts', () => ({
  get: vi.fn(),
  all: vi.fn(async () => []),
}));

import { all, get } from '../../shared/db.ts';
import { PRICE_DRAIN_LAST_PROGRESS_KEY } from '../peerPriceDrainProgress.ts';

function envWithKv(store = new Map<string, string>()): Env {
  return {
    DB: {},
    CONFIG_KV: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
    },
  } as Env;
}

describe('stPeerPricesHealth', () => {
  const env = envWithKv();
  const now = new Date('2026-10-23T15:00:00.000Z');

  beforeEach(() => {
    vi.mocked(get).mockReset();
    vi.mocked(all).mockReset();
    vi.mocked(all).mockResolvedValue([]);
  });

  it('maps a stalled metrics payload to a stalled pipeline check', async () => {
    const stalledEnv = envWithKv(new Map([
      [PRICE_DRAIN_LAST_PROGRESS_KEY, '2026-10-21T00:00:00.000Z'],
    ]));
    vi.mocked(get).mockResolvedValueOnce({
      n: 1200,
      never_n: 50,
      oldest_at: '2026-10-01T00:00:00.000Z',
    });
    vi.mocked(get).mockResolvedValueOnce({ d: '2026-10-22' });
    vi.mocked(get).mockResolvedValueOnce({ n: 0 });

    const metrics = await collectStPeerPricesMetrics(stalledEnv, now, 6);
    expect(metrics.stalled).toBe(true);
    expect(metrics.pending).toBe(1200);
    expect(metrics.detail).toContain('no drain progress');
    expect(metrics.notCovered).toBe(0);
    expect(metrics.notCoveredSample).toEqual([]);

    const check = stPeerPricesMetricsToCheck(metrics);
    expect(check.id).toBe('st_peer_prices');
    expect(check.status).toBe('stalled');
    expect(check.detail).toContain('Socratic.Trade');
    expect(check.value).toMatchObject({ pending: 1200, notCovered: 0, notCoveredSample: [] });
  });

  it('reports ok when there is no pending backlog', async () => {
    vi.mocked(get).mockResolvedValueOnce({ n: 0, never_n: 0, oldest_at: null });
    vi.mocked(get).mockResolvedValueOnce({ d: '2026-10-22' });
    vi.mocked(get).mockResolvedValueOnce({ n: 0 });

    const metrics = await collectStPeerPricesMetrics(env, now, 6);
    expect(metrics.stalled).toBe(false);
    expect(stPeerPricesMetricsToCheck(metrics).status).toBe('ok');
  });

  it('carries the not-covered count + sample in the check value and detail without degrading', async () => {
    vi.mocked(get).mockResolvedValueOnce({ n: 0, never_n: 0, oldest_at: null });
    vi.mocked(get).mockResolvedValueOnce({ d: '2026-10-22' });
    vi.mocked(get).mockResolvedValueOnce({ n: 3 });
    vi.mocked(all).mockResolvedValueOnce([
      { ticker: 'AAA' },
      { ticker: 'BBB' },
      { ticker: 'CCC' },
    ]);

    const metrics = await collectStPeerPricesMetrics(env, now, 6);
    expect(metrics.pending).toBe(0);
    expect(metrics.notCovered).toBe(3);
    expect(metrics.notCoveredSample).toEqual(['AAA', 'BBB', 'CCC']);

    const check = stPeerPricesMetricsToCheck(metrics);
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('; 3 not covered by ST');
    expect(check.value).toMatchObject({
      pending: 0,
      notCovered: 3,
      notCoveredSample: ['AAA', 'BBB', 'CCC'],
    });
  });

  it('appends the not-covered suffix to the stalled detail when both are present', async () => {
    const stalledEnv = envWithKv(new Map([
      [PRICE_DRAIN_LAST_PROGRESS_KEY, '2026-10-21T00:00:00.000Z'],
    ]));
    vi.mocked(get).mockResolvedValueOnce({
      n: 12,
      never_n: 12,
      oldest_at: '2026-10-01T00:00:00.000Z',
    });
    vi.mocked(get).mockResolvedValueOnce({ d: '2026-10-22' });
    vi.mocked(get).mockResolvedValueOnce({ n: 2 });
    vi.mocked(all).mockResolvedValueOnce([{ ticker: 'AAA' }, { ticker: 'BBB' }]);
    vi.mocked(all).mockResolvedValueOnce([{ ticker: 'PEND1' }]);

    const metrics = await collectStPeerPricesMetrics(stalledEnv, now, 6);
    expect(metrics.stalled).toBe(true);
    expect(metrics.notCovered).toBe(2);

    const check = stPeerPricesMetricsToCheck(metrics);
    expect(check.status).toBe('stalled');
    expect(check.detail).toContain('; 2 not covered by ST');
  });

  it('keeps an in-progress backlog under the threshold ok, with pending visible (Kody #3)', async () => {
    const movingEnv = envWithKv(new Map([
      [PRICE_DRAIN_LAST_PROGRESS_KEY, '2026-10-23T13:00:00.000Z'],
    ]));
    vi.mocked(get).mockResolvedValueOnce({ n: 12, never_n: 0, oldest_at: '2026-10-01T00:00:00.000Z' });
    vi.mocked(get).mockResolvedValueOnce({ d: '2026-10-22' });

    const metrics = await collectStPeerPricesMetrics(movingEnv, now, 6);
    expect(metrics.stalled).toBe(false);
    const check = stPeerPricesMetricsToCheck(metrics);
    expect(check.status).toBe('ok');
    expect((check.value as { pending: number }).pending).toBe(12);
    expect(check.detail).toContain('12 ticker(s) pending');
    expect(check.detail).toContain('drain progress');
    expect(check.detail).toContain('2.0h ago');
  });

  it('keeps a tail-only backlog with a current corpus ok (Kody #3)', async () => {
    vi.mocked(get).mockResolvedValueOnce({ n: 2, never_n: 2, oldest_at: '2026-10-20T00:00:00.000Z' });
    vi.mocked(get).mockResolvedValueOnce({ d: '2026-10-22' });

    const metrics = await collectStPeerPricesMetrics(env, now, 6);
    expect(metrics.stalled).toBe(false);
    expect(stPeerPricesMetricsToCheck(metrics).status).toBe('ok');
  });

  it('does not throw out of health when the corpus date read fails (Kody #4)', async () => {
    vi.mocked(get).mockResolvedValueOnce({ n: 12, never_n: 0, oldest_at: null });
    vi.mocked(get).mockRejectedValueOnce(new Error('D1 statement error: SQLITE_BUSY'));

    const metrics = await collectStPeerPricesMetrics(env, now, 6);
    expect(metrics.corpusLatestDate).toBeNull();
    expect(metrics.skip).toBe(false);
    expect(metrics.stalled).toBe(true);
    expect(stPeerPricesMetricsToCheck(metrics).status).toBe('stalled');
  });

  it('stalls a pending backlog that has no drain-progress stamp, without saying neverh', async () => {
    vi.mocked(get).mockResolvedValueOnce({ n: 7, never_n: 0, oldest_at: null });
    vi.mocked(get).mockResolvedValueOnce({ d: '2026-10-22' });

    const metrics = await collectStPeerPricesMetrics(env, now, 6);
    expect(metrics.stalled).toBe(true);
    expect(metrics.detail).toContain('drain progress never');
    expect(metrics.detail).not.toContain('neverh');
  });

  it('does not stall when every pending ticker is never-priced and drain has not started', async () => {
    vi.mocked(get).mockResolvedValueOnce({ n: 2, never_n: 2, oldest_at: null });
    vi.mocked(get).mockResolvedValueOnce({ d: null });

    const metrics = await collectStPeerPricesMetrics(env, now, 6);
    expect(metrics.stalled).toBe(false);
    expect(metrics.detail).toContain('never-priced');
    expect(metrics.detail).not.toContain('drain progress never');
  });

  it('does not stall on old pending rows when KV shows recent drain progress (CT-2469)', async () => {
    const kv = envWithKv(new Map([
      [PRICE_DRAIN_LAST_PROGRESS_KEY, '2026-10-23T14:30:00.000Z'],
    ]));
    vi.mocked(get).mockResolvedValueOnce({
      n: 950,
      never_n: 10,
      oldest_at: '2026-10-08T12:00:00.000Z',
    });
    vi.mocked(get).mockResolvedValueOnce({ d: '2026-10-22' });

    const metrics = await collectStPeerPricesMetrics(kv, now, 6);
    expect(metrics.stalled).toBe(false);
    expect(metrics.oldestPendingCheckedAt).toBe('2026-10-08T12:00:00.000Z');
    expect(metrics.detail).toContain('oldest pending check');
  });

  it('no longer runs the full-table MAX(price_checked_at) read (Kody #5)', async () => {
    vi.mocked(get).mockResolvedValueOnce({ n: 0, never_n: 0, oldest_at: null });
    vi.mocked(get).mockResolvedValue({ d: '2026-10-22' });

    await collectStPeerPricesMetrics(env, now, 6);
    const sqls = vi.mocked(get).mock.calls.map((c) => String(c[1]));
    expect(sqls.some((q) => /MAX\(price_checked_at\)\s+AS at FROM securities_ref/i.test(q))).toBe(false);
  });
});
