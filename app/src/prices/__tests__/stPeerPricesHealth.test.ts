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

import { get } from '../../shared/db.ts';

describe('stPeerPricesHealth', () => {
  const env = { DB: {} } as Env;
  const now = new Date('2026-10-23T15:00:00.000Z');

  beforeEach(() => {
    vi.mocked(get).mockReset();
  });

  it('maps a stalled metrics payload to a stalled pipeline check', async () => {
    vi.mocked(get).mockResolvedValueOnce({
      n: 1200,
      never_n: 50,
      last_at: '2026-10-21T00:00:00.000Z',
    });
    vi.mocked(get).mockResolvedValueOnce({ d: '2026-10-22' });

    const metrics = await collectStPeerPricesMetrics(env, now, 6);
    expect(metrics.stalled).toBe(true);
    expect(metrics.pending).toBe(1200);

    const check = stPeerPricesMetricsToCheck(metrics);
    expect(check.id).toBe('st_peer_prices');
    expect(check.status).toBe('stalled');
    expect(check.detail).toContain('Socratic.Trade');
  });

  it('reports ok when there is no pending backlog', async () => {
    vi.mocked(get).mockResolvedValueOnce({ n: 0, never_n: 0, last_at: null });

    const metrics = await collectStPeerPricesMetrics(env, now, 6);
    expect(metrics.stalled).toBe(false);
    expect(stPeerPricesMetricsToCheck(metrics).status).toBe('ok');
  });

  it('keeps an in-progress backlog under the threshold ok, with pending visible (Kody #3)', async () => {
    vi.mocked(get).mockResolvedValueOnce({ n: 12, never_n: 0, last_at: '2026-10-23T13:00:00.000Z' });
    vi.mocked(get).mockResolvedValueOnce({ d: '2026-10-22' });

    const metrics = await collectStPeerPricesMetrics(env, now, 6);
    expect(metrics.stalled).toBe(false);
    const check = stPeerPricesMetricsToCheck(metrics);
    expect(check.status).toBe('ok');
    expect((check.value as { pending: number }).pending).toBe(12);
    expect(check.detail).toContain('12 ticker(s) pending');
    expect(check.detail).toContain('2.0h ago');
  });

  it('keeps a tail-only backlog with a current corpus ok (Kody #3)', async () => {
    vi.mocked(get).mockResolvedValueOnce({ n: 2, never_n: 2, last_at: '2026-10-20T00:00:00.000Z' });
    vi.mocked(get).mockResolvedValueOnce({ d: '2026-10-22' });

    const metrics = await collectStPeerPricesMetrics(env, now, 6);
    expect(metrics.stalled).toBe(false);
    expect(stPeerPricesMetricsToCheck(metrics).status).toBe('ok');
  });

  it('does not throw out of health when the corpus date read fails (Kody #4)', async () => {
    vi.mocked(get).mockResolvedValueOnce({ n: 12, never_n: 0, last_at: '2026-10-23T13:00:00.000Z' });
    vi.mocked(get).mockRejectedValueOnce(new Error('D1 statement error: SQLITE_BUSY'));

    const metrics = await collectStPeerPricesMetrics(env, now, 6);
    expect(metrics.corpusLatestDate).toBeNull();
    expect(metrics.skip).toBe(false);
    expect(stPeerPricesMetricsToCheck(metrics).status).toBe('ok');
  });

  it('renders never, not neverh ago, when pending tickers have no progress stamp (Kody #6)', async () => {
    vi.mocked(get).mockResolvedValueOnce({ n: 7, never_n: 0, last_at: null });
    vi.mocked(get).mockResolvedValueOnce({ d: '2026-10-22' });

    const metrics = await collectStPeerPricesMetrics(env, now, 6);
    expect(metrics.detail).toContain('progress never on pending set');
    expect(metrics.detail).not.toContain('neverh');
  });

  it('no longer runs the full-table MAX(price_checked_at) read (Kody #5)', async () => {
    vi.mocked(get).mockResolvedValueOnce({ n: 0, never_n: 0, last_at: null });
    vi.mocked(get).mockResolvedValue({ d: '2026-10-22' });

    await collectStPeerPricesMetrics(env, now, 6);
    const sqls = vi.mocked(get).mock.calls.map((c) => String(c[1]));
    expect(sqls.some((q) => /MAX\(price_checked_at\)\s+AS at FROM securities_ref/i.test(q))).toBe(false);
  });
});
