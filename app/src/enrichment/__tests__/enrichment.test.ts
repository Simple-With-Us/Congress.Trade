/**
 * src/enrichment/__tests__/enrichment.test.ts
 *
 * Unit tests for the pure enrichment core: market-cap bucketing, SIC→sector,
 * budget arithmetic, provider-merge, and the FMP / SEC-EDGAR response parsers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { marketCapBucket, sicToSector, remainingBudget, mergeRefs } from '../compute.ts';
import { parseFmpProfile } from '../fmp.ts';
import { parseCompanyTickers, parseSecSubmissions, padCik, buildSecProvider } from '../sec.ts';
import {
  enrichmentNeededSql,
  enrichmentChainNames,
  hasConfiguredKeyedEnrichmentProvider,
  runEnrichment,
  parseTransientRetryMarker,
  transientRetryEligible,
  nextTransientRetryMarker,
  obviousNonEquity,
  NO_PROVIDER_DATA_ERROR,
  NOT_AN_EQUITY_ERROR,
} from '../service.ts';
import { buildSocraticProvider, peerProfileSymbol, SOCRATIC_PROFILE_PATH } from '../socratic.ts';
import { __resetSharedEdgarPacerForTests } from '../../shared/pace.ts';
import { openMigratedD1 } from '../../prices/__tests__/sqliteD1.ts';

describe('marketCapBucket', () => {
  it('buckets by the standard thresholds', () => {
    expect(marketCapBucket(3.2e12)).toBe('mega');
    expect(marketCapBucket(200e9)).toBe('mega');
    expect(marketCapBucket(50e9)).toBe('large');
    expect(marketCapBucket(5e9)).toBe('mid');
    expect(marketCapBucket(1e9)).toBe('small');
    expect(marketCapBucket(1e8)).toBe('micro');
    expect(marketCapBucket(1e7)).toBe('nano');
  });
  it('is null for missing / non-positive', () => {
    expect(marketCapBucket(null)).toBeNull();
    expect(marketCapBucket(0)).toBeNull();
    expect(marketCapBucket(undefined)).toBeNull();
  });
});

describe('sicToSector', () => {
  it('maps SIC division ranges to coarse sectors', () => {
    expect(sicToSector(3674)).toBe('Manufacturing'); // semiconductors
    expect(sicToSector('6021')).toBe('Finance, Insurance & Real Estate');
    expect(sicToSector(7372)).toBe('Services'); // prepackaged software
    expect(sicToSector(1311)).toBe('Mining'); // crude petroleum
    expect(sicToSector(5812)).toBe('Retail Trade');
  });
  it('is null for missing/invalid', () => {
    expect(sicToSector(null)).toBeNull();
    expect(sicToSector('')).toBeNull();
    expect(sicToSector('abc')).toBeNull();
  });
});

describe('remainingBudget', () => {
  it('is cap minus used, never negative, optionally capped by runMax', () => {
    expect(remainingBudget(230, 0)).toBe(230);
    expect(remainingBudget(230, 200)).toBe(30);
    expect(remainingBudget(230, 999)).toBe(0);
    expect(remainingBudget(230, 100, 50)).toBe(50); // runMax wins
    expect(remainingBudget(230, 220, 50)).toBe(10); // budget wins
  });
});

describe('enrichmentNeededSql', () => {
  it('retries incomplete EDGAR/imported rows only when a keyed provider exists', () => {
    expect(enrichmentNeededSql('sr', false)).toBe('(sr.ticker IS NULL OR sr.enriched_at IS NULL)');
    const withKey = enrichmentNeededSql('sr', true);
    expect(withKey).toContain('sr.company_name IS NULL');
    expect(withKey).toContain('sr.country IS NULL');
    expect(withKey).toContain('sr.market_cap IS NULL');
    expect(withKey).toContain("sr.source LIKE '%socratic%'");
    expect(withKey).not.toContain("sr.source LIKE '%fmp%'");
    expect(withKey).toContain('AND NOT');
    expect(withKey).toContain(NO_PROVIDER_DATA_ERROR);
    expect(withKey).toContain('REPLACE');
    expect(enrichmentNeededSql('sr', false)).not.toContain(NO_PROVIDER_DATA_ERROR);
  });

  it('selects a ticker-shaped no-provider tombstone once, and skips spaced or non-equity names', async () => {
    const { db, close } = await openMigratedD1();
    try {
      const insertTx = db.prepare(
        `INSERT INTO transactions (id, ticker, asset_name, tx_date, source, created_at)
         VALUES (?, ?, ?, '2026-01-05', 'primary', '2026-01-05T00:00:00Z')`,
      );
      const insertRef = db.prepare(
        `INSERT INTO securities_ref (ticker, enriched_at, enrichment_error, source)
         VALUES (?, '2026-01-01T00:00:00.000Z', ?, ?)`,
      );
      insertTx.run('tx-a', 'AAPL', 'AAPL');
      insertRef.run('AAPL', NO_PROVIDER_DATA_ERROR, null);
      insertTx.run('tx-brk', 'BRK/B', 'BRK/B');
      insertRef.run('BRK/B', NO_PROVIDER_DATA_ERROR, null);
      insertTx.run('tx-spaced', 'MSFT', 'Microsoft Corp');
      insertRef.run('MSFT', NO_PROVIDER_DATA_ERROR, null);
      insertTx.run('tx-fund', 'QQQ', 'INDEX FUND');
      insertRef.run('QQQ', NO_PROVIDER_DATA_ERROR, null);
      insertTx.run('tx-muni', 'DALLAS WATER MUNICIPAL BOND', 'DALLAS WATER MUNICIPAL BOND');
      insertRef.run('DALLAS WATER MUNICIPAL BOND', NO_PROVIDER_DATA_ERROR, null);
      insertTx.run('tx-done', 'IBM', 'IBM');
      insertRef.run('IBM', NO_PROVIDER_DATA_ERROR, 'socratic');
      insertTx.run('tx-ne', 'CITY TREASURY NOTE', 'CITY TREASURY NOTE');
      insertRef.run('CITY TREASURY NOTE', NOT_AN_EQUITY_ERROR, null);

      const sql = `SELECT t.ticker AS ticker
        FROM transactions t
        LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
        WHERE t.ticker IS NOT NULL AND t.ticker <> ''
          AND ${enrichmentNeededSql('sr', true)}
        GROUP BY t.ticker
        ORDER BY t.ticker`;
      const tickers = db.prepare(sql).all().map((row) => String(row.ticker));
      expect(tickers).toEqual(['AAPL', 'BRK/B']);
    } finally {
      close();
    }
  });
});

describe('peer share-class alias and non-equity classification', () => {
  it('requests BRK/B as BRK.B and leaves other symbols unchanged', () => {
    expect(peerProfileSymbol('BRK/B')).toBe('BRK.B');
    expect(peerProfileSymbol('brk/b')).toBe('BRK.B');
    expect(peerProfileSymbol('BF/B')).toBe('BF.B');
    expect(peerProfileSymbol('AAPL')).toBe('AAPL');
    expect(peerProfileSymbol('BRK-B')).toBe('BRK-B');
    expect(peerProfileSymbol('ABCDEF/G')).toBe('ABCDEF/G');
  });

  it('asks the peer for the dotted symbol', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ ref: null }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const provider = buildSocraticProvider('https://socratic.trade', 'token', fetchImpl);
    expect(await provider.fetchRef('BRK/B')).toBeNull();
    expect(urls).toEqual([`https://socratic.trade${SOCRATIC_PROFILE_PATH}BRK.B`]);
  });

  it('classifies obvious non-tickers and not a normal 1-5 letter miss', () => {
    expect(obviousNonEquity('DALLAS WATER MUNICIPAL BOND')).toBe(true);
    expect(obviousNonEquity('CITY OF DALLAS')).toBe(true);
    expect(obviousNonEquity('SOME CORPORATE BOND')).toBe(true);
    expect(obviousNonEquity('TREASURY')).toBe(true);
    expect(obviousNonEquity('AAPL')).toBe(false);
    expect(obviousNonEquity('AAPL', 'CITY MUNICIPAL BOND')).toBe(false);
    expect(obviousNonEquity('BOND')).toBe(false);
    expect(obviousNonEquity('BRK/B')).toBe(false);
    expect(obviousNonEquity('BRK.B')).toBe(false);
  });
});

describe('hasConfiguredKeyedEnrichmentProvider', () => {
  // Async since the keys resolve through Infisical (env fallback in tests).
  it('detects any configured keyed market-data provider', async () => {
    expect(await hasConfiguredKeyedEnrichmentProvider({} as never)).toBe(false);
    // FMP and direct vendor keys are not enrichment providers.
    expect(await hasConfiguredKeyedEnrichmentProvider({ FMP_API_KEY: 'k' } as never)).toBe(false);
    expect(await hasConfiguredKeyedEnrichmentProvider({ FMP_API_KEY: 'k', FMP_ENRICHMENT_ENABLED: 'true' } as never)).toBe(false);
    expect(await hasConfiguredKeyedEnrichmentProvider({ MASSIVE_API_KEY: 'k' } as never)).toBe(false);
    expect(await hasConfiguredKeyedEnrichmentProvider({ TIINGO_API_KEY: 'k' } as never)).toBe(false);
    expect(await hasConfiguredKeyedEnrichmentProvider({ APP_B_IMPORT_URL: 'https://socratic.trade' } as never)).toBe(false);
    expect(await hasConfiguredKeyedEnrichmentProvider({
      APP_B_IMPORT_URL: 'https://socratic.trade',
      APP_B_INGEST_TOKEN: 'token',
    } as never)).toBe(true);
  });
});

describe('enrichmentChainNames', () => {
  it('is Socratic then EDGAR when the peer is configured, and never FMP', () => {
    expect(enrichmentChainNames({
      APP_B_IMPORT_URL: 'https://socratic.trade',
      APP_B_INGEST_TOKEN: 'token',
      FMP_API_KEY: 'k',
      MASSIVE_API_KEY: 'm',
    } as never)).toEqual(['socratic', 'edgar']);
    expect(enrichmentChainNames({ FMP_API_KEY: 'k' } as never)).toEqual(['edgar']);
  });
});

describe('mergeRefs', () => {
  it('layers a richer provider over a coarser one without erasing fields', () => {
    const edgar = { sector: 'Manufacturing', stateOfIncorp: 'DE', cik: '0000320193', source: 'edgar' };
    const fmp = { sector: 'Technology', marketCap: 3.2e12, country: 'US', isEtf: false, source: 'fmp' };
    const merged = mergeRefs('AAPL', [edgar, fmp]);
    expect(merged.sector).toBe('Technology'); // fmp overrides edgar
    expect(merged.stateOfIncorp).toBe('DE'); // kept from edgar
    expect(merged.marketCap).toBe(3.2e12);
    expect(merged.marketCapBucket).toBe('mega'); // recomputed
    expect(merged.country).toBe('US');
    expect(merged.source).toBe('edgar+fmp');
  });
  it('OR-s booleans and ignores null/empty overrides', () => {
    const merged = mergeRefs('SPY', [{ isEtf: true, sector: 'X' }, { isEtf: false, sector: null }]);
    expect(merged.isEtf).toBe(true);
    expect(merged.sector).toBe('X'); // null didn't erase it
  });
  it('normalizes company names when merging', () => {
    const merged = mergeRefs('CBS', [{ companyName: 'CBS CORPORATION' }]);
    expect(merged.companyName).toBe('CBS Corporation');
  });
});

describe('parseFmpProfile', () => {
  it('parses a profile array into a partial ref', () => {
    const r = parseFmpProfile([
      { symbol: 'AAPL', companyName: 'Apple Inc.', sector: 'Technology', industry: 'Consumer Electronics',
        mktCap: 3200000000000, country: 'US', state: 'CA', exchangeShortName: 'NASDAQ', currency: 'USD',
        ipoDate: '1980-12-12', cik: '0000320193', isEtf: false, isAdr: false },
    ]);
    expect(r).not.toBeNull();
    expect(r!.sector).toBe('Technology');
    expect(r!.marketCap).toBe(3200000000000);
    expect(r!.marketCapBucket).toBe('mega');
    expect(r!.assetClass).toBe('equity');
    expect(r!.exchangeShort).toBe('NASDAQ');
    expect(r!.source).toBe('fmp');
  });
  it('flags ETFs and returns null for an empty/unknown response', () => {
    expect(parseFmpProfile([{ symbol: 'SPY', isEtf: true }])!.assetClass).toBe('etf');
    expect(parseFmpProfile([])).toBeNull();
    expect(parseFmpProfile({})).toBeNull();
  });
});

describe('SEC EDGAR parsers', () => {
  it('padCik zero-pads to 10 digits', () => {
    expect(padCik(320193)).toBe('0000320193');
    expect(padCik('0000320193')).toBe('0000320193');
  });
  it('parseCompanyTickers builds an uppercase ticker→CIK map', () => {
    const m = parseCompanyTickers({
      '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
      '1': { cik_str: 789019, ticker: 'msft', title: 'Microsoft' },
    });
    expect(m.get('AAPL')).toBe('0000320193');
    expect(m.get('MSFT')).toBe('0000789019');
  });
  it('parseSecSubmissions derives sector from SIC and flags ETFs', () => {
    const r = parseSecSubmissions({
      name: 'Apple Inc.', sic: '3571', sicDescription: 'Electronic Computers',
      stateOfIncorporation: 'CA', exchanges: ['Nasdaq'], cik: 320193, category: 'Operating',
    });
    expect(r!.sector).toBe('Manufacturing');
    expect(r!.stateOfIncorp).toBe('CA');
    expect(r!.exchange).toBe('Nasdaq');
    expect(r!.cik).toBe('0000320193');
    expect(r!.isEtf).toBe(false);
    expect(parseSecSubmissions({ name: 'SPDR', category: 'Exchange Traded Fund' })!.isEtf).toBe(true);
  });
});

/**
 * Regression coverage: a failed ticker-map fetch (network error or non-OK
 * response) must NOT be cached, or every subsequent call for the life of the
 * isolate keeps returning that permanently-empty Map (silently blinding every
 * EDGAR lookup) instead of retrying on the next call.
 */
describe('buildSecProvider — does not cache a failed ticker-map fetch', () => {
  it('retries the ticker-map fetch on the next call after a non-OK response, instead of reusing a cached empty map', async () => {
    let mapCalls = 0;
    // 1st ticker-map fetch 503s; 2nd succeeds. The submissions endpoint always
    // 404s (irrelevant here — only proves the CIK lookup got that far).
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('company_tickers.json')) {
        mapCalls++;
        if (mapCalls === 1) return { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
        return { ok: true, json: async () => ({ '0': { cik_str: 320193, ticker: 'AAPL' } }) } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const provider = buildSecProvider(fetchImpl);

    // 1st call: map fetch fails → no CIK resolvable → null, without caching.
    expect(await provider.fetchRef('AAPL')).toBeNull();
    expect(mapCalls).toBe(1);

    // 2nd call on the SAME provider instance: if the failure had been cached
    // (the pre-fix bug), mapCalls would stay at 1 forever. It must retry.
    await provider.fetchRef('AAPL');
    expect(mapCalls).toBe(2);
  });
});

describe('enrichment transient-retry backoff (attempt-aging, no permanent tombstone)', () => {
  it('parseTransientRetryMarker is null for a real tombstone message / empty / absent', () => {
    expect(parseTransientRetryMarker(null)).toBeNull();
    expect(parseTransientRetryMarker(undefined)).toBeNull();
    expect(parseTransientRetryMarker('')).toBeNull();
    expect(parseTransientRetryMarker('no provider data')).toBeNull();
    expect(parseTransientRetryMarker('garbage:not-a-marker')).toBeNull();
  });

  it('nextTransientRetryMarker starts at attempt 1 and parses back out', () => {
    const now = Date.parse('2026-07-01T00:00:00.000Z');
    const marker = nextTransientRetryMarker(null, now);
    expect(marker).toMatch(/^transient-retry:1:/);
    const parsed = parseTransientRetryMarker(marker);
    expect(parsed?.attempts).toBe(1);
    // Base backoff is 1 hour.
    expect(parsed?.nextEligibleAt).toBe(now + 60 * 60 * 1000);
  });

  it('doubles the backoff on each consecutive attempt, capped at 24h', () => {
    const now = Date.parse('2026-07-01T00:00:00.000Z');
    let marker: string | null = null;
    const expectedHours = [1, 2, 4, 8, 16, 24, 24]; // doubles from 1h, caps at 24h
    for (const hours of expectedHours) {
      marker = nextTransientRetryMarker(marker, now);
      const parsed = parseTransientRetryMarker(marker)!;
      expect(parsed.nextEligibleAt - now).toBe(hours * 60 * 60 * 1000);
    }
  });

  it('transientRetryEligible: no marker is always eligible; a pending backoff is not; an aged-out one is', () => {
    const now = Date.parse('2026-07-01T12:00:00.000Z');
    expect(transientRetryEligible(null, now)).toBe(true);
    expect(transientRetryEligible('no provider data', now)).toBe(true); // not a transient marker at all
    const marker = nextTransientRetryMarker(null, now); // next eligible = now + 1h
    expect(transientRetryEligible(marker, now)).toBe(false); // still within backoff
    expect(transientRetryEligible(marker, now + 60 * 60 * 1000)).toBe(true); // backoff elapsed
  });
});

/**
 * Regression coverage for the throttling change: EDGAR calls used to skip
 * pace() entirely ("EDGAR is free + unmetered"). They now await the
 * EDGAR-dedicated pacer, same as every other provider awaits its own gate.
 * Minimal D1/KV fakes (mirrors the pattern in
 * ingestion/__tests__/tradeLatency.test.ts) let this exercise the real
 * runEnrichment provider loop instead of only the pacer unit in isolation.
 */
describe('runEnrichment paces SEC EDGAR calls', () => {
  beforeEach(() => __resetSharedEdgarPacerForTests());
  afterEach(() => vi.unstubAllGlobals());

  function fakeDb(tickerRows: Array<{ ticker: string }>) {
    const stmt = {
      bind() {
        return stmt;
      },
      async all<T>() {
        return { results: tickerRows as unknown as T[] };
      },
      async first<T>() {
        return null as T | null;
      },
      async run() {
        return { success: true, meta: { changes: 0 } };
      },
    };
    return { prepare: () => stmt, async batch() { return []; } } as unknown as D1Database;
  }

  function fakeKv() {
    const store = new Map<string, string>();
    return {
      async get(k: string) {
        return store.get(k) ?? null;
      },
      async put(k: string, v: string) {
        store.set(k, v);
      },
      async delete(k: string) {
        store.delete(k);
      },
    };
  }

  it('awaits the EDGAR-dedicated pacer before every EDGAR fetch, no keyed provider configured', async () => {
    const db = fakeDb([{ ticker: 'AAA' }, { ticker: 'BBB' }]);
    const kv = fakeKv();

    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('company_tickers.json')) {
        return {
          ok: true,
          json: async () => ({
            '0': { cik_str: 1, ticker: 'AAA' },
            '1': { cik_str: 2, ticker: 'BBB' },
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({
          name: 'Test Co', sic: '7372', exchanges: ['Nasdaq'], cik: 1, category: 'Operating',
        }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchImpl);

    const env = { DB: db, CONFIG_KV: kv } as unknown as Parameters<typeof runEnrichment>[0];

    const t0 = Date.now();
    // 600/min = 100ms min gap; a fast rate chosen for a deterministic-but-quick
    // test, not the production default (see EDGAR_MAX_PER_MINUTE in wrangler.toml).
    const result = await runEnrichment(env, { max: 2, dryRun: true, edgarMaxPerMinute: 600 });
    const elapsed = Date.now() - t0;

    expect(result.scanned).toBe(2);
    expect(result.enriched).toBe(2); // both tickers resolved via the EDGAR-only chain
    // Before this change, EDGAR calls skipped pace() entirely and this loop of
    // 2 EDGAR fetches would finish near-instantly; now the second call is
    // gated behind the pacer's ~100ms min gap from the first.
    expect(elapsed).toBeGreaterThanOrEqual(90);
  });
});

/**
 * Behavioral (real migrated SQLite) coverage for the transient-retry backoff:
 * a thrown provider error must never permanently tombstone a ticker the way
 * `upsertEmpty` does (which stamps `enriched_at` and stops future selection);
 * instead it writes an attempt-aged `transient-retry:` marker into
 * `enrichment_error` while leaving `enriched_at` untouched/NULL, so the ticker
 * stays selectable and is retried once its backoff elapses.
 */
describe('runEnrichment — transient-retry backoff (real D1)', () => {
  function fakeKv() {
    const store = new Map<string, string>();
    return {
      async get(k: string) {
        return store.get(k) ?? null;
      },
      async put(k: string, v: string) {
        store.set(k, v);
      },
      async delete(k: string) {
        store.delete(k);
      },
    };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('does not tombstone a thrown (transient) failure; records an attempt-1 backoff marker, enriched_at stays NULL', async () => {
    const { db, d1, close } = await openMigratedD1();
    try {
      db.prepare(
        `INSERT INTO transactions (id, ticker, tx_date, source, created_at)
         VALUES ('tx-1', 'FLAKY', '2026-01-05', 'primary', '2026-01-05T00:00:00Z')`,
      ).run();

      const fetchImpl = vi.fn(async (url: string) => {
        if (String(url).includes('company_tickers.json')) {
          return {
            ok: true,
            json: async () => ({ '0': { cik_str: 1, ticker: 'FLAKY' } }),
          } as unknown as Response;
        }
        throw new Error('network blip'); // submissions fetch fails transiently
      });
      vi.stubGlobal('fetch', fetchImpl);

      const env = { DB: d1, CONFIG_KV: fakeKv() } as unknown as Parameters<typeof runEnrichment>[0];
      const result = await runEnrichment(env, { max: 10, edgarMaxPerMinute: 10000 });

      expect(result.scanned).toBe(1);
      expect(result.enriched).toBe(0);
      expect(result.failures).toBe(1);
      expect(result.errors.some((e) => e.includes('FLAKY') && e.includes('edgar'))).toBe(true);

      const row = db
        .prepare('SELECT enriched_at, enrichment_error FROM securities_ref WHERE ticker = ?')
        .get('FLAKY');
      expect(row?.enriched_at).toBeNull(); // NOT tombstoned — stays selectable
      expect(row?.enrichment_error).toMatch(/^transient-retry:1:/);
    } finally {
      close();
    }
  });

  it('escalates to attempt 2 (longer backoff) once a prior attempt-1 marker has aged out, and stays eligible across re-selection', async () => {
    const { db, d1, close } = await openMigratedD1();
    try {
      db.prepare(
        `INSERT INTO transactions (id, ticker, tx_date, source, created_at)
         VALUES ('tx-1', 'FLAKY', '2026-01-05', 'primary', '2026-01-05T00:00:00Z')`,
      ).run();
      // Pre-seed an attempt-1 marker whose backoff already elapsed (long in the past).
      db.prepare(
        `INSERT INTO securities_ref (ticker, enrichment_error) VALUES ('FLAKY', 'transient-retry:1:2020-01-01T00:00:00.000Z')`,
      ).run();

      const fetchImpl = vi.fn(async (url: string) => {
        if (String(url).includes('company_tickers.json')) {
          return { ok: true, json: async () => ({ '0': { cik_str: 1, ticker: 'FLAKY' } }) } as unknown as Response;
        }
        throw new Error('still flaky');
      });
      vi.stubGlobal('fetch', fetchImpl);

      const env = { DB: d1, CONFIG_KV: fakeKv() } as unknown as Parameters<typeof runEnrichment>[0];
      const result = await runEnrichment(env, { max: 10, edgarMaxPerMinute: 10000 });

      // The aged-out marker did not block re-selection: the ticker was scanned again.
      expect(result.scanned).toBe(1);
      const row = db
        .prepare('SELECT enriched_at, enrichment_error FROM securities_ref WHERE ticker = ?')
        .get('FLAKY');
      expect(row?.enriched_at).toBeNull();
      expect(row?.enrichment_error).toMatch(/^transient-retry:2:/); // escalated from 1 → 2
    } finally {
      close();
    }
  });

  it('does NOT re-attempt a ticker still within its pending backoff window', async () => {
    const { db, d1, close } = await openMigratedD1();
    try {
      db.prepare(
        `INSERT INTO transactions (id, ticker, tx_date, source, created_at)
         VALUES ('tx-1', 'FLAKY', '2026-01-05', 'primary', '2026-01-05T00:00:00Z')`,
      ).run();
      // Marker whose backoff is far in the future — must not be re-attempted yet.
      db.prepare(
        `INSERT INTO securities_ref (ticker, enrichment_error) VALUES ('FLAKY', 'transient-retry:1:2999-01-01T00:00:00.000Z')`,
      ).run();

      const fetchImpl = vi.fn(async () => {
        throw new Error('should not be called for company_tickers.json either, but harmless either way');
      });
      vi.stubGlobal('fetch', fetchImpl);

      const env = { DB: d1, CONFIG_KV: fakeKv() } as unknown as Parameters<typeof runEnrichment>[0];
      const result = await runEnrichment(env, { max: 10, edgarMaxPerMinute: 10000 });

      // Selected by the base SQL predicate (enriched_at IS NULL) but skipped in
      // the loop before any provider call, since its backoff hasn't elapsed.
      expect(result.scanned).toBe(0);
      expect(fetchImpl).not.toHaveBeenCalled();
      const row = db
        .prepare('SELECT enrichment_error FROM securities_ref WHERE ticker = ?')
        .get('FLAKY');
      expect(row?.enrichment_error).toBe('transient-retry:1:2999-01-01T00:00:00.000Z'); // untouched
    } finally {
      close();
    }
  });
});

describe('runEnrichment — slash alias, tombstone retry, non-equity', () => {
  function fakeKv() {
    const store = new Map<string, string>();
    return {
      async get(k: string) {
        return store.get(k) ?? null;
      },
      async put(k: string, v: string) {
        store.set(k, v);
      },
      async delete(k: string) {
        store.delete(k);
      },
    };
  }

  function peerEnv(d1: D1Database) {
    return {
      DB: d1,
      CONFIG_KV: fakeKv(),
      APP_B_IMPORT_URL: 'https://socratic.trade',
      APP_B_INGEST_TOKEN: 'token',
    } as unknown as Parameters<typeof runEnrichment>[0];
  }

  afterEach(() => vi.unstubAllGlobals());

  it('stores a BRK/B profile on the original ticker and does not invent country', async () => {
    const { db, d1, close } = await openMigratedD1();
    try {
      db.prepare(
        `INSERT INTO transactions (id, ticker, asset_name, tx_date, source, created_at)
         VALUES ('tx-brk', 'BRK/B', 'BRK/B', '2026-01-05', 'primary', '2026-01-05T00:00:00Z')`,
      ).run();
      db.prepare(
        `INSERT INTO securities_ref (ticker, enriched_at, enrichment_error)
         VALUES ('BRK/B', '2026-01-01T00:00:00.000Z', 'no provider data')`,
      ).run();

      const urls: string[] = [];
      const fetchImpl = vi.fn(async (url: string) => {
        urls.push(String(url));
        if (String(url).includes('/api/market/profile/BRK.B')) {
          return new Response(JSON.stringify({
            ref: { companyName: 'Berkshire Hathaway', sector: 'Financial Services', marketCap: 1_000_000_000_000 },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
      });
      vi.stubGlobal('fetch', fetchImpl);

      const result = await runEnrichment(peerEnv(d1), { max: 10 });
      expect(result.enriched).toBe(1);
      expect(urls.some((u) => u.endsWith('/api/market/profile/BRK.B'))).toBe(true);
      expect(urls.some((u) => u.includes('BRK%2F') || u.includes('BRK/B'))).toBe(false);

      const row = db.prepare(
        'SELECT ticker, company_name, sector, country, market_cap, enrichment_error FROM securities_ref WHERE ticker = ?',
      ).get('BRK/B');
      expect(db.prepare('SELECT ticker FROM securities_ref WHERE ticker = ?').get('BRK.B')).toBeUndefined();
      expect(row?.company_name).toBeTruthy();
      expect(row?.sector).toBe('Financial Services');
      expect(row?.country).toBeNull();
      expect(row?.market_cap).toBeTruthy();
      expect(row?.enrichment_error).toBeNull();
    } finally {
      close();
    }
  });

  it('retries a ticker-shaped no-provider tombstone once and keeps that error on a clean miss', async () => {
    const { db, d1, close } = await openMigratedD1();
    try {
      db.prepare(
        `INSERT INTO transactions (id, ticker, asset_name, tx_date, source, created_at)
         VALUES ('tx-z', 'ZZZZ', 'ZZZZ', '2026-01-05', 'primary', '2026-01-05T00:00:00Z')`,
      ).run();
      db.prepare(
        `INSERT INTO securities_ref (ticker, enriched_at, enrichment_error)
         VALUES ('ZZZZ', '2026-01-01T00:00:00.000Z', 'no provider data')`,
      ).run();

      const fetchImpl = vi.fn(async (url: string) => {
        if (String(url).includes('/api/market/profile/')) {
          return new Response(JSON.stringify({ ref: null }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
      });
      vi.stubGlobal('fetch', fetchImpl);
      const env = peerEnv(d1);

      const first = await runEnrichment(env, { max: 10 });
      expect(first.scanned).toBe(1);
      expect(first.enriched).toBe(0);
      const row = db.prepare('SELECT enrichment_error, source FROM securities_ref WHERE ticker = ?').get('ZZZZ');
      expect(row?.enrichment_error).toBe(NO_PROVIDER_DATA_ERROR);
      expect(String(row?.source)).toContain('socratic');

      fetchImpl.mockClear();
      const second = await runEnrichment(env, { max: 10 });
      expect(second.scanned).toBe(0);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      close();
    }
  });

  it('marks a municipal name not an equity and does not select it again', async () => {
    const { db, d1, close } = await openMigratedD1();
    try {
      db.prepare(
        `INSERT INTO transactions (id, ticker, asset_name, tx_date, source, created_at)
         VALUES ('tx-m', 'DALLAS WATER MUNICIPAL BOND', 'DALLAS WATER MUNICIPAL BOND', '2026-01-05', 'primary', '2026-01-05T00:00:00Z')`,
      ).run();

      const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
      vi.stubGlobal('fetch', fetchImpl);
      const env = peerEnv(d1);

      const first = await runEnrichment(env, { max: 10 });
      expect(first.scanned).toBe(1);
      expect(fetchImpl).not.toHaveBeenCalled();
      const row = db.prepare('SELECT enrichment_error, enriched_at FROM securities_ref WHERE ticker = ?').get('DALLAS WATER MUNICIPAL BOND');
      expect(row?.enrichment_error).toBe(NOT_AN_EQUITY_ERROR);
      expect(row?.enriched_at).toBeTruthy();

      const second = await runEnrichment(env, { max: 10 });
      expect(second.scanned).toBe(0);
      const still = db.prepare('SELECT enrichment_error FROM securities_ref WHERE ticker = ?').get('DALLAS WATER MUNICIPAL BOND');
      expect(still?.enrichment_error).toBe(NOT_AN_EQUITY_ERROR);
    } finally {
      close();
    }
  });

  it('does not classify a normal ticker as non-equity when the peer has no profile', async () => {
    const { db, d1, close } = await openMigratedD1();
    try {
      db.prepare(
        `INSERT INTO transactions (id, ticker, asset_name, tx_date, source, created_at)
         VALUES ('tx-a', 'AAPL', 'AAPL', '2026-01-05', 'primary', '2026-01-05T00:00:00Z')`,
      ).run();
      const fetchImpl = vi.fn(async (url: string) => {
        if (String(url).includes('/api/market/profile/')) {
          return new Response(JSON.stringify({ ref: null }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
      });
      vi.stubGlobal('fetch', fetchImpl);

      await runEnrichment(peerEnv(d1), { max: 10 });
      const row = db.prepare('SELECT enrichment_error FROM securities_ref WHERE ticker = ?').get('AAPL');
      expect(row?.enrichment_error).toBe(NO_PROVIDER_DATA_ERROR);
    } finally {
      close();
    }
  });
});
