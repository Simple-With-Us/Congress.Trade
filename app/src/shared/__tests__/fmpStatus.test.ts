import { describe, it, expect } from 'vitest';
import { assertFmpTierOk, FMP_TIER_FAIL_STATUSES } from '../fmpStatus.ts';

describe('assertFmpTierOk', () => {
  it('throws a tagged error for key/plan statuses', () => {
    for (const s of FMP_TIER_FAIL_STATUSES) {
      expect(() => assertFmpTierOk(s)).toThrow('FMP_HTTP_' + s);
    }
  });

  it('is a no-op for "no data" / server statuses (404, 500, 200)', () => {
    expect(() => assertFmpTierOk(404)).not.toThrow();
    expect(() => assertFmpTierOk(500)).not.toThrow();
    expect(() => assertFmpTierOk(200)).not.toThrow();
  });
});

