# 2026-08-16 — Health reports Infisical sources; AG***_S**C lives only in shared

## 1. Context & Objective

After rotating the leaked `ADMIN_TOKEN` / `AG***_S**C_*` pair, the same
`AG***_S**C_*` values were written into the ST app project, the CT app
project, and shared-at-ct.  The owner is right: fleet-wide keys belong
in the shared Infisical project only.  The resolver merges shared first
and then the app project, so an app-side copy shadows shared and makes
the next rotation a three-project chore.

`GET /api/health` is the uptime-monitor target.  It already exempts
itself from the scrape guard and now publishes a public-safe Infisical
source status (names, counts, errors — never values) so a monitor can
see that shared and app are both loading.

## 2. Changes Made

- Deleted `AG***_S**C_TOKEN` and `AG***_S**C_POST_TOKEN` from the
  Congress.Trade and Socratic.Trade **app** Infisical projects.  They
  remain in **shared-at-ct** (`18f563a3-…`) and in
  `~/.secrets/ag***-s**c.env` / `global-api-keys`.
- `GET /api/health` now includes `checks.secrets` from
  `getSecretResolverStatus` (enabled, cacheReady, errors, per-source
  configured/ok/count).
- Comment on the merge order in `src/secrets/infisical.ts` and
  `app/docs/config-registry.md`.

Touched:

- `app/src/delivery/rest.ts`
- `app/src/delivery/__tests__/healthCache.test.ts`
- `app/src/secrets/infisical.ts`
- `app/docs/config-registry.md`
- `docs/EFFORT-LOG.md`
- `STATUS.md`

## 3. Decisions & Trade-offs

- Did not put `ADMIN_TOKEN` in shared.  That token is Congress.Trade
  admin auth and stays on the CT app project.
- Did not copy `AG***_S**C_*` onto Usage Monitor Infisical.  Cloud
  agents that only have a UM identity should use `~/.secrets` or the
  shared identity.
- Did not add a Cloudflare WAF skip in this change.  Public
  `https://congress.trade/api/health` is HTTP 200 with JSON today; the
  403 seen during the 2026-08-14 restart was Cloudflare Access / edge
  during the container gap, not the app.  The scrape guard already
  exempts `/api/health`.

## 4. Verification State

```bash
cd app && npx vitest run src/delivery/__tests__/healthCache.test.ts \
  src/secrets/__tests__/infisical.test.ts
# 2 files / 9 passed
```

CI on PR #1885: first `typecheck + test` (run 31926870126, attempt 1,
04:32Z) failed with every file `(0 test)` and 0% coverage on
`hetzner-ct-ci-1`.  Same-window `grok/note-title` failed the same way.
Attempt 2 (19:41Z, same runner) succeeded.  Local health/infisical
tests still 9/9.  Merged `origin/main` after #1886 (`77782b7b`)
conflicted on `docs/EFFORT-LOG.md`; kept both rows.

Infisical names-only check after delete: CT app and ST app no longer
list `AG***_S**C_*`; shared still does.

## 5. Next Steps & Blockers

1. **Done.**  Coolify auto-deployed #1885.  Live sha `a50c09e5`.
   `checks.secrets.sources`: shared ok/65, app ok/145, 0 errors.
2. Local Mac agents keep posting via `~/.secrets/ag***-s**c.env`.
   Cloud agents that used the ST/CT app project for `AG***_S**C_*`
   must read the shared project (or the handoff file) instead.
3. Owner: replace congress.trade admin UI localStorage `ADMIN_TOKEN`
   from `CT_ADMIN_TOKEN` in `~/.secrets/global-api-keys` (do not paste).
4. Not in this lane: Coolify preview ADMIN still older hash
   `b687d700`; UM Infisical was not updated; no WAF skip for GH-runner
   health 403s; pipeline `status:stalled` is existing autopilot/senate.

## 6. Zero-Code Findings

- Public `/api/health` is 200 and `ok: true` from this Mac as of
  2026-08-16.  Pipeline `status: stalled` is the existing autopilot
  billing halt + senate polling, not this change.
