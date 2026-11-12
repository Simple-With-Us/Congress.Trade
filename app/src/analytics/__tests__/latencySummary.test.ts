import { describe, expect, it } from 'vitest';
import { buildAnalyticsRouter } from '../routes.ts';

const app = buildAnalyticsRouter();

/**
 * Fake D1 returning two matched fmp candidates and nothing for the other
 * providers, mirroring the production race-monitor tables.
 */
function recentIso(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

function fakeDb() {
  const t0 = recentIso(6);
  const t1 = recentIso(4.5);
  const t2 = recentIso(10);
  const t3 = recentIso(9.5);
  const t4 = recentIso(5);
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
                  provider: 'fmp',
                  trade_hash: 'hash_a',
                  status: 'matched',
                  chamber: 'house',
                  provider_key: 'k1',
                  congress_first_seen_at: t0,
                  provider_first_seen_at: t1,
                  provider_published_at: null,
                  match_method: 'trade-hash',
                  filed_date: t0.slice(0, 10),
                  created_at: t0,
                  updated_at: t1,
                },
                {
                  provider: 'fmp',
                  trade_hash: 'hash_b',
                  status: 'matched',
                  chamber: 'house',
                  provider_key: 'k2',
                  congress_first_seen_at: t2,
                  provider_first_seen_at: t3,
                  provider_published_at: null,
                  match_method: 'fuzzy-no-ticker',
                  filed_date: t2.slice(0, 10),
                  created_at: t2,
                  updated_at: t3,
                },
                {
                  provider: 'unusual_whales',
                  trade_hash: 'hash_c',
                  status: 'pending',
                  chamber: 'house',
                  provider_key: null,
                  congress_first_seen_at: t4,
                  provider_first_seen_at: null,
                  provider_published_at: null,
                  match_method: null,
                  filed_date: t4.slice(0, 10),
                  created_at: t4,
                  updated_at: t4,
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

function fakeEnv() {
  return {
    DB: fakeDb(),
    CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
    FMP_LATENCY_API_KEY: 'k',
  } as never;
}

function fairnessEnv() {
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const candidates = Array.from({ length: 20 }, (_, i) => ({
    provider: 'fmp',
    // Realistic `lastName_TICKER_DATE_side` shape — the scope denominator
    // rejects hashes with no filer segment, so a synthetic id would drop out.
    trade_hash: `pelosi_TICK${i}_2026-06-01_buy`,
    status: i < 10 ? 'matched' : 'pending',
    chamber: 'house',
    provider_key: i < 10 ? `fmp-key-${i}` : null,
    match_method: i < 10 ? 'trade-hash' : null,
    congress_first_seen_at: old,
    provider_first_seen_at: old,
    provider_published_at: null,
    filed_date: old.slice(0, 10),
    created_at: old,
    updated_at: old,
  }));
  const observations = Array.from({ length: 20 }, (_, i) => ({
    provider: 'fmp',
    chamber: 'house',
    provider_key: `fmp-key-${i}`,
    // Realistic `lastName_TICKER_DATE_side` shape — the scope denominator
    // rejects hashes with no filer segment, so a synthetic id would drop out.
    trade_hash: `pelosi_TICK${i}_2026-06-01_buy`,
    first_observed_at: old,
    last_observed_at: old,
    provider_published_at: null,
    source_url: null,
    filed_date: `2026-06-${(i + 1).toString().padStart(2, '0')}`,
    filer_name: `Pelosi ${i}`,
    payload: null,
  }));
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return this;
          },
          async all<T>() {
            if (/FROM trade_latency_candidates/i.test(sql)) return { results: candidates as T[] };
            if (/FROM trade_provider_observations/i.test(sql)) return { results: observations as T[] };
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
    },
    CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
    FMP_LATENCY_API_KEY: 'k',
  } as never;
}

describe('GET /latency-summary (public speed scoreboard)', () => {
  it('serves aggregate provider metrics with public field names', async () => {
    const res = await app.request('http://localhost/latency-summary', {}, fakeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    const body = (await res.json()) as {
      generatedAt: string;
      windowHours: number;
      windowDays: number;
      maxConcurrentDeltaHours: number;
      totals: { racedDisclosures: number; matched: number; comparableProviders: number };
      providers: Array<Record<string, unknown>>;
    };
    expect(body.windowHours).toBe(168);
    expect(body.windowDays).toBe(7);
    expect(body.maxConcurrentDeltaHours).toBe(336);
    expect(body.totals.racedDisclosures).toBe(3);
    // hash_a is a `trade-hash` pairing; hash_b is `fuzzy-no-ticker`, which
    // never verified WHICH security was traded. Only the strong one is allowed
    // to carry the speed claim.
    expect(body.totals.matched).toBe(1);
    const fmp = body.providers.find((p) => p.id === 'fmp');
    expect(fmp).toMatchObject({
      // Public scoreboard collapses stable + RapidAPI into one FinancialModelingPrep.com lane.
      label: 'FinancialModelingPrep.com',
      operationalStatus: 'running',
      candidates: 2,
      matched: 1,
      strongMatched: 1,
      // Reported beside the headline, never inside it.
      weakMatched: 1,
      usFirstCount: 1,
      providerFirstCount: 0,
      // Only hash_a's delta (+5400s) times the race; hash_b's +1800s is weak.
      medianLeadSec: 5400,
      avgLeadSec: 5400,
    });
    // RapidAPI must not appear as a separate public provider.
    expect(body.providers.find((p) => p.id === 'fmp_rapidapi')).toBeUndefined();
    // Stopped/unconfigured lanes stay off the public list.
    expect(body.providers.find((p) => p.id === 'unusual_whales')).toBeUndefined();
    expect(body.providers.find((p) => p.id === 'quiver')).toBeUndefined();
    const admin = (body as { adminProviders: Array<Record<string, unknown>> }).adminProviders;
    expect(admin.find((p) => p.id === 'fmp')).toMatchObject({
      label: 'FinancialModelingPrep.com',
      publiclyShown: true,
    });
    expect(admin.find((p) => p.id === 'unusual_whales')).toMatchObject({
      publiclyShown: false,
      matched: 0,
    });
  });

  it('never leaks per-filing or member detail', async () => {
    const res = await app.request('http://localhost/latency-summary', {}, fakeEnv());
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain('doc_id');
    expect(raw).not.toContain('docId');
    expect(raw).not.toContain('filerName');
    expect(raw).not.toContain('sourceUrl');
    // No internal provider-configuration hints on the public contract.
    expect(raw).not.toContain('configured');
    expect(raw).not.toContain('requiresMembership');
  });

  it('keeps provider-only rows in the denominator and suppresses a speed claim when overlap is incomplete', async () => {
    const res = await app.request('http://localhost/latency-summary', {}, fairnessEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: Array<Record<string, unknown>> };
    const fmp = body.providers.find((p) => p.id === 'fmp');
    expect(fmp).toMatchObject({
      providerObserved: 20,
      maturedProviderObserved: 20,
      maturedMatched: 10,
      unmatchedProvider: 10,
      ctCoveragePct: 50,
      providerCoveragePct: 50,
      strongMatched: 10,
      // 10 concurrent races + incomplete coverage → preliminary soft claim, not full usable.
      comparisonStatus: 'preliminary',
      comparisonBasis: 'matched-overlap-only',
    });
  });

  it('publishes the "N of M matched" scope denominator both clients render', async () => {
    const res = await app.request('http://localhost/latency-summary', {}, fairnessEnv());
    const body = (await res.json()) as {
      totals: { scopeMatched?: number; scopeTotal?: number };
      scope: {
        windowHours: number;
        total: number;
        matched: number;
        ctOnly: number;
        providerOnly: number;
        matchedPct: number | null;
        excludedOutOfScope: number;
        excludedMissingFiler: number;
      };
    };
    // 20 House lines; both sides saw all 20 (one line, not two), and 10 are
    // strongly paired. M is the union, never the sum.
    expect(body.totals).toMatchObject({ scopeMatched: 10, scopeTotal: 20 });
    expect(body.scope).toMatchObject({
      windowHours: 336,
      total: 20,
      matched: 10,
      ctOnly: 0,
      providerOnly: 0,
      matchedPct: 50,
      excludedOutOfScope: 0,
      excludedMissingFiler: 0,
    });
  });

  it('times live matches with multi-day gaps and drops historical-crawl first_seen/filed lag', async () => {
    const now = Date.now();
    const ctSeen = new Date(now - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    const providerSeen = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5d ago — still within 14d
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async all<T>() {
              if (/FROM trade_latency_candidates/i.test(sql)) {
                return {
                  results: [
                    // Live: filed 2d before first_seen, provider 5d earlier → timed
                    {
                      provider: 'quiver',
                      trade_hash: 'q_hash_1',
                      status: 'matched',
                      chamber: 'senate',
                      provider_key: 'q1',
                      match_method: 'trade-hash',
                      congress_first_seen_at: ctSeen,
                      provider_first_seen_at: providerSeen,
                      provider_published_at: providerSeen,
                      filed_date: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
                      created_at: ctSeen,
                      updated_at: ctSeen,
                    },
                    // Historical crawl: filed years before first_seen → excluded
                    {
                      provider: 'quiver',
                      trade_hash: 'q_hash_2',
                      status: 'matched',
                      chamber: 'senate',
                      provider_key: 'q2',
                      match_method: 'trade-hash',
                      congress_first_seen_at: ctSeen,
                      provider_first_seen_at: ctSeen,
                      provider_published_at: ctSeen,
                      filed_date: '2024-01-01',
                      created_at: ctSeen,
                      updated_at: ctSeen,
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
      },
      CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
      QUIVER_API_KEY: 'k',
    } as never;
    const res = await app.request('http://localhost/latency-summary', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: Array<Record<string, unknown>> };
    const qq = body.providers.find((p) => p.id === 'quiver');
    expect(qq).toMatchObject({
      strongMatched: 1,
      matched: 1,
    });
    // Provider earlier by ~5d → negative lead (provider ahead)
    expect(Number(qq?.medianLeadSec)).toBeLessThan(0);
  });

  it('merges FMP stable + RapidAPI into one public FMP lane using earliest path stamp', async () => {
    const ct = recentIso(3);
    const rapidEarlier = recentIso(2.5); // RapidAPI saw first
    const stableLater = recentIso(2.0);
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async all<T>() {
              if (/FROM trade_latency_candidates/i.test(sql)) {
                return {
                  results: [
                    {
                      provider: 'fmp',
                      trade_hash: 'shared_trade',
                      status: 'matched',
                      chamber: 'house',
                      provider_key: 'stable-key',
                      match_method: 'trade-hash',
                      congress_first_seen_at: ct,
                      provider_first_seen_at: stableLater,
                      provider_published_at: null,
                      filed_date: ct.slice(0, 10),
                      created_at: ct,
                      updated_at: stableLater,
                    },
                    {
                      provider: 'fmp_rapidapi',
                      trade_hash: 'shared_trade',
                      status: 'matched',
                      chamber: 'house',
                      provider_key: 'rapid-key',
                      match_method: 'trade-hash',
                      congress_first_seen_at: ct,
                      provider_first_seen_at: rapidEarlier,
                      provider_published_at: null,
                      filed_date: ct.slice(0, 10),
                      created_at: ct,
                      updated_at: rapidEarlier,
                    },
                    {
                      provider: 'fmp',
                      trade_hash: 'only_stable',
                      status: 'matched',
                      chamber: 'house',
                      provider_key: 'stable-only',
                      match_method: 'trade-hash',
                      congress_first_seen_at: ct,
                      // CT ahead by 600s
                      provider_first_seen_at: new Date(Date.parse(ct) + 600_000).toISOString(),
                      provider_published_at: null,
                      filed_date: ct.slice(0, 10),
                      created_at: ct,
                      updated_at: ct,
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
      },
      CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
      FMP_LATENCY_API_KEY: 'k',
    } as never;
    const res = await app.request('http://localhost/latency-summary', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: { comparableProviders: number };
      providers: Array<Record<string, unknown>>;
    };
    expect(body.providers.filter((p) => String(p.id).startsWith('fmp'))).toHaveLength(1);
    expect(body.providers.find((p) => p.id === 'fmp_rapidapi')).toBeUndefined();
    const fmp = body.providers.find((p) => p.id === 'fmp')!;
    expect(fmp.label).toBe('FinancialModelingPrep.com');
    // Two distinct trades (shared_trade merged once + only_stable)
    expect(fmp.matched).toBe(2);
    expect(fmp.candidates).toBe(2);
    // shared: earliest = rapid (ct → rapidEarlier = +0.5h = +1800s)
    // only_stable: +600s → avg = (1800+600)/2 = 1200
    expect(fmp.avgLeadSec).toBe(1200);
    expect(fmp.medianLeadSec).toBe(1200);
    expect(fmp.usFirstCount).toBe(2);
  });

  it('uses Quiver monitor first-seen when provider_published_at is missing (no fake empty tie)', async () => {
    const ct = recentIso(4);
    // Provider first-seen 900s after CT; no Quiver_Upload_Time published stamp.
    const providerSeen = new Date(Date.parse(ct) + 900_000).toISOString();
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async all<T>() {
              if (/FROM trade_latency_candidates/i.test(sql)) {
                return {
                  results: [
                    {
                      provider: 'quiver',
                      trade_hash: 'qq1',
                      status: 'matched',
                      chamber: 'house',
                      provider_key: 'qq-key-1',
                      match_method: 'trade-hash',
                      congress_first_seen_at: ct,
                      provider_first_seen_at: providerSeen,
                      provider_published_at: null,
                      filed_date: ct.slice(0, 10),
                      created_at: ct,
                      updated_at: providerSeen,
                    },
                    {
                      provider: 'quiver',
                      trade_hash: 'qq2',
                      status: 'matched',
                      chamber: 'house',
                      provider_key: 'qq-key-2',
                      match_method: 'trade-hash',
                      congress_first_seen_at: ct,
                      provider_first_seen_at: new Date(Date.parse(ct) + 1_200_000).toISOString(),
                      provider_published_at: null,
                      filed_date: ct.slice(0, 10),
                      created_at: ct,
                      updated_at: ct,
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
      },
      CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
      QUIVER_API_KEY: 'k',
    } as never;
    const res = await app.request('http://localhost/latency-summary', {}, env);
    const body = (await res.json()) as { providers: Array<Record<string, unknown>> };
    const qq = body.providers.find((p) => p.id === 'quiver')!;
    expect(qq.matched).toBe(2);
    // Must expose real lead stats (not null/0-0 which the UI painted as "Preliminary tie").
    expect(qq.usFirstCount).toBe(2);
    expect(qq.providerFirstCount).toBe(0);
    expect(qq.tieCount).toBe(0);
    expect(qq.avgLeadSec).toBe(1050); // (900+1200)/2
    expect(qq.medianLeadSec).toBe(1050);
    expect(qq.comparisonStatus).toBe('preliminary');
  });

  it('marks comparison insufficient when matched identity exists but no usable race timestamps', async () => {
    const ct = recentIso(4);
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async all<T>() {
              if (/FROM trade_latency_candidates/i.test(sql)) {
                return {
                  results: [
                    {
                      provider: 'quiver',
                      trade_hash: 'qq-empty',
                      status: 'matched',
                      chamber: 'house',
                      provider_key: 'qq-empty-key',
                      match_method: 'trade-hash',
                      congress_first_seen_at: ct,
                      provider_first_seen_at: null,
                      provider_published_at: null,
                      filed_date: ct.slice(0, 10),
                      created_at: ct,
                      updated_at: ct,
                    },
                    {
                      provider: 'quiver',
                      trade_hash: 'qq-empty-2',
                      status: 'matched',
                      chamber: 'house',
                      provider_key: 'qq-empty-key-2',
                      match_method: 'trade-hash',
                      congress_first_seen_at: ct,
                      provider_first_seen_at: null,
                      provider_published_at: null,
                      filed_date: ct.slice(0, 10),
                      created_at: ct,
                      updated_at: ct,
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
      },
      CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
      QUIVER_API_KEY: 'k',
    } as never;
    const res = await app.request('http://localhost/latency-summary', {}, env);
    const body = (await res.json()) as { providers: Array<Record<string, unknown>> };
    const qq = body.providers.find((p) => p.id === 'quiver')!;
    expect(qq.matched).toBe(0);
    expect(qq.avgLeadSec).toBeNull();
    expect(qq.medianLeadSec).toBeNull();
    expect(qq.usFirstCount).toBe(0);
    expect(qq.comparisonStatus).toBe('insufficient');
  });

  it('degrades to an empty envelope when the latency tables are missing', async () => {
    const env = {
      DB: {
        prepare() {
          return {
            bind() {
              return this;
            },
            async all() {
              throw new Error('no such table: trade_latency_candidates');
            },
            async first() {
              return null;
            },
            async run() {
              return {};
            },
          };
        },
      },
      CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
    } as never;
    const res = await app.request('http://localhost/latency-summary', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { racedDisclosures: number } };
    expect(body.totals.racedDisclosures).toBe(0);
  });
});
