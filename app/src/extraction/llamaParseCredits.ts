/**
 * src/extraction/llamaParseCredits.ts
 *
 * Live LlamaParse (LlamaIndex Cloud) free-credit balance across every key in
 * LLAMAPARSE_API_KEY. Each key belongs to its own free-tier organization (a
 * separate signup, each with its own 10,000-credit/month grant and its own
 * monthly reset date) -- LlamaIndex's usage/rate limits are account-scoped,
 * not per-key, so a shared "credits used" number only makes sense summed
 * per-account, not divided evenly across keys. This module calls
 * LlamaIndex's own account API (GET /organizations, then
 * GET /organizations/:id/usage) for each key and reports the real balance --
 * nothing in this repo's own ledger (llmSpend.ts) knows this number, since
 * that ledger tracks Congress.Trade's own metered USD cost, not LlamaParse's
 * separate free-credit grant.
 */

import type { Env } from '../shared/types.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

const LLAMAINDEX_API_BASE = 'https://api.cloud.llamaindex.ai/api/v1';
const CREDITS_TTL_MS = 5 * 60 * 1000;

export interface LlamaParseAccountCredits {
  keyIndex: number;
  orgId: string | null;
  orgName: string | null;
  remaining: number | null;
  total: number | null;
  resetsAt: string | null;
  exhausted: boolean;
  error: string | null;
}

export interface LlamaParseCreditsReport {
  checkedAt: string;
  accounts: LlamaParseAccountCredits[];
  totals: { remaining: number; total: number; accountsChecked: number; accountsErrored: number };
}

interface OrgListEntry {
  id?: string;
  name?: string;
}

interface OrgUsageResponse {
  plan?: { current_billing_period?: { end_date?: string } };
  usage?: {
    active_free_credits_usage?: Array<{ starting_balance?: number; remaining_balance?: number; expires_at?: string }>;
  };
}

async function fetchAccountCredits(env: Env, keyIndex: number, key: string): Promise<LlamaParseAccountCredits> {
  const base: LlamaParseAccountCredits = {
    keyIndex, orgId: null, orgName: null, remaining: null, total: null,
    resetsAt: null, exhausted: false, error: null,
  };
  const runtime = { envOverride: env };
  try {
    const orgsRes = await trackedFetch(
      `${LLAMAINDEX_API_BASE}/organizations`,
      { headers: { Authorization: `Bearer ${key}` } },
      { service: 'llamaparse-account', operation: 'list-organizations' },
      fetch,
      runtime,
    );
    if (!orgsRes.ok) return { ...base, error: `organizations lookup ${orgsRes.status}` };
    const orgs = (await orgsRes.json()) as OrgListEntry[];
    const org = orgs?.[0];
    if (!org?.id) return { ...base, error: 'no organization found for this key' };

    const usageRes = await trackedFetch(
      `${LLAMAINDEX_API_BASE}/organizations/${org.id}/usage`,
      { headers: { Authorization: `Bearer ${key}` } },
      { service: 'llamaparse-account', operation: 'read-usage' },
      fetch,
      runtime,
    );
    if (!usageRes.ok) return { ...base, orgId: org.id, orgName: org.name ?? null, error: `usage lookup ${usageRes.status}` };
    const usage = (await usageRes.json()) as OrgUsageResponse;
    const grant = usage.usage?.active_free_credits_usage?.[0];
    const remaining = typeof grant?.remaining_balance === 'number' ? grant.remaining_balance : null;
    const total = typeof grant?.starting_balance === 'number' ? grant.starting_balance : null;
    return {
      ...base,
      orgId: org.id,
      orgName: org.name ?? null,
      remaining,
      total,
      resetsAt: grant?.expires_at ?? usage.plan?.current_billing_period?.end_date ?? null,
      exhausted: remaining === 0,
    };
  } catch (err) {
    return { ...base, error: (err as Error).message };
  }
}

let creditsCache: { loadedAt: number; report: LlamaParseCreditsReport } | null = null;

/** Drop the in-process credits cache (tests / admin force-refresh). */
export function clearLlamaParseCreditsCache(): void {
  creditsCache = null;
}

/**
 * Fetch (TTL-cached, 5 min) the live LlamaParse free-credit balance across
 * every key in LLAMAPARSE_API_KEY. Returns null only when no key is
 * configured at all; a single key's own fetch failure is reported per-account
 * (`error` field) rather than failing the whole report.
 */
export async function fetchLlamaParseCredits(
  env: Env,
  opts: { forceRefresh?: boolean } = {},
): Promise<LlamaParseCreditsReport | null> {
  const now = Date.now();
  if (!opts.forceRefresh && creditsCache && now - creditsCache.loadedAt < CREDITS_TTL_MS) {
    return creditsCache.report;
  }
  const raw = (await resolveSecret(env, 'LLAMAPARSE_API_KEY')).value;
  const keys = (raw ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) return null;

  const accounts = await Promise.all(keys.map((key, i) => fetchAccountCredits(env, i + 1, key)));
  let remaining = 0;
  let total = 0;
  let accountsChecked = 0;
  let accountsErrored = 0;
  for (const a of accounts) {
    if (a.error || a.remaining == null || a.total == null) {
      accountsErrored += 1;
      continue;
    }
    accountsChecked += 1;
    remaining += a.remaining;
    total += a.total;
  }
  const report: LlamaParseCreditsReport = {
    checkedAt: new Date().toISOString(),
    accounts,
    totals: { remaining, total, accountsChecked, accountsErrored },
  };
  creditsCache = { loadedAt: now, report };
  return report;
}
