import type { Env } from '../shared/types.ts';
import {
  DEFAULT_CANDIDATES,
  NON_OFFERED_CANDIDATES,
  keyFor,
  type BakeoffCandidate,
  type Provider,
} from '../extraction/bakeoff.ts';
import {
  deleteSecret,
  readSourceSecrets,
  refreshSecrets,
  resolveSecrets,
  updateSecret,
  type SecretMutationOptions,
} from '../secrets/infisical.ts';
import type {
  BenchmarkChamber,
  BenchmarkModelRef,
  BenchmarkSelectedLineup,
} from './persistence.ts';

type LineupSlot = 'a' | 'b' | 'c';
type RoleSlot = 'primary' | 'failover';

/**
 * The agreement trio (tier-1 unanimous pair = slots a/b; tier-2/3 adds c) now
 * lives at the C/D/E Infisical keys — A/B are the separate PRIMARY/FAILOVER
 * live-ingestion roles below (see BENCHMARK_ROLE_KEYS).
 */
export const BENCHMARK_LINEUP_KEYS: Record<
  BenchmarkChamber,
  Record<LineupSlot, string>
> = {
  house: {
    a: 'AGREEMENT_HOUSE_MODEL_C',
    b: 'AGREEMENT_HOUSE_MODEL_D',
    c: 'AGREEMENT_HOUSE_MODEL_E',
  },
  senate: {
    a: 'AGREEMENT_SENATE_MODEL_C',
    b: 'AGREEMENT_SENATE_MODEL_D',
    c: 'AGREEMENT_SENATE_MODEL_E',
  },
  executive: {
    a: 'AGREEMENT_EXEC_MODEL_C',
    b: 'AGREEMENT_EXEC_MODEL_D',
    c: 'AGREEMENT_EXEC_MODEL_E',
  },
};

/** PRIMARY/FAILOVER live-ingestion extraction model, per chamber. */
export const BENCHMARK_ROLE_KEYS: Record<
  BenchmarkChamber,
  Record<RoleSlot, string>
> = {
  house: {
    primary: 'AGREEMENT_HOUSE_MODEL_A',
    failover: 'AGREEMENT_HOUSE_MODEL_B',
  },
  senate: {
    primary: 'AGREEMENT_SENATE_MODEL_A',
    failover: 'AGREEMENT_SENATE_MODEL_B',
  },
  executive: {
    primary: 'AGREEMENT_EXEC_MODEL_A',
    failover: 'AGREEMENT_EXEC_MODEL_B',
  },
};

/**
 * LlamaParse is selectable in the benchmark UI but intentionally absent from
 * DEFAULT_CANDIDATES (the automatic bake-off default). Keep it in the same
 * server-side catalog so the UI cannot save an arbitrary provider/model pair.
 */
const LLAMAPARSE_CANDIDATES: BakeoffCandidate[] = [
  { provider: 'llamaparse', model: 'fast' },
  { provider: 'llamaparse', model: 'cost-effective' },
  { provider: 'llamaparse', model: 'agentic' },
];

// Direct-provider models kept in the catalog for DECODE/replay + validation of
// historical extraction_runs and prior live config, even though they are no
// longer OFFERED in DEFAULT_CANDIDATES (all live LLM extraction now routes through
// OpenRouter; llamaparse is the sole direct transport). `mistral:mistral-ocr-latest`
// was moved here when its offered slot became `openrouter:mistral/mistral-ocr-latest`.
const LEGACY_CANDIDATES: BakeoffCandidate[] = [
  { provider: 'openai', model: 'gpt-5.6-terra' },
  { provider: 'openai', model: 'gpt-6-luna' },
  { provider: 'openai', model: 'gpt-6-sol' },
  { provider: 'gemini', model: 'gemini-3.5-flash' },
  { provider: 'anthropic', model: 'claude-sonnet-5' },
  { provider: 'anthropic', model: 'claude-haiku-4-5' },
  { provider: 'xai', model: 'grok-4.3' },
  { provider: 'mistral', model: 'mistral-ocr-latest' },
];

export function benchmarkModelCatalog(): BakeoffCandidate[] {
  const byKey = new Map<string, BakeoffCandidate>();
  for (const candidate of [
    ...DEFAULT_CANDIDATES,
    ...LLAMAPARSE_CANDIDATES,
    ...LEGACY_CANDIDATES,
    ...NON_OFFERED_CANDIDATES,
  ]) {
    byKey.set(`${candidate.provider}:${candidate.model}`, { ...candidate });
  }
  return [...byKey.values()];
}

/** Models OFFERED in the benchmark UI: the default bake-off lineup plus the
 *  LlamaParse tiers. Excludes direct-provider LEGACY entries (decode-only —
 *  no API key) and NON_OFFERED routes. Validation still uses the full
 *  benchmarkModelCatalog(). */
export function benchmarkSelectableCatalog(): BakeoffCandidate[] {
  const byKey = new Map<string, BakeoffCandidate>();
  for (const candidate of [...DEFAULT_CANDIDATES, ...LLAMAPARSE_CANDIDATES]) {
    byKey.set(`${candidate.provider}:${candidate.model}`, { ...candidate });
  }
  return [...byKey.values()];
}

export interface BenchmarkCatalogEntry extends BenchmarkModelRef {
  configured: boolean;
}

export interface BenchmarkLineupSettings {
  chamber: BenchmarkChamber;
  lineup: BenchmarkSelectedLineup | null;
  /** SHA-256 over the explicit chamber values. */
  version: string;
  valid: boolean;
  keys: Record<LineupSlot, string>;
  catalog: BenchmarkCatalogEntry[];
}

export interface BenchmarkSettingsAudit {
  chamber: BenchmarkChamber;
  keys: string[];
  previousVersion: string;
  resultingVersion: string | null;
  writtenKeys: string[];
  readbackVerified: boolean;
  rollbackAttempted: boolean;
  rollbackVerified: boolean | null;
}

export class BenchmarkSettingsValidationError extends Error {}

export class BenchmarkSettingsConflictError extends Error {
  constructor(
    message: string,
    readonly current: BenchmarkLineupSettings | BenchmarkRoleSettings,
  ) {
    super(message);
  }
}

export class BenchmarkSettingsWriteError extends Error {
  constructor(
    message: string,
    readonly audit: BenchmarkSettingsAudit,
  ) {
    super(message);
  }
}

interface SettingsDependencies {
  resolve: typeof resolveSecrets;
  readSource: typeof readSourceSecrets;
  configuredKey: typeof keyFor;
  write: (
    env: Env,
    source: 'app' | 'shared',
    key: string,
    value: string,
    options?: SecretMutationOptions,
  ) => Promise<void>;
  remove: (
    env: Env,
    source: 'app' | 'shared',
    key: string,
    options?: SecretMutationOptions,
  ) => Promise<void>;
  refresh: typeof refreshSecrets;
}

export interface BenchmarkSettingsMutationControl {
  /** D1-backed ownership/freshness assertion supplied by the admin route. */
  assertLease?: () => Promise<void>;
  /** Per Infisical/readback operation bound; mutation fetches are also aborted. */
  operationTimeoutMs?: number;
}

const DEFAULT_SETTINGS_OPERATION_TIMEOUT_MS = 15_000;

const DEFAULT_DEPENDENCIES: SettingsDependencies = {
  resolve: resolveSecrets,
  readSource: readSourceSecrets,
  configuredKey: keyFor,
  write: updateSecret,
  remove: deleteSecret,
  refresh: refreshSecrets,
};

async function boundedSettingsOperation<T>(
  label: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function settingsOperationTimeout(control: BenchmarkSettingsMutationControl): number {
  const timeoutMs = control.operationTimeoutMs ?? DEFAULT_SETTINGS_OPERATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new BenchmarkSettingsValidationError('operationTimeoutMs must be between 1 and 60000');
  }
  return timeoutMs;
}

function cleanModelRef(value: BenchmarkModelRef, field: string): BenchmarkModelRef {
  if (!value || typeof value !== 'object') {
    throw new BenchmarkSettingsValidationError(`${field} must be {provider,model}`);
  }
  const provider = typeof value.provider === 'string' ? value.provider.trim().toLowerCase() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (!provider || !model) {
    throw new BenchmarkSettingsValidationError(`${field} must be {provider,model}`);
  }
  return { provider, model };
}

export function parseBenchmarkModelRef(value: string | undefined): BenchmarkModelRef | null {
  if (!value) return null;
  const [provider, ...modelParts] = value.trim().split(':');
  const model = modelParts.join(':').trim();
  return provider && model ? { provider: provider.toLowerCase(), model } : null;
}

export function serializeBenchmarkModelRef(value: BenchmarkModelRef): string {
  return `${value.provider}:${value.model}`;
}

export function validateBenchmarkModel(
  value: BenchmarkModelRef,
  field = 'model',
): BakeoffCandidate {
  const model = cleanModelRef(value, field);
  const match = benchmarkModelCatalog().find(
    (candidate) => candidate.provider === model.provider && candidate.model === model.model,
  );
  if (!match) {
    throw new BenchmarkSettingsValidationError(
      `${field} is not in the benchmark model catalog`,
    );
  }
  return match;
}

export function isOpenRouterAuto(model: { provider: string; model: string }): boolean {
  return model.provider === 'openrouter' && (model.model === 'auto' || model.model === 'openrouter/auto');
}

export function getUnderlyingProvider(model: { provider: string; model: string }): string {
  if (model.provider === 'openrouter') {
    const parts = model.model.split('/');
    if (parts.length > 1) {
      const sub = parts[0].toLowerCase();
      if (sub === 'google') return 'gemini';
      if (sub === 'x-ai') return 'xai';
      return sub;
    }
  }
  return model.provider;
}

export function validateBenchmarkLineup(input: {
  a: BenchmarkModelRef;
  b: BenchmarkModelRef;
  c: BenchmarkModelRef;
}): BenchmarkSelectedLineup {
  const lineup: BenchmarkSelectedLineup = {
    a: validateBenchmarkModel(input.a, 'a'),
    b: validateBenchmarkModel(input.b, 'b'),
    c: validateBenchmarkModel(input.c, 'c'),
  };
  const models = [lineup.a, lineup.b, lineup.c as BenchmarkModelRef];
  if (new Set(models.map(serializeBenchmarkModelRef)).size !== 3) {
    throw new BenchmarkSettingsValidationError('a, b, and c must be three distinct models');
  }
  if (models.some(isOpenRouterAuto)) {
    throw new BenchmarkSettingsValidationError(
      'openrouter/auto cannot be part of a 3-model lineup because its routing is unpredictable',
    );
  }
  // Distinct model IDs only — same underlying vendor (e.g. two OpenRouter-routed
  // OpenAI models, or two different Anthropic models) is allowed so all-OpenRouter
  // cascades can still form independent agreement votes by model diversity.
  return lineup;
}

export interface BenchmarkSelectedRoles {
  primary: BenchmarkModelRef;
  failover: BenchmarkModelRef;
}

export interface BenchmarkRoleSettings {
  chamber: BenchmarkChamber;
  roles: BenchmarkSelectedRoles | null;
  /** SHA-256 over the explicit chamber values. */
  version: string;
  valid: boolean;
  keys: Record<RoleSlot, string>;
  catalog: BenchmarkCatalogEntry[];
}

export function validateBenchmarkRoles(input: {
  primary: BenchmarkModelRef;
  failover: BenchmarkModelRef;
}): BenchmarkSelectedRoles {
  const roles: BenchmarkSelectedRoles = {
    primary: validateBenchmarkModel(input.primary, 'primary'),
    failover: validateBenchmarkModel(input.failover, 'failover'),
  };
  if (isOpenRouterAuto(roles.primary) || isOpenRouterAuto(roles.failover)) {
    throw new BenchmarkSettingsValidationError(
      'openrouter/auto cannot be selected as primary or failover because its routing is unpredictable',
    );
  }
  if (serializeBenchmarkModelRef(roles.primary) === serializeBenchmarkModelRef(roles.failover)) {
    throw new BenchmarkSettingsValidationError('primary and failover must be different models');
  }
  return roles;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('');
}

function sameRoles(
  actual: BenchmarkSelectedRoles | null,
  expected: BenchmarkSelectedRoles,
): boolean {
  if (!actual) return false;
  return (['primary', 'failover'] as const).every(
    (slot) => serializeBenchmarkModelRef(actual[slot]) === serializeBenchmarkModelRef(expected[slot]),
  );
}

function sameLineup(
  actual: BenchmarkSelectedLineup | null,
  expected: BenchmarkSelectedLineup,
): boolean {
  if (!actual?.c || !expected.c) return false;
  return (['a', 'b', 'c'] as const).every(
    (slot) => serializeBenchmarkModelRef(actual[slot] as BenchmarkModelRef)
      === serializeBenchmarkModelRef(expected[slot] as BenchmarkModelRef),
  );
}

async function readSettingsWithDependencies(
  env: Env,
  chamber: BenchmarkChamber,
  dependencies: SettingsDependencies,
): Promise<BenchmarkLineupSettings> {
  const keys = BENCHMARK_LINEUP_KEYS[chamber];
  const requestedKeys = [keys.a, keys.b, keys.c] as const;
  const values = await dependencies.resolve(env, [...requestedKeys]);
  const branchValues = {
    a: values[keys.a],
    b: values[keys.b],
    c: values[keys.c],
  };
  const a = parseBenchmarkModelRef(branchValues.a);
  const b = parseBenchmarkModelRef(branchValues.b);
  const c = parseBenchmarkModelRef(branchValues.c);
  const lineup = a && b && c ? { a, b, c } : null;
  let valid = false;
  if (lineup) {
    try {
      validateBenchmarkLineup(lineup);
      valid = true;
    } catch {
      valid = false;
    }
  }
  const version = await sha256(JSON.stringify({ chamber, branchValues }));
  const catalog = benchmarkSelectableCatalog();
  const configuredByProvider = new Map<Provider, boolean>();
  await Promise.all([...new Set(catalog.map((candidate) => candidate.provider))].map(async (provider) => {
    configuredByProvider.set(provider, Boolean(await dependencies.configuredKey(env, provider)));
  }));
  return {
    chamber,
    lineup,
    version,
    valid,
    keys,
    catalog: catalog.map((candidate) => ({
      ...candidate,
      configured: configuredByProvider.get(candidate.provider) ?? false,
    })),
  };
}

export async function readBenchmarkLineupSettings(
  env: Env,
  chamber: BenchmarkChamber,
  dependencies: Partial<SettingsDependencies> = {},
): Promise<BenchmarkLineupSettings> {
  return readSettingsWithDependencies(env, chamber, { ...DEFAULT_DEPENDENCIES, ...dependencies });
}

export async function saveBenchmarkLineupSettings(
  env: Env,
  input: {
    chamber: BenchmarkChamber;
    a: BenchmarkModelRef;
    b: BenchmarkModelRef;
    c: BenchmarkModelRef;
    expectedVersion: string;
  },
  dependencies: Partial<SettingsDependencies> = {},
  control: BenchmarkSettingsMutationControl = {},
): Promise<{ settings: BenchmarkLineupSettings; audit: BenchmarkSettingsAudit }> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const timeoutMs = settingsOperationTimeout(control);
  const assertLease = control.assertLease ?? (async () => undefined);
  const lineup = validateBenchmarkLineup(input);
  if (!input.expectedVersion || typeof input.expectedVersion !== 'string') {
    throw new BenchmarkSettingsValidationError('expectedVersion is required');
  }
  const current = await boundedSettingsOperation(
    'read current benchmark settings',
    timeoutMs,
    () => readSettingsWithDependencies(env, input.chamber, deps),
  );
  if (current.version !== input.expectedVersion) {
    throw new BenchmarkSettingsConflictError('benchmark lineup settings changed; reload and retry', current);
  }

  const requested = [lineup.a, lineup.b, lineup.c as BenchmarkModelRef];
  const configured = await boundedSettingsOperation(
    'validate benchmark provider credentials',
    timeoutMs,
    () => Promise.all(
      requested.map((model) => deps.configuredKey(env, model.provider as Provider)),
    ),
  );
  const missingProviders = requested
    .filter((_model, index) => !configured[index])
    .map((model) => model.provider);
  if (missingProviders.length) {
    throw new BenchmarkSettingsValidationError(
      `provider credentials are not configured: ${missingProviders.join(', ')}`,
    );
  }

  const keys = BENCHMARK_LINEUP_KEYS[input.chamber];
  const writes: Array<{ slot: LineupSlot; key: string; value: string }> = [
    { slot: 'a', key: keys.a, value: serializeBenchmarkModelRef(lineup.a) },
    { slot: 'b', key: keys.b, value: serializeBenchmarkModelRef(lineup.b) },
    { slot: 'c', key: keys.c, value: serializeBenchmarkModelRef(lineup.c as BenchmarkModelRef) },
  ];
  // Snapshot only source-owned branch overrides. Inherited global/shared/env
  // values are intentionally absent so rollback deletes a newly-created app
  // override instead of pinning today's fallback forever.
  const sourceValues = await boundedSettingsOperation(
    'read current benchmark source overrides',
    timeoutMs,
    () => deps.readSource(env, 'app'),
  );
  const priorValues: Record<LineupSlot, string | undefined> = {
    a: sourceValues[keys.a],
    b: sourceValues[keys.b],
    c: sourceValues[keys.c],
  };
  const audit: BenchmarkSettingsAudit = {
    chamber: input.chamber,
    keys: writes.map((write) => write.key),
    previousVersion: current.version,
    resultingVersion: null,
    writtenKeys: [],
    readbackVerified: false,
    rollbackAttempted: false,
    rollbackVerified: null,
  };

  try {
    for (const write of writes) {
      await assertLease();
      await boundedSettingsOperation(
        `write ${write.key}`,
        timeoutMs,
        (signal) => deps.write(env, 'app', write.key, write.value, { signal }),
      );
      audit.writtenKeys.push(write.key);
    }
    await boundedSettingsOperation(
      'refresh benchmark settings',
      timeoutMs,
      () => deps.refresh(env),
    );
    const settings = await boundedSettingsOperation(
      'verify benchmark settings',
      timeoutMs,
      () => readSettingsWithDependencies(env, input.chamber, deps),
    );
    if (!sameLineup(settings.lineup, lineup)) {
      throw new Error('Infisical readback did not match the requested lineup');
    }
    // Do not report success after this writer's lease expired or was replaced
    // while readback was in flight.
    await assertLease();
    audit.readbackVerified = true;
    audit.resultingVersion = settings.version;
    return { settings, audit };
  } catch (error) {
    audit.rollbackAttempted = true;
    try {
      for (const write of writes) {
        // A stale writer must never undo a successor's values. Losing the
        // owner-token fence aborts rollback immediately.
        await assertLease();
        const priorValue = priorValues[write.slot];
        if (priorValue === undefined) {
          await boundedSettingsOperation(
            `rollback delete ${write.key}`,
            timeoutMs,
            (signal) => deps.remove(env, 'app', write.key, { signal }),
          );
        } else {
          await boundedSettingsOperation(
            `rollback write ${write.key}`,
            timeoutMs,
            (signal) => deps.write(env, 'app', write.key, priorValue, { signal }),
          );
        }
      }
      await boundedSettingsOperation(
        'refresh rolled-back benchmark settings',
        timeoutMs,
        () => deps.refresh(env),
      );
      const rolledBack = await boundedSettingsOperation(
        'verify rolled-back benchmark settings',
        timeoutMs,
        () => readSettingsWithDependencies(env, input.chamber, deps),
      );
      const restoredSource = await boundedSettingsOperation(
        'verify rolled-back benchmark source overrides',
        timeoutMs,
        () => deps.readSource(env, 'app'),
      );
      await assertLease();
      const exactSourceRollback = writes.every(
        (write) => restoredSource[write.key] === priorValues[write.slot],
      );
      audit.rollbackVerified = exactSourceRollback && rolledBack.version === current.version;
    } catch {
      audit.rollbackVerified = false;
    }
    throw new BenchmarkSettingsWriteError(
      `failed to save benchmark lineup: ${(error as Error).message}`,
      audit,
    );
  }
}

// ---------------------------------------------------------------------------
// PRIMARY/FAILOVER roles (AGREEMENT_*_MODEL_A/_B) — mirrors the trio lineup
// read/save above exactly (version-hash/expectedVersion conflict check,
// provider-credential validation, fenced sequential writes, refresh, readback
// verification, rollback with source-owned snapshot), scoped to two slots.
// ---------------------------------------------------------------------------

async function readRoleSettingsWithDependencies(
  env: Env,
  chamber: BenchmarkChamber,
  dependencies: SettingsDependencies,
): Promise<BenchmarkRoleSettings> {
  const keys = BENCHMARK_ROLE_KEYS[chamber];
  const requestedKeys = [keys.primary, keys.failover] as const;
  const values = await dependencies.resolve(env, [...requestedKeys]);
  const branchValues = {
    primary: values[keys.primary],
    failover: values[keys.failover],
  };
  const primary = parseBenchmarkModelRef(branchValues.primary);
  const failover = parseBenchmarkModelRef(branchValues.failover);
  const roles = primary && failover ? { primary, failover } : null;
  let valid = false;
  if (roles) {
    try {
      validateBenchmarkRoles(roles);
      valid = true;
    } catch {
      valid = false;
    }
  }
  const version = await sha256(JSON.stringify({ chamber, branchValues }));
  const catalog = benchmarkSelectableCatalog();
  const configuredByProvider = new Map<Provider, boolean>();
  await Promise.all([...new Set(catalog.map((candidate) => candidate.provider))].map(async (provider) => {
    configuredByProvider.set(provider, Boolean(await dependencies.configuredKey(env, provider)));
  }));
  return {
    chamber,
    roles,
    version,
    valid,
    keys,
    catalog: catalog.map((candidate) => ({
      ...candidate,
      configured: configuredByProvider.get(candidate.provider) ?? false,
    })),
  };
}

export async function readBenchmarkRoleSettings(
  env: Env,
  chamber: BenchmarkChamber,
  dependencies: Partial<SettingsDependencies> = {},
): Promise<BenchmarkRoleSettings> {
  return readRoleSettingsWithDependencies(env, chamber, { ...DEFAULT_DEPENDENCIES, ...dependencies });
}

export async function saveBenchmarkRoleSettings(
  env: Env,
  input: {
    chamber: BenchmarkChamber;
    primary: BenchmarkModelRef;
    failover: BenchmarkModelRef;
    expectedVersion: string;
  },
  dependencies: Partial<SettingsDependencies> = {},
  control: BenchmarkSettingsMutationControl = {},
): Promise<{ settings: BenchmarkRoleSettings; audit: BenchmarkSettingsAudit }> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const timeoutMs = settingsOperationTimeout(control);
  const assertLease = control.assertLease ?? (async () => undefined);
  const roles = validateBenchmarkRoles(input);
  if (!input.expectedVersion || typeof input.expectedVersion !== 'string') {
    throw new BenchmarkSettingsValidationError('expectedVersion is required');
  }
  const current = await boundedSettingsOperation(
    'read current benchmark role settings',
    timeoutMs,
    () => readRoleSettingsWithDependencies(env, input.chamber, deps),
  );
  if (current.version !== input.expectedVersion) {
    throw new BenchmarkSettingsConflictError('benchmark role settings changed; reload and retry', current);
  }

  const requested = [roles.primary, roles.failover];
  const configured = await boundedSettingsOperation(
    'validate benchmark role provider credentials',
    timeoutMs,
    () => Promise.all(
      requested.map((model) => deps.configuredKey(env, model.provider as Provider)),
    ),
  );
  const missingProviders = requested
    .filter((_model, index) => !configured[index])
    .map((model) => model.provider);
  if (missingProviders.length) {
    throw new BenchmarkSettingsValidationError(
      `provider credentials are not configured: ${missingProviders.join(', ')}`,
    );
  }

  const keys = BENCHMARK_ROLE_KEYS[input.chamber];
  const writes: Array<{ slot: RoleSlot; key: string; value: string }> = [
    { slot: 'primary', key: keys.primary, value: serializeBenchmarkModelRef(roles.primary) },
    { slot: 'failover', key: keys.failover, value: serializeBenchmarkModelRef(roles.failover) },
  ];
  // Snapshot only source-owned branch overrides. Inherited global/shared/env
  // values are intentionally absent so rollback deletes a newly-created app
  // override instead of pinning today's fallback forever.
  const sourceValues = await boundedSettingsOperation(
    'read current benchmark role source overrides',
    timeoutMs,
    () => deps.readSource(env, 'app'),
  );
  const priorValues: Record<RoleSlot, string | undefined> = {
    primary: sourceValues[keys.primary],
    failover: sourceValues[keys.failover],
  };
  const audit: BenchmarkSettingsAudit = {
    chamber: input.chamber,
    keys: writes.map((write) => write.key),
    previousVersion: current.version,
    resultingVersion: null,
    writtenKeys: [],
    readbackVerified: false,
    rollbackAttempted: false,
    rollbackVerified: null,
  };

  try {
    for (const write of writes) {
      await assertLease();
      await boundedSettingsOperation(
        `write ${write.key}`,
        timeoutMs,
        (signal) => deps.write(env, 'app', write.key, write.value, { signal }),
      );
      audit.writtenKeys.push(write.key);
    }
    await boundedSettingsOperation(
      'refresh benchmark role settings',
      timeoutMs,
      () => deps.refresh(env),
    );
    const settings = await boundedSettingsOperation(
      'verify benchmark role settings',
      timeoutMs,
      () => readRoleSettingsWithDependencies(env, input.chamber, deps),
    );
    if (!sameRoles(settings.roles, roles)) {
      throw new Error('Infisical readback did not match the requested roles');
    }
    // Do not report success after this writer's lease expired or was replaced
    // while readback was in flight.
    await assertLease();
    audit.readbackVerified = true;
    audit.resultingVersion = settings.version;
    return { settings, audit };
  } catch (error) {
    audit.rollbackAttempted = true;
    try {
      for (const write of writes) {
        // A stale writer must never undo a successor's values. Losing the
        // owner-token fence aborts rollback immediately.
        await assertLease();
        const priorValue = priorValues[write.slot];
        if (priorValue === undefined) {
          await boundedSettingsOperation(
            `rollback delete ${write.key}`,
            timeoutMs,
            (signal) => deps.remove(env, 'app', write.key, { signal }),
          );
        } else {
          await boundedSettingsOperation(
            `rollback write ${write.key}`,
            timeoutMs,
            (signal) => deps.write(env, 'app', write.key, priorValue, { signal }),
          );
        }
      }
      await boundedSettingsOperation(
        'refresh rolled-back benchmark role settings',
        timeoutMs,
        () => deps.refresh(env),
      );
      const rolledBack = await boundedSettingsOperation(
        'verify rolled-back benchmark role settings',
        timeoutMs,
        () => readRoleSettingsWithDependencies(env, input.chamber, deps),
      );
      const restoredSource = await boundedSettingsOperation(
        'verify rolled-back benchmark role source overrides',
        timeoutMs,
        () => deps.readSource(env, 'app'),
      );
      await assertLease();
      const exactSourceRollback = writes.every(
        (write) => restoredSource[write.key] === priorValues[write.slot],
      );
      audit.rollbackVerified = exactSourceRollback && rolledBack.version === current.version;
    } catch {
      audit.rollbackVerified = false;
    }
    throw new BenchmarkSettingsWriteError(
      `failed to save benchmark roles: ${(error as Error).message}`,
      audit,
    );
  }
}
