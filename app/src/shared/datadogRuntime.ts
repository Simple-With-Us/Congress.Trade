/**
 * Fail-closed Datadog config for Coolify Deno-in-Docker.
 *
 * Reuses fleet env names from fleet-ops (`DD_API_KEY`, `DD_APP_KEY`,
 * `DD_SITE`) plus RUM client-token aliases used by other fleet apps
 * (`DD_CLIENT_TOKEN`, `NEXT_PUBLIC_DD_*`).  Missing, blank, partial, or
 * unknown `DD_SITE` values disable send.  No invented keys and no default
 * site.  `DD_APP_KEY` is accepted for registry completeness (synthetics /
 * management) and is never required to ship logs, traces, or RUM.
 */

import { readBuildInfo } from './buildInfo.ts';
import type { Env } from './types.ts';

export const DATADOG_SITES = [
  'datadoghq.com',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'datadoghq.eu',
  'ap1.datadoghq.com',
  'ap2.datadoghq.com',
  'ddog-gov.com',
  'us1.ddog-gov.com',
] as const;

export type DatadogSite = (typeof DATADOG_SITES)[number];

export const DATADOG_BACKEND_SERVICE = 'congress-trade';
export const DATADOG_RUM_SERVICE = 'congress-trade-web';
export const DEFAULT_DATADOG_SITE: DatadogSite = 'us5.datadoghq.com';
export const DATADOG_TRACE_SAMPLE_RATE = 0.2;

export type DatadogBackendReason =
  | 'ready'
  | 'missing-api-key'
  | 'missing-site'
  | 'invalid-site'
  | 'partial'
  | 'init-failed';

export type DatadogRumReason =
  | 'ready'
  | 'missing-client-token'
  | 'missing-application-id'
  | 'missing-site'
  | 'invalid-site'
  | 'partial'
  | 'disabled';

export interface DatadogInitInput {
  DD_API_KEY?: string;
  DATADOG_API_KEY?: string;
  DD_APP_KEY?: string;
  DATADOG_APP_KEY?: string;
  DD_SITE?: string;
  DD_SERVICE?: string;
  DD_ENV?: string;
  DD_AGENT_HOST?: string;
  DD_TRACE_AGENT_URL?: string;
  DD_TRACE_AGENT_HOSTNAME?: string;
  DD_TRACE_URL?: string;
  DD_TRACE_SAMPLE_RATE?: string;
  /** Host tag for APM.  Prefer fleet-hetzner-nbg1 so traces do not mint extra Free hosts. */
  DD_HOSTNAME?: string;
  /** Explicit RUM kill switch.  `false`/`0`/`off`/`no` fail-closes even when tokens exist. */
  DD_RUM_ENABLED?: string;
  NEXT_PUBLIC_DD_RUM_ENABLED?: string;
  DD_CLIENT_TOKEN?: string;
  DD_RUM_CLIENT_TOKEN?: string;
  NEXT_PUBLIC_DD_CLIENT_TOKEN?: string;
  NEXT_PUBLIC_DD_RUM_CLIENT_TOKEN?: string;
  DD_APPLICATION_ID?: string;
  DD_RUM_APPLICATION_ID?: string;
  NEXT_PUBLIC_DD_APPLICATION_ID?: string;
  NEXT_PUBLIC_DD_RUM_APPLICATION_ID?: string;
  NEXT_PUBLIC_DD_SITE?: string;
  SENTRY_ENVIRONMENT?: string;
  USAGE_MONITOR_ENVIRONMENT?: string;
  CT_BUILD_SHA?: string;
  SOURCE_COMMIT?: string;
}

export interface DatadogBackendConfig {
  enabled: true;
  reason: 'ready';
  apiKey?: string;
  agentHost?: string;
  agentUrl?: string;
  sampleRate: number;
  site: DatadogSite;
  service: string;
  env: string;
  version?: string;
  hostname?: string;
  logsIntakeUrl: string;
  tracesIntakeUrl: string;
}

export interface DatadogBackendDisabled {
  enabled: false;
  reason: Exclude<DatadogBackendReason, 'ready'>;
}

export type DatadogBackendResolution = DatadogBackendConfig | DatadogBackendDisabled;

export interface DatadogRumConfig {
  enabled: true;
  reason: 'ready';
  clientToken: string;
  applicationId: string;
  site: DatadogSite;
  service: string;
  env: string;
  version?: string;
  scriptSrc: string;
  connectOrigins: readonly string[];
}

export interface DatadogRumDisabled {
  enabled: false;
  reason: Exclude<DatadogRumReason, 'ready'>;
}

export type DatadogRumResolution = DatadogRumConfig | DatadogRumDisabled;

const SITE_SET = new Set<string>(DATADOG_SITES);

function trimOrEmpty(value: string | undefined): string {
  return value?.trim() ?? '';
}

export function flagOff(value: string | undefined): boolean {
  const normalized = trimOrEmpty(value).toLowerCase();
  return normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off';
}

export const FLEET_DD_HOSTNAME = 'fleet-hetzner-nbg1';

export function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = trimOrEmpty(value);
    if (trimmed) return trimmed;
  }
  return '';
}

export function normalizeDatadogSite(raw: string | undefined): DatadogSite | undefined {
  const site = trimOrEmpty(raw).toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!site) return undefined;
  return SITE_SET.has(site) ? site as DatadogSite : undefined;
}

/** Map Coolify/handoff `prod` onto Datadog `production` so dashboards do not split. */
export function canonicalizeDatadogEnv(raw: string | undefined): string {
  const trimmed = trimOrEmpty(raw);
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (lower === 'prod' || lower === 'production') return 'production';
  return trimmed;
}

export function resolveDatadogEnvName(input: DatadogInitInput | undefined): string {
  return canonicalizeDatadogEnv(
    firstNonEmpty(
      input?.DD_ENV,
      input?.SENTRY_ENVIRONMENT,
      input?.USAGE_MONITOR_ENVIRONMENT,
      'production',
    ),
  ) || 'production';
}

export function resolveDatadogVersion(input: DatadogInitInput | undefined): string | undefined {
  const build = readBuildInfo({
    CT_BUILD_SHA: input?.CT_BUILD_SHA,
    SOURCE_COMMIT: input?.SOURCE_COMMIT,
  });
  return build.sha === 'unknown' ? undefined : build.sha;
}

export function resolveDatadogClientToken(input: DatadogInitInput | undefined): string {
  return firstNonEmpty(
    input?.DD_CLIENT_TOKEN,
    input?.DD_RUM_CLIENT_TOKEN,
    input?.NEXT_PUBLIC_DD_CLIENT_TOKEN,
    input?.NEXT_PUBLIC_DD_RUM_CLIENT_TOKEN,
  );
}

export function resolveDatadogApplicationId(input: DatadogInitInput | undefined): string {
  return firstNonEmpty(
    input?.DD_APPLICATION_ID,
    input?.DD_RUM_APPLICATION_ID,
    input?.NEXT_PUBLIC_DD_APPLICATION_ID,
    input?.NEXT_PUBLIC_DD_RUM_APPLICATION_ID,
  );
}

export function resolveDatadogSiteRaw(input: DatadogInitInput | undefined): string {
  return firstNonEmpty(input?.DD_SITE, input?.NEXT_PUBLIC_DD_SITE);
}

export function datadogLogsIntakeUrl(site: DatadogSite): string {
  const host = site === 'datadoghq.com'
    ? 'http-intake.logs.datadoghq.com'
    : `http-intake.logs.${site}`;
  return `https://${host}/api/v2/logs`;
}

export function datadogTracesIntakeUrl(site: DatadogSite): string {
  const host = site === 'datadoghq.com'
    ? 'trace.agent.datadoghq.com'
    : `trace.agent.${site}`;
  return `https://${host}/api/v0.2/traces`;
}

export function datadogRumScriptSrc(site: DatadogSite): string {
  const slug = site === 'datadoghq.com'
    ? 'us1'
    : site === 'datadoghq.eu'
      ? 'eu'
      : site === 'ddog-gov.com' || site === 'us1.ddog-gov.com'
        ? 'gov'
        : site.split('.')[0];
  return `https://www.datadoghq-browser-agent.com/${slug}/v5/datadog-rum.js`;
}

export function datadogRumConnectOrigins(site: DatadogSite): readonly string[] {
  const intake = site === 'datadoghq.com'
    ? 'https://browser-intake-datadoghq.com'
    : site === 'datadoghq.eu'
      ? 'https://browser-intake-datadoghq.eu'
      : site === 'ddog-gov.com'
        ? 'https://browser-intake-ddog-gov.com'
        : site === 'us1.ddog-gov.com'
          ? 'https://browser-intake-us1-ddog-gov.com'
          : `https://browser-intake-${site.replace('.datadoghq.com', '')}-datadoghq.com`;
  return [intake];
}

function rumServiceName(service: string | undefined): string {
  const trimmed = firstNonEmpty(service);
  if (!trimmed || trimmed === DATADOG_BACKEND_SERVICE) return DATADOG_RUM_SERVICE;
  return trimmed.endsWith('-web') ? trimmed : `${trimmed}-web`;
}

export function resolveDatadogBackend(input: DatadogInitInput | undefined): DatadogBackendResolution {
  const apiKey = firstNonEmpty(input?.DD_API_KEY, input?.DATADOG_API_KEY);
  const agentHost = firstNonEmpty(input?.DD_AGENT_HOST, input?.DD_TRACE_AGENT_HOSTNAME);
  const agentUrl = firstNonEmpty(input?.DD_TRACE_AGENT_URL, input?.DD_TRACE_URL);
  const siteRaw = resolveDatadogSiteRaw(input);
  const site = siteRaw ? normalizeDatadogSite(siteRaw) : DEFAULT_DATADOG_SITE;
  const sampleRate = input?.DD_TRACE_SAMPLE_RATE ? parseFloat(input.DD_TRACE_SAMPLE_RATE) : DATADOG_TRACE_SAMPLE_RATE;

  if (!apiKey && !agentHost && !agentUrl) return { enabled: false, reason: 'missing-api-key' };
  if (!site) return { enabled: false, reason: 'invalid-site' };

  return {
    enabled: true,
    reason: 'ready',
    apiKey: apiKey || undefined,
    agentHost: agentHost || undefined,
    agentUrl: agentUrl || undefined,
    sampleRate: Number.isFinite(sampleRate) && sampleRate >= 0 && sampleRate <= 1 ? sampleRate : DATADOG_TRACE_SAMPLE_RATE,
    site,
    service: firstNonEmpty(input?.DD_SERVICE, DATADOG_BACKEND_SERVICE),
    env: resolveDatadogEnvName(input),
    version: resolveDatadogVersion(input),
    hostname: firstNonEmpty(input?.DD_HOSTNAME) || undefined,
    logsIntakeUrl: datadogLogsIntakeUrl(site),
    tracesIntakeUrl: datadogTracesIntakeUrl(site),
  };
}

export function resolveDatadogRum(input: DatadogInitInput | undefined): DatadogRumResolution {
  if (flagOff(input?.DD_RUM_ENABLED) || flagOff(input?.NEXT_PUBLIC_DD_RUM_ENABLED)) {
    return { enabled: false, reason: 'disabled' };
  }
  const clientToken = resolveDatadogClientToken(input);
  const applicationId = resolveDatadogApplicationId(input);
  const siteRaw = resolveDatadogSiteRaw(input);
  const site = siteRaw ? normalizeDatadogSite(siteRaw) : DEFAULT_DATADOG_SITE;

  if (!clientToken && !applicationId) return { enabled: false, reason: 'missing-client-token' };
  if (!clientToken) return { enabled: false, reason: 'missing-client-token' };
  if (!applicationId) return { enabled: false, reason: 'missing-application-id' };
  if (!site) return { enabled: false, reason: 'invalid-site' };

  return {
    enabled: true,
    reason: 'ready',
    clientToken,
    applicationId,
    site,
    service: rumServiceName(input?.DD_SERVICE),
    env: resolveDatadogEnvName(input),
    version: resolveDatadogVersion(input),
    scriptSrc: datadogRumScriptSrc(site),
    connectOrigins: datadogRumConnectOrigins(site),
  };
}

export function datadogPublicStatus(input: DatadogInitInput | undefined): {
  logs: boolean;
  apm: boolean;
  rum: boolean;
} {
  const backend = resolveDatadogBackend(input);
  const rum = resolveDatadogRum(input);
  return {
    logs: backend.enabled && Boolean(backend.apiKey),
    apm: backend.enabled,
    rum: rum.enabled,
  };
}

const DATADOG_RESOLVE_KEYS = [
  'DD_API_KEY',
  'DATADOG_API_KEY',
  'DD_APP_KEY',
  'DATADOG_APP_KEY',
  'DD_SITE',
  'DD_SERVICE',
  'DD_ENV',
  'DD_AGENT_HOST',
  'DD_TRACE_AGENT_URL',
  'DD_TRACE_AGENT_HOSTNAME',
  'DD_TRACE_URL',
  'DD_TRACE_SAMPLE_RATE',
  'DD_HOSTNAME',
  'DD_RUM_ENABLED',
  'NEXT_PUBLIC_DD_RUM_ENABLED',
  'DD_CLIENT_TOKEN',
  'DD_RUM_CLIENT_TOKEN',
  'NEXT_PUBLIC_DD_CLIENT_TOKEN',
  'NEXT_PUBLIC_DD_RUM_CLIENT_TOKEN',
  'DD_APPLICATION_ID',
  'DD_RUM_APPLICATION_ID',
  'NEXT_PUBLIC_DD_APPLICATION_ID',
  'NEXT_PUBLIC_DD_RUM_APPLICATION_ID',
  'NEXT_PUBLIC_DD_SITE',
] as const;

export type DatadogSecretKey = (typeof DATADOG_RESOLVE_KEYS)[number];

export async function resolveProductionDatadogEnv(
  env: Env,
  resolve: (env: Env, key: DatadogSecretKey) => Promise<{ value?: string }>,
): Promise<DatadogInitInput> {
  const resolved = await Promise.all(
    DATADOG_RESOLVE_KEYS.map(async (key) => [key, (await resolve(env, key)).value] as const),
  );
  const fromInfisical = Object.fromEntries(resolved) as Record<DatadogSecretKey, string | undefined>;
  return {
    DD_API_KEY: fromInfisical.DD_API_KEY || env.DD_API_KEY,
    DATADOG_API_KEY: fromInfisical.DATADOG_API_KEY || env.DATADOG_API_KEY,
    DD_APP_KEY: fromInfisical.DD_APP_KEY || env.DD_APP_KEY,
    DATADOG_APP_KEY: fromInfisical.DATADOG_APP_KEY || env.DATADOG_APP_KEY,
    DD_SITE: fromInfisical.DD_SITE || env.DD_SITE,
    DD_SERVICE: fromInfisical.DD_SERVICE || env.DD_SERVICE,
    DD_ENV: fromInfisical.DD_ENV || env.DD_ENV,
    DD_AGENT_HOST: fromInfisical.DD_AGENT_HOST || env.DD_AGENT_HOST,
    DD_TRACE_AGENT_URL: fromInfisical.DD_TRACE_AGENT_URL || env.DD_TRACE_AGENT_URL,
    DD_TRACE_AGENT_HOSTNAME: fromInfisical.DD_TRACE_AGENT_HOSTNAME || env.DD_TRACE_AGENT_HOSTNAME,
    DD_TRACE_URL: fromInfisical.DD_TRACE_URL || env.DD_TRACE_URL,
    DD_TRACE_SAMPLE_RATE: fromInfisical.DD_TRACE_SAMPLE_RATE || env.DD_TRACE_SAMPLE_RATE,
    DD_HOSTNAME: fromInfisical.DD_HOSTNAME || env.DD_HOSTNAME,
    DD_RUM_ENABLED: fromInfisical.DD_RUM_ENABLED || env.DD_RUM_ENABLED,
    NEXT_PUBLIC_DD_RUM_ENABLED: fromInfisical.NEXT_PUBLIC_DD_RUM_ENABLED || env.NEXT_PUBLIC_DD_RUM_ENABLED,
    DD_CLIENT_TOKEN: fromInfisical.DD_CLIENT_TOKEN || env.DD_CLIENT_TOKEN,
    DD_RUM_CLIENT_TOKEN: fromInfisical.DD_RUM_CLIENT_TOKEN || env.DD_RUM_CLIENT_TOKEN,
    NEXT_PUBLIC_DD_CLIENT_TOKEN: fromInfisical.NEXT_PUBLIC_DD_CLIENT_TOKEN || env.NEXT_PUBLIC_DD_CLIENT_TOKEN,
    NEXT_PUBLIC_DD_RUM_CLIENT_TOKEN:
      fromInfisical.NEXT_PUBLIC_DD_RUM_CLIENT_TOKEN || env.NEXT_PUBLIC_DD_RUM_CLIENT_TOKEN,
    DD_APPLICATION_ID: fromInfisical.DD_APPLICATION_ID || env.DD_APPLICATION_ID,
    DD_RUM_APPLICATION_ID: fromInfisical.DD_RUM_APPLICATION_ID || env.DD_RUM_APPLICATION_ID,
    NEXT_PUBLIC_DD_APPLICATION_ID:
      fromInfisical.NEXT_PUBLIC_DD_APPLICATION_ID || env.NEXT_PUBLIC_DD_APPLICATION_ID,
    NEXT_PUBLIC_DD_RUM_APPLICATION_ID:
      fromInfisical.NEXT_PUBLIC_DD_RUM_APPLICATION_ID || env.NEXT_PUBLIC_DD_RUM_APPLICATION_ID,
    NEXT_PUBLIC_DD_SITE: fromInfisical.NEXT_PUBLIC_DD_SITE || env.NEXT_PUBLIC_DD_SITE,
    SENTRY_ENVIRONMENT: env.SENTRY_ENVIRONMENT,
    USAGE_MONITOR_ENVIRONMENT: env.USAGE_MONITOR_ENVIRONMENT,
    CT_BUILD_SHA: env.CT_BUILD_SHA,
    SOURCE_COMMIT: env.SOURCE_COMMIT,
  };
}
