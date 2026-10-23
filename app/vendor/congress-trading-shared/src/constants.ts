// =============================================================================
// congress-trading-shared — constants
// =============================================================================

// ---- Ticker aliases (corporate actions / ticker changes) ----
//
// Two semantically distinct classes — the split matters for point-in-time (PIT) return
// attribution (see `classifyTickerAlias` / `resolveContinuousTicker` in utils.ts):
//   • TICKER_RENAMES      — same continuous listed entity; the price series simply continues
//                           under the new ticker, so folding old→new is correct for backtests.
//   • TICKER_ACQUISITIONS — the source ticker was delisted in a takeover (cash and/or a
//                           different successor entity); its price series ENDS at the deal, so
//                           folding it into the acquirer's ongoing series fabricates exposure.
// `TICKER_ALIASES` is their union, retained as a flat map for identity/display resolution and
// for backward compatibility with existing consumers that only need the current ticker.

/** Continuous renames/rebrands: same listed entity, price history continues under the new ticker. */
export const TICKER_RENAMES: Readonly<Record<string, string>> = Object.freeze({
  FB: "META", // Facebook, Inc. → Meta Platforms, Inc.; ticker change 2022-06-09, same CIK/listing.
  SQ: "XYZ", // Block, Inc. ticker change SQ → XYZ (2025); same entity, continuous listing.
  GEHCV: "GEHC", // GE HealthCare when-issued (GEHCV) → regular-way (GEHC) after the 2023 GE spin-off.
});

/**
 * Delisting acquisitions: source ticker ceased trading in a takeover; its price series is
 * discontinuous. The `to` target is the curated successor used for identity/display resolution —
 * for a multi-step history it is the current successor, which may be several corporate actions
 * removed from the immediate 2018-style acquirer (see TWX below). These targets are a stable
 * contract (existing consumers/tests depend on them); do not repoint them without a major bump.
 */
export const TICKER_ACQUISITIONS: Readonly<Record<string, string>> = Object.freeze({
  BRCM: "AVGO", // Broadcom Corp (BRCM) acquired by Avago, closed 2016-02-01 (mixed cash+stock); BRCM delisted, Avago renamed itself Broadcom Ltd and continues as AVGO (AVGO is Avago's own series, not BRCM's).
  TWX: "WBD", // Time Warner (TWX) acquired by AT&T 2018 — TWX holders received AT&T (T) stock and TWX's series ended there. WBD is a DOWNSTREAM 2022 entity (AT&T's WarnerMedia spun off + merged with Discovery); curated as the current successor for display, NOT the direct 2018 successor.
  ATVI: "MSFT", // Activision Blizzard (ATVI) acquired by Microsoft 2023 (all-cash); ATVI delisted, holders received cash, not MSFT shares.
  RHT: "IBM", // Red Hat (RHT) acquired by IBM 2019 (all-cash); RHT delisted, holders received cash, not IBM shares.
});

/**
 * Union of every curated ticker alias (renames + acquisitions), for IDENTITY/display resolution
 * where only the current ticker matters. Kept as a flat map for backward compatibility.
 *
 * NOTE: this map is PIT-UNSAFE — it folds acquisition sources (ATVI→MSFT, …) into the acquirer,
 * so point-in-time logic that resolves through it will attribute a delisted position to the
 * acquirer's ongoing price series. Use `classifyTickerAlias()` / `resolveContinuousTicker()`
 * when the corporate-action class matters. Its key enumeration order (renames then acquisitions)
 * is NOT part of the contract — treat it as an unordered lookup map.
 */
export const TICKER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  ...TICKER_RENAMES,
  ...TICKER_ACQUISITIONS,
});

// ---- Market cap bucket thresholds ----

export const MKT_CAP_THRESHOLDS = Object.freeze({
  MEGA: 200_000_000_000, // $200B+
  LARGE: 10_000_000_000, // $10B+
  MID: 2_000_000_000, // $2B+
  SMALL: 300_000_000, // $300M+
  MICRO: 50_000_000, // $50M+
} as const);

// ---- API paths ----

export const API_PATHS = Object.freeze({
  HEALTH: "/api/health",
  TRANSACTIONS: "/api/transactions",
  STREAM: "/api/stream",
  MARKET_BUNDLE: "/api/market/bundle",
  MARKET_REF: "/api/market/ref",
  MARKET_REFS: "/api/market/refs",
  MARKET_PRICES: "/api/market/prices",
  MARKET_SPX: "/api/market/spx",
  MARKET_FUNDAMENTALS: "/api/market/fundamentals",
  MARKET_ANALYST: "/api/market/analyst",
  MARKET_INSIDER: "/api/market/insider",
  MARKET_SHORT_VOLUME: "/api/market/short-volume",
  ANALYTICS_TICKER_LEADERBOARD: "/api/analytics/ticker-leaderboard",
  ANALYTICS_CONVICTION: "/api/analytics/conviction",
  ANALYTICS_MEMBER_LEADERBOARD: "/api/analytics/member-leaderboard",
  ANALYTICS_CLUSTER_BUYS: "/api/analytics/cluster-buys",
  ANALYTICS_MEMBER_PERFORMANCE: "/api/analytics/member",
  ANALYTICS_TICKER_BACKTEST: "/api/analytics/ticker",
  ANALYTICS_CONFLICTS: "/api/analytics/conflicts",
  ADMIN_SECURITIES_IMPORT: "/api/admin/securities/import",
  EXPORT_BULK_SNAPSHOT: "/api/export/bulk-snapshot",
  SUBSCRIPTIONS: "/api/subscriptions",
} as const);

// ---- Analytics window presets ----

export const WINDOW_PRESETS = Object.freeze([
  "1d", "7d", "30d", "90d", "180d", "365d", "1825d", "all",
] as const);

export type Window = (typeof WINDOW_PRESETS)[number];

// ---- Filing lag buckets ----

export const LAG_BUCKETS = Object.freeze([
  Object.freeze({ label: "0-7d", max: 7 }),
  Object.freeze({ label: "8-14d", max: 14 }),
  Object.freeze({ label: "15-30d", max: 30 }),
  Object.freeze({ label: "31-45d", max: 45 }),
  Object.freeze({ label: "46-59d", max: 59 }),
  Object.freeze({ label: "60d+", max: null }),
] as const);

// ---- Defaults ----

export const DEFAULT_CONGRESS_TRADE_BASE_URL = "https://congress.trade";

export const DEFAULT_TRANSACTIONS_LIMIT = 100;

export const MAX_REFS_BATCH = 500;

export const APP_B_ORIGIN_TAG = "app-b" as const;

// ---- Share payload contract version (App B → App A) ----

/**
 * Current version of the `SharePayloadSchema` envelope (ST-3853).  Senders should stamp
 * `schemaVersion: SHARE_PAYLOAD_SCHEMA_VERSION` on every share payload.  A payload without the
 * field predates versioning and is treated as version 1 (see `resolveSharePayloadSchemaVersion`).
 * Bump this only for a breaking change to the envelope or its row schemas, and ship the receiver
 * support first.
 */
export const SHARE_PAYLOAD_SCHEMA_VERSION = 1 as const;

/** Version assumed for legacy share payloads that carry no `schemaVersion`. */
export const SHARE_PAYLOAD_LEGACY_SCHEMA_VERSION = 1 as const;

// ---- Events ----

export const CONGRESS_EVENT_TYPES = Object.freeze([
  "congress.trade",
  "insider.update",
  "ref.upsert",
  "price.eod",
  "spx.eod",
] as const);
