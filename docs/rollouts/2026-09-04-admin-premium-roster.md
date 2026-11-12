# Admin Premium Members roster

## Summary

Admin Diagnostics lumped trial and paid as Subscribed, listed only the last
ten logins, and never showed Apple.  After the Sep 3 Stripe $5 trial converted
to paid, the local row stayed `trialing` because the guarded
`customer.subscription.updated` write could miss when the event-state UPSERT
was not visible in the same libsql batch.  Stripe basil also moved
`invoice.subscription` under `parent.subscription_details`, so a later
`invoice.paid` could not find the Subscription.

This change adds an Admin Premium Members table (email, plan, Trial or Paid,
Stripe or Apple, Sandbox or Production) with a live Stripe overlay.  Opening
the roster heals a stale local trial when Stripe already shows paid.
`invoice.paid` / `invoice.payment_succeeded` now retrieve the live
Subscription and apply it.  Same-subscription updates that win ordering write
the user row after the batch commits.

## Files

- `app/src/admin/premiumRoster.ts`
- `app/src/admin/__tests__/premiumRoster.test.ts`
- `app/src/admin/routes.ts`
- `app/src/billing/stripe.ts`
- `app/src/billing/subscription.ts`
- `app/src/billing/routes.ts`
- `app/src/ui/dashboardHtml.ts`
- `app/src/billing/__tests__/routes.test.ts`
- `app/src/billing/__tests__/subscription.test.ts`
- `app/src/billing/__tests__/stripe.test.ts`
- `app/src/billing/__tests__/premiumActivationWebhook.test.ts`
- `app/src/ui/__tests__/dashboardHtml.test.ts`

## Verification

- `cd app && npx --no-install vitest run src/admin/__tests__/premiumRoster.test.ts src/billing/__tests__/subscription.test.ts src/billing/__tests__/routes.test.ts src/billing/__tests__/stripe.test.ts src/billing/__tests__/premiumActivationWebhook.test.ts src/ui/__tests__/dashboardHtml.test.ts`
- `cd app && npm run typecheck`

PR only.  No Coolify.  No merge.

Board: `43eaac7f`.
