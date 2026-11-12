import { describe, expect, it, vi } from "vitest";
import { CongressTradeClient, normalizeSecurityRef } from "../client";
import { SecurityRefSchema } from "../schemas";

function mockClient(fetchFn: typeof fetch) {
  return new CongressTradeClient({
    baseUrl: "https://custom.congress.trade",
    fetch: fetchFn,
  });
}

const validRef = {
  ticker: "AAPL",
  companyName: null,
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
};

const emptyTransactionsPage = {
  transactions: [],
  cursor: 0,
  count: 0,
  total: 0,
  limit: 100,
};

describe("CongressTradeClient", () => {
  describe("request plumbing", () => {
    it("sends request with correct url and headers", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ref: validRef }),
      });

      const client = new CongressTradeClient({
        baseUrl: "https://custom.congress.trade",
        token: "secret-token",
        fetch: mockFetch,
      });

      const result = await client.getRef("AAPL");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://custom.congress.trade/api/market/ref/AAPL");
      expect(init.method).toBe("GET");
      expect(init.headers).toEqual({
        "content-type": "application/json",
        accept: "application/json",
        authorization: "Bearer secret-token",
      });
      expect(result).toEqual(validRef);
    });

    it("strips trailing slash from baseUrl", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ref: null }) });
      const client = new CongressTradeClient({ baseUrl: "https://api.example.com/", fetch: mockFetch });
      await client.getRef("AAPL");
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.example.com/api/market/ref/AAPL");
    });

    it("returns null for a missing ref and throws other HTTP errors", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
      const client = mockClient(mockFetch);
      await expect(client.getRef("NOPE")).resolves.toBeNull();

      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      await expect(client.getRef("NOPE")).rejects.toThrow("Request failed: GET /api/market/ref/NOPE -> HTTP 500");
    });
  });

  describe("createSubscription", () => {
    it("creates a subscription via POST", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: "sub-1",
          secret: "generated-secret-123",
          streamUrl: "/api/stream?subscription=sub-1&token=generated-secret-123",
        }),
      });
      const client = mockClient(mockFetch);
      const result = await client.createSubscription("client-1");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://custom.congress.trade/api/subscriptions");
      expect(init.method).toBe("POST");
      expect(result).toEqual({
        id: "sub-1",
        secret: "generated-secret-123",
        streamUrl: "/api/stream?subscription=sub-1&token=generated-secret-123",
      });
    });

    it("sends desiredSecret when long enough", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: "sub-1", secret: "my-custom-secret-1" }),
      });
      const client = mockClient(mockFetch);
      await client.createSubscription("client-1", "my-custom-secret-1");
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body.secret).toBe("my-custom-secret-1");
    });

    it("rejects desired secrets outside the server's 16-256 character range", async () => {
      const mockFetch = vi.fn();
      const client = mockClient(mockFetch);
      await expect(client.createSubscription("client-1", "short")).rejects.toThrow("16-256 characters");
      await expect(client.createSubscription("client-1", "s".repeat(257))).rejects.toThrow("16-256 characters");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("throws on HTTP error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 409 });
      const client = mockClient(mockFetch);
      await expect(client.createSubscription("client-1")).rejects.toThrow(
        "Request failed: POST /api/subscriptions -> HTTP 409",
      );
    });

    it("throws when response has no id or secret", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });
      const client = mockClient(mockFetch);
      await expect(client.createSubscription("client-1")).rejects.toThrow("Invalid subscription create response");
    });
  });

  describe("market data endpoints", () => {
    it("getBundle returns ref, prices, and spx", async () => {
      const mockData = {
        ticker: "MSFT",
        ref: { ...validRef, ticker: "MSFT" },
        prices: { ticker: "MSFT", closes: [] },
        spx: [{ date: "2026-01-01", close: 5000 }],
      };
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => mockData });
      const client = mockClient(mockFetch);
      const result = await client.getBundle("MSFT", { from: "2026-01-01", to: "2026-06-01" });
      expect(result.ticker).toBe("MSFT");
      expect(result.ref).toEqual({ ...validRef, ticker: "MSFT" });
      expect(result.prices).toEqual({ ticker: "MSFT", closes: [] });
      expect(result.spx).toEqual([{ date: "2026-01-01", close: 5000 }]);
    });

    it("getBundle handles explicit null/empty fields and rejects a missing envelope", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ticker: "MSFT", ref: null, prices: null, spx: [] }),
      });
      const client = mockClient(mockFetch);
      const result = await client.getBundle("MSFT");
      expect(result.ref).toBeNull();
      expect(result.prices).toBeNull();
      expect(result.spx).toEqual([]);
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      await expect(client.getBundle("MSFT")).rejects.toThrow("Invalid market bundle response");
    });

    it("getPrices rejects a malformed response with no closes array", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ticker: "AAPL" }) });
      const client = mockClient(mockFetch);
      await expect(client.getPrices("AAPL", { from: "2026-01-01" }))
        .rejects.toThrow("Invalid market prices response");
    });

    it("getPrices returns data when closes present", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ticker: "AAPL", closes: [{ date: "2026-01-01", close: 150 }] }),
      });
      const client = mockClient(mockFetch);
      const result = await client.getPrices("AAPL");
      expect(result).toEqual({ ticker: "AAPL", closes: [{ date: "2026-01-01", close: 150 }] });
    });

    it("getSpx returns closes array", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ closes: [{ date: "2026-01-01", close: 5000 }] }),
      });
      const client = mockClient(mockFetch);
      const result = await client.getSpx({ from: "2026-01-01", to: "2026-06-01" });
      expect(result).toEqual([{ date: "2026-01-01", close: 5000 }]);
    });

    it("getSpx accepts an explicit empty array and rejects a missing envelope", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ closes: [] }) });
      const client = mockClient(mockFetch);
      const result = await client.getSpx();
      expect(result).toEqual([]);
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      await expect(client.getSpx()).rejects.toThrow("Invalid SPX prices response");
    });

    it("getFundamentals returns rows array", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ticker: "AAPL",
          rows: [{ date: "2026-01-01", peRatio: null, source: null, updatedAt: "2026-01-01T00:00:00Z" }],
        }),
      });
      const client = mockClient(mockFetch);
      const result = await client.getFundamentals("AAPL", { from: "2026-01-01" });
      expect(result).toEqual([{
        ticker: "AAPL",
        date: "2026-01-01",
        peRatio: undefined,
        source: undefined,
        updatedAt: "2026-01-01T00:00:00Z",
      }]);
    });

    it("getFundamentals accepts explicit empty rows and rejects a missing envelope", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rows: [] }) });
      const client = mockClient(mockFetch);
      const result = await client.getFundamentals("AAPL");
      expect(result).toEqual([]);
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      await expect(client.getFundamentals("AAPL")).rejects.toThrow("Invalid market fundamentals response");
    });

    it("getAnalyst returns rows array", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ticker: "AAPL",
          rows: [{ date: "2026-01-01", rating: null, analystCount: 10 }],
        }),
      });
      const client = mockClient(mockFetch);
      const result = await client.getAnalyst("AAPL");
      expect(result).toEqual([{ ticker: "AAPL", date: "2026-01-01", rating: undefined, analystCount: 10 }]);
    });

    it("getInsider injects the scoped ticker and preserves nullable read values", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ticker: "AAPL",
          rows: [{
            date: "2026-01-01",
            sentiment: null,
            buyFilings: null,
            sellFilings: 1,
            buyShares: null,
            sellShares: 20,
            owners: [],
          }],
        }),
      });
      const client = mockClient(mockFetch);
      await expect(client.getInsider("AAPL")).resolves.toEqual([{
        ticker: "AAPL",
        date: "2026-01-01",
        sentiment: null,
        buyFilings: null,
        sellFilings: 1,
        buyShares: null,
        sellShares: 20,
        owners: [],
      }]);
    });

    it("getShortVolume injects the scoped ticker and preserves a null ratio", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ticker: "AAPL", rows: [{ date: "2026-01-01", ratio: null, elevated: false }] }),
      });
      const client = mockClient(mockFetch);
      await expect(client.getShortVolume("AAPL")).resolves.toEqual([{
        ticker: "AAPL",
        date: "2026-01-01",
        ratio: null,
        elevated: false,
      }]);
    });

    it("getRefs returns empty array for empty input", async () => {
      const mockFetch = vi.fn();
      const client = mockClient(mockFetch);
      const result = await client.getRefs([]);
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("getRef handles null ref", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ref: null }) });
      const client = mockClient(mockFetch);
      const result = await client.getRef("NOPE");
      expect(result).toBeNull();
    });

    it("normalizes the producer's missing sharesOutstanding field to null", async () => {
      const { sharesOutstanding: _omitted, ...producerRef } = validRef;
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ref: producerRef }) });
      const client = mockClient(mockFetch);
      await expect(client.getRef("AAPL")).resolves.toEqual(validRef);
    });

    it("rejects malformed typed payloads instead of returning unsafe casts", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ref: { ticker: 7 } }) });
      const client = mockClient(mockFetch);
      await expect(client.getRef("AAPL")).rejects.toThrow("Invalid market ref response");
    });
  });

  describe("normalizeSecurityRef (exported for direct-parse consumers)", () => {
    it("is exported so consumers bypassing the client can reuse it", () => {
      expect(typeof normalizeSecurityRef).toBe("function");
    });

    it("lets a direct SecurityRefSchema.parse succeed on a real producer payload", () => {
      // The live Congress.Trade REST producer omits sharesOutstanding entirely.
      const { sharesOutstanding: _omitted, ...producerRef } = validRef;

      // Without normalization a direct parse fails: the key is nullable but required.
      expect(() => SecurityRefSchema.parse(producerRef)).toThrow();

      // With it, the same payload validates and the field reads as null.
      const parsed = SecurityRefSchema.parse(normalizeSecurityRef(producerRef));
      expect(parsed.sharesOutstanding).toBeNull();
      expect(parsed).toEqual(validRef);
    });

    it("preserves an explicit sharesOutstanding value instead of overwriting it", () => {
      const withValue = { ...validRef, sharesOutstanding: 16_000_000 };
      expect(normalizeSecurityRef(withValue)).toEqual(withValue);
    });

    it("returns non-object input unchanged", () => {
      expect(normalizeSecurityRef(null)).toBeNull();
      expect(normalizeSecurityRef(undefined)).toBeUndefined();
      expect(normalizeSecurityRef("AAPL")).toBe("AAPL");
      expect(normalizeSecurityRef([1, 2])).toEqual([1, 2]);
    });
  });

  describe("transactions", () => {
    it("handles optional query parameters correctly", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => emptyTransactionsPage });
      const client = mockClient(mockFetch);
      await client.getTransactions({ ticker: "AAPL", limit: 10, order: "asc" });
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://custom.congress.trade/api/transactions?ticker=AAPL&limit=10&order=asc");
    });

    it("handles all query params", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => emptyTransactionsPage });
      const client = mockClient(mockFetch);
      await client.getTransactions({
        since: "42",
        from: "2026-01-01",
        to: "2026-06-30",
        ticker: "MSFT",
        member: "Pelosi",
        chamber: "house",
        type: "P",
        limit: 5,
        order: "desc",
      });
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("since=42");
      expect(url).toContain("chamber=house");
      expect(url).toContain("order=desc");
    });

    it("preserves required read provenance and additive transaction fields", async () => {
      const transaction = {
        id: "tx-1", docId: "doc-1", filerId: null, txDate: "2026-01-01", owner: "self",
        assetName: "Apple", ticker: "AAPL", assetType: "stock", txType: "P",
        amountMin: 1001, amountMax: 15000, estValue: 8000, isOption: false,
        capGainsOver200: false, rawText: "Apple", confidence: 0.9, source: "primary",
        createdAt: "2026-01-02T00:00:00Z", cursorSeq: 42,
      };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ...emptyTransactionsPage, transactions: [transaction], cursor: 42, count: 1, total: 1 }),
      });
      const client = mockClient(mockFetch);
      await expect(client.getTransactions({ since: 0 })).resolves.toMatchObject({
        transactions: [{ estValue: 8000, source: "primary", cursorSeq: 42 }],
      });
    });

    it("rejects invalid resume cursors before issuing a request", async () => {
      const mockFetch = vi.fn();
      const client = mockClient(mockFetch);
      await expect(client.getTransactions({ since: "2026-01-01" as never })).rejects.toThrow();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("chunks getRefs requests when length exceeds MAX_REFS_BATCH", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ refs: [validRef] }) });
      const client = mockClient(mockFetch);
      const tickers = Array.from({ length: 505 }, (_, i) => `T${i}`);
      const results = await client.getRefs(tickers);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(results.length).toBe(2);
    });
  });

  describe("analytics endpoints", () => {
    it("getTickerLeaderboard returns tickers array", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tickers: [{ ticker: "AAPL", tradeCount: 5 }] }),
      });
      const client = mockClient(mockFetch);
      const result = await client.getTickerLeaderboard({ window: "30d", limit: 10 });
      expect(result).toEqual([{ ticker: "AAPL", tradeCount: 5 }]);
    });

    it("getTickerLeaderboard accepts explicit empty rows and rejects a missing envelope", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tickers: [] }) });
      const client = mockClient(mockFetch);
      const result = await client.getTickerLeaderboard();
      expect(result).toEqual([]);
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      await expect(client.getTickerLeaderboard()).rejects.toThrow("Invalid ticker leaderboard response");
    });

    it("getClusterBuys returns clusters array", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ clusters: [{ ticker: "MSFT", memberCount: 3 }] }),
      });
      const client = mockClient(mockFetch);
      const result = await client.getClusterBuys({ window: "90d" });
      expect(result).toEqual([{ ticker: "MSFT", memberCount: 3 }]);
    });

    it("getMemberLeaderboard returns members array", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ members: [{ filerId: "123", tradeCount: 10 }] }),
      });
      const client = mockClient(mockFetch);
      const result = await client.getMemberLeaderboard({ limit: 5 });
      expect(result).toEqual([{ filerId: "123", tradeCount: 10 }]);
    });

    it("getMemberPerformance returns dual-anchor performance (filing + trade)", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          filerId: "filer-1",
          side: "buys",
          buyCount: 12,
          tradeDate: { tradeCount: 12, scoredCount: 10, winRate: 0.7, avgExcess: 0.02 },
          filingDate: { tradeCount: 12, scoredCount: 9, winRate: 0.66, avgExcess: 0.015, avgAnnualizedExcess: 0.04 },
          performance: { tradeCount: 12, scoredCount: 10, winRate: 0.7, avgExcess: 0.02 },
          note: "Buys only.",
        }),
      });
      const client = mockClient(mockFetch);
      const result = await client.getMemberPerformance("filer-1");
      expect(result?.filingDate?.avgExcess).toBe(0.015);
      expect(result?.tradeDate?.avgExcess).toBe(0.02);
      expect(result?.performance?.winRate).toBe(0.7);
    });

    it("getMemberPerformance returns null for empty filerId", async () => {
      const mockFetch = vi.fn();
      const client = mockClient(mockFetch);
      const result = await client.getMemberPerformance("");
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("getMemberPerformance accepts legacy single-leg performance and rejects garbage", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ performance: { tradeCount: 10, winRate: 0.7 } }),
      });
      const client = mockClient(mockFetch);
      const legacy = await client.getMemberPerformance("filer-1");
      expect(legacy?.performance?.tradeCount).toBe(10);
      expect(legacy?.tradeDate?.tradeCount).toBe(10);
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ performance: null }) });
      expect(await client.getMemberPerformance("filer-1")).toBeNull();
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ not: "valid" }) });
      await expect(client.getMemberPerformance("filer-1")).rejects.toThrow("Invalid member performance response");
    });

    it("getConviction returns tickers array", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tickers: [{ ticker: "AAPL", convictionScore: 85, direction: "BUY" }] }),
      });
      const client = mockClient(mockFetch);
      const result = await client.getConviction({ window: "7d" });
      expect(result).toEqual([{ ticker: "AAPL", convictionScore: 85, direction: "BUY" }]);
    });

    it("getTickerBacktest returns backtest with horizons", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ticker: "AAPL", filerId: "123", txType: "P", totalBuyEvents: 5, pricedDays: 30, horizons: [{ days: 30, tradeCount: 5, n: 5, medianReturn: 2.5, avgReturn: 3.0, winRate: 0.8, medianExcess: 1.5, avgExcess: 2.0 }] }),
      });
      const client = mockClient(mockFetch);
      const result = await client.getTickerBacktest("AAPL", { window: "90d", horizons: "30,60", filerId: "123" });
      expect(result!.horizons).toHaveLength(1);
      expect(result!.horizons[0].days).toBe(30);
      expect(result!.filerId).toBe("123");
    });

    it("getTickerBacktest returns null for empty horizons", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ticker: "AAPL", txType: "P", totalBuyEvents: 0, pricedDays: 0, horizons: [] }),
      });
      const client = mockClient(mockFetch);
      const result = await client.getTickerBacktest("AAPL");
      expect(result).toBeNull();
    });

    it("getConflicts returns conflicts array", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ conflicts: [{ id: "c1", ticker: "AAPL", sector: "Tech", txType: "P", txDate: "2026-01-01", filerId: "123", memberName: "Jane Doe", chamber: "senate", partyBucket: "D", viaCommittees: ["Banking"], estAmountUsd: 50000 }] }),
      });
      const client = mockClient(mockFetch);
      const result = await client.getConflicts({ chamber: "senate", party: "D" });
      expect(result).toHaveLength(1);
      expect(result[0].ticker).toBe("AAPL");
    });

    it("getConflicts accepts explicit empty rows and rejects a missing envelope", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ conflicts: [] }) });
      const client = mockClient(mockFetch);
      const result = await client.getConflicts();
      expect(result).toEqual([]);
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      await expect(client.getConflicts()).rejects.toThrow("Invalid committee conflicts response");
    });
  });

  describe("streamUrl", () => {
    it("returns a full SSE URL with encoded subscription id and optional stream token", () => {
      const client = new CongressTradeClient({ baseUrl: "https://custom.congress.trade" });
      const url = client.streamUrl("sub/1&2");
      expect(url).toBe("https://custom.congress.trade/api/stream?subscription=sub%2F1%262");
      expect(client.streamUrl("sub/1&2", "secret ?& value")).toBe(
        "https://custom.congress.trade/api/stream?subscription=sub%2F1%262&token=secret+%3F%26+value",
      );
    });
  });
});

import { SseParser } from "../client";

describe("SseParser", () => {
  it("ignores heartbeat/comment lines", () => {
    const parser = new SseParser();
    const result = parser.push(": heartbeat\n\n");
    expect(result).toEqual([]);
  });

  it("ignores id-only or event-only blocks with no data", () => {
    const parser = new SseParser();
    const result = parser.push("id: 12345\nevent: update\n\n");
    expect(result).toEqual([]);
    expect(parser.push("data: later\n\n")).toEqual([{ id: "12345", data: "later" }]);
  });

  it("emits correct message when data is present", () => {
    const parser = new SseParser();
    const result = parser.push("id: 12345\nevent: update\ndata: hello world\n\n");
    expect(result).toEqual([{ id: "12345", event: "update", data: "hello world" }]);
  });

  it("joins multiple data lines with newlines", () => {
    const parser = new SseParser();
    const result = parser.push("data: line1\ndata: line2\ndata: line3\n\n");
    expect(result).toEqual([{ data: "line1\nline2\nline3" }]);
  });

  it("accumulates data across multiple push calls", () => {
    const parser = new SseParser();
    const r1 = parser.push("data: start");
    expect(r1).toEqual([]);
    const r2 = parser.push(" of message\n\n");
    expect(r2).toEqual([{ data: "start of message" }]);
  });

  it("handles CRLF line endings", () => {
    const parser = new SseParser();
    const result = parser.push("id: 1\r\ndata: hello\r\n\r\n");
    expect(result).toEqual([{ id: "1", data: "hello" }]);
  });

  it("handles CR-only line endings", () => {
    const parser = new SseParser();
    expect(parser.push("id: 1\rdata: hello\r\r")).toEqual([{ id: "1", data: "hello" }]);
  });

  it("handles CRLF split across push calls without creating a blank line", () => {
    const parser = new SseParser();
    expect(parser.push("data: first\r")).toEqual([]);
    expect(parser.push("\nevent: update\r\ndata: second\r\n\r\n")).toEqual([
      { event: "update", data: "first\nsecond" },
    ]);
  });

  it("ignores a leading byte-order mark", () => {
    const parser = new SseParser();
    expect(parser.push("\uFEFFdata: hello\n\n")).toEqual([{ data: "hello" }]);
  });

  it("strips leading space from field value", () => {
    const parser = new SseParser();
    const result = parser.push("data:  padded\n\n");
    expect(result).toEqual([{ data: " padded" }]);
  });

  it("handles data-only blocks (no event/id)", () => {
    const parser = new SseParser();
    const result = parser.push("data: {\"foo\":\"bar\"}\n\n");
    expect(result).toEqual([{ data: '{"foo":"bar"}' }]);
  });

  it("handles event before data", () => {
    const parser = new SseParser();
    const result = parser.push("event: trade\ndata: {\"type\":\"P\"}\n\n");
    expect(result).toEqual([{ event: "trade", data: '{"type":"P"}' }]);
  });

  it("treats an empty event field as the default message event", () => {
    const parser = new SseParser();
    expect(parser.push("event:\ndata: hello\n\n")).toEqual([{ data: "hello" }]);
  });

  it("handles id after data", () => {
    const parser = new SseParser();
    const result = parser.push("data: msg\ndata: body\nid: 99\n\n");
    expect(result).toEqual([{ id: "99", data: "msg\nbody" }]);
  });

  it("dispatches multiple complete events in one push", () => {
    const parser = new SseParser();
    const result = parser.push("data: first\n\ndata: second\n\n");
    expect(result).toEqual([{ data: "first" }, { data: "second" }]);
  });

  it("persists an event id until the server replaces or clears it", () => {
    const parser = new SseParser();
    expect(parser.push("id: 41\ndata: first\n\ndata: second\n\nid\ndata: third\n\n")).toEqual([
      { id: "41", data: "first" },
      { id: "41", data: "second" },
      { id: "", data: "third" },
    ]);
  });

  it("ignores event ids containing a null character", () => {
    const parser = new SseParser();
    expect(parser.push("id: safe\ndata: first\n\nid: bad\0id\ndata: second\n\n")).toEqual([
      { id: "safe", data: "first" },
      { id: "safe", data: "second" },
    ]);
  });

  it("bounds incomplete lines and accumulated event data", () => {
    const lineParser = new SseParser({ maxLineLength: 8 });
    expect(() => lineParser.push("data: 123456789")).toThrow("SSE line exceeds 8 characters");
    expect(lineParser.push("data: ok\n\n")).toEqual([{ data: "ok" }]);

    const eventParser = new SseParser({ maxEventDataLength: 5 });
    expect(() => eventParser.push("data: 123\ndata: 45\n\n"))
      .toThrow("SSE event data exceeds 5 characters");
  });

  it("rejects invalid parser limits", () => {
    expect(() => new SseParser({ maxLineLength: 0 })).toThrow("positive integer");
    expect(() => new SseParser({ maxEventDataLength: 1.5 })).toThrow("positive integer");
  });

  it("ignores comments between data blocks", () => {
    const parser = new SseParser();
    const result = parser.push("data: visible\n: comment\n\n");
    // The comment line is ignored; the event should contain visible
    expect(result).toEqual([{ data: "visible" }]);
  });
});
