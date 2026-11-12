import type { Env } from '../shared/types.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { parseEmailAllowlist } from './access.ts';
import { listGrantedAdminEmails } from './adminAccess.ts';

export interface AdminRuntimeConfig {
  /** Merged allowlist: ADMIN_EMAILS (env bootstrap) + persisted grants.  This
   *  is what "is this email an admin" checks against. */
  allow: Set<string>;
  /** ADMIN_EMAILS only — the env-configured root bootstrap.  Read-only from
   *  the UI: grant/revoke never write to it, and revoking one of these
   *  addresses through the admin-management UI is refused (see
   *  admin/adminAccess.ts).  Kept separate so the UI can label these entries
   *  "configured in the environment — not editable here". */
  envAllow: Set<string>;
  accessAud?: string;
  accessTeamDomain?: string;
}

async function resolved(env: Env, key: keyof Env & string): Promise<string | undefined> {
  return (await resolveSecret(env, key)).value;
}

export async function adminRuntimeConfig(env: Env): Promise<AdminRuntimeConfig> {
  const [emails, accessAud, accessTeamDomain] = await Promise.all([
    resolved(env, 'ADMIN_EMAILS'),
    resolved(env, 'ACCESS_AUD'),
    resolved(env, 'ACCESS_TEAM_DOMAIN'),
  ]);
  const envAllow = parseEmailAllowlist(emails);
  // Defensive: a missing/broken DB binding (some test envs stub only what
  // they need) must degrade to the env-only allowlist, never throw and never
  // widen access.
  let granted: Set<string>;
  try {
    granted = await listGrantedAdminEmails(env.DB);
  } catch {
    granted = new Set<string>();
  }
  const allow = new Set<string>(envAllow);
  for (const email of granted) allow.add(email);
  return {
    allow,
    envAllow,
    accessAud,
    accessTeamDomain,
  };
}

export async function isAdminSessionEmail(env: Env, email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  const cfg = await adminRuntimeConfig(env);
  return cfg.allow.has(email.trim().toLowerCase());
}
