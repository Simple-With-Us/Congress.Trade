/**
 * src/auth/users.ts
 * End-user records in D1 (`users` table). Distinct from the admin surface and
 * from delivery `subscriptions` (which are webhook/SSE targets, not billing).
 * Stripe/billing columns are layered on in a later migration; this module owns
 * identity only.
 */

import type { Env, User } from '../shared/types.ts';
import { get, run } from '../shared/db.ts';
import { uuid } from '../shared/ids.ts';

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  google_sub: string | null;
  email_verified: number;
  created_at: string;
  last_login_at: string | null;
  // Billing columns (migration 0004). Absent on rows read before the migration
  // is applied, hence the `?`-guarded coercions in mapUser.
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  subscription_status?: string | null;
  plan?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: number | null;
  trial_end?: string | null;
  // Sign in with Apple (migration 0080). Same `?`-guard pattern as billing.
  apple_sub?: string | null;
  // Sign in with X / Twitter (migration 0090).
  x_sub?: string | null;
}

function mapUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    picture: r.picture,
    googleSub: r.google_sub,
    appleSub: r.apple_sub ?? null,
    xSub: r.x_sub ?? null,
    emailVerified: r.email_verified === 1,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
    stripeCustomerId: r.stripe_customer_id ?? null,
    stripeSubscriptionId: r.stripe_subscription_id ?? null,
    subscriptionStatus: r.subscription_status ?? null,
    plan: (r.plan as User['plan']) ?? null,
    currentPeriodEnd: r.current_period_end ?? null,
    cancelAtPeriodEnd: r.cancel_at_period_end === 1,
    trialEnd: r.trial_end ?? null,
  };
}

export async function getUserById(env: Env, id: string): Promise<User | null> {
  const r = await get<UserRow>(env.DB, 'SELECT * FROM users WHERE id = ?', [id]);
  return r ? mapUser(r) : null;
}

export async function getUserByEmail(env: Env, email: string): Promise<User | null> {
  const r = await get<UserRow>(env.DB, 'SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
  return r ? mapUser(r) : null;
}

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string | null;
  picture?: string | null;
}

/**
 * Upsert a user from a verified Google profile, keyed by email.
 *
 * SECURITY: Google only attests ownership of an email when email_verified is
 * true. Matching-or-creating by an UNVERIFIED email would let an attacker who
 * registers a Google account claiming a victim's address take over the
 * victim's existing (e.g. magic-link) account. Callers should check
 * `emailVerified` first for a friendly error; this throw is the backstop.
 */
export async function upsertUserFromGoogle(env: Env, p: GoogleProfile): Promise<User> {
  if (p.emailVerified !== true) {
    throw new Error('google profile email is not verified; refusing to match or create an account');
  }
  const email = p.email.toLowerCase();
  const now = new Date().toISOString();
  const existing = await getUserByEmail(env, email);
  if (existing) {
    await run(
      env.DB,
      `UPDATE users
          SET name = COALESCE(?, name),
              picture = COALESCE(?, picture),
              google_sub = ?,
              email_verified = ?,
              last_login_at = ?
        WHERE id = ?`,
      [p.name ?? null, p.picture ?? null, p.sub, p.emailVerified ? 1 : 0, now, existing.id],
    );
    return (await getUserById(env, existing.id)) as User;
  }
  const id = uuid();
  await run(
    env.DB,
    `INSERT INTO users (id, email, name, picture, google_sub, email_verified, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, email, p.name ?? null, p.picture ?? null, p.sub, p.emailVerified ? 1 : 0, now, now],
  );
  return (await getUserById(env, id)) as User;
}

/** Upsert a user identified by a (just-verified) email — the magic-link path. */
export async function upsertUserByEmail(env: Env, emailRaw: string): Promise<User> {
  const email = emailRaw.toLowerCase();
  const now = new Date().toISOString();
  const existing = await getUserByEmail(env, email);
  if (existing) {
    await run(env.DB, 'UPDATE users SET email_verified = 1, last_login_at = ? WHERE id = ?', [
      now,
      existing.id,
    ]);
    return (await getUserById(env, existing.id)) as User;
  }
  const id = uuid();
  await run(
    env.DB,
    `INSERT INTO users (id, email, name, picture, google_sub, email_verified, created_at, last_login_at)
     VALUES (?, ?, NULL, NULL, NULL, 1, ?, ?)`,
    [id, email, now, now],
  );
  return (await getUserById(env, id)) as User;
}

export async function getUserByAppleSub(env: Env, appleSub: string): Promise<User | null> {
  const r = await get<UserRow>(env.DB, 'SELECT * FROM users WHERE apple_sub = ?', [appleSub]);
  return r ? mapUser(r) : null;
}

export interface AppleProfile {
  sub: string;
  /** The identity token's `email` claim (real address, or a private-relay address for "Hide My Email"); present on every verified token, not just the first. */
  email?: string | null;
  emailVerified?: boolean;
  /**
   * Client-supplied full name, present on first sign-in ONLY —
   * `ASAuthorizationAppleIDCredential.fullName` is never encoded in the
   * identity token JWT at all; the client must capture it from that
   * first-authorization callback and pass it through separately.
   */
  name?: string | null;
}

/**
 * Upsert a user from a verified Apple identity token, keyed by the stable
 * Apple `sub` claim (constant for this app across all future sign-ins, even
 * once Apple stops returning email on later calls).
 *
 * Linking order:
 *   1. An existing `apple_sub` match wins outright (returning user).
 *   2. Else, when Apple supplied a VERIFIED email, link to an existing
 *      account with that email (e.g. a prior Google/magic-link signup) —
 *      mirrors upsertUserFromGoogle's same account-takeover guard: only a
 *      provider-verified email may claim an existing account.
 *   3. Else create a new account. Apple's own private-relay addresses (the
 *      "Hide My Email" feature) are still real, Apple-verified, receivable
 *      addresses, so they are accepted the same as a direct email.
 */
export async function upsertUserFromApple(env: Env, p: AppleProfile): Promise<User> {
  const now = new Date().toISOString();
  const existingByApple = await getUserByAppleSub(env, p.sub);
  if (existingByApple) {
    await run(
      env.DB,
      `UPDATE users
          SET name = COALESCE(?, name),
              last_login_at = ?
        WHERE id = ?`,
      [p.name ?? null, now, existingByApple.id],
    );
    return (await getUserById(env, existingByApple.id)) as User;
  }

  const email = p.email ? p.email.toLowerCase() : null;
  const emailVerified = p.emailVerified === true;
  const existingByEmail = email && emailVerified ? await getUserByEmail(env, email) : null;
  if (existingByEmail) {
    await run(
      env.DB,
      `UPDATE users
          SET apple_sub = ?,
              name = COALESCE(name, ?),
              last_login_at = ?
        WHERE id = ?`,
      [p.sub, p.name ?? null, now, existingByEmail.id],
    );
    return (await getUserById(env, existingByEmail.id)) as User;
  }

  // A present-but-UNVERIFIED email is never trusted as this new account's
  // address — it may belong to someone else (that's exactly why the link
  // above was skipped) — so it falls back to the synthetic placeholder the
  // same as a genuinely absent email, rather than risking a UNIQUE collision
  // with (or silently borrowing) another account's real email.
  const trustedEmail = emailVerified ? email : null;
  const id = uuid();
  await run(
    env.DB,
    `INSERT INTO users (id, email, name, picture, google_sub, apple_sub, email_verified, created_at, last_login_at)
     VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    [
      id,
      trustedEmail ?? `apple-${p.sub}@privaterelay.congress.trade.invalid`,
      p.name ?? null,
      p.sub,
      trustedEmail ? 1 : 0,
      now,
      now,
    ],
  );
  return (await getUserById(env, id)) as User;
}

export async function getUserByXSub(env: Env, xSub: string): Promise<User | null> {
  const r = await get<UserRow>(env.DB, 'SELECT * FROM users WHERE x_sub = ?', [xSub]);
  return r ? mapUser(r) : null;
}

export interface XProfile {
  sub: string;
  username: string;
  name?: string | null;
  picture?: string | null;
}

export async function upsertUserFromX(env: Env, p: XProfile): Promise<User> {
  const now = new Date().toISOString();
  const existingByX = await getUserByXSub(env, p.sub);
  if (existingByX) {
    await run(
      env.DB,
      `UPDATE users
          SET name = COALESCE(?, name),
              picture = COALESCE(?, picture),
              last_login_at = ?
        WHERE id = ?`,
      [p.name ?? null, p.picture ?? null, now, existingByX.id],
    );
    return (await getUserById(env, existingByX.id)) as User;
  }

  const id = uuid();
  const placeholderEmail = `x-${p.sub}@privaterelay.congress.trade.invalid`;
  await run(
    env.DB,
    `INSERT INTO users (id, email, name, picture, google_sub, apple_sub, x_sub, email_verified, created_at, last_login_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, 0, ?, ?)`,
    [
      id,
      placeholderEmail,
      p.name ?? p.username ?? null,
      p.picture ?? null,
      p.sub,
      now,
      now,
    ],
  );
  return (await getUserById(env, id)) as User;
}

export async function linkXSubToUser(env: Env, userId: string, xSub: string): Promise<User> {
  const now = new Date().toISOString();
  await run(
    env.DB,
    `UPDATE users
        SET x_sub = ?,
            last_login_at = ?
      WHERE id = ?`,
    [xSub, now, userId],
  );
  return (await getUserById(env, userId)) as User;
}
