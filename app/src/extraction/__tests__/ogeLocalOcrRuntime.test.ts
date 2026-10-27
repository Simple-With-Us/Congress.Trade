import { describe, expect, it } from 'vitest';
import { createDenoLocalOcrBackend } from '../ogeLocalOcrRuntime.ts';

// The runtime module only touches Deno APIs inside functions, so importing it
// under Node (vitest) is safe.  Under Node there is no Deno runtime, so every
// probe fails fast — which is exactly the shape needed to pin the caching
// policy: failures must be re-probed, never served from a permanent cache.

describe('ogeLocalOcrRuntime probe caching', () => {
  it('does not permanently cache a failed probe', async () => {
    const backend = createDenoLocalOcrBackend();
    const first = await backend.probe();
    const second = await backend.probe();

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    // A cached failure would return the same object; distinct objects prove
    // the second call re-probed instead of replaying the first failure.
    expect(second).not.toBe(first);
  });
});
