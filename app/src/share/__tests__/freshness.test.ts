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
  FRESHNESS_NEVER_LABEL,
  type FreshnessSnapshot,
} from '../freshness.ts';

// Fixed "now": 2026-06-25T00:00:00Z.
const NOW = Date.parse('2026-06-25T00:00:00Z');
const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(NOW - n * DAY_MS).toISOString().slice(0, 10);
const daysAgoIso = (n: number) => new Date(NOW - n * DAY_MS).toISOString();

const freshSnapshot: FreshnessSnapshot = {
  spxLatestDate: daysAgo(1),
  priceLatestDate: daysAgo(2),
  fundamentalsLatest: daysAgo(1),
  insiderLatestDate: daysAgo(2),
  shortVolumeLatestDate: daysAgo(1),
  analystLatest: daysAgo(1),
  refEnrichmentLatest: daysAgo(1),
};

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
  it('flags nothing when every stream is within threshold', () => {
    expect(evaluateFreshness(freshSnapshot, NOW)).toEqual([]);
  });

  it('flags never-populated (null) streams as stale', () => {
    const snap: FreshnessSnapshot = {
      spxLatestDate: null,
      priceLatestDate: null,
      fundamentalsLatest: null,
      insiderLatestDate: null,
      shortVolumeLatestDate: null,
      analystLatest: null,
      refEnrichmentLatest: null,
    };
    const stale = evaluateFreshness(snap, NOW);
    expect(stale).toHaveLength(7);
    expect(stale.every((s) => s.latest === FRESHNESS_NEVER_LABEL)).toBe(true);
  });

  it('flags a stream past its threshold, with stream/age', () => {
    const snap: FreshnessSnapshot = { ...freshSnapshot, spxLatestDate: daysAgo(6) };
    const stale = evaluateFreshness(snap, NOW);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ stream: 'spx', ageDays: 6 });
  });

  it('is inclusive at the threshold (== max is still fresh)', () => {
    const snap: FreshnessSnapshot = {
      spxLatestDate: daysAgo(FRESHNESS_MAX_AGE_DAYS.spx),
      priceLatestDate: daysAgo(FRESHNESS_MAX_AGE_DAYS.prices),
      fundamentalsLatest: daysAgo(FRESHNESS_MAX_AGE_DAYS.fundamentals),
      insiderLatestDate: daysAgo(FRESHNESS_MAX_AGE_DAYS.insider),
      shortVolumeLatestDate: daysAgo(FRESHNESS_MAX_AGE_DAYS.shortVolume),
      analystLatest: daysAgoIso(FRESHNESS_MAX_AGE_DAYS.analyst),
      refEnrichmentLatest: daysAgoIso(FRESHNESS_MAX_AGE_DAYS.refEnrichment),
    };
    expect(evaluateFreshness(snap, NOW)).toEqual([]);
  });

  it('flags multiple stale streams at once but leaves a populated-fresh one alone', () => {
    const snap: FreshnessSnapshot = {
      ...freshSnapshot,
      spxLatestDate: daysAgo(10),
      priceLatestDate: daysAgo(2),
      fundamentalsLatest: daysAgo(12),
    };
    const streams = evaluateFreshness(snap, NOW).map((s) => s.stream);
    expect(streams).toEqual(['spx', 'fundamentals']);
  });

  it('fundamentals gets extra slack vs spx/prices', () => {
    // 6 days: stale for spx/prices (max 5) but fresh for fundamentals (max 8).
    const snap: FreshnessSnapshot = {
      ...freshSnapshot,
      spxLatestDate: daysAgo(6),
      priceLatestDate: daysAgo(6),
      fundamentalsLatest: daysAgo(6),
    };
    const streams = evaluateFreshness(snap, NOW).map((s) => s.stream);
    expect(streams).toEqual(['spx', 'prices']);
  });

  it('flags insider and shortVolume past the daily EOD threshold', () => {
    const snap: FreshnessSnapshot = {
      ...freshSnapshot,
      insiderLatestDate: daysAgo(6),
      shortVolumeLatestDate: daysAgo(6),
    };
    const streams = evaluateFreshness(snap, NOW).map((s) => s.stream);
    expect(streams).toEqual(['insider', 'shortVolume']);
  });

  it('flags analyst and refEnrichment only past the nightly slack threshold', () => {
    const snap: FreshnessSnapshot = {
      ...freshSnapshot,
      analystLatest: daysAgoIso(6),
      refEnrichmentLatest: daysAgoIso(6),
    };
    expect(evaluateFreshness(snap, NOW)).toEqual([]);
    const staleSnap: FreshnessSnapshot = {
      ...snap,
      analystLatest: daysAgoIso(9),
      refEnrichmentLatest: daysAgoIso(9),
    };
    const streams = evaluateFreshness(staleSnap, NOW).map((s) => s.stream);
    expect(streams).toEqual(['analyst', 'refEnrichment']);
  });
});
