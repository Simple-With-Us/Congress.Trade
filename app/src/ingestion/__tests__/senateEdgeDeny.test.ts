/**
 * Senate eFD edge-deny backoff (CT-2442): the window math, its CONFIG_KV
 * state, and the two honesty surfaces it feeds.  While the watcher holds off,
 * senate attempts are 60 minutes to 6 hours apart, so polling_senate must
 * still read stalled (and say why), and the polling heartbeat must not page
 * that deliberate silence as a stuck cron.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { evaluatePipelineSignals, type PipelineSignals } from '../../shared/pipelineHealth.ts';
import { sweepPollingHeartbeat } from '../autonomySweeps.ts';
import {
  SENATE_EDGE_BACKOFF_GRACE_MS,
  SENATE_EDGE_BACKOFF_KV_KEY,
  clearSenateEdgeBackoff,
  isSenateEdgeBackoffActive,
  nextSenateEdgeBackoff,
  readSenateEdgeBackoff,
  writeSenateEdgeBackoff,
} from '../senateEdgeDeny.ts';

const REASON = 'senate POST /search/home/ -> HTTP 403 (server=AkamaiGHost) [edge_denied]';
// Monday 1:00 PM: weekday session caps apply (45 minute poll cap, 240 minute heartbeat).
const NOW = new Date('2026-10-26T18:00:00.000Z');
const nowMs = NOW.getTime();
const minutesAgo = (n: number) => new Date(nowMs - n * 60_000).toISOString();
const minutesAhead = (n: number) => new Date(nowMs + n * 60_000).toISOString();

function memoryKv(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    async get(key: string, type?: string) {
      const v = store.get(key) ?? null;
      return v !== null && type === 'json' ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

describe('nextSenateEdgeBackoff', () => {
  it('starts at 60 minutes, doubles on each further deny, and caps at 6 hours', () => {
    let state = nextSenateEdgeBackoff(null, NOW, REASON);
    const windows = [state.windowMs / 60_000];
    for (let i = 0; i < 5; i++) {
      state = nextSenateEdgeBackoff(state, new Date(Date.parse(state.until) + 60_000), REASON);
      windows.push(state.windowMs / 60_000);
    }
    expect(windows).toEqual([60, 120, 240, 360, 360, 360]);
    expect(state.consecutive).toBe(6);
    expect(state.firstDeniedAt).toBe(NOW.toISOString());
    expect(state.reason).toBe(REASON);
  });

  it('sets until to now plus the window and starts over without a previous state', () => {
    const state = nextSenateEdgeBackoff(null, NOW, REASON);
    expect(state).toMatchObject({ consecutive: 1, windowMs: 3_600_000, until: minutesAhead(60), lastDeniedAt: NOW.toISOString() });
    expect(isSenateEdgeBackoffActive(state, new Date(nowMs + 59 * 60_000))).toBe(true);
    expect(isSenateEdgeBackoffActive(state, new Date(nowMs + 60 * 60_000))).toBe(false);
    expect(isSenateEdgeBackoffActive(state, new Date(nowMs + 80 * 60_000), SENATE_EDGE_BACKOFF_GRACE_MS)).toBe(true);
  });
});

describe('senate edge backoff state in CONFIG_KV', () => {
  it('round-trips, and a cleared or malformed key reads as no backoff', async () => {
    const kv = memoryKv();
    const env = { CONFIG_KV: kv } as unknown as Env;
    const state = nextSenateEdgeBackoff(null, NOW, REASON);

    expect(await writeSenateEdgeBackoff(env, state)).toBe(true);
    expect(await readSenateEdgeBackoff(env)).toEqual(state);

    await clearSenateEdgeBackoff(env);
    expect(await readSenateEdgeBackoff(env)).toBeNull();

    kv.store.set(SENATE_EDGE_BACKOFF_KV_KEY, '{not json');
    expect(await readSenateEdgeBackoff(env)).toBeNull();
    kv.store.set(SENATE_EDGE_BACKOFF_KV_KEY, JSON.stringify({ until: 'never' }));
    expect(await readSenateEdgeBackoff(env)).toBeNull();
  });

  it('reports a failed save instead of pretending the backoff holds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = {
      CONFIG_KV: { put: async () => { throw new Error('kv down'); } },
    } as unknown as Env;
    expect(await writeSenateEdgeBackoff(env, nextSenateEdgeBackoff(null, NOW, REASON))).toBe(false);
    warn.mockRestore();
  });
});

describe('polling_senate during an edge-deny backoff', () => {
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
    lastExtractionSuccessAt: minutesAgo(60),
    localWorkerActivity24h: 0,
    autopilotHaltReason: null,
    latestTxCreatedAt: minutesAgo(60),
    dishonestResolutionCount: 0,
    orphanedNeedsReviewCount: 0,
    strandedFilings: 0,
    pollSources: [
      { source: 'house', lastSuccessAt: minutesAgo(10), lastAttemptAt: minutesAgo(10), configDisabled: false },
      { source: 'senate', lastSuccessAt: minutesAgo(10), lastAttemptAt: minutesAgo(10), configDisabled: false },
      { source: 'executive', lastSuccessAt: minutesAgo(10), lastAttemptAt: minutesAgo(10), configDisabled: false },
    ],
    latencyProviders: [{ provider: 'fmp', lastObservedAt: minutesAgo(60) }],
    senateRelay: {
      configured: true,
      probe: { ok: true, status: 200, checkedAt: minutesAgo(1), host: 'relay.test' },
    },
  };

  function senate(patch: Partial<NonNullable<PipelineSignals['pollSources']>[number]>): PipelineSignals {
    return {
      ...base,
      pollSources: base.pollSources!.map((p) => (p.source === 'senate' ? { ...p, ...patch } : p)),
    };
  }

  const check = (s: PipelineSignals) => evaluatePipelineSignals(s, nowMs).checks.find((c) => c.id === 'polling_senate')!;

  it('sparse attempts read stalled even with no backoff signal at all', () => {
    // 2 hours since the last attempt (a 4-hour window), 9 hours since the last success.
    const c = check(senate({ lastSuccessAt: minutesAgo(540), lastAttemptAt: minutesAgo(120) }));
    expect(c.status).toBe('stalled');
    expect(c.detail).toContain('NOT RUNNING');
  });

  it('stays stalled and names the backoff instead of a dead cron', () => {
    const s = senate({
      lastSuccessAt: minutesAgo(540),
      lastAttemptAt: minutesAgo(120),
      edgeBackoff: { until: minutesAhead(120), lastDeniedAt: minutesAgo(120), reason: REASON },
    });
    const res = evaluatePipelineSignals(s, nowMs);
    const c = res.checks.find((x) => x.id === 'polling_senate')!;
    expect(c.status).toBe('stalled');
    expect(res.status).toBe('stalled');
    expect(c.detail).toBe(`senate polling BACKED OFF after an edge deny (${REASON}): next attempt in 120m; no success in 9h (threshold 0.75h)`);
    expect(c.value).toBe(9);
  });

  it('names the backoff right after the deny too (attempts still fresh)', () => {
    const c = check(senate({
      lastSuccessAt: minutesAgo(540),
      lastAttemptAt: minutesAgo(1),
      edgeBackoff: { until: minutesAhead(59), lastDeniedAt: minutesAgo(1), reason: REASON },
    }));
    expect(c.status).toBe('stalled');
    expect(c.detail).toContain('BACKED OFF');
    expect(c.detail).toContain('next attempt in 59m');
  });

  it('falls back to NOT RUNNING once the next attempt is overdue past the grace', () => {
    const c = check(senate({
      lastSuccessAt: minutesAgo(900),
      lastAttemptAt: minutesAgo(240),
      edgeBackoff: { until: minutesAgo(60), lastDeniedAt: minutesAgo(240), reason: REASON },
    }));
    expect(c.status).toBe('stalled');
    expect(c.detail).toContain('NOT RUNNING');
  });

  it('says FAILING, not BACKED OFF, once polling resumed after the window and fails for another reason', () => {
    // Deny 300 minutes ago, window over 240 minutes ago, attempts every 10
    // minutes since (a Mango outage, a timeout): the old deny is not the cause.
    const c = check(senate({
      lastSuccessAt: minutesAgo(900),
      lastAttemptAt: minutesAgo(5),
      edgeBackoff: { until: minutesAgo(240), lastDeniedAt: minutesAgo(300), reason: REASON },
    }));
    expect(c.status).toBe('stalled');
    expect(c.detail).toBe('senate polling FAILING: attempts are running (last 0h ago) but no success in 15h (threshold 0.75h)');
  });

  it('says FAILING inside the grace too when the attempt after the window was not a deny', () => {
    const c = check(senate({
      lastSuccessAt: minutesAgo(900),
      lastAttemptAt: minutesAgo(8),
      edgeBackoff: { until: minutesAgo(10), lastDeniedAt: minutesAgo(70), reason: REASON },
    }));
    expect(c.status).toBe('stalled');
    expect(c.detail).toContain('FAILING');
  });

  it('ignores a spent backoff whose deny predates the last success', () => {
    const c = check(senate({
      lastSuccessAt: minutesAgo(90),
      lastAttemptAt: minutesAgo(5),
      edgeBackoff: { until: minutesAhead(30), lastDeniedAt: minutesAgo(200), reason: REASON },
    }));
    expect(c.status).toBe('stalled');
    expect(c.detail).toContain('FAILING');
  });

  it('a fresh success reads ok whatever the backoff key says', () => {
    const c = check(senate({
      lastSuccessAt: minutesAgo(5),
      lastAttemptAt: minutesAgo(5),
      edgeBackoff: { until: minutesAhead(30), lastDeniedAt: minutesAgo(65), reason: REASON },
    }));
    expect(c.status).toBe('ok');
  });
});

describe('sweepPollingHeartbeat during an edge-deny backoff', () => {
  function heartbeatEnv(kvSeed: Record<string, string>) {
    const rows = [
      { source: 'house', last_attempt: minutesAgo(5) },
      { source: 'senate', last_attempt: minutesAgo(300) },
      { source: 'executive', last_attempt: minutesAgo(5) },
    ];
    return {
      CONFIG_KV: memoryKv(kvSeed),
      DB: {
        prepare: () => ({
          bind() { return this; },
          all: async () => ({ results: rows }),
        }),
      },
    } as unknown as Env;
  }

  it('does not page a backed-off senate as a stuck cron', async () => {
    const backoff = nextSenateEdgeBackoff(null, new Date(nowMs - 300 * 60_000), REASON);
    const state = { ...backoff, windowMs: 6 * 3_600_000, until: minutesAhead(60) };
    const push = vi.fn(async () => ({ sent: true }));

    const res = await sweepPollingHeartbeat(
      heartbeatEnv({ [SENATE_EDGE_BACKOFF_KV_KEY]: JSON.stringify(state) }),
      NOW,
      { push: push as never },
    );

    expect(res.ageBySource.senate).toBe(300 * 60);
    expect(res.alerted).toEqual([]);
    expect(push).not.toHaveBeenCalled();
  });

  it('still pages a silent senate with no backoff in force', async () => {
    const push = vi.fn(async () => ({ sent: true }));
    const res = await sweepPollingHeartbeat(heartbeatEnv({}), NOW, { push: push as never });
    expect(res.alerted).toEqual(['senate']);
  });
});
