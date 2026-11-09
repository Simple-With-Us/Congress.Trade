import { describe, expect, it } from 'vitest';
import {
  evaluateSenateIntakeHealth,
  readSenateIntakeStatus,
  recordSenateIntake,
  SENATE_INTAKE_STALE_AFTER_MS,
  SENATE_INTAKE_STATUS_KV_KEY,
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

  it('warns when the relay has never heartbeated inside the 6am-10pm window', () => {
    const health = evaluateSenateIntakeHealth(null, new Date('2026-11-09T18:00:00.000Z'));
    expect(health).toMatchObject({ level: 'warning', seen: false, inWindow: true });
    expect(health.detail).toContain('never heartbeated');
    expect(health.detail).toContain('senate-intake:last');
  });

  it('stays quiet overnight when the relay has never been seen', () => {
    const health = evaluateSenateIntakeHealth(null, new Date('2026-11-09T09:00:00.000Z'));
    expect(health).toMatchObject({ level: 'ok', seen: false, inWindow: false });
    expect(health.detail).toContain('Quiet outside');
  });

  it('warns on a stale heartbeat inside the window and keeps a pre-close stale warning overnight', async () => {
    const { env } = memEnv();
    await recordSenateIntake(env, record('2026-11-09T16:00:00.000Z'));
    const midday = await readSenateIntakeStatus(env, new Date('2026-11-09T18:00:00.000Z'));
    expect(evaluateSenateIntakeHealth(midday, new Date('2026-11-09T18:00:00.000Z')).level).toBe('warning');

    await recordSenateIntake(env, record('2026-11-05T02:00:00.000Z'));
    const overnight = await readSenateIntakeStatus(env, new Date('2026-11-05T09:00:00.000Z'));
    const health = evaluateSenateIntakeHealth(overnight, new Date('2026-11-05T09:00:00.000Z'));
    expect(health.level).toBe('warning');
    expect(health.detail).toContain('already stale');
  });

  it('does not warn on a fresh in-window heartbeat or a healthy overnight gap', async () => {
    const { env } = memEnv();
    await recordSenateIntake(env, record('2026-11-09T17:50:00.000Z'));
    const fresh = await readSenateIntakeStatus(env, new Date('2026-11-09T18:00:00.000Z'));
    expect(evaluateSenateIntakeHealth(fresh, new Date('2026-11-09T18:00:00.000Z')).level).toBe('ok');

    await recordSenateIntake(env, record('2026-11-05T03:50:00.000Z'));
    const gap = await readSenateIntakeStatus(env, new Date('2026-11-05T09:00:00.000Z'));
    const health = evaluateSenateIntakeHealth(gap, new Date('2026-11-05T09:00:00.000Z'));
    expect(health.level).toBe('ok');
    expect(health.detail).toContain('Quiet outside');
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
