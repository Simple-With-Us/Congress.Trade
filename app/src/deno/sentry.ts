/**
 * Production `#sentry` binding for the Coolify Docker container
 * (Deno-in-Docker on the Hetzner fleet box).  Not Deno Deploy.
 *
 * `@sentry/deno` is the official Sentry SDK for the Deno *runtime*.  It
 * inits in-process and POSTs envelopes over fetch — no deployctl, no
 * deno.com Deploy APIs, no Deploy integration.  `initProductionSentry` is
 * the boot path used by `main.ts` after Infisical refresh.  Capture/monitor
 * helpers no-op until Coolify/Infisical provides a DSN and `init` succeeds.
 */

import * as DenoSentry from '@sentry/deno';
import {
  createSentryBindings,
  sentryLoggerWarn,
  type ProductionSentryBindings,
  type SentryInitInput,
  type SentryInitResult,
  type SentrySdkLike,
} from '../shared/sentryRuntime.ts';

const sdk = DenoSentry as unknown as SentrySdkLike;
const bindings: ProductionSentryBindings = createSentryBindings(sdk);

export const withSentry = bindings.withSentry;
export const withMonitor = bindings.withMonitor;
export const captureException = bindings.captureException;
export const captureMessage = bindings.captureMessage;
export const setTags = bindings.setTags;
export const consoleLoggingIntegration = bindings.consoleLoggingIntegration;
export const isSentryInitialized = bindings.isInitialized;
export const flushSentry = bindings.flush;
export const logger = { warn: sentryLoggerWarn };

export function initProductionSentry(
  env: SentryInitInput,
  tracesSampleRate?: number,
): SentryInitResult {
  return bindings.initProductionSentry(env, tracesSampleRate);
}
