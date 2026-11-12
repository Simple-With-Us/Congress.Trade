# 2026-08-25 — Session admin allowlist not attaching (`admin.allowed=false`)

## Summary

Signed-in Google sessions on production (`1190bbb3`, PR #2219) return
`GET /auth/me` → `admin.allowed: false`, so `/admin` and Review Queue fall
through to Trends.  **No code bug in the admin email path.**  The runtime
resolver reads `ADMIN_EMAILS` from **Infisical prod** (congress-trade app
project); the live value is a **stale 19-character address** that does not
match the signed-in session email (operator Google account, 24 characters).
Image-baked `.prod.vars` / Coolify env for `ADMIN_EMAILS` is **not** used when
Infisical returns a truthy value for that key.

PR #2219 removed the browser Admin Sign-In / `ADMIN_TOKEN` workaround, which
had masked this configuration drift.

## Investigation (code path)

| Step | Location | Result |
|------|----------|--------|
| Session identity | `GET /auth/me` → `getCurrentUserFromRequest` | Uses `ct_session` cookie or Bearer session token; loads `users.email` from D1 |
| Admin gate | `isAdminSessionEmail` → `adminRuntimeConfig` | Merges `ADMIN_EMAILS` (env/Infisical) + `admin_allowlist` grants |
| Allowlist parse | `parseEmailAllowlist` | Splits on comma/whitespace, trims, lowercases — correct for plain emails |
| Secret source | `resolveSecret(env, 'ADMIN_EMAILS')` | Infisical cache first; env fallback only when Infisical missing/empty and `INFISICAL_ALLOW_ENV_FALLBACK !== 'false'` |
| Cloudflare Access | `/auth/me` Access JWT branch | Only supplements when session email is not already admin; `ACCESS_AUD` empty in `.prod.vars` — not the primary path |
| UI | `canUseAdmin()` | Keys on `ME.admin.allowed` only after #2219 — correct |

Automated coverage already exercises the happy path:
`app/src/auth/__tests__/routes.test.ts` (“GET /me marks allowlisted signed-in
users as admin”) and `app/src/admin/__tests__/adminAllowlist.test.ts`.

## Production evidence (no secret values)

- `GET /api/health` on `https://congress.trade` (2026-08-25): `checks.secrets.enabled=true`, `cacheReady=true`, shared `count=65`, app `count=140`, `errors=[]`, `build.sha=1190bbb3`.
- Infisical **congress-trade** project, env **prod**, key **`ADMIN_EMAILS`**: **present**, value length **19** (no wrapping quotes).  Session email length **24** → mismatch.
- Repo `app/.prod.vars` lists `ADMIN_EMAILS` for the correct address, but production resolves Infisical first.

## Root cause

**Env-only:** Infisical prod key **`ADMIN_EMAILS`** (congress-trade app
project, environment `prod`) must be updated to the operator’s signed-in
email.  Do not rely on `.prod.vars` or Coolify env alone while Infisical
returns the stale value.

## Remediation (operator)

1. In Infisical → **congress-trade** project → env **prod**, set **`ADMIN_EMAILS`**
   to the operator’s signed-in Google email (comma-separated if multiple operators).
2. Wait for resolver TTL (`INFISICAL_CACHE_TTL_SECONDS`, default 600s) **or**
   restart the Coolify `congress-app` container **or** (with a valid
   `ADMIN_TOKEN`) `POST /api/admin/diagnostics/secrets/refresh`.
3. Re-test signed in: `GET /auth/me` → `admin.allowed: true`; `/admin` shows
   Admin · Cadence; Review Queue tab visible.

Optional belt-and-suspenders: add the same email via
`POST /api/admin/admins/grant` once any admin path works (persisted grant in
`admin_allowlist`).

**Do not** reintroduce Admin Sign-In / token fields in product UI.  **Do not**
weaken `/api/admin/*` fail-closed behavior.

## Files changed (this rollout note only)

- `docs/rollouts/2026-08-25-admin-emails-session-allowlist.md`
- `docs/EFFORT-LOG.md`

## Verification

After Infisical update:

```bash
# Signed-in browser or curl with ct_session cookie
curl -sS -b 'ct_session=…' -A 'Mozilla/5.0' 'https://congress.trade/auth/me' | jq '.admin'
# expect: { "allowed": true }
```

## Follow-ups

- None required in app code for this incident.
- Consider documenting in runbooks that post-#2219 web admin is **session
  allowlist only**; `ADMIN_TOKEN` remains automation-only.
