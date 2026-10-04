/// <reference lib="deno.unstable" />
import { createClient } from '@libsql/client';
import { S3Client } from '@aws-sdk/client-s3';
import { D1DatabaseShim, KVNamespaceShim, S3BucketShim } from './shims.ts';
import { DurableQueueAdapter } from './durableQueue.ts';
import app from '../index.ts';
import type { Env, QueueMessage } from '../shared/types.ts';
import { resolveSecret, resolveSecrets, refreshSecrets } from '../secrets/infisical.ts';
import { initSettings, startSettingsRefresh, appSettings } from '../settings/settingsService.ts';
import { resolveResidentialProxyUrl } from '../shared/proxyFetch.ts';
import { resolveDenoCostProfile } from './costProfile.ts';
import { createRuntimeQueueHandlers } from './runtimeHandlers.ts';
import { runScheduledTick } from './scheduledTick.ts';
import {
  registerDailyLaneCrons,
  registerFrequentLaneCrons,
  resolveDailyLaneDeadlineMs,
} from './cronLanes.ts';
import { withThirdPartyTelemetry } from '../shared/thirdPartyTelemetry.ts';
import { resolveProductionSentryEnv } from '../shared/sentryRuntime.ts';
import { datadogCaptureException, initProductionDatadog } from '../shared/datadog.ts';
import { resolveProductionDatadogEnv } from '../shared/datadogRuntime.ts';
import { captureException, initProductionSentry } from '#sentry';
import { isExpectedPdfParseNoise } from '../shared/pdfParseErrors.ts';
import { sentryLoggerWarn } from '../shared/sentryRuntime.ts';
import { applySqliteConnectionPragmas, libsqlClientOptions } from './sqliteClient.ts';

// 1. Initialize the KV namespace used for configuration and Infisical caching.
// Deno KV Connect does not support queues, so queue bindings are attached only
// after the Turso database has been resolved below.
let tursoDbShim: D1DatabaseShim | null = null;
const kvPath = Deno.env.get('DENO_KV_PATH') || undefined;
const kv = await Deno.openKv(kvPath);
const configKvShim = new KVNamespaceShim(kv, 'config', () => tursoDbShim);

// Keep the isolate alive, but do not report expected pdf.js XRef noise
// (CONGRESS-TRADE-1C).  extractPdfText already fail-softs those PDFs.
globalThis.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  e.preventDefault();
  if (isExpectedPdfParseNoise(e.reason)) {
    sentryLoggerWarn('pdf.xref_noise', { source: 'unhandledrejection' });
    return;
  }
  console.error('Global unhandled rejection:', e.reason);
  try {
    captureException(e.reason);
  } catch {}
});
globalThis.addEventListener('error', (e: ErrorEvent) => {
  e.preventDefault();
  const reason = e.error || e.message;
  if (isExpectedPdfParseNoise(reason)) {
    sentryLoggerWarn('pdf.xref_noise', { source: 'uncaught' });
    return;
  }
  console.error('Global uncaught error:', reason);
  try {
    captureException(e.error || new Error(String(e.message)));
  } catch {}
});

let cachedEnvValues: Record<string, string | undefined> | null = null;

function buildEnvironmentValues(): Record<string, string | undefined> {
  if (cachedEnvValues) return cachedEnvValues;
  const envObj: Record<string, string | undefined> = {};
  const paths = ['.prod.vars', './.prod.vars', 'app/.prod.vars', '/app/.prod.vars'];
  for (const p of paths) {
    try {
      const text = Deno.readTextFileSync(p);
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
          const idx = trimmed.indexOf('=');
          const k = trimmed.slice(0, idx).trim();
          const v = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
          if (k && v && !envObj[k]) envObj[k] = v;
        }
      }
      if (Object.keys(envObj).length > 0) break;
    } catch {}
  }
  for (const key of Object.keys(Deno.env.toObject())) {
    const v = Deno.env.get(key);
    if (v) envObj[key] = v;
  }
  cachedEnvValues = envObj;
  return envObj;
}

// Secret resolution only reads CONFIG_KV and environment values. Keep the
// unavailable runtime bindings out of this bootstrap object rather than
// presenting a producer that cannot durably enqueue yet.
const secretEnv = {
  ...buildEnvironmentValues(),
  CONFIG_KV: configKvShim as any,
} as Env;

// 2. Resolve Infisical secrets at boot, then load the typed app-settings
// snapshot (Infisical SOT: startup load, in-memory cache, background refresh,
// write-through on admin save — see INFISICAL.md).  Boot fails fast here if
// the resolver is misconfigured; individual knobs stay fail-soft with safe
// defaults.
await refreshSecrets(secretEnv);
const settings = await initSettings(secretEnv);
startSettingsRefresh(secretEnv);
// SIGHUP = on-demand settings reload (canonical "Reload settings" path).
try {
  Deno.addSignalListener('SIGHUP', () => {
    settings.refresh(secretEnv).catch((err) => {
      console.error('settings.SIGHUP refresh failed (keeping last-known-good):', (err as Error).message);
    });
  });
} catch {}
console.log(`App settings initialized (${settings.keys().length} knobs from Infisical/env)`);
const sentryResolved = await resolveProductionSentryEnv(secretEnv, resolveSecret);
const sentryBoot = initProductionSentry(sentryResolved);
console.log(
  sentryBoot.initialized
    ? `Sentry initialized (${sentryResolved.SENTRY_ENVIRONMENT || 'production'})`
    : `Sentry disabled (${sentryBoot.reason})`,
);
const datadogResolved = await resolveProductionDatadogEnv(secretEnv, resolveSecret);
const datadogBoot = initProductionDatadog(datadogResolved);
console.log(
  datadogBoot.logs
    ? `Datadog logs+APM initialized (${datadogResolved.DD_ENV || datadogResolved.SENTRY_ENVIRONMENT || 'production'})`
    : `Datadog logs+APM disabled (${datadogBoot.backendReason})`,
);
console.log(
  datadogBoot.rum
    ? 'Datadog RUM enabled for public HTML'
    : `Datadog RUM disabled (${datadogBoot.rumReason})`,
);

// Resolve residential proxy from Infisical for Senate/House scraping
const proxySecrets = await resolveSecrets(secretEnv, [
  'RESIDENTIAL_PROXY_URL',
  'RESIDENTIAL_PROXY_HOST',
  'RESIDENTIAL_PROXY_PORT',
  'RESIDENTIAL_PROXY_USERNAME',
  'RESIDENTIAL_PROXY_PASSWORD',
  'SENATE_PROXY_URL',
]);
const resolvedProxyUrl = resolveResidentialProxyUrl({
  ...secretEnv,
  ...proxySecrets,
});
if (resolvedProxyUrl && cachedEnvValues) {
  cachedEnvValues['RESIDENTIAL_PROXY_URL'] = resolvedProxyUrl;
  console.log('Residential proxy initialized from Infisical for Senate/House scraping');
}

const tursoUrlRes = await resolveSecret(secretEnv, 'TURSO_DATABASE_URL');
const tursoTokenRes = await resolveSecret(secretEnv, 'TURSO_AUTH_TOKEN');

const rawTursoUrl = tursoUrlRes.value || Deno.env.get('TURSO_DATABASE_URL') || '';
const tursoUrl = rawTursoUrl.trim().replace(/^['"]+|['"]+$/g, '').trim();
const rawTursoToken = tursoTokenRes.value || Deno.env.get('TURSO_AUTH_TOKEN') || '';
const tursoToken = rawTursoToken.trim().replace(/^['"]+|['"]+$/g, '').trim();

if (!tursoUrl || tursoUrl.includes('dummy-url')) {
  console.warn("WARNING: TURSO_DATABASE_URL is missing after resolving secrets. The app is falling back to a dummy URL, which means database connections will fail. Ensure INFISICAL_APP_CLIENT_ID and INFISICAL_APP_CLIENT_SECRET are set in Coolify.");
}

// 3. Initialize Turso DB Shim.
// File URLs (production /data/congress-trade/db.sqlite) use one connection
// and a per-connection busy timeout. See sqliteClient.ts (CONGRESS-TRADE-1M).
const libsqlClient = createClient(libsqlClientOptions(
  tursoUrl || 'libsql://dummy-url.turso.io', // Provide a valid dummy URL to prevent crash at boot
  tursoToken,
));

await applySqliteConnectionPragmas(libsqlClient);

const dbShim = new D1DatabaseShim(libsqlClient);
tursoDbShim = dbShim;
const durableQueueDb = dbShim as unknown as D1Database;
const ingestQueueShim = new DurableQueueAdapter<QueueMessage>(durableQueueDb, 'ingest');
const deliveryQueueShim = new DurableQueueAdapter<QueueMessage>(durableQueueDb, 'delivery');

const awsS3EndpointRes = await resolveSecret(secretEnv, 'AWS_S3_ENDPOINT');
const awsAccessKeyIdRes = await resolveSecret(secretEnv, 'AWS_ACCESS_KEY_ID');
const awsSecretAccessKeyRes = await resolveSecret(secretEnv, 'AWS_SECRET_ACCESS_KEY');
const awsS3BucketNameRes = await resolveSecret(secretEnv, 'AWS_S3_BUCKET_NAME');
const awsRegionRes = await resolveSecret(secretEnv, 'AWS_REGION');

// Prefer AWS_* Infisical keys; fall back to CF_R2_S3_* names used in operator
// secret stores so Deno prod can read the same R2 S3 API token without a rename.
const awsS3Endpoint = awsS3EndpointRes.value
  || Deno.env.get('AWS_S3_ENDPOINT')
  || Deno.env.get('CF_R2_S3_ENDPOINT')
  || Deno.env.get('CF_R2_S3_API')
  || undefined;
const awsAccessKeyId = awsAccessKeyIdRes.value
  || Deno.env.get('AWS_ACCESS_KEY_ID')
  || Deno.env.get('CF_R2_S3_ACCESS_KEY_ID')
  || '';
const awsSecretAccessKey = awsSecretAccessKeyRes.value
  || Deno.env.get('AWS_SECRET_ACCESS_KEY')
  || Deno.env.get('CF_R2_S3_SECRET_ACCESS_KEY')
  || '';
const awsS3BucketName = awsS3BucketNameRes.value
  || Deno.env.get('AWS_S3_BUCKET_NAME')
  || Deno.env.get('CF_R2_BUCKET_NAME')
  || 'congress-trade';
const awsRegion = awsRegionRes.value || Deno.env.get('AWS_REGION') || 'auto';

// 4. Initialize S3 (R2) Shim
const s3Client = new S3Client({
  region: awsRegion,
  endpoint: awsS3Endpoint,
  // Garage and R2 both support path-style S3 requests. Path style is required
  // for Garage because the Coolify TLS certificate covers the endpoint host,
  // not arbitrary bucket-name subdomains.
  forcePathStyle: true,
  credentials: {
    accessKeyId: awsAccessKeyId,
    secretAccessKey: awsSecretAccessKey,
  },
});
const s3Shim = new S3BucketShim(s3Client, awsS3BucketName);

// Helper to construct the FULL Env object
function buildEnv(): Env {
  return {
    ...buildEnvironmentValues(),
    ...sentryResolved,
    ...datadogResolved,
    CONFIG_KV: configKvShim as any,
    DB: dbShim as any,
    RAW_FILES: s3Shim as any,
    INGEST_QUEUE: ingestQueueShim as any,
    DELIVERY_QUEUE: deliveryQueueShim as any,
  } as Env;
}

const durableQueueHandlers = createRuntimeQueueHandlers();
// Tick cost profile knobs come from Infisical first (settings snapshot),
// with process env as the legacy fallback — never direct env reads alone.
const costProfile = resolveDenoCostProfile({
  get: (k: string) => settings.get(k) ?? Deno.env.get(k) ?? undefined,
});

// Start Cron Tasks. Deno Deploy does not run the Cloudflare Worker
// `scheduled()` entrypoint, so the live filing watcher and durable outbox
// reconciliations must be wired here explicitly — unless an external
// scheduler owns ticks (DENO_DISABLE_INTERNAL_CRON=true → Coolify/GH Actions
// call POST /api/admin/runtime-tick). Default profile is free (every 5 min,
// tiny drain batches) so we survive free-tier after Aug 1.
// In-isolate overlap guard: Deno.cron does not wait for a slow previous tick,
// so without this a >5-minute tick would stack watcher/outbox work in the same
// isolate. Cross-isolate overlap (cron vs POST /api/admin/runtime-tick) is
// covered by the DB-backed singleton inside runScheduledTick.
//
// 2026-09-21 hardening (board 14dac466 follow-up): a stuck in-flight tick used
// to silently starve every subsequent minute tick for as long as the
// underlying hang lasted — observed in prod 2026-09-20 06:00–13:00 UTC where
// the watcher stopped firing for all three chambers. The hard deadline aborts
// the tick but does NOT force-release tickInFlight when the abort is ignored
// (the documented CONGRESS-TRADE-1B class of latency lanes that ignore the
// abort signal). The watchdog below force-releases tickInFlight after
// CT_TICK_STUCK_MINUTES minutes (default 10) and emits a Sentry
// `cron.tick_stuck` event so the OWNER is alerted even when the underlying
// hang doesn't reach the hard-timeout reject path.
let tickInFlight = false;
let tickInFlightSinceMs = 0;
let consecutiveOverlapTicks = 0;

if (!costProfile.disableInternalCron) {
  console.log(
    `Deno cost profile=${costProfile.name} cron="${costProfile.cronSchedule}" ` +
      `drainLimit=${costProfile.drainLimit} claimSize=${costProfile.drainClaimSize}`,
  );
  Deno.cron('Worker scheduled tasks', costProfile.cronSchedule, async () => {
    if (tickInFlight) {
      const heldMs = Date.now() - tickInFlightSinceMs;
      // Stuck detection (Infisical knob CT_TICK_STUCK_MINUTES, default 10).
      const stuckMinutes = settings.getInt('CT_TICK_STUCK_MINUTES', 10, 60);
      consecutiveOverlapTicks += 1;
      sentryLoggerWarn('cron.tick_overlap', {
        runtime: 'deno',
        heldMs,
        consecutive: consecutiveOverlapTicks,
      });
      // Stuck detection: the in-flight tick has held the lock for longer than
      // CT_TICK_STUCK_MINUTES. The hard-timeout reject already aborted it; if
      // the lane ignored the abort (the CONGRESS-TRADE-1B class) the lock
      // never releases. Force-release now and emit a Sentry alarm so the
      // operator sees the class of failure, not just "polling stopped".
      if (heldMs > stuckMinutes * 60_000) {
        const err = new Error(
          `Deno cron tick stuck for ${Math.round(heldMs / 1000)}s — force-releasing tickInFlight so subsequent ticks can run`,
        );
        console.error('cron.tick_stuck', { heldMs, consecutive: consecutiveOverlapTicks });
        captureException(err, {
          tags: { cron: 'deno-tick', class: 'stuck-force-released' },
          extra: { heldMs, consecutive: consecutiveOverlapTicks },
        });
        datadogCaptureException(err, { cron: 'deno-tick', class: 'stuck-force-released', heldMs: String(heldMs), consecutive: String(consecutiveOverlapTicks) });
        tickInFlight = false;
        tickInFlightSinceMs = 0;
        // Fall through: this tick will now run normally. The previous tick
        // may still be executing in the background (its finally block will
        // see tickInFlight=false, but that's idempotent). The next minute's
        // tick will reset the consecutiveOverlapTicks counter via the
        // non-overlap path below.
      } else {
        return;
      }
    }
    tickInFlight = true;
    tickInFlightSinceMs = Date.now();
    consecutiveOverlapTicks = 0;
    // The tick deadline aborts the tick pipeline instead of abandoning it:
    // lanes stop at the next boundary and the queue drain stops claiming.
    // Default 45s; the Oracle container raises it via CT_TICK_DEADLINE_MS
    // (Infisical knob) so bigger drain batches fit one tick.
    const tickDeadlineMs = Math.max(10_000, Math.min(settings.getInt('CT_TICK_DEADLINE_MS', 45_000), 14 * 60_000));
    const tickAbort = new AbortController();
    try {
      const env = buildEnv();
      const tickPromise = withThirdPartyTelemetry(env, () => runScheduledTick(
        env,
        durableQueueHandlers,
        costProfile,
        new Date(),
        // Daily work moved to dedicated staggered lane crons (cronLanes.ts)
        // with multi-minute deadlines; the 45s tick must not run or starve it.
        {
          signal: tickAbort.signal,
          includeDailyJobs: false,
          includeLatencyLanes: false,
        },
      ));
      let softTimeoutId: ReturnType<typeof setTimeout> | undefined;
      let hardTimeoutId: ReturnType<typeof setTimeout> | undefined;

      // Soft abort 20s before hard deadline so active lanes wind down before
      // CONGRESS-TRADE-1B hard cutoff (latency lanes moved to dedicated crons).
      const softDeadlineMs = Math.max(5000, tickDeadlineMs - 20000);
      softTimeoutId = setTimeout(() => {
        tickAbort.abort(new Error(`Deno cron tick nearing ${tickDeadlineMs}ms deadline`));
      }, softDeadlineMs);

      const timeoutPromise = new Promise<never>((_, reject) => {
        hardTimeoutId = setTimeout(() => {
          tickAbort.abort(new Error(`Deno cron tick exceeded ${tickDeadlineMs}ms deadline`));
          reject(new Error(`Deno cron tick exceeded ${tickDeadlineMs}ms deadline`));
        }, tickDeadlineMs);
      });

      try {
        const result = await Promise.race([tickPromise, timeoutPromise]);
        if (result.skippedOverlap) {
          console.log('Deno tick skipped: another tick holds the singleton lock');
        } else if (result.aborted) {
          console.warn('Deno tick aborted before completing all lanes', {
            errors: result.errors,
          });
        } else if (result.skippedDrain) {
          console.log('Deno tick idle (skipped outbox/queue drain)', {
            profile: result.profile,
            watcher: result.watcher,
          });
        } else if (result.watcher) {
          console.log('Deno watcher completed', result.watcher);
        }
      } finally {
        if (softTimeoutId !== undefined) clearTimeout(softTimeoutId);
        if (hardTimeoutId !== undefined) clearTimeout(hardTimeoutId);
      }
    } catch (err) {
      console.error('Deno cron tick caught error:', err);
      captureException(err, { tags: { cron: 'deno-tick' } });
      datadogCaptureException(err, { cron: 'deno-tick' });
    } finally {
      tickInFlight = false;
      tickInFlightSinceMs = 0;
    }
  });

  // Staggered daily lane crons: market data (enrichment/prices) → bulk R2
  // snapshot → filer (photos/bioguide/ticker backfill) → retention sweeps.
  // Each lane has its own hourly window, KV date stamp, singleton lock, and
  // multi-minute deadline, so a slow provider lane can no longer starve the
  // lanes behind it (the old single-stamp chain died at the tick's 45s).
  registerDailyLaneCrons(buildEnv, resolveDailyLaneDeadlineMs(Deno.env));
  registerFrequentLaneCrons(buildEnv);
} else {
  console.log(
    'Deno internal cron disabled (DENO_DISABLE_INTERNAL_CRON); ' +
      'drive background work via POST /api/admin/runtime-tick',
  );
}

// Dummy context to satisfy Cloudflare signature
const dummyCtx = {
  waitUntil: (promise: Promise<any>) => {
    promise.catch(console.error);
  },
  passThroughOnException: () => {},
};

// Start HTTP Server
const portStr = Deno.env.get('PORT');
const port = portStr ? parseInt(portStr, 10) : 5000;
Deno.serve({ port }, async (req) => {
  const env = buildEnv();
  return app.fetch(req, env, dummyCtx as any);
});
