import { describe, expect, it } from 'vitest';
import {
  evaluateSenateFetcherHealth,
  readSenateFetcherRunStatus,
  readSenateIntakeStatus,
  recordSenateFetcherRun,
  recordSenateIntake,
  SENATE_FETCHER_RUN_KV_KEY,
  SENATE_INTAKE_STALE_AFTER_MS,
  SENATE_INTAKE_STATUS_KV_KEY,
  type SenateFetcherRunRecord,
  type SenateIntakeRecord,
} from '../senateIntakeStatus.ts';
import type { Env } from '../../shared/types.ts';

function memEnv(): { env: Env; kv: Map<string, string> } {
  const kv = new Map<string, string>();
  const CONFIG_KV = {
    async get(key: string, type?: string) {
      const v = kv.get(key);
      if (v == null) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      kv.set(key, value);
    },
  };
  return { env: { CONFIG_KV } as unknown as Env, kv };
}

function record(receivedAt: string): SenateIntakeRecord {
  return { receivedAt, received: 12, converted: 11, rejected: 1, newCount: 3, dryRun: false };
}

describe('senate intake relay heartbeat', () => {
  it('reads as never-run when no relay has called in', async () => {
    const { env } = memEnv();
    expect(await readSenateIntakeStatus(env)).toBeNull();
  });

  it('round-trips a recorded relay and computes freshness', async () => {
    const { env, kv } = memEnv();
    const at = new Date('2026-11-05T12:00:00.000Z');
    await recordSenateIntake(env, record(at.toISOString()));
    expect(kv.has(SENATE_INTAKE_STATUS_KV_KEY)).toBe(true);
    const status = await readSenateIntakeStatus(env, new Date(at.getTime() + 10 * 60_000));
    expect(status).toMatchObject({ received: 12, converted: 11, rejected: 1, newCount: 3, dryRun: false, stale: false });
    expect(status?.ageMs).toBe(10 * 60_000);
  });

  it('flags a relay silent past the stale threshold', async () => {
    const { env } = memEnv();
    const at = new Date('2026-11-05T12:00:00.000Z');
    await recordSenateIntake(env, record(at.toISOString()));
    const status = await readSenateIntakeStatus(env, new Date(at.getTime() + SENATE_INTAKE_STALE_AFTER_MS + 1));
    expect(status?.stale).toBe(true);
  });

  it('round-trips the failure marker', async () => {
    const { env } = memEnv();
    const at = new Date('2026-11-05T18:00:00.000Z');
    await recordSenateIntake(env, { ...record(at.toISOString()), failed: true });
    const status = await readSenateIntakeStatus(env, new Date(at.getTime() + 60_000));
    expect(status?.failed).toBe(true);
  });

  it('does not read overnight silence inside the fetcher window gap as stale', async () => {
    const { env } = memEnv();
    // Last relay 21:50 Mac time (Nov 4), read back at 03:00 Mac time.
    await recordSenateIntake(env, record('2026-11-05T03:50:00.000Z'));
    const status = await readSenateIntakeStatus(env, new Date('2026-11-05T09:00:00.000Z'));
    expect(status?.stale).toBe(false);
  });

  it('keeps a relay that went stale before the window closed stale overnight', async () => {
    const { env } = memEnv();
    // Last relay 20:00 Mac time (Nov 4) — already past the threshold by the
    // 22:00 close — read back at 03:00 Mac time.
    await recordSenateIntake(env, record('2026-11-05T02:00:00.000Z'));
    const status = await readSenateIntakeStatus(env, new Date('2026-11-05T09:00:00.000Z'));
    expect(status?.stale).toBe(true);
  });

  it('applies the threshold from the 06:00 window open, not from the last evening relay', async () => {
    const { env } = memEnv();
    await recordSenateIntake(env, record('2026-11-05T03:50:00.000Z'));
    // 06:30 Mac time: two missed runs, still inside the grace.
    const early = await readSenateIntakeStatus(env, new Date('2026-11-05T12:30:00.000Z'));
    expect(early?.stale).toBe(false);
    // 06:46 Mac time: past the threshold measured from the open.
    const later = await readSenateIntakeStatus(env, new Date('2026-11-05T12:46:00.000Z'));
    expect(later?.stale).toBe(true);
  });

  it('reads a malformed record as never-run', async () => {
    const { env, kv } = memEnv();
    kv.set(SENATE_INTAKE_STATUS_KV_KEY, JSON.stringify({ receivedAt: 'x', received: 'many' }));
    expect(await readSenateIntakeStatus(env)).toBeNull();
  });

  it('never throws into the intake path when KV is absent or failing', async () => {
    const bare = {} as unknown as Env;
    await expect(recordSenateIntake(bare, record(new Date().toISOString()))).resolves.toBeUndefined();
    expect(await readSenateIntakeStatus(bare)).toBeNull();
    const failing = {
      CONFIG_KV: {
        async get() { throw new Error('kv down'); },
        async put() { throw new Error('kv down'); },
      },
    } as unknown as Env;
    await expect(recordSenateIntake(failing, record(new Date().toISOString()))).resolves.toBeUndefined();
    expect(await readSenateIntakeStatus(failing)).toBeNull();
  });
});

describe('senate fetcher run heartbeat', () => {
  function runRecord(ranAt: string, receivedAt = ranAt): SenateFetcherRunRecord {
    return { ranAt, receivedAt, status: 'ok', rows: 7, newCount: 0, role: 'agents' };
  }

  it('reads as no-runs when the fetcher has never reported', async () => {
    const { env } = memEnv();
    expect(await readSenateFetcherRunStatus(env)).toBeNull();
  });

  it('round-trips a recorded run and computes freshness from receipt', async () => {
    const { env, kv } = memEnv();
    const at = new Date('2026-11-05T12:00:00.000Z');
    await recordSenateFetcherRun(env, runRecord(at.toISOString()));
    expect(kv.has(SENATE_FETCHER_RUN_KV_KEY)).toBe(true);
    const status = await readSenateFetcherRunStatus(env, new Date(at.getTime() + 10 * 60_000));
    expect(status).toMatchObject({ status: 'ok', rows: 7, newCount: 0, role: 'agents', stale: false });
    expect(status?.ageMs).toBe(10 * 60_000);
  });

  it('flags a fetcher silent past the stale threshold', async () => {
    const { env } = memEnv();
    const at = new Date('2026-11-05T12:00:00.000Z');
    await recordSenateFetcherRun(env, runRecord(at.toISOString()));
    const status = await readSenateFetcherRunStatus(env, new Date(at.getTime() + SENATE_INTAKE_STALE_AFTER_MS + 1));
    expect(status?.stale).toBe(true);
  });

  it('round-trips blocked runs from the standby copy', async () => {
    const { env } = memEnv();
    const at = new Date('2026-11-05T18:00:00.000Z');
    await recordSenateFetcherRun(env, { ...runRecord(at.toISOString()), status: 'blocked', rows: 0, role: 'jay' });
    const status = await readSenateFetcherRunStatus(env, new Date(at.getTime() + 60_000));
    expect(status).toMatchObject({ status: 'blocked', rows: 0, role: 'jay' });
  });

  it('keeps runs and deliveries apart: a run is not a delivery', async () => {
    const { env, kv } = memEnv();
    await recordSenateFetcherRun(env, runRecord(new Date().toISOString()));
    expect(kv.has(SENATE_FETCHER_RUN_KV_KEY)).toBe(true);
    expect(kv.has(SENATE_INTAKE_STATUS_KV_KEY)).toBe(false);
    expect(await readSenateIntakeStatus(env)).toBeNull();
  });

  it('keeps runs and deliveries apart: a delivery is not a run', async () => {
    const { env, kv } = memEnv();
    await recordSenateIntake(env, record(new Date().toISOString()));
    expect(kv.has(SENATE_INTAKE_STATUS_KV_KEY)).toBe(true);
    expect(kv.has(SENATE_FETCHER_RUN_KV_KEY)).toBe(false);
    expect(await readSenateFetcherRunStatus(env)).toBeNull();
  });

  it('rejects malformed run records instead of rendering them', async () => {
    const { env, kv } = memEnv();
    const at = new Date().toISOString();
    kv.set(SENATE_FETCHER_RUN_KV_KEY, JSON.stringify({ ...runRecord(at), status: 'weird' }));
    expect(await readSenateFetcherRunStatus(env)).toBeNull();
    kv.set(SENATE_FETCHER_RUN_KV_KEY, JSON.stringify({ ...runRecord(at), role: 'nobody' }));
    expect(await readSenateFetcherRunStatus(env)).toBeNull();
    kv.set(SENATE_FETCHER_RUN_KV_KEY, JSON.stringify({ ...runRecord(at), rows: '7' }));
    expect(await readSenateFetcherRunStatus(env)).toBeNull();
  });

  it('treats the run heartbeat as best-effort when KV is down', async () => {
    const failing = {
      CONFIG_KV: {
        async get() { throw new Error('kv down'); },
        async put() { throw new Error('kv down'); },
      },
    } as unknown as Env;
    await expect(recordSenateFetcherRun(failing, runRecord(new Date().toISOString()))).resolves.toBeUndefined();
    expect(await readSenateFetcherRunStatus(failing)).toBeNull();
  });

  it('warns when no run has been reported inside the 6am-10pm window', () => {
    const health = evaluateSenateFetcherHealth(null, new Date('2026-11-09T18:00:00.000Z'));
    expect(health).toMatchObject({ level: 'warning', seen: false, inWindow: true });
    expect(health.detail).toContain('has not reported a run');
    expect(health.detail).toContain('senate-fetcher:last-run');
  });

  it('stays quiet overnight when no run has been reported', () => {
    const health = evaluateSenateFetcherHealth(null, new Date('2026-11-09T09:00:00.000Z'));
    expect(health).toMatchObject({ level: 'ok', seen: false, inWindow: false });
    expect(health.detail).toContain('Quiet outside');
  });

  it('does not warn on a fresh run with zero new rows, even when no delivery exists', async () => {
    const { env } = memEnv();
    const now = new Date('2026-11-09T18:00:00.000Z');
    await recordSenateFetcherRun(env, runRecord('2026-11-09T17:50:00.000Z'));
    const run = await readSenateFetcherRunStatus(env, now);
    const health = evaluateSenateFetcherHealth(run, now);
    expect(await readSenateIntakeStatus(env, now)).toBeNull();
    expect(health.level).toBe('ok');
    expect(health.detail).toContain('0 new rows');
    expect(health.detail).toContain('not a missed run');
  });

  it('warns on a stale run inside the window and keeps a pre-close stale warning overnight', async () => {
    const { env } = memEnv();
    await recordSenateFetcherRun(env, runRecord('2026-11-09T16:00:00.000Z'));
    const midday = await readSenateFetcherRunStatus(env, new Date('2026-11-09T18:00:00.000Z'));
    expect(evaluateSenateFetcherHealth(midday, new Date('2026-11-09T18:00:00.000Z')).level).toBe('warning');

    await recordSenateFetcherRun(env, runRecord('2026-11-05T02:00:00.000Z'));
    const overnight = await readSenateFetcherRunStatus(env, new Date('2026-11-05T09:00:00.000Z'));
    const health = evaluateSenateFetcherHealth(overnight, new Date('2026-11-05T09:00:00.000Z'));
    expect(health.level).toBe('warning');
    expect(health.detail).toContain('already stale');
  });
});
