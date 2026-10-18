import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  IsoDateSchema,
  IsoDateTimeSchema,
  ChamberSchema,
  PartyBucketSchema,
  OwnerSchema,
  TxTypeSchema,
  AssetTypeCategorySchema,
  MktCapBucketSchema,
  PriceCloseSchema,
  SecurityRefSchema,
  SecurityRefInputSchema,
  CongressTransactionSchema,
  TransactionsPageSchema,
  FundamentalRowSchema,
  AnalystRowSchema,
  InsiderRowSchema,
  ShortVolumeRowSchema,
  PriceSeriesSchema,
  SharePayloadSchema,
  CongressEventTypeSchema,
  CongressEventSchema,
  ConvictionTickerSchema,
  TickerLeaderSchema,
  ClusterBuySchema,
  MemberLeaderSchema,
  MemberPerformanceSchema,
  BacktestHorizonSchema,
  TickerBacktestSchema,
  CommitteeConflictSchema,
  SnapshotTableInfoSchema,
  SnapshotManifestSchema,
  ClientMemberSchema,
  ClientAssetSchema,
  ClientTransactionSchema,
  ClientFilingSchema,
  ClientTradeSchema,
  BundleResponseSchema,
  TransactionsQuerySchema,
  AmountBracketSchema,
  parseArray,
  parseSafe,
} from "../schemas";

// =============================================================================
// IoDateSchema
// =============================================================================

describe("IsoDateSchema", () => {
  it("accepts valid ISO dates", () => {
    expect(IsoDateSchema.safeParse("2024-01-15").success).toBe(true);
    expect(IsoDateSchema.safeParse("2020-02-29").success).toBe(true); // leap year
    expect(IsoDateSchema.safeParse("1999-12-31").success).toBe(true);
  });

  it("rejects invalid dates", () => {
    expect(IsoDateSchema.safeParse("2024-02-30").success).toBe(false); // Feb 30
    expect(IsoDateSchema.safeParse("2023-02-29").success).toBe(false); // non-leap
    expect(IsoDateSchema.safeParse("not-a-date").success).toBe(false);
  });

  it("rejects non-string types", () => {
    expect(IsoDateSchema.safeParse(12345).success).toBe(false);
    expect(IsoDateSchema.safeParse(null).success).toBe(false);
    expect(IsoDateSchema.safeParse(undefined).success).toBe(false);
  });

  it("rejects dates with time components", () => {
    expect(IsoDateSchema.safeParse("2024-01-15T00:00:00Z").success).toBe(false);
  });

  it("rejects malformed date strings", () => {
    expect(IsoDateSchema.safeParse("24-01-15").success).toBe(false);
    expect(IsoDateSchema.safeParse("2024/01/15").success).toBe(false);
    expect(IsoDateSchema.safeParse("2024-1-5").success).toBe(false);
  });
});

// =============================================================================
// IsoDateTimeSchema
// =============================================================================

describe("IsoDateTimeSchema", () => {
  it("accepts valid ISO 8601 UTC date-time strings", () => {
    expect(IsoDateTimeSchema.safeParse("2026-07-22T14:30:00Z").success).toBe(true);
    expect(IsoDateTimeSchema.safeParse("2026-07-22T14:30:00.000Z").success).toBe(true);
  });

  it("rejects non-ISO date-time formats", () => {
    expect(IsoDateTimeSchema.safeParse("2026-07-22 14:30:00").success).toBe(false);
    expect(IsoDateTimeSchema.safeParse("2026-07-22").success).toBe(false);
    expect(IsoDateTimeSchema.safeParse("invalid-datetime").success).toBe(false);
    expect(IsoDateTimeSchema.safeParse(12345).success).toBe(false);
  });
});

// =============================================================================
// Enum schemas
// =============================================================================

describe("ChamberSchema", () => {
  it("accepts valid chambers", () => {
    expect(ChamberSchema.safeParse("house").success).toBe(true);
    expect(ChamberSchema.safeParse("senate").success).toBe(true);
    expect(ChamberSchema.safeParse("executive").success).toBe(true);
  });

  it("rejects invalid chambers", () => {
    expect(ChamberSchema.safeParse("congress").success).toBe(false);
    expect(ChamberSchema.safeParse("").success).toBe(false);
    expect(ChamberSchema.safeParse("HOUSE").success).toBe(false);
    expect(ChamberSchema.safeParse("EXECUTIVE").success).toBe(false);
    expect(ChamberSchema.safeParse("president").success).toBe(false);
  });
});

describe("PartyBucketSchema", () => {
  it("accepts valid party buckets", () => {
    expect(PartyBucketSchema.safeParse("D").success).toBe(true);
    expect(PartyBucketSchema.safeParse("R").success).toBe(true);
    expect(PartyBucketSchema.safeParse("O").success).toBe(true);
  });

  it("rejects invalid values", () => {
    expect(PartyBucketSchema.safeParse("I").success).toBe(false);
    expect(PartyBucketSchema.safeParse("d").success).toBe(false);
    expect(PartyBucketSchema.safeParse("").success).toBe(false);
  });
});

describe("OwnerSchema", () => {
  it("accepts valid owner types", () => {
    expect(OwnerSchema.safeParse("self").success).toBe(true);
    expect(OwnerSchema.safeParse("spouse").success).toBe(true);
    expect(OwnerSchema.safeParse("joint").success).toBe(true);
    expect(OwnerSchema.safeParse("dependent").success).toBe(true);
  });

  it("rejects invalid owner types", () => {
    expect(OwnerSchema.safeParse("child").success).toBe(false);
    expect(OwnerSchema.safeParse("SELF").success).toBe(false);
  });
});

describe("TxTypeSchema", () => {
  it("accepts B/S/E and coerces legacy P to B", () => {
    expect(TxTypeSchema.safeParse("B").success).toBe(true);
    expect(TxTypeSchema.safeParse("S").success).toBe(true);
    expect(TxTypeSchema.safeParse("E").success).toBe(true);
    const p = TxTypeSchema.safeParse("P");
    expect(p.success).toBe(true);
    if (p.success) expect(p.data).toBe("B");
  });

  it("rejects invalid transaction types", () => {
    expect(TxTypeSchema.safeParse("p").success).toBe(false);
    expect(TxTypeSchema.safeParse("Buy").success).toBe(false);
    expect(TxTypeSchema.safeParse("X").success).toBe(false);
  });
});

describe("AssetTypeCategorySchema", () => {
  it("accepts all valid categories", () => {
    const categories = [
      "public_equity",
      "private_equity",
      "option",
      "fund",
      "fixed_income_government",
      "fixed_income_corporate",
      "fixed_income_asset_backed",
      "cash",
      "retirement_or_529",
      "real_estate",
      "private_fund",
      "business_interest",
      "crypto",
      "insurance_annuity",
      "trust",
      "commodity_collectible",
      "derivative",
      "intellectual_property",
      "receivable",
      "other_security",
      "other",
      "unknown",
    ];
    for (const cat of categories) {
      expect(AssetTypeCategorySchema.safeParse(cat).success).toBe(true);
    }
  });

  it("rejects invalid categories", () => {
    expect(AssetTypeCategorySchema.safeParse("stocks").success).toBe(false);
    expect(AssetTypeCategorySchema.safeParse("").success).toBe(false);
  });
});

describe("MktCapBucketSchema", () => {
  it("accepts all valid buckets", () => {
    const buckets = ["mega", "large", "mid", "small", "micro", "nano"];
    for (const bucket of buckets) {
      expect(MktCapBucketSchema.safeParse(bucket).success).toBe(true);
    }
  });

  it("rejects invalid buckets", () => {
    expect(MktCapBucketSchema.safeParse("giant").success).toBe(false);
    expect(MktCapBucketSchema.safeParse("MEGA").success).toBe(false);
    expect(MktCapBucketSchema.safeParse("").success).toBe(false);
  });
});

// =============================================================================
// PriceCloseSchema
// =============================================================================

describe("PriceCloseSchema", () => {
  it("accepts valid price close with volume", () => {
    const result = PriceCloseSchema.safeParse({
      date: "2024-01-15",
      close: 185.25,
      volume: 50000000,
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid price close without volume", () => {
    const result = PriceCloseSchema.safeParse({
      date: "2024-01-15",
      close: 185.25,
    });
    expect(result.success).toBe(true);
  });

  it("normalizes a wire-level null volume to an omitted optional value", () => {
    expect(PriceCloseSchema.parse({ date: "2024-01-15", close: 185.25, volume: null }))
      .toEqual({ date: "2024-01-15", close: 185.25, volume: undefined });
  });

  it("rejects missing required fields", () => {
    expect(PriceCloseSchema.safeParse({ date: "2024-01-15" }).success).toBe(false);
    expect(PriceCloseSchema.safeParse({ close: 100 }).success).toBe(false);
  });

  it("rejects invalid date", () => {
    expect(
      PriceCloseSchema.safeParse({ date: "not-valid", close: 100 }).success,
    ).toBe(false);
  });
});

// =============================================================================
// SecurityRefSchema
// =============================================================================

describe("SecurityRefSchema", () => {
  const validRef = {
    ticker: "AAPL",
    companyName: "Apple Inc.",
    sector: "Technology",
    industry: "Consumer Electronics",
    assetClass: "stock",
    isEtf: false,
    isAdr: false,
    country: "US",
    stateHq: "CA",
    stateOfIncorp: "CA",
    exchange: "NASDAQ",
    exchangeShort: "NASDAQ",
    currency: "USD",
    marketCap: 3_500_000_000_000,
    marketCapBucket: "mega",
    sharesOutstanding: 15_000_000_000,
    ipoDate: "1980-12-12",
    cik: "0000320193",
    sicCode: "3571",
    sicDescription: "Electronic Computers",
    source: "enriched",
  };

  it("parses a fully populated ref", () => {
    const result = SecurityRefSchema.safeParse(validRef);
    expect(result.success).toBe(true);
  });

  it("rejects empty ticker", () => {
    expect(SecurityRefSchema.safeParse({ ...validRef, ticker: "" }).success).toBe(false);
  });

  it("accepts read tickers up to the same 20-character limit as imports", () => {
    const ticker = "A".repeat(20);
    expect(SecurityRefInputSchema.safeParse({ ticker }).success).toBe(true);
    expect(SecurityRefSchema.safeParse({ ...validRef, ticker }).success).toBe(true);
  });

  it("accepts null for nullable fields", () => {
    const result = SecurityRefSchema.safeParse({
      ...validRef,
      sector: null,
      marketCap: null,
      marketCapBucket: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts missing optional fields", () => {
    // enrichedAt and currentPrice are optional — omit them
    const result = SecurityRefSchema.safeParse(validRef);
    expect(result.success).toBe(true);
  });

  it("rejects non-numeric marketCap", () => {
    expect(
      SecurityRefSchema.safeParse({ ...validRef, marketCap: "3.5T" }).success,
    ).toBe(false);
  });

  it("rejects invalid marketCapBucket", () => {
    expect(
      SecurityRefSchema.safeParse({ ...validRef, marketCapBucket: "giant" }).success,
    ).toBe(false);
  });

  it("rejects non-boolean isEtf", () => {
    expect(
      SecurityRefSchema.safeParse({ ...validRef, isEtf: "yes" }).success,
    ).toBe(false);
  });

  it("accepts optional enrichedAt and currentPrice when present", () => {
    const result = SecurityRefSchema.safeParse({
      ...validRef,
      enrichedAt: "2024-01-15T10:30:00Z",
      currentPrice: 185.25,
      currentPriceDate: "2024-01-15",
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// SecurityRefInputSchema
// =============================================================================

describe("SecurityRefInputSchema", () => {
  it("accepts partial input with just ticker", () => {
    const result = SecurityRefInputSchema.safeParse({ ticker: "AAPL" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ticker).toBe("AAPL");
    }
  });

  it("accepts partial input with extra fields", () => {
    const result = SecurityRefInputSchema.safeParse({
      ticker: "MSFT",
      companyName: "Microsoft Corp.",
      sector: "Technology",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty ticker", () => {
    expect(SecurityRefInputSchema.safeParse({ ticker: "" }).success).toBe(false);
  });

  it("accepts ticker lengths up to 20", () => {
    expect(SecurityRefInputSchema.safeParse({ ticker: "A".repeat(20) }).success).toBe(true);
  });

  it("rejects ticker longer than 20", () => {
    const result = SecurityRefInputSchema.safeParse({ ticker: "A".repeat(21) });
    expect(result.success).toBe(false);
  });

  it("rejects invalid types for non-ticker fields", () => {
    const result = SecurityRefInputSchema.safeParse({
      ticker: "AAPL",
      isEtf: "not-boolean",
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// CongressTransactionSchema
// =============================================================================

describe("CongressTransactionSchema", () => {
  const validTx = {
    id: "tx-abc-123",
    docId: "doc-xyz-456",
    filerId: null,
    txDate: "2026-01-15",
    owner: "self",
    assetName: "Apple Inc.",
    ticker: "AAPL",
    assetType: "stock",
    txType: "P",
    amountMin: 1001,
    amountMax: 15000,
    estValue: 8000,
    isOption: false,
    capGainsOver200: false,
    rawText: "purchased Apple shares",
    confidence: 0.95,
    source: "primary",
    createdAt: "2026-01-16T00:00:00Z",
    cursorSeq: 50,
  };

  it("parses a valid transaction", () => {
    const result = CongressTransactionSchema.safeParse(validTx);
    expect(result.success).toBe(true);
  });

  it("rejects empty id", () => {
    expect(
      CongressTransactionSchema.safeParse({ ...validTx, id: "" }).success,
    ).toBe(false);
  });

  it("rejects missing docId", () => {
    const { docId: _, ...rest } = validTx;
    expect(CongressTransactionSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects invalid txType", () => {
    expect(
      CongressTransactionSchema.safeParse({ ...validTx, txType: "X" }).success,
    ).toBe(false);
  });

  it("rejects invalid owner", () => {
    expect(
      CongressTransactionSchema.safeParse({ ...validTx, owner: "child" }).success,
    ).toBe(false);
  });

  it("rejects non-boolean isOption", () => {
    expect(
      CongressTransactionSchema.safeParse({ ...validTx, isOption: "true" }).success,
    ).toBe(false);
  });

  it("rejects non-boolean capGainsOver200", () => {
    expect(
      CongressTransactionSchema.safeParse({ ...validTx, capGainsOver200: 1 }).success,
    ).toBe(false);
  });

  it("accepts null for nullable fields", () => {
    const result = CongressTransactionSchema.safeParse({
      ...validTx,
      filerId: null,
      ticker: null,
      amountMin: null,
      amountMax: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional fields when absent", () => {
    const {
      estValue: _estValue,
      confidence: _confidence,
      source: _source,
      createdAt: _createdAt,
      cursorSeq: _cursorSeq,
      ...minimalTx
    } = validTx;
    const result = CongressTransactionSchema.safeParse(minimalTx);
    expect(result.success).toBe(true);
  });

  it("accepts optional fields when present", () => {
    const result = CongressTransactionSchema.safeParse({
      ...validTx,
      fullName: "John Doe",
      state: "NY",
      photoUrl: "https://example.com/photo.jpg",
      filedDate: "2026-01-15",
      firstSeenAt: "2026-01-15T10:00:00Z",
      sourceUrl: "https://example.com/doc",
      refCompanyName: "Apple Inc.",
      refSector: "Technology",
      refMarketCap: 3_500_000_000_000,
      refMarketCapBucket: "mega",
      refCountry: "US",
      refExchangeShort: "NASDAQ",
      refAssetClass: "stock",
      assetTypeName: "Common Stock",
      assetTypeCategory: "public_equity",
      assetTypeCategoryLabel: "Public Equity",
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// TransactionsPageSchema
// =============================================================================

describe("TransactionsPageSchema", () => {
  const validTx = {
    id: "tx-1",
    docId: "doc-1",
    filerId: null,
    txDate: "2026-01-15",
    owner: "self",
    assetName: "Apple Inc.",
    ticker: "AAPL",
    assetType: "stock",
    txType: "P",
    amountMin: 1001,
    amountMax: 15000,
    estValue: 8000,
    isOption: false,
    capGainsOver200: false,
    rawText: "purchased Apple shares",
    confidence: 0.95,
    source: "primary",
    createdAt: "2026-01-16T00:00:00Z",
    cursorSeq: 50,
  };

  it("parses a valid transactions page", () => {
    const result = TransactionsPageSchema.safeParse({
      transactions: [validTx],
      cursor: 50,
      count: 1,
      total: 100,
      limit: 20,
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional offset", () => {
    const result = TransactionsPageSchema.safeParse({
      transactions: [validTx],
      cursor: 50,
      count: 1,
      total: 100,
      limit: 20,
      offset: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing transactions array", () => {
    expect(
      TransactionsPageSchema.safeParse({
        cursor: 50,
        count: 1,
        total: 100,
        limit: 20,
      }).success,
    ).toBe(false);
  });

  it("rejects non-array transactions", () => {
    expect(
      TransactionsPageSchema.safeParse({
        transactions: "not-an-array",
        cursor: 50,
        count: 1,
        total: 100,
        limit: 20,
      }).success,
    ).toBe(false);
  });

  it("rejects empty transactions array with invalid tx", () => {
    expect(
      TransactionsPageSchema.safeParse({
        transactions: [{ ...validTx, id: "" }],
        cursor: 50,
        count: 1,
        total: 100,
        limit: 20,
      }).success,
    ).toBe(false);
  });

  it("rejects read rows missing required cursor provenance", () => {
    const { cursorSeq: _cursorSeq, ...withoutCursor } = validTx;
    expect(TransactionsPageSchema.safeParse({
      transactions: [withoutCursor],
      cursor: 50,
      count: 1,
      total: 100,
      limit: 20,
    }).success).toBe(false);
  });
});

// =============================================================================
// FundamentalRowSchema
// =============================================================================

describe("FundamentalRowSchema", () => {
  it("parses a fully populated row", () => {
    const result = FundamentalRowSchema.safeParse({
      ticker: "AAPL",
      date: "2024-01-15",
      peRatio: 30.5,
      eps: 6.42,
      beta: 1.2,
      dividendYield: 0.005,
      week52High: 200,
      week52Low: 150,
      fcfYield: 0.035,
      debtToEquity: 1.5,
      epsGrowth: 0.1,
    });
    expect(result.success).toBe(true);
  });

  it("parses a minimal row (just ticker and date)", () => {
    const result = FundamentalRowSchema.safeParse({
      ticker: "AAPL",
      date: "2024-01-15",
    });
    expect(result.success).toBe(true);
  });

  it("normalizes nullable wire values and retains read metadata", () => {
    expect(FundamentalRowSchema.parse({
      ticker: "AAPL",
      date: "2024-01-15",
      peRatio: null,
      source: null,
      updatedAt: "2024-01-15T10:00:00Z",
    })).toEqual({
      ticker: "AAPL",
      date: "2024-01-15",
      peRatio: undefined,
      source: undefined,
      updatedAt: "2024-01-15T10:00:00Z",
    });
  });

  it("rejects missing ticker", () => {
    expect(
      FundamentalRowSchema.safeParse({ date: "2024-01-15" }).success,
    ).toBe(false);
  });

  it("rejects invalid date", () => {
    expect(
      FundamentalRowSchema.safeParse({ ticker: "AAPL", date: "bad" }).success,
    ).toBe(false);
  });
});

// =============================================================================
// AnalystRowSchema
// =============================================================================

describe("AnalystRowSchema", () => {
  it("parses a fully populated row", () => {
    const result = AnalystRowSchema.safeParse({
      ticker: "AAPL",
      date: "2024-01-15",
      rating: "Buy",
      strongBuy: 20,
      buy: 15,
      hold: 5,
      sell: 1,
      strongSell: 0,
      targetMean: 210,
      targetHigh: 250,
      targetLow: 180,
      targetMedian: 205,
    });
    expect(result.success).toBe(true);
  });

  it("parses a minimal row", () => {
    const result = AnalystRowSchema.safeParse({
      ticker: "AAPL",
      date: "2024-01-15",
    });
    expect(result.success).toBe(true);
  });

  it("normalizes nullable wire values and retains analyst metadata", () => {
    const result = AnalystRowSchema.parse({
      ticker: "AAPL",
      date: "2024-01-15",
      rating: null,
      targetMean: null,
      analystCount: 12,
      source: "provider",
      updatedAt: "2024-01-15T10:00:00Z",
    });
    expect(result).toMatchObject({ ticker: "AAPL", analystCount: 12, source: "provider" });
    expect(result.rating).toBeUndefined();
    expect(result.targetMean).toBeUndefined();
  });
});

// =============================================================================
// InsiderRowSchema
// =============================================================================

describe("InsiderRowSchema", () => {
  it("parses a valid row", () => {
    const result = InsiderRowSchema.safeParse({
      ticker: "AAPL",
      date: "2024-01-15",
      sentiment: 0.75,
      buyFilings: 10,
      sellFilings: 5,
      buyShares: 100000,
      sellShares: 50000,
      owners: ["owner1", "owner2"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required sentiment", () => {
    const result = InsiderRowSchema.safeParse({
      ticker: "AAPL",
      date: "2024-01-15",
      buyFilings: 10,
      sellFilings: 5,
      buyShares: 100000,
      sellShares: 50000,
      owners: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-array owners", () => {
    const result = InsiderRowSchema.safeParse({
      ticker: "AAPL",
      date: "2024-01-15",
      sentiment: 0.5,
      buyFilings: 10,
      sellFilings: 5,
      buyShares: 100000,
      sellShares: 50000,
      owners: "owner1",
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// ShortVolumeRowSchema
// =============================================================================

describe("ShortVolumeRowSchema", () => {
  it("parses a valid row", () => {
    const result = ShortVolumeRowSchema.safeParse({
      ticker: "AAPL",
      date: "2024-01-15",
      ratio: 0.35,
      elevated: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing elevated flag", () => {
    expect(
      ShortVolumeRowSchema.safeParse({
        ticker: "AAPL",
        date: "2024-01-15",
        ratio: 0.35,
      }).success,
    ).toBe(false);
  });
});

// =============================================================================
// PriceSeriesSchema
// =============================================================================

describe("PriceSeriesSchema", () => {
  it("parses a valid price series", () => {
    const result = PriceSeriesSchema.safeParse({
      ticker: "AAPL",
      closes: [
        { date: "2024-01-15", close: 185.0 },
        { date: "2024-01-16", close: 186.5, volume: 5000000 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("parses with optional currentPrice", () => {
    const result = PriceSeriesSchema.safeParse({
      ticker: "AAPL",
      closes: [{ date: "2024-01-15", close: 185.0 }],
      currentPrice: 187.0,
      currentPriceDate: "2024-01-17",
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty closes", () => {
    const result = PriceSeriesSchema.safeParse({
      ticker: "AAPL",
      closes: [],
    });
    expect(result.success).toBe(true); // empty array is fine
  });

  it("normalizes nullable current price fields from the read API", () => {
    expect(PriceSeriesSchema.parse({
      ticker: "AAPL",
      closes: [],
      currentPrice: null,
      currentPriceDate: null,
    })).toEqual({
      ticker: "AAPL",
      closes: [],
      currentPrice: undefined,
      currentPriceDate: undefined,
    });
  });

  it("rejects closes with invalid entry", () => {
    const result = PriceSeriesSchema.safeParse({
      ticker: "AAPL",
      closes: [{ date: "bad-date", close: 100 }],
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// SharePayloadSchema
// =============================================================================

describe("SharePayloadSchema", () => {
  it("parses a fully populated payload", () => {
    const result = SharePayloadSchema.safeParse({
      refs: [{ ticker: "AAPL" }, { ticker: "MSFT", companyName: "Microsoft" }],
      spx: [{ date: "2024-01-15", close: 4700 }],
      prices: [
        {
          ticker: "AAPL",
          closes: [{ date: "2024-01-15", close: 185.0 }],
        },
      ],
      insider: [
        {
          ticker: "AAPL",
          date: "2024-01-15",
          sentiment: 0.5,
          buyFilings: 1,
          sellFilings: 0,
          buyShares: 1000,
          sellShares: 0,
          owners: [],
        },
      ],
      shortVolume: [
        { ticker: "AAPL", date: "2024-01-15", ratio: 0.3, elevated: false },
      ],
      fundamentals: [{ ticker: "AAPL", date: "2024-01-15", peRatio: 30 }],
      analyst: [{ ticker: "AAPL", date: "2024-01-15", rating: "Buy", source: "fmp", asOfTimestamp: "2026-07-24T16:34:08Z" }],
      trades: [
        {
          docId: "H-2026-20024100",
          chamber: "house",
          source: "house_clerk",
          sourceUrl: "https://disclosures-clerk.house.gov/public_disc/ptr-pdf/2026/20024100.pdf",
          filerName: "Nancy Pelosi",
          ticker: "NVDA",
          txType: "P",
          transactionDate: "2026-07-15",
          transactionTimestamp: "2026-07-15T00:00:00Z",
          disclosureDate: "2026-07-22",
          disclosureTimestamp: "2026-07-22T14:30:00Z",
          extractedTimestamp: "2026-07-22T14:31:05Z",
          amountMin: 1000001,
          amountMax: 5000000,
        },
      ],
      origin: "app-b",
    });
    expect(result.success).toBe(true);
  });

  it("parses an empty payload (all fields optional)", () => {
    const result = SharePayloadSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("parses payload with only refs", () => {
    const result = SharePayloadSchema.safeParse({
      refs: [{ ticker: "AAPL" }],
    });
    expect(result.success).toBe(true);
  });

  it("parses payload with only prices", () => {
    const result = SharePayloadSchema.safeParse({
      prices: [
        { ticker: "AAPL", closes: [{ date: "2024-01-15", close: 185.0 }] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid ref in refs array", () => {
    const result = SharePayloadSchema.safeParse({
      refs: [{ ticker: "" }],
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// CongressEventTypeSchema
// =============================================================================

describe("CongressEventTypeSchema", () => {
  it("accepts all valid event types", () => {
    const types = [
      "congress.trade",
      "insider.update",
      "ref.upsert",
      "price.eod",
      "spx.eod",
    ];
    for (const t of types) {
      expect(CongressEventTypeSchema.safeParse(t).success).toBe(true);
    }
  });

  it("rejects invalid event types", () => {
    expect(CongressEventTypeSchema.safeParse("unknown.event").success).toBe(false);
    expect(CongressEventTypeSchema.safeParse("CONGRESS.TRADE").success).toBe(false);
  });
});

// =============================================================================
// CongressEventSchema
// =============================================================================

describe("CongressEventSchema", () => {
  it("parses an event with known type", () => {
    const result = CongressEventSchema.safeParse({
      type: "congress.trade",
      id: "evt-1",
      seq: 1,
      emittedAt: "2024-01-15T10:00:00Z",
      data: { ticker: "AAPL", txType: "P" },
    });
    expect(result.success).toBe(true);
  });

  it("parses an event with custom string type", () => {
    const result = CongressEventSchema.safeParse({
      type: "custom.event.v2",
    });
    expect(result.success).toBe(true);
  });

  it("parses minimal event (type only)", () => {
    const result = CongressEventSchema.safeParse({ type: "congress.trade" });
    expect(result.success).toBe(true);
  });

  it("rejects missing type", () => {
    expect(CongressEventSchema.safeParse({}).success).toBe(false);
  });

  it.each([
    { type: "" },
    { type: "   " },
    { type: "custom", id: "" },
    { type: "custom", seq: -1 },
    { type: "custom", seq: 1.5 },
    { type: "custom", emittedAt: "not-a-date" },
  ])("rejects malformed event envelope %#", (event) => {
    expect(CongressEventSchema.safeParse(event).success).toBe(false);
  });
});

// =============================================================================
// ConvictionTickerSchema
// =============================================================================

describe("ConvictionTickerSchema", () => {
  it("parses a fully populated conviction ticker", () => {
    const result = ConvictionTickerSchema.safeParse({
      ticker: "AAPL",
      name: "Apple Inc.",
      convictionScore: 0.85,
      direction: "BUY",
      fallback: false,
      memberCount: 12,
      tradeCount: 25,
      directionalMembers: 8,
      directionalTrades: 15,
      netSentiment: 0.6,
      estNetFlowUsd: 5000000,
      parties: { D: 7, R: 5 },
    });
    expect(result.success).toBe(true);
  });

  it("parses minimal conviction ticker", () => {
    const result = ConvictionTickerSchema.safeParse({
      ticker: "AAPL",
      convictionScore: null,
      direction: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid direction", () => {
    expect(
      ConvictionTickerSchema.safeParse({
        ticker: "AAPL",
        convictionScore: 0.5,
        direction: "HOLD",
      }).success,
    ).toBe(false);
  });
});

// =============================================================================
// Additional analytics schemas
// =============================================================================

describe("TickerLeaderSchema", () => {
  it("parses a valid ticker leader", () => {
    const result = TickerLeaderSchema.safeParse({
      ticker: "AAPL",
      name: "Apple Inc.",
      tradeCount: 42,
      buyCount: 30,
      sellCount: 12,
      memberCount: 8,
      estVolumeUsd: 10_000_000,
      estNetFlowUsd: 5_000_000,
      netSentiment: 0.4,
    });
    expect(result.success).toBe(true);
  });
});

describe("ClusterBuySchema", () => {
  it("parses a valid cluster buy", () => {
    const result = ClusterBuySchema.safeParse({
      ticker: "AAPL",
      name: "Apple Inc.",
      txType: "P",
      memberCount: 5,
      tradeCount: 10,
      estVolumeUsd: 2_000_000,
      topMembers: [
        { filerId: "f1", fullName: "John Doe", tradeCount: 3 },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("MemberLeaderSchema", () => {
  it("parses a valid member leader", () => {
    const result = MemberLeaderSchema.safeParse({
      filerId: "f1",
      fullName: "John Doe",
      tradeCount: 50,
      estVolumeUsd: 5_000_000,
      estNetFlowUsd: 2_000_000,
      netSentiment: 0.3,
    });
    expect(result.success).toBe(true);
  });
});

describe("MemberPerformanceSchema", () => {
  it("parses valid performance data", () => {
    const result = MemberPerformanceSchema.safeParse({
      tradeCount: 100,
      scoredCount: 80,
      winRate: 0.65,
      medianReturn: 0.012,
      medianExcess: 0.005,
      avgReturn: 0.01,
      avgExcess: 0.003,
      avgAnnualizedExcess: 0.04,
    });
    expect(result.success).toBe(true);
  });

  it("accepts null values for nullable fields", () => {
    const result = MemberPerformanceSchema.safeParse({
      winRate: null,
      medianReturn: null,
      medianExcess: null,
      avgReturn: null,
      avgExcess: null,
      avgAnnualizedExcess: null,
    });
    expect(result.success).toBe(true);
  });
});

describe("MemberDualPerformanceSchema", () => {
  it("parses dual-anchor envelope from App A", async () => {
    const { MemberDualPerformanceSchema } = await import("../schemas");
    const result = MemberDualPerformanceSchema.safeParse({
      filerId: "P000197",
      side: "buys",
      buyCount: 20,
      tradeDate: { scoredCount: 15, avgExcess: 0.02, winRate: 0.6 },
      filingDate: { scoredCount: 14, avgExcess: 0.01, avgAnnualizedExcess: 0.03, winRate: 0.55 },
      performance: { scoredCount: 15, avgExcess: 0.02 },
    });
    expect(result.success).toBe(true);
  });
});

describe("BacktestHorizonSchema", () => {
  it("parses valid horizon data", () => {
    const result = BacktestHorizonSchema.safeParse({
      days: 30,
      tradeCount: 15,
      n: 15,
      medianReturn: 0.02,
      avgReturn: 0.018,
      winRate: 0.6,
      medianExcess: 0.01,
      avgExcess: 0.008,
    });
    expect(result.success).toBe(true);
  });

  it("accepts null for nullable fields", () => {
    const result = BacktestHorizonSchema.safeParse({
      days: 30,
      tradeCount: 5,
      n: 5,
      medianReturn: null,
      avgReturn: null,
      winRate: null,
      medianExcess: null,
      avgExcess: null,
    });
    expect(result.success).toBe(true);
  });
});

describe("TickerBacktestSchema", () => {
  it("parses valid backtest data", () => {
    const result = TickerBacktestSchema.safeParse({
      ticker: "AAPL",
      txType: "P",
      totalBuyEvents: 25,
      pricedDays: 20,
      horizons: [
        { days: 7, tradeCount: 5, n: 5, medianReturn: 0.01, avgReturn: 0.008, winRate: 0.55, medianExcess: 0.005, avgExcess: 0.003 },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("CommitteeConflictSchema", () => {
  it("parses valid conflict data", () => {
    const result = CommitteeConflictSchema.safeParse({
      id: "conflict-1",
      ticker: "AAPL",
      sector: "Technology",
      txType: "P",
      txDate: "2024-01-15",
      filerId: "f1",
      memberName: "John Doe",
      chamber: "house",
      partyBucket: "D",
      viaCommittees: ["Armed Services", "Finance"],
      estAmountUsd: 50000,
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// Snapshot schemas
// =============================================================================

describe("SnapshotTableInfoSchema", () => {
  it("parses valid table info", () => {
    const result = SnapshotTableInfoSchema.safeParse({
      objectKey: "transactions/2024-01-15.ndjson",
      rowCount: 1000,
    });
    expect(result.success).toBe(true);
  });
});

describe("SnapshotManifestSchema", () => {
  it("parses valid manifest", () => {
    const result = SnapshotManifestSchema.safeParse({
      generatedAt: "2024-01-15T10:00:00Z",
      snapshotDate: "2024-01-15",
      runId: "run-123",
      format: "ndjson",
      tables: {
        transactions: {
          objectKey: "transactions/2024-01-15.ndjson",
          rowCount: 1000,
        },
      },
      schema: {
        transactions: ["id", "ticker", "txDate"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid format", () => {
    const result = SnapshotManifestSchema.safeParse({
      generatedAt: "2024-01-15T10:00:00Z",
      snapshotDate: "2024-01-15",
      runId: "run-123",
      format: "json",
      tables: {},
      schema: {},
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// Client-facing schemas
// =============================================================================

describe("ClientMemberSchema", () => {
  it("parses valid member", () => {
    const result = ClientMemberSchema.safeParse({
      id: "m1",
      name: "John Doe",
      chamber: "house",
      party: "Democratic",
      state: "NY",
      photoUrl: "https://example.com/photo.jpg",
    });
    expect(result.success).toBe(true);
  });

  it("accepts null for nullable fields", () => {
    const result = ClientMemberSchema.safeParse({
      id: null,
      name: null,
      chamber: null,
      party: null,
      state: null,
      photoUrl: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts executive chamber for OGE 278-T filers", () => {
    const result = ClientMemberSchema.safeParse({
      id: "m2",
      name: "Jane President",
      chamber: "executive",
      party: null,
      state: null,
      photoUrl: null,
    });
    expect(result.success).toBe(true);
  });
});

describe("ClientAssetSchema", () => {
  it("parses valid asset", () => {
    const result = ClientAssetSchema.safeParse({
      name: "Apple Inc.",
      ticker: "AAPL",
      type: "stock",
      sector: "Technology",
      marketCapBucket: "mega",
    });
    expect(result.success).toBe(true);
  });

  it("parses valid asset with new optional fields", () => {
    const result = ClientAssetSchema.safeParse({
      name: "Apple Inc.",
      ticker: "AAPL",
      type: "stock",
      sector: "Technology",
      marketCapBucket: "mega",
      companyName: "Apple Incorporated",
      logoUrl: "https://logo.com/apple.png",
      typeName: "Common Stock",
      typeCategory: "equity",
      typeCategoryLabel: "Equity",
    });
    expect(result.success).toBe(true);
    expect(result.data?.companyName).toBe("Apple Incorporated");
    expect(result.data?.logoUrl).toBe("https://logo.com/apple.png");
    expect(result.data?.typeName).toBe("Common Stock");
    expect(result.data?.typeCategory).toBe("equity");
    expect(result.data?.typeCategoryLabel).toBe("Equity");
  });
});

describe("ClientTransactionSchema", () => {
  it("parses valid transaction", () => {
    const result = ClientTransactionSchema.safeParse({
      date: "2024-01-15",
      type: "P",
      owner: "self",
      amountMin: 1001,
      amountMax: 15000,
      estValue: 8000,
      isOption: false,
    });
    expect(result.success).toBe(true);
  });
});

describe("ClientFilingSchema", () => {
  it("parses valid filing", () => {
    const result = ClientFilingSchema.safeParse({
      filedDate: "2024-01-15",
      firstSeenAt: "2024-01-15T10:00:00Z",
      sourceUrl: "https://example.com/doc",
    });
    expect(result.success).toBe(true);
  });
});

describe("ClientTradeSchema", () => {
  it("parses a valid client trade", () => {
    const result = ClientTradeSchema.safeParse({
      id: "trade-1",
      cursor: 42,
      docId: "doc-1",
      member: {
        id: "m1",
        name: "John Doe",
        chamber: "house",
        party: "D",
        state: "NY",
        photoUrl: null,
      },
      asset: {
        name: "Apple Inc.",
        ticker: "AAPL",
        type: "stock",
        sector: "Technology",
        marketCapBucket: "mega",
      },
      transaction: {
        date: "2024-01-15",
        type: "P",
        owner: "self",
        amountMin: 1001,
        amountMax: 15000,
        isOption: false,
      },
      filing: {
        filedDate: "2024-01-16",
        firstSeenAt: "2024-01-16T10:00:00Z",
        sourceUrl: "https://example.com/doc",
      },
      confidence: 0.95,
      source: "primary",
    });
    expect(result.success).toBe(true);
  });

  it("parses a valid client trade with manual source", () => {
    const result = ClientTradeSchema.safeParse({
      id: "trade-1",
      cursor: 42,
      docId: "doc-1",
      member: {
        id: "m1",
        name: "John Doe",
        chamber: "house",
        party: "D",
        state: "NY",
        photoUrl: null,
      },
      asset: {
        name: "Apple Inc.",
        ticker: "AAPL",
        type: "stock",
        sector: "Technology",
        marketCapBucket: "mega",
      },
      transaction: {
        date: "2024-01-15",
        type: "P",
        owner: "self",
        amountMin: 1001,
        amountMax: 15000,
        isOption: false,
      },
      filing: {
        filedDate: "2024-01-16",
        firstSeenAt: "2024-01-16T10:00:00Z",
        sourceUrl: "https://example.com/doc",
      },
      confidence: 0.95,
      source: "manual",
    });
    expect(result.success).toBe(true);
    expect(result.data?.source).toBe("manual");
  });

  it("rejects invalid source", () => {
    const valid = {
      id: "trade-1",
      cursor: 42,
      docId: "doc-1",
      member: {
        id: null, name: null, chamber: null, party: null, state: null, photoUrl: null,
      },
      asset: {
        name: "Apple Inc.", ticker: "AAPL", type: null, sector: null, marketCapBucket: null,
      },
      transaction: {
        date: null, type: "P", owner: null, amountMin: null, amountMax: null, isOption: false,
      },
      filing: {
        filedDate: null, firstSeenAt: null, sourceUrl: null,
      },
      confidence: 0.95,
      source: "unknown_source",
    };
    expect(ClientTradeSchema.safeParse(valid).success).toBe(false);
  });
});

// =============================================================================
// BundleResponseSchema
// =============================================================================

describe("BundleResponseSchema", () => {
  it("parses valid bundle response", () => {
    const result = BundleResponseSchema.safeParse({
      ticker: "AAPL",
      ref: {
        ticker: "AAPL",
        companyName: "Apple Inc.",
        sector: null,
        industry: null,
        assetClass: null,
        isEtf: false,
        isAdr: false,
        country: null,
        stateHq: null,
        stateOfIncorp: null,
        exchange: null,
        exchangeShort: null,
        currency: null,
        marketCap: null,
        marketCapBucket: null,
        sharesOutstanding: null,
        ipoDate: null,
        cik: null,
        sicCode: null,
        sicDescription: null,
        source: null,
      },
      prices: {
        ticker: "AAPL",
        closes: [{ date: "2024-01-15", close: 185.0 }],
      },
      spx: [{ date: "2024-01-15", close: 4700 }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts null ref and prices", () => {
    const result = BundleResponseSchema.safeParse({
      ticker: "AAPL",
      ref: null,
      prices: null,
      spx: [{ date: "2024-01-15", close: 4700 }],
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// TransactionsQuerySchema
// =============================================================================

describe("TransactionsQuerySchema", () => {
  it("parses empty query (all optional)", () => {
    const result = TransactionsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("parses fully populated query", () => {
    const result = TransactionsQuerySchema.safeParse({
      since: "42",
      from: "2024-01-01",
      to: "2024-12-31",
      ticker: "AAPL",
      member: "John Doe",
      chamber: "house",
      type: "P",
      limit: 20,
      order: "asc",
    });
    expect(result.success).toBe(true);
  });

  it.each(["42", 42, 0])("accepts numeric resume cursor %s", (since) => {
    expect(TransactionsQuerySchema.safeParse({ since }).success).toBe(true);
  });

  it("rejects malformed cursor strings", () => {
    expect(TransactionsQuerySchema.safeParse({ since: "42x" }).success).toBe(false);
    expect(TransactionsQuerySchema.safeParse({ since: "2024-01-01" }).success).toBe(false);
  });

  it("accepts executive chamber", () => {
    expect(
      TransactionsQuerySchema.safeParse({ chamber: "executive" }).success,
    ).toBe(true);
  });

  it("rejects invalid chamber", () => {
    expect(
      TransactionsQuerySchema.safeParse({ chamber: "congress" }).success,
    ).toBe(false);
  });

  it("rejects invalid type", () => {
    expect(
      TransactionsQuerySchema.safeParse({ type: "X" }).success,
    ).toBe(false);
  });

  it("rejects non-integer limit", () => {
    expect(
      TransactionsQuerySchema.safeParse({ limit: 20.5 }).success,
    ).toBe(false);
  });

  it("rejects negative limit", () => {
    expect(
      TransactionsQuerySchema.safeParse({ limit: -5 }).success,
    ).toBe(false);
  });

  it("rejects invalid order", () => {
    expect(
      TransactionsQuerySchema.safeParse({ order: "random" }).success,
    ).toBe(false);
  });
});

// =============================================================================
// Helper: parseArray
// =============================================================================

describe("parseArray", () => {
  it("parses a valid array of objects", () => {
    const result = parseArray(
      z.object({ ticker: z.string(), close: z.number() }),
      [
        { ticker: "AAPL", close: 185 },
        { ticker: "MSFT", close: 420 },
      ],
    );
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0].ticker).toBe("AAPL");
  });

  it("returns null for invalid array items", () => {
    const result = parseArray(
      z.object({ ticker: z.string(), close: z.number() }),
      [{ ticker: "AAPL", close: "not-a-number" }],
    );
    expect(result).toBeNull();
  });

  it("returns null for non-array input", () => {
    const result = parseArray(z.string(), "not-an-array");
    expect(result).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(parseArray(z.string(), null)).toBeNull();
    expect(parseArray(z.string(), undefined)).toBeNull();
  });

  it("returns empty array for empty array input", () => {
    const result = parseArray(z.string(), []);
    expect(result).toEqual([]);
  });

  it("parses array of strings", () => {
    const result = parseArray(z.string(), ["a", "b", "c"]);
    expect(result).toEqual(["a", "b", "c"]);
  });
});

// =============================================================================
// Helper: parseSafe
// =============================================================================

describe("parseSafe", () => {
  it("parses a valid object", () => {
    const result = parseSafe(
      z.object({ ticker: z.string() }),
      { ticker: "AAPL" },
    );
    expect(result).not.toBeNull();
    expect(result!.ticker).toBe("AAPL");
  });

  it("returns null for invalid data", () => {
    const result = parseSafe(
      z.object({ ticker: z.string() }),
      { ticker: 123 },
    );
    expect(result).toBeNull();
  });

  it("returns null for null input", () => {
    expect(parseSafe(z.string(), null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseSafe(z.string(), undefined)).toBeNull();
  });

  it("parses a plain string", () => {
    const result = parseSafe(z.string(), "hello");
    expect(result).toBe("hello");
  });

  it("parses an enum value", () => {
    const result = parseSafe(ChamberSchema, "house");
    expect(result).toBe("house");
  });

  it("returns null for invalid enum", () => {
    const result = parseSafe(ChamberSchema, "congress");
    expect(result).toBeNull();
  });
});

// =============================================================================
// AmountBracketSchema
// =============================================================================

describe("AmountBracketSchema", () => {
  it("accepts valid bracket with max > min", () => {
    const result = AmountBracketSchema.safeParse({ min: 1000, max: 5000 });
    expect(result.success).toBe(true);
  });

  it("accepts valid bracket with max === min", () => {
    const result = AmountBracketSchema.safeParse({ min: 1000, max: 1000 });
    expect(result.success).toBe(true);
  });

  it("accepts valid bracket with max === null", () => {
    const result = AmountBracketSchema.safeParse({ min: 1000, max: null });
    expect(result.success).toBe(true);
  });

  it("rejects bracket with max < min (inverted bounds)", () => {
    const result = AmountBracketSchema.safeParse({ min: 5000, max: 1000 });
    expect(result.success).toBe(false);
  });

  it("rejects negative min", () => {
    const result = AmountBracketSchema.safeParse({ min: -100, max: 1000 });
    expect(result.success).toBe(false);
  });
});
