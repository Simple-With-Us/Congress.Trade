import type { Env } from '../shared/types.ts';

export const DEFAULT_PIPELINE_STALL_HOURS = 6;
/** Default stall window for ST peer enrichment backlog (daily + hourly drain). */
export const DEFAULT_ST_PEER_ENRICHMENT_STALL_HOURS = 30;

function envGet(key: string): string | undefined {
  try {
    return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(key);
  } catch {
    return undefined;
  }
}

function stallEnvKeyForCondition(condition: string): string {
  return `CT_PIPELINE_STALL_HOURS_${condition.replace(/[^a-z0-9]+/gi, '_').toUpperCase()}`;
}

export function readPipelineStallHours(env: Env, condition?: string): number {
  if (condition) {
    const specific = Number.parseInt(envGet(stallEnvKeyForCondition(condition)) ?? '', 10);
    if (Number.isFinite(specific) && specific >= 1) return Math.min(specific, 168);
  }
  const fromEnv = envGet('CT_PIPELINE_STALL_HOURS');
  const n = Number.parseInt(fromEnv ?? '', 10);
  if (Number.isFinite(n) && n >= 1) return Math.min(n, 168);
  const legacy = Number.parseInt(envGet('CT_OCR_STALL_HOURS') ?? '', 10);
  if (Number.isFinite(legacy) && legacy >= 1) return Math.min(legacy, 168);
  if (condition === 'st_peer_enrichment') return DEFAULT_ST_PEER_ENRICHMENT_STALL_HOURS;
  return DEFAULT_PIPELINE_STALL_HOURS;
}

export function stallWindowMs(hours: number): number {
  return hours * 3_600_000;
}
