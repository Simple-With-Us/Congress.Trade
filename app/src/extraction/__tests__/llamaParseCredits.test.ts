/**
 * fetchLlamaParseCredits — live LlamaIndex Cloud account credit balance
 * across every key in LLAMAPARSE_API_KEY. Each key is its own free-tier org
 * (own 10k/month grant, own reset date) -- these tests pin that the report
 * sums correctly across mixed exhausted/healthy/errored accounts and never
 * throws on a single bad key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { clearLlamaParseCreditsCache, fetchLlamaParseCredits } from '../llamaParseCredits.ts';

function envWithKeys(keys: string[]): Env {
  return { LLAMAPARSE_API_KEY: keys.join(',') } as unknown as Env;
}

function orgResponse(id: string, name: string) {
  return new Response(JSON.stringify([{ id, name }]), { status: 200 });
}
function usageResponse(remaining: number, total: number, expiresAt: string) {
  return new Response(JSON.stringify({
    plan: { current_billing_period: { end_date: expiresAt } },
    usage: { active_free_credits_usage: [{ starting_balance: total, remaining_balance: remaining, expires_at: expiresAt }] },
  }), { status: 200 });
}

describe('fetchLlamaParseCredits', () => {
  beforeEach(() => {
    clearLlamaParseCreditsCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when no LlamaParse key is configured', async () => {
    const report = await fetchLlamaParseCredits({ LLAMAPARSE_API_KEY: '' } as unknown as Env);
    expect(report).toBeNull();
  });

  it('sums remaining/total across multiple keys, each its own account', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/organizations/org-a/usage')) return usageResponse(0, 10000, '2026-08-13T00:00:00Z');
      if (url.includes('/organizations/org-b/usage')) return usageResponse(9721, 10000, '2026-08-26T00:00:00Z');
      if (url.endsWith('/organizations')) {
        // Distinguish which key called by checking the Authorization header via a
        // second arg is awkward with this simple signature -- use call order.
        const callIndex = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/organizations')).length;
        return callIndex === 1 ? orgResponse('org-a', "Key One's Org") : orgResponse('org-b', "Key Two's Org");
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const report = await fetchLlamaParseCredits(envWithKeys(['key-1', 'key-2']));
    expect(report).not.toBeNull();
    expect(report?.accounts).toHaveLength(2);
    expect(report?.accounts[0]).toMatchObject({ keyIndex: 1, orgName: "Key One's Org", remaining: 0, total: 10000, exhausted: true });
    expect(report?.accounts[1]).toMatchObject({ keyIndex: 2, orgName: "Key Two's Org", remaining: 9721, total: 10000, exhausted: false });
    expect(report?.totals).toEqual({ remaining: 9721, total: 20000, accountsChecked: 2, accountsErrored: 0 });
  });

  it('reports a per-account error without failing the whole report when one key errors', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/organizations')) {
        const callIndex = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/organizations')).length;
        if (callIndex === 1) return new Response('unauthorized', { status: 401 });
        return orgResponse('org-b', "Healthy Org");
      }
      if (url.includes('/organizations/org-b/usage')) return usageResponse(10000, 10000, '2026-08-15T00:00:00Z');
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const report = await fetchLlamaParseCredits(envWithKeys(['bad-key', 'good-key']));
    expect(report?.accounts[0]).toMatchObject({ keyIndex: 1, error: 'organizations lookup 401', remaining: null });
    expect(report?.accounts[1]).toMatchObject({ keyIndex: 2, orgName: 'Healthy Org', remaining: 10000, exhausted: false });
    // The errored key must not count toward totals -- a null balance is not zero credits.
    expect(report?.totals).toEqual({ remaining: 10000, total: 10000, accountsChecked: 1, accountsErrored: 1 });
  });

  it('marks an account exhausted only at exactly zero remaining, not merely low', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/organizations')) return orgResponse('org-a', 'Org');
      if (url.includes('/usage')) return usageResponse(1, 10000, '2026-08-13T00:00:00Z');
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const report = await fetchLlamaParseCredits(envWithKeys(['key-1']));
    expect(report?.accounts[0]).toMatchObject({ remaining: 1, exhausted: false });
  });

  it('caches results for 5 minutes and skips re-fetching until forceRefresh', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/organizations')) return orgResponse('org-a', 'Org');
      if (url.includes('/usage')) return usageResponse(500, 10000, '2026-08-13T00:00:00Z');
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = envWithKeys(['key-1']);

    await fetchLlamaParseCredits(env);
    const callsAfterFirst = fetchMock.mock.calls.length;
    await fetchLlamaParseCredits(env);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst); // cached, no new calls

    await fetchLlamaParseCredits(env, { forceRefresh: true });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst); // bypassed cache
  });
});
