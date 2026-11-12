# Delivery quarantine recovery

## Summary

Webhook deliveries past the per-subscription parked-depth cap were written to
`deliveries.status = 'quarantined'` with admin email copy implying they would
recover when the target healed, but no code ever moved them back to `parked`.
This change adds bounded auto-recovery on the scheduled parked flush, an admin
replay endpoint, and a `delivery_quarantine` `/api/health` check.

## Files changed

- `app/src/delivery/targetCircuit.ts` — `recoverQuarantinedDeliveries`, wired into `flushParkedDeliveries`
- `app/src/admin/routes.ts` — `POST /api/admin/delivery-requeue-quarantined`
- `app/src/shared/pipelineHealth.ts` — collect counts + `delivery_quarantine` check
- Tests under `app/src/delivery/__tests__/targetCircuit.test.ts` and `app/src/shared/__tests__/pipelineHealth.test.ts`

## Verification

```bash
cd app && npm run typecheck && npm test
```

After deploy, `/api/health` should report `delivery_quarantine` degraded while
quarantined rows remain; counts should fall as parked headroom opens and the
minute tick runs `flushParkedDeliveries`.  Operators can batch-replay with:

`POST /api/admin/delivery-requeue-quarantined` body `{ "limit": 500, "ignoreCircuit": true }`.

## Follow-ups

- Per-subscription delivery health on `GET /api/subscriptions/:id` (expert review #159).
- Consider raising or tiering `DELIVERY_TARGET_PARKED_CAP` for Premium targets.
