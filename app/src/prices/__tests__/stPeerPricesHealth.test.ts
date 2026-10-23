import { describe, expect, it, vi } from 'vitest';
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

  it('maps a stalled metrics payload to a stalled pipeline check', async () => {
    vi.mocked(get).mockResolvedValueOnce({
      n: 1200,
      never_n: 50,
      last_at: '2026-10-21T00:00:00.000Z',
    });
    vi.mocked(get).mockResolvedValueOnce({ d: '2026-10-22' });
    vi.mocked(get).mockResolvedValueOnce({ at: '2026-10-22T12:00:00.000Z' });

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
});
