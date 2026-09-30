import { describe, expect, it } from 'vitest';
import {
  evaluatePipelineSignals,
  tradingDaysBehind,
  type PipelineSignals,
  DEFAULT_PIPELINE_THRESHOLDS,
} from '../pipelineHealth.ts';

describe('evaluatePipelineSignals', () => {
  const nowMs = 1754092800000; // Fixed clock for testing

  const cleanSignals: PipelineSignals = {
    outboxPending: 0,
    outboxOldestAt: null,
    outboxFailed: 0,
    reviewBacklog: 0,
    reviewEligible: 0,
    reviewSuppressed: 0,
    reviewTerminal: 0,
    extractionAttempts24h: 10,
    extractionOk24h: 10,
    lastExtractionSuccessAt: new Date(nowMs - 3600 * 1000).toISOString(),
    localWorkerActivity24h: 0,
    autopilotHaltReason: null,
    latestTxCreatedAt: new Date(nowMs - 3600 * 1000).toISOString(),
    dishonestResolutionCount: 0,
    orphanedNeedsReviewCount: 0,
    strandedFilings: 0,
    pollSources: [
      { source: 'house', lastSuccessAt: new Date(nowMs - 30 * 60_000).toISOString(), lastAttemptAt: new Date(nowMs - 30 * 60_000).toISOString(), configDisabled: false },
      { source: 'senate', lastSuccessAt: new Date(nowMs - 45 * 60_000).toISOString(), lastAttemptAt: new Date(nowMs - 45 * 60_000).toISOString(), configDisabled: false },
      // Weekday cap is 45 minutes.  A 5 hour executive success used to sit inside the old 26 hour ceiling and would now mark the whole fixture stalled.
      { source: 'executive', lastSuccessAt: new Date(nowMs - 20 * 60_000).toISOString(), lastAttemptAt: new Date(nowMs - 20 * 60_000).toISOString(), configDisabled: false },
    ],
    latencyProviders: [
      { provider: 'quiver', lastObservedAt: new Date(nowMs - 2 * 3_600_000).toISOString() },
      { provider: 'unusual_whales', lastObservedAt: new Date(nowMs - 3 * 3_600_000).toISOString() },
    ],
    senateRelay: {
      configured: true,
      probe: { ok: true, status: 200, checkedAt: new Date(nowMs - 60_000).toISOString(), host: 'scout.jays.services' },
    },
    // 2026-09-21: defaults for the new signals; matches a healthy pipeline.
    filingSkips24h: 0,
    filingSkipsByAction24h: { extract_empty_failure: 0, auto_resolved_empty: 0, doc_quarantined: 0 },
    fmpLatency: {
      observationCount24h: 120,
      lastObservationAt: new Date(nowMs - 600 * 1000).toISOString(),
      lastObservationAgeSec: 600,
      http429s24h: 0,
      byProvider: { fmp: { lastObservationAt: new Date(nowMs - 600 * 1000).toISOString(), ageSec: 600, count24h: 120 } },
    },
  };

  it('returns ok status for clean pipeline signals', () => {
    const res = evaluatePipelineSignals(cleanSignals, nowMs);
    expect(res.status).toBe('ok');
    expect(res.checks.every((c) => c.status === 'ok')).toBe(true);
  });

  it('returns unknown status when signals are null', () => {
    const nullSignals: PipelineSignals = {
      outboxPending: null,
      outboxOldestAt: null,
      outboxFailed: null,
      reviewBacklog: null,
      reviewEligible: null,
      reviewSuppressed: null,
      reviewTerminal: null,
      extractionAttempts24h: null,
      extractionOk24h: null,
      lastExtractionSuccessAt: null,
      localWorkerActivity24h: 0,
      autopilotHaltReason: null,
      latestTxCreatedAt: null,
      dishonestResolutionCount: null,
      orphanedNeedsReviewCount: null,
      strandedFilings: null,
      pollSources: null,
      latencyProviders: null,
      senateRelay: null,
    };
    const res = evaluatePipelineSignals(nullSignals, nowMs);
    expect(res.status).toBe('unknown');
    expect(res.checks.every((c) => c.status === 'unknown' || c.status === 'ok')).toBe(true);
  });

  it('degrades only on fresh dead-letter items, not a saturated triaged DLQ (#2182)', () => {
    const triaged: PipelineSignals = {
      ...cleanSignals,
      outboxFailed: 81,
      outboxFailedFresh: 0,
    };
    const res = evaluatePipelineSignals(triaged, nowMs);
    const check = res.checks.find((c) => c.id === 'ingestion_dead_letter');
    expect(check?.status).toBe('ok');
    expect(check?.value).toBe(0);
    expect(check?.detail).toContain('81 triaged');
    expect(check?.detail).toContain('0 fresh');
    expect(res.status).toBe('ok');
  });

  it('still degrades when a fresh outbox failure arrives beside triaged rows', () => {
    const mixed: PipelineSignals = {
      ...cleanSignals,
      outboxFailed: 82,
      outboxFailedFresh: 1,
    };
    const res = evaluatePipelineSignals(mixed, nowMs);
    const check = res.checks.find((c) => c.id === 'ingestion_dead_letter');
    expect(check?.status).toBe('degraded');
    expect(check?.value).toBe(1);
    expect(check?.detail).toContain('1 fresh');
    expect(check?.detail).toContain('81 triaged');
    expect(res.status).toBe('degraded');
  });

  it('flags stalled when 0/N extractions succeed in 24h (403/budget stall case)', () => {
    const stalledSignals: PipelineSignals = {
      ...cleanSignals,
      extractionAttempts24h: 40,
      extractionOk24h: 0,
    };
    const res = evaluatePipelineSignals(stalledSignals, nowMs);
    expect(res.status).toBe('stalled');
    const providerCheck = res.checks.find((c) => c.id === 'extraction_provider');
    expect(providerCheck?.status).toBe('stalled');
  });

  it('flags stalled when autopilot is halted', () => {
    const haltedSignals: PipelineSignals = {
      ...cleanSignals,
      autopilotHaltReason: 'error_class:billing',
    };
    const res = evaluatePipelineSignals(haltedSignals, nowMs);
    expect(res.status).toBe('stalled');
    const haltCheck = res.checks.find((c) => c.id === 'autopilot_halt');
    expect(haltCheck?.status).toBe('stalled');
    expect(haltCheck?.detail).toContain('error_class:billing');
  });

  it('flags stalled when review backlog is elevated with zero 24h extraction attempts', () => {
    const backlogStallSignals: PipelineSignals = {
      ...cleanSignals,
      reviewBacklog: 200,
      reviewEligible: 9,
      reviewSuppressed: 0,
      reviewTerminal: 191,
      extractionAttempts24h: 0,
      extractionOk24h: 0,
    };
    const res = evaluatePipelineSignals(backlogStallSignals, nowMs);
    expect(res.status).toBe('stalled');
    const backlogCheck = res.checks.find((c) => c.id === 'extraction_backlog');
    expect(backlogCheck?.status).toBe('stalled');
    expect(backlogCheck?.detail).toContain('eligible 9');
    expect(backlogCheck?.detail).toContain('terminal 191');
    const providerCheck = res.checks.find((c) => c.id === 'extraction_provider');
    expect(providerCheck?.status).toBe('stalled');
  });

  it('marks any unresolved review item unhealthy, split by bucket', () => {
    const oneItem: PipelineSignals = {
      ...cleanSignals,
      reviewBacklog: 1,
      reviewEligible: 0,
      reviewSuppressed: 0,
      reviewTerminal: 1,
    };
    const res = evaluatePipelineSignals(oneItem, nowMs);
    const backlogCheck = res.checks.find((c) => c.id === 'extraction_backlog');
    expect(backlogCheck?.status).toBe('degraded');
    expect(backlogCheck?.detail).toContain('1 unresolved');
    expect(backlogCheck?.detail).toContain('terminal 1');
    expect(res.status).toBe('degraded');
  });

  it('does not mark extraction_provider ok when attempts=0 and autopilot is halted', () => {
    const haltedIdle: PipelineSignals = {
      ...cleanSignals,
      reviewBacklog: 0,
      reviewEligible: 0,
      reviewSuppressed: 0,
      reviewTerminal: 0,
      extractionAttempts24h: 0,
      extractionOk24h: 0,
      autopilotHaltReason: 'error_class:billing (OpenRouter files-endpoint prepaid minimum, not account quota)',
    };
    const res = evaluatePipelineSignals(haltedIdle, nowMs);
    const providerCheck = res.checks.find((c) => c.id === 'extraction_provider');
    expect(providerCheck?.status).toBe('stalled');
    expect(providerCheck?.detail).toContain('halted');
  });

  it('does not mark extraction_provider ok when attempts=0 and review backlog is nonzero', () => {
    const idleBacklog: PipelineSignals = {
      ...cleanSignals,
      reviewBacklog: 5,
      reviewEligible: 5,
      reviewSuppressed: 0,
      reviewTerminal: 0,
      extractionAttempts24h: 0,
      extractionOk24h: 0,
    };
    const res = evaluatePipelineSignals(idleBacklog, nowMs);
    const providerCheck = res.checks.find((c) => c.id === 'extraction_provider');
    expect(providerCheck?.status).not.toBe('ok');
    expect(providerCheck?.status).toBe('stalled');
  });

  it('marks extraction_provider degraded when local workers are active with backlog and no provider runs', () => {
    const localBusy: PipelineSignals = {
      ...cleanSignals,
      reviewBacklog: 3,
      reviewEligible: 3,
      reviewSuppressed: 0,
      reviewTerminal: 0,
      extractionAttempts24h: 0,
      extractionOk24h: 0,
      localWorkerActivity24h: 4,
    };
    const res = evaluatePipelineSignals(localBusy, nowMs);
    const providerCheck = res.checks.find((c) => c.id === 'extraction_provider');
    expect(providerCheck?.status).toBe('degraded');
    expect(providerCheck?.detail).toContain('local vision worker active');
    expect(providerCheck?.detail).toContain('backlog is 3');
  });

  it('marks extraction_provider ok when local workers are active and review backlog is clear', () => {
    const localClear: PipelineSignals = {
      ...cleanSignals,
      reviewBacklog: 0,
      reviewEligible: 0,
      reviewSuppressed: 0,
      reviewTerminal: 0,
      extractionAttempts24h: 0,
      extractionOk24h: 0,
      localWorkerActivity24h: 2,
    };
    const res = evaluatePipelineSignals(localClear, nowMs);
    const providerCheck = res.checks.find((c) => c.id === 'extraction_provider');
    expect(providerCheck?.status).toBe('ok');
    expect(providerCheck?.detail).toContain('review backlog clear');
  });

  it('flags stalled when outbox pending items exceed max age threshold', () => {
    const oldestMs = nowMs - (120 * 60 * 1000); // 120m old, > 90m limit
    const outboxStallSignals: PipelineSignals = {
      ...cleanSignals,
      outboxPending: 5,
      outboxOldestAt: new Date(oldestMs).toISOString(),
    };
    const res = evaluatePipelineSignals(outboxStallSignals, nowMs);
    expect(res.status).toBe('stalled');
    const outboxCheck = res.checks.find((c) => c.id === 'ingestion_backlog');
    expect(outboxCheck?.status).toBe('stalled');
  });

  it('flags degraded when filings are stranded past the autonomy sweep window', () => {
    const strandedSignals: PipelineSignals = {
      ...cleanSignals,
      strandedFilings: 3,
    };
    const res = evaluatePipelineSignals(strandedSignals, nowMs);
    expect(res.status).toBe('degraded');
    const strandedCheck = res.checks.find((c) => c.id === 'stranded_filings');
    expect(strandedCheck?.status).toBe('degraded');
    expect(strandedCheck?.value).toBe(3);
  });

  it('flags degraded (never stalled) when transaction data is stale (recess guard)', () => {
    const staleTxMs = nowMs - (120 * 3600 * 1000); // 120h old, > 96h limit
    const staleTxSignals: PipelineSignals = {
      ...cleanSignals,
      latestTxCreatedAt: new Date(staleTxMs).toISOString(),
    };
    const res = evaluatePipelineSignals(staleTxSignals, nowMs);
    expect(res.status).toBe('degraded');
    const txCheck = res.checks.find((c) => c.id === 'data_freshness');
    expect(txCheck?.status).toBe('degraded');
  });

  // --- review_resolution_integrity (2026-08-09 production bug) -------------
  // review_queue reported resolved=1 for 3,497/3,497 rows (hence the review
  // UI saying "all done" daily) while 738 of those had zero live
  // transactions and 180 needs_review filings had no open queue row. This
  // check is the seeded-738-style regression guard the incident asked for.
  describe('review_resolution_integrity', () => {
    it('flags degraded when resolved rows carry no recorded resolution reason (the 738 case)', () => {
      const dishonestSignals: PipelineSignals = {
        ...cleanSignals,
        dishonestResolutionCount: 738,
      };
      const res = evaluatePipelineSignals(dishonestSignals, nowMs);
      expect(res.status).toBe('degraded');
      const check = res.checks.find((c) => c.id === 'review_resolution_integrity');
      expect(check?.status).toBe('degraded');
      expect(check?.detail).toContain('738');
      expect(check?.value).toBe(738);
    });

    it('flags degraded when needs_review filings have no open queue row (the 180 case)', () => {
      const orphanedSignals: PipelineSignals = {
        ...cleanSignals,
        orphanedNeedsReviewCount: 180,
      };
      const res = evaluatePipelineSignals(orphanedSignals, nowMs);
      expect(res.status).toBe('degraded');
      const check = res.checks.find((c) => c.id === 'review_resolution_integrity');
      expect(check?.status).toBe('degraded');
      expect(check?.detail).toContain('180');
    });

    it('stays ok when every resolved row has a recorded reason and every needs_review filing has an open queue row', () => {
      const res = evaluatePipelineSignals(cleanSignals, nowMs);
      const check = res.checks.find((c) => c.id === 'review_resolution_integrity');
      expect(check?.status).toBe('ok');
      expect(check?.value).toBe(0);
    });

    it('reports unknown (not ok) when integrity counts could not be collected', () => {
      const uncollectedSignals: PipelineSignals = {
        ...cleanSignals,
        dishonestResolutionCount: null,
        orphanedNeedsReviewCount: null,
      };
      const res = evaluatePipelineSignals(uncollectedSignals, nowMs);
      const check = res.checks.find((c) => c.id === 'review_resolution_integrity');
      expect(check?.status).toBe('unknown');
    });
  });
});

describe('polling + latency liveness (owner 2026-08-10: never silently off)', () => {
  const nowMs = 1754092800000;
  const base: PipelineSignals = {
    outboxPending: 0,
    outboxOldestAt: null,
    outboxFailed: 0,
    reviewBacklog: 0,
    reviewEligible: 0,
    reviewSuppressed: 0,
    reviewTerminal: 0,
    extractionAttempts24h: 10,
    extractionOk24h: 10,
    lastExtractionSuccessAt: new Date(nowMs - 3600 * 1000).toISOString(),
    localWorkerActivity24h: 0,
    autopilotHaltReason: null,
    latestTxCreatedAt: new Date(nowMs - 3600 * 1000).toISOString(),
    dishonestResolutionCount: 0,
    orphanedNeedsReviewCount: 0,
    strandedFilings: 0,
    pollSources: [
      { source: 'house', lastSuccessAt: new Date(nowMs - 30 * 60_000).toISOString(), lastAttemptAt: new Date(nowMs - 30 * 60_000).toISOString(), configDisabled: false },
      { source: 'senate', lastSuccessAt: new Date(nowMs - 45 * 60_000).toISOString(), lastAttemptAt: new Date(nowMs - 45 * 60_000).toISOString(), configDisabled: false },
      // Weekday cap is 45 minutes.  A 5 hour executive success used to sit inside the old 26 hour ceiling and would now mark the whole fixture stalled.
      { source: 'executive', lastSuccessAt: new Date(nowMs - 20 * 60_000).toISOString(), lastAttemptAt: new Date(nowMs - 20 * 60_000).toISOString(), configDisabled: false },
    ],
    latencyProviders: [
      { provider: 'quiver', lastObservedAt: new Date(nowMs - 2 * 3_600_000).toISOString() },
    ],
    senateRelay: {
      configured: true,
      probe: { ok: true, status: 200, checkedAt: new Date(nowMs - 60_000).toISOString(), host: 'scout.jays.services' },
    },
  };

  it('config-disabled executive polling is stalled and says so (the OGE_WATCH_ENABLED incident)', () => {
    const s: PipelineSignals = {
      ...base,
      pollSources: base.pollSources!.map((p) =>
        p.source === 'executive' ? { ...p, configDisabled: true } : p),
    };
    const res = evaluatePipelineSignals(s, nowMs);
    const check = res.checks.find((c) => c.id === 'polling_executive')!;
    expect(check.status).toBe('stalled');
    expect(check.detail).toContain('DISABLED by config');
    expect(res.status).toBe('stalled');
  });

  it('fresh attempts + stale successes reads as FAILING (the senate-403 class)', () => {
    const s: PipelineSignals = {
      ...base,
      pollSources: base.pollSources!.map((p) =>
        p.source === 'senate'
          ? { ...p, lastSuccessAt: new Date(nowMs - 30 * 3_600_000).toISOString(), lastAttemptAt: new Date(nowMs - 10 * 60_000).toISOString() }
          : p),
    };
    const res = evaluatePipelineSignals(s, nowMs);
    const check = res.checks.find((c) => c.id === 'polling_senate')!;
    expect(check.status).toBe('stalled');
    expect(check.detail).toContain('FAILING');
  });

  it('no attempts at all reads as NOT RUNNING (cron dead / never wired)', () => {
    const s: PipelineSignals = {
      ...base,
      pollSources: base.pollSources!.map((p) =>
        p.source === 'house' ? { ...p, lastSuccessAt: null, lastAttemptAt: null } : p),
    };
    const res = evaluatePipelineSignals(s, nowMs);
    const check = res.checks.find((c) => c.id === 'polling_house')!;
    expect(check.status).toBe('stalled');
    expect(check.detail).toContain('NOT RUNNING');
  });

  it('a chamber missing from the liveness collection entirely is stalled, never silent', () => {
    const s: PipelineSignals = {
      ...base,
      pollSources: base.pollSources!.filter((p) => p.source !== 'executive'),
    };
    const res = evaluatePipelineSignals(s, nowMs);
    const check = res.checks.find((c) => c.id === 'polling_executive')!;
    expect(check.status).toBe('stalled');
  });

  it('weekend hourly cadence stays ok at 70 minutes and stalls at 2 hours', () => {
    // Saturday 2025-08-02 12:00 ET (EDT).  The fixture clock above is a Friday.
    const saturdayMs = Date.parse('2025-08-02T16:00:00Z');
    const withinHourly: PipelineSignals = {
      ...base,
      pollSources: base.pollSources!.map((p) =>
        p.source === 'executive'
          ? { ...p, lastSuccessAt: new Date(saturdayMs - 70 * 60_000).toISOString(), lastAttemptAt: new Date(saturdayMs - 70 * 60_000).toISOString() }
          : { ...p, lastSuccessAt: new Date(saturdayMs - 50 * 60_000).toISOString(), lastAttemptAt: new Date(saturdayMs - 50 * 60_000).toISOString() }),
    };
    expect(evaluatePipelineSignals(withinHourly, saturdayMs).checks.find((c) => c.id === 'polling_executive')!.status).toBe('ok');

    const missedHourly: PipelineSignals = {
      ...base,
      pollSources: base.pollSources!.map((p) =>
        p.source === 'executive'
          ? { ...p, lastSuccessAt: new Date(saturdayMs - 2 * 3_600_000).toISOString(), lastAttemptAt: new Date(saturdayMs - 2 * 3_600_000).toISOString() }
          : { ...p, lastSuccessAt: new Date(saturdayMs - 50 * 60_000).toISOString(), lastAttemptAt: new Date(saturdayMs - 50 * 60_000).toISOString() }),
    };
    expect(evaluatePipelineSignals(missedHourly, saturdayMs).checks.find((c) => c.id === 'polling_executive')!.status).toBe('stalled');
  });

  it('executive success inside the weekday 45 minute window stays ok, and 20h does not', () => {
    const fresh: PipelineSignals = {
      ...base,
      pollSources: base.pollSources!.map((p) =>
        p.source === 'executive'
          ? { ...p, lastSuccessAt: new Date(nowMs - 20 * 60_000).toISOString(), lastAttemptAt: new Date(nowMs - 20 * 60_000).toISOString() }
          : p),
    };
    expect(evaluatePipelineSignals(fresh, nowMs).checks.find((c) => c.id === 'polling_executive')!.status).toBe('ok');

    const stale: PipelineSignals = {
      ...base,
      pollSources: base.pollSources!.map((p) =>
        p.source === 'executive'
          ? { ...p, lastSuccessAt: new Date(nowMs - 20 * 3_600_000).toISOString(), lastAttemptAt: new Date(nowMs - 20 * 3_600_000).toISOString() }
          : p),
    };
    const res = evaluatePipelineSignals(stale, nowMs);
    expect(res.checks.find((c) => c.id === 'polling_executive')!.status).toBe('stalled');
  });

  it('zero latency observations ever is stalled (monitoring never wired = loudest case)', () => {
    const res = evaluatePipelineSignals({ ...base, latencyProviders: [] }, nowMs);
    const check = res.checks.find((c) => c.id === 'latency_probes')!;
    expect(check.status).toBe('stalled');
    expect(check.detail).toContain('NOT RUNNING');
  });

  it('system-wide latency silence past 24h is stalled', () => {
    const res = evaluatePipelineSignals({
      ...base,
      latencyProviders: [{ provider: 'quiver', lastObservedAt: new Date(nowMs - 30 * 3_600_000).toISOString() }],
    }, nowMs);
    expect(res.checks.find((c) => c.id === 'latency_probes')!.status).toBe('stalled');
  });

  it('one recently-active provider going quiet is degraded and names the provider', () => {
    const res = evaluatePipelineSignals({
      ...base,
      latencyProviders: [
        { provider: 'quiver', lastObservedAt: new Date(nowMs - 2 * 3_600_000).toISOString() },
        { provider: 'unusual_whales', lastObservedAt: new Date(nowMs - 60 * 3_600_000).toISOString() },
      ],
    }, nowMs);
    const check = res.checks.find((c) => c.id === 'latency_probes')!;
    expect(check.status).toBe('degraded');
    expect(check.detail).toContain('unusual_whales');
  });

  it('a provider quiet for over a week is still degraded (never silently off)', () => {
    const res = evaluatePipelineSignals({
      ...base,
      latencyProviders: [
        { provider: 'quiver', lastObservedAt: new Date(nowMs - 2 * 3_600_000).toISOString() },
        { provider: 'unusual_whales', lastObservedAt: new Date(nowMs - 10 * 24 * 3_600_000).toISOString() },
      ],
    }, nowMs);
    const check = res.checks.find((c) => c.id === 'latency_probes')!;
    expect(check.status).toBe('degraded');
    expect(check.detail).toContain('unusual_whales');
  });

  it('a retired provider (expected=false) quiet for weeks does not page; detail still names it', () => {
    const res = evaluatePipelineSignals({
      ...base,
      latencyProviders: [
        { provider: 'fmp', lastObservedAt: new Date(nowMs - 1 * 3_600_000).toISOString(), expected: true },
        { provider: 'quiver', lastObservedAt: new Date(nowMs - 457 * 3_600_000).toISOString(), expected: false },
        { provider: 'unusual_whales', lastObservedAt: new Date(nowMs - 421 * 3_600_000).toISOString(), expected: false },
      ],
    }, nowMs);
    const check = res.checks.find((c) => c.id === 'latency_probes')!;
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('retired in config');
    expect(check.detail).toContain('quiver');
    expect(check.value).toBe(1);
  });

  it('an expected provider going quiet still pages even alongside retired ones', () => {
    const res = evaluatePipelineSignals({
      ...base,
      latencyProviders: [
        { provider: 'fmp', lastObservedAt: new Date(nowMs - 60 * 3_600_000).toISOString(), expected: true },
        { provider: 'quiver', lastObservedAt: new Date(nowMs - 457 * 3_600_000).toISOString(), expected: false },
      ],
    }, nowMs);
    const check = res.checks.find((c) => c.id === 'latency_probes')!;
    // fmp alone is expected and 60h quiet — that is whole-system silence.
    expect(check.status).toBe('stalled');
  });

  it('an expected provider with no observation ever is degraded as never observed', () => {
    const res = evaluatePipelineSignals({
      ...base,
      latencyProviders: [
        { provider: 'fmp', lastObservedAt: new Date(nowMs - 1 * 3_600_000).toISOString(), expected: true },
        { provider: 'unusual_whales', lastObservedAt: null, expected: true },
      ],
    }, nowMs);
    const check = res.checks.find((c) => c.id === 'latency_probes')!;
    expect(check.status).toBe('degraded');
    expect(check.detail).toContain('unusual_whales (never observed)');
  });

  it('every provider retired in config is stalled (latency monitoring off entirely stays loud)', () => {
    const res = evaluatePipelineSignals({
      ...base,
      latencyProviders: [
        { provider: 'quiver', lastObservedAt: new Date(nowMs - 457 * 3_600_000).toISOString(), expected: false },
      ],
    }, nowMs);
    const check = res.checks.find((c) => c.id === 'latency_probes')!;
    expect(check.status).toBe('stalled');
    expect(check.detail).toContain('no provider is enabled in config');
  });

  it('rows without the expected flag keep the old always-page behavior', () => {
    const res = evaluatePipelineSignals({
      ...base,
      latencyProviders: [
        { provider: 'fmp', lastObservedAt: new Date(nowMs - 1 * 3_600_000).toISOString() },
        { provider: 'quiver', lastObservedAt: new Date(nowMs - 457 * 3_600_000).toISOString() },
      ],
    }, nowMs);
    expect(res.checks.find((c) => c.id === 'latency_probes')!.status).toBe('degraded');
  });

  it('a dead Senate relay probe is stalled even when polling_senate is ok', () => {
    const res = evaluatePipelineSignals({
      ...base,
      senateRelay: {
        configured: true,
        probe: { ok: false, status: 502, checkedAt: new Date(nowMs - 30_000).toISOString(), host: 'scout.jays.services' },
      },
    }, nowMs);
    const check = res.checks.find((c) => c.id === 'senate_relay')!;
    expect(check.status).toBe('stalled');
    expect(check.detail).toContain('DOWN');
    expect(check.detail).toContain('scout.jays.services');
    expect(res.checks.find((c) => c.id === 'polling_senate')!.status).toBe('ok');
  });

  it('an unset Senate relay URL is degraded, not silent', () => {
    const res = evaluatePipelineSignals({
      ...base,
      senateRelay: { configured: false, probe: null },
    }, nowMs);
    const check = res.checks.find((c) => c.id === 'senate_relay')!;
    expect(check.status).toBe('degraded');
    expect(check.detail).toContain('SENATE_RELAY_URL unset');
  });

  it('a stale ok Senate relay probe is degraded', () => {
    const res = evaluatePipelineSignals({
      ...base,
      senateRelay: {
        configured: true,
        probe: { ok: true, status: 200, checkedAt: new Date(nowMs - 45 * 60_000).toISOString(), host: 'scout.jays.services' },
      },
    }, nowMs);
    const check = res.checks.find((c) => c.id === 'senate_relay')!;
    expect(check.status).toBe('degraded');
    expect(check.detail).toContain('stale');
  });

  it('marks senate_relay ok when residential proxy is configured (scout relay retired)', () => {
    const res = evaluatePipelineSignals({
      ...base,
      senateRelay: { configured: false, probe: null },
      residentialProxyConfigured: true,
    }, nowMs);
    const check = res.checks.find((c) => c.id === 'senate_relay')!;
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('Residential proxy active');
  });
});

// Board row 6c05e09b: prod prices sat frozen for 46 days with no health signal.
describe('price_freshness check', () => {
  // Tue 2026-09-15 12:00 UTC.
  const nowMs = Date.parse('2026-09-15T12:00:00Z');
  const base = {
    outboxPending: 0, outboxOldestAt: null, outboxFailed: 0, reviewBacklog: 0, reviewEligible: 0,
    reviewSuppressed: 0, reviewTerminal: 0, extractionAttempts24h: 10, extractionOk24h: 10,
    lastExtractionSuccessAt: new Date(nowMs - 3600 * 1000).toISOString(), localWorkerActivity24h: 0,
    autopilotHaltReason: null, latestTxCreatedAt: new Date(nowMs - 3600 * 1000).toISOString(),
    dishonestResolutionCount: 0, orphanedNeedsReviewCount: 0, strandedFilings: 0,
    pollSources: null, latencyProviders: null, senateRelay: null,
    // 2026-09-21: defaults for the new signals. Tests that don't override
    // these should still produce a stable check count.
    filingSkips24h: 0,
    filingSkipsByAction24h: { extract_empty_failure: 0, auto_resolved_empty: 0, doc_quarantined: 0 },
    fmpLatency: {
      observationCount24h: 100,
      lastObservationAt: new Date(nowMs - 600 * 1000).toISOString(),
      lastObservationAgeSec: 600,
      http429s24h: 0,
      byProvider: {},
    },
  } as PipelineSignals;
  const check = (s: Partial<PipelineSignals>) =>
    evaluatePipelineSignals({ ...base, ...s }, nowMs).checks.find((c) => c.id === 'price_freshness');

  it('counts weekdays strictly between the newest bar and today', () => {
    // Friday bar read on Monday: 0 behind; on Tuesday: 1 (Monday's bar is due).
    expect(tradingDaysBehind('2026-09-11', Date.parse('2026-09-14T12:00:00Z'))).toBe(0);
    expect(tradingDaysBehind('2026-09-11', Date.parse('2026-09-15T12:00:00Z'))).toBe(1);
    // The live prod freeze: last S&P bar 2026-08-03 read on 2026-09-18.
    expect(tradingDaysBehind('2026-08-03', Date.parse('2026-09-18T12:00:00Z'))).toBe(33);
    expect(tradingDaysBehind('not a date', nowMs)).toBeNull();
  });

  it('is skipped entirely for a signal builder that predates the check (existing behaviour preserved)', () => {
    expect(check({})).toBeUndefined();
  });

  it('is ok when both series are within three trading days', () => {
    const c = check({ priceEodLatestDate: '2026-09-14', spxEodLatestDate: '2026-09-14' });
    expect(c?.status).toBe('ok');
  });

  it('goes degraded, naming the leg and the dates, when the price cache is a few days behind (weekend grace)', () => {
    // nowMs = Tue 2026-09-15 12:00 UTC. Price cache at Wed 2026-09-02 =
    // 9 trading days behind — sits in the degraded band (>3, <=14).
    // Trading weekdays in between: Sep 3,4,7,8,9,10,11,14 = 8 weekdays.
    const c = check({ priceEodLatestDate: '2026-09-02', spxEodLatestDate: '2026-09-14' });
    expect(c?.status).toBe('degraded');
    expect(c?.detail).toContain('price cache newest bar 2026-09-02');
    expect(c?.detail).not.toContain('S&P 500 series');
    // value shape (2026-09-20): { worstBehind, legs: { 'price cache': {date, behind}, ... } }
    const v = c?.value as { worstBehind: number };
    expect(v.worstBehind).toBeGreaterThan(3);
    expect(v.worstBehind).toBeLessThanOrEqual(14);
  });

  it('flags the S&P series independently (a week+ behind escalates to critical, Pushover alarm)', () => {
    // nowMs = Tue 2026-09-15. S&P at 2026-08-22 (Sat) = 16 trading weekdays
    // behind → >14 (priceMaxAgeCriticalDays) → critical.
    const c = check({ priceEodLatestDate: '2026-09-14', spxEodLatestDate: '2026-08-22' });
    expect(c?.status).toBe('critical');
    expect(c?.detail).toContain('S&P 500 series newest bar 2026-08-22');
    expect(c?.detail).toContain('recover via POST /admin/recover-pipeline');
  });

  it('escalates to STALLED when the newest bar is a month+ behind (structurally broken price refresh lane)', () => {
    // nowMs = Tue 2026-09-15. S&P frozen at 2026-08-01 (Sat) = 31 trading
    // weekdays behind → > 30 (priceMaxAgeStalledDays) → stalled. (Prod
    // actually froze at 2026-08-03 = 30 weekdays = exactly critical; the
    // 2026-09-21+ reading would be stalled once we cross the weekend.)
    const c = check({ priceEodLatestDate: '2026-09-14', spxEodLatestDate: '2026-08-01' });
    expect(c?.status).toBe('stalled');
    expect(c?.detail).toContain('S&P 500 series newest bar 2026-08-01');
    expect(c?.detail).toContain('structurally broken');
  });

  it('is unknown (never a false ok) when a leg could not be read, and degraded still wins over unknown', () => {
    expect(check({ priceEodLatestDate: null, spxEodLatestDate: '2026-09-14' })?.status).toBe('unknown');
    // S&P at 2026-09-02 = 8 weekdays behind → degraded (not critical).
    expect(check({ priceEodLatestDate: null, spxEodLatestDate: '2026-09-02' })?.status).toBe('degraded');
  });

  it('degrades the overall pipeline status from a stalled price cache', () => {
    const res = evaluatePipelineSignals(
      { ...base, priceEodLatestDate: '2026-08-01', spxEodLatestDate: '2026-08-01' },
      nowMs,
    );
    expect(res.status).toBe('stalled');
  });

  it('honours a custom threshold', () => {
    // 9 days behind with threshold 10 → ok.
    const res = evaluatePipelineSignals(
      { ...base, priceEodLatestDate: '2026-09-02', spxEodLatestDate: '2026-09-02' },
      nowMs,
      { ...DEFAULT_PIPELINE_THRESHOLDS, priceMaxAgeTradingDays: 10 },
    );
    expect(res.checks.find((c) => c.id === 'price_freshness')?.status).toBe('ok');
  });

  it('honours a custom critical threshold', () => {
    // 9 days behind with critical=5 → critical.
    const res = evaluatePipelineSignals(
      { ...base, priceEodLatestDate: '2026-09-02', spxEodLatestDate: '2026-09-02' },
      nowMs,
      { ...DEFAULT_PIPELINE_THRESHOLDS, priceMaxAgeCriticalDays: 5, priceMaxAgeStalledDays: 50 },
    );
    expect(res.checks.find((c) => c.id === 'price_freshness')?.status).toBe('critical');
  });

  it('value object includes per-leg date + behind so the detail is actionable without a second SQL query', () => {
    // price=2026-09-08 (Tue) → 4 weekdays behind, spx=today → 0 behind.
    const c = check({ priceEodLatestDate: '2026-09-08', spxEodLatestDate: '2026-09-15' });
    const v = c?.value as { worstBehind: number; legs: Record<string, { date: string | null; behind: number | null }> };
    expect(v.worstBehind).toBe(4);
    expect(v.legs['price cache']).toEqual({ date: '2026-09-08', behind: 4 });
    expect(v.legs['S&P 500 series']).toEqual({ date: '2026-09-15', behind: 0 });
  });
});
