import { describe, expect, it } from 'vitest';
import {
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
