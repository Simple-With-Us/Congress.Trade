import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { D1DatabaseShim } from '../shims.ts';
import { runMaintenancePipeline } from '../scheduledTick.ts';

vi.mock('../../secrets/infisical.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../secrets/infisical.ts')>();
  return {
    ...actual,
    refreshSecrets: vi.fn(() => new Promise(() => {})),
  };
});
vi.mock('../../ingestion/watcher.ts', () => ({
  runWatcher: vi.fn(async () => ({ polled: 0 })),
}));
vi.mock('../../extraction/agreement.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../extraction/agreement.ts')>();
  return {
    ...actual,
    maybeRunAgreementAutopublish: vi.fn(async () => null),
  };
});
vi.mock('../../extraction/autopilot.ts', () => ({
  maybeStartBacklogAutopilot: vi.fn(async () => null),
}));
vi.mock('#sentry', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

import { refreshSecrets } from '../../secrets/infisical.ts';
import { runWatcher } from '../../ingestion/watcher.ts';
import { captureMessage } from '#sentry';

async function makeEnv(): Promise<Env> {
  const client = createClient({ url: 'file::memory:' });
  await client.execute(`
    CREATE TABLE deno_runtime_kv (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (namespace, key)
    )
  `);
  return { DB: new D1DatabaseShim(client) } as Env;
}

describe('runMaintenancePipeline lane timeouts', () => {
  beforeEach(() => {
    vi.mocked(refreshSecrets).mockClear();
    vi.mocked(runWatcher).mockClear();
    vi.mocked(captureMessage).mockClear();
  });

  it('isolates a hung secrets_refresh lane and continues to watcher', async () => {
    const env = await makeEnv();
    const result = await runMaintenancePipeline(env, {
      outboxLimit: 5,
      laneTimeoutMs: { secrets_refresh: 30 },
    });
    expect(result.errors.some((e) => e.startsWith('secrets_refresh: timed out'))).toBe(true);
    expect(result.aborted).toBe(false);
    expect(runWatcher).toHaveBeenCalled();
    expect(captureMessage).toHaveBeenCalled();
  }, 10_000);
});
