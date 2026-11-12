/**
 * src/shared/llmSpend.ts
 *
 * GOVERNOR 1 — hard daily LLM USD ceiling (owner mandate: "no more spend
 * spikes ever").
 *
 * Every extraction/benchmark/bakeoff provider call flows through ONE choke
 * point — `runCandidateOnDoc` in src/extraction/bakeoff.ts (production live
 * ingestion routes there via ConfiguredVisionExtractor, agreement/batch/
 * benchmark/bakeoff call it directly) — plus the shared `fetchWithRetry`
 * wrapper in visionLlm.ts for the raw HTTP adapters. Both consult this module
 * BEFORE spending money, and `runCandidateOnDoc` records the metered dollars
 * for every attempt (success or failure) immediately AFTER the provider
 * responds, so the meter is durable across isolates via one immutable,
 * response/attempt-keyed settlement per paid call.
 *
 * Pricing: provider-reported cost when the provider returns the actual charge
 * (xAI cost_in_usd_ticks), otherwise the shared benchmark rate card
 * (priceBenchmarkUsage). Unpriceable usage (unknown model) records nothing —
 * the meter never invents numbers.
 *
 * Enforcement semantics (the exact "$20 sonnet storm" vector this closes):
 *   - Exceeding a ceiling FAILS CLOSED with error-class 'budget'
 *     (LlmBudgetExceededError / failure code 'llm_budget_exceeded').
 *   - Budget errors are TERMINAL for the attempt: they are never retried by
 *     fetchWithRetry, and ConfiguredVisionExtractor never fails over to
 *     another (potentially pricier) model on a budget halt.
 *   - The meter read itself FAILS OPEN (a D1 blip must not take extraction
 *     down), but spend is recorded on the same D1, so a sustained meter
 *     outage also stops accruing extraction results.
 *
 * Knobs (Infisical-tunable, env fallback, all optional):
 *   LLM_DAILY_USD_CEILING               global daily ceiling, default $10
 *   LLM_DAILY_USD_CEILING_<PROVIDER>    per-provider sub-ceiling (e.g.
 *                                       LLM_DAILY_USD_CEILING_OPENROUTER);
 *                                       unset = governed by the global only
 */

import type { Env } from './types.ts';
import { resolveSecret } from '../secrets/infisical.ts';

/** Stable marker embedded in every budget-halt error message. Provider-failure
 * classification and the no-failover break key off this exact string, so it
 * must never drift and must never match the transient rate-limit regexes
 * (`429|402|too many requests|quota exceeded|rate[- ]?limit|payment required`). */
export const LLM_BUDGET_ERROR_MARKER = 'llm daily usd budget exceeded';

export const LLAMAPARSE_CREDITS_PER_USD = 800;
export const LLAMAPARSE_USD_PER_CREDIT = 0.00125;

export interface LlmSpendDecision {
  allowed: boolean;
  /** Which ceiling tripped when not allowed. */
  scope: 'total' | 'provider';
  provider: string;
  spentUsd: number;
  ceilingUsd: number;
  spentCredits?: number;
  ceilingCredits?: number;
}

/** Fail-closed budget halt. `errorClass: 'budget'` is the stable class name. */
export class LlmBudgetExceededError extends Error {
  readonly errorClass = 'budget' as const;
  constructor(readonly decision: LlmSpendDecision) {
    super(llmBudgetHaltMessage(decision));
    this.name = 'LlmBudgetExceededError';
  }
}

/** Stable, secret-safe budget-halt message carrying the classification marker. */
export function llmBudgetHaltMessage(decision: LlmSpendDecision): string {
  if (decision.provider.trim().toLowerCase() === 'llamaparse' && decision.ceilingCredits != null && decision.spentCredits != null) {
    return (
      `${LLM_BUDGET_ERROR_MARKER} (${decision.scope}:${decision.provider}): ` +
      `${Math.round(decision.spentCredits)} of ${Math.round(decision.ceilingCredits)} credits spent today`
    );
  }
  return (
    `${LLM_BUDGET_ERROR_MARKER} (${decision.scope}` +
    `${decision.scope === 'provider' ? `:${decision.provider}` : ''}): ` +
    `$${decision.spentUsd.toFixed(4)} of $${decision.ceilingUsd.toFixed(2)} spent today`
  );
}

/** True for any error/message produced by a budget halt (error-class 'budget'). */
export function isLlmBudgetHalt(error: unknown): boolean {
  if (error instanceof LlmBudgetExceededError) return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.toLowerCase().includes(LLM_BUDGET_ERROR_MARKER);
}

export const DEFAULT_LLM_DAILY_USD_CEILING = 10;
/** Soft default per-doc lifetime LLM spend (all purposes). Override via LLM_DOC_USD_CEILING. */
export const DEFAULT_LLM_DOC_USD_CEILING = 0.25;
/**
 * Default daily LlamaParse credit ceiling, in credits, FLEET-WIDE.
 *
 * This governor is enforced against `llm_spend_settlements`, whose only
 * provider dimension is `provider` — there is no per-key column — so the
 * number below caps the whole `LLAMAPARSE_API_KEY` pool combined, not one
 * account. The pool is 7 keys, each its own free-tier org with its own
 * 10,000-credit/month grant (see `extraction/llamaParseCredits.ts`), i.e.
 * 70,000 credits/month. Paced over 40 days so a month's grant can never be
 * exhausted before the accounts reset: 70,000 / 40 = 1,750 credits/day.
 *
 * Override via LLAMAPARSE_DAILY_CREDIT_CEILING (prod already sets 1750).
 */
export const DEFAULT_LLAMAPARSE_DAILY_CREDIT_CEILING = 1750;
export const LLM_DOC_BUDGET_ERROR_MARKER = 'llm per-doc usd budget exceeded';
export const LLM_DOC_ALREADY_EXTRACTED_MARKER = 'llm skip: doc already has transactions';

function dayStr(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function usdVar(value: string | undefined, fallback: number | null): number | null {
  const n = Number.parseFloat((value ?? '').trim());
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function providerCeilingKeys(provider: string): string[] {
  const tag = provider.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  if (tag === 'LLAMAPARSE') {
    return [
      'LLAMAPARSE_DAILY_CREDIT_CEILING',
      'LLAMAPARSE_DAILY_CREDITS_CEILING',
      'LLM_DAILY_CREDIT_CEILING_LLAMAPARSE',
      'LLM_DAILY_USD_CEILING_LLAMAPARSE',
      'LLAMAPARSE_DAILY_USD_CEILING',
    ];
  }
  return [`LLM_DAILY_USD_CEILING_${tag}`, `${tag}_DAILY_USD_CEILING`];
}

async function resolveUsdKnob(
  env: Env,
  key: string | string[],
  fallback: number | null,
): Promise<number | null> {
  const keys = Array.isArray(key) ? key : [key];
  for (const k of keys) {
    try {
      const live = (await resolveSecret(env, k as keyof Env & string)).value
        ?? (env[k as keyof Env] as string | undefined);
      const val = usdVar(live, null);
      if (val != null) return val;
    } catch {
      const val = usdVar(env[k as keyof Env] as string | undefined, null);
      if (val != null) return val;
    }
  }
  return fallback;
}

export interface LlmSpendTotals {
  day: string;
  totalUsd: number;
  perProvider: Record<string, number>;
}

export const LLM_SPEND_SETTLEMENT_WRITER = Symbol.for(
  'congress.trade.llm-spend-settlement-writer',
);
export const AUTOPILOT_BUDGET_SETTLEMENT_WRITER = Symbol.for(
  'congress.trade.autopilot-budget-settlement-writer',
);

export interface LlmSpendSettlementReceipt {
  settlementId: string;
  provider: string;
  providerResponseId: string | null;
  attemptId: string;
  day: string;
  occurredAt: string;
  requestedModel: string;
  resolvedModel: string | null;
  docId: string | null;
  /** Call-site purpose: extraction | agreement | benchmark | autopilot | … */
  purpose: string | null;
  usd: number;
  receiptHash: string;
  createdAt: string;
}

export interface LlmSpendSettlementWriter {
  write(receipt: LlmSpendSettlementReceipt): Promise<'inserted' | 'duplicate'>;
}

export interface AutopilotBudgetSettlementReceipt {
  settlementId: string;
  day: string;
  reservedMicroUsd: number;
  actualMicroUsd: number;
  status: 'completed' | 'aborted' | 'failed';
  createdAt: string;
}

export interface AutopilotBudgetSettlementWriter {
  write(receipt: AutopilotBudgetSettlementReceipt): Promise<'inserted' | 'duplicate'>;
}

export const LLM_SPEND_SETTLEMENT_ERROR_MARKER = 'llm spend settlement failed';

export class LlmSpendSettlementError extends Error {
  readonly errorClass = 'accounting' as const;
  constructor(message: string, override readonly cause?: unknown) {
    super(`${LLM_SPEND_SETTLEMENT_ERROR_MARKER}: ${message}`);
    this.name = 'LlmSpendSettlementError';
  }
}

export function isLlmSpendSettlementFailure(error: unknown): boolean {
  if (error instanceof LlmSpendSettlementError) return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.toLowerCase().includes(LLM_SPEND_SETTLEMENT_ERROR_MARKER);
}

class SettlementIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementIntegrityError';
  }
}

function missingSettlementProjection(error: unknown): boolean {
  return /no such table:\s*llm_spend_settlement_totals/i
    .test(error instanceof Error ? error.message : String(error));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface StoredLlmSettlement {
  receipt_hash: string;
}

export function createLlmSpendSettlementWriter(db: D1Database): LlmSpendSettlementWriter {
  return {
    async write(receipt) {
      // Prefer the purpose-aware insert (migration 0077). Fall back when the
      // rolling deploy has not applied ALTER TABLE purpose yet so extraction
      // is never blocked solely on schema lag.
      let inserted: { meta?: { changes?: number } };
      try {
        inserted = await db.prepare(
          `INSERT OR IGNORE INTO llm_spend_settlements
             (settlement_id, provider, provider_response_id, attempt_id, day,
              occurred_at, requested_model, resolved_model, doc_id, purpose, usd,
              receipt_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          receipt.settlementId,
          receipt.provider,
          receipt.providerResponseId,
          receipt.attemptId,
          receipt.day,
          receipt.occurredAt,
          receipt.requestedModel,
          receipt.resolvedModel,
          receipt.docId,
          receipt.purpose,
          receipt.usd,
          receipt.receiptHash,
          receipt.createdAt,
        ).run();
      } catch (error) {
        // SQLite variants: "no such column: purpose" vs "table X has no column named purpose"
        if (!/no such column:\s*purpose|no column named purpose/i.test(
          error instanceof Error ? error.message : String(error),
        )) {
          throw error;
        }
        inserted = await db.prepare(
          `INSERT OR IGNORE INTO llm_spend_settlements
             (settlement_id, provider, provider_response_id, attempt_id, day,
              occurred_at, requested_model, resolved_model, doc_id, usd,
              receipt_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          receipt.settlementId,
          receipt.provider,
          receipt.providerResponseId,
          receipt.attemptId,
          receipt.day,
          receipt.occurredAt,
          receipt.requestedModel,
          receipt.resolvedModel,
          receipt.docId,
          receipt.usd,
          receipt.receiptHash,
          receipt.createdAt,
        ).run();
      }
      if ((inserted.meta?.changes ?? 0) > 0) return 'inserted';

      const existing = await db.prepare(
        `SELECT receipt_hash FROM llm_spend_settlements
          WHERE settlement_id = ?
             OR (? IS NOT NULL AND provider = ? AND provider_response_id = ?)
          LIMIT 1`,
      ).bind(
        receipt.settlementId,
        receipt.providerResponseId,
        receipt.provider,
        receipt.providerResponseId,
      ).first<StoredLlmSettlement>();
      if (!existing) throw new Error('settlement insert was ignored without an existing receipt');
      if (existing.receipt_hash !== receipt.receiptHash) {
        throw new SettlementIntegrityError('settlement identity replayed with conflicting accounting data');
      }
      return 'duplicate';
    },
  };
}

interface StoredAutopilotSettlement {
  day: string;
  reserved_microusd: number;
  actual_microusd: number;
  status: string;
}

export function createAutopilotBudgetSettlementWriter(
  db: D1Database,
): AutopilotBudgetSettlementWriter {
  return {
    async write(receipt) {
      const settled = await db.prepare(
        `UPDATE autopilot_budget_reservations
            SET actual_microusd = ?, status = ?, settled_at = ?
          WHERE reservation_id = ? AND day = ? AND reserved_microusd = ?
            AND status = 'reserved'`,
      ).bind(
        receipt.actualMicroUsd,
        receipt.status,
        receipt.createdAt,
        receipt.settlementId,
        receipt.day,
        receipt.reservedMicroUsd,
      ).run();
      if ((settled.meta?.changes ?? 0) > 0) return 'inserted';
      const existing = await db.prepare(
        `SELECT day, reserved_microusd, actual_microusd, status
           FROM autopilot_budget_reservations WHERE reservation_id = ?`,
      ).bind(receipt.settlementId).first<StoredAutopilotSettlement>();
      if (!existing) throw new Error('autopilot reservation is missing');
      if (
        existing.day !== receipt.day
        || Number(existing.reserved_microusd) !== receipt.reservedMicroUsd
        || Number(existing.actual_microusd) !== receipt.actualMicroUsd
        || existing.status !== receipt.status
      ) {
        throw new SettlementIntegrityError('budget settlement replayed with conflicting accounting data');
      }
      return 'duplicate';
    },
  };
}

function settlementWriter(env: Env): LlmSpendSettlementWriter | null {
  const capability = (env as unknown as Record<PropertyKey, unknown>)[LLM_SPEND_SETTLEMENT_WRITER];
  if (capability && typeof (capability as LlmSpendSettlementWriter).write === 'function') {
    return capability as LlmSpendSettlementWriter;
  }
  const db = (env as Partial<Env>).DB;
  return db && typeof db.prepare === 'function' ? createLlmSpendSettlementWriter(db) : null;
}

function autopilotSettlementWriter(env: Env): AutopilotBudgetSettlementWriter | null {
  const capability = (env as unknown as Record<PropertyKey, unknown>)[AUTOPILOT_BUDGET_SETTLEMENT_WRITER];
  if (capability && typeof (capability as AutopilotBudgetSettlementWriter).write === 'function') {
    return capability as AutopilotBudgetSettlementWriter;
  }
  const db = (env as Partial<Env>).DB;
  return db && typeof db.prepare === 'function' ? createAutopilotBudgetSettlementWriter(db) : null;
}

/** Read today's metered spend. Returns null when the meter is unreadable
 * (missing DB binding, pre-migration table) so callers can fail open. */
export async function readLlmSpend(env: Env, now = new Date()): Promise<LlmSpendTotals | null> {
  const db = (env as Partial<Env>).DB;
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    const legacy = await db
      .prepare('SELECT provider, usd FROM llm_spend WHERE day = ?')
      .bind(dayStr(now))
      .all<{ provider: string; usd: number }>();
    let settlements: { results?: Array<{ provider: string; usd: number }> } = { results: [] };
    try {
      settlements = await db
        .prepare('SELECT provider, usd FROM llm_spend_settlement_totals WHERE day = ?')
        .bind(dayStr(now))
        .all<{ provider: string; usd: number }>();
    } catch (error) {
      if (!missingSettlementProjection(error)) return null;
      // Rolling-deploy compatibility only: migration 0054 immediately creates
      // the bounded projection. Until then, preserve exact ceiling semantics
      // by reading the immutable ledger; never fall back to additive writes.
      try {
        settlements = await db
          .prepare('SELECT provider, usd FROM llm_spend_settlements WHERE day = ?')
          .bind(dayStr(now))
          .all<{ provider: string; usd: number }>();
      } catch {
        return null;
      }
    }
    const perProvider: Record<string, number> = {};
    let totalUsd = 0;
    for (const row of [...(legacy?.results ?? []), ...(settlements?.results ?? [])]) {
      const usd = Number(row.usd) || 0;
      perProvider[row.provider] = (perProvider[row.provider] ?? 0) + usd;
      totalUsd += usd;
    }
    return { day: dayStr(now), totalUsd, perProvider };
  } catch {
    return null;
  }
}

/**
 * Decide whether one more paid call to `provider` is allowed today. Checks the
 * global ceiling first, then the provider sub-ceiling when configured. Fails
 * OPEN (allowed) when the meter cannot be read — see the module doc comment.
 */
export async function checkLlmSpendCeiling(
  env: Env,
  provider: string,
  now = new Date(),
): Promise<LlmSpendDecision> {
  const allowed: LlmSpendDecision = {
    allowed: true,
    scope: 'total',
    provider,
    spentUsd: 0,
    ceilingUsd: DEFAULT_LLM_DAILY_USD_CEILING,
  };
  const spend = await readLlmSpend(env, now);
  if (!spend) return allowed;
  const totalCeiling = (await resolveUsdKnob(env, 'LLM_DAILY_USD_CEILING', DEFAULT_LLM_DAILY_USD_CEILING))
    ?? DEFAULT_LLM_DAILY_USD_CEILING;
  if (spend.totalUsd >= totalCeiling) {
    return { allowed: false, scope: 'total', provider, spentUsd: spend.totalUsd, ceilingUsd: totalCeiling };
  }
  let providerCeiling = await resolveUsdKnob(env, providerCeilingKeys(provider), null);
  const providerSpend = spend.perProvider[provider] ?? 0;
  let spentCredits: number | undefined;
  let ceilingCredits: number | undefined;

  if (provider.trim().toLowerCase() === 'llamaparse') {
    spentCredits = providerSpend * LLAMAPARSE_CREDITS_PER_USD;
    const rawCreditCap = (await resolveSecret(env, 'LLAMAPARSE_DAILY_CREDIT_CEILING')).value
      ?? (await resolveSecret(env, 'LLAMAPARSE_DAILY_CREDITS_CEILING')).value
      ?? env.LLAMAPARSE_DAILY_CREDIT_CEILING
      ?? env.LLAMAPARSE_DAILY_CREDITS_CEILING;

    const parsedCredits = rawCreditCap != null && rawCreditCap.trim() !== ''
      ? usdVar(rawCreditCap, DEFAULT_LLAMAPARSE_DAILY_CREDIT_CEILING)
      : DEFAULT_LLAMAPARSE_DAILY_CREDIT_CEILING;

    if (parsedCredits != null) {
      ceilingCredits = parsedCredits;
      providerCeiling = parsedCredits * LLAMAPARSE_USD_PER_CREDIT;
    }
  }

  if (providerCeiling != null && providerSpend >= providerCeiling) {
    return {
      allowed: false,
      scope: 'provider',
      provider,
      spentUsd: providerSpend,
      ceilingUsd: providerCeiling,
      spentCredits,
      ceilingCredits,
    };
  }
  return { ...allowed, spentUsd: spend.totalUsd, ceilingUsd: totalCeiling, spentCredits, ceilingCredits };
}

/** Throw a fail-closed LlmBudgetExceededError when the ceiling is exhausted. */
export async function assertLlmSpendWithinCeiling(
  env: Env,
  provider: string,
  now = new Date(),
): Promise<void> {
  const decision = await checkLlmSpendCeiling(env, provider, now);
  if (!decision.allowed) throw new LlmBudgetExceededError(decision);
}

export interface SettleLlmSpendInput {
  provider: string;
  requestedModel: string;
  resolvedModel?: string | null;
  providerResponseId?: string | null;
  attemptId: string;
  docId?: string | null;
  /** Call-site purpose for admin/scorecard attribution. */
  purpose?: string | null;
  usd: number;
  occurredAt?: string;
}

export interface DocLlmSpendDecision {
  allowed: boolean;
  docId: string;
  spentUsd: number;
  ceilingUsd: number;
  reason: 'ok' | 'doc_ceiling' | 'already_extracted' | 'meter_unreadable';
}

/** LlamaParse is a free-credit parser, not an OpenRouter USD call. */
export function isLlamaParseProvider(provider: string | null | undefined): boolean {
  return (provider ?? '').trim().toLowerCase() === 'llamaparse';
}

/** Paid model calls that share the per-doc OpenRouter USD latch. */
export function isUsdMeteredExtractionProvider(provider: string | null | undefined): boolean {
  return !isLlamaParseProvider(provider);
}

/** Lifetime metered USD for one doc_id (all purposes). null when unreadable. */
export async function readDocLlmSpendUsd(
  env: Env,
  docId: string,
  opts: { excludeLlamaParse?: boolean } = {},
): Promise<number | null> {
  const db = (env as Partial<Env>).DB;
  if (!db || typeof db.prepare !== 'function' || !docId.trim()) return null;
  try {
    const sql = opts.excludeLlamaParse
      ? `SELECT COALESCE(SUM(usd), 0) AS usd FROM llm_spend_settlements WHERE doc_id = ? AND lower(provider) != 'llamaparse'`
      : `SELECT COALESCE(SUM(usd), 0) AS usd FROM llm_spend_settlements WHERE doc_id = ?`;
    const row = await db.prepare(sql).bind(docId).first<{ usd: number }>();
    return Number(row?.usd) || 0;
  } catch {
    return null;
  }
}

/** True when transactions already exist for this filing (skip re-spend unless reprocess). */
export async function docHasExistingTransactions(env: Env, docId: string): Promise<boolean> {
  const db = (env as Partial<Env>).DB;
  if (!db || typeof db.prepare !== 'function' || !docId.trim()) return false;
  try {
    const row = await db.prepare(
      `SELECT 1 AS ok FROM transactions WHERE doc_id = ? LIMIT 1`,
    ).bind(docId).first<{ ok: number }>();
    return Boolean(row?.ok);
  } catch {
    return false;
  }
}

/**
 * Per-doc spend gate + already-extracted skip.
 * - `reprocess: true` (admin / explicit) bypasses the already-extracted skip
 *   but still honors the per-doc USD ceiling.
 * - `estimatedUsd` (optional) blocks a LIVE call that would overshoot the
 *   remaining ceiling. Cache hits must not pass this — they cost $0.
 * - LlamaParse is exempt from the OpenRouter per-doc USD latch (H-2026-9116328).
 *   Its own daily credit ceiling still applies via checkLlmSpendCeiling.
 * - Meter unreadable → fail open (same as daily ceiling).
 */
export async function checkDocLlmSpendAllowed(
  env: Env,
  docId: string,
  opts: { reprocess?: boolean; estimatedUsd?: number; provider?: string } = {},
): Promise<DocLlmSpendDecision> {
  const ceiling = (await resolveUsdKnob(env, 'LLM_DOC_USD_CEILING', DEFAULT_LLM_DOC_USD_CEILING))
    ?? DEFAULT_LLM_DOC_USD_CEILING;
  if (!opts.reprocess) {
    if (await docHasExistingTransactions(env, docId)) {
      return {
        allowed: false,
        docId,
        spentUsd: 0,
        ceilingUsd: ceiling,
        reason: 'already_extracted',
      };
    }
  }
  const spent = await readDocLlmSpendUsd(env, docId, { excludeLlamaParse: true });
  if (spent == null) {
    return {
      allowed: true,
      docId,
      spentUsd: 0,
      ceilingUsd: ceiling,
      reason: 'meter_unreadable',
    };
  }
  if (isLlamaParseProvider(opts.provider)) {
    return {
      allowed: true,
      docId,
      spentUsd: spent,
      ceilingUsd: ceiling,
      reason: 'ok',
    };
  }
  const estimated = Number.isFinite(opts.estimatedUsd) && (opts.estimatedUsd ?? 0) > 0
    ? Number(opts.estimatedUsd)
    : 0;
  if (spent >= ceiling || spent + estimated > ceiling) {
    return {
      allowed: false,
      docId,
      spentUsd: spent,
      ceilingUsd: ceiling,
      reason: 'doc_ceiling',
    };
  }
  return {
    allowed: true,
    docId,
    spentUsd: spent,
    ceilingUsd: ceiling,
    reason: 'ok',
  };
}

export class LlmDocBudgetExceededError extends Error {
  readonly errorClass = 'budget' as const;
  constructor(readonly decision: DocLlmSpendDecision) {
    super(
      decision.reason === 'already_extracted'
        ? `${LLM_DOC_ALREADY_EXTRACTED_MARKER} (${decision.docId})`
        : `${LLM_DOC_BUDGET_ERROR_MARKER} (${decision.docId}): `
          + `$${decision.spentUsd.toFixed(4)} of $${decision.ceilingUsd.toFixed(2)}`,
    );
    this.name = 'LlmDocBudgetExceededError';
  }
}

export function isLlmDocBudgetHalt(error: unknown): boolean {
  if (error instanceof LlmDocBudgetExceededError) return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const lower = message.toLowerCase();
  return lower.includes(LLM_DOC_BUDGET_ERROR_MARKER)
    || lower.includes(LLM_DOC_ALREADY_EXTRACTED_MARKER);
}

export async function assertDocLlmSpendAllowed(
  env: Env,
  docId: string,
  opts: { reprocess?: boolean; estimatedUsd?: number; provider?: string } = {},
): Promise<void> {
  const decision = await checkDocLlmSpendAllowed(env, docId, opts);
  if (!decision.allowed) throw new LlmDocBudgetExceededError(decision);
}

/** Persist one immutable paid-response receipt through the lease-independent
 * accounting capability. Failures are terminal and visible: silently losing a
 * charge would let the hard ceiling fail open and could trigger paid failover. */
export async function settleLlmSpend(
  env: Env,
  input: SettleLlmSpendInput,
): Promise<'ignored' | 'inserted' | 'duplicate'> {
  if (!(Number.isFinite(input.usd) && input.usd > 0)) return 'ignored';
  const writer = settlementWriter(env);
  // Unit/local callers that intentionally construct an Env without a DB have
  // no durable side effects to account for. Every production runtime has DB.
  if (!writer) return 'ignored';
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const providerResponseId = input.providerResponseId?.trim() || null;
  const purpose = input.purpose?.trim() || null;
  const identity = providerResponseId
    ? [input.provider, 'response', providerResponseId]
    : [input.provider, 'attempt', input.attemptId];
  const settlementId = await sha256(JSON.stringify(identity));
  const receiptHash = await sha256(JSON.stringify({
    provider: input.provider,
    providerResponseId,
    // A provider response ID is the canonical identity across worker replay;
    // the local attempt ID matters only for the no-response-ID fallback.
    attemptId: providerResponseId ? null : input.attemptId,
    day: occurredAt.slice(0, 10),
    requestedModel: input.requestedModel,
    resolvedModel: input.resolvedModel ?? null,
    docId: input.docId ?? null,
    // purpose is attribution metadata only — not part of settlement identity.
    usd: input.usd,
  }));
  const receipt: LlmSpendSettlementReceipt = {
    settlementId,
    provider: input.provider,
    providerResponseId,
    attemptId: input.attemptId,
    day: occurredAt.slice(0, 10),
    occurredAt,
    requestedModel: input.requestedModel,
    resolvedModel: input.resolvedModel ?? null,
    docId: input.docId ?? null,
    purpose,
    usd: input.usd,
    receiptHash,
    createdAt: new Date().toISOString(),
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await writer.write(receipt);
    } catch (error) {
      if (error instanceof SettlementIntegrityError) {
        throw new LlmSpendSettlementError(error.message, error);
      }
      lastError = error;
    }
  }
  throw new LlmSpendSettlementError(
    `could not persist ${input.provider} receipt ${settlementId.slice(0, 12)}`,
    lastError,
  );
}

export async function settleAutopilotBudgetReceipt(
  env: Env,
  receipt: AutopilotBudgetSettlementReceipt,
): Promise<'inserted' | 'duplicate'> {
  const writer = autopilotSettlementWriter(env);
  if (!writer) throw new LlmSpendSettlementError('autopilot accounting writer is unavailable');
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await writer.write(receipt);
    } catch (error) {
      if (error instanceof SettlementIntegrityError) {
        throw new LlmSpendSettlementError(error.message, error);
      }
      lastError = error;
    }
  }
  throw new LlmSpendSettlementError(
    `could not persist autopilot receipt ${receipt.settlementId.slice(0, 24)}`,
    lastError,
  );
}

export interface LlmSpendByModel {
  provider: string;
  model: string;
  callCount: number;
  docCount: number;
  totalUsd: number;
}

export interface LlmSpendRangeReport {
  rangeStart: string;
  rangeEnd: string;
  totalUsd: number;
  totalCalls: number;
  totalDocs: number;
  byModel: LlmSpendByModel[];
}

function daysAgoStr(now: Date, days: number): string {
  const d = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return dayStr(d);
}

/**
 * Metered spend for [sinceDay, throughDay] (inclusive, 'YYYY-MM-DD'),
 * grouped by provider + model (COALESCE(resolved_model, requested_model) --
 * the model that actually ran, not just the one first requested before any
 * fallback substitution). Reads the immutable `llm_spend_settlements` ledger
 * directly rather than the day+provider-only `llm_spend_settlement_totals`
 * projection, since that projection can't answer a model-level or
 * date-range question. Returns null when the meter is unreadable (same
 * fail-open contract as readLlmSpend) rather than a report with no rows, so
 * callers can distinguish "genuinely zero spend" from "couldn't read it".
 */
export async function readLlmSpendByModel(
  env: Env,
  sinceDay: string,
  throughDay: string,
): Promise<LlmSpendRangeReport | null> {
  const db = (env as Partial<Env>).DB;
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    const rows = await db.prepare(
      `SELECT provider, COALESCE(resolved_model, requested_model) AS model,
              COUNT(*) AS call_count, COUNT(DISTINCT doc_id) AS doc_count, SUM(usd) AS total_usd
         FROM llm_spend_settlements
        WHERE day >= ? AND day <= ?
        GROUP BY provider, model
        ORDER BY total_usd DESC`,
    ).bind(sinceDay, throughDay).all<{
      provider: string; model: string; call_count: number; doc_count: number; total_usd: number;
    }>();
    const byModel: LlmSpendByModel[] = (rows?.results ?? []).map((r) => ({
      provider: r.provider,
      model: r.model,
      callCount: Number(r.call_count) || 0,
      docCount: Number(r.doc_count) || 0,
      totalUsd: Number(r.total_usd) || 0,
    }));
    const totalUsd = byModel.reduce((sum, r) => sum + r.totalUsd, 0);
    const totalCalls = byModel.reduce((sum, r) => sum + r.callCount, 0);
    // Doc counts per model can overlap (same doc read by two models) -- a
    // true "distinct docs touched at all" needs its own query rather than
    // summing per-model doc counts, which would double-count.
    const distinctDocsRow = await db.prepare(
      `SELECT COUNT(DISTINCT doc_id) AS n FROM llm_spend_settlements
        WHERE day >= ? AND day <= ? AND doc_id IS NOT NULL`,
    ).bind(sinceDay, throughDay).first<{ n: number }>();
    return {
      rangeStart: sinceDay,
      rangeEnd: throughDay,
      totalUsd,
      totalCalls,
      totalDocs: Number(distinctDocsRow?.n) || 0,
      byModel,
    };
  } catch {
    return null;
  }
}

/** Convenience wrapper: last-7-days and last-30-days reports in one call. */
export async function readLlmSpendWeekAndMonth(
  env: Env,
  now = new Date(),
): Promise<{ week: LlmSpendRangeReport | null; month: LlmSpendRangeReport | null }> {
  const today = dayStr(now);
  const [week, month] = await Promise.all([
    readLlmSpendByModel(env, daysAgoStr(now, 6), today),
    readLlmSpendByModel(env, daysAgoStr(now, 29), today),
  ]);
  return { week, month };
}

export interface LlmSpendSnapshot extends LlmSpendTotals {
  ceilingUsd: number;
  perProviderCeilings: Record<string, number>;
  exhausted: boolean;
}

/** Admin-diagnostics snapshot: today's per-provider dollars vs ceilings. */
export async function inspectLlmSpend(env: Env, now = new Date()): Promise<LlmSpendSnapshot | null> {
  const spend = await readLlmSpend(env, now);
  if (!spend) return null;
  const ceilingUsd = (await resolveUsdKnob(env, 'LLM_DAILY_USD_CEILING', DEFAULT_LLM_DAILY_USD_CEILING))
    ?? DEFAULT_LLM_DAILY_USD_CEILING;
  const perProviderCeilings: Record<string, number> = {};
  for (const provider of Object.keys(spend.perProvider)) {
    const providerCeiling = await resolveUsdKnob(env, providerCeilingKeys(provider), null);
    if (providerCeiling != null) perProviderCeilings[provider] = providerCeiling;
  }
  return {
    ...spend,
    ceilingUsd,
    perProviderCeilings,
    exhausted: spend.totalUsd >= ceilingUsd,
  };
}

export interface DocExtractionMetrics30d {
  sinceDay: string;
  throughDay: string;
  totalIdentifiedDocs: number;
  deterministic: {
    totalDocs: number;
    byMethod: Record<string, number>;
  };
  paidLlm: {
    totalDocs: number;
    totalUsd: number;
    avgCostUsd: number;
    p90CostUsd: number;
    maxCostUsd: number;
    highestCostDocId: string | null;
  };
}

/** Admin 30-day breakdown of identified docs, deterministic vs paid LLM, avg/p90/max cost. */
export async function read30DayExtractionMetrics(
  env: Env,
  now = new Date(),
): Promise<DocExtractionMetrics30d | null> {
  const db = (env as Partial<Env>).DB;
  if (!db || typeof db.prepare !== 'function') return null;

  const today = dayStr(now);
  const sinceDay = daysAgoStr(now, 29);
  const cutoffIso = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const identifiedRow = await db
      .prepare(`SELECT COUNT(*) AS n FROM filings WHERE first_seen_at >= ?`)
      .bind(cutoffIso)
      .first<{ n: number }>();
    const totalIdentifiedDocs = Number(identifiedRow?.n) || 0;

    const detRows = await db
      .prepare(
        `SELECT COALESCE(extractor, 'unknown') AS method, COUNT(*) AS n
           FROM filings
          WHERE first_seen_at >= ?
          GROUP BY method`,
      )
      .bind(cutoffIso)
      .all<{ method: string; n: number }>();

    const byMethod: Record<string, number> = {};
    let detTotal = 0;
    for (const r of detRows?.results ?? []) {
      const count = Number(r.n) || 0;
      byMethod[r.method] = count;
      if (['text_pdf', 'senate_html', 'oge_text', 'scan-cpu-worker', 'local_mac', 'server_cpu', 'tesseract'].includes(r.method)) {
        detTotal += count;
      }
    }

    const paidDocRows = await db
      .prepare(
        `SELECT doc_id, SUM(usd) AS doc_usd
           FROM llm_spend_settlements
          WHERE day >= ? AND day <= ? AND doc_id IS NOT NULL
          GROUP BY doc_id
          ORDER BY doc_usd ASC`,
      )
      .bind(sinceDay, today)
      .all<{ doc_id: string; doc_usd: number }>();

    const paidList = (paidDocRows?.results ?? []).map((r) => ({
      docId: r.doc_id,
      usd: Number(r.doc_usd) || 0,
    }));

    const paidTotalDocs = paidList.length;
    const paidTotalUsd = paidList.reduce((acc, x) => acc + x.usd, 0);
    const avgCostUsd = paidTotalDocs > 0 ? paidTotalUsd / paidTotalDocs : 0;

    let p90CostUsd = 0;
    let maxCostUsd = 0;
    let highestCostDocId: string | null = null;

    if (paidTotalDocs > 0) {
      const p90Idx = Math.min(Math.floor(paidTotalDocs * 0.9), paidTotalDocs - 1);
      p90CostUsd = paidList[p90Idx].usd;
      const highest = paidList[paidTotalDocs - 1];
      maxCostUsd = highest.usd;
      highestCostDocId = highest.docId;
    }

    return {
      sinceDay,
      throughDay: today,
      totalIdentifiedDocs,
      deterministic: {
        totalDocs: detTotal,
        byMethod,
      },
      paidLlm: {
        totalDocs: paidTotalDocs,
        totalUsd: paidTotalUsd,
        avgCostUsd,
        p90CostUsd,
        maxCostUsd,
        highestCostDocId,
      },
    };
  } catch {
    return null;
  }
}
