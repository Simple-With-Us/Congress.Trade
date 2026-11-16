/**
 * src/admin/instrumentPricing.ts
 * OWNER: admin + prices
 *
 * Admin payload for the Instrument Pricing settings pane: capability matrix,
 * committee→industry mapping version, snapshot timestamp provenance counts,
 * and an exact-time lookup that refuses options / event contracts.
 */

import type { Env } from '../shared/types.ts';
import { all } from '../shared/db.ts';
import { COMMITTEE_SECTOR_RULES } from '../analytics/conflicts.ts';
import { COMMITTEE_SECTOR_MAPPING_VERSION } from '../export/pitScores.ts';
import { INSTRUMENT_CAPABILITY_LIST } from '../prices/instrumentCapabilities.ts';
import { lookupExactMinutePrice, type ExactPriceResult } from '../prices/exactPrice.ts';

export interface InstrumentPricingPayload {
  capabilities: typeof INSTRUMENT_CAPABILITY_LIST;
  committeeIndustry: {
    version: string;
    ruleCount: number;
    note: string;
  };
  snapshotProvenance: Array<{ timeProvenance: string; n: number }>;
}

export async function instrumentPricingPayload(env: Env): Promise<InstrumentPricingPayload> {
  const rows = await all<{ time_provenance: string | null; n: number }>(
    env.DB,
    `SELECT COALESCE(time_provenance, 'unknown') AS time_provenance, COUNT(*) AS n
       FROM latency_price_snapshots
      GROUP BY 1`,
  ).catch(() => [] as Array<{ time_provenance: string | null; n: number }>);

  return {
    capabilities: INSTRUMENT_CAPABILITY_LIST,
    committeeIndustry: {
      version: COMMITTEE_SECTOR_MAPPING_VERSION,
      ruleCount: COMMITTEE_SECTOR_RULES.length,
      note: 'Committee assignments are cross-referenced to GICS sectors on Trends conflicts and PIT scores. Minute pricing stays off for options and event contracts.',
    },
    snapshotProvenance: rows.map((r) => ({
      timeProvenance: r.time_provenance || 'unknown',
      n: Number(r.n) || 0,
    })),
  };
}

export async function lookupExactPriceForAdmin(
  env: Env,
  query: {
    ticker?: string | null;
    at?: string | null;
    isOption?: string | null;
    assetType?: string | null;
    assetName?: string | null;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<ExactPriceResult> {
  const flag = (query.isOption || '').trim().toLowerCase();
  const isOption = flag === '1' || flag === 'true' || flag === 'yes';
  return lookupExactMinutePrice(
    env,
    {
      ticker: query.ticker,
      atIso: query.at || '',
      isOption,
      assetType: query.assetType,
      assetName: query.assetName,
    },
    fetchImpl,
  );
}
