import { describe, expect, it } from 'vitest';
import { probeScheduleConfigFromEnv } from '../probeSchedule.ts';
import {
  generateTradeHash,
  extractLastName,
  normalizeTradeSide,
  matchDisclosureCandidate,
  parseTradeHash,
  raceFirstSeenAt,
  tradeDateDayDistance,
  isLiveRaceImport,
  LATENCY_MAX_CONCURRENT_DELTA_HOURS,
  LATENCY_SCORE_WINDOW_HOURS,
  LATENCY_PROVIDER_MATCH_LOOKBACK_HOURS,
  LATENCY_LIVE_FILING_MAX_LAG_DAYS,
  FMP_LATENCY_CALLS_PER_RUN,
  FMP_LATENCY_DAILY_CAP_PER_KEY,
  fmpLatencyEtHourWeight,
  fmpLatencyIntervalSec,
  disclosurePublishYieldBand,
  disclosurePublishYieldWeight,
  budgetedProbeIntervalSec,
  selectFmpLatencyKey,
  listConfiguredFmpLatencySlots,
  selectRotatedAvenue,
  selectFmpLatencyPathForCycle,
  selectLatencySourceProbe,
  resolveUnusualWhalesKey,
  resolveFmpRapidApiKey,
  getFmpLatencyFleetRemaining,
  getFmpLatencyUsed,
  addFmpLatencyUsed,
  markFmpSlotHttp429,
  isFmpSlotHttp429,
  isFmpSlotHttp429DayBan,
  readFmpSlotHttp429Cause,
  addLatencySourceUsed,
  getLatencySourceUsed,
  LATENCY_SOURCE_BUDGETS,
  getDisclosureLatencyProviderStatuses,
  listFmpLatencyPathRegistry,
  runDisclosureLatencyProbe,
  earliestIso,
  effectiveRaceProviderTime,
  mergeFmpFamilyCandidateRows,
  mergeFmpFamilyObservationRows,
  mergeFmpOperationalStatus,
  isLatencyComparisonPublic,
  PUBLIC_FMP_LATENCY_LABEL,
  parseFmpDisclosureRows,
  parseUnusualWhalesDisclosureRows,
  providerFilerName,
  tradeHashHasFiler,
  matchStrength,
  computeLatencyScope,
  isInLatencyScope,
  buildPublicLatencyProviders,
  repairProviderObservationHashes,
  CORPUS_MATCH_METHOD,
  hashesFromCorpusTransactions,
  coverageRowsFromCorpusHashes,
  mergeCoveragePreferringRace,
} from '../tradeLatency.ts';

describe('tradeLatency', () => {
  describe('extractLastName', () => {
    it('extracts last name', () => {
      expect(extractLastName('Ro Khanna')).toBe('khanna');
      expect(extractLastName('Pelosi, Nancy')).toBe('pelosi');
      expect(extractLastName('Donald J. Trump')).toBe('trump');
      expect(extractLastName('Tuberville, Tommy')).toBe('tuberville');
    });
  });

  describe('normalizeTradeSide', () => {
    it('maps CT P/S/E codes and provider prose to buy/sell/exchange', () => {
      expect(normalizeTradeSide('P')).toBe('buy');
      expect(normalizeTradeSide('S')).toBe('sell');
      expect(normalizeTradeSide('E')).toBe('exchange');
      expect(normalizeTradeSide('purchase')).toBe('buy');
      expect(normalizeTradeSide('Sale')).toBe('sell');
      expect(normalizeTradeSide('buy')).toBe('buy');
      expect(normalizeTradeSide(null)).toBe('exchange');
    });
  });

  describe('generateTradeHash', () => {
    it('generates deterministic hash across name/type variants', () => {
      const hash1 = generateTradeHash('Ro Khanna', 'AAPL', '2026-07-24', 'buy');
      const hash2 = generateTradeHash('Khanna, Ro', 'AAPL', '2026-07-24', 'purchase');
      const hash3 = generateTradeHash('Ro Khanna', 'AAPL', '2026-07-24', 'P');
      expect(hash1).toBe(hash2);
      expect(hash1).toBe(hash3);
      expect(hash1).toBe('khanna_AAPL_2026-07-24_buy');
    });

    it('maps sale codes to sell', () => {
      expect(generateTradeHash('Kevin Hern', 'DVN', '2024-06-28', 'S')).toBe(
        generateTradeHash('Hern, Kevin', 'DVN', '2024-06-28', 'Sale'),
      );
    });
  });

  describe('matchDisclosureCandidate', () => {
    it('matches exact trade hashes as trade-hash', () => {
      const hash = generateTradeHash('Debbie Dingell', 'HONAV', '2026-06-29', 'exchange');
      const m = matchDisclosureCandidate(
        { trade_hash: hash },
        {
          provider: 'unusual_whales',
          chamber: 'house',
          providerKey: 'k1',
          tradeHash: hash,
          payload: {},
          sourceUrl: null,
          filedDate: null,
          filerName: 'Debbie Dingell',
          providerPublishedAt: null,
        },
      );
      expect(m).toEqual({ providerKey: 'k1', matchMethod: 'trade-hash' });
    });

    it('fuzzy-matches near trade dates (±2 days) for same filer/ticker/side', () => {
      const m = matchDisclosureCandidate(
        { trade_hash: 'delaney_BWXT_2026-07-24_buy' },
        {
          provider: 'quiver',
          chamber: 'house',
          providerKey: 'k-near',
          tradeHash: 'delaney_BWXT_2026-07-26_buy',
          payload: {},
          sourceUrl: null,
          filedDate: null,
          filerName: 'April McClain Delaney',
          providerPublishedAt: null,
        },
      );
      expect(m?.matchMethod).toBe('fuzzy-near-date');
    });

    it('fuzzy-matches when provider date is empty but filer/ticker/side agree', () => {
      const m = matchDisclosureCandidate(
        { trade_hash: 'sessions_ARCC_2026-07-24_sell' },
        {
          provider: 'unusual_whales',
          chamber: 'house',
          providerKey: 'k2',
          tradeHash: 'sessions_ARCC__sell',
          payload: {},
          sourceUrl: null,
          filedDate: null,
          filerName: 'Pete Sessions',
          providerPublishedAt: null,
        },
      );
      expect(m?.matchMethod).toBe('fuzzy-missing-date');
    });

    it('fuzzy-matches when provider ticker is empty but filer/date/side agree', () => {
      const m = matchDisclosureCandidate(
        { trade_hash: 'beyer_AAPL_2026-07-27_buy' },
        {
          provider: 'unusual_whales',
          chamber: 'house',
          providerKey: 'k3',
          tradeHash: 'beyer__2026-07-27_buy',
          payload: {},
          sourceUrl: null,
          filedDate: null,
          filerName: 'Don Beyer',
          providerPublishedAt: null,
        },
      );
      expect(m?.matchMethod).toBe('fuzzy-no-ticker');
    });
  });

  describe('parseTradeHash', () => {
    it('parses normal and empty-ticker hashes', () => {
      expect(parseTradeHash('himes_BAC_2026-07-20_sell')).toEqual({
        lastName: 'himes',
        ticker: 'BAC',
        date: '2026-07-20',
        side: 'sell',
      });
      expect(parseTradeHash('beyer__2026-07-27_buy')).toMatchObject({
        lastName: 'beyer',
        date: '2026-07-27',
        side: 'buy',
      });
    });
  });

  describe('raceFirstSeenAt', () => {
    it('uses now when first_seen is outside the score window', () => {
      const now = '2026-08-04T12:00:00.000Z';
      expect(raceFirstSeenAt('2024-01-01T00:00:00.000Z', now, 168)).toBe(now);
      expect(raceFirstSeenAt('2026-08-03T12:00:00.000Z', now, 168)).toBe('2026-08-03T12:00:00.000Z');
    });
  });

  describe('scoreboard constants', () => {
    it('uses 7d CT live window and 14d provider match/timing lookback', () => {
      expect(LATENCY_SCORE_WINDOW_HOURS).toBe(168);
      expect(LATENCY_PROVIDER_MATCH_LOOKBACK_HOURS).toBe(336);
      expect(LATENCY_MAX_CONCURRENT_DELTA_HOURS).toBe(336);
      expect(LATENCY_LIVE_FILING_MAX_LAG_DAYS).toBe(7);
    });
  });

  describe('isLiveRaceImport', () => {
    it('excludes seed and competitor backfills', () => {
      expect(isLiveRaceImport({ source: 'seed_dataset', filedDate: '2026-08-01', firstSeenAt: '2026-08-02T00:00:00.000Z' })).toBe(
        false,
      );
      expect(
        isLiveRaceImport({ source: 'competitor_backfill', filedDate: '2026-08-01', firstSeenAt: '2026-08-02T00:00:00.000Z' }),
      ).toBe(false);
    });

    it('excludes primary-path historical crawls (first_seen long after filed)', () => {
      expect(
        isLiveRaceImport({
          source: 'primary',
          filedDate: '2024-05-01',
          firstSeenAt: '2026-08-04T12:00:00.000Z',
        }),
      ).toBe(false);
    });

    it('allows live primary imports filed days before first_seen', () => {
      expect(
        isLiveRaceImport({
          source: 'primary',
          filedDate: '2026-08-01',
          firstSeenAt: '2026-08-03T12:00:00.000Z',
        }),
      ).toBe(true);
    });

    it('treats a 15-day first_seen lag as a crawl, not a live race', () => {
      // Live 2026-08-16: FMP "losses" were July 24–27 House PTRs first_seen in
      // one Aug 11 22:35Z batch.  15–18 days after filed is a reimport, not
      // us losing a same-day race.
      expect(
        isLiveRaceImport({
          source: 'primary',
          filedDate: '2026-07-26',
          firstSeenAt: '2026-08-11T22:35:05.988Z',
        }),
      ).toBe(false);
      expect(
        isLiveRaceImport({
          source: 'primary',
          filedDate: '2026-08-05',
          firstSeenAt: '2026-08-11T22:36:03.656Z',
        }),
      ).toBe(true);
    });
  });

  describe('tradeDateDayDistance', () => {
    it('returns absolute day gaps', () => {
      expect(tradeDateDayDistance('2026-07-24', '2026-07-26')).toBe(2);
      expect(tradeDateDayDistance('2026-07-24', '2026-07-24')).toBe(0);
      expect(tradeDateDayDistance('bad', '2026-07-24')).toBeNull();
    });
  });

  describe('FMP latency-only dual keys', () => {
    it('spaces remaining budget across the UTC day with floor/ceiling', () => {
      // Noon UTC mid-day with plenty of remaining runs.
      const noon = new Date('2026-08-05T16:00:00.000Z'); // 12:00 ET in summer
      const interval = fmpLatencyIntervalSec(noon, FMP_LATENCY_DAILY_CAP_PER_KEY);
      expect(interval).toBeGreaterThanOrEqual(60);
      expect(interval).toBeLessThanOrEqual(45 * 60);
      // Exhausted budget → max interval (skip signal for caller).
      expect(fmpLatencyIntervalSec(noon, 0)).toBe(45 * 60);
      expect(fmpLatencyIntervalSec(noon, 1)).toBe(45 * 60); // < CALLS_PER_RUN
    });

    it('reads its bands from the MEASURED provider windows, not the old guess', () => {
      // 2026-08-05 is a Wednesday. Provider profile = union of both chambers'
      // peaks: PEAK 09-10 ET (House burst), HIGH 16-18 ET (Senate afternoon),
      // MID 10-16 + 18-21 ET, LOW 21-09 ET (measured zero for both chambers).
      //
      // These deliberately DISAGREE with the pre-measurement table this call
      // used to return, and the disagreement is the point: 10:00 ET used to be
      // called "peak" (08-12 was one flat block) when the measurement puts the
      // House burst at 09:00-09:06, median 09:02. An hour of burst-rate probing
      // was landing after the burst was over.
      const band = (iso: string) => disclosurePublishYieldBand(new Date(iso));

      expect(band('2026-08-05T13:30:00.000Z')).toBe('peak'); // 09:30 ET
      expect(band('2026-08-05T14:00:00.000Z')).toBe('mid'); //  10:00 ET (was 'peak')
      expect(band('2026-08-05T17:00:00.000Z')).toBe('mid'); //  13:00 ET (was 'high')
      expect(band('2026-08-05T21:00:00.000Z')).toBe('high'); // 17:00 ET (was 'mid')
      expect(band('2026-08-05T04:00:00.000Z')).toBe('low'); //  00:00 ET
      expect(band('2026-08-06T01:00:00.000Z')).toBe('low'); //  21:00 ET — dead

      // Weights are a mean-1 DENSITY (budget-neutral by construction), not the
      // old absolute 3.0/2.0/1.0/0.4 multipliers. Only the ordering is pinned;
      // pinning exact values here would just duplicate probeSchedule's own tests.
      const w = (iso: string) => disclosurePublishYieldWeight(new Date(iso));
      expect(w('2026-08-05T13:30:00.000Z')).toBeGreaterThan(w('2026-08-05T21:00:00.000Z'));
      expect(w('2026-08-05T21:00:00.000Z')).toBeGreaterThan(w('2026-08-05T17:00:00.000Z'));
      expect(w('2026-08-05T17:00:00.000Z')).toBeGreaterThan(w('2026-08-05T04:00:00.000Z'));

      // Weekend is one flat LOW tier (publication-side weekend volume is ~0).
      expect(band('2026-08-08T14:00:00.000Z')).toBe('low'); // Sat 10:00 ET
    });

    it('restores the pre-measurement bands when the schedule is switched off', () => {
      // The kill switch has to land somewhere KNOWN-GOOD, not somewhere
      // untested: PROBE_SCHEDULE_ENABLED=0 must reproduce the old behaviour
      // exactly, so an operator who flips it gets today's system back.
      const off = probeScheduleConfigFromEnv({ PROBE_SCHEDULE_ENABLED: '0' });
      expect(off.enabled).toBe(false);
      // 14:00 UTC = 10:00 ET → the old table's 08-12 "peak" block.
      expect(disclosurePublishYieldBand(new Date('2026-08-05T14:00:00.000Z'), off)).toBe('peak');
      expect(disclosurePublishYieldWeight(new Date('2026-08-05T14:00:00.000Z'), off)).toBe(3);
      expect(disclosurePublishYieldWeight(new Date('2026-08-05T04:00:00.000Z'), off)).toBe(0.4);
      // And the old weekend downgrade rule comes back with it.
      expect(disclosurePublishYieldBand(new Date('2026-08-08T14:00:00.000Z'), off)).toBe('high');
    });

    it('weights peak ET hours denser than overnight (2–3×+)', () => {
      // America/New_York: 2026-08-05 13:30 UTC = 09:30 ET (measured peak).
      const peak = fmpLatencyEtHourWeight(new Date('2026-08-05T13:30:00.000Z'));
      // 2026-08-05 04:00 UTC = 00:00 ET (overnight)
      const night = fmpLatencyEtHourWeight(new Date('2026-08-05T04:00:00.000Z'));
      expect(peak).toBeGreaterThanOrEqual(night * 2);
      // Peak spacing should be shorter than overnight for same remaining budget.
      const remaining = 100;
      const peakIv = fmpLatencyIntervalSec(new Date('2026-08-05T13:30:00.000Z'), remaining);
      const nightIv = fmpLatencyIntervalSec(new Date('2026-08-05T04:00:00.000Z'), remaining);
      expect(peakIv).toBeLessThan(nightIv);
      // Shared budgeted helper used by UW/QQ as well.
      const peakShared = budgetedProbeIntervalSec({
        now: new Date('2026-08-05T13:30:00.000Z'),
        remainingRuns: 50,
        minIntervalSec: 60,
        maxIntervalSec: 45 * 60,
      });
      const nightShared = budgetedProbeIntervalSec({
        now: new Date('2026-08-05T04:00:00.000Z'),
        remainingRuns: 50,
        minIntervalSec: 60,
        maxIntervalSec: 45 * 60,
      });
      expect(peakShared).toBeLessThan(nightShared);
    });

    it('resolveUnusualWhalesKey accepts canonical or UNUSUALWHALES alias (single key)', async () => {
      expect(await resolveUnusualWhalesKey({} as never)).toBeNull();
      expect(
        (await resolveUnusualWhalesKey({ UNUSUALWHALES_API_KEY: 'from-global' } as never))?.apiKey,
      ).toBe('from-global');
      expect(
        (
          await resolveUnusualWhalesKey({
            UNUSUAL_WHALES_API_KEY: 'canonical',
            UNUSUALWHALES_API_KEY: 'alias',
          } as never)
        )?.apiKey,
      ).toBe('canonical');
    });

    it('UW/QQ selectLatencySourceProbe enforces daily cap and yield spacing', async () => {
      const kv = new Map<string, string>();
      const env = {
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
        UW_LATENCY_DAILY_CAP: '10',
        QUIVER_LATENCY_DAILY_CAP: '12',
      } as never;
      // 13:30 UTC = 09:30 ET — inside the MEASURED provider peak (09-10 ET).
      const peakNow = new Date('2026-08-05T13:30:00.000Z');
      const uw = await selectLatencySourceProbe(env, 'unusual_whales', peakNow, { force: true });
      expect(uw?.cap).toBe(10);
      expect(uw?.callsPerRun).toBe(1);
      expect(uw?.band).toBe('peak');
      await addLatencySourceUsed(env, 'unusual_whales', 10, peakNow);
      expect(await selectLatencySourceProbe(env, 'unusual_whales', peakNow, { force: true })).toBeNull();

      const qq = await selectLatencySourceProbe(env, 'quiver', peakNow, { force: true });
      expect(qq?.cap).toBe(12);
      expect(qq?.callsPerRun).toBe(LATENCY_SOURCE_BUDGETS.quiver.callsPerRun);
      await addLatencySourceUsed(env, 'quiver', 11, peakNow);
      expect(await selectLatencySourceProbe(env, 'quiver', peakNow, { force: true })).toBeNull();
    });

    it('uses FMP_API_KEY as free-tier slot-2 (or sole key) for dual capacity', async () => {
      const kv = new Map<string, string>();
      const env = {
        FMP_API_KEY: 'free-only',
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
      } as never;
      // Sole free key via FMP_API_KEY → slot 2 material (still eligible).
      const sole = await selectFmpLatencyKey(env, new Date('2026-08-05T15:00:00.000Z'), { force: true });
      expect(sole?.apiKey).toBe('free-only');
      expect(sole?.secretName).toBe('FMP_API_KEY');
      expect(sole?.slot).toBe('2');

      const envLatency = {
        ...env,
        FMP_LATENCY_API_KEY: 'latency-key-1',
      } as never;
      const sel = await selectFmpLatencyKey(envLatency, new Date('2026-08-05T15:00:00.000Z'), { force: true });
      expect(sel?.apiKey).toBe('latency-key-1');
      expect(sel?.slot).toBe('1');
      expect(sel?.secretName).toBe('FMP_LATENCY_API_KEY');
      expect(sel?.cap).toBe(FMP_LATENCY_DAILY_CAP_PER_KEY);
      expect(FMP_LATENCY_CALLS_PER_RUN).toBe(2);
    });

    it('rotates among eligible dual keys (does not dual-spend) and tracks counters', async () => {
      const kv = new Map<string, string>();
      const env = {
        FMP_LATENCY_API_KEY: 'k1',
        ['FMP_LATENCY_API_KEY' + '_2']: 'k2',
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
      } as never;
      const now = new Date('2026-08-05T15:00:00.000Z');
      await addFmpLatencyUsed(env, '2', 10, now);
      expect(await getFmpLatencyUsed(env, '2', now)).toBe(10);
      // First pick among [1,2] → slot 1 (round-robin from empty last).
      const sel1 = await selectFmpLatencyKey(env, now, { force: true });
      expect(sel1?.slot).toBe('1');
      expect(sel1?.apiKey).toBe('k1');
      // Second pick rotates to slot 2.
      const sel2 = await selectFmpLatencyKey(env, now, { force: true });
      expect(sel2?.slot).toBe('2');
      expect(sel2?.apiKey).toBe('k2');
      expect(sel2?.remaining).toBe(FMP_LATENCY_DAILY_CAP_PER_KEY - 10);
      // Exhaust key1 — only key2 remains eligible, rotation stays on 2.
      await addFmpLatencyUsed(env, '1', FMP_LATENCY_DAILY_CAP_PER_KEY, now);
      const sel3 = await selectFmpLatencyKey(env, now, { force: true });
      expect(sel3?.slot).toBe('2');
    });

    it('selectRotatedAvenue round-robins multi-avenue families', async () => {
      const kv = new Map<string, string>();
      const env = {
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
      } as never;
      expect(await selectRotatedAvenue(env, 'demo', [])).toBeNull();
      expect(await selectRotatedAvenue(env, 'demo', ['only'])).toBe('only');
      expect(await selectRotatedAvenue(env, 'demo', ['a', 'b'])).toBe('a');
      expect(await selectRotatedAvenue(env, 'demo', ['a', 'b'])).toBe('b');
      expect(await selectRotatedAvenue(env, 'demo', ['a', 'b'])).toBe('a');
      // Independent family namespaces.
      expect(await selectRotatedAvenue(env, 'other', ['x', 'y'])).toBe('x');
    });

    it('resolveFmpRapidApiKey prefers FMP_RAPIDAPI_KEY then shared RAPIDAPI_KEY (ST)', async () => {
      expect(await resolveFmpRapidApiKey({} as never)).toBeNull();
      expect(await resolveFmpRapidApiKey({ RAPIDAPI_KEY: 'shared-marketplace' } as never)).toBe(
        'shared-marketplace',
      );
      expect(
        await resolveFmpRapidApiKey({
          FMP_RAPIDAPI_KEY: 'dedicated',
          RAPIDAPI_KEY: 'shared-marketplace',
        } as never),
      ).toBe('dedicated');
      // Free-tier FMP keys are NOT valid RapidAPI credentials.
      expect(await resolveFmpRapidApiKey({ FMP_LATENCY_API_KEY: 'free-tier' } as never)).toBeNull();
    });

    it('selectFmpLatencyPathForCycle stays on stable when RapidAPI is opted in (congress routes 404)', async () => {
      const kv = new Map<string, string>();
      const env = {
        FMP_LATENCY_API_KEY: 'k1',
        RAPIDAPI_KEY: 'marketplace-key',
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
      } as never;
      const ids = ['fmp', 'fmp_rapidapi', 'quiver'] as const;
      expect(await selectFmpLatencyPathForCycle(env, ids, { force: true })).toBe('stable');
      expect(await selectFmpLatencyPathForCycle(env, ids, { force: true })).toBe('stable');
      // Opt-in must not rotate a cycle onto RapidAPI house/senate (those 404).
      const both = { ...env, FMP_LATENCY_PATHS: 'stable,rapidapi' } as never;
      expect(await selectFmpLatencyPathForCycle(both, ids, { force: true })).toBe('stable');
      expect(await selectFmpLatencyPathForCycle(both, ids, { force: true })).toBe('stable');
      // rapidapi-only paths still select stable so the congress lane is not silent.
      const rapidOnly = { ...env, FMP_LATENCY_PATHS: 'rapidapi' } as never;
      expect(await selectFmpLatencyPathForCycle(rapidOnly, ['fmp_rapidapi'], { force: true })).toBe('stable');
      // A marketplace key is irrelevant: RapidAPI is not a disclosure candidate.
      const noRapid = {
        FMP_LATENCY_API_KEY: 'k1',
        FMP_LATENCY_PATHS: 'stable,rapidapi',
        CONFIG_KV: env.CONFIG_KV,
      } as never;
      expect(await selectFmpLatencyPathForCycle(noRapid, ids, { force: true })).toBe('stable');
      // Probe OFF — no path selected.
      const off = { ...env, FMP_LATENCY_PROBE_ENABLED: 'false' } as never;
      expect(await selectFmpLatencyPathForCycle(off, ids, { force: true })).toBeNull();
      // No free-tier key → nothing to probe (RapidAPI key must not stand in).
      const rapidKeyOnly = {
        RAPIDAPI_KEY: 'marketplace-key',
        FMP_LATENCY_PATHS: 'stable,rapidapi',
        CONFIG_KV: env.CONFIG_KV,
      } as never;
      expect(await selectFmpLatencyPathForCycle(rapidKeyOnly, ids, { force: true })).toBeNull();
    });

    it('selectFmpLatencyKey rotates dual free keys including FMP_API_KEY as slot-2 fallback', async () => {
      const kv = new Map<string, string>();
      const env = {
        FMP_LATENCY_API_KEY: 'free-key-a',
        FMP_API_KEY: 'free-key-b',
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
      } as never;
      const now = new Date('2026-08-05T15:00:00.000Z');
      const a = await selectFmpLatencyKey(env, now, { force: true });
      const b = await selectFmpLatencyKey(env, now, { force: true });
      const c = await selectFmpLatencyKey(env, now, { force: true });
      expect(a?.apiKey).toBe('free-key-a');
      expect(a?.slot).toBe('1');
      expect(b?.apiKey).toBe('free-key-b');
      expect(b?.slot).toBe('2');
      expect(b?.secretName).toBe('FMP_API_KEY');
      expect(c?.apiKey).toBe('free-key-a');
      // Duplicate of primary must not create a second slot.
      const same = {
        FMP_LATENCY_API_KEY: 'same',
        FMP_API_KEY: 'same',
        CONFIG_KV: env.CONFIG_KV,
      } as never;
      const only = await selectFmpLatencyKey(same, now, { force: true });
      expect(only?.slot).toBe('1');
      expect(await selectFmpLatencyKey(same, now, { force: true })).toMatchObject({ slot: '1', apiKey: 'same' });
      const fleet = await getFmpLatencyFleetRemaining(env, now);
      expect(fleet.freeTierKeysConfigured).toBe(2);
      expect(fleet.freeTierCap).toBe(FMP_LATENCY_DAILY_CAP_PER_KEY * 2);
    });

    it('listConfiguredFmpLatencySlots mirrors key material (incl. FMP_API_KEY slot-2 fallback)', async () => {
      const kv = new Map<string, string>();
      const configKv = {
        get: async (k: string) => kv.get(k) ?? null,
        put: async (k: string, v: string) => {
          kv.set(k, v);
        },
      };
      const dual = {
        FMP_LATENCY_API_KEY: 'free-key-a',
        FMP_API_KEY: 'free-key-b',
        CONFIG_KV: configKv,
      } as never;
      expect(await listConfiguredFmpLatencySlots(dual)).toEqual(['1', '2']);
      const same = {
        FMP_LATENCY_API_KEY: 'same',
        FMP_API_KEY: 'same',
        CONFIG_KV: configKv,
      } as never;
      expect(await listConfiguredFmpLatencySlots(same)).toEqual(['1']);
      const secondaryOnly = {
        FMP_LATENCY_API_KEY_2: 'k2',
        FMP_LATENCY_API_KEY: 'k1',
        CONFIG_KV: configKv,
      } as never;
      expect(await listConfiguredFmpLatencySlots(secondaryOnly)).toEqual(['1', '2']);
    });

    it('getFmpLatencyFleetRemaining sums dual free keys + RapidAPI path budget', async () => {
      const kv = new Map<string, string>();
      const env = {
        FMP_LATENCY_API_KEY: 'k1',
        ['FMP_LATENCY_API_KEY' + '_2']: 'k2',
        RAPIDAPI_KEY: 'marketplace',
        FMP_RAPIDAPI_DAILY_CAP: '100',
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
      } as never;
      const now = new Date('2026-08-05T15:00:00.000Z');
      const fleet = await getFmpLatencyFleetRemaining(env, now);
      expect(fleet.freeTierKeysConfigured).toBe(2);
      expect(fleet.freeTierCap).toBe(FMP_LATENCY_DAILY_CAP_PER_KEY * 2);
      expect(fleet.freeTierRemaining).toBe(FMP_LATENCY_DAILY_CAP_PER_KEY * 2);
      expect(fleet.rapidapiCap).toBe(100);
      expect(fleet.rapidapiRemaining).toBe(100);
      expect(fleet.totalRemaining).toBe(FMP_LATENCY_DAILY_CAP_PER_KEY * 2 + 100);
    });

    it('probe run never calls RapidAPI congress routes even when the path is opted in', async () => {
      const kv = new Map<string, string>();
      const hosts: string[] = [];
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = String(input);
        hosts.push(url);
        return new Response(JSON.stringify([]), { status: 200 });
      }) as typeof fetch;
      const env = {
        DISCLOSURE_LATENCY_WATCH_ENABLED: 'true',
        FMP_LATENCY_API_KEY: 'k1',
        RAPIDAPI_KEY: 'marketplace-key',
        FMP_LATENCY_PATHS: 'stable,rapidapi',
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
        DB: {
          prepare() {
            return {
              bind() {
                return this;
              },
              async all() {
                return { results: [] };
              },
              async first() {
                return null;
              },
              async run() {
                return { success: true, meta: { changes: 0 } };
              },
            };
          },
        },
      } as never;
      const now = new Date('2026-08-05T15:00:00.000Z');
      const r1 = await runDisclosureLatencyProbe(env, now, fetchImpl, {
        force: true,
        providers: ['fmp', 'fmp_rapidapi'],
      });
      // House + senate on the stable host only. RapidAPI must not be called.
      expect(hosts.length).toBe(2);
      expect(hosts.every((u) => u.includes('financialmodelingprep.com'))).toBe(true);
      expect(hosts.some((u) => u.includes('rapidapi.com'))).toBe(false);
      const skipped = r1.providers.find((p) => p.id === 'fmp_rapidapi');
      expect(skipped?.enabled).toBe(false);
      expect(skipped?.operationalStatus).toBe('off');
      expect(skipped?.reason).toMatch(/404/);

      hosts.length = 0;
      const r2 = await runDisclosureLatencyProbe(env, now, fetchImpl, {
        force: true,
        providers: ['fmp', 'fmp_rapidapi'],
      });
      expect(hosts.length).toBe(2);
      expect(hosts.every((u) => u.includes('financialmodelingprep.com'))).toBe(true);
      expect(hosts.some((u) => u.includes('rapidapi.com'))).toBe(false);
      const stable = r2.providers.find((p) => p.id === 'fmp');
      expect(stable?.enabled).toBe(true);
    });

    it('selectFmpLatencyKey skips a slot marked HTTP 429 for the UTC day', async () => {
      const kv = new Map<string, string>();
      const env = {
        FMP_LATENCY_API_KEY: 'k1',
        FMP_API_KEY: 'k2',
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
      } as never;
      const now = new Date('2026-08-05T15:00:00.000Z');
      await markFmpSlotHttp429(env, '1', now, '429');
      const picked = await selectFmpLatencyKey(env, now, { force: true });
      expect(picked?.slot).toBe('2');
    });

    it('isFmpSlotHttp429DayBan is true only for 429 cause, not unauthorized or legacy', async () => {
      const kv = new Map<string, string>();
      const env = {
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
      } as never;
      const now = new Date('2026-08-05T15:00:00.000Z');
      await markFmpSlotHttp429(env, '1', now, '429');
      expect(await readFmpSlotHttp429Cause(env, '1', now)).toBe('429');
      expect(await isFmpSlotHttp429DayBan(env, '1', now)).toBe(true);
      await markFmpSlotHttp429(env, '2', now, 'unauthorized');
      expect(await readFmpSlotHttp429Cause(env, '2', now)).toBe('unauthorized');
      expect(await isFmpSlotHttp429DayBan(env, '2', now)).toBe(false);
      expect(await isFmpSlotHttp429(env, '2', now)).toBe(true);
      kv.set('fmp-latency:http429:key1:2026-08-05', '1');
      expect(await isFmpSlotHttp429DayBan(env, '1', now)).toBe(false);
      expect(await isFmpSlotHttp429(env, '1', now)).toBe(true);
    });

    it('retries the other FMP free-tier key in the same cycle after HTTP 401', async () => {
      const kv = new Map<string, string>();
      const keysUsed: string[] = [];
      const row = {
        symbol: 'AAPL',
        firstName: 'Ro',
        lastName: 'Khanna',
        office: 'Ro Khanna',
        disclosureDate: '2026-08-17',
        transactionDate: '2026-08-10',
        type: 'Purchase',
      };
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;
        const key = decodeURIComponent((/[?&]apikey=([^&]+)/.exec(url) || [])[1] || '');
        if (key && !keysUsed.includes(key)) keysUsed.push(key);
        if (key && key === keysUsed[0]) {
          return new Response('Invalid API KEY', { status: 401 });
        }
        return new Response(JSON.stringify([row]), { status: 200 });
      }) as typeof fetch;
      const env = {
        DISCLOSURE_LATENCY_WATCH_ENABLED: 'true',
        FMP_LATENCY_API_KEY: 'dead-key',
        FMP_LATENCY_API_KEY_2: 'live-key',
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
        DB: {
          prepare() {
            return {
              bind() { return this; },
              async all() { return { results: [] }; },
              async first() { return null; },
              async run() { return { success: true, meta: { changes: 0 } }; },
            };
          },
        },
      } as never;
      const now = new Date('2026-08-05T15:00:00.000Z');
      const result = await runDisclosureLatencyProbe(env, now, fetchImpl, {
        force: true,
        providers: ['fmp'],
      });
      expect(new Set(keysUsed)).toEqual(new Set(['dead-key', 'live-key']));
      expect(result.errors).toEqual([]);
      expect(result.fetchedRows).toBeGreaterThan(0);
      const failedFirst = keysUsed[0] === 'dead-key';
      expect(await isFmpSlotHttp429(env, failedFirst ? '1' : '2', now)).toBe(true);
      // The unauthorized key must not win the next selection.
      const next = await selectFmpLatencyKey(env, now, { force: true });
      expect(next?.apiKey).toBe(failedFirst ? 'live-key' : 'dead-key');
    });

    it('retries the other FMP free-tier key in the same cycle after HTTP 429', async () => {
      const kv = new Map<string, string>();
      const keysUsed: string[] = [];
      const row = {
        symbol: 'AAPL',
        firstName: 'Ro',
        lastName: 'Khanna',
        office: 'Ro Khanna',
        disclosureDate: '2026-08-17',
        transactionDate: '2026-08-10',
        type: 'Purchase',
      };
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;
        const key = decodeURIComponent((/[?&]apikey=([^&]+)/.exec(url) || [])[1] || '');
        if (key && !keysUsed.includes(key)) keysUsed.push(key);
        // First distinct key is the 429 slot; the retry must use a different one.
        if (key && key === keysUsed[0]) {
          return new Response(JSON.stringify({ 'Error Message': 'Bandwidth Limit Reach' }), { status: 429 });
        }
        return new Response(JSON.stringify([row]), { status: 200 });
      }) as typeof fetch;
      const env = {
        DISCLOSURE_LATENCY_WATCH_ENABLED: 'true',
        FMP_LATENCY_API_KEY: 'k1',
        FMP_API_KEY: 'k2',
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
        DB: {
          prepare() {
            return {
              bind() { return this; },
              async all() { return { results: [] }; },
              async first() { return null; },
              async run() { return { success: true, meta: { changes: 0 } }; },
            };
          },
        },
      } as never;
      const now = new Date('2026-08-05T15:00:00.000Z');
      const result = await runDisclosureLatencyProbe(env, now, fetchImpl, {
        force: true,
        providers: ['fmp'],
      });
      expect(keysUsed.length).toBe(2);
      expect(result.errors).toEqual([]);
      expect(result.fetchedRows).toBeGreaterThan(0);
      const marked =
        (await isFmpSlotHttp429(env, '1', now)) || (await isFmpSlotHttp429(env, '2', now));
      expect(marked).toBe(true);
    });

    it('retries one FMP key through the residential proxy after both free-tier keys 429', async () => {
      const kv = new Map<string, string>();
      let fetchCalls = 0;
      const fetchImpl = (async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ 'Error Message': 'Bandwidth Limit Reach' }), { status: 429 });
      }) as typeof fetch;
      const env = {
        DISCLOSURE_LATENCY_WATCH_ENABLED: 'true',
        FMP_LATENCY_API_KEY: 'k1',
        FMP_API_KEY: 'k2',
        RESIDENTIAL_PROXY_URL: 'http://127.0.0.1:3128',
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
        DB: {
          prepare() {
            return {
              bind() { return this; },
              async all() { return { results: [] }; },
              async first() { return null; },
              async run() { return { success: true, meta: { changes: 0 } }; },
            };
          },
        },
      } as never;
      const result = await runDisclosureLatencyProbe(env, new Date('2026-08-05T15:00:00.000Z'), fetchImpl, {
        force: true,
        providers: ['fmp'],
      });
      // Direct key1 + other key + proxy retry. Node has no Deno HTTP client so
      // the proxy wrapper is identity, but the extra attempt still fires.
      expect(fetchCalls).toBeGreaterThanOrEqual(3);
      expect(result.fetchedRows).toBe(0);
      expect(result.errors.some((e) => /HTTP_429/.test(e))).toBe(true);
    });

    it('does not treat Quiver HTTP 403 as a successful empty feed', async () => {
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ detail: 'Upgrade your subscription plan to access this dataset.' }), {
          status: 403,
        })) as typeof fetch;
      const env = {
        DISCLOSURE_LATENCY_WATCH_ENABLED: 'true',
        QUIVER_API_KEY: 'qq-dead',
        CONFIG_KV: {
          get: async () => null,
          put: async () => {},
        },
        DB: {
          prepare() {
            return {
              bind() { return this; },
              async all() { return { results: [] }; },
              async first() { return null; },
              async run() { return { success: true, meta: { changes: 0 } }; },
            };
          },
        },
      } as never;
      const result = await runDisclosureLatencyProbe(env, new Date('2026-08-05T15:00:00.000Z'), fetchImpl, {
        force: true,
        providers: ['quiver'],
      });
      expect(result.fetchedRows).toBe(0);
      expect(result.errors.some((e) => /HTTP_403/.test(e))).toBe(true);
    });

    it('stays running when last observation is stale but probes still succeed', async () => {
      const stale = new Date(Date.now() - 95 * 3_600_000).toISOString();
      const env = {
        FMP_LATENCY_API_KEY: 'k1',
        DISCLOSURE_LATENCY_WATCH_ENABLED: 'true',
        CONFIG_KV: { get: async () => null, put: async () => {} },
        DB: {
          prepare(sql: string) {
            return {
              bind() { return this; },
              async all() { return { results: [] }; },
              async first() {
                if (String(sql).includes('trade_provider_observations')) {
                  return { last_obs: stale };
                }
                if (String(sql).includes('provider_probe_runs')) {
                  return { last_ok: new Date().toISOString() };
                }
                return null;
              },
              async run() { return { success: true, meta: { changes: 0 } }; },
            };
          },
        },
      } as never;
      const statuses = await getDisclosureLatencyProviderStatuses(env);
      const fmp = statuses.find((s) => s.id === 'fmp');
      expect(fmp?.operationalStatus).toBe('running');
      expect(fmp?.reason).toMatch(/probes still succeeding/);
    });

    it('marks a configured provider error when last observation is older than 24h', async () => {
      const stale = new Date(Date.now() - 95 * 3_600_000).toISOString();
      const env = {
        QUIVER_API_KEY: 'qq',
        CONFIG_KV: { get: async () => null, put: async () => {} },
        DB: {
          prepare(sql: string) {
            return {
              bind() { return this; },
              async all() { return { results: [] }; },
              async first() {
                if (String(sql).includes('trade_provider_observations')) {
                  return { last_obs: stale };
                }
                return null;
              },
              async run() { return { success: true, meta: { changes: 0 } }; },
            };
          },
        },
      } as never;
      const statuses = await getDisclosureLatencyProviderStatuses(env);
      const qq = statuses.find((s) => s.id === 'quiver');
      expect(qq?.operationalStatus).toBe('error');
      expect(qq?.reason).toMatch(/95h/);
    });

    it('skips a key that is at daily cap', async () => {
      const kv = new Map<string, string>();
      const env = {
        FMP_LATENCY_API_KEY: 'k1',
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
      } as never;
      const now = new Date('2026-08-05T15:00:00.000Z');
      await addFmpLatencyUsed(env, '1', FMP_LATENCY_DAILY_CAP_PER_KEY, now);
      expect(await selectFmpLatencyKey(env, now, { force: true })).toBeNull();
    });

    it('reports FMP configured when latency key or free-tier FMP_API_KEY present', async () => {
      // FMP_API_KEY alone is valid free-tier material (slot-2 fallback / single key).
      const statusesLegacy = await getDisclosureLatencyProviderStatuses({
        FMP_API_KEY: 'free-tier-only',
        CONFIG_KV: { get: async () => null, put: async () => {} },
      } as never);
      const fmpLegacy = statusesLegacy.find((s) => s.id === 'fmp');
      expect(fmpLegacy?.configured).toBe(true);

      const statuses = await getDisclosureLatencyProviderStatuses({
        ['FMP_LATENCY_API_KEY' + '_2']: 'second-key',
        CONFIG_KV: { get: async () => null, put: async () => {} },
      } as never);
      const fmp = statuses.find((s) => s.id === 'fmp');
      expect(fmp?.configured).toBe(true);
    });

    it('defaults FMP family ON for CT when latency key present (explicit false disables); rapidapi path off by default', async () => {
      const env = {
        FMP_LATENCY_API_KEY: 'latency-key',
        RAPIDAPI_KEY: 'marketplace-key',
        CONFIG_KV: { get: async () => null, put: async () => {} },
      } as never;
      const defaultStatuses = await getDisclosureLatencyProviderStatuses(env);
      const fmp = defaultStatuses.find((s) => s.id === 'fmp');
      const rapid = defaultStatuses.find((s) => s.id === 'fmp_rapidapi');
      // Default ON for stable — not grey OFF (owner: FMP is for CT latency).
      expect(fmp?.operationalStatus).toBe('running');
      // RapidAPI path default OFF (no house/senate/executive disclosure feed).
      expect(rapid?.operationalStatus).toBe('off');
      expect(rapid?.reason).toMatch(/404/);
      expect(fmp?.configured).toBe(true);
      expect(rapid?.configured).toBe(true);
      expect(listFmpLatencyPathRegistry().map((p) => p.pathId).sort()).toEqual(['rapidapi', 'stable']);

      const offEnv = { ...env, FMP_LATENCY_PROBE_ENABLED: 'false' } as never;
      const offStatuses = await getDisclosureLatencyProviderStatuses(offEnv);
      expect(offStatuses.find((s) => s.id === 'fmp')?.operationalStatus).toBe('off');
      expect(offStatuses.find((s) => s.id === 'fmp_rapidapi')?.operationalStatus).toBe('off');

      const withRapid = {
        ...env,
        FMP_LATENCY_PATHS: 'stable,rapidapi',
      } as never;
      const pathStatuses = await getDisclosureLatencyProviderStatuses(withRapid);
      expect(pathStatuses.find((s) => s.id === 'fmp')?.operationalStatus).toBe('running');
      // Opt-in does not turn RapidAPI into a congress probe.
      expect(pathStatuses.find((s) => s.id === 'fmp_rapidapi')?.operationalStatus).toBe('off');
      expect(pathStatuses.find((s) => s.id === 'fmp_rapidapi')?.reason).toMatch(/404/);
      const rapidOnly = { ...env, FMP_LATENCY_PATHS: 'rapidapi' } as never;
      const rapidOnlyStatuses = await getDisclosureLatencyProviderStatuses(rapidOnly);
      expect(rapidOnlyStatuses.find((s) => s.id === 'fmp')?.operationalStatus).toBe('running');
      expect(rapidOnlyStatuses.find((s) => s.id === 'fmp_rapidapi')?.operationalStatus).toBe('off');
    });

    it('skips FMP HTTP when probe is explicitly OFF even if watch is force-run', async () => {
      let fetchCount = 0;
      const fetchImpl = (async () => {
        fetchCount += 1;
        return new Response(JSON.stringify([]), { status: 200 });
      }) as typeof fetch;
      const env = {
        DISCLOSURE_LATENCY_WATCH_ENABLED: 'true',
        FMP_LATENCY_PROBE_ENABLED: 'false',
        FMP_LATENCY_API_KEY: 'k1',
        CONFIG_KV: {
          get: async () => null,
          put: async () => {},
        },
        DB: {
          prepare() {
            return {
              bind() { return this; },
              async all() { return { results: [] }; },
              async first() { return null; },
              async run() { return { success: true, meta: { changes: 0 } }; },
            };
          },
        },
      } as never;
      const result = await runDisclosureLatencyProbe(env, new Date('2026-08-05T15:00:00.000Z'), fetchImpl, {
        force: true,
        providers: ['fmp', 'fmp_rapidapi'],
      });
      expect(fetchCount).toBe(0);
      expect(result.providers.every((p) => p.operationalStatus === 'off')).toBe(true);
      expect(result.fetchedRows).toBe(0);
    });
  });

  describe('public scoreboard FMP merge + effective timing', () => {
    it('earliestIso picks the minimum parseable stamp', () => {
      expect(earliestIso('2026-08-05T12:00:00.000Z', '2026-08-05T11:00:00.000Z', null)).toBe(
        '2026-08-05T11:00:00.000Z',
      );
      expect(earliestIso(null, undefined, '')).toBeNull();
    });

    it('effectiveRaceProviderTime falls back to first_seen for provider-kind feeds', () => {
      expect(
        effectiveRaceProviderTime('provider', {
          provider_published_at: null,
          provider_first_seen_at: '2026-08-05T10:00:00.000Z',
        }),
      ).toBe('2026-08-05T10:00:00.000Z');
      expect(
        effectiveRaceProviderTime('provider', {
          provider_published_at: '2026-08-05T09:00:00.000Z',
          provider_first_seen_at: '2026-08-05T10:00:00.000Z',
        }),
      ).toBe('2026-08-05T09:00:00.000Z');
      expect(
        effectiveRaceProviderTime('monitor', {
          provider_published_at: '2026-08-05T09:00:00.000Z',
          provider_first_seen_at: '2026-08-05T10:00:00.000Z',
        }),
      ).toBe('2026-08-05T10:00:00.000Z');
    });

    it('mergeFmpFamilyCandidateRows collapses dual paths by trade_hash with earliest stamp', () => {
      const merged = mergeFmpFamilyCandidateRows([
        {
          provider: 'fmp',
          trade_hash: 't1',
          status: 'matched',
          chamber: 'house',
          provider_key: 'a',
          match_method: 'trade-hash',
          congress_first_seen_at: '2026-08-05T10:00:00.000Z',
          provider_first_seen_at: '2026-08-05T10:05:00.000Z',
          provider_published_at: null,
          filed_date: '2026-08-05',
          created_at: '2026-08-05T10:00:00.000Z',
          updated_at: '2026-08-05T10:05:00.000Z',
        },
        {
          provider: 'fmp_rapidapi',
          trade_hash: 't1',
          status: 'matched',
          chamber: 'house',
          provider_key: 'b',
          match_method: 'trade-hash',
          congress_first_seen_at: '2026-08-05T10:00:00.000Z',
          provider_first_seen_at: '2026-08-05T10:02:00.000Z',
          provider_published_at: null,
          filed_date: '2026-08-05',
          created_at: '2026-08-05T10:00:00.000Z',
          updated_at: '2026-08-05T10:02:00.000Z',
        },
      ]);
      expect(merged).toHaveLength(1);
      expect(merged[0]!.provider).toBe('fmp');
      expect(merged[0]!.provider_first_seen_at).toBe('2026-08-05T10:02:00.000Z');
    });

    it('mergeFmpFamilyObservationRows dedupes by trade_hash', () => {
      const merged = mergeFmpFamilyObservationRows([
        {
          provider: 'fmp',
          chamber: 'house',
          provider_key: 'a',
          trade_hash: 't1',
          first_observed_at: '2026-08-05T10:05:00.000Z',
          last_observed_at: '2026-08-05T10:05:00.000Z',
          provider_published_at: null,
          source_url: null,
          filed_date: null,
          filer_name: null,
          payload: null,
        },
        {
          provider: 'fmp_rapidapi',
          chamber: 'house',
          provider_key: 'b',
          trade_hash: 't1',
          first_observed_at: '2026-08-05T10:01:00.000Z',
          last_observed_at: '2026-08-05T10:01:00.000Z',
          provider_published_at: null,
          source_url: null,
          filed_date: null,
          filer_name: null,
          payload: null,
        },
      ]);
      expect(merged).toHaveLength(1);
      expect(merged[0]!.first_observed_at).toBe('2026-08-05T10:01:00.000Z');
      expect(merged[0]!.provider).toBe('fmp');
    });

    it('mergeFmpOperationalStatus prefers running over stopped/off', () => {
      expect(mergeFmpOperationalStatus(['off', 'running'])).toBe('running');
      expect(mergeFmpOperationalStatus(['stopped', 'off'])).toBe('stopped');
      expect(mergeFmpOperationalStatus(['off', 'off'])).toBe('off');
    });

    it('isLatencyComparisonPublic keeps only running lanes with a trustworthy coverage join', () => {
      expect(isLatencyComparisonPublic({ operationalStatus: 'running' })).toBe(true);
      expect(isLatencyComparisonPublic({ operationalStatus: 'running', coverageIntegrity: 'ok' })).toBe(true);
      expect(isLatencyComparisonPublic({ operationalStatus: 'error' })).toBe(false);
      expect(isLatencyComparisonPublic({ operationalStatus: 'stopped' })).toBe(false);
      expect(isLatencyComparisonPublic({ operationalStatus: 'off' })).toBe(false);
      expect(isLatencyComparisonPublic({ operationalStatus: 'unknown' })).toBe(false);
      expect(isLatencyComparisonPublic({
        operationalStatus: 'running',
        coverageIntegrity: 'contradiction',
      })).toBe(false);
      expect(PUBLIC_FMP_LATENCY_LABEL).toBe('FinancialModelingPrep.com');
    });
  });

  describe('provider filer parsing (FMP zero-match regression)', () => {
    // Verbatim shape of a real GET /stable/house-latest row. Confirmed against
    // the payloads production actually stored: the keys are firstName /
    // lastName / office — there is no `representative`, `senator`, `filerName`
    // or `name`, which is what the parser used to read and why 309 of 309
    // stored FMP observations had filer_name NULL and an unmatchable hash.
    const FMP_HOUSE_ROW = {
      symbol: 'PANW',
      senateID: 'M001239',
      disclosureDate: '2026-08-11',
      transactionDate: '2026-07-31',
      firstName: 'John',
      lastName: 'McGuire',
      office: 'John McGuire',
      district: 'VA05',
      owner: 'Self',
      assetDescription: 'Palo Alto Networks Inc',
      assetType: 'Stock',
      type: 'Sale',
      amount: '$1,001 - $15,000',
      comment: '',
      link: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035180.pdf',
    };

    it('SHOULD-MATCH pair: the live FMP payload now pairs with the CT candidate it never could', () => {
      const [row] = parseFmpDisclosureRows('house', [FMP_HOUSE_ROW]);
      expect(row.filerName).toBe('John McGuire');
      expect(row.tradeHash).toBe('mcguire_PANW_2026-07-31_sell');
      expect(tradeHashHasFiler(row.tradeHash)).toBe(true);

      // The CT side of the same disclosure, hashed by the live ingestion path.
      const ctHash = generateTradeHash('John McGuire', 'PANW', '2026-07-31', 'S');
      expect(ctHash).toBe('mcguire_PANW_2026-07-31_sell');
      expect(matchDisclosureCandidate({ trade_hash: ctHash }, row)).toEqual({
        providerKey: '20035180',
        matchMethod: 'trade-hash',
      });
    });

    it('the pre-fix field list produced an unmatchable empty-filer hash', () => {
      // Reproduces the old behaviour: read only the full-name keys FMP does
      // not send, and the leading segment of the hash is empty.
      const legacyHash = generateTradeHash(null, 'PANW', '2026-07-31', 'Sale');
      expect(legacyHash).toBe('_PANW_2026-07-31_sell');
      expect(tradeHashHasFiler(legacyHash)).toBe(false);
      expect(
        matchDisclosureCandidate(
          { trade_hash: 'mcguire_PANW_2026-07-31_sell' },
          { ...parseFmpDisclosureRows('house', [FMP_HOUSE_ROW])[0], tradeHash: legacyHash },
        ),
      ).toBeNull();
    });

    it('MUST-NOT-MATCH near miss: same ticker, date and side, different member', () => {
      const [row] = parseFmpDisclosureRows('house', [FMP_HOUSE_ROW]);
      // Another House member sold PANW the same day. Every axis but the person
      // agrees, so no branch — exact or fuzzy — may pair them.
      const otherMember = generateTradeHash('Marjorie McGuiness', 'PANW', '2026-07-31', 'S');
      expect(otherMember).not.toBe(row.tradeHash);
      expect(matchDisclosureCandidate({ trade_hash: otherMember }, row)).toBeNull();
    });

    it('MUST-NOT-MATCH near miss: same member and ticker, date outside the slack window', () => {
      const [row] = parseFmpDisclosureRows('house', [FMP_HOUSE_ROW]);
      // 2026-07-31 vs 2026-07-25 is 6 days — beyond LATENCY_FUZZY_DATE_SLACK_DAYS.
      const staleDate = generateTradeHash('John McGuire', 'PANW', '2026-07-25', 'S');
      expect(matchDisclosureCandidate({ trade_hash: staleDate }, row)).toBeNull();
      // ...and the opposite side never pairs either.
      const wrongSide = generateTradeHash('John McGuire', 'PANW', '2026-07-31', 'P');
      expect(matchDisclosureCandidate({ trade_hash: wrongSide }, row)).toBeNull();
    });

    it('providerFilerName prefers a declared name, then first+last, then the display field', () => {
      expect(providerFilerName({ name: 'Hern, Kevin' }, ['name'])).toBe('Kevin Hern');
      expect(providerFilerName({ firstName: 'John', lastName: 'McGuire' }, ['name'], ['office'])).toBe(
        'John McGuire',
      );
      expect(providerFilerName({ office: 'John McGuire' }, ['name'], ['office'])).toBe('John McGuire');
      // Structured parts outrank the display field.
      expect(
        providerFilerName({ firstName: 'John', lastName: 'McGuire', office: 'VA05' }, ['name'], ['office']),
      ).toBe('John McGuire');
      expect(providerFilerName({ symbol: 'PANW' }, ['name'], ['office'])).toBeNull();
    });

    it('runs Unusual Whales names through the same normalizer as our own side', () => {
      const [row] = parseUnusualWhalesDisclosureRows([
        { name: 'KHANNA, ROHIT', ticker: 'NVDA', transaction_date: '2026-07-30', txn_type: 'Purchase' },
      ]);
      // cleanFilerName flips "Last, First", title-cases the shout, and applies
      // the curated legal-name alias — identical to the House/Senate path.
      expect(row.filerName).toBe('Ro Khanna');
      expect(row.tradeHash).toBe('khanna_NVDA_2026-07-30_buy');
    });
  });

  describe('repairProviderObservationHashes', () => {
    function repairEnv(rows: Array<Record<string, unknown>>) {
      const updates: Array<{ sql: string; params: unknown[] }> = [];
      return {
        env: {
          DB: {
            prepare(sql: string) {
              return {
                params: [] as unknown[],
                bind(...params: unknown[]) {
                  this.params = params;
                  return this;
                },
                async all<T>() {
                  return { results: rows as T[] };
                },
                async first<T>() {
                  return null as T | null;
                },
                async run() {
                  updates.push({ sql, params: this.params });
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          },
        } as never,
        updates,
      };
    }

    it('re-hashes a stored FMP row in place, keeping the first_observed_at stamp', async () => {
      const { env, updates } = repairEnv([
        {
          provider: 'fmp',
          chamber: 'house',
          provider_key: '20035180',
          trade_hash: '_PANW_2026-07-31_sell',
          payload: JSON.stringify({
            symbol: 'PANW',
            transactionDate: '2026-07-31',
            firstName: 'John',
            lastName: 'McGuire',
            office: 'John McGuire',
            type: 'Sale',
          }),
        },
      ]);
      const result = await repairProviderObservationHashes(env, 10);
      expect(result).toMatchObject({ scanned: 1, repaired: 1, dropped: 0, unresolved: 0 });
      // An UPDATE, never a delete-and-reinsert: re-fetching would reset
      // first_observed_at to now and destroy the race evidence.
      expect(updates).toHaveLength(1);
      expect(updates[0]!.sql).toMatch(/UPDATE trade_provider_observations/);
      expect(updates[0]!.sql).not.toMatch(/first_observed_at/);
      expect(updates[0]!.params[0]).toBe('mcguire_PANW_2026-07-31_sell');
      expect(updates[0]!.params[1]).toBe('John McGuire');
    });

    it('leaves a row alone when the payload still yields no filer', async () => {
      const { env, updates } = repairEnv([
        {
          provider: 'fmp',
          chamber: 'house',
          provider_key: 'k',
          trade_hash: '_PANW_2026-07-31_sell',
          payload: JSON.stringify({ symbol: 'PANW', transactionDate: '2026-07-31', type: 'Sale' }),
        },
      ]);
      const result = await repairProviderObservationHashes(env, 10);
      expect(result).toMatchObject({ repaired: 0, unresolved: 1 });
      expect(updates).toHaveLength(0);
    });
  });

  describe('match strength', () => {
    it('keeps the headline on fully specified pairings', () => {
      expect(matchStrength('trade-hash')).toBe('strong');
      expect(matchStrength('fuzzy-near-date')).toBe('strong');
      expect(matchStrength(CORPUS_MATCH_METHOD)).toBe('strong');
      // One identity axis never verified — reported, never in the headline.
      expect(matchStrength('fuzzy-missing-date')).toBe('weak');
      expect(matchStrength('fuzzy-no-ticker')).toBe('weak');
      expect(matchStrength('something-new')).toBe('weak');
      expect(matchStrength(null)).toBe('none');
    });
  });

  describe('coverage is not coupled to the candidate window', () => {
    const NOW = '2026-08-11T21:00:00.000Z';
    const MATURITY = '2026-08-10T21:00:00.000Z';
    // The pairing CT made three weeks ago, for an observation seen four days ago.
    const agedCandidate = {
      provider: 'quiver' as const,
      trade_hash: 'delaney_HUBB_2026-07-23_buy',
      status: 'matched',
      chamber: 'house' as const,
      provider_key: 'qq-1',
      match_method: 'trade-hash',
      congress_first_seen_at: '2026-07-21T15:32:44.034Z',
      provider_first_seen_at: '2026-08-07T04:30:10.001Z',
      provider_published_at: null,
      filed_date: '2026-07-21',
      created_at: '2026-07-21T15:32:44.034Z',
      updated_at: '2026-08-07T04:30:10.001Z',
    };
    const observation = {
      provider: 'quiver' as const,
      chamber: 'house' as const,
      provider_key: 'qq-1',
      trade_hash: 'delaney_HUBB_2026-07-23_buy',
      first_observed_at: '2026-08-07T04:30:10.001Z',
      last_observed_at: '2026-08-07T04:30:10.001Z',
      provider_published_at: null,
      source_url: null,
      filed_date: '2026-07-21',
      filer_name: 'John Delaney',
      payload: null,
    };

    it('counts a matched pair whose CT side aged past the 7d score window', () => {
      // `mine` is the 7d timing cohort and legitimately excludes the aged
      // candidate; the observation is still inside the 14d monitor window.
      const [, quiver] = buildPublicLatencyProviders(
        [],
        [],
        [observation],
        [],
        MATURITY,
        [
          {
            provider: 'quiver',
            chamber: 'house',
            provider_key: 'qq-1',
            trade_hash: 'delaney_HUBB_2026-07-23_buy',
            match_method: 'trade-hash',
          },
        ],
      ).filter((p) => p.provider === 'fmp' || p.provider === 'quiver');
      expect(quiver.provider).toBe('quiver');
      expect(quiver.maturedProviderObserved).toBe(1);
      expect(quiver.maturedMatched).toBe(1);
      expect(quiver.ctCoveragePct).toBe(100);
      expect(quiver.unmatchedProvider).toBe(0);
      expect(NOW).toBeTruthy();
    });

    it('without the match-clock index the same pair reads as 0% (the old bug)', () => {
      const [, quiver] = buildPublicLatencyProviders([], [], [observation], [], MATURITY, []).filter(
        (p) => p.provider === 'fmp' || p.provider === 'quiver',
      );
      expect(quiver.maturedMatched).toBe(0);
      expect(quiver.ctCoveragePct).toBe(0);
      expect(quiver.unmatchedProvider).toBe(1);
      expect(agedCandidate.status).toBe('matched');
    });

    it('never spreads one pairing across every line of a filing that shares a provider_key', () => {
      // FMP's provider_key is the PTR document token, so all five lines of one
      // filing carry it. In production 309 FMP observations span 31 keys and a
      // single key covers 73 trades — crediting by key alone would turn one
      // pairing into 73.
      const filing = ['AAPL', 'MSFT', 'NVDA', 'PANW', 'TSLA'].map((ticker) => ({
        provider: 'fmp' as const,
        chamber: 'house' as const,
        provider_key: '20035180',
        trade_hash: `hern_${ticker}_2026-08-05_sell`,
        first_observed_at: '2026-08-07T04:30:10.001Z',
        last_observed_at: '2026-08-07T04:30:10.001Z',
        provider_published_at: null,
        source_url: null,
        filed_date: '2026-08-05',
        filer_name: 'Kevin Hern',
        payload: null,
      }));
      const [fmp] = buildPublicLatencyProviders([], [], filing, [], MATURITY, [
        {
          provider: 'fmp',
          chamber: 'house',
          provider_key: '20035180',
          trade_hash: 'hern_PANW_2026-08-05_sell',
          match_method: 'trade-hash',
        },
      ]);
      expect(fmp.provider).toBe('fmp');
      expect(fmp.maturedProviderObserved).toBe(5);
      // Exactly the one line that actually paired.
      expect(fmp.maturedMatched).toBe(1);
      expect(fmp.unmatchedProvider).toBe(4);
      expect(fmp.ctCoveragePct).toBe(20);
    });

    describe('contradiction guard: 0% coverage while holding pairings is not publishable', () => {
      // The production shape this guard exists for: many matured provider rows,
      // none of them matched, while trade_latency_candidates holds strong
      // pairings for the same lane. Those two facts cannot both be true.
      const observations = Array.from({ length: 12 }, (_, i) => ({
        ...observation,
        provider_key: `qq-${100 + i}`,
        trade_hash: `member${i}_ACME_2026-07-2${i % 10}_buy`,
      }));

      it('suppresses ctCoveragePct instead of publishing a 0% it did not measure', () => {
        const [, quiver] = buildPublicLatencyProviders([], [], observations, [], MATURITY, [
          // Real pairings on file — but for trades the observation cohort does
          // not contain, which is the signature of a broken lookup.
          {
            provider: 'quiver',
            chamber: 'house',
            provider_key: 'qq-other',
            trade_hash: 'delaney_HUBB_2026-07-23_buy',
            match_method: 'trade-hash',
          },
        ]).filter((p) => p.provider === 'fmp' || p.provider === 'quiver');

        expect(quiver.maturedProviderObserved).toBe(12);
        expect(quiver.maturedMatched).toBe(0);
        expect(quiver.coverageStrongPairingsOnFile).toBe(1);
        expect(quiver.coverageIntegrity).toBe('contradiction');
        // The whole point: not 0.
        expect(quiver.ctCoveragePct).toBeNull();
        expect(quiver.overlapPct).toBeNull();
        // A broken join must never reach a publishable claim.
        expect(quiver.comparisonStatus).not.toBe('usable');
      });

      it('still reports an honest 0% when there are genuinely no pairings on file', () => {
        const [, quiver] = buildPublicLatencyProviders([], [], observations, [], MATURITY, []).filter(
          (p) => p.provider === 'fmp' || p.provider === 'quiver',
        );
        expect(quiver.coverageStrongPairingsOnFile).toBe(0);
        expect(quiver.coverageIntegrity).toBe('ok');
        // Nothing contradicts this zero, so it is a measurement and it stands.
        expect(quiver.ctCoveragePct).toBe(0);
        expect(quiver.unmatchedProvider).toBe(12);
      });

      it('does not fire on weak-only pairings, which are excluded from the headline by design', () => {
        const [, quiver] = buildPublicLatencyProviders([], [], observations, [], MATURITY, [
          {
            provider: 'quiver',
            chamber: 'house',
            provider_key: 'qq-other',
            trade_hash: 'delaney_HUBB_2026-07-23_buy',
            match_method: 'fuzzy-missing-date',
          },
        ]).filter((p) => p.provider === 'fmp' || p.provider === 'quiver');
        // maturedMatched counts strong only, so a weak pairing on file is not
        // in tension with a strong-zero. This 0% is honest.
        expect(quiver.coverageStrongPairingsOnFile).toBe(0);
        expect(quiver.coverageIntegrity).toBe('ok');
        expect(quiver.ctCoveragePct).toBe(0);
      });

      it('stays quiet on a healthy lane', () => {
        const [, quiver] = buildPublicLatencyProviders([], [], [observation], [], MATURITY, [
          {
            provider: 'quiver',
            chamber: 'house',
            provider_key: 'qq-1',
            trade_hash: 'delaney_HUBB_2026-07-23_buy',
            match_method: 'trade-hash',
          },
        ]).filter((p) => p.provider === 'fmp' || p.provider === 'quiver');
        expect(quiver.coverageIntegrity).toBe('ok');
        expect(quiver.ctCoveragePct).toBe(100);
      });

      it('does not fire when a lane observed nothing matured (no ratio to contradict)', () => {
        const [, quiver] = buildPublicLatencyProviders([], [], [], [], MATURITY, [
          {
            provider: 'quiver',
            chamber: 'house',
            provider_key: 'qq-1',
            trade_hash: 'delaney_HUBB_2026-07-23_buy',
            match_method: 'trade-hash',
          },
        ]).filter((p) => p.provider === 'fmp' || p.provider === 'quiver');
        expect(quiver.maturedProviderObserved).toBe(0);
        expect(quiver.coverageIntegrity).toBe('ok');
        expect(quiver.ctCoveragePct).toBeNull();
      });
    });

    it('flags stored observations that can never match instead of calling them a coverage miss', () => {
      const [fmp] = buildPublicLatencyProviders(
        [],
        [],
        [{ ...observation, provider: 'fmp', trade_hash: '_PANW_2026-07-31_sell', provider_key: 'k' }],
        [],
        MATURITY,
        [],
      );
      expect(fmp.provider).toBe('fmp');
      expect(fmp.observedRowsMissingFiler).toBe(1);
    });
  });

  describe('scope denominator (N of M matched)', () => {
    const inWindow = '2026-08-05T00:00:00.000Z';
    const candidate = (over: Record<string, unknown>) => ({
      provider: 'quiver' as const,
      trade_hash: 'hern_CMCSA_2026-08-05_sell',
      status: 'pending',
      chamber: 'house' as const,
      provider_key: null,
      match_method: null,
      congress_first_seen_at: inWindow,
      provider_first_seen_at: null,
      provider_published_at: null,
      filed_date: '2026-08-05',
      filer_name: 'Kevin Hern',
      created_at: inWindow,
      updated_at: inWindow,
      ...over,
    });
    const observation = (over: Record<string, unknown>) => ({
      provider: 'quiver' as const,
      chamber: 'house' as const,
      provider_key: 'qq-1',
      trade_hash: 'hern_CMCSA_2026-08-05_sell',
      first_observed_at: inWindow,
      filer_name: 'Kevin Hern',
      ...over,
    });

    it('counts a line both sides saw exactly once, and only pairs it when the match is strong', () => {
      const scope = computeLatencyScope({
        candidates: [candidate({ status: 'matched', match_method: 'trade-hash' })] as never,
        observations: [observation({})] as never,
        coverageRows: [
          {
            provider: 'quiver',
            chamber: 'house',
            provider_key: 'qq-1',
            trade_hash: 'hern_CMCSA_2026-08-05_sell',
            match_method: 'trade-hash',
          },
        ],
        windowHours: 336,
      });
      expect(scope.total).toBe(1);
      expect(scope.matched).toBe(1);
      expect(scope.ctOnly).toBe(0);
      expect(scope.providerOnly).toBe(0);
      expect(scope.matchedPct).toBe(100);
    });

    it('separates what only we saw from what only the provider saw', () => {
      const scope = computeLatencyScope({
        candidates: [candidate({ trade_hash: 'hern_DEO_2026-08-05_sell' })] as never,
        observations: [observation({ trade_hash: 'delaney_BWXT_2026-07-24_buy', filer_name: 'John Delaney' })] as never,
        coverageRows: [],
        windowHours: 336,
      });
      expect(scope.total).toBe(2);
      expect(scope.matched).toBe(0);
      expect(scope.ctOnly).toBe(1);
      expect(scope.providerOnly).toBe(1);
    });

    it('a weak pairing counts toward matchedIncludingWeak but never the headline', () => {
      const scope = computeLatencyScope({
        candidates: [candidate({ status: 'matched', match_method: 'fuzzy-missing-date' })] as never,
        observations: [observation({})] as never,
        coverageRows: [
          {
            provider: 'quiver',
            chamber: 'house',
            provider_key: 'qq-1',
            trade_hash: 'hern_CMCSA_2026-08-05_sell',
            match_method: 'fuzzy-missing-date',
          },
        ],
        windowHours: 336,
      });
      expect(scope.total).toBe(1);
      expect(scope.matched).toBe(0);
      expect(scope.matchedIncludingWeak).toBe(1);
    });

    it('folds a provider row onto the candidate hash it paired with, never as a second line', () => {
      const scope = computeLatencyScope({
        candidates: [candidate({ status: 'matched', match_method: 'fuzzy-near-date' })] as never,
        // Provider hashed the same trade one day off; the pairing carries the
        // canonical CT hash, so this must not read as a separate disclosure.
        observations: [observation({ trade_hash: 'hern_CMCSA_2026-08-04_sell' })] as never,
        coverageRows: [
          {
            provider: 'quiver',
            chamber: 'house',
            provider_key: 'qq-1',
            trade_hash: 'hern_CMCSA_2026-08-05_sell',
            match_method: 'fuzzy-near-date',
          },
        ],
        windowHours: 336,
      });
      expect(scope.total).toBe(1);
      expect(scope.matched).toBe(1);
    });

    it('keeps POTUS/VP/cabinet in scope and drops executive rows we cannot identify', () => {
      expect(isInLatencyScope({ chamber: 'house', filer_name: null })).toBe(true);
      expect(isInLatencyScope({ chamber: 'senate', filer_name: null })).toBe(true);
      expect(isInLatencyScope({ chamber: 'executive', filer_name: 'Donald J. Trump' })).toBe(true);
      expect(isInLatencyScope({ chamber: 'executive', filer_name: 'Scott Bessent' })).toBe(true);
      // Not a filer we track, and a bare surname is never enough.
      expect(isInLatencyScope({ chamber: 'executive', filer_name: 'Pat Someone' })).toBe(false);
      expect(isInLatencyScope({ chamber: 'executive', filer_name: 'Trump' })).toBe(false);
      expect(isInLatencyScope({ chamber: 'executive', filer_name: null })).toBe(false);

      const scope = computeLatencyScope({
        candidates: [],
        observations: [
          observation({ chamber: 'executive', trade_hash: 'trump_AAPL_2026-08-05_buy', filer_name: 'Donald J. Trump' }),
          observation({
            chamber: 'executive',
            provider_key: 'qq-2',
            trade_hash: 'someone_AAPL_2026-08-05_buy',
            filer_name: 'Pat Someone',
          }),
        ] as never,
        coverageRows: [],
        windowHours: 336,
      });
      expect(scope.total).toBe(1);
      expect(scope.excludedOutOfScope).toBe(1);
    });

    it('excludes filer-less rows from M rather than letting them depress the ratio', () => {
      const scope = computeLatencyScope({
        candidates: [],
        observations: [observation({ trade_hash: '_PANW_2026-07-31_sell' })] as never,
        coverageRows: [],
        windowHours: 336,
      });
      expect(scope.total).toBe(0);
      expect(scope.excludedMissingFiler).toBe(1);
      expect(scope.matchedPct).toBeNull();
    });

    it('counts a corpus-hash pairing as both sides seeing the line, not provider-only', () => {
      const scope = computeLatencyScope({
        candidates: [],
        observations: [observation({})] as never,
        coverageRows: [
          {
            provider: 'quiver',
            chamber: 'house',
            provider_key: 'qq-1',
            trade_hash: 'hern_CMCSA_2026-08-05_sell',
            match_method: CORPUS_MATCH_METHOD,
          },
        ],
        windowHours: 336,
      });
      expect(scope.total).toBe(1);
      expect(scope.matched).toBe(1);
      expect(scope.ctOnly).toBe(0);
      expect(scope.providerOnly).toBe(0);
    });
  });

  describe('corpus coverage (#1523 backfill/lag undercount)', () => {
    const MATURITY = '2026-08-10T21:00:00.000Z';
    const observation = {
      provider: 'fmp' as const,
      chamber: 'house' as const,
      provider_key: '20035180',
      trade_hash: 'hern_AAPL_2026-07-15_buy',
      first_observed_at: '2026-08-07T04:30:10.001Z',
      last_observed_at: '2026-08-07T04:30:10.001Z',
      provider_published_at: null,
      source_url: null,
      filed_date: '2026-07-15',
      filer_name: 'Kevin Hern',
      payload: null,
    };

    it('hashes seed and competitor-backfill rows the same way as a live import', () => {
      const hashes = hashesFromCorpusTransactions([
        { full_name: 'Kevin Hern', ticker: 'AAPL', tx_date: '2026-07-15', tx_type: 'P' },
        { full_name: 'Kevin Hern', ticker: 'MSFT', tx_date: '2026-07-15', tx_type: 'S' },
      ]);
      expect(hashes.has('hern_AAPL_2026-07-15_buy')).toBe(true);
      expect(hashes.has('hern_MSFT_2026-07-15_sell')).toBe(true);
    });

    it('pairs a provider row to the full CT corpus by exact hash', () => {
      const rows = coverageRowsFromCorpusHashes(
        [observation],
        new Set(['hern_AAPL_2026-07-15_buy']),
      );
      expect(rows).toEqual([
        {
          provider: 'fmp',
          chamber: 'house',
          provider_key: '20035180',
          trade_hash: 'hern_AAPL_2026-07-15_buy',
          match_method: CORPUS_MATCH_METHOD,
        },
      ]);
    });

    it('prefers a live-race pairing when both exist', () => {
      const merged = mergeCoveragePreferringRace(
        [
          {
            provider: 'fmp',
            chamber: 'house',
            provider_key: '20035180',
            trade_hash: 'hern_AAPL_2026-07-15_buy',
            match_method: 'trade-hash',
          },
        ],
        coverageRowsFromCorpusHashes([observation], new Set(['hern_AAPL_2026-07-15_buy'])),
      );
      expect(merged).toHaveLength(1);
      expect(merged[0]!.match_method).toBe('trade-hash');
    });

    it('counts a backfilled CT copy as coverage, not as a timed race and not as unmatched', () => {
      const [fmp] = buildPublicLatencyProviders(
        [],
        [],
        [observation],
        [],
        MATURITY,
        [
          {
            provider: 'fmp',
            chamber: 'house',
            provider_key: '20035180',
            trade_hash: 'hern_AAPL_2026-07-15_buy',
            match_method: CORPUS_MATCH_METHOD,
          },
        ],
      );
      expect(fmp.provider).toBe('fmp');
      // Coverage: we have the trade.
      expect(fmp.maturedProviderObserved).toBe(1);
      expect(fmp.maturedMatched).toBe(1);
      expect(fmp.unmatchedProvider).toBe(0);
      expect(fmp.unmatchedProviderCtMissing).toBe(0);
      expect(fmp.unmatchedProviderCtExcluded).toBe(1);
      expect(fmp.ctCoveragePct).toBe(100);
      // Timing: no live-race candidate, so no Ahead/Behind sample.
      expect(fmp.matched).toBe(0);
      expect(fmp.comparisonStatus).toBe('insufficient');
    });

    it('still reports a genuine miss when the corpus does not contain the trade', () => {
      const [fmp] = buildPublicLatencyProviders([], [], [observation], [], MATURITY, []);
      expect(fmp.maturedMatched).toBe(0);
      expect(fmp.unmatchedProvider).toBe(1);
      expect(fmp.unmatchedProviderCtMissing).toBe(1);
      expect(fmp.unmatchedProviderCtExcluded).toBe(0);
      expect(fmp.ctCoveragePct).toBe(0);
    });

    it('refuses a usable Ahead/Behind claim when the parser stored empty-filer hashes', () => {
      const broken = Array.from({ length: 12 }, (_, i) => ({
        ...observation,
        provider_key: `k-${i}`,
        // Unique hashes so FMP-family merge does not collapse the cohort.
        trade_hash: `_AAPL_2026-06-${String(i + 1).padStart(2, '0')}_buy`,
      }));
      const [fmp] = buildPublicLatencyProviders([], [], broken, [], MATURITY, []);
      expect(fmp.observedRowsMissingFiler).toBe(12);
      expect(fmp.parserHealth).toBe('unhealthy');
      expect(fmp.comparisonStatus).not.toBe('usable');
      expect(fmp.comparisonStatus).not.toBe('preliminary');
    });
  });
});
