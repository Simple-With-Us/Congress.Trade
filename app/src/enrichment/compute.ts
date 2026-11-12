/**
 * src/enrichment/compute.ts
 * OWNER: enrichment
 *
 * Pure helpers for asset enrichment: market-cap bucketing, a coarse SIC→sector
 * mapping (the free SEC-EDGAR fallback when FMP's GICS sector is unavailable),
 * the daily API-budget arithmetic, and a provider-merge that lets a richer
 * provider (FMP) win over a coarser one (EDGAR) field-by-field. All pure +
 * deterministic so they unit-test without network or DB.
 */

import { marketCapBucket as sharedMarketCapBucket } from '@jaywedgeworth22/congress-trading-shared';
import { normalizeCompanyName } from '../shared/companyName.ts';
import type { MktCapBucket, SecurityRef } from './types.ts';

/** Bucket a USD market cap into the standard size tiers. null for missing/≤0. */
export function marketCapBucket(n: number | null | undefined): MktCapBucket | null {
  return sharedMarketCapBucket(n);
}

/**
 * Map a numeric SIC code to a coarse sector via the SEC's SIC division ranges.
 * Free (SEC EDGAR exposes the SIC), but much coarser than GICS — used only when
 * a richer sector (FMP) isn't available. null for missing/invalid input.
 */
export function sicToSector(sic: string | number | null | undefined): string | null {
  if (sic == null || sic === '') return null;
  const n = typeof sic === 'number' ? sic : parseInt(String(sic), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1000) return 'Agriculture, Forestry & Fishing';
  if (n < 1500) return 'Mining';
  if (n < 1800) return 'Construction';
  if (n < 4000) return 'Manufacturing';
  if (n < 5000) return 'Transportation & Utilities';
  if (n < 5200) return 'Wholesale Trade';
  if (n < 6000) return 'Retail Trade';
  if (n < 6800) return 'Finance, Insurance & Real Estate';
  if (n < 9000) return 'Services';
  return 'Public Administration';
}

/**
 * Remaining FMP calls allowed in the current day, given the daily cap, calls
 * already used, and an optional per-run max. Never negative.
 */
export function remainingBudget(cap: number, usedToday: number, runMax?: number): number {
  const left = Math.max(0, Math.floor(cap) - Math.max(0, Math.floor(usedToday)));
  if (runMax != null && Number.isFinite(runMax)) return Math.max(0, Math.min(left, Math.floor(runMax)));
  return left;
}

/**
 * Merge provider partials into a single SecurityRef. Later partials override
 * earlier ones field-by-field, but only where they provide a non-null value —
 * so a coarse base (EDGAR) can be filled first and a richer one (FMP) layered on
 * top without erasing fields the richer source happens to lack. Booleans are
 * OR-ed. `marketCapBucket` is recomputed from the merged marketCap.
 */
export function mergeRefs(ticker: string, partials: Array<Partial<SecurityRef> | null>): SecurityRef {
  const out: SecurityRef = {
    ticker,
    companyName: null, sector: null, industry: null, assetClass: null,
    isEtf: false, isAdr: false, country: null, stateHq: null, stateOfIncorp: null,
    exchange: null, exchangeShort: null, currency: null, marketCap: null,
    marketCapBucket: null, sharesOutstanding: null, ipoDate: null, cik: null, sicCode: null,
    sicDescription: null, source: null,
  };
  const sources: string[] = [];
  for (const p of partials) {
    if (!p) continue;
    if (p.source && sources.indexOf(p.source) < 0) sources.push(p.source);
    for (const k of Object.keys(p) as Array<keyof SecurityRef>) {
      if (k === 'ticker' || k === 'source') continue;
      const v = p[k];
      if (k === 'isEtf' || k === 'isAdr') {
        if (v === true) (out as unknown as Record<string, unknown>)[k as string] = true;
        continue;
      }
      if (v != null && v !== '') (out as unknown as Record<string, unknown>)[k as string] = v;
    }
  }
  out.companyName = normalizeCompanyName(out.companyName);
  out.marketCapBucket = marketCapBucket(out.marketCap);
  out.source = sources.length ? sources.join('+') : null;
  return out;
}
