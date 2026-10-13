import { describe, expect, it, vi } from 'vitest';
import {
  isMaintenanceLaneTimeout,
  MaintenanceLaneTimeoutError,
  raceMaintenanceLane,
} from '../maintenanceLaneTimeout.ts';

describe('raceMaintenanceLane', () => {
  it('returns the lane result when it finishes inside the budget', async () => {
    const value = await raceMaintenanceLane('watcher', 500, async () => 42);
    expect(value).toBe(42);
  });

  it('rejects with MaintenanceLaneTimeoutError when the lane exceeds the budget', async () => {
    const started = Date.now();
    await expect(
      raceMaintenanceLane('secrets_refresh', 40, () => new Promise((resolve) => {
        setTimeout(() => resolve('late'), 200);
      })),
    ).rejects.toMatchObject({ lane: 'secrets_refresh', timeoutMs: 40 });
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('classifies timeout errors', async () => {
    const err = new MaintenanceLaneTimeoutError('apns_fanout', 1000);
    expect(isMaintenanceLaneTimeout(err)).toBe(true);
    expect(isMaintenanceLaneTimeout(new Error('other'))).toBe(false);
  });
});
