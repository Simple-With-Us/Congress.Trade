/**
 * Account deletion for Guideline 5.1.1(v) and Privacy §6.
 *
 * Shared by `delete_account` (client command) and `POST /auth/account/delete`.
 * Deletes or detaches user-owned rows, best-effort cancels Stripe (no refunds),
 * revokes indexed sessions, and removes the `users` row so leftover session
 * tokens resolve to null.
 */

import type { Env, User } from '../shared/types.ts';
import { all, run } from '../shared/db.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { deleteSubscription } from '../delivery/subscriptions.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import { destroySessionsForUser } from './session.ts';

function clientIdForUser(user: User): string {
  return `user:${user.id}`;
}

export interface DeleteAccountResult {
  deleted: true;
  userId: string;
  detached: {
    subscriptions: number;
    pushDevices: number;
    preferences: boolean;
    appleSubscriptions: number;
    commands: number;
    stripe: 'canceled' | 'skipped' | 'failed';
    sessions: number;
  };
}

async function ignoreMissingTable<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(message)) return fallback;
    throw err;
  }
}

async function deletedCount(work: () => Promise<{ meta?: { changes?: number } } | undefined>): Promise<number> {
  return ignoreMissingTable(async () => {
    const res = await work();
    return res?.meta?.changes ?? 0;
  }, 0);
}

/** Cancel a Stripe subscription immediately without issuing a refund. */
export async function cancelStripeSubscriptionIfAny(
  env: Env,
  subscriptionId: string | null | undefined,
): Promise<'canceled' | 'skipped' | 'failed'> {
  const id = subscriptionId?.trim();
  if (!id) return 'skipped';
  const fromEnv = typeof env.STRIPE_SECRET_KEY === 'string' ? env.STRIPE_SECRET_KEY.trim() : '';
  const secretKey = fromEnv || (await resolveSecret(env, 'STRIPE_SECRET_KEY')).value?.trim();
  if (!secretKey) return 'skipped';
  try {
    const res = await trackedFetch(
      `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${secretKey}`,
          'Stripe-Version': '2025-03-31.basil',
        },
      },
      { service: 'billing', operation: 'stripe-subscription-cancel' },
    );
    if (res.ok || res.status === 404) return 'canceled';
    return 'failed';
  } catch {
    return 'failed';
  }
}

export async function deleteUserAccount(
  env: Env,
  user: User,
  opts: { keepCommandId?: string } = {},
): Promise<DeleteAccountResult> {
  const clientId = clientIdForUser(user);
  const stripe = await cancelStripeSubscriptionIfAny(env, user.stripeSubscriptionId);

  const subscriptionRows = await ignoreMissingTable(
    () => all<{ id: string }>(env.DB, 'SELECT id FROM subscriptions WHERE client_id = ?', [clientId]),
    [] as Array<{ id: string }>,
  );
  let subscriptions = 0;
  for (const row of subscriptionRows) {
    try {
      if (await deleteSubscription(env, row.id)) subscriptions += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/no such table/i.test(message)) break;
      throw err;
    }
  }

  const pushDevices = await deletedCount(() =>
    run(env.DB, 'DELETE FROM push_devices WHERE user_id = ?', [user.id]),
  );
  const preferenceChanges = await deletedCount(() =>
    run(env.DB, 'DELETE FROM user_preferences WHERE user_id = ?', [user.id]),
  );
  const appleSubscriptions = await deletedCount(() =>
    run(env.DB, 'DELETE FROM apple_subscriptions WHERE user_id = ?', [user.id]),
  );

  const commands = opts.keepCommandId
    ? await deletedCount(() =>
      run(env.DB, 'DELETE FROM client_commands WHERE user_id = ? AND id != ?', [user.id, opts.keepCommandId]),
    )
    : await deletedCount(() =>
      run(env.DB, 'DELETE FROM client_commands WHERE user_id = ?', [user.id]),
    );

  const sessions = await destroySessionsForUser(env, user.id);

  await deletedCount(() => run(env.DB, 'DELETE FROM users WHERE id = ?', [user.id]));

  return {
    deleted: true,
    userId: user.id,
    detached: {
      subscriptions,
      pushDevices,
      preferences: preferenceChanges > 0,
      appleSubscriptions,
      commands,
      stripe,
      sessions,
    },
  };
}
