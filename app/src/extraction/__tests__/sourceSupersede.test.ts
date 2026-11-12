import { describe, expect, it } from 'vitest';
import {
  canSupersedeResolvedVision,
  isVisionTxSource,
  supersededPipelineSourcesSql,
} from '../sourceSupersede.ts';

describe('sourceSupersede', () => {
  it('retires primary/manual/server_cpu when local_mac publishes', () => {
    expect(isVisionTxSource('local_mac')).toBe(true);
    expect(supersededPipelineSourcesSql('local_mac')).toBe("'primary', 'manual', 'server_cpu'");
    expect(supersededPipelineSourcesSql('primary')).toBeNull();
  });

  it('allows a larger vision set to replace a truncated confirm on a resolved filing', () => {
    expect(canSupersedeResolvedVision({
      incomingSource: 'local_mac',
      incomingCount: 361,
      incomingDatedCount: 361,
      liveSameSource: 0,
      liveOther: 209,
      liveOtherDated: 209,
    })).toBe(true);
  });

  it('does not insert a second vision set when local_mac is already live', () => {
    expect(canSupersedeResolvedVision({
      incomingSource: 'local_mac',
      incomingCount: 361,
      incomingDatedCount: 361,
      liveSameSource: 361,
      liveOther: 209,
      liveOtherDated: 209,
    })).toBe(false);
  });

  it('does not clobber a resolved confirm with a smaller vision read', () => {
    expect(canSupersedeResolvedVision({
      incomingSource: 'local_mac',
      incomingCount: 12,
      incomingDatedCount: 12,
      liveSameSource: 0,
      liveOther: 209,
      liveOtherDated: 209,
    })).toBe(false);
  });

  it('does not retire a dated confirm because placeholder dates padded the incoming count', () => {
    expect(canSupersedeResolvedVision({
      incomingSource: 'local_mac',
      incomingCount: 361,
      incomingDatedCount: 180,
      liveSameSource: 0,
      liveOther: 209,
      liveOtherDated: 209,
    })).toBe(false);
  });
});
