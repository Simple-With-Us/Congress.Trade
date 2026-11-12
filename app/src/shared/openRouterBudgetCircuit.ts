/**
 * OpenRouter key-budget circuit (owner 2026-08-07).
 *
 * When the OpenRouter key hits its weekly/account budget, hammering the API
 * does not "wait for money" productively — it burns queue attempts, logs, and
 * latency. Policy:
 *
 *   1. Allow a short burst of immediate failures (default 3) so a transient
 *      403 is not a permanent outage.
 *   2. Trip the circuit open for 1 hour (default) — no further OpenRouter
 *      paid calls until the cool-down ends.
 *   3. On success, clear the streak and close the circuit.
 *
 * Delaying spend over hours is NOT a solution for being over budget; this
 * only prevents a million useless retries. The app daily LLM ceiling
 * (llmSpend.ts) remains the spend governor when funds exist.
 *
 * State lives in CONFIG_KV (`openrouter_budget_circuit`) so it is shared
 * across Deno isolates. Fail-open when KV is missing (local unit tests).
 */

import type { Env } from './types.ts';
import { IngestRetryError } from '../ingestion/fetcher.ts';

export const OPENROUTER_BUDGET_CIRCUIT_KV_KEY = 'openrouter_budget_circuit';
export const OPENROUTER_BUDGET_ERROR_MARKER = 'openrouter key budget circuit open';

/** Default consecutive budget failures before the circuit opens. */
export const DEFAULT_OR_BUDGET_TRIP_AFTER = 3;
/** Default cool-down once open (seconds). */
export const DEFAULT_OR_BUDGET_COOLDOWN_SECONDS = 3600;

export interface OpenRouterBudgetCircuitState {
  consecutiveFailures: number;
  /** Epoch ms when the cool-down ends; null when closed. */
  openUntilMs: number | null;
  lastError: string | null;
  updatedAtMs: number;
  /**
   * How many times this isolate has opened the circuit.  Files-prepaid /
   * key-limit trips stay bounded: after MAX_TRANSIENT_OPENS the cool-down
   * still applies once, then the circuit closes so extraction can auto-resume.
   * Real depleted-credit / auth failures are not stored here — those halt
   * autopilot fail-closed.
   */
  openCount: number;
}

/** Max transient (files-prepaid / key-limit) opens before we stop extending. */
export const MAX_TRANSIENT_CIRCUIT_OPENS = 6;

const FILES_PREPAID_RE = /balance for files|at least \$0\.50|openrouter_key_limit|files-endpoint prepaid/i;

export function isTransientFilesPrepaidBudgetMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  return FILES_PREPAID_RE.test(message);
}

export interface OpenRouterBudgetCircuitKnobs {
  tripAfter: number;
  cooldownSeconds: number;
}

const BUDGET_MESSAGE_RE =
  /budget limit|key limit exceeded|key budget|weekly limit|monthly usage limit|include_byok|payment required|credits? (are )?depleted|insufficient[_ ]?(credits|quota)|credit balance is too low|billing hard limit|prepayment credits|api key budget/i;

export function isOpenRouterBudgetMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  return BUDGET_MESSAGE_RE.test(message);
}

export function isOpenRouterBudgetHttp(status: number, detail = ''): boolean {
  if (status === 402) return true;
  if (status === 403 && isOpenRouterBudgetMessage(detail)) return true;
  return isOpenRouterBudgetMessage(detail);
}

export async function resolveOpenRouterBudgetCircuitKnobs(
  env: Env,
): Promise<OpenRouterBudgetCircuitKnobs> {
  const envRec = env as unknown as Record<string, unknown>;
  const tripRaw = Number.parseInt(String(envRec.OPENROUTER_BUDGET_TRIP_AFTER ?? ''), 10);
  const coolRaw = Number.parseInt(
    String(envRec.OPENROUTER_BUDGET_COOLDOWN_SECONDS ?? ''),
    10,
  );
  return {
    tripAfter: Number.isFinite(tripRaw) && tripRaw >= 1 ? tripRaw : DEFAULT_OR_BUDGET_TRIP_AFTER,
    cooldownSeconds: Number.isFinite(coolRaw) && coolRaw >= 60
      ? coolRaw
      : DEFAULT_OR_BUDGET_COOLDOWN_SECONDS,
  };
}

function emptyState(nowMs: number): OpenRouterBudgetCircuitState {
  return {
    consecutiveFailures: 0,
    openUntilMs: null,
    lastError: null,
    updatedAtMs: nowMs,
    openCount: 0,
  };
}

export async function readOpenRouterBudgetCircuit(
  env: Env,
  nowMs = Date.now(),
): Promise<OpenRouterBudgetCircuitState> {
  const kv = env.CONFIG_KV;
  if (!kv) return emptyState(nowMs);
  try {
    const raw = await kv.get(OPENROUTER_BUDGET_CIRCUIT_KV_KEY);
    if (!raw) return emptyState(nowMs);
    const parsed = JSON.parse(raw) as Partial<OpenRouterBudgetCircuitState>;
    const openUntilMs = typeof parsed.openUntilMs === 'number' ? parsed.openUntilMs : null;
    // Expired cool-down → treat as closed for callers.
    if (openUntilMs != null && openUntilMs <= nowMs) {
      return {
        consecutiveFailures: 0,
        openUntilMs: null,
        lastError: parsed.lastError ?? null,
        updatedAtMs: nowMs,
        openCount: Math.max(0, Number(parsed.openCount) || 0),
      };
    }
    return {
      consecutiveFailures: Math.max(0, Number(parsed.consecutiveFailures) || 0),
      openUntilMs,
      lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
      updatedAtMs: typeof parsed.updatedAtMs === 'number' ? parsed.updatedAtMs : nowMs,
      openCount: Math.max(0, Number(parsed.openCount) || 0),
    };
  } catch {
    return emptyState(nowMs);
  }
}

async function writeState(env: Env, state: OpenRouterBudgetCircuitState, cooldownSeconds: number): Promise<void> {
  const kv = env.CONFIG_KV;
  if (!kv) return;
  try {
    // Keep state at least through the cool-down + a little headroom.
    const ttl = Math.max(cooldownSeconds + 600, 1800);
    await kv.put(OPENROUTER_BUDGET_CIRCUIT_KV_KEY, JSON.stringify(state), {
      expirationTtl: ttl,
    });
  } catch (err) {
    console.warn('openrouter budget circuit: kv write failed', (err as Error).message);
  }
}

/**
 * Pre-flight: throw IngestRetryError(delay=remaining cool-down) when open so
 * CF/Deno queues back off hourly instead of spinning.
 */
export async function assertOpenRouterBudgetCircuitAllowsCall(
  env: Env,
  nowMs = Date.now(),
): Promise<void> {
  const state = await readOpenRouterBudgetCircuit(env, nowMs);
  if (state.openUntilMs != null && state.openUntilMs > nowMs) {
    const delaySeconds = Math.max(1, Math.ceil((state.openUntilMs - nowMs) / 1000));
    throw new IngestRetryError(
      `${OPENROUTER_BUDGET_ERROR_MARKER}: cool-down ${delaySeconds}s `
      + `(last: ${(state.lastError ?? 'budget').slice(0, 160)})`,
      delaySeconds,
    );
  }
}

export async function noteOpenRouterBudgetSuccess(env: Env, nowMs = Date.now()): Promise<void> {
  const knobs = await resolveOpenRouterBudgetCircuitKnobs(env);
  await writeState(env, emptyState(nowMs), knobs.cooldownSeconds);
}

/**
 * Record a budget-class failure. Returns whether the circuit is now open and
 * the delaySeconds callers should use for queue retry.
 */
export async function noteOpenRouterBudgetFailure(
  env: Env,
  detail: string,
  nowMs = Date.now(),
): Promise<{ open: boolean; delaySeconds: number; consecutiveFailures: number }> {
  const knobs = await resolveOpenRouterBudgetCircuitKnobs(env);
  const prev = await readOpenRouterBudgetCircuit(env, nowMs);
  const transient = isTransientFilesPrepaidBudgetMessage(detail);
  // If already open, refresh cool-down from now so a mid-cool-down hit extends
  // the ban rather than allowing another burst immediately after — except
  // transient files/key-limit trips, which stay bounded and do not extend
  // forever.
  if (prev.openUntilMs != null && prev.openUntilMs > nowMs) {
    const extend = !transient || prev.openCount < MAX_TRANSIENT_CIRCUIT_OPENS;
    const openUntilMs = extend
      ? nowMs + knobs.cooldownSeconds * 1000
      : prev.openUntilMs;
    const state: OpenRouterBudgetCircuitState = {
      consecutiveFailures: prev.consecutiveFailures,
      openUntilMs,
      lastError: detail.slice(0, 300),
      updatedAtMs: nowMs,
      openCount: prev.openCount,
    };
    await writeState(env, state, knobs.cooldownSeconds);
    return {
      open: true,
      delaySeconds: Math.max(1, Math.ceil((openUntilMs - nowMs) / 1000)),
      consecutiveFailures: prev.consecutiveFailures,
    };
  }

  const consecutiveFailures = prev.consecutiveFailures + 1;
  const shouldOpen = consecutiveFailures >= knobs.tripAfter
    && (!transient || prev.openCount < MAX_TRANSIENT_CIRCUIT_OPENS);
  const openUntilMs = shouldOpen ? nowMs + knobs.cooldownSeconds * 1000 : null;
  const state: OpenRouterBudgetCircuitState = {
    consecutiveFailures,
    openUntilMs,
    lastError: detail.slice(0, 300),
    updatedAtMs: nowMs,
    openCount: shouldOpen ? prev.openCount + 1 : prev.openCount,
  };
  await writeState(env, state, knobs.cooldownSeconds);
  if (shouldOpen) {
    console.warn(
      `openrouter budget circuit OPEN after ${consecutiveFailures} failures; `
      + `cool-down ${knobs.cooldownSeconds}s`,
    );
  }
  return {
    open: shouldOpen,
    // Burst path: short delay so the queue can surface the next 1–2 attempts
    // quickly; once open, full hourly cool-down.
    delaySeconds: shouldOpen ? knobs.cooldownSeconds : 5,
    consecutiveFailures,
  };
}

/** True when an error is our circuit cool-down (queue should honor delaySeconds). */
export function isOpenRouterBudgetCircuitHalt(error: unknown): boolean {
  if (error instanceof IngestRetryError && error.message.includes(OPENROUTER_BUDGET_ERROR_MARKER)) {
    return true;
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.toLowerCase().includes(OPENROUTER_BUDGET_ERROR_MARKER);
}
