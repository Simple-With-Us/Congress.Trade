import { API_PATHS, DEFAULT_CONGRESS_TRADE_BASE_URL, MAX_REFS_BATCH } from "./constants";
import type {
  BundleResponse,
  TransactionsPage,
  TransactionsQueryInput,
  TransactionsQuery,
  PriceClose,
  PriceSeries,
  SecurityRef,
  FundamentalRow,
  AnalystRow,
  InsiderReadRow,
  ShortVolumeReadRow,
  TickerLeader,
  ClusterBuy,
  MemberLeader,
  MemberDualPerformance,
  ConvictionTicker,
  TickerBacktest,
  CommitteeConflict,
} from "./types";
import {
  AnalystRowSchema,
  BundleResponseSchema,
  ClusterBuySchema,
  CommitteeConflictSchema,
  ConvictionTickerSchema,
  FundamentalRowSchema,
  InsiderReadRowSchema,
  MemberLeaderSchema,
  MemberDualPerformanceSchema,
  MemberPerformanceSchema,
  PriceCloseSchema,
  PriceSeriesSchema,
  SecurityRefSchema,
  ShortVolumeReadRowSchema,
  SubscriptionSchema,
  TickerBacktestSchema,
  TickerLeaderSchema,
  TransactionsQuerySchema,
  TransactionsPageSchema,
} from "./schemas";
import { z } from "zod";

const RawRefEnvelopeSchema = z.object({ ref: z.unknown().nullable() });
const RawRefsEnvelopeSchema = z.object({ refs: z.array(z.unknown()) });
const ClosesEnvelopeSchema = z.object({ closes: z.array(PriceCloseSchema) });
const UnknownRowsEnvelopeSchema = z.object({
  ticker: z.string().optional(),
  rows: z.array(z.unknown()),
});

function parseResponse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid ${label} response: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Backfill producer-omitted nullable metadata on a raw security-ref payload so
 * it satisfies {@link SecurityRefSchema}.
 *
 * `SecurityRefSchema.sharesOutstanding` is `.nullable()` but NOT `.optional()`,
 * so the key must be *present* — `null` is accepted, absent is not. The live
 * Congress.Trade REST producer does not emit `sharesOutstanding` at all, which
 * would otherwise make every strict ref/bundle read throw.
 *
 * `CongressTradeClient` applies this automatically on every read path. It is
 * exported because consumers that bypass the client and call
 * `SecurityRefSchema.parse(...)` directly need the same normalization — without
 * it they hit `Invalid market ref response` on well-formed producer payloads.
 *
 * Non-object input (null, arrays, primitives) is returned unchanged so callers
 * can pass raw JSON through before validating it.
 */
export function normalizeSecurityRef(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const ref = { ...value } as Record<string, unknown>;
  if (!("sharesOutstanding" in ref)) {
    ref.sharesOutstanding = null;
  }
  
  if ("marketCapBucket" in ref) {
    const validBuckets = ["mega", "large", "mid", "small", "micro", "nano"];
    if (typeof ref.marketCapBucket === "string" && !validBuckets.includes(ref.marketCapBucket)) {
      ref.marketCapBucket = null;
    }
  }

  if ("currentPriceDate" in ref && typeof ref.currentPriceDate === "string") {
    const match = ref.currentPriceDate.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) {
      ref.currentPriceDate = match[1];
    } else {
      ref.currentPriceDate = null;
    }
  }

  return ref;
}

export class CongressTradeHttpError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
  ) {
    super(`Request failed: ${method} ${path} -> HTTP ${status}`);
    this.name = "CongressTradeHttpError";
  }
}

export interface CongressTradeClientConfig {
  baseUrl?: string;
  token?: string;
  fetch?: typeof fetch;
}

export interface Subscription {
  id: string;
  secret: string;
  streamUrl?: string;
}

export class CongressTradeClient {
  private baseUrl: string;
  private token?: string;
  private fetchApi: typeof fetch;

  constructor(config: CongressTradeClientConfig = {}) {
    this.baseUrl = (config.baseUrl || DEFAULT_CONGRESS_TRADE_BASE_URL).replace(/\/+$/, "");
    this.token = config.token;
    this.fetchApi = config.fetch || globalThis.fetch;
  }

  private headers(extra?: Record<string, string>): HeadersInit {
    const h: Record<string, string> = { "content-type": "application/json", ...extra };
    if (this.token) {
      h["authorization"] = `Bearer ${this.token}`;
    }
    return h;
  }

  private async getJson<T>(path: string, searchParams?: URLSearchParams): Promise<T> {
    const qs = searchParams?.toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
    const res = await this.fetchApi(url, {
      method: "GET",
      headers: this.headers({ accept: "application/json" }),
      cache: "no-store",
    });
    if (!res.ok) {
      throw new CongressTradeHttpError("GET", path, res.status);
    }
    return (await res.json()) as T;
  }

  /**
   * Create an SSE subscription on behalf of an already-authenticated end user.
   * Current Congress.Trade derives ownership from the user session and ignores
   * `clientId`; the field remains on the wire for compatibility with older servers.
   */
  async createSubscription(clientId?: string, desiredSecret?: string): Promise<Subscription> {
    const body: Record<string, string> = { delivery: "sse" };
    if (clientId) {
      body.clientId = clientId;
    }
    if (desiredSecret !== undefined) {
      if (desiredSecret.length < 16 || desiredSecret.length > 256) {
        throw new RangeError("desired subscription secret must be 16-256 characters");
      }
      body.secret = desiredSecret;
    }

    const res = await this.fetchApi(`${this.baseUrl}${API_PATHS.SUBSCRIPTIONS}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      cache: "no-store",
    });

    if (!res.ok) {
      throw new CongressTradeHttpError("POST", API_PATHS.SUBSCRIPTIONS, res.status);
    }

    return parseResponse(SubscriptionSchema, await res.json(), "subscription create");
  }

  /**
   * Build an SSE URL. Pass the per-subscription secret for EventSource-style
   * clients; callers that omit it must send the same secret as a Bearer header.
   */
  streamUrl(subscriptionId: string, secret?: string): string {
    const params = new URLSearchParams({ subscription: subscriptionId });
    if (secret !== undefined) params.set("token", secret);
    return `${this.baseUrl}${API_PATHS.STREAM}?${params.toString()}`;
  }

  async getBundle(
    ticker: string,
    opts?: { from?: string; to?: string }
  ): Promise<BundleResponse> {
    const params = new URLSearchParams();
    if (opts?.from) params.set("from", opts.from);
    if (opts?.to) params.set("to", opts.to);
    const data = await this.getJson<Record<string, unknown>>(
      `${API_PATHS.MARKET_BUNDLE}/${encodeURIComponent(ticker)}`,
      params
    );
    return parseResponse(BundleResponseSchema, {
      ...data,
      ref: normalizeSecurityRef(data.ref),
    }, "market bundle");
  }

  async getRef(ticker: string): Promise<SecurityRef | null> {
    const path = `${API_PATHS.MARKET_REF}/${encodeURIComponent(ticker)}`;
    try {
      const data = parseResponse(RawRefEnvelopeSchema, await this.getJson<unknown>(path), "market ref envelope");
      if (data.ref === null) return null;
      return parseResponse(SecurityRefSchema, normalizeSecurityRef(data.ref), "market ref");
    } catch (error) {
      if (error instanceof CongressTradeHttpError && error.status === 404) return null;
      throw error;
    }
  }

  async getRefs(tickers: string[]): Promise<SecurityRef[]> {
    if (tickers.length === 0) return [];
    const results: SecurityRef[] = [];
    for (let i = 0; i < tickers.length; i += MAX_REFS_BATCH) {
      const chunk = tickers.slice(i, i + MAX_REFS_BATCH);
      const params = new URLSearchParams();
      params.set("tickers", chunk.join(","));
      const data = parseResponse(
        RawRefsEnvelopeSchema,
        await this.getJson<unknown>(API_PATHS.MARKET_REFS, params),
        "market refs envelope",
      );
      results.push(...data.refs.map((ref) => parseResponse(
        SecurityRefSchema,
        normalizeSecurityRef(ref),
        "market ref",
      )));
    }
    return results;
  }

  async getPrices(ticker: string, opts?: { from?: string; to?: string }): Promise<PriceSeries> {
    const params = new URLSearchParams();
    if (opts?.from) params.set("from", opts.from);
    if (opts?.to) params.set("to", opts.to);
    const data = await this.getJson<unknown>(`${API_PATHS.MARKET_PRICES}/${encodeURIComponent(ticker)}`, params);
    return parseResponse(PriceSeriesSchema, data, "market prices");
  }

  async getSpx(opts?: { from?: string; to?: string }): Promise<PriceClose[]> {
    const params = new URLSearchParams();
    if (opts?.from) params.set("from", opts.from);
    if (opts?.to) params.set("to", opts.to);
    const data = await this.getJson<unknown>(API_PATHS.MARKET_SPX, params);
    return parseResponse(ClosesEnvelopeSchema, data, "SPX prices").closes;
  }

  async getFundamentals(ticker: string, opts?: { from?: string; to?: string }): Promise<FundamentalRow[]> {
    const params = new URLSearchParams();
    if (opts?.from) params.set("from", opts.from);
    if (opts?.to) params.set("to", opts.to);
    const data = await this.getJson<unknown>(
      `${API_PATHS.MARKET_FUNDAMENTALS}/${encodeURIComponent(ticker)}`,
      params
    );
    const envelope = parseResponse(UnknownRowsEnvelopeSchema, data, "market fundamentals");
    const rowTicker = envelope.ticker ?? ticker.toUpperCase();
    return envelope.rows.map((row) => parseResponse(
      FundamentalRowSchema,
      { ...(row && typeof row === "object" ? row : {}), ticker: rowTicker },
      "fundamental row",
    ));
  }

  async getAnalyst(ticker: string, opts?: { from?: string; to?: string }): Promise<AnalystRow[]> {
    const params = new URLSearchParams();
    if (opts?.from) params.set("from", opts.from);
    if (opts?.to) params.set("to", opts.to);
    const data = await this.getJson<unknown>(
      `${API_PATHS.MARKET_ANALYST}/${encodeURIComponent(ticker)}`,
      params
    );
    const envelope = parseResponse(UnknownRowsEnvelopeSchema, data, "market analyst");
    const rowTicker = envelope.ticker ?? ticker.toUpperCase();
    return envelope.rows.map((row) => parseResponse(
      AnalystRowSchema,
      { ...(row && typeof row === "object" ? row : {}), ticker: rowTicker },
      "analyst row",
    ));
  }

  async getInsider(ticker: string, opts?: { from?: string; to?: string }): Promise<InsiderReadRow[]> {
    const params = new URLSearchParams();
    if (opts?.from) params.set("from", opts.from);
    if (opts?.to) params.set("to", opts.to);
    const envelope = parseResponse(
      UnknownRowsEnvelopeSchema,
      await this.getJson<unknown>(`${API_PATHS.MARKET_INSIDER}/${encodeURIComponent(ticker)}`, params),
      "market insider",
    );
    const rowTicker = envelope.ticker ?? ticker.toUpperCase();
    return envelope.rows.map((row) => parseResponse(
      InsiderReadRowSchema,
      { ...(row && typeof row === "object" ? row : {}), ticker: rowTicker },
      "insider row",
    ));
  }

  async getShortVolume(ticker: string, opts?: { from?: string; to?: string }): Promise<ShortVolumeReadRow[]> {
    const params = new URLSearchParams();
    if (opts?.from) params.set("from", opts.from);
    if (opts?.to) params.set("to", opts.to);
    const envelope = parseResponse(
      UnknownRowsEnvelopeSchema,
      await this.getJson<unknown>(`${API_PATHS.MARKET_SHORT_VOLUME}/${encodeURIComponent(ticker)}`, params),
      "market short volume",
    );
    const rowTicker = envelope.ticker ?? ticker.toUpperCase();
    return envelope.rows.map((row) => parseResponse(
      ShortVolumeReadRowSchema,
      { ...(row && typeof row === "object" ? row : {}), ticker: rowTicker },
      "short-volume row",
    ));
  }

  async getTransactions(query: TransactionsQueryInput = {}): Promise<TransactionsPage> {
    const parsedQuery = TransactionsQuerySchema.parse(query);
    const params = new URLSearchParams();
    if (parsedQuery.since !== undefined) params.set("since", String(parsedQuery.since));
    if (parsedQuery.from) params.set("from", parsedQuery.from);
    if (parsedQuery.to) params.set("to", parsedQuery.to);
    if (parsedQuery.ticker) params.set("ticker", parsedQuery.ticker);
    if (parsedQuery.member) params.set("member", parsedQuery.member);
    if (parsedQuery.chamber) params.set("chamber", parsedQuery.chamber);
    if (parsedQuery.type) params.set("type", parsedQuery.type);
    if (parsedQuery.limit) params.set("limit", String(parsedQuery.limit));
    if (parsedQuery.order) params.set("order", parsedQuery.order);
    return parseResponse(
      TransactionsPageSchema,
      await this.getJson<unknown>(API_PATHS.TRANSACTIONS, params),
      "transactions",
    );
  }

  async getTickerLeaderboard(opts: { window?: string; limit?: number } = {}): Promise<TickerLeader[]> {
    const params = new URLSearchParams();
    if (opts.window) params.set("window", opts.window);
    if (opts.limit) params.set("limit", String(opts.limit));
    return parseResponse(
      z.object({ tickers: z.array(TickerLeaderSchema) }),
      await this.getJson<unknown>(API_PATHS.ANALYTICS_TICKER_LEADERBOARD, params),
      "ticker leaderboard",
    ).tickers;
  }

  async getClusterBuys(opts: { window?: string; limit?: number } = {}): Promise<ClusterBuy[]> {
    const params = new URLSearchParams();
    if (opts.window) params.set("window", opts.window);
    if (opts.limit) params.set("limit", String(opts.limit));
    return parseResponse(
      z.object({ clusters: z.array(ClusterBuySchema) }),
      await this.getJson<unknown>(API_PATHS.ANALYTICS_CLUSTER_BUYS, params),
      "cluster buys",
    ).clusters;
  }

  async getMemberLeaderboard(opts: { window?: string; limit?: number } = {}): Promise<MemberLeader[]> {
    const params = new URLSearchParams();
    if (opts.window) params.set("window", opts.window);
    if (opts.limit) params.set("limit", String(opts.limit));
    return parseResponse(
      z.object({ members: z.array(MemberLeaderSchema) }),
      await this.getJson<unknown>(API_PATHS.ANALYTICS_MEMBER_LEADERBOARD, params),
      "member leaderboard",
    ).members;
  }

  /**
   * Dual-anchor member performance (filingDate = copy-trade, tradeDate = politician timing).
   * Prefer `filingDate` for App B trading decisions; keep `tradeDate` as context.
   * Legacy single-leg clients can still read `performance` (= tradeDate).
   */
  async getMemberPerformance(filerId: string): Promise<MemberDualPerformance | null> {
    if (!filerId) return null;
    const raw = await this.getJson<unknown>(
      `${API_PATHS.ANALYTICS_MEMBER_PERFORMANCE}/${encodeURIComponent(filerId)}/performance`
    );
    if (!raw || typeof raw !== "object") {
      throw new Error("Invalid member performance response");
    }
    const obj = raw as Record<string, unknown>;
    // Require at least one known performance key so meta-only / garbage envelopes fail closed.
    const hasKeys = "filingDate" in obj || "tradeDate" in obj || "performance" in obj;
    if (!hasKeys) throw new Error("Invalid member performance response");

    const dual = MemberDualPerformanceSchema.safeParse(raw);
    if (!dual.success) throw new Error("Invalid member performance response");
    const d = dual.data;
    // Legacy clients only sent `performance` (= trade-date skill). Normalize so
    // callers always see tradeDate when that is the only leg present.
    if (d.performance && !d.tradeDate) d.tradeDate = d.performance;
    if (d.filingDate || d.tradeDate || d.performance) return d;
    // Explicit nulls only (no scored legs yet)
    return null;
  }

  async getConviction(opts: { window?: string; limit?: number } = {}): Promise<ConvictionTicker[]> {
    const params = new URLSearchParams();
    if (opts.window) params.set("window", opts.window);
    if (opts.limit) params.set("limit", String(opts.limit));
    return parseResponse(
      z.object({ tickers: z.array(ConvictionTickerSchema) }),
      await this.getJson<unknown>(API_PATHS.ANALYTICS_CONVICTION, params),
      "conviction",
    ).tickers;
  }

  async getTickerBacktest(
    ticker: string,
    opts: { window?: string; horizons?: string; filerId?: string } = {}
  ): Promise<TickerBacktest | null> {
    const params = new URLSearchParams();
    if (opts.window) params.set("window", opts.window);
    if (opts.horizons) params.set("horizons", opts.horizons);
    if (opts.filerId) params.set("filerId", opts.filerId);
    const data = await this.getJson<unknown>(
      `${API_PATHS.ANALYTICS_TICKER_BACKTEST}/${encodeURIComponent(ticker)}/backtest`,
      params
    );
    const parsed = parseResponse(TickerBacktestSchema, data, "ticker backtest");
    return parsed.horizons.length ? parsed : null;
  }

  async getConflicts(
    opts: { window?: string; limit?: number; chamber?: string; party?: string } = {}
  ): Promise<CommitteeConflict[]> {
    const params = new URLSearchParams();
    if (opts.window) params.set("window", opts.window);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.chamber) params.set("chamber", opts.chamber);
    if (opts.party) params.set("party", opts.party);
    return parseResponse(
      z.object({ conflicts: z.array(CommitteeConflictSchema) }),
      await this.getJson<unknown>(API_PATHS.ANALYTICS_CONFLICTS, params),
      "committee conflicts",
    ).conflicts;
  }
}

export interface SseMessage {
  event?: string;
  id?: string;
  data: string;
}

export interface SseParserOptions {
  /** Maximum characters allowed in one SSE field line before the parser resets and throws. */
  maxLineLength?: number;
  /** Maximum joined data characters allowed in one event before the parser resets and throws. */
  maxEventDataLength?: number;
}

/** Incremental text/event-stream parser. Feed decoded chunks; get back complete events. */
export class SseParser {
  private buf = "";
  private cur: { event?: string; data: string[] } = { data: [] };
  private lastEventId: string | undefined;
  private atStart = true;
  private swallowLeadingLf = false;
  private eventDataLength = 0;
  private readonly maxLineLength: number;
  private readonly maxEventDataLength: number;

  constructor(options: SseParserOptions = {}) {
    this.maxLineLength = options.maxLineLength ?? 64 * 1024;
    this.maxEventDataLength = options.maxEventDataLength ?? 1024 * 1024;
    if (!Number.isInteger(this.maxLineLength) || this.maxLineLength <= 0) {
      throw new RangeError("maxLineLength must be a positive integer");
    }
    if (!Number.isInteger(this.maxEventDataLength) || this.maxEventDataLength <= 0) {
      throw new RangeError("maxEventDataLength must be a positive integer");
    }
  }

  private resetAfterLimit(message: string): never {
    this.buf = "";
    this.cur = { data: [] };
    this.lastEventId = undefined;
    this.atStart = true;
    this.swallowLeadingLf = false;
    this.eventDataLength = 0;
    throw new RangeError(message);
  }

  push(chunk: string): SseMessage[] {
    if (this.swallowLeadingLf && chunk.length > 0) {
      if (chunk.startsWith("\n")) chunk = chunk.slice(1);
      this.swallowLeadingLf = false;
    }
    if (this.atStart && chunk.length > 0) {
      this.atStart = false;
      if (chunk.startsWith("\uFEFF")) chunk = chunk.slice(1);
    }
    this.buf += chunk;
    const out: SseMessage[] = [];
    for (;;) {
      const lf = this.buf.indexOf("\n");
      const cr = this.buf.indexOf("\r");
      const lineEnd = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr);
      if (lineEnd < 0) {
        if (this.buf.length > this.maxLineLength) {
          this.resetAfterLimit(`SSE line exceeds ${this.maxLineLength} characters`);
        }
        break;
      }
      if (lineEnd > this.maxLineLength) {
        this.resetAfterLimit(`SSE line exceeds ${this.maxLineLength} characters`);
      }

      const delimiter = this.buf[lineEnd];
      let delimiterLength = 1;
      if (delimiter === "\r") {
        if (this.buf[lineEnd + 1] === "\n") delimiterLength = 2;
        else if (lineEnd === this.buf.length - 1) this.swallowLeadingLf = true;
      }
      const line = this.buf.slice(0, lineEnd);
      this.buf = this.buf.slice(lineEnd + delimiterLength);
      if (line === "") {
        if (this.cur.data.length > 0) {
          const msg: SseMessage = { data: this.cur.data.join("\n") };
          if (this.cur.event !== undefined) msg.event = this.cur.event;
          if (this.lastEventId !== undefined) msg.id = this.lastEventId;
          out.push(msg);
        }
        this.cur = { data: [] };
        this.eventDataLength = 0;
        continue;
      }
      if (line.startsWith(":")) continue; // comment / heartbeat
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") {
        const separatorLength = this.cur.data.length > 0 ? 1 : 0;
        const nextLength = this.eventDataLength + separatorLength + value.length;
        if (nextLength > this.maxEventDataLength) {
          this.resetAfterLimit(`SSE event data exceeds ${this.maxEventDataLength} characters`);
        }
        this.cur.data.push(value);
        this.eventDataLength = nextLength;
      }
      else if (field === "event") this.cur.event = value || undefined;
      else if (field === "id" && !value.includes("\0")) this.lastEventId = value;
    }
    return out;
  }
}
