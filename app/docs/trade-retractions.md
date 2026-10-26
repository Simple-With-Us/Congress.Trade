# trade.retract contract

A **retraction** means a transaction that was published is no longer on the
feed.  Causes: admin unpublish, admin reject, republish retirement (a row the
corrected filing no longer contains), amendment supersede, or any other
deprecation.  It is **not an alert**: there is no APNs push, and consumers
should hide or delete the trade rather than notify anyone.

## Payload

Every channel carries the same object:

```json
{ "retractSeq": 17, "txId": "3f0c...", "docId": "E-2026-...", "retractedAt": "2026-10-25T20:00:00.000Z" }
```

`retractSeq` is the retraction cursor.  It increases monotonically and is
independent of the transaction `cursorSeq`.

## Poll: `GET /api/transactions/retractions?since=<retractSeq>&limit=<n>`

- Access is the same as `/api/transactions`: public, CORS-readable, and the
  same per-IP daily row budget (429 + `Retry-After`).
- Response: `{ "retractions": [TradeRetraction...], "cursor": <int>, "hasMore": <bool> }`, oldest first.
- Feed `cursor` back as `since`.  `limit` defaults to 500 (max 1000).  Keep
  paging while `hasMore` is true.
- A retraction whose row was later revived is omitted, and the cursor still
  advances past it.

## Webhook

- Delivered to every active webhook subscription.  It is not filtered by
  subscription filters, so ignore an unknown `txId`.
- Headers are the same as trade deliveries, except `X-CT-Event: transaction.retracted`.
  `X-Tx-Id` is the retraction key (`retract:<retractSeq>`), not the retracted
  transaction id, so header-based dedupe (`X-Subscription-Id` + `X-Tx-Id`)
  never mistakes a retract for the original `trade.new`. The retracted trade
  is in the body (`retraction.txId`).
- Body: `{ "type": "trade.retract", "id": "ct-retract-<retractSeq>", "event": "trade.retract", "retraction": TradeRetraction, "deliveredAt": "..." }`.
  There is no `data.trades`.
- Dedupe on `id`.  Retries and signatures work exactly as for `trade.new`.
- A retraction revived before it was delivered is dropped and not sent.

## SSE (`/api/stream`)

- Frame: `event: trade.retract` with `data: {"type":"trade.retract", ...TradeRetraction}`.
  The frame has no `id:` line, so `Last-Event-ID` stays the trade `cursorSeq`.
- Resume with `?retractSince=<retractSeq>`.  The stream opens with
  `event: retract-cursor` (the starting point), and the `reconnect` frame
  carries `retractSince`.  A fresh open without `?retractSince=` starts at the
  current high-water mark (live tail); a resume (via `?since=` or
  `Last-Event-ID`) without one replays from 0, so a native auto-reconnect —
  which cannot resend the query param — never skips a mid-disconnect
  retraction.
- Like the webhook, frames are not filtered.  They are emitted on the durable
  backlog cadence (about 45 s).

## Revival (un-retract)

When a republish revives a row that was exposed as retracted, the row comes
back with its **same id** and a **new `cursorSeq`**, even when it is
byte-identical.  A `/api/transactions?since=` poller therefore sees it again
and should upsert it by id.  It is not a new trade, and no `trade.new` webhook
or push is sent.  Rows deprecated before retractions existed keep their
cursor when revived unchanged, because no consumer was ever told they were
gone.

Webhook-only consumers get no revive event.  If they act on `trade.retract`
they should reconcile through `/api/transactions?since=`.

## Recommended poller loop

1. `GET /api/transactions?since=<txCursor>`: upsert by `id` and store `cursor`.
2. `GET /api/transactions/retractions?since=<retractCursor>`: delete or hide
   each `txId` and store `cursor`.

Order between the two calls does not matter.  A revived row's retraction
never appears in step 2, and its new `cursorSeq` puts it back in step 1.
