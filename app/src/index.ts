/**
 * src/index.ts
 * OWNER: foundation (this scaffold)
 *
 * Worker entrypoint. Wires together:
 *   - fetch():      Hono app. Mounts health, REST/SSE, admin, analytics, auth,
 *                   billing, and UI routers.
 *   - scheduled():  cron handler -> runWatcher() + daily enrichment/price jobs.
 *   - queue():      consumer routing INGEST_QUEUE / DELIVERY_QUEUE messages to
 *                   the appropriate stage handlers by message type.
 *
 * Data flow:
 *   watcher --(filing.new)--> fetcher --(filing.fetched)--> classifier
 *      -> extractor (pipeline) -> normalizer --(tx.persisted)-->
 *      delivery dispatch (webhook/sse) --(delivery.dispatch)--> client.
 */

import { Hono } from 'hono';
import * as Sentry from '#sentry';
import type { Env, QueueMessage } from './shared/types.ts';
import type { DurableQueueLeaseContext } from './deno/durableQueue.ts';

// Stage handlers owned by their feature modules.
import { classifyTransientIngestError, fetchFiling, IngestRetryError } from './ingestion/fetcher.ts';
import { classifyFiling } from './ingestion/classifier.ts';
import { extractAndNormalize } from './extraction/orchestrator.ts';
import { DeliveryRetryError, dispatchWebhook } from './delivery/webhook.ts';
import { recordDeadLetterDurable } from './delivery/deadLetter.ts';
import { flushD1Budget } from './shared/d1Budget.ts';
import { runMaintenancePipeline } from './deno/scheduledTick.ts';
import { handleAgreementCheck } from './extraction/agreement.ts';
import {
  handleAutopilotTick,
  markAutopilotRunHalted,
} from './extraction/autopilot.ts';
import { datadogRequestMiddleware } from './shared/datadog.ts';
import { browserSecurityHeadersMiddleware } from './security/headers.ts';
import { publicApiGuard } from './security/botDefense.ts';
import { mountApiRouters } from './apiRouters.ts';

export { mountApiRouters, buildProductionApp } from './apiRouters.ts';
import {
  completeDeliveryOutbox,
  reconnectDeadLetteredOutbox,
} from './delivery/outbox.ts';
import {
  completeIngestionOutbox,
  reconnectDeadLetteredIngestionOutbox,
} from './ingestion/outbox.ts';
import {
  deliverUsageTelemetryEvent,
  isUsageTelemetryCircuitOpen,
  isTerminalUsageTelemetryDeliveryError,
  persistUsageTelemetryFallback,
  trackedFetch,
  withThirdPartyTelemetry,
} from './shared/thirdPartyTelemetry.ts';
import {
  buildSentryInitOptions,
  resolveSentryTracesSampleRate,
  sentryLoggerWarn,
} from './shared/sentryRuntime.ts';

const app = new Hono<{ Bindings: Env }>();

// Attach defense-in-depth browser headers to every Worker-generated response,
// including error and redirect responses. HSTS is added only for HTTPS.
app.use('*', browserSecurityHeadersMiddleware);
app.use('*', datadogRequestMiddleware());

// Anti-scraping guard for the public data API (user-agent blocklist + per-IP
// request budget + X-Robots-Tag). Runs before the feature routers; token-gated
// surfaces (/api/admin, /api/ingest, /api/export) are exempt inside the guard.
app.use('/api/*', publicApiGuard);

// --- IMPLEMENTED health check -------------------------------------------------
app.get('/health', (c) => c.json({ ok: true }));
app.get('/api/health/mac', async (c) => {
  const now = Date.now();
  let scoutHb: Record<string, unknown> | null = null;
  let cpuWorkerHb: Record<string, unknown> | null = null;
  if (c.env.CONFIG_KV) {
    try {
      const sRaw = await c.env.CONFIG_KV.get('mac-heartbeat:scout');
      if (sRaw) scoutHb = JSON.parse(sRaw) as Record<string, unknown>;
      const cRaw = await c.env.CONFIG_KV.get('mac-heartbeat:scan-cpu-worker');
      if (cRaw) cpuWorkerHb = JSON.parse(cRaw) as Record<string, unknown>;
    } catch {
      // KV failure degrades gracefully
    }
  }
  const scoutTs = typeof scoutHb?.timestamp === 'string' ? scoutHb.timestamp : null;
  const cpuTs = typeof cpuWorkerHb?.timestamp === 'string' ? cpuWorkerHb.timestamp : null;
  const scoutAge = scoutTs ? Math.floor((now - Date.parse(scoutTs)) / 1000) : null;
  const cpuWorkerAge = cpuTs ? Math.floor((now - Date.parse(cpuTs)) / 1000) : null;

  const MAX_AGE_SEC = 900; // 15 minutes max age threshold
  const scoutStalled = scoutAge === null || scoutAge > MAX_AGE_SEC;
  const cpuStalled = cpuWorkerAge === null || cpuWorkerAge > MAX_AGE_SEC;
  const ok = !scoutStalled || !cpuStalled; // ok if at least one Mac worker is reporting

  return c.json(
    {
      ok,
      status: ok ? 'ok' : 'degraded',
      workers: {
        scout: { heartbeat: scoutHb, ageSeconds: scoutAge, stalled: scoutStalled },
        cpuWorker: { heartbeat: cpuWorkerHb, ageSeconds: cpuWorkerAge, stalled: cpuStalled },
      },
      thresholdSeconds: MAX_AGE_SEC,
      checkedAt: new Date().toISOString(),
    },
    ok ? 200 : 503,
  );
});

mountApiRouters(app);

export { app as honoApp };

// --- Queue message handlers ---------------------------------------------------
// Single source of truth lives in queueHandlers.ts (used by the Deno durable
// queue via deno/runtimeHandlers.ts). Imported here for the Workers consumer
// path and re-exported so the two copies cannot diverge again.
import {
  handleCorruptDeadLetterMessage,
  handleDeadLetterMessage,
  handleDeliveryMessage,
  handleIngestMessage,
} from './queueHandlers.ts';

export {
  handleCorruptDeadLetterMessage,
  handleDeadLetterMessage,
  handleDeliveryMessage,
  handleIngestMessage,
};

function sentryOptions(env: Env, tracesSampleRate: number) {
  return buildSentryInitOptions(env, tracesSampleRate, {
    integrations: [Sentry.consoleLoggingIntegration({ levels: ['warn', 'error'] })],
    // Meter the SDK-owned Sentry envelope transport too. The explicit Env is
    // required because the SDK can flush after the request callback unwinds.
    transportOptions: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        trackedFetch(
          input,
          init,
          { service: 'observability', operation: 'send-envelope' },
          fetch,
          { envOverride: env, silentQueueFailure: true },
        ),
    },
  });
}

const requestAndScheduledWorker = Sentry.withSentry(
  (env: Env) => sentryOptions(
    env,
    // Send traces for a sample of requests (0 = off, 1.0 = all). Override via
    // the SENTRY_TRACES_SAMPLE_RATE var without a redeploy; fleet default is 0.2.
    resolveSentryTracesSampleRate(env, 0.2),
  ),
  {
    /** HTTP entrypoint. */
    fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
      const response = withThirdPartyTelemetry(env, () => app.fetch(request, env, ctx));
      // Flush this request's metered D1 rows after the response settles — the
      // read path is where analytics/scraper scans accrue. Best-effort, never blocks.
      ctx.waitUntil(Promise.resolve(response).catch(() => undefined).then(() => flushD1Budget(env)));
      return response;
    },

    /** Cron entrypoint — runs every minute; watcher self-gates via shouldPollNow.
     *  Daily enrichment + price refresh self-gate via a KV date stamp.
     *  Lane orchestration is shared with the Deno tick (runMaintenancePipeline)
     *  so the two cron paths cannot drift; this wrapper only adds Sentry
     *  monitors/capture per lane and registers the pipeline with waitUntil. */
    async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
      return withThirdPartyTelemetry(env, async () => {
      const cronMonitor: Record<string, { monitor: string; tag: string; options?: Record<string, unknown> }> = {
        secrets_refresh: { monitor: 'secrets-refresh-cron', tag: 'secrets-refresh' },
        watcher: {
          monitor: 'watcher-cron',
          tag: 'watcher',
          options: {
            schedule: { type: 'crontab', value: '* * * * *' },
            checkinMargin: 2,
            maxRuntime: 5,
            timezone: 'UTC',
          },
        },
        agreement_autopublish: {
          monitor: 'agreement-autopublish-cron',
          tag: 'agreement-autopublish',
          options: {
            schedule: { type: 'crontab', value: '* * * * *' },
            checkinMargin: 2,
            maxRuntime: 2,
            timezone: 'UTC',
          },
        },
        backlog_autopilot: { monitor: 'backlog-autopilot-cron', tag: 'backlog-autopilot' },
        ingestion_outbox: { monitor: 'ingestion-outbox-cron', tag: 'ingestion-outbox' },
        delivery_outbox: { monitor: 'delivery-outbox-cron', tag: 'delivery-outbox' },
        parked_deliveries: { monitor: 'parked-deliveries-cron', tag: 'parked-deliveries' },
        disclosure_latency: { monitor: 'disclosure-latency-cron', tag: 'disclosure-latency' },
        daily_jobs: { monitor: 'daily-jobs-cron', tag: 'daily-jobs' },
      };
      const pipelinePromise = runMaintenancePipeline(env, {
        outboxLimit: 100,
        // GOVERNOR 3: re-dispatch deliveries parked behind per-target circuit
        // breakers — full release when the target's circuit closed, one hourly
        // probe candidate while it is recovering.
        parkedDeliveryLimit: 50,
        usageTelemetryLimit: 25,
        disclosureLatency: true,
        observeLane: (lane, run) => {
          // Receiver outages must not create Sentry envelopes, which would
          // create another Usage Monitor event and amplify; keep this lane
          // monitor-free and log-only.
          if (lane === 'usage_telemetry') {
            return run()
              .then((result: any) => {
                if (result?.failed > 0) {
                  // console.log is intentionally outside the Sentry warn/error
                  // log integration for the same amplification reason.
                  console.log('usage telemetry fallback remains pending', result);
                }
              })
              .catch((err: unknown) => {
                console.log('usage telemetry fallback drain unavailable', {
                  errorType: err instanceof Error ? err.name : 'unknown',
                });
              });
          }
          const meta = cronMonitor[lane] ?? { monitor: `${lane}-cron`, tag: lane };
          return Sentry.withMonitor(meta.monitor, run, meta.options as never)
            .catch((err: unknown) =>
              Sentry.captureException(err, { tags: { cron: meta.tag } }),
            );
        },
      });
      // Register with waitUntil so the isolate stays alive until every lane
      // settles; the pipeline isolates per-lane failures internally.
      ctx.waitUntil(pipelinePromise.then(() => undefined));
      });
    },
  },
);

const queueWorker = Sentry.withSentry(
  // Queue transaction envelopes are themselves metered through INGEST_QUEUE.
  // Never sample queue traces, or each envelope would enqueue another traced
  // queue invocation. Explicit captureException events remain enabled.
  (env: Env) => sentryOptions(env, 0),
  {
    /**
     * Queue consumer. Routes by the bound queue name to the ingest/delivery
     * handlers. Messages are ack'd individually; failures retry per wrangler.toml.
     */
    async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> {
      const typedBatch = batch as unknown as MessageBatch<QueueMessage>;
      return withThirdPartyTelemetry(env, async () => {
      const isDeadLetterQueue = typedBatch.queue.endsWith('-dlq');
      if (isDeadLetterQueue) {
        for (const message of typedBatch.messages) {
          try {
            await handleDeadLetterMessage(
              env,
              typedBatch.queue,
              message.body as QueueMessage,
              message.attempts,
            );
            message.ack();
          } catch (err) {
            const messageType = (message.body as QueueMessage).type;
            if (messageType === 'usage.telemetry' && isTerminalUsageTelemetryDeliveryError(err)) {
              // Deterministic payload/idempotency rejects cannot be recovered
              // by replaying the same DLQ message.
              message.ack();
              continue;
            }
            // Usage Monitor outage retries must not create a Sentry envelope,
            // which would create another Usage Monitor event and amplify.
            if (messageType === 'usage.telemetry') {
              const retained = await persistUsageTelemetryFallback(
                env,
                (message.body as QueueMessage & { type: 'usage.telemetry' }).event,
              );
              if (retained) {
                message.ack();
                continue;
              }
            } else {
              Sentry.captureException(err as Error, {
                tags: { queue: typedBatch.queue, recovery: 'dead-letter' },
              });
            }
            message.retry({ delaySeconds: 60 });
          }
        }
        // Flush this DLQ batch's metered D1 rows (outbox-reopen writes). The
        // queue handler awaits all its work inline, so we await the flush too
        // (messages are already ack'd; a quick KV write does not delay them).
        await flushD1Budget(env);
        return;
      }

      const isDelivery = typedBatch.queue.includes('delivery');
      for (const message of typedBatch.messages) {
        try {
          const msg = message.body as QueueMessage;
          Sentry.setTags({
            queue: isDelivery ? 'delivery' : 'ingest',
            messageType: msg.type ?? 'unknown',
          });
          if (isDelivery) {
            const shouldComplete = await handleDeliveryMessage(env, msg);
            if (shouldComplete && msg.type === 'delivery.dispatch') {
              const completion = await completeDeliveryOutbox(env, msg.txId);
              if (completion === 'missing') {
                // Legacy/direct queue messages predate the outbox. Their work
                // is complete, and retrying cannot manufacture an origin row.
                sentryLoggerWarn('ingest.dead_letter', {
                  queue: 'delivery',
                  reason: 'outbox_missing',
                });
              }
            }
          } else {
            await handleIngestMessage(env, msg, message.attempts);
            if (msg.type === 'filing.new') {
              const completion = await completeIngestionOutbox(env, msg.docId);
              if (completion === 'missing') {
                sentryLoggerWarn('ingest.dead_letter', {
                  queue: 'ingest',
                  reason: 'outbox_missing',
                });
              }
            }
          }
          message.ack();
        } catch (err) {
          const messageType = (message.body as QueueMessage).type;
          if (messageType === 'usage.telemetry' && isTerminalUsageTelemetryDeliveryError(err)) {
            // Ack deterministic payload/idempotency rejects instead of writing
            // the same poison event back to R2 and retrying it forever.
            message.ack();
            continue;
          }
          const ingestRetry = isDelivery
            ? null
            : classifyTransientIngestError(err, message.attempts);
          if (messageType === 'usage.telemetry') {
            const retained = await persistUsageTelemetryFallback(
              env,
              (message.body as QueueMessage & { type: 'usage.telemetry' }).event,
            );
            if (retained) {
              message.ack();
              continue;
            }
          } else if (!(err instanceof DeliveryRetryError) && !(err instanceof IngestRetryError)) {
            console.error(`queue ${typedBatch.queue} message failed:`, (err as Error).message);
            // Expected queue retries are control flow (at-least-once delivery /
            // transient ingest). Capturing them creates Sentry storms such as
            // CONGRESS-TRADE-J ("webhook delivery target(s) require retry").
            // Reserve Issues for unexpected failures only.
            Sentry.captureException(err as Error, {
              tags: { queue: typedBatch.queue, messageType },
            });
          }
          if (err instanceof DeliveryRetryError) {
            sentryLoggerWarn('webhook-retry', {
              queue: typedBatch.queue,
              delaySeconds: err.delaySeconds,
            });
            message.retry({ delaySeconds: err.delaySeconds });
          } else if (err instanceof IngestRetryError) {
            sentryLoggerWarn('ingest.retry', {
              queue: typedBatch.queue,
              delaySeconds: err.delaySeconds,
            });
            message.retry({ delaySeconds: err.delaySeconds });
          } else if (ingestRetry) {
            message.retry({ delaySeconds: ingestRetry.delaySeconds });
          } else {
            message.retry();
          }
        }
      }
      // Flush this batch's metered D1 rows (ingest/delivery writes).
      await flushD1Budget(env);
      });
    },
  },
);

export default {
  fetch: requestAndScheduledWorker.fetch,
  scheduled: requestAndScheduledWorker.scheduled,
  queue: queueWorker.queue,
};
