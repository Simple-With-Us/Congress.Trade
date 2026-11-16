# Webhook signatures

Every outbound delivery is signed with HMAC-SHA256 keyed by the
per-subscription secret returned once at subscription creation (falling back to
the worker-wide `WEBHOOK_SIGNING_KEY` when a subscription has no secret).

Two signature headers are sent. **Verify `X-CT-Signature`.**

```
X-CT-Signature: t=1785600000,v1=6b1f…c4
X-Signature:    sha256=9ad2…7e      <- legacy, deprecated
X-CT-Event:     transaction.created   (transaction.retracted for trade.retract)
X-Tx-Id:        <transaction id>
X-Subscription-Id: <subscription id>
X-Delivery-Attempt: <n>
```

## `X-CT-Signature` (v1)

`v1` is `HMAC-SHA256(secret, "<t>.<raw request body>")`, hex-encoded, where `t`
is the signing time in Unix seconds.

To verify:

1. Parse `t` and `v1` from the comma-separated header.
2. Reject if `abs(now - t)` exceeds your acceptance window. **300 seconds** is
   the suggested default. Reject far-future `t` as well as stale `t` — a
   clock-skewed future value would otherwise extend a captured request's life.
3. Recompute `HMAC-SHA256(secret, t + "." + rawBody)` over the **raw** body
   bytes, before any JSON parsing or re-serialization.
4. Compare in constant time.

`app/src/delivery/webhook.ts` exports `verifyWebhookSignatureV1()` as the
reference implementation; it is what the tests exercise, so the contract is
executable rather than only described here.

## Why `X-Signature` is deprecated

The legacy header signs the request **body alone**. It therefore never expires:
a captured request stays valid forever, and a recipient cannot distinguish a
replay from a fresh delivery or bound how long a leaked request is dangerous.
Binding `t` into the signed material is what makes an acceptance window
possible, and the `v1=` label lets the scheme be rotated later without breaking
verifiers that already exist.

`X-Signature` is still sent so current consumers keep working. Migrate to
`X-CT-Signature`; the legacy header will be removed in a future release.

## Delivery semantics (unchanged)

Webhook delivery is **at-least-once**. Recipients must still dedupe on
`X-Subscription-Id` + `X-Tx-Id`. The signature proves authenticity and
freshness; it does not make delivery exactly-once.
