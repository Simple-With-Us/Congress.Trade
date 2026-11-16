import { describe, expect, it } from 'vitest';
import type { Env } from '../../shared/types.ts';
import {
  BenchmarkSettingsConflictError,
  BenchmarkSettingsValidationError,
  BenchmarkSettingsWriteError,
  benchmarkModelCatalog,
  benchmarkSelectableCatalog,
  readBenchmarkLineupSettings,
  readBenchmarkRoleSettings,
  saveBenchmarkLineupSettings,
  saveBenchmarkRoleSettings,
  validateBenchmarkLineup,
  validateBenchmarkRoles,
} from '../settings.ts';

describe('benchmarkModelCatalog vs benchmarkSelectableCatalog', () => {
  it('keeps NON_OFFERED_CANDIDATES valid for save/decode while excluding them from the offered UI catalog', () => {
    const fullKeys = benchmarkModelCatalog().map((m) => `${m.provider}:${m.model}`);
    const offeredKeys = benchmarkSelectableCatalog().map((m) => `${m.provider}:${m.model}`);

    // The full catalog (used by validateBenchmarkModel to gate save/decode)
    // must still accept these — a regression that silently dropped
    // NON_OFFERED_CANDIDATES here would reject historical config/runs with no
    // other test signal (see 2026-07-19 review finding).
    for (const key of [
      'openrouter:openrouter/auto',
      'openrouter:openai/gpt-5.6-terra-pro',
      'openrouter:openai/gpt-5.6-sol',
    ]) {
      expect(fullKeys).toContain(key);
      expect(offeredKeys).not.toContain(key);
    }
  });

  it('excludes direct-provider LEGACY_CANDIDATES (no API key) from the offered UI catalog but keeps them in the full catalog', () => {
    const fullKeys = benchmarkModelCatalog().map((m) => `${m.provider}:${m.model}`);
    const offeredKeys = benchmarkSelectableCatalog().map((m) => `${m.provider}:${m.model}`);

    for (const key of [
      'openai:gpt-5.6-terra',
      'gemini:gemini-3.5-flash',
      'anthropic:claude-sonnet-5',
      'mistral:mistral-ocr-latest',
      'xai:grok-4.3',
    ]) {
      expect(fullKeys).toContain(key);
      expect(offeredKeys).not.toContain(key);
    }
  });
});

const OLD = {
  a: 'mistral:mistral-ocr-latest',
  b: 'openrouter:openai/gpt-5.6-terra',
  c: 'openrouter:anthropic/claude-sonnet-5',
};

const NEW = {
  a: { provider: 'openrouter', model: 'openai/gpt-5.6-terra' },
  b: { provider: 'openrouter', model: 'google/gemini-3.8-flash' },
  c: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' },
};

const OLD_ROLES = {
  primary: 'mistral:mistral-ocr-latest',
  failover: 'openrouter:openai/gpt-5.6-terra',
};

const NEW_ROLES = {
  primary: { provider: 'openrouter', model: 'openai/gpt-5.6-terra' },
  failover: { provider: 'openrouter', model: 'google/gemini-3.8-flash' },
};

function dependencies(state: Record<string, string>, options: { failOnce?: string } = {}) {
  let failed = false;
  return {
    resolve: async (_env: Env, keys: string[]) => Object.fromEntries(
      keys.map((key) => [key, state[key]]),
    ),
    readSource: async () => Object.fromEntries(
      Object.entries(state).filter(([key]) => key.startsWith('AGREEMENT_HOUSE_MODEL_')
        || key.startsWith('AGREEMENT_SENATE_MODEL_')
        || key.startsWith('AGREEMENT_EXEC_MODEL_')),
    ),
    configuredKey: async () => 'configured-key',
    write: async (_env: Env, _source: 'app' | 'shared', key: string, value: string) => {
      if (!failed && options.failOnce === key) {
        failed = true;
        throw new Error('simulated Infisical write failure');
      }
      state[key] = value;
    },
    remove: async (_env: Env, _source: 'app' | 'shared', key: string) => {
      delete state[key];
    },
    refresh: async () => ({}),
  };
}

/** The agreement trio now lives at the C/D/E keys (A/B are the primary/failover roles). */
function initialState(chamber: 'house' | 'senate' | 'executive' = 'house'): Record<string, string> {
  const prefix = chamber === 'house' ? 'HOUSE' : chamber === 'senate' ? 'SENATE' : 'EXEC';
  return {
    [`AGREEMENT_${prefix}_MODEL_C`]: OLD.a,
    [`AGREEMENT_${prefix}_MODEL_D`]: OLD.b,
    [`AGREEMENT_${prefix}_MODEL_E`]: OLD.c,
  };
}

function initialRoleState(chamber: 'house' | 'senate' | 'executive' = 'house'): Record<string, string> {
  const prefix = chamber === 'house' ? 'HOUSE' : chamber === 'senate' ? 'SENATE' : 'EXEC';
  return {
    [`AGREEMENT_${prefix}_MODEL_A`]: OLD_ROLES.primary,
    [`AGREEMENT_${prefix}_MODEL_B`]: OLD_ROLES.failover,
  };
}

describe('benchmark lineup settings', () => {
  it('reads the explicit chamber lineup and reports credential availability without values', async () => {
    const env = {
      ...initialState(),
      OPENAI_API_KEY: 'openai-key',
      MISTRAL_API_KEY: 'mistral-key',
      ANTHROPIC_API_KEY: 'anthropic-key',
      OPENROUTER_API_KEY: 'openrouter-key',
    } as unknown as Env;
    const settings = await readBenchmarkLineupSettings(env, 'house');
    expect(settings.lineup).toEqual({
      a: { provider: 'mistral', model: 'mistral-ocr-latest' },
      b: { provider: 'openrouter', model: 'openai/gpt-5.6-terra' },
      c: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' },
    });
    expect(settings.valid).toBe(true);
    expect(settings.version).toMatch(/^[a-f0-9]{64}$/);
    expect(settings.catalog.find((model) => model.provider === 'openrouter' && model.model.startsWith('openai'))).toMatchObject({
      configured: true,
    });
    expect(JSON.stringify(settings)).not.toContain('openai-key');
  });

  it('does not invent a lineup when a chamber has no explicit model keys', async () => {
    const settings = await readBenchmarkLineupSettings({} as Env, 'house', dependencies({}) as never);
    expect(settings.lineup).toBeNull();
    expect(settings.valid).toBe(false);
  });

  it('allows a lineup of distinct models from the same transport/vendor', () => {
    const lineup = validateBenchmarkLineup({
      a: { provider: 'openrouter', model: 'openai/gpt-5.6-terra' },
      b: { provider: 'openrouter', model: 'openai/gpt-5.6-luna' },
      c: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' },
    });
    expect(lineup.a.model).toBe('openai/gpt-5.6-terra');
    expect(lineup.b.model).toBe('openai/gpt-5.6-luna');
  });

  it('writes all three chamber keys and verifies readback', async () => {
    const state = initialState();
    const deps = dependencies(state);
    const current = await readBenchmarkLineupSettings({} as Env, 'senate', deps as never);
    const saved = await saveBenchmarkLineupSettings({} as Env, {
      chamber: 'senate',
      ...NEW,
      expectedVersion: current.version,
    }, deps as never);

    expect(saved.settings.lineup).toEqual(NEW);
    expect(saved.audit).toMatchObject({
      readbackVerified: true,
      rollbackAttempted: false,
      writtenKeys: [
        'AGREEMENT_SENATE_MODEL_C',
        'AGREEMENT_SENATE_MODEL_D',
        'AGREEMENT_SENATE_MODEL_E',
      ],
    });
    expect(state.AGREEMENT_SENATE_MODEL_C).toBe('openrouter:openai/gpt-5.6-terra');
    expect(state.AGREEMENT_SENATE_MODEL_D).toBe('openrouter:google/gemini-3.8-flash');
    expect(state.AGREEMENT_SENATE_MODEL_E).toBe('openrouter:anthropic/claude-sonnet-5');
  });

  it('supports the first-ever chamber save when no effective lineup exists', async () => {
    const state: Record<string, string> = {};
    const deps = dependencies(state);
    const current = await readBenchmarkLineupSettings({} as Env, 'house', deps as never);
    expect(current).toMatchObject({ lineup: null, valid: false });

    const saved = await saveBenchmarkLineupSettings({} as Env, {
      chamber: 'house',
      ...NEW,
      expectedVersion: current.version,
    }, deps as never);

    expect(saved.settings).toMatchObject({ lineup: NEW, valid: true });
    expect(saved.audit).toMatchObject({ readbackVerified: true, rollbackAttempted: false });
    expect(state.AGREEMENT_HOUSE_MODEL_C).toBe('openrouter:openai/gpt-5.6-terra');
    expect(state.AGREEMENT_HOUSE_MODEL_D).toBe('openrouter:google/gemini-3.8-flash');
    expect(state.AGREEMENT_HOUSE_MODEL_E).toBe('openrouter:anthropic/claude-sonnet-5');
  });

  it('rolls back a partial write without pinning inherited branch overrides', async () => {
    const state = initialState();
    const deps = dependencies(state, { failOnce: 'AGREEMENT_EXEC_MODEL_D' });
    const current = await readBenchmarkLineupSettings({} as Env, 'executive', deps as never);

    let thrown: unknown;
    try {
      await saveBenchmarkLineupSettings({} as Env, {
        chamber: 'executive',
        ...NEW,
        expectedVersion: current.version,
      }, deps as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BenchmarkSettingsWriteError);
    expect((thrown as BenchmarkSettingsWriteError).audit).toMatchObject({
      rollbackAttempted: true,
      rollbackVerified: true,
    });
    expect(state.AGREEMENT_EXEC_MODEL_C).toBeUndefined();
    expect(state.AGREEMENT_EXEC_MODEL_D).toBeUndefined();
    expect(state.AGREEMENT_EXEC_MODEL_E).toBeUndefined();
  });

  it('verifies exact rollback to missing source values when no fallback lineup exists', async () => {
    const state: Record<string, string> = {};
    const deps = dependencies(state, { failOnce: 'AGREEMENT_HOUSE_MODEL_D' });
    const current = await readBenchmarkLineupSettings({} as Env, 'house', deps as never);

    let thrown: unknown;
    try {
      await saveBenchmarkLineupSettings({} as Env, {
        chamber: 'house',
        ...NEW,
        expectedVersion: current.version,
      }, deps as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BenchmarkSettingsWriteError);
    expect((thrown as BenchmarkSettingsWriteError).audit).toMatchObject({
      rollbackAttempted: true,
      rollbackVerified: true,
      previousVersion: current.version,
    });
    expect(state.AGREEMENT_HOUSE_MODEL_C).toBeUndefined();
    expect(state.AGREEMENT_HOUSE_MODEL_D).toBeUndefined();
    expect(state.AGREEMENT_HOUSE_MODEL_E).toBeUndefined();
  });

  it('rejects a stale optimistic version before any write', async () => {
    const state: Record<string, string> = {};
    const deps = dependencies(state);
    await expect(saveBenchmarkLineupSettings({} as Env, {
      chamber: 'house',
      ...NEW,
      expectedVersion: 'stale-version',
    }, deps as never)).rejects.toBeInstanceOf(BenchmarkSettingsConflictError);
    expect(state.AGREEMENT_HOUSE_MODEL_C).toBeUndefined();
  });

  it('checks the lease fence before each write and refuses stale rollback', async () => {
    const state = initialState();
    const deps = dependencies(state, { failOnce: 'AGREEMENT_HOUSE_MODEL_D' });
    const current = await readBenchmarkLineupSettings({} as Env, 'house', deps as never);
    let fenceChecks = 0;

    let thrown: unknown;
    try {
      await saveBenchmarkLineupSettings({} as Env, {
        chamber: 'house',
        ...NEW,
        expectedVersion: current.version,
      }, deps as never, {
        assertLease: async () => {
          fenceChecks += 1;
          if (fenceChecks >= 3) throw new Error('lease replaced by successor');
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BenchmarkSettingsWriteError);
    expect((thrown as BenchmarkSettingsWriteError).audit).toMatchObject({
      writtenKeys: ['AGREEMENT_HOUSE_MODEL_C'],
      rollbackAttempted: true,
      rollbackVerified: false,
    });
    expect(fenceChecks).toBe(3);
    // The stale writer leaves its partial value for the live owner to reconcile;
    // critically, it does not delete or overwrite the successor's keyspace.
    expect(state.AGREEMENT_HOUSE_MODEL_C).toBe('openrouter:openai/gpt-5.6-terra');
  });

  it('aborts a timed-out Infisical mutation before the lease can expire', async () => {
    const state = initialState();
    let firstWrite = true;
    let aborted = false;
    const deps = {
      ...dependencies(state),
      write: async (
        _env: Env,
        _source: 'app' | 'shared',
        key: string,
        value: string,
        options?: { signal?: AbortSignal },
      ) => {
        if (!firstWrite) {
          state[key] = value;
          return;
        }
        firstWrite = false;
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          }, { once: true });
        });
      },
    };
    const current = await readBenchmarkLineupSettings({} as Env, 'house', deps as never);

    await expect(saveBenchmarkLineupSettings({} as Env, {
      chamber: 'house',
      ...NEW,
      expectedVersion: current.version,
    }, deps as never, {
      operationTimeoutMs: 1_000,
      assertLease: async () => undefined,
    })).rejects.toBeInstanceOf(BenchmarkSettingsWriteError);
    expect(aborted).toBe(true);
  });
});

describe('benchmark primary/failover role settings', () => {
  it('reads the explicit chamber roles and reports credential availability without values', async () => {
    const env = {
      ...initialRoleState(),
      OPENAI_API_KEY: 'openai-key',
      MISTRAL_API_KEY: 'mistral-key',
    } as unknown as Env;
    const settings = await readBenchmarkRoleSettings(env, 'house');
    expect(settings.roles).toEqual({
      primary: { provider: 'mistral', model: 'mistral-ocr-latest' },
      failover: { provider: 'openrouter', model: 'openai/gpt-5.6-terra' },
    });
    expect(settings.valid).toBe(true);
    expect(settings.version).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(settings)).not.toContain('openai-key');
  });

  it('does not invent roles when a chamber has no explicit model keys', async () => {
    const settings = await readBenchmarkRoleSettings({} as Env, 'house', dependencies({}) as never);
    expect(settings.roles).toBeNull();
    expect(settings.valid).toBe(false);
  });

  it('rejects a primary/failover pair sharing the exact same model', () => {
    expect(() => validateBenchmarkRoles({
      primary: { provider: 'openrouter', model: 'openai/gpt-5.6-terra' },
      failover: { provider: 'openrouter', model: 'openai/gpt-5.6-terra' },
    })).toThrow(BenchmarkSettingsValidationError);
  });

  it('allows primary/failover on the same transport with different models', () => {
    const roles = validateBenchmarkRoles({
      primary: { provider: 'openrouter', model: 'openai/gpt-5.6-terra' },
      failover: { provider: 'openrouter', model: 'openai/gpt-5.6-luna' },
    });
    expect(roles.failover.model).toBe('openai/gpt-5.6-luna');
  });

  it('writes both chamber role keys and verifies readback', async () => {
    const state = initialRoleState();
    const deps = dependencies(state);
    const current = await readBenchmarkRoleSettings({} as Env, 'senate', deps as never);
    const saved = await saveBenchmarkRoleSettings({} as Env, {
      chamber: 'senate',
      ...NEW_ROLES,
      expectedVersion: current.version,
    }, deps as never);

    expect(saved.settings.roles).toEqual(NEW_ROLES);
    expect(saved.audit).toMatchObject({
      readbackVerified: true,
      rollbackAttempted: false,
      writtenKeys: ['AGREEMENT_SENATE_MODEL_A', 'AGREEMENT_SENATE_MODEL_B'],
    });
    expect(state.AGREEMENT_SENATE_MODEL_A).toBe('openrouter:openai/gpt-5.6-terra');
    expect(state.AGREEMENT_SENATE_MODEL_B).toBe('openrouter:google/gemini-3.8-flash');
  });

  it('rejects a stale optimistic version before any write', async () => {
    const state: Record<string, string> = {};
    const deps = dependencies(state);
    await expect(saveBenchmarkRoleSettings({} as Env, {
      chamber: 'house',
      ...NEW_ROLES,
      expectedVersion: 'stale-version',
    }, deps as never)).rejects.toBeInstanceOf(BenchmarkSettingsConflictError);
    expect(state.AGREEMENT_HOUSE_MODEL_A).toBeUndefined();
  });

  it('verifies exact rollback to missing source values when no fallback roles exist', async () => {
    const state: Record<string, string> = {};
    const deps = dependencies(state, { failOnce: 'AGREEMENT_HOUSE_MODEL_B' });
    const current = await readBenchmarkRoleSettings({} as Env, 'house', deps as never);

    let thrown: unknown;
    try {
      await saveBenchmarkRoleSettings({} as Env, {
        chamber: 'house',
        ...NEW_ROLES,
        expectedVersion: current.version,
      }, deps as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BenchmarkSettingsWriteError);
    expect((thrown as BenchmarkSettingsWriteError).audit).toMatchObject({
      rollbackAttempted: true,
      rollbackVerified: true,
      previousVersion: current.version,
    });
    expect(state.AGREEMENT_HOUSE_MODEL_A).toBeUndefined();
    expect(state.AGREEMENT_HOUSE_MODEL_B).toBeUndefined();
  });
});

describe('benchmark catalogs', () => {
  it('correctly filters selectable catalog and retains all in model catalog', () => {
    const selectable = benchmarkSelectableCatalog();
    const full = benchmarkModelCatalog();

    // Selectable catalog must not contain direct providers
    const directSelectable = selectable.filter(
      (m: any) => ['openai', 'gemini', 'anthropic', 'xai', 'mistral'].includes(m.provider)
    );
    expect(directSelectable).toEqual([]);

    // Selectable catalog must not contain openrouter/auto
    const autoSelectable = selectable.filter(
      (m: any) => m.provider === 'openrouter' && m.model === 'openrouter/auto'
    );
    expect(autoSelectable).toEqual([]);

    // Selectable catalog must not contain terra-pro or sol
    const highCostSelectable = selectable.filter(
      (m: any) => m.provider === 'openrouter' && ['openai/gpt-5.6-terra-pro', 'openai/gpt-5.6-sol'].includes(m.model)
    );
    expect(highCostSelectable).toEqual([]);

    // Full catalog must contain them for replayability
    expect(full.some((m: any) => m.provider === 'openai' && m.model === 'gpt-5.6-terra')).toBe(true);
    expect(full.some((m: any) => m.provider === 'gemini' && m.model === 'gemini-3.5-flash')).toBe(true);
    expect(full.some((m: any) => m.provider === 'openrouter' && m.model === 'openrouter/auto')).toBe(true);
    expect(full.some((m: any) => m.provider === 'openrouter' && m.model === 'openai/gpt-5.6-terra-pro')).toBe(true);
    expect(full.some((m: any) => m.provider === 'openrouter' && m.model === 'openai/gpt-5.6-sol')).toBe(true);
  });
});
