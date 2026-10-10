import { describe, expect, it } from 'vitest';
import {
  evaluatePipelineSignals,
  tradingDaysBehind,
  Http429ValueSchema,
  type PipelineSignals,
  DEFAULT_PIPELINE_THRESHOLDS,
} from '../pipelineHealth.ts';
import { DEFAULT_PROBE_SCHEDULE_CONFIG } from '../../ingestion/probeSchedule.ts';

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

  it('degrades on non-parked dead-letter rows even when none are fresh in 24h (board f6be69f466af)', () => {
    const staleFailures: PipelineSignals = {
      ...cleanSignals,
      outboxFailed: 81,
      outboxFailedFresh: 0,
      outboxFailedActive: 81,
      outboxFailedIdentity: {
        count: 81,
        fingerprint: 'a'.repeat(64),
        doc_ids: ['S-6bf3b6f7', 'S-9e2ff733'],
        fingerprintCoversAll: true,
      },
    };
    const res = evaluatePipelineSignals(staleFailures, nowMs);
    const check = res.checks.find((c) => c.id === 'ingestion_dead_letter');
    expect(check?.status).toBe('degraded');
    expect(check?.value).toBe(81);
    expect(check?.detail).toContain('81 active');
    expect(check?.detail).toContain('identity fp=aaaaaaaaaaaa');
    expect(check?.detail).toContain('all failed=81');
    expect(check?.detail).not.toContain('S-6bf3b6f7');
    expect(res.status).toBe('degraded');
  });

  it('stays ok when failed outbox rows are explicitly parked', () => {
    const parkedOnly: PipelineSignals = {
      ...cleanSignals,
      outboxFailed: 12,
      outboxFailedFresh: 0,
      outboxFailedActive: 0,
      outboxFailedParked: 12,
      outboxFailedNonRetryable: 0,
    };
    const res = evaluatePipelineSignals(parkedOnly, nowMs);
    const check = res.checks.find((c) => c.id === 'ingestion_dead_letter');
    expect(check?.status).toBe('ok');
    expect(check?.detail).toContain('12 parked');
    expect(check?.detail).toContain('not auto-retried');
    expect(res.status).toBe('ok');
  });

  it('names the operator replay when active rows are non-transient or cycle-capped', () => {
    const capped: PipelineSignals = {
      ...cleanSignals,
      outboxFailed: 4,
      outboxFailedFresh: 0,
      outboxFailedActive: 4,
      outboxFailedParked: 0,
      outboxFailedNonRetryable: 4,
    };
    const res = evaluatePipelineSignals(capped, nowMs);
    const check = res.checks.find((c) => c.id === 'ingestion_dead_letter');
    expect(check?.status).toBe('degraded');
    expect(check?.value).toBe(4);
    expect(check?.detail).toContain('not auto-retried');
    expect(check?.detail).toContain('POST /api/admin/ingest-requeue-failed');
    expect(res.status).toBe('degraded');
  });

  it('keeps active retryable failures degraded until the sweep clears them', () => {
    const aged: PipelineSignals = {
      ...cleanSignals,
      outboxFailed: 81,
      outboxFailedFresh: 0,
      outboxFailedActive: 81,
      outboxFailedParked: 0,
      outboxFailedNonRetryable: 0,
    };
    const res = evaluatePipelineSignals(aged, nowMs);
    const check = res.checks.find((c) => c.id === 'ingestion_dead_letter');
    expect(check?.status).toBe('degraded');
    expect(check?.value).toBe(81);
    expect(check?.detail).not.toContain('POST /api/admin/ingest-requeue-failed');
    expect(res.status).toBe('degraded');
  });

  it('degrades on a recent cron deadline and pages when it repeats', () => {
    const once: PipelineSignals = {
      ...cleanSignals,
      cronTickOverrun: {
        at: new Date(nowMs - 60_000).toISOString(),
        deadlineMs: 45000,
        reason: 'Deno cron tick exceeded 45000ms deadline',
        count: 1,
      },
    };
    const onceRes = evaluatePipelineSignals(once, nowMs);
    const onceCheck = onceRes.checks.find((c) => c.id === 'cron_deadline');
    expect(onceCheck?.status).toBe('degraded');
    expect(onceCheck?.detail).toContain('Deno cron tick exceeded 45000ms deadline');

    const repeated: PipelineSignals = {
      ...cleanSignals,
      cronTickOverrun: { ...once.cronTickOverrun!, count: 3 },
    };
    expect(evaluatePipelineSignals(repeated, nowMs).checks.find((c) => c.id === 'cron_deadline')?.status).toBe('critical');

    const stale: PipelineSignals = {
      ...cleanSignals,
      cronTickOverrun: {
        at: new Date(nowMs - 7 * 60 * 60 * 1000).toISOString(),
        deadlineMs: 45000,
        reason: 'Deno cron tick exceeded 45000ms deadline',
        count: 4,
      },
    };
    expect(evaluatePipelineSignals(stale, nowMs).checks.find((c) => c.id === 'cron_deadline')?.status).toBe('ok');
  });

  it('degrades when webhook deliveries are quarantined after parked-cap overflow', () => {
    const quarantined: PipelineSignals = {
      ...cleanSignals,
      deliveryParked: 500,
      deliveryQuarantined: 57_321,
    };
    const res = evaluatePipelineSignals(quarantined, nowMs);
    const check = res.checks.find((c) => c.id === 'delivery_quarantine');
    expect(check?.status).toBe('degraded');
    expect(check?.value).toBe(57_321);
    expect(check?.detail).toContain('delivery-requeue-quarantined');
    expect(res.status).toBe('degraded');
  });

  it('still degrades when a fresh outbox failure arrives beside older active rows', () => {
    const mixed: PipelineSignals = {
      ...cleanSignals,
      outboxFailed: 82,
      outboxFailedFresh: 1,
      outboxFailedActive: 82,
    };
    const res = evaluatePipelineSignals(mixed, nowMs);
    const check = res.checks.find((c) => c.id === 'ingestion_dead_letter');
    expect(check?.status).toBe('degraded');
    expect(check?.value).toBe(82);
    expect(check?.detail).toContain('1 fresh in 24h');
    expect(check?.detail).toContain('82 active');
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

  it('marks senate_relay stalled when residential proxy is configured but probe is down (board f6be69f466af)', () => {
    const res = evaluatePipelineSignals({
      ...base,
      senateRelay: { configured: false, probe: null },
      residentialProxyConfigured: true,
      residentialProxy: {
        configured: true,
        probe: {
          ok: false,
          status: 503,
          checkedAt: new Date(nowMs - 30_000).toISOString(),
          host: '10.99.0.2:8888',
        },
      },
    }, nowMs);
    const check = res.checks.find((c) => c.id === 'senate_relay')!;
    expect(check.status).toBe('stalled');
    expect(check.detail).toContain('Residential proxy DOWN');
  });

  it('marks senate_relay ok when residential proxy probe is live', () => {
    const res = evaluatePipelineSignals({
      ...base,
      senateRelay: { configured: false, probe: null },
      residentialProxyConfigured: true,
      residentialProxy: {
        configured: true,
        probe: {
          ok: true,
          status: 200,
          checkedAt: new Date(nowMs - 30_000).toISOString(),
          host: '10.99.0.2:8888',
        },
      },
    }, nowMs);
    const check = res.checks.find((c) => c.id === 'senate_relay')!;
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('Residential proxy live');
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

describe('Http429ValueSchema', () => {
  it('accepts a parsed number marker (1)', () => {
    const res = Http429ValueSchema.safeParse(1);
    expect(res.success).toBe(true);
    if (res.success) expect(res.data).toEqual({ count: 1 });
  });
  it('accepts a raw numeric string marker ("1")', () => {
    const res = Http429ValueSchema.safeParse('1');
    expect(res.success).toBe(true);
  });
  it('accepts the legacy { count } object', () => {
    const res = Http429ValueSchema.safeParse({ count: 2 });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data).toEqual({ count: 2 });
  });
  it('rejects a negative number', () => {
    expect(Http429ValueSchema.safeParse(-1).success).toBe(false);
  });
  it('rejects a random object', () => {
    expect(Http429ValueSchema.safeParse({ foo: 'bar' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pollMaxAgeHours session-cap widening (#PR-2599 follow-up)
//
// The shipped schedule floors are 30 min weekday / 60 min weekend (house,
// senate, provider) and 15 min weekday (executive profile). A *legally slower*
// coverage floor (e.g. PROBE_SCHEDULE_MAX_INTERVAL_SEC=3600) widens the cap to
// 1.5x the longest allocated gap so a healthy slower poll is not falsely
// stalled — without ever restoring the 3h/26h per-source ceilings that hid a
// multi-hour SQLITE_BUSY wedge.
// ---------------------------------------------------------------------------

describe('pollMaxAgeHours session-cap widening', () => {
  // Friday 2025-08-01 12:00 ET (EDT) — a weekday in the same week as the
  // saturday test below; matches the fixture clock used elsewhere in this
  // file so the existing "ok at 20 min / stalled at 20 h" executive test
  // continues to anchor the shipped-floor case.
  const weekdayMs = 1754092800000;
  // Saturday 2025-08-02 12:00 ET (EDT) = 2025-08-02T16:00:00Z.
  const weekendMs = Date.parse('2025-08-02T16:00:00Z');

  // Local copy of the shipped default poll-success ceilings (DEFAULT_PIPELINE_THRESHOLDS
  // would also work, but writing the literals here makes the per-source ceiling
  // the test cares about impossible to miss).
  const defaultThresholds = {
    ...DEFAULT_PIPELINE_THRESHOLDS,
    pollSuccessMaxAgeHours: { house: 3, senate: 3, executive: 26 },
  };

  it('shipped schedule: house / senate collapse to 0.75h weekday', () => {
    const res = evaluatePipelineSignals({
      outboxPending: 0, outboxOldestAt: null, outboxFailed: 0,
      reviewBacklog: 0, reviewEligible: 0, reviewSuppressed: 0, reviewTerminal: 0,
      extractionAttempts24h: 10, extractionOk24h: 10,
      lastExtractionSuccessAt: new Date(weekdayMs - 3_600_000).toISOString(),
      localWorkerActivity24h: 0, autopilotHaltReason: null,
      latestTxCreatedAt: new Date(weekdayMs - 3_600_000).toISOString(),
      dishonestResolutionCount: 0, orphanedNeedsReviewCount: 0, strandedFilings: 0,
      pollSources: [
        { source: 'house', lastSuccessAt: new Date(weekdayMs - 30 * 60_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 30 * 60_000).toISOString(), configDisabled: false },
        { source: 'senate', lastSuccessAt: new Date(weekdayMs - 30 * 60_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 30 * 60_000).toISOString(), configDisabled: false },
        { source: 'executive', lastSuccessAt: new Date(weekdayMs - 10 * 60_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 10 * 60_000).toISOString(), configDisabled: false },
      ],
      latencyProviders: [{ provider: 'quiver', lastObservedAt: new Date(weekdayMs - 3_600_000).toISOString() }],
      senateRelay: null,
    }, weekdayMs, defaultThresholds);
    expect(res.checks.find((c) => c.id === 'polling_house')!.status).toBe('ok');
    expect(res.checks.find((c) => c.id === 'polling_senate')!.status).toBe('ok');
  });

  it('shipped schedule: house / senate collapse to 1.5h weekend (default 3h ceiling does NOT reopen)', () => {
    // House last success 2h ago on a Saturday — must be stalled, not ok, even
    // though the 3h per-source ceiling is well above 2h.
    const res = evaluatePipelineSignals({
      outboxPending: 0, outboxOldestAt: null, outboxFailed: 0,
      reviewBacklog: 0, reviewEligible: 0, reviewSuppressed: 0, reviewTerminal: 0,
      extractionAttempts24h: 10, extractionOk24h: 10,
      lastExtractionSuccessAt: new Date(weekendMs - 3_600_000).toISOString(),
      localWorkerActivity24h: 0, autopilotHaltReason: null,
      latestTxCreatedAt: new Date(weekendMs - 3_600_000).toISOString(),
      dishonestResolutionCount: 0, orphanedNeedsReviewCount: 0, strandedFilings: 0,
      pollSources: [
        { source: 'house', lastSuccessAt: new Date(weekendMs - 2 * 3_600_000).toISOString(), lastAttemptAt: new Date(weekendMs - 2 * 3_600_000).toISOString(), configDisabled: false },
        { source: 'senate', lastSuccessAt: new Date(weekendMs - 70 * 60_000).toISOString(), lastAttemptAt: new Date(weekendMs - 70 * 60_000).toISOString(), configDisabled: false },
        { source: 'executive', lastSuccessAt: new Date(weekendMs - 70 * 60_000).toISOString(), lastAttemptAt: new Date(weekendMs - 70 * 60_000).toISOString(), configDisabled: false },
      ],
      latencyProviders: [{ provider: 'quiver', lastObservedAt: new Date(weekendMs - 3_600_000).toISOString() }],
      senateRelay: null,
    }, weekendMs, defaultThresholds);
    expect(res.checks.find((c) => c.id === 'polling_house')!.status).toBe('stalled');
    expect(res.checks.find((c) => c.id === 'polling_senate')!.status).toBe('ok');
  });

  it('raised pollSuccessMaxAgeHours=10 with the shipped schedule stays capped at 0.75h weekday (3h/26h ceilings do NOT reopen)', () => {
    // 2h ago is *inside* a 3h/10h/26h ceiling but outside the 0.75h session
    // cap, so the chamber must be stalled.
    const res = evaluatePipelineSignals({
      outboxPending: 0, outboxOldestAt: null, outboxFailed: 0,
      reviewBacklog: 0, reviewEligible: 0, reviewSuppressed: 0, reviewTerminal: 0,
      extractionAttempts24h: 10, extractionOk24h: 10,
      lastExtractionSuccessAt: new Date(weekdayMs - 3_600_000).toISOString(),
      localWorkerActivity24h: 0, autopilotHaltReason: null,
      latestTxCreatedAt: new Date(weekdayMs - 3_600_000).toISOString(),
      dishonestResolutionCount: 0, orphanedNeedsReviewCount: 0, strandedFilings: 0,
      pollSources: [
        { source: 'house', lastSuccessAt: new Date(weekdayMs - 2 * 3_600_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 2 * 3_600_000).toISOString(), configDisabled: false },
        { source: 'senate', lastSuccessAt: new Date(weekdayMs - 2 * 3_600_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 2 * 3_600_000).toISOString(), configDisabled: false },
        { source: 'executive', lastSuccessAt: new Date(weekdayMs - 2 * 3_600_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 2 * 3_600_000).toISOString(), configDisabled: false },
      ],
      latencyProviders: [{ provider: 'quiver', lastObservedAt: new Date(weekdayMs - 3_600_000).toISOString() }],
      senateRelay: null,
    }, weekdayMs, { ...defaultThresholds, pollSuccessMaxAgeHours: { house: 10, senate: 10, executive: 10 } });
    expect(res.checks.find((c) => c.id === 'polling_house')!.status).toBe('stalled');
    expect(res.checks.find((c) => c.id === 'polling_senate')!.status).toBe('stalled');
    expect(res.checks.find((c) => c.id === 'polling_executive')!.status).toBe('stalled');
  });

  it('PROBE_SCHEDULE_MAX_INTERVAL_SEC=3600 weekday: house widens to 1.5h, executive stays 0.75h (profile floor wins)', () => {
    // Global weekday floor raised to 1h: house/senate longest gap = 1h so
    // threshold = 1.5 * 1h = 1.5h. Executive profile floor stays 15 min so
    // its longest gap stays 0.25h and its threshold stays 0.75h. The global
    // env var does NOT widen executive.
    const slowWeekday = {
      ...DEFAULT_PROBE_SCHEDULE_CONFIG,
      maxIntervalSec: 3600,
    };
    // House last success 50 min ago — ok (under 1.5h widened cap).
    const within = evaluatePipelineSignals({
      outboxPending: 0, outboxOldestAt: null, outboxFailed: 0,
      reviewBacklog: 0, reviewEligible: 0, reviewSuppressed: 0, reviewTerminal: 0,
      extractionAttempts24h: 10, extractionOk24h: 10,
      lastExtractionSuccessAt: new Date(weekdayMs - 3_600_000).toISOString(),
      localWorkerActivity24h: 0, autopilotHaltReason: null,
      latestTxCreatedAt: new Date(weekdayMs - 3_600_000).toISOString(),
      dishonestResolutionCount: 0, orphanedNeedsReviewCount: 0, strandedFilings: 0,
      pollSources: [
        { source: 'house', lastSuccessAt: new Date(weekdayMs - 50 * 60_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 50 * 60_000).toISOString(), configDisabled: false },
        { source: 'senate', lastSuccessAt: new Date(weekdayMs - 50 * 60_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 50 * 60_000).toISOString(), configDisabled: false },
        { source: 'executive', lastSuccessAt: new Date(weekdayMs - 50 * 60_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 50 * 60_000).toISOString(), configDisabled: false },
      ],
      latencyProviders: [{ provider: 'quiver', lastObservedAt: new Date(weekdayMs - 3_600_000).toISOString() }],
      senateRelay: null,
    }, weekdayMs, defaultThresholds, slowWeekday);
    expect(within.checks.find((c) => c.id === 'polling_house')!.status).toBe('ok');
    expect(within.checks.find((c) => c.id === 'polling_senate')!.status).toBe('ok');
    // Executive profile floor (15 min) wins over the global env var.
    expect(within.checks.find((c) => c.id === 'polling_executive')!.status).toBe('stalled');

    // House last success 2h ago — stalled (over 1.5h widened cap).
    const pastSignals = {
      outboxPending: 0, outboxOldestAt: null, outboxFailed: 0,
      reviewBacklog: 0, reviewEligible: 0, reviewSuppressed: 0, reviewTerminal: 0,
      extractionAttempts24h: 10, extractionOk24h: 10,
      lastExtractionSuccessAt: new Date(weekdayMs - 3_600_000).toISOString(),
      localWorkerActivity24h: 0, autopilotHaltReason: null,
      latestTxCreatedAt: new Date(weekdayMs - 3_600_000).toISOString(),
      dishonestResolutionCount: 0, orphanedNeedsReviewCount: 0, strandedFilings: 0,
      pollSources: [
        { source: 'house', lastSuccessAt: new Date(weekdayMs - 2 * 3_600_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 2 * 3_600_000).toISOString(), configDisabled: false },
        { source: 'senate', lastSuccessAt: new Date(weekdayMs - 2 * 3_600_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 2 * 3_600_000).toISOString(), configDisabled: false },
        { source: 'executive', lastSuccessAt: new Date(weekdayMs - 10 * 60_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 10 * 60_000).toISOString(), configDisabled: false },
      ],
      latencyProviders: [{ provider: 'quiver', lastObservedAt: new Date(weekdayMs - 3_600_000).toISOString() }],
      senateRelay: null,
      filingSkips24h: 0,
      filingSkipsByAction24h: { extract_empty_failure: 0, auto_resolved_empty: 0, doc_quarantined: 0 },
      fmpLatency: {
        observationCount24h: 120,
        lastObservationAt: new Date(weekdayMs - 600 * 1000).toISOString(),
        lastObservationAgeSec: 600,
        http429s24h: 0,
        byProvider: { fmp: { lastObservationAt: new Date(weekdayMs - 600 * 1000).toISOString(), ageSec: 600, count24h: 120 } },
      },
    } satisfies PipelineSignals;
    const past = evaluatePipelineSignals(pastSignals, weekdayMs, defaultThresholds, slowWeekday);
    expect(past.checks.find((c) => c.id === 'polling_house')!.status).toBe('stalled');
  });

  it('PROBE_SCHEDULE_WEEKEND_MAX_INTERVAL_SEC=7200 on shipped profiles: weekend trough is still 1h, so a 2h house success is stalled (7200 alone does NOT widen the cap)', () => {
    // 7200 is the legal max of PROBE_SCHEDULE_WEEKEND_MAX_INTERVAL_SEC, but
    // the shipped weekend budget (27) keeps the trough at 3600s. The cap
    // therefore stays 1.5h and a house success 2h ago is stalled.
    const slowWeekend = {
      ...DEFAULT_PROBE_SCHEDULE_CONFIG,
      weekendMaxIntervalSec: 7200,
    };
    const stalled = evaluatePipelineSignals({
      outboxPending: 0, outboxOldestAt: null, outboxFailed: 0,
      reviewBacklog: 0, reviewEligible: 0, reviewSuppressed: 0, reviewTerminal: 0,
      extractionAttempts24h: 10, extractionOk24h: 10,
      lastExtractionSuccessAt: new Date(weekendMs - 3_600_000).toISOString(),
      localWorkerActivity24h: 0, autopilotHaltReason: null,
      latestTxCreatedAt: new Date(weekendMs - 3_600_000).toISOString(),
      dishonestResolutionCount: 0, orphanedNeedsReviewCount: 0, strandedFilings: 0,
      pollSources: [
        { source: 'house', lastSuccessAt: new Date(weekendMs - 2 * 3_600_000).toISOString(), lastAttemptAt: new Date(weekendMs - 2 * 3_600_000).toISOString(), configDisabled: false },
        { source: 'senate', lastSuccessAt: new Date(weekendMs - 70 * 60_000).toISOString(), lastAttemptAt: new Date(weekendMs - 70 * 60_000).toISOString(), configDisabled: false },
        { source: 'executive', lastSuccessAt: new Date(weekendMs - 70 * 60_000).toISOString(), lastAttemptAt: new Date(weekendMs - 70 * 60_000).toISOString(), configDisabled: false },
      ],
      latencyProviders: [{ provider: 'quiver', lastObservedAt: new Date(weekendMs - 3_600_000).toISOString() }],
      senateRelay: null,
    }, weekendMs, defaultThresholds, slowWeekend);
    expect(stalled.checks.find((c) => c.id === 'polling_house')!.status).toBe('stalled');
  });

  it('a schedule that actually lengthens the weekend gap: weekendBudget 12 widens house weekend trough to 8640s, cap stays at 3h ceiling, 2h ok / 4h stalled', () => {
    // weekendBudget 12 -> effectiveBudget 10 (10% headroom) -> 86400/10 = 8640s
    // trough. missedSlotHours = 1.5 * 2.4h = 3.6h would widen the cap, but the
    // 3h per-source ceiling binds (min(3, 3.6)). Senate and executive use the
    // shipped budgets and stay at the 1.5h weekend cap.
    const widerHouseWeekend = {
      ...DEFAULT_PROBE_SCHEDULE_CONFIG,
      profiles: {
        ...DEFAULT_PROBE_SCHEDULE_CONFIG.profiles,
        house: { ...DEFAULT_PROBE_SCHEDULE_CONFIG.profiles.house, weekendBudget: 12 },
      },
    };
    // 2h ago: ok under the 3h ceiling-bound cap.
    const within = evaluatePipelineSignals({
      outboxPending: 0, outboxOldestAt: null, outboxFailed: 0,
      reviewBacklog: 0, reviewEligible: 0, reviewSuppressed: 0, reviewTerminal: 0,
      extractionAttempts24h: 10, extractionOk24h: 10,
      lastExtractionSuccessAt: new Date(weekendMs - 3_600_000).toISOString(),
      localWorkerActivity24h: 0, autopilotHaltReason: null,
      latestTxCreatedAt: new Date(weekendMs - 3_600_000).toISOString(),
      dishonestResolutionCount: 0, orphanedNeedsReviewCount: 0, strandedFilings: 0,
      pollSources: [
        { source: 'house', lastSuccessAt: new Date(weekendMs - 2 * 3_600_000).toISOString(), lastAttemptAt: new Date(weekendMs - 2 * 3_600_000).toISOString(), configDisabled: false },
        { source: 'senate', lastSuccessAt: new Date(weekendMs - 70 * 60_000).toISOString(), lastAttemptAt: new Date(weekendMs - 70 * 60_000).toISOString(), configDisabled: false },
        { source: 'executive', lastSuccessAt: new Date(weekendMs - 70 * 60_000).toISOString(), lastAttemptAt: new Date(weekendMs - 70 * 60_000).toISOString(), configDisabled: false },
      ],
      latencyProviders: [{ provider: 'quiver', lastObservedAt: new Date(weekendMs - 3_600_000).toISOString() }],
      senateRelay: null,
    }, weekendMs, defaultThresholds, widerHouseWeekend);
    expect(within.checks.find((c) => c.id === 'polling_house')!.status).toBe('ok');

    // 4h ago: stalled, over the 3h ceiling-bound cap.
    const past = evaluatePipelineSignals({
      outboxPending: 0, outboxOldestAt: null, outboxFailed: 0,
      reviewBacklog: 0, reviewEligible: 0, reviewSuppressed: 0, reviewTerminal: 0,
      extractionAttempts24h: 10, extractionOk24h: 10,
      lastExtractionSuccessAt: new Date(weekendMs - 3_600_000).toISOString(),
      localWorkerActivity24h: 0, autopilotHaltReason: null,
      latestTxCreatedAt: new Date(weekendMs - 3_600_000).toISOString(),
      dishonestResolutionCount: 0, orphanedNeedsReviewCount: 0, strandedFilings: 0,
      pollSources: [
        { source: 'house', lastSuccessAt: new Date(weekendMs - 4 * 3_600_000).toISOString(), lastAttemptAt: new Date(weekendMs - 4 * 3_600_000).toISOString(), configDisabled: false },
        { source: 'senate', lastSuccessAt: new Date(weekendMs - 70 * 60_000).toISOString(), lastAttemptAt: new Date(weekendMs - 70 * 60_000).toISOString(), configDisabled: false },
        { source: 'executive', lastSuccessAt: new Date(weekendMs - 70 * 60_000).toISOString(), lastAttemptAt: new Date(weekendMs - 70 * 60_000).toISOString(), configDisabled: false },
      ],
      latencyProviders: [{ provider: 'quiver', lastObservedAt: new Date(weekendMs - 3_600_000).toISOString() }],
      senateRelay: null,
    }, weekendMs, defaultThresholds, widerHouseWeekend);
    expect(past.checks.find((c) => c.id === 'polling_house')!.status).toBe('stalled');
  });

  it('weekdayPollMaxAgeHours: 2 with the shipped schedule raises the weekday cap to 2h (cannot exceed pollSuccessMaxAgeHours)', () => {
    // 1.5h ago is ok under 2h widened cap (would have been stalled at 0.75h).
    const within = evaluatePipelineSignals({
      outboxPending: 0, outboxOldestAt: null, outboxFailed: 0,
      reviewBacklog: 0, reviewEligible: 0, reviewSuppressed: 0, reviewTerminal: 0,
      extractionAttempts24h: 10, extractionOk24h: 10,
      lastExtractionSuccessAt: new Date(weekdayMs - 3_600_000).toISOString(),
      localWorkerActivity24h: 0, autopilotHaltReason: null,
      latestTxCreatedAt: new Date(weekdayMs - 3_600_000).toISOString(),
      dishonestResolutionCount: 0, orphanedNeedsReviewCount: 0, strandedFilings: 0,
      pollSources: [
        { source: 'house', lastSuccessAt: new Date(weekdayMs - 90 * 60_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 90 * 60_000).toISOString(), configDisabled: false },
        { source: 'senate', lastSuccessAt: new Date(weekdayMs - 90 * 60_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 90 * 60_000).toISOString(), configDisabled: false },
        { source: 'executive', lastSuccessAt: new Date(weekdayMs - 90 * 60_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 90 * 60_000).toISOString(), configDisabled: false },
      ],
      latencyProviders: [{ provider: 'quiver', lastObservedAt: new Date(weekdayMs - 3_600_000).toISOString() }],
      senateRelay: null,
    }, weekdayMs, { ...defaultThresholds, weekdayPollMaxAgeHours: 2 });
    expect(within.checks.find((c) => c.id === 'polling_house')!.status).toBe('ok');

    // 2.5h ago is stalled (over 2h widened cap).
    const past = evaluatePipelineSignals({
      outboxPending: 0, outboxOldestAt: null, outboxFailed: 0,
      reviewBacklog: 0, reviewEligible: 0, reviewSuppressed: 0, reviewTerminal: 0,
      extractionAttempts24h: 10, extractionOk24h: 10,
      lastExtractionSuccessAt: new Date(weekdayMs - 3_600_000).toISOString(),
      localWorkerActivity24h: 0, autopilotHaltReason: null,
      latestTxCreatedAt: new Date(weekdayMs - 3_600_000).toISOString(),
      dishonestResolutionCount: 0, orphanedNeedsReviewCount: 0, strandedFilings: 0,
      pollSources: [
        { source: 'house', lastSuccessAt: new Date(weekdayMs - 150 * 60_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 150 * 60_000).toISOString(), configDisabled: false },
        { source: 'senate', lastSuccessAt: new Date(weekdayMs - 150 * 60_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 150 * 60_000).toISOString(), configDisabled: false },
        { source: 'executive', lastSuccessAt: new Date(weekdayMs - 150 * 60_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 150 * 60_000).toISOString(), configDisabled: false },
      ],
      latencyProviders: [{ provider: 'quiver', lastObservedAt: new Date(weekdayMs - 3_600_000).toISOString() }],
      senateRelay: null,
    }, weekdayMs, { ...defaultThresholds, weekdayPollMaxAgeHours: 2 });
    expect(past.checks.find((c) => c.id === 'polling_house')!.status).toBe('stalled');

    // weekdayPollMaxAgeHours: 5 with the per-source ceiling at 3h:
    // 2h ago is inside the 3h per-source ceiling AND inside the 3h cap, so
    // it stays ok. 4h ago is over both and stalls.
    const capped = evaluatePipelineSignals({
      outboxPending: 0, outboxOldestAt: null, outboxFailed: 0,
      reviewBacklog: 0, reviewEligible: 0, reviewSuppressed: 0, reviewTerminal: 0,
      extractionAttempts24h: 10, extractionOk24h: 10,
      lastExtractionSuccessAt: new Date(weekdayMs - 3_600_000).toISOString(),
      localWorkerActivity24h: 0, autopilotHaltReason: null,
      latestTxCreatedAt: new Date(weekdayMs - 3_600_000).toISOString(),
      dishonestResolutionCount: 0, orphanedNeedsReviewCount: 0, strandedFilings: 0,
      pollSources: [
        { source: 'house', lastSuccessAt: new Date(weekdayMs - 2 * 3_600_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 2 * 3_600_000).toISOString(), configDisabled: false },
        { source: 'senate', lastSuccessAt: new Date(weekdayMs - 2 * 3_600_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 2 * 3_600_000).toISOString(), configDisabled: false },
        { source: 'executive', lastSuccessAt: new Date(weekdayMs - 2 * 3_600_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 2 * 3_600_000).toISOString(), configDisabled: false },
      ],
      latencyProviders: [{ provider: 'quiver', lastObservedAt: new Date(weekdayMs - 3_600_000).toISOString() }],
      senateRelay: null,
    }, weekdayMs, { ...defaultThresholds, weekdayPollMaxAgeHours: 5 });
    expect(capped.checks.find((c) => c.id === 'polling_house')!.status).toBe('ok');

    const pastCapped = evaluatePipelineSignals({
      outboxPending: 0, outboxOldestAt: null, outboxFailed: 0,
      reviewBacklog: 0, reviewEligible: 0, reviewSuppressed: 0, reviewTerminal: 0,
      extractionAttempts24h: 10, extractionOk24h: 10,
      lastExtractionSuccessAt: new Date(weekdayMs - 3_600_000).toISOString(),
      localWorkerActivity24h: 0, autopilotHaltReason: null,
      latestTxCreatedAt: new Date(weekdayMs - 3_600_000).toISOString(),
      dishonestResolutionCount: 0, orphanedNeedsReviewCount: 0, strandedFilings: 0,
      pollSources: [
        { source: 'house', lastSuccessAt: new Date(weekdayMs - 4 * 3_600_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 4 * 3_600_000).toISOString(), configDisabled: false },
        { source: 'senate', lastSuccessAt: new Date(weekdayMs - 4 * 3_600_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 4 * 3_600_000).toISOString(), configDisabled: false },
        { source: 'executive', lastSuccessAt: new Date(weekdayMs - 4 * 3_600_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 4 * 3_600_000).toISOString(), configDisabled: false },
      ],
      latencyProviders: [{ provider: 'quiver', lastObservedAt: new Date(weekdayMs - 3_600_000).toISOString() }],
      senateRelay: null,
    }, weekdayMs, { ...defaultThresholds, weekdayPollMaxAgeHours: 5 });
    expect(pastCapped.checks.find((c) => c.id === 'polling_house')!.status).toBe('stalled');
  });

  it('tight custom pollSuccessMaxAgeHours=0.6h floors at one missed slot (0.75h), not 0.6h', () => {
    // 0.6h is below sessionCap (0.75h) and below one missed slot (0.75h), so the
    // effective cap is 0.75h per the PipelineThresholds contract.
    const ok = evaluatePipelineSignals({
      outboxPending: 0, outboxOldestAt: null, outboxFailed: 0,
      reviewBacklog: 0, reviewEligible: 0, reviewSuppressed: 0, reviewTerminal: 0,
      extractionAttempts24h: 10, extractionOk24h: 10,
      lastExtractionSuccessAt: new Date(weekdayMs - 3_600_000).toISOString(),
      localWorkerActivity24h: 0, autopilotHaltReason: null,
      latestTxCreatedAt: new Date(weekdayMs - 3_600_000).toISOString(),
      dishonestResolutionCount: 0, orphanedNeedsReviewCount: 0, strandedFilings: 0,
      pollSources: [
        { source: 'house', lastSuccessAt: new Date(weekdayMs - 35 * 60_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 35 * 60_000).toISOString(), configDisabled: false },
        { source: 'senate', lastSuccessAt: new Date(weekdayMs - 35 * 60_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 35 * 60_000).toISOString(), configDisabled: false },
        { source: 'executive', lastSuccessAt: new Date(weekdayMs - 10 * 60_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 10 * 60_000).toISOString(), configDisabled: false },
      ],
      latencyProviders: [{ provider: 'quiver', lastObservedAt: new Date(weekdayMs - 3_600_000).toISOString() }],
      senateRelay: null,
    }, weekdayMs, { ...defaultThresholds, pollSuccessMaxAgeHours: { house: 0.6, senate: 0.6, executive: 26 } });
    expect(ok.checks.find((c) => c.id === 'polling_house')!.status).toBe('ok');

    // 40 min is under the 0.75h missed-slot floor (would have been stalled at 0.6h).
    const withinMissedSlot = evaluatePipelineSignals({
      outboxPending: 0, outboxOldestAt: null, outboxFailed: 0,
      reviewBacklog: 0, reviewEligible: 0, reviewSuppressed: 0, reviewTerminal: 0,
      extractionAttempts24h: 10, extractionOk24h: 10,
      lastExtractionSuccessAt: new Date(weekdayMs - 3_600_000).toISOString(),
      localWorkerActivity24h: 0, autopilotHaltReason: null,
      latestTxCreatedAt: new Date(weekdayMs - 3_600_000).toISOString(),
      dishonestResolutionCount: 0, orphanedNeedsReviewCount: 0, strandedFilings: 0,
      pollSources: [
        { source: 'house', lastSuccessAt: new Date(weekdayMs - 40 * 60_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 40 * 60_000).toISOString(), configDisabled: false },
        { source: 'senate', lastSuccessAt: new Date(weekdayMs - 40 * 60_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 40 * 60_000).toISOString(), configDisabled: false },
        { source: 'executive', lastSuccessAt: new Date(weekdayMs - 10 * 60_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 10 * 60_000).toISOString(), configDisabled: false },
      ],
      latencyProviders: [{ provider: 'quiver', lastObservedAt: new Date(weekdayMs - 3_600_000).toISOString() }],
      senateRelay: null,
    }, weekdayMs, { ...defaultThresholds, pollSuccessMaxAgeHours: { house: 0.6, senate: 0.6, executive: 26 } });
    expect(withinMissedSlot.checks.find((c) => c.id === 'polling_house')!.status).toBe('ok');

    // 50 min is over the 0.75h missed-slot floor, stalled.
    const stalled = evaluatePipelineSignals({
      outboxPending: 0, outboxOldestAt: null, outboxFailed: 0,
      reviewBacklog: 0, reviewEligible: 0, reviewSuppressed: 0, reviewTerminal: 0,
      extractionAttempts24h: 10, extractionOk24h: 10,
      lastExtractionSuccessAt: new Date(weekdayMs - 3_600_000).toISOString(),
      localWorkerActivity24h: 0, autopilotHaltReason: null,
      latestTxCreatedAt: new Date(weekdayMs - 3_600_000).toISOString(),
      dishonestResolutionCount: 0, orphanedNeedsReviewCount: 0, strandedFilings: 0,
      pollSources: [
        { source: 'house', lastSuccessAt: new Date(weekdayMs - 50 * 60_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 50 * 60_000).toISOString(), configDisabled: false },
        { source: 'senate', lastSuccessAt: new Date(weekdayMs - 50 * 60_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 50 * 60_000).toISOString(), configDisabled: false },
        { source: 'executive', lastSuccessAt: new Date(weekdayMs - 10 * 60_000).toISOString(), lastAttemptAt: new Date(weekdayMs - 10 * 60_000).toISOString(), configDisabled: false },
      ],
      latencyProviders: [{ provider: 'quiver', lastObservedAt: new Date(weekdayMs - 3_600_000).toISOString() }],
      senateRelay: null,
    }, weekdayMs, { ...defaultThresholds, pollSuccessMaxAgeHours: { house: 0.6, senate: 0.6, executive: 26 } });
    expect(stalled.checks.find((c) => c.id === 'polling_house')!.status).toBe('stalled');
  });
});
