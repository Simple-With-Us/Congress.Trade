import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  datadogLogsIntakeUrl,
  datadogPublicStatus,
  datadogRumConnectOrigins,
  datadogRumScriptSrc,
  datadogTracesIntakeUrl,
  canonicalizeDatadogEnv,
  normalizeDatadogSite,
  resolveDatadogBackend,
  resolveDatadogRum,
  resolveProductionDatadogEnv,
} from '../datadogRuntime.ts';
import {
  createDatadogTransport,
  shouldSampleDatadogTrace,
} from '../datadogTransport.ts';
import { renderDatadogRumScript } from '../datadogRum.ts';
import {
  datadogRequestMiddleware,
  initProductionDatadog,
  resetDatadogForTests,
  startDatadogSpan,
  traceDatadogOperation,
} from '../datadog.ts';
import { Hono } from 'hono';

afterEach(() => {
  resetDatadogForTests();
});

describe('Datadog site + intake mapping', () => {
  it('accepts known fleet sites and rejects unknown hosts', () => {
    expect(normalizeDatadogSite('us5.datadoghq.com')).toBe('us5.datadoghq.com');
    expect(normalizeDatadogSite('https://datadoghq.com/')).toBe('datadoghq.com');
    expect(normalizeDatadogSite('datadog.example')).toBeUndefined();
    expect(normalizeDatadogSite('')).toBeUndefined();
  });

  it('maps US5 and US1 intake hosts without inventing a default site', () => {
    expect(datadogLogsIntakeUrl('us5.datadoghq.com')).toBe(
      'https://http-intake.logs.us5.datadoghq.com/api/v2/logs',
    );
    expect(datadogTracesIntakeUrl('us5.datadoghq.com')).toBe(
      'https://trace.agent.us5.datadoghq.com/api/v0.2/traces',
    );
    expect(datadogLogsIntakeUrl('datadoghq.com')).toBe(
      'https://http-intake.logs.datadoghq.com/api/v2/logs',
    );
    expect(datadogRumScriptSrc('us5.datadoghq.com')).toBe(
      'https://www.datadoghq-browser-agent.com/us5/v5/datadog-rum.js',
    );
    expect(datadogRumConnectOrigins('us5.datadoghq.com')).toEqual([
      'https://browser-intake-us5-datadoghq.com',
    ]);
  });
});

describe('fail-closed Datadog backend config', () => {
  it('enables logs+APM with API key and defaults to us5.datadoghq.com', () => {
    const ready = resolveDatadogBackend({
      DD_API_KEY: 'abc123',
      DD_ENV: 'production',
    });
    expect(ready).toMatchObject({
      enabled: true,
      reason: 'ready',
      service: 'congress-trade',
      env: 'production',
      site: 'us5.datadoghq.com',
    });
    if (ready.enabled) expect(ready.apiKey).toBe('abc123');
  });

  it('canonicalizes Coolify DD_ENV=prod to production', () => {
    const ready = resolveDatadogBackend({
      DD_API_KEY: 'abc123',
      DD_ENV: 'prod',
    });
    expect(ready).toMatchObject({ enabled: true, env: 'production' });
  });

  it('accepts DATADOG_API_KEY alias and explicit site', () => {
    const ready = resolveDatadogBackend({
      DATADOG_API_KEY: 'alt_key_123',
      DD_SITE: 'datadoghq.com',
      DD_ENV: 'staging',
    });
    expect(ready).toMatchObject({
      enabled: true,
      reason: 'ready',
      site: 'datadoghq.com',
      env: 'staging',
    });
    if (ready.enabled) expect(ready.apiKey).toBe('alt_key_123');
  });

  it('accepts DD_AGENT_HOST without API key', () => {
    const ready = resolveDatadogBackend({
      DD_AGENT_HOST: '127.0.0.1',
    });
    expect(ready).toMatchObject({
      enabled: true,
      reason: 'ready',
      site: 'us5.datadoghq.com',
    });
    if (ready.enabled) expect(ready.agentHost).toBe('127.0.0.1');
  });

  it('accepts DD_TRACE_AGENT_URL as distinct from agentHost', () => {
    const ready = resolveDatadogBackend({
      DD_TRACE_AGENT_URL: 'http://agent:8126',
    });
    expect(ready).toMatchObject({
      enabled: true,
      reason: 'ready',
      agentUrl: 'http://agent:8126',
      site: 'us5.datadoghq.com',
    });
  });

  it('no-ops when keys, agent host, and site are missing', () => {
    expect(resolveDatadogBackend({})).toEqual({ enabled: false, reason: 'missing-api-key' });
    expect(resolveDatadogBackend({ DD_API_KEY: '   ' })).toEqual({
      enabled: false,
      reason: 'missing-api-key',
    });
  });

  it('fails closed on invalid site host', () => {
    expect(resolveDatadogBackend({
      DD_API_KEY: 'abc',
      DD_SITE: 'made-up.datadog.example',
    })).toEqual({ enabled: false, reason: 'invalid-site' });
  });

  it('does not require DD_APP_KEY to send', () => {
    const ready = resolveDatadogBackend({
      DD_API_KEY: 'abc',
      DD_SITE: 'datadoghq.com',
    });
    expect(ready.enabled).toBe(true);
  });
});

describe('fail-closed Datadog RUM config', () => {
  it('enables RUM with client token, application id, and defaults site to us5', () => {
    const rum = resolveDatadogRum({
      DD_CLIENT_TOKEN: 'pub_token',
      DD_APPLICATION_ID: 'app-id-1',
    });
    expect(rum).toMatchObject({
      enabled: true,
      service: 'congress-trade-web',
      site: 'us5.datadoghq.com',
    });
  });

  it('accepts NEXT_PUBLIC_DD_* aliases used by other fleet apps', () => {
    const rum = resolveDatadogRum({
      NEXT_PUBLIC_DD_CLIENT_TOKEN: 'pub_next',
      NEXT_PUBLIC_DD_APPLICATION_ID: 'app-next',
      NEXT_PUBLIC_DD_SITE: 'datadoghq.com',
    });
    expect(rum.enabled).toBe(true);
    if (rum.enabled) {
      expect(rum.clientToken).toBe('pub_next');
      expect(rum.applicationId).toBe('app-next');
      expect(rum.site).toBe('datadoghq.com');
    }
  });

  it('fails closed on partial RUM keys', () => {
    expect(resolveDatadogRum({ DD_CLIENT_TOKEN: 'pub' })).toEqual({
      enabled: false,
      reason: 'missing-application-id',
    });
    expect(resolveDatadogRum({})).toEqual({
      enabled: false,
      reason: 'missing-client-token',
    });
  });

  it('fails closed when DD_RUM_ENABLED is off even with tokens', () => {
    expect(resolveDatadogRum({
      DD_CLIENT_TOKEN: 'pub_token',
      DD_APPLICATION_ID: 'app-id-1',
      DD_RUM_ENABLED: 'false',
    })).toEqual({ enabled: false, reason: 'disabled' });
    expect(datadogPublicStatus({
      DD_API_KEY: 'abc',
      DD_SITE: 'us5.datadoghq.com',
      DD_CLIENT_TOKEN: 'pub_token',
      DD_APPLICATION_ID: 'app-id-1',
      DD_RUM_ENABLED: 'false',
    })).toEqual({ logs: true, apm: true, rum: false });
  });

  it('carries DD_HOSTNAME as a host tag, not the Agent address', () => {
    const backend = resolveDatadogBackend({
      DD_API_KEY: 'abc',
      DD_SITE: 'us5.datadoghq.com',
      DD_HOSTNAME: 'fleet-hetzner-nbg1',
      DD_AGENT_HOST: '127.0.0.1',
    });
    expect(backend.enabled).toBe(true);
    if (!backend.enabled) return;
    expect(backend.hostname).toBe('fleet-hetzner-nbg1');
    expect(backend.agentHost).toBe('127.0.0.1');
  });

  it('never puts the API key in the public snippet', () => {
    const html = renderDatadogRumScript(resolveDatadogRum({
      DD_API_KEY: 'secret-api-key-must-not-leak',
      DD_CLIENT_TOKEN: 'pub_token',
      DD_APPLICATION_ID: 'app-id-1',
      DD_SITE: 'us5.datadoghq.com',
    }));
    expect(html).toContain('pub_token');
    expect(html).toContain('app-id-1');
    expect(html).toContain('sessionReplaySampleRate":0');
    expect(html).not.toContain('secret-api-key-must-not-leak');
    expect(renderDatadogRumScript({ enabled: false, reason: 'partial' })).toBe('');
  });
});

describe('Datadog HTTP transport', () => {
  it('no-ops when backend is disabled', async () => {
    const fetchImpl = vi.fn();
    const transport = createDatadogTransport({ enabled: false }, fetchImpl as never);
    transport.log({ status: 'error', message: 'boom' });
    transport.span({
      name: 'web.request',
      resource: 'GET /x',
      startMs: 1,
      durationMs: 2,
      error: true,
    });
    await transport.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts logs and sampled error traces to the configured site', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 202 }));
    const backend = resolveDatadogBackend({
      DD_API_KEY: 'abc123',
      DD_SITE: 'us5.datadoghq.com',
    });
    expect(backend.enabled).toBe(true);
    if (!backend.enabled) return;
    const transport = createDatadogTransport(backend, fetchImpl as never, {
      sampleRate: 0,
      random: () => 0.99,
    });
    transport.log({ status: 'error', message: 'tick failed?token=super-secret' });
    transport.span({
      name: 'web.request',
      resource: 'GET /api/transactions',
      startMs: 1_000,
      durationMs: 12,
      error: true,
      meta: { 'http.status_code': '500' },
    });
    await transport.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const logCall = fetchImpl.mock.calls[0];
    expect(logCall[0]).toBe('https://http-intake.logs.us5.datadoghq.com/api/v2/logs');
    expect((logCall[1] as RequestInit).headers).toMatchObject({ 'DD-API-KEY': 'abc123' });
    const logBody = JSON.parse(String((logCall[1] as RequestInit).body));
    expect(JSON.stringify(logBody)).not.toContain('super-secret');
    expect(JSON.stringify(logBody)).toContain('[Filtered]');
    const traceCall = fetchImpl.mock.calls[1];
    expect(traceCall[0]).toBe('https://trace.agent.us5.datadoghq.com/api/v0.2/traces');
  });

  it('samples successful traces and always keeps errors', () => {
    expect(shouldSampleDatadogTrace(true, 0, () => 0.99)).toBe(true);
    expect(shouldSampleDatadogTrace(false, 0.2, () => 0.19)).toBe(true);
    expect(shouldSampleDatadogTrace(false, 0.2, () => 0.21)).toBe(false);
  });
});

describe('Datadog process init + request middleware', () => {
  it('reports public-safe status without leaking keys', () => {
    const status = datadogPublicStatus({
      DD_API_KEY: 'abc',
      DD_SITE: 'us5.datadoghq.com',
    });
    expect(status).toEqual({ logs: true, apm: true, rum: false });
    expect(JSON.stringify(status)).not.toContain('abc');

    const agentOnly = datadogPublicStatus({
      DD_AGENT_HOST: '127.0.0.1',
    });
    expect(agentOnly).toEqual({ logs: false, apm: true, rum: false });
  });

  it('swallows intake failures so a request still completes', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('intake exploded');
    });
    const backend = resolveDatadogBackend({
      DD_API_KEY: 'abc',
      DD_SITE: 'us5.datadoghq.com',
    });
    expect(backend.enabled).toBe(true);
    if (!backend.enabled) return;
    const transport = createDatadogTransport(backend, fetchImpl as never);
    transport.log({ status: 'error', message: 'later' });
    await expect(transport.flush()).resolves.toBeUndefined();
  });

  it('request middleware no-ops when Datadog is off', async () => {
    const fetchImpl = vi.fn();
    initProductionDatadog({}, fetchImpl as never);
    const app = new Hono();
    app.use('*', datadogRequestMiddleware());
    app.get('/api/transactions', (c) => c.json({ ok: true }));
    const res = await app.request('http://localhost/api/transactions');
    expect(res.status).toBe(200);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves Infisical values over empty env', async () => {
    const resolved = await resolveProductionDatadogEnv(
      {} as never,
      async (_env, key) => (key === 'DD_API_KEY' ? { value: 'from-infisical' } : {}),
    );
    expect(resolved.DD_API_KEY).toBe('from-infisical');
  });

  it('supports traceDatadogOperation and startDatadogSpan', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 202 }));
    initProductionDatadog({ DD_API_KEY: 'abc123' }, fetchImpl as never);

    const result = await traceDatadogOperation('custom.task', 'queue.process', async () => {
      const span = startDatadogSpan('sub.task', { resource: 'db.query' });
      span.setTag('query.table', 'transactions');
      span.finish();
      return 'processed';
    });

    expect(result).toBe('processed');
  });
});
