import { describe, expect, it } from 'vitest';
import {
  LITESTREAM_REPLICATING_MAX_AGE_SEC,
  readLocalLitestreamAge,
} from '../litestreamAge.ts';

describe('readLocalLitestreamAge', () => {
  it('keeps the health threshold above the 15m sync-interval', () => {
    expect(LITESTREAM_REPLICATING_MAX_AGE_SEC).toBeGreaterThan(15 * 60);
    expect(LITESTREAM_REPLICATING_MAX_AGE_SEC).toBe(30 * 60);
  });

  it('returns unknown when the LTX dir is missing (Node tests have no Deno fs)', async () => {
    const result = await readLocalLitestreamAge('/tmp/ct-ltx-does-not-exist');
    expect(result.litestreamStatus).toBe('unknown');
    expect(result.litestreamAgeSeconds).toBeNull();
  });
});
