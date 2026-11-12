import { describe, it, expect } from "vitest";
import {
  TICKER_ALIASES,
  TICKER_RENAMES,
  TICKER_ACQUISITIONS,
  MKT_CAP_THRESHOLDS,
  API_PATHS,
  WINDOW_PRESETS,
  LAG_BUCKETS,
  DEFAULT_CONGRESS_TRADE_BASE_URL,
  DEFAULT_TRANSACTIONS_LIMIT,
  MAX_REFS_BATCH,
  APP_B_ORIGIN_TAG,
} from "../constants";

// =============================================================================
// TICKER_ALIASES
// =============================================================================

describe("TICKER_ALIASES", () => {
  it("maps known aliases to their current tickers", () => {
    expect(TICKER_ALIASES.FB).toBe("META");
    expect(TICKER_ALIASES.BRCM).toBe("AVGO");
    expect(TICKER_ALIASES.SQ).toBe("XYZ");
    expect(TICKER_ALIASES.GEHCV).toBe("GEHC");
    expect(TICKER_ALIASES.TWX).toBe("WBD");
    expect(TICKER_ALIASES.ATVI).toBe("MSFT");
    expect(TICKER_ALIASES.RHT).toBe("IBM");
  });

  it("is a frozen/readonly object", () => {
    expect(Object.isFrozen(TICKER_ALIASES)).toBe(true);
    expect(Object.isFrozen(TICKER_RENAMES)).toBe(true);
    expect(Object.isFrozen(TICKER_ACQUISITIONS)).toBe(true);
    expect(Object.keys(TICKER_ALIASES)).toHaveLength(7);
  });

  it("all alias keys are uppercase", () => {
    for (const key of Object.keys(TICKER_ALIASES)) {
      expect(key).toBe(key.toUpperCase());
    }
  });

  it("all alias values are uppercase", () => {
    for (const value of Object.values(TICKER_ALIASES)) {
      expect(value).toBe(value.toUpperCase());
    }
  });

  it("no alias maps to itself", () => {
    for (const [key, value] of Object.entries(TICKER_ALIASES)) {
      expect(key).not.toBe(value);
    }
  });
});

// =============================================================================
// TICKER_RENAMES / TICKER_ACQUISITIONS (rename-vs-acquisition split)
// =============================================================================

describe("TICKER_RENAMES", () => {
  it("maps continuous renames to their current tickers", () => {
    expect(TICKER_RENAMES.FB).toBe("META");
    expect(TICKER_RENAMES.SQ).toBe("XYZ");
    expect(TICKER_RENAMES.GEHCV).toBe("GEHC");
  });

  it("has exactly the 3 known continuous renames", () => {
    expect(Object.keys(TICKER_RENAMES)).toHaveLength(3);
  });

  it("does NOT contain acquisition sources", () => {
    for (const acqKey of Object.keys(TICKER_ACQUISITIONS)) {
      expect(TICKER_RENAMES).not.toHaveProperty(acqKey);
    }
  });

  it("all keys and values are uppercase, none self-mapping", () => {
    for (const [key, value] of Object.entries(TICKER_RENAMES)) {
      expect(key).toBe(key.toUpperCase());
      expect(value).toBe(value.toUpperCase());
      expect(key).not.toBe(value);
    }
  });
});

describe("TICKER_ACQUISITIONS", () => {
  it("maps delisting acquisitions to their successor tickers", () => {
    expect(TICKER_ACQUISITIONS.BRCM).toBe("AVGO");
    expect(TICKER_ACQUISITIONS.TWX).toBe("WBD");
    expect(TICKER_ACQUISITIONS.ATVI).toBe("MSFT");
    expect(TICKER_ACQUISITIONS.RHT).toBe("IBM");
  });

  it("has exactly the 4 known delisting acquisitions", () => {
    expect(Object.keys(TICKER_ACQUISITIONS)).toHaveLength(4);
  });

  it("does NOT contain rename sources", () => {
    for (const renameKey of Object.keys(TICKER_RENAMES)) {
      expect(TICKER_ACQUISITIONS).not.toHaveProperty(renameKey);
    }
  });

  it("all keys and values are uppercase, none self-mapping", () => {
    for (const [key, value] of Object.entries(TICKER_ACQUISITIONS)) {
      expect(key).toBe(key.toUpperCase());
      expect(value).toBe(value.toUpperCase());
      expect(key).not.toBe(value);
    }
  });
});

describe("TICKER_ALIASES = TICKER_RENAMES ∪ TICKER_ACQUISITIONS", () => {
  it("the two classes are disjoint (no shared source ticker)", () => {
    const renameKeys = new Set(Object.keys(TICKER_RENAMES));
    for (const acqKey of Object.keys(TICKER_ACQUISITIONS)) {
      expect(renameKeys.has(acqKey)).toBe(false);
    }
  });

  it("their key counts sum to the union count", () => {
    expect(
      Object.keys(TICKER_RENAMES).length +
        Object.keys(TICKER_ACQUISITIONS).length,
    ).toBe(Object.keys(TICKER_ALIASES).length);
  });

  it("the union is exactly the merge of both maps (backward-compatible)", () => {
    expect(TICKER_ALIASES).toEqual({
      ...TICKER_RENAMES,
      ...TICKER_ACQUISITIONS,
    });
  });

  it("every alias entry appears in exactly one class with the same target", () => {
    for (const [key, value] of Object.entries(TICKER_ALIASES)) {
      const inRename = TICKER_RENAMES[key as keyof typeof TICKER_RENAMES];
      const inAcq = TICKER_ACQUISITIONS[key as keyof typeof TICKER_ACQUISITIONS];
      const hits = [inRename, inAcq].filter((v) => v !== undefined);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toBe(value);
    }
  });
});

// =============================================================================
// MKT_CAP_THRESHOLDS
// =============================================================================

describe("MKT_CAP_THRESHOLDS", () => {
  it("has the correct threshold values", () => {
    expect(MKT_CAP_THRESHOLDS.MEGA).toBe(200_000_000_000);
    expect(MKT_CAP_THRESHOLDS.LARGE).toBe(10_000_000_000);
    expect(MKT_CAP_THRESHOLDS.MID).toBe(2_000_000_000);
    expect(MKT_CAP_THRESHOLDS.SMALL).toBe(300_000_000);
    expect(MKT_CAP_THRESHOLDS.MICRO).toBe(50_000_000);
  });

  it("thresholds are in descending order", () => {
    expect(MKT_CAP_THRESHOLDS.MEGA).toBeGreaterThan(MKT_CAP_THRESHOLDS.LARGE);
    expect(MKT_CAP_THRESHOLDS.LARGE).toBeGreaterThan(MKT_CAP_THRESHOLDS.MID);
    expect(MKT_CAP_THRESHOLDS.MID).toBeGreaterThan(MKT_CAP_THRESHOLDS.SMALL);
    expect(MKT_CAP_THRESHOLDS.SMALL).toBeGreaterThan(MKT_CAP_THRESHOLDS.MICRO);
  });
});

// =============================================================================
// API_PATHS
// =============================================================================

describe("API_PATHS", () => {
  it("has the health path", () => {
    expect(API_PATHS.HEALTH).toBe("/api/health");
  });

  it("has the transactions path", () => {
    expect(API_PATHS.TRANSACTIONS).toBe("/api/transactions");
  });

  it("has the stream path", () => {
    expect(API_PATHS.STREAM).toBe("/api/stream");
  });

  it("has the market bundle path", () => {
    expect(API_PATHS.MARKET_BUNDLE).toBe("/api/market/bundle");
  });

  it("has the market ref paths", () => {
    expect(API_PATHS.MARKET_REF).toBe("/api/market/ref");
    expect(API_PATHS.MARKET_REFS).toBe("/api/market/refs");
  });

  it("has the market prices and SPX paths", () => {
    expect(API_PATHS.MARKET_PRICES).toBe("/api/market/prices");
    expect(API_PATHS.MARKET_SPX).toBe("/api/market/spx");
  });

  it("has enrichment data paths", () => {
    expect(API_PATHS.MARKET_FUNDAMENTALS).toBe("/api/market/fundamentals");
    expect(API_PATHS.MARKET_ANALYST).toBe("/api/market/analyst");
    expect(API_PATHS.MARKET_INSIDER).toBe("/api/market/insider");
    expect(API_PATHS.MARKET_SHORT_VOLUME).toBe("/api/market/short-volume");
  });

  it("has analytics paths", () => {
    expect(API_PATHS.ANALYTICS_TICKER_LEADERBOARD).toBe(
      "/api/analytics/ticker-leaderboard",
    );
    expect(API_PATHS.ANALYTICS_CONVICTION).toBe("/api/analytics/conviction");
    expect(API_PATHS.ANALYTICS_MEMBER_LEADERBOARD).toBe(
      "/api/analytics/member-leaderboard",
    );
    expect(API_PATHS.ANALYTICS_CLUSTER_BUYS).toBe("/api/analytics/cluster-buys");
    expect(API_PATHS.ANALYTICS_MEMBER_PERFORMANCE).toBe("/api/analytics/member");
    expect(API_PATHS.ANALYTICS_TICKER_BACKTEST).toBe("/api/analytics/ticker");
    expect(API_PATHS.ANALYTICS_CONFLICTS).toBe("/api/analytics/conflicts");
  });

  it("has admin and export paths", () => {
    expect(API_PATHS.ADMIN_SECURITIES_IMPORT).toBe(
      "/api/admin/securities/import",
    );
    expect(API_PATHS.EXPORT_BULK_SNAPSHOT).toBe("/api/export/bulk-snapshot");
  });

  it("all paths start with /api/", () => {
    for (const path of Object.values(API_PATHS)) {
      expect(path.startsWith("/api/")).toBe(true);
    }
  });
});

// =============================================================================
// WINDOW_PRESETS
// =============================================================================

describe("WINDOW_PRESETS", () => {
  it("contains all expected presets", () => {
    expect(WINDOW_PRESETS).toEqual([
      "1d",
      "7d",
      "30d",
      "90d",
      "180d",
      "365d",
      "1825d",
      "all",
    ]);
  });

  it("has exactly 8 presets", () => {
    expect(WINDOW_PRESETS).toHaveLength(8);
  });

  it("all presets end with 'd' except 'all'", () => {
    for (const preset of WINDOW_PRESETS) {
      if (preset !== "all") {
        expect(preset.endsWith("d")).toBe(true);
      }
    }
  });
});

// =============================================================================
// LAG_BUCKETS
// =============================================================================

describe("LAG_BUCKETS", () => {
  it("contains all expected lag buckets", () => {
    expect(LAG_BUCKETS).toHaveLength(6);
    expect(LAG_BUCKETS[0]).toEqual({ label: "0-7d", max: 7 });
    expect(LAG_BUCKETS[1]).toEqual({ label: "8-14d", max: 14 });
    expect(LAG_BUCKETS[2]).toEqual({ label: "15-30d", max: 30 });
    expect(LAG_BUCKETS[3]).toEqual({ label: "31-45d", max: 45 });
    expect(LAG_BUCKETS[4]).toEqual({ label: "46-59d", max: 59 });
    expect(LAG_BUCKETS[5]).toEqual({ label: "60d+", max: null });
  });

  it("max values are ascending except for the final null", () => {
    for (let i = 0; i < LAG_BUCKETS.length - 2; i++) {
      const current = LAG_BUCKETS[i].max;
      const next = LAG_BUCKETS[i + 1].max;
      if (current !== null && next !== null) {
        expect(current).toBeLessThan(next);
      }
    }
  });

  it("the last bucket has null max (unbounded)", () => {
    expect(LAG_BUCKETS[LAG_BUCKETS.length - 1].max).toBeNull();
  });

  it("is deeply frozen at runtime", () => {
    expect(Object.isFrozen(LAG_BUCKETS)).toBe(true);
    expect(LAG_BUCKETS.every(Object.isFrozen)).toBe(true);
  });
});

// =============================================================================
// Defaults
// =============================================================================

describe("Default constants", () => {
  it("DEFAULT_CONGRESS_TRADE_BASE_URL is correct", () => {
    expect(DEFAULT_CONGRESS_TRADE_BASE_URL).toBe("https://congress.trade");
  });

  it("DEFAULT_TRANSACTIONS_LIMIT is 100", () => {
    expect(DEFAULT_TRANSACTIONS_LIMIT).toBe(100);
  });

  it("MAX_REFS_BATCH is 500", () => {
    expect(MAX_REFS_BATCH).toBe(500);
  });
});

// =============================================================================
// APP_B_ORIGIN_TAG
// =============================================================================

describe("APP_B_ORIGIN_TAG", () => {
  it("is the literal string 'app-b'", () => {
    expect(APP_B_ORIGIN_TAG).toBe("app-b");
  });

  it("is typed as const (string literal)", () => {
    // TypeScript compile-time check: this constant is used for origin tagging
    expect(typeof APP_B_ORIGIN_TAG).toBe("string");
  });
});
