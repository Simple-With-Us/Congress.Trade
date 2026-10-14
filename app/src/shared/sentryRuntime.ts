/**
 * Coolify Docker / production Sentry runtime.
 *
 * Production is Deno-in-Docker on Coolify (Hetzner fleet), not Deno Deploy.
 * This module talks to an injected SDK (`@sentry/deno` — the Deno *runtime*
 * SDK, not a Deploy integration) and fail-softs when Coolify/Infisical has
 * no `SENTRY_DSN` or `init` throws.  Secrets are stripped by
 * `scrubSentryEvent` before send.  Do not add deployctl or Deploy-only APIs.
 */

import { readBuildInfo } from './buildInfo.ts';
import {
  isExpectedPdfParseNoise,
  sentryEventLooksLikePdfParseNoise,
  SENTRY_PDF_IGNORE_ERRORS,
} from './pdfParseErrors.ts';
import { sentryOperationalNoiseShouldDrop } from './sentryNoise.ts';
import { scrubSentryEvent } from './sentryScrub.ts';
import type { Env } from './types.ts';

export type SentryLogAttributes = Record<string, string | number | boolean | null>;

type LoggerWarn = (message: string, attributes?: SentryLogAttributes) => void;

let activeLoggerWarn: LoggerWarn | undefined;
let activeMetricsCount:
  | ((name: string, value?: number, options?: { attributes?: SentryLogAttributes }) => unknown)
  | undefined;
let activeFlush: ((timeout?: number) => Promise<boolean>) | undefined;
let logFlushTimer: ReturnType<typeof setTimeout> | undefined;

const LOG_FLUSH_DELAY_MS = 250;

function scheduleSentryLogFlush(): void {
  if (!activeFlush || logFlushTimer) return;
  logFlushTimer = setTimeout(() => {
    logFlushTimer = undefined;
    void activeFlush?.(2000);
  }, LOG_FLUSH_DELAY_MS);
}

/**
 * Flush buffered Sentry Logs / envelopes.  Deno's SDK only auto-flushes logs
 * on `beforeExit` / `unload` or after 100 items; a long-lived Coolify process
 * never exits, so sparse `sentryLoggerWarn` lines sat in the buffer (0 logs
 * in 7d after the last hourly heartbeat on 2026-09-22).
 */
export function flushSentry(timeout = 2000): Promise<boolean> {
  if (!activeFlush) return Promise.resolve(false);
  return activeFlush(timeout);
}

/**
 * Sparse operational log for Sentry Logs.  After a successful SDK init this
 * goes to `Sentry.logger.warn` only (no console), so Datadog's console hook
 * does not dual-ship the same line.  Before init, falls back to console.warn
 * for local/dev.
 */
export function sentryLoggerWarn(message: string, attributes?: SentryLogAttributes): void {
  if (activeMetricsCount) {
    try {
      activeMetricsCount(message, 1, attributes ? { attributes } : undefined);
    } catch {
      // Metrics must never break the warn path.
    }
  }
  if (activeLoggerWarn) {
    try {
      activeLoggerWarn(message, attributes);
      scheduleSentryLogFlush();
      return;
    } catch {
      // SDK logger threw; do not also console.warn (that would dual-ship).
      return;
    }
  }
  if (attributes) console.warn(message, attributes);
  else console.warn(message);
}

export interface SentrySdkLike {
  init: (options: Record<string, unknown>) => unknown;
  captureException: (err: unknown, hint?: unknown) => unknown;
  captureMessage?: (msg: string, level?: string) => unknown;
  setTags?: (tags: Record<string, unknown>) => void;
  setTag?: (key: string, value: string) => void;
  withMonitor?: (name: string, fn: () => unknown, options?: unknown) => unknown;
  consoleLoggingIntegration?: (options?: { levels?: string[] }) => unknown;
  logger?: { warn?: (message: string, attributes?: SentryLogAttributes) => unknown };
  metrics?: {
    count?: (
      name: string,
      value?: number,
      options?: { attributes?: SentryLogAttributes },
    ) => unknown;
  };
  flush?: (timeout?: number) => Promise<boolean>;
}

export interface SentryInitInput {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;
  /** Coolify image SHA (`SOURCE_COMMIT` → `CT_BUILD_SHA`).  Not a Deploy id. */
  CT_BUILD_SHA?: string;
  /** Coolify runtime commit when the image ARG was empty. */
  SOURCE_COMMIT?: string;
}

export interface SentryInitResult {
  initialized: boolean;
  reason: 'dsn' | 'missing-dsn' | 'init-failed';
}

export interface ProductionSentryBindings {
  initProductionSentry: (env: SentryInitInput, tracesSampleRate?: number) => SentryInitResult;
  withSentry: <T extends Record<string, unknown>>(
    optionsFactory: ((env: Env) => Record<string, unknown>) | Record<string, unknown>,
    worker: T,
  ) => T;
  withMonitor: (name: string, fn: unknown, options?: unknown) => Promise<unknown>;
  captureException: (err: unknown, options?: unknown) => unknown;
  captureMessage: (msg: string, level?: string) => unknown;
  setTags: (tags: Record<string, unknown>) => void;
  consoleLoggingIntegration: (options?: { levels?: string[] }) => unknown;
  isInitialized: () => boolean;
  flush: (timeout?: number) => Promise<boolean>;
}

export function resolveSentryDsn(env: SentryInitInput | undefined): string | undefined {
  const dsn = env?.SENTRY_DSN?.trim();
  return dsn || undefined;
}

export function resolveSentryTracesSampleRate(
  env: SentryInitInput | undefined,
  fallback: number,
): number {
  const raw = env?.SENTRY_TRACES_SAMPLE_RATE;
  if (raw == null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function buildSentryInitOptions(
  env: SentryInitInput,
  tracesSampleRate: number,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  const build = readBuildInfo({
    CT_BUILD_SHA: env.CT_BUILD_SHA,
    SOURCE_COMMIT: env.SOURCE_COMMIT,
  });
  const release = build.sha === 'unknown' ? undefined : build.sha;
  return {
    dsn: resolveSentryDsn(env),
    environment: env.SENTRY_ENVIRONMENT || 'production',
    tracesSampleRate,
    sendDefaultPii: false,
    ...(release ? { release } : {}),
    initialScope: {
      tags: { runtime: 'coolify-docker' },
    },
    beforeSend: <T>(event: T) => {
      const scrubbed = scrubSentryEvent(event);
      if (sentryEventLooksLikePdfParseNoise(scrubbed)) return null;
      if (sentryOperationalNoiseShouldDrop(scrubbed)) return null;
      return scrubbed;
    },
    beforeSendTransaction: <T>(event: T) => scrubSentryEvent(event),
    beforeSendLog: <T>(log: T) => scrubSentryEvent(log),
    enableLogs: true,
    // Deno's default 5s unref'd timer never fires if the isolate is quiet
    // and the process never exits.  1s plus an explicit flush after warns
    // and cron/request boundaries is what actually delivers Logs.
    _flushInterval: 1000,
    ignoreErrors: SENTRY_PDF_IGNORE_ERRORS,
    tracePropagationTargets: [/^https:\/\/([\w-]+\.)?congress\.trade/],
    ...extras,
  };
}

function extractEnvFromHandlerArgs(args: unknown[]): Env | undefined {
  for (const arg of args) {
    if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
      const candidate = arg as Record<string, unknown>;
      if (
        'SENTRY_DSN' in candidate
        || 'SENTRY_ENVIRONMENT' in candidate
        || 'DB' in candidate
        || 'CONFIG_KV' in candidate
      ) {
        return candidate as unknown as Env;
      }
    }
  }
  return undefined;
}

export function createSentryBindings(sdk: SentrySdkLike): ProductionSentryBindings {
  let initialized = false;
  activeLoggerWarn = undefined;
  activeMetricsCount = undefined;
  activeFlush = undefined;
  if (logFlushTimer) {
    clearTimeout(logFlushTimer);
    logFlushTimer = undefined;
  }

  const initProductionSentry = (
    env: SentryInitInput,
    tracesSampleRate = resolveSentryTracesSampleRate(env, 0.2),
  ): SentryInitResult => {
    if (initialized) return { initialized: true, reason: 'dsn' };
    const dsn = resolveSentryDsn(env);
    if (!dsn) return { initialized: false, reason: 'missing-dsn' };
    try {
      const extras: Record<string, unknown> = {};
      if (typeof sdk.consoleLoggingIntegration === 'function') {
        extras.integrations = [sdk.consoleLoggingIntegration({ levels: ['warn', 'error'] })];
      }
      sdk.init(buildSentryInitOptions(env, tracesSampleRate, extras));
      initialized = true;
      if (typeof sdk.logger?.warn === 'function') {
        const warn = sdk.logger.warn.bind(sdk.logger);
        activeLoggerWarn = (message, attributes) => {
          warn(message, attributes);
        };
      }
      if (typeof sdk.metrics?.count === 'function') {
        activeMetricsCount = sdk.metrics.count.bind(sdk.metrics);
      }
      if (typeof sdk.flush === 'function') {
        const flushFn = sdk.flush.bind(sdk);
        activeFlush = async (timeout) => {
          try {
            return Boolean(await flushFn(timeout));
          } catch {
            return false;
          }
        };
      }
      return { initialized: true, reason: 'dsn' };
    } catch (err) {
      console.warn(
        'Sentry init failed; continuing without Sentry',
        err instanceof Error ? err.name : 'unknown',
      );
      return { initialized: false, reason: 'init-failed' };
    }
  };

  const withSentry = <T extends Record<string, unknown>>(
    optionsFactory: ((env: Env) => Record<string, unknown>) | Record<string, unknown>,
    worker: T,
  ): T => {
    const wrap = (handler: unknown): unknown => {
      if (typeof handler !== 'function') return handler;
      return (...args: unknown[]) => {
        try {
          const env = extractEnvFromHandlerArgs(args);
          const options = typeof optionsFactory === 'function'
            ? optionsFactory(env ?? {} as Env)
            : optionsFactory;
          const dsn = typeof options.dsn === 'string' ? options.dsn : env?.SENTRY_DSN;
          initProductionSentry({
            SENTRY_DSN: dsn,
            SENTRY_ENVIRONMENT: typeof options.environment === 'string'
              ? options.environment
              : env?.SENTRY_ENVIRONMENT,
            SENTRY_TRACES_SAMPLE_RATE: env?.SENTRY_TRACES_SAMPLE_RATE,
            CT_BUILD_SHA: env?.CT_BUILD_SHA,
            SOURCE_COMMIT: env?.SOURCE_COMMIT,
          }, typeof options.tracesSampleRate === 'number' ? options.tracesSampleRate : undefined);
        } catch {
          // Fail-soft: a bad options factory must not take down the request.
        }
        return handler(...args);
      };
    };

    const wrapped = { ...worker };
    for (const key of Object.keys(worker) as Array<keyof T>) {
      wrapped[key] = wrap(worker[key]) as T[keyof T];
    }
    return wrapped;
  };

  const withMonitor = (name: string, fn: unknown, options?: unknown): Promise<unknown> => {
    const run = () => (typeof fn === 'function' ? fn() : fn);
    if (initialized && typeof sdk.withMonitor === 'function') {
      try {
        return Promise.resolve(sdk.withMonitor(name, run, options));
      } catch {
        return Promise.resolve(run());
      }
    }
    return Promise.resolve(run());
  };

  const captureException = (err: unknown, options?: unknown): unknown => {
    if (!initialized) return undefined;
    if (isExpectedPdfParseNoise(err)) return undefined;
    try {
      return sdk.captureException(err, options);
    } catch {
      return undefined;
    }
  };

  const captureMessage = (msg: string, level?: string): unknown => {
    if (!initialized || typeof sdk.captureMessage !== 'function') return undefined;
    try {
      return sdk.captureMessage(msg, level);
    } catch {
      return undefined;
    }
  };

  const setTags = (tags: Record<string, unknown>): void => {
    if (!initialized) return;
    try {
      if (typeof sdk.setTags === 'function') {
        sdk.setTags(tags);
        return;
      }
      if (typeof sdk.setTag === 'function') {
        for (const [key, value] of Object.entries(tags)) {
          sdk.setTag(key, String(value));
        }
      }
    } catch {
      // Fail-soft.
    }
  };

  const consoleLoggingIntegration = (options?: { levels?: string[] }): unknown => {
    if (typeof sdk.consoleLoggingIntegration === 'function') {
      return sdk.consoleLoggingIntegration(options);
    }
    return { name: 'ConsoleLogging' };
  };

  return {
    initProductionSentry,
    withSentry,
    withMonitor,
    captureException,
    captureMessage,
    setTags,
    consoleLoggingIntegration,
    isInitialized: () => initialized,
    flush: flushSentry,
  };
}

export async function resolveProductionSentryEnv(
  env: Env,
  resolve: (env: Env, key: 'SENTRY_DSN' | 'SENTRY_ENVIRONMENT' | 'SENTRY_TRACES_SAMPLE_RATE') => Promise<{ value?: string }>,
): Promise<SentryInitInput> {
  const [dsn, environment, traces] = await Promise.all([
    resolve(env, 'SENTRY_DSN'),
    resolve(env, 'SENTRY_ENVIRONMENT'),
    resolve(env, 'SENTRY_TRACES_SAMPLE_RATE'),
  ]);
  return {
    SENTRY_DSN: dsn.value || env.SENTRY_DSN,
    SENTRY_ENVIRONMENT: environment.value || env.SENTRY_ENVIRONMENT,
    SENTRY_TRACES_SAMPLE_RATE: traces.value || env.SENTRY_TRACES_SAMPLE_RATE,
    CT_BUILD_SHA: env.CT_BUILD_SHA,
    SOURCE_COMMIT: env.SOURCE_COMMIT,
  };
}
