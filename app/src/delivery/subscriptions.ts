/**
 * src/delivery/subscriptions.ts
 * OWNER: delivery agent
 *
 * Subscription CRUD + matching logic. Creates/updates/cancels subscriptions and
 * decides whether a given transaction matches a subscription's filters
 * (politicians/tickers/chambers/amount range/sides/sectors/market-cap buckets).
 */

import type { Env, Subscription, SubscriptionFilters, Transaction } from '../shared/types.ts';
import { all, first, get, run } from '../shared/db.ts';
import { prefixedId } from '../shared/ids.ts';
import { findMemberCandidates, mapSubscription, pickMemberCandidate, type SubscriptionRow } from './rows.ts';
import { isDeliveryBackfill } from './deliveryFreshness.ts';
import { cleanFilerName } from '../extraction/nameNormalizer.ts';
import { getUserById } from '../auth/users.ts';
import { isPremiumUserAsync } from '../billing/entitlement.ts';

const SELECT_COLS =
  'id, client_id, delivery, target_url, secret, filters, cursor, active, created_at';

export const MAX_SUBSCRIPTIONS_PER_USER = 2;
export const MAX_ACTIVE_SUBSCRIPTIONS_PER_USER = 2;
export const MAX_SUBSCRIPTION_SECRET_LENGTH = 256;
export const MAX_WEBHOOK_TARGET_URL_LENGTH = 2048;
/** Stricter floor for an operator-supplied secret rotated in after an incident. */
export const MIN_ROTATED_SUBSCRIPTION_SECRET_LENGTH = 32;

export class SubscriptionQuotaError extends Error {}

/**
 * Entitlement re-check at delivery/connection time. Subscription creation is
 * premium-gated, but a durable subscription outlives its owner's billing
 * state (trial-and-cancel would otherwise keep webhook/SSE delivery working
 * forever). User-owned rows store clientId as `user:<id>`; the owner must
 * still satisfy the same canonical predicate the UI/REST layer uses
 * (billing/entitlement isPremiumUserAsync — Stripe OR Apple IAP — over the
 * users row + apple_subscriptions ledger). Admin operator-provisioned
 * integration ids are intentionally ungated, matching the PATCH
 * /subscriptions/:id policy.
 */
export async function subscriptionOwnerEntitled(
  env: Env,
  clientId: string | null | undefined,
): Promise<boolean> {
  if (!clientId?.startsWith('user:')) return true;
  const owner = await getUserById(env, clientId.slice('user:'.length));
  return isPremiumUserAsync(env, owner);
}

export function subscriptionSecretError(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') return 'secret must be a string';
  if (value.length < 16 || value.length > MAX_SUBSCRIPTION_SECRET_LENGTH) {
    return `secret must be 16-${MAX_SUBSCRIPTION_SECRET_LENGTH} characters`;
  }
  return null;
}

/**
 * Validate a caller-supplied secret for POST .../rotate-secret. Rotation is
 * explicitly about replacing a production-facing HMAC key after an incident
 * (e.g. CT-AUD-003), so it holds a higher bar than creation's 16-char floor:
 * at least 32 characters, and no embedded whitespace (a common copy/paste
 * artifact that would silently break signature verification).
 */
export function rotateSubscriptionSecretError(value: unknown): string | null {
  if (typeof value !== 'string') return 'secret must be a string';
  if (
    value.length < MIN_ROTATED_SUBSCRIPTION_SECRET_LENGTH ||
    value.length > MAX_SUBSCRIPTION_SECRET_LENGTH
  ) {
    return `secret must be ${MIN_ROTATED_SUBSCRIPTION_SECRET_LENGTH}-${MAX_SUBSCRIPTION_SECRET_LENGTH} characters`;
  }
  if (/\s/.test(value)) return 'secret must not contain whitespace';
  return null;
}

export function webhookTargetLengthError(value: string | null): string | null {
  return value && value.length > MAX_WEBHOOK_TARGET_URL_LENGTH
    ? `targetUrl must be at most ${MAX_WEBHOOK_TARGET_URL_LENGTH} characters`
    : null;
}

function normalizedSubscriptionQuotaError(err: unknown): SubscriptionQuotaError | null {
  if (err instanceof SubscriptionQuotaError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/subscription total quota exceeded/i.test(message)) {
    return new SubscriptionQuotaError(`subscription limit reached (${MAX_SUBSCRIPTIONS_PER_USER} total)`);
  }
  if (/subscription active quota exceeded/i.test(message)) {
    return new SubscriptionQuotaError(`active subscription limit reached (${MAX_ACTIVE_SUBSCRIPTIONS_PER_USER})`);
  }
  return null;
}

async function runSubscriptionWrite(
  env: Env,
  sql: string,
  params: Array<string | number | null>,
): Promise<void> {
  try {
    await run(env.DB, sql, params);
  } catch (err) {
    const quotaError = normalizedSubscriptionQuotaError(err);
    if (quotaError) throw quotaError;
    throw err;
  }
}

/**
 * Durable D1-backed quota preflight; migration triggers are the race-safe
 * backstop (see trg_subscriptions_total_quota in migrations/0047_subscription_quota_active_only.sql).
 *
 * `total` deliberately counts ACTIVE rows only, not every lifetime row.
 * Pause/deactivate leaves the row (so Resume works) without consuming a
 * create/active slot. Hard delete (`deleteSubscription`) removes the row
 * entirely. Counting deactivated rows here would permanently lock an account
 * out of creating new subscriptions once it accumulated lifetime pauses —
 * the "lifetime subscription lockout" bug.
 */
export async function assertSubscriptionQuota(
  env: Env,
  clientId: string,
  opts: { creating?: boolean; activating?: boolean } = {},
): Promise<void> {
  const row = await first<{ total: number; active: number }>(
    env.DB,
    `SELECT COUNT(*) AS total, COUNT(*) AS active
       FROM subscriptions WHERE client_id = ? AND active = 1`,
    [clientId],
  );
  if (opts.creating && (row?.total ?? 0) >= MAX_SUBSCRIPTIONS_PER_USER) {
    throw new SubscriptionQuotaError(`subscription limit reached (${MAX_SUBSCRIPTIONS_PER_USER} total)`);
  }
  if ((opts.creating || opts.activating) && (row?.active ?? 0) >= MAX_ACTIVE_SUBSCRIPTIONS_PER_USER) {
    throw new SubscriptionQuotaError(`active subscription limit reached (${MAX_ACTIVE_SUBSCRIPTIONS_PER_USER})`);
  }
}

export function validateSubscriptionFilters(value: unknown):
  | { ok: true; filters: SubscriptionFilters }
  | { ok: false; error: string } {
  if (value == null) return { ok: true, filters: {} };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'filters must be an object' };
  const raw = value as Record<string, unknown>;
  const allowed = new Set([
    'members', 'tickers', 'chambers', 'minAmount', 'maxAmount', 'sides', 'sectors', 'marketCapBuckets',
    'includeBackfill',
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return { ok: false, error: 'filters contain unsupported fields' };

  const strings = (key: string, limit: number, maxLength: number): string[] | string => {
    const input = raw[key];
    if (input == null) return [];
    if (!Array.isArray(input) || input.length > limit || input.some((v) => typeof v !== 'string' || !v.trim() || v.length > maxLength)) {
      return `${key} must contain at most ${limit} bounded strings`;
    }
    return [...new Set(input.map((v) => (v as string).trim()))];
  };
  const members = strings('members', 50, 64); if (typeof members === 'string') return { ok: false, error: members };
  const tickersRaw = strings('tickers', 50, 20); if (typeof tickersRaw === 'string') return { ok: false, error: tickersRaw };
  const chambers = strings('chambers', 3, 10); if (typeof chambers === 'string') return { ok: false, error: chambers };
  const sides = strings('sides', 3, 1); if (typeof sides === 'string') return { ok: false, error: sides };
  const sectors = strings('sectors', 25, 100); if (typeof sectors === 'string') return { ok: false, error: sectors };
  const buckets = strings('marketCapBuckets', 6, 10); if (typeof buckets === 'string') return { ok: false, error: buckets };
  if (chambers.some((v) => v !== 'house' && v !== 'senate' && v !== 'executive')) return { ok: false, error: 'chambers contains an invalid value' };
  // Canonical B|S|E; accept legacy P as Buy and coerce.
  if (sides.some((v) => v !== 'B' && v !== 'P' && v !== 'S' && v !== 'E')) {
    return { ok: false, error: 'sides contains an invalid value' };
  }
  const sidesNorm = [...new Set(sides.map((v) => (v === 'P' ? 'B' : v)))];
  if (buckets.some((v) => !['mega', 'large', 'mid', 'small', 'micro', 'nano'].includes(v))) return { ok: false, error: 'marketCapBuckets contains an invalid value' };
  const min = raw.minAmount; const max = raw.maxAmount;
  if (min != null && (typeof min !== 'number' || !Number.isFinite(min) || min < 0)) return { ok: false, error: 'minAmount must be a non-negative number' };
  if (max != null && (typeof max !== 'number' || !Number.isFinite(max) || max < 0)) return { ok: false, error: 'maxAmount must be a non-negative number' };
  if (typeof min === 'number' && typeof max === 'number' && min > max) return { ok: false, error: 'minAmount cannot exceed maxAmount' };
  const includeBackfill = raw.includeBackfill;
  if (includeBackfill != null && typeof includeBackfill !== 'boolean') {
    return { ok: false, error: 'includeBackfill must be a boolean' };
  }
  return { ok: true, filters: {
    ...(members.length ? { members } : {}), ...(tickersRaw.length ? { tickers: [...new Set(tickersRaw.map((v) => v.toUpperCase()))] } : {}),
    ...(chambers.length ? { chambers: chambers as SubscriptionFilters['chambers'] } : {}),
    ...(typeof min === 'number' ? { minAmount: min } : {}), ...(typeof max === 'number' ? { maxAmount: max } : {}),
    ...(sidesNorm.length ? { sides: sidesNorm as SubscriptionFilters['sides'] } : {}), ...(sectors.length ? { sectors } : {}),
    ...(buckets.length ? { marketCapBuckets: buckets } : {}),
    ...(includeBackfill === true ? { includeBackfill: true } : {}),
  } };
}

/**
 * Both arms declare `error` / `unresolvedMembers` / `filters` (optional) so callers
 * can read them in the `!ok` branch: this repo's non-strict deno config does not
 * narrow the union there (the reason older call sites cast to `any`).
 */
export type ResolvedSubscriptionFilters =
  | { ok: true; filters: SubscriptionFilters; error?: undefined; unresolvedMembers?: undefined }
  | { ok: false; error: string; unresolvedMembers?: string[]; filters?: undefined };

/** Max candidates named in an "ambiguous" error, so the message stays short. */
const MAX_AMBIGUOUS_CANDIDATES_SHOWN = 4;
const MEMBER_ID_LOOKUP_CHUNK = 100;

/** `?, ?, ?` placeholders for an IN list. */
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Run an `IN (...)` lookup in chunks that stay far below SQLite's bound-variable limit. */
async function chunkedIn<T>(
  env: Env,
  sqlFor: (placeholderList: string) => string,
  values: string[],
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < values.length; i += MEMBER_ID_LOOKUP_CHUNK) {
    const chunk = values.slice(i, i + MEMBER_ID_LOOKUP_CHUNK);
    out.push(...(await all<T>(env.DB, sqlFor(placeholders(chunk.length)), chunk)));
  }
  return out;
}

/**
 * Resolve the entries of a subscription `members` filter to the filer ids that
 * {@link matchesFilters} compares against `tx.filerId`.
 *
 * An entry is, in order: an existing `filers.bioguide_id` (case-insensitive;
 * a tombstoned alias maps to its canonical filer, like the read paths), an id
 * that only exists on transactions (a filer with no `filers` row is still a
 * member in the `/members` roster), or a member NAME.  A name must identify
 * exactly one person — exact full/display-name match first, then live filers
 * over dormant duplicates — because subscribing someone to the wrong politician
 * is worse than an error.  Anything else is reported back, not stored.
 */
export async function resolveSubscriptionMembers(
  env: Env,
  entries: string[],
): Promise<{ ids: string[]; unresolved: string[]; ambiguous: Array<{ input: string; candidates: string[] }> }> {
  const resolved = new Map<string, string>();

  // 1. Existing filer ids (exact, then upper-cased: bioguide ids are upper case).
  const idCandidates = [...new Set(entries.flatMap((entry) => [entry, entry.toUpperCase()]))];
  const idRows = await chunkedIn<{ bioguide_id: string; merged_into: string | null }>(
    env,
    (ph) => `SELECT bioguide_id, merged_into FROM filers WHERE bioguide_id IN (${ph})`,
    idCandidates,
  );
  const canonicalById = new Map(idRows.map((row) => [row.bioguide_id, row.merged_into || row.bioguide_id]));
  for (const entry of entries) {
    const hit = canonicalById.get(entry) ?? canonicalById.get(entry.toUpperCase());
    if (hit) resolved.set(entry, hit);
  }

  // 2. Ids that only exist on transactions (no filers row).
  const afterIds = entries.filter((entry) => !resolved.has(entry));
  if (afterIds.length > 0) {
    const txRows = await chunkedIn<{ filer_id: string }>(
      env,
      (ph) => `SELECT DISTINCT filer_id FROM transactions WHERE filer_id IN (${ph})`,
      afterIds,
    );
    const txIds = new Set(txRows.map((row) => row.filer_id));
    for (const entry of afterIds) if (txIds.has(entry)) resolved.set(entry, entry);
  }

  // 3. Names.
  const unresolved: string[] = [];
  const ambiguous: Array<{ input: string; candidates: string[] }> = [];
  for (const entry of entries) {
    if (resolved.has(entry)) continue;
    const pick = pickMemberCandidate(await findMemberCandidates(env, entry));
    if (pick.kind === 'match') resolved.set(entry, pick.filerId);
    else if (pick.kind === 'none') unresolved.push(entry);
    else {
      ambiguous.push({
        input: entry,
        candidates: pick.candidates
          .slice(0, MAX_AMBIGUOUS_CANDIDATES_SHOWN)
          .map((cand) => `${cand.name ?? cand.filerId} (${cand.filerId})`),
      });
    }
  }

  return {
    ids: [...new Set(entries.map((entry) => resolved.get(entry)).filter((id): id is string => !!id))],
    unresolved,
    ambiguous,
  };
}

/**
 * {@link validateSubscriptionFilters} plus member resolution.  EVERY create and
 * update path must call this one (a test scans for direct callers of the sync
 * validator): `members` is stored as resolved filer ids, and names that cannot be
 * resolved to exactly one member are rejected so the caller can answer 400
 * instead of saving a subscription that silently delivers nothing.
 */
export async function validateAndResolveSubscriptionFilters(
  env: Env,
  value: unknown,
): Promise<ResolvedSubscriptionFilters> {
  const base = validateSubscriptionFilters(value);
  if (!base.ok) return { ok: false, error: (base as { error: string }).error };
  const members = base.filters.members;
  if (!members || members.length === 0) return { ok: true, filters: base.filters };

  const { ids, unresolved, ambiguous } = await resolveSubscriptionMembers(env, members);
  if (unresolved.length > 0 || ambiguous.length > 0) {
    const messages: string[] = [];
    if (unresolved.length > 0) {
      messages.push(
        `members not recognized: ${unresolved.map((name) => `"${name}"`).join(', ')}.  ` +
          "Use a member's full name or filer id (see GET /api/members).",
      );
    }
    for (const item of ambiguous) {
      messages.push(
        `"${item.input}" is ambiguous: ${item.candidates.join(', ')}.  Use the full name or the filer id.`,
      );
    }
    return {
      ok: false,
      error: messages.join('  '),
      unresolvedMembers: [...unresolved, ...ambiguous.map((item) => item.input)],
    };
  }
  return { ok: true, filters: { ...base.filters, members: ids } };
}

/** Owner-facing view of a subscription's `members` filter (see {@link describeSubscriptionMembers}). */
export interface SubscriptionMemberInfo {
  /** filer id -> display name, for the ids we can name. */
  memberLabels: Record<string, string>;
  /** Stored entries that are not a known filer id, e.g. free-text names saved before names were resolved. */
  unresolvedMembers: string[];
}

/**
 * Names for the filer ids stored in subscriptions' `members` filters, and the
 * entries that can never match.  Subscriptions created before names were
 * resolved (board a6058af2) may hold raw text like "Nancy Pelosi": nothing is
 * rewritten here, but the owner's list flags those entries so they can Edit and
 * Save (which resolves or rejects them).  Subscriptions without a members
 * filter are omitted from the result.
 */
export async function describeSubscriptionMembers(
  env: Env,
  subs: Subscription[],
): Promise<Map<string, SubscriptionMemberInfo>> {
  const out = new Map<string, SubscriptionMemberInfo>();
  const allIds = [...new Set(subs.flatMap((sub) => sub.filters?.members ?? []))];
  if (allIds.length === 0) return out;

  const labelRows = await chunkedIn<{ id: string; name: string | null }>(
    env,
    (ph) => `SELECT f.bioguide_id AS id,
                    COALESCE(cf.display_name, cf.full_name, f.display_name, f.full_name) AS name
               FROM filers f
               LEFT JOIN filers cf ON cf.bioguide_id = f.merged_into
              WHERE f.bioguide_id IN (${ph})`,
    allIds,
  );
  const known = new Set(labelRows.map((row) => row.id));
  const labels = new Map<string, string>();
  for (const row of labelRows) {
    if (row.name) labels.set(row.id, cleanFilerName(row.name) || row.name);
  }

  // Ids that exist only on transactions are valid members without a name.
  const unlabeled = allIds.filter((id) => !known.has(id));
  if (unlabeled.length > 0) {
    const txRows = await chunkedIn<{ filer_id: string }>(
      env,
      (ph) => `SELECT DISTINCT filer_id FROM transactions WHERE filer_id IN (${ph})`,
      unlabeled,
    );
    for (const row of txRows) known.add(row.filer_id);
  }

  for (const sub of subs) {
    const members = sub.filters?.members ?? [];
    if (members.length === 0) continue;
    const memberLabels: Record<string, string> = {};
    const unresolvedMembers: string[] = [];
    for (const id of members) {
      const label = labels.get(id);
      if (label) memberLabels[id] = label;
      if (!known.has(id)) unresolvedMembers.push(id);
    }
    out.set(sub.id, { memberLabels, unresolvedMembers });
  }
  return out;
}

/**
 * Generate a webhook signing secret (256 bits of entropy, hex). Uses WebCrypto
 * so it is Workers-compatible.
 */
export function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `whsec_${hex}`;
}

/**
 * Create a new subscription. Generates the id and a per-subscription secret
 * unless the caller supplies one. Webhooks use it for HMAC signing; SSE and
 * management routes use it as the bearer credential. Defaults `active` to true,
 * `cursor` to 0, and stamps createdAt.
 */
export async function createSubscription(
  env: Env,
  input: Omit<Subscription, 'id' | 'cursor' | 'active' | 'createdAt'> &
    Partial<Pick<Subscription, 'id' | 'cursor' | 'active'>>,
): Promise<Subscription> {
  const suppliedSecretError = input.secret == null ? null : subscriptionSecretError(input.secret);
  if (suppliedSecretError) throw new Error(suppliedSecretError);
  const targetLengthError = webhookTargetLengthError(input.targetUrl ?? null);
  if (targetLengthError) throw new Error(targetLengthError);
  const id = input.id ?? prefixedId('sub');
  const createdAt = new Date().toISOString();
  const cursor = input.cursor ?? 0;
  const active = input.active ?? true;
  const secret = input.secret ?? generateSecret();

  const sub: Subscription = {
    id,
    clientId: input.clientId,
    delivery: input.delivery,
    targetUrl: input.targetUrl ?? null,
    secret,
    filters: input.filters ?? {},
    cursor,
    active,
    createdAt,
  };

  try {
    await runSubscriptionWrite(
      env,
      `INSERT INTO subscriptions (${SELECT_COLS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sub.id,
        sub.clientId,
        sub.delivery,
        sub.targetUrl,
        sub.secret,
        JSON.stringify(sub.filters),
        sub.cursor,
        sub.active ? 1 : 0,
        sub.createdAt,
      ],
    );
  } catch (err) {
    if (!input.id || !/UNIQUE constraint failed:\s*subscriptions\.id/i.test(err instanceof Error ? err.message : String(err))) {
      throw err;
    }
    const existing = await getSubscription(env, input.id);
    if (existing?.clientId === input.clientId) return existing;
    throw err;
  }

  return sub;
}

/** Fetch a subscription by id, or null if absent. */
export async function getSubscription(env: Env, id: string): Promise<Subscription | null> {
  const row = await get<SubscriptionRow>(
    env.DB,
    `SELECT ${SELECT_COLS} FROM subscriptions WHERE id = ?`,
    [id],
  );
  return row ? mapSubscription(row) : null;
}

/** List subscriptions (optionally only active ones), newest first. */
export async function listSubscriptions(env: Env, activeOnly = false): Promise<Subscription[]> {
  const sql = activeOnly
    ? `SELECT ${SELECT_COLS} FROM subscriptions WHERE active = 1 ORDER BY created_at DESC`
    : `SELECT ${SELECT_COLS} FROM subscriptions ORDER BY created_at DESC`;
  const rows = await all<SubscriptionRow>(env.DB, sql);
  return rows.map(mapSubscription);
}

/**
 * Update mutable fields of a subscription (filters, target_url, secret, active,
 * cursor). Only provided keys are written. Returns the updated subscription.
 */
export async function updateSubscription(
  env: Env,
  id: string,
  patch: Partial<Pick<Subscription, 'filters' | 'targetUrl' | 'secret' | 'active' | 'cursor'>>,
): Promise<Subscription> {
  const suppliedSecretError = patch.secret == null ? null : subscriptionSecretError(patch.secret);
  if (suppliedSecretError) throw new Error(suppliedSecretError);
  const targetLengthError = patch.targetUrl === undefined
    ? null
    : webhookTargetLengthError(patch.targetUrl);
  if (targetLengthError) throw new Error(targetLengthError);
  const sets: string[] = [];
  const params: Array<string | number | null> = [];

  if (patch.filters !== undefined) {
    sets.push('filters = ?');
    params.push(JSON.stringify(patch.filters));
  }
  if (patch.targetUrl !== undefined) {
    sets.push('target_url = ?');
    params.push(patch.targetUrl);
  }
  if (patch.secret !== undefined) {
    sets.push('secret = ?');
    params.push(patch.secret);
  }
  if (patch.active !== undefined) {
    sets.push('active = ?');
    params.push(patch.active ? 1 : 0);
  }
  if (patch.cursor !== undefined) {
    sets.push('cursor = ?');
    params.push(patch.cursor);
  }

  if (sets.length > 0) {
    params.push(id);
    await runSubscriptionWrite(
      env,
      `UPDATE subscriptions SET ${sets.join(', ')} WHERE id = ?`,
      params,
    );
  }

  const updated = await getSubscription(env, id);
  if (!updated) throw new Error(`subscription not found: ${id}`);
  return updated;
}

export interface RotateSubscriptionSecretResult {
  subscription: Subscription;
  /** True when the secret was server-generated (only then is it safe to echo). */
  generated: boolean;
}

/**
 * Rotate a subscription's signing secret with zero secret exposure on the
 * caller-supplied path. If `secret` is omitted, generates a fresh one (same
 * entropy as creation) and returns it once for display; a caller-supplied
 * secret is validated (see {@link rotateSubscriptionSecretError}) but never
 * echoed back or logged.
 */
export async function rotateSubscriptionSecret(
  env: Env,
  id: string,
  secret?: string,
): Promise<RotateSubscriptionSecretResult> {
  const generated = secret === undefined;
  if (!generated) {
    const err = rotateSubscriptionSecretError(secret);
    if (err) throw new Error(err);
  }
  const nextSecret = generated ? generateSecret() : (secret as string);
  const subscription = await updateSubscription(env, id, { secret: nextSecret });
  return { subscription, generated };
}

/**
 * Deactivate a subscription: excludes it from delivery fanout (webhook/SSE
 * dispatch already filter on `active = 1`) and frees its slot against the
 * creation quota (see {@link assertSubscriptionQuota}). Idempotent — safe to
 * call on an already-inactive subscription.
 */
export async function deactivateSubscription(env: Env, id: string): Promise<Subscription> {
  return updateSubscription(env, id, { active: false });
}

/**
 * Permanently remove a subscription row. Distinct from {@link deactivateSubscription}
 * (pause): delete frees the row entirely so it no longer appears in the owner's
 * list. Delivery history rows (`deliveries.subscription_id`) are left in place
 * for audit (no FK); SSE leases for the id are cleaned best-effort.
 */
export async function deleteSubscription(env: Env, id: string): Promise<boolean> {
  const existing = await getSubscription(env, id);
  if (!existing) return false;
  await runSubscriptionWrite(env, 'DELETE FROM subscriptions WHERE id = ?', [id]);
  try {
    await run(env.DB, 'DELETE FROM sse_leases WHERE subscription_id = ?', [id]);
  } catch {
    // sse_leases may be absent in older local DBs / lightweight test envs
  }
  return true;
}

/**
 * Pure predicate: does a transaction match a subscription's filters?
 *
 * Semantics (all clauses are AND-ed; an empty/undefined clause matches all):
 *   - members[]:  filer bioguide id must be in the set (matched by tx.filerId).
 *                 The set holds ids only: create/update resolve member names via
 *                 {@link validateAndResolveSubscriptionFilters}, so a raw name here
 *                 (a row saved before that existed) can never match.
 *   - tickers[]:  tx.ticker must be in the set (case-insensitive).
 *   - chambers[]: NOTE — Transaction carries no chamber column; chamber filtering
 *                 is applied at the query layer (REST join on filings). This
 *                 predicate therefore treats `chambers` as advisory and only
   *                 enforces members/tickers/minAmount. Webhook dispatch resolves
 *                 chamber separately (see webhook.ts).
 *   - minAmount:  tx.amountMin must be >= filter.minAmount.
 *   - backfill:   dropped unless includeBackfill; freshness is judged as of
 *                 `freshnessAtMs` (default now).
 */
export function matchesFilters(
  tx: Transaction,
  filters: SubscriptionFilters,
  freshnessAtMs?: number,
): boolean {
  if (!filters) return true;

  if (filters.members && filters.members.length > 0) {
    if (!tx.filerId || !filters.members.includes(tx.filerId)) return false;
  }

  if (filters.tickers && filters.tickers.length > 0) {
    const want = filters.tickers.map((t) => t.toUpperCase());
    if (!tx.ticker || !want.includes(tx.ticker.toUpperCase())) return false;
  }

  if (filters.minAmount !== undefined && filters.minAmount !== null) {
    const amt = tx.amountMin ?? 0;
    if (amt < filters.minAmount) return false;
  }

  if (filters.maxAmount !== undefined && filters.maxAmount !== null) {
    const amt = tx.amountMin ?? 0;
    if (amt > filters.maxAmount) return false;
  }

  if (filters.sides && filters.sides.length > 0) {
    const side = String(tx.txType) === 'P' ? 'B' : tx.txType;
    if (!side || !filters.sides.includes(side)) return false;
  }

  if (filters.includeBackfill !== true && isDeliveryBackfill(tx, freshnessAtMs)) return false;

  return true;
}

/** Resolved per-transaction context the predicate can't read off the row itself. */
export interface DeliveryContext {
  /** Owning filing's chamber ('house' | 'senate'). */
  chamber?: string | null;
  /** securities_ref.sector for the tx ticker. */
  sector?: string | null;
  /** securities_ref.market_cap_bucket for the tx ticker. */
  marketCapBucket?: string | null;
  /**
   * Instant to judge delivery freshness at (default now).  Targeted webhook
   * retries pass deliveryFreshnessJudgedAtMs so a parked delivery does not
   * age into backfill while its target circuit is open.
   */
  freshnessAtMs?: number;
}

/**
 * Filter variant that enforces the clauses needing resolved context the caller
 * supplies (chamber from the owning filing; sector + market-cap bucket from
 * securities_ref). A filtered field with no resolved value never matches, so a
 * subscription that asks for e.g. mega-caps won't receive un-enriched tickers.
 */
export function matchesFiltersWithContext(
  tx: Transaction,
  filters: SubscriptionFilters,
  ctx: DeliveryContext,
): boolean {
  if (!matchesFilters(tx, filters, ctx.freshnessAtMs)) return false;
  if (filters.chambers && filters.chambers.length > 0) {
    if (!ctx.chamber || !filters.chambers.includes(ctx.chamber as never)) return false;
  }
  if (filters.sectors && filters.sectors.length > 0) {
    if (!ctx.sector || !filters.sectors.includes(ctx.sector)) return false;
  }
  if (filters.marketCapBuckets && filters.marketCapBuckets.length > 0) {
    if (!ctx.marketCapBucket || !filters.marketCapBuckets.includes(ctx.marketCapBucket)) return false;
  }
  return true;
}

/**
 * Back-compat wrapper: enforce chambers[] only (sector/cap unresolved). Prefer
 * {@link matchesFiltersWithContext} where securities_ref is available.
 */
export function matchesFiltersWithChamber(
  tx: Transaction,
  filters: SubscriptionFilters,
  chamber: string | null,
): boolean {
  return matchesFiltersWithContext(tx, filters, { chamber });
}
