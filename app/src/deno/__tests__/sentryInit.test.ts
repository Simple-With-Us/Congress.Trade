import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildSentryInitOptions,
  createSentryBindings,
  resolveProductionSentryEnv,
  resolveSentryDsn,
  sentryLoggerWarn,
  type SentrySdkLike,
} from '../../shared/sentryRuntime.ts';
import { SENTRY_FILTERED_VALUE, scrubSentryEvent } from '../../shared/sentryScrub.ts';

function fakeSdk(overrides: Partial<SentrySdkLike> = {}): SentrySdkLike & {
  init: ReturnType<typeof vi.fn>;
  captureException: ReturnType<typeof vi.fn>;
  captureMessage: ReturnType<typeof vi.fn>;
  setTags: ReturnType<typeof vi.fn>;
  withMonitor: ReturnType<typeof vi.fn>;
  consoleLoggingIntegration: ReturnType<typeof vi.fn>;
} {
  return {
    init: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    setTags: vi.fn(),
    withMonitor: vi.fn((_name: string, fn: () => unknown) => fn()),
    consoleLoggingIntegration: vi.fn(() => ({ name: 'ConsoleLogging' })),
    ...overrides,
  };
}

describe('production Sentry init', () => {
  it('initializes the SDK when DSN is set', () => {
    const sdk = fakeSdk();
    const sentry = createSentryBindings(sdk);
    const result = sentry.initProductionSentry({
      SENTRY_DSN: 'https://key@o1.ingest.us.sentry.io/1',
      SENTRY_ENVIRONMENT: 'production',
      SENTRY_TRACES_SAMPLE_RATE: '0.2',
    });

    expect(result).toEqual({ initialized: true, reason: 'dsn' });
    expect(sentry.isInitialized()).toBe(true);
    expect(sdk.init).toHaveBeenCalledOnce();
    const options = sdk.init.mock.calls[0][0] as Record<string, unknown>;
    expect(options.dsn).toBe('https://key@o1.ingest.us.sentry.io/1');
    expect(options.environment).toBe('production');
    expect(options.tracesSampleRate).toBe(0.2);
    expect(options.sendDefaultPii).toBe(false);
    expect(options.enableLogs).toBe(true);
    expect(options._flushInterval).toBe(1000);
    expect(typeof options.beforeSend).toBe('function');
    expect(Array.isArray(options.ignoreErrors)).toBe(true);
    expect(options.ignoreErrors).toEqual(expect.arrayContaining(['XRefEntryException']));
    expect((options.initialScope as { tags?: { runtime?: string } })?.tags?.runtime).toBe('coolify-docker');
  });

  it('routes sentryLoggerWarn to the SDK logger after init without console.warn', () => {
    const warn = vi.fn();
    const count = vi.fn();
    const sdk = fakeSdk({ logger: { warn }, metrics: { count } });
    const sentry = createSentryBindings(sdk);
    sentry.initProductionSentry({
      SENTRY_DSN: 'https://key@o1.ingest.us.sentry.io/1',
    });
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sentryLoggerWarn('ingest.dead_letter', { queue: 'ingest', reason: 'governor_cap' });
    expect(warn).toHaveBeenCalledWith('ingest.dead_letter', {
      queue: 'ingest',
      reason: 'governor_cap',
    });
    expect(count).toHaveBeenCalledWith('ingest.dead_letter', 1, {
      attributes: { queue: 'ingest', reason: 'governor_cap' },
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('flushes the SDK after init and no-ops before', async () => {
    const flush = vi.fn(async () => true);
    const sdk = fakeSdk({ flush });
    const sentry = createSentryBindings(sdk);
    expect(await sentry.flush(500)).toBe(false);
    expect(flush).not.toHaveBeenCalled();
    sentry.initProductionSentry({
      SENTRY_DSN: 'https://key@o1.ingest.us.sentry.io/1',
    });
    await expect(sentry.flush(1500)).resolves.toBe(true);
    expect(flush).toHaveBeenCalledWith(1500);
  });

  it('falls back to console.warn when Sentry is not initialized', () => {
    createSentryBindings(fakeSdk());
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sentryLoggerWarn('webhook-retry', { delaySeconds: 5 });
    expect(spy).toHaveBeenCalledWith('webhook-retry', { delaySeconds: 5 });
    spy.mockRestore();
  });

  it('tags the Coolify image SHA as the Sentry release, not a Deploy id', () => {
    const options = buildSentryInitOptions({
      SENTRY_DSN: 'https://key@o1.ingest.us.sentry.io/1',
      CT_BUILD_SHA: 'abc123def',
    }, 0.1);
    expect(options.release).toBe('abc123def');
    expect(options).not.toHaveProperty('dsnDeployment');
  });

  it('falls back to Coolify SOURCE_COMMIT when CT_BUILD_SHA is unset', () => {
    const options = buildSentryInitOptions({
      SENTRY_DSN: 'https://key@o1.ingest.us.sentry.io/1',
      SOURCE_COMMIT: '94a3a921f0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5',
    }, 0.1);
    expect(options.release).toBe('94a3a921f0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5');
  });

  it('omits release when Coolify did not supply a real SHA', () => {
    const options = buildSentryInitOptions({
      SENTRY_DSN: 'https://key@o1.ingest.us.sentry.io/1',
      SOURCE_COMMIT: '$SOURCE_COMMIT',
    }, 0.1);
    expect(options).not.toHaveProperty('release');
  });

  it('no-ops cleanly when DSN is missing', async () => {
    const sdk = fakeSdk();
    const sentry = createSentryBindings(sdk);
    const result = sentry.initProductionSentry({});

    expect(result).toEqual({ initialized: false, reason: 'missing-dsn' });
    expect(sentry.isInitialized()).toBe(false);
    expect(sdk.init).not.toHaveBeenCalled();
    expect(sentry.captureException(new Error('boom'))).toBeUndefined();
    expect(sdk.captureException).not.toHaveBeenCalled();
    expect(sentry.captureMessage('hello')).toBeUndefined();
    expect(await sentry.withMonitor('lane', () => 'ok')).toBe('ok');
    expect(sdk.withMonitor).not.toHaveBeenCalled();
    sentry.setTags({ queue: 'ingest' });
    expect(sdk.setTags).not.toHaveBeenCalled();
  });

  it('treats blank DSN as missing', () => {
    const sdk = fakeSdk();
    const sentry = createSentryBindings(sdk);
    expect(sentry.initProductionSentry({ SENTRY_DSN: '   ' })).toEqual({
      initialized: false,
      reason: 'missing-dsn',
    });
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it('fail-softs if SDK init throws so the app still boots', () => {
    const sdk = fakeSdk({
      init: vi.fn(() => {
        throw new Error('sdk exploded');
      }),
    });
    const sentry = createSentryBindings(sdk);
    const result = sentry.initProductionSentry({
      SENTRY_DSN: 'https://key@o1.ingest.us.sentry.io/1',
    });
    expect(result).toEqual({ initialized: false, reason: 'init-failed' });
    expect(sentry.isInitialized()).toBe(false);
    expect(sentry.captureException(new Error('later'))).toBeUndefined();
  });

  it('drops expected pdf.js XRef noise before send (CONGRESS-TRADE-1C)', () => {
    const options = buildSentryInitOptions(
      { SENTRY_DSN: 'https://key@o1.ingest.us.sentry.io/1' },
      0.1,
    );
    const beforeSend = options.beforeSend as (event: Record<string, unknown>) => unknown;
    expect(beforeSend({
      exception: {
        values: [{
          type: 'XRefEntryException',
          value: 'Bad (uncompressed) XRef entry: 13R',
        }],
      },
    })).toBeNull();
  });

  it('does not capture expected pdf.js XRef exceptions after init', () => {
    const sdk = fakeSdk();
    const sentry = createSentryBindings(sdk);
    sentry.initProductionSentry({
      SENTRY_DSN: 'https://key@o1.ingest.us.sentry.io/1',
    });
    const err = Object.assign(new Error('Bad (uncompressed) XRef entry: 14R'), {
      name: 'XRefEntryException',
    });
    expect(sentry.captureException(err)).toBeUndefined();
    expect(sdk.captureException).not.toHaveBeenCalled();
    const real = new Error('Deno cron tick exceeded 45000ms deadline');
    sentry.captureException(real);
    expect(sdk.captureException).toHaveBeenCalledWith(real, undefined);
  });

  it('scrubs secrets from events before send', () => {
    const credential = 'do-not-serialize-this-credential';
    const options = buildSentryInitOptions(
      { SENTRY_DSN: 'https://key@o1.ingest.us.sentry.io/1' },
      0.1,
    );
    const beforeSend = options.beforeSend as (event: Record<string, unknown>) => Record<string, unknown>;
    const event = beforeSend({
      request: {
        url: `https://api.example.test/resource?api_key=${credential}&page=2`,
        headers: [['authorization', `Bearer ${credential}`], ['accept', 'application/json']],
      },
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(credential);
    expect(serialized).toContain(SENTRY_FILTERED_VALUE);
    expect(serialized).toContain('page=2');
    expect(serialized).toContain('application/json');
  });

  it('resolves Infisical DSN over a missing env value', async () => {
    const resolved = await resolveProductionSentryEnv(
      {} as never,
      async (_env, key) => (
        key === 'SENTRY_DSN'
          ? { value: 'https://infisical@o1.ingest.us.sentry.io/1' }
          : {}
      ),
    );
    expect(resolveSentryDsn(resolved)).toBe('https://infisical@o1.ingest.us.sentry.io/1');
  });

  it('falls back to env when Infisical has no Sentry keys', async () => {
    const resolved = await resolveProductionSentryEnv(
      { SENTRY_DSN: 'https://env@o1.ingest.us.sentry.io/1' } as never,
      async () => ({}),
    );
    expect(resolved.SENTRY_DSN).toBe('https://env@o1.ingest.us.sentry.io/1');
  });

  it('inits from the worker wrapper when DSN is on env', async () => {
    const sdk = fakeSdk();
    const sentry = createSentryBindings(sdk);
    const worker = sentry.withSentry(
      (env) => ({ dsn: env.SENTRY_DSN, tracesSampleRate: 0 }),
      {
        fetch: (_req: Request, _env: { SENTRY_DSN?: string }) => new Response('ok'),
      },
    );
    await worker.fetch(
      new Request('https://congress.trade/health'),
      { SENTRY_DSN: 'https://key@o1.ingest.us.sentry.io/1' },
    );
    expect(sdk.init).toHaveBeenCalledOnce();
    expect(sentry.isInitialized()).toBe(true);
  });
});

describe('production entry wiring', () => {
  it('boots Sentry from Infisical/env after secrets refresh', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/deno/main.ts'), 'utf8');
    expect(src).toContain('resolveProductionSentryEnv');
    expect(src).toContain('initProductionSentry');
    expect(src).toContain('flushSentry');
    expect(src).toContain('captureException(err, { tags: { cron: \'deno-tick\' } })');
    expect(src).toContain('isDenoCronTickHardDeadline(message)');
    expect(src).not.toContain('/exceeded \\d+ms deadline/');
    expect(src).toContain('isExpectedPdfParseNoise');
    expect(src).toContain('sentryLoggerWarn');
    expect(src).not.toContain('sentryDummy');
  });

  it('boots Datadog from Infisical/env and fail-closes when keys are missing', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/deno/main.ts'), 'utf8');
    expect(src).toContain('resolveProductionDatadogEnv');
    expect(src).toContain('initProductionDatadog');
    expect(src).toContain('datadogCaptureException');
    expect(src).not.toContain('dd-trace');
  });

  it('does not add Deno Deploy, deployctl, or Deploy-only APIs', () => {
    const files = [
      'src/deno/sentry.ts',
      'src/shared/sentryRuntime.ts',
      'src/deno/main.ts',
    ].map((rel) => readFileSync(resolve(process.cwd(), rel), 'utf8'));
    const code = files.join('\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/from ['"][^'"]*deployctl/);
    expect(code).not.toMatch(/deno\.com\/deploy/i);
    expect(code).not.toMatch(/from ['"]https:\/\/deno\.land\/x\/deploy/);
    expect(code).not.toMatch(/Deno\.env\.get\(\s*['"]DENO_DEPLOYMENT_ID['"]/);
    expect(code).not.toMatch(/Deno\.env\.get\(\s*['"]DENO_REGION['"]/);
    expect(files.join('\n')).toContain('Coolify');
  });
});

describe('production #sentry import map', () => {
  it('does not resolve #sentry to sentryDummy in Deno or Node maps', () => {
    const appDeno = JSON.parse(readFileSync(resolve(process.cwd(), 'deno.json'), 'utf8')) as {
      imports: Record<string, string>;
    };
    const rootDeno = JSON.parse(readFileSync(resolve(process.cwd(), '../deno.json'), 'utf8')) as {
      imports: Record<string, string>;
    };
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      imports: { '#sentry': Record<string, string> };
    };

    expect(appDeno.imports['#sentry']).toBe('./src/deno/sentry.ts');
    expect(appDeno.imports['#sentry']).not.toMatch(/sentryDummy/);
    expect(rootDeno.imports['#sentry']).toBe('./app/src/deno/sentry.ts');
    expect(rootDeno.imports['#sentry']).not.toMatch(/sentryDummy/);
    expect(pkg.imports['#sentry'].deno).toBe('./src/deno/sentry.ts');
    expect(pkg.imports['#sentry'].default).toBe('./src/deno/sentry.ts');
    expect(JSON.stringify(pkg.imports['#sentry'])).not.toMatch(/sentryDummy/);
    expect(appDeno.imports['@sentry/deno']).toMatch(/@sentry\/deno/);
  });
});

describe('scrubSentryEvent', () => {
  it('redacts URL userinfo and credential query keys', () => {
    const event = scrubSentryEvent({
      breadcrumbs: [{
        data: { url: 'https://user:secret@api.example.test/path?token=abc&safe=1' },
      }],
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('abc');
    expect(serialized).toContain('safe=1');
    expect(serialized).toMatch(/\[Filtered\]|%5BFiltered%5D/);
  });
});
