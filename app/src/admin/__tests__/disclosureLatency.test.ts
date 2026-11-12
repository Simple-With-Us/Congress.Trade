import { describe, expect, it } from 'vitest';
import { buildAdminRouter } from '../routes.ts';

const app = buildAdminRouter();

function recentIso(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

function fakeDb() {
  // Keep deltas deterministic (210s monitor, 120s published) inside the 72h window.
  const congressFirst = recentIso(6);
  const providerPublished = new Date(Date.parse(congressFirst) + 120_000).toISOString();
  const providerFirst = new Date(Date.parse(congressFirst) + 210_000).toISOString();
  return {
    prepare(sql: string) {
      return {
        params: [] as unknown[],
        bind(...params: unknown[]) {
          this.params = params;
          return this;
        },
        async all<T>() {
          if (/FROM trade_latency_candidates/i.test(sql)) {
            return {
              results: [
                {
                  trade_hash: 'test_hash_123',
                  doc_id: 'H-2026-20012345',
                  provider: 'fmp',
                  chamber: 'house',
                  source_url: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20012345.pdf',
                  filed_date: congressFirst.slice(0, 10),
                  filer_name: 'Jane Smith',
                  congress_first_seen_at: congressFirst,
                  provider_key: '20012345',
                  provider_first_seen_at: providerFirst,
                  provider_published_at: providerPublished,
                  match_method: 'trade-hash',
                  status: 'matched',
                  attempts: 2,
                  last_checked_at: providerFirst,
                  error: null,
                  created_at: congressFirst,
                  updated_at: providerFirst,
                },
              ] as T[],
            };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          return null as T | null;
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;
}

describe('admin disclosure latency API', () => {
  it('lists congress.trade-vs-FMP observations with computed provider delta', async () => {
    const res = await app.request(
      '/disclosure-latency',
      { headers: { Authorization: 'Bearer admin-secret' } },
      { ADMIN_TOKEN: 'admin-secret', DB: fakeDb() } as never,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ docId: string; providerDeltaSec: number; providerPublishedDeltaSec: number; status: string }>;
    };
    expect(body.items).toEqual([
      expect.objectContaining({
        docId: 'H-2026-20012345',
        providerDeltaSec: 210,
        providerPublishedDeltaSec: 120,
        status: 'matched',
      }),
    ]);
  });

  it('returns aggregate metrics and a public-safe summary payload', async () => {
    const res = await app.request(
      '/disclosure-latency/summary',
      { headers: { Authorization: 'Bearer admin-secret' } },
      { ADMIN_TOKEN: 'admin-secret', FMP_LATENCY_API_KEY: 'configured', DB: fakeDb() } as never,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: { candidates: number; matched: number; configuredComparableProviders: number };
      providers: Array<{ provider: string; avgMonitorDeltaSec: number | null; avgProviderPublishedDeltaSec: number | null }>;
      publicSummary: { providers: Array<{ provider: string }> };
    };
    // Free-tier FMP_LATENCY_* configures stable only; RapidAPI needs RAPIDAPI_KEY /
    // FMP_RAPIDAPI_KEY (ST marketplace convention). So one configured path here.
    expect(body.totals).toEqual(expect.objectContaining({ candidates: 1, matched: 1, configuredComparableProviders: 1 }));
    expect(body.providers.find((p) => p.provider === 'fmp')).toEqual(
      expect.objectContaining({ provider: 'fmp', avgMonitorDeltaSec: 210, avgProviderPublishedDeltaSec: 120 }),
    );
    expect(JSON.stringify(body.publicSummary)).not.toContain('H-2026-20012345');
  });
});
