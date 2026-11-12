/**
 * src/ui/tickerLogoPolicy.ts
 * OWNER: dashboard agent
 *
 * Policy tables live in `@jaywedgeworth22/congress-trading-shared`. This
 * module re-exports them and keeps the Congress.Trade CONFIG_KV overlay
 * (admin jury) plus the KV key. Themed local files still win in tickerLogos.ts.
 */

import type { Env } from '../shared/types.ts';
import type { SymbolLogoPolicy, TickerLogoPolicyMap } from '@jaywedgeworth22/congress-trading-shared';
import {
  canonicalLogoPolicySymbol,
  parseTickerLogoPolicyMap,
} from '@jaywedgeworth22/congress-trading-shared';

export {
  DEFAULT_LOGO_SOURCE_ORDER,
  SEEDED_LOGO_POLICY,
  SOCRATIC_DEFAULT_LOGO_SOURCE_ORDER,
  canonicalLogoPolicySymbol,
  mergeLogoPolicy,
  parseLogoSources,
  parseSymbolLogoPolicy,
  parseTickerLogoPolicyMap,
  policyFromLetters,
  remoteLogoSources,
  sourceOrderFor,
} from '@jaywedgeworth22/congress-trading-shared';

export type {
  LogoSource,
  LogoTheme,
  SymbolLogoPolicy,
  TickerLogoPolicyMap,
} from '@jaywedgeworth22/congress-trading-shared';

export const LOGO_POLICY_KV_NAME = 'ticker-logo-policy-v1'; // gitleaks:allow

let overlayMemo: { exp: number; map: TickerLogoPolicyMap } = { exp: 0, map: {} };

export function primeLogoPolicyOverlay(map: TickerLogoPolicyMap): void {
  overlayMemo = { exp: Date.now() + 60_000, map };
}

export function invalidateLogoPolicyOverlay(): void {
  overlayMemo = { exp: 0, map: {} };
}

export async function readLogoPolicyOverlay(
  env: Pick<Env, 'CONFIG_KV'> | { CONFIG_KV?: Env['CONFIG_KV'] },
): Promise<TickerLogoPolicyMap> {
  const now = Date.now();
  if (now < overlayMemo.exp) return overlayMemo.map;
  const kv = env.CONFIG_KV;
  if (!kv) {
    overlayMemo = { exp: now + 60_000, map: {} };
    return {};
  }
  try {
    const raw = await kv.get(LOGO_POLICY_KV_NAME);
    const parsed = raw ? parseTickerLogoPolicyMap(JSON.parse(raw)) : {};
    const map = parsed ?? {};
    overlayMemo = { exp: now + 60_000, map };
    return map;
  } catch {
    overlayMemo = { exp: now + 5_000, map: {} };
    return {};
  }
}

export async function writeLogoPolicyOverlay(
  env: Pick<Env, 'CONFIG_KV'> | { CONFIG_KV?: Env['CONFIG_KV'] },
  map: TickerLogoPolicyMap,
): Promise<TickerLogoPolicyMap> {
  const kv = env.CONFIG_KV;
  if (!kv) throw new Error('CONFIG_KV is not bound');
  await kv.put(LOGO_POLICY_KV_NAME, JSON.stringify(map));
  primeLogoPolicyOverlay(map);
  return map;
}

export async function upsertLogoPolicySymbol(
  env: Pick<Env, 'CONFIG_KV'> | { CONFIG_KV?: Env['CONFIG_KV'] },
  symbol: string,
  policy: SymbolLogoPolicy,
): Promise<TickerLogoPolicyMap> {
  const current = await readLogoPolicyOverlay(env);
  const next = { ...current, [canonicalLogoPolicySymbol(symbol)]: policy };
  return writeLogoPolicyOverlay(env, next);
}
