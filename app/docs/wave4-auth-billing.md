# Go-live: end-user auth + Stripe paywall (Wave 4)

This is the copy-paste runbook for turning on the public-site **account system**
(Google OAuth + email magic-link) and the **freemium paywall** (Stripe). The code
is already merged and **degrades gracefully** until these are configured:

| Not configured | Behaviour |
|---|---|
| `STRIPE_SECRET_KEY` absent | `/billing/checkout` → `503`; Upgrade button shows "billing not configured" |
| `GOOGLE_OAUTH_CLIENT_ID` absent | `/auth/google/start` → `503`; "Continue with Google" errors cleanly |
| `RESEND_API_KEY`/`EMAIL_FROM` absent | magic-link request returns `{sent:false}` → UI says "try Google" |

So you can deploy now and flip each piece on as you create the accounts.

Set `APP_BASE_URL=https://congress.trade` in Infisical (congress-trade `prod`)
first — it is the public origin used to build every OAuth redirect and magic
link.  If unset we fall back to the request origin, which is fine for a single
domain but explicit is safer.  Do not `wrangler secret put` — production is
Coolify, not a Worker.

---

## 1. Stripe (freemium paywall)

**Pricing (current, verified 2026-10-09):** 1-week free trial → **$8.99/mo** or **$79.99/yr**.  Stripe checkout uses `STRIPE_TRIAL_DAYS` (default **7** when unset in `billing/routes.ts`).  App Store Connect intro offer must match **ONE_WEEK** on both `trade.congress.premium.monthly` and `.annual`.  In-app / store / web copy must quote 1 week, never 2 weeks or 1 month.

1. **Create the product + prices** (Stripe Dashboard → Products, in *live* mode):
   - Product: "Congress.Trade Premium".
   - Add two **recurring** prices: `$5 / month` and `$50 / year`. Copy each
     `price_…` id.
2. **Enable the Billing Portal**: Dashboard → Settings → Billing → Customer portal
   → activate (allow cancel + payment-method updates). This backs the
   "Manage subscription" menu item.
3. **Create the webhook**: Dashboard → Developers → Webhooks → Add endpoint:
   - URL: `https://<APP_BASE_URL>/billing/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`,
     `customer.subscription.updated`, `customer.subscription.deleted`
   - Copy the **Signing secret** (`whsec_…`).
4. **Set the secrets/vars in Infisical** (`STRIPE_SECRET_KEY`,
   `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_ANNUAL`,
   `STRIPE_TRIAL_DAYS=7`).  Do not `wrangler secret put`.

**Test before live:** do all of the above in Stripe *test* mode with `sk_test_…`
keys and the test webhook secret; use card `4242 4242 4242 4242`.  The trial means
no charge for 7 days (1 week), so confirm the flow end-to-end first.

How it reconciles: checkout creates the customer up-front and stores the
`customer ↔ user` link; the `customer.subscription.*` webhooks are the source of
truth for status/plan/period. A user is **premium** while `trialing` or `active`
(see `src/billing/entitlement.ts`).

---

## 2. Google OAuth ("Sign in with Google")

Google Cloud Console → APIs & Services:

1. **OAuth consent screen**: External, add app name + support email, and your
   domain to *Authorized domains*. Scopes needed: `openid`, `email`, `profile`.
2. **Credentials → Create OAuth client ID → Web application**:
   - Authorized JavaScript origin: `https://<APP_BASE_URL>`
   - Authorized redirect URI: `https://<APP_BASE_URL>/auth/google/callback`
   - (add `http://localhost:8787/...` variants for local Deno `npm run dev`)
3. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in Infisical.

---

## 3. Resend (magic-link emails)

1. Resend → add + **verify your sending domain** (DNS records).
2. Create an API key.
3. Set `RESEND_API_KEY` and `EMAIL_FROM` in Infisical
   (`Congress.Trade <login@congress.trade>`).

`EMAIL_FROM` must be a verified sender on that domain. Until set, magic-link
requests no-op gracefully and the UI nudges users to Google sign-in.

---

## 4. Cloudflare Access for the admin surface

The in-page Admin tabs (poll cadence, review queue, backfill) call `/api/admin/*`,
which returns `401/403` on the public site (the dashboard shows
"Admin tools have moved to admin.congress.trade"). Gate that subdomain with
Cloudflare Access + Google so admin is one-click SSO, **not** OTP-every-24h.

1. **Point the subdomain at the Coolify app**: `admin.congress.trade` is
   Cloudflare DNS/edge in front of the same `congress-app` container as
   `congress.trade`.  Do not add a Worker `wrangler.toml` route.
2. **Zero Trust → Access → Applications → Add → Self-hosted**:
   - Application domain: `admin.congress.trade`
   - **Session Duration: 1 month** (this is the knob that removes the
     OTP-every-24h annoyance).
3. **Identity provider = Google** (Zero Trust → Settings → Authentication → add
   Google as a login method) so the Access login is "Sign in with Google" (SSO),
   not an emailed PIN.
4. **Policy**: Allow → Include → *Emails* = your admin address(es).

Behind Access, the browser carries the Access cookie automatically, so the admin
panels work on the subdomain with no token to paste.

---

## 5. Apply migrations, deploy, smoke-test

```bash
npm run typecheck && npm run test
ADMIN_TOKEN=... bash scripts/ship.sh
```

`ship.sh` waits for the Coolify revision on `https://congress.trade`, then
applies the idempotent `POST /api/admin/migrate` path against the host SQLite
file.  Do not use remote Wrangler D1 migrations on this account.

Smoke test:
- `GET /auth/me` → `{ "user": null, "entitlement": { "premium": false, … } }`
- `GET /billing/status` → `{ "configured": true, … }` once Stripe keys are set
- Sign in (Google + magic-link), then **Upgrade → Start free trial** → Stripe
  Checkout → back to `/?checkout=success` with the **Premium** badge showing.
- As a free user, the feed shows the **last 30 days** + a "🔒 unlock full history"
  CTA; **Export CSV** opens the upgrade modal. As premium, both unlock.

---

## 6. Historic backfill

Once deployed, seed back-history — see
[`DEPLOY.md`](../DEPLOY.md) §5, e.g.:

```bash
curl -X POST https://<APP_BASE_URL>/api/admin/backfill \
  -H 'authorization: Bearer <ADMIN_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{"chambers":["house","senate"],"sinceYear":2014}'   # add "dryRun":true to preview
```

For higher-fidelity House history, use the official House index backfill in
bounded batches. `dryRun` counts matching PTRs without writing rows or enqueueing
work; non-dry runs default to `maxFilings: 500` unless a different cap is sent.

```bash
curl -X POST https://<APP_BASE_URL>/api/admin/house-backfill \
  -H 'authorization: Bearer <ADMIN_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{"fromYear":2024,"toYear":2026,"maxFilings":500,"dryRun":true}'
```
