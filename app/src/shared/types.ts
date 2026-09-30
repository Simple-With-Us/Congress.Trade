/// <reference types="@cloudflare/workers-types" />
/**
 * src/shared/types.ts
 *
 * Canonical shared contracts for congress-feed. Every module (ingestion,
 * extraction, delivery, admin) imports its types from here. Treat this file
 * as the source of truth — downstream agents implement against these shapes.
 */

import type { AssetTypeCategory } from './assetTypes.ts';
import type { StockActStatus } from './stockAct.ts';
import type {
  Chamber,
  Owner,
  TxType,
  ClientTrade,
} from '@jaywedgeworth22/congress-trading-shared';

/**
 * App-wide chamber union: `house | senate | executive`. As of shared package
 * v1.8.0, `executive` (OGE Form 278-T filers: President / Vice President) is
 * part of the upstream `congress-trading-shared` contract itself, so this is
 * now a plain re-export — no more app-local widening (see
 * docs/handoffs/2026-07-15-claude-to-monet.md for the migration). The
 * business rule is unchanged: executive rows are still EXCLUDED by default
 * from the feed/analytics (opt in via an explicit `chamber=` filter), from
 * webhook/SSE subscriptions without an explicit `chambers` filter, and from
 * the App-B bulk export surfaces — that filtering lives in application code,
 * not the type.
 */
export type { Chamber, Owner, TxType, ClientTrade };

// ---------------------------------------------------------------------------
// Primitive unions / enums
// ---------------------------------------------------------------------------


/**
 * Filing type code. STOCK Act Periodic Transaction Reports are 'P'.
 * Kept as a broad string-union to allow future filing types without a
 * breaking change to consumers.
 */
export type FilingType = 'P' | (string & {});

/** Pipeline status of a single filing as it moves through ingestion. */
export type IngestStatus =
  | 'new'
  | 'fetched'
  | 'classified'
  | 'extraction_pending_local'
  | 'extracted'
  | 'persisted'
  | 'needs_review'
  | 'verified_empty'
  | 'error';

/** Detected physical form of a disclosure document. */
export type DocKind = 'senate_html' | 'text_pdf' | 'scanned_pdf' | 'unknown';

/** Beneficial owner of a transaction. */

/** Transaction type storage codes: B (Buy) | S (Sell) | E (Exchange). Legacy P (Purchase) is dual-read and coerced to B on write. */

/** Delivery transport for a subscription. */
export type DeliveryChannel = 'webhook' | 'sse';

/** @deprecated alias of {@link DeliveryChannel}; kept for back-compat. */
export type DeliveryKind = DeliveryChannel;

/** Delivery attempt status. */
export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

/** Provenance of a persisted transaction. 'manual' = hand-entered by an admin in
 *  review when the automated read was wrong / too low-confidence to trust. */
export type TxSource = 'primary' | 'seed_dataset' | 'manual' | 'competitor_backfill' | 'local_mac' | 'server_cpu';

// ---------------------------------------------------------------------------
// Domain entities (mirror D1 tables; JSON columns are typed as parsed shapes)
// ---------------------------------------------------------------------------

export interface Filer {
  bioguideId: string;
  chamber: Chamber;
  fullName: string;
  party: string;
  state: string;
  district: string;
  /** Committee identifiers/names (stored as JSON in D1). */
  committees: string[];
}

export interface Filing {
  docId: string;
  chamber: Chamber;
  filerId: string | null;
  filingType: FilingType;
  filedDate: string | null;
  sourceUrl: string;
  /** R2 object key of the raw fetched original (null until fetched). */
  rawObjectKey: string | null;
  ingestStatus: IngestStatus;
  docKind: DocKind;
  /** Name of the extractor that produced the result (null until extracted). */
  extractor: string | null;
  modelVersion: string | null;
  confidence: number | null;
  firstSeenAt: string;
  sourceUpdatedAt: string | null;
  error: string | null;
  /** Self-hosted URL for the raw document PDF (present if we fetched it). */
  pdfUrl?: string;
  localWaitExpiresAt?: string | null;
}

/** One `trade_latency_candidates` row, already reduced to a single object. */
export interface TradeLatencyRead {
  provider: string | null;
  /** `provider_first_seen_at`.  There is no `observed_at` column. */
  observedAt: string | null;
  providerPublishedAt: string | null;
  congressFirstSeenAt: string | null;
  /** `observedAt` minus `congressFirstSeenAt`, in seconds.  Not a stored column. */
  providerDeltaSec: number | null;
  /** `providerPublishedAt` minus `congressFirstSeenAt`, in seconds.  Not a stored column. */
  providerPublishedDeltaSec: number | null;
  status: string | null;
}

export interface Transaction {
  id: string;
  docId: string;
  filerId: string | null;
  txDate: string | null;
  owner: Owner | null;
  assetName: string;
  ticker: string | null;
  assetType: string | null;
  assetTypeName?: string | null;
  assetTypeCategory?: AssetTypeCategory;
  assetTypeCategoryLabel?: string;
  txType: TxType;
  amountMin: number | null;
  amountMax: number | null;
  isOption: boolean;
  capGainsOver200: boolean;
  rawText: string;
  filingStatus?: string | null;
  subholding?: string | null;
  location?: string | null;
  description?: string | null;
  supplementalText?: string | null;
  confidence: number;
  /** Provenance: live pipeline ('primary') vs backfill ('seed_dataset'). */
  source: TxSource;
  /**
   * Stable per-filing row identity used to make live normalization idempotent.
   * Historical rows may be null/absent until backfilled.
   */
  rowKey?: string | null;
  createdAt: string;
  /** Monotonic cursor for REST `?since=` paging. Assigned at insert. */
  cursorSeq: number;
  /** Audit note detailing data cleaning or normalization operations. */
  cleaningNote?: string | null;
  // --- Optional resolved filer identity (feed/stream only) -----------------
  // Populated only on the dashboard feed + SSE paths (LEFT JOIN filers); absent
  // on the webhook/normalizer paths, hence optional. null when unresolved.
  /** Filer's full name resolved from the filers table. */
  fullName?: string | null;
  /** Filer's state (e.g. 'CA') resolved from the filers table. */
  state?: string | null;
  /** Filer party from the filers table (feed only; used for D/R/I rings and the iOS politician line). */
  party?: string | null;
  /** Filer's headshot URL (unitedstates/images CDN); null = show initials. */
  photoUrl?: string | null;
  /**
   * Filer's official Bioguide ID matched by member enrichment
   * (filers.resolved_bioguide_id, migration 0066). Feed only; null until the
   * enrichment job matches the filer's name against congress-legislators.
   * Distinct from `filerId`, which holds a source-specific synthetic slug.
   */
  bioguideId?: string | null;
  /** Self-hosted URL for the raw document PDF (present if we fetched it). */
  pdfUrl?: string;
  /** Filing's official disclosure date (date-only) from the source. Feed only. */
  filedDate?: string | null;
  /**
   * When we first learned about this trade (feed only). Filing-index
   * first-seen is used only when it does not predate the trade date;
   * otherwise the persist time. Never a date before txDate.
   */
  firstSeenAt?: string | null;
  /** Original public disclosure document URL. Feed only. */
  sourceUrl?: string | null;
  /**
   * Stored STOCK Act disclosure lag: whole days from trade date to official
   * filing date (migration 0065; computed at insert + backfilled). NULL when
   * either date is unknown. See shared/stockAct.ts.
   */
  disclosureLagDays?: number | null;
  /** STOCK Act 45-day classification of the disclosure lag; null = unknown. */
  stockActStatus?: StockActStatus | null;
  /** Close on/before the trade date (`tx_performance.price_at_trade`).  Feed only. */
  priceAtTrade?: number | null;
  /** S&P close on that same trade anchor (`tx_performance.spx_at_trade`). */
  spxAtTrade?: number | null;
  /** Close on/before the filing date (`tx_performance.price_at_filing`). */
  priceAtFiling?: number | null;
  /** S&P close on that same filing anchor (`tx_performance.spx_at_filing`). */
  spxAtFiling?: number | null;
  /**
   * One provider-race row for this trade.  Null when the feed selected the
   * latency columns and no candidate matched.  Absent when the query did not
   * select them (SSE and CSV).  `observedAt` is `provider_first_seen_at`.
   * Deltas are computed the same way as GET /api/admin/disclosure-latency.
   */
  latency?: TradeLatencyRead | null;
  // --- Optional cross-referenced asset data (securities_ref; feed only) ------
  // Populated when the ticker has been enriched; null/absent otherwise.
  refCompanyName?: string | null;
  refSector?: string | null;
  refMarketCap?: number | null;
  refMarketCapBucket?: string | null;
  refCountry?: string | null;
  refExchangeShort?: string | null;
  refAssetClass?: string | null;
}

/**
 * A transaction as produced by an extractor, BEFORE normalization/persistence.
 * Ticker may be unresolved; amount bracket may not yet be validated. The
 * normalizer (src/extraction/normalizer.ts) turns ParsedTx[] into Transaction[].
 */
export interface ParsedTx {
  txDate: string | null;
  owner: Owner | null;
  assetName: string;
  /** Raw ticker as seen in the document; may be null/garbage pre-resolution. */
  ticker: string | null;
  assetType: string | null;
  assetTypeName?: string | null;
  txType: TxType;
  amountMin: number | null;
  amountMax: number | null;
  isOption: boolean;
  capGainsOver200: boolean;
  /**
   * Source fields that were explicitly unreadable and were defaulted locally,
   * or provenance markers for the row itself (e.g. recovered from a truncated
   * provider response — see `salvageTruncatedTransactions` in visionLlm.ts).
   */
  extractionWarnings?: Array<'unreadable_is_option' | 'unreadable_cap_gains' | 'salvaged_truncated_output'>;
  /** Verbatim source text for this row, for audit/review. */
  rawText: string;
  /** Structured/detail text that belongs to this filing row, not page chrome. */
  filingStatus?: string | null;
  subholding?: string | null;
  location?: string | null;
  description?: string | null;
  supplementalText?: string | null;
  /** Per-row extractor confidence in [0,1]. */
  confidence: number;
}

export interface SubscriptionFilters {
  /** Filer bioguide ids to include (empty/undefined => all). */
  members?: string[];
  /** Tickers to include (empty/undefined => all). */
  tickers?: string[];
  /** Chambers to include (empty/undefined => all). */
  chambers?: Chamber[];
  /** Minimum transaction amount_min (bracket floor) to deliver. */
  minAmount?: number;
  /** Maximum transaction amount_min (bracket floor); pairs with minAmount for a range. */
  maxAmount?: number;
  /** Transaction sides to include, e.g. ['B'] for buys only (empty/undefined => all). Legacy 'P' is accepted and treated as Buy. */
  sides?: TxType[];
  /** GICS sectors to include (securities_ref.sector); empty/undefined => all. */
  sectors?: string[];
  /** Market-cap buckets to include (mega…nano, securities_ref.market_cap_bucket). */
  marketCapBuckets?: string[];
}

export interface Subscription {
  id: string;
  clientId: string;
  delivery: DeliveryChannel;
  /** Webhook target URL; null/empty for sse subscriptions. */
  targetUrl: string | null;
  /** Per-subscription credential: webhook HMAC key and SSE/management bearer secret. */
  secret: string | null;
  filters: SubscriptionFilters;
  /** Last delivered transactions.cursorSeq. */
  cursor: number;
  active: boolean;
  createdAt: string;
}

export interface Delivery {
  id: string;
  subscriptionId: string;
  txId: string;
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
}

export interface ReviewItem {
  docId: string;
  reason: string;
  /** Arbitrary JSON payload describing the low-confidence parse. */
  payload: unknown;
  createdAt: string;
  resolved: boolean;
  /** Monotonic optimistic-concurrency version for review-visible state. */
  reviewRevision: number;
  sourceUrl?: string;
  rawObjectKey?: string;
  docKind?: string;
}

// ---------------------------------------------------------------------------
// Client API contracts (shared web app + SwiftUI backend surface)
// ---------------------------------------------------------------------------


export interface ClientPreferences {
  userId: string;
  savedFilters: Record<string, unknown>;
  watchlist: string[];
  notificationSettings: Record<string, unknown>;
  defaultWindow: string | null;
  updatedAt: string;
}

export type ClientCommandType =
  | 'update_preferences'
  | 'create_subscription'
  | 'update_subscription'
  | 'delete_subscription'
  | 'register_device'
  | 'unregister_device'
  | 'start_checkout'
  | 'request_export'
  | 'redeem_apple_purchase'
  | 'link_apple_entitlement'
  | 'delete_account';

export type ClientCommandStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface ClientCommand {
  id: string;
  userId: string;
  type: ClientCommandType;
  status: ClientCommandStatus;
  idempotencyKey: string | null;
  payload: unknown;
  result: unknown | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// ---------------------------------------------------------------------------
// End-user accounts (public-site auth: Google OAuth + email magic-link)
// ---------------------------------------------------------------------------

/**
 * A public-site end user. Distinct from the admin surface and from delivery
 * `Subscription`s (webhook/SSE targets). Billing fields (Stripe) were layered on
 * in migration 0004 and are null until the user starts a checkout.
 */
export interface User {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  /** Google `sub` claim when the user has linked Google sign-in; null otherwise. */
  googleSub: string | null;
  /** Apple `sub` claim when the user has linked Sign in with Apple; null otherwise. */
  appleSub: string | null;
  /** X (Twitter) `sub` / user ID when linked; null otherwise. */
  xSub: string | null;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;

  // --- Billing (Stripe). Null until the user starts a checkout. ---
  /** Stripe customer id (`cus_…`), created lazily on first checkout. */
  stripeCustomerId: string | null;
  /** Stripe subscription id (`sub_…`) for the active/most-recent subscription. */
  stripeSubscriptionId: string | null;
  /** Raw Stripe subscription status: trialing | active | past_due | canceled | … */
  subscriptionStatus: string | null;
  /** Billing cadence of the current subscription. */
  plan: BillingPlan | null;
  /** ISO end of the current billing period (access end on cancel). */
  currentPeriodEnd: string | null;
  /** True when the subscription is set to cancel at period end. */
  cancelAtPeriodEnd: boolean;
  /** ISO end of the free trial, when trialing. */
  trialEnd: string | null;
}

/** Subscription billing cadence. */
export type BillingPlan = 'monthly' | 'annual';

/**
 * Resolved access level for a user (or anonymous visitor). Derived purely from
 * the user's billing fields by billing/entitlement.ts — never stored.
 */
export interface Entitlement {
  /** True when the visitor may access premium features (full history, export). */
  premium: boolean;
  /** Raw Stripe status, or null for anonymous / never-subscribed users. */
  status: string | null;
  plan: BillingPlan | null;
  /** True while in the free trial window. */
  trialing: boolean;
  trialEnd: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /**
   * Which provider the premium grant currently comes from, when known.
   * Populated only by the async resolver (billing/entitlement.ts
   * resolveEntitlementAsync) that also checks the Apple IAP ledger; the pure
   * sync `entitlementOf` leaves this undefined. Additive/optional so it is
   * always backward-compatible for existing Decodable clients.
   *
   * `'apple_anonymous'` is the device-scoped grant issued by `POST
   * /api/client/v1/entitlements/apple/redeem` (Guideline 5.1.1(v) — no
   * Congress.Trade account) — it is never present on a `User`-keyed
   * `resolveEntitlementAsync` response (which only ever resolves 'stripe' |
   * 'apple' | null), only on the anonymous route's own response body.
   */
  source?: 'stripe' | 'apple' | 'apple_anonymous' | null;
}

// ---------------------------------------------------------------------------
// Poll configuration (adaptive scheduling)
// ---------------------------------------------------------------------------

/**
 * A single window of the adaptive poll schedule. Hours are in America/New_York
 * (Eastern) local time. A window matches when the current ET weekday is in
 * daysOfWeek AND startHourET <= hourET < endHourET. endHourET of 24 means
 * "through end of day".
 */
export interface PollWindow {
  /** 0=Sunday ... 6=Saturday. */
  daysOfWeek: number[];
  startHourET: number;
  endHourET: number;
  intervalSec: number;
}

export interface PollConfig {
  schedule: PollWindow[];
  aggressiveMode: boolean;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Queue messages (stage hand-off + delivery fan-out)
// ---------------------------------------------------------------------------

export type QueueMessage =
  | { type: 'filing.new'; docId: string; chamber: Chamber; sourceUrl: string }
  | { type: 'filing.fetched'; docId: string }
  | { type: 'filing.extracted'; docId: string }
  | { type: 'filing.local_wait_check'; docId: string }
  | { type: 'tx.persisted'; txId: string; docId: string }
  | {
      type: 'agreement.check';
      docId: string;
      rawObjectKey: string | null;
      escalationTier?: number;
      /** Durable review_queue lease owner; optional for pre-0031 queued messages. */
      claimToken?: string;
    }
  | {
      type: 'delivery.dispatch';
      txId: string;
      /** Legacy targeted dispatch retained for already-enqueued messages. */
      subscriptionId?: string;
      /** Keyset cursor for one-page-per-message webhook fanout. */
      afterSubscriptionId?: string;
    }
  | {
      /**
       * Async execution of one client command. POST /api/client/v1/commands
       * persists the row, enqueues this message, and returns 202; the worker
       * runs the command and clients poll GET /commands/:id for status.
       */
      type: 'command.execute';
      commandId: string;
      userId: string;
    }
  | {
      /** Durable hand-off for one secret-safe external API usage event. */
      type: 'usage.telemetry';
      event: ThirdPartyUsageTelemetryEvent;
    }
  | {
      /**
       * One backlog-autopilot processing slice (a few docs); the consumer
       * re-enqueues itself until the run completes or halts. Runs in the
       * queue (generous per-message duration), never in the cron.
       *
       * `tickId` MUST be unique per send. Continuation ticks re-enqueue while
       * the current claim is still `processing`, and the active-dedupe unique
       * index is on (queue_name, dedupe_key) for pending/processing rows —
       * a stable per-runId key would INSERT OR IGNORE and silently drop the
       * next slice, stalling the run until the 30-minute stalled halt.
       */
      type: 'autopilot.tick';
      runId: string;
      /** Unique id for this queue row (not the run). Fresh uuid on every send. */
      tickId: string;
    };

/**
 * Strict v2 event queued by fresh producers. The transport adds the batch-level
 * `producerId`; v1 rows exist only in the R2/D1 legacy drain. Keep this
 * deliberately free of request URLs, headers, query strings, bodies, and
 * response payloads.
 */
export interface ThirdPartyUsageTelemetryEvent {
  eventId: string;
  environment: string;
  provider: string;
  service: string;
  project: 'congress-trade';
  label: string;
  producerKeyRef?: string;
  billingMode: 'actual' | 'estimated' | 'manual';
  metricType: 'usage' | 'cost' | 'limit';
  quantity?: number;
  unit?: 'request' | 'call' | 'token' | 'credit' | 'usd' | 'page' | 'job' | 'document' | 'row' | 'byte';
  costUsd?: number;
  requests?: number;
  credits?: number;
  confidence: 'actual' | 'estimated' | 'manual';
  occurredAt: string;
  metadata?: Record<string, string | number | boolean | null>;
  /**
   * Provider-side call/generation id (e.g. OpenRouter's `id` on a completions
   * response). Optional in the shared `UsageTelemetryEventSchema`; lets the
   * monitor verify reported cost against the provider's own record. Never
   * part of the idempotency-key basis.
   */
  providerRequestId?: string;
}

// ---------------------------------------------------------------------------
// Worker environment bindings + secrets
// ---------------------------------------------------------------------------

export interface Env {
  // --- Bindings (Worker-shaped names; Deno shims them on Coolify) ---
  DB: D1Database;
  RAW_FILES: R2Bucket;
  INGEST_QUEUE: Queue<QueueMessage>;
  DELIVERY_QUEUE: Queue<QueueMessage>;
  CONFIG_KV: KVNamespace;

  // SQLite path.  Env names are Turso leftovers.  Production is
  // `file:/data/congress-trade/db.sqlite` via Coolify / Infisical.
  // Do not point these at libsql://…turso.io.  Deno Deploy is retired.
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;

  // S3-compatible raw-document storage used by the Deno runtime.
  AWS_S3_ENDPOINT?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_S3_BUCKET_NAME?: string;
  AWS_REGION?: string;

  // --- Secrets (Infisical / Coolify env / local .dev.vars) ---
  /** Vision/text LLM key (e.g. Gemini) for scanned-PDF extraction. */
  GEMINI_API_KEY?: string;
  GEMINI_RPM_LIMIT?: string;
  /** Primary vision model override (defaults to 'gemini-3.8-flash'). */
  VISION_PRIMARY_MODEL?: string;
  /** Secondary arbitration extractor key. Presence enables arbitration. */
  ARBITRATION_API_KEY?: string;
  /** Anthropic API key — Claude vision candidates in the extractor bake-off. */
  ANTHROPIC_API_KEY?: string;
  /** Anthropic model override (defaults to 'claude-sonnet-5'). */
  ANTHROPIC_MODEL?: string;
  /** OpenAI API key — GPT vision candidates in the extractor bake-off. */
  OPENAI_API_KEY?: string;
  /** Mistral API key — `mistral-ocr-latest` candidate in the extractor bake-off. */
  MISTRAL_API_KEY?: string;
  /** xAI API key — Grok (Files API → grok-4.6) candidate in the extractor bake-off. */
  XAI_API_KEY?: string;
  /** OpenRouter API key — the unified transport for ALL live LLM extraction. */
  OPENROUTER_API_KEY?: string;
  /** Secondary OpenRouter API key for budget cap failover. */
  OPENROUTER_BACKUP_API_KEY?: string;
  /** OpenRouter model override (defaults to '~google/gemini-flash-latest'). */
  OPENROUTER_MODEL?: string;
  /** file-parser engine for typed/text PDFs (default 'cloudflare-ai' — free). */
  OPENROUTER_PDF_ENGINE_TEXT?: string;
  /** file-parser engine for scanned PDFs on non-native-vision models (default 'mistral-ocr'). */
  OPENROUTER_PDF_ENGINE_SCANNED?: string;
  /** Optional per-request provider price ceiling, JSON like {"prompt":5,"completion":20} (USD/M tokens). */
  OPENROUTER_MAX_PRICE?: string;
  /** LlamaIndex Cloud API key — LlamaParse OCR + structured extraction candidate. */
  /** Additional market/enrichment provider keys. */
  MASSIVE_API_KEY?: string;
  INTRINIO_API_KEY?: string;
  TWELVEDATA_API_KEY?: string;
  FINNHUB_API_KEY?: string;
  /** Tiingo API key — enrichment fallback + optional price-history fallback. */
  TIINGO_API_KEY?: string;
  /** Logo.dev public token for the ticker-logo proxy. */
  LOGODEV_PUBLISHABLE_KEY?: string;
  /**
   * Alias used on Coolify/Hetzner (and some older env files). Same publishable
   * logo.dev key as LOGODEV_PUBLISHABLE_KEY — accepted so either name works.
   */
  LOGO_DEV_TOKEN?: string;
  /** 'true' enables the per-minute autonomous cross-vendor agreement → auto-publish pass. */
  AGREEMENT_AUTOPUBLISH_ENABLED?: string;
  /** Max review docs the autonomous pass attempts per cron tick (default 3). */
  AGREEMENT_AUTOPUBLISH_LIMIT?: string;
  /** Max cascade attempts (tier passes) per review doc before it stays in human review (default 3). */
  AGREEMENT_MAX_ATTEMPTS?: string;
  /** Daily autonomous candidate-doc-read budget; -1 explicitly disables the cap (default 300). */
  AGREEMENT_DAILY_LLM_BUDGET?: string;
  /**
   * When 'true' (default), a doc whose cheap complexity signals exceed the
   * thresholds (page_count / raw_bytes) starts the cascade directly at tier 2
   * (three models) instead of tier 1. Set 'false' to always start at tier 1.
   */
  AGREEMENT_BIG_DOC_START_TIER2?: string;
  /** Page-count threshold for the big-doc tier-2 start heuristic (default 10). */
  AGREEMENT_BIG_DOC_PAGE_THRESHOLD?: string;
  /** Raw-byte threshold for the big-doc tier-2 start heuristic (default 2097152 = 2MB). */
  AGREEMENT_BIG_DOC_BYTES_THRESHOLD?: string;
  /**
   * When 'true' (default), the agreement cascade's 7 free-text material fields
   * (assetName, assetType, assetTypeName, subholding, location, description,
   * supplementalText) compare through a canonical form (casefold, punctuation
   * stripped, company suffixes canonicalized) instead of byte/case equality,
   * so two vendors that both correctly read the same disclosed text don't
   * disagree merely over casing or punctuation. The 9 strict/enum fields
   * (ticker, amounts, tx_type, tx_date, owner, is_option, cap_gains_over_200,
   * filing_status) always require exact value equality regardless of this
   * flag. Set 'false' to restore byte-strict comparison on every tier.
   */
  AGREEMENT_TEXT_NORMALIZATION?: string;
  /**
   * Legacy FMP key. Not used by latency probes (those use FMP_LATENCY_* only).
   * Enrichment/prices no longer call FMP on free-tier keys (owner 2026-08).
   * May still appear in admin diagnostics / Infisical inventory.
   */
  FMP_API_KEY?: string;
  /** Free-tier FMP key #1 — disclosure-latency probes ONLY. */
  FMP_LATENCY_API_KEY?: string;
  /**
   * Secondary free-tier latency key lives in env/Infisical as
   * FMP_LATENCY_API_KEY + "_2" (built at runtime in tradeLatency.ts so static
   * scanners do not false-positive the env *name*). Not listed as a typed
   * property for the same reason; resolveSecret still reads it by name.
   */
  /** Per-key daily cap for latency probes (default 235). */
  FMP_LATENCY_DAILY_CAP?: string;
  /**
   * Master switch for FMP-family latency probes (stable + RapidAPI).
   * Default OFF — no FMP spend until operator sets true/1/yes/on.
   */
  FMP_LATENCY_PROBE_ENABLED?: string;
  /** Comma list of FMP paths when probe is on: stable, rapidapi (default both). */
  FMP_LATENCY_PATHS?: string;
  /** Override base URL for FMP stable path. */
  FMP_STABLE_BASE_URL?: string;
  /** Override base URL for FMP RapidAPI path. */
  FMP_RAPIDAPI_BASE_URL?: string;
  /** RapidAPI host header for FMP path. */
  FMP_RAPIDAPI_HOST?: string;
  /**
   * Optional dedicated RapidAPI key for fmp_rapidapi path.
   * Falls back to shared RAPIDAPI_KEY (Socratic.Trade marketplace convention).
   * Does not use free-tier FMP_LATENCY_* keys.
   */
  FMP_RAPIDAPI_KEY?: string;
  /**
   * Shared RapidAPI marketplace key (same secret Socratic.Trade uses for
   * RapidAPI-hosted providers). CT uses it for FMP latency/scout only when
   * FMP_RAPIDAPI_KEY is unset.
   */
  RAPIDAPI_KEY?: string;
  /** Daily HTTP budget for FMP-via-RapidAPI latency path (default 500). */
  FMP_RAPIDAPI_DAILY_CAP?: string;
  /** Daily FMP call budget (stringified int); defaults to 230 when unset. */
  FMP_DAILY_CALL_CAP?: string;
  /** Shared FMP per-minute pacer ceiling (stringified int). Infisical-tunable. */
  FMP_MAX_PER_MINUTE?: string;
  /** SEC EDGAR per-minute pacer ceiling (stringified int). Infisical-tunable. */
  EDGAR_MAX_PER_MINUTE?: string;
  /** Local-dev-only escape hatch: opens admin when the environment is not production. */
  ADMIN_OPEN_IN_DEV?: string;
  /** Override URLs for the seed backfill datasets (House / Senate mirrors). */
  SEED_HOUSE_URL?: string;
  SEED_SENATE_URL?: string;
  /** House live search polling flag; fail-soft (on unless explicitly "false"). */
  HOUSE_LIVE_SEARCH_ENABLED?: string;
  /** Days into January during which the prior-year House index is also swept
   *  (year-boundary gap; default 14, 0 disables). Infisical-tunable. */
  HOUSE_PRIOR_YEAR_OVERLAP_DAYS?: string;
  /** Base Senate submitted-date lookback in days (default 7). Infisical-tunable. */
  SENATE_LOOKBACK_DAYS?: string;
  /** Widened Senate lookback (days) used for the daily deep sweep and outage
   *  catch-up (default 30; raise temporarily for one-off deep recovery). */
  SENATE_MAX_LOOKBACK_DAYS?: string;
  /** Relay microservice URL (e.g. Oracle Coolify host) for Senate eFD ingestion. */
  SENATE_RELAY_URL?: string;
  /** Bearer token for Mac scout.jays.services POST /fetch-ptr and /fetch-doc. */
  SENATE_RELAY_SECRET?: string;
  /** Relay microservice URL (e.g. Oracle Coolify host) for House Clerk ingestion. */
  HOUSE_RELAY_URL?: string;
  /** Relay microservice URL (e.g. Oracle Coolify host) for Executive OGE ingestion. */
  OGE_RELAY_URL?: string;
  /** Shared fallback relay microservice URL for all ingestion sources. */
  INGEST_RELAY_URL?: string;
  /** Proxy gateway URL for routing Senate eFD requests. */
  SENATE_PROXY_URL?: string;
  /** Residential proxy URL (e.g. Tailscale http://100.113.106.39:3128) for all gov scraping/probing. */
  RESIDENTIAL_PROXY_URL?: string;
  RESIDENTIAL_PROXY_HOST?: string;
  RESIDENTIAL_PROXY_PORT?: string;
  RESIDENTIAL_PROXY_USERNAME?: string;
  RESIDENTIAL_PROXY_PASSWORD?: string;
  /** Enable Cloudflare Browser Rendering fallback (strictly capped to free tier). */
  SENATE_USE_BROWSER_RENDERING?: string;
  /** Enables the OGE executive-branch (278-T) filings watcher. Infisical-tunable. */
  OGE_WATCH_ENABLED?: string;
  /** Override URL for the OGE President/VP filings index view. */
  OGE_INDEX_URL?: string;
  /** CSV list of override URLs for OGE filings index views. */
  OGE_INDEX_URLS?: string;
  /**
   * UNUSED live gate. Adaptive `probeSchedule` / `decideSourcePoll` owns
   * executive cadence. A leftover Infisical 21600 must not re-impose 6h.
   */
  OGE_POLL_INTERVAL_SEC?: string;
  /** Max raw PDF bytes sent to vision extraction for executive filings (default 6MB). */
  OGE_MAX_VISION_BYTES?: string;
  /** Model override for the secondary (arbitration) vision extractor. */
  ARBITRATION_MODEL?: string;
  /** Enables the congress.trade-vs-provider congressional disclosure latency monitor. */
  DISCLOSURE_LATENCY_WATCH_ENABLED?: string;
  /** Enables the public-API anti-scraping guard (UA blocklist + per-IP budgets). Unset = off. */
  SCRAPE_GUARD_ENABLED?: string;
  /** App-level D1 daily rows-READ budget (stringified int). Soft-warns at 80%; default 200M/day. Infisical-tunable. */
  D1_DAILY_ROWS_READ_BUDGET?: string;
  /** App-level D1 daily rows-WRITTEN budget (stringified int). Soft-warns at 80%; default 2M/day (~$10/mo of D1 writes). Infisical-tunable. */
  D1_DAILY_ROWS_WRITTEN_BUDGET?: string;
  /** Arm the D1 row-budget HARD stop (skip discretionary daily jobs when over budget). Unset = off (alert-only). Infisical-tunable. */
  D1_ROW_BUDGET_ENFORCE?: string;
  /** Comma-separated provider ids to race: fmp, unusual_whales, quiver. Defaults to direct comparable providers. */
  DISCLOSURE_LATENCY_PROVIDERS?: string;
  /** Latest rows to fetch per provider/chamber endpoint when the latency monitor runs. */
  DISCLOSURE_LATENCY_WATCH_LIMIT?: string;
  /** Enables the legacy congress.trade-vs-FMP monitor switch; kept for backward compatibility. */
  FMP_DISCLOSURE_WATCH_ENABLED?: string;
  /** Legacy FMP-specific latest-row limit; DISCLOSURE_LATENCY_WATCH_LIMIT takes precedence. */
  FMP_DISCLOSURE_WATCH_LIMIT?: string;
  /** Unusual Whales API key for recent Congress trades (latency probe). */
  UNUSUAL_WHALES_API_KEY?: string;
  /** Alias (global-api-keys / Infisical) without underscores in the vendor name. */
  UNUSUALWHALES_API_KEY?: string;
  /** Distinct filed dates the UW disclosure-latency deep-match pass may query
   *  per probe run (recent-trades?date=<filedDate>), for pending observations
   *  older than the normal ~200-row window. Default 8; clamped to [0, 25];
   *  0 disables the pass. */
  UW_DEEP_MATCH_DATES_PER_RUN?: string;
  /**
   * Daily HTTP call budget for Unusual Whales latency probes (default 240).
   * Base recent-trades = 1 call; deep-match date queries spend from remainder.
   * Spread over 24h with denser ET peak-hour yield bands.
   */
  UW_LATENCY_DAILY_CAP?: string;
  /**
   * Daily HTTP call budget for Quiver latency probes (default 360).
   * Each probe = 3 calls (house + senate + trump). Yield-weighted over the day.
   */
  QUIVER_LATENCY_DAILY_CAP?: string;
  /** Quiver API bearer token for live Congress trading endpoints. */
  QUIVER_API_KEY?: string;
  QUIVER_API_TOKEN?: string;
  /** AInvest key; currently reported as symbol-scoped and not directly comparable for this monitor. */
  AINVEST_API_KEY?: string;
  /** Which price provider to prefer: 'fmp' or 'massive'. */
  PRICE_PROVIDER?: string;
  /** HMAC key for signing outbound webhook payloads. */
  WEBHOOK_SIGNING_KEY?: string;
  /** Sentry DSN for error monitoring (Deno SDK via `#sentry`). */
  SENTRY_DSN?: string;
  /** Coolify image SHA (`SOURCE_COMMIT` baked at Docker build).  Sentry release. */
  CT_BUILD_SHA?: string;
  /** Coolify runtime commit when `CT_BUILD_SHA` is unset.  Not a Deploy id. */
  SOURCE_COMMIT?: string;
  /** Sentry event/log environment tag, e.g. "production" | "preview". */
  SENTRY_ENVIRONMENT?: string;
  /** Read-only safety switch for isolated branch-review deployments. */
  PREVIEW_DEPLOYMENT?: string;
  /** Uniform trace sampling rate (0-1) for the Sentry Cloudflare SDK; overrides the code default. */
  SENTRY_TRACES_SAMPLE_RATE?: string;
  /** Browser SDK kill switch (`false`/`0`/`off`/`no`).  Default on when DSN is set. */
  SENTRY_BROWSER_ENABLED?: string;
  /** User Feedback widget kill switch.  Default on. */
  SENTRY_FEEDBACK_ENABLED?: string;
  /** Web session Replay sample (Designer 2026-09-04: default 0.1). */
  SENTRY_REPLAY_SESSION_SAMPLE_RATE?: string;
  /** Web error Replay sample (default 1). */
  SENTRY_REPLAY_ERROR_SAMPLE_RATE?: string;
  /** Datadog API key for agentless logs + APM intake. */
  DD_API_KEY?: string;
  DATADOG_API_KEY?: string;
  /** Datadog application key (fleet registry / synthetics).  Not required to send logs or traces. */
  DD_APP_KEY?: string;
  DATADOG_APP_KEY?: string;
  /** Datadog site, e.g. us5.datadoghq.com. Defaults to us5.datadoghq.com. */
  DD_SITE?: string;
  /** Optional APM/log service override.  Default congress-trade. */
  DD_SERVICE?: string;
  /** Optional Datadog env tag.  Falls back to SENTRY_ENVIRONMENT / USAGE_MONITOR_ENVIRONMENT. */
  DD_ENV?: string;
  /** Optional Datadog Agent host / URL (e.g. 127.0.0.1 or http://127.0.0.1:8126). */
  DD_AGENT_HOST?: string;
  DD_TRACE_AGENT_URL?: string;
  DD_TRACE_AGENT_HOSTNAME?: string;
  DD_TRACE_URL?: string;
  /** Optional APM trace sample rate (0.0 to 1.0, defaults to 0.2). */
  DD_TRACE_SAMPLE_RATE?: string;
  /** Host tag.  Prefer fleet-hetzner-nbg1 so APM does not mint extra Free hosts. */
  DD_HOSTNAME?: string;
  /** RUM kill switch.  false/0/off/no fail-closes even when client tokens exist. */
  DD_RUM_ENABLED?: string;
  NEXT_PUBLIC_DD_RUM_ENABLED?: string;
  /** Public RUM client token.  Aliases: DD_RUM_CLIENT_TOKEN, NEXT_PUBLIC_DD_CLIENT_TOKEN. */
  DD_CLIENT_TOKEN?: string;
  DD_RUM_CLIENT_TOKEN?: string;
  NEXT_PUBLIC_DD_CLIENT_TOKEN?: string;
  NEXT_PUBLIC_DD_RUM_CLIENT_TOKEN?: string;
  /** Public RUM application id.  Aliases: DD_RUM_APPLICATION_ID, NEXT_PUBLIC_DD_APPLICATION_ID. */
  DD_APPLICATION_ID?: string;
  DD_RUM_APPLICATION_ID?: string;
  NEXT_PUBLIC_DD_APPLICATION_ID?: string;
  NEXT_PUBLIC_DD_RUM_APPLICATION_ID?: string;
  NEXT_PUBLIC_DD_SITE?: string;
  /** Cloudflare Workers version metadata binding; used by Sentry to auto-tag the release. */
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp?: string };

  // --- End-user auth (public-site sign-in) ---
  /** Google OAuth client credentials for "Sign in with Google". */
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  /** X (Twitter) OAuth client credentials for "Sign in with X". */
  X_OAUTH_CLIENT_ID?: string;
  X_OAUTH_CLIENT_SECRET?: string;
  /** Resend API key + verified from-address for magic-link sign-in emails. */
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  /** Recipient for operational alert emails (e.g. FMP tier failures); reuses RESEND_API_KEY + EMAIL_FROM. */
  ALERT_EMAIL?: string;
  /** Public base URL (e.g. https://congress.trade) for OAuth redirects + links. */
  APP_BASE_URL?: string;
  /** Cross-app share endpoint + token for pushing refreshed market refs/prices. */
  APP_B_IMPORT_URL?: string;
  APP_B_INGEST_TOKEN?: string;
  /** API Usage Monitor scoped ingest endpoint for app-provider usage telemetry. */
  USAGE_MONITOR_ENABLED?: string;
  USAGE_MONITOR_INGEST_URL?: string;
  USAGE_MONITOR_INGEST_TOKEN?: string;
  USAGE_MONITOR_ENVIRONMENT?: string;
  /**
   * Read-side self-throttle feedback loop (see shared/monitorBudgetGate.ts):
   * CT polls the monitor's cross-app `GET /api/budget-status` so discretionary
   * spend (currently just the backlog autopilot) can back off a provider the
   * monitor already reports at/over budget, instead of learning about it only
   * after CT's own local budget/receipt data catches up. Advisory only — it
   * composes UNDER any hard, CT-local resource governor and fails OPEN
   * (never throttles) when unreachable or unconfigured.
   */
  /** Dedicated read token for `GET /api/budget-status`; falls back to USAGE_MONITOR_INGEST_TOKEN (a token that can push can also read), mirroring the monitor's own USAGE_READ_TOKEN||USAGE_INGEST_TOKEN convention. */
  USAGE_MONITOR_READ_TOKEN?: string;
  /** Master on/off switch for the self-throttle (default enabled whenever the monitor is configured). Set to a falsy value to disable. */
  USAGE_MONITOR_BUDGET_THROTTLE_ENABLED?: string;
  /** Fraction of monthly budget (0-1) at/above which a provider is treated as throttled (default 1.0 — i.e. the monitor's own "exceeded" status). Lower it to back off earlier, e.g. "0.9". */
  USAGE_MONITOR_BUDGET_THROTTLE_THRESHOLD?: string;
  /** In-isolate cache TTL in ms for the polled budget-status response (default 120000 = 2min). */
  USAGE_MONITOR_BUDGET_STATUS_CACHE_TTL_MS?: string;
  /** Bounded request deadline in ms for the budget-status poll itself (default 5000, hard cap 15000). */
  USAGE_MONITOR_BUDGET_STATUS_TIMEOUT_MS?: string;
  /**
   * Usage telemetry delivery circuit breaker + R2 outbox limits (see
   * shared/thirdPartyTelemetry.ts). All are env-overridable; every one has a
   * safe built-in default and none require a redeploy to tune during an
   * incident. Added after a receiver outage let unbounded retries churn a
   * growing D1 table into a large overage — see docs/rollouts for the record.
   */
  /** Consecutive delivery failures before the circuit opens (default 3). */
  USAGE_TELEMETRY_CIRCUIT_FAILURE_THRESHOLD?: string;
  /** First open-circuit backoff window in ms; doubles per repeated probe failure (default 30000 = 30s). */
  USAGE_TELEMETRY_CIRCUIT_BASE_BACKOFF_MS?: string;
  /** Cap on the exponential backoff window in ms (default 1800000 = 30min). */
  USAGE_TELEMETRY_CIRCUIT_MAX_BACKOFF_MS?: string;
  /** Receiver request deadline in ms (default 15000, hard cap 60000). */
  USAGE_TELEMETRY_DELIVERY_TIMEOUT_MS?: string;
  /** Atomic half-open probe lease in ms; always exceeds the delivery deadline (default 30000). */
  USAGE_TELEMETRY_CIRCUIT_PROBE_LEASE_MS?: string;
  /** Hard cap on pending R2 outbox objects; new events are dropped past this (default 5000). */
  USAGE_TELEMETRY_FALLBACK_MAX_OBJECTS?: string;
  /** Age in days at which a pending R2 outbox object is discarded unsent (default 14). */
  USAGE_TELEMETRY_FALLBACK_TTL_DAYS?: string;
  /** Max legacy D1 fallback rows read per flush cycle during the one-time drain (default 100, hard cap 500). */
  USAGE_TELEMETRY_D1_DRAIN_LIMIT?: string;

  /**
   * --- Hard resource governors (owner mandate 2026-07-18) ---
   * Governor 1: daily LLM USD ceilings (shared/llmSpend.ts; Infisical-tunable).
   * Enforced fail-closed inside the provider-call choke point.
   */
  /** Global daily LLM spend ceiling in USD (default 10). */
  LLM_DAILY_USD_CEILING?: string;
  /** Per-doc lifetime LLM spend ceiling in USD (default 0.25). */
  LLM_DOC_USD_CEILING?: string;
  /** Optional per-provider daily USD sub-ceilings; unset = global-only. */
  LLM_DAILY_USD_CEILING_OPENROUTER?: string;
  OPENROUTER_DAILY_USD_CEILING?: string;
  LLM_DAILY_USD_CEILING_GEMINI?: string;
  LLM_DAILY_USD_CEILING_OPENAI?: string;
  LLM_DAILY_USD_CEILING_ANTHROPIC?: string;
  LLM_DAILY_USD_CEILING_MISTRAL?: string;
  LLM_DAILY_USD_CEILING_XAI?: string;
  LLM_DAILY_USD_CEILING_LLAMAPARSE?: string;
  LLAMAPARSE_DAILY_USD_CEILING?: string;
  LLAMAPARSE_DAILY_CREDIT_CEILING?: string;
  LLAMAPARSE_DAILY_CREDITS_CEILING?: string;
  /**
   * Governor 2: D1 write governor (shared/d1Budget.ts). Env-only like the
   * usage-telemetry circuit limits: read synchronously on the hot write path.
   */
  /** Governed write operations allowed per invocation (default 2000). */
  D1_WRITE_OPS_PER_INVOCATION_CAP?: string;
  /** Statements per governed batch before truncation + quarantine (default 200). */
  D1_WRITE_BATCH_CAP?: string;
  /**
   * Governor 3: per-target outbound circuit breaker
   * (delivery/targetCircuit.ts). Env-only, same rationale as above.
   */
  /** Consecutive failures before a target's circuit opens (default 5). */
  DELIVERY_TARGET_FAILURE_THRESHOLD?: string;
  /** Failed attempts allowed per target per UTC day (default 50). */
  DELIVERY_TARGET_DAILY_ATTEMPT_CAP?: string;
  /** First open-circuit window in seconds; doubles per failure, capped at 3600 (default 60). */
  DELIVERY_TARGET_BASE_BACKOFF_SEC?: string;
  /** Parked deliveries allowed per subscription before overflow quarantine (default 500). */
  DELIVERY_TARGET_PARKED_CAP?: string;
  /** Admin + scoped import bearer tokens. */
  ADMIN_TOKEN?: string;
  /** Admin email allowlist for site-session admin access and Cloudflare Access. */
  ADMIN_EMAILS?: string;
  /** HTTPS webhook that wakes Grok Bot Publisher on review_queue entry. */
  REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL?: string;
  /** HMAC secret for REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL payloads. */
  REVIEW_QUEUE_PUBLISHER_WEBHOOK_SECRET?: string;
  /** Cloudflare Access team name/hostname for admin API JWT verification. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Access application AUD tag for admin API JWT verification. */
  ACCESS_AUD?: string;
  INGEST_TOKEN?: string;
  /** Scoped token for the idempotent admin maintenance endpoints only (backlog requeue/retry). */
  ADMIN_MAINTENANCE_TOKEN?: string;
  LLAMAPARSE_API_KEY?: string;

  // --- Billing (Stripe) ---
  /** Stripe secret key (`sk_…`) for the REST API. Presence enables billing. */
  STRIPE_SECRET_KEY?: string;
  /** Stripe webhook signing secret (`whsec_…`) for verifying webhook events. */
  STRIPE_WEBHOOK_SECRET?: string;
  /** Stripe Price ids for the premium tier (one per cadence). */
  STRIPE_PRICE_MONTHLY?: string;
  STRIPE_PRICE_ANNUAL?: string;
  /** Free-trial length in days for new subscriptions (default 7). */
  STRIPE_TRIAL_DAYS?: string;
  /** Live Billing Portal configuration id (`bpc_…`).  Without this, Stripe's
   *  implicit default can hide the Premium product and show an empty
   *  subscription list. */
  STRIPE_PORTAL_CONFIGURATION?: string;
  /** iOS bundle id for StoreKit receipt verification (default trade.congress.ios). */
  APPLE_BUNDLE_ID?: string;
  /** Sign in with Apple Services ID for the website OAuth flow. */
  APPLE_SERVICES_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_P8?: string;
  APPLE_PRIVATE_KEY?: string;
  /** APNs provider key id (10-char). Required with team id + signing material to send. */
  APNS_KEY_ID?: string;
  /** Apple Developer Team ID. */
  APNS_TEAM_ID?: string;
  /** APNs topic; defaults to trade.congress.ios. */
  APNS_BUNDLE_ID?: string;
  /** Signing material for the APNs provider token. Never log. */
  APNS_P8?: string;
  /** Alternate env slot for the same signing material. */
  APNS_PRIVATE_KEY_B64?: string;
  APNS_PRIVATE_KEY?: string;
  /** "true" to enable Stripe Managed Payments (merchant-of-record) on Checkout.
   *  Leave off until the account is approved for Managed Payments and products
   *  carry an eligible digital tax code. */
  STRIPE_MANAGED_PAYMENTS?: string;

  // --- Apple (Sign in with Apple + In-App Purchase) ---
  /** "true" to enable POST /auth/apple. Off until Sign in with Apple capability + key config are set up in App Store Connect. */
  APPLE_SIGNIN_ENABLED?: string;
  /** "true" to enable the redeem_apple_purchase command + POST /api/webhooks/apple. Off until the App Store Connect subscription products exist. */
  APPLE_IAP_ENABLED?: string;
  /**
   * Kill switch for App Store Sandbox / TestFlight JWS. Default (unset / "true")
   * allows Apple-signed Sandbox grants because TestFlight, App Review, and
   * Designed-for-iPad on Mac all talk to this production API with
   * environment=Sandbox. Set "false" to refuse those grants.
   */
  APPLE_ALLOW_SANDBOX?: string;
  /** App Store Connect product id for the monthly Premium subscription (default trade.congress.premium.monthly). */
  APPLE_PRODUCT_MONTHLY?: string;
  /** App Store Connect product id for the annual Premium subscription (default trade.congress.premium.annual). */
  APPLE_PRODUCT_ANNUAL?: string;
  /**
   * HMAC key for the anonymous-purchase device entitlement token
   * (`billing/deviceEntitlement.ts`) — the short-lived proof a signed-out
   * device presents on PDF/CSV requests after `POST
   * /api/client/v1/entitlements/apple/redeem`. Independent of every other
   * signing key in this file; rotating it just expires outstanding tokens
   * early (every one re-mints on the device's next reconcile pass).
   */
  APPLE_DEVICE_ENTITLEMENT_SECRET?: string;

  // --- Infisical runtime secret resolver ---
  /** Optional Infisical API origin. Defaults to https://app.infisical.com. */
  INFISICAL_BASE_URL?: string;
  /** Infisical environment/slug for both app + shared projects. Defaults to prod. */
  INFISICAL_ENV?: string;
  /** Short-lived in-isolate secret cache TTL. Defaults to 600 seconds. */
  INFISICAL_CACHE_TTL_SECONDS?: string;
  /** Set "false" after cutover to disable fallback to Cloudflare Worker secrets. */
  INFISICAL_ALLOW_ENV_FALLBACK?: string;
  /** App-specific Infisical machine identity + project. */
  INFISICAL_APP_PROJECT_ID?: string;
  INFISICAL_APP_CLIENT_ID?: string;
  INFISICAL_APP_CLIENT_SECRET?: string;
  INFISICAL_APP_SECRET_PATH?: string;
  /** Legacy Coolify names (no _APP_); accepted as aliases for the app project. */
  INFISICAL_CLIENT_ID?: string;
  INFISICAL_CLIENT_SECRET?: string;
  INFISICAL_SECRET_PATH?: string;
  INFISICAL_PROJECT_ID?: string;
  /** Shared Infisical machine identity + project for shared-at-ct secrets. */
  INFISICAL_SHARED_PROJECT_ID?: string;
  INFISICAL_SHARED_CLIENT_ID?: string;
  INFISICAL_SHARED_CLIENT_SECRET?: string;
  INFISICAL_SHARED_SECRET_PATH?: string;

  // --- Plain vars (.dev.vars / [vars]) ---
  /**
   * Numeric App Store Connect id for the iOS app, e.g. "1234567890" — set
   * once the app is Approved and has a real id (see src/ui/appLinks.ts).
   * Unset by default: the app is not in the public App Store yet, so there
   * is no real id to hardcode, and the Smart App Banner stays absent until
   * this is configured.
   */
  IOS_APP_STORE_ID?: string;
  /** Public TestFlight join link or beta URL for the iOS app. */
  IOS_TESTFLIGHT_URL?: string;
  IOS_BETA_URL?: string;
  /** "true" to force arbitration on when configured. */
  ARBITRATION_ENABLED?: string;
  /** Cross-app import guardrails. Tune down for lean/free-compatible runs. */
  IMPORT_MAX_BYTES?: string;
  IMPORT_MAX_REFS?: string;
  IMPORT_MAX_SPX?: string;
  IMPORT_MAX_PRICES?: string;
  IMPORT_MAX_CLOSES_PER_TICKER?: string;
  IMPORT_MAX_INSIDER?: string;
  IMPORT_MAX_SHORT_VOLUME?: string;
}
