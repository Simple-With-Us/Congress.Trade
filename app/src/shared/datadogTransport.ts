/**
 * Agentless Datadog HTTP intake for Deno (logs v2 + traces v0.2).
 *
 * The official Node `dd-trace` agent is not used: production is Deno-in-Docker,
 * not Next.js.  Intake fetch is unmetered (must never recurse through
 * `trackedFetch`).  Missing config is a no-op.  Send failures fail-soft so
 * the product request still completes.
 */

import { SENTRY_FILTERED_VALUE, scrubSentryEvent } from './sentryScrub.ts';
import {
  DATADOG_TRACE_SAMPLE_RATE,
  type DatadogBackendConfig,
} from './datadogRuntime.ts';

export type DatadogLogStatus = 'warn' | 'error';

export interface DatadogLogEvent {
  message: string;
  status: DatadogLogStatus;
  timestamp?: number;
  attributes?: Record<string, string | number | boolean>;
}

export interface DatadogSpanEvent {
  name: string;
  resource: string;
  startMs: number;
  durationMs: number;
  error: boolean;
  meta?: Record<string, string>;
  metrics?: Record<string, number>;
}

export interface DatadogTransport {
  enabled: boolean;
  log: (event: DatadogLogEvent) => void;
  span: (event: DatadogSpanEvent) => void;
  flush: () => Promise<void>;
}

const MAX_QUEUE = 64;
const FLUSH_MS = 2_000;

function shouldSampleTrace(error: boolean, sampleRate: number, random = Math.random): boolean {
  if (error) return true;
  return random() < sampleRate;
}

const LOOSE_CREDENTIAL_QUERY = /([?&](?:api[_-]?key|token|access[_-]?token|auth[_-]?token|secret|password|authorization|session(?:id)?|sig(?:nature)?|code)=)[^&\s<>"']+/gi;

function redactLooseCredentialQuery(value: string): string {
  return value.replace(LOOSE_CREDENTIAL_QUERY, `$1${SENTRY_FILTERED_VALUE}`);
}

function safeText(value: string): string {
  const scrubbed = scrubSentryEvent({ message: value }) as { message?: string };
  return redactLooseCredentialQuery(String(scrubbed.message ?? value))
    .replace(/pub_[A-Za-z0-9_-]{8,}/g, SENTRY_FILTERED_VALUE)
    .slice(0, 4_000);
}

function safeMeta(meta: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (!key || value == null) continue;
    out[key.slice(0, 80)] = safeText(String(value)).slice(0, 200);
  }
  return out;
}

function randomId(): number {
  // 48-bit ids stay inside Number.MAX_SAFE_INTEGER so JSON intake is exact.
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let value = 0;
  for (const byte of bytes) value = (value * 256) + byte;
  return value || 1;
}

export function createDatadogTransport(
  config: DatadogBackendConfig | { enabled: false },
  fetchImpl: typeof fetch = fetch,
  options: { sampleRate?: number; now?: () => number; random?: () => number } = {},
): DatadogTransport {
  if (!config.enabled || !config.apiKey) {
    return {
      enabled: false,
      log: () => undefined,
      span: () => undefined,
      flush: async () => undefined,
    };
  }

  const sampleRate = options.sampleRate ?? config.sampleRate ?? DATADOG_TRACE_SAMPLE_RATE;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const logs: DatadogLogEvent[] = [];
  const spans: DatadogSpanEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushing = false;

  const schedule = () => {
    if (timer != null) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, FLUSH_MS);
  };

  const enqueue = (kind: 'log' | 'span') => {
    const overflow = kind === 'log' ? logs.length > MAX_QUEUE : spans.length > MAX_QUEUE;
    if (overflow) {
      if (kind === 'log') logs.shift();
      else spans.shift();
    }
    schedule();
  };

  const postJson = async (url: string, body: unknown, extraHeaders: Record<string, string> = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'DD-API-KEY': config.apiKey!,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      // Fail-soft: a dead intake must not take down the request or cron tick.
    } finally {
      clearTimeout(timeout);
    }
  };

  const flush = async () => {
    if (flushing) return;
    if (logs.length === 0 && spans.length === 0) return;
    flushing = true;
    const pendingLogs = logs.splice(0, logs.length);
    const pendingSpans = spans.splice(0, spans.length);
    try {
      if (pendingLogs.length > 0) {
        await postJson(config.logsIntakeUrl, pendingLogs.map((event) => ({
          ddsource: 'deno',
          ddtags: `env:${config.env},service:${config.service}${config.version ? `,version:${config.version}` : ''}`,
          hostname: 'congress-app',
          message: safeText(event.message),
          service: config.service,
          status: event.status,
          timestamp: event.timestamp ?? now(),
          ...(event.attributes ? { attributes: event.attributes } : {}),
        })));
      }
      if (pendingSpans.length > 0) {
        const payload = pendingSpans.map((event) => {
          const traceId = randomId();
          const spanId = randomId();
          return [{
            trace_id: traceId,
            span_id: spanId,
            name: event.name.slice(0, 100),
            resource: safeText(event.resource).slice(0, 200),
            service: config.service,
            type: 'web',
            start: Math.round(event.startMs * 1e6),
            duration: Math.max(0, Math.round(event.durationMs * 1e6)),
            error: event.error ? 1 : 0,
            meta: {
              env: config.env,
              language: 'deno',
              ...(config.version ? { version: config.version } : {}),
              ...safeMeta(event.meta),
            },
            metrics: event.metrics ?? {},
          }];
        });
        await postJson(config.tracesIntakeUrl, payload);
      }
    } finally {
      flushing = false;
    }
  };

  return {
    enabled: true,
    log: (event) => {
      logs.push({
        ...event,
        message: safeText(event.message),
        timestamp: event.timestamp ?? now(),
      });
      enqueue('log');
    },
    span: (event) => {
      if (!shouldSampleTrace(event.error, sampleRate, random)) return;
      spans.push(event);
      enqueue('span');
    },
    flush,
  };
}

export function shouldSampleDatadogTrace(
  error: boolean,
  sampleRate = DATADOG_TRACE_SAMPLE_RATE,
  random = Math.random,
): boolean {
  return shouldSampleTrace(error, sampleRate, random);
}
