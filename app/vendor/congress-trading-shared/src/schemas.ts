import { z } from "zod";
import { isIsoDate } from "./utils";
import { CONGRESS_EVENT_TYPES } from "./constants";

const nullAsUndefined = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => value === null ? undefined : value, schema.optional());

// ---- Chamber / Party / Owner ----

export const IsoDateSchema = z.string().refine(isIsoDate, {
  message: "Expected a valid YYYY-MM-DD date",
});

export const IsoDateTimeSchema = z.string().datetime({
  message: "Expected a valid ISO 8601 UTC date-time string (e.g., 2026-07-22T14:30:00Z)",
});
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

// "executive" covers OGE Form 278-T presidential/VP filers — the
// executive-branch analogue of congressional STOCK Act disclosures.
export const ChamberSchema = z.enum(["house", "senate", "executive"]);
export type Chamber = z.infer<typeof ChamberSchema>;

export const PartyBucketSchema = z.enum(["D", "R", "O"]);
export type PartyBucket = z.infer<typeof PartyBucketSchema>;

export const OwnerSchema = z.enum(["self", "spouse", "joint", "dependent"]);
export type Owner = z.infer<typeof OwnerSchema>;

/** B = Buy, S = Sell, E = Exchange. Legacy form letter P (Purchase) is accepted on parse and coerced to B. */
export const TxTypeSchema = z
  .enum(["B", "S", "E", "P"])
  .transform((v): "B" | "S" | "E" => (v === "P" ? "B" : v));
export type TxType = "B" | "S" | "E";

export const AssetTypeCategorySchema = z.enum([
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
]);
export type AssetTypeCategory = z.infer<typeof AssetTypeCategorySchema>;

// ---- Market data ----

export const MktCapBucketSchema = z.enum([
  "mega", "large", "mid", "small", "micro", "nano",
]);
export type MktCapBucket = z.infer<typeof MktCapBucketSchema>;

export const PriceCloseSchema = z.object({
  date: IsoDateSchema,
  close: z.number(),
  volume: nullAsUndefined(z.number()),
});
export type PriceClose = z.infer<typeof PriceCloseSchema>;

export const SecurityRefSchema = z.object({
  ticker: z.string().min(1).max(20),
  companyName: z.string().nullable(),
  sector: z.string().nullable(),
  industry: z.string().nullable(),
  assetClass: z.string().nullable(),
  isEtf: z.boolean(),
  isAdr: z.boolean(),
  country: z.string().nullable(),
  stateHq: z.string().nullable(),
  stateOfIncorp: z.string().nullable(),
  exchange: z.string().nullable(),
  exchangeShort: z.string().nullable(),
  currency: z.string().nullable(),
  marketCap: z.number().nullable(),
  marketCapBucket: MktCapBucketSchema.nullable(),
  sharesOutstanding: z.number().nullable(),
  ipoDate: z.string().nullable(),
  cik: z.string().nullable(),
  sicCode: z.string().nullable(),
  sicDescription: z.string().nullable(),
  source: z.string().nullable(),
  enrichedAt: z.string().nullable().optional(),
  currentPrice: z.number().nullable().optional(),
  currentPriceDate: IsoDateSchema.nullable().optional(),
});
export type SecurityRef = z.infer<typeof SecurityRefSchema>;

export const SecurityRefInputSchema = SecurityRefSchema.partial().extend({
  ticker: z.string().min(1).max(20),
});
export type SecurityRefInput = z.infer<typeof SecurityRefInputSchema>;

// ---- Transaction ----

export const CongressTransactionSchema = z.object({
  id: z.string().min(1),
  docId: z.string().min(1),
  filerId: z.string().nullable(),
  txDate: z.string().nullable(),
  owner: OwnerSchema.nullable(),
  assetName: z.string(),
  ticker: z.string().nullable(),
  assetType: z.string().nullable(),
  assetTypeName: z.string().nullable().optional(),
  assetTypeCategory: AssetTypeCategorySchema.nullable().optional(),
  assetTypeCategoryLabel: z.string().nullable().optional(),
  txType: TxTypeSchema,
  amountMin: z.number().nullable(),
  amountMax: z.number().nullable(),
  estValue: z.number().nullable().optional(),
  isOption: z.boolean(),
  capGainsOver200: z.boolean(),
  rawText: z.string(),
  filingStatus: z.string().nullable().optional(),
  subholding: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  supplementalText: z.string().nullable().optional(),
  confidence: z.number().optional(),
  source: z.enum(["primary", "seed_dataset", "manual"]).optional(),
  rowKey: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  cursorSeq: z.number().int().nonnegative().optional(),
  chamber: ChamberSchema.nullable().optional(),
  memberName: z.string().nullable().optional(),
  filedDate: z.string().nullable().optional(),
  fullName: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  photoUrl: z.string().nullable().optional(),
  firstSeenAt: z.string().nullable().optional(),
  sourceUrl: z.string().nullable().optional(),
  refCompanyName: z.string().nullable().optional(),
  refSector: z.string().nullable().optional(),
  refMarketCap: z.number().nullable().optional(),
  refMarketCapBucket: z.string().nullable().optional(),
  refCountry: z.string().nullable().optional(),
  refExchangeShort: z.string().nullable().optional(),
  refAssetClass: z.string().nullable().optional(),
});
export type CongressTransaction = z.infer<typeof CongressTransactionSchema>;

/** Full transaction row returned by the cursor-paginated REST read endpoint. */
export const CongressTransactionReadSchema = CongressTransactionSchema.extend({
  confidence: z.number(),
  source: z.enum(["primary", "seed_dataset", "manual"]),
  createdAt: z.string(),
  cursorSeq: z.number().int().nonnegative(),
});
export type CongressTransactionRead = z.infer<typeof CongressTransactionReadSchema>;

export const TransactionsPageSchema = z.object({
  transactions: z.array(CongressTransactionReadSchema),
  cursor: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative().optional(),
  filingsImportedToday: z.number().int().nonnegative().optional(),
});
export type TransactionsPage = z.infer<typeof TransactionsPageSchema>;

export const TransactionsQuerySchema = z.object({
  since: z.union([
    z.string().regex(/^\d+$/, "Expected a non-negative integer cursor"),
    z.number().int().nonnegative(),
  ]).optional(),
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
  ticker: z.string().optional(),
  member: z.string().optional(),
  chamber: ChamberSchema.optional(),
  type: TxTypeSchema.optional(),
  limit: z.number().int().positive().optional(),
  order: z.enum(["asc", "desc"]).optional(),
});
export type TransactionsQueryInput = z.input<typeof TransactionsQuerySchema>;
export type TransactionsQuery = z.infer<typeof TransactionsQuerySchema>;

// ---- Import/Share payload (App B → App A) ----

export const FundamentalRowSchema = z.object({
  ticker: z.string(),
  date: IsoDateSchema,
  peRatio: nullAsUndefined(z.number()),
  eps: nullAsUndefined(z.number()),
  beta: nullAsUndefined(z.number()),
  dividendYield: nullAsUndefined(z.number()),
  week52High: nullAsUndefined(z.number()),
  week52Low: nullAsUndefined(z.number()),
  fcfYield: nullAsUndefined(z.number()),
  debtToEquity: nullAsUndefined(z.number()),
  epsGrowth: nullAsUndefined(z.number()),
  source: nullAsUndefined(z.string()),
  updatedAt: z.string().optional(),
});
export type FundamentalRow = z.infer<typeof FundamentalRowSchema>;

export const AnalystRowSchema = z.object({
  ticker: z.string(),
  date: IsoDateSchema,
  rating: nullAsUndefined(z.string()),
  strongBuy: nullAsUndefined(z.number()),
  buy: nullAsUndefined(z.number()),
  hold: nullAsUndefined(z.number()),
  sell: nullAsUndefined(z.number()),
  strongSell: nullAsUndefined(z.number()),
  targetMean: nullAsUndefined(z.number()),
  targetHigh: nullAsUndefined(z.number()),
  targetLow: nullAsUndefined(z.number()),
  targetMedian: nullAsUndefined(z.number()),
  analystCount: nullAsUndefined(z.number()),
  source: nullAsUndefined(z.string()),
  updatedAt: z.string().optional(),
  asOfTimestamp: nullAsUndefined(z.string()),
});
export type AnalystRow = z.infer<typeof AnalystRowSchema>;

export const TradeEventRowSchema = z.object({
  docId: z.string(),
  chamber: ChamberSchema,
  source: z.string(),
  sourceUrl: nullAsUndefined(z.string()),
  filerName: z.string(),
  filerId: nullAsUndefined(z.string()),
  party: nullAsUndefined(z.string()),
  state: nullAsUndefined(z.string()),
  district: nullAsUndefined(z.string()),
  ticker: z.string(),
  assetType: nullAsUndefined(z.string()),
  assetDescription: nullAsUndefined(z.string()),
  txType: z.string(),
  transactionDate: IsoDateSchema,
  transactionTimestamp: nullAsUndefined(z.string()),
  disclosureDate: nullAsUndefined(IsoDateSchema),
  disclosureTimestamp: nullAsUndefined(z.string()),
  extractedTimestamp: nullAsUndefined(z.string()),
  amountMin: nullAsUndefined(z.number()),
  amountMax: nullAsUndefined(z.number()),
});
export type TradeEventRow = z.infer<typeof TradeEventRowSchema>;

export const InsiderRowSchema = z.object({
  ticker: z.string(),
  date: IsoDateSchema,
  sentiment: z.number(),
  buyFilings: z.number(),
  sellFilings: z.number(),
  buyShares: z.number(),
  sellShares: z.number(),
  owners: z.array(z.string()),
});
export type InsiderRow = z.infer<typeof InsiderRowSchema>;

/** Read-side shape returned by the ticker-scoped Congress.Trade insider endpoint. */
export const InsiderReadRowSchema = InsiderRowSchema.extend({
  sentiment: z.number().nullable(),
  buyFilings: z.number().nullable(),
  sellFilings: z.number().nullable(),
  buyShares: z.number().nullable(),
  sellShares: z.number().nullable(),
});
export type InsiderReadRow = z.infer<typeof InsiderReadRowSchema>;

export const ShortVolumeRowSchema = z.object({
  ticker: z.string(),
  date: IsoDateSchema,
  ratio: z.number(),
  elevated: z.boolean(),
});
export type ShortVolumeRow = z.infer<typeof ShortVolumeRowSchema>;

/** Read-side shape returned by the ticker-scoped Congress.Trade short-volume endpoint. */
export const ShortVolumeReadRowSchema = ShortVolumeRowSchema.extend({
  ratio: z.number().nullable(),
});
export type ShortVolumeReadRow = z.infer<typeof ShortVolumeReadRowSchema>;

export const PriceSeriesSchema = z.object({
  ticker: z.string(),
  closes: z.array(PriceCloseSchema),
  currentPrice: nullAsUndefined(z.number()),
  currentPriceDate: nullAsUndefined(IsoDateSchema),
});
export type PriceSeries = z.infer<typeof PriceSeriesSchema>;

export const SharePayloadSchema = z.object({
  refs: z.array(SecurityRefInputSchema).optional(),
  spx: z.array(PriceCloseSchema).optional(),
  prices: z.array(PriceSeriesSchema).optional(),
  insider: z.array(InsiderRowSchema).optional(),
  shortVolume: z.array(ShortVolumeRowSchema).optional(),
  fundamentals: z.array(FundamentalRowSchema).optional(),
  analyst: z.array(AnalystRowSchema).optional(),
  trades: z.array(TradeEventRowSchema).optional(),
  origin: z.string().optional(),
});
export type SharePayload = z.infer<typeof SharePayloadSchema>;

export const BundleResponseSchema = z.object({
  ticker: z.string(),
  ref: SecurityRefSchema.nullable(),
  prices: PriceSeriesSchema.nullable(),
  spx: z.array(PriceCloseSchema),
});
export type BundleResponse = z.infer<typeof BundleResponseSchema>;

// ---- Push events (App A → App B) ----

export const CongressEventTypeSchema = z.enum(CONGRESS_EVENT_TYPES);
export type CongressEventType = z.infer<typeof CongressEventTypeSchema>;

export const CongressEventSchema = z.object({
  type: CongressEventTypeSchema.or(z.string().trim().min(1)),
  id: z.string().trim().min(1).optional(),
  seq: z.number().int().nonnegative().optional(),
  emittedAt: z.string().datetime().optional(),
  data: z.unknown().optional(),
});
export type CongressEvent = z.infer<typeof CongressEventSchema>;

export const CongressTradeDataSchema = z.object({
  trades: z.array(CongressTransactionSchema).optional(),
  transaction: CongressTransactionSchema.optional(),
});
export type CongressTradeData = z.infer<typeof CongressTradeDataSchema>;

export const CongressTradeEventSchema = CongressEventSchema.extend({
  type: z.literal("congress.trade").or(z.literal("trade.new")),
  data: CongressTradeDataSchema.optional(),
});
export type CongressTradeEvent = z.infer<typeof CongressTradeEventSchema>;

// ---- Analytics ----

export const ConvictionTickerSchema = z.object({
  ticker: z.string(),
  name: nullAsUndefined(z.string()),
  convictionScore: z.number().nullable(),
  direction: z.enum(["BUY", "SELL"]).nullable(),
  fallback: z.boolean().optional(),
  memberCount: z.number().optional(),
  tradeCount: z.number().optional(),
  directionalMembers: z.number().optional(),
  directionalTrades: z.number().optional(),
  netSentiment: z.number().optional(),
  estNetFlowUsd: z.number().optional(),
  parties: z.record(z.string(), z.number()).optional(),
  components: z.record(z.string(), z.unknown()).optional(),
});
export type ConvictionTicker = z.infer<typeof ConvictionTickerSchema>;

export const TickerLeaderSchema = z.object({
  ticker: z.string(),
  name: nullAsUndefined(z.string()),
  tradeCount: z.number().optional(),
  buyCount: z.number().optional(),
  sellCount: z.number().optional(),
  memberCount: z.number().optional(),
  estVolumeUsd: z.number().optional(),
  estNetFlowUsd: z.number().optional(),
  netSentiment: z.number().optional(),
});
export type TickerLeader = z.infer<typeof TickerLeaderSchema>;

export const ClusterBuySchema = z.object({
  ticker: nullAsUndefined(z.string()),
  name: nullAsUndefined(z.string()),
  txType: nullAsUndefined(z.string()),
  memberCount: z.number().optional(),
  tradeCount: z.number().optional(),
  estVolumeUsd: z.number().optional(),
  firstSeen: nullAsUndefined(z.string()),
  lastSeen: nullAsUndefined(z.string()),
  parties: z.record(z.string(), z.number()).optional(),
  topMembers: z.array(z.object({
    filerId: nullAsUndefined(z.string()),
    fullName: nullAsUndefined(z.string()),
    memberName: nullAsUndefined(z.string()),
    name: nullAsUndefined(z.string()),
    partyBucket: PartyBucketSchema.nullable().optional(),
    photoUrl: nullAsUndefined(z.string()),
    tradeCount: z.number().optional(),
  })).optional(),
});
export type ClusterBuy = z.infer<typeof ClusterBuySchema>;

export const MemberLeaderSchema = z.object({
  filerId: nullAsUndefined(z.string()),
  fullName: nullAsUndefined(z.string()),
  memberName: nullAsUndefined(z.string()),
  name: nullAsUndefined(z.string()),
  party: nullAsUndefined(z.string()),
  partyBucket: PartyBucketSchema.nullable().optional(),
  chamber: ChamberSchema.nullable().optional(),
  state: nullAsUndefined(z.string()),
  photoUrl: nullAsUndefined(z.string()),
  tradeCount: z.number().optional(),
  buyCount: z.number().optional(),
  sellCount: z.number().optional(),
  uniqueTickers: z.number().optional(),
  estVolumeUsd: z.number().optional(),
  estNetFlowUsd: z.number().optional(),
  netSentiment: z.number().optional(),
});
export type MemberLeader = z.infer<typeof MemberLeaderSchema>;

/** One performance leg (trade-date skill or filing-date copy-trade). */
export const MemberPerformanceSchema = z.object({
  tradeCount: z.number().optional(),
  scoredCount: z.number().optional(),
  winRate: z.number().nullable().optional(),
  medianReturn: z.number().nullable().optional(),
  medianExcess: z.number().nullable().optional(),
  avgReturn: z.number().nullable().optional(),
  avgExcess: z.number().nullable().optional(),
  /** Filing-date leg only: excess annualized for Top Performers parity. */
  avgAnnualizedExcess: z.number().nullable().optional(),
});
export type MemberPerformance = z.infer<typeof MemberPerformanceSchema>;

/**
 * Dual-anchor member performance from App A
 * `GET /api/analytics/member/:filerId/performance`.
 *
 * - `tradeDate` — stock move since the politician's trade vs S&P (timing skill)
 * - `filingDate` — move since public disclosure vs S&P (copy-trade for App B)
 * - `performance` — legacy alias of `tradeDate` for older clients
 */
export const MemberDualPerformanceSchema = z.object({
  filerId: z.string().optional(),
  side: z.string().optional(),
  buyCount: z.number().optional(),
  tradeDate: MemberPerformanceSchema.nullable().optional(),
  filingDate: MemberPerformanceSchema.nullable().optional(),
  performance: MemberPerformanceSchema.nullable().optional(),
  note: z.string().optional(),
});
export type MemberDualPerformance = z.infer<typeof MemberDualPerformanceSchema>;

export const BacktestHorizonSchema = z.object({
  days: z.number(),
  tradeCount: z.number(),
  n: z.number(),
  medianReturn: z.number().nullable(),
  avgReturn: z.number().nullable(),
  winRate: z.number().nullable(),
  medianExcess: z.number().nullable(),
  avgExcess: z.number().nullable(),
});
export type BacktestHorizon = z.infer<typeof BacktestHorizonSchema>;

export const TickerBacktestSchema = z.object({
  ticker: z.string(),
  filerId: z.string().nullable().optional(),
  txType: z.string(),
  totalBuyEvents: z.number(),
  pricedDays: z.number(),
  horizons: z.array(BacktestHorizonSchema),
});
export type TickerBacktest = z.infer<typeof TickerBacktestSchema>;

export const CommitteeConflictSchema = z.object({
  id: z.string().nullable(),
  ticker: z.string().nullable(),
  sector: z.string(),
  txType: z.string().nullable(),
  txDate: z.string().nullable(),
  filerId: z.string().nullable(),
  memberName: z.string().nullable(),
  chamber: z.string().nullable(),
  partyBucket: PartyBucketSchema.nullable(),
  viaCommittees: z.array(z.string()),
  estAmountUsd: z.number(),
});
export type CommitteeConflict = z.infer<typeof CommitteeConflictSchema>;

// ---- Snapshot/Export ----

export const SnapshotTableInfoSchema = z.object({
  objectKey: z.string(),
  rowCount: z.number(),
});
export type SnapshotTableInfo = z.infer<typeof SnapshotTableInfoSchema>;

export const SnapshotManifestSchema = z.object({
  generatedAt: z.string(),
  snapshotDate: IsoDateSchema,
  runId: z.string(),
  format: z.literal("ndjson"),
  tables: z.record(z.string(), SnapshotTableInfoSchema),
  schema: z.record(z.string(), z.array(z.string())),
});
export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;

// ---- Client-facing types ----

export const ClientMemberSchema = z.object({
  id: z.string().nullable(),
  name: z.string().nullable(),
  chamber: ChamberSchema.nullable(),
  party: z.string().nullable(),
  state: z.string().nullable(),
  photoUrl: z.string().nullable(),
});
export type ClientMember = z.infer<typeof ClientMemberSchema>;

export const ClientAssetSchema = z.object({
  name: z.string(),
  ticker: z.string().nullable(),
  type: z.string().nullable(),
  sector: z.string().nullable(),
  marketCapBucket: z.string().nullable(),
  companyName: z.string().nullable().optional(),
  logoUrl: z.string().nullable().optional(),
  typeName: z.string().nullable().optional(),
  typeCategory: z.string().nullable().optional(),
  typeCategoryLabel: z.string().nullable().optional(),
});
export type ClientAsset = z.infer<typeof ClientAssetSchema>;

export const ClientTransactionSchema = z.object({
  date: z.string().nullable(),
  type: TxTypeSchema,
  owner: z.string().nullable(),
  amountMin: z.number().nullable(),
  amountMax: z.number().nullable(),
  estValue: z.number().nullable().optional(),
  isOption: z.boolean(),
});
export type ClientTransaction = z.infer<typeof ClientTransactionSchema>;

export const ClientFilingSchema = z.object({
  filedDate: z.string().nullable(),
  firstSeenAt: z.string().nullable(),
  sourceUrl: z.string().nullable(),
});
export type ClientFiling = z.infer<typeof ClientFilingSchema>;

export const ClientTradeSchema = z.object({
  id: z.string(),
  cursor: z.number(),
  docId: z.string(),
  member: ClientMemberSchema,
  asset: ClientAssetSchema,
  transaction: ClientTransactionSchema,
  filing: ClientFilingSchema,
  confidence: z.number(),
  source: z.enum(["primary", "seed_dataset", "manual"]),
});
export type ClientTrade = z.infer<typeof ClientTradeSchema>;

// ---- STOCK Act brackets ----

export const AmountBracketSchema = z.object({
  min: z.number().finite().nonnegative(),
  max: z.number().finite().nonnegative().nullable(),
}).refine((data) => data.max === null || data.max >= data.min, {
  message: "max must be greater than or equal to min",
  path: ["max"],
});

// ---- Subscription (from CongressTradeClient.createSubscription) ----

export const SubscriptionSchema = z.object({
  id: z.string().min(1),
  secret: z.string().min(16).max(256),
  streamUrl: z.string().optional(),
});

// ---- SSE parser ----

export const SseMessageSchema = z.object({
  event: z.string().optional(),
  id: z.string().optional(),
  data: z.string(),
});

// ---- Helper: tolerant array parser ----

/**
 * Parses an unknown value as an array of the given schema.
 * Returns the parsed array on success, or null on failure.
 * Useful for validating API responses at runtime.
 */
export function parseArray<T>(
  schema: z.ZodType<T>,
  data: unknown,
): T[] | null {
  const result = z.array(schema).safeParse(data);
  return result.success ? result.data : null;
}

/**
 * Parses an unknown value against a schema.
 * Returns the parsed value on success, or null on failure.
 */
export function parseSafe<T>(
  schema: z.ZodType<T>,
  data: unknown,
): T | null {
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}
