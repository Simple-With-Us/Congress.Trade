/**
 * src/admin/adminAccess.ts
 * Persisted admin allowlist: grant/revoke admin access for a user's email, IN
 * ADDITION to the env-configured ADMIN_EMAILS bootstrap list.
 *
 * ADMIN_EMAILS stays the root escape hatch and is never written here — it is
 * read directly from the environment (see identity.ts's adminRuntimeConfig).
 * This module only owns the separate `admin_allowlist` table (0090_admin_
 * allowlist.sql) and its `admin_access_audit` trail.  Every function here is
 * consulted ADDITIONALLY by isAdminSessionEmail/adminRuntimeConfig, never in
 * place of ADMIN_EMAILS.
 *
 * Every mutation here (grantAdmin/revokeAdmin) is called from a route that
 * already sits behind the standard /api/admin/* auth gate in routes.ts — this
 * module does not itself re-verify the caller is an admin; it enforces the
 * privilege-granting invariants (email validity/normalization, never touching
 * an ADMIN_EMAILS address, never leaving the admin pool empty) and writes the
 * audit trail.
 */

import { all, get, run } from '../shared/db.ts';
import { uuid } from '../shared/ids.ts';

export interface GrantedAdmin {
  email: string;
  grantedBy: string;
  grantedAt: string;
}

export interface AdminAuditEntry {
  id: string;
  action: 'grant' | 'revoke';
  email: string;
  actor: string;
  createdAt: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim + lowercase, so "Foo@Bar.com" and "foo@bar.com" are the same entry. */
export function normalizeAdminEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidAdminEmail(raw: string): boolean {
  return EMAIL_RE.test(raw.trim());
}

/** Just the email set — what adminRuntimeConfig merges into its allowlist. */
export async function listGrantedAdminEmails(db: D1Database): Promise<Set<string>> {
  const rows = await all<{ email: string }>(db, 'SELECT email FROM admin_allowlist');
  return new Set(rows.map((row) => row.email));
}

/** Full rows (who granted, when) for the admin-management UI. */
export async function listGrantedAdmins(db: D1Database): Promise<GrantedAdmin[]> {
  const rows = await all<{ email: string; granted_by: string; granted_at: string }>(
    db,
    'SELECT email, granted_by, granted_at FROM admin_allowlist ORDER BY granted_at ASC',
  );
  return rows.map((row) => ({ email: row.email, grantedBy: row.granted_by, grantedAt: row.granted_at }));
}

async function recordAuditEntry(
  db: D1Database,
  entry: { action: 'grant' | 'revoke'; email: string; actor: string; now: string },
): Promise<void> {
  await run(
    db,
    'INSERT INTO admin_access_audit (id, action, email, actor, created_at) VALUES (?, ?, ?, ?, ?)',
    [uuid(), entry.action, entry.email, entry.actor, entry.now],
  );
}

export async function listAdminAudit(db: D1Database, limit = 100): Promise<AdminAuditEntry[]> {
  const rows = await all<{ id: string; action: string; email: string; actor: string; created_at: string }>(
    db,
    'SELECT id, action, email, actor, created_at FROM admin_access_audit ORDER BY created_at DESC LIMIT ?',
    [limit],
  );
  return rows.map((row) => ({
    id: row.id,
    action: row.action === 'revoke' ? 'revoke' : 'grant',
    email: row.email,
    actor: row.actor,
    createdAt: row.created_at,
  }));
}

export interface GrantResult {
  ok: boolean;
  error?: string;
}

/**
 * Grant admin access to `email`.  Refuses an invalid address and refuses an
 * address already covered by ADMIN_EMAILS (that allowlist is env-configured
 * and not editable through this table — granting it here would just create a
 * second, uncontrolled entry for the same admin).
 */
export async function grantAdmin(
  db: D1Database,
  opts: { email: string; actor: string; envAllow: Set<string>; now?: string },
): Promise<GrantResult> {
  const email = normalizeAdminEmail(opts.email);
  if (!email || !isValidAdminEmail(email)) {
    return { ok: false, error: 'a valid email address is required' };
  }
  if (opts.envAllow.has(email)) {
    return {
      ok: false,
      error: `${email} is already an admin via ADMIN_EMAILS — configured in the environment, not editable here`,
    };
  }
  const now = opts.now ?? new Date().toISOString();
  await run(
    db,
    `INSERT INTO admin_allowlist (email, granted_by, granted_at) VALUES (?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET granted_by = excluded.granted_by, granted_at = excluded.granted_at`,
    [email, opts.actor, now],
  );
  await recordAuditEntry(db, { action: 'grant', email, actor: opts.actor, now });
  return { ok: true };
}

export interface RevokeResult {
  ok: boolean;
  error?: string;
}

/**
 * Revoke a previously-granted admin.  Refuses to touch an ADMIN_EMAILS
 * address (edit the environment instead — this table never overrides it),
 * refuses a target that was never granted, and refuses to leave the admin
 * pool (ADMIN_EMAILS ∪ granted) empty — a clear error, never a silent no-op.
 */
export async function revokeAdmin(
  db: D1Database,
  opts: { email: string; actor: string; actorEmail?: string; envAllow: Set<string>; now?: string },
): Promise<RevokeResult> {
  const email = normalizeAdminEmail(opts.email);
  if (!email) return { ok: false, error: 'a valid email address is required' };
  if (opts.envAllow.has(email)) {
    return {
      ok: false,
      error: `${email} is configured via ADMIN_EMAILS in the environment — not editable here`,
    };
  }
  const granted = await listGrantedAdminEmails(db);
  if (!granted.has(email)) {
    return { ok: false, error: `${email} is not in the granted-admin list` };
  }
  const totalAdmins = new Set([...opts.envAllow, ...granted]).size;
  if (totalAdmins <= 1) {
    const actorEmail = opts.actorEmail ? normalizeAdminEmail(opts.actorEmail) : undefined;
    if (actorEmail && actorEmail === email) {
      return { ok: false, error: 'you are the only admin — you cannot revoke your own access' };
    }
    return { ok: false, error: 'cannot revoke the last remaining admin' };
  }
  const now = opts.now ?? new Date().toISOString();
  await run(db, 'DELETE FROM admin_allowlist WHERE email = ?', [email]);
  await recordAuditEntry(db, { action: 'revoke', email, actor: opts.actor, now });
  return { ok: true };
}

/** Single-row existence check, cheaper than listGrantedAdminEmails for one email. */
export async function isEmailGranted(db: D1Database, email: string): Promise<boolean> {
  const row = await get<{ email: string }>(
    db,
    'SELECT email FROM admin_allowlist WHERE email = ?',
    [normalizeAdminEmail(email)],
  );
  return row != null;
}
