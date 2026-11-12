import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../shared/types.ts';
import {
  HOUSE_GRID_ASSET_SNAP_CONFIDENCE_DROP,
  clearHouseGridSecurityCatalogCache,
  loadHouseGridSecurityCatalog,
  snapHouseGridAssets,
  type HouseGridSecurityCatalog,
} from '../houseGridAssetSnap.ts';

const catalog: HouseGridSecurityCatalog = {
  entries: [
    { ticker: 'AAPL', name: 'Apple Inc.' },
    { ticker: 'ZTS', name: 'Zoetis Inc. Class A' },
    { ticker: 'ORLY', name: "O'Reilly Automotive, Inc." },
    { ticker: 'BAC', name: 'Bank of America Corporation' },
    { ticker: 'NXPI', name: 'NXP Semiconductors N.V.' },
    { ticker: 'NFLX', name: 'Netflix, Inc.' },
    { ticker: 'MSFT', name: 'Microsoft Corporation' },
    { ticker: 'AAAA', name: 'Aaaaax Holdings' },
    { ticker: 'AAAB', name: 'Aaaaay Holdings' },
  ],
};

function row(assetName: string, confidence = 0.97, ticker: string | null = null) {
  return { assetName, ticker, confidence, supplementalText: 'grid page 3' };
}

describe('house grid asset snap', () => {
  it('keeps a clear read and can fill a missing ticker without raising confidence', () => {
    const [snapped] = snapHouseGridAssets([row('APPLE INC CMN', 0.97)], catalog);
    expect(snapped.assetName).toBe('APPLE INC CMN');
    expect(snapped.ticker).toBe('AAPL');
    expect(snapped.confidence).toBe(0.97);
    expect(snapped.supplementalText).toBe('grid page 3');
  });

  it('rewrites a one-letter proper noun and drops confidence below the publish gate', () => {
    const [snapped] = snapHouseGridAssets([row('OETIS INC CMN CLASS A')], catalog);
    expect(snapped.assetName).toBe('ZOETIS INC CMN CLASS A');
    expect(snapped.ticker).toBe('ZTS');
    expect(snapped.confidence).toBeCloseTo(0.97 - HOUSE_GRID_ASSET_SNAP_CONFIDENCE_DROP, 5);
    expect(snapped.confidence).toBeLessThan(0.95);
    expect(snapped.supplementalText).toContain('asset name snapped');
  });

  it('splits a catalog apostrophe instead of gluing the corrected name', () => {
    const [snapped] = snapHouseGridAssets([row('D REILLY AUTOMOTIVE INC CMN', 0.8)], catalog);
    expect(snapped.assetName).toBe('O REILLY AUTOMOTIVE INC CMN');
    expect(snapped.ticker).toBe('ORLY');
    expect(snapped.confidence).toBeCloseTo(0.77, 5);
  });

  it('fixes the issuer on a hybrid line and does not infer an equity ticker', () => {
    const [snapped] = snapHouseGridAssets(
      [row('BAN OF AMERICA CORP HYBRID PERPETUAL', 0.97)],
      catalog,
    );
    expect(snapped.assetName).toBe('BANK OF AMERICA CORP HYBRID PERPETUAL');
    expect(snapped.ticker).toBeNull();
    expect(snapped.confidence).toBeLessThan(0.95);
  });

  it('restores N.V. as two tokens when the letters were glued', () => {
    const [snapped] = snapHouseGridAssets([row('NXP SEMICONDUCTOR NV CMN', 0.9)], catalog);
    expect(snapped.assetName).toBe('NXP SEMICONDUCTORS N V CMN');
    expect(snapped.ticker).toBe('NXPI');
  });

  it('does not override an existing ticker that names a different security', () => {
    const [snapped] = snapHouseGridAssets([row('OETIS INC CMN CLASS A', 0.97, 'MSFT')], catalog);
    expect(snapped.assetName).toBe('OETIS INC CMN CLASS A');
    expect(snapped.ticker).toBe('MSFT');
    expect(snapped.confidence).toBe(0.97);
  });

  it('keeps a ticker that agrees with the snapped name', () => {
    const [snapped] = snapHouseGridAssets([row('OETIS INC CMN CLASS A', 0.5, 'ZTS')], catalog);
    expect(snapped.assetName).toBe('ZOETIS INC CMN CLASS A');
    expect(snapped.ticker).toBe('ZTS');
    expect(snapped.confidence).toBeCloseTo(0.47, 5);
  });

  it('leaves a two-edit short name alone', () => {
    const [snapped] = snapHouseGridAssets([row('NETFUX INC')], catalog);
    expect(snapped.assetName).toBe('NETFUX INC');
    expect(snapped.ticker).toBeNull();
    expect(snapped.confidence).toBe(0.97);
  });

  it('leaves a name that is equally close to two securities', () => {
    const [snapped] = snapHouseGridAssets([row('AAAAAZ HOLDINGS')], catalog);
    expect(snapped.assetName).toBe('AAAAAZ HOLDINGS');
    expect(snapped.confidence).toBe(0.97);
  });

  it('does not rewrite an option line', () => {
    const [snapped] = snapHouseGridAssets([row('CALL/OETIS INC CMN CLASS A')], catalog);
    expect(snapped.assetName).toBe('CALL/OETIS INC CMN CLASS A');
    expect(snapped.ticker).toBeNull();
  });

  it('returns the same rows when the catalog is empty', () => {
    const input = [row('OETIS INC CMN CLASS A')];
    const snapped = snapHouseGridAssets(input, { entries: [] });
    expect(snapped[0]).toBe(input[0]);
  });

  it('does not rewrite a five-character key whose runner-up is two edits away', () => {
    const [snapped] = snapHouseGridAssets(
      [row('ABCDF INC')],
      {
        entries: [
          { ticker: 'ABCD', name: 'Abcde Inc.' },
          { ticker: 'ABCX', name: 'Abcxx Inc.' },
        ],
      },
    );
    expect(snapped.assetName).toBe('ABCDF INC');
    expect(snapped.ticker).toBeNull();
    expect(snapped.confidence).toBe(0.97);
  });
});

function catalogDb(query: (sql: string) => { results: unknown[] } | Error): Env {
  return {
    DB: {
      prepare(sql: string) {
        return {
          all: async () => {
            const result = query(sql);
            if (result instanceof Error) throw result;
            return result;
          },
        };
      },
    },
  } as unknown as Env;
}

describe('house grid security catalog cache', () => {
  beforeEach(() => {
    clearHouseGridSecurityCatalogCache();
  });

  it('caches a successful load and a missing table', async () => {
    let calls = 0;
    const env = catalogDb((sql) => {
      calls += 1;
      if (sql.includes('securities_ref')) {
        return { results: [{ ticker: 'AAPL', company_name: 'Apple Inc.' }] };
      }
      throw new Error('no such table: securities_master');
    });
    const first = await loadHouseGridSecurityCatalog(env);
    const second = await loadHouseGridSecurityCatalog(env);
    expect(first.entries.some((entry) => entry.ticker === 'AAPL')).toBe(true);
    expect(second).toBe(first);
    expect(calls).toBe(2);
  });

  it('does not cache a lock, so the next load retries', async () => {
    let calls = 0;
    const env = catalogDb(() => {
      calls += 1;
      throw new Error('SQLITE_BUSY: database is locked');
    });
    const first = await loadHouseGridSecurityCatalog(env);
    const second = await loadHouseGridSecurityCatalog(env);
    expect(first.entries.length).toBeGreaterThan(0);
    expect(second).not.toBe(first);
    expect(calls).toBe(4);
  });
});
