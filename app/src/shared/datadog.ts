/**
 * Process-wide Datadog bindings.  Init is fail-closed: missing or partial
 * keys leave logs/APM/RUM disabled and the app still boots.
 */

import type { MiddlewareHandler } from 'hono';
import {
  FLEET_DD_HOSTNAME,
  resolveDatadogBackend,
  resolveDatadogRum,
  type DatadogBackendConfig,
  type DatadogBackendReason,
  type DatadogInitInput,
  type DatadogRumReason,
} from './datadogRuntime.ts';
import { createDatadogTransport, type DatadogTransport } from './datadogTransport.ts';
import type { Env } from './types.ts';

export interface DatadogInitResult {
  logs: boolean;
  apm: boolean;
  rum: boolean;
  backendReason: DatadogBackendReason;
  rumReason: DatadogRumReason;
}

type DdSpan = {
  setTag: (key: string, value: unknown) => DdSpan;
  finish: () => void;
  context: () => unknown;
};

type DdTracer = {
  init: (options?: Record<string, unknown>) => void;
  startSpan: (name: string, options?: Record<string, unknown>) => DdSpan;
  trace: <T>(name: string, options: Record<string, unknown>, fn: (span: DdSpan) => Promise<T> | T) => Promise<T>;
  scope: () => { active: () => DdSpan | null };
};

const noopTransport: DatadogTransport = {
  enabled: false,
  log: () => undefined,
  span: () => undefined,
  flush: async () => undefined,
};

let transport: DatadogTransport = noopTransport;
let initializedInput: DatadogInitInput | undefined;
let activeTracer: DdTracer | null = null;
let consoleHooked = false;
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);

function hookConsole(): void {
  if (consoleHooked) return;
  consoleHooked = true;
  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    if (!transport.enabled) return;
    transport.log({ status: 'warn', message: formatConsoleArgs(args) });
  };
  console.error = (...args: unknown[]) => {
    originalError(...args);
    if (!transport.enabled) return;
    transport.log({ status: 'error', message: formatConsoleArgs(args) });
  };
}

function formatConsoleArgs(args: unknown[]): string {
  return args.map((arg) => {
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
    if (typeof arg === 'string') return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return '[unserializable]';
    }
  }).join(' ').slice(0, 2_000);
}

export function resetDatadogForTests(): void {
  transport = noopTransport;
  initializedInput = undefined;
  activeTracer = null;
  if (consoleHooked) {
    console.warn = originalWarn;
    console.error = originalError;
    consoleHooked = false;
  }
}

export async function tryInitDdTracer(backend: DatadogBackendConfig): Promise<DdTracer | null> {
  if (activeTracer) return activeTracer;
  try {
    const proc = (globalThis as any).process;
    const hostTag = backend.hostname
      || proc?.env?.DD_HOSTNAME
      || ((proc?.env?.COOLIFY_FQDN || proc?.env?.COOLIFY_RESOURCE_UUID) ? FLEET_DD_HOSTNAME : '');
    if (hostTag && proc?.env) proc.env.DD_HOSTNAME = hostTag;
    // Agentless dd-trace tags host from os.hostname() (the container id), not DD_HOSTNAME.
    if (hostTag) {
      try {
        const os = await import('node:os');
        os.hostname = () => hostTag;
      } catch {
        // Continue; host tag may stay the container id.
      }
    }
    const mod = await import('npm:dd-trace');
    const tracer = (mod.default || mod) as unknown as DdTracer;
    if (proc?.env) {
      if (backend.agentUrl) {
        proc.env.DD_TRACE_AGENT_URL = backend.agentUrl;
      } else if (backend.agentHost) {
        proc.env.DD_AGENT_HOST = backend.agentHost;
      } else if (backend.apiKey) {
        proc.env.DD_API_KEY = backend.apiKey;
        proc.env.DD_TRACE_EXPERIMENTAL_EXPORTER = 'agentless';
      }
      proc.env.DD_SITE = backend.site;
    }
    const initOptions: Record<string, unknown> = {
      service: backend.service,
      env: backend.env,
      version: backend.version,
      sampleRate: backend.sampleRate,
      logInjection: true,
      runtimeMetrics: true,
    };
    if (backend.agentUrl) {
      initOptions.url = backend.agentUrl;
    } else if (backend.agentHost) {
      initOptions.hostname = backend.agentHost;
    }
    initOptions.llmobs = {
      mlApp: backend.service || 'congress-trade',
      agentlessEnabled: !backend.agentHost && !backend.agentUrl,
    };
    tracer.init(initOptions);
    activeTracer = tracer;
    (globalThis as { _ddtrace?: DdTracer })._ddtrace = tracer;
    return activeTracer;
  } catch {
    return null;
  }
}

export function initProductionDatadog(
  input: DatadogInitInput,
  fetchImpl: typeof fetch = fetch,
): DatadogInitResult {
  initializedInput = input;
  const backend = resolveDatadogBackend(input);
  const rum = resolveDatadogRum(input);
  if (!backend.enabled) {
    transport = noopTransport;
    return {
      logs: false,
      apm: false,
      rum: rum.enabled,
      backendReason: backend.reason,
      rumReason: rum.reason,
    };
  }

  try {
    transport = createDatadogTransport(backend, fetchImpl, { sampleRate: backend.sampleRate });
    if (transport.enabled) hookConsole();
    void tryInitDdTracer(backend);
    return {
      logs: Boolean(backend.apiKey),
      apm: true,
      rum: rum.enabled,
      backendReason: backend.reason,
      rumReason: rum.reason,
    };
  } catch {
    transport = noopTransport;
    return {
      logs: false,
      apm: false,
      rum: rum.enabled,
      backendReason: 'init-failed',
      rumReason: rum.reason,
    };
  }
}

export function getDatadogTransport(): DatadogTransport {
  return transport;
}

export function getDatadogInitInput(): DatadogInitInput | undefined {
  return initializedInput;
}

export function getActiveDdTracer(): DdTracer | null {
  return activeTracer;
}

export function datadogLog(status: 'warn' | 'error', message: string): void {
  transport.log({ status, message });
}

export function datadogCaptureException(err: unknown, attributes?: Record<string, string>): void {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  transport.log({
    status: 'error',
    message,
    attributes: attributes as Record<string, string | number | boolean> | undefined,
  });
}

export interface DatadogSpanHandle {
  setTag: (key: string, value: unknown) => void;
  finish: () => void;
}

export function startDatadogSpan(
  name: string,
  options: { resource?: string; type?: string; tags?: Record<string, unknown> } = {},
): DatadogSpanHandle {
  const startedAt = Date.now();
  const tags: Record<string, unknown> = { ...(options.tags ?? {}) };
  if (options.resource) tags.resource = options.resource;
  if (options.type) tags.type = options.type;

  let rawSpan: DdSpan | null = null;
  if (activeTracer) {
    try {
      rawSpan = activeTracer.startSpan(name, {
        tags,
      });
      if (options.resource && (rawSpan as any)?.setTag) {
        (rawSpan as any).setTag('resource.name', options.resource);
      }
    } catch {
      rawSpan = null;
    }
  }

  return {
    setTag: (key: string, value: unknown) => {
      tags[key] = value;
      if (rawSpan && (rawSpan as any)?.setTag) {
        try {
          (rawSpan as any).setTag(key, value);
        } catch {
          // ignore
        }
      }
    },
    finish: () => {
      if (rawSpan && (rawSpan as any)?.finish) {
        try {
          (rawSpan as any).finish();
        } catch {
          // ignore
        }
      }
      if (transport.enabled) {
        const error = Boolean(tags.error);
        const meta: Record<string, string> = {};
        for (const [k, v] of Object.entries(tags)) {
          if (v != null) meta[k] = String(v);
        }
        transport.span({
          name,
          resource: options.resource || name,
          startMs: startedAt,
          durationMs: Math.max(0, Date.now() - startedAt),
          error,
          meta,
        });
      }
    },
  };
}

export async function traceDatadogOperation<T>(
  name: string,
  resource: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const span = startDatadogSpan(name, { resource });
  try {
    const result = await fn();
    span.finish();
    return result;
  } catch (error) {
    span.setTag('error', true);
    span.setTag('error.message', error instanceof Error ? error.message : String(error));
    span.finish();
    throw error;
  }
}

function requestPath(url: string): string {
  try {
    return new URL(url, 'http://congress.trade').pathname || '/';
  } catch {
    return '/';
  }
}

function skipQuietHealth(path: string, status: number): boolean {
  return status < 400 && (path === '/health' || path === '/api/health');
}

export function datadogRequestMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const path = requestPath(c.req.url);
    const method = c.req.method;
    const resource = `${method} ${path}`;
    const span = startDatadogSpan('web.request', {
      resource,
      type: 'web',
      tags: {
        'http.method': method,
        'http.url': path,
      },
    });

    try {
      await next();
    } catch (err) {
      span.setTag('error', true);
      span.setTag('error.message', err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      const status = c.res?.status ?? 500;
      span.setTag('http.status_code', String(status));
      if (status >= 400) {
        span.setTag('error', true);
        if (transport.enabled) {
          transport.log({
            status: status >= 500 ? 'error' : 'warn',
            message: `${method} ${path} ${status}`,
            attributes: { status, path },
          });
        }
      }
      if (!skipQuietHealth(path, status)) {
        span.finish();
      }
    }
  };
}
