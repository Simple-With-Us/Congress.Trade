import { describe, expect, it } from 'vitest';
import { costProfilePublicSummary, resolveDenoCostProfile } from '../costProfile.ts';

describe('resolveDenoCostProfile', () => {
  it('defaults to aggressive live knobs when unset', () => {
    const p = resolveDenoCostProfile({});
    expect(p.name).toBe('live');
    expect(p.cronSchedule).toBe('* * * * *');
    expect(p.drainLimit).toBe(25);
    expect(p.drainClaimSize).toBe(10);
    expect(p.outboxLimit).toBe(100);
    expect(p.disableInternalCron).toBe(false);
    expect(p.idleShortCircuit).toBe(true);
  });

  it('ignores leftover CT_COST_PROFILE and DENO_COST_PROFILE names', () => {
    const p = resolveDenoCostProfile({
      CT_COST_PROFILE: 'free',
      DENO_COST_PROFILE: 'balanced',
    });
    expect(p.name).toBe('live');
    expect(p.cronSchedule).toBe('* * * * *');
    expect(p.drainLimit).toBe(25);
  });

  it('allows per-knob overrides via CT_*', () => {
    const p = resolveDenoCostProfile({
      CT_CRON_SCHEDULE: '*/10 * * * *',
      CT_DRAIN_LIMIT: '7',
      CT_DRAIN_CLAIM_SIZE: '2',
      CT_OUTBOX_LIMIT: '15',
      CT_DISABLE_INTERNAL_CRON: 'true',
      CT_FORCE_FULL_TICK: '1',
    });
    expect(p.cronSchedule).toBe('*/10 * * * *');
    expect(p.drainLimit).toBe(7);
    expect(p.drainClaimSize).toBe(2);
    expect(p.outboxLimit).toBe(15);
    expect(p.disableInternalCron).toBe(true);
    expect(p.idleShortCircuit).toBe(false);
  });

  it('still accepts legacy DENO_* knob aliases for local tests', () => {
    const p = resolveDenoCostProfile({ DENO_CRON_SCHEDULE: '*/3 * * * *' });
    expect(p.cronSchedule).toBe('*/3 * * * *');
    expect(p.name).toBe('live');
  });

  it('clamps absurd overrides to live fallbacks', () => {
    const p = resolveDenoCostProfile({
      CT_DRAIN_LIMIT: '9999',
      CT_DRAIN_CLAIM_SIZE: '0',
      CT_OUTBOX_LIMIT: '-3',
    });
    expect(p.drainLimit).toBe(100);
    expect(p.drainClaimSize).toBe(10);
    expect(p.outboxLimit).toBe(100);
  });

  it('exposes a public summary without secrets', () => {
    const s = costProfilePublicSummary(resolveDenoCostProfile({}));
    expect(s).toMatchObject({ name: 'live', cronSchedule: '* * * * *', drainLimit: 25 });
  });
});
