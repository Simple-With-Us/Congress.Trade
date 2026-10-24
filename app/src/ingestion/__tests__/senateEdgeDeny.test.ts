/**
 * Senate eFD edge-deny backoff (CT-2442): the window math, its CONFIG_KV
 * state, and the two honesty surfaces it feeds.  While the watcher holds off,
 * senate attempts are 60 minutes to 6 hours apart, so polling_senate must
 * still read stalled (and say why), and the polling heartbeat must not page
 * that deliberate silence as a stuck cron.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { evaluatePipelineSignals, type PipelineSignals } from '../../shared/pipelineHealth.ts';
import { sweepPollingHeartbeat } from '../autonomySweeps.ts';
import {
  SENATE_EDGE_BACKOFF_GRACE_MS,
  SENATE_EDGE_BACKOFF_KV_KEY,
  SenateHttpError,
  SenateProxyEgressError,
  clearSenateEdgeBackoff,
  isSenateEdgeBackoffActive,
  nextSenateEdgeBackoff,
  readSenateEdgeBackoff,
  sanitizeEfdTransportError,
  senateEdgeDenyLogFields,
  senateEdgeDenyReason,
  senateEfdTransportScrubSecrets,
  writeSenateEdgeBackoff,
} from '../senateEdgeDeny.ts';

const REASON = 'senate POST /search/home/ -> HTTP 403 (server=AkamaiGHost) [edge_denied]';

describe('sanitizeEfdTransportError', () => {
  it('strips URL userinfo and bounds the length', () => {
    const out = sanitizeEfdTransportError(new Error(`connect http://u:p%40ss@host:1/ ${'x'.repeat(500)}`));
    expect(out).toContain('http://[redacted]@host:1/');
    expect(out).not.toContain('p%40ss');
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it('replaces configured proxy secrets in the text', () => {
    const secret = 'http://proxy-user:proxy-pass@10.99.0.2:8888';
    const out = sanitizeEfdTransportError(`tunnel failed via ${secret}`, [secret, 'proxy-pass']);
    expect(out).not.toContain('proxy-user');
    expect(out).not.toContain('proxy-pass');
    expect(out).toContain('[redacted]');
  });

  it('collects the env binding\'s proxy values as scrub secrets, not only process.env', () => {
    const secrets = senateEfdTransportScrubSecrets('http://10.99.0.2:8888', {
      RESIDENTIAL_PROXY_USERNAME: 'bind-user',
      RESIDENTIAL_PROXY_PASSWORD: 'bind-pass',
    });
    expect(secrets).toEqual(expect.arrayContaining(['http://10.99.0.2:8888', 'bind-user', 'bind-pass']));
    const out = sanitizeEfdTransportError(new Error('407 from proxy for bind-user / bind-pass'), secrets);
    expect(out).not.toMatch(/bind-user|bind-pass/);
  });

  // Kody on #2846: production resolves the proxy from Infisical into the env
  // binding, so the process env holds no proxy values, and the userinfo
  // rewrite used to run first and change the text the URL secret had to match.
  describe('secrets from the proxy URL in use (CT-2442)', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('takes the username and password out of the proxy URL, raw and decoded, with no env at all', () => {
      for (const key of ['RESIDENTIAL_PROXY_URL', 'SENATE_PROXY_URL', 'RESIDENTIAL_PROXY_USERNAME', 'RESIDENTIAL_PROXY_PASSWORD']) {
        vi.stubEnv(key, '');
      }
      const secrets = senateEfdTransportScrubSecrets('http://mango-user:p%40ss%3Aw0rd@10.99.0.2:8888');
      expect(secrets).toEqual(expect.arrayContaining([
        'http://mango-user:p%40ss%3Aw0rd@10.99.0.2:8888',
        'mango-user:p%40ss%3Aw0rd',
        'mango-user',
        'p%40ss%3Aw0rd',
        'p@ss:w0rd',
      ]));
    });

    it('redacts a password echoed outside a scheme://user:pass@ position', () => {
      const secrets = senateEfdTransportScrubSecrets('http://mango-user:p%40ss-w0rd@10.99.0.2:8888');
      const out = sanitizeEfdTransportError(
        new TypeError('proxy CONNECT refused: 407 for user mango-user (password p@ss-w0rd, sent as p%40ss-w0rd)'),
        secrets,
      );
      expect(out).toBe('proxy CONNECT refused: 407 for user [redacted] (password [redacted], sent as [redacted])');
    });

    it('redacts the userinfo of a URL, the configured one or any other', () => {
      const proxyUrl = 'http://mango-user:s3cret-pw@10.99.0.2:8888';
      const secrets = senateEfdTransportScrubSecrets(proxyUrl);
      expect(sanitizeEfdTransportError(`tunnel via ${proxyUrl}/ failed`, secrets)).toBe('tunnel via [redacted]/ failed');
      // Not configured, so not in the list: the userinfo rewrite still catches it.
      expect(sanitizeEfdTransportError('tunnel via http://other:pw-9@10.0.0.7:3128/ failed', secrets))
        .toBe('tunnel via http://[redacted]@10.0.0.7:3128/ failed');
    });

    it('substitutes the secrets before the userinfo rewrite, longest first', () => {
      // A raw `@` in the password: the rewrite alone stops at that `@` and
      // keeps the rest of the password.
      const proxyUrl = 'http://mango-user:pa@ss-w0rd@10.99.0.2:8888';
      expect(sanitizeEfdTransportError(`connect ${proxyUrl} refused`)).toContain('ss-w0rd');
      const secrets = senateEfdTransportScrubSecrets(proxyUrl);
      const out = sanitizeEfdTransportError(`connect ${proxyUrl} refused; retry with pa@ss-w0rd`, secrets);
      expect(out).toBe('connect [redacted] refused; retry with [redacted]');
      // Longest first: the whole URL goes as one, not cut up by its own password.
      expect(sanitizeEfdTransportError(proxyUrl, ['pa@ss-w0rd', proxyUrl])).toBe('[redacted]');
    });

    it('bounds the text to maxChars, 200 by default', () => {
      expect(sanitizeEfdTransportError('x'.repeat(5_000))).toHaveLength(200);
      expect(sanitizeEfdTransportError('x'.repeat(5_000), [], 1_000)).toHaveLength(1_000);
    });
  });
});

describe('SenateProxyEgressError', () => {
  it('never exposes proxy URL userinfo or scrub secrets in the message', () => {
    const proxyUrl = 'http://leak-user:leak-pass@10.0.0.9:3128';
    const secrets = senateEfdTransportScrubSecrets(proxyUrl);
    const err = new SenateProxyEgressError(
      new Error(`connect ${proxyUrl}/path refused`),
      new SenateHttpError('GET /search/', 403, 'AkamaiGHost'),
      secrets,
    );
    expect(err.message).not.toMatch(/leak-user|leak-pass/);
    expect(err.message).toContain('(connect [redacted]/path refused)');
    expect(err.message).toContain('direct fallback failed: senate GET /search/ -> HTTP 403');
  });
});

describe('senateEdgeDenyReason / senateEdgeDenyLogFields', () => {
  it('restate an edge deny from its classified fields only', () => {
    const err = new SenateHttpError('POST /search/home/', 403, 'AkamaiGHost', {
      detail: 'echo http://u:hunter22@10.99.0.2:8888 <script>',
    });
    expect(err.message).toContain('hunter22');
    expect(senateEdgeDenyReason(err)).toBe('senate POST /search/home/ -> HTTP 403 (server=AkamaiGHost) [edge_denied]');
    expect(senateEdgeDenyLogFields(err)).toBe(
      'source=senate class=edge_denied step="POST /search/home/" status=403 server=AkamaiGHost',
    );
  });

  it('keep an odd Server header to a short safe token', () => {
    const err = new SenateHttpError('POST report/data/', 403, `AkamaiGHost\n<img src=x>${'z'.repeat(100)}`, {
      body: '<TITLE>Access Denied</TITLE>',
    });
    const reason = senateEdgeDenyReason(err);
    // Markup characters and the newline dropped, then cut to 40 characters.
    expect(reason).toBe(`senate POST report/data/ -> HTTP 403 (server=AkamaiGHostimg srcx${'z'.repeat(21)}) [edge_denied]`);
    expect(senateEdgeDenyReason(new SenateHttpError('GET /search/', 403, null, { body: '<TITLE>Access Denied</TITLE>' })))
      .toBe('senate GET /search/ -> HTTP 403 (server=unknown) [edge_denied]');
  });
});

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

  it('validates the record with a zod schema: malformed required fields read as no backoff', async () => {
    const kv = memoryKv();
    const env = { CONFIG_KV: kv } as unknown as Env;
    const good = nextSenateEdgeBackoff(null, NOW, REASON);
    const malformed: unknown[] = [
      { ...good, consecutive: '1' },
      { ...good, consecutive: 0 },
      { ...good, consecutive: 1.5 },
      { ...good, windowMs: -60_000 },
      { ...good, windowMs: null },
      { ...good, until: 12345 },
      { ...good, until: 'not a date' },
      [good],
      'a string',
      42,
    ];
    for (const value of malformed) {
      kv.store.set(SENATE_EDGE_BACKOFF_KV_KEY, JSON.stringify(value));
      expect(await readSenateEdgeBackoff(env), JSON.stringify(value)).toBeNull();
    }
  });

  it('drops unknown fields and lets a bad optional field fall back on its own', async () => {
    const kv = memoryKv();
    const env = { CONFIG_KV: kv } as unknown as Env;
    const good = nextSenateEdgeBackoff(null, NOW, REASON);
    kv.store.set(SENATE_EDGE_BACKOFF_KV_KEY, JSON.stringify({
      ...good,
      lastDeniedAt: 'yesterday',
      firstDeniedAt: 7,
      reason: { html: '<b>x</b>' },
      injected: '<script>',
    }));

    const read = await readSenateEdgeBackoff(env);

    expect(read).toEqual({
      consecutive: 1,
      firstDeniedAt: good.until,
      lastDeniedAt: good.until,
      windowMs: good.windowMs,
      until: good.until,
      reason: 'edge denied',
    });
    expect(read).not.toHaveProperty('injected');
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
