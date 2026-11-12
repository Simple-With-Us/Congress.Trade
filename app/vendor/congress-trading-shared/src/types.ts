// =============================================================================
// congress-trading-shared — cross-app types
// All types are now derived from Zod schemas via z.infer (single source of truth).
// Schemas live in ./schemas.ts; types are re-exported here for convenience.
// =============================================================================

// ---- Chamber / Party / Owner / TxType / Market-data enums ----

export type {
  Chamber,
  PartyBucket,
  Owner,
  TxType,
  AssetTypeCategory,
  MktCapBucket,
} from "./schemas";

// ---- Market data types ----

export type {
  PriceClose,
  SecurityRef,
  SecurityRefInput,
  PriceSeries,
} from "./schemas";

// ---- Transaction types ----

export type {
  CongressTransaction,
  CongressTransactionRead,
  TransactionsPage,
  TransactionsQueryInput,
  TransactionsQuery,
  BundleResponse,
} from "./schemas";

// ---- Enrichment data types ----

export type {
  FundamentalRow,
  AnalystRow,
  InsiderRow,
  InsiderReadRow,
  ShortVolumeRow,
  ShortVolumeReadRow,
} from "./schemas";

// ---- Analytics types ----

export type {
  ConvictionTicker,
  TickerLeader,
  ClusterBuy,
  MemberLeader,
  MemberPerformance,
  MemberDualPerformance,
  BacktestHorizon,
  TickerBacktest,
  CommitteeConflict,
} from "./schemas";

// ---- Import/Share payload (App B → App A) ----

export type { SharePayload } from "./schemas";

// ---- Push events (App A → App B) ----

export type { CongressEventType, CongressEvent, CongressTradeEvent, CongressTradeData } from "./schemas";

// ---- Snapshot/Export ----

export type { SnapshotTableInfo, SnapshotManifest } from "./schemas";

// ---- Client-facing types ----

export type {
  ClientMember,
  ClientAsset,
  ClientTransaction,
  ClientFiling,
  ClientTrade,
} from "./schemas";

// ---- Ticker alias classification ----

/**
 * Class of a curated ticker alias:
 * - `rename` — a continuous rename/rebrand (same listed entity, price series continues).
 * - `acquisition` — a delisting takeover (source ticker's price series ends at the deal).
 */
export type TickerAliasClass = "rename" | "acquisition";

/** Resolution of a ticker alias source to its target, tagged with the corporate-action class. */
export interface TickerAliasResolution {
  /** The normalized source ticker (the alias key). */
  from: string;
  /** The current/target ticker the alias maps to. */
  to: string;
  /** Whether the mapping is a continuous rename or a discontinuous acquisition. */
  class: TickerAliasClass;
}

// ---- Shared constant (consolidated: canonical is in constants.ts) ----

export { APP_B_ORIGIN_TAG as APP_B_ORIGIN, CONGRESS_EVENT_TYPES } from "./constants";
