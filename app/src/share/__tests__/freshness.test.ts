/**
 * src/share/__tests__/freshness.test.ts
 *
 * Unit tests for the cross-app freshness watchdog decision logic. Pure +
 * deterministic (fixed clock), no DB.
 */

import { describe, it, expect } from 'vitest';
import {
  ageInDays,
  evaluateFreshness,
  FRESHNESS_MAX_AGE_DAYS,
  runFreshnessCheck,
  type FreshnessSnapshot,
} from '../freshness.ts';

// Fixed "now": 2026-06-25T00:00:00Z.
const NOW = Date.parse('2026-06-25T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString().slice(0, 10);

describe('ageInDays', () => {
  it('counts whole days for a bare date and an ISO timestamp', () => {
    expect(ageInDays('2026-06-20', NOW)).toBe(5);
    expect(ageInDays('2026-06-23T12:00:00Z', NOW)).toBe(1);
  });
  it('returns null for null / unparseable input', () => {
    expect(ageInDays(null, NOW)).toBeNull();
    expect(ageInDays('not-a-date', NOW)).toBeNull();
  });
});

describe('evaluateFreshness', () => {
  const fresh: FreshnessSnapshot = {
    spxLatestDate: daysAgo(1),
    priceLatestDate: daysAgo(2),
    fundamentalsLatest: daysAgo(1),
  };

  it('flags nothing when every stream is within threshold', () => {
    expect(evaluateFreshness(fresh, NOW)).toEqual([]);
  });

  it('skips never-populated (null) streams — no false alarm before wiring', () => {
    const snap: FreshnessSnapshot = {
      spxLatestDate: null,
      priceLatestDate: null,
      fundamentalsLatest: null,
    };
    expect(evaluateFreshness(snap, NOW)).toEqual([]);
  });

  it('flags a stream past its threshold, with stream/age', () => {
    const snap: FreshnessSnapshot = { ...fresh, spxLatestDate: daysAgo(6) };
    const stale = evaluateFreshness(snap, NOW);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ stream: 'spx', ageDays: 6 });
  });

  it('is inclusive at the threshold (== max is still fresh)', () => {
    const snap: FreshnessSnapshot = {
      spxLatestDate: daysAgo(FRESHNESS_MAX_AGE_DAYS.spx), // exactly 5d -> fresh
      priceLatestDate: daysAgo(FRESHNESS_MAX_AGE_DAYS.prices),
      fundamentalsLatest: daysAgo(FRESHNESS_MAX_AGE_DAYS.fundamentals),
    };
    expect(evaluateFreshness(snap, NOW)).toEqual([]);
  });

  it('flags multiple stale streams at once but leaves a populated-fresh one alone', () => {
    const snap: FreshnessSnapshot = {
      spxLatestDate: daysAgo(10),
      priceLatestDate: daysAgo(2), // fresh
      fundamentalsLatest: daysAgo(12),
    };
    const streams = evaluateFreshness(snap, NOW).map((s) => s.stream);
    expect(streams).toEqual(['spx', 'fundamentals']);
  });

  it('fundamentals gets extra slack vs spx/prices', () => {
    // 6 days: stale for spx/prices (max 5) but fresh for fundamentals (max 8).
    const snap: FreshnessSnapshot = {
      spxLatestDate: daysAgo(6),
      priceLatestDate: daysAgo(6),
      fundamentalsLatest: daysAgo(6),
    };
    const streams = evaluateFreshness(snap, NOW).map((s) => s.stream);
    expect(streams).toEqual(['spx', 'prices']);
  });
});

describe('runFreshnessCheck', () => {
  it('reads fundamentals freshness from received_at, not provider updated_at', async () => {
    let sql = '';
    const db = {
      prepare(q: string) {
        sql = q;
        return {
          bind() {
            return this;
          },
          async first() {
            return {
              spx_latest: '2026-06-24',
              price_latest: '2026-06-24',
              fundamentals_latest: '2026-06-24T00:00:00.000Z',
            };
          },
        };
      },
    };
    const stale = await runFreshnessCheck({ DB: db } as never, new Date('2026-06-25T00:00:00Z'));
    expect(stale).toEqual([]);
    expect(sql).toContain('MAX(received_at)');
    expect(sql).not.toContain('updated_at');
  });
});
