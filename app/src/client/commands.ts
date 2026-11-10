import type { Env, User, ClientCommandType, Subscription } from '../shared/types.ts';
import { isPremiumUserAsync, resolveEntitlementAsync } from '../billing/entitlement.ts';
import {
  assertSubscriptionQuota,
  createSubscription,
  deleteSubscription,
  SubscriptionQuotaError,
  updateSubscription,
  webhookTargetLengthError,
} from '../delivery/subscriptions.ts';
import { localWebhookTargetsAllowed, validatePublicWebhookTarget } from '../delivery/webhookTarget.ts';
import { rateLimit } from '../shared/rateLimit.ts';
import { getCommand, updateCommandStatus, upsertPreferences } from './state.ts';
import { parsePushSettings, serializePushSettings } from '../shared/pushSettings.ts';
import { getUserById } from '../auth/users.ts';
import {
  asDelivery,
  ClientInputError,
  normalizeFilters,
  publicSubscription,
  arrayOfStrings,
  clientIdForUser,
} from './utils.ts';
import { getOwnedSubscription } from './queries.ts';
import {
  asPushPlatform,
  deactivatePushDevice,
  publicPushDevice,
  upsertPushDevice,
} from './pushDevices.ts';
import { AppleRedeemError, jwsFromInput, requireAppleIapEnabled, verifyAppleRedemption } from '../billing/appleRedeem.ts';
import { clientRedeemWouldResurrectRevoked, getAppleSubscription, upsertAppleSubscription } from '../billing/appleSubscriptions.ts';
import { notifyPremiumActivation } from '../billing/premiumActivationAlert.ts';
import { deleteUserAccount } from '../auth/deleteAccount.ts';

export function commandType(value: unknown): ClientCommandType {
  const type = String(value || '');
  if (
    type === 'update_preferences' ||
    type === 'create_subscription' ||
    type === 'update_subscription' ||
    type === 'delete_subscription' ||
    type === 'register_device' ||
    type === 'unregister_device' ||
    type === 'start_checkout' ||
    type === 'request_export' ||
    type === 'redeem_apple_purchase' ||
    type === 'link_apple_entitlement' ||
    type === 'delete_account'
  ) {
    return type;
  }
  throw new ClientInputError('unsupported command type');
}

export function normalizePreferencePatch(input: Record<string, unknown>) {
  const patch: Parameters<typeof upsertPreferences>[2] = {};
  if (input.savedFilters !== undefined) {
    if (typeof input.savedFilters !== 'object' || Array.isArray(input.savedFilters) || input.savedFilters === null) {
      throw new ClientInputError('savedFilters must be an object');
    }
    patch.savedFilters = input.savedFilters as Record<string, unknown>;
  }
  if (input.watchlist !== undefined) patch.watchlist = arrayOfStrings(input.watchlist, { upper: true }) ?? [];
  if (input.notificationSettings !== undefined) {
    if (
      typeof input.notificationSettings !== 'object' ||
      Array.isArray(input.notificationSettings) ||
      input.notificationSettings === null
    ) {
      throw new ClientInputError('notificationSettings must be an object');
    }
    patch.notificationSettings = serializePushSettings(
      parsePushSettings(input.notificationSettings),
    );
  }
  if (input.defaultWindow !== undefined) {
    patch.defaultWindow = input.defaultWindow == null ? null : String(input.defaultWindow);
  }
  return patch;
}

export function persistedCommandResult(type: ClientCommandType, result: unknown): unknown {
  if (type !== 'create_subscription' || !result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }
  const root = result as { subscription?: unknown };
  if (!root.subscription || typeof root.subscription !== 'object' || Array.isArray(root.subscription)) {
    return result;
  }
  return {
    ...root,
    subscription: publicSubscription(root.subscription as Subscription),
  };
}

/** Split an executed command result into the row-safe half and the one-time credential half. */
export function splitCommandResult(
  type: ClientCommandType,
  result: unknown,
): { persisted: unknown; secret: unknown | null } {
  const persisted = persistedCommandResult(type, result);
  if (persisted === result) return { persisted, secret: null };
  const sub = ((result as { subscription?: Record<string, unknown> }).subscription ?? {});
  if (sub.secret === undefined && sub.streamUrl === undefined) return { persisted, secret: null };
  const secret: Record<string, unknown> = {};
  if (sub.secret !== undefined) secret.secret = sub.secret;
  if (sub.streamUrl !== undefined) secret.streamUrl = sub.streamUrl;
  return { persisted, secret: { subscription: secret } };
}

/** Merge a claimed one-time credential back into the redacted result for the single disclosing response. */
export function mergeClaimedSecret(result: unknown, claimed: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (!claimed || typeof claimed !== 'object' || Array.isArray(claimed)) return result;
  const sub = (result as { subscription?: unknown }).subscription;
  const claimedSub = (claimed as { subscription?: Record<string, unknown> }).subscription;
  if (!sub || typeof sub !== 'object' || Array.isArray(sub) || !claimedSub) return result;
  return { ...(result as Record<string, unknown>), subscription: { ...(sub as Record<string, unknown>), ...claimedSub } };
}

function subscriptionIdForCommand(commandId: string | undefined): string | undefined {
  return commandId?.startsWith('cmd_') ? `sub_${commandId.slice(4)}` : undefined;
}

/**
 * Shared body of `redeem_apple_purchase` and `link_apple_entitlement` — both
 * verify the same JWS the same way and attach the transaction to `user.id`.
 * The only difference between the two commands is client-side: iOS calls
 * `redeem_apple_purchase` from an explicit user action (Subscribe, Restore
 * Purchases) and surfaces its errors; it calls `link_apple_entitlement`
 * silently right after sign-in to claim a purchase this device already made
 * anonymously, and swallows a 409 there (see `PremiumSheet` /
 * `Store/AppleIAP.swift` `linkAppleEntitlementIfNeeded`). Reusing one server
 * code path keeps that distinction purely presentational, never a second
 * place the verify-and-ledger logic could drift.
 */
async function redeemAppleTransactionForUser(
  env: Env,
  user: User,
  input: Record<string, unknown>,
): Promise<unknown> {
  await requireAppleIapEnabled(env);
  const jws = jwsFromInput(input);
  let verified;
  try {
    verified = await verifyAppleRedemption(env, jws);
  } catch (err) {
    if (err instanceof AppleRedeemError) throw new ClientInputError(err.message, err.status);
    throw err;
  }
  const { transaction, plan, originalTransactionId } = verified;

  const existing = await getAppleSubscription(env, originalTransactionId);
  if (
    clientRedeemWouldResurrectRevoked(existing, {
      transactionId: transaction.transactionId,
      purchaseDateMs: transaction.purchaseDate != null ? Number(transaction.purchaseDate) : null,
    })
  ) {
    throw new ClientInputError('this Apple subscription was refunded or revoked', 400);
  }

  const upserted = await upsertAppleSubscription(env, {
    originalTransactionId,
    userId: user.id,
    productId: transaction.productId ?? '',
    plan,
    status: 'active',
    environment: transaction.environment ?? null,
    latestTransactionId: transaction.transactionId ?? null,
    purchaseDate: transaction.purchaseDate != null ? new Date(Number(transaction.purchaseDate)).toISOString() : null,
    expiresDate: transaction.expiresDate != null ? new Date(Number(transaction.expiresDate)).toISOString() : null,
  });
  if (!upserted.ok) {
    // Never silently reassign a subscription's Premium grant to a new
    // account — restore-purchases (or claiming an anonymous device purchase)
    // on a shared/second Apple ID or account must surface as a conflict, not
    // a takeover of the original owner's Premium.
    throw new ClientInputError('this Apple subscription is already linked to a different account', 409);
  }
  if (upserted.isNew) {
    // Fires once per originalTransactionId (isNew is only true the first
    // time this ledger row is created — see appleSubscriptions.ts).  A
    // restore-purchases replay of the SAME transaction id (tested above:
    // "redeeming the same originalTransactionId again ... is idempotent")
    // hits the ON CONFLICT branch instead and does not re-notify.
    // Apple's JWS payload carries no trial/introductory-offer flag this
    // codebase decodes, so Apple activations are always reported as "paid" —
    // a known gap vs. Stripe, where `trialing` is exact.
    await notifyPremiumActivation(env, {
      activationKey: `apple:${upserted.record.originalTransactionId}`,
      userId: user.id,
      userEmail: user.email,
      source: 'apple',
      plan: upserted.record.plan,
      trialing: false,
    });
  }

  const refreshedUser = await getUserById(env, user.id);
  const entitlement = await resolveEntitlementAsync(env, refreshedUser);
  return {
    entitlement,
    plan: upserted.record.plan,
    expiresAt: upserted.record.expiresDate,
    originalTransactionId: upserted.record.originalTransactionId,
  };
}

export async function executeCommand(
  env: Env,
  user: User,
  type: ClientCommandType,
  payload: unknown,
  opts: { commandId?: string } = {},
): Promise<unknown> {
  const input = (payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}) as Record<string, unknown>;
  if (type === 'update_preferences') {
    return { preferences: await upsertPreferences(env, user.id, normalizePreferencePatch(input)) };
  }
  if (type === 'create_subscription') {
    // Legacy iOS builds registered APNs via create_subscription + delivery:'apns'.
    // That is not a webhook/SSE channel — rewrite to the device-registration path
    // so production tokens stop failing with "delivery must be 'sse' or 'webhook'".
    if (input.delivery === 'apns' || input.delivery === 'ios' || input.delivery === 'push') {
      return executeCommand(env, user, 'register_device', {
        platform: 'apns',
        token: input.targetUrl ?? input.token ?? input.deviceToken,
        appBundle: input.appBundle,
        env: input.env,
      }, opts);
    }
    if (!(await isPremiumUserAsync(env, user))) {
      throw new ClientInputError('Creating a subscription requires a Premium account', 402);
    }
    const delivery = asDelivery(input.delivery);
    const targetUrl = typeof input.targetUrl === 'string' ? input.targetUrl.trim() : null;
    const targetLengthError = webhookTargetLengthError(targetUrl);
    if (targetLengthError) throw new ClientInputError(targetLengthError);
    if (delivery === 'webhook') {
      const targetError = await validatePublicWebhookTarget(targetUrl, {
        allowLocalhost: localWebhookTargetsAllowed(env),
      });
      if (targetError) throw new ClientInputError(targetError);
    }
    const clientId = clientIdForUser(user);
    const limited = await rateLimit(env, 'sub-create-user', clientId, 10, 3600);
    if (!limited.ok) throw new ClientInputError('too many subscription requests', 429);
    try {
      await assertSubscriptionQuota(env, clientId, { creating: true });
      const sub = await createSubscription(env, {
        id: subscriptionIdForCommand(opts.commandId),
        clientId,
        delivery,
        targetUrl: delivery === 'webhook' ? targetUrl : null,
        secret: null,
        filters: await normalizeFilters(env, input.filters),
      });
      return { subscription: publicSubscription(sub, true) };
    } catch (err) {
      if (err instanceof SubscriptionQuotaError) throw new ClientInputError(err.message, 409);
      throw err;
    }
  }
  if (type === 'update_subscription') {
    const id = typeof input.id === 'string' ? input.id : '';
    if (!id) throw new ClientInputError('id is required');
    const existing = await getOwnedSubscription(env, user, id);
    const patch: Partial<Pick<Subscription, 'filters' | 'targetUrl' | 'active'>> = {};
    if (input.filters !== undefined) patch.filters = await normalizeFilters(env, input.filters);
    if (input.active !== undefined) {
      patch.active = input.active === true;
      if (patch.active && !existing.active) {
        if (!(await isPremiumUserAsync(env, user))) {
          throw new ClientInputError('Activating a subscription requires a Premium account', 402);
        }
        try {
          await assertSubscriptionQuota(env, existing.clientId, { activating: true });
        } catch (err) {
          if (err instanceof SubscriptionQuotaError) throw new ClientInputError(err.message, 409);
          throw err;
        }
      }
    }
    if (input.targetUrl !== undefined) {
      const targetUrl = typeof input.targetUrl === 'string' ? input.targetUrl.trim() : null;
      const targetLengthError = webhookTargetLengthError(targetUrl);
      if (targetLengthError) throw new ClientInputError(targetLengthError);
      if (existing.delivery === 'webhook') {
        const targetError = await validatePublicWebhookTarget(targetUrl, {
          allowLocalhost: localWebhookTargetsAllowed(env),
        });
        if (targetError) throw new ClientInputError(targetError);
      }
      patch.targetUrl = targetUrl;
    }
    try {
      const updated = await updateSubscription(env, id, patch);
      return { subscription: publicSubscription(updated) };
    } catch (err) {
      if (err instanceof SubscriptionQuotaError) throw new ClientInputError(err.message, 409);
      throw err;
    }
  }
  if (type === 'delete_subscription') {
    const id = typeof input.id === 'string' ? input.id : '';
    if (!id) throw new ClientInputError('id is required');
    // Ownership check (404 if missing / not owned). Delete is allowed for
    // signed-in owners even without Premium so cancelled accounts can clean up.
    await getOwnedSubscription(env, user, id);
    const deleted = await deleteSubscription(env, id);
    if (!deleted) throw new ClientInputError('subscription not found', 404);
    return { deleted: true, id };
  }
  if (type === 'register_device') {
    // Device registration is signed-in only (not Premium-gated). Actual trade
    // push fan-out still requires Premium + APNs credentials when that path
    // ships — storing the token early means upgrade → push without re-prompt.
    let platform;
    try {
      platform = asPushPlatform(input.platform ?? input.delivery ?? 'apns');
    } catch (err) {
      throw new ClientInputError(err instanceof Error ? err.message : String(err));
    }
    const tokenRaw =
      (typeof input.token === 'string' && input.token) ||
      (typeof input.targetUrl === 'string' && input.targetUrl) ||
      (typeof input.deviceToken === 'string' && input.deviceToken) ||
      '';
    const limited = await rateLimit(env, 'device-register-user', user.id, 30, 3600);
    if (!limited.ok) throw new ClientInputError('too many device registration requests', 429);
    try {
      const device = await upsertPushDevice(env, {
        userId: user.id,
        platform,
        token: tokenRaw,
        appBundle: typeof input.appBundle === 'string' ? input.appBundle : null,
        env: typeof input.env === 'string' ? input.env : null,
      });
      return { device: publicPushDevice(device) };
    } catch (err) {
      throw new ClientInputError(err instanceof Error ? err.message : String(err));
    }
  }
  if (type === 'unregister_device') {
    const limited = await rateLimit(env, 'device-unregister-user', user.id, 30, 3600);
    if (!limited.ok) throw new ClientInputError('too many device unregister requests', 429);
    let platform;
    try {
      platform = input.platform !== undefined || input.delivery !== undefined
        ? asPushPlatform(input.platform ?? input.delivery)
        : undefined;
    } catch (err) {
      throw new ClientInputError(err instanceof Error ? err.message : String(err));
    }
    const token =
      (typeof input.token === 'string' && input.token) ||
      (typeof input.targetUrl === 'string' && input.targetUrl) ||
      (typeof input.deviceToken === 'string' && input.deviceToken) ||
      undefined;
    const id = typeof input.id === 'string' ? input.id : undefined;
    if (!id && !token) throw new ClientInputError('id or token is required');
    try {
      const deactivated = await deactivatePushDevice(env, {
        userId: user.id,
        id,
        token,
        platform,
      });
      if (!deactivated) throw new ClientInputError('device not found', 404);
      return { deactivated: true, id: id ?? null };
    } catch (err) {
      if (err instanceof ClientInputError) throw err;
      throw new ClientInputError(err instanceof Error ? err.message : String(err));
    }
  }
  if (type === 'redeem_apple_purchase' || type === 'link_apple_entitlement') {
    return redeemAppleTransactionForUser(env, user, input);
  }
  if (type === 'delete_account') {
    return deleteUserAccount(env, user, { keepCommandId: opts.commandId });
  }
  throw new ClientInputError(`${type} is not implemented yet`, 501);
}

/**
 * How long POST /api/client/v1/commands will hold a request open trying to
 * finish the command inline before handing it back to the durable queue and
 * answering 202. Must stay comfortably under the iOS client's 20s per-request
 * timeout (`APIClient.makeRequest`) — a budget that outlives the socket buys
 * nothing and costs the caller a transport error instead of a status.
 */
export const INLINE_COMMAND_BUDGET_MS = 9_000;

/**
 * Queue-worker entrypoint for `command.execute` messages. Also the inline
 * fast path: POST /api/client/v1/commands enqueues the durable backstop, then
 * calls this directly so a human waiting on a screen gets a terminal status in
 * one round trip instead of waiting out the background tick.
 * Idempotent on redelivery: terminal rows are left untouched. Deterministic
 * input/entitlement failures are recorded as `failed` and acknowledged;
 * unexpected errors are rethrown so the queue retry/backoff applies.
 */
export async function executeQueuedCommand(
  env: Env,
  commandId: string,
  userId: string,
): Promise<void> {
  const command = await getCommand(env, userId, commandId);
  if (!command) return;
  if (command.status !== 'queued' && command.status !== 'running') return;
  const user = await getUserById(env, userId);
  if (!user) {
    await updateCommandStatus(env, userId, commandId, 'failed', {
      error: 'command owner not found',
    });
    return;
  }
  await updateCommandStatus(env, userId, commandId, 'running');
  try {
    const result = await executeCommand(env, user, command.type, command.payload, { commandId });
    // The secret half never enters client_commands.result: GET /commands,
    // GET /commands/:id and idempotency replay all return `result` verbatim,
    // so a credential stored there is permanently replayable. It goes to
    // result_secret, which the first owner-authenticated GET /commands/:id
    // claims and destroys (claimCommandResultSecret).
    const { persisted, secret } = splitCommandResult(command.type, result);
    await updateCommandStatus(env, userId, commandId, 'succeeded', { result: persisted, resultSecret: secret });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateCommandStatus(env, userId, commandId, 'failed', { error: message });
    if (!(err instanceof ClientInputError)) throw err;
  }
}
